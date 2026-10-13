-- ═══════════════════════════════════════════════════════════════════════════
-- ALYQ Cloud POS · Migration 0096 — free-size variant models
--
-- Extends the existing parent-product + variants model (0043 / 0079 / 0086 and
-- branch stock 0078 / 0080) instead of creating a second one. Nothing here
-- creates a separate catalogue product per design, groups products by price,
-- or introduces a second stock ledger.
--
-- What this adds, and why each piece exists:
--
--   1. A variant may carry a MODEL NAME (\"Model A\") instead of a colour or a
--      numeric size. A free-size ring is a model with no size at all, so the
--      storefront and the register never ask for one.
--   2. A variant may carry an ordered GALLERY (`images`, max 5 https URLs) in
--      addition to its cover `image_url`. The gallery is per variant, so each
--      design shows its own photos.
--   3. The combination identity includes the model name. Two free-size models
--      of one product are two combinations; legacy colour × size rows have no
--      model name and keep exactly the identity they had.
--   4. A named model inherits the parent product's selling price in this phase:
--      it cannot carry its own price override.
--   5. Every line that references a variant (sale, return, online order,
--      reservation, stock movement) must reference a variant of THAT product.
--      Line tables also snapshot the model name, so an invoice keeps reading
--      \"Model A\" after the variant is renamed or archived.
--   6. The public storefront read (`storefront_branch_product_variants_v2`) exposes the model name and gallery of ACTIVE
--      variants of published products, and nothing else new.
--   7. The variant audit row names the model and records gallery changes.
--
-- Branch stock is untouched: `branch_stock_balances` already holds the exact
-- shelf per (branch, product, variant), so a model's stock is per branch by
-- construction. Permissions are untouched: the existing product_variants RLS
-- (add_product / edit_product / adjust_stock / delete_product) already governs
-- writes, and the new columns inherit it.
-- ═══════════════════════════════════════════════════════════════════════════

begin;

-- ── 1 + 2. model name and gallery ──────────────────────────────────────────
alter table public.product_variants
  add column if not exists display_name_ar text,
  add column if not exists display_name_en text,
  add column if not exists images jsonb not null default '[]'::jsonb;

comment on column public.product_variants.display_name_en is
  'Optional English model name (e.g. Model A). Required, with a colour/size or another model name, for a combination that has no colour or size (free-size rings).';
comment on column public.product_variants.display_name_ar is
  'Optional Arabic model name. Either language is enough; the storefront falls back across the pair.';
comment on column public.product_variants.images is
  'Ordered gallery of this variant only: up to five https image URLs. The first entry is shown first. image_url stays the cover for legacy readers.';

alter table public.product_variants drop constraint if exists product_variants_display_name_shape;
alter table public.product_variants add constraint product_variants_display_name_shape check (
  (display_name_en is null or char_length(btrim(display_name_en)) between 1 and 80)
  and (display_name_ar is null or char_length(btrim(display_name_ar)) between 1 and 80)
);

create or replace function public.product_variant_images_valid(p_images jsonb)
returns boolean
language sql
immutable
set search_path = pg_catalog
as $$
  select jsonb_typeof(p_images) = 'array'
     and jsonb_array_length(p_images) <= 5
     and not exists (
       select 1
         from jsonb_array_elements(p_images) as e(value)
        where jsonb_typeof(e.value) <> 'string'
           or char_length(e.value #>> '{}') > 2048
           or (e.value #>> '{}') !~* '^https?://[^[:space:]]+$'
     );
$$;

alter table public.product_variants drop constraint if exists product_variants_images_shape;
alter table public.product_variants add constraint product_variants_images_shape check (
  public.product_variant_images_valid(images)
);

-- ── identity: a combination must name something; a model is a name ─────────
alter table public.product_variants drop constraint if exists product_variants_dimension_present;
alter table public.product_variants add constraint product_variants_dimension_present check (
  btrim(color_key) <> ''
  or nullif(btrim(coalesce(size_value, '')), '') is not null
  or nullif(btrim(coalesce(display_name_en, '')), '') is not null
  or nullif(btrim(coalesce(display_name_ar, '')), '') is not null
);

-- ── 4. a named model inherits the parent product price in this phase ───────
alter table public.product_variants drop constraint if exists product_variants_named_model_inherits_price;
alter table public.product_variants add constraint product_variants_named_model_inherits_price check (
  (nullif(btrim(coalesce(display_name_en, '')), '') is null
     and nullif(btrim(coalesce(display_name_ar, '')), '') is null)
  or price_override is null
);

-- Two free-size models of one product must be distinguishable. The model name
-- joins the identity; for legacy rows it is the empty string, so their identity
-- is unchanged.
drop index if exists public.product_variants_combination_unique;
create unique index product_variants_combination_unique
  on public.product_variants (
    product_id,
    color_key,
    coalesce(lower(btrim(size_value)), ''),
    coalesce(lower(btrim(coalesce(nullif(btrim(display_name_en), ''), nullif(btrim(display_name_ar), '')))), '')
  );

-- ── 5. every line names a variant of ITS product; lines keep the model name ─
alter table public.sale_items        add column if not exists variant_display_name text;
alter table public.return_items      add column if not exists variant_display_name text;
alter table public.online_order_items add column if not exists variant_display_name text;

comment on column public.sale_items.variant_display_name is
  'Snapshot of the model name sold (e.g. Model A). Written once; null for colour/size lines and every legacy line.';

create or replace function public.variant_line_snapshot_guard()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_variant public.product_variants%rowtype;
begin
  if new.variant_id is null then
    return new;
  end if;
  select * into v_variant from public.product_variants where id = new.variant_id;
  if not found then
    raise exception 'Variant does not exist' using errcode = 'foreign_key_violation';
  end if;
  if v_variant.product_id <> new.product_id then
    raise exception 'Variant does not belong to this product' using errcode = 'check_violation';
  end if;
  if new.variant_display_name is null then
    new.variant_display_name := coalesce(
      nullif(btrim(coalesce(v_variant.display_name_en, '')), ''),
      nullif(btrim(coalesce(v_variant.display_name_ar, '')), '')
    );
  end if;
  return new;
end;
$$;

create or replace function public.variant_product_guard()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_product uuid;
begin
  if new.variant_id is null then
    return new;
  end if;
  select product_id into v_product from public.product_variants where id = new.variant_id;
  if v_product is null then
    raise exception 'Variant does not exist' using errcode = 'foreign_key_violation';
  end if;
  if v_product <> new.product_id then
    raise exception 'Variant does not belong to this product' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

revoke all on function public.variant_line_snapshot_guard() from public, anon, authenticated;
revoke all on function public.variant_product_guard() from public, anon, authenticated;
revoke all on function public.product_variant_images_valid(jsonb) from public;
grant execute on function public.product_variant_images_valid(jsonb) to anon, authenticated, service_role;

drop trigger if exists sale_items_variant_snapshot_guard on public.sale_items;
create trigger sale_items_variant_snapshot_guard
  before insert or update of variant_id, product_id on public.sale_items
  for each row execute function public.variant_line_snapshot_guard();

drop trigger if exists return_items_variant_snapshot_guard on public.return_items;
create trigger return_items_variant_snapshot_guard
  before insert or update of variant_id, product_id on public.return_items
  for each row execute function public.variant_line_snapshot_guard();

drop trigger if exists online_order_items_variant_snapshot_guard on public.online_order_items;
create trigger online_order_items_variant_snapshot_guard
  before insert or update of variant_id, product_id on public.online_order_items
  for each row execute function public.variant_line_snapshot_guard();

drop trigger if exists stock_reservations_variant_product_guard on public.stock_reservations;
create trigger stock_reservations_variant_product_guard
  before insert or update of variant_id, product_id on public.stock_reservations
  for each row execute function public.variant_product_guard();

drop trigger if exists stock_movements_variant_product_guard on public.stock_movements;
create trigger stock_movements_variant_product_guard
  before insert or update of variant_id, product_id on public.stock_movements
  for each row execute function public.variant_product_guard();

-- ── 7. audit names the model and records gallery changes ───────────────────
create or replace function public.product_variants_audit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_product    public.products%rowtype;
  v_label      text;
  v_action     text;
  v_details    jsonb;
  v_actor      text := coalesce(auth.uid()::text, 'system');
  v_actor_name text;
  v_model      text;
begin
  if tg_op = 'DELETE' then
    select * into v_product from public.products where id = old.product_id;
    v_model := coalesce(nullif(btrim(coalesce(old.display_name_en, '')), ''), nullif(btrim(coalesce(old.display_name_ar, '')), ''));
    v_label := coalesce(v_model, public.variant_label(old.color_en, old.color_ar, old.size, old.size_label));
    insert into public.audit_log (action, entity, entity_id, entity_label, details, user_id, user_name)
    values ('product.variant_deleted', 'product',
            old.product_id::text, coalesce(v_product.sku, old.sku),
            jsonb_build_object(
              'variant_id', old.id, 'sku', old.sku, 'color', coalesce(old.color_en, old.color_ar),
              'size', coalesce(public.numeric_label(old.size), old.size_label),
              'model', v_model,
              'label', v_label, 'stock', old.stock_quantity),
            v_actor, coalesce(v_actor_name, v_actor));
    return null;
  end if;

  select * into v_product from public.products where id = new.product_id;
  v_model := coalesce(nullif(btrim(coalesce(new.display_name_en, '')), ''), nullif(btrim(coalesce(new.display_name_ar, '')), ''));
  v_label := coalesce(v_model, public.variant_label(new.color_en, new.color_ar, new.size, new.size_label));

  if tg_op = 'INSERT' then
    v_action := 'product.variant_created';
    v_details := jsonb_build_object(
      'variant_id', new.id, 'sku', new.sku, 'color', coalesce(new.color_en, new.color_ar),
      'size', coalesce(public.numeric_label(new.size), new.size_label),
      'model', v_model,
      'label', v_label,
      'price_override', new.price_override, 'cost_override', new.cost_override,
      'low_stock_level', new.low_stock_level, 'opening_stock', new.stock_quantity,
      'gallery_count', jsonb_array_length(new.images));
  else
    -- Archive and reactivate are their own actions; everything else is an edit,
    -- and the changed fields travel with it.
    if new.active is distinct from old.active then
      v_action := case when new.active then 'product.variant_reactivated' else 'product.variant_archived' end;
    else
      v_action := 'product.variant_updated';
    end if;
    v_details := jsonb_build_object(
      'variant_id', new.id, 'sku', new.sku,
      'label', v_label,
      'changed', jsonb_strip_nulls(jsonb_build_object(
        'sku',        case when new.sku        is distinct from old.sku        then new.sku end,
        'barcode',    case when new.barcode    is distinct from old.barcode    then new.barcode end,
        'color_en',   case when new.color_en   is distinct from old.color_en   then new.color_en end,
        'color_ar',   case when new.color_ar   is distinct from old.color_ar   then new.color_ar end,
        'color_hex',  case when new.color_hex  is distinct from old.color_hex  then new.color_hex end,
        'size',       case when new.size       is distinct from old.size       then new.size end,
        'size_label', case when new.size_label is distinct from old.size_label then new.size_label end,
        'display_name_en', case when new.display_name_en is distinct from old.display_name_en then new.display_name_en end,
        'display_name_ar', case when new.display_name_ar is distinct from old.display_name_ar then new.display_name_ar end,
        'price_override', case when new.price_override is distinct from old.price_override then new.price_override end,
        'cost_override',  case when new.cost_override  is distinct from old.cost_override  then new.cost_override end,
        'low_stock_level', case when new.low_stock_level is distinct from old.low_stock_level then new.low_stock_level end,
        'image_url',  case when new.image_url  is distinct from old.image_url  then new.image_url end,
        'gallery_count', case when new.images is distinct from old.images then jsonb_array_length(new.images) end
      )));
  end if;

  insert into public.audit_log (action, entity, entity_id, entity_label, details, user_id, user_name)
  values (v_action, 'product', new.product_id::text, coalesce(v_product.sku, new.sku), v_details,
          v_actor, coalesce(v_actor_name, v_actor));

  return null;
end
$$;

-- ── 6. the public storefront read: safe fields of active, published models ─
-- Published as a NEW function rather than by changing 0080's return type: a
-- re-applied migration chain must keep `create or replace` idempotent, and
-- Postgres refuses to change a function's return type in place. The historical
-- function is left exactly as it was and remains a valid fallback.
create or replace function public.storefront_branch_product_variants_v2()
returns table(
  id uuid,product_id uuid,sku text,barcode text,color_key text,color_ar text,color_en text,color_hex text,
  size numeric,size_label text,size_value text,size_sort_order integer,image_url text,price_override numeric,
  stock_quantity integer,active boolean,sort_order integer,
  display_name_ar text,display_name_en text,images jsonb
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $function$
  select v.id,v.product_id,v.sku,v.barcode,v.color_key,v.color_ar,v.color_en,v.color_hex,
         v.size,v.size_label,v.size_value,v.size_sort_order,v.image_url,v.price_override,
         coalesce(bs.quantity,0),v.active,v.sort_order,
         v.display_name_ar,v.display_name_en,v.images
    from public.product_variants v
    join public.products p on p.id=v.product_id
    cross join lateral(select id from public.branches where is_default and active order by created_at,id limit 1) b
    left join public.branch_stock_balances bs on bs.branch_id=b.id and bs.variant_id=v.id
   where p.active and p.show_on_website and p.variants_enabled and v.active
   order by v.product_id,v.color_key,v.size_sort_order,lower(v.size_value),v.sort_order,lower(coalesce(v.display_name_en,v.display_name_ar,''))
$function$;

revoke all on function public.storefront_branch_product_variants_v2() from public;
grant execute on function public.storefront_branch_product_variants_v2() to anon, authenticated, service_role;

commit;
