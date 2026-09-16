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
| — | Excel exports & report outputs *(post-phase workstream)* | **Completed** |
| 9 | Online store — public storefront + POS order queue | **Completed** |

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

## Phase 9 — Online store — Completed

Declared by `src/modules/online/index.ts`, migrations 0017–0020, the `app.phase9` i18n banner and
the Phase 9 section of `scripts/store.flow.mjs`. One module, two audiences: a public shop at
`#/store` and five screens inside the app shell for the people who run it.

### Features implemented
- **Public storefront**, mounted outside `RequireAuth` at `/store/*` (nine routes: home, products,
  product, cart, checkout, confirmation, track, account, contact). No session, no role, no
  business data loaded before a shopper asks for it. Bilingual and RTL-safe, prices in EGP.
- **One catalog, two front doors.** The shop reads the same products, categories, brands, stock and
  prices as the POS through `catalogQuery`; nothing is entered twice, and `show_on_website` decides
  what a shopper may see.
- **Website builder** (`#/online/website`, capability `manage_website`): logo, favicon, hero and
  section imagery, primary/secondary/accent colours, dark mode, corner radius, button style and font
  stack. Saving writes CSS custom properties into a `:root` style block, so a new colour is live on
  the next render — no rebuild, no deploy. Tabs: appearance, homepage, contact & social, delivery &
  payment, search (SEO).
- **Homepage sections** (`#/online/content`): hero, featured, best sellers, new arrivals, categories,
  promo banners, brands, reviews, FAQ and contact — each shown/hidden and reordered by the admin,
  rendered from `sections.ts`.
- **Search, filters and sorting**: name, barcode and SKU; category, brand, price range and
  availability; newest, price ascending/descending, best selling and name.
- **Product pages**: multi-image gallery with zoom, description, specifications, brand, stock,
  related products and New / Sale / Best-seller badges (`badges.ts`).
- **Cart and checkout**: add/update/remove, coupon codes, delivery or pickup, COD or InstaPay,
  guest or signed-in. Customer accounts (`localAccounts` in demo, Supabase Auth live) add profile,
  saved addresses, order history, reorder and wishlist.
- **The POS queue** (`#/online/orders`, capability `manage_online_orders`): statuses Pending,
  Approved, Processing, Ready, Completed, Cancelled. Approving creates the sale through the existing
  `pos_complete_sale` path with `source: "online"` and deducts stock once; cancelling keeps the
  record, demands a written reason and deducts nothing. Every transition records who, when and from
  where, and each action is offered only if `checkAction` would allow it.
- **Inventory protection**: a pending order reserves its units (availability subtracts open
  reservations), approval converts the reservation into a sale, cancellation releases it. Only
  stock-tracked products can be ordered at all.
- **InstaPay verification**: the customer sends a reference plus a proof image (uploaded to the
  `product-images` bucket under `proofs/`); the order sits in *payment verification pending*; an
  employee approves or rejects it. Nothing completes on upload, ever.
- **Notifications**: `useOnlineNotifications` polls the queue, badges the sidebar with the pending
  count and says how many need payment verification; sound is an admin setting, off by default.
- **Order tracking** for customers at `#/store/track`: order number plus phone, with order status and
  payment status shown as the two separate things they are.
- **Marketing** (`#/online/marketing`): campaigns, coupons and flash sales feeding the same pricing
  the checkout uses.
- **SEO and performance**: per-page meta title/description/canonical, JSON-LD for the store and for
  each product, `noindex` on cart/checkout/account, a `sitemap.xml` route, system font stacks (no
  webfont to block rendering) and lazy image decoding.
- **Online reports** (`#/online/reports`): online revenue and order counts, pending and cancelled
  totals, best-selling online products and payment-status breakdown, exportable like every other list.
- **Social and contact links**: Facebook, Instagram, TikTok, WhatsApp and InstaPay configured in the
  builder, rendered in the storefront header and footer plus a floating WhatsApp button.
- **Live schema**: migrations `0017_online_storefront` (tables), `0018_online_order_functions`
  (`place_online_order`, `submit_online_payment_proof`, `lookup_online_order`, `list_my_online_orders`,
  `resolve_online_order`), `0019_storefront_public_reads` and `0020_storefront_grants_and_coupon_check`.
  The server re-prices every line and validates every coupon — the client's totals are a preview.
- **Checkout contract** (live mode): the order travels as one `place_online_order` call and is read
  back for the confirmation through `lookup_online_order` — the phone-gated read a visitor may use —
  because `online_orders` / `online_order_items` / `order_events` are staff-only under RLS
  (`getOrder` remains the staff path). `store_customer_id` is sent only when it can be a real
  `store_customers.id`: storefront accounts are browser-local (`cus-…`) and the function casts the
  field to `uuid`. A refused checkout is mapped from the server's own wording (stock, quantity,
  inactive / website-hidden product, coupon, delivery rules) to its friendly `store.error.<code>`
  text, and a failure is logged as `{ code, message, details, hint }` — never `[object Object]`.
  A checkout the server accepted but could not be read back is reported as `order_unreadable` with
  the order number, so the customer never re-orders something that already exists.
- Tests: 75 logic tests in `src/modules/online/__tests__/logic.selftest.ts`; 20 checkout-contract
  tests in `src/modules/online/__tests__/checkout.selftest.ts` (payload, read-back, error mapping);
  the `supabase/tests/scenarios.sql` checkout phase runs the real function as `anon` (pickup /
  delivery × COD / InstaPay, catalogue pricing, reservations, every refusal writing zero rows,
  replayed key, guest read-back); `scripts/store.flow.mjs`
  drives the whole acceptance flow in the DOM (14 steps: browse → search → sort → filter → product →
  cart → guest COD checkout → tracking → approval → sale + stock → InstaPay proof → verification →
  cancellation with reason → admin screens → live theme → social links → Arabic/RTL).

### Remaining gaps
- The customer-account path in demo mode is a local directory (`localAccounts`), so passwords are not
  hashed and accounts are per-browser; live mode delegates to Supabase Auth.
- Notifications poll rather than subscribe — no Realtime channel yet.
- No shipping-carrier integration: delivery is a fee and an address, not a tracked parcel.
- Product reviews are content the admin writes, not submissions from verified buyers.
- The live order path (migrations 0017–0020) is exercised by `npm run db:check` against in-process
  Postgres, never against a hosted project.

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

*Addendum, written after this snapshot:* items 2, 3, 4 and 7 have since been closed — `.github/`
now holds `ci.yml` and `deploy-pages.yml`, and the repository has a `.gitignore`, a `.env.example`
and a root `README.md`. Excel exports exist for products, inventory, sales, payments, cash,
customers, returns, expenses, reports and online orders, so item 7's "no exports" no longer holds;
printing is still limited to the three artefacts. Item 1 is partly closed: migrations now run to
0020 and cover Phase 8 and Phase 9, and `npm run db:check` applies them twice in an in-process
WebAssembly Postgres — still never against a hosted project.

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

---

## Verification snapshot after Phase 9

| Check | Result |
| --- | --- |
| `npm run typecheck` | clean (and the EN/AR dictionary is 1784 keys on both sides) |
| `npm run build` | green — single self-contained HTML document |
| `npm test` | 13/13 suites, including 75/75 online-shop logic tests |
| `npm run db:check` | migrations 0001–0020 apply, are idempotent, and match every `…Row` interface |
| `npm run test:e2e` | 3/3 suites — smoke, auth (9 steps), store (14 steps), 0 console errors |

---

## Verification snapshot after Phases 11–14

| Check | Result |
| --- | --- |
| `npm run typecheck` | clean — and the EN/AR dictionary is 2373 keys on both sides, with no key on one side only |
| `npm run build` | green — single self-contained HTML document, 2,255 kB (606 kB gzip) |
| `npm test` | 19/19 suites — including 29/29 dashboard, 18/18 Phase 8, 12/12 audit-expansion, 10/10 advanced-report analytics |
| `npm run db:check` | migrations 0001–0024 apply, are idempotent, and match both the app's row types and its role model |
| `npm run test:e2e` | 3/3 suites — smoke (now covering the advanced reports screen and the dashboard charts), auth, store · 0 console errors · 0 network calls |

What Phases 11–14 added on top of the Phase 9 snapshot:

- **Advanced reports** (`/reports/advanced`) — six tabs (sales, products, customers, expenses, shifts,
  financial) reading one date window, each with its own Excel report. The arithmetic lives in
  `src/modules/reports/services/{salesAnalytics,expenseAnalytics,shiftAnalytics}.ts` and the workbooks
  in `analyticsExport.ts`; the screen renders those and computes nothing of its own, so a table and
  its spreadsheet cannot drift apart. Access is gated twice — by the route table (`view_shifts`) and
  by `assertCanViewReports()` — and every button on it is `authority="report"`, so the raw extracts
  stay on the Reports hub behind `export_data`.
- **Dashboard analytics** — month-to-date sales, net profit and expenses, the pending approval and
  online-order queues, the best sellers, and four charts (sales trend, revenue vs expenses, payment
  mix, product performance) drawn as plain SVG in `src/modules/dashboard/components/Charts.tsx`. No
  charting dependency was added. Every figure comes from the reports' analytics through
  `dashboardQuery.ts`, and the whole section renders only behind `mayViewReports()`, so a cashier's
  dashboard is exactly what it was.
- **Reports inside their own modules** — the expenses screen gained the reports' date window (list,
  tiles and export all read the same filtered array), and the shift history screen exports the shift
  report workbook built by the same analytics the advanced screen uses.
- **Audit expansion** — `sale.discounted`, `sale.voided`, `product.price_changed`,
  `product.cost_changed`, `stock.adjusted` and `stock.corrected`, each written by the service funnel
  that performs the act (the same place the capability is asserted), in demo and live mode alike.
  Migration `0024_audit_business_events.sql` extends `public.audit_actions` and the entity vocabulary
  to match, which `npm run db:check` asserts row for row. No second audit trail was created.
- **Shared date windows** — `src/modules/reports/services/dateRanges.ts` now owns what "today", "this
  month", "the last 30 days" and "the last N days" mean. The picker renders it, the reports filter
  with it, and the dashboard charts their span with it, so three screens cannot define a month
  differently. It moved out of the component so a headless caller can read a window without pulling
  the UI graph into a logic suite.

---

## Verification snapshot after Phase 17

Phases 15–16 (stock-hold reconciliation, realtime underneath the app, reservation
monitoring and alerts) landed in commits `1a8bfc0` and `a02bb39` without a snapshot
of their own; the numbers below are the first taken after them, so they cover all
three phases.

| Check | Result |
| --- | --- |
| `npm run typecheck` | clean — and the EN/AR dictionary is 2563 keys on both sides, with no key on one side only |
| `npm run build` | green — single self-contained HTML document, 2,344 kB (629 kB gzip) |
| `npm test` | 22/22 suites, 533 tests — including the new 24/24 Phase 17 access-control suite, 27/27 settings (was 24), 35/35 export, 15/15 role model, 12/12 enforcement |
| `npm run db:check` | migrations 0001–0028 apply, are idempotent, and match the app's row types, its role model (5 roles, 131 grants), the audit vocabulary (48 actions over 15 entities) and the seed — plus a new behaviour probe that resolves per-user exceptions in SQL |
| `npm run test:e2e` | 3/3 suites — smoke, auth, store · 0 console errors · 0 network calls |

What Phase 17 added on top of the Phase 15–16 snapshot:

- **Six capabilities, and the two areas they were missing from** — `view_customers`,
  `add_customer`, `edit_customer`, `delete_customer`, `view_cost`, `change_cost`, taking the
  model to 40. The customer book had existed for eight releases with no capability describing
  it, which is why no custom role could be built without it; cost had been gated by
  `change_price`, which conflated "may reprice" with "may see what the shop paid". History is
  part of `view_customers` rather than a fourth act: same screen, same person, same reason for
  looking. Grants: every role may view customers and cost; cashier and inventory clerk may add
  and edit customers and change cost; only manager and admin may delete a customer; viewer
  stays read-only (7 capabilities).
- **Per-user exceptions** — `profiles.extra_capabilities` / `denied_capabilities`, mirrored in
  the offline staff directory, resolved by `src/lib/permissions/exceptions.ts` and by
  `public.current_user_capabilities()` in SQL. Deny wins, and it wins in storage too: the
  write path drops a grant that a denial contradicts, so the disjointness constraint is never
  reached by a careless caller. Exceptions belong to the *person*, not the role — promoting
  somebody keeps them — and they sit on top of a custom role overlay exactly as they sit on
  top of the system matrix. `public.admin_set_user_exceptions()` is the only door to the
  columns: it requires `manage_users`, validates against `known_capabilities()`, and refuses
  to let an administrator deny themselves the console.
- **Access preview** — `src/lib/permissions/preview.ts` answers "what would this role actually
  see?" from the same three inputs the gates use and the same two tables they read. It is a
  projection, not a bypass: it never writes to the session, never calls `canAct`, and no guard
  in the app reads a value it returns. The suite signs a viewer in, previews an administrator,
  and asserts the viewer is still refused everything they were refused before.
- **Cost, gated in five places** — the product form hides the field without `view_cost` and
  makes it read-only without `change_cost`; the product page and table hide cost, profit and
  margin; the products and inventory exports drop the cost, margin and stock-value columns and
  keep their totals aligned with the columns they actually wrote; the Excel importer discards a
  cost column from a seat that may not change one, and says so in the modal. Profit is derived
  from cost, so it is gated with it rather than separately.
- **The customer book, gated in three places** — the screens hide what a seat may not do, the
  service asserts the capability before it touches a repository, and migration 0028 gives
  `public.customers` four policies that ask `public.can()` for the matching capability. It is
  the only tenant table tightened here: the rest are written from inside `security definer`
  RPCs whose checks live in the service layer, and tightening them is a change of its own.
- **The Roles screen** — search across names in both languages, key, description, base role and
  the permissions a role holds (so "which role may approve a refund?" is a question the screen
  answers); duplicate a role into a new one with a unique name; a permission count, an
  action-verb tally and the assigned-user count on every card; a preview button per role and a
  global one. `PermissionPicker` now shows the verb of each act, and `PermissionSummary` states
  what a role may and may not do in words rather than tick boxes.
- **Users screen** — an exceptions button and badge per seat, opening `UserExceptionsModal`:
  two lists (grant / withhold), a live preview of the resolved result, and the same
  self-lockout refusal the service and the database make.
- **Audit** — one new action, `user.permissions_changed`, written by the service that changes
  them, recording `granted`, `ungranted`, `withheld`, `restored` and both lists as stored, so a
  row can be re-read later without guessing what "granted" meant at the time. No second trail.
- **Migration 0028** — seeds the 24 new `role_capabilities` rows, adds the audit action, the two
  profile columns and their disjointness constraint, `current_user_capabilities()`, the rewritten
  `public.can()` (deny → grant → overlay → matrix), `admin_set_user_exceptions()`, the four
  customer policies, and the grants. `npm run db:check` applies it, re-applies it to prove
  idempotence, and then *behaves* against it: it derives which capability to take away and which
  to grant from `role_capabilities` rather than hardcoding either, and asserts the grant reaches
  `can()`, the denial overrides the role's own matrix, deny wins over a grant of the same act,
  `current_user_capabilities()` agrees with `can()` capability by capability, a cashier calling
  the RPC is refused, an administrator denying themselves `manage_users` is refused, clearing the
  exceptions restores the matrix exactly, and all four customer policies ask for the capability
  they are named after.
- **Tests** — `src/lib/permissions/__tests__/accessControl.selftest.ts` (24) covers the exception
  arithmetic and its enforcement through real service funnels, the preview's agreement with a
  signed-in session and its inability to change one, and the catalogue's completeness: every
  capability has exactly one of seven verbs, belongs to exactly one group, is translated in both
  languages (label, hint and denial copy), is held by at least one role, and is read by a gate
  somewhere in `src/`. The settings suite gained three: exceptions end to end through
  `authenticate()`, an exception travelling with a person across a role change, and role search
  (both languages, key, description, base role, permission id and permission label, multi-term
  narrowing, stable order, empty results). The export suite gained two negative cost-gating
  tests, and the auth suite now asserts `/customers` is *not* an open path.

Deliberately not done, and why:

- **No supplier capabilities.** There is no supplier entity in the schema or the app, so a
  `view_suppliers` group would have been a permission that gates nothing — the exact drift the
  catalogue tests exist to catch. Adding the entity is its own phase.
- **Cost is scoped to the catalogue.** `view_cost` / `change_cost` gate products, their exports
  and their imports. Reports that show margin keep their existing `view_reports` gate: changing
  what a report reveals is a reporting decision, not a catalogue one.
- **No role sorting.** The Roles screen lists roles in store order and search preserves it
  (asserted), because inventing a sort order nobody asked for would change what "first" means on
  a screen administrators recognise.
- **`enforcement.selftest.ts` runs signed out.** Its `signInAs` helper writes a session and then
  calls `resetSessionCache()` + `primeCacheFromStorage()`, and with no `localStorage` in node the
  prime reads nothing back — so every caller in that suite is anonymous and its refusals pass for
  the right result and the wrong reason. Phase 17's suite does not repeat the mistake (it relies
  on the in-memory cache `writeStoredSession` already primes, and stubs storage where persistence
  is the thing under test), and the settings suite has always stubbed it. Fixing the older suite
  means giving it the same stub and re-checking 12 assertions that have never actually run
  authorised, which is a change of its own rather than a rider on this one.

## Verification snapshot after Phase 20

Phases 18 (backup, recovery and data safety, commit `71409fc`), 19 (full system QA
and hardening, `59928b9`) and 20 (production readiness) are the first three phases
that added no new selling surface: they protect the installation, prove what is
already there, and document it. The numbers below are the ones taken at the end of
phase 20.

| Check | Result |
| --- | --- |
| `npm run typecheck` | clean — and the EN/AR dictionary is 2793 keys on both sides, with no key on one side only and none that translates to nothing |
| `npm run build` | green — single self-contained HTML document, 2,434.65 kB (652.09 kB gzip) |
| `npm test` | 24/24 suites — including 28/28 Phase 18 backup and recovery, 24/24 Phase 17 access control, 6/6 Phase 19 system-QA invariants, 27/27 settings, 15/15 role model, 12/12 enforcement |
| `npm run db:check` | migrations 0001–0029 apply, are idempotent, and match the app's row types, its role model (5 roles, 139 grants), the audit vocabulary (55 actions over 16 entities) and the seed — plus behaviour probes for the custom-role overlay, per-user exceptions and the customer-book gate |
| `npm run test:e2e` | 4/4 suites — smoke, auth, store, and the 9-step backup/recovery flow · 0 console errors · 0 network calls |

### What phase 18 added

A snapshot of the whole installation in both modes the app runs in. Offline it is
a JSON document in this browser's storage; live, migration 0029 builds it inside
one statement, in foreign-key order, with the database's own md5 over the payload.
Restore is admin-only through the matrix, needs a typed word and exactly one
source, validates format/version/mode/completeness/checksum before touching
anything, and first snapshots the state it is about to replace — so rollback is a
row in the list (`pre_restore`) rather than a promise. The audit log is carried by
a snapshot but never rewritten by a restore. Five capabilities
(`view_backups`, `create_backup`, `restore_backup`, `export_backup`,
`run_health_check`) sit in a new Data safety group; a manager may protect the
installation and may not replace it or carry it out. The emergency export reuses
the existing workbook builders and the existing `export_data` capability — there is
no second export engine.

It also fixed a routing bug the acceptance flow could not work around:
`<Route path="/settings">` had no splat, so React Router never handed it a deeper
path and every settings URL — Users, Roles, Approval rules — fell through to the
catch-all and landed on the dashboard.

### What phase 19 found and fixed

Two defects, both medium, both fixed and both pinned by a new invariant suite
(`src/lib/qa/__tests__/systemQa.selftest.ts`): the login form cleared its busy flag
only on the success path, so a rejection wedged the Sign in button forever; and
nine physical alignment utilities (`text-left`/`text-right`) did not flip in Arabic
against an app that uses logical utilities in 258 other places. The suite also
holds dictionary parity and sidebar-to-route parity, and each invariant was
mutation-tested — reintroducing either defect fails it by file and line.

Everything else came back hardened: dates are local-calendar everywhere so no day
boundary drifts; self-lockout is refused on the client and in SQL for all three
vectors; the audit log is append-only by trigger and by policy; `recordAudit`
cannot break the act it records; no console output carries a token, password or
session; and the client only ever holds the Supabase anon key.

### What phase 20 reviewed and deliberately left alone

* `src/main.tsx` keeps its five-line boot trace, and `receipt.ts` keeps two
  `[receipt-print]` diagnostics. None carries sensitive data, and the print path
  fails silently in the field (popup blockers), so the breadcrumbs are worth more
  than the quiet. The boot trace is also retained by explicit instruction.
* `importOpeningStock` is reachable only from its tests, and 348 dictionary keys
  are declared but unreferenced. Both are recorded rather than deleted: the parser
  is exercised and correct, and deleting keys risks breaking a dynamic lookup for
  no user-visible gain.
* The single-file build inlines the dynamic `xlsx` import — one 2,259 kB script, no
  external references — so its bytes ship and parse at first paint although it only
  executes when an export runs. Splitting it would mean giving up the single-file
  deliverable, which is a deployment decision rather than an optimisation.
* `view_cost` is enforced in the screen and the service, but in live mode
  `cost_price` rides along on a row the reader may already select: Postgres
  row-level security has no column-level equivalent. Closing it needs a cost-free
  view and a client that reads it.

### Known limitations carried into production

1. There are no `suppliers` or `purchases` tables in this schema, so neither can be
   backed up or reported on. Payments are covered through `sale_payments`.
2. Offline snapshots live in the browser's own storage: another device is another
   installation, and the storage quota is a real ceiling (detected and reported, not
   extended).
3. Offline automatic backups fire the first time an admin opens the panel after one
   falls due — a browser has no background job. Live mode exposes
   `public.automatic_backup_if_due()`, but scheduling it needs pg_cron or an
   external scheduler, which a migration cannot install. See
   [`DEPLOYMENT.md`](DEPLOYMENT.md) §9.
4. A live restore is one transaction; an offline restore can fail partway and cannot
   undo itself, so it names the `pre_restore` snapshot that can.
5. Backup files are plain JSON, not encrypted. They contain users and the audit
   trail, which is why `export_backup` is admin-only.
6. Schema compatibility is a single version number. A future version needs an
   explicit upgrade path; today a mismatch is refused rather than guessed at.
7. The data-health report diagnoses and never repairs, by design.
