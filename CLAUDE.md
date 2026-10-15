# CLAUDE.md — ALYQ Cloud POS

## Project overview
Bilingual (Arabic/English, RTL-aware) retail suite for the ALYQ accessories shop (Egypt, default currency EGP).
One React codebase ships as:
- **Staff back office / POS** (`#/dashboard/*`): catalog, inventory, POS, customers, returns/refunds, shifts, expenses, approvals, reports, audit, settings, and the online-order queue.
- **Public storefront** (`#/` and `#/store/*`): browse, cart, checkout (COD/InstaPay), order tracking, optional customer account. It reads the same catalog and stock as the POS.
- **Mobile management app** (`#/mobile/*`, Capacitor Android/iOS + PWA) with push notifications.
- **Windows desktop register** (Electron, `desktop/`) with receipt printer, cash drawer and offline sales.

Users: staff roles (admin, manager, cashier, inventory_clerk, viewer, plus admin-defined custom roles) and anonymous shoppers.

## Tech stack
React 19, TypeScript 5.9, Vite 7 (`vite-plugin-singlefile` gives one self-contained `dist/index.html`), Tailwind 4, react-router 7 (**HashRouter**), Supabase (Postgres + Auth + Storage + Edge Functions, `@supabase/supabase-js`), Capacitor 8, Electron 44, `xlsx` (vendored tarball in `vendor/`). Node 22 in CI (no `engines` field).

```bash
npm install
npm run dev              # Vite dev server
npm run build            # dist/index.html (single file)
npm run typecheck        # tsc; also fails on missing/extra AR translations
npm run lint             # eslint; warnings don't block, errors do
npm test                 # all *.selftest.ts (node:assert) via scripts/test.logic.mjs [filter...]
npm run test:e2e         # real bundle in jsdom (scripts/*.flow.mjs) [id...]
npm run db:check         # applies all migrations twice in PGlite + schema/code parity checks
npm run production:preflight   # read-only local release checks (CI runs it)
npm run desktop:dev | desktop:package:win
npm run mobile:build | mobile:android | mobile:ios
```

## Folder structure
- `src/main.tsx`: entry. Registers the service worker, renders `App`.
- `src/App.tsx`: all routes and the provider stack. Legacy top-level staff paths redirect to `/dashboard/...`.
- `src/components/`: `ErrorBoundary`, `layout/` (AppShell, RouteGuard, module home pages), `ui/` (shared primitives).
- `src/lib/`: cross-cutting code: `auth` (sessions, login, recovery), `permissions` (roles.ts matrix, custom roles, route guards), `i18n` (`dictionary.ts` EN+AR, I18nProvider), `supabase` (client, realtime), `branch` (active branch context), `export` (Excel), `desktop` (Electron bridge), `branding`, `storefront` (external store link), `dates`, `phone.ts`.
- `src/modules/<domain>/`: one folder per domain, each with `types.ts`, `validation.ts`, `services/`, `data/` (repositories), `hooks/` (Providers), `components/`, `pages/`, `__tests__/`. Domains: approvals, audit, backup, customers, dashboard, expenses, import, inventory, mobile, online (storefront + online admin; `v2/` is the live storefront UI), operations, pos (incl. `offline/` IndexedDB outbox), products, registers, reports, returns, settings, shifts, storefront (catalogue data), system (health).
- `supabase/migrations/`: numbered SQL migrations `0001`–`0095` (+ README with schema notes).
- `supabase/functions/`: Deno edge functions `alyq-admin`, `alyq-auth`, `alyq-push`.
- `supabase/tests/`: SQL scenarios run by `db:check`.
- `scripts/`: test runners, e2e `*.flow.mjs`, `migrations.check.mjs`, preflight, desktop dev.
- `desktop/`: Electron `main.mjs`, `preload.mjs`, `contracts.mjs` (IPC contract).
- `android/`, `ios/`: Capacitor native projects.
- `public/`: PWA manifest, icons, `alyq-sw.js` (Web Push service worker), brand assets.
- `docs/`: architecture, auth, permission matrix, deployment, desktop/mobile runbooks. Root `PHASE-*.md` / `AUDIT-*.md` are historical reports.

## Main flows
- **Mode selection:** each module's `data/index.ts` returns the Supabase repository when `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` are set and valid, and otherwise a demo repository stored in `localStorage`. Demo accounts are in README.
- **Staff login:** `LoginPage` → `authService` → edge function `alyq-auth` (turns a username into the real email, then `signInWithPassword`) → `auth.setSession` → `AuthProvider` → `RequireAuth` → the module providers and `AppShell` load → `RouteGuard` checks capabilities. Password recovery goes through `alyq-auth recover`. Admin creation of users and password resets go through `alyq-admin`, which uses the service role and checks `can('manage_users')` as the caller.
- **POS sale:** `PosPage` → `PosProvider` → `pos/services/saleService` → repository → RPC `pos_complete_sale` / `pos_complete_registered_sale` (atomic: sale, items, payments, stock movement). Other RPCs: confirm InstaPay with `pos_confirm_payment`, void with `pos_void_sale`. Offline (desktop) sales are queued in IndexedDB (`pos/offline/outbox.ts`) and synced via `pos_sync_offline_sale` / `pos_sync_registered_offline_sale`.
- **Return/refund:** `ReturnFormModal` → returns service → `pos_process_return`, then `pos_settle_refund`.
- **Online order:** storefront checkout → `place_online_order` (reserves stock, security definer for anon) → shopper may `submit_online_payment_proof` (InstaPay) → staff in `#/dashboard/online/orders` call `resolve_online_order`. Approving creates a sale with `source: "online"`, and cancelling releases the reservation. Shoppers track orders with `lookup_online_order`. Pricing and coupon previews use `preview_storefront_pricing` / `check_storefront_coupon_pricing`.
- **Shifts:** `open_registered_shift` → sales → `close_shift_authoritative`. EOD page in `shifts/`.
- **Inventory:** `inventory_adjust_stock`, `inventory_transfer_stock` (branch stock), stocktakes via `stocktake_create` / `stocktake_save_counts` / `stocktake_finalize`.
- **Push:** DB outbox → `notification_push_deliveries` → `alyq-push` (invoked with `PUSH_DISPATCH_SECRET`) claims a batch through `notification_claim_push_batch` and sends via FCM, APNs or Web Push. Web payloads carry only `notification_id`, and the app resolves the route after auth.

## Data model summary
Postgres with RLS enabled on every table. Permissions are stored as data (`role_capabilities`, `custom_roles`, `role_aliases`) and enforced by `public.can()` inside RPCs and policies. Key tables:
- **Catalog:** `categories` (self-ref `parent_id`, cycle guard), `products` (FK category, unique SKU/barcode), `product_variants`, `product_color_images`, `product_content` (storefront SEO/brand).
- **Stock:** `stock_movements` (append-only ledger), `branch_stock_balances`, `stock_transfers`, `stock_reservations`, `stocktakes` / `stocktake_lines`.
- **Sales:** `sales` → `sale_items`, `sale_payments`; `customers`; `sales_returns` → `return_items`; `refund_records`; numbering counters (`sale_counters`, etc.).
- **Ops:** `shifts`, `expenses`, `cash_movements`, `registers`, `branches`, `branch_memberships`, `approval_rules` / `approval_requests`, `operation_policies`, `manager_credentials`.
- **Identity/audit:** `profiles` (1:1 `auth.users`), `audit_actions`, `audit_log` (append-only).
- **Online:** `website_settings` (single-row document), `online_orders` → `online_order_items`, `order_events`, `coupons`, `promotions` / `promotion_targets` / `promo_code_usages`, `campaigns`, `delivery_zones`, `store_customers`, `store_reviews`, `store_faqs`, `storefront_category_content`.
- **Notifications:** `notification_outbox`, `user_notification_inbox`, `notification_push_deliveries`, `notification_delivery_attempts`, `mobile_installations`, `web_push_subscriptions`.
- **Backup/import:** `backups`, `backup_settings`, `import_batches`, `cleanup_previews`.
- **Storage:** public bucket `product-images`.

## Environment variables (names only)
Browser build (Vite inlines these at build time, so restart dev after changing them):
- `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`: live mode. Missing means demo mode. Only the anon/publishable key, never the service role.
- `VITE_CURRENCY`: display/export currency (default EGP).
- `VITE_STOREFRONT_URL`: optional external storefront origin for the "open website" link.
- `VITE_APP_VERSION`, `VITE_BUILD_SHA`: shown by mobile runtime diagnostics.
- `WEB_PUSH_VAPID_PUBLIC_KEY`: injected via `vite.config.ts` `define`. It is the only push value allowed in the browser.
- `VITE_DEMO_SEED` is declared in `vite-env.d.ts` but not read by `src/`.

Edge functions (Supabase secrets):
- `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`.
- `alyq-push` also uses: `PUSH_DISPATCH_SECRET`, `FCM_PROJECT_ID`, `FCM_CLIENT_EMAIL`, `FCM_PRIVATE_KEY`, `APNS_TEAM_ID`, `APNS_KEY_ID`, `APNS_PRIVATE_KEY`, `APNS_TOPIC`, `APNS_ENVIRONMENT`, `WEB_PUSH_VAPID_PUBLIC_KEY`, `WEB_PUSH_VAPID_PRIVATE_KEY`, `WEB_PUSH_SUBJECT`.

Desktop: `ALYQ_BUILD_SHA`, `ALYQ_DESKTOP_DEV_URL`, `ALYQ_DESKTOP_DEV_PORT`.
Tests/tools: `DATABASE_URL`, `ALYQ_DATABASE_URL`, `ALYQ_PSQL`, `CHROMIUM_EXECUTABLE`, `VISUAL_BASE_URL`, `VISUAL_PORT`, `ALYQ_TEST_*`. CI secrets: `SUPABASE_TEST_URL`, `SUPABASE_TEST_ANON_KEY`, variable `ALYQ_LIVE_CI`.

## External services
- **Supabase** (DB/Auth/Storage/Realtime): `src/lib/supabase/client.ts`, the `data/supabaseRepository.ts` files, `src/lib/supabase/realtime.ts`.
- **Edge function calls:** `alyq-auth` from `src/lib/auth/data/supabaseRepository.ts`, and `alyq-admin` from `src/modules/settings/data/supabaseRepository.ts`.
- **FCM, APNs, Web Push (`web-push` npm):** `supabase/functions/alyq-push/`. Client side: `src/modules/mobile/services/{mobilePush,webPush,pwaBridge}.ts`, `public/alyq-sw.js`.
- **Electron hardware** (printer, drawer, scanner): `desktop/main.mjs` and `src/lib/desktop/bridge.ts`.
- **WhatsApp:** `wa.me` links only (`src/lib/phone.ts`, storefront layout; audit migration 0056). No API client.

## Deployment
- **GitHub Pages:** `.github/workflows/deploy-pages.yml` runs on push to `main`: lint → typecheck → build → publish `dist/`.
- **CI:** `.github/workflows/ci.yml` runs on push to `main` / `arena/**` and on PRs. Jobs: static (preflight, lint, types, build), logic, database (`db:check`), e2e. The live Supabase e2e job is opt-in. `cancel-in-progress` per ref means a manual dispatch cancels a running push run.
- **Database:** apply `supabase/migrations/*.sql` in order (`supabase db push`). See `docs/DEPLOYMENT.md`.
- **Edge functions:** deploy with the Supabase CLI. `alyq-push` needs gateway JWT verification disabled because it checks its own secret.
- **Desktop:** `electron-builder` NSIS x64 → `release/`.
- **Mobile:** `cap sync` with app id `eg.alyq.management`.
- The repo contains no `vercel.json` or Vercel workflow. If Vercel is used, it is configured outside the repo.

## Conventions to follow
- UI never calls Supabase directly. Go through the module repository, and implement **both** the demo and Supabase repositories.
- Permissions: change the matrix in `src/lib/permissions/roles.ts` **and** the DB (`role_capabilities` / `can()` in a new migration). Enforce in screen, service and DB. `db:check` asserts parity.
- Every UI string is a key in `src/lib/i18n/dictionary.ts` with EN and AR. Typecheck enforces completeness. Use `t()` and `pick(ar, en)`.
- Schema changes go in a **new** numbered, idempotent migration (`create … if not exists`, `create or replace`). Enable RLS, grant explicitly, and run `npm run db:check`. Never edit an applied migration.
- Sensitive writes are `security definer` RPCs that check `can()` and write `audit_log`.
- Tests: add `*.selftest.ts` next to the module (`node:assert`) and e2e in `scripts/*.flow.mjs`.
- Routes use HashRouter. New staff pages go under `/dashboard/...` inside `AuthenticatedApp` in `App.tsx`.
- Never put service-role or provider secrets in `VITE_*` or `src/`.

## Known risks / gaps
- README is partly stale: it mentions `src/app/` (doesn't exist) and "migrations 0001–0055".
- A production build with missing or invalid Supabase env does not fail. It silently ships **demo mode** (localStorage data).
- Very large files: `dictionary.ts` (~9.3k lines), `WebsiteSettingsPage.tsx` (~1.8k), `WebsiteTabPanels.tsx` (~1.5k).
- Legacy storefront components (`online/components/storefront/`) are kept "for rollback" next to `v2/`.
- ~40 lint warnings, mostly `react-hooks/exhaustive-deps`.
- `public/alyq-sw.js` `notificationclick` calls `client.navigate()` on uncontrolled clients, which can throw, so the click opens nothing. Pushes with an invalid payload show no notification.
- Many historical report files at repo root. Treat `docs/` and the code as the source of truth.
