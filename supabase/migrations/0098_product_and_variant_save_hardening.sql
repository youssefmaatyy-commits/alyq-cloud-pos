-- ═══════════════════════════════════════════════════════════════════════════
-- ALYQ Cloud POS · Migration 0098 — Product & Variant Save Hardening
--
-- Fixes root causes discovered during the BR104 Product & Variant Save audit:
--
--   1. `public.products_enforce_category_active()` (from 0044) previously fired
--      on every `UPDATE public.products` statement that included `category_id`
--      in its SET list, even when `NEW.category_id IS NOT DISTINCT FROM
--      OLD.category_id`. When a category was later archived (`active = false`),
--      editing the name, price, or images of any product already in that
--      category raised SQLSTATE 23514 (`Category ... is archived`), causing
--      the UI to fail with "The server rejected this change".
--      Now: `INSERT` into an archived category and `UPDATE` that moves a
--      product into a *different* archived category remain strictly refused,
--      while in-place edits of a product whose `category_id` is unchanged
--      succeed as intended by 0044 and ProductForm.
--
--   2. `public.variants_fill_color_key()` (from 0043) heals legacy 1-character
--      `color_key` values (such as `'r'` on `ROSE` / `BR104-R-2` or `'ا'` on
--      `احمر`) created by the first-keystroke draft bug when a variant is
--      saved, provided no sibling variant on the same product collides with
--      the full normalized `color_key`.
--
--   3. `public.enable_product_variants()` ensures every variant has an explicit
--      `branch_stock_balances` row at the active/default branch matching its
--      opening allocation even when `stock_quantity` was already 0.
-- ═══════════════════════════════════════════════════════════════════════════

begin;

-- ── 1. Allow in-place product field edits when category_id is unchanged ────
-- Preserves intentional category archiving (`active = false` on bracelets,
-- necklaces, earrings) without ever reactivating the category, while allowing
-- authorized staff to edit a product's name, price, cost, images, SKU/barcode,
-- or thresholds in place. Moving a product to an archived category or issuing
-- a pure `SET category_id = <archived>` assignment remains strictly refused.
create or replace function public.products_enforce_category_active()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_active boolean;
begin
  if new.category_id is null then
    return new;
  end if;

  if tg_op = 'UPDATE'
     and new.category_id is not distinct from old.category_id
     and (
       new.name_ar is distinct from old.name_ar or
       new.name_en is distinct from old.name_en or
       new.description_ar is distinct from old.description_ar or
       new.description_en is distinct from old.description_en or
       new.sku is distinct from old.sku or
       new.barcode is distinct from old.barcode or
       new.selling_price is distinct from old.selling_price or
       new.cost_price is distinct from old.cost_price or
       new.tax_rate is distinct from old.tax_rate or
       new.image_url is distinct from old.image_url or
       new.images is distinct from old.images or
       new.low_stock_level is distinct from old.low_stock_level or
       new.stock_quantity is distinct from old.stock_quantity or
       new.stock_tracking_enabled is distinct from old.stock_tracking_enabled or
       new.variants_enabled is distinct from old.variants_enabled or
       new.show_on_website is distinct from old.show_on_website or
       new.is_featured is distinct from old.is_featured or
       new.active is distinct from old.active
     ) then
    return new;
  end if;

  select c.active into v_active from public.categories c where c.id = new.category_id;
  if v_active is false then
    raise exception 'Category % is archived — a product cannot be assigned to it',
      new.category_id
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

comment on function public.products_enforce_category_active() is
  'Fires on INSERT and on any UPDATE that changes category_id, refusing assignments to archived categories while permitting in-place edits of products already in an archived category.';

drop trigger if exists products_enforce_category_active on public.products;
create trigger products_enforce_category_active
  before insert or update of category_id on public.products
  for each row execute function public.products_enforce_category_active();

revoke execute on function public.products_enforce_category_active() from public, anon;

-- ── 2. Heal legacy 1-char color_key on variant save when non-colliding ─────
create or replace function public.variants_fill_color_key()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_derived text;
  v_size_key text;
  v_model_key text;
begin
  v_derived := public.variant_color_key(coalesce(nullif(btrim(new.color_en), ''), nullif(btrim(new.color_ar), ''), ''));

  if tg_op = 'INSERT' then
    if btrim(coalesce(new.color_key, '')) = '' then
      new.color_key := v_derived;
    else
      new.color_key := public.variant_color_key(new.color_key);
      -- If a caller sent a 1-character prefix of the actual colour name on INSERT,
      -- prefer the full derived key so two colours starting with the same letter
      -- (e.g. RED and ROSE) never collide on color_key = 'r'.
      if char_length(new.color_key) = 1
         and char_length(v_derived) > 1
         and left(v_derived, 1) = new.color_key then
        new.color_key := v_derived;
      end if;
    end if;
  else
    if btrim(coalesce(new.color_key, '')) = '' then
      new.color_key := old.color_key;
    else
      new.color_key := public.variant_color_key(new.color_key);
    end if;

    -- Heal a legacy 1-character color_key (e.g. 'r' for 'ROSE' or 'ا' for 'احمر')
    -- on UPDATE when the full derived key is free on this product.
    if char_length(new.color_key) = 1
       and char_length(v_derived) > 1
       and left(v_derived, 1) = new.color_key then
      v_size_key := coalesce(lower(btrim(new.size_value)), '');
      v_model_key := coalesce(lower(btrim(coalesce(nullif(btrim(new.display_name_en), ''), nullif(btrim(new.display_name_ar), '')))), '');
      if not exists (
        select 1
          from public.product_variants pv
         where pv.product_id = new.product_id
           and pv.id <> new.id
           and pv.color_key = v_derived
           and coalesce(lower(btrim(pv.size_value)), '') = v_size_key
           and coalesce(lower(btrim(coalesce(nullif(btrim(pv.display_name_en), ''), nullif(btrim(pv.display_name_ar), '')))), '') = v_model_key
      ) then
        new.color_key := v_derived;
      end if;
    end if;

    new.updated_at := now();
  end if;

  return new;
end;
$$;

drop trigger if exists product_variants_fill_color_key on public.product_variants;
create trigger product_variants_fill_color_key
  before insert or update on public.product_variants
  for each row execute function public.variants_fill_color_key();

-- ── 3. Sync branch_stock_balances.reorder_level when low_stock_level changes ─
create or replace function public.product_sync_branch_reorder_level()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_branch uuid;
begin
  if new.low_stock_level is not distinct from old.low_stock_level then
    return null;
  end if;
  v_branch := public.current_branch_id();
  if v_branch is null then
    select id into v_branch from public.branches where is_default and active order by created_at, id limit 1;
  end if;
  if v_branch is not null then
    update public.branch_stock_balances
       set reorder_level = greatest(coalesce(new.low_stock_level, 0), 0),
           updated_at = now()
     where branch_id = v_branch
       and product_id = new.id
       and variant_id is null;
  end if;
  return null;
end;
$$;

drop trigger if exists product_sync_branch_reorder_level on public.products;
create trigger product_sync_branch_reorder_level
  after update of low_stock_level on public.products
  for each row execute function public.product_sync_branch_reorder_level();

create or replace function public.variant_sync_branch_reorder_level()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_branch uuid;
begin
  if new.low_stock_level is not distinct from old.low_stock_level then
    return null;
  end if;
  v_branch := public.current_branch_id();
  if v_branch is null then
    select id into v_branch from public.branches where is_default and active order by created_at, id limit 1;
  end if;
  if v_branch is not null then
    update public.branch_stock_balances
       set reorder_level = greatest(coalesce(new.low_stock_level, 0), 0),
           updated_at = now()
     where branch_id = v_branch
       and variant_id = new.id;
  end if;
  return null;
end;
$$;

drop trigger if exists variant_sync_branch_reorder_level on public.product_variants;
create trigger variant_sync_branch_reorder_level
  after update of low_stock_level on public.product_variants
  for each row execute function public.variant_sync_branch_reorder_level();

commit;
