-- ═══════════════════════════════════════════════════════════════════════════
-- ALYQ Cloud POS · Migration 0022
-- Phases 11–14 — business control: the database half of the enforcement,
--                approval and oversight work the app does in its service layer.
--
-- The rule this file follows is the one 0016 set for refunds: the app refuses
-- an action because a capability says so, and the database refuses the same
-- action because a trigger or a `security definer` function says so. Hiding a
-- button is a courtesy; two independent refusals are a control.
--
-- What this file ADDS (sections are appended as each increment lands)
--   * audit vocabulary for a sales return (`return.created` → entity `return`),
--     which `src/modules/returns/services/returnService.ts` writes in both demo
--     and live mode — no database function writes it, unlike the refund
--     settlement rows 0016 already stamps. The migration check diffs
--     `public.audit_actions` against `AUDIT_ACTIONS` in
--     `src/modules/audit/types.ts` row for row, so neither side can move alone.
--
-- What this file DELIBERATELY DOES NOT DO
--   * it does not rewrite `refund_records`, `sales_returns`, `shifts` or
--     `expenses`. Their invariants (0010, 0012, 0016) already hold and are
--     already tested; this phase adds the decisions people make about them,
--     not new copies of the tables.
--   * it does not add a second audit trail. Every row goes to `audit_log`.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── audit vocabulary · returns ──────────────────────────────────────────────
-- A return is the goods side of a refund: stock goes back on the shelf and a
-- refund row opens. Tracking it separately from `refund.created` is what lets
-- the audit screen answer "who accepted this back?" without reading money.
insert into public.audit_actions (action, entity) values
  ('return.created', 'return')
on conflict (action) do nothing;
