-- ═══════════════════════════════════════════════════════════════════════════
-- ALYQ Cloud POS · Migration 0097 — Shared Barcode & Individual Variant Models
--
-- Extends the existing parent-product + variants architecture (0043 / 0079 / 0086
-- and branch stock 0078 / 0080) without creating a parallel inventory ledger.
--
-- What this migration establishes:
--
--   1. A variant may carry a MODEL NAME (`display_name_ar`, `display_name_en`)
--      instead of a colour or size (e.g. "شكل 1" / "Model 1").
--   2. A variant may carry an ordered GALLERY (`images`, max 5 https URLs) in
--      addition to its cover `image_url`, so each model displays its own photos.
--   3. Shared Parent Barcode without DB duplication:
--      - The parent product (`public.products.barcode`, e.g. `BR101`) owns the
--        shared barcode in `catalogue_codes`.
--      - Each model (`public.product_variants`) has its own globally unique
--        internal `sku` (e.g. `BR101-M01`, `BR101-M02`, `BR101-M03`).
--      - When a named model leaves `barcode` blank (or passes the parent's
--        shared barcode), `product_variants.barcode` stays `NULL` rather than
--        fabricating a per-model barcode or duplicating `BR101` across rows.
--      - Cross-product barcode collisions remain strictly forbidden by
--        `products_barcode_unique`, `product_variants_barcode_unique`, and
--        `catalogue_codes`.
--   4. A named model inherits the parent product's selling price (`price_override`
--      is null), and total parent stock (`products.stock_quantity`) remains the
--      automatic sum of its models' per-branch stock (`branch_stock_balances`).
--   5. Every line table (`sale_items`, `return_items`, `online_order_items`)
--      verifies that `variant_id` belongs to `product_id`, snapshots the sold
--      model name (`variant_display_name`), and inherits the parent product's
--      shared barcode onto the line when `variant.barcode` is null.
--   6. Stocktakes (`stocktake_create`) and the public storefront RPC
--      (`storefront_branch_product_variants_v2`) expose the model name, gallery,
--      and inherited shared barcode.
-- ═══════════════════════════════════════════════════════════════════════════

begin;

-- ── 1. Model name & gallery columns on product_variants ───────────────────
alter table public.product_variants
  add column if not exists display_name_ar text,
  add column if not exists display_name_en text,
  add column if not exists images jsonb not null default '[]'::jsonb;

comment on column public.product_variants.display_name_en is
  'Optional English model/shape name (e.g. Model 1). Required, when no colour/size is present, to identify an individual model under a shared parent barcode.';
comment on column public.product_variants.display_name_ar is
  'Optional Arabic model/shape name (e.g. شكل 1). Either language is sufficient; UI falls back across the pair.';
comment on column public.product_variants.images is
  'Ordered gallery of this specific model/variant: up to five https image URLs. image_url remains the primary cover photo.';

-- Column-level UPDATE grant required because migration 0061 replaced table-level
-- UPDATE on product_variants with an explicit column list for authenticated.
grant update (display_name_ar, display_name_en, images)
  on table public.product_variants to authenticated;

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

revoke all on function public.product_variant_images_valid(jsonb) from public;
grant execute on function public.product_variant_images_valid(jsonb) to anon, authenticated, service_role;

alter table public.product_variants drop constraint if exists product_variants_images_shape;
alter table public.product_variants add constraint product_variants_images_shape check (
  public.product_variant_images_valid(images)
);

-- ── 2. Combination identity & price inheritance for named models ──────────
alter table public.product_variants drop constraint if exists product_variants_dimension_present;
alter table public.product_variants add constraint product_variants_dimension_present check (
  btrim(color_key) <> ''
  or nullif(btrim(coalesce(size_value, '')), '') is not null
  or nullif(btrim(coalesce(display_name_en, '')), '') is not null
  or nullif(btrim(coalesce(display_name_ar, '')), '') is not null
);

alter table public.product_variants drop constraint if exists product_variants_named_model_inherits_price;
alter table public.product_variants add constraint product_variants_named_model_inherits_price check (
  (nullif(btrim(coalesce(display_name_en, '')), '') is null
     and nullif(btrim(coalesce(display_name_ar, '')), '') is null)
  or price_override is null
);

drop index if exists public.product_variants_combination_unique;
create unique index product_variants_combination_unique
  on public.product_variants (
    product_id,
    color_key,
    coalesce(lower(btrim(size_value)), ''),
    coalesce(lower(btrim(coalesce(nullif(btrim(display_name_en), ''), nullif(btrim(display_name_ar), '')))), '')
  );

-- ── 3. Shared Parent Barcode handling (no forced per-model barcode) ───────
-- Named models share their parent product's barcode (`products.barcode`).
-- If a named model is inserted or updated with a blank barcode or with a
-- barcode equal to its own parent product's barcode, keep `new.barcode = null`
-- so the shared barcode is stored once on `public.products` without duplicate
-- storage or false self-collision in `catalogue_codes`.
-- Legacy colour/size variants keep exact 0086 behaviour (auto-deriving from SKU
-- on INSERT when barcode is blank).
create or replace function public.product_variants_autogenerate_barcode()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_normalized text;
  v_parent_barcode text;
  v_is_named_model boolean;
begin
  v_is_named_model :=
    nullif(btrim(coalesce(new.display_name_en, '')), '') is not null
    or nullif(btrim(coalesce(new.display_name_ar, '')), '') is not null;

  if v_is_named_model then
    if btrim(coalesce(new.barcode, '')) = '' then
      new.barcode := null;
      return new;
    end if;
    select barcode into v_parent_barcode
      from public.products
     where id = new.product_id;
    if v_parent_barcode is not null
       and btrim(v_parent_barcode) <> ''
       and lower(btrim(new.barcode)) = lower(btrim(v_parent_barcode)) then
      new.barcode := null;
      return new;
    end if;
    return new;
  end if;

  -- Legacy colour/size variants: only auto-derive on INSERT when blank.
  if tg_op <> 'INSERT' then
    return new;
  end if;
  if btrim(coalesce(new.barcode, '')) <> '' then
    return new;
  end if;

  v_normalized := upper(btrim(coalesce(new.sku, '')));
  if v_normalized = '' or char_length(v_normalized) > 80 then
    return new;
  end if;
  if v_normalized !~ '^[\x20-\x7E]+$' then
    return new;
  end if;

  new.barcode := v_normalized;
  return new;
end;
$$;

comment on function public.product_variants_autogenerate_barcode() is
  'For named models (shared parent barcode), keeps NEW.barcode NULL when blank or equal to the parent product barcode so the shared barcode lives once on products.barcode. For legacy colour/size variants on INSERT, fills a blank NEW.barcode from ASCII NEW.sku.';

drop trigger if exists product_variants_autogenerate_barcode on public.product_variants;
create trigger product_variants_autogenerate_barcode
  before insert or update of barcode, display_name_en, display_name_ar on public.product_variants
  for each row execute function public.product_variants_autogenerate_barcode();

-- ── 4. Line snapshots & product-variant integrity guards ──────────────────
alter table public.sale_items         add column if not exists variant_display_name text;
alter table public.return_items       add column if not exists variant_display_name text;
alter table public.online_order_items add column if not exists variant_display_name text;

comment on column public.sale_items.variant_display_name is
  'Immutable snapshot of the sold model name (e.g. شكل 1 / Model 1). Null for colour/size lines and simple products.';
comment on column public.return_items.variant_display_name is
  'Immutable snapshot of the returned model name.';
comment on column public.online_order_items.variant_display_name is
  'Immutable snapshot of the ordered model name.';

create or replace function public.variant_line_snapshot_guard()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_variant public.product_variants%rowtype;
  v_parent_barcode text;
begin
  if new.variant_id is null then
    new.variant_display_name := null;
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

  -- When a model uses the parent product's shared barcode (v_variant.barcode is null),
  -- snapshot the parent product's barcode onto the invoice/return/order line.
  if btrim(coalesce(new.barcode, '')) = '' then
    select nullif(btrim(coalesce(p.barcode, '')), '')
      into v_parent_barcode
      from public.products p
     where p.id = new.product_id;
    new.barcode := coalesce(nullif(btrim(coalesce(v_variant.barcode, '')), ''), v_parent_barcode);
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

-- ── 5. Stocktake creation: include model label and shared parent barcode ──
create or replace function public.stocktake_create(p_blind boolean default false,p_note text default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_actor text; v_name text; v_id uuid:=gen_random_uuid(); v_ref text; v_branch uuid:=public.current_branch_id();
  v_shelf record; v_lines integer:=0; v_label text;
begin
  select a.actor_id,a.actor_name into v_actor,v_name from public.stocktake_assert_adjust() a;
  if v_branch is null then raise exception 'An active stocktake branch is required' using errcode='42501'; end if;
  if p_note is not null and char_length(btrim(p_note))>500 then raise exception 'Stocktake note is too long' using errcode='23514'; end if;
  v_ref:='ST-'||to_char(clock_timestamp(),'YYYYMMDD')||'-'||upper(substr(replace(v_id::text,'-',''),1,8));
  insert into public.stocktakes(id,reference,status,blind,note,created_by,created_by_name,branch_id)
  values(v_id,v_ref,'counting',coalesce(p_blind,false),nullif(btrim(p_note),''),v_actor,v_name,v_branch);

  for v_shelf in
    select p.id product_id,p.name_ar,p.name_en,
           case when p.variants_enabled then v.id else null end variant_id,
           case when p.variants_enabled then v.sku else p.sku end sku,
           case when p.variants_enabled then coalesce(nullif(btrim(coalesce(v.barcode,'')),''), p.barcode) else p.barcode end barcode,
           v.color_en,v.color_ar,v.size,v.size_value,v.display_name_en,v.display_name_ar,
           coalesce(bs.quantity,0) quantity
      from public.products p
      left join public.product_variants v on v.product_id=p.id and p.variants_enabled and v.active
      left join public.branch_stock_balances bs on bs.branch_id=v_branch and bs.product_id=p.id
        and bs.variant_id is not distinct from(case when p.variants_enabled then v.id else null end)
     where p.active and p.stock_tracking_enabled and (not p.variants_enabled or v.id is not null)
     order by p.sku,v.color_key,v.size_sort_order,v.sku
  loop
    v_label:=case when v_shelf.variant_id is null then '' else
      concat_ws(
        ' / ',
        coalesce(
          nullif(btrim(coalesce(v_shelf.color_en, v_shelf.color_ar, '')), ''),
          nullif(btrim(coalesce(v_shelf.display_name_en, v_shelf.display_name_ar, '')), '')
        ),
        v_shelf.size_value
      ) end;
    insert into public.stocktake_lines(
      stocktake_id,product_id,variant_id,shelf_key,sku,barcode,product_name_ar,product_name_en,variant_label,expected_quantity
    ) values(v_id,v_shelf.product_id,v_shelf.variant_id,coalesce(v_shelf.variant_id,v_shelf.product_id)::text,
      v_shelf.sku,v_shelf.barcode,v_shelf.name_ar,v_shelf.name_en,v_label,v_shelf.quantity);
    v_lines:=v_lines+1;
  end loop;
  if v_lines=0 then raise exception 'There is no tracked stock to count' using errcode='23514'; end if;
  insert into public.audit_log(action,entity,entity_id,entity_label,details,user_id,user_name,branch_id)
  values('stocktake.created','stocktake',v_id::text,v_ref,jsonb_build_object('lines',v_lines,'blind',coalesce(p_blind,false)),v_actor,v_name,v_branch);
  return jsonb_build_object('ok',true,'session',public.stocktake_document(v_id));
end
$function$;

-- ── 6. Audit trail records model name and gallery changes ─────────────────
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

-- ── 7. Public storefront read: active models with name & gallery ──────────
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

-- ── 8. Keep application/database health contract aligned with 0097 ────────
create or replace function public.system_health_probe()
returns jsonb
language plpgsql
stable
security definer
set search_path=pg_catalog,public
as $function$
declare v_branch uuid:=public.current_branch_id();
begin
  if auth.uid() is null then raise exception 'Authenticated health check required' using errcode='42501'; end if;
  return jsonb_build_object(
    'authenticated',true,'server_time',now(),
    'migration','0097_shared_barcode_variant_models.sql','migration_count',97,
    'active_branch_id',v_branch,
    'branch_context_valid',v_branch is not null and public.can_access_branch(v_branch));
end
$function$;

comment on function public.system_health_probe() is
  'Authenticated health contract for migration 0097_shared_barcode_variant_models.sql (count 97).';

commit;
