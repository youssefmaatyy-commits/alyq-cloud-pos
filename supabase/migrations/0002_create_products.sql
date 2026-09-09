-- ═══════════════════════════════════════════════════════════════════════════
-- ALYQ Cloud POS · Migration 0002
-- Phase 2 — Product type enum + products table
-- ═══════════════════════════════════════════════════════════════════════════

create extension if not exists pg_trgm;

-- ── product type ──────────────────────────────────────────────────────────
do $$
begin
  if not exists (select 1 from pg_type where typname = 'product_type') then
    create type public.product_type as enum (
      'physical',
      'service',
      'manufactured',
      'serial-tracked',
      'expiry-tracked'
    );
  end if;
end
$$;

comment on type public.product_type is
  'physical = stocked goods, service = non-stock work, manufactured = produced in-house, serial-tracked = unique serials, expiry-tracked = batch/expiry.';

-- ── products ──────────────────────────────────────────────────────────────
create table if not exists public.products (
  id                      uuid primary key default gen_random_uuid(),
  sku                     text        not null,
  barcode                 text,
  name_ar                 text        not null check (char_length(btrim(name_ar)) between 1 and 120),
  name_en                 text        not null check (char_length(btrim(name_en)) between 1 and 120),
  description_ar          text        check (char_length(coalesce(description_ar, '')) <= 1000),
  description_en          text        check (char_length(coalesce(description_en, '')) <= 1000),
  category_id             uuid        not null references public.categories (id) on delete restrict,
  product_type            public.product_type not null default 'physical',
  selling_price           numeric(14, 2) not null default 0 check (selling_price >= 0),
  cost_price              numeric(14, 2) not null default 0 check (cost_price >= 0),
  tax_rate                numeric(5, 2)  not null default 0 check (tax_rate >= 0 and tax_rate <= 100),
  stock_tracking_enabled  boolean     not null default true,
  active                  boolean     not null default true,
  image_url               text,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),

  constraint products_sku_format check (sku ~ '^[A-Za-z0-9][A-Za-z0-9 _-]*$' and char_length(sku) <= 40),
  constraint products_barcode_length check (char_length(barcode) <= 64)
);

comment on table  public.products          is 'Sellable items and services (Phase 2). No stock quantities yet — Phase 3.';
comment on column public.products.sku      is 'Unique human-facing stock keeping unit.';
comment on column public.products.barcode  is 'Optional EAN/UPC/Code128 scanner code; unique when provided.';
comment on column public.products.tax_rate is 'Percentage (0–100), not an amount.';

-- Uniqueness rules required by Phase 2.
do $$
begin
  if not exists (
    select 1 from pg_indexes
     where schemaname = 'public' and indexname = 'products_sku_unique'
  ) then
    create unique index products_sku_unique
      on public.products (lower(btrim(sku)));
  end if;
end
$$;

-- Partial unique index: only enforced when a barcode is actually provided.
do $$
begin
  if not exists (
    select 1 from pg_indexes
     where schemaname = 'public' and indexname = 'products_barcode_unique'
  ) then
    create unique index products_barcode_unique
      on public.products (btrim(barcode))
      where barcode is not null and btrim(barcode) <> '';
  end if;
end
$$;

create index if not exists products_category_idx  on public.products (category_id);
create index if not exists products_active_idx    on public.products (active);
create index if not exists products_type_idx      on public.products (product_type);
create index if not exists products_name_idx      on public.products (lower(name_en));
create index if not exists products_created_idx   on public.products (created_at desc);

-- Case-insensitive trigram search over names/SKU/barcode (optional but cheap).
create index if not exists products_search_trgm
  on public.products
  using gin ((lower(coalesce(name_en, '') || ' ' || coalesce(name_ar, '') || ' ' || coalesce(sku, '') || ' ' || coalesce(barcode, ''))) gin_trgm_ops);

drop trigger if exists products_set_updated_at on public.products;
create trigger products_set_updated_at
  before update on public.products
  for each row execute function public.set_updated_at();

-- Audit columns: who changed what (uses auth.uid() when available).
alter table public.products
  add column if not exists created_by uuid,
  add column if not exists updated_by uuid;
