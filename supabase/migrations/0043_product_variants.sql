-- ═══════════════════════════════════════════════════════════════════════════
-- ALYQ Cloud POS · Migration 0043 — product variants (colours, numeric sizes)
--
-- THE MODEL, in one paragraph.
--
-- A product stays the merchandising entity: one row, one name, one page, one
-- price list. What changes is where the STOCK lives. When
-- `products.variants_enabled` is true, `product_variants.stock_quantity` is the
-- stock of record and `products.stock_quantity` becomes a ROLLUP of it,
-- maintained by a trigger and never written by hand. A till sale, an online
-- order, a reservation and a return all name the exact combination
-- (product + colour + size + the frozen snapshot of what it looked like), so
-- selling Gold / 17 can only ever take units off Gold / 17 — the rule the whole
-- feature exists to enforce.
--
-- WHAT THIS FILE DELIBERATELY DOES NOT DO.
--
--   · It does not duplicate products per colour. Two rows for one ring is two
--     names, two websites, two price lists and a report that cannot add them up.
--   · It does not make `color_key` a display string. The identity of a colour is
--     captured once, when the combination is created, and a later rename changes
--     the words on the label — never the identity, the uniqueness rule or the
--     history that points at it.
--   · It does not default an existing product's stock onto the first variant.
--     Enabling variants on a product that holds stock REQUIRES an explicit
--     distribution that adds up to exactly what the product holds; anything else
--     is refused, so the conversion can neither create nor destroy a unit.
--   · It does not let a product leave variant mode while any history names one of
--     its variants. That stock is not a number to be quietly collapsed.
--   · It does not change the shape of any existing function's arguments. Where a
--     function needed a variant it gained ONE argument at the end with a default;
--     the old call signature keeps working and means the same thing it did.
--
-- Everything below is one file on purpose: the schema, the guards, the five
-- redefined functions and the new reads are a single deployable unit, so a
-- half-applied variant model cannot exist.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. the flag that decides where stock lives ─────────────────────────────
alter table public.products
  add column if not exists variants_enabled boolean not null default false;

comment on column public.products.variants_enabled is
  'True when this product sells by variant (colour / size). stock_quantity is then a ROLLUP of product_variants.stock_quantity, kept by trigger and refused as a direct write.';

-- ── 2. the combination ─────────────────────────────────────────────────────
create table if not exists public.product_variants (
  id              uuid primary key default gen_random_uuid(),
  product_id      uuid not null references public.products (id) on delete cascade,
  sku             text not null,
  barcode         text,
  /**
   * The STABLE identity of the colour: normalized once from the first label and
   * never rewritten by a rename, so "Gold" → "Yellow Gold" keeps every sale,
   * movement and reservation pointing at the same combination.
   */
  color_key       text not null default '',
  color_ar        text,
  color_en        text,
  color_hex       text,
  /**
   * The NUMERIC size — 16, 16.5, 17. Sizes sort numerically everywhere because
   * they are numbers, not strings: '16.5' must never sort before '16'.
   */
  size            numeric(8, 2),
  /** Textual size, used only when there is no number ("One Size"). */
  size_label      text,
  image_url       text,
  /** Null → the product's selling_price. Server-side authority either way. */
  price_override  numeric(14, 2),
  /** Null → the product's cost_price. */
  cost_override   numeric(14, 2),
  stock_quantity  integer not null default 0,
  low_stock_level integer not null default 0,
  active          boolean not null default true,
  sort_order      integer not null default 0,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  constraint product_variants_sku_not_blank check (btrim(sku) <> ''),
  -- A combination must name SOMETHING: a colour, a number, or a label.
  constraint product_variants_dimension_present check (
    btrim(color_key) <> '' or size is not null or btrim(coalesce(size_label, '')) <> ''
  ),
  constraint product_variants_size_positive    check (size is null or size > 0),
  constraint product_variants_stock_not_negative check (stock_quantity >= 0),
  constraint product_variants_low_not_negative   check (low_stock_level >= 0),
  constraint product_variants_price_not_negative check (price_override is null or price_override >= 0),
  constraint product_variants_cost_not_negative  check (cost_override is null or cost_override >= 0),
  constraint product_variants_hex_shape          check (color_hex is null or color_hex ~* '^#[0-9a-f]{6}$'),
  constraint product_variants_label_shape        check (size_label is null or length(btrim(size_label)) between 1 and 40)
);

comment on table public.product_variants is
  'One buyable combination of a product: colour (stable color_key) × numeric size. Stock lives here when products.variants_enabled is true.';

comment on column public.product_variants.color_key is
  'Stable colour identity (normalized once, never rewritten by a rename). Uniqueness and every historical reference key off this, never off the display label.';
comment on column public.product_variants.price_override is
  'Selling price for this combination when it differs from the product. Null means "the product price". The server always wins over the client.';
comment on column public.product_variants.stock_quantity is
  'Units of THIS combination on the shelf. When the product has variants_enabled, products.stock_quantity is the rollup of this column and cannot be written directly.';

-- One row per exact combination. `coalesce(size, -1)` because -1 cannot be a
-- real size (the check above requires > 0), and a null in a unique index would
-- otherwise compare as "distinct" and let the same combination exist twice.
create unique index if not exists product_variants_combination_unique
  on public.product_variants (product_id, color_key, coalesce(size, -1), coalesce(btrim(size_label), ''));

-- Codes are compared case- and whitespace-insensitively, the way a scanner and
-- the app's own uniqueness checks compare them.
create unique index if not exists product_variants_sku_unique
  on public.product_variants (lower(btrim(sku)));
create unique index if not exists product_variants_barcode_unique
  on public.product_variants (lower(btrim(barcode)))
  where btrim(coalesce(barcode, '')) <> '';

create index if not exists product_variants_product_idx
  on public.product_variants (product_id, color_key, size);
create index if not exists product_variants_active_idx
  on public.product_variants (product_id, active) where active;

-- ── 3. one registry of every scannable code in the catalogue ───────────────
-- A barcode or SKU must resolve to exactly ONE sellable thing. Before variants,
-- that was guaranteed by two unique constraints on `products`. Now that the
-- codes can live on either a product or one of its combinations, the guarantee
-- has to be shared — otherwise a variant could take a barcode a product already
-- owns and a scan would stop being unambiguous.
create table if not exists public.catalogue_codes (
  kind       text not null,
  code_key   text not null,
  code       text not null,
  product_id uuid not null references public.products (id) on delete cascade,
  variant_id uuid references public.product_variants (id) on delete cascade,
  primary key (kind, code_key),
  constraint catalogue_codes_kind_shape check (kind in ('sku', 'barcode')),
  constraint catalogue_codes_key_not_blank check (btrim(code_key) <> '')
);

comment on table public.catalogue_codes is
  'Every SKU and barcode in the catalogue, keyed case-insensitively, whether it belongs to a product or to one of its variants. Kept by trigger; nothing writes it directly, which is what makes a scan unambiguous.';

insert into public.catalogue_codes (kind, code_key, code, product_id, variant_id)
select 'sku', lower(btrim(p.sku)), p.sku, p.id, null
  from public.products p
 where btrim(coalesce(p.sku, '')) <> ''
on conflict (kind, code_key) do nothing;

insert into public.catalogue_codes (kind, code_key, code, product_id, variant_id)
select 'barcode', lower(btrim(p.barcode)), p.barcode, p.id, null
  from public.products p
 where btrim(coalesce(p.barcode, '')) <> ''
on conflict (kind, code_key) do nothing;

-- ── 4. history keeps the exact combination, frozen ─────────────────────────
-- Every line that left the shop records WHICH combination it was, in columns
-- that are written once and never updated: a rename, a re-price or an archive
-- must not rewrite what an invoice says was sold.
alter table public.sale_items
  add column if not exists variant_id uuid references public.product_variants (id) on delete restrict,
  add column if not exists variant_color_ar text,
  add column if not exists variant_color_en text,
  add column if not exists variant_size numeric(8, 2),
  add column if not exists variant_size_label text;

alter table public.return_items
  add column if not exists variant_id uuid references public.product_variants (id) on delete restrict,
  add column if not exists variant_color_ar text,
  add column if not exists variant_color_en text,
  add column if not exists variant_size numeric(8, 2),
  add column if not exists variant_size_label text;

alter table public.online_order_items
  add column if not exists variant_id uuid references public.product_variants (id) on delete restrict,
  add column if not exists variant_color_ar text,
  add column if not exists variant_color_en text,
  add column if not exists variant_size numeric(8, 2),
  add column if not exists variant_size_label text;

alter table public.stock_movements
  add column if not exists variant_id uuid references public.product_variants (id) on delete restrict,
  add column if not exists variant_color_ar text,
  add column if not exists variant_color_en text,
  add column if not exists variant_size numeric(8, 2);

alter table public.stock_reservations
  add column if not exists variant_id uuid references public.product_variants (id) on delete restrict;

comment on column public.sale_items.variant_id is
  'The exact variant sold, when the product sells by variant. Null on every legacy line — those keep rendering from the product snapshot alone.';
comment on column public.sale_items.variant_size is
  'Snapshot of the numeric size sold. Frozen here, so the invoice still says 17 after the variant is renamed, re-priced or archived.';
comment on column public.stock_movements.variant_id is
  'The exact variant the movement moved, when it moved one. `quantity_before`/`quantity_after` then describe that variant, not the product rollup.';
comment on column public.stock_reservations.variant_id is
  'The exact variant this order is holding. Available to promise is per variant: stock − Σ reserved for that (product, variant).';

create index if not exists sale_items_variant_idx on public.sale_items (variant_id);
create index if not exists return_items_variant_idx on public.return_items (variant_id);
create index if not exists online_order_items_variant_idx on public.online_order_items (variant_id);
create index if not exists stock_movements_variant_idx on public.stock_movements (variant_id, created_at desc);
create index if not exists stock_reservations_variant_idx on public.stock_reservations (variant_id, status);

-- Duplicate holds on one line would hide the same units twice. Merge any that
-- exist first (sum-preserving: the units held do not change), then forbid them.
do $$
begin
  -- Keep one row per (order, product, variant) and put the whole held quantity
  -- on it, so merging never changes how many units are held.
  with keep as (
    select distinct on (online_order_id, product_id, variant_id)
           id as keep_id, online_order_id, product_id, variant_id
      from public.stock_reservations
     order by online_order_id, product_id, variant_id, created_at, id
  ),
  totals as (
    select online_order_id, product_id, variant_id, sum(quantity) as total
      from public.stock_reservations
     group by online_order_id, product_id, variant_id
    having count(*) > 1
  )
  update public.stock_reservations r
     set quantity = t.total
    from totals t
    join keep k
      on k.online_order_id = t.online_order_id
     and k.product_id = t.product_id
     and k.variant_id is not distinct from t.variant_id
   where r.id = k.keep_id;

  delete from public.stock_reservations r
   using (
     select distinct on (online_order_id, product_id, variant_id)
            id as keep_id, online_order_id, product_id, variant_id
       from public.stock_reservations
      order by online_order_id, product_id, variant_id, created_at, id
   ) k
   where r.online_order_id = k.online_order_id
     and r.product_id = k.product_id
     and r.variant_id is not distinct from k.variant_id
     and r.id <> k.keep_id;
end
$$;

create unique index if not exists stock_reservations_open_unique
  on public.stock_reservations (
    online_order_id,
    product_id,
    coalesce(variant_id, '00000000-0000-0000-0000-000000000000'::uuid)
  )
  where status = 'reserved';

-- ── 5. helpers ─────────────────────────────────────────────────────────────

/**
 * The stable identity of a colour: trimmed, whitespace-collapsed, case-folded.
 *
 * Deliberately NOT the display label. The label is what a shop renames (Gold →
 * Yellow Gold, in either language); this is what every sale, movement,
 * reservation and uniqueness rule points at.
 */
create or replace function public.variant_color_key(p_label text)
returns text
language sql
immutable
as $$
  select lower(regexp_replace(btrim(coalesce(p_label, '')), '\s+', ' ', 'g'))
$$;

comment on function public.variant_color_key(text) is
  'The stable identity of a colour: captured once from the first label and never rewritten by a rename. Display labels (color_ar/color_en) may change freely.';

/** 17.00 → 17, 17.50 → 17.5, 16.25 → 16.25. For messages and labels only. */
create or replace function public.numeric_label(p_value numeric)
returns text
language sql
immutable
as $$
  select trim(trailing '.' from trim(trailing '0' from to_char(p_value, 'FM999999990.99')))
$$;

/**
 * "Gold / 17" — the words a person reads for a combination, in that order.
 *
 * Used for refusals ("Only 2 of Gold / 17 in stock") so the message names the
 * exact combination that was asked for, never the product as a whole. Returns
 * null when the combination names nothing, and callers fall back to the SKU.
 */
create or replace function public.variant_label(
  p_color_en  text,
  p_color_ar  text,
  p_size      numeric,
  p_size_label text
)
returns text
language sql
immutable
as $$
  select nullif(concat_ws(' / ',
           nullif(btrim(coalesce(p_color_en, p_color_ar, '')), ''),
           case when p_size is not null then public.numeric_label(p_size)
                else nullif(btrim(coalesce(p_size_label, '')), '') end), '')
$$;

/**
 * A uuid, or null — never an exception.
 *
 * A forged or stale variant id used to reach a `::uuid` cast and fail with
 * 22P02, which reads like a database fault rather than a refusal. This turns
 * "not a variant id" into the same clean, explained refusal as "a variant id
 * that is not mine".
 */
create or replace function public.variant_id_of(p_raw text)
returns uuid
language plpgsql
immutable
as $$
declare
  v text := lower(btrim(coalesce(p_raw, '')));
begin
  if v ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return v::uuid;
  end if;
  return null;
end
$$;

/** Units of one exact combination held by orders that are still open. */
create or replace function public.reserved_quantity_variant(p_variant_id uuid)
returns integer
language sql
stable
as $$
  select coalesce(sum(quantity), 0)::integer
    from public.stock_reservations
   where variant_id = p_variant_id
     and status = 'reserved'
$$;

comment on function public.reserved_quantity_variant(uuid) is
  'Units of one variant held by open orders. Available to promise is stock_quantity − this, per exact combination.';

-- ── 6. the identity of a colour is captured once ───────────────────────────
create or replace function public.variants_fill_color_key()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    -- An explicit key wins (it is how a caller may intentionally group two
    -- labels under one colour); otherwise it is derived from the first label.
    if btrim(coalesce(new.color_key, '')) = '' then
      new.color_key := public.variant_color_key(coalesce(new.color_en, new.color_ar, ''));
    else
      new.color_key := public.variant_color_key(new.color_key);
    end if;
  else
    -- An UPDATE that renames the colour carries no key, so the existing one is
    -- kept — that is the whole point of a stable identity. A caller that really
    -- means to move the combination to another colour sends a key explicitly,
    -- and the uniqueness index decides whether it is free.
    if btrim(coalesce(new.color_key, '')) = '' then
      new.color_key := old.color_key;
    else
      new.color_key := public.variant_color_key(new.color_key);
    end if;
    new.updated_at := now();
  end if;
  return new;
end
$$;

drop trigger if exists product_variants_fill_color_key on public.product_variants;
create trigger product_variants_fill_color_key
  before insert or update on public.product_variants
  for each row execute function public.variants_fill_color_key();

-- ── 7. the rollup: products.stock_quantity follows its variants ────────────
create or replace function public.variants_sync_product_stock()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_product_id uuid;
  v_total      integer;
begin
  v_product_id := case when tg_op = 'DELETE' then old.product_id else new.product_id end;

  select coalesce(sum(stock_quantity), 0)::integer
    into v_total
    from public.product_variants
   where product_id = v_product_id;

  -- The rollup writes products.stock_quantity through the guard below. The
  -- setting names the ONE product this statement is allowed to move, so a
  -- caller cannot ride the trigger to write some other product's rollup.
  perform set_config('alyq.variant_rollup_product', v_product_id::text, true);

  -- Nothing to say when the number did not move (a rename): skipping the write
  -- keeps the product row untouched, and with it the lock.
  update public.products
     set stock_quantity = v_total,
         updated_at     = now()
   where id = v_product_id
     and stock_quantity is distinct from v_total;

  return null;
end
$$;

comment on function public.variants_sync_product_stock() is
  'Keeps products.stock_quantity equal to the sum of its variants. SECURITY DEFINER so an inventory clerk with adjust_stock but without edit_product can still move variant stock; the guard below lets exactly this write through.';

drop trigger if exists product_variants_sync_product_stock on public.product_variants;
create trigger product_variants_sync_product_stock
  after insert or update of stock_quantity or delete on public.product_variants
  for each row execute function public.variants_sync_product_stock();

/**
 * A variant product's total is derived, not editable.
 *
 * The rollup is the only writer. Anybody else — the app, a script, a well-meant
 * psql session — is refused, because writing the total while the variants hold
 * the truth is how a shop ends up counting the same ring twice (or not at all).
 */
create or replace function public.products_block_direct_stock_write()
returns trigger
language plpgsql
as $$
begin
  if new.variants_enabled
     and new.stock_quantity is distinct from old.stock_quantity
     and current_setting('alyq.variant_rollup_product', true) is distinct from new.id::text
  then
    raise exception 'Product % sells by variant — adjust the variant''s stock instead of the product total', new.sku
      using errcode = 'check_violation';
  end if;
  return new;
end
$$;

comment on function public.products_block_direct_stock_write() is
  'Refuses a direct write to a variant product''s stock rollup. The rollup trigger identifies itself so exactly one writer can move the number.';

drop trigger if exists products_block_direct_stock_write on public.products;
create trigger products_block_direct_stock_write
  before update of stock_quantity on public.products
  for each row execute function public.products_block_direct_stock_write();

/** A combination's price and cost answer to the same capabilities as the product's. */
create or replace function public.variants_enforce_price_authority()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'UPDATE' then
    if new.price_override is distinct from old.price_override and not public.can('change_price') then
      raise exception 'Changing a variant price requires the change_price capability'
        using errcode = 'insufficient_privilege';
    end if;
    if new.cost_override is distinct from old.cost_override and not public.can('change_cost') then
      raise exception 'Changing a variant cost requires the change_cost capability'
        using errcode = 'insufficient_privilege';
    end if;
  else
    if new.price_override is not null and not public.can('change_price') then
      raise exception 'Setting a variant price requires the change_price capability'
        using errcode = 'insufficient_privilege';
    end if;
    if new.cost_override is not null and not public.can('change_cost') then
      raise exception 'Setting a variant cost requires the change_cost capability'
        using errcode = 'insufficient_privilege';
    end if;
  end if;
  return new;
end
$$;

drop trigger if exists product_variants_enforce_price_authority on public.product_variants;
create trigger product_variants_enforce_price_authority
  before insert or update on public.product_variants
  for each row execute function public.variants_enforce_price_authority();

-- ── 8. one registry, kept by trigger ───────────────────────────────────────
create or replace function public.catalogue_codes_sync_product()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'DELETE' then
    delete from public.catalogue_codes where product_id = old.id and variant_id is null;
    return null;
  end if;

  delete from public.catalogue_codes where product_id = new.id and variant_id is null;

  begin
    if btrim(coalesce(new.sku, '')) <> '' then
      insert into public.catalogue_codes (kind, code_key, code, product_id, variant_id)
      values ('sku', lower(btrim(new.sku)), new.sku, new.id, null);
    end if;
    if btrim(coalesce(new.barcode, '')) <> '' then
      insert into public.catalogue_codes (kind, code_key, code, product_id, variant_id)
      values ('barcode', lower(btrim(new.barcode)), new.barcode, new.id, null);
    end if;
  exception when unique_violation then
    raise exception 'Code % is already used by another product or variant',
      coalesce(nullif(btrim(coalesce(new.barcode, '')), ''), new.sku)
      using errcode = 'unique_violation';
  end;

  return null;
end
$$;

drop trigger if exists catalogue_codes_sync_product on public.products;
create trigger catalogue_codes_sync_product
  after insert or update of sku, barcode or delete on public.products
  for each row execute function public.catalogue_codes_sync_product();

create or replace function public.catalogue_codes_sync_variant()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'DELETE' then
    delete from public.catalogue_codes where variant_id = old.id;
    return null;
  end if;

  delete from public.catalogue_codes where variant_id = new.id;

  begin
    insert into public.catalogue_codes (kind, code_key, code, product_id, variant_id)
    values ('sku', lower(btrim(new.sku)), new.sku, new.product_id, new.id);

    if btrim(coalesce(new.barcode, '')) <> '' then
      insert into public.catalogue_codes (kind, code_key, code, product_id, variant_id)
      values ('barcode', lower(btrim(new.barcode)), new.barcode, new.product_id, new.id);
    end if;
  exception when unique_violation then
    raise exception 'Code % is already used by another product or variant',
      coalesce(nullif(btrim(coalesce(new.barcode, '')), ''), new.sku)
      using errcode = 'unique_violation';
  end;

  return null;
end
$$;

drop trigger if exists catalogue_codes_sync_variant on public.product_variants;
create trigger catalogue_codes_sync_variant
  after insert or update of sku, barcode or delete on public.product_variants
  for each row execute function public.catalogue_codes_sync_variant();

-- ── 9. the variant lifecycle in the audit trail ────────────────────────────
insert into public.audit_actions (action, entity) values
  ('product.variant_created',     'product'),
  ('product.variant_updated',     'product'),
  ('product.variant_archived',    'product'),
  ('product.variant_reactivated', 'product'),
  ('product.variant_deleted',     'product'),
  ('product.variants_enabled',    'product'),
  ('product.variants_disabled',   'product')
on conflict (action) do nothing;

/**
 * Every variant write leaves a row, whatever path made it.
 *
 * The app also records these in demo mode (where there is no database to do it)
 * — in live mode this trigger is the record, so a variant edited through
 * PostgREST, a script or the admin screen produces the same entry.
 */
create or replace function public.product_variants_audit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_product   public.products%rowtype;
  v_label     text;
  v_action    text;
  v_details   jsonb;
  v_actor     text := coalesce(auth.uid()::text, 'system');
  v_actor_name text;
begin
  if tg_op = 'DELETE' then
    select * into v_product from public.products where id = old.product_id;
    v_label := public.variant_label(old.color_en, old.color_ar, old.size, old.size_label);
    insert into public.audit_log (action, entity, entity_id, entity_label, details, user_id, user_name)
    values ('product.variant_deleted', 'product',
            old.product_id::text, coalesce(v_product.sku, old.sku),
            jsonb_build_object(
              'variant_id', old.id, 'sku', old.sku, 'color', coalesce(old.color_en, old.color_ar),
              'size', coalesce(public.numeric_label(old.size), old.size_label),
              'label', v_label, 'stock', old.stock_quantity),
            v_actor, coalesce(v_actor_name, v_actor));
    return null;
  end if;

  select * into v_product from public.products where id = new.product_id;

  if tg_op = 'INSERT' then
    v_action := 'product.variant_created';
    v_details := jsonb_build_object(
      'variant_id', new.id, 'sku', new.sku, 'color', coalesce(new.color_en, new.color_ar),
      'size', coalesce(public.numeric_label(new.size), new.size_label),
      'label', public.variant_label(new.color_en, new.color_ar, new.size, new.size_label),
      'price_override', new.price_override, 'cost_override', new.cost_override,
      'low_stock_level', new.low_stock_level, 'opening_stock', new.stock_quantity);
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
      'label', public.variant_label(new.color_en, new.color_ar, new.size, new.size_label),
      'changed', jsonb_strip_nulls(jsonb_build_object(
        'sku',        case when new.sku        is distinct from old.sku        then new.sku end,
        'barcode',    case when new.barcode    is distinct from old.barcode    then new.barcode end,
        'color_en',   case when new.color_en   is distinct from old.color_en   then new.color_en end,
        'color_ar',   case when new.color_ar   is distinct from old.color_ar   then new.color_ar end,
        'color_hex',  case when new.color_hex  is distinct from old.color_hex  then new.color_hex end,
        'size',       case when new.size       is distinct from old.size       then new.size end,
        'size_label', case when new.size_label is distinct from old.size_label then new.size_label end,
        'price_override', case when new.price_override is distinct from old.price_override then new.price_override end,
        'cost_override',  case when new.cost_override  is distinct from old.cost_override  then new.cost_override end,
        'low_stock_level', case when new.low_stock_level is distinct from old.low_stock_level then new.low_stock_level end,
        'image_url',  case when new.image_url  is distinct from old.image_url  then new.image_url end
      )));
  end if;

  insert into public.audit_log (action, entity, entity_id, entity_label, details, user_id, user_name)
  values (v_action, 'product', new.product_id::text, coalesce(v_product.sku, new.sku), v_details,
          v_actor, coalesce(v_actor_name, v_actor));

  return null;
end
$$;

drop trigger if exists product_variants_audit on public.product_variants;
create trigger product_variants_audit
  after insert or update or delete on public.product_variants
  for each row execute function public.product_variants_audit();

-- Stock corrections on a variant use the existing stock.adjusted/stock.corrected
-- vocabulary: the movement rows already carry the variant and the columns above
-- carry the colour/size snapshot, so no new action is needed for them.

-- ── 10. RLS and privileges ─────────────────────────────────────────────────
alter table public.product_variants enable row level security;
alter table public.catalogue_codes   enable row level security;

-- Reading the combinations is ordinary catalogue reading: anybody signed in may
-- (the same people who can already read `products`), which is what lets the
-- register, the admin table, the inventory list and the reports all show them.
drop policy if exists product_variants_select on public.product_variants;
create policy product_variants_select on public.product_variants
  for select to authenticated using (true);

-- Adding a combination is catalog authoring, editing one is an edit.
drop policy if exists product_variants_insert on public.product_variants;
create policy product_variants_insert on public.product_variants
  for insert to authenticated
  with check (public.can('add_product') or public.can('edit_product'));

drop policy if exists product_variants_update on public.product_variants;
create policy product_variants_update on public.product_variants
  for update to authenticated
  using (public.can('adjust_stock') or public.can('edit_product'))
  with check (public.can('adjust_stock') or public.can('edit_product'));

drop policy if exists product_variants_delete on public.product_variants;
create policy product_variants_delete on public.product_variants
  for delete to authenticated using (public.can('delete_product'));

-- The registry is derived state. It is readable (so a screen can explain why a
-- code is taken) and written only by its triggers, which run as the owner.
drop policy if exists catalogue_codes_select on public.catalogue_codes;
create policy catalogue_codes_select on public.catalogue_codes
  for select to authenticated using (true);

revoke all on table public.catalogue_codes from anon, authenticated;
grant select on table public.catalogue_codes to authenticated;

grant select, insert, update, delete on table public.product_variants to authenticated;
revoke all on table public.product_variants from anon;

-- ── 11. switching a product into and out of variant stock ──────────────────

/**
 * Turn on variant stock for a product, distributing what is already on the shelf.
 *
 * `p_opening` is an object of variant id → units, and its sum MUST equal
 * `products.stock_quantity`. That is the whole guard: the conversion may neither
 * create nor destroy a unit, and it never quietly assigns the existing stock to
 * whichever variant happens to be first. A shop that does not know the split is
 * told to count first, which is the honest answer.
 *
 * No stock movements are written. Nothing moved: the same physical units were
 * re-expressed from one product total into its combinations. The conversion is
 * recorded where an event with no movement belongs — an audit row carrying the
 * complete distribution — and each variant's first real movement later shows
 * `quantity_before` as the opening figure, so the ledger still starts where the
 * conversion ended.
 */
create or replace function public.enable_product_variants(
  p_product_id uuid,
  p_opening    jsonb,
  p_user_id    text default null,
  p_user_name  text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_product   public.products%rowtype;
  v_variant   public.product_variants%rowtype;
  v_opening   jsonb := coalesce(p_opening, '{}'::jsonb);
  v_sum       integer := 0;
  v_qty       integer;
  v_key       text;
  v_count     integer := 0;
  v_active    integer := 0;
  v_actor     text := coalesce(auth.uid()::text, p_user_id, '');
  v_name      text := coalesce(p_user_name, v_actor);
begin
  if not public.can('edit_product') then
    raise exception 'Switching a product to variant stock requires the edit_product capability'
      using errcode = 'insufficient_privilege';
  end if;

  select * into v_product from public.products where id = p_product_id for update;
  if not found then
    raise exception 'Product % not found', p_product_id using errcode = 'foreign_key_violation';
  end if;

  if jsonb_typeof(v_opening) <> 'object' then
    raise exception 'The opening distribution must be an object of variant id → units'
      using errcode = 'check_violation';
  end if;

  select count(*), count(*) filter (where active)
    into v_count, v_active
    from public.product_variants where product_id = v_product.id;
  if v_count = 0 then
    raise exception 'Product % has no variants — add the combinations before switching', v_product.sku
      using errcode = 'check_violation';
  end if;

  -- Re-running with the same numbers is a no-op, not an error: a double-click
  -- must not look like a failure, and it must not write a second conversion.
  if v_product.variants_enabled then
    if (select coalesce(sum(stock_quantity), 0)::integer from public.product_variants where product_id = v_product.id)
       = v_product.stock_quantity then
      return jsonb_build_object('product_id', v_product.id, 'changed', false,
                                'variants_enabled', true, 'units', v_product.stock_quantity);
    end if;
    raise exception 'Product % already sells by variant', v_product.sku using errcode = 'check_violation';
  end if;

  -- Every key must be one of THIS product's variants, and a whole number of units.
  for v_key in select jsonb_object_keys(v_opening) loop
    if public.variant_id_of(v_key) is null then
      raise exception 'The opening distribution names something that is not a variant: %', v_key
        using errcode = 'check_violation';
    end if;
    select * into v_variant from public.product_variants
     where id = public.variant_id_of(v_key) and product_id = v_product.id;
    if not found then
      raise exception 'The opening distribution names a variant that does not belong to %', v_product.sku
        using errcode = 'check_violation';
    end if;
    if jsonb_typeof(v_opening -> v_key) <> 'number'
       or (v_opening ->> v_key)::numeric < 0
       or (v_opening ->> v_key)::numeric <> trunc((v_opening ->> v_key)::numeric) then
      raise exception 'The opening count for % must be a whole number of units', v_variant.sku
        using errcode = 'check_violation';
    end if;
    v_sum := v_sum + ((v_opening ->> v_key)::numeric)::integer;
  end loop;

  if v_sum <> v_product.stock_quantity then
    raise exception 'The opening quantities add up to %, but % holds % — the conversion must neither create nor destroy stock',
      v_sum, v_product.sku, v_product.stock_quantity
      using errcode = 'check_violation';
  end if;

  -- Apply the distribution, then let the rollup confirm the total is unchanged.
  for v_variant in select * from public.product_variants where product_id = v_product.id loop
    v_qty := coalesce(((v_opening ->> v_variant.id::text)::numeric)::integer, 0);
    update public.product_variants
       set stock_quantity = v_qty,
           updated_at     = now()
     where id = v_variant.id
       and stock_quantity is distinct from v_qty;
  end loop;

  update public.products
     set variants_enabled = true,
         updated_at       = now()
   where id = v_product.id;

  insert into public.audit_log (action, entity, entity_id, entity_label, details, user_id, user_name)
  values ('product.variants_enabled', 'product', v_product.id::text, v_product.sku,
          jsonb_build_object(
            'sku', v_product.sku,
            'product', v_product.name_en,
            'units', v_sum,
            'variants', v_count,
            'active_variants', v_active,
            'opening', (
              select jsonb_agg(jsonb_build_object(
                       'variant_id', v.id, 'sku', v.sku,
                       'color', coalesce(v.color_en, v.color_ar),
                       'size', coalesce(public.numeric_label(v.size), v.size_label),
                       'qty', v.stock_quantity)
                     order by v.color_key, v.size)
                from public.product_variants v where v.product_id = v_product.id
            )),
          v_actor, v_name);

  return jsonb_build_object('product_id', v_product.id, 'changed', true, 'variants_enabled', true,
                            'units', v_sum, 'variants', v_count, 'active_variants', v_active);
end
$$;

comment on function public.enable_product_variants(uuid, jsonb, text, text) is
  'Switches a product to variant stock. Requires edit_product and an opening distribution that sums to exactly the stock the product already holds — the conversion can neither create nor destroy a unit and never defaults the stock onto one variant. Audited as product.variants_enabled.';

/**
 * Leave variant mode, consolidating the combinations into one product figure.
 *
 * Allowed only while NOTHING references a variant: no sale line, no return, no
 * movement, no online order line, no reservation. Once history names a
 * combination, the product keeps its variants — that is what keeps an old
 * invoice readable — and an archive is the way to stop selling it.
 */
create or replace function public.disable_product_variants(
  p_product_id          uuid,
  p_consolidated_stock  numeric,
  p_user_id             text default null,
  p_user_name           text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_product  public.products%rowtype;
  v_variant  public.product_variants%rowtype;
  v_total    integer := 0;
  v_active   integer := 0;
  v_refs     integer := 0;
  v_holds    integer := 0;
  v_wanted   integer;
  v_actor    text := coalesce(auth.uid()::text, p_user_id, '');
  v_name     text := coalesce(p_user_name, v_actor);
begin
  if not public.can('edit_product') then
    raise exception 'Switching a product off variant stock requires the edit_product capability'
      using errcode = 'insufficient_privilege';
  end if;

  select * into v_product from public.products where id = p_product_id for update;
  if not found then
    raise exception 'Product % not found', p_product_id using errcode = 'foreign_key_violation';
  end if;
  if not v_product.variants_enabled then
    return jsonb_build_object('product_id', v_product.id, 'changed', false, 'variants_enabled', false);
  end if;

  select count(*), coalesce(sum(stock_quantity), 0)::integer, count(*) filter (where active)
    into v_refs, v_total, v_active
    from public.product_variants where product_id = v_product.id;

  -- Anything that names a variant keeps the product in variant mode.
  select
      (select count(*) from public.sale_items si
        join public.product_variants v on v.id = si.variant_id
       where v.product_id = v_product.id)
    + (select count(*) from public.return_items ri
        join public.product_variants v on v.id = ri.variant_id
       where v.product_id = v_product.id)
    + (select count(*) from public.stock_movements sm
        join public.product_variants v on v.id = sm.variant_id
       where v.product_id = v_product.id)
    + (select count(*) from public.online_order_items oi
        join public.product_variants v on v.id = oi.variant_id
       where v.product_id = v_product.id)
    + (select count(*) from public.stock_reservations sr
        join public.product_variants v on v.id = sr.variant_id
       where v.product_id = v_product.id)
    into v_refs;

  if v_refs > 0 then
    raise exception 'Product % has % historical record(s) naming its variants — it stays in variant mode; archive the combinations instead',
      v_product.sku, v_refs
      using errcode = 'restrict_violation';
  end if;

  select count(*) into v_holds
    from public.stock_reservations sr
    join public.product_variants v on v.id = sr.variant_id
   where v.product_id = v_product.id and sr.status = 'reserved';
  if v_holds > 0 then
    raise exception 'Product % still has % open stock hold(s) — settle or cancel those orders first',
      v_product.sku, v_holds
      using errcode = 'restrict_violation';
  end if;

  if v_total = 0 and v_product.stock_tracking_enabled then
    raise exception 'Product % holds % units across its variants — consolidate that exact figure',
      v_product.sku, v_total
      using errcode = 'check_violation';
  end if;

  v_wanted := coalesce(p_consolidated_stock, v_total)::integer;
  if v_product.stock_tracking_enabled and v_wanted <> v_total then
    raise exception 'The consolidated figure is %, but the variants hold % — nothing is created or destroyed by switching back',
      v_wanted, v_total
      using errcode = 'check_violation';
  end if;

  delete from public.product_variants where product_id = v_product.id;

  update public.products
     set variants_enabled = false,
         stock_quantity   = case when stock_tracking_enabled then v_total else stock_quantity end,
         updated_at       = now()
   where id = v_product.id;

  insert into public.audit_log (action, entity, entity_id, entity_label, details, user_id, user_name)
  values ('product.variants_disabled', 'product', v_product.id::text, v_product.sku,
          jsonb_build_object('sku', v_product.sku, 'product', v_product.name_en,
                             'units', v_total, 'variants', v_active),
          v_actor, v_name);

  return jsonb_build_object('product_id', v_product.id, 'changed', true, 'variants_enabled', false,
                            'units', v_total);
end
$$;

comment on function public.disable_product_variants(uuid, numeric, text, text) is
  'Leaves variant mode. Refused (restrict_violation) while ANY sale line, return, movement, online order line or reservation names one of the variants, and refused unless the consolidated figure equals the sum of the variants. Audited as product.variants_disabled.';

/** Archive (–) or reactivate a single combination. Idempotent; trigger-audited. */
create or replace function public.set_variant_active(p_variant_id uuid, p_active boolean)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_variant public.product_variants%rowtype;
  v_product public.products%rowtype;
  v_others  integer;
begin
  if not public.can('edit_product') then
    raise exception 'Archiving a variant requires the edit_product capability'
      using errcode = 'insufficient_privilege';
  end if;

  select * into v_variant from public.product_variants where id = p_variant_id for update;
  if not found then
    raise exception 'Variant % not found', p_variant_id using errcode = 'foreign_key_violation';
  end if;
  select * into v_product from public.products where id = v_variant.product_id;

  if v_variant.active = p_active then
    return jsonb_build_object('variant_id', v_variant.id, 'active', v_variant.active, 'changed', false);
  end if;

  if not p_active and v_product.variants_enabled then
    select count(*) into v_others
      from public.product_variants
     where product_id = v_variant.product_id and id <> v_variant.id and active;
    if v_others = 0 then
      raise exception 'Product % would have nothing left to sell — add or reactivate another combination first',
        v_product.sku
        using errcode = 'check_violation';
    end if;
  end if;

  update public.product_variants set active = p_active, updated_at = now() where id = v_variant.id;

  return jsonb_build_object('variant_id', v_variant.id, 'active', p_active, 'changed', true,
                            'sku', v_variant.sku);
end
$$;

comment on function public.set_variant_active(uuid, boolean) is
  'Archives or reactivates one combination (requires edit_product). Refuses archiving the last active combination of a variant product. The audit row is written by the table trigger.';

/** How much history names each variant — the read side of the delete decision. */
create or replace function public.variant_reference_counts(p_variant_id uuid default null)
returns table (
  variant_id         uuid,
  product_id         uuid,
  sku                text,
  sale_items         bigint,
  return_items       bigint,
  stock_movements    bigint,
  online_order_items bigint,
  stock_reservations bigint,
  total              bigint
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.can('delete_product') then
    raise exception 'Reading variant reference counts requires the delete_product capability'
      using errcode = 'insufficient_privilege';
  end if;

  return query
    select v.id, v.product_id, v.sku,
           (select count(*) from public.sale_items si          where si.variant_id = v.id),
           (select count(*) from public.return_items ri        where ri.variant_id = v.id),
           (select count(*) from public.stock_movements sm     where sm.variant_id = v.id),
           (select count(*) from public.online_order_items oi  where oi.variant_id = v.id),
           (select count(*) from public.stock_reservations sr  where sr.variant_id = v.id),
           (select count(*) from public.sale_items si          where si.variant_id = v.id)
         + (select count(*) from public.return_items ri        where ri.variant_id = v.id)
         + (select count(*) from public.stock_movements sm     where sm.variant_id = v.id)
         + (select count(*) from public.online_order_items oi  where oi.variant_id = v.id)
         + (select count(*) from public.stock_reservations sr  where sr.variant_id = v.id)
      from public.product_variants v
     where p_variant_id is null or v.id = p_variant_id
     order by v.sku;
end
$$;

comment on function public.variant_reference_counts(uuid) is
  'How much history references each variant. total > 0 means it may only be archived, never deleted. delete_product holders only.';

/** Permanently remove a combination that nothing references. */
create or replace function public.delete_variant(p_variant_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_variant public.product_variants%rowtype;
  v_product public.products%rowtype;
  -- A record rather than %rowtype: a set-returning function has no composite
  -- type to hang a rowtype on.
  v_refs    record;
  v_siblings integer;
begin
  if not public.can('delete_product') then
    raise exception 'Deleting a variant requires the delete_product capability'
      using errcode = 'insufficient_privilege';
  end if;

  select * into v_variant from public.product_variants where id = p_variant_id for update;
  if not found then
    raise exception 'Variant % not found', p_variant_id using errcode = 'foreign_key_violation';
  end if;
  select * into v_product from public.products where id = v_variant.product_id;

  if v_product.variants_enabled then
    select count(*) into v_siblings
      from public.product_variants where product_id = v_variant.product_id;
    if v_siblings <= 1 then
      raise exception 'Product % would have nothing left to sell — add another combination first', v_product.sku
        using errcode = 'check_violation';
    end if;
  end if;

  select * into v_refs from public.variant_reference_counts(p_variant_id);
  if coalesce(v_refs.total, 0) > 0 then
    raise exception 'Variant % is named by % historical record(s) — archive it instead of deleting',
      v_variant.sku, v_refs.total
      using errcode = 'restrict_violation';
  end if;

  delete from public.product_variants where id = v_variant.id;

  return jsonb_build_object('variant_id', v_variant.id, 'sku', v_variant.sku, 'deleted', true);
end
$$;

comment on function public.delete_variant(uuid) is
  'Permanently removes a combination (requires delete_product). Refused with restrict_violation when any history names it, and refused when it is the last combination of a variant product. The audit row is written by the table trigger.';

-- ── 12. the public storefront reads the combinations ───────────────────────
/**
 * The combinations a visitor may choose between.
 *
 * Same posture as `storefront_catalogue()` (0030): a fixed column list, only
 * customer-facing columns, and only for products the shop publishes. `cost_override`
 * and `low_stock_level` are deliberately absent — a shop window does not show
 * what a thing cost or how close it is to running out.
 */
create or replace function public.storefront_product_variants()
returns table (
  id             uuid,
  product_id     uuid,
  sku            text,
  barcode        text,
  color_key      text,
  color_ar       text,
  color_en       text,
  color_hex      text,
  size           numeric,
  size_label     text,
  image_url      text,
  price_override numeric,
  stock_quantity integer,
  active         boolean,
  sort_order     integer
)
language sql
stable
security definer
set search_path = public
as $$
  select v.id, v.product_id, v.sku, v.barcode, v.color_key, v.color_ar, v.color_en, v.color_hex,
         v.size, v.size_label, v.image_url, v.price_override, v.stock_quantity, v.active, v.sort_order
    from public.product_variants v
    join public.products p on p.id = v.product_id
   where p.active
     and p.show_on_website
     and p.variants_enabled
     and v.active
   order by v.product_id, v.color_key, v.size nulls last, v.sort_order
$$;

comment on function public.storefront_product_variants() is
  'The published combinations of published products: colour, size, swatch, price override and stock on hand. Never cost, never the low-stock threshold.';

revoke all on function public.storefront_product_variants() from public;
grant execute on function public.storefront_product_variants() to anon, authenticated, service_role;

revoke all on function public.variant_color_key(text) from public;
revoke all on function public.numeric_label(numeric) from public;
revoke all on function public.variant_label(text, text, numeric, text) from public;
revoke all on function public.variant_id_of(text) from public;
revoke all on function public.reserved_quantity_variant(uuid) from public;
revoke all on function public.enable_product_variants(uuid, jsonb, text, text) from public, anon;
revoke all on function public.disable_product_variants(uuid, numeric, text, text) from public, anon;
revoke all on function public.set_variant_active(uuid, boolean) from public, anon;
revoke all on function public.delete_variant(uuid) from public, anon;
revoke all on function public.variant_reference_counts(uuid) from public, anon;

grant execute on function public.variant_color_key(text) to authenticated, service_role;
grant execute on function public.numeric_label(numeric) to authenticated, service_role;
grant execute on function public.variant_label(text, text, numeric, text) to authenticated, service_role;
grant execute on function public.variant_id_of(text) to authenticated, service_role;
grant execute on function public.reserved_quantity_variant(uuid) to authenticated, service_role;
grant execute on function public.enable_product_variants(uuid, jsonb, text, text) to authenticated, service_role;
grant execute on function public.disable_product_variants(uuid, numeric, text, text) to authenticated, service_role;
grant execute on function public.set_variant_active(uuid, boolean) to authenticated, service_role;
grant execute on function public.delete_variant(uuid) to authenticated, service_role;
grant execute on function public.variant_reference_counts(uuid) to authenticated, service_role;

-- ═══════════════════════════════════════════════════════════════════════════
-- 13. the money and the stock paths, now exact-combination aware
--
-- Each function below is the previous definition with ONE thing added: a
-- variant branch. The legacy path is byte-for-byte what it was, so every
-- product without variants behaves exactly as it did before this migration.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── pos_complete_sale ──
--
-- Selling a product that has variants now names the exact combination. The variant row is locked
-- (`for update`) before the availability check, the check reads THAT variant's stock, and the
-- deduction, the sale line and the movement all point at it. A line without a combination, or
-- with somebody else's combination, is refused — the register never picks a colour or a size.

create or replace function public.pos_complete_sale(
  p_payload jsonb,
  -- Phase 24: the request that authorises an over-limit discount. Optional so
  -- every existing caller — resolve_online_order() included, which completes an
  -- online order with no discount — keeps working unchanged.
  p_approval_request_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_client_ref      text := p_payload->>'client_ref';
  v_discount_type   text := coalesce(p_payload->>'discount_type', 'none');
  v_discount_value  numeric(14,2) := coalesce((p_payload->>'discount_value')::numeric, 0);
  v_user_id         text := p_payload->>'user_id';
  v_user_name       text := p_payload->>'user_name';
  v_source          text := coalesce(p_payload->>'source', 'pos');

  v_line            jsonb;
  v_product         public.products%rowtype;
  v_qty             integer;
  v_unit            numeric(14,2);
  v_before          integer;
  -- Phase 43: the exact combination of a variant product, locked and priced
  -- from the catalogue — never from the payload.
  v_variant         public.product_variants%rowtype;
  v_variant_id      uuid;
  v_variant_label   text;

  v_subtotal        numeric(14,2) := 0;
  v_discount_percent numeric(8,2) := 0;
  v_approval_id      uuid;
  v_discount_amount numeric(14,2) := 0;
  v_total           numeric(14,2);

  v_pay             jsonb;
  v_pay_method      text;
  v_pay_amount      numeric(14,2);
  v_pay_status      text;
  v_pay_tendered    numeric(14,2);
  v_sum             numeric(14,2) := 0;
  v_cash_received   numeric(14,2) := 0;
  v_cash_applied    numeric(14,2) := 0;
  v_all_paid        boolean := true;
  v_first_method    public.payment_method;
  v_customer_id    uuid;
  v_customer_name  text;
  v_customer_phone text;
  v_shift_id       uuid;

  v_sale_id         uuid;
  v_sale_number     text;
  v_sale_status     text;
  v_pay_status_enum public.payment_status;
begin
  -- ── authorization (Phase 23) ──────────────────────────────
  -- This function is SECURITY DEFINER, so row level security does not apply
  -- inside it, and EXECUTE is granted to `authenticated`. Until this guard
  -- existed, the capability matrix was enforced only in the browser: any
  -- signed-in seat — including a read-only `viewer`, whose `can('sell')` is
  -- false — could call the RPC directly and write a sale, its items, its
  -- payments and a stock movement. Reproduced before the fix: a viewer created
  -- INV-000002 and moved stock 500 → 498.
  --
  -- `manage_online_orders` is accepted alongside `sell` because
  -- `resolve_online_order()` completes an order by calling this function with
  -- source = 'online'. That path must keep working for a seat that works the
  -- online queue. Every shipped role that resolves orders also holds `sell`;
  -- this widens the gate only for a custom role built to work orders without
  -- ringing up sales at the till.
  if not (public.can('sell') or public.can('manage_online_orders')) then
    raise exception 'Not permitted to complete a sale'
      using errcode = 'insufficient_privilege';
  end if;
  -- 1. idempotency
  select id into v_sale_id from public.sales where client_ref = v_client_ref;
  if found then
    return jsonb_build_object('sale_id', v_sale_id);
  end if;

  if v_source not in ('pos', 'online') then
    raise exception 'Invalid source' using errcode = 'check_violation';
  end if;

  -- ── open-shift requirement (Phase 27) ────────────────────────────────────
  -- A till sale is drawer money: it must land inside an open shift's books or
  -- the close-out can never explain the cash. The store holds at most one open
  -- shift at a time (`shifts_enforce_invariants`, 0012), so the rule is
  -- "an open shift exists" and the sale stamps it — that is what makes the
  -- attribution a fact instead of a time-window guess, and what lets a sale
  -- be refused with zero rows written (the check runs before any counter is
  -- touched, so a refused sale burns no invoice number).
  --
  -- `source = 'online'` is deliberately exempt: the storefront is its own
  -- channel, and the shop's model keeps it independent of the till.
  --
  -- `for update` serialises against a concurrent close: whichever takes the
  -- row lock first wins — if the close commits first we see 'closed' and
  -- refuse; if we commit first the sale sits inside the shift's window.
  if v_source = 'pos' then
    select id into v_shift_id from public.shifts where status = 'open' for update;
    if not found then
      raise exception 'Cannot complete a sale: no open shift'
        using errcode = 'no_data_found';
    end if;
  end if;

  if v_discount_type not in ('none','percent','fixed') or v_discount_value < 0
     or (v_discount_type = 'percent' and v_discount_value > 100) then
    raise exception 'Invalid discount' using errcode = 'check_violation';
  end if;

  if jsonb_array_length(coalesce(p_payload->'lines','[]'::jsonb)) = 0 then
    raise exception 'Empty cart' using errcode = 'check_violation';
  end if;
  if jsonb_array_length(coalesce(p_payload->'payments','[]'::jsonb)) = 0 then
    raise exception 'At least one payment is required' using errcode = 'check_violation';
  end if;

  -- 2. validate lines against live catalog + accumulate subtotal
  for v_line in select * from jsonb_array_elements(p_payload->'lines')
  loop
    v_qty := (v_line->>'qty')::integer;
    if v_qty is null or v_qty <= 0 then
      raise exception 'Invalid quantity' using errcode = 'check_violation';
    end if;
    select * into v_product from public.products where id = (v_line->>'product_id')::uuid for update;
    if not found then
      raise exception 'Product % not found', v_line->>'product_id' using errcode = 'foreign_key_violation';
    end if;
    if not v_product.active or not v_product.stock_tracking_enabled then
      raise exception 'Product % is not sellable', v_product.sku using errcode = 'check_violation';
    end if;
    -- ── Phase 43: the shelf is the EXACT combination's ────────────────────
    -- A product that sells by variant can only be sold by naming the colour and
    -- the size, and the units come off that combination. Nothing else
    -- authorises the line: not the product rollup, not a sibling size, not a
    -- sibling colour. The id is parsed defensively (variant_id_of returns null
    -- instead of letting a forged value become a 22P02 cast error) and the row
    -- is locked here so the check and the deduction agree.
    if v_product.variants_enabled then
      v_variant_id := public.variant_id_of(v_line ->> 'variant_id');
      if v_variant_id is null then
        raise exception 'Choose the colour and the size for %', v_product.sku
          using errcode = 'check_violation';
      end if;
      select * into v_variant from public.product_variants
       where id = v_variant_id and product_id = v_product.id
       for update;
      if not found then
        raise exception 'That colour and size does not belong to %', v_product.sku
          using errcode = 'check_violation';
      end if;
      if not v_variant.active then
        raise exception '% is no longer sold',
          coalesce(public.variant_label(v_variant.color_en, v_variant.color_ar,
                                       v_variant.size, v_variant.size_label), v_variant.sku)
          using errcode = 'check_violation';
      end if;
      if v_qty > v_variant.stock_quantity then
        raise exception 'Only % of % in stock', v_variant.stock_quantity,
          coalesce(public.variant_label(v_variant.color_en, v_variant.color_ar,
                                       v_variant.size, v_variant.size_label), v_variant.sku)
          using errcode = 'check_violation';
      end if;
      v_unit := coalesce(v_variant.price_override, v_product.selling_price);
    else
      if v_qty > v_product.stock_quantity then
        raise exception 'Only % of % in stock', v_product.stock_quantity, v_product.sku using errcode = 'check_violation';
      end if;
      v_unit := v_product.selling_price;
    end if;
    v_subtotal := v_subtotal + round((v_unit * v_qty)::numeric, 2);
  end loop;

  -- 3. authoritative totals
  if v_discount_type = 'percent' then
    v_discount_amount := round((v_subtotal * v_discount_value / 100)::numeric, 2);
  elsif v_discount_type = 'fixed' then
    v_discount_amount := least(round(v_discount_value::numeric, 2), v_subtotal);
  end if;
  v_total := v_subtotal - v_discount_amount;

  -- ── approval limits, enforced here and not in the browser (Phase 24) ──────
  -- Until now the only thing between a signed-in seat and an arbitrary discount
  -- was saleService.ts:146, which a direct call to this function never passes
  -- through. The percentage below is derived from numbers this function computed
  -- itself — the catalogue-priced subtotal and the discount it clamped — and not
  -- from anything the caller claims, so a fixed discount is measured the same
  -- way the till measures it: 8.00 off a 20.00 basket is the 40% act it is.
  v_discount_percent := case
    when v_subtotal > 0 then round((v_discount_amount * 100.0 / v_subtotal)::numeric, 2)
    else 0
  end;
  if public.approval_required_for('discount', v_discount_percent) then
    if p_approval_request_id is not null then
      v_approval_id := p_approval_request_id;
    elsif coalesce(btrim(p_payload ->> 'approval_request_id'), '') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
      v_approval_id := (p_payload ->> 'approval_request_id')::uuid;
    else
      v_approval_id := null;
    end if;
    -- Validates and returns the request without spending it: the sale does not
    -- exist yet, and a sale that fails below must not burn an approval.
    v_approval_id := public.approval_assert_satisfied(
      'discount', v_discount_percent, v_approval_id, '{}'::jsonb
    );
  end if;

  -- 4. validate payments: each valid, sum equals the total exactly
  for v_pay in select * from jsonb_array_elements(p_payload->'payments')
  loop
    v_pay_method := v_pay->>'method';
    v_pay_amount := round(coalesce((v_pay->>'amount')::numeric, 0), 2);
    -- 0015 added 'visa'; 0018 adds 'cod' for online orders.
    if v_pay_method not in ('cash','instapay','visa','cod') or v_pay_amount <= 0 then
      raise exception 'Invalid payment' using errcode = 'check_violation';
    end if;
    if v_pay_method = 'cash' then
      v_pay_tendered := round(coalesce((v_pay->>'tendered')::numeric, v_pay_amount), 2);
      if v_pay_tendered < v_pay_amount then
        raise exception 'Insufficient cash received' using errcode = 'check_violation';
      end if;
      v_cash_received := v_cash_received + v_pay_tendered;
      v_cash_applied  := v_cash_applied + v_pay_amount;
      v_pay_status := 'paid';
    else
      -- Card money is captured at the terminal, so `visa` is always paid.
      -- Cash on delivery has NOT been collected, so `cod` is always pending —
      -- a client cannot claim delivery cash it has not taken. InstaPay alone
      -- stays pending until the transfer is confirmed.
      v_pay_status := case
        when v_pay_method = 'visa' then 'paid'
        when v_pay_method = 'cod' then 'pending'
        when coalesce(v_pay->>'status', 'paid') = 'pending' then 'pending'
        else 'paid'
      end;
    end if;
    if v_pay_status = 'pending' then v_all_paid := false; end if;
    if v_first_method is null then v_first_method := v_pay_method::public.payment_method; end if;
    v_sum := v_sum + v_pay_amount;
  end loop;

  if v_sum <> v_total then
    raise exception 'Payments sum to %, but the sale total is %', v_sum, v_total using errcode = 'check_violation';
  end if;

  v_sale_status := case when v_all_paid then 'completed' else 'pending' end;

  -- ── customer linkage (Phase 27) ─────────────────────────────────────────
  -- The till selects a customer (or a walk-in) and snapshots name/phone for
  -- the receipt. Until this existed the payload was read by no version of the
  -- function — every live sale lost its customer and read back as a guest,
  -- while demo mode (its own repository) kept it, so the drift was invisible
  -- in the suite. The rules here:
  --   · a well-formed id that is not in `customers` is dropped to NULL rather
  --     than failing the sale — the sale is real, the link is not;
  --   · a valid id takes the customer's current name/phone from the book
  --     (authoritative), a walk-in keeps the payload snapshot, blank → NULL.
  v_customer_id := case
    when coalesce(btrim(p_payload ->> 'customer_id'), '') ~
         '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    then (p_payload ->> 'customer_id')::uuid
    else null
  end;
  if v_customer_id is not null
     and not exists (select 1 from public.customers where id = v_customer_id) then
    v_customer_id := null;
  end if;
  v_customer_name  := nullif(btrim(coalesce(p_payload ->> 'customer_name', '')), '');
  v_customer_phone := nullif(btrim(coalesce(p_payload ->> 'customer_phone', '')), '');
  if v_customer_id is not null then
    select c.name, c.phone into v_customer_name, v_customer_phone
      from public.customers c where c.id = v_customer_id;
  end if;

  -- 5. sale number + sale row
  update public.sale_counters set next_value = next_value + 1 where id = 1
    returning 'INV-' || lpad((next_value - 1)::text, 6, '0') into v_sale_number;

  insert into public.sales (
    sale_number, client_ref, status, payment_method, payment_status,
    subtotal, discount_type, discount_value, discount_amount, total,
    amount_received, change, user_id, user_name, paid_at, paid_by, paid_by_name,
    source, customer_id, customer_name, customer_phone, shift_id
  ) values (
    v_sale_number, v_client_ref, v_sale_status::public.sale_status,
    coalesce(v_first_method, 'cash'), case when v_all_paid then 'paid' else 'pending' end::public.payment_status,
    v_subtotal, v_discount_type::public.discount_type, v_discount_value, v_discount_amount, v_total,
    case when v_cash_received > 0 then v_cash_received else null end,
    case when v_cash_received > 0 then round((v_cash_received - v_cash_applied)::numeric, 2) else null end,
    v_user_id, v_user_name,
    case when v_all_paid then now() else null end,
    case when v_all_paid then v_user_id else null end,
    case when v_all_paid then v_user_name else null end,
    v_source,
    v_customer_id, v_customer_name, v_customer_phone,
    v_shift_id
  ) returning id into v_sale_id;

  -- Spend it now, inside the same transaction as the sale it produced, so a
  -- rolled-back sale leaves the approval unspent and it cannot be replayed
  -- against the next one.
  if v_approval_id is not null then
    perform public.mark_approval_applied(v_approval_id, v_sale_id::text);
  end if;

  -- 6. payment rows + sale items + stock + movements
  for v_pay in select * from jsonb_array_elements(p_payload->'payments')
  loop
    v_pay_method := v_pay->>'method';
    v_pay_amount := round(coalesce((v_pay->>'amount')::numeric, 0), 2);
    -- The same rule as validation above: InstaPay follows the payload, card and
    -- cash are paid, cash on delivery is never paid at creation.
    v_pay_status := case
      when v_pay_method = 'instapay'
        then case when coalesce(v_pay->>'status', 'paid') = 'pending' then 'pending' else 'paid' end
      when v_pay_method = 'cod' then 'pending'
      else 'paid'
    end;
    v_pay_status_enum := v_pay_status::public.payment_status;

    insert into public.sale_payments (sale_id, method, amount, status, paid_at, paid_by, paid_by_name)
    values (
      v_sale_id, v_pay_method::public.payment_method, v_pay_amount, v_pay_status_enum,
      case when v_pay_status_enum = 'paid' then now() else null end,
      case when v_pay_status_enum = 'paid' then v_user_id else null end,
      case when v_pay_status_enum = 'paid' then v_user_name else null end
    );
  end loop;

  for v_line in select * from jsonb_array_elements(p_payload->'lines')
  loop
    v_qty := (v_line->>'qty')::integer;
    select * into v_product from public.products where id = (v_line->>'product_id')::uuid for update;

    if v_product.variants_enabled then
      -- Locked in the same order as the validation pass (product, then variant),
      -- so two tills selling the last ring serialise instead of deadlocking.
      v_variant_id := public.variant_id_of(v_line ->> 'variant_id');
      select * into v_variant from public.product_variants
       where id = v_variant_id and product_id = v_product.id
       for update;
      if not found then
        raise exception 'That colour and size does not belong to %', v_product.sku
          using errcode = 'check_violation';
      end if;
      v_variant_label := coalesce(public.variant_label(v_variant.color_en, v_variant.color_ar,
                                                      v_variant.size, v_variant.size_label), v_variant.sku);

      -- The invoice keeps WHO and WHAT: the combination's id, and the colour and
      -- size frozen as they read today. A later rename cannot rewrite this row.
      insert into public.sale_items (
        sale_id, product_id, variant_id,
        variant_color_ar, variant_color_en, variant_size, variant_size_label,
        name_ar, name_en, sku, barcode, unit_price, quantity, line_total
      ) values (
        v_sale_id, v_product.id, v_variant.id,
        v_variant.color_ar, v_variant.color_en, v_variant.size, v_variant.size_label,
        v_product.name_ar, v_product.name_en, v_variant.sku, v_variant.barcode,
        coalesce(v_variant.price_override, v_product.selling_price), v_qty,
        round((coalesce(v_variant.price_override, v_product.selling_price) * v_qty)::numeric, 2)
      );

      v_before := v_variant.stock_quantity;
      update public.product_variants
         set stock_quantity = stock_quantity - v_qty, updated_at = now()
       where id = v_variant.id;

      insert into public.stock_movements (
        product_id, variant_id, variant_color_ar, variant_color_en, variant_size,
        delta, quantity_before, quantity_after, type, reason, notes, user_id, user_name
      ) values (
        v_product.id, v_variant.id, v_variant.color_ar, v_variant.color_en, v_variant.size,
        v_qty, v_before, v_before - v_qty, 'issue', 'other',
        case when v_source = 'online'
             then 'Online order ' || coalesce(p_payload->>'order_number', '') || ' · Sale ' || v_sale_number
             else 'Sale ' || v_sale_number
        end,
        v_user_id, v_user_name);
    else
      insert into public.sale_items (sale_id, product_id, name_ar, name_en, sku, barcode, unit_price, quantity, line_total)
      values (v_sale_id, v_product.id, v_product.name_ar, v_product.name_en, v_product.sku,
              v_product.barcode, v_product.selling_price, v_qty,
              round((v_product.selling_price * v_qty)::numeric, 2));

      v_before := v_product.stock_quantity;
      update public.products set stock_quantity = stock_quantity - v_qty, updated_at = now() where id = v_product.id;

      insert into public.stock_movements (product_id, delta, quantity_before, quantity_after, type, reason, notes, user_id, user_name)
      values (v_product.id, v_qty, v_before, v_before - v_qty, 'issue', 'other',
              case when v_source = 'online'
                   then 'Online order ' || coalesce(p_payload->>'order_number', '') || ' · Sale ' || v_sale_number
                   else 'Sale ' || v_sale_number
              end,
              v_user_id, v_user_name);
    end if;
  end loop;

  return jsonb_build_object('sale_id', v_sale_id, 'sale_number', v_sale_number);
end;
$$;


-- ── pos_void_sale ──
--
-- A void puts each line back on the shelf it came off. The combination is read from the sold line,
-- never guessed from the product. (Extracted from 0033, the latest definition — it carries the
-- void_sale capability guard 0007 did not have.)

create or replace function public.pos_void_sale(
  p_sale_id   uuid,
  p_user_id   text,
  p_user_name text,
  p_reason    text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sale    public.sales%rowtype;
  v_item    public.sale_items%rowtype;
  v_product public.products%rowtype;
  v_variant public.product_variants%rowtype;
  v_before  integer;
begin
  -- ── authorization (Phase 23) ──────────────────────────────
  -- Voiding erases a completed sale and reverses its stock. `void_sale` is
  -- held by managers and admins only — not even a cashier has it — yet the RPC
  -- was callable by every signed-in seat, including a viewer. That is the
  -- widest gap of the four: the capability existed, and nothing enforced it.
  if not public.can('void_sale') then
    raise exception 'Not permitted to void a sale'
      using errcode = 'insufficient_privilege';
  end if;
  select * into v_sale from public.sales where id = p_sale_id for update;
  if not found then
    raise exception 'Sale not found' using errcode = 'no_data_found';
  end if;
  if v_sale.status = 'voided' then
    return jsonb_build_object('sale_id', p_sale_id);
  end if;

  update public.sales
    set status = 'voided', voided_at = now(), void_reason = p_reason
    where id = p_sale_id;

  for v_item in select * from public.sale_items where sale_id = p_sale_id
  loop
    -- Phase 43: a void puts each line back on the shelf it came off. The
    -- combination travels on the sold line, so a voided Gold / 17 cannot
    -- reappear as Gold / 16 — and the rollup follows automatically.
    if v_item.variant_id is not null then
      select * into v_variant
        from public.product_variants
        where id = v_item.variant_id
        for update;
      if found then
        v_before := v_variant.stock_quantity;
        update public.product_variants
          set stock_quantity = stock_quantity + v_item.quantity,
              updated_at = now()
          where id = v_variant.id;

        insert into public.stock_movements (
          product_id, variant_id, variant_color_ar, variant_color_en, variant_size,
          delta, quantity_before, quantity_after,
          type, reason, notes, user_id, user_name
        ) values (
          v_item.product_id, v_variant.id, v_variant.color_ar, v_variant.color_en, v_variant.size,
          v_item.quantity, v_before, v_before + v_item.quantity,
          'adjustment_in', 'other',
          'Void of ' || v_sale.sale_number || coalesce(': ' || p_reason, ''),
          p_user_id, p_user_name
        );
      end if;
    else
      select * into v_product
        from public.products
        where id = v_item.product_id
        for update;
      if found then
        v_before := v_product.stock_quantity;
        update public.products
          set stock_quantity = stock_quantity + v_item.quantity,
              updated_at = now()
          where id = v_product.id;

        insert into public.stock_movements (
          product_id, delta, quantity_before, quantity_after,
          type, reason, notes, user_id, user_name
        ) values (
          v_product.id, v_item.quantity, v_before, v_before + v_item.quantity,
          'adjustment_in', 'other',
          'Void of ' || v_sale.sale_number || coalesce(': ' || p_reason, ''),
          p_user_id, p_user_name
        );
      end if;
    end if;
  end loop;

  return jsonb_build_object('sale_id', p_sale_id);
end;
$$;




-- ── pos_process_return ──
--
-- A return restores the EXACT combination that was sold, copied from the sold line. The caller
-- cannot choose a shelf, so a return of Gold / 17 can never credit Gold / 16 or Silver / 17, and
-- the restored quantity is the one the sale's own line proves.

create or replace function public.pos_process_return(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sale             public.sales%rowtype;
  v_line             jsonb;
  v_return_id        uuid;
  v_refund_id        uuid;
  v_return_number    text;
  v_refund_number    text;
  v_refund_total     numeric(14,2) := 0;
  v_approval_id      uuid;
  v_refunded_so_far  numeric(14,2) := 0;
  v_sale_item        public.sale_items%rowtype;
  v_already_returned integer;
  v_qty              integer;
  v_before           integer;
  v_refund_method    text := coalesce(p_payload->>'refund_method', 'cash');
  v_refund_status    text := coalesce(p_payload->>'refund_status', 'completed');
  v_reason           text := btrim(coalesce(p_payload->>'reason', ''));
  v_user_id          text := p_payload->>'user_id';
  v_user_name        text := p_payload->>'user_name';
  v_product          public.products%rowtype;
  -- Phase 43: the EXACT combination that was sold, read from the sold line.
  v_variant          public.product_variants%rowtype;
begin
  -- ── authorization (Phase 23) ──────────────────────────────
  -- SECURITY DEFINER + EXECUTE to `authenticated` + no predicate meant any
  -- signed-in seat could process a return and issue a refund — money out of the
  -- till — regardless of `process_return`. A viewer did exactly that in the
  -- reproduction that prompted this guard.
  if not public.can('process_return') then
    raise exception 'Not permitted to process a return'
      using errcode = 'insufficient_privilege';
  end if;
  if v_reason = '' then
    raise exception 'Return reason is required' using errcode = 'check_violation';
  end if;
  if v_refund_method not in ('cash', 'visa', 'instapay') then
    raise exception 'Invalid refund method' using errcode = 'check_violation';
  end if;
  if jsonb_array_length(coalesce(p_payload->'items', '[]'::jsonb)) = 0 then
    raise exception 'No items to return' using errcode = 'check_violation';
  end if;

  select * into v_sale from public.sales where id = (p_payload->>'sale_id')::uuid for update;
  if not found then
    raise exception 'Sale not found' using errcode = 'no_data_found';
  end if;
  if v_sale.status = 'voided' then
    raise exception 'Voided sales cannot be returned' using errcode = 'check_violation';
  end if;

  -- 0016 (a): a rejected refund never moved money, so it does not consume the
  -- sale's refundable amount. Pending still does.
  select coalesce(sum(amount), 0) into v_refunded_so_far
    from public.refund_records
   where sale_id = v_sale.id
     and status <> 'rejected';

  -- validate every line before writing anything
  for v_line in select * from jsonb_array_elements(p_payload->'items')
  loop
    v_qty := (v_line->>'quantity')::integer;
    if v_qty is null or v_qty <= 0 then
      raise exception 'Return quantity must be a positive whole number' using errcode = 'check_violation';
    end if;

    select * into v_sale_item from public.sale_items
     where id = (v_line->>'sale_item_id')::uuid and sale_id = v_sale.id;
    if not found then
      raise exception 'Sale item not found on this invoice' using errcode = 'foreign_key_violation';
    end if;

    -- 0041: a REJECTED return is cancelled — its goods are written back out
    -- when the refund is rejected (see pos_settle_refund), so it must not
    -- hold the quantity. Pending and completed both count: the goods are on
    -- the shelf either way, and double-returning would restore them twice.
    select coalesce(sum(ri.quantity), 0) into v_already_returned
      from public.return_items ri
      join public.sales_returns r on r.id = ri.return_id
     where r.sale_id = v_sale.id
       and ri.sale_item_id = v_sale_item.id
       and r.refund_status <> 'rejected';

    if v_qty > (v_sale_item.quantity - v_already_returned) then
      raise exception 'Return quantity exceeds remaining returnable quantity for %', v_sale_item.sku
        using errcode = 'check_violation';
    end if;

    v_refund_total := v_refund_total + round((v_sale_item.unit_price * v_qty)::numeric, 2);
  end loop;

  if v_refund_total > (v_sale.total - v_refunded_so_far) then
    raise exception 'Refund exceeds remaining refundable amount for this sale'
      using errcode = 'check_violation';
  end if;

  -- ── approval limits (Phase 24) ────────────────────────────────────────────
  -- The refund total above is built from the sale's own line prices and capped
  -- at what is still refundable, so it cannot be inflated. What a direct call
  -- could do until now is issue a refund above the shop's cap with nobody
  -- signing it off, because returnService.ts:246 is the only place that checked.
  if public.approval_required_for('refund', v_refund_total) then
    if coalesce(btrim(p_payload ->> 'approval_request_id'), '') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
      v_approval_id := (p_payload ->> 'approval_request_id')::uuid;
    else
      v_approval_id := null;
    end if;
    v_approval_id := public.approval_assert_satisfied(
      'refund', v_refund_total, v_approval_id, '{}'::jsonb
    );
  end if;

  -- 0016 (b): `::text` binds tighter than `-`, so `next_value::text - 1` was
  -- parsed as `text - integer` and raised on every return and every refund.
  update public.return_counters set next_value = next_value + 1 where id = 1
    returning 'RET-' || lpad((next_value - 1)::text, 6, '0') into v_return_number;
  update public.refund_counters set next_value = next_value + 1 where id = 1
    returning 'REF-' || lpad((next_value - 1)::text, 6, '0') into v_refund_number;

  insert into public.sales_returns (
    return_number, sale_id, sale_number, customer_id, customer_name,
    reason, refund_amount, refund_method, refund_status, user_id, user_name
  ) values (
    v_return_number, v_sale.id, v_sale.sale_number, v_sale.customer_id, v_sale.customer_name,
    v_reason, v_refund_total, v_refund_method::public.refund_method,
    v_refund_status::public.refund_status, v_user_id, v_user_name
  ) returning id into v_return_id;

  for v_line in select * from jsonb_array_elements(p_payload->'items')
  loop
    v_qty := (v_line->>'quantity')::integer;

    select * into v_sale_item from public.sale_items
     where id = (v_line->>'sale_item_id')::uuid and sale_id = v_sale.id;

    insert into public.return_items (
      return_id, sale_item_id, product_id,
      variant_id, variant_color_ar, variant_color_en, variant_size, variant_size_label,
      name_ar, name_en, sku, barcode,
      unit_price, quantity, line_total
    ) values (
      v_return_id, v_sale_item.id, v_sale_item.product_id,
      -- The combination is a FACT ABOUT THE SALE, copied from the sold line.
      -- The caller cannot pick a shelf to put the goods back on, so returning
      -- a Gold / 17 can never restore Gold / 16 or Silver / 17.
      v_sale_item.variant_id, v_sale_item.variant_color_ar, v_sale_item.variant_color_en,
      v_sale_item.variant_size, v_sale_item.variant_size_label,
      v_sale_item.name_ar,
      v_sale_item.name_en, v_sale_item.sku, v_sale_item.barcode,
      v_sale_item.unit_price, v_qty,
      round((v_sale_item.unit_price * v_qty)::numeric, 2)
    );

    if v_sale_item.variant_id is not null then
      select * into v_variant from public.product_variants
       where id = v_sale_item.variant_id for update;
      if found then
        v_before := v_variant.stock_quantity;
        update public.product_variants
           set stock_quantity = stock_quantity + v_qty, updated_at = now()
         where id = v_variant.id;

        insert into public.stock_movements (
          product_id, variant_id, variant_color_ar, variant_color_en, variant_size,
          delta, quantity_before, quantity_after,
          type, reason, notes, user_id, user_name
        ) values (
          v_sale_item.product_id, v_variant.id, v_variant.color_ar, v_variant.color_en, v_variant.size,
          v_qty, v_before, v_before + v_qty,
          'adjustment_in', 'customer_return',
          'Customer Return: ' || v_return_number || ' (Sale ' || v_sale.sale_number || ')',
          v_user_id, v_user_name
        );
      end if;
    else
      select * into v_product from public.products where id = v_sale_item.product_id for update;
      if found then
        v_before := v_product.stock_quantity;
        update public.products
           set stock_quantity = stock_quantity + v_qty, updated_at = now()
         where id = v_product.id;

        insert into public.stock_movements (
          product_id, delta, quantity_before, quantity_after,
          type, reason, notes, user_id, user_name
        ) values (
          v_product.id, v_qty, v_before, v_before + v_qty,
          'adjustment_in', 'customer_return',
          'Customer Return: ' || v_return_number || ' (Sale ' || v_sale.sale_number || ')',
          v_user_id, v_user_name
        );
      end if;
    end if;
  end loop;

  -- 0016 (c): a refund paid over the counter is settled now, by the person
  -- recording it; a pending one waits for approval and stays unstamped.
  insert into public.refund_records (
    refund_number, sale_id, sale_number, return_id, amount,
    payment_method, status, reason, user_id, user_name,
    settled_at, settled_by, settled_by_name
  ) values (
    v_refund_number, v_sale.id, v_sale.sale_number, v_return_id, v_refund_total,
    v_refund_method::public.refund_method,
    v_refund_status::public.refund_status,
    v_reason, v_user_id, v_user_name,
    case when v_refund_status = 'completed' then now() else null end,
    case when v_refund_status = 'completed' then v_user_id else null end,
    case when v_refund_status = 'completed' then v_user_name else null end
  ) returning id into v_refund_id;

  if v_approval_id is not null then
    perform public.mark_approval_applied(v_approval_id, v_refund_id::text);
  end if;

  return jsonb_build_object('return_id', v_return_id, 'refund_id', v_refund_id);
end;
$$;


-- ── pos_settle_refund ──
--
-- Rejecting a refund reverses the return on the same combination it credited. Without this, a
-- rejected variant return would leave phantom units on one shelf.

create or replace function public.pos_settle_refund(
  p_refund_id uuid,
  p_user_id   text,
  p_user_name text,
  p_decision  text default 'completed',
  p_reason    text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_refund public.refund_records%rowtype;
  v_actor  text := coalesce(auth.uid()::text, p_user_id);
  v_name   text := p_user_name;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_return_number  text;
  v_ri             public.return_items%rowtype;
  v_product        public.products%rowtype;
  v_variant        public.product_variants%rowtype;
  v_before         integer;
  v_after          integer;
  v_reversed_units integer := 0;
begin
  if p_decision not in ('completed', 'rejected') then
    raise exception 'A refund may only be settled or rejected, not %', p_decision
      using errcode = 'check_violation';
  end if;
  if p_decision = 'rejected' and v_reason is null then
    raise exception 'A rejected refund needs a reason'
      using errcode = 'check_violation';
  end if;
  if not public.can('approve_refund') then
    raise exception 'Your role cannot settle a refund'
      using errcode = 'insufficient_privilege';
  end if;

  select * into v_refund from public.refund_records where id = p_refund_id for update;
  if not found then
    raise exception 'Refund not found' using errcode = 'no_data_found';
  end if;

  -- Idempotent in the same direction, refused in the other.
  if v_refund.status <> 'pending' then
    if v_refund.status = p_decision::public.refund_status then
      return jsonb_build_object(
        'refund_id', p_refund_id, 'status', v_refund.status, 'already_settled', true
      );
    end if;
    raise exception 'This refund was already settled as %', v_refund.status
      using errcode = 'check_violation';
  end if;

  if v_actor is not null then
    select p.name into v_name from public.profiles p where p.id = auth.uid();
    v_name := coalesce(v_name, p_user_name);
  end if;

  update public.refund_records
     set status           = p_decision::public.refund_status,
         settled_at       = now(),
         settled_by       = v_actor,
         settled_by_name  = v_name,
         rejection_reason = case when p_decision = 'rejected' then v_reason else null end
   where id = p_refund_id and status = 'pending';

  -- The linked return follows the money (Phase 27, parity with the demo
  -- repository, which already mirrored this in its settleRefund): a rejected
  -- return is a cancelled return, and a completed one is settled.
  if v_refund.return_id is not null then
    update public.sales_returns
       set refund_status = p_decision::public.refund_status
     where id = v_refund.return_id
       and refund_status = 'pending';
  end if;

  -- A rejection writes the goods back out: the return's stock restoration is
  -- reversed unit for unit, so the shelf returns to what it was before the
  -- customer brought the item in. This is what makes the released quantity
  -- (0041's v_already_returned) honest — and it is what keeps a re-accepted
  -- return from restoring the same units a second time.
  --
  -- `greatest(0, …)` mirrors the negative-stock guard and the movement
  -- consistency constraint: if stock moved since the return (a manual
  -- recount down to zero), the reversal floors at zero rather than failing
  -- the settlement.
  if p_decision = 'rejected' and v_refund.return_id is not null then
    select return_number into v_return_number
      from public.sales_returns where id = v_refund.return_id;

    for v_ri in select * from public.return_items
                where return_id = v_refund.return_id
    loop
      -- The reversal follows the return line: the same shelf the return credited
      -- is the one it is taken off, so a rejected refund of a Gold / 17 cannot
      -- reduce Gold / 16.
      if v_ri.variant_id is not null then
        select * into v_variant from public.product_variants
          where id = v_ri.variant_id for update;
        if found then
          v_before := v_variant.stock_quantity;
          v_after  := greatest(0, v_before - v_ri.quantity);
          update public.product_variants
             set stock_quantity = v_after, updated_at = now()
           where id = v_variant.id;
          insert into public.stock_movements (
            product_id, variant_id, variant_color_ar, variant_color_en, variant_size,
            delta, quantity_before, quantity_after, type, reason, notes,
            user_id, user_name
          ) values (
            v_ri.product_id, v_variant.id, v_variant.color_ar, v_variant.color_en, v_variant.size,
            v_ri.quantity, v_before, v_after,
            'adjustment_out', 'customer_return',
            'Reversed: refund ' || v_refund.refund_number || ' rejected (Return '
              || coalesce(v_return_number, '?') || ')',
            coalesce(v_actor, v_refund.user_id),
            coalesce(v_name, v_refund.user_name)
          );
          v_reversed_units := v_reversed_units + v_ri.quantity;
        end if;
      else
        select * into v_product from public.products
          where id = v_ri.product_id for update;
        if found then
          v_before := v_product.stock_quantity;
          v_after  := greatest(0, v_before - v_ri.quantity);
          update public.products
             set stock_quantity = v_after, updated_at = now()
           where id = v_ri.product_id;
          insert into public.stock_movements (
            product_id, delta, quantity_before, quantity_after, type, reason, notes,
            user_id, user_name
          ) values (
            v_ri.product_id, v_ri.quantity, v_before, v_after,
            'adjustment_out', 'customer_return',
            'Reversed: refund ' || v_refund.refund_number || ' rejected (Return '
              || coalesce(v_return_number, '?') || ')',
            coalesce(v_actor, v_refund.user_id),
            coalesce(v_name, v_refund.user_name)
          );
          v_reversed_units := v_reversed_units + v_ri.quantity;
        end if;
      end if;
    end loop;
  end if;

  insert into public.audit_log (
    action, entity, entity_id, entity_label, details, user_id, user_name
  ) values (
    case when p_decision = 'rejected' then 'refund.rejected' else 'refund.settled' end,
    'refund',
    p_refund_id::text,
    v_refund.refund_number,
    jsonb_build_object(
      'amount',   v_refund.amount,
      'method',   v_refund.payment_method::text,
      'sale',     v_refund.sale_number,
      'decision', p_decision,
      'reason',   v_reason,
      'reversed_units', v_reversed_units
    ),
    coalesce(v_actor, v_refund.user_id),
    coalesce(v_name, v_refund.user_name)
  );

  return jsonb_build_object(
    'refund_id', p_refund_id, 'status', p_decision, 'already_settled', false,
    'reversed_units', v_reversed_units
  );
end;
$$;


-- ── place_online_order ──
--
-- An online order names the exact combination, and available-to-promise is per combination:
-- stock − the holds on THAT variant. One exhausted size cannot borrow stock from another, and
-- the hold is written against the variant so the next customer's check sees it.

create or replace function public.place_online_order(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_client_ref     text := p_payload->>'client_ref';
  v_delivery_type  text := coalesce(p_payload->>'delivery_type', 'delivery');
  v_payment_method text := p_payload->>'payment_method';
  v_coupon_code    text := nullif(upper(btrim(coalesce(p_payload->>'coupon_code', ''))), '');
  v_settings       jsonb;
  v_delivery_fee   numeric(14,2) := 0;
  -- Normalized once, so the address and the shop's list of places are compared
  -- the way the storefront compares them: trimmed, case-folded, whitespace
  -- collapsed. `v_minimum`/`v_threshold` are read after the coupon, because the
  -- goods total they are measured against does not exist yet.
  v_city           text := lower(regexp_replace(btrim(coalesce(p_payload->'address'->>'city', '')), '\s+', ' ', 'g'));
  v_area           text := lower(regexp_replace(btrim(coalesce(p_payload->'address'->>'area', '')), '\s+', ' ', 'g'));
  v_minimum        numeric(14,2);
  v_threshold      numeric(14,2);

  v_line           jsonb;
  v_product        public.products%rowtype;
  v_qty            integer;
  v_available      integer;
  -- Phase 43: the exact combination this line buys, when the product has them.
  v_variant        public.product_variants%rowtype;
  v_variant_id     uuid;
  v_variant_label  text;
  v_price_fixed    boolean;
  v_unit           numeric(14,2);
  v_subtotal       numeric(14,2) := 0;
  -- Phase 23: the priced cart. The first loop works out what each line costs
  -- (catalogue price, less any live campaign) and the second loop writes the
  -- snapshot rows, so the price has to travel between them. It did not: the
  -- second loop read `unit_price` from the caller's payload, which the app
  -- never sends — every live-mode checkout failed the NOT NULL constraint, and
  -- a caller who did send one set the shop's own snapshot price.
  v_priced_lines   jsonb := '[]'::jsonb;

  v_coupon         public.coupons%rowtype;
  v_discount       numeric(14,2) := 0;
  v_campaign       public.campaigns%rowtype;
  -- What is in the cart, so a coupon restricted to certain products or
  -- categories can be checked against the real contents rather than trusted.
  v_cart_products  text[] := '{}';
  v_cart_categories text[] := '{}';

  v_total          numeric(14,2);
  v_order_id       uuid;
  v_order_number   text;
  v_customer_id    uuid := nullif(p_payload->>'store_customer_id', '')::uuid;
  v_payment_status public.online_payment_status;
begin
  -- 1. idempotency: a double submit returns the original order
  select id, order_number into v_order_id, v_order_number
  from public.online_orders where client_ref = v_client_ref;
  if found then
    return jsonb_build_object('order_id', v_order_id, 'order_number', v_order_number, 'duplicate', true);
  end if;

  if coalesce(btrim(p_payload->>'customer_name'), '') = '' then
    raise exception 'Customer name is required' using errcode = 'check_violation';
  end if;
  if coalesce(btrim(p_payload->>'customer_phone'), '') = '' then
    raise exception 'Customer phone is required' using errcode = 'check_violation';
  end if;
  if v_delivery_type not in ('delivery', 'pickup') then
    raise exception 'Invalid delivery type' using errcode = 'check_violation';
  end if;
  if v_payment_method not in ('cod', 'instapay') then
    raise exception 'Invalid payment method' using errcode = 'check_violation';
  end if;
  if jsonb_array_length(coalesce(p_payload->'lines', '[]'::jsonb)) = 0 then
    raise exception 'Empty cart' using errcode = 'check_violation';
  end if;

  select settings into v_settings from public.website_settings where id = 1;
  v_settings := coalesce(v_settings, '{}'::jsonb);

  -- 2. the delivery fee is the shop's, not the customer's — and so are the
  --    places the shop is willing to deliver to
  if v_delivery_type = 'delivery' then
    if coalesce((v_settings->'delivery'->>'enabled')::boolean, true) = false then
      raise exception 'Delivery is not available' using errcode = 'check_violation';
    end if;
    v_delivery_fee := greatest(round(coalesce((v_settings->'delivery'->>'fee')::numeric, 0), 2), 0);

    -- A driver needs a whole address: which city, which area in it, and which
    -- street. Building, floor and apartment stay optional.
    if v_city = ''
       or v_area = ''
       or coalesce(btrim(p_payload->'address'->>'street'), '') = '' then
      raise exception 'A delivery address is required' using errcode = 'check_violation';
    end if;

    -- The shop may list the places it serves — cities or neighbourhoods, in
    -- either language. An empty list means it has not restricted delivery.
    if jsonb_typeof(v_settings->'delivery'->'areas') = 'array'
       and jsonb_array_length(v_settings->'delivery'->'areas') > 0
       and not exists (
         select 1
         from jsonb_array_elements(v_settings->'delivery'->'areas') as place
         where (
           coalesce(place->>'ar', '') <> ''
           and lower(regexp_replace(btrim(place->>'ar'), '\s+', ' ', 'g')) in (v_city, v_area)
         ) or (
           coalesce(place->>'en', '') <> ''
           and lower(regexp_replace(btrim(place->>'en'), '\s+', ' ', 'g')) in (v_city, v_area)
         )
       ) then
      raise exception 'Delivery to % is not available',
        coalesce(nullif(btrim(coalesce(p_payload->'address'->>'city', '')), ''),
                 btrim(coalesce(p_payload->'address'->>'area', '')))
        using errcode = 'check_violation';
    end if;
  else
    v_delivery_fee := 0;
  end if;

  -- 3. lines: authoritative prices, campaign discounts, availability
  for v_line in select * from jsonb_array_elements(p_payload->'lines')
  loop
    v_qty := (v_line->>'qty')::integer;
    if v_qty is null or v_qty <= 0 then
      raise exception 'Invalid quantity' using errcode = 'check_violation';
    end if;

    select * into v_product from public.products
    where id = (v_line->>'product_id')::uuid for update;
    if not found then
      raise exception 'Product % not found', v_line->>'product_id' using errcode = 'foreign_key_violation';
    end if;
    if not v_product.active or not v_product.show_on_website then
      raise exception 'Product % is not available on the website', v_product.sku
        using errcode = 'check_violation';
    end if;
    -- Approval turns the order into a POS sale, and a sale can only carry
    -- stock-tracked products. Refusing here means the customer hears it at
    -- checkout, instead of staff discovering it when they try to approve.
    if not v_product.stock_tracking_enabled then
      raise exception 'Product % cannot be ordered online', v_product.sku
        using errcode = 'check_violation';
    end if;
    -- ── Phase 43: which combination, and how many of THAT are promiseable ──
    -- Available-to-promise is per exact combination: stock − the holds on that
    -- variant. G17 = 2 with S17 = 2 refuses a third Gold / 17 while Silver / 17
    -- is untouched, and the product rollup never enters the arithmetic.
    v_price_fixed := false;
    if v_product.variants_enabled then
      v_variant_id := public.variant_id_of(v_line ->> 'variant_id');
      if v_variant_id is null then
        raise exception 'Choose the colour and the size for %', v_product.sku
          using errcode = 'check_violation';
      end if;
      select * into v_variant from public.product_variants
       where id = v_variant_id and product_id = v_product.id
       for update;
      if not found then
        raise exception 'That colour and size does not belong to %', v_product.sku
          using errcode = 'check_violation';
      end if;
      if not v_variant.active then
        raise exception '% is no longer sold',
          coalesce(public.variant_label(v_variant.color_en, v_variant.color_ar,
                                       v_variant.size, v_variant.size_label), v_variant.sku)
          using errcode = 'check_violation';
      end if;
      v_variant_label := coalesce(public.variant_label(v_variant.color_en, v_variant.color_ar,
                                                      v_variant.size, v_variant.size_label), v_variant.sku);
      v_available := v_variant.stock_quantity - public.reserved_quantity_variant(v_variant.id);
      if v_qty > v_available then
        raise exception 'Only % of % available', v_available, v_variant_label
          using errcode = 'check_violation';
      end if;
      if v_variant.price_override is not null then
        v_price_fixed := true;
      end if;
    elsif v_product.stock_tracking_enabled then
      v_available := v_product.stock_quantity - public.reserved_quantity(v_product.id);
      if v_qty > v_available then
        raise exception 'Only % of % available', v_available, v_product.sku
          using errcode = 'check_violation';
      end if;
    end if;

    v_cart_products := array_append(v_cart_products, v_product.id::text);
    if v_product.category_id is not null then
      v_cart_categories := array_append(v_cart_categories, v_product.category_id::text);
    end if;

    -- A live campaign on this product lowers the unit price; the customer's
    -- cart total is never trusted.
    --
    -- A combination with its own price is priced by that override and nothing
    -- else: a shop that marked one size down did so deliberately, and letting a
    -- campaign stack on top would quietly sell below the number it chose.
    v_unit := case when v_variant_id is not null and v_price_fixed
                   then v_variant.price_override
                   else v_product.selling_price
              end;
    if not v_price_fixed then
      select * into v_campaign
      from public.campaigns
      where active
        and starts_at <= now() and ends_at >= now()
        and product_ids @> to_jsonb(array[v_product.id::text])
      order by discount_value desc
      limit 1;
      if found then
        if v_campaign.discount_type = 'percent' then
          v_unit := round((v_unit * (100 - v_campaign.discount_value) / 100)::numeric, 2);
        else
          v_unit := greatest(round((v_unit - v_campaign.discount_value)::numeric, 2), 0);
        end if;
      end if;
    end if;

    v_subtotal := v_subtotal + round((v_unit * v_qty)::numeric, 2);

    -- Carry the shop's price to the snapshot loop. Nothing from the caller's
    -- line is trusted past this point but product_id and qty, both of which
    -- were just validated against the catalogue.
    v_priced_lines := v_priced_lines || jsonb_build_object(
      'product_id', v_product.id::text,
      'qty',        v_qty,
      'unit_price', v_unit,
      -- Carried so the snapshot loop writes the same combination this loop
      -- priced and checked. Null on every legacy line.
      'variant_id', v_variant.id::text
    );
  end loop;

  -- 4. coupon, validated against its own rules and the recomputed subtotal
  if v_coupon_code is not null then
    select * into v_coupon from public.coupons
    where code = v_coupon_code for update;
    if not found or not v_coupon.active then
      raise exception 'Coupon % is not valid', v_coupon_code using errcode = 'check_violation';
    end if;
    if v_coupon.starts_at is not null and v_coupon.starts_at > now() then
      raise exception 'Coupon % is not active yet', v_coupon_code using errcode = 'check_violation';
    end if;
    if v_coupon.ends_at is not null and v_coupon.ends_at < now() then
      raise exception 'Coupon % has expired', v_coupon_code using errcode = 'check_violation';
    end if;
    if v_coupon.usage_limit is not null and v_coupon.used_count >= v_coupon.usage_limit then
      raise exception 'Coupon % has been fully used', v_coupon_code using errcode = 'check_violation';
    end if;
    if v_subtotal < v_coupon.min_subtotal then
      raise exception 'Coupon % needs a subtotal of at least %', v_coupon_code, v_coupon.min_subtotal
        using errcode = 'check_violation';
    end if;

    -- A code restricted to certain products or categories only applies when the
    -- cart actually contains one of them. Without this, "10% off coffee" would
    -- discount an espresso machine too.
    if v_coupon.applies_to = 'products' and not exists (
      select 1 from jsonb_array_elements_text(v_coupon.target_ids) as target
      where target = any (v_cart_products)
    ) then
      raise exception 'Coupon % does not apply to this cart', v_coupon_code
        using errcode = 'check_violation';
    end if;
    if v_coupon.applies_to = 'categories' and not exists (
      select 1 from jsonb_array_elements_text(v_coupon.target_ids) as target
      where target = any (v_cart_categories)
    ) then
      raise exception 'Coupon % does not apply to this cart', v_coupon_code
        using errcode = 'check_violation';
    end if;

    if v_coupon.discount_type = 'percent' then
      v_discount := round((v_subtotal * v_coupon.value / 100)::numeric, 2);
      if v_coupon.max_discount is not null then
        v_discount := least(v_discount, v_coupon.max_discount);
      end if;
    else
      v_discount := least(round(v_coupon.value::numeric, 2), v_subtotal);
    end if;

    update public.coupons set used_count = used_count + 1, updated_at = now()
    where id = v_coupon.id;
  end if;

  -- 4b. the shop's delivery rules, measured against the goods total the coupon
  --     has already reduced — the same number the checkout shows.
  if v_delivery_type = 'delivery' then
    v_minimum := nullif(v_settings->'delivery'->>'minimum_order', '')::numeric;
    if v_minimum is not null and v_minimum > 0 and (v_subtotal - v_discount) < v_minimum then
      raise exception 'Delivery orders need at least %', v_minimum
        using errcode = 'check_violation';
    end if;
    v_threshold := nullif(v_settings->'delivery'->>'free_delivery_threshold', '')::numeric;
    if v_threshold is not null and v_threshold > 0
       and (v_subtotal - v_discount) >= v_threshold then
      v_delivery_fee := 0;
    end if;
  end if;

  v_total := v_subtotal - v_discount + v_delivery_fee;

  -- InstaPay always needs a human to confirm the transfer; cash on delivery is
  -- simply unpaid until it is collected.
  v_payment_status := case
    when v_payment_method = 'instapay' then 'verification_required'::public.online_payment_status
    else 'pending'::public.online_payment_status
  end;

  -- 5. the order
  insert into public.online_orders (
    client_ref, store_customer_id, customer_name, customer_phone, customer_email,
    delivery_type, address, subtotal, discount_code, discount_amount, delivery_fee,
    total, payment_method, payment_status, status, notes
  ) values (
    v_client_ref,
    v_customer_id,
    btrim(p_payload->>'customer_name'),
    btrim(p_payload->>'customer_phone'),
    nullif(btrim(coalesce(p_payload->>'customer_email', '')), ''),
    v_delivery_type::public.delivery_type,
    coalesce(p_payload->'address', '{}'::jsonb),
    v_subtotal, v_coupon_code, v_discount, v_delivery_fee,
    v_total, v_payment_method::public.payment_method, v_payment_status,
    'pending'::public.online_order_status,
    nullif(btrim(coalesce(p_payload->>'notes', '')), '')
  ) returning id, order_number into v_order_id, v_order_number;

  -- 6. line items (snapshot) + reservations (inventory protection)
  -- Phase 23: the priced cart, not the payload. Same keys, so the body below
  -- is unchanged; the difference is that `unit_price` is now the shop's.
  for v_line in select * from jsonb_array_elements(v_priced_lines)
  loop
    v_qty := (v_line->>'qty')::integer;
    v_variant_id := public.variant_id_of(v_line ->> 'variant_id');
    select * into v_product from public.products where id = (v_line->>'product_id')::uuid;
    v_unit := round((v_line->>'unit_price')::numeric, 2);

    if v_variant_id is not null then
      select * into v_variant from public.product_variants where id = v_variant_id;

      insert into public.online_order_items (
        order_id, product_id, variant_id,
        variant_color_ar, variant_color_en, variant_size, variant_size_label,
        name_ar, name_en, sku, barcode, unit_price, quantity, line_total
      ) values (
        v_order_id, v_product.id, v_variant.id,
        v_variant.color_ar, v_variant.color_en, v_variant.size, v_variant.size_label,
        v_product.name_ar, v_product.name_en, v_variant.sku, v_variant.barcode,
        v_unit, v_qty, round((v_unit * v_qty)::numeric, 2)
      );

      if v_product.stock_tracking_enabled then
        -- Same order, same product, same combination → the holds ADD UP instead
        -- of hiding the same units twice behind a duplicate row.
        update public.stock_reservations
           set quantity = quantity + v_qty
         where online_order_id = v_order_id
           and product_id = v_product.id
           and variant_id = v_variant.id
           and status = 'reserved';
        if not found then
          insert into public.stock_reservations (online_order_id, product_id, variant_id, quantity, status)
          values (v_order_id, v_product.id, v_variant.id, v_qty, 'reserved'::public.reservation_status);
        end if;
      end if;
    else
      insert into public.online_order_items (
        order_id, product_id, name_ar, name_en, sku, barcode, unit_price, quantity, line_total
      ) values (
        v_order_id, v_product.id, v_product.name_ar, v_product.name_en, v_product.sku,
        v_product.barcode, v_unit, v_qty, round((v_unit * v_qty)::numeric, 2)
      );

      if v_product.stock_tracking_enabled then
        update public.stock_reservations
           set quantity = quantity + v_qty
         where online_order_id = v_order_id
           and product_id = v_product.id
           and variant_id is null
           and status = 'reserved';
        if not found then
          insert into public.stock_reservations (online_order_id, product_id, quantity, status)
          values (v_order_id, v_product.id, v_qty, 'reserved'::public.reservation_status);
        end if;
      end if;
    end if;
  end loop;

  insert into public.order_events (order_id, kind, note)
  values (v_order_id, 'placed'::public.order_event_kind,
          'Order placed on the website (' || v_delivery_type || ')');

  return jsonb_build_object(
    'order_id', v_order_id,
    'order_number', v_order_number,
    'total', v_total,
    'payment_status', v_payment_status::text,
    'duplicate', false
  );
end;
$$;


-- ── resolve_online_order ──
--
-- Approving an order creates the sale through pos_complete_sale with the order's exact
-- combinations attached, so the deduction lands on the right shelf; cancelling an approved
-- order restores the same combinations, one movement per line.

create or replace function public.resolve_online_order(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_action      text := p_payload->>'action';
  v_order_id    uuid := nullif(p_payload->>'order_id', '')::uuid;
  v_reason      text := nullif(btrim(coalesce(p_payload->>'reason', '')), '');
  v_order       public.online_orders%rowtype;
  v_user_id     text := coalesce(auth.uid()::text, p_payload->>'user_id', '');
  v_user_name   text := coalesce(nullif(btrim(coalesce(p_payload->>'user_name', '')), ''),
                                 (select p.name from public.profiles p where p.id = auth.uid()),
                                 'System');
  v_goods_total numeric(14,2);
  v_list_total  numeric(14,2);
  v_sale_discount numeric(14,2);
  v_result      jsonb;
  v_reservation record;
begin
  select * into v_order from public.online_orders where id = v_order_id for update;
  if not found then
    raise exception 'Order not found' using errcode = 'P0002';
  end if;

  -- ── payment verification ────────────────────────────────────────────────
  if v_action in ('payment_approve', 'payment_reject') then
    if not public.can('confirm_payment') then
      raise exception 'Not allowed to verify payments' using errcode = '42501';
    end if;
    if v_order.payment_status = 'paid' and v_action = 'payment_approve' then
      return jsonb_build_object('order_number', v_order.order_number, 'payment_status', 'paid');
    end if;

    if v_action = 'payment_approve' then
      update public.online_orders
      set payment_status = 'paid'::public.online_payment_status,
          payment_verified_by = auth.uid(),
          payment_verified_by_name = v_user_name,
          payment_verified_at = now(),
          updated_at = now()
      where id = v_order.id;

      insert into public.order_events (order_id, kind, note, user_id, user_name)
      values (v_order.id, 'payment_approved'::public.order_event_kind,
              'Payment verified and accepted', auth.uid(), v_user_name);

      insert into public.audit_log (action, entity_id, entity_label, details, user_id, user_name)
      values ('online_order.payment_approved', v_order.id::text, v_order.order_number,
              jsonb_build_object('method', v_order.payment_method::text,
                                 'amount', v_order.total,
                                 'reference', v_order.payment_reference),
              v_user_id, v_user_name);

      return jsonb_build_object('order_number', v_order.order_number, 'payment_status', 'paid');
    end if;

    if v_reason is null then
      raise exception 'A rejection reason is required' using errcode = 'check_violation';
    end if;

    update public.online_orders
    set payment_status = 'failed'::public.online_payment_status,
        payment_rejected_reason = v_reason,
        payment_verified_by = auth.uid(),
        payment_verified_by_name = v_user_name,
        payment_verified_at = now(),
        updated_at = now()
    where id = v_order.id;

    insert into public.order_events (order_id, kind, note, user_id, user_name)
    values (v_order.id, 'payment_rejected'::public.order_event_kind,
            'Payment rejected: ' || v_reason, auth.uid(), v_user_name);

    insert into public.audit_log (action, entity_id, entity_label, details, user_id, user_name)
    values ('online_order.payment_rejected', v_order.id::text, v_order.order_number,
            jsonb_build_object('reason', v_reason, 'amount', v_order.total),
            v_user_id, v_user_name);

    return jsonb_build_object('order_number', v_order.order_number, 'payment_status', 'failed');
  end if;

  -- ── everything below is order-state work ────────────────────────────────
  if not public.can('manage_online_orders') then
    raise exception 'Not allowed to manage online orders' using errcode = '42501';
  end if;

  if v_action = 'approve' then
    if v_order.status <> 'pending' then
      raise exception 'Only a pending order can be approved (this one is %)', v_order.status::text
        using errcode = 'check_violation';
    end if;
    -- Unverified money must never become a sale.
    if v_order.payment_method = 'instapay' and v_order.payment_status <> 'paid' then
      raise exception 'Verify the InstaPay payment before approving this order'
        using errcode = 'check_violation';
    end if;

    -- The sale covers the merchandise; the delivery fee stays on the order
    -- (a POS sale has no delivery-fee column, by constraint).
    v_goods_total := v_order.subtotal - v_order.discount_amount;

    -- `pos_complete_sale` re-reads catalogue prices, so the sale's lines come out
    -- at LIST price. Whatever lowered them when the customer checked out — a
    -- flash sale, a coupon, both — has to be carried across as one fixed
    -- discount, or the register would book more revenue than the order took.
    -- The baseline the discount is measured against is what the till will
    -- charge: the combination's own price when it has one, otherwise the
    -- product's. Using the product price for a variant line would book a
    -- phantom discount equal to the override.
    select coalesce(sum(round((coalesce(v.price_override, p.selling_price) * i.quantity)::numeric, 2)), 0)
      into v_list_total
    from public.online_order_items i
    join public.products p on p.id = i.product_id
    left join public.product_variants v on v.id = i.variant_id
    where i.order_id = v_order.id;

    v_sale_discount := greatest(round((v_list_total - v_goods_total)::numeric, 2), 0);

    v_result := public.pos_complete_sale(jsonb_build_object(
      'client_ref', 'online-' || v_order.id::text,
      'source', 'online',
      'order_number', v_order.order_number,
      'discount_type', case when v_sale_discount > 0 then 'fixed' else 'none' end,
      'discount_value', v_sale_discount,
      'user_id', v_user_id,
      'user_name', v_user_name,
      'customer_id', v_order.store_customer_id,
      'customer_name', v_order.customer_name,
      'customer_phone', v_order.customer_phone,
      'lines', coalesce((
        select jsonb_agg(jsonb_build_object('product_id', i.product_id, 'qty', i.quantity,
                                            'variant_id', i.variant_id))
        from public.online_order_items i where i.order_id = v_order.id
      ), '[]'::jsonb),
      'payments', jsonb_build_array(jsonb_build_object(
        'method', case when v_order.payment_method = 'cod' then 'cod' else 'instapay' end,
        'amount', v_goods_total,
        'status', case when v_order.payment_status = 'paid' then 'paid' else 'pending' end
      ))
    ));

    -- Reservations become the deduction the sale just made.
    update public.stock_reservations
    set status = 'converted'::public.reservation_status, resolved_at = now()
    where online_order_id = v_order.id and status = 'reserved';

    update public.online_orders
    set status = 'approved'::public.online_order_status,
        sale_id = (v_result->>'sale_id')::uuid,
        sale_number = v_result->>'sale_number',
        approved_by = auth.uid(),
        approved_by_name = v_user_name,
        approved_at = now(),
        updated_at = now()
    where id = v_order.id;

    insert into public.order_events (order_id, kind, note, user_id, user_name)
    values (v_order.id, 'approved'::public.order_event_kind,
            'Order approved · sale ' || coalesce(v_result->>'sale_number', ''),
            auth.uid(), v_user_name);

    insert into public.audit_log (action, entity_id, entity_label, details, user_id, user_name)
    values ('online_order.approved', v_order.id::text, v_order.order_number,
            jsonb_build_object('sale_number', v_result->>'sale_number',
                               'total', v_order.total,
                               'payment_method', v_order.payment_method::text,
                               'source', 'website'),
            v_user_id, v_user_name);

    return jsonb_build_object('order_number', v_order.order_number, 'status', 'approved',
                              'sale_number', v_result->>'sale_number');
  end if;

  if v_action = 'cancel' then
    if v_order.status in ('cancelled', 'completed') then
      raise exception 'A % order cannot be cancelled', v_order.status::text
        using errcode = 'check_violation';
    end if;
    if v_reason is null then
      raise exception 'A cancellation reason is required' using errcode = 'check_violation';
    end if;

    -- An approved order already became a sale: unwind it, which is what puts
    -- the stock back. That is a void, so it needs the void capability.
    if v_order.sale_id is not null then
      if not public.can('void_sale') then
        raise exception 'This order was approved and became sale %; only a manager can cancel it',
          coalesce(v_order.sale_number, '') using errcode = '42501';
      end if;
      update public.sales
      set status = 'voided'::public.sale_status,
          voided_at = now(),
          void_reason = 'Online order ' || v_order.order_number || ' cancelled: ' || v_reason
      where id = v_order.sale_id
        and status <> 'voided';

      -- Restore the stock the voided sale took, one movement per line. Mirrors
      -- the void path in 0007 exactly: `delta` is a magnitude (the column
      -- checks delta > 0) and the sign is implied by `adjustment_in`.
      for v_reservation in
        select i.product_id, i.variant_id, i.quantity, p.stock_quantity,
               v.stock_quantity as variant_stock, v.color_ar, v.color_en, v.size
        from public.online_order_items i
        join public.products p on p.id = i.product_id
        left join public.product_variants v on v.id = i.variant_id
        where i.order_id = v_order.id
      loop
        if v_reservation.variant_id is not null then
          update public.product_variants
          set stock_quantity = stock_quantity + v_reservation.quantity, updated_at = now()
          where id = v_reservation.variant_id;

          insert into public.stock_movements
            (product_id, variant_id, variant_color_ar, variant_color_en, variant_size,
             delta, quantity_before, quantity_after, type, reason, notes, user_id, user_name)
          values (v_reservation.product_id, v_reservation.variant_id,
                  v_reservation.color_ar, v_reservation.color_en, v_reservation.size,
                  v_reservation.quantity,
                  v_reservation.variant_stock,
                  v_reservation.variant_stock + v_reservation.quantity,
                  'adjustment_in', 'other',
                  'Cancelled online order ' || v_order.order_number, v_user_id, v_user_name);
        else
          update public.products
          set stock_quantity = stock_quantity + v_reservation.quantity, updated_at = now()
          where id = v_reservation.product_id;

          insert into public.stock_movements
            (product_id, delta, quantity_before, quantity_after, type, reason, notes, user_id, user_name)
          values (v_reservation.product_id, v_reservation.quantity,
                  v_reservation.stock_quantity,
                  v_reservation.stock_quantity + v_reservation.quantity,
                  'adjustment_in', 'other',
                  'Cancelled online order ' || v_order.order_number, v_user_id, v_user_name);
        end if;
      end loop;
    end if;

    -- Whatever was still held goes back to the pool.
    update public.stock_reservations
    set status = 'released'::public.reservation_status, resolved_at = now()
    where online_order_id = v_order.id and status = 'reserved';

    -- A coupon consumed by a cancelled order is given back.
    if v_order.discount_code is not null then
      update public.coupons
      set used_count = greatest(used_count - 1, 0), updated_at = now()
      where code = v_order.discount_code;
    end if;

    update public.online_orders
    set status = 'cancelled'::public.online_order_status,
        cancellation_reason = v_reason,
        cancelled_by = auth.uid(),
        cancelled_by_name = v_user_name,
        cancelled_at = now(),
        sale_id = null,
        sale_number = null,
        updated_at = now()
    where id = v_order.id;

    insert into public.order_events (order_id, kind, note, user_id, user_name)
    values (v_order.id, 'cancelled'::public.order_event_kind,
            'Order cancelled: ' || v_reason, auth.uid(), v_user_name);

    insert into public.audit_log (action, entity_id, entity_label, details, user_id, user_name)
    values ('online_order.cancelled', v_order.id::text, v_order.order_number,
            jsonb_build_object('reason', v_reason, 'total', v_order.total,
                               'had_sale', v_order.sale_id is not null),
            v_user_id, v_user_name);

    return jsonb_build_object('order_number', v_order.order_number, 'status', 'cancelled');
  end if;

  if v_action in ('processing', 'ready', 'complete') then
    -- Forward-only: an order may not go backwards or skip approval.
    if v_order.status in ('cancelled', 'pending') then
      raise exception 'A % order must be approved first', v_order.status::text
        using errcode = 'check_violation';
    end if;
    if v_order.status in ('completed') then
      raise exception 'This order is already completed' using errcode = 'check_violation';
    end if;
    if v_order.status = 'ready' and v_action = 'processing' then
      raise exception 'A ready order cannot go back to processing' using errcode = 'check_violation';
    end if;

    update public.online_orders
    set status = v_action::public.online_order_status,
        completed_at = case when v_action = 'complete' then now() else completed_at end,
        updated_at = now()
    where id = v_order.id;

    insert into public.order_events (order_id, kind, note, user_id, user_name)
    values (v_order.id, v_action::public.order_event_kind,
            initcap(v_action) || ' by ' || v_user_name, auth.uid(), v_user_name);

    return jsonb_build_object('order_number', v_order.order_number, 'status', v_action);
  end if;

  raise exception 'Unknown action %', coalesce(v_action, '(none)') using errcode = 'check_violation';
end;
$$;


-- ── repair_stock_reservation ──
--
-- The 9-argument repair names the combination a hold covers. The 8-argument signature from 0025
-- is kept below as a wrapper, so every existing caller keeps working unchanged.

create or replace function public.repair_stock_reservation(
  p_action         text,
  p_reservation_id uuid,
  p_order_id       uuid,
  p_product_id     uuid,
  p_quantity       integer,
  p_reason         text,
  p_user_id        text,
  p_user_name      text,
  -- Phase 43: the exact combination a 'hold' should cover. NOT defaulted, so
  -- the 8-argument signature below stays unambiguous and keeps working.
  p_variant_id     uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_action       text := lower(btrim(coalesce(p_action, '')));
  v_reason       text := nullif(btrim(coalesce(p_reason, '')), '');
  v_user_id      text := coalesce(auth.uid()::text, p_user_id, '');
  v_user_name    text := coalesce(nullif(btrim(coalesce(p_user_name, '')), ''),
                                 (select p.name from public.profiles p where p.id = auth.uid()),
                                 'System');
  v_reservation  public.stock_reservations%rowtype;
  v_order        public.online_orders%rowtype;
  v_product      public.products%rowtype;
  v_variant      public.product_variants%rowtype;
  v_variant_id   uuid;
  v_expected     integer;
  v_before       jsonb;
  v_note         text;
  -- Where a release or a convert is heading, computed once. It has to be a
  -- variable: plpgsql reads the first `then` it meets as the IF's own, so a CASE
  -- inline in a condition is a syntax error, not a value.
  v_wanted       text;
begin
  v_wanted := case when v_action = 'release' then 'released' else 'converted' end;
  -- Oversight, not till work: the same capability the stock ledger asks for.
  if not public.can('adjust_stock') then
    raise exception 'Only a manager or the inventory clerk can repair stock holds'
      using errcode = '42501';
  end if;

  if v_reason is null then
    raise exception 'A reason is required' using errcode = 'check_violation';
  end if;

  if v_action not in ('release', 'convert', 'reconcile', 'hold') then
    raise exception 'Unknown repair action %', coalesce(p_action, '(none)')
      using errcode = 'check_violation';
  end if;

  -- ── 'hold': restore a hold a pending order should already have ────────────
  if v_action = 'hold' then
    select * into v_order from public.online_orders where id = p_order_id for update;
    if not found then
      raise exception 'Order not found' using errcode = 'P0002';
    end if;
    if v_order.status <> 'pending' then
      raise exception 'A % order does not hold stock, so there is nothing to repair',
        v_order.status::text using errcode = 'check_violation';
    end if;

    select * into v_product from public.products where id = p_product_id;
    if not found or not v_product.stock_tracking_enabled then
      raise exception 'This product does not track stock, so it holds nothing'
        using errcode = 'check_violation';
    end if;

    -- A product that sells by variant holds an EXACT combination, so the repair
    -- must name one too. Without it there is no honest answer to "hold what?".
    if v_product.variants_enabled then
      if p_variant_id is null then
        raise exception 'Product % sells by variant — name the combination this hold covers', v_product.sku
          using errcode = 'check_violation';
      end if;
      select * into v_variant from public.product_variants
       where id = p_variant_id and product_id = p_product_id for update;
      if not found then
        raise exception 'That colour and size does not belong to %', v_product.sku
          using errcode = 'check_violation';
      end if;
      v_variant_id := v_variant.id;
    else
      v_variant_id := null;
    end if;

    select coalesce(sum(i.quantity), 0)::integer into v_expected
    from public.online_order_items i
    where i.order_id = v_order.id
      and i.product_id = p_product_id
      and i.variant_id is not distinct from v_variant_id;

    if v_expected is null or v_expected <= 0 then
      raise exception 'The order has no line for this product' using errcode = 'check_violation';
    end if;
    if p_quantity is not null and p_quantity <> v_expected then
      raise exception 'The order asks for %; a repair cannot hold a different number', v_expected
        using errcode = 'check_violation';
    end if;

    -- Two holds on one line would hide the same units twice.
    select * into v_reservation
    from public.stock_reservations
    where online_order_id = v_order.id
      and product_id = p_product_id
      and variant_id is not distinct from v_variant_id
      and status = 'reserved'
    for update;
    if found then
      return jsonb_build_object(
        'reservation', to_jsonb(v_reservation),
        'before', jsonb_build_object('status', v_reservation.status,
                                     'quantity', v_reservation.quantity,
                                     'resolved_at', v_reservation.resolved_at),
        'already_resolved', true,
        'order_number', v_order.order_number);
    end if;

    insert into public.stock_reservations (online_order_id, product_id, variant_id, quantity, status)
    values (v_order.id, p_product_id, v_variant_id, v_expected, 'reserved'::public.reservation_status)
    returning * into v_reservation;

    insert into public.order_events (order_id, kind, note, user_id, user_name)
    values (v_order.id, 'note'::public.order_event_kind,
            'Hold restored · ' || v_expected || ' unit(s) · ' || v_reason,
            auth.uid(), v_user_name);

    return jsonb_build_object(
      'reservation', to_jsonb(v_reservation),
      'before', jsonb_build_object('status', null, 'quantity', 0, 'resolved_at', null),
      'already_resolved', false,
      'order_number', v_order.order_number);
  end if;

  -- ── release / convert / reconcile: one existing row ───────────────────────
  if p_reservation_id is null then
    raise exception 'A reservation id is required' using errcode = 'check_violation';
  end if;

  select * into v_reservation
  from public.stock_reservations
  where id = p_reservation_id
  for update;
  if not found then
    raise exception 'Reservation not found' using errcode = 'P0002';
  end if;

  v_before := jsonb_build_object('status', v_reservation.status,
                                 'quantity', v_reservation.quantity,
                                 'resolved_at', v_reservation.resolved_at);

  select * into v_order from public.online_orders where id = v_reservation.online_order_id for update;

  -- ── a resolved row: repeatable in its own direction, refused in the other ──
  if v_reservation.status <> 'reserved' then
    if v_action = 'reconcile' then
      -- The only thing a settled row can still be wrong about is its own
      -- timestamp, which the table's check constraint requires.
      if v_reservation.resolved_at is not null then
        return jsonb_build_object('reservation', to_jsonb(v_reservation), 'before', v_before,
                                  'already_resolved', true,
                                  'order_number', v_order.order_number);
      end if;
      update public.stock_reservations
      set resolved_at = now()
      where id = v_reservation.id
      returning * into v_reservation;

      if found and v_order.id is not null then
        insert into public.order_events (order_id, kind, note, user_id, user_name)
        values (v_order.id, 'note'::public.order_event_kind,
                'Hold reconciled · resolved timestamp recorded · ' || v_reason,
                auth.uid(), v_user_name);
      end if;

      return jsonb_build_object('reservation', to_jsonb(v_reservation), 'before', v_before,
                                'already_resolved', false,
                                'order_number', v_order.order_number);
    end if;

    if v_reservation.status::text = v_wanted then
      return jsonb_build_object('reservation', to_jsonb(v_reservation), 'before', v_before,
                                'already_resolved', true,
                                'order_number', v_order.order_number);
    end if;

    raise exception 'This hold was already %; it cannot be %',
      v_reservation.status::text, v_wanted
      using errcode = 'check_violation';
  end if;

  -- ── reconcile an open hold: the quantity is the order's own ───────────────
  if v_action = 'reconcile' then
    if v_order.id is null then
      raise exception 'Order not found' using errcode = 'P0002';
    end if;
    if v_order.status <> 'pending' then
      raise exception 'A % order does not hold stock — release or convert the hold instead',
        v_order.status::text using errcode = 'check_violation';
    end if;

    select coalesce(sum(i.quantity), 0)::integer into v_expected
    from public.online_order_items i
    where i.order_id = v_order.id
      and i.product_id = v_reservation.product_id
      and i.variant_id is not distinct from v_reservation.variant_id;

    if v_expected is null or v_expected <= 0 then
      raise exception 'The order has no line for this product — release the hold instead'
        using errcode = 'check_violation';
    end if;
    if p_quantity is not null and p_quantity <> v_expected then
      raise exception 'The order asks for %; a repair cannot hold a different number', v_expected
        using errcode = 'check_violation';
    end if;
    if v_expected = v_reservation.quantity then
      return jsonb_build_object('reservation', to_jsonb(v_reservation), 'before', v_before,
                                'already_resolved', true,
                                'order_number', v_order.order_number);
    end if;

    update public.stock_reservations
    set quantity = v_expected
    where id = v_reservation.id
    returning * into v_reservation;

    insert into public.order_events (order_id, kind, note, user_id, user_name)
    values (v_order.id, 'note'::public.order_event_kind,
            'Hold reconciled · ' || (v_before->>'quantity') || ' → ' || v_expected || ' units · ' || v_reason,
            auth.uid(), v_user_name);

    return jsonb_build_object('reservation', to_jsonb(v_reservation), 'before', v_before,
                              'already_resolved', false,
                              'order_number', v_order.order_number);
  end if;

  -- ── release / convert ─────────────────────────────────────────────────────
  update public.stock_reservations
  set status = v_wanted::public.reservation_status,
      resolved_at = now()
  where id = v_reservation.id
  returning * into v_reservation;

  v_note := 'Hold ' || v_reservation.status::text || ' during reconciliation · '
            || (v_before->>'quantity') || ' unit(s) · ' || v_reason;
  if v_order.id is not null then
    insert into public.order_events (order_id, kind, note, user_id, user_name)
    values (v_order.id, 'note'::public.order_event_kind, v_note, auth.uid(), v_user_name);
  end if;

  return jsonb_build_object('reservation', to_jsonb(v_reservation), 'before', v_before,
                            'already_resolved', false,
                            'order_number', v_order.order_number);
end;
$$;


comment on function public.repair_stock_reservation(text, uuid, uuid, uuid, integer, text, text, text, uuid) is
  'Repairs one hold. Variant-aware: a "hold" on a product that sells by variant must name the exact combination, and the reservation''s own variant_id decides which shelf it covers.';

/**
 * The pre-Phase-43 entry point, unchanged in name and arguments.
 *
 * It delegates with a null variant, which means exactly what it always meant:
 * the hold is for the product as a whole. A caller that knows about
 * combinations (the Stock Holds screen) uses the 9-argument form above.
 */
create or replace function public.repair_stock_reservation(
  p_action         text,
  p_reservation_id uuid,
  p_order_id       uuid,
  p_product_id     uuid,
  p_quantity       integer,
  p_reason         text,
  p_user_id        text,
  p_user_name      text
)
returns jsonb
language sql
security definer
set search_path = public
as $$
  select public.repair_stock_reservation(
    p_action, p_reservation_id, p_order_id, p_product_id,
    p_quantity, p_reason, p_user_id, p_user_name, null
  )
$$;

comment on function public.repair_stock_reservation(text, uuid, uuid, uuid, integer, text, text, text) is
  'Backward-compatible wrapper (Phase 25 signature) for repair_stock_reservation. Delegates with a null variant, i.e. a whole-product hold.';


-- ── 13b. grants for the redefined functions ────────────────────────────────
-- `create or replace` keeps a function's existing ACL, so these change nothing
-- for the functions that already had EXECUTE. They are listed anyway because
-- the two that are NEW (the 9-argument repair and the storefront read above)
-- must not inherit anything from `public`.
revoke all on function public.repair_stock_reservation(text, uuid, uuid, uuid, integer, text, text, text, uuid) from public, anon;
grant execute on function public.repair_stock_reservation(text, uuid, uuid, uuid, integer, text, text, text, uuid) to authenticated, service_role;
revoke all on function public.repair_stock_reservation(text, uuid, uuid, uuid, integer, text, text, text) from public, anon;
grant execute on function public.repair_stock_reservation(text, uuid, uuid, uuid, integer, text, text, text) to authenticated, service_role;

-- ── 14. health, told apart per combination ─────────────────────────────────
/**
 * The inventory summary, with the two questions separated.
 *
 * A product total cannot answer "is it in stock?" once combinations exist: 20
 * units across Gold/17 = 0, Gold/18 = 10 and Silver/17 = 10 is a product that
 * is IN stock and a size that is SOLD OUT. So the rules are:
 *
 *   · a product without variants keeps the old arithmetic exactly — tracked,
 *     stock above zero, at or under its own threshold;
 *   · a product with variants is judged by its ACTIVE combinations: out of
 *     stock when nothing sellable is left, low when some combination is at or
 *     under its own threshold (or is sold out while others remain);
 *   · `lowStock` and `outOfStock` therefore count the same kinds of things they
 *     always did — but for variant products the answer comes from the
 *     combinations, never from the rollup.
 *
 * The variant counts are returned beside them, so a screen can say "3 of 6
 * combinations are low" without a second read.
 */
create or replace function public.reports_inventory_summary()
returns jsonb
language plpgsql
stable
set search_path = public
as $$
declare
  v jsonb;
begin
  if not public.can('view_reports') then
    raise exception 'Reading reports requires the view_reports capability'
      using errcode = 'insufficient_privilege';
  end if;

  with variant_rollup as (
    select v.product_id,
           count(*)                                              as variants,
           count(*) filter (where v.active)                      as active_variants,
           coalesce(sum(v.stock_quantity) filter (where v.active), 0) as active_units,
           count(*) filter (where v.active and v.stock_quantity > 0)  as sellable,
           count(*) filter (where v.active and v.stock_quantity <= 0) as sold_out,
           count(*) filter (where v.active and v.stock_quantity > 0
                              and v.stock_quantity <= v.low_stock_level) as low
      from public.product_variants v
     group by v.product_id
  )
  select jsonb_build_object(
    'products',  count(*),
    'tracked',   count(*) filter (where p.stock_tracking_enabled),
    'units',     coalesce(sum(p.stock_quantity) filter (where p.stock_tracking_enabled), 0),
    'atCost',    coalesce(sum(p.stock_quantity * p.cost_price)
                          filter (where p.stock_tracking_enabled), 0),
    'atRetail',  coalesce(sum(p.stock_quantity * p.selling_price)
                          filter (where p.stock_tracking_enabled), 0),
    'potentialMargin',
                 coalesce(sum(p.stock_quantity * p.selling_price)
                          filter (where p.stock_tracking_enabled), 0)
               - coalesce(sum(p.stock_quantity * p.cost_price)
                          filter (where p.stock_tracking_enabled), 0),
    'outOfStock', count(*) filter (
                    where p.stock_tracking_enabled and (
                      case when p.variants_enabled
                           then coalesce(vr.sellable, 0) = 0
                           else p.stock_quantity <= 0 end)),
    'lowStock',   count(*) filter (
                    where p.stock_tracking_enabled
                      and case when p.variants_enabled
                               then coalesce(vr.sellable, 0) > 0
                                and (coalesce(vr.low, 0) > 0 or coalesce(vr.sold_out, 0) > 0)
                               else p.stock_quantity > 0
                                and p.stock_quantity <= p.low_stock_level end),
    -- Phase 43 additions: what the product-level numbers cannot say.
    'variantProducts', count(*) filter (where p.variants_enabled),
    'variants',        coalesce(sum(coalesce(vr.variants, 0)) filter (where p.variants_enabled), 0),
    'activeVariants',  coalesce(sum(coalesce(vr.active_variants, 0)) filter (where p.variants_enabled), 0),
    'lowVariants',     coalesce(sum(coalesce(vr.low, 0)) filter (where p.variants_enabled), 0),
    'soldOutVariants', coalesce(sum(coalesce(vr.sold_out, 0)) filter (where p.variants_enabled), 0)
  )
  into v
  from public.products p
  left join variant_rollup vr on vr.product_id = p.id;

  return v;
end
$$;

comment on function public.reports_inventory_summary() is
  'Stock valuation snapshot. Units and values keep their old meaning (the rollup, which equals the sum of the variants). Out-of-stock and low-stock are now VARIANT-AWARE: a product that sells by variant is judged by its active combinations, never by its total, and the low/sold-out combination counts are returned beside them.';

-- ── 15. health, valued per combination ─────────────────────────────────────
create or replace function public.reports_variant_performance(
  p_from timestamptz default null,
  p_to   timestamptz default null
)
returns jsonb
language plpgsql
stable
set search_path = public
as $$
declare
  v jsonb;
begin
  if not public.can('view_reports') then
    raise exception 'Reading reports requires the view_reports capability'
      using errcode = 'insufficient_privilege';
  end if;

  with sold as (
    select si.variant_id,
           count(*)                        as invoices,
           coalesce(sum(si.quantity), 0)   as units,
           coalesce(sum(si.line_total), 0) as revenue,
           coalesce(sum(si.quantity * coalesce(pv.cost_override, p.cost_price, 0)), 0) as cost
      from public.sale_items si
      join public.sales s on s.id = si.sale_id
      left join public.product_variants pv on pv.id = si.variant_id
      left join public.products p on p.id = si.product_id
     where s.status <> 'voided'
       and si.variant_id is not null
       and (p_from is null or s.created_at >= p_from)
       and (p_to   is null or s.created_at <= p_to)
     group by si.variant_id
  ),
  returned as (
    select ri.variant_id,
           coalesce(sum(ri.quantity), 0)   as units,
           coalesce(sum(ri.line_total), 0) as amount
      from public.return_items ri
      join public.sales_returns r on r.id = ri.return_id
     where ri.variant_id is not null
       and r.refund_status <> 'rejected'
       and (p_from is null or r.created_at >= p_from)
       and (p_to   is null or r.created_at <= p_to)
     group by ri.variant_id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'variantId',      pv.id,
           'productId',      pv.product_id,
           'productSku',     p.sku,
           'productNameEn',  p.name_en,
           'productNameAr',  p.name_ar,
           'sku',            pv.sku,
           'colorEn',        pv.color_en,
           'colorAr',        pv.color_ar,
           'size',           pv.size,
           'sizeLabel',      pv.size_label,
           'active',         pv.active,
           'invoices',       coalesce(s.invoices, 0),
           'units',          coalesce(s.units, 0),
           'revenue',        coalesce(s.revenue, 0),
           'cost',           coalesce(s.cost, 0),
           'returnedUnits',  coalesce(r.units, 0),
           'returnedAmount', coalesce(r.amount, 0),
           'stock',          case when p.stock_tracking_enabled then pv.stock_quantity else 0 end,
           'stockValue',     case when p.stock_tracking_enabled
                                  then pv.stock_quantity * coalesce(pv.cost_override, p.cost_price, 0)
                                  else 0 end
         ) order by coalesce(s.revenue, 0) desc, pv.sku), '[]'::jsonb)
    into v
    from public.product_variants pv
    join public.products p on p.id = pv.product_id
    left join sold s     on s.variant_id = pv.id
    left join returned r on r.variant_id = pv.id;

  return v;
end
$$;

comment on function public.reports_variant_performance(timestamptz, timestamptz) is
  'Per-combination units, revenue, cost and returns for a period, one row per variant whether or not it sold. A separate read on purpose: reports_product_performance keeps its existing shape (whole products, stock from the rollup), and this one answers the per-colour/per-size question. Adding them together would double count, so nothing does.';

revoke all on function public.reports_variant_performance(timestamptz, timestamptz) from public, anon;
grant execute on function public.reports_variant_performance(timestamptz, timestamptz) to authenticated, service_role;
