-- ═══════════════════════════════════════════════════════════════════════════
-- ALYQ Cloud POS · Migration 0027
-- Phase 16 follow-up — realtime coverage: publish `sales`.
--
-- 0026 published the tables behind the online queue, approvals, refunds, returns
-- and stock. A review of what staff actually watch turned up one gap: the sales
-- ledger itself. Completing a website order writes a `sales` row, a card payment
-- confirmation updates one, settling a refund is filed against one, and the
-- Sales screen (`/pos/sales`) plus the dashboard's revenue tiles read it. None of
-- those movements reached a second till until it reloaded or its own poll fired,
-- which is exactly the class of staleness realtime exists to remove.
--
-- What is deliberately NOT published:
--
--   * `sale_payments` — a payment row is never the interesting event on its own.
--     Confirming an InstaPay proof writes the sale it belongs to (0008), and
--     `pos_complete_sale` writes the sale with its payments in one transaction, so
--     the `sales` row above already carries every payment change a screen reacts
--     to. Publishing the child table too would double the WAL traffic on the
--     busiest write in the system for no additional freshness.
--   * Anything else. Realtime is an optimisation, not a source of truth: every
--     extra table is a row-shaped cost on every write, so the list stays exactly
--     as long as the screens that go live because of it.
--
-- As in 0026: row-level security still decides what anybody hears. `sales` has
-- had `sales_select_authenticated` since 0007 (`for select to authenticated using
-- (true)`) and `grant select` since 0015, so a signed-in client receives the rows
-- it may already read and nothing more. No row shapes change, no existing query,
-- function or screen moves, and replica identity stays at its default (primary
-- key) because the client re-queries rather than reading the `old` record.
--
-- The client half of this is `REALTIME_TABLES` in
-- `src/lib/supabase/realtime.ts`; a self-test scans *every* migration for tables
-- added to the publication and fails if the two lists disagree.
-- ═══════════════════════════════════════════════════════════════════════════

do $$
declare
  -- Table, and the screen that goes live because of it.
  wanted text[] := array[
    -- The sales ledger: a POS sale, a website order completed into a sale, a card
    -- or InstaPay confirmation, and the sale a refund or return is filed against.
    'sales'
  ];
  table_name text;
begin
  -- No publication (an older Supabase install, or a local stack that never
  -- created one) is not worth failing a deploy over: the client reports
  -- "unavailable" and the app runs on its pollers exactly as before.
  if not exists (
    select 1 from pg_publication where pubname = 'supabase_realtime'
  ) then
    raise warning 'publication supabase_realtime does not exist; realtime stays off and the app polls';
    return;
  end if;

  foreach table_name in array wanted loop
    -- Idempotent in both directions: a table that is already published is left
    -- alone (`alter publication ... add table` would raise a duplicate error),
    -- and a table that does not exist yet is skipped rather than failing the
    -- migration for a project that has not run 0007.
    if exists (
      select 1 from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = table_name and c.relkind = 'r'
    ) and not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = table_name
    ) then
      execute format('alter publication supabase_realtime add table public.%I', table_name);
      raise notice 'published public.% to supabase_realtime', table_name;
    end if;
  end loop;
end $$;

comment on table public.sales is
  'Published to supabase_realtime (0027): a sale written at one till, a website order completed into a sale, and a payment confirmation all reach the Sales screen and the revenue tiles without a reload. Delivered per sales_select_authenticated from 0007.';
