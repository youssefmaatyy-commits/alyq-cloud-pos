-- ═══════════════════════════════════════════════════════════════════════════
-- ALYQ Cloud POS · Migration 0043
-- Phase 43 — Product variants: colours, numeric sizes and exact-variant stock
--
-- WHAT WAS WRONG
--   One product was one SKU was one stock figure. A ring sold in three sizes and
--   two colours was six physical things the shop could not tell apart: the till
--   could sell the last of a size that was not on the shelf (the product's other
--   sizes authorised it), the storefront could not show that 18 was sold out,
--   and a return put its units back on the product rather than on the size the
--   customer actually brought back.
--
-- WHAT THIS MIGRATION ADDS
--   `product_variants` — one row per exact colour/size combination, carrying its
--   own SKU, barcode, stock, threshold, price override, cost override and image.
--   `products.variants_enabled` turns the behaviour on per product, so every
--   legacy product keeps today's path statement for statement.
--
-- THE ONE DOCUMENTED SOURCE OF TRUTH
--   Variants enabled  → `product_variants.stock_quantity` is authoritative.
--                       `products.stock_quantity` is a ROLLUP for the reports,
--                       the dashboard and the compatibility readers, written by
--                       exactly one trigger (`product_variants_sync_product_stock`)
--                       and frozen against every other writer
--                       (`products_block_direct_stock_write`). No reader ever
--                       sums the two, so stock cannot be double counted.
--   Variants disabled → today's behaviour, unchanged, byte for byte.
--
-- EXACT-VARIANT STOCK IS NON-NEGOTIABLE
--   `pos_complete_sale`, `place_online_order`, `pos_process_return`,
--   `pos_settle_refund` and `resolve_online_order` all read the exact variant,
--   lock it `for update` BEFORE the availability check, and hold that lock to the
--   end of the transaction. Gold/17 stock 2 with Silver/17 stock 2 and Gold/18
--   stock 20 is still "2 left in Gold/17": the other rows are never consulted.
--
-- COLOUR IDENTITY IS NOT THE DISPLAY LABEL
--   A combination's identity is `(product_id, color_key, size)`, where
--   `color_key` is captured once, from the first label, normalised
--   (trim / collapse / lower) and never rewritten by a later rename. Renaming
--   "Gold" to "Yellow Gold" — in either language — leaves the identity, the
--   history and the uniqueness rule untouched. History rows freeze the sold
--   COLOUR AND SIZE SNAPSHOTS as well as the variant id, so an old invoice still
--   reads "Gold / 17" after any rename.
--
-- NUMERIC SIZES
--   `size numeric(8,2)` sorts 16 → 16.5 → 17 → 17.5 numerically everywhere
--   (SQL `order by size`, client `Number(a) - Number(b)`). A textual size is
--   supported only as `size_label` when `size` is null ("One Size"), so it can
--   never break the ordering or the uniqueness rule.
--
-- ENABLING AND DISABLING (never a silent conversion in either direction)
--   `enable_product_variants()` requires the opening quantities to SUM EXACTLY
--   to the product's existing stock, writes one honest `adjustment_in` movement
--   per variant so the ledger explains where the units went, and only then flips
--   the flag. `disable_product_variants()` refuses outright once any of the five
--   history tables references a variant of the product — variant history stays
--   variant-aware forever — and otherwise requires the consolidated figure to
--   equal the variant total before it collapses anything.
--
-- PERMISSIONS
--   No new capability: catalogue verbs for variant management (`add_product`,
--   `edit_product`, `delete_product`), `adjust_stock` for variant stock,
--   `change_price` / `change_cost` for the overrides — the same words the
--   product-level paths already use. The rollup runs in a SECURITY DEFINER
--   trigger so an inventory seat that holds `adjust_stock` WITHOUT `edit_product`
--   (a combination only a custom role can express) still moves variant stock:
--   the rollup writes `products` as its owner, and the guard recognises it by a
--   transaction-local marker, never by widening anybody's capabilities.
--
-- BACKWARD COMPATIBILITY
--   Nothing is dropped or rewritten. Every added column is nullable, every new
--   table starts empty except the code registry backfilled from `products`, and
--   `repair_stock_reservation` keeps its old signature as a wrapper. Old
--   invoices, orders, movements and reservations read exactly as they did.
--
-- Idempotent throughout (create-if-not-exists / create-or-replace / on-conflict).
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 0. the flag, on the product ──────────────────────────────────────────────
alter table public.products
  add column if not exists variants_enabled boolean not null default false;

comment on column public.products.variants_enabled is
  'Sell this product by variant (colour/size). When true, product_variants.stock_quantity is the source of truth and products.stock_quantity is the rollup the trigger keeps; when false, the product-level stock behaves exactly as it always has.';

-- ── 1. helpers ───────────────────────────────────────────────────────────────

/** A place/colour name compared the way a person would: trimmed, folded, spaced. */
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

/** "Gold / 17", "Gold", "17", "One Size" — the readable half of a variant. */
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
  select concat_ws(
    ' / ',
    nullif(btrim(coalesce(nullif(btrim(coalesce(p_color_en, '')), ''), coalesce(p_color_ar, ''))), ''),
    case
      when p_size is not null then public.numeric_label(p_size)
      else nullif(btrim(coalesce(p_size_label, '')), '')
    end
  )
$$;

comment on function public.variant_label(text, text, numeric, text) is
  'Readable label for a variant, in the shop''s English copy with the Arabic as fallback. Used in server messages; the storefront and the POS format their own, translated, from the same parts.';

/**
 * A uuid out of whatever the caller sent — or null.
 *
 * A forged / malformed `variant_id` used to reach `::uuid` and abort the whole
 * call with 22P02 before any rule could explain itself. This turns it into a
 * plain "no variant supplied", which the callers refuse with their own wording.
 */
create or replace function public.variant_id_of(p_raw text)
returns uuid
language sql
immutable
as $$
  select case
    when coalesce(btrim(p_raw), '') ~
         '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    then btrim(p_raw)::uuid
    else null
  end
$$;

-- ── 2. the variant table ─────────────────────────────────────────────────────
create table if not exists public.product_variants (
  id              uuid primary key default gen_random_uuid(),
  product_id      uuid not null references public.products (id) on delete cascade,

  sku             text not null,
  barcode         text,

  -- Identity: `color_key` is stable, the labels are the shop's copy.
  color_key       text not null default '',
  color_ar        text,
  color_en        text,
  color_hex       text,

  -- The numeric size model. `size_label` is the textual fallback, only used
  -- when `size` is null.
  size            numeric(8, 2),
  size_label      text,

  image_url       text,
  price_override  numeric(14, 2),
  cost_override   numeric(14, 2),

  stock_quantity  integer not null default 0,
  low_stock_level integer not null default 0,
  active          boolean not null default true,
  sort_order      integer not null default 0,

  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  constraint product_variants_sku_format
    check (sku ~ '^[A-Za-z0-9][A-Za-z0-9 _-]*$' and char_length(sku) <= 40),
  constraint product_variants_barcode_length
    check (char_length(barcode) <= 64),
  -- A variant has to be distinguishable from its siblings: a colour, or a size.
  constraint product_variants_dimension_present
    check (btrim(color_key) <> '' or size is not null or btrim(coalesce(size_label, '')) <> ''),
  constraint product_variants_size_positive
    check (size is null or size > 0),
  constraint product_variants_size_label_shape
    check (size_label is null or char_length(btrim(size_label)) between 1 and 24),
  constraint product_variants_stock_nonnegative
    check (stock_quantity >= 0),
  constraint product_variants_low_stock_nonnegative
    check (low_stock_level >= 0),
  constraint product_variants_price_nonnegative
    check (price_override is null or price_override >= 0),
  constraint product_variants_cost_nonnegative
    check (cost_override is null or cost_override >= 0),
  constraint product_variants_color_hex_shape
    check (color_hex is null or color_hex ~ '^#[0-9a-fA-F]{6}$'),
  constraint product_variants_image_shape
    check (image_url is null or char_length(image_url) <= 2048)
);

comment on table public.product_variants is
  'One row per exact colour/size combination of a product. When products.variants_enabled is true this table is the stock authority: each row is an independently counted physical thing, priced optionally by override, and snapshotted onto sale/order/return lines so history survives a rename or an archive.';
comment on column public.product_variants.color_key is
  'Stable colour identity (variant_color_key of the first label). Renaming color_en/color_ar never changes it, so (product_id, color_key, size) keeps meaning the same combination.';
comment on column public.product_variants.size is
  'The numeric size — the primary model (16, 16.5, 17…). Sorted numerically everywhere; unique per product+colour.';
comment on column public.product_variants.size_label is
  'Textual size, only ever used when `size` is null (e.g. "One Size"). It can never collide with the numeric ordering.';
comment on column public.product_variants.stock_quantity is
  'On-hand units of THIS exact combination. Authoritative when products.variants_enabled; never derived from, and never shared with, another colour or size.';
comment on column public.product_variants.price_override is
  'Optional selling price; null means the product''s own selling_price. Read server-side only — a client-sent price is never trusted.';
comment on column public.product_variants.cost_override is
  'Optional unit cost; null means the product''s own cost_price.';

-- Uniqueness: one row per exact combination. `coalesce(size, -1)` because a
-- unique index treats NULLs as distinct, and -1 can never be a real size
-- (`product_variants_size_positive`). The same trick covers `size_label`.
create unique index if not exists product_variants_combination_unique
  on public.product_variants (
    product_id,
    color_key,
    coalesce(size, (-1)::numeric),
    coalesce(size_label, '')
  );

create unique index if not exists product_variants_sku_unique
  on public.product_variants (lower(btrim(sku)));

create unique index if not exists product_variants_barcode_unique
  on public.product_variants (btrim(barcode))
  where barcode is not null and btrim(barcode) <> '';

create index if not exists product_variants_product_idx
  on public.product_variants (product_id, sort_order, size);

create index if not exists product_variants_active_idx
  on public.product_variants (product_id) where active;

drop trigger if exists product_variants_set_updated_at on public.product_variants;
create trigger product_variants_set_updated_at
  before update on public.product_variants
  for each row execute function public.set_updated_at();

-- ── 3. the shared code registry ──────────────────────────────────────────────
-- One place that answers "is this SKU or barcode already taken?" across products
-- AND variants, so a scan can never resolve to two rows and the till can never
-- silently add the wrong size. Kept in sync by triggers on both tables; the
-- application does not write it.
create table if not exists public.catalogue_codes (
  kind       text not null check (kind in ('sku', 'barcode')),
  code_key   text not null,
  code       text not null,
  product_id uuid not null references public.products (id) on delete cascade,
  variant_id uuid references public.product_variants (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (kind, code_key)
);

comment on table public.catalogue_codes is
  'Cross-table uniqueness for SKUs and barcodes: one code, one row, whether it belongs to a product or to one of its variants. Maintained by triggers on products and product_variants; not writable by the application.';

create index if not exists catalogue_codes_variant_idx on public.catalogue_codes (variant_id);
create index if not exists catalogue_codes_product_idx on public.catalogue_codes (product_id);

-- Backfill from the catalogue as it stands. `on conflict do nothing` cannot hide
-- a real collision here: products_sku_unique / products_barcode_unique already
-- guarantee one row per code across products.
insert into public.catalogue_codes (kind, code_key, code, product_id, variant_id)
select 'sku', lower(btrim(p.sku)), btrim(p.sku), p.id, null
  from public.products p
 where btrim(coalesce(p.sku, '')) <> ''
on conflict (kind, code_key) do nothing;

insert into public.catalogue_codes (kind, code_key, code, product_id, variant_id)
select 'barcode', lower(btrim(p.barcode)), btrim(p.barcode), p.id, null
  from public.products p
 where p.barcode is not null and btrim(p.barcode) <> ''
on conflict (kind, code_key) do nothing;

/** Keep the registry in step with a product row. */
create or replace function public.catalogue_codes_sync_product()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_taken text;
begin
  if tg_op = 'DELETE' then
    delete from public.catalogue_codes where product_id = old.id and variant_id is null;
    return old;
  end if;

  delete from public.catalogue_codes where product_id = new.id and variant_id is null;

  if btrim(coalesce(new.sku, '')) <> '' then
    select c.code into v_taken from public.catalogue_codes c
     where c.kind = 'sku' and c.code_key = lower(btrim(new.sku));
    if v_taken is not null then
      raise exception 'SKU % is already used by another product or variant', btrim(new.sku)
        using errcode = 'unique_violation';
    end if;
    insert into public.catalogue_codes (kind, code_key, code, product_id)
    values ('sku', lower(btrim(new.sku)), btrim(new.sku), new.id);
  end if;

  if btrim(coalesce(new.barcode, '')) <> '' then
    select c.code into v_taken from public.catalogue_codes c
     where c.kind = 'barcode' and c.code_key = lower(btrim(new.barcode));
    if v_taken is not null then
      raise exception 'Barcode % is already used by another product or variant', btrim(new.barcode)
        using errcode = 'unique_violation';
    end if;
    insert into public.catalogue_codes (kind, code_key, code, product_id)
    values ('barcode', lower(btrim(new.barcode)), btrim(new.barcode), new.id);
  end if;

  return new;
end;
$$;

/** Keep the registry in step with a variant row. */
create or replace function public.catalogue_codes_sync_variant()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_taken text;
begin
  if tg_op = 'DELETE' then
    delete from public.catalogue_codes where variant_id = old.id;
    return old;
  end if;

  delete from public.catalogue_codes where variant_id = new.id;

  if btrim(coalesce(new.sku, '')) <> '' then
    select c.code into v_taken from public.catalogue_codes c
     where c.kind = 'sku' and c.code_key = lower(btrim(new.sku));
    if v_taken is not null then
      raise exception 'SKU % is already used by another product or variant', btrim(new.sku)
        using errcode = 'unique_violation';
    end if;
    insert into public.catalogue_codes (kind, code_key, code, product_id, variant_id)
    values ('sku', lower(btrim(new.sku)), btrim(new.sku), new.product_id, new.id);
  end if;

  if btrim(coalesce(new.barcode, '')) <> '' then
    select c.code into v_taken from public.catalogue_codes c
     where c.kind = 'barcode' and c.code_key = lower(btrim(new.barcode));
    if v_taken is not null then
      raise exception 'Barcode % is already used by another product or variant', btrim(new.barcode)
        using errcode = 'unique_violation';
    end if;
    insert into public.catalogue_codes (kind, code_key, code, product_id, variant_id)
    values ('barcode', lower(btrim(new.barcode)), btrim(new.barcode), new.product_id, new.id);
  end if;

  return new;
end;
$$;

/** Fill `color_key` from the label when the caller did not supply one. */
create or replace function public.product_variants_fill_identity()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  -- On insert: derive the stable key from the first label given.
  -- On update: only ever fill a blank. A rename must NOT move the identity, so
  -- this trigger deliberately leaves a non-blank key exactly as it is.
  if btrim(coalesce(new.color_key, '')) = '' then
    new.color_key := public.variant_color_key(coalesce(new.color_en, new.color_ar, ''));
  else
    new.color_key := public.variant_color_key(new.color_key);
  end if;
  return new;
end;
$$;

drop trigger if exists product_variants_fill_identity on public.product_variants;
create trigger product_variants_fill_identity
  before insert or update on public.product_variants
  for each row execute function public.product_variants_fill_identity();

drop trigger if exists products_catalogue_codes_sync on public.products;
create trigger products_catalogue_codes_sync
  after insert or update of sku, barcode or delete on public.products
  for each row execute function public.catalogue_codes_sync_product();

drop trigger if exists product_variants_catalogue_codes_sync on public.product_variants;
create trigger product_variants_catalogue_codes_sync
  after insert or update of sku, barcode, product_id or delete on public.product_variants
  for each row execute function public.catalogue_codes_sync_variant();

-- ── 4. history columns (nullable: legacy rows keep reading exactly as before) ─
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

create index if not exists stock_reservations_variant_idx
  on public.stock_reservations (variant_id)
  where status = 'reserved';

-- ── 5. the rollup, and the guard that keeps it the only writer ───────────────

/**
 * products.stock_quantity := Σ variant stock, for a variant product.
 *
 * SECURITY DEFINER — and this is the point of correction 6: the update lands on
 * `products` as the FUNCTION OWNER, so it is not subject to the products RLS
 * policies, which ask for `edit_product`. An inventory seat holding
 * `adjust_stock` but not `edit_product` (expressible only as a custom role) can
 * therefore move a variant and still see the rollup follow. Nothing is granted
 * to that seat to make this work.
 */
create or replace function public.product_variants_sync_product_stock()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_product_id uuid := coalesce(new.product_id, old.product_id);
  v_total      integer;
begin
  select coalesce(sum(stock_quantity), 0)::integer into v_total
    from public.product_variants
   where product_id = v_product_id;

  -- The marker names the ONE product this transaction may write directly, so an
  -- unrelated update to another variant product's rollup in the same
  -- transaction is still refused by the guard below.
  perform set_config('alyq.variant_rollup_product', v_product_id::text, true);

  update public.products
     set stock_quantity = v_total,
         updated_at = now()
   where id = v_product_id
     and stock_quantity is distinct from v_total;

  return null;
end;
$$;

drop trigger if exists product_variants_sync_product_stock on public.product_variants;
create trigger product_variants_sync_product_stock
  after insert or update of stock_quantity or delete on public.product_variants
  for each row execute function public.product_variants_sync_product_stock();

/**
 * A variant product's rollup is not written by hand.
 *
 * Without this, the next well-meaning `update products set stock_quantity = …`
 * (the inventory screen, a recount, an import) would overwrite the sum of the
 * variants and the shop would be counting two different numbers again. The
 * rollup trigger above is recognised by the transaction-local marker.
 */
create or replace function public.products_block_direct_stock_write()
returns trigger
language plpgsql
as $$
begin
  if new.variants_enabled
     and new.stock_quantity is distinct from old.stock_quantity
     and coalesce(current_setting('alyq.variant_rollup_product', true), '') <> new.id::text then
    raise exception 'Product % sells by variant — adjust the variant''s stock instead', new.sku
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists products_block_direct_stock_write on public.products;
create trigger products_block_direct_stock_write
  before update of stock_quantity on public.products
  for each row execute function public.products_block_direct_stock_write();

/** Price overrides answer to the same two capabilities the product prices do. */
create or replace function public.enforce_variant_price_authority()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(nullif(current_setting('role', true), ''), 'postgres') <> 'authenticated' then
    return new;
  end if;

  if new.price_override is distinct from old.price_override
     and not public.can('change_price') then
    raise exception 'Changing a selling price requires the change_price capability'
      using errcode = 'insufficient_privilege';
  end if;

  if new.cost_override is distinct from old.cost_override
     and not public.can('change_cost') then
    raise exception 'Changing a cost price requires the change_cost capability'
      using errcode = 'insufficient_privilege';
  end if;

  return new;
end;
$$;

drop trigger if exists product_variants_enforce_price_authority on public.product_variants;
create trigger product_variants_enforce_price_authority
  before update on public.product_variants
  for each row execute function public.enforce_variant_price_authority();

-- ── 6. what is held, per exact variant ───────────────────────────────────────
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
  'Units of ONE exact variant held by pending online orders. Available to sell that variant = its stock_quantity − this.';

create or replace function public.variant_available(p_variant_id uuid)
returns integer
language sql
stable
as $$
  select greatest(
    coalesce((select v.stock_quantity from public.product_variants v where v.id = p_variant_id), 0)
      - public.reserved_quantity_variant(p_variant_id),
    0
  )::integer
$$;

comment on function public.variant_available(uuid) is
  'What a customer may still take of this exact variant right now: its own stock less the holds on it. Never reads another colour, another size, or the product rollup.';

-- ── 7. audit vocabulary ──────────────────────────────────────────────────────
-- Seven actions over the existing `product` entity. The variant itself is named
-- in `details` (variant_id, colour, size) so the trail answers "who added /
-- renamed / archived that size?" without a second entity to keep in step.
insert into public.audit_actions (action, entity) values
  ('product.variant_created',    'product'),
  ('product.variant_updated',    'product'),
  ('product.variant_archived',   'product'),
  ('product.variant_reactivated','product'),
  ('product.variant_deleted',    'product'),
  ('product.variants_enabled',   'product'),
  ('product.variants_disabled',  'product')
on conflict (action) do nothing;


-- ── 8. enabling variants: an explicit, atomic conversion ─────────────────────

/**
 * Switch a product to variant stock, distributing what is already on the shelf.
 *
 * `p_opening` maps variant id → opening units. The sum MUST equal the product's
 * existing stock: the conversion is never allowed to create or destroy a unit,
 * and it never defaults the existing stock onto one variant. Every unit that
 * moves is written to the stock ledger as its own `adjustment_in`, so the trail
 * explains the conversion to whoever reads the movements later.
 */
create or replace function public.enable_product_variants(
  p_product_id uuid,
  p_opening    jsonb,
  p_user_id    text,
  p_user_name  text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_product  public.products%rowtype;
  v_variant  public.product_variants%rowtype;
  v_opening  jsonb := coalesce(p_opening, '{}'::jsonb);
  v_count    integer := 0;
  v_total    integer := 0;
  v_qty      integer;
  v_actor    text := coalesce(auth.uid()::text, p_user_id, '');
  v_name     text;
  v_details  jsonb := '{}'::jsonb;
begin
  if not public.can('edit_product') then
    raise exception 'Selling a product by variant requires the edit_product capability'
      using errcode = 'insufficient_privilege';
  end if;

  if jsonb_typeof(v_opening) <> 'object' then
    raise exception 'The opening quantities must be an object of variant id → units'
      using errcode = 'check_violation';
  end if;

  select * into v_product from public.products where id = p_product_id for update;
  if not found then
    raise exception 'Product % not found', p_product_id using errcode = 'foreign_key_violation';
  end if;

  -- Idempotent: a retried click on an already-variant product is answered, not
  -- refused, and writes no second conversion to the trail.
  if v_product.variants_enabled then
    select coalesce(sum(stock_quantity), 0)::integer, count(*)
      into v_total, v_count
      from public.product_variants where product_id = v_product.id;
    return jsonb_build_object(
      'product_id', v_product.id, 'variants_enabled', true,
      'units', v_total, 'variants', v_count, 'changed', false
    );
  end if;

  select count(*) into v_count from public.product_variants where product_id = v_product.id;
  if v_count = 0 then
    raise exception 'Add at least one variant before switching % to variant stock', v_product.sku
      using errcode = 'check_violation';
  end if;

  -- Every key has to be a variant of THIS product.
  if exists (
    select 1 from jsonb_object_keys(v_opening) as k
     where not exists (
       select 1 from public.product_variants v
        where v.id = public.variant_id_of(k) and v.product_id = v_product.id
     )
  ) then
    raise exception 'The opening quantities name a variant that does not belong to %', v_product.sku
      using errcode = 'check_violation';
  end if;

  -- Sum the requested distribution, refusing anything that is not a whole,
  -- non-negative number of units.
  for v_variant in select * from public.product_variants where product_id = v_product.id order by id
  loop
    v_qty := coalesce((v_opening->>v_variant.id::text)::integer, 0);
    if v_qty is null or v_qty < 0 then
      raise exception 'The opening quantity for % must be a whole number of units',
        coalesce(public.variant_label(v_variant.color_en, v_variant.color_ar, v_variant.size, v_variant.size_label), v_variant.sku)
        using errcode = 'check_violation';
    end if;
    v_total := v_total + v_qty;
    v_details := v_details || jsonb_build_object(
      v_variant.sku, jsonb_build_object('qty', v_qty, 'variant_id', v_variant.id)
    );
  end loop;

  -- THE invariant of the conversion.
  if v_total <> v_product.stock_quantity then
    raise exception 'The opening quantities add up to %, but % holds % — the conversion must neither create nor destroy stock',
      v_total, v_product.sku, v_product.stock_quantity
      using errcode = 'check_violation';
  end if;

  -- Apply, unit for unit, and explain each one in the ledger.
  for v_variant in select * from public.product_variants where product_id = v_product.id order by id
  loop
    v_qty := coalesce((v_opening->>v_variant.id::text)::integer, 0);

    if v_qty > v_variant.stock_quantity then
      insert into public.stock_movements (
        product_id, variant_id, variant_color_ar, variant_color_en, variant_size,
        delta, quantity_before, quantity_after, type, reason, notes, user_id, user_name
      ) values (
        v_product.id, v_variant.id, v_variant.color_ar, v_variant.color_en, v_variant.size,
        v_qty - v_variant.stock_quantity, v_variant.stock_quantity, v_qty,
        'adjustment_in', 'recount',
        'Variant opening balance — ' || v_product.sku || ' switched to variant stock',
        v_actor, coalesce(nullif(btrim(coalesce(p_user_name, '')), ''), 'System')
      );
    elsif v_qty < v_variant.stock_quantity then
      insert into public.stock_movements (
        product_id, variant_id, variant_color_ar, variant_color_en, variant_size,
        delta, quantity_before, quantity_after, type, reason, notes, user_id, user_name
      ) values (
        v_product.id, v_variant.id, v_variant.color_ar, v_variant.color_en, v_variant.size,
        v_variant.stock_quantity - v_qty, v_variant.stock_quantity, v_qty,
        'adjustment_out', 'recount',
        'Variant opening balance — ' || v_product.sku || ' switched to variant stock',
        v_actor, coalesce(nullif(btrim(coalesce(p_user_name, '')), ''), 'System')
      );
    end if;

    if v_qty <> v_variant.stock_quantity then
      update public.product_variants
         set stock_quantity = v_qty, updated_at = now()
       where id = v_variant.id;
    end if;
  end loop;

  update public.products
     set variants_enabled = true, updated_at = now()
   where id = v_product.id;

  select p.name into v_name from public.profiles p where p.id = auth.uid();

  insert into public.audit_log (action, entity, entity_id, entity_label, details, user_id, user_name)
  values (
    'product.variants_enabled', 'product', v_product.id::text, v_product.sku,
    jsonb_build_object(
      'product', v_product.name_en,
      'sku',     v_product.sku,
      'units',   v_total,
      'variants', v_count,
      'opening', v_details
    ),
    coalesce(v_actor, 'system'),
    coalesce(v_name, nullif(btrim(coalesce(p_user_name, '')), ''), 'Unknown')
  );

  return jsonb_build_object(
    'product_id', v_product.id, 'variants_enabled', true,
    'units', v_total, 'variants', v_count, 'changed', true
  );
end;
$$;

comment on function public.enable_product_variants(uuid, jsonb, text, text) is
  'Atomically switch a product to variant stock. The opening quantities must sum exactly to the product''s existing stock — no unit is created, destroyed or defaulted onto one variant — and each moved unit is written to the stock ledger. Requires edit_product.';

/**
 * Switch back to a single stock figure — only when nothing historical depends on
 * the variants, and only with an explicit consolidated figure.
 *
 * The five history tables are checked first: once a variant has been sold,
 * returned, moved, ordered or held, the product's history is variant-aware
 * forever and the flag cannot be turned off at all. That is deliberate — the
 * alternative is an invoice whose lines mean something different from the
 * catalogue's current shape.
 */
create or replace function public.disable_product_variants(
  p_product_id  uuid,
  p_consolidate numeric,
  p_user_id     text,
  p_user_name   text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_product   public.products%rowtype;
  v_variant   public.product_variants%rowtype;
  v_units     integer := 0;
  v_count     integer := 0;
  v_refs      bigint := 0;
  v_held      integer := 0;
  v_actor     text := coalesce(auth.uid()::text, p_user_id, '');
  v_name      text;
begin
  if not public.can('edit_product') then
    raise exception 'Changing how a product tracks stock requires the edit_product capability'
      using errcode = 'insufficient_privilege';
  end if;

  select * into v_product from public.products where id = p_product_id for update;
  if not found then
    raise exception 'Product % not found', p_product_id using errcode = 'foreign_key_violation';
  end if;

  if not v_product.variants_enabled then
    return jsonb_build_object(
      'product_id', v_product.id, 'variants_enabled', false,
      'units', v_product.stock_quantity, 'changed', false
    );
  end if;

  -- History first: any reference at all freezes the product's shape.
  select (select count(*) from public.sale_items si          where si.variant_id = v.id)
       + (select count(*) from public.return_items ri        where ri.variant_id = v.id)
       + (select count(*) from public.stock_movements sm     where sm.variant_id = v.id)
       + (select count(*) from public.online_order_items oi  where oi.variant_id = v.id)
       + (select count(*) from public.stock_reservations sr  where sr.variant_id = v.id)
    into v_refs
    from public.product_variants v
   where v.product_id = v_product.id;

  if coalesce(v_refs, 0) > 0 then
    raise exception
      'Product % has variant history (% reference(s)) and cannot go back to a single stock figure; archive the variants instead',
      v_product.sku, v_refs
      using errcode = 'restrict_violation';
  end if;

  select coalesce(sum(stock_quantity), 0)::integer, count(*)
    into v_units, v_count
    from public.product_variants where product_id = v_product.id;

  -- Nothing may be held by a pending order while the shape changes.
  select coalesce(sum(sr.quantity), 0)::integer into v_held
    from public.stock_reservations sr
    join public.product_variants v on v.id = sr.variant_id
   where v.product_id = v_product.id and sr.status = 'reserved';

  if v_held > 0 then
    raise exception 'A pending order is still holding % unit(s) of %; resolve it first', v_held, v_product.sku
      using errcode = 'check_violation';
  end if;

  -- THE invariant of the reverse conversion, mirroring the forward one.
  if coalesce(p_consolidate, -1) <> v_units then
    raise exception 'The consolidated figure must be % — the units on the variants — but % was given',
      v_units, coalesce(p_consolidate, -1)
      using errcode = 'check_violation';
  end if;

  delete from public.product_variants where product_id = v_product.id;

  update public.products
     set variants_enabled = false,
         stock_quantity  = v_units,
         updated_at      = now()
   where id = v_product.id;

  select p.name into v_name from public.profiles p where p.id = auth.uid();

  insert into public.audit_log (action, entity, entity_id, entity_label, details, user_id, user_name)
  values (
    'product.variants_disabled', 'product', v_product.id::text, v_product.sku,
    jsonb_build_object(
      'product', v_product.name_en,
      'sku',     v_product.sku,
      'units',   v_units,
      'variants', v_count
    ),
    coalesce(v_actor, 'system'),
    coalesce(v_name, nullif(btrim(coalesce(p_user_name, '')), ''), 'Unknown')
  );

  return jsonb_build_object(
    'product_id', v_product.id, 'variants_enabled', false,
    'units', v_units, 'variants', v_count, 'changed', true
  );
end;
$$;

comment on function public.disable_product_variants(uuid, numeric, text, text) is
  'Collapse a variant product back to one stock figure — refused with restrict_violation as soon as any of the five history tables references any of its variants, refused while a pending order still holds units, and refused unless the consolidated figure equals the variant total. Requires edit_product.';

-- ── 9. archiving and deleting a single variant ───────────────────────────────

create or replace function public.set_variant_active(p_variant_id uuid, p_active boolean)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_variant public.product_variants%rowtype;
  v_product public.products%rowtype;
  v_actor   text := auth.uid()::text;
  v_name    text;
begin
  if not public.can('edit_product') then
    raise exception 'Changing a variant''s active state requires the edit_product capability'
      using errcode = 'insufficient_privilege';
  end if;

  select * into v_variant from public.product_variants where id = p_variant_id for update;
  if not found then
    raise exception 'Variant % not found', p_variant_id using errcode = 'foreign_key_violation';
  end if;
  select * into v_product from public.products where id = v_variant.product_id;

  if v_variant.active is not distinct from p_active then
    return jsonb_build_object('variant_id', v_variant.id, 'active', v_variant.active, 'changed', false);
  end if;

  update public.product_variants
     set active = p_active, updated_at = now()
   where id = p_variant_id
  returning * into v_variant;

  select p.name into v_name from public.profiles p where p.id = auth.uid();

  insert into public.audit_log (action, entity, entity_id, entity_label, details, user_id, user_name)
  values (
    case when p_active then 'product.variant_reactivated' else 'product.variant_archived' end,
    'product', v_product.id::text, v_product.sku,
    jsonb_build_object(
      'product',    v_product.name_en,
      'variant_id', v_variant.id,
      'sku',        v_variant.sku,
      'color',      coalesce(v_variant.color_en, v_variant.color_ar),
      'size',       v_variant.size,
      'size_label', v_variant.size_label,
      'previous',   not p_active,
      'next',       p_active
    ),
    coalesce(v_actor, 'system'),
    coalesce(v_name, v_actor, 'Unknown')
  );

  return jsonb_build_object('variant_id', v_variant.id, 'active', v_variant.active, 'changed', true);
end;
$$;

comment on function public.set_variant_active(uuid, boolean) is
  'Archive (false) or reactivate (true) one variant. Requires edit_product; idempotent; writes product.variant_archived / product.variant_reactivated. An archived variant leaves the POS, the storefront and new orders, while its history and any return against it stay readable.';

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
end;
$$;

comment on function public.variant_reference_counts(uuid) is
  'How much history references each variant. total > 0 means it may only be archived, never deleted. delete_product holders only.';

create or replace function public.delete_variant(p_variant_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_variant public.product_variants%rowtype;
  v_product public.products%rowtype;
  v_refs    record;
  v_actor   text := auth.uid()::text;
  v_name    text;
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

  -- A product that sells by variant must keep at least one: deleting the last
  -- one would leave a product nobody can buy and no way to express its stock.
  if v_product.variants_enabled
     and (select count(*) from public.product_variants where product_id = v_variant.product_id) <= 1 then
    raise exception 'Product % sells by variant and must keep at least one variant; add another before deleting %',
      v_product.sku, v_variant.sku
      using errcode = 'restrict_violation';
  end if;

  select * into v_refs from public.variant_reference_counts(p_variant_id);
  if coalesce(v_refs.total, 0) > 0 then
    raise exception
      'Variant % has history (sale_items %, return_items %, stock_movements %, online_order_items %, stock_reservations %) and cannot be deleted; archive it instead',
      v_variant.sku, v_refs.sale_items, v_refs.return_items, v_refs.stock_movements,
      v_refs.online_order_items, v_refs.stock_reservations
      using errcode = 'restrict_violation';
  end if;

  select p.name into v_name from public.profiles p where p.id = auth.uid();

  insert into public.audit_log (action, entity, entity_id, entity_label, details, user_id, user_name)
  values (
    'product.variant_deleted', 'product', v_product.id::text, v_product.sku,
    jsonb_build_object(
      'product',    v_product.name_en,
      'variant_id', v_variant.id,
      'sku',        v_variant.sku,
      'color',      coalesce(v_variant.color_en, v_variant.color_ar),
      'size',       v_variant.size,
      'size_label', v_variant.size_label,
      'stock',      v_variant.stock_quantity
    ),
    coalesce(v_actor, 'system'),
    coalesce(v_name, v_actor, 'Unknown')
  );

  delete from public.product_variants where id = p_variant_id;

  return jsonb_build_object('deleted', true, 'variant_id', v_variant.id, 'sku', v_variant.sku);
end;
$$;

comment on function public.delete_variant(uuid) is
  'Permanently delete a variant ONLY when no history references it (refused with restrict_violation otherwise — archive those). Requires delete_product; writes product.variant_deleted before the delete.';

-- ── 10. RLS + grants ─────────────────────────────────────────────────────────
alter table public.product_variants enable row level security;
alter table public.catalogue_codes  enable row level security;

drop policy if exists "product_variants_select_authenticated" on public.product_variants;
create policy "product_variants_select_authenticated"
  on public.product_variants for select to authenticated using (true);

-- Catalogue work: whoever may add a product may add its variants. Insert stays
-- separate from update because a variant is normally created with its stock as
-- part of the product form.
drop policy if exists "product_variants_insert_catalogue" on public.product_variants;
create policy "product_variants_insert_catalogue"
  on public.product_variants for insert to authenticated
  with check (public.can('add_product') or public.can('edit_product'));

-- The point of correction 6: `adjust_stock` alone is enough to move a variant's
-- stock, because that is the capability the inventory screen asks for — an
-- inventory seat does not need `edit_product` to count a shelf. Price overrides
-- are gated separately, by the price-authority trigger above.
drop policy if exists "product_variants_update_catalogue" on public.product_variants;
create policy "product_variants_update_catalogue"
  on public.product_variants for update to authenticated
  using (public.can('adjust_stock') or public.can('edit_product'))
  with check (public.can('adjust_stock') or public.can('edit_product'));

drop policy if exists "product_variants_delete_catalogue" on public.product_variants;
create policy "product_variants_delete_catalogue"
  on public.product_variants for delete to authenticated
  using (public.can('delete_product'));

drop policy if exists "catalogue_codes_select_authenticated" on public.catalogue_codes;
create policy "catalogue_codes_select_authenticated"
  on public.catalogue_codes for select to authenticated using (true);

grant select, insert, update, delete on public.product_variants to authenticated;
-- Read-only to the application: the triggers that keep it honest run as the
-- owner, so no client can forge an entry in the uniqueness registry.
grant select on public.catalogue_codes to authenticated;
revoke insert, update, delete, truncate, references, trigger
  on public.catalogue_codes from anon, authenticated;

revoke execute on function public.enable_product_variants(uuid, jsonb, text, text) from public, anon;
revoke execute on function public.disable_product_variants(uuid, numeric, text, text) from public, anon;
revoke execute on function public.set_variant_active(uuid, boolean) from public, anon;
revoke execute on function public.delete_variant(uuid) from public, anon;
revoke execute on function public.variant_reference_counts(uuid) from public, anon;

grant execute on function public.enable_product_variants(uuid, jsonb, text, text) to authenticated;
grant execute on function public.disable_product_variants(uuid, numeric, text, text) to authenticated;
grant execute on function public.set_variant_active(uuid, boolean) to authenticated;
grant execute on function public.delete_variant(uuid) to authenticated;
grant execute on function public.variant_reference_counts(uuid) to authenticated;

-- ── 11. the storefront's view of a variant product ───────────────────────────

/**
 * What a shopper may buy of each exact variant.
 *
 * Deliberately the same policy as `storefront_catalogue()`: stock is already
 * public (the shop shows "only 1 left"), while cost, the low-stock threshold and
 * the staff columns are not. `available` already subtracts the holds, so the
 * storefront's "sold out" matches the server's refusal.
 */
drop function if exists public.storefront_product_variants();

create or replace function public.storefront_product_variants()
returns table (
  id             uuid,
  product_id     uuid,
  sku            text,
  barcode        text,
  color_ar       text,
  color_en       text,
  color_hex      text,
  size           numeric,
  size_label     text,
  image_url      text,
  price          numeric,
  stock_quantity integer,
  available      integer,
  active         boolean,
  sort_order     integer
)
language sql
stable
security definer
set search_path = public
as $$
  select v.id,
         v.product_id,
         v.sku,
         v.barcode,
         v.color_ar,
         v.color_en,
         v.color_hex,
         v.size,
         v.size_label,
         v.image_url,
         coalesce(v.price_override, p.selling_price) as price,
         v.stock_quantity,
         public.variant_available(v.id) as available,
         v.active,
         v.sort_order
    from public.product_variants v
    join public.products p on p.id = v.product_id
   where p.active
     and p.show_on_website
     and p.variants_enabled
   order by v.product_id, v.color_key, v.size nulls last, v.sort_order
$$;

comment on function public.storefront_product_variants() is
  'Public storefront read of a variant product''s combinations: labels, optional swatch/image, the price actually charged (override or product price) and what is still available. Omits cost_override and low_stock_level, exactly like storefront_catalogue().';

revoke execute on function public.storefront_product_variants() from public;
grant execute on function public.storefront_product_variants() to anon, authenticated, service_role;

-- ── 12. stock health, per variant ────────────────────────────────────────────
-- The product rollup answers "how many units", never "is this product healthy":
-- a product with 20 units of Silver 17 and none of Gold 17 is not merely "in
-- stock". Both report functions therefore classify a variant product from its
-- active variants, and a legacy product exactly as before.

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
    -- Sold out: nothing left to sell. For a variant product that means no active
    -- combination has stock, NOT that the rollup reached zero (the rollup is the
    -- sum, so it would agree — but a product can be "in stock" and still have a
    -- size nobody can buy, which is what `lowStock` now also reports).
    'outOfStock', count(*) filter (
                    where p.stock_tracking_enabled
                      and case when p.variants_enabled then
                            not exists (
                              select 1 from public.product_variants v
                               where v.product_id = p.id and v.active and v.stock_quantity > 0
                            )
                          else p.stock_quantity <= 0 end),
    -- Low stock: a legacy product counts when it is above zero but at or under
    -- its own threshold; a variant product counts when ANY active combination is
    -- at or under its own threshold (a sold-out combination with a real
    -- threshold included — somebody needs to look at it).
    'lowStock',   count(*) filter (
                    where p.stock_tracking_enabled
                      and case when p.variants_enabled then
                            -- Something is still sellable…
                            exists (
                              select 1 from public.product_variants v
                               where v.product_id = p.id and v.active and v.stock_quantity > 0
                            )
                            -- …but a combination is either at or under its own
                            -- threshold, or sold out entirely. Mirrors
                            -- summarizeVariants() in the client exactly.
                            and (
                              exists (
                                select 1 from public.product_variants v
                                 where v.product_id = p.id and v.active
                                   and v.low_stock_level > 0
                                   and v.stock_quantity <= v.low_stock_level
                              )
                              or exists (
                                select 1 from public.product_variants v
                                 where v.product_id = p.id and v.active
                                   and v.stock_quantity <= 0
                              )
                            )
                          else p.stock_quantity > 0
                               and p.stock_quantity <= p.low_stock_level end)
  )
  into v
  from public.products p;

  return v;
end
$$;

comment on function public.reports_inventory_summary() is
  'Stock valuation snapshot. Units and values count tracked products from the rollup (which IS the sum of the variants), while out-of-stock and low-stock are classified per active VARIANT for a variant product — once any combination is at or under its own threshold the product is low, and only a product with nothing sellable left is out. Legacy products behave exactly as before.';

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
           coalesce(sum(si.line_total), 0) as revenue
      from public.sale_items si
      join public.sales s on s.id = si.sale_id
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
     where r.refund_status <> 'rejected'
       and ri.variant_id is not null
       and (p_from is null or r.created_at >= p_from)
       and (p_to   is null or r.created_at <= p_to)
     group by ri.variant_id
  ),
  ordered as (
    select oi.variant_id, coalesce(sum(oi.quantity), 0) as units
      from public.online_order_items oi
      join public.online_orders o on o.id = oi.order_id
     where o.status <> 'cancelled'
       and oi.variant_id is not null
       and (p_from is null or o.created_at >= p_from)
       and (p_to   is null or o.created_at <= p_to)
     group by oi.variant_id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'variantId',    v.id,
           'productId',    p.id,
           'productSku',   p.sku,
           'productNameEn', p.name_en,
           'productNameAr', p.name_ar,
           'sku',          v.sku,
           'colorAr',      v.color_ar,
           'colorEn',      v.color_en,
           'size',         v.size,
           'sizeLabel',    v.size_label,
           'active',       v.active,
           'sold',         coalesce(sd.units, 0),
           'invoices',     coalesce(sd.invoices, 0),
           'revenue',      coalesce(sd.revenue, 0),
           'returnedUnits', coalesce(rt.units, 0),
           'returnedAmount', coalesce(rt.amount, 0),
           'orderedOnline', coalesce(ol.units, 0),
           'stock',        v.stock_quantity,
           'lowStockLevel', v.low_stock_level,
           'low',          v.active and v.low_stock_level > 0 and v.stock_quantity <= v.low_stock_level,
           'out',          v.active and v.stock_quantity <= 0
         ) order by p.name_en, v.color_key, v.size nulls last), '[]'::jsonb)
    into v
    from public.product_variants v
    join public.products p on p.id = v.product_id
    left join sold    sd on sd.variant_id = v.id
    left join returned rt on rt.variant_id = v.id
    left join ordered ol on ol.variant_id = v.id;

  return v;
end
$$;

comment on function public.reports_variant_performance(timestamptz, timestamptz) is
  'Per-variant units, revenue, returns, online demand and current stock for a period, one row per variant whether or not it sold. Reads the variant snapshot on the history lines, so a sale of "Gold / 17" is still Gold / 17 after a rename. Product-level reports are untouched and still reconcile, because the product rollup IS the sum of these rows.';

revoke execute on function public.reports_variant_performance(timestamptz, timestamptz) from public, anon;
grant execute on function public.reports_variant_performance(timestamptz, timestamptz) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- 13. The RPCs, redefined with an exact-variant branch
--
-- Each body below is the current shipped definition (pos_complete_sale from
-- 0040, pos_process_return / pos_settle_refund from 0041, place_online_order
-- from 0042, resolve_online_order from 0018) with ONE addition: a variant
-- products branch. The legacy statements are byte-for-byte what they were, so a
-- product with variants switched off behaves exactly as it does today.
--
-- The ordering rule is the same everywhere and is what makes the concurrency
-- guard work: lock the PRODUCT row, then lock the EXACT VARIANT row, then read
-- availability. Two callers cannot both pass the check for the last unit of
-- Gold / 17, because whichever arrives second blocks on the variant's row lock
-- until the first has committed its reservation or its sale.
-- ═══════════════════════════════════════════════════════════════════════════

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

  -- Phase 43: the exact variant, when the product sells by variant.
  v_variant         public.product_variants%rowtype;
  v_variant_id      uuid;

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
    if v_product.variants_enabled then
      -- The shelf is the exact variant's. `for update` takes the row lock BEFORE
      -- the availability check and holds it to the end of the transaction, which
      -- is what stops two registers taking the last Gold / 17 between the check
      -- and the deduction below.
      v_variant_id := public.variant_id_of(v_line->>'variant_id');
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
          coalesce(public.variant_label(v_variant.color_en, v_variant.color_ar, v_variant.size, v_variant.size_label), v_product.sku)
          using errcode = 'check_violation';
      end if;
      if v_qty > v_variant.stock_quantity then
        raise exception 'Only % of % in stock', v_variant.stock_quantity,
          coalesce(public.variant_label(v_variant.color_en, v_variant.color_ar, v_variant.size, v_variant.size_label), v_product.sku)
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
      v_variant_id := public.variant_id_of(v_line->>'variant_id');
      -- Re-read under the same lock the validation took: the deduction has to
      -- come off the exact row, never off the product rollup.
      select * into v_variant from public.product_variants
       where id = v_variant_id and product_id = v_product.id
       for update;
      v_unit := coalesce(v_variant.price_override, v_product.selling_price);

      insert into public.sale_items (
        sale_id, product_id, name_ar, name_en, sku, barcode, unit_price, quantity, line_total,
        variant_id, variant_color_ar, variant_color_en, variant_size, variant_size_label
      ) values (
        v_sale_id, v_product.id, v_product.name_ar, v_product.name_en,
        coalesce(nullif(btrim(v_variant.sku), ''), v_product.sku),
        coalesce(v_variant.barcode, v_product.barcode),
        v_unit, v_qty, round((v_unit * v_qty)::numeric, 2),
        v_variant.id, v_variant.color_ar, v_variant.color_en, v_variant.size, v_variant.size_label
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

grant execute on function public.pos_complete_sale(jsonb, uuid) to authenticated;
revoke execute on function public.pos_complete_sale(jsonb, uuid) from anon;
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
  -- Phase 43: the exact variant, when the product sells by variant.
  v_variant        public.product_variants%rowtype;
  v_variant_id     uuid;
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
    -- Phase 43: availability is per EXACT variant for a variant product. The row
    -- lock is taken before the check and held until the reservation below, so a
    -- second shopper cannot be promised the same last unit.
    v_variant_id := null;
    if v_product.variants_enabled then
      v_variant_id := public.variant_id_of(v_line->>'variant_id');
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
          coalesce(public.variant_label(v_variant.color_en, v_variant.color_ar, v_variant.size, v_variant.size_label), v_product.sku)
          using errcode = 'check_violation';
      end if;
      v_available := v_variant.stock_quantity - public.reserved_quantity_variant(v_variant.id);
      if v_qty > v_available then
        raise exception 'Only % of % available', v_available,
          coalesce(public.variant_label(v_variant.color_en, v_variant.color_ar, v_variant.size, v_variant.size_label), v_product.sku)
          using errcode = 'check_violation';
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
    -- cart total is never trusted. A variant's own price override is the base
    -- the campaign reduces, exactly as the checkout quotes it.
    v_unit := case when v_product.variants_enabled
                   then coalesce(v_variant.price_override, v_product.selling_price)
                   else v_product.selling_price end;
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

    v_subtotal := v_subtotal + round((v_unit * v_qty)::numeric, 2);

    -- Carry the shop's price to the snapshot loop. Nothing from the caller's
    -- line is trusted past this point but product_id and qty, both of which
    -- were just validated against the catalogue.
    v_priced_lines := v_priced_lines || jsonb_build_object(
      'product_id', v_product.id::text,
      'variant_id', v_variant_id::text,
      'qty',        v_qty,
      'unit_price', v_unit
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
    select * into v_product from public.products where id = (v_line->>'product_id')::uuid;
    v_unit := round((v_line->>'unit_price')::numeric, 2);
    v_variant_id := public.variant_id_of(v_line->>'variant_id');

    if v_variant_id is not null then
      select * into v_variant from public.product_variants
       where id = v_variant_id and product_id = v_product.id;

      insert into public.online_order_items (
        order_id, product_id, name_ar, name_en, sku, barcode, unit_price, quantity, line_total,
        variant_id, variant_color_ar, variant_color_en, variant_size, variant_size_label
      ) values (
        v_order_id, v_product.id, v_product.name_ar, v_product.name_en,
        coalesce(nullif(btrim(v_variant.sku), ''), v_product.sku),
        coalesce(v_variant.barcode, v_product.barcode),
        v_unit, v_qty, round((v_unit * v_qty)::numeric, 2),
        v_variant.id, v_variant.color_ar, v_variant.color_en, v_variant.size, v_variant.size_label
      );

      if v_product.stock_tracking_enabled then
        insert into public.stock_reservations (online_order_id, product_id, variant_id, quantity, status)
        values (v_order_id, v_product.id, v_variant.id, v_qty, 'reserved'::public.reservation_status);
      end if;
    else
      insert into public.online_order_items (
        order_id, product_id, name_ar, name_en, sku, barcode, unit_price, quantity, line_total
      ) values (
        v_order_id, v_product.id, v_product.name_ar, v_product.name_en, v_product.sku,
        v_product.barcode, v_unit, v_qty, round((v_unit * v_qty)::numeric, 2)
      );

      if v_product.stock_tracking_enabled then
        insert into public.stock_reservations (online_order_id, product_id, quantity, status)
        values (v_order_id, v_product.id, v_qty, 'reserved'::public.reservation_status);
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
  -- Phase 43: the variant the SALE LINE was sold as — never the caller's choice.
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

    -- The variant travels with the SALE LINE, so a return cannot redirect the
    -- units to another colour or size: whatever was sold is what comes back.
    insert into public.return_items (
      return_id, sale_item_id, product_id, name_ar, name_en, sku, barcode,
      unit_price, quantity, line_total,
      variant_id, variant_color_ar, variant_color_en, variant_size, variant_size_label
    ) values (
      v_return_id, v_sale_item.id, v_sale_item.product_id, v_sale_item.name_ar,
      v_sale_item.name_en, v_sale_item.sku, v_sale_item.barcode,
      v_sale_item.unit_price, v_qty,
      round((v_sale_item.unit_price * v_qty)::numeric, 2),
      v_sale_item.variant_id, v_sale_item.variant_color_ar, v_sale_item.variant_color_en,
      v_sale_item.variant_size, v_sale_item.variant_size_label
    );

    select * into v_product from public.products where id = v_sale_item.product_id for update;
    if found and v_sale_item.variant_id is not null then
      -- Straight back onto the combination that was sold — not another size,
      -- not another colour, and not the product rollup.
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
          v_product.id, v_variant.id, v_variant.color_ar, v_variant.color_en, v_variant.size,
          v_qty, v_before, v_before + v_qty,
          'adjustment_in', 'customer_return',
          'Customer Return: ' || v_return_number || ' (Sale ' || v_sale.sale_number || ')',
          v_user_id, v_user_name
        );
      end if;
    elsif found then
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
  v_before         integer;
  v_after          integer;
  v_reversed_units integer := 0;
  -- Phase 43: the exact combination a rejected return's goods come off.
  v_variant        public.product_variants%rowtype;
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
      -- A rejected return's goods go back OUT. For a variant line that means the
      -- exact combination the return restored, so a re-accepted return cannot
      -- take the units off a sibling size instead.
      if v_ri.variant_id is not null then
        select * into v_variant from public.product_variants
          where id = v_ri.variant_id for update;
        if found then
          v_before := v_variant.stock_quantity;
          v_after  := greatest(0, v_before - v_ri.quantity);
          update public.product_variants
             set stock_quantity = v_after, updated_at = now()
           where id = v_ri.variant_id;
          insert into public.stock_movements (
            product_id, variant_id, variant_color_ar, variant_color_en, variant_size,
            delta, quantity_before, quantity_after, type, reason, notes,
            user_id, user_name
          ) values (
            v_ri.product_id, v_ri.variant_id, v_ri.variant_color_ar, v_ri.variant_color_en, v_ri.variant_size,
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
$$;create or replace function public.resolve_online_order(p_payload jsonb)
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
    -- Phase 43: the list price of a variant line is the variant's own price
    -- (override, else the product's), which is exactly what pos_complete_sale
    -- will book — so the discount that carries the campaign/coupon across stays
    -- exact for variant orders too.
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
        select jsonb_agg(jsonb_build_object(
                 'product_id', i.product_id,
                 'variant_id', i.variant_id,
                 'qty',        i.quantity))
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
          -- The voided sale took the units off the exact combination; they go
          -- back onto it, never onto a sibling or onto the product rollup.
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
create or replace function public.repair_stock_reservation(
  p_action         text,
  p_reservation_id uuid,
  p_order_id       uuid,
  p_product_id     uuid,
  p_quantity       integer,
  p_reason         text,
  p_user_id        text,
  p_user_name      text,
  -- Phase 43: the exact variant the hold belongs to. Null keeps every legacy
  -- (product-level) hold working exactly as before.
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
  v_expected     integer;
  v_before       jsonb;
  v_note         text;
  -- Where a release or a convert is heading, computed once. It has to be a
  -- variable: plpgsql reads the first `then` it meets as the IF's own, so a CASE
  -- inline in a condition is a syntax error, not a value.
  v_wanted       text;
  v_variant      public.product_variants%rowtype;
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

    select coalesce(sum(i.quantity), 0)::integer into v_expected
    from public.online_order_items i
    where i.order_id = v_order.id
      and i.product_id = p_product_id
      -- Phase 43: an exact-variant hold may only restore what THAT combination
      -- was ordered for; a product-wide call (p_variant_id null) keeps matching
      -- the legacy, variant-less lines only.
      and i.variant_id is not distinct from p_variant_id;

    if v_expected is null or v_expected <= 0 then
      raise exception 'The order has no line for this product' using errcode = 'check_violation';
    end if;
    if p_quantity is not null and p_quantity <> v_expected then
      raise exception 'The order asks for %; a repair cannot hold a different number', v_expected
        using errcode = 'check_violation';
    end if;
    if not exists (
      select 1 from public.products p
      where p.id = p_product_id and p.stock_tracking_enabled
    ) then
      raise exception 'This product does not track stock, so it holds nothing'
        using errcode = 'check_violation';
    end if;

    if p_variant_id is not null then
      select * into v_variant from public.product_variants
       where id = p_variant_id and product_id = p_product_id;
      if not found then
        raise exception 'That variant does not belong to this product'
          using errcode = 'check_violation';
      end if;
    end if;

    -- Two holds on one line would hide the same units twice.
    select * into v_reservation
    from public.stock_reservations
    where online_order_id = v_order.id
      and product_id = p_product_id
      and variant_id is not distinct from p_variant_id
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
    values (v_order.id, p_product_id, p_variant_id, v_expected, 'reserved'::public.reservation_status)
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
    where i.order_id = v_order.id and i.product_id = v_reservation.product_id;

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

-- ── 14. repair_stock_reservation keeps its old signature ─────────────────────
-- The eight-argument version shipped in 0025 stays exactly what it was for every
-- existing caller: a product-level repair. It delegates to the variant-aware
-- version with a null variant, which matches the legacy, variant-less holds —
-- the shape every reservation had before this migration. Nothing is removed, so
-- no caller (app, script or another function) has to change to keep working.
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
language plpgsql
security definer
set search_path = public
as $$
begin
  return public.repair_stock_reservation(
    p_action, p_reservation_id, p_order_id, p_product_id,
    p_quantity, p_reason, p_user_id, p_user_name, null
  );
end;
$$;

comment on function public.repair_stock_reservation(text, uuid, uuid, uuid, integer, text, text, text) is
  'Legacy (product-level) stock-hold repair, kept for backward compatibility: delegates to the variant-aware overload with a null variant, so it matches exactly the holds that existed before variants did.';

revoke execute on function public.repair_stock_reservation(text, uuid, uuid, uuid, integer, text, text, text, uuid) from public, anon;
grant execute on function public.repair_stock_reservation(text, uuid, uuid, uuid, integer, text, text, text, uuid) to authenticated;
