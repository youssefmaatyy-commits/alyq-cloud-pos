-- 0079 — Flexible string sizes and one ordered gallery per product colour
--
-- Legacy numeric `size`, textual `size_label`, and per-variant `image_url` stay
-- readable for old invoices and clients. New catalogue identity is the ordered
-- `size_value` string; colour galleries reference existing storage URLs once per
-- colour, never once per size.

begin;

-- ── Flexible size identity ──────────────────────────────────────────────────
alter table public.product_variants
  add column if not exists size_value text,
  add column if not exists size_sort_order integer not null default 0;

update public.product_variants
   set size_value = coalesce(
     nullif(btrim(size_label),''),
     case when size is null then null else trim(trailing '.' from trim(trailing '0' from size::text)) end
   ),
       size_sort_order = sort_order
 where size_value is null;

create or replace function public.product_variant_normalize_size()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $function$
declare v_numeric numeric;
begin
  -- Compatibility writers may still send the former numeric/label columns.
  -- A writer that explicitly sends size_value always wins.
  if nullif(btrim(coalesce(new.size_value,'')),'') is null
     or (tg_op='UPDATE' and new.size_value is not distinct from old.size_value
         and (new.size is distinct from old.size or new.size_label is distinct from old.size_label)) then
    new.size_value := coalesce(
      nullif(btrim(new.size_label),''),
      case when new.size is null then null else trim(trailing '.' from trim(trailing '0' from new.size::text)) end
    );
  else
    new.size_value := nullif(regexp_replace(btrim(new.size_value),'\s+',' ','g'),'');
  end if;

  -- Keep the legacy numeric column populated only when the exact string safely
  -- fits it. Letter, kids, pants, One Size and future systems stay text.
  if new.size_value ~ '^[0-9]+([.][0-9]{1,2})?$' then
    begin
      v_numeric := new.size_value::numeric;
      if v_numeric>0 and v_numeric<1000000 then new.size:=v_numeric; else new.size:=null; end if;
    exception when numeric_value_out_of_range then new.size:=null;
    end;
  else
    new.size:=null;
  end if;
  new.size_label:=new.size_value;
  return new;
end
$function$;

drop trigger if exists product_variant_normalize_size on public.product_variants;
create trigger product_variant_normalize_size
before insert or update of size_value,size,size_label on public.product_variants
for each row execute function public.product_variant_normalize_size();

alter table public.product_variants drop constraint if exists product_variants_dimension_present;
alter table public.product_variants add constraint product_variants_dimension_present check (
  btrim(color_key)<>'' or nullif(btrim(coalesce(size_value,'')),'') is not null
);
alter table public.product_variants drop constraint if exists product_variants_label_shape;
alter table public.product_variants drop constraint if exists product_variants_size_value_shape;
alter table public.product_variants add constraint product_variants_size_value_shape check (
  size_value is null or char_length(btrim(size_value)) between 1 and 80
);
alter table public.product_variants drop constraint if exists product_variants_size_sort_nonnegative;
alter table public.product_variants add constraint product_variants_size_sort_nonnegative check (size_sort_order>=0);

drop index if exists public.product_variants_combination_unique;
create unique index product_variants_combination_unique
  on public.product_variants(product_id,color_key,coalesce(lower(btrim(size_value)),''));
drop index if exists public.product_variants_product_idx;
create index product_variants_product_idx
  on public.product_variants(product_id,color_key,size_sort_order,lower(btrim(size_value)));

comment on column public.product_variants.size_value is
  'Authoritative merchant-entered size string: letter, numeric, kids, pants, One Size, or any future system. Case-insensitive within one Color × Size identity.';
comment on column public.product_variants.size_sort_order is
  'Explicit merchant ordering for size options. Natural ordering is the application fallback when values share an order.';
comment on column public.product_variants.size is
  'Legacy numeric compatibility projection of size_value when its exact value fits numeric(8,2); never the size identity after migration 0079.';
comment on column public.product_variants.size_label is
  'Legacy snapshot/display compatibility copy of size_value; never the size identity after migration 0079.';

-- ── Ordered colour galleries ────────────────────────────────────────────────
create table if not exists public.product_color_images (
  id          uuid primary key default gen_random_uuid(),
  product_id  uuid not null references public.products(id) on delete cascade,
  color_key   text not null,
  image_url   text not null,
  alt_ar      text,
  alt_en      text,
  sort_order  integer not null default 0,
  is_primary  boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint product_color_images_color_not_blank check (btrim(color_key)<>''),
  constraint product_color_images_url_not_blank check (btrim(image_url)<>'' and char_length(image_url)<=2048),
  constraint product_color_images_sort_nonnegative check (sort_order>=0),
  constraint product_color_images_alt_ar_shape check (alt_ar is null or char_length(btrim(alt_ar)) between 1 and 160),
  constraint product_color_images_alt_en_shape check (alt_en is null or char_length(btrim(alt_en)) between 1 and 160),
  constraint product_color_images_exact_unique unique(product_id,color_key,image_url)
);
create unique index if not exists product_color_images_one_primary
  on public.product_color_images(product_id,color_key) where is_primary;
create index if not exists product_color_images_order_idx
  on public.product_color_images(product_id,color_key,is_primary desc,sort_order,id);

create or replace function public.product_color_image_validate()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
begin
  new.color_key:=lower(regexp_replace(btrim(new.color_key),'\s+',' ','g'));
  new.image_url:=btrim(new.image_url);
  new.alt_ar:=nullif(btrim(coalesce(new.alt_ar,'')),'');
  new.alt_en:=nullif(btrim(coalesce(new.alt_en,'')),'');
  new.updated_at:=now();
  if not exists(
    select 1 from public.product_variants v
     where v.product_id=new.product_id and v.color_key=new.color_key
  ) then
    raise exception 'Colour gallery does not match a product colour' using errcode='23514';
  end if;
  return new;
end
$function$;
drop trigger if exists product_color_image_validate on public.product_color_images;
create trigger product_color_image_validate
before insert or update on public.product_color_images
for each row execute function public.product_color_image_validate();

-- Preserve each legitimate legacy colour URL once. Shared URLs are references
-- to the same stored object; no file is copied.
insert into public.product_color_images(product_id,color_key,image_url,sort_order,is_primary)
select distinct on(v.product_id,v.color_key)
       v.product_id,v.color_key,btrim(v.image_url),0,true
  from public.product_variants v
 where btrim(v.color_key)<>'' and btrim(coalesce(v.image_url,''))<>''
 order by v.product_id,v.color_key,v.sort_order,v.created_at,v.id
on conflict do nothing;

comment on table public.product_color_images is
  'Ordered reusable gallery URLs for one product colour. Sizes of the same colour share these rows and storage objects. The product gallery remains the fallback.';

create or replace function public.replace_product_color_images(p_product_id uuid,p_images jsonb)
returns setof public.product_color_images
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare v_item jsonb; v_index integer:=0; v_primary_seen jsonb:='{}'::jsonb;
begin
  if auth.uid() is null or not public.can('edit_product') then
    raise exception 'Editing colour galleries requires edit_product' using errcode='42501';
  end if;
  if not exists(select 1 from public.products where id=p_product_id) then
    raise exception 'Product not found' using errcode='P0002';
  end if;
  if p_images is null or jsonb_typeof(p_images)<>'array' then
    raise exception 'Colour gallery payload must be an array' using errcode='22023';
  end if;
  delete from public.product_color_images where product_id=p_product_id;
  for v_item in select value from jsonb_array_elements(p_images) loop
    if jsonb_typeof(v_item)<>'object' then raise exception 'Invalid colour gallery item' using errcode='22023'; end if;
    insert into public.product_color_images(
      product_id,color_key,image_url,alt_ar,alt_en,sort_order,is_primary
    ) values(
      p_product_id,v_item->>'color_key',v_item->>'image_url',
      nullif(btrim(coalesce(v_item->>'alt_ar','')),''),nullif(btrim(coalesce(v_item->>'alt_en','')),''),
      v_index,
      case
        when coalesce((v_item->>'is_primary')::boolean,false) and not (v_primary_seen ? lower(btrim(v_item->>'color_key')))
          then true
        when not (v_primary_seen ? lower(btrim(v_item->>'color_key'))) then true
        else false
      end
    );
    v_primary_seen:=v_primary_seen||jsonb_build_object(lower(btrim(v_item->>'color_key')),true);
    v_index:=v_index+1;
  end loop;
  return query select * from public.product_color_images
   where product_id=p_product_id order by color_key,is_primary desc,sort_order,id;
end
$function$;

create or replace function public.storefront_color_images()
returns table(id uuid,product_id uuid,color_key text,image_url text,alt_ar text,alt_en text,sort_order integer,is_primary boolean)
language sql
stable
security definer
set search_path = pg_catalog, public
as $function$
  select i.id,i.product_id,i.color_key,i.image_url,i.alt_ar,i.alt_en,i.sort_order,i.is_primary
    from public.product_color_images i
    join public.products p on p.id=i.product_id
   where p.active and p.show_on_website and p.variants_enabled
   order by i.product_id,i.color_key,i.is_primary desc,i.sort_order,i.id
$function$;

alter table public.product_color_images enable row level security;
drop policy if exists product_color_images_select on public.product_color_images;
create policy product_color_images_select on public.product_color_images
  for select to authenticated using(public.can('view_products'));
drop policy if exists product_color_images_insert on public.product_color_images;
create policy product_color_images_insert on public.product_color_images
  for insert to authenticated with check(public.can('add_product') or public.can('edit_product'));
drop policy if exists product_color_images_update on public.product_color_images;
create policy product_color_images_update on public.product_color_images
  for update to authenticated using(public.can('edit_product')) with check(public.can('edit_product'));
drop policy if exists product_color_images_delete on public.product_color_images;
create policy product_color_images_delete on public.product_color_images
  for delete to authenticated using(public.can('edit_product'));

revoke all on public.product_color_images from public,anon,authenticated;
grant select,insert,update,delete on public.product_color_images to authenticated,service_role;
grant update(size_value,size_sort_order) on public.product_variants to authenticated;
revoke all on function public.product_variant_normalize_size() from public,anon,authenticated;
revoke all on function public.product_color_image_validate() from public,anon,authenticated;
revoke all on function public.replace_product_color_images(uuid,jsonb) from public,anon;
grant execute on function public.replace_product_color_images(uuid,jsonb) to authenticated,service_role;
revoke all on function public.storefront_color_images() from public;
grant execute on function public.storefront_color_images() to anon,authenticated,service_role;

commit;
