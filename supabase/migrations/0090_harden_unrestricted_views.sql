-- 0090_harden_unrestricted_views.sql
-- Harden unrestricted views, eliminate direct Data API leakages, and enforce security barrier on backup metadata.

-- ── 1. Secure refund allocation diagnostic view ────────────────────────────
-- Diagnostic review queue for historic refund allocations. Contains cross-branch
-- financial totals and invoice anomaly details.
-- Action: Revoke direct access from public, anon, and authenticated. Internal-only for postgres/service_role.
revoke all on public.refund_allocation_anomalies from public, anon, authenticated;
grant select on public.refund_allocation_anomalies to postgres, service_role;

comment on view public.refund_allocation_anomalies is
  'Internal diagnostic review queue only. Direct Data API access revoked to prevent cross-branch financial data exposure.';

-- ── 2. Isolate legacy category tree view ───────────────────────────────────
-- Legacy recursive view from early migration 0003. The frontend exclusively uses
-- the authoritative storefront_categories_v2 RPC and categories table.
-- Action: Revoke direct access from public, anon, and authenticated.
revoke all on public.category_tree_view from public, anon, authenticated;
grant select on public.category_tree_view to postgres, service_role;

comment on view public.category_tree_view is
  'Legacy migration 0003 category tree view. Direct Data API access revoked; runtime catalogue reads use storefront_categories_v2 and public.categories.';

-- ── 3. Harden backup manifests view with security barrier ───────────────────
-- Operational snapshot metadata view for seats holding view_backups.
-- Action: Recreate with security_barrier = true to defend against query planner
-- filter pushdown and side-channel leakage, preserving public.can('view_backups').
-- Ensure strict grants: authenticated SELECT only, anon and public REVOKED.
create or replace view public.backup_manifests
with (security_barrier = true) as
select b.id,
       b.kind,
       b.note,
       b.mode,
       b.schema_version,
       b.checksum,
       b.row_count,
       b.size_bytes,
       b.table_count,
       b.source_revision,
       b.created_at,
       b.created_by,
       b.created_by_name
  from public.backups b
 where public.can('view_backups');

comment on view public.backup_manifests is
  'Snapshot metadata for seats holding view_backups with security_barrier protection — never the backup document itself.';

revoke all on public.backup_manifests from anon, public;
grant select on public.backup_manifests to authenticated;
