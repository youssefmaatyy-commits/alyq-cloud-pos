-- ═══════════════════════════════════════════════════════════════════════════
-- ALYQ Cloud POS · Migration 0004
-- Phase 2 (continued) — Stock, low-stock threshold, storefront flags, gallery.
-- Additive and safe to re-run: every statement guards with IF NOT EXISTS.
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.products
  add column if not exists stock_quantity    integer  not null default 0 check (stock_quantity >= 0),
  add column if not exists low_stock_level   integer  not null default 0 check (low_stock_level >= 0),
  add column if not exists show_on_website   boolean  not null default true,
  add column if not exists is_featured       boolean  not null default false,
  add column if not exists images            text[]   not null default '{}';

comment on column public.products.stock_quantity  is 'Current on-hand quantity (0 for non-tracked products).';
comment on column public.products.low_stock_level is 'Alert threshold — warn when stock_quantity <= this value.';
comment on column public.products.show_on_website is 'Whether the product is visible on the storefront.';
comment on column public.products.is_featured     is 'Whether the product is highlighted on the storefront.';
comment on column public.products.images          is 'Additional gallery URLs; the cover lives in image_url.';

-- Constraint: gallery size is bounded to keep rows lean.
do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'products_images_bounded'
       and conrelid = 'public.products'::regclass
  ) then
    alter table public.products
      add constraint products_images_bounded
      check (array_length(images, 1) is null or array_length(images, 1) <= 5);
  end if;
end
$$;

create index if not exists products_featured_idx on public.products (is_featured) where is_featured;
create index if not exists products_website_idx  on public.products (show_on_website);
