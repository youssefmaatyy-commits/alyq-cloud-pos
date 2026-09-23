-- ═══════════════════════════════════════════════════════════════════════════
-- ALYQ Cloud POS · Migration 0026
-- Phase 16 — realtime: publish the tables the signed-in app watches.
--
-- Until now "live" meant a 20-second poll for website orders and a mount-time
-- read for everything else. Approve an order in one tab and the other tab's
-- badge stayed wrong until somebody navigated; settle a stuck stock hold and a
-- second till saw the old availability until it reloaded. Supabase Realtime
-- fixes that with one WebSocket per client — but only for tables that are in the
-- `supabase_realtime` publication. A table that is not published produces the
-- quietest failure there is: the channel connects, reports SUBSCRIBED, and never
-- fires. So this migration is the server half of the feature, and
-- `REALTIME_TABLES` in `src/lib/supabase/realtime.ts` is the client half. The
-- two lists must match; both say so in comments.
--
-- What realtime does NOT change:
--
--   * **Row-level security still decides what you hear about.** A subscription
--     carries the session's own token, and Realtime evaluates each table's SELECT
--     policy per row before delivering it. Every table below already has one for
--     `authenticated` (products and stock_movements in 0001, sales_returns and
--     refund_records in 0014, approval_requests in 0012, and the online tables in
--     0017), so a cashier hears about the rows a cashier may read and nothing
--     else. Publishing a table is not exposing it.
--   * **It is an optimisation, not a source of truth.** The client treats an
--     event as "re-read this", through the same repository and the same RLS it
--     always used. A missed event costs freshness; it cannot corrupt state. The
--     existing poll stays as the safety net, slowed down while a channel is up.
--   * **No row shapes change**, so no existing query, function or screen moves.
--
-- Replica identity is left at its default (primary key). The client never reads
-- the `old` record — it re-queries — and FULL identity would write every
-- unchanged column of every product row into the WAL on each sale, which is a
-- real cost for nothing.
-- ═══════════════════════════════════════════════════════════════════════════

do $$
declare
  -- Table, and the screen that goes live because of it.
  wanted text[] := array[
    -- The website queue: a new order, an approval, a cancellation, a completion
    -- and an InstaPay proof that now needs verifying are all rows in this table.
    'online_orders',
    -- An order's timeline, so an open order drawer follows what another member
    -- of staff is doing to the same order instead of showing a stale note.
    'order_events',
    -- Stock holds (Phase 15): availability is stock minus held, so a repaired,
    -- released or restored hold has to reach every till that is selling.
    'stock_reservations',
    -- Pending approvals and the decisions on them — the sidebar badge and the
    -- approval queue both read this.
    'approval_requests',
    -- The refund lifecycle: recorded, settled, rejected.
    'refund_records',
    -- Returns, which a refund is usually filed against.
    'sales_returns',
    -- Stock levels themselves, so a sale at one till moves the number at the
    -- other without anybody reloading.
    'products',
    -- The stock ledger behind those levels.
    'stock_movements'
  ];
  table_name text;
begin
  -- A project without the publication (an older Supabase install, or a local
  -- stack that never created it) is not an error worth failing a deploy over:
  -- the client reports "unavailable" and the app runs on its pollers, exactly as
  -- it did before this migration existed.
  if not exists (
    select 1 from pg_publication where pubname = 'supabase_realtime'
  ) then
    raise warning 'publication supabase_realtime does not exist; realtime stays off and the app polls';
    return;
  end if;

  foreach table_name in array wanted loop
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

-- ── what "published" means for each table ──────────────────────────────────
comment on table public.online_orders is
  'Published to supabase_realtime (0026): the website queue goes live — new orders, approvals, cancellations, completions and payment proofs. Delivered per the staff SELECT policy from 0017.';
comment on table public.stock_reservations is
  'Published to supabase_realtime (0026): a hold written, released, converted or repaired (0025) reaches every screen that shows availability. Delivered per the staff SELECT policy from 0017.';
comment on table public.approval_requests is
  'Published to supabase_realtime (0026): the pending-approvals badge and queue follow a decision made anywhere, including another tab.';
comment on table public.refund_records is
  'Published to supabase_realtime (0026): the refund lifecycle — recorded, settled, rejected — updates wherever it is shown.';
