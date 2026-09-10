# ALYQ Cloud POS — Phase Status Report

**Repository:** `youssefmaatyy-commits/alyq-cloud-pos`
**Branch:** `arena/01a08778-alyq-cloud-pos` · **HEAD:** `ec03675` · **Date:** 2026-09-10
**Purpose:** establish exactly where the project stands before continuing. No new work is proposed here.

---

## How the phase map was determined

Phases are not declared in one place, so this report was assembled from the artefacts that do
declare them:

| Source | What it establishes |
| --- | --- |
| Module header comments (`src/modules/*/index.ts`, `types.ts`) | Phases 2, 3, 4, 7, 8 |
| `supabase/migrations/*.sql` headers + `supabase/migrations/README.md` | Phases 2, 3, 4, 6, 7 (migrations 0001–0010) |
| i18n banners and `app.phase*` / `nav.phase1` keys | Phases 1, 2, 3, 8 |
| `scripts/smoke.dom.mjs` section markers | Phases 2, 3, 4, 7, 8 |
| `docs/AUTHORIZATION.md`, `docs/AUTHENTICATION.md`, commit history | The two named phases after Phase 8 |

Two caveats, stated up front:

1. **Phase 5 is not documented anywhere in the repository** — no migration, no module header, no
   i18n key, no test section, no commit message. It is the only gap in the numbering. Its scope
   cannot be established from the code, so its status is reported as *unverified*.
2. `origin/main` is a single squashed commit (`84dcf47`), so the pre-Phase-8 commit history is not
   available. Phase boundaries for Phases 1–7 therefore come from the artefacts above, not from
   commit sequencing.

---

## Status summary

| # | Phase | Status |
| --- | --- | --- |
| 1 | App shell, routing, dashboard | **Completed** |
| 2 | Products & Categories | **Completed** |
| 3 | Inventory (stock + movement ledger) | **Completed** |
| 4 | POS + Sales | **Completed** |
| 5 | *(not identified in the repository)* | **Unverified — no evidence of scope** |
| 6 | InstaPay confirmation + Split payments | **Completed** |
| 7 | Customers + Returns + Refunds | **Completed** |
| 8 | Cashier shifts + Expenses + Audit log | **Completed** (code) / **Partial** (live schema) |
| — | Authorization phase *(named, not numbered)* | **Completed** |
| — | Authentication phase *(named, not numbered)* | **Completed** (demo) / **Partial** (live schema) |

"Completed" means the phase's features are implemented, wired into the app, and covered by at least
one automated suite. Gaps listed per phase are things that are absent or only partly present — not
planned scope.

---

## Phase 1 — App shell, routing, dashboard — Completed

### Features implemented
- Vite + React 19 + TypeScript single-page app; `HashRouter` so every deep link works from any
  static host, including the single-file production build.
- `AppShell`: desktop sidebar, mobile drawer, sticky header, responsive layout, logical
  (RTL-safe) spacing.
- Bilingual i18n provider — English + Arabic, `dir` switching, dictionaries, `money`/`date`/`num`
  formatters.
- Design-language foundation (`docs/DESIGN_LANGUAGE.md`) and the shared UI kit: `Button`,
  `Card`, `Field`, `Modal`, `ConfirmDialog`, `EmptyState`, `ErrorState`, `LoadingBlock`, `Badge`,
  `StatTile`, `TextInput`, `SelectInput`, `TextArea`, `ToggleSwitch`, icon set.
- Toast provider; demo/live mode badge.
- Dashboard screen with four catalog KPI tiles and a catalog call-to-action.
- Catch-all route that redirects unknown paths to the dashboard.

### Remaining gaps
- The header and dashboard subtitle still render `app.phase` = **"Phase 2 · Products & Categories"**,
  although Phases 3–8 and the two named phases have shipped.
- The dashboard is still Phase-1 scoped: it shows catalog counters only. No sales/revenue,
  inventory value, low-stock or shift/cash figures are surfaced there.
- No React error boundary anywhere in the tree; an unhandled render error surfaces as a console
  error (the DOM suites treat those as failures) rather than a recoverable screen.
- No dedicated 404 screen — unknown routes silently redirect to `/`.

---

## Phase 2 — Products & Categories — Completed

### Features implemented
- Product CRUD: list, create, edit, detail; archive + restore; active/inactive toggle.
- Categories: CRUD with parent/child hierarchy, cycle guard, delete-in-use guard (offers
  deactivation instead).
- Bilingual names/descriptions (EN + AR), product types, SKU (auto-suggested, uniqueness enforced),
  barcode (auto-generate, manual override preserved, duplicate detection, printable label sheet).
- Pricing: selling price, cost price, tax rate.
- Stock fields on the product: tracking flag, quantity, low-stock level.
- Storefront flags: `show_on_website`, `is_featured`.
- Image gallery up to 6 images: upload with validation, previews, reorder, set cover, replace,
  remove; Supabase Storage bucket + RLS in live mode.
- Search (Arabic-normalised, trigram-backed in live mode), filters (status, category, stock,
  featured), sorting, pagination.
- Data: demo repository with seeded catalog, Supabase repository, migrations 0001–0005 (tables,
  RLS, audit columns, stock/storefront columns, image bucket).
- Logic self-test: 36 tests.

### Remaining gaps
- `show_on_website` and `is_featured` are stored and editable but nothing consumes them — there is
  no storefront or website surface in this app.
- Products cannot be hard-deleted (archive/restore only, by design); categories in use cannot be
  deleted.
- The demo "Reset" action restores the catalog only — it does not touch any other module's data.

---

## Phase 3 — Inventory (stock + movement ledger) — Completed

### Features implemented
- Append-only stock movement ledger with movement types (`adjustment_in`, `adjustment_out`,
  `receive`, `issue`, `transfer`, `correction`) and reasons (purchase, supplier return, customer
  return, damaged, expired, lost, theft, recount, transfer in/out, and more).
- Stock adjustment workflow (modal) recording before/after quantity, reason, notes and the acting
  user; increase and decrease paths.
- Negative-stock prevention: UI guard **and** a database trigger.
- Out-of-stock status flips automatically when stock reaches zero; stock status badges
  (in stock / low stock / out of stock).
- Inventory dashboard (current stock list) and movement history page with search and per-product
  drill-down (`#/inventory/movements`).
- Role gate on adjustments; `view_inventory` capability for read access.
- Supabase repository + migration 0006 (enums, ledger table, guard trigger, RLS).
- DOM smoke coverage: dashboard, increase, decrease, negative blocked, ledger rows, out-of-stock.

### Remaining gaps
- Stock is single-location: there is no branch or warehouse dimension, even though shifts and
  expenses are branch-aware.
- No stocktake / cycle-count screen — `recount` and `correction` exist only as adjustment reasons.
- No purchase-order or receiving workflow; `receive`/`issue` exist as ledger types without any
  document behind them.
- No dedicated low-stock or out-of-stock screens: `nav.lowStock` and `nav.outOfStock` are defined
  in the dictionary but unused, and no such routes exist (only list filters and badges).

---

## Phase 4 — POS + Sales — Completed

### Features implemented
- Register (`#/pos`): product grid with search and category filter, keyboard-wedge barcode
  scanning hook, cart with add/increment/decrement/remove and line totals.
- Discounts: none / percentage / fixed, with validation and a maximum percentage.
- Authoritative totals in `posMath` (subtotal, discount, tax, total, change, remaining) shared by
  cart, payment panel and receipt.
- Payments: cash with quick-amount buttons (including "Exact"), smart payment calculation, change
  due, and a split-payment mode with automatic balancing of the other method.
- Sale completion with a success modal showing the sale number and payment methods.
- Receipt printing with a single source of truth for receipt text (`receiptStrings`), + reprint
  from the sale detail page; iframe/sandbox print fallbacks handled.
- Sales history (`#/pos/sales`): search, status filter (completed / pending / voided), method
  filter, pagination.
- Sale detail (`#/pos/sales/:id`): items, payments, customer, totals, void action (manager/admin,
  restores stock and writes movements), InstaPay payment confirmation.
- Sequential invoice numbering; Supabase migration 0007 with transactional
  `pos_complete_sale` / `pos_void_sale` RPCs and payment/discount constraints.
- Logic self-test: 34 tests.

### Remaining gaps
- **No card/Visa payment at the register**: `PAYMENT_METHODS = ["cash", "instapay"]`. Visa exists
  only as a refund method, an expense payment method and in receipt strings.
- No hold/park sale, no quote or proforma invoice, and no "start a return" action from the register.
- Receipts are print-only: no PDF file, no e-mail or messaging share.
- No CSV/report export anywhere in the application.
- Barcode entry is keyboard-wedge only — no camera-based scanning.
- Printing depends on `window.open`/`print` being available; inside a sandboxed iframe the receipt
  can only be produced by opening a real browser tab (handling exists, the platform limit does not
  go away).

---

## Phase 5 — *(not identified)* — Unverified

No artefact in the repository declares a Phase 5: `supabase/migrations` jumps from 0007
(Phase 4) to 0008 (Phase 6), no module header mentions it, no i18n key exists for it, the DOM smoke
suite lists sections for Phases 2, 3, 4, 7 and 8 only, and no commit message references it.

Because its scope cannot be established from the code, no features and no gaps can be reported for
it. **This is the one place in the phase map that needs confirmation from you** (what Phase 5 was
meant to cover), after which it can be marked completed or not started.

---

## Phase 6 — InstaPay confirmation + Split payments — Completed

### Features implemented
- InstaPay payments carry a status: `paid` (confirmed) or `pending` (awaiting confirmation).
- Confirmation action on the sale detail page, gated by the `confirm_payment` capability, with
  "who confirmed it and when" recorded.
- Idempotent, transactional `pos_confirm_payment` RPC (migration 0008).
- Split payments: `sale_payments` table (migration 0009), one row per method; payment-aware
  completion and confirmation RPCs replacing the earlier single-method versions.
- Payment panel: split toggle, InstaPay amount input, paid/pending selector, automatic balancing of
  the other method, both methods shown on the success modal.
- Shift maths treat mixed payments per leg (cash leg in the drawer, InstaPay leg reported
  separately) and expose unconfirmed InstaPay as `instapay_pending`.
- DOM smoke coverage: mixed cash+InstaPay sale, InstaPay-only sale, pending vs paid.

### Remaining gaps
- InstaPay is entirely manual — a staff member marks a payment as paid. No gateway, QR, API or
  webhook integration.
- No card terminal integration (see Phase 4).
- Unconfirmed InstaPay sales have no expiry/timeout handling and no dedicated pending-payments
  queue; they are found through the sales-history status filter or the individual sale.

---

## Phase 7 — Customers + Returns + Refunds — Completed

### Features implemented
- Customers: list with search, create/edit modal, validation (name required, phone required,
  format-checked and unique), address, notes; customer detail page with purchase history (sales and
  returns); optional customer link on a sale; customer search/select control inside the POS.
- Returns: created from an existing sale with item + quantity selection, reason, partial returns,
  over-return prevention, stock restored through the movement ledger, sequential return numbering,
  return detail page.
- Refunds: a refund record is created with each return, sequential numbering, cash / Visa / InstaPay
  methods, refund amount validated against the sale, refunds list and detail pages, refund status
  badge (completed / pending).
- Return receipt printing that reuses the sales-receipt pipeline and styles (no second printing
  system), with the same reprint behaviour.
- Receipt customer rule: any customer-linked transaction must show customer name **and** phone, or
  the receipt is blocked; anonymous/guest sales still print.
- Demo seed + Supabase migration 0010 (`customers`, `sales_returns`, `return_items`,
  `refund_records`, counters, sales–customer linkage, transactional `pos_process_return` RPC).
- Logic self-test: 9 tests.

### Remaining gaps
- Refund records are always created as `completed` — the return form hardcodes
  `refund_status: "completed"`. The `pending` refund state therefore cannot be created from the UI,
  and nothing in the app can settle it; the refund pages are read-only (no correction or reversal).
- Returns are refund-only: there is no exchange or replacement flow.
- No customer statement, credit balance, loyalty or points.
- The receipt customer rule covers name + phone; no address or ID capture on receipts.

---

## Phase 8 — Cashier shifts + Expenses + Audit log — Code completed, live schema partial

### Features implemented
- Shifts: open a shift with branch, register and opening float; only one shift open at a time;
  live dashboard (current sales, current expenses, expected cash); summary grid; close with counted
  cash and a live signed difference plus tone; frozen summary snapshot at close; shift history and
  shift detail; duration; cash-difference approval by a manager/admin.
- Money model (single source of truth in `shiftCalculations`):
  `expected cash = opening + cash sales − cash refunds − cash expenses`; InstaPay and Visa are
  reported but never enter the drawer; voided sales excluded; unconfirmed InstaPay excluded; splits
  counted per leg.
- Expenses: create/edit/delete, categories, payment methods (cash/InstaPay/Visa), branch, notes,
  date/time, sequential numbering, list with search and category/method filters, totals
  (total/cash/InstaPay/Visa), linked-shift column, automatic link to the open shift, edit/delete
  restricted to manager+.
- Audit log: append-only trail of `shift.opened`, `shift.closed`, `expense.created`,
  `expense.updated`, `expense.deleted`, `shift.adjustment.approved`; actor, structured details,
  search, action filter, dedicated page, denial state.
- Permission gating for shift/expense/audit actions across the UI.
- Logic self-test: 17 tests; DOM smoke coverage of the full open → sell → expense → close cycle,
  including the acceptance scenario (1 000 opening + 500 cash − 100 expense = 1 400 expected).

### Remaining gaps
- **No Supabase migration for `shifts`, `expenses` or `audit_log`.** Migrations stop at 0010
  (Phase 7). The Supabase repositories for these three modules exist and query those tables, so
  live mode has no schema for this phase.
- The demo reset only clears the catalog; shift / expense / audit demo data must be cleared by hand.
- Expense attachments are a URL plus a display label — no file upload in either mode.
- The audit trail covers shift and expense actions only. Sales, returns/refunds, customer records
  and product-catalog changes are not audited.
- Audit rows are attributed client-side from the session; a tampered client could write a different
  actor.
- No printable end-of-day / Z-report: the figures live on screen; the only print outputs in the app
  are sales and return receipts and barcode labels.
- Shifts are branch/register-aware only as free text or a static register list — there is no branch
  or device registry.

---

## Authorization phase *(named, not numbered)* — Completed

Commits `2cf72be`, `4af0e72`, `560d12e`, `bddfc70`, `791973f`.

### Features implemented
- Canonical role + capability model in `src/lib/permissions/roles.ts`: five roles
  (`admin`, `manager`, `cashier`, `inventory_clerk`, `viewer`), sixteen capabilities, alias mapping,
  fail-closed `normalizeRole`, and `hasCapability` / `capabilitiesOf` / `rolesWithCapability`.
- Every module permission helper (inventory, POS, returns, shifts/expenses/audit) delegates to that
  matrix; no permission was removed.
- Audit route authorization: `RequireAuditAccess` guard, route wrap, sidebar entry hidden from
  unauthorized roles, EN + AR denial copy.
- Role-model self-test: 12 tests (parity with the previous helpers, fail-closed resolution,
  cashier definition, signed-out denial).
- `scripts/auth.flow.mjs` created as the re-runnable seven-step acceptance test for the auth phase.
- `docs/AUTHORIZATION.md`: matrix, enforcement points, guarantee that no other module changed, and
  reproduction recipes.

### Remaining gaps
- Defense in depth is uneven. Action-layer `FORBIDDEN` checks exist only for POS sale completion
  (`PosProvider`) and stock adjustment (`InventoryProvider`). Returns/refunds, expenses and shifts
  rely on UI gating alone — a direct call to those repositories is not re-checked.
- The matrix is code; there is no per-role permission editing UI.
- The `cashier` role is defined and enforced, but the login directory is the only place accounts are
  declared — no role administration screen.

---

## Authentication phase *(named, not numbered)* — Completed (demo) / Partial (live)

Commit `ec03675`. The demo role switcher was replaced by a real session-driven flow; the permission
matrix was carried over unchanged.

### Features implemented
- Login screen at `#/login`, rendered outside the app shell with no module provider mounted, so no
  business data loads before sign-in: username, password, remember-me, bilingual, inline validation,
  demo credential hint in demo mode only.
- Session model: opaque token, acting user, `issued_at`, sliding `expires_at`, `remember`; idle TTL
  8 h, 7 days with remember-me, hard 30-day absolute cap.
- Expiry enforced at three points — boot, navigation (`hashchange`/`popstate`), and a 60-second
  heartbeat plus tab focus — with an explanatory message on the login screen.
- Logout control in the sidebar; clears the session from both stores.
- Five demo accounts, one per role, in a data module; no component contains a username, password or
  role list.
- Storage: one key (`alyq.auth.session.v1`) — localStorage with remember-me, sessionStorage
  otherwise, never both; the legacy demo identity key is cleared and no longer written.
- Repository seam `UserRepository` with demo and Supabase implementations
  (`signInWithPassword` + `profiles.role`), selected the same way as every other module.
- Signed out, the acting user's role is `""`, which is not a member of the model, so every
  capability is denied (fail closed).
- Route protection: `RequireAuth` around the shell; `src/lib/permissions/routes.ts` maps each screen
  to a capability and is read by **both** the route guard and the sidebar; `/audit` keeps its own
  more specific denial.
- `pos.canCompleteSale` gap closed — it previously listed roles by hand and omitted `cashier`, so a
  signed-in cashier could not sell despite the matrix granting `sell`.
- Tests: 17 auth logic tests; `scripts/auth.flow.mjs` now asserts 9 steps (login, wrong password,
  logout, expiry while running, expiry at boot, role gating, cashier permissions, viewer
  restrictions, session persistence); the DOM smoke suite signs in before driving the app.
- `docs/AUTHENTICATION.md`.

### Remaining gaps
- Password verification happens in the browser for the demo directory; a client is not a trust
  boundary. Live mode delegates to Supabase Auth.
- No `profiles` migration, so the Supabase auth path has no schema behind it, and there is no
  Supabase instance in this environment — the live auth path is typed but never executed.
- No server-side session validation or refresh; the token is carried, not verified.
- No MFA, no password reset/change, no account lockout or rate limiting, no user administration
  screen.
- No cross-device session list or remote revocation; sessions are per-browser storage only.
- No warning before expiry — the session simply ends on the next interaction.
- Audit rows take their actor from the session client-side (same gap as Phase 8).

---

## Cross-cutting gaps

These are not owned by a single phase:

1. **Live (Supabase) mode is incomplete and unexercised.** Schema exists for Phases 2–7 only
   (migrations 0001–0010). Phase 8 tables (`shifts`, `expenses`, `audit_log`) and auth `profiles`
   have repositories but no migrations. No Supabase project is reachable here, so every automated
   suite runs against the demo (localStorage) path.
2. **No CI.** There is no `.github/` workflow; typecheck, build, six logic suites, the DOM smoke
   suite and the auth flow test are hand-rolled Node/esbuild scripts run manually. No coverage
   tooling.
3. **Repository hygiene (previously deferred — not authorised).** No `.gitignore` (`node_modules/`
   and `dist/` sit untracked), a stray `vite-env.d.ts` at the root, an untracked sandbox-only
   `vite.preview.config.ts`, and no root `README.md`.
4. **No `.env.example`** — the Supabase variables (`VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`)
   are only discoverable from the client module.
5. **Demo-mode caveats.** All data lives in localStorage and is per-browser; the reset action clears
   the catalog only; demo passwords are shared and displayed on the login screen; there is no
   multi-user concurrency or conflict handling.
6. **i18n is complete for both languages** across every module, but the shell's "Phase N" labels are
   stale (see Phase 1).
7. **Printing is limited to three artefacts** — sales receipt, return receipt, barcode label. There
   are no reports, exports or analytics outputs anywhere in the app.

---

## Verification snapshot at HEAD `ec03675`

| Check | Result |
| --- | --- |
| `npx tsc --noEmit` | clean |
| `npm run build` | green — 964.26 kB, 254.39 kB gzip |
| Roles + capabilities self-test | 12/12 |
| Authentication self-test | 17/17 |
| Products logic self-test | 36/36 |
| POS logic self-test | 34/34 |
| Returns/customers logic self-test | 9/9 |
| Phase 8 self-test | 17/17 |
| `scripts/auth.flow.mjs` | 9 passed · 0 failed · 0 console errors |
| `scripts/smoke.dom.mjs` (full DOM) | all checks passed · 0 console errors |

E2E coverage by phase: Phase 1 (shell, nav, RTL/LTR), Phase 2, Phase 3, Phase 4, Phase 6 (inside the
POS section), Phase 7, Phase 8, authorization (audit gating per role), authentication
(`auth.flow.mjs`, 9 steps). Phase 5 has no coverage because its scope is unknown; live/Supabase mode
has no coverage because no instance exists.
