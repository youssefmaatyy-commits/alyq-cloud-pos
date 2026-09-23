-- ═══════════════════════════════════════════════════════════════════════════
-- ALYQ Cloud POS · Migration 0003
-- Phase 2 — Row Level Security, audit columns and optional demo seed.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── audit columns ─────────────────────────────────────────────────────────
create or replace function public.set_audit_columns()
returns trigger
language plpgsql
as $$
begin
  new.updated_by := auth.uid();
  return new;
end;
$$;

drop trigger if exists products_audit_columns on public.products;
create trigger products_audit_columns
  before update on public.products
  for each row execute function public.set_audit_columns();

-- ── RLS ───────────────────────────────────────────────────────────────────
-- Baseline tenant policy: every authenticated workspace member gets full
-- CRUD on the catalog. Tighten `using`/`with check` per branch/role when the
-- users & permissions phase lands.
alter table public.categories enable row level security;
alter table public.products    enable row level security;

drop policy if exists "categories_select_authenticated" on public.categories;
create policy "categories_select_authenticated"
  on public.categories for select
  to authenticated
  using (true);

drop policy if exists "categories_write_authenticated" on public.categories;
create policy "categories_write_authenticated"
  on public.categories for insert
  to authenticated
  with check (true);

drop policy if exists "categories_update_authenticated" on public.categories;
create policy "categories_update_authenticated"
  on public.categories for update
  to authenticated
  using (true)
  with check (true);

drop policy if exists "categories_delete_authenticated" on public.categories;
create policy "categories_delete_authenticated"
  on public.categories for delete
  to authenticated
  using (true);

drop policy if exists "products_select_authenticated" on public.products;
create policy "products_select_authenticated"
  on public.products for select
  to authenticated
  using (true);

drop policy if exists "products_insert_authenticated" on public.products;
create policy "products_insert_authenticated"
  on public.products for insert
  to authenticated
  with check (true);

drop policy if exists "products_update_authenticated" on public.products;
create policy "products_update_authenticated"
  on public.products for update
  to authenticated
  using (true)
  with check (true);

-- ── helpful view: category tree with product counts ───────────────────────
create or replace view public.category_tree_view as
with recursive tree as (
  select c.id,
         c.name_ar,
         c.name_en,
         c.parent_id,
         c.active,
         c.sort_order,
         0::int    as depth,
         c.id::text as path
    from public.categories c
   where c.parent_id is null
  union all
  select c.id,
         c.name_ar,
         c.name_en,
         c.parent_id,
         c.active,
         c.sort_order,
         t.depth + 1,
         t.path || '/' || c.id
    from public.categories c
    join tree t on c.parent_id = t.id
)
select t.id,
       t.name_ar,
       t.name_en,
       t.parent_id,
       t.active,
       t.sort_order,
       t.depth,
       t.path,
       (select count(*) from public.products p where p.category_id = t.id) as product_count
  from tree t;

-- ── optional demo seed (skips silently when SKUs already exist) ───────────
insert into public.categories (id, name_ar, name_en, parent_id, active, sort_order)
select v.id, v.name_ar, v.name_en, null::uuid, v.active, v.sort_order
  from (values
    ('11111111-1111-4111-8111-000000000001'::uuid, 'مجوهرات', 'Jewellery', true,  1),
    ('11111111-1111-4111-8111-000000000004'::uuid, 'إكسسوارات أزياء',   'Fashion Accessories',   true,  2),
    ('11111111-1111-4111-8111-000000000006'::uuid, 'خدمات',   'Services',  true,  3)
  ) as v(id, name_ar, name_en, active, sort_order)
where not exists (select 1 from public.categories c where c.id = v.id);

insert into public.categories (id, name_ar, name_en, parent_id, active, sort_order)
select v.id, v.name_ar, v.name_en, v.parent_id, v.active, v.sort_order
  from (values
    ('11111111-1111-4111-8111-000000000002'::uuid, 'أقراط',        'Earrings', '11111111-1111-4111-8111-000000000001'::uuid, true, 1),
    ('11111111-1111-4111-8111-000000000003'::uuid, 'قلادات',       'Necklaces', '11111111-1111-4111-8111-000000000001'::uuid, true, 2),
    ('11111111-1111-4111-8111-000000000005'::uuid, 'أساور','Bracelets',  '11111111-1111-4111-8111-000000000004'::uuid, true, 1)
  ) as v(id, name_ar, name_en, parent_id, active, sort_order)
where not exists (select 1 from public.categories c where c.id = v.id);

insert into public.products (
  sku, barcode, name_ar, name_en, description_ar, description_en,
  category_id, product_type, selling_price, cost_price, tax_rate,
  stock_tracking_enabled, active
)
select v.sku, v.barcode, v.name_ar, v.name_en, v.description_ar, v.description_en,
       v.category_id, v.product_type::public.product_type, v.selling_price, v.cost_price, v.tax_rate,
       v.stock_tracking_enabled, v.active
  from (values
    ('ALYQ-1001', '6281000000013', 'أقراط لؤلؤ ذهبية', 'Gold Pearl Earrings',
     'نحاس مطلي بالذهب مع لؤلؤ طبيعي، إغلاق آمن.', 'Gold-plated brass with freshwater pearls, secure closure.',
     '11111111-1111-4111-8111-000000000002'::uuid, 'physical', 32.50, 21.00, 15.00, true, true),
    ('ALYQ-1010', '6281000000037', 'قلادة لؤلؤ', 'Pearl Necklace',
     'لؤلؤ صناعي على سلسلة رفيعة — تُحفظ في علبتها.', 'Faux pearls on a fine chain — keep in its pouch.',
     '11111111-1111-4111-8111-000000000003'::uuid, 'expiry-tracked', 14.00, 8.50, 15.00, true, true),
    ('ALYQ-3001', '4006381333931', 'خدمة تغليف الهدايا والنقش', 'Gift Wrapping & Personalisation',
     'تغليف في المتجر مع نقش الاسم، تشمل جلسة تنسيق قصيرة.', 'In-store wrapping with name engraving, includes a short styling session.',
     '11111111-1111-4111-8111-000000000006'::uuid, 'service', 350.00, 0.00, 15.00, false, true)
  ) as v(sku, barcode, name_ar, name_en, description_ar, description_en,
         category_id, product_type, selling_price, cost_price, tax_rate,
         stock_tracking_enabled, active)
where not exists (select 1 from public.products p where lower(btrim(p.sku)) = lower(btrim(v.sku)));
