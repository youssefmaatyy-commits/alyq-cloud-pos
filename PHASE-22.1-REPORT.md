# Phase 22.1 — Reports data path: aggregation moved into PostgreSQL

**Branch:** `arena/01a09298-alyq-cloud-pos` · **Base:** `ef605d4` (Phase 22)
**Scope:** reporting data processing only. No new business features, no architecture change.

---

## 1. The defect, measured

The reports screen answered *"what did we take this month?"* by fetching invoices and
summing them in the browser. `SALES_ROW_CAP` limits that read to the most recent
**1,000** invoices, so on any real book the totals were computed from a slice.

Phase 22 made the truncation *visible* rather than silent. This phase removes it.

The differential suite measures the gap on a 2,500-invoice dataset:

| | revenue invoices | revenue |
|---|---|---|
| what the browser could see | 960 | 657,569.85 EGP |
| what the period actually held | 2,399 | 1,797,821.65 EGP |
| **never reached the totals** | **1,439** | **1,140,251.80 EGP** |

A visible wrong number is still a wrong number. The tiles now come from the database,
which sums every invoice in the window where the rows already are.

---

## 2. What was built

**`supabase/migrations/0032_report_aggregates.sql`** — five RPCs, and only five: one per
aggregate the existing reports actually render. Nothing speculative was added.

| RPC | Mirrors (in `src/`) | Feeds |
|---|---|---|
| `reports_financial_summary(p_from, p_to)` | `computeFinancialTotals()` | Financial report tiles, dashboard monthly KPIs |
| `reports_sales_summary(p_from, p_to, p_timezone)` | `salesByPaymentMethod()`, `salesByEmployee()`, `salesTrend()` | Sales tab: totals, payment mix, per employee, per day |
| `reports_product_performance(p_from, p_to)` | `productPerformance()` | Product tab |
| `reports_inventory_summary()` | `stockValueTotals()` | Inventory valuation |
| `reports_expense_summary(p_from, p_to, p_timezone)` | `buildExpenseReport()` | Expense tab |

Six supporting indexes were added (`sale_items.sale_id`, `sale_items.product_id`,
`sale_payments.sale_id`, `expenses.spent_at`, `sales_returns.created_at`,
`refund_records.created_at`) — a total over three years is only fast if the period can be
sought rather than scanned.

**`src/modules/reports/services/reportAggregates.ts`** — the only place in the app that
calls them. It maps jsonb into the app's *existing* types (`FinancialTotals`,
`PaymentMethodSalesRow`, `EmployeeSalesRow`, `TrendPoint`, `ProductPerformanceRow`,
`StockValueTotals`, `ExpenseBreakdownRow`, `ExpenseDayRow`), so no screen had to learn a
new shape.

---

## 3. Four design decisions, and why

**1. `SECURITY INVOKER`, not `SECURITY DEFINER`.**
The brief allowed definer "where needed". It is not needed anywhere here, and using it
would have been a regression: these functions *aggregate*, and an aggregate is exactly
the operation that leaks rows a definer function can see but the caller cannot. As
invoker, RLS applies to every row inside the aggregate — a caller who may not see the
expense book aggregates an empty set, not somebody else's spending. Each function still
pins `set search_path = public` and opens with `public.can('view_reports')`, which is the
same gate every report policy has always used. It is never bypassed, re-implemented or
approximated.

**2. Additive parts only.**
The RPCs return counts, units and sums of money. Percentages, averages and margins are
computed in the browser with the app's own `share()` and `roundMoney()`. Two definitions
of "margin" is how a report starts disagreeing with itself, and on the day it happens
nobody can say which number is real. `share()` was made `export`ed for this — one
definition, now shared by both paths.

**3. Mirror the existing semantics exactly, including the awkward ones.**
Not the semantics a cleaner design would have. Specifically:
- an invoice with **no payment rows** is attributed wholly to its own
  `payment_method`/`payment_status` (`paymentTotals()`' legacy fallback);
- `productPerformance` gives **every catalogue product** a row, sold or not — so the SQL
  left-joins the shelf rather than the sales;
- `stockValue` uses the **raw** `stock_quantity` while `stock` is gated on
  `stock_tracking_enabled`, and the two deliberately disagree for an untracked product;
- product cost is units × the product's **current** cost, not the cost at sale time;
- payment-method rows come back in `PAYMENT_METHODS` order (the `payment_method` enum is
  declared in exactly that order, so the enum's own ordering *is* the app's ordering);
- expense categories are **zero-filled** across all five known categories in the app's
  order, while employees and branches read biggest-first — because `breakdown()` reserves
  biggest-first for open-ended keys and a known vocabulary reads in catalogue order.

**4. The caller owns "what a day is" — and names its timezone.**
`dayKeyOf` buckets by the *browser's* local calendar day. The bounds already arrive as
absolute instants from `toTimestampBounds()`, but bucketing needs to know which local day
an instant falls in, so the caller's IANA zone name travels with the request.

---

## 4. A bug this phase caught in itself

The first draft of 0032 took **`p_tz_offset_minutes`** — the caller's UTC offset — and
was wrong for roughly half the year.

Egypt observes daylight saving: Cairo is +2 in winter and +3 in summer. A report window
that spans April or October therefore contains **two** offsets, and any single number
moves every late-evening invoice of the other season into the wrong day. Nothing throws;
the day series simply disagrees with the one the browser drew. It is the same silent
failure `dateRanges.ts` warns about, one layer down.

The differential suite caught it the moment it ran against a Cairo-pinned dataset across a
400-day window: **every money total and every breakdown agreed, and only the day-bucketed
series diverged** — 11 of 89 comparisons, all of them `byDay`/`activeDays`. That signature
is what identified the cause rather than merely reporting a failure.

The parameter is now `p_timezone text`, bucketing uses `AT TIME ZONE`, and Postgres
applies the correct offset per timestamp. An unrecognised zone degrades to UTC rather than
failing the report. §6 of the suite asserts the parameter is *load-bearing*: bucketing the
same window in UTC must move invoices between days, or the zone name is decoration.

---

## 5. The differential suite

**`scripts/reports.aggregates.mjs`** (+ `scripts/lib/reportAggregates-entry.ts`), registered
as the `reports` suite in `npm run test:e2e`.

It boots a real PostgreSQL (PGlite) with all 32 migrations, the shim and the seed, writes a
deterministic dataset, then runs **both paths against the same rows** and compares them
field by field:

- **TypeScript** — the actual shipped functions, bundled from `src/` by esbuild. Not
  re-implemented for the test: re-deriving the numbers inside the test would prove only
  that the test agrees with itself.
- **PostgreSQL** — the five RPCs, given nothing but the window.

Dataset: **2,500 invoices** across 400 days, 6,136 lines, 2,638 payment rows, **317
invoices with no payment rows at all**, 220 expenses, 6 returns, 6 refunds (completed,
pending *and* rejected), and three catalogue products placed to pin down semantics a join
could silently change: one untracked-but-stocked, one never sold, one below its threshold.

Deliberately exercised, because these are where an aggregate quietly drifts: split
payments (cash + visa on one invoice), voided invoices, the legacy payment fallback with
*varying* method and status (a rewrite that hardcodes `cash`/`paid` would still pass),
products that never sold, and day bucketing at a non-UTC offset.

Six windows: all-time, a year-plus span, one calendar month, the last 30 days, a single
day, and **an empty window in 2019** (zeros and empty arrays — not nulls, not an error).

**Result: 91 comparisons agree.** Breakdown per window: financial totals; sales totals;
payment mix; per employee; per day trend; product performance; expense tiles, by category,
by method, by employee, by branch, by day, and the single largest expense; plus the
inventory snapshot, the cap proof, the timezone proof, the two payload assertions and six
permission assertions.

The suite runs in both Arabic and English data: product and expense names are written in
Arabic (`غير متتبع`, `مخزون منخفض`), staff names and the em-dash fallback label (`—`)
travel through the aggregates, and the AR/EN copy added in §7 is asserted by the existing
i18n coverage.

---

## 6. Security verification

Three independent layers, because a permission test that passes for the wrong reason is
worse than none.

**In the suite (§7):**

| caller | result |
|---|---|
| admin | all five answer |
| viewer | all five answer — `view_reports` is granted to **all five** system roles |
| authenticated, no profile | refused (`can()` fails closed) |
| anon | refused (no `EXECUTE` grant at all) |
| **cashier narrowed by a custom role without `view_reports`** | **all five refused** |

The last row is the one that matters. `can()` lets an *active custom role* decide
absolutely, so a gate that read `profiles.role` instead would pass every other assertion
and still leak the whole report book to a narrowed user. Note that every built-in role
holds `view_reports` — viewer included, because "may see the numbers" is what that role is
*for* — so there is no built-in negative case, and inventing one would have tested
nothing.

**In `supabase/tests/scenarios.sql`** (so `npm run db:check` proves it on every run): the
same five refusals, plus a **payload shape assertion** for each RPC. A report that starts
returning a column nobody asked for — a customer's phone, an employee's contact, a cost the
screen never shows — fails no arithmetic test anywhere, because every number it returns is
still correct. Only a shape assertion catches it, and it catches it the day it is added.
The narrowing is performed through the real admin RPCs, not by writing the tables:
`custom_roles` has no INSERT grant for `authenticated`, because a role list is exactly what
a browser must not be able to edit directly.

**Mutation-tested.** Weakening one gate to `profiles.role = 'admin'` makes `db:check`
**fail**; restoring it passes. The scenario has teeth.

Grants: `revoke execute … from public` *first*, then grant to `authenticated` and
`service_role`. Default privileges would otherwise hand `EXECUTE` back to every role,
which is how a gate quietly stops being one.

---

## 7. Frontend wiring

Kept in the browser, as the brief required: UI rendering, filters, pagination controls and
export formatting. Only the arithmetic moved.

**`ReportsPage.tsx`** — the financial totals now come from `reports_financial_summary`,
with `computeFinancialTotals` over the fetched rows as the fallback. The row read, its
`SALES_ROW_CAP` and the exact `countSales` beside it are unchanged, because the invoice
*list* and the exports still need rows. What changed is that the cap now limits what the
page can **list**, not what it can **count**.

The coverage notice was the honest part of Phase 22 and stays honest: its hint said *"Every
total on this page covers the sales shown, not the whole period."* That is no longer true
when the database answered, so a second string was added (`reports.salesCoverageHintAggregated`,
EN + AR) and the notice picks between them. The page never claims more coverage than it has.

**`DashboardPage.tsx` / `dashboardQuery.ts`** — the monthly KPI tile now prefers the
database's month. `computeMonthlyKpis` was already a pure mapping over `FinancialTotals`, so
that mapping was extracted as `monthlyKpisFromTotals()` and both sources flow through it:
the tile cannot drift from the report it summarises whichever way it was filled.

**Fallback semantics.** Every function returns `{ ok: true, value } | { ok: false, reason }`
— never throws, never returns a partial number. Demo mode, a project whose migrations
predate 0032, and a caller without `view_reports` all fall back to the arithmetic the screen
already had. Falling back is not a privilege escalation: it computes over rows the caller was
already allowed to read, and RLS gates the RPCs through the same `public.can()`.

---

## 8. Performance

Measured inside the suite (§8), on the 2,500-invoice dataset, all-time window. PGlite is
in-process, so this measures **work and payload, not network latency**.

| | rows moved | payload | time |
|---|---|---|---|
| browser path | 11,274 | 1,759.3 KB | 99 ms pull + 15 ms arithmetic = **114 ms** |
| database path | 5 aggregates | **47.6 KB** | **137 ms** |

**Payload: 37× less to move**, and none of it retained afterwards — the browser path holds
every invoice in memory for as long as the screen is open, then throws them away. Over a
real connection the row path additionally pays to serialise and transfer 1.7 MB, which only
widens this gap.

Reported honestly: in-process wall-clock is **comparable, not better** (137 ms vs 114 ms).
PGlite is WASM Postgres with no network and no query cache, and the figure is five sequential
RPC calls in one transaction. The claim this phase can defend is *less data moved, less
memory held, and correct totals* — not "faster in every environment". The correctness win is
the decisive one and is not environment-dependent: the browser path could not produce these
totals at all without exceeding its own row cap.

Both payload assertions are checked by the suite, so a future change that starts shipping an
invoice list inside an "aggregate" fails the run.

---

## 9. Gates

| gate | result |
|---|---|
| `npm run typecheck` | ✓ clean |
| `npm test` | ✓ every logic selftest passes (reports coverage 10/10, dashboard 29/29, POS 34/34, returns 20/20, expenses, inventory, online, settings, shifts, backup 28/28, Excel import 29/29, products 51) |
| `npm run build` | ✓ 394 modules, `dist/index.html` 2,448.82 kB (gzip 656.88 kB) |
| `npm run db:check` | ✓ **32 migrations** apply cleanly, are idempotent, and satisfy the application; every role scenario passes including the new report-aggregate one; capability-matrix, audit-vocabulary, role-alias and seed parity all hold |
| `npm run test:e2e` | ✓ **6/6 suites** (smoke, auth, store, backup, crash, **reports**) |
| `npm run lint` | ✓ 0 errors, 23 warnings — unchanged from the Phase 22 baseline |

---

## 10. Scope compliance

Not modified: the ALYQ storefront design, the POS, the inventory workflow, the orders
workflow, the permissions architecture, the backup system, and the existing security fixes.

`src/modules/pos/data/repository.ts` was **read, not changed** — `SALES_ROW_CAP` and
`SaleListQuery` are imported by the reports module, and the sales contract has no second
data path. `salesAnalytics.ts` gained only an `export` keyword and a doc comment on
`share()`. `scenarios.sql` gained only a new block. No business feature was added; no
architecture was rewritten.

---

## 11. Known limitations

- **The invoice list is still capped.** The tiles are complete; the *table* of invoices and
  the exports still read at most `SALES_ROW_CAP` rows, and the coverage notice says so.
  Paging the list itself is a UI change beyond this phase's scope.
- **Tie-breaking on equal values.** Where the TypeScript keeps first-seen order among exact
  ties (the largest expense of a day), the SQL orders by `amount desc, id`. Identical for
  all tested data; it can only differ on an exact money tie, and both orders are
  deterministic.
- **`byBranch` has no zero-fill**, matching `breakdown()`: a branch with no spending in the
  window does not appear. Categories do, because `byCategoryRows()` zero-fills them.
- **Live-project checks still need real Supabase credentials.** Everything here was proven
  against PGlite with the production grant set and the shim's auth stand-ins.
- `xlsx@0.18.5` remains the npm latest, as in Phase 22.

---

## 12. Files

**Added**
- `supabase/migrations/0032_report_aggregates.sql` — the five RPCs, grants, indexes
- `src/modules/reports/services/reportAggregates.ts` — the only caller of them
- `scripts/reports.aggregates.mjs` — the differential suite (§1–§8)
- `scripts/lib/reportAggregates-entry.ts` — bundles the shipped builders for the suite

**Modified**
- `src/modules/reports/pages/ReportsPage.tsx` — totals from the database, honest notice
- `src/modules/dashboard/DashboardPage.tsx` — monthly tile from the database
- `src/modules/dashboard/dashboardQuery.ts` — `monthlyKpisFromTotals()` extracted
- `src/modules/reports/services/salesAnalytics.ts` — `share()` exported
- `src/lib/i18n/dictionary.ts` — `reports.salesCoverageHintAggregated` (EN + AR)
- `supabase/tests/scenarios.sql` — report-aggregate scenario (gate + payload shape)
- `scripts/test.e2e.mjs` — the `reports` suite registered
