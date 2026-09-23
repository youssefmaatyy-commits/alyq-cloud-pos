# Phase 53 — Profit, Margin, Best Sellers & Slow Movers

**Date:** 2026-09-23 · **Branch:** `arena/01a0cb74-alyq-cloud-pos` · **Base:** `222f33e62a4f6ff36f1ab781aa7beda3a7765e01` (`arena/01a0a01f-alyq-cloud-pos`)

---

## 1. Complete?

**YES — READY** for the session branch. Profitability is live in demo and in the live schema (migration 0055). Canonical is not pushed. Hosted Supabase is not deployed.

## 2. Base SHA

`222f33e62a4f6ff36f1ab781aa7beda3a7765e01`

## 3. What shipped

- **Management KPIs:** Gross Sales, Total Discounts, Net Sales, COGS, Gross Profit, Gross Margin %, Units Sold, Sales/Orders Count, AOV. Delivery fees collected and free-shipping given sit beside them, **not** inside product margin.
- **Historical cost:** `sale_items.unit_cost` is frozen at `pos_complete_sale` (variant override ?? product cost). Existing rows stay `NULL` — unknown, never free, never rewritten from today's catalogue. Client arithmetic (`buildProfitability`) is the authority; RPCs return additive sums only; margins stay in TypeScript (`share()`).
- **Date filters:** Today / Yesterday / Last 7 / Last 30 / This Month / Previous Month / Custom, as complete local calendar days via `presetRange` / `toTimestampBounds`.
- **Channel:** All / POS / Online (`sale.source`).
- **Product + exact-variant profitability:** Gold/17 and Silver/17 never collapse.
- **Best sellers:** real transactions, ranked Units then Net Sales. Featured is not consulted.
- **Slow movers:** stock > 0 and no sales in 30/60/90 lookback; last sale, days since, units, stock value. Not mixed with Low / Out of Stock.
- **Discount impact:** Automatic promotions / Promo codes / Manual POS item / Manual POS invoice — never double-counted.
- **Returns:** reduce realized net/units/COGS with the refunded amounts, once, on the exact variant. Rejected refunds count nowhere. Voided/cancelled/unrealized sales are excluded (`revenueSales` + realized online `sale_id`).
- **Charts:** Net Sales, Gross Profit, Sales vs Profit, Discount Trend — UTC calendar-day grouping.
- **Drill-down:** row click → `#/products/{id}`.
- **Export:** existing `ExportButton` / `buildSheets` architecture; cost/profit/margin omitted without `view_cost` (`canAct`, no role names).
- **UI tab label is `Profitability`:** smoke `clickTab` uses `startsWith`, and `"Products".startsWith("Profit")` is true.

## 4. Stocktake audit (Phase 52)

**LIVE persistence is missing.** Stocktake history is demo/local only: `localStorage` key `alyq.inventory.stocktakes.v1` in `src/modules/inventory/services/stocktake.ts`. There is no Supabase table/RPC for stocktake sessions.

**Final Audit blocker.** This phase did not rewrite stocktake.

## 5. Files

| Path | Role |
| --- | --- |
| `supabase/migrations/0055_sale_item_unit_cost_profitability.sql` | `sale_items.unit_cost`, snapshot in `pos_complete_sale`, profitability RPCs (`can('view_reports')`) |
| `src/modules/reports/services/profitability.ts` | Client authority |
| `src/modules/reports/services/profitabilityExport.ts` | Workbooks |
| `src/modules/reports/components/tabs/ProfitabilityTab.tsx` | Profit tab |
| `src/modules/reports/pages/AdvancedReportsPage.tsx` | Tab + one `listOrders()` |
| `src/modules/reports/__tests__/profitability.selftest.ts` | Acceptance fixtures |
| `src/lib/i18n/dictionary.ts` | EN + AR keys |

## 6. Verification

| Check | Result |
| --- | --- |
| `npm run typecheck` | PASS |
| `npm test` | PASS — 37/37 suites (profitability fixtures included) |
| `npm run db:check` | PASS — 55 migrations, 0001–0055 apply twice, role scenarios, column parity (`sale_items` 23 cols incl. `unit_cost`) |
| `npm run test:e2e` | PASS — all 19 suites (smoke includes the Profitability tab + workbook; remaining suites re-run after a 600s wall-clock cut during branding) |
| `npm run build` | PASS — `dist/index.html` 3,067.80 kB (gzip 808.59 kB) |
| `npm run lint` | 0 errors, 35 pre-existing warnings |
| `npm run test:rendered` | **FAIL — environment:** Playwright Chromium missing at `/home/user/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell`. Message: “Looks like Playwright was just installed or updated. Please run `npx playwright install`.” Not an app defect. |

Acceptance fixtures in `profitability.selftest.ts`:

- Gross 1000 − auto 100 − manual 50 = Net 850, COGS 500, profit 350, margin 41.18%; catalogue cost 999 is ignored.
- Partial refund of a 2-unit sale: net 425, units 1, COGS 250 — subtracted once.
- Gold/17 = 5 and Silver/17 = 2 independent.
- Units rank A(10/5000) above B(4/6000); net-sales rank reverse; Featured does not jump the order.
- Slow Variant A stock 12 with no 90-day sales appears; a recently sold sibling does not; stock 0 does not.

## 7. Not done (deliberate)

- Did not deploy 0055 to hosted Supabase.
- Did not push canonical.
- Did not reset/rebase/force-push.
- Did not rewrite stocktake.
- Did not backfill historical `unit_cost` (unknown stays unknown).
- Ranking is TypeScript-only; RPCs stay additive.

## 8. Permissions

Cost, COGS, profit and margin hide without `view_cost`. The screen still requires `view_reports` (existing advanced-reports gate). Export uses `authority="report"` (`export_reports`). No hardcoded role names.
