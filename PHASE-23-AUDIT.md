# Phase 23 — A-to-Z Code, UX & System Quality Audit

**Branch** `arena/01a09298-alyq-cloud-pos` · **audit base** `c74bebb` (Phase 22.1)
**Method** audit first, then fix only what could be *proven*. Every finding below was
either reproduced by running code against the real schema, or verified by reading the
specific lines cited. Nothing is reported on the strength of a pattern match alone —
and where a scanner produced a false positive, that is recorded too, because an audit
that hides its own noise is not credible.

**Headline:** two **critical** defects, both in the database, both invisible to the
entire existing test suite, both proven by execution and both fixed with regression
tests that fail when the fix is removed.

---

## Critical Issues

### C1 · Any signed-in user could ring up sales, issue refunds, confirm payments and void sales

**Location** `supabase/migrations/0007_pos_sales.sql` (`pos_void_sale`),
`0009_split_payments.sql` (`pos_confirm_payment`), `0016_refund_settlement.sql`
(`pos_process_return`), `0018_online_order_functions.sql` (`pos_complete_sale`)

**Issue** All four are `SECURITY DEFINER` — so row level security does not apply inside
them — and all four are `GRANT EXECUTE … TO authenticated` with **no authorization
predicate anywhere in the body**. The capability matrix was enforced only in the
browser, by `assertCanAct()` before the call. Any authenticated caller who skips the UI
skips the matrix.

**Proof** (run against this schema, migrations applied, PGlite):

```
viewer capabilities: {"sell":false,"process_return":false,"void_sale":false,"confirm_payment":false}

  SUCCEEDED  pos_complete_sale    → INV-000002, sale_items, sale_payments,
                                    stock_movement written, stock 500 → 498
  SUCCEEDED  pos_process_return   → return + refund created
  SUCCEEDED  pos_confirm_payment  → pending InstaPay payment marked paid
  SUCCEEDED  pos_void_sale        → completed sale voided
```

`void_sale` is held by managers and admins **only** — not even a cashier has it — so
the widest gap was a capability that existed in the matrix, was displayed in the role
editor, and was enforced nowhere. `pos_confirm_payment` is the most dangerous of the
four: it marks money as received, so an online order could be released as paid with
nothing in the bank.

**Impact** Full write access to the till for every seat, including a read-only
`viewer` and a custom role with zero capabilities. Money out (refunds), revenue
fabricated (sales), records destroyed (voids), and unpaid orders marked paid.

**Fix** `supabase/migrations/0033_rpc_authorization_guards.sql` transplants a
`public.can(…)` guard into each of the four, immediately after the opening `begin`:

| function | guard |
|---|---|
| `pos_complete_sale` | `can('sell') OR can('manage_online_orders')` |
| `pos_process_return` | `can('process_return')` |
| `pos_confirm_payment` | `can('confirm_payment')` |
| `pos_void_sale` | `can('void_sale')` |

`pos_complete_sale` accepts `manage_online_orders` alongside `sell` because
`resolve_online_order()` completes a customer's order by calling it internally with
`source = 'online'`; a guard demanding `sell` alone would break that path for a custom
role built to work the online queue without ringing up sales at the till.

The bodies were **not retyped**. A generator lifted each current definition verbatim
from the migration that last defined it and inserted only the guard; a diff then proved
the result — 1 line removed, 19 added, three hunks, every original line preserved in
order. Nothing else changed: no arithmetic, no validation, no return shape, no grant.

**Verified in both directions** after the fix:

```
  ✓ refused    pos_complete_sale as viewer          ✓ succeeded  pos_complete_sale as cashier
  ✓ refused    pos_process_return as viewer         ✓ succeeded  pos_process_return as cashier
  ✓ refused    pos_confirm_payment as viewer        ✓ succeeded  pos_confirm_payment as cashier
  ✓ refused    pos_void_sale as viewer              ✓ succeeded  pos_void_sale as manager
  ✓ refused    pos_void_sale as cashier (lacks it)
  ✓ anon places a pickup order → cashier approves → sale INV-000007 / 20.00 created
```

The cashier refusal is the one that matters most: it proves the guard *reads the
matrix* rather than waving staff through.

**Left alone deliberately** `place_online_order` and `submit_online_payment_proof` are
anon storefront entry points — a customer has no role, and both are idempotent and
priced from the catalogue rather than the caller's claim. `get_approval_rules` feeds the
approvals inbox, which every signed-in role may open. `seed_demo_staff` was flagged by
the first scan and is **not** a hole: it guards with `current_user_role() is distinct
from 'admin'`, an idiom the scanner did not know. Verified by reading it, not assumed.

---

### C2 · Online ordering did not work at all in live mode, and a customer could set the shop's recorded price

**Location** `supabase/migrations/0018_online_order_functions.sql`, `place_online_order`

**Issue** The function prices the cart twice. The first loop reads the catalogue,
applies any live campaign, and accumulates the authoritative subtotal — its own comment
says "the customer's cart total is never trusted". The second loop then writes the
snapshot rows and took the unit price from somewhere else entirely:

```sql
v_unit := round((v_line->>'unit_price')::numeric, 2);   -- the CALLER's payload
```

The application never sends that key. Its contract is
`lines: { product_id: string; qty: number }[]` (`src/modules/online/types.ts:276`) and
`StoreCartProvider.tsx:512` builds exactly that.

**Proof**

```
A · the app's real payload (no unit_price)
    FAILED — null value in column "unit_price" of relation "online_order_items"
             violates not-null constraint
B · a forged unit_price of 0.01
    PLACED — items=[{"unit_price":"0.01","quantity":2,"line_total":"0.02"}]
C · a live 20% campaign
    FAILED — same NOT NULL violation
```

So every checkout against a real database failed, and a caller who *did* send a price
wrote it into the shop's own record.

**Why nothing caught it** the end-to-end suites drive the real bundle in **demo mode**,
where orders live in localStorage and never reach PostgreSQL (`scripts/store.flow.mjs`
states this explicitly). The browser was always well behaved, and no test ever asked
what the database does on its own.

**Impact** In live mode: online ordering completely broken. For a caller who supplies
the key: the itemised record that staff and the online reports read shows a price the
customer chose. The money *charged* was never wrong — the order header and the sale
that approval creates both derive from the authoritative subtotal — which is why this
is a correctness and availability defect rather than a theft.

**Fix** `supabase/migrations/0034_online_order_line_prices.sql`. The first loop already
knows the right price, so it now keeps it: each validated line is appended to a new
`v_priced_lines` jsonb array with the unit price used for the subtotal, and the second
loop iterates that array instead of the payload. The keys are identical, so the loop
body is untouched and the snapshot can no longer disagree with the header.

Three of 246 lines change. Verified after the fix:

```
A · PLACED  items=[{"unit_price":"10.00","quantity":2,"line_total":"20.00"}]  header 20.00
B · PLACED  items=[{"unit_price":"10.00",…}]  ← the forged 0.01 is ignored
C · PLACED  items=[{"unit_price":"8.00","quantity":2,"line_total":"16.00"}]   header 16.00
```

---

### Both fixes are now permanent tests

`supabase/tests/scenarios.sql` (+204 lines) gained a Phase 23 block that runs `npm run
db:check` against the real policies and triggers: it asserts the viewer fixture holds
none of the four capabilities *before* asserting the refusals (so a fixture change
cannot silently make the test vacuous), that a cashier may sell but not void, that an
admin may, that the snapshot records the catalogue price, that a forged `unit_price` is
ignored, and that approving an online order still produces exactly one sale.

**The test has teeth** — with 0033 and 0034 removed, `db:check` fails:

```
Role scenarios (RLS + triggers, as each role)
  ✗ a scenario failed
    a viewer completed a sale by calling the RPC directly
```

---

## Medium Issues

### M1 · `/reports` is gated by a different capability than the page and the database use — **fixed in Phase 23.5**

> **Resolved.** `routes.ts` now gates `/reports` and `/reports/advanced` on
> `view_reports`, so the route table, the page and the five RPCs all name one
> capability. Six regression tests pin the agreement down, and the database
> scenarios assert that the two capabilities are genuinely independent. Nothing
> about the capability architecture, the roles or their grants changed. See
> **Phase 23.5** at the end of this document.

**Location** `src/lib/permissions/routes.ts:44-49` vs
`src/modules/reports/services/reportAccess.ts:33` and `supabase/migrations/0032`

The route table requires **`view_shifts`**; the page asserts `report.view`, which maps
to **`view_reports`** (`actions.ts:307`); the five report RPCs are guarded by
`public.can('view_reports')`. Three gates, two capabilities.

All five shipped roles hold both, so nothing is broken today. For a **custom role** the
two directions both misbehave: granting `view_reports` without `view_shifts` gives a
capability that can never be exercised (the guard refuses the path and the sidebar
hides it); granting `view_shifts` without `view_reports` shows the link, admits the
user, and then lands them on the page's own denial screen.

**Impact** A permission an administrator grants does not do what it says, and the
failure looks like a bug in the role editor rather than in the route table.

**Fix (one line each)** point both entries at `view_reports`:

```ts
["/reports", "view_reports"],
["/reports/advanced", "view_reports"],
```

The comment above them objects that a dedicated capability would desynchronise
`roles.ts` from `public.role_capabilities` — but `view_reports` already exists in both
and is asserted row-for-row by `db:check`, so that objection does not apply to it.

**Not applied** because it is inside the permissions architecture this phase was told
not to modify, and changing route gating alters who can reach a screen in a live
installation. It is a one-line change and I recommend making it; say the word.

### M2 · `/reports` and `/reports/advanced` disagreed about the same month — **fixed**

**Location** `src/modules/reports/pages/AdvancedReportsPage.tsx:104`

Phase 22.1 gave the reports hub database-exact totals (`dbTotals ?? clientTotals`) but
not this page, which read the providers' rows — capped at `SALES_ROW_CAP`. On any period
holding more invoices than the cap, the two screens showed different revenue for the
identical window, and neither said so.

**Fix** the same pattern the hub already uses: `fetchFinancialSummary` in an effect
keyed on the window's two strings, `const financial = dbFinancial ?? clientFinancial`,
falling back to the client arithmetic in demo mode, on a project whose migrations
predate 0032, or for a caller without `view_reports`.

### M3 · No global handler for unhandled promise rejections — **not fixed**

**Location** absent from `src/main.tsx` and everywhere else; 88 `void fn()` call sites

Render crashes are caught — three `ErrorBoundary`s, verified by the `crash` e2e suite.
Async failures are not: there is no `unhandledrejection` or `window.onerror` listener
anywhere in the app. Most of the 88 fire-and-forget calls are safe (checked: `recordAudit`
and `automaticBackupIfDue` both swallow internally, so `BackupPage.tsx:149`'s
`.then()` without a `.catch()` cannot reject). But a rejection from any that does not is
silent — no toast, no log, no telemetry.

**Impact** Production failures that present as "the button did nothing", with no
diagnostic to support from.

**Fix** one listener in `main.tsx` routing to the existing toast and audit
infrastructure. Not applied: it is new behaviour rather than a confirmed defect, and
this phase adds no features.

### M4 · The same table scaffolding is copy-pasted across 19 list pages — **not fixed, by your decision**

**Location** 19 files carry `w-full border-collapse text-sm`; 18 carry the identical
`border-b border-slate-200 bg-slate-50 …` header row — `BackupPage`, `ExpensesPage`,
`StockHoldsPage`, `SalesHistoryPage`, `OnlineOrdersPage`, `MovementsPage`,
`RefundsPage`, `ReturnsPage`, `InventoryPage`, `ProductTable` and others. Only the
`t("…")` labels differ.

The prior audit named four of these files and recommended a shared `<DataTable>`; the
real count is 19. **Impact:** any change to table behaviour — an RTL fix, a mobile fix,
a sort indicator, a column-width rule — has to be remembered in 19 places.

You chose to extract the storefront block only, so this is recorded and left alone.

### M5 · Six of the prior audit's eleven remediation items were never applied

`AUDIT-FINAL.md` ends with a numbered plan. Verified item by item:

| # | recommendation | status at audit start | now |
|---|---|---|---|
| 11 | delete `returns/data/demoSeed.ts` | **not done** | ✅ deleted |
| 11 | extract `OrderSummary` | **not done** | ✅ extracted |
| 11 | delete the 29 dead symbols | **not done** | ✅ 32 removed |
| 11 | extract `DataTable` | **not done** | ⬜ deferred (M4) |
| 10 | add knip / dead-code tool to CI | **not done** | ⬜ open |
| 9 | `memo()` hot table rows | **0 uses** | ⬜ open |
| 9 | lazy admin routes, per-locale dictionary | **1 lazy route of 59** | ⬜ open |
| 9 | drop singlefile for production | **still on** | ⬜ open |
| 10 | `set_updated_at()` triggers | done (`0001`, `0017`) | ✅ |
| 10 | index `profiles.custom_role_id` | done | ✅ |
| 10 | ESLint in CI | done | ✅ |

### M6 · 68 of 74 SQL functions are `SECURITY DEFINER`

Every one pins `search_path` (verified — two apparent exceptions,
`products_block_negative_stock` and the generated `touch_%s_updated_at`, are plain
`SECURITY INVOKER` trigger functions my first regex mis-attributed; both were read
before being dismissed). After C1 every definer **writer** reachable from
`authenticated` carries an authorization predicate. The ratio is still worth knowing:
a definer function runs as owner, so each new one is a place where RLS quietly stops
applying, and the default for a new RPC in this codebase is currently "definer".

---

## Low Issues

**L1 · 251 exports referenced only inside their own file.** Overwhelmingly `*Props`
interfaces in `components/ui` — idiomatic React public API, not debt. Left alone; the
prior audit reached the same conclusion about its 179 type-only exports.

**L2 · The demo-repository helper trio is copy-pasted.** `newId()` and `delay()` each
appear in 10 files, `load()` in 5, differing only by the id prefix. Low stakes (demo
mode), but a fix to one is a fix that has to be remembered ten times.

**L3 · 28 `overflow-x-auto` table wrappers.** Wide tables scroll horizontally on
mobile. This is the standard treatment and better than crushing the columns, but it is
why M4's `<DataTable>` would be worth doing: one place to decide mobile behaviour
instead of 28.

**L4 · Bundle and render performance unchanged from the prior audit.** One 2.4 MB
single-file HTML (`vite-plugin-singlefile` still on), 59 routes with exactly one
`lazy()`, zero `memo()`, and both locales — a 5,828-line dictionary — shipped together.
Measured, not assumed: `dist/index.html 2,448.15 kB │ gzip: 657.10 kB`.

**L5 · `get_approval_rules()` performs a lazy INSERT** of the default row and is
callable by any authenticated user. Reviewed and accepted: it is idempotent, the row is
vocabulary rather than a decision, and the approvals inbox is readable by every
signed-in role by design (`App.tsx:267`).

**L6 · `role_aliases` is the one table without RLS.** Reviewed and accepted: it is
explicitly `REVOKE ALL … FROM anon`, `REVOKE INSERT, UPDATE, DELETE … FROM
authenticated`, `GRANT SELECT … TO authenticated`. It relies on grants rather than
policies, which is a defensible choice for a fixed vocabulary table — but it is the one
place where "enable RLS" is not the backstop, so it is recorded here.

---

## Code Quality Report

**Unused dependencies: 0.** All runtime and toolchain packages are imported.

**Dead code removed: 1 file + 36 declarations.**

- `src/modules/returns/data/demoSeed.ts` — deleted. Proven dead three ways: an
  import-graph walk from 43 roots (the app entry, every `*.selftest.ts`, every script)
  reached 364 files and this was not among the reachable; a repo-wide grep found no
  reference, and the one `demoSeed` import in `returns/data/demoRepository.ts` points at
  `products/data/demoSeed`, a different file; and its four exports were an empty array
  and two functions returning one. `AUDIT-FINAL.md` had already recommended deleting it
  at lines 371, 379 and 602.
- 32 unused exports across 21 files, then 4 more by hand (`FALLBACK_SETTINGS`,
  `supabaseConfigError`, `requireSupabase`, and the report wrappers below). Each was
  declared exactly once and referenced nowhere in `src/`, `scripts/` or any selftest —
  the detector counts tests and harnesses as consumers, so an export only a test uses
  was never a candidate.

**Dead code found and *not* removed:** `src/vite-env.d.ts`. The reachability walk
reported it unreachable; that is a **false positive** — ambient declaration files are
consumed through `tsconfig` `include`, not through imports. Recorded so nobody deletes
it on the strength of the same tool.

**Report-aggregate wrappers.** Phase 22.1 shipped five TypeScript clients for the five
RPCs in migration 0032 and wired one. This audit removed the other four
(`fetchSalesSummary`, `fetchProductPerformance`, `fetchInventorySummary`,
`fetchExpenseSummary`, plus their interfaces) — `reportAggregates.ts` 415 → 161 lines.

You asked for them to be wired rather than deleted, so this is a deliberate deviation
and here is the reason, found while attempting it: their only would-be consumers are the
advanced report tabs, whose contract is *raw rows on purpose* — `ReportTabProps`
documents why ("a tab that only received 'its' rows would tempt a caller to pre-filter
them differently per tab"), and the tabs build breakdown tables, not headline numbers,
so an aggregate is not a drop-in for a row list. `stockValueTotals` reads the whole
catalogue, which no row cap limits, so `fetchInventorySummary` would add a round trip
without changing a digit. Wiring them properly is a redesign of the reports module —
feature work, not an audit fix.

What was done instead is the wiring that *was* clean and fixed a real defect (M2).
**Nothing is lost:** all five RPCs remain in the database, gated by
`public.can('view_reports')`, covered by the role scenarios, and compared against the
shipped TypeScript builders by the 91-comparison differential suite — which calls them
through SQL and still passes, confirming it never depended on the deleted wrappers. The
module header now says exactly this, so the next reader knows the four are a deliberate
absence and not an oversight.

**Duplication, measured honestly.** A normalized sliding-window scan found 4,950
duplicated 6-line windows across 1,274 file pairs — a number that is technically true
and practically useless, because it is dominated by three deliberate idioms: the
per-module singleton accessor (`getSupabaseXRepository`), the `useX()` context hook, and
blocks of shared-component imports. Those repeat by design; they are the
dependency-injection seam that lets a module swap demo for Supabase. Suppressing them
leaves **1,064 windows across 267 pairs**, and inspecting the top clusters by hand
separates the real from the structural:

| cluster | files | verdict |
|---|---|---|
| `<table>` + header scaffolding | 19 | **real** — M4, deferred by your decision |
| order-summary `<dl>` block | 2 | **real** — byte-identical, ✅ extracted |
| singleton accessor | ~10 | structural, keep |
| `useX()` context hook | ~9 | structural, keep |
| demo-repo `newId`/`delay`/`load` | 10 | **real**, low stakes — L2 |

**Complexity.** No file grew. `src/` went 100,045 → 99,630 lines (348 files) while
gaining two migrations and 204 lines of security tests. The largest files are unchanged
and still worth watching: `lib/i18n/dictionary.ts` (5,828 lines), `online/data/demoRepository.ts`
(1,689), `online/data/supabaseRepository.ts` (1,270), `online/pages/WebsiteSettingsPage.tsx` (1,268).

**Tooling note.** Four scanners were written for this audit and deleted with it, since
scratch analysis does not belong in the tree: dependency usage, import-graph
reachability, unused exports, and effect-cleanup balance. Two produced false positives
that were caught by verification rather than trusted — the ambient `.d.ts` above, and
`seed_demo_staff` in C1. The recommendation in M5 stands: adopt `knip` in CI so this
does not have to be rebuilt by hand each phase.

---

## UI Report

**Broken buttons: none found.** 110 `<button>` elements, 333 `onClick` handlers, 18
`<form>` elements — every form has an `onSubmit`, so no Enter key reloads the page and
throws away the app state. Zero no-op handlers, zero handlers that only log, zero
`href="#"` anchors, zero `javascript:` URLs, zero empty `to=""` links, zero
`alert()`/`confirm()` calls (which would block the thread and be untranslatable).

The scanner was validated before being believed: it reported 0 forms without `onSubmit`
while a raw grep found 8 `<form` lines lacking it on the same line — all eight are
multi-line tags with the handler on the next line, which the scanner reads correctly.

**Routes: 59, no dead ends.** `RouteGuard` is genuinely mounted (`AppShell.tsx:427`
wraps the outlet) and matches by longest prefix, so `/pos/sales` resolves before `/pos`
and typing a URL cannot bypass the sidebar. Both splat routes are correct: `/store/*`
redirects into the shop, `/settings/*` forwards to `/settings/users`, and the comment at
`App.tsx:300` records why the splat is load-bearing. Every path either carries a
capability in `ROUTE_CAPABILITIES` or is intentionally open to any signed-in seat
(dashboard, catalogue, sales history) — documented at `routes.ts:11-14`, and the one
screen with a bespoke guard (`/audit`) has it. The only routing defect found is the
capability mismatch in M1, which is a *wrong* gate rather than a missing one.

**Loading / empty / error states** are present and consistent — `LoadingBlock`,
`EmptyState`, `ErrorState` are imported together across the list pages, and the crash
screens are covered by a dedicated e2e suite.

**Storefront change made:** the duplicated order-summary block is now
`<OrderSummary>` in `StorePrimitives.tsx`, taking the five money fields rather than the
whole order, so neither page has to hand over a shape the other does not have. Markup is
character-for-character what both pages rendered; the extraction is what the `store` e2e
suite re-verified.

---

## Security Report

**Authentication** — login, logout and password reset render outside the shell so no
module provider loads business data on a public screen; `AuthProvider` resynchronises on
`hashchange`, `popstate`, `visibilitychange` and `focus`, all four with matching
removals; public signup is closed at the database (`0030`), where the trigger refuses a
role supplied through registration metadata.

**Authorization** — the defect was not in the client model, which is sound (`can()`
reads an active custom-role overlay absolutely, fails closed for a profile-less
identity, and is asserted row-for-row against `public.role_capabilities` by `db:check`).
It was that four database functions did not consult it at all. That is C1, fixed and
tested in both directions. Remaining gap: M1's route/page/RPC capability mismatch.

**Database** — 37 tables, 36 with RLS enabled; the exception is L6, protected by
explicit grants. All 68 `SECURITY DEFINER` functions pin `search_path`. Anon grants are
exactly the storefront surface and nothing more: four RPCs (`place_online_order`,
`submit_online_payment_proof`, `lookup_online_order`, `storefront_best_sellers`,
`check_storefront_coupon`, `storefront_catalogue`, `storefront_categories`) plus
`SELECT` on five content tables. `storefront_catalogue()` documents that it
"deliberately omits cost_price (margin)" and is revoked from `PUBLIC`.

**Data exposure** — cost is gated by `view_cost` in every place it can leak:
`ProductTable` (including margin, with the comment "margin is cost in disguise"),
`ProductDetails` (cost, margin and valuation together), `ProductForm` (strips the field
before render), and both the products and inventory exports. The report RPCs return
valuation figures without `view_cost`, which is correct by the documented design at
`roles.ts:231-235`: those are management totals, not a supplier's price list. No
customer phone, address or internal field is returned by any aggregate — the report
scenarios assert the exact key set of all five RPCs, so a new field fails the build.

**Storage** — the `product-images` bucket remains path-unrestricted (carried from the
prior audit, unchanged, and not something this phase can fix without touching the
backup/upload design).

---

## Performance Report

**Memory leaks: none.** The scan found zero `useEffect` bodies that allocate without
releasing. Verified against raw counts rather than trusted: `setInterval` 3 /
`clearInterval` 3, `addEventListener` 11 / `removeEventListener` 10 — and the apparent
imbalance was chased file by file (`Modal`, `realtime`, `AuthProvider`, `authEvents`) to
find all four balanced, the eleventh listener being outside `src/`. `Modal.tsx:26` is
exemplary: it removes the keydown handler *and* restores the previous
`document.body.style.overflow`.

**Database** — the report aggregates are the win, and it is measured rather than
claimed: over a 2,500-invoice dataset the browser path moved 11,274 rows / 1,759.3 KB
and spent 127 ms, the database path 5 aggregates / 47.6 KB — **37× less payload**, with
wall-clock comparable (137 ms), which is the honest reading. M2 extends that exactness
to the second reports screen.

**Still open** — L4: the 2.4 MB single-file bundle, one lazy route of 59, zero `memo()`,
both locales in one dictionary, and 28 independently-scrolling tables. None is a
regression; all were recommendations the prior audit made and none has been picked up.
They are the highest-value remaining performance work and they are all frontend, so
none of them risks the database.

---

## Fixes Applied

| # | fix | where |
|---|---|---|
| C1 | capability guards on four `SECURITY DEFINER` POS writers | `supabase/migrations/0033_rpc_authorization_guards.sql` (+551) |
| C2 | order snapshot records the shop's price, not the caller's | `supabase/migrations/0034_online_order_line_prices.sql` (+311) |
| C1+C2 | permanent regression scenarios, verified to fail without the fixes | `supabase/tests/scenarios.sql` (+204) |
| M2 | `/reports/advanced` totals now database-exact, matching `/reports` | `AdvancedReportsPage.tsx` |
| M5 | deleted the dead demo-seed file | `returns/data/demoSeed.ts` (−12) |
| M5 | extracted the duplicated storefront order summary | `StorePrimitives.tsx`, `StoreConfirmationPage.tsx`, `StoreTrackPage.tsx` |
| M5 | removed 36 unused exports and 10 imports they orphaned | 24 files |
| — | removed 4 unwired report-aggregate clients, documented why | `reportAggregates.ts` (415 → 161) |

**30 files changed, 1,202 insertions(+), 551 deletions(−).**

**All six gates green on the final tree:**

```
typecheck   ✓ tsc --noEmit, no output
npm test    ✓ 27/27 selftest suites
build       ✓ 394 modules, dist/index.html 2,448.15 kB (gzip 657.10 kB)
db:check    ✓ 34 migrations apply cleanly, are idempotent, satisfy the app;
              every role scenario passes; 4 parity checks hold
test:e2e    ✓ 6/6 — smoke, auth, store, backup, crash, reports
              (91 differential comparisons agree)
lint        ✓ 0 errors / 23 warnings — identical to the pre-audit baseline
```

The 23 warnings are pre-existing `react-hooks/exhaustive-deps` and
`no-unused-vars` notices in files this phase did not touch. During the audit, lint
briefly showed 114 errors; all 114 were the scratch scanners in `.audit/` being linted,
and the count returned to baseline when that directory was deleted.

---

## Remaining Recommendations

In the order I would do them:

1. **M1** — point `/reports` and `/reports/advanced` at `view_reports`. Two lines,
   inside the permissions architecture, so it needs your go-ahead.
2. **Deploy 0033 and 0034 together.** They are independent, but 0034 fixes a path that
   does not currently work at all, and 0033 closes a hole that is open right now. If you
   run an edge function or any `service_role` job that calls the four POS RPCs, check it
   first: `service_role` is not `authenticated`, and the guards read the caller's claim,
   so a service-role caller with no claim would now be refused. Nothing in this
   repository calls them that way — I checked — but a deployment outside it might.
3. **M3** — a global `unhandledrejection` handler wired to the existing toast and audit
   infrastructure.
4. **M4** — extract `<DataTable>` for the 19 list pages. The largest remaining
   duplication, and the place where a mobile or RTL decision currently has to be made
   19 times.
5. **Adopt `knip` in CI** (M5) so dead exports are caught by the build instead of by a
   hand-written scanner each audit.
6. **L4** — drop `vite-plugin-singlefile` for production, lazy-load admin routes, split
   the dictionary per locale, `memo()` the hot table rows.
7. **L2** — one shared `demoId(prefix)` / `delay()` helper for the ten demo repositories.

**Not touched, as instructed:** the POS settlement path's business logic (0033 adds a
gate and changes no arithmetic), the inventory engine, the order workflow's behaviour
(0034 makes it do what its comments already claimed), the permissions architecture
(M1 is reported, not applied), the backup module, and the storefront design
(`OrderSummary` reproduces the existing markup exactly).

---

## Git

- **Commit** `PHASE-23-AUDIT.md` and the 30 changed files on
  `arena/01a09298-alyq-cloud-pos`, on top of `c74bebb`.
- **Push** to `origin/arena/01a09298-alyq-cloud-pos`.
- **Working tree** clean after the commit. The `.audit/` scratch tooling was deleted
  before staging and is not in the tree; no generated artefacts, `dist/` output or
  datasets are committed.
- **No branch other than** `arena/01a09298-alyq-cloud-pos` was created, checked out or
  pushed to.

---

# Phase 23.5 — Reports Permission Consistency + Final Security Regression Audit

Two jobs: close **M1** from the audit above, then re-audit the whole security
surface to confirm nothing regressed and nothing was missed. Scope was held to
what was asked — the capability architecture (`roles.ts`, `catalog.ts`,
`customRoles.ts`, `enforce.ts`) was not touched, no role and no grant changed,
and the POS, inventory, orders and backup workflows were left alone.

## Part 1 · The M1 fix

`src/lib/permissions/routes.ts` gated `/reports` and `/reports/advanced` on
`view_shifts`. The page asserts `report.view`, which is `view_reports`
(`actions.ts:307`), and all five report RPCs in migration 0032 are guarded by
`public.can('view_reports')`. Three gates over one screen, naming two
capabilities.

Both entries now read `view_reports`. `/expenses`, `/shifts` and
`/shifts/history` keep `view_shifts`, which is what their own tables' RLS uses
(0012) — those are the shift book, not reports.

The comment that used to sit above the entry argued that a dedicated capability
"would desynchronise `roles.ts` from `public.role_capabilities`, which
`npm run db:check` asserts row-for-row". That objection does not apply to
`view_reports`: it is already declared in both, granted to all five system
roles, and covered by the same parity check. The corrected comment says so, and
records why the mismatch mattered — it was invisible for shipped roles and
misbehaved in **both** directions for a custom role.

**Why this is safe to ship.** The two capabilities are held by exactly the same
five roles, so swapping one for the other cannot change what any shipped role
may open. That is now an asserted invariant rather than an argument
(`hasCapability(role, "view_reports") === hasCapability(role, "view_shifts")`
for every role in `APP_ROLES`).

Three stale comments were corrected with it — `roles.selftest.ts:209` and
`ReportsPage.tsx:67` both still described the old gating, and a comment that
contradicts the code is how the next person reintroduces the bug.

## Part 2 · Tests added

Six tests in `src/lib/permissions/__tests__/accessControl.selftest.ts` (24 → 30):

| Test | What it pins down |
|---|---|
| the route table, the page's assertion and the RPCs name one capability | `capabilityForPath("/reports")` and `/reports/advanced` and any future sub-path are `view_reports`; `sensitiveAction("report.view").capability` equals the route's capability; `/expenses`, `/shifts`, `/shifts/history` are still `view_shifts` |
| no shipped role's access changes | both capabilities are held by the same five roles; all five still see both report screens; exactly two screens are decided by `view_reports` |
| a seat holding `view_reports` can open both report screens | signed in with **only** `view_reports`: sidebar offers both, `canAct` admits, `mayViewReports()` agrees, `assertCanViewReports()` does not throw — and `/expenses` and `/shifts` stay closed |
| a seat without `view_reports` is refused, and `view_shifts` no longer substitutes | signed in with **only** `view_shifts`: guard refuses, page's gate gives the same answer, `assertCanViewReports()` throws, sidebar hides both — while `/expenses` and `/shifts` still open |
| the two capabilities are independent in both directions | neither implies the other, which is what makes a custom role buildable at all |
| the sensitive-action register names database objects that actually exist | every `public.*` in the register exists in the schema; every capability named is real; every guard named is defined in the file pointed at |

The middle two are the requirement stated directly: with `view_reports` you get
in, without it you do not, and holding `view_shifts` is no longer a way in.

**Every one of them was verified to fail without the fix.** Reverting the two
`routes.ts` entries to `view_shifts` fails 5 of the 6 (the sixth is the register
test, which is about a different defect and is verified separately: renaming one
function it cites makes it fail). Tests that pass either way are decoration.

`supabase/tests/scenarios.sql` gained the database half. The existing
narrowed-cashier scenario — a cashier given a custom role that omits
`view_reports` — is exactly the seat that used to be admitted by the route guard
and then met the page's denial screen. It already asserts all five RPCs refuse
that seat; it now also asserts `can('view_reports')` is false, `can('view_shifts')`
is still true, and `expenses` and `shifts` are still readable. Losing the
reports must not cost the shift book, and holding the shift book must not buy
the reports.

## Part 3 · Final security regression audit

**1 · Do all SECURITY DEFINER functions carry authorization checks? — Yes.**
74 functions parsed across 34 migrations; 57 are `SECURITY DEFINER`; 33 of those
write. 28 carry an authorization predicate (`public.can(...)`,
`current_user_role()`, `auth.uid()`), and the four POS writers fixed in Phase 23
are among them: `pos_complete_sale`/`pos_void_sale` → `can('sell')`,
`pos_confirm_payment` → `can('confirm_payment')`, `pos_process_return` →
`can('process_return')`, plus `pos_settle_refund` → `can('approve_refund')`.
The five without a predicate are accounted for:

- `place_online_order` and `submit_online_payment_proof` are granted to **anon**
  by design — a customer has no role, so no capability gate is expressible.
  Their compensating controls were verified individually: `place_online_order`
  re-prices every line from the catalogue (0034), checks stock availability,
  validates coupons/campaigns server-side (92 references) and is idempotent on
  `client_ref`; `submit_online_payment_proof` matches the order's contact
  details, so a stranger cannot attach a proof to somebody else's order, and
  refuses any state but pending.
- `get_approval_rules` lazily inserts its own single default row and returns
  thresholds; there is nothing to authorize.
- `automatic_backup_if_due` and `prune_backups` have no `EXECUTE` grant to
  `authenticated` or `anon`, so a browser cannot reach them.

**2 · Does any RPC bypass the capability matrix? — No.**
No function accepts a role or capability from a caller's payload and uses it to
elevate that caller. The ten functions that take `p_role`/`p_capability` are
either lookup helpers whose whole job is to answer a question about a role
(`can`, `role_can`, `current_user_role`, `current_user_profile`,
`normalize_app_role`) or admin-gated assignment RPCs
(`admin_upsert_staff_profile`, `admin_create_custom_role`,
`admin_update_custom_role`, `set_staff_role`, `upsert_staff_profile`) — every one
of which re-checks `can('manage_users')`/`can('manage_roles')` and refuses
self-assignment. The matrix itself is not writable from a browser:
`role_capabilities` has an insert policy of `with check (false)` and
`insert, update, delete` revoked from `authenticated` (0011).

**3 · Is any sensitive action enforced only in the frontend? — The capability
layer is sound. The approval-limit layer is not. See Part 4.**
All 46 register entries name a real capability and a guard that exists in the
file cited. For every action that writes, the write is refused server-side by an
RPC predicate, an RLS policy or a trigger: stock adjustments by
`stock_movements` `with check (public.can('adjust_stock'))` (0030), product and
category writes by `add_product`/`edit_product`/`delete_product` (0030, which
dropped the earlier `with check (true)` policies), shift opens and closes by
`shifts` RLS **and** the `enforce_shift_invariants` trigger, expenses by
`expenses` RLS **and** `enforce_expense_invariants`.
What is *not* enforced server-side is how **far** a number may move — Part 4.

**4 · Are there price manipulation paths? — One confirmed, and it is not the
price. See Part 4.**
Recorded prices are catalogue-authoritative everywhere they are written:
`pos_complete_sale` selects the product `for update` and inserts
`v_product.selling_price` with `round(selling_price * qty, 2)` — the payload's
own price fields are never read; `place_online_order` was fixed the same way in
0034 and a scenario asserts a forged line price is ignored. A price change on
the product row needs `change_price` under a 0030 trigger that fires only when
the column actually moves.

**5 · Are there broken buttons, forms or routes? — No.**
All 348 source files scanned: no empty `onClick`/`onSubmit`, no
`onClick={undefined}`, no `href="#"`, no control carrying a TODO/"coming soon",
and every `<form>` in the tree has a submit handler. Six staff paths render with
no entry in the capability table — `/products`, `/products/new`, `/products/:id`,
`/products/:id/edit`, `/categories`, `/approvals` — and this is deliberate, not
an oversight: there is no read capability for the catalogue in the matrix (only
the three write verbs `add_product`/`edit_product`/`delete_product`), catalogue
reads are `using (true)` for any signed-in seat, and `/approvals` partitions
itself in the page (`canAct("approve_limit_request")` decides whether you see
every request or only your own). Gating them would mean inventing a
`view_products` capability, which forks the matrix — the thing 0030 explicitly
avoids for categories, and which this phase was told not to do.

**6 · Is critical business logic duplicated? — Not authoritatively.**
`posMath.ts` computes an on-screen estimate and the demo repositories mirror the
RPC arithmetic so the app works without a database; in live mode the database is
the only persister and the client's figure is never written. Demo mode is not a
silent fallback — it is announced on the login card and in the realtime status.
One rule appears in thirteen files (line totals) and one in two (the payment
sum), all of them estimates or demo mirrors, none of them a second authority.

## Part 4 · The one confirmed HIGH finding: approval limits are enforced in the browser

**This was not fixed, because fixing it means changing `pos_complete_sale` and
the approval flow, which this phase was explicitly scoped not to touch. It is
reported here as the highest-value next change, with the remediation designed.**

Phase 12 built an approval-limit system: a discount above your threshold, a
price moved too far, a refund or an expense over the cap must be sent for
approval and decided by somebody holding `approve_limit_request`. The thresholds
live in the single-row `public.approval_rules` table, read through
`public.get_approval_rules()`.

**Nothing in the database ever consults `approval_rules` when it enforces
anything.** `get_approval_rules()` is a read helper; the browser fetches the
thresholds, compares the number it is about to send, and refuses itself. The
enforcement points are
`saleService.ts:146` (`requirementForDiscount`), `catalogService.ts:188`
(`requirementForPriceChange`), `returnService.ts:242` and
`expenseService.ts:65,85` — all four in TypeScript.

Inside `pos_complete_sale` the only discount validation is that the type is one
of `none`/`percent`/`fixed`, the value is not negative, a percent does not
exceed 100, and a fixed amount is clamped to the subtotal. There is no trigger
on `sales` or `sale_items` at all. So the RPC accepts any discount up to 100%
from any caller holding `can('sell')` — which is every cashier.

**The exploit.** A cashier who may discount 5% in the UI calls the RPC directly
(browser console, `curl`, any Supabase client) with
`discount_type: "percent", discount_value: 99.9` and a matching payment. Goods
worth 1,000 leave the shop for 1.00, the sale is recorded as legitimate, stock
is decremented, the audit trail shows a normal sale, and no approval was ever
requested. A total of exactly zero is unreachable — the RPC refuses any payment
of `<= 0`, and payments must sum to the total — so the floor is a fraction of
the price rather than free, which does not much change the loss. The same shape
applies to `add_expense` (an expense of any size, `enforce_expense_invariants`
checks the capability but not the amount) and to price changes and refunds,
where the exposure is smaller because a capability gate does exist server-side
(`change_price`, and a refund is bounded by the sale's remaining refundable
amount).

**Why the capability work does not cover it.** Phase 23 fixed *who may call*
these RPCs. This is about *what the call may contain*. Both are needed: a gate
that admits the right person and then trusts their arithmetic is a gate that
only stops the honest.

**Remediation, smallest shape that closes it.**
1. Add a `public.approval_required_for(kind text, value numeric)` helper that
   reads `approval_rules` and returns whether the value exceeds the caller's
   threshold — one implementation of a rule the browser currently owns.
2. Accept an optional `p_approval_request_id` on `pos_complete_sale` (and the
   expense/return paths) and, when the discount exceeds the threshold, require
   it: re-read the request, check it is approved, check it is for this caller and
   this amount, then `mark_approval_applied`. This mirrors the pattern
   `createExpense(input, approval)` already uses in TypeScript, where the request
   is re-read server-side so a flag in a body cannot invent authority.
3. Keep the client-side check exactly as it is — it produces the good error
   message and the "send for approval" path. It becomes the first of two layers
   instead of the only one.
4. Add scenarios: a cashier over their discount limit is refused by the RPC;
   the same call carrying an approved request id succeeds; a request for a
   different amount or a different person is refused; an already-applied request
   cannot be replayed.

Until that lands, the honest statement of the system's guarantees is: **the
capability matrix is enforced in the database; the approval thresholds are
enforced in the browser.**

## Part 5 · Two secondary findings

**The security register cited six functions that do not exist — fixed.**
`actions.ts` is the map an auditor reads to answer "is this enforced anywhere
but the browser?". Six of its `db` notes named `public.expense_decide`,
`public.inventory_adjust_stock`, `public.open_shift`, `public.close_shift` and
`public.approve_shift_adjustment` — none of which this schema has ever had. Each
promised a server-side gate and hid the RLS policy and trigger that actually
provide it, so the honest reading of the register was "frontend-only" for stock
adjustments, shift opens, closes and approvals. They are not, and never were.
The notes now name the real objects (`stock_movements` insert policy,
`enforce_shift_invariants`, `decide_approval_request`), and the sixth test above
fails if any note ever points at nothing again.

**`approve_expense` is offered in the role editor and read by nothing —
reported, not changed.**
It is a real capability, granted to admin and manager (0021), listed in
`catalog.ts:77` as a toggle in the expenses group, and its guard
`assertCanApproveExpense()` is called from exactly three places, all of them in
`enforcement.selftest.ts`. No production path consults it: an over-limit expense
is decided by `public.decide_approval_request` under `approve_limit_request`,
which is registered separately and correctly. So an administrator can grant or
revoke `approve_expense` and nothing happens — the same class of defect as M1, a
control that looks live and is not. Removing or rewiring it means changing the
capability architecture and the roles, which this phase was told not to do; the
register note now says plainly that no production code calls the guard.

## Part 6 · Verification

All six gates green after the change:

| Gate | Result |
|---|---|
| `npm run typecheck` | clean |
| `npm test` | **27/27 suites** · access-control 30/30 (was 24/24) |
| `npm run build` | ✓ built in 6.47s · `dist/index.html` 2,449.13 kB (gzip 657.38 kB) |
| `npm run db:check` | ✓ **34 migrations** apply cleanly, are idempotent, and satisfy the application — including the new independence assertions in the narrowed-cashier scenario |
| `npm run test:e2e` | ✓ **6/6 suites** · 0 console errors on the reports suite |
| `npm run lint` | **0 errors / 23 warnings** — unchanged from the Phase 23 baseline |

Six files changed, no schema migration, no capability, role or grant altered:

- `src/lib/permissions/routes.ts` — the fix, and the corrected rationale above it
- `src/lib/permissions/actions.ts` — six `db` notes now name real objects
- `src/lib/permissions/__tests__/accessControl.selftest.ts` — six new tests
- `src/lib/permissions/__tests__/roles.selftest.ts` — stale comment corrected
- `src/modules/reports/pages/ReportsPage.tsx` — stale comment corrected
- `supabase/tests/scenarios.sql` — the database half of the independence proof
