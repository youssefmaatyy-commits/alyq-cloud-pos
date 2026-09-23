-- ═══════════════════════════════════════════════════════════════════════════
-- ALYQ Cloud POS · 0031 — the category insert gate, completed
--
-- 0030 gated every catalogue write behind public.can(). For the category insert
-- it created a policy under a NEW name (`categories_insert_authenticated`) and
-- dropped only the name it knew about. The original gate from 0003 —
-- `categories_write_authenticated`, `for insert to authenticated with check
-- (true)` — was left standing beside it.
--
-- Row level security ORs the policies that apply to a command, so a single open
-- policy defeats every gated policy next to it. The result: a viewer, who holds
-- no write capability of any kind, could still insert a category with a forged
-- request. Nothing noticed, because the UI never offers the button —
-- catalogService.ts requires `add_product` first, and actions.ts already
-- declares the database rule as "RLS insert on categories — add_product". The
-- policy set simply disagreed with the rule the application documented.
--
-- Dropping the stale policy leaves `categories_insert_authenticated` as the one
-- insert gate, which is the rule the app already enforces in the UI. The
-- `drop … if exists` / `create` pair below is restated rather than assumed so
-- this migration states the end condition on its own, and re-applies cleanly.
--
-- Nothing else writes categories. The only other inserts in the repository are
-- the migration seed (0003) and the test fixture (supabase/tests/scenarios.sql),
-- both of which run as the table owner and bypass row level security by design.
-- No security-invoker function touches the table, so no definer path loses a
-- write it depends on.
-- ═══════════════════════════════════════════════════════════════════════════

-- The gate 0030 intended: adding a shelf is catalog authoring, so it rides the
-- product verbs. There is no `add_category` capability in the matrix and
-- inventing one here would fork it.
drop policy if exists "categories_write_authenticated"   on public.categories;
drop policy if exists "categories_insert_authenticated"  on public.categories;

create policy "categories_insert_authenticated"
  on public.categories for insert to authenticated
  with check (public.can('add_product'));

comment on policy "categories_insert_authenticated" on public.categories is
  'The single category insert gate. 0003 left an OR''d `with check (true)` policy '
  'beside this one; 0031 removes it, because RLS ORs policies and one open policy '
  'defeats every gated policy next to it.';
