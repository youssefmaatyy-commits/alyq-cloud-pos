-- ═══════════════════════════════════════════════════════════════════════════
-- 0070 · Explicit module reads for dashboard, catalogue and sales history
-- ═══════════════════════════════════════════════════════════════════════════
-- These three screens were historically open to every signed-in profile and
-- therefore could not be removed from a custom role.  Name those reads without
-- changing any shipped seat's access, and project them through the existing
-- role/custom-role/exception model.  No second authorization system is added:
-- public.can(text) remains the only RLS question.
--
-- Existing custom roles keep the dashboard and catalogue they could always
-- open.  Sales history keeps its former `sell` door: roles/users that could sell
-- retain the read, while a new role may now be read-only sales without a till.
-- Idempotent: migration checks apply this file twice.
-- ═══════════════════════════════════════════════════════════════════════════

insert into public.role_capabilities (role, capability) values
  ('admin',           'view_dashboard'),
  ('manager',         'view_dashboard'),
  ('cashier',         'view_dashboard'),
  ('inventory_clerk', 'view_dashboard'),
  ('viewer',          'view_dashboard'),

  ('admin',           'view_products'),
  ('manager',         'view_products'),
  ('cashier',         'view_products'),
  ('inventory_clerk', 'view_products'),
  ('viewer',          'view_products'),

  ('admin',           'view_sales'),
  ('manager',         'view_sales'),
  ('cashier',         'view_sales'),
  ('inventory_clerk', 'view_sales')
on conflict (role, capability) do nothing;

-- Custom-role capability arrays are absolute overlays, so they need the two
-- formerly implicit reads explicitly.  `view_sales` follows the old route gate.
update public.custom_roles
   set capabilities =
         case
           when not ('view_dashboard' = any(capabilities))
             then array_append(capabilities, 'view_dashboard')
           else capabilities
         end,
       updated_at = updated_at
 where not ('view_dashboard' = any(capabilities));

update public.custom_roles
   set capabilities =
         case
           when not ('view_products' = any(capabilities))
             then array_append(capabilities, 'view_products')
           else capabilities
         end,
       updated_at = updated_at
 where not ('view_products' = any(capabilities));

update public.custom_roles
   set capabilities = array_append(capabilities, 'view_sales'),
       updated_at = updated_at
 where 'sell' = any(capabilities)
   and not ('view_sales' = any(capabilities));

-- Per-user sell exceptions also opened/closed sales history before this read
-- was named.  Carry that intent forward so an upgrade cannot widen or narrow an
-- individual account by accident.  Deny still wins in public.can().
update public.profiles
   set extra_capabilities = array_append(extra_capabilities, 'view_sales'),
       updated_at = updated_at
 where 'sell' = any(extra_capabilities)
   and not ('view_sales' = any(extra_capabilities));

update public.profiles
   set denied_capabilities = array_append(denied_capabilities, 'view_sales'),
       updated_at = updated_at
 where 'sell' = any(denied_capabilities)
   and not ('view_sales' = any(denied_capabilities));

-- ── Authoritative catalogue reads ─────────────────────────────────────────
-- Storefront catalogue reads use the hardened SECURITY DEFINER RPCs from 0030,
-- not direct table grants.  Direct authenticated reads are workspace reads and
-- now require either the named module read or an operation that necessarily
-- consumes catalogue rows.
drop policy if exists "categories_select_authenticated" on public.categories;
create policy "categories_select_authenticated"
  on public.categories for select to authenticated
  using (
    public.can('view_products')
    or public.can('view_inventory')
    or public.can('sell')
    or public.can('add_product')
    or public.can('edit_product')
    or public.can('import_data')
    or public.can('view_reports')
    or public.can('manage_website')
    or public.can('manage_online_orders')
  );

drop policy if exists "products_select_authenticated" on public.products;
create policy "products_select_authenticated"
  on public.products for select to authenticated
  using (
    public.can('view_products')
    or public.can('view_inventory')
    or public.can('sell')
    or public.can('adjust_stock')
    or public.can('add_product')
    or public.can('edit_product')
    or public.can('change_price')
    or public.can('delete_product')
    or public.can('import_data')
    or public.can('export_data')
    or public.can('process_return')
    or public.can('process_refund')
    or public.can('view_reports')
    or public.can('manage_website')
    or public.can('manage_online_orders')
  );

drop policy if exists product_variants_select on public.product_variants;
create policy product_variants_select
  on public.product_variants for select to authenticated
  using (
    public.can('view_products')
    or public.can('view_inventory')
    or public.can('sell')
    or public.can('adjust_stock')
    or public.can('add_product')
    or public.can('edit_product')
    or public.can('import_data')
    or public.can('process_return')
    or public.can('process_refund')
    or public.can('view_reports')
    or public.can('manage_website')
    or public.can('manage_online_orders')
  );

drop policy if exists catalogue_codes_select on public.catalogue_codes;
create policy catalogue_codes_select
  on public.catalogue_codes for select to authenticated
  using (
    public.can('view_products')
    or public.can('sell')
    or public.can('add_product')
    or public.can('edit_product')
    or public.can('import_data')
  );

-- ── Authoritative invoice reads ───────────────────────────────────────────
-- Invoice rows feed several existing, separately-authorized workflows.  The
-- new read opens sales history without granting a write; the other clauses keep
-- returns, payment confirmation, shifts, reports and audit workflows intact.
-- Child rows repeat the same expression so a direct PostgREST query cannot walk
-- around the parent policy.
drop policy if exists "sales_select_authenticated" on public.sales;
create policy "sales_select_authenticated"
  on public.sales for select to authenticated
  using (
    public.can('view_sales')
    or public.can('sell')
    or public.can('edit_sale')
    or public.can('void_sale')
    or public.can('confirm_payment')
    or public.can('process_return')
    or public.can('process_refund')
    or public.can('view_shifts')
    or public.can('view_reports')
    or public.can('view_audit_log')
  );

drop policy if exists "sale_items_select_authenticated" on public.sale_items;
create policy "sale_items_select_authenticated"
  on public.sale_items for select to authenticated
  using (
    public.can('view_sales')
    or public.can('sell')
    or public.can('edit_sale')
    or public.can('void_sale')
    or public.can('confirm_payment')
    or public.can('process_return')
    or public.can('process_refund')
    or public.can('view_shifts')
    or public.can('view_reports')
    or public.can('view_audit_log')
  );

drop policy if exists "sale_payments_select_authenticated" on public.sale_payments;
create policy "sale_payments_select_authenticated"
  on public.sale_payments for select to authenticated
  using (
    public.can('view_sales')
    or public.can('sell')
    or public.can('edit_sale')
    or public.can('void_sale')
    or public.can('confirm_payment')
    or public.can('process_return')
    or public.can('process_refund')
    or public.can('view_shifts')
    or public.can('view_reports')
    or public.can('view_audit_log')
  );
