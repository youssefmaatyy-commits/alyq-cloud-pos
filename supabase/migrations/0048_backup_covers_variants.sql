-- ═══════════════════════════════════════════════════════════════════════════
-- 0048 — BACKUP COVERS THE PHASE 43/45 TABLES (Phase 48 audit finding)
-- ═══════════════════════════════════════════════════════════════════════════
-- THE DEFECT (found by the Phase 48 full-system audit): migration 0029's
-- `backup_table_order()` was written before product variants and storefront
-- category content existed, so the live snapshot and restore path — which
-- iterate this one array for everything — silently DROPPED three tables:
--
--   product_variants            (0043)  the shelf of record for variant goods
--   catalogue_codes             (0043)  per-product / per-variant codes
--   storefront_category_content (0045)  per-category storefront presentation
--
-- A live backup therefore looked healthy while carrying a shop that had lost
-- every Gold/17 and Silver/17; a restore would have overwritten a running
-- installation with those gaps. Data-loss class, and invisible until the day
-- the backup was needed.
--
-- WHY THIS FILE: 0029 is already deployed (hosted is through 0043) and its
-- history must not be rewritten; the function was DESIGNED for this day —
-- "the day somebody adds a table they should have to add it once" — and every
-- consumer (snapshot, restore, delete order) reads it dynamically, so
-- replacing the one function is the complete, atomic fix. No data is touched,
-- no privilege changes, no new tables; the derived restore order and the
-- reversed delete order follow on their own.
--
-- Slotting (parents before children, exactly as 0029 orders them):
--   product_variants   after products (its only parent);
--   catalogue_codes    after product_variants (points at products AND variants);
--   storefront_category_content after product_content (its sibling content
--                      row; parent `categories` precedes both).
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function public.backup_table_order()
returns text[]
language sql
immutable
set search_path = public
as $$
  select array[
    -- counters and vocabulary first: nothing points at them, everything may be
    -- pointed at by them
    'approval_counters',
    'refund_counters',
    'return_counters',
    'sale_counters',
    'role_aliases',
    'role_capabilities',
    'audit_actions',
    'approval_rules',
    -- the storefront's own documents
    'campaigns',
    'coupons',
    'store_faqs',
    'website_settings',
    -- the catalogue and the people
    'categories',
    'custom_roles',
    'customers',
    'store_customers',
    'shifts',
    'products',
    -- Phase 43/45: the shelf of record and its codes, between their parent and
    -- the children that reference them
    'product_variants',
    'catalogue_codes',
    'profiles',
    -- the trading record
    'expenses',
    'sales',
    'audit_log',
    'online_orders',
    'sales_returns',
    -- children of the above, last
    'sale_items',
    'sale_payments',
    'stock_movements',
    'product_content',
    'storefront_category_content',
    'store_reviews',
    'online_order_items',
    'order_events',
    'stock_reservations',
    'return_items',
    'refund_records',
    'approval_requests'
  ];
$$;

-- catalogue_codes joins the restore exclusions: it is TRIGGER-OWNED (0043's
-- catalogue_codes_sync_product rewrites it whenever products/variants are
-- written). Re-inserting the captured rows after products came back would
-- collide with the rows the triggers had already written — the restore's own
-- scenario proved it with a duplicate-key raise. A snapshot still carries it
-- (a document is the record); a restore lets the triggers rebuild it, exactly
-- as role_capabilities is left to the release and audit_log to the trail.
-- Re-stated beside the order so this file is the whole story; the derive body
-- is 0029's verbatim otherwise.
create or replace function public.backup_restore_order()
returns text[]
language sql
immutable
set search_path = public
as $$
  select coalesce(array(
    select t
      from unnest(public.backup_table_order()) with ordinality as x(t, n)
     where t <> all (array[
       'role_aliases', 'role_capabilities', 'audit_actions', 'audit_log',
       'catalogue_codes'
     ])
     order by n
  ), '{}');
$$;
