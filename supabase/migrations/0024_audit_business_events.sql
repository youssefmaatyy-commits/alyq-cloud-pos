-- ═══════════════════════════════════════════════════════════════════════════
-- ALYQ Cloud POS · Migration 0024
-- Phase 13 — audit expansion: the vocabulary for the acts that move money or
--            stock without creating a document of their own.
--
-- Until now the trail could answer "who settled this refund?" and "who asked
-- for this over-limit discount?" but not "who took 20% off invoice 41?", "who
-- voided it?", "who moved the retail price of the 250 g coffee?", or "who wrote
-- the shelf count into the system?". Those acts are performed by the same
-- service funnels that assert the capabilities (`saleService`, `catalogService`,
-- `inventoryService`), so the app writes the rows in demo mode and live mode
-- alike — no database function is involved, exactly as with `return.created`
-- in 0022.
--
-- What this file adds is only the *vocabulary*: `audit_log.action` references
-- `public.audit_actions(action)`, and the insert trigger derives `entity` from
-- that table, so an action the app can emit must exist here or the audit write
-- fails at runtime — after the money has moved. The migration check diffs this
-- table against `AUDIT_ACTIONS` / `AUDIT_ENTITIES` in
-- `src/modules/audit/types.ts` row for row, so neither side can move alone.
--
-- What this file deliberately does NOT do
--   * it does not add a second audit trail, a second log table, or a trigger
--     that writes these rows. Every entry goes to `public.audit_log`.
--   * it does not widen read access: `audit_log` stays readable only by whoever
--     `public.can('view_audit_log')` says may read it (0013, 0014).
--   * it is idempotent, like every migration here: re-running it changes nothing.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── audit vocabulary · sales ────────────────────────────────────────────────
-- A discount is a price the shop chose not to charge, and a void is an invoice
-- the shop chose to un-sell. Both are already capability-gated
-- (`apply_discount`, `void_sale`); these rows record that the gate was passed,
-- by whom, and with what numbers.
insert into public.audit_actions (action, entity) values
  ('sale.discounted', 'sale'),
  ('sale.voided',     'sale')
on conflict (action) do nothing;

-- ── audit vocabulary · catalogue prices ─────────────────────────────────────
-- Retail and purchase cost are separate actions because they answer different
-- questions: a price move is a margin decision somebody will ask about, a cost
-- move is a supplier fact that changes every past profit figure. The register
-- already treats them as two sensitive actions (`product.price_change`,
-- `product.cost_change`) and the approval rule names the field that moved.
insert into public.audit_actions (action, entity) values
  ('product.price_changed', 'product'),
  ('product.cost_changed',  'product')
on conflict (action) do nothing;

-- ── audit vocabulary · stock ────────────────────────────────────────────────
-- One funnel (`inventoryService.adjustStock`) writes both: a `recount` reason is
-- the correction case — the shelf and the system disagreed — and every other
-- reason is an adjustment. Keeping them as two actions is what lets the trail
-- answer "who fixed the stock?" without reading movement reasons.
insert into public.audit_actions (action, entity) values
  ('stock.adjusted',  'stock'),
  ('stock.corrected', 'stock')
on conflict (action) do nothing;
