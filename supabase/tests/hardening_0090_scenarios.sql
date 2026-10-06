-- Hardening 0090 Scenarios: Verify unrestricted view security hardening,
-- security_barrier enforcement on backup metadata, and isolation of diagnostic views.

do $$
declare
  v_admin     uuid := '00000000-0000-4000-8000-0000000000a1';
  v_cashier   uuid := '00000000-0000-4000-8000-0000000000c1';
  v_viewer    uuid := '00000000-0000-4000-8000-0000000000e1';
  v_denied    boolean;
  v_count     bigint;
  v_cats      jsonb;
  v_options   text[];
  v_has_doc   boolean;
begin
  -- ──────────────────────────────────────────────────────────────────────────
  -- 1. Verify security_barrier is enabled on public.backup_manifests
  -- ──────────────────────────────────────────────────────────────────────────
  perform pg_temp.become(null, 'postgres');

  select c.reloptions into v_options
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname = 'backup_manifests';

  if v_options is null or not ('security_barrier=true' = any(v_options)) then
    raise exception 'public.backup_manifests does not have security_barrier = true enabled (options: %)', v_options;
  end if;

  -- Ensure document column is NOT on backup_manifests
  select exists (
    select 1
      from information_schema.columns
     where table_schema = 'public'
       and table_name = 'backup_manifests'
       and column_name = 'document'
  ) into v_has_doc;

  if v_has_doc then
    raise exception 'public.backup_manifests must never expose the raw backup document payload';
  end if;

  -- ──────────────────────────────────────────────────────────────────────────
  -- 2. Test refund_allocation_anomalies view isolation
  -- ──────────────────────────────────────────────────────────────────────────
  -- Anon role must be denied
  perform pg_temp.become(null, 'anon');
  v_denied := false;
  begin
    execute 'select count(*) from public.refund_allocation_anomalies' into v_count;
  exception when insufficient_privilege then
    v_denied := true;
  end;
  if not v_denied then
    raise exception 'anon was able to query public.refund_allocation_anomalies';
  end if;

  -- Low-privilege authenticated (cashier) must be denied
  perform pg_temp.become(v_cashier, 'authenticated');
  v_denied := false;
  begin
    execute 'select count(*) from public.refund_allocation_anomalies' into v_count;
  exception when insufficient_privilege then
    v_denied := true;
  end;
  if not v_denied then
    raise exception 'cashier was able to query public.refund_allocation_anomalies';
  end if;

  -- Low-privilege authenticated (viewer) must be denied
  perform pg_temp.become(v_viewer, 'authenticated');
  v_denied := false;
  begin
    execute 'select count(*) from public.refund_allocation_anomalies' into v_count;
  exception when insufficient_privilege then
    v_denied := true;
  end;
  if not v_denied then
    raise exception 'viewer was able to query public.refund_allocation_anomalies';
  end if;

  -- High-privilege authenticated (admin) via Data API role must also be denied
  -- (internal-only diagnostic view, not accessible through browser JWT)
  perform pg_temp.become(v_admin, 'authenticated');
  v_denied := false;
  begin
    execute 'select count(*) from public.refund_allocation_anomalies' into v_count;
  exception when insufficient_privilege then
    v_denied := true;
  end;
  if not v_denied then
    raise exception 'authenticated admin was able to query public.refund_allocation_anomalies directly via Data API role';
  end if;

  -- Superuser (postgres) / service_role must succeed
  perform pg_temp.become(null, 'postgres');
  begin
    execute 'select count(*) from public.refund_allocation_anomalies' into v_count;
  exception when others then
    raise exception 'postgres superuser could not query public.refund_allocation_anomalies: %', sqlerrm;
  end;

  -- ──────────────────────────────────────────────────────────────────────────
  -- 3. Test category_tree_view isolation & runtime storefront RPC parity
  -- ──────────────────────────────────────────────────────────────────────────
  -- Anon direct view read must be denied
  perform pg_temp.become(null, 'anon');
  v_denied := false;
  begin
    execute 'select count(*) from public.category_tree_view' into v_count;
  exception when insufficient_privilege then
    v_denied := true;
  end;
  if not v_denied then
    raise exception 'anon was able to query public.category_tree_view directly';
  end if;

  -- Low-privilege authenticated (cashier) direct view read must be denied
  perform pg_temp.become(v_cashier, 'authenticated');
  v_denied := false;
  begin
    execute 'select count(*) from public.category_tree_view' into v_count;
  exception when insufficient_privilege then
    v_denied := true;
  end;
  if not v_denied then
    raise exception 'cashier was able to query public.category_tree_view directly';
  end if;

  -- Authenticated admin direct view read must be denied
  perform pg_temp.become(v_admin, 'authenticated');
  v_denied := false;
  begin
    execute 'select count(*) from public.category_tree_view' into v_count;
  exception when insufficient_privilege then
    v_denied := true;
  end;
  if not v_denied then
    raise exception 'admin was able to query public.category_tree_view directly';
  end if;

  -- Superuser (postgres) query must succeed
  perform pg_temp.become(null, 'postgres');
  begin
    execute 'select count(*) from public.category_tree_view' into v_count;
  exception when others then
    raise exception 'postgres superuser could not query public.category_tree_view: %', sqlerrm;
  end;

  -- Verify Storefront Category Access:
  -- 1) anon can call storefront_categories_v2 RPC (security definer)
  perform pg_temp.become(null, 'anon');
  begin
    select count(*) into v_count from public.storefront_categories_v2();
  exception when others then
    raise exception 'anon failed to execute storefront_categories_v2(): %', sqlerrm;
  end;

  -- 2) anon direct read on public.categories table is denied (table has no anon grant; access is strictly via RPC)
  v_denied := false;
  begin
    execute 'select count(*) from public.categories' into v_count;
  exception when insufficient_privilege then
    v_denied := true;
  end;
  if not v_denied then
    raise exception 'anon was able to select from public.categories table directly';
  end if;

  -- 3) authenticated can directly read public.categories
  perform pg_temp.become(v_cashier, 'authenticated');
  begin
    select count(*) into v_count from public.categories;
  exception when others then
    raise exception 'authenticated cashier failed to select from public.categories: %', sqlerrm;
  end;

  -- 4) authenticated can call storefront_categories_v2 RPC
  begin
    select count(*) into v_count from public.storefront_categories_v2();
  exception when others then
    raise exception 'authenticated cashier failed to execute storefront_categories_v2(): %', sqlerrm;
  end;

  -- ──────────────────────────────────────────────────────────────────────────
  -- 4. Test backup_manifests capability-gating and security barrier
  -- ──────────────────────────────────────────────────────────────────────────
  -- Anon must be denied table privileges
  perform pg_temp.become(null, 'anon');
  v_denied := false;
  begin
    execute 'select count(*) from public.backup_manifests' into v_count;
  exception when insufficient_privilege then
    v_denied := true;
  end;
  if not v_denied then
    raise exception 'anon was able to query public.backup_manifests';
  end if;

  -- Cashier (authenticated, no view_backups capability) executes SELECT, but sees 0 rows
  perform pg_temp.become(v_cashier, 'authenticated');
  if public.can('view_backups') then
    raise exception 'cashier unexpectedly holds view_backups capability';
  end if;
  select count(*) into v_count from public.backup_manifests;
  if v_count <> 0 then
    raise exception 'cashier without view_backups saw % backup_manifest rows (expected 0)', v_count;
  end if;

  -- Viewer (authenticated, no view_backups capability) executes SELECT, but sees 0 rows
  perform pg_temp.become(v_viewer, 'authenticated');
  if public.can('view_backups') then
    raise exception 'viewer unexpectedly holds view_backups capability';
  end if;
  select count(*) into v_count from public.backup_manifests;
  if v_count <> 0 then
    raise exception 'viewer without view_backups saw % backup_manifest rows (expected 0)', v_count;
  end if;

  -- Admin (authenticated, holds view_backups capability) executes SELECT and can see manifests
  perform pg_temp.become(v_admin, 'authenticated');
  if not public.can('view_backups') then
    raise exception 'admin does not hold view_backups capability';
  end if;
  begin
    select count(*) into v_count from public.backup_manifests;
  exception when others then
    raise exception 'admin failed to select from public.backup_manifests: %', sqlerrm;
  end;

  -- Restore session to postgres superuser
  perform pg_temp.become(null, 'postgres');

  raise notice 'Migration 0090 security hardening verified — refund anomalies & category tree views isolated from Data API, backup manifests protected with security_barrier and view_backups filter, storefront categories operational';
end
$$;
