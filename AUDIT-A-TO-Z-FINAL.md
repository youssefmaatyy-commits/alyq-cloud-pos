# ALYQ · Final A-to-Z Project Audit

**Date:** 2026-09-14 · **Branch:** `arena/01a0a01f-alyq-cloud-pos` · **Starting HEAD:** `e04fb0c` · **Ending HEAD:** see §17/§20
**Method:** static analysis of every tracked file · live schema dump (PGlite, real PostgreSQL engine, all 36 migrations) · 6-suite DOM E2E against the built bundle · 24+ logic self-test suites · **mutation testing** (3 deliberate weakenings, each proven caught) · full toolchain battery. No hosted Supabase project is reachable from this environment; everything is reported as LOCAL/CI PROVEN or HOSTED-UNVERIFIED accordingly.

**Incident note (recovered, zero loss):** mid-audit the sandbox was re-cloned — the local branch pointer reverted to `de9c111` while the workspace held the two newer commits' content as unstaged files. Remote was always intact at `e04fb0c`. The working tree was proven **byte-identical** to the remote tip before any action, then the local pointer was fast-forwarded (no reset, no history rewrite, no force). Verified afterwards: local == remote == `e04fb0c`, clean tree.

---

## 1. Executive summary

The project is in a **healthy, internally consistent, well-tested state**. The database layer is the security authority and the test suites genuinely enforce it (proven by mutation testing, §15). One Low-severity UI inconsistency was found and fixed (§16/§17). One High-severity **dependency advisory** (`xlsx`) has no npm-published fix and is, by this audit's own rules, an operator decision (§11). No Critical findings. Nothing about InstaPay, password recovery, migrations or branding was modified.

Bottom line: all local/CI gates pass; the remaining risk surface is (a) the xlsx supply-chain decision, (b) hosted-project configuration and verification that cannot be performed from here (§20).

## 2. Project inventory

| Area | Count | Notes |
|---|---|---|
| Tracked files | 430 | 350 `src/`, 40 `supabase/`, 14 `scripts/`, 7 `docs/`, 2 `public/`, root configs |
| Modules | 16 | online (52 files), products (35), pos (24), reports (22), settings (21), returns (19), inventory (19), shifts (17), approvals (16), customers (15), backup (15), expenses (12), audit (11), dashboard (4), storefront-link (1), + `lib/` (auth 24, permissions 12, supabase 4, export 4, i18n 3, qa 1) |
| Route registrations | 59 `<Route>` | incl. nesting + 3 catch-alls (§3) |
| Page components | 45 `*Page.tsx` | |
| Modals | 18 `*Modal.tsx` | |
| Hooks/providers files | 17 | AuthProvider, PosProvider, StorefrontProvider, InventoryProvider, useRealtimeWatch, … |
| Migrations | 36 | `0001`…`0036`, filename-ordered, applied twice by db:check |
| DB tables / views / sequences | 37 / 2 / 3 | §7 |
| RLS policies | 107 | 102 public + 5 `storage.objects` |
| DB functions (public schema) | 151 | incl. pgcrypto/pg_trgm/uuid extension functions; app-defined ≈ 60 |
| Triggers / FKs / indexes | 40 / 28 / 125 | §7 |
| Test files (`src/**/__tests__`) | 27 | + 6 E2E suites in `scripts/` |
| Dependencies | 7 prod, 16 dev | §11 |

Classification: everything in `src/` is **actively used** except the items listed in §9 (1 orphan file, 1 vestigial env declaration, cosmetic legacy IDs). `supabase/tests/*` and `scripts/*` are **test/CI-only** by design. Demo repositories (`data/demoRepository.ts` per module) are **demo-only** by design (documented offline mode), not dead code.

## 3. Routes tested

**Auth (public):** `/login`, `/forgot-password`, `/reset-password` — driven by `auth.flow.mjs` (9 steps: sign-in, wrong password, expiry, unauthorized blocked, logout) and the 27-test Supabase auth contract suite (PKCE + implicit recovery links, deactivated-account refusal, enumeration resistance).

**Storefront (public, 10 routes):** `/store` index, `products`, `products/:key`, `cart`, `checkout`, `confirmation`, `track`, `account`, `contact`, catch-all → `/store`. Driven end-to-end by `store.flow.mjs` (176 assertions): public render with nobody signed in, browse/search/product/cart, guest COD checkout, tracking by number+phone, InstaPay proof submission.

**App shell (authenticated, 31 paths + catch-all → `/`):** `/` · `/products` (+`new`,`/:id`,`/:id/edit`) · `/categories` · `/inventory` (+`/movements`) · `/pos` (+`/sales`,`/sales/:id`) · `/customers` (+`/:id`) · `/returns` (+`/:id`) · `/refunds` (+`/:id`) · `/shifts` (+`/history`) · `/expenses` · `/approvals` · `/reports` (+`/advanced`) · `/online/{orders,reservations,website,marketing,content,reports}` · `/audit` · `/settings/{users,roles,approvals,backup}`.
- Every route element resolves (typecheck + build prove imports); no dead routes; no duplicate feature routes (`/approvals` inbox vs `/settings/approvals` rules are distinct features; `/reports` vs `/reports/advanced` likewise).
- **All 27 sidebar NavItems map to registered routes** (cross-checked one-by-one); no menu link points at a missing route.
- Direct-URL navigation to a gated route renders the RouteGuard denial (proven in `auth.flow.mjs` step 6 for `#/audit`, `#/pos`, plus data-leak assertions: no `EXP-######`, no POS data in the denial screen); `/audit` additionally self-guards with specific copy.
- Permission gates: 23-entry `ROUTE_CAPABILITIES` table read by both sidebar and guard (single source, cannot disagree); `/audit` self-guarded; storefront public by design; back-office never loads for anonymous visitors (store.flow step 1).
- Refresh/back-forward: HashRouter deep links work from any static host (design note in App.tsx); recovery-link fragment collision handled at boot (`normalizeRecoveryUrl`, unit-tested).

*Limitation (honest):* routes were exercised in jsdom (real bundle, real React), not in a desktop/mobile browser — visual layout per viewport is a manual/hosted item (§20).

## 4. Buttons & interactive controls

330 `<Button>`/`<button>` elements enumerated. Findings:
- **0** no-op handlers, **0** `TODO`/`FIXME`/"coming soon" markers, **0** raw `alert()`/`confirm()` (destructive confirmations use in-app modals, e.g. backup restore requires typing a word).
- Disabled-when-appropriate pattern verified on the highest-stakes controls: Complete Sale (busy-guarded; not even rendered for a denied viewer — asserted in E2E), Adjust Stock (disabled for viewer — asserted), proof submit (busy states `upload`→`submit`), double-submit guards (`setBusy`/`setSubmitting`/`setSaving`) present in 33 components.
- **1 misleading control found (Low, FIXED):** the Customers sidebar link was rendered unconditionally; for a *custom role* that denies `view_customers` it offered a screen the guard then refuses — contradicting RouteGuard's documented layer-1 promise. System roles were never affected (§16 F1).
- Duplicate-action scan: no two controls perform the same action unintentionally; the historical "Open website does nothing" defect was fixed in earlier commits (`1a3d182`, `ff02149`) and the storefront-link selftest pins the literal route.

## 5. Forms

18 `<form>` elements + modal forms (18 modals). Audited: login (busy-guard, remember-me, coded errors), forgot-password (single field, enumeration-resistant answer, demo-channel honesty), reset-password (single-consume link guard against StrictMode double-mount, confirm-match, policy checklist), users/roles (admin; server-mirrored validation in `alyq-admin`), products/categories (duplicate-SKU rejection, delete-in-use guard — E2E), POS sale (split payments, discount → approval interplay), returns/refunds (lifecycle invariant triggers), expenses/shifts (numbering + invariant triggers), approvals (decide/apply), reports filters (SQL-bounded windows), website/payment settings, InstaPay proof (type/size pre-checks, server-side bucket enforcement), online checkout (guest + account, COD/InstaPay), tracking (number+phone gate).
Checks: required fields, invalid/empty values, double submission (busy-disabled), Enter key (native form submit), loading/disabled/success/failure states, stale-state resets (`clearError` on fresh form — login), permission gating. Evidence: module `validation.ts` per domain + 27 settings tests + E2E flows; the i18n dictionary carries every error key used (EN/AR parity enforced by typecheck).

## 6. End-to-end workflows tested

| Requested flow group | Evidence | Result |
|---|---|---|
| Staff auth (login/logout/inactive/wrong password/recovery/change) | `auth.flow.mjs` 9 steps + 27 contract tests + 17 auth selftests | ✅ |
| User management (create/edit/disable/roles/custom/denied/extra) | settings selftests 27/27; `alyq-admin` design (capability re-check as caller); scenarios: custom-role overlay + exceptions (`can()` follows deny-wins) | ✅ |
| POS (sale/discount/over-limit/approval/payment/receipt/stock/return/refund/void/confirm) | `smoke.dom.mjs` 498 assertions; DB scenarios Phase 23 (viewer refused all four POS writers; cashier may sell, not void) + Phase 24 (99.9% discount refused without a spent approval; approval consumed exactly once) | ✅ |
| Customers (create/update/history/search) | customers selftests + DB gate ("the customer book is gated in the database") | ✅ |
| Products (create/edit/stock/images/categories/prices/cost visibility/hidden) | smoke suite (incl. file upload, negative-stock blocked, archive/restore), `enforce_price_authority` trigger, cost gated by `view_cost` | ✅ |
| Online store (home→catalogue→search→product→cart→checkout→COD/InstaPay→proof→confirmation→tracking→approval→cancel→order-to-POS→reservations) | `store.flow.mjs` 176 assertions (approve creates a real `source="online"` sale, stock hold deducted, proof stays at verification); reservation repair selftests 30/30 | ✅ |
| Reports (pages/filters/large datasets/advanced/exports) | `reports.aggregates.mjs`: PostgreSQL RPCs vs shipped TS builders over **2,500 invoices** — identical numbers; export modules selftested | ✅ |
| Settings (website/payments/theme/social/users/roles/backup) | `backup.flow.mjs` 15 steps (permissions, snapshot, schedule, typed-word restore, manager limits) + settings selftests | ✅ |

## 7. Database / table audit (live dump of the migration-built schema)

- **37 tables**; RLS enabled on 36. Sole exception `role_aliases` — static reference data (alias→role mapping), **no grant to `anon`**, browser-unreachable; accepted (Informational).
- **Fail-closed counters:** `sale_counters`, `return_counters`, `refund_counters` have RLS enabled and **zero policies** — only the SECURITY DEFINER numbering functions touch them. Correct by design (Verified OK).
- **28 FKs**, behaviours deliberate: financial history protected (`sale_items→products`, `sales_returns→sales`, `refund_records→sales` RESTRICT), child rows CASCADE (`sale_items`, `return_items`, `online_order_items`, `sale_payments`), optional links SET NULL (`sales.customer_id`, `online_orders.sale_id`, `expenses.shift_id`), vocabulary integrity (`audit_log.action→audit_actions`). No orphan paths found in normal workflows (order→sale conversion sets `sale_id`; cancellation keeps the order).
- **125 indexes, zero redundant pairs** (no two indexes share a column list); search uses a trigram GIN over the combined name/sku/barcode expression; hot paths (status+created_at, customer+created_at, client_ref idempotency uniques) covered. No missing-index candidates for the query shapes in the repositories.
- **40 triggers**: invariant enforcers (audit append-only, shifts/expenses/refunds/approvals, negative stock, price authority, category cycle/delete-in-use) + `updated_at` stampers. **Finding (Cleanup, deferred):** 6 storefront tables (`campaigns`, `coupons`, `online_orders`, `product_content`, `store_faqs`, `website_settings`) carry **two** BEFORE UPDATE triggers doing the identical unconditional `updated_at := now()` (`*_set_updated_at` backfilled by 0030 over 0017's `*_touch_updated_at`). Harmless (same value, negligible cost); removing needs a new migration for zero behavioural gain — report-only per audit rules. `sales` has no stamp trigger by design: its RPCs set `updated_at` explicitly and no client path updates the table directly (grep-verified).
- Timestamps/audit columns (`created_by`/`updated_by` via `set_audit_columns`) present where required; 3 sequences + counter tables for numbering.
- No obsolete tables found; every table is queried by a repository/RPC (db:check asserts exactly this: "every table the repositories call `.from()` on exists, is RLS-enabled, and is selectable by `authenticated`").

## 8. RLS / RPC / security audit

- **107 policies** (102 public + 5 storage). Storage: after 0036 — anon INSERT only under `proofs/` (`storage.foldername(name)[1]='proofs'`), no anon select/update/delete; authenticated retains management; bucket public=true, 5 MB cap, SVG excluded (all re-verified in the live dump this audit).
- **Anon-reachable tables:** exactly the 5 storefront read tables (`website_settings`, `store_faqs`, `store_reviews`, `campaigns`, `product_content` — SELECT only). `products`/`categories`/`online_orders` are **not** anon-readable; the shop window is served by SECURITY DEFINER RPCs that publish derived answers only (`storefront_catalogue/best_sellers` — proven in scenarios: no `cost_price`, no `created_by`, no internal columns leak).
- **All SECURITY DEFINER functions pin `search_path`** (dump query for secdef-without-search_path returned **empty**).
- **Grant matrix sane:** reports RPCs `anon=false, auth=true`; internal machinery (`build_snapshot_document`, `automatic_backup_if_due`, `prune_backups`, `approval_assert_satisfied`) `anon=false, auth=false` (service-role/pg_cron only); storefront + POS + admin RPCs executable by both browser roles **with internal authorization** — Phase 23 scenarios prove each POS writer enforces the capability matrix itself; admin RPCs re-check `can('manage_users'/'manage_roles')` as the caller; `seed_demo_staff` admin-gated; `alyq-admin` edge function re-verifies caller capability server-side before touching credentials.
- **Three-layer parity (UI ↔ route ↔ DB) verified:** `canAct` (resolved custom-role capabilities) drives buttons; the same `ROUTE_CAPABILITIES` table drives sidebar+guard; `public.can()` drives policies/RPCs; db:check's parity assertions pin `role_capabilities`↔`ROLE_CAPABILITIES` (5 roles, 139 grants), audit vocabulary (55 actions), role aliases, seed presets, and column shapes against the TS row types.
- **No feature is protected only by the frontend**: every write path is an RPC or a policy-gated table; prices are catalogue-derived server-side (`place_online_order` prices against the catalogue, 0034 line prices, `enforce_price_authority` trigger); approvals cannot be borrowed/reused (Phase 24 consumption invariant, mutation-proven §15); signup cannot self-promote (0030: no metadata ⇒ inactive viewer; scenarios pin it); audit rows cannot be forged casually (append-only trigger + oversight-only policies; attribution is client-stamped — documented narrower gap in `AUTHENTICATION.md` §6.5).
- Secret hygiene re-verified: zero JWT-shaped strings in tree **and in all history**; `.env*` ignored (only the empty template tracked); `service_role` appears only in the edge function + operator docs; browser bundle (fresh build) contains no secret patterns.

## 9. Dead-code findings

| Item | Class | Status |
|---|---|---|
| `src/modules/returns/services/returnsReports.ts` (computeCustomerAnalytics/computeReturnsAnalytics) | **Orphan**: zero app imports; only its own selftest imports it. The shipped analytics UI uses `reports/services/salesAnalytics.ts`. Reachability proven exhaustively (static imports, dynamic `import()`, barrels, string registries) | Deferred — report-only: proven unused, but intent uncertain (may be a planned Returns tab); deletion would also remove its tests. Operator decision |
| `VITE_DEMO_SEED` | Vestigial: declared in `vite-env.d.ts`, documented in `.env.example`, read by no code | Deferred (Informational) |
| `demoSeed.ts` legacy ids (`cat-coffee`, `cat-beverages`, …) | Cosmetic: opaque identifiers only; every **visible** name is accessories-correct; changing ids churns demo data for zero user value | Deferred (Informational) |
| `DashboardPage.tsx.backup` | Historical (existed at `d699a95`); **already removed** — not tracked at HEAD | Verified OK |

**Items removed: 0** — per the rule "do not remove code only because it looks unused / if uncertain, report only".

## 10. Duplicate-code findings

- **Class C (dangerous duplicated business logic): none live.** The one true parallel implementation (`returnsReports.ts` vs `salesAnalytics.ts`) has an **orphaned** side (§9), so no shipped rule exists twice. The reports differential suite actively proves the TS builders and SQL RPCs agree over 2,500 invoices — duplication of *computation* across the TS/SQL boundary is pinned equivalent, not drifting.
- **Intentional, documented mirrors (Class A):** password policy (client `passwordPolicy.ts` ↔ `alyq-admin` floor ↔ Supabase Auth verdict — the file headers state which one counts); demo↔supabase repository pairs (the mode seam); validation mirrored in RPCs ("a request that skips the form meets the same bar").
- **Class B (share-a-helper candidates, low value):** `extensionForMime` duplicated in `imageStorage.ts`/`imageUpload.ts` (12-line pure maps); error-code mapping idioms per module. Refactoring these trades churn for nothing measurable — report-only.
- **DB:** the doubled `updated_at` triggers (§7) — the only structural duplication found; deferred.

## 11. Dependencies

Prod (7): `@supabase/supabase-js` (4 files), `react`/`react-dom` (19.2), `react-router-dom` (47), `clsx` (1), `tailwind-merge` (1), `xlsx` (2). Dev (16): build/test tooling, correctly scoped (pglite, esbuild, jsdom, eslint, typescript, vite, singlefile plugin, tailwind, types). No unused prod deps; no duplicate packages; no prod/dev misplacement.

- **`xlsx@0.18.5` — HIGH advisory, NO npm fix (Deferred — Needs operator decision).** GHSA-4r6h-8v6p-xvw6 (prototype pollution) + GHSA-5pgg-2g8v-p4x9 (ReDoS). SheetJS publishes fixes (0.19.3+/0.20.2+) **only via cdn.sheetjs.com**, not the npm registry, so `npm audit fix` cannot resolve it and this audit's rules forbid major/supply-chain upgrades absent a *critical* CVE. Context: the attack surface is the **admin-gated Excel import** (a crafted file opened by a privileged staff member in their own browser) — not anonymous-reachable. Operator options: (a) switch the dependency to the SheetJS CDN tarball at 0.20.x, (b) accept the risk formally given the privileged-only surface, (c) replace the library (refactor — out of audit scope).
- Bundle: single-file by design (`vite-plugin-singlefile`), 2.45 MB / **658 KB gzip**; xlsx is the dominant weight. Informational — the design is deliberate (offline static hosting).

## 12. Performance

- Realtime: `realtime.ts` returns unsubscribes; `useRealtimeWatch` and providers clean up channels; **3/3 `setInterval` sites pair with `clearInterval`** (auth heartbeat, online notifications, homepage rotation); no leaked-listener patterns found.
- Queries: sales history pages in SQL (`range()` + `SALES_ROW_CAP`, bounds pushed down "rather than fetching history and filtering it"); reports bounded/date-filtered/paged since Phase 22 and computed in SQL since 0032; online-order lists accept limits; storefront reads are derived-answer RPCs, not table scans.
- E2E suites assert **0 network calls** in demo mode and **0 console errors** everywhere.
- Not measured (requires hosted/browser): real-device render performance, live query plans, CDN behaviour. §20.

## 13. UI/UX · mobile · RTL

- **RTL/LTR** exercised by the smoke suite (direction switch asserted); `dir`/`lang` driven by the i18n provider; layout uses logical properties (`me-`/`ms-` Tailwind classes observed).
- **Branding:** dictionary carries the official identity (`ALYQ | أَلِــيْـــق`, accessories taglines). A dedicated **codepoint-built** branding selftest pins the exact Arabic wordmark (its header documents three historical near-miss spellings it now prevents). Visible demo catalogue is fully accessories (Jewellery/Earrings/Necklaces/Rings/Bracelets/Hair Accessories); remaining "coffee/beverages" strings are (a) opaque seed IDs, (b) SQL comments, (c) isolated test fixtures (`مشروبات/Beverages` scenario rows) — all allowed under the audit's fixture exception. No "Women's Accessories Store" anywhere.
- EN/AR dictionary parity is a **typecheck gate** (documented in package scripts) — a missing translation fails the build.
- Loading/empty/error states: shared `EmptyState`/`LoadingBlock` components; denials render role-named copy; destructive actions require typed confirmation (backup restore).
- **Not testable here:** true visual layout at tablet/mobile widths, touch-target sizing, contrast rendering — jsdom has no layout engine. Listed in §20 as manual checks.

## 14. Accessibility

229 `aria-*` attributes; 21 explicit ARIA roles; form errors use `role="alert"`, success `role="status"`; **every `<img>` carries `alt`** (verified tag-by-tag: meaningful images get translated alt text, decorative ones get the correct empty `alt=""`); recovery forms use `autoFocus` + `aria-label`; keyboard operation relies on native form submit and real `<button>`/`<Link>` elements (no div-clicks found). Static contrast check not performed (no rendered styles in jsdom) — §20.

## 15. Test-quality findings (mutation-proven teeth)

Three deliberate weakenings, each confirmed **caught by the intended suite**, each restored byte-exact (`git checkout --`, verified clean):

| Mutation | Gate that caught it | Failure message |
|---|---|---|
| M1: removed the `proofs/` prefix clause from 0036's anon policy | `db:check` anonymous-storage scenario | `anon uploaded outside the proofs/ namespace` |
| M2: `approval_required_for('discount') → false` in 0035 | `db:check` Phase-24 scenario | `the discount approval was not spent on the sale it authorised` |
| M3: `RouteGuard` always renders children | `auth.flow.mjs` step 6 | `the register was served to a viewer` |

**False-positive control:** the audit's own first hypothesis (viewer lacks `view_customers`) was **disproved by the E2E run** before it could ship as a wrong "fix" — the viewer matrix does include `view_customers`; the test failure forced re-examination (§16 F1 final framing). Suites fail on *any* `console.error` (except the crash suite, which asserts the boundary instead). No assertion-free or tautological tests found in the security-critical suites; the contract tests drive the real repository against a scripted client.

## 16. Bugs discovered

| # | Severity | Finding | Status |
|---|---|---|---|
| F1 | **Low** | Sidebar offered *Customers* unconditionally. For a **custom role** denying `view_customers`, the link led to a denial screen — contradicting RouteGuard's documented layer-1 contract. (System roles unaffected: all five hold the capability; the initial "viewer is affected" framing was disproved during verification, §15) | **Fixed** (§17) |
| F2 | **High** (dependency) | `xlsx@0.18.5` advisories (prototype pollution, ReDoS); no npm fix exists; admin-only import surface | Deferred — **Needs operator decision** (§11) |
| F3 | Cleanup | Doubled `updated_at` triggers on 6 storefront tables (0030 backfill over 0017's loop) — same effect, redundant | Deferred (new migration for zero behavioural gain) |
| F4 | Cleanup | `returnsReports.ts` orphaned parallel analytics (test-only consumer) | Deferred — operator decision (§9) |
| F5 | Informational | `VITE_DEMO_SEED` declared/documented but read by no code | Deferred |
| F6 | Informational | Sequential order numbers (`WEB-######`) make the phone number the effective guest credential — accepted, documented design of the account-less checkout (same gate as tracking; staff verification still required before `paid`) | Verified OK (accepted design) |
| F7 | Informational | Payment proofs live in a public bucket as capability URLs (random UUID names; listing closed by 0036; private-bucket+signed-URLs would be a redesign) | Verified OK (accepted residual, documented) |
| F8 | Informational | Audit rows are client-attributed (name is self-reported) — every action passes a server-side capability check first; documented in `AUTHENTICATION.md` §6.5 | Deferred (known, narrowed) |

**Critical: 0 found.**

## 17. Bugs fixed

**F1 — one line,** `src/components/layout/AppShell.tsx`:
```diff
- <NavItem to="/customers" icon={<UsersIcon />} label={t("nav.customers")} />
+ <NavItem to="/customers" icon={<UsersIcon />} label={t("nav.customers")} visible={canOpen("/customers")} />
```
Defect shown: custom role minus `view_customers` sees a link whose destination refuses (guard layer 2 still held — no leak). Reproduced: statically via the capability table + RouteGuard contract; behaviourally via the viewer sidebar E2E assertions. Smallest safe change: the exact pattern its 15 sibling NavItems already use; `canOpen` reads the same resolved-capability source as the guard, so sidebar and guard cannot disagree. Regression evidence: `auth.flow.mjs` re-run **9/9 PASS** with the viewer sidebar unchanged (`#/customers` still offered — viewer holds the capability; the four truly-hidden routes still absent). Surroundings unchanged: full battery re-run green (§19). **No test file was modified** (an initially-added assertion was reverted after §15 disproved its premise).

## 18. Items intentionally not changed

Historical migrations (including the redundant trigger pairs — F3 needs a *new* migration for no behavioural gain) · `returnsReports.ts` + its tests (F4, uncertain intent) · `VITE_DEMO_SEED` (F5) · demoSeed legacy IDs (opaque) · `xlsx` (F2, audit rules forbid the supply-chain change; operator decides) · single-file bundle design · knowledge-gated guest checkout (F6) · public bucket model (F7) · client-attributed audit (F8, documented design with a stated path) · `role_aliases` without RLS (reference data, ungranted to anon) · 23 pre-existing lint **warnings** (0 errors; mass-formatting forbidden).

## 19. Full test battery (run at the fixed tree)

| Gate | Result |
|---|---|
| `npm run typecheck` (incl. EN/AR dictionary parity) | ✅ PASS |
| `npm test` (27 test files; products 51, online 77, settings 27, auth 17+27, backup 28, …) | ✅ PASS — all suites |
| `npm run db:check` (36 migrations ×2 on real PostgreSQL/PGlite + 92 assertions + role scenarios incl. anonymous storefront & anonymous storage phases) | ✅ PASS |
| `npm run test:e2e` | ✅ PASS — **6/6 suites**, 0 console errors, 0 unexpected network calls |
| `npm run build` | ✅ PASS (2,450 kB / 658 kB gzip) |
| `npm run lint` | ✅ PASS (0 errors / 23 pre-existing warnings) |

**LOCAL/CI PROVEN:** everything above. **HOSTED SUPABASE UNVERIFIED:** §20 (no reachable project; nothing simulated).

## 20. Hosted-only checks still required (operator)

1. Apply migrations through `0036` (`supabase db push` or the documented psql loop) and verify the live bucket with the read-only SQL in the 0036 report (MIME list without SVG, 5 MB cap, the 5 storage policies and their roles).
2. Auth → URL Configuration: Site URL = `https://<ALYQ-HOST>/`; Redirect allowlist += `https://<ALYQ-HOST>/#/reset-password`.
3. Auth → SMTP: configure a production sender (built-in sender is rate-limited); run the 7-step recovery checklist in `DEPLOYMENT.md` §5.
4. Deploy `alyq-admin` (`supabase secrets set SUPABASE_SERVICE_ROLE_KEY=… && supabase functions deploy alyq-admin`).
5. The 10-item hosted smoke list (catalogue, anon field-exclusion, test order, forged-price refusal, viewer POS refusal, cashier sale, approval limits, proof path under 0036, reset request reaching Auth, reports) — with test data only.
6. Real-browser pass: desktop/tablet/mobile layout, touch targets, contrast, RTL rendering.
7. Decide F2 (xlsx source swap vs documented risk acceptance).

---

## Final numeric summary

| Metric | Value |
|---|---|
| Routes (registrations / page components) | 59 / 45 |
| Sidebar navigation items | 27 (all resolve to live routes) |
| Buttons/interactive controls audited | 330 button elements (0 no-op, 0 dead) |
| Forms audited | 18 `<form>` + 18 modals |
| Database tables / views / sequences | 37 / 2 / 3 |
| Functions (public schema, incl. extensions) / browser-called RPCs | 151 / 31 distinct |
| Migrations | 36 (all apply, idempotent) |
| RLS policies | 107 (102 public + 5 storage) |
| Triggers / FKs / indexes | 40 / 28 / 125 (0 redundant) |
| Dead-code candidates / proven-dead items removed | 4 / **0** (all deferred per rules) |
| Duplication findings | 4 (0 dangerous-live; 1 orphaned parallel impl; 2 intentional mirrors; 1 DB trigger pair) |
| Bugs found | 8 (1 Low fixed · 1 High dependency deferred · 3 cleanup/informational deferred · 3 informational accepted) |
| Bugs fixed | 1 (F1, one line, regression-proven) |
| Critical remaining | **0** |
| High remaining | **1** (F2 `xlsx` — needs operator decision; unfixable via npm; upgrade barred by audit rules) |
| Mutation tests | 3/3 caught, 3/3 restored byte-exact |
| Test gates | 6/6 PASS · tests passed: all suites (0 failed) · E2E 6/6 · db:check 92 assertions |
| Files changed by this audit | 2 (`src/components/layout/AppShell.tsx`, this report) |

**Completion determination:** every gate the audit can run locally passes; no Critical findings; the single High finding is a dependency advisory that this audit's own rules place out of bounds (no npm fix; no major/supply-chain upgrades) and is handed to the operator with options. Because a High item therefore remains *open pending operator decision*, and because hosted-Supabase verification (§20) could not be performed from this environment, the unconditional completion sentence is **deliberately not issued**. All work within the audit's authority is done, fixed, tested and reported honestly.
