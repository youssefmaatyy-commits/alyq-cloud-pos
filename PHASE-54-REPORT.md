# Phase 54 — End-of-Day Cashier & Shift Reporting

**Date:** 2026-09-23 · **Branch:** `arena/01a0cb74-alyq-cloud-pos` · **HEAD before this commit:** `dcbc881` (Phase 53)

---

## 1. Complete?

**YES — READY** on the existing shifts module. No second architecture. No migration 0056. Canonical is not pushed. Hosted Supabase is not deployed.

## 2. Formula (drawer only)

```
Expected Cash = opening cash + cash sales − cash refunds − cash expenses
```

InstaPay, Visa/card and COD never enter expected cash. Discounts are reported in four buckets and are **not** subtracted again after net paid cash. Difference = actual − expected (Over / Short / Exact).

Acceptance: 500 + 1000 − 50 − 100 = **1350** expected; actual **1330**; difference **−20**.

## 3. What shipped

- **Shift summary:** id, opened/closed by/at, status, opening cash, sales count, gross, four discount buckets + total, net, returns/refunds (cash vs non-cash), expenses, cash / InstaPay / Visa / other, expected, actual, difference.
- **Sale attribution:** `sale.shift_id` is authority; online sales without a till shift stay out; legacy POS rows without `shift_id` still use the opening/close window.
- **Close UX:** count → **Review close** (opening, cash sales, cash refunds, cash expenses, expected, actual, difference) → explicit **Confirm close**. Never a silent close.
- **Frozen snapshot:** closed `summary` is padded for new fields, never recomputed. Audit `shift.closed` records opening, cash sales/refunds/expenses, expected, actual, difference — not UI math.
- **Owner EOD:** `/shifts/eod` (`view_shifts`), Today + custom complete local calendar days via existing `DateRangePicker`. Closed shifts aggregate; each drawer stays a row; total difference is the **sum of each closed difference**. Open shifts are pending — actual cash is unknown, never pretended.
- **History:** all statuses, pending badge, per-shift export, EOD link. Sales home card `shift-eod` (no extra sidebar item).
- **Export:** shift detail + EOD workbooks on the existing `ExportButton` / `buildSheets` path (`authority="report"`).

## 4. Stocktake (Phase 52)

**Unchanged.** History is still demo/local (`alyq.inventory.stocktakes.v1`). **Final Audit blocker.** This phase did not rewrite stocktake.

## 5. Schema

Existing `shifts.summary` JSON + `closing_cash` already persist the close snapshot. **No 0056.** Migrations 0001–0055 intact.

## 6. Files

| Path | Role |
| --- | --- |
| `src/modules/shifts/types.ts` | Gross/net/discount/visa/other on `ShiftSummary` |
| `src/modules/shifts/services/shiftCalculations.ts` | Belonging, buckets, pad, visa/other, formula |
| `src/modules/shifts/services/endOfDay.ts` | Closed totals + pending list |
| `src/modules/shifts/services/eodExport.ts` | Detail + EOD sheets |
| `src/modules/shifts/components/CloseShiftModal.tsx` | Two-step review → confirm |
| `src/modules/shifts/components/ShiftSummaryGrid.tsx` | Gross / discounts / net / visa |
| `src/modules/shifts/hooks/ShiftProvider.tsx` | Pad frozen snapshots; richer close audit |
| `src/modules/shifts/pages/EndOfDayPage.tsx` | Owner EOD |
| `src/modules/shifts/pages/ShiftHistoryPage.tsx` | Pending + detail export |
| `src/modules/shifts/__tests__/eod.selftest.ts` | 1350/−20, discounts, two closed + open |
| `src/lib/i18n/dictionary.ts` | EN + AR keys |
| `src/App.tsx`, `routes.ts`, `preview.ts`, `moduleHomes.tsx` | `/shifts/eod` |

## 7. Verification

| Check | Result |
| --- | --- |
| `npm run typecheck` | PASS |
| `npm test` | PASS — 38/38 suites (6/6 Phase 54 EOD + 18/18 Phase 8) |
| `npm run db:check` | PASS — 55 migrations, 0001–0055 apply twice |
| `npm run test:e2e` | PASS — **19/19** (smoke: two-step close + EOD lists SH-000002) |
| `npm run build` | PASS — `dist/index.html` 3,092.16 kB (gzip 813.59 kB) |
| `npm run lint` | **0 errors**, 35 pre-existing warnings |
| `npm run test:rendered` | **FAIL — environment:** Playwright Chromium missing at `/home/user/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell`. Message: “Looks like Playwright was just installed or updated. Please run `npx playwright install`.” Not an app defect. |

## 8. Not done (deliberate)

- Did not deploy Supabase.
- Did not push canonical.
- Did not reset/rebase/force-push.
- Did not rewrite stocktake.
- Did not invent payment methods or a second shift lifecycle.
