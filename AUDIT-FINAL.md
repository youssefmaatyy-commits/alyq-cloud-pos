# ALYQ Cloud POS — Final Production Audit

**Date:** 2026-09-13 · **Commit audited:** `c1f9b86` · **Branch:** `arena/01a09298-alyq-cloud-pos`
**Method:** everything below was measured or executed, not inferred. Where a claim could not be
verified in this environment it is listed in §9 rather than guessed at.

**Scale audited:** 346 TS/TSX files · 98,615 lines · 29 migrations (9,113 lines SQL) ·
26 logic suites (571 test cases, 3,242 assertions) · 4 E2E flows (663 assertions) · 48 routes.

---

## 1. Verdict and scores

| Dimension | Score | Basis |
|---|---|---|
| **Overall system** | **6.5 / 10** | Excellent engineering discipline, but the live-mode data layer is effectively untested and contains three blockers. |
| **Production readiness** | **NOT READY (live mode)** / **READY (demo mode)** | See the split below. |
| **Code quality** | **7.5 / 10** | Strict TS, coherent modules, outstanding comments, idempotent migrations. No linter; 90 never-imported exports; a 2.4 MB monolith. |
| **Security** | **5 / 10** | Strong DB invariants and a correct capability model — but the model is not enforced on direct table writes, and signup can mint an admin. |
| **Performance** | **4.5 / 10** | Single-file bundle shipping both languages and the whole back office to every visitor; unbounded queries; no pagination or memoized rows. |
| **Testing** | **8 / 10** | Genuinely deep — including a real-PostgreSQL migration harness. One structural blind spot: every test runs in demo mode. |

### The readiness split, stated plainly

* **As an offline/demo product: ready.** 26/26 suites, 4/4 E2E, 29 migrations idempotent, CI green on the last 8 pushes, zero console errors, zero network calls.
* **As a live Supabase product: not ready.** Three defects (C1, C2, H1) all live in the layer that only exists in live mode — RLS policies, grants, and server-side row caps. Demo mode has no RLS, no grants and no row cap, so **no test in the repository can reach them.** That is the single most important sentence in this report: the test suite is excellent and structurally blind to exactly the place where the product breaks.

Fixing C1+C2+H1 is roughly one migration and one trigger change. None of it requires touching the
ecommerce engine, the POS, or the inventory logic.

---

## 2. Critical findings

### C1 — The public storefront cannot read the catalogue in live mode
**Location:** `src/modules/storefront/data/storefrontCatalog.ts:20-45`; policies from
`supabase/migrations/0003…`, `0015_pos_card_payments.sql:302-303`.

**Problem.** The file's own header says *"No authentication required — this is the public
storefront"* and then runs:

```ts
client.from("products").select("*").eq("active", true).eq("show_on_website", true)
client.from("categories").select("*").eq("active", true)
```

But the database has **no anonymous access to either table**:

| Table | SELECT policies | Roles | Grant to anon |
|---|---|---|---|
| `products` | `products_select_authenticated` | `{authenticated}` | none |
| `categories` | `categories_select_authenticated` | `{authenticated}` | none |

Measured on a real PostgreSQL engine with all 29 migrations applied:

```
website-visible products (superuser sees) : 3
website-visible products (anon sees)      : 0
active categories      (anon sees)        : 0
```

Meanwhile `product_content`, `campaigns`, `store_faqs`, `store_reviews` and `website_settings`
*do* have public policies — so the storefront pass was done for the content tables and missed the
two that actually carry the shop.

**Impact — CRITICAL.** In live mode the shop renders **empty**, and silently: RLS returns an empty
set rather than an error, and the code only throws on `result.error`. A merchant deploying to
Supabase gets a working back office and a blank storefront. If the project does not carry
Supabase's default table grants, the same call instead fails with `permission denied for table
products` and the storefront shows an error.

**Secondary issue in the same code path.** Once anonymous reads are enabled naively, `select("*")`
would publish `cost_price`, `stock_quantity` and `low_stock_level` to every visitor.

**Recommended fix (safest, matches an existing pattern).** Do not widen the staff policies. Add a
migration exposing a purpose-built public surface — the same approach `0019` already uses for
`storefront_best_sellers` (SECURITY DEFINER, stable, pinned `search_path`, granted to anon):

```sql
create or replace function public.storefront_catalogue()
returns table (id uuid, sku text, barcode text, name_ar text, name_en text,
               description_ar text, description_en text, category_id uuid,
               selling_price numeric, sale_price numeric, stock_quantity integer,
               image_url text, images jsonb, is_featured boolean, created_at timestamptz)
language sql stable security definer set search_path = public as $$
  select id, sku, barcode, name_ar, name_en, description_ar, description_en, category_id,
         selling_price, sale_price, stock_quantity, image_url, images, is_featured, created_at
    from public.products where active and show_on_website
$$;
grant execute on function public.storefront_catalogue() to anon, authenticated;
```

Point `fetchStorefrontCatalog()` at it (plus an equivalent for active categories), and add an E2E
step that runs the storefront **as `anon`** — that single assertion is what would have caught this.

---

### C2 — A signup can mint itself an active administrator
**Location:** `supabase/migrations/0014_audit_policies_and_seed.sql:93-127` (`handle_new_user`).

**Problem.** The trigger derives the role from user metadata, which a Supabase client sets freely at
signup:

```sql
v_meta := coalesce(new.raw_user_meta_data,'{}') || coalesce(new.raw_app_meta_data,'{}');
v_role := public.normalize_app_role(v_meta->>'role');
insert into public.profiles (…, role, active)
values (…, coalesce(v_role,'viewer'), v_role is not null);
```

The doc comment claims this "fails closed", and it does — *when metadata is absent*. It does not
when metadata is supplied. Executed against the real schema:

```
attacker-declares-admin        role=admin    active=true   ← ⚠ ACTIVE ADMIN
attacker-declares-owner        role=admin    active=true   ← ⚠ ACTIVE ADMIN
attacker-declares-superadmin   role=admin    active=true   ← ⚠ ACTIVE ADMIN
attacker-declares-manager      role=manager  active=true
honest-signup-no-metadata      role=viewer   active=false  (fail-closed ✓)
```

The alias list (`owner`, `superadmin`, …) is seeded in a migration file, i.e. public knowledge.
The anon key and URL are compiled into the shipped bundle, so both halves of the attack are public.

**Impact — CRITICAL, conditional.** If email signup is enabled in the Supabase project (Supabase's
default), anyone can register and immediately hold all 45 capabilities. *I cannot verify your
project's auth settings from here* — see §9.

**Recommended fix.** Trust role metadata only from the service role, and always create the profile
inactive:

```sql
v_role := case when coalesce(nullif(current_setting('request.jwt.claim.role', true),''), 'anon')
                    in ('service_role')
               then public.normalize_app_role(v_meta->>'role')
               else null end;
-- and insert with active = false in every case; an admin promotes via upsert_staff_profile()
```

Also disable public sign-up in the dashboard and record that in `DEPLOYMENT.md`, so the code and
the operational control agree.

---

## 3. High findings

### H1 — The capability model is not enforced on direct table writes
**Location:** policies on `products`, `categories`, `stock_movements` (all `with_check (true)` for
`authenticated`); `sale_counters` / `refund_counters` / `return_counters` (RLS disabled, no REVOKE).

**Problem.** 16 write policies correctly gate on `public.can(...)` — customers, expenses, shifts,
website settings, coupons, campaigns, online orders. Five do not:

```
categories       categories_write_authenticated    INSERT  with_check = TRUE
categories       categories_update_authenticated   UPDATE  with_check = TRUE
products         products_insert_authenticated     INSERT  with_check = TRUE
products         products_update_authenticated     UPDATE  with_check = TRUE
stock_movements  stock_movements_insert_authenticated INSERT with_check = TRUE
```

Verified by writing as a seeded **viewer** (which `can()` correctly denies `add_product`,
`edit_product`, `change_price`, `adjust_stock`) and reading the state back:

```
price before            : 32.50
viewer UPDATE attempt   : no error
price after             : 1.00   → ⚠ THE WRITE LANDED
viewer CREATE category  : 6 → 7  → ⚠ THE WRITE LANDED
viewer INJECT stock mv  : 0 → 1  → ⚠ THE WRITE LANDED
viewer WRITE counter    : 1 → 999999 → ⚠ THE WRITE LANDED
viewer WRITE role_alias : blocked ✓ (the migration's REVOKE holds)
viewer SELF-PROMOTE     : blocked ✓ (permission denied for table profiles)
```

The counters are worse: RLS is **off** and no REVOKE was issued, so with Supabase's default grants
even `anon` holds INSERT/UPDATE/DELETE. Overwriting `sale_counters.next_value` breaks sale
numbering for the whole shop (a unique violation on `sales_sale_number_key`), i.e. an
unauthenticated denial of service against the till.

**What is correctly locked down** (measured, not assumed): every anonymous write — website
settings, products, reviews — was blocked; `backups` is unreachable by *every* role including
admin (RPC-only); `profiles`, `role_aliases`, `role_capabilities`, `audit_log`, `expenses`,
`shifts`, `custom_roles` are all denied to anon by explicit REVOKE; products have no DELETE policy
at all, which matches the app's archive-don't-delete design.

**Impact — HIGH.** A viewer or clerk with a browser console can reprice the catalogue and inject
stock. The UI hides the buttons; the API does not.

**Recommended fix.** One migration, mirroring the 16 policies that already do it right:

```sql
drop policy products_update_authenticated on public.products;
create policy products_update_authenticated on public.products for update to authenticated
  using (public.can('edit_product'))
  with check (public.can('edit_product')
              and (public.can('change_price') or (selling_price, cost_price)
                   = (select p.selling_price, p.cost_price from public.products p where p.id = products.id)));
-- same shape for products INSERT (add_product), categories (add_product/manage_roles),
-- stock_movements (adjust_stock)
revoke insert, update, delete on public.sale_counters, public.refund_counters,
       public.return_counters from anon, authenticated;   -- they are RPC-internal
alter table public.sale_counters enable row level security;  -- and add a no-op deny policy
```

The price-column clause is optional hardening: it makes `change_price` mean something at the
database layer instead of only in the UI.

### H2 — Reports and lists silently truncate at the server's row cap
**Location:** `src/modules/pos/data/supabaseRepository.ts:173-221` (`listSales()` — no parameters);
`src/modules/reports/pages/ReportsPage.tsx:71-77`; `src/modules/reports/components/tabs/SalesReportTab.tsx:21`.

**Problem.** The whole data layer contains **four** bounded queries:

```
audit/supabaseRepository.ts:47      .limit(500)
shifts/supabaseRepository.ts:97     .limit(1)
backup/supabaseRepository.ts:102    .limit(200)
online/supabaseRepository.ts:489    .limit(filter.limit)   -- optional
```

Everything else is `select("*")` with no range: `listSales()` takes no arguments at all. `ReportsPage`
then mounts seven providers (pos, catalog, inventory, customers, returns, expenses, shifts) and
`SalesReportTab` aggregates client-side:

```ts
const analytics = useMemo(() => buildSalesAnalytics({ sales, shifts, range }), [sales, shifts, range]);
```

The `DateRangePicker` filters **after** the fetch, so it cannot reduce the payload or escape the cap.
Supabase's default `max-rows` is 1000. There is no truncation indicator anywhere in the UI (the only
`truncate` hits are CSS text-overflow classes).

**Impact — HIGH.** Past ~1000 sales the sales history stops listing and **revenue reports silently
under-report** — wrong numbers with no error, in the screen a merchant trusts most. Every visit to
Reports also fires seven unbounded full-table fetches.

**Recommended fix.** Push the range into the query (`.gte("created_at", from).lte("created_at", to)`
plus `.range(page*100, page*100+99)`), or move aggregation into SECURITY DEFINER SQL functions as
`0019` already does for best sellers. Interim, one line of honesty in the UI: if a fetch returns
exactly the cap, show "results truncated — narrow the date range".

### H3 — No error boundary is mounted anywhere
**Location:** `src/components/ErrorBoundary.tsx` (exists, never imported); `src/App.tsx`, `src/main.tsx`.

**Problem.** The only `getDerivedStateFromError` / `componentDidCatch` in the repository is inside
`ErrorBoundary.tsx`, and the only two occurrences of the name are its own declaration and its own
`console.error` string. Nothing mounts it.

**Impact — HIGH (availability).** Any render-time exception — a malformed row, an unexpected null,
a bad translation key — blanks the entire app with no recovery path, including mid-checkout on the
storefront. In a single-page app with no error boundary this is the difference between "one screen
failed" and "the shop is down until a manual reload".

**Recommended fix.** The component is already written: wrap the route tree in `App.tsx` and the
storefront subtree separately (so a back-office failure cannot take the shop down), with a fallback
offering reload and, ideally, an audit entry.

---

## 4. Medium findings

### M1 — `xlsx@0.18.5`: two high advisories, and no fix exists on npm
**Location:** `package.json`; used at `src/modules/products/services/excelImport.ts:704`;
upload control at `src/modules/products/components/ExcelImportModal.tsx:281`.

```
xlsx  high  range: *   Prototype Pollution (GHSA-4r6h-8v6p-xvw6)
                       ReDoS (GHSA-5pgg-2g8v-p4x9)
```

`npm view xlsx versions` → 108 versions, **last = 0.18.5**. SheetJS moved off the npm registry, so
`npm update` cannot fix this. The parse runs on **user-uploaded bytes**, on the main thread, and the
file input has an `accept` attribute but **no size cap**.

**Impact — MEDIUM.** Exploitation needs the `import_data` capability (cashier and above), so this is
an insider or compromised-account risk rather than an anonymous one; a crafted workbook can pollute
prototypes, and a large or pathological one freezes the tab.

**Fix.** Install the patched build from the SheetJS CDN (`xlsx-0.20.3.tgz`), add a size cap (~10 MB)
with a translated rejection message, and parse inside a Worker so a ReDoS cannot block the UI.

### M2 — The single-file build ships the whole product to every visitor
**Location:** `vite.config.ts` (`vite-plugin-singlefile`); output `dist/index.html` (2,437 kB, 653 kB gzip).

`dist/` contains exactly one HTML file. Inlined in it: react-dom (524 kB source), supabase-js,
SheetJS, the entire back office, the storefront, and **both** language dictionaries
(`src/lib/i18n/dictionary.ts` = 371 kB of source). Verified present in the artifact: SheetJS
signature ✓, Arabic dictionary strings ✓, storefront CSS variables ✓.

The mitigation in `excelImport.ts:702` — *"xlsx is ~900 kB and must not land in the startup bundle"*
— is real for a normal build but **defeated by the singlefile plugin**: the dynamic import defers
execution, not download.

**Impact — MEDIUM.** An anonymous shopper on a phone downloads the accounting back office and the
language they are not reading. Seconds of blank screen before first paint.

**Fix.** Keep singlefile for the offline demo artifact, but build production normally: route-level
`React.lazy` for admin routes, a lazy dictionary per active locale, and let xlsx stay a real async
chunk. This alone should take the storefront's first load well under 200 kB gzip.

### M3 — No pagination or virtualization; zero memoized components
ProductsPage, SalesHistoryPage and AuditLogPage contain no `.slice()` and no limit; only 3 files in
the app mention pagination; **`React.memo` appears 0 times across 130 `.tsx` files** (while
`useMemo` appears 210× and `useCallback` 137×, so value memoization is disciplined but component
memoization is absent).

**Impact — MEDIUM.** Every fetched row becomes a DOM row, and every parent re-render re-renders them.
Degrades well before H2's cap. **Fix:** page the tables (the audit repository already caps at 500 —
copy that), and `memo()` the row components.

### M4 — Dev-toolchain advisories (Windows, dev-server only)
`vite 7.3.2` (advisories span 7.0.0–7.3.3; 8.3.0 published) — NTLMv2 hash disclosure via UNC path
handling and a `server.fs.deny` bypass; `esbuild 0.27.7` (0.28.2 published) — arbitrary file read in
the dev server. Both are **Windows-only and dev-server-only**; the production artifact is unaffected.
**Fix:** bump, checking `@vitejs/plugin-react` and `vite-plugin-singlefile` compatibility with vite 8.

### M5 — `deploy-pages.yml` points at a stale branch and an older Node
`on.push.branches: [arena/01a0900c-alyq-cloud-pos]` — a *previous* session's branch. Current work
lands on `arena/01a09298-…`, so Pages will never deploy from it. It also pins `node-version: 20`
while `ci.yml` uses 22. **Fix:** trigger on `main` (or `arena/**` to match CI) and align Node.

### M6 — No linter or formatter; dead exports accumulated unnoticed
No ESLint, Prettier or Biome config exists. The only static gate is `tsc` — which is genuinely
strict (`strict`, `noUnusedLocals`, `noUnusedParameters`, `noFallthroughCasesInSwitch`), and is the
reason unused *imports and locals* cannot accumulate. But nothing enforces the rules of hooks,
exhaustive effect dependencies, a11y, or import hygiene — and 90 never-imported exports (§5) grew
in that gap. **Fix:** add `eslint` with `typescript-eslint` + `react-hooks` + `jsx-a11y` and `knip`
as a fifth CI job; expect a noisy first run, so land it with a baseline.

### M7 — The DB test harness identifies users differently from production
`supabase/tests/supabase-shim.sql:75-81` implements `auth.uid()` as
`current_setting('request.jwt.claim.sub')` — the pre-2022 singular GUC. Production Supabase reads
`request.jwt.claims->>'sub'`. Semantically equivalent for `uid()`, so nothing is broken today, but
every policy assertion in `db:check` is validated against a different identity function than the one
that will run live, and any future policy using `auth.jwt()` or `auth.email()` could pass in CI and
behave differently in production.

This is not hypothetical: it produced a false negative during this audit — capability-gated tables
returned 0 rows for *every* role, including admin, until both GUC forms were set. A future engineer
will hit the same trap and may well conclude the permission system is broken.

**Fix:** have the shim read both forms, as production does, and add a comment saying why.

### M8 — `updated_at` has no database-level guarantee
15 tables carry `updated_at`; **none** has a trigger maintaining it (31 triggers exist, on 17 tables,
for other invariants). The application sets it in 34 places across the data layer, so it works — but
any write path that bypasses the repositories (a SECURITY DEFINER RPC adjusting stock during a sale,
a manual fix, a future import) leaves it stale. **Fix:** a `set_updated_at()` trigger on the 15
tables; cheap, and it makes the column trustworthy for the backup health check.

---

## 5. Code quality: duplication, dead code, unused dependencies

### Dead and unnecessary code (measured across all 1,668 named exports)

* **29 truly dead** — declared and referenced nowhere, including tests and scripts:

| Symbol | File |
|---|---|
| `ErrorBoundary` *(class)* | `src/components/ErrorBoundary.tsx` — see H3 |
| `unregisteredCapabilities`, `canWithCustomRole`, `effectiveRoleLabel`, `draftFromSystemRole`, `actingCapabilities`, `canActAll`, `assertAllCapabilities`, `assertAnyCapability`, `actionLabelKeyOf`, `systemRoleCapabilities` | `src/lib/permissions/{actions,customRoles,enforce,preview}.ts` |
| `supabaseConfigError`, `requireSupabase` | `src/lib/supabase/client.ts` |
| `APPROVAL_RULE_LABEL_KEYS`, `isPercentageKind` | `src/modules/approvals/validation.ts` |
| `EMPTY_CUSTOMER_FILTERS`, `EMPTY_RETURN_FILTERS` | `src/modules/{customers,returns}/types.ts` |
| `FALLBACK_SETTINGS` | `src/modules/online/hooks/StorefrontProvider.tsx` |
| `storefrontThemeAttributes` | `src/modules/online/services/theme.ts` |
| `ProductCountBadge`, `categoryLabel`, `newImageId`, `defaultStockTracking`, `PRODUCT_TYPE_OPTIONS` | `src/modules/products/*` |
| `usePercent` | `src/modules/reports/components/ReportTable.tsx` |
| `DEMO_RETURNS`, `DEMO_REFUNDS`, `buildDemoReturns`, `buildDemoRefunds` | `src/modules/returns/data/demoSeed.ts` |
| `loadOpenShift` | `src/modules/shifts/services/shiftService.ts` |

* **61 needless exports** — used only inside their own file, so the `export` widens the public API
  for nothing (`DemoOnlineRepository`, `SupabaseOnlineRepository`, `LocalStoreAccounts`,
  `SUPABASE_URL`, `normalizeCustomRole`, `userCan`, `fnv1aHex`, `checksumInput`, …).
* **179 dead type-only exports** — lower impact, mostly `*Props` interfaces in `components/ui`.
* **1 orphan file:** `src/components/ErrorBoundary.tsx`.
* **`src/modules/returns/data/demoSeed.ts` is vestigial** — `DEMO_RETURNS` is an empty array and
  nothing imports the module. Delete the file, not just the exports.
* **21 of the 29 dead symbols sit in `lib/permissions`** — an API built ahead of its callers. Since
  the capability model is the security core (see H1), the fix there is to *use* them: `enforce.ts`'s
  `assertAllCapabilities` / `canActAll` are exactly what the missing write policies need client-side.

**Unused dependencies: none.** All 7 runtime deps are imported; the four my detector flagged
(`typescript`, `@types/node`, `@types/react`, `@types/react-dom`) are toolchain packages and are
**false positives** — I verified this rather than reporting it.

### Duplicated code
A 6-line normalized-window scan over non-test sources found 378 raw hits, which collapse into a
smaller set of real clusters (the raw count includes overlapping windows and identical import
lines, which are not meaningful duplication):

| Cluster | Files | What is duplicated | Fix |
|---|---|---|---|
| Order summary block | `StoreConfirmationPage.tsx` ↔ `StoreTrackPage.tsx` | the whole `<dl>` of subtotal / delivery fee / total rows (~20 lines, 5 separate hits) | one `<OrderSummary order={…}/>` component |
| Refunds vs returns tables | `RefundsPage.tsx` ↔ `ReturnsPage.tsx` | card + `overflow-x-auto` wrapper + table header | a shared `<DataTable>` |
| Sales tables | `CustomerDetailPage.tsx` ↔ `SalesHistoryPage.tsx` | identical `<table>`/`<thead>`/`<tr>` header markup | same `<DataTable>` |
| Cart vs checkout aside | `StoreCartPage.tsx` ↔ `StoreCheckoutPage.tsx` | sticky summary aside and its rows | same `<OrderSummary>` |
| Provider refresh logic | `ApprovalProvider` ↔ `InventoryProvider` ↔ `ReturnProvider` | the `silent` realtime-refresh pattern, comments included | a `useSilentRefresh` hook |
| Two auth screens | `lib/auth/components/AuthScreen.tsx` ↔ `LoginPage.tsx` | header row and layout | confirm whether both are needed at all |
| Repository boilerplate | `backup/data/supabaseRepository.ts` ↔ `settings/data/supabaseRepository.ts` | injectable-client scaffolding | acceptable; low value to unify |

**Impact — LOW/MEDIUM.** Each cluster is a place where a future fix must be applied twice and will
eventually be applied once. The `OrderSummary` and `DataTable` extractions are the two worth doing.

### Complexity hotspots
`dictionary.ts` 5,811 (data, fine) · `online/data/demoRepository.ts` 1,690 ·
`online/data/supabaseRepository.ts` 1,271 · `WebsiteSettingsPage.tsx` 1,269 ·
`StoreContentPage.tsx` 942 · `reservationRepair.ts` 941 · `MarketingPage.tsx` 879.
28 non-test files exceed 500 lines. The four page components over 700 lines are the real
maintainability risk — `WebsiteSettingsPage` at 1,269 lines is a section-per-component refactor
waiting to happen.

### Architecture: what is genuinely good
These are not courtesies; each was verified and each is unusual at this project size:

* **All 54 SECURITY DEFINER functions pin `search_path`** (0 unpinned) — the classic Supabase
  privilege-escalation vector is closed across the board.
* **The capability model is internally consistent: 0 mismatches across all 225 cells** (45
  capabilities × 5 roles) between the stored `role_capabilities` matrix and runtime `can()`; and
  `can('not_a_real_capability')` returns `false` — it fails closed.
* **The database defends itself.** Synthetic inserts were rejected by CHECK constraints and
  fail-closed triggers: `Unknown audit action` (audit_log validates against its registered action
  catalogue), `Your role cannot record an expense`, `Your role cannot open a shift`,
  `sales_cash_rec…`, `stock_movements…`. These fired even for a superuser insert.
* 144 CHECK constraints · 119 indexes · 56 unique indexes · 20 enums · 12 UNIQUE constraints on the
  business numbers (sale, order, refund, return, shift, expense, request) · `shifts_one_open_idx`
  enforcing one open shift · **every table has at least one index** · `products_search_trgm` GIN
  index for search.
* `backups` is unreachable by every role including admin — RPC-only, with `export_backup`,
  `restore_backup` and `manage_settings` restricted to admin in the matrix.
* Migrations are **idempotent and re-entrant**: `db:check` applies all 29 twice against real
  PostgreSQL and passes; the seed uses `where not exists` guards throughout.
* The print path is **XSS-safe**: every interpolation in `barcodeLabel.ts` passes through
  `escapeXml`, which escapes all five of `& < > " '` — verified by running a
  `"><img src=x onerror=alert(1)>` payload through `buildBarcodeLabelHtml` and confirming no live
  tag survives and no attribute breakout occurs. The call site also guards an empty barcode.
* **No hardcoded secrets.** Only the intentional offline demo password.
* The custom-role overlay behaves correctly: a viewer assigned the `accountant` custom role still
  reports base role `viewer` from `current_user_role()` while `can()` consults the overlay — the
  split that `db:check` also asserts.

---

## 6. UI and business-flow testing: what is actually covered

I could not click every button in a browser; what I can state precisely is what the automated flows
drive in jsdom against the real app bundle.

**Covered (663 E2E assertions):**

| Flow | Coverage |
|---|---|
| `smoke.dom.mjs` (14 steps, 490 asserts, 2,657 lines) | products list, search, status+category filters, empty-submit validation, create with stock+cover image, duplicate-SKU rejection, sorting, detail view, archive/restore, edit incl. Show/Hide on Website, category CRUD, **delete guard on a populated category**, max-6-images enforcement, bilingual RTL/LTR including POS screens, Excel template + import (valid/invalid rows, update-vs-create), barcode label print |
| `store.flow.mjs` (172 asserts, 1,099 lines) | storefront is public → browse/search/open product → cart → **guest checkout (pickup, COD)** → tracking → order reaches POS → **InstaPay human verification** → cancellation returns stock → rest of back office renders → stock-holds screen reads the same reservations → website builder goes live → Arabic + EGP → till session untouched by a shopper → live hold on reconciliation |
| `auth.flow.mjs` (9 steps) | signed-out start, login, permission-gated navigation, logout |
| `backup.flow.mjs` (9 steps, 9 checks) | permission gate, six monitoring questions, snapshot records date/size/author, download hands over a real 45 kB workbook, health check reads relationships, schedule policy, **restore requires the typed word and leaves a way back**, manager may protect but not replace the installation, emergency export uses the existing engine |

All four run with **0 console errors and 0 network calls**.

**Routes no E2E flow visits** (from literal `navigate("#/…")` extraction; parameterized detail
routes are under-reported by this method, so treat this as approximate):
`/approvals`, `/online/content`, `/online/marketing`, `/online/reports`, `/refunds`,
`/settings/*`, `/forgot-password`, `/reset-password`.

**Coverage gaps that matter, in priority order:**

1. **Nothing tests live mode.** Every suite and flow runs against localStorage. RLS, grants, the
   server row cap, RPC error shapes — untested. This is where C1, C2, H1 and H2 all live. *Highest
   value test to add: an `anon`-role storefront read and a `viewer`-role price write, run against
   the pglite schema (the harness already exists — `scripts/migrations.check.mjs`).*
2. **Password recovery** (`/forgot-password`, `/reset-password`) is never exercised.
3. **Approvals and refunds** — the two flows with money-moving authority — have deep *logic* suites
   (11 and 20 tests) but no DOM/E2E pass.
4. **Settings screens** (`/settings/*`, 27 logic tests) have no DOM pass.
5. **No coverage measurement at all** — no c8/nyc/istanbul, so "are tests enough?" cannot be
   answered numerically. Adding `c8` to the existing runner is a small change and would make this
   report's §7 answerable next time.
6. **No visual, mobile, print or cross-browser verification** — impossible in this environment (§9).

**Are the tests checking real behaviour?** Yes, unusually so. They assert money maths to the
piastre, idempotency (the same request twice), snapshot semantics (a sale keeps the name it sold
under), fail-closed permissions, that an emergency export is built by the *existing* engine rather
than a second one, and that the shop does not wear the back office's colours. The branding suite
even asserts the *absence* of retired strings. This is behaviour testing, not coverage theatre.

---

## 7. Performance review

| Area | Finding | Severity |
|---|---|---|
| Bundle | 2,437 kB / 653 kB gzip in **one** HTML file; both dictionaries (371 kB source), SheetJS, react-dom, supabase-js, admin + storefront all inlined | M2 |
| Queries | 4 bounded queries in the entire data layer; `listSales()` unbounded; ReportsPage fires 7 unbounded fetches on mount | H2 |
| Rendering | No pagination in product/sales/audit tables; `React.memo` used 0× across 130 components | M3 |
| Caching | Demo state is versioned and cached correctly (the new `seed_revision` reseeds once, not per load). Live mode has no client cache — every navigation re-fetches | Low |
| N+1 | None found. The online repository batch-fetches with `.in("order_id", ids)` ✓ | — |
| Polling | Online orders: 20 s default with a 120 s safety-net floor and document-visibility awareness ✓; auth heartbeat ✓; storefront carousel interval ✓. Sensible. | — |
| Memory leaks | **Not verified** — requires long-session profiling (§9). The `URL.revokeObjectURL` cleanup after downloads is present ✓ | Unverified |

Positive: `xlsx` and the label builder are behind dynamic imports (correct intent, defeated by the
singlefile plugin — see M2); the trigram GIN index means product search is index-backed; audit reads
are capped at 500.

---

## 8. Database audit summary

**Structure:** 37 tables · 20 enums · 27 foreign keys (10 CASCADE, 7 SET NULL, 10 RESTRICT/NO
ACTION) · 144 CHECK constraints · 119 indexes · 56 unique · 31 triggers on 17 tables · 141 functions
(54 SECURITY DEFINER, all pinning `search_path`).

**Verified sound:** money columns are `numeric` throughout (the one hit my scan produced,
`approval_rules.price_change_approval_enabled`, is a boolean matched by the substring "price" — a
false positive, not a defect); every table is indexed; business numbers are uniquely constrained;
CASCADEs are all parent→child (order items, sale items/payments, return items, product content,
reviews, reservations) plus `profiles`/`store_customers` → `auth.users`; migrations are idempotent
and re-entrant; the seed is guarded with `where not exists`; 33 of 37 tables have RLS enabled.

**Issues:** H1 (write policies + counter tables) · M8 (`updated_at` has no trigger) ·
**`profiles.custom_role_id` is the only foreign key of 27 with no leading index** — every
custom-role join and every cascade check on it is a sequential scan; one `create index` fixes it ·
the four RLS-off tables are fine for `role_aliases` (protected by explicit REVOKE, verified holding
under attack) but **not** for the three counters (H1).

**Can a database change break existing data?** Not at migration time: there is no `DROP TABLE`, no
`DROP COLUMN`, no `DROP SCHEMA` and no `ALTER TYPE … RENAME` in any of the 29 files, and the 112
`drop policy if exists` statements are the idempotency pattern, not data loss.

Every destructive statement in the migrations lives **inside a guarded runtime function**, which is
the right place for it — I checked each one rather than counting matches:

| Statement | Location | Guard |
|---|---|---|
| `delete from public.backups b using doomed d …` | `0029:557`, inside `prune_backups()` | retention policy; keeps the newest N automatic and any pre-restore snapshot |
| `execute format('delete from public.%I', v_tables[i])` | `0029:937`, inside `admin_restore_document()` | the restore path itself: children first, behind the typed word and an automatic pre-restore snapshot |
| `delete from public.audit_log where created_at < p_before` | `0014:370`, inside `purge_audit_log()` | sets a transaction-local `alyq.audit_purge` flag so the audit immutability trigger permits *only* this delete |

(The one `truncate` match, `0029:901`, is the English word inside a comment about checksum
validation — not a `TRUNCATE` statement. An earlier draft of this report said "no DELETE FROM
anywhere"; that was wrong, and this table is the correction.)

There are **no down-migrations**, so rollback means restoring a backup — which is precisely what the
backup module is for, and it is well built (RPC-only access, typed restore word, prune policy, health
check).
The residual risk is operational: `0003`'s seed was edited in place during Phase 21 Step 2, which is
correct for a project that has not yet been deployed, but would not re-run on a database that had
already applied it. Any future catalogue change should be a new migration, not an edit to `0003`.

---

## 9. What I could not verify

Stated plainly, because two of the three critical findings depend on it:

1. **Your live Supabase project's configuration** — whether public email signup is enabled
   (determines whether C2 is exploitable today), the `max-rows` setting (determines exactly where
   H2 bites), JWT expiry/refresh settings, and Storage bucket policies for `product-images`. No
   project credentials exist in this environment, by design.
2. **Real-device UI** — rendering, layout, RTL correctness on screen, responsive/mobile behaviour,
   actual print output, touch targets. All UI evidence here is jsdom-level (DOM structure,
   attributes, disabled states, text content), which verifies behaviour but not appearance.
3. **Real query performance** — the pglite database held ~15 rows. No `EXPLAIN ANALYZE` against a
   realistic volume, so index effectiveness is inferred from the schema, not measured.
4. **Memory leaks and long-session stability** — needs hours of profiling with heap snapshots.
5. **Genuine third-party workbooks** — the import tests build workbooks with SheetJS itself, so
   Excel- and LibreOffice-authored files (and the CVE-2023-30533 payload shape) are untested.
6. **Cross-browser behaviour** — one engine (jsdom/Chromium-like) only.
7. **Parameterized-route E2E coverage** — my route-visit extraction only matched literal
   navigations, so detail routes (`/products/:id`, `/customers/:id`, `/refunds/:id`) may be covered
   by template-literal navigations I did not count.

Also disclosed: two of my own probes were wrong before they were right, and both would have produced
false findings had I trusted them — a privilege matrix whose `anon` and `authenticated` columns
collided on the same key, and a JWT-claims GUC that did not match the shim's `auth.uid()` (which
made the capability system look completely broken; it is not — §5). The numbers in this report are
from the corrected runs.

---

## 10. Recommended order of work

**Before any live deployment (blockers):**
1. **C1** — `storefront_catalogue()` RPC + point the storefront at it. *(new migration + 1 file)*
2. **C2** — ignore role metadata unless `service_role`; always create inactive. *(1 function)*
3. **H1** — capability-gate the five write policies; REVOKE the three counters from anon and
   authenticated. *(1 migration)*
4. **H3** — mount `ErrorBoundary`. *(it already exists; ~10 lines in `App.tsx`)*
5. Disable public signup in the dashboard and record it in `DEPLOYMENT.md`.

**Then, in this order:**
6. **H2** — date-bounded, paginated sales/report queries; truncation indicator as a stopgap.
7. **A live-mode RLS test suite** on the existing pglite harness — anon storefront read, viewer
   price write, cashier capability boundary. This is the test that would have caught 1–3, and it
   costs little because the harness already applies every migration.
8. **M1** — SheetJS CDN build, upload size cap, parse in a Worker.
9. **M2/M3** — drop singlefile for production, lazy admin routes and per-locale dictionary,
   paginate tables, `memo()` rows.
10. **M6/M7/M8** — add ESLint + knip to CI; make the shim's `auth.uid()` match production; add
    `set_updated_at()` triggers; index `profiles.custom_role_id`.
11. Clean up: delete `returns/data/demoSeed.ts`, the 29 dead symbols, drop the 61 needless
    `export` keywords; extract `OrderSummary` and `DataTable`.

**Do not touch** while doing the above: the POS settlement path, the inventory engine, the order
workflow, the approval/audit machinery, or the backup module. They are the strongest parts of the
system — the backup module in particular is better built than most production systems I audit.
