# P0 release-safety audit

Audit baseline/refetched main: `c2cca7aa9863b08b5edda50a12f4c5c7a350530c`. No newer main commit was present at either inspection. Work stays on the session-fixed `arena/71bcb1dd-alyq-cloud-pos`; no main push, history rewrite, merge, production write or deployment is authorized. Unrelated PR #16 is preserved.

## Baseline and root causes

The original complete run was **20/31**, exit 1 (633.280 s). It reproduced eleven failures. `categories` was on the requested watch list but **passed that baseline**; two additional failing suites (`variants`, `poslayout`) were fixed rather than excluded.

| Suite | Classification and original/latent cause | Correction without weakening business coverage |
|---|---|---|
| `store` | **Stale expectation**: root now renders the public storefront, not Login. **Timing**: filter refreshes temporarily removed/replaced order rows, builder tabs and clipboard feedback were asynchronous. **Real defect discovered**: a drawer/filter read could overwrite a newer verified payment. | Assert public root and use explicit Login/canonical staff routes; wait for exact filtered rows, enabled actions, editor panels, feedback and persisted/UI state; invalidate outdated order snapshots at mutation/selection boundaries. Approval, money/actor attribution, exact stock/holds, cancellation, fees and unsafe-link assertions retained. |
| `lifecycle` | **Stale expectation**: root-is-Login. **Timing**: archived POS search and inventory refresh had not committed. | Explicit Login/public-root assertions; wait for committed route/search/archive/delete UI states. Referenced-product deletion denial, audit and unchanged stock remain asserted. |
| `categories` | **Latent timing flakiness**, not a failure in the reproduced baseline: fixed sleeps around category save/archive/reactivation and filter reloads. | Canonical navigation, same-renderer event flushing, real form/tree/confirmation readiness. Atomic reassignment, exact stock `[4,6,8]`, archived-target rejection and delete counts retained. |
| `storefront` | **Stale expectation**: initial root is Login. **Timing**: builder panels loaded asynchronously. **Real defect discovered**: a passive product-identity reset could erase the shopper's first color click after loading. | Explicit Login; wait for each builder panel and exact shelf. Move identity reset before paint with `useLayoutEffect`; preserve manual Gold/Silver/17 selection, quantity/stock, bilingual/RTL and checkout-copy assertions. |
| `promotions` | **Stale expectation**: successful return navigates to `/dashboard/returns/:id`, not the old root return route. **Timing**: controlled-field updates, pricing and invoice lines were not settled. | Canonical return/routes, native same-renderer updates and pricing/invoice/return readiness; retain exact discount, 52.02-per-unit refund, stock and price-restoration coverage. |
| `dashboardux` | **Stale expectation**: save success checked `#/products` instead of `/dashboard/products`. **Timing**: category options, variant grids and status filters had not hydrated. | Committed canonical route plus SKU/variant/filter readiness; preserve KPI destinations, exact shelves, mobile drawer/RTL and denied actions. |
| `final` | **Stale expectation**: old product-save route. **Timing**: customer attachment, exact shelves, return's asynchronous success navigation, previous-order action completion and category-tree reloads. **Real defect discovered**: stale order read could undo payment UI state. | Wait for each business/UI milestone, return-success navigation and enabled payment control; use order snapshot guard. All 22 integrated phases retain exact Gold return/Silver hold, stock-on-approval-only, discount/financial, permissions, preview-only Danger Zone and password-free audit assertions. |
| `storepolish` | **Stale expectation**: old saved-product route. **Timing**: theme effect and product controls were not ready. | Wait for canonical save/loaded editor, exact theme tokens and manual variant controls; retain palette, prices, checkout hierarchy, RTL and exact shelf assertions. |
| `nav` | **Stale expectation**: baseline includes the legitimate new Notifications shortcut; six modules + storefront alone is no longer the exact sidebar. **Timing**: hydration/denied-route marker. | Assert the exact eight destinations (six module doors + Notifications + storefront), not a looser subset. Keep legacy `#/products`/`#/pos/sales` bookmark checks and add canonical redirect assertion; preserve all 20 navigation/permission/RTL checks. |
| `visualaudit` | **Stale expectation**: root no longer mounts the authenticated dashboard shell. **Timing**: shell/committed page readiness. | Navigate explicitly to `/dashboard`, wait for committed shell/page; retain thirteen-screen layout/token/identity/RTL checks. |
| `variants` (additional baseline failure) | **Timing**: category options were still loading; default-color effect had not rendered exact Gold/17 sizes. **Real compatibility defect discovered**: legacy numeric-only labels/sorting ignored merchant flexible size values. | Wait for hydrated form/exact shelf; use shared flexible-size/order helpers and prefer `size_value` while preserving legacy numeric snapshots/color-only shelves. Exact balanced stock, refusal and disable-block assertions retained; dedicated label regressions added. |
| `poslayout` (additional baseline failure) | **Timing**: product form/save and controlled native input changes were observed before commitment. | Committed form/save routes and same-renderer setters; preserve exact-code additions, service/inactive exclusion, cap, long-cart/checkout and RTL checks. |

The ten requested suites contain **no fixed settle sleeps**. Shared waits yield only while checking observable conditions; polling/request-animation-frame timers are not arbitrary settle delays. Unused numeric settle arguments were removed. React's `flushSync` comes from the **same test bundle/renderer**, not a second React copy. Production entry has no test exports/globals. Existing active-V2 and test-only legacy rollback projections remain unchanged in the runner; all 31 suites still run, with no exclusions/retry-on-failure policy.

The ten original scripts retain their original counts of direct business assertions (nav gains an additional redirect assertion); stale route/startup/menu expectations are corrected rather than removed. Assertion-count comparison is supplementary evidence, not a substitute for executing the full tests.

## Safety/release decisions

- Explicit Production/Demo config; no missing-config or network-error Demo fallback; controlled pre-provider bootstrap error; persistent labelled Demo/PWA identity.
- Tested deprecated seed-off veto/migration. No fake Production seeding, local→Production conversion or required SQL migration.
- Build/preflight inspect actual final bytes and copied files, exact SHA/UTC time/environment and private credential patterns/known escaped values. Raw configuration/provider errors are never printed.
- Authenticated Health/Diagnostics display allowlisted nonsecret release identity; support diagnostics use existing redaction.
- Read-only anonymous STABLE public catalogue/variant/pricing GET probe; zero sellable products is commercially blocking except an exact approved new/staging empty-store setting. It does not inspect private reservations or promise availability under concurrency.
- Required types/build/lint/logic/database/E2E checks and aggregate Release gate; all 31 E2E twice in CI. Default `db:check` is forced to isolated PGlite even if an ambient database URL exists.
- Protected main-only promotion validates trusted/latest exact-SHA checks, independent environment reviewers/branch policy, pulled authoritative Vercel config, dist/prebuilt integrity, served candidate metadata and real catalogue before domain movement. CLI pinned at 63.1.2; help flags verified without a provider deployment.
- No RLS, permission, assertion, SQL/history or production data weakening. All 94 historical migrations and the seed file remain unchanged; isolated database tests still apply/reapply the complete manifest and scenarios.

## Evidence and release disposition

Final local command exit codes/durations, both complete gate/all-31 results, frozen final SHA, artifact metadata and the PR URL/checks are recorded in the PR and the accompanying final report after execution. Do not read targeted passes as a completed release gate. CI's public `.invalid` config is an **offline Production-contract fixture**, not actual commercial approval; the real production probe/deploy was not executed.

Residual risk: npm audit reports **15 advisories (8 moderate, 5 high, 2 critical)**. Native Capacitor Android/iOS critical advisory and build-tool/transitive high advisories were not silently force-upgraded as part of this release-safety patch; native distribution and any commercial risk acceptance remain separate blockers. Lint currently reports zero errors/42 visible warnings. Provider administration and a real negative-release drill are unverified: branch-protection API returned 403, existing deployment environments had no protection rules, and Vercel automatic Production/RBAC settings were not accessible. **Commercial NO-GO** until the administrator/operational checks in `vercel-release-gate.md` are evidenced.

Rollback/environment migration: see `production-environment.md` and `rollback-runbook.md`. Do not roll back to an implicit-Demo artifact, delete financial rows/browser evidence or run reverse/destructive SQL. Before deploying this patch, a PR revert requires no database action.

## Changed files and reasons

(86 changed/added/removed files; generated build outputs, logs, provider metadata and credentials are not tracked.)

| File | Reason |
|---|---|
| `.env.example` | Explicit required mode/public config, release identity and tested seed-veto migration; no values/secrets. |
| `.github/workflows/ci.yml` | Mandatory static/logic/isolated-DB/all-31-twice jobs and aggregate Release gate; offline build fixture, no live writers. |
| `.github/workflows/deploy-pages.yml` | Remove unsupported failed/404 Pages publishing path; do not replace it with an unlabelled Demo. |
| `.github/workflows/promote-production.yml` | Protected main push-only exact-SHA promotion, full gate/probe, step-scoped token and guarded candidate client. |
| `.gitignore` | Exclude pulled Vercel environment/project/prebuilt scratch from Git. |
| `README.md` | Correct quick-start explicit Demo/Production behavior, isolated DB and full-gate/deployment links. |
| `docs/DEPLOYMENT.md` | Remove implicit fallback/privileged-build advice; explicit mode, protected rollout, isolated tests and current schema count. |
| `docs/PRODUCTION_READINESS_PLAN.md` | Mark historical fallback proposal superseded without rewriting the historical plan. |
| `docs/production/go-live-runbook.md` | Require protected exact-SHA no-domain candidate/probe/Health verification; no fake Production test seeding. |
| `docs/production/go-no-go-checklist.md` | Add twice-full-gate, protections, backend/artifact/probe/candidate identity and negative-release evidence gates. |
| `docs/production/migration-plan.md` | Correct current unchanged manifest to 94; document no migration required and retain historical 85-file evidence. |
| `docs/production/production-environment.md` | Document explicit mode, key/URL validation, allowlist, deprecated seed path, public/secret boundary and offline-vs-commercial evidence. |
| `docs/production/release-builds.md` | Correct gate sequence/current schema, twice-all verification, metadata/integrity and protected hosting policy. |
| `docs/production/release-safety-audit.md` | Baseline/per-suite root causes, coverage preservation, scope/security/rollback and complete file-reason inventory. |
| `docs/production/rollback-runbook.md` | No-migration rollback, known Production artifact only, no implicit Demo or data deletion/conversion. |
| `docs/production/security-review.md` | Release-safety decisions and honest external/advisory blockers; no RLS/grant changes. |
| `docs/production/vercel-release-gate.md` | Provider administrator prerequisites, implemented guards, GET-only probe, external findings and required negative-release drill. |
| `package.json` | Add release safety/probe and expanded complete gate; force default database gate to isolated PGlite. |
| `scripts/catalogue-probe.mjs` | Commercial probe CLI with presence/format validation and redacted counts-only result/errors. |
| `scripts/categories.flow.mjs` | Stabilize categories with canonical/legacy route readiness, flushed native updates and observable business/UI state; preserve coverage (see root-cause table). |
| `scripts/dashboardux.flow.mjs` | Stabilize dashboardux with canonical/legacy route readiness, flushed native updates and observable business/UI state; preserve coverage (see root-cause table). |
| `scripts/final.flow.mjs` | Stabilize final with canonical/legacy route readiness, flushed native updates and observable business/UI state; preserve coverage (see root-cause table). |
| `scripts/lib/app-bundle.mjs` | Always isolated explicit Demo despite ambient Production values; real release metadata and test-only same-renderer entry. |
| `scripts/lib/app-entry.ts` | Test-only flushSync export from the identical ReactDOM renderer; no Production global/entry change. |
| `scripts/lib/candidate-release.mjs` | Verify served immutable candidate nonsecret metadata before domain movement; no bypass token. |
| `scripts/lib/catalogue-probe.mjs` | Anonymous STABLE GET-only catalogue/exact variants/representative pricing, counts-only failure/empty controls. |
| `scripts/lib/github-release-gate.mjs` | Trusted latest exact-SHA/run checks/current main and independent reviewer/main-only environment policy; fail closed. |
| `scripts/lib/release-artifact.d.mts` | Typed build-plugin/release identity contract for Vite. |
| `scripts/lib/release-artifact.mjs` | Nonsecret exact checkout identity, copied-file digests, final-byte secret/escaped-value scan and labelled Demo manifest. |
| `scripts/lib/test-production-env.mjs` | Clearly synthetic .invalid public configuration for offline contract tests only. |
| `scripts/lib/ui-waits.mjs` | Yielding committed-route/UI readiness, exact form/category/permission/filter/product signals. |
| `scripts/lib/ux-harness.mjs` | Canonical semantic route/auth/action/cart/checkout waits; correctly flushed native events, no shared settle sleeps. |
| `scripts/lifecycle.flow.mjs` | Stabilize lifecycle with canonical/legacy route readiness, flushed native updates and observable business/UI state; preserve coverage (see root-cause table). |
| `scripts/nav.flow.mjs` | Stabilize nav with canonical/legacy route readiness, flushed native updates and observable business/UI state; preserve coverage (see root-cause table). |
| `scripts/poslayout.flow.mjs` | Stabilize poslayout with canonical/legacy route readiness, flushed native updates and observable business/UI state; preserve coverage (see root-cause table). |
| `scripts/production-preflight.mjs` | Validate actual supplied mode/config plus final checkout/dist integrity and secrets, not only the env template. |
| `scripts/promotions.flow.mjs` | Stabilize promotions with canonical/legacy route readiness, flushed native updates and observable business/UI state; preserve coverage (see root-cause table). |
| `scripts/release-safety.test.mjs` | 19 groups: fail-closed config/real Vite artifacts/bootstrap/secret/integrity/GET probes and exact-SHA/protected-candidate authorization. |
| `scripts/store.flow.mjs` | Stabilize store with canonical/legacy route readiness, flushed native updates and observable business/UI state; preserve coverage (see root-cause table). |
| `scripts/storefront.flow.mjs` | Stabilize storefront with canonical/legacy route readiness, flushed native updates and observable business/UI state; preserve coverage (see root-cause table). |
| `scripts/storepolish.flow.mjs` | Stabilize storepolish with canonical/legacy route readiness, flushed native updates and observable business/UI state; preserve coverage (see root-cause table). |
| `scripts/variants.flow.mjs` | Stabilize variants with canonical/legacy route readiness, flushed native updates and observable business/UI state; preserve coverage (see root-cause table). |
| `scripts/vercel-release.mjs` | Pinned guarded Vercel pull/build/prebuilt candidate/promote, authoritative env and byte/secret/probe/authorization checkpoints. |
| `scripts/visualaudit.flow.mjs` | Stabilize visualaudit with canonical/legacy route readiness, flushed native updates and observable business/UI state; preserve coverage (see root-cause table). |
| `src/App.tsx` | Controlled config gate before all business providers, persistent Demo banner and safe committed-route marker. |
| `src/components/layout/RouteGuard.tsx` | Use supported Card testId so semantic access-denied state is observable; permissions unchanged. |
| `src/lib/auth/__tests__/support/fakeSupabaseClientModule.ts` | Extend isolated auth stub for the explicit repository-mode API; no real backend/credential change. |
| `src/lib/auth/data/index.ts` | Select persistence only through the shared explicit validated mode; invalid Production cannot fall back to Demo. |
| `src/lib/config/ApplicationConfigurationScreen.tsx` | Bilingual controlled unavailable page without business providers, input forms or configuration values. |
| `src/lib/config/application-mode.d.mts` | Typed discriminated shared configuration/allowlist interface. |
| `src/lib/config/application-mode.mjs` | Shared browser-safe exact mode/URL/public key/seed-veto/build allowlist validation, safe error codes. |
| `src/lib/config/release.ts` | Four-field readonly nonsecret build identity for authenticated Health/support diagnostics. |
| `src/lib/i18n/dictionary.ts` | EN/AR Demo copy describes explicit selection and noncommercial local test data, not missing Supabase fallback. |
| `src/lib/supabase/client.ts` | Explicit config/repository mode, HTTPS/public-key validation and controlled SDK errors; no missing-config Demo return. |
| `src/lib/supabase/realtime.ts` | Import-time invalid config does not pre-empt controlled bootstrap or open a channel. |
| `src/main.tsx` | Register Production push service worker only with valid Production config, never Demo/invalid mode. |
| `src/modules/approvals/data/index.ts` | Select persistence only through the shared explicit validated mode; invalid Production cannot fall back to Demo. |
| `src/modules/audit/data/index.ts` | Select persistence only through the shared explicit validated mode; invalid Production cannot fall back to Demo. |
| `src/modules/backup/data/index.ts` | Select persistence only through the shared explicit validated mode; invalid Production cannot fall back to Demo. |
| `src/modules/customers/data/index.ts` | Select persistence only through the shared explicit validated mode; invalid Production cannot fall back to Demo. |
| `src/modules/expenses/data/index.ts` | Select persistence only through the shared explicit validated mode; invalid Production cannot fall back to Demo. |
| `src/modules/import/services/commit.ts` | Require explicit validated repository mode for live import dispatch; no configuration-absence local path. |
| `src/modules/inventory/data/index.ts` | Select persistence only through the shared explicit validated mode; invalid Production cannot fall back to Demo. |
| `src/modules/mobile/pages/MobileHealthPage.tsx` | Display allowlisted SHA/UTC build time/environment in authenticated Mobile Health. |
| `src/modules/online/__tests__/orderReadConsistency.selftest.ts` | 14 deterministic late-read/filter/close/payment race regressions. |
| `src/modules/online/components/storefront/VariantPicker.tsx` | Prefer exact merchant size_value while preserving numeric legacy/color-only labels. |
| `src/modules/online/data/index.ts` | Select persistence only through the shared explicit validated mode; invalid Production cannot fall back to Demo. |
| `src/modules/online/hooks/OnlineOrdersProvider.tsx` | Validated catalogue factory plus stale filter/drawer snapshot invalidation before/after writes and selection changes. |
| `src/modules/online/pages/StoreProductPage.tsx` | Reset product identity/selection before paint so first color click is not erased by a passive effect. |
| `src/modules/online/services/orderReadConsistency.ts` | Timer-free independent read/filter/selection/write revision guard. |
| `src/modules/online/services/variantLabel.ts` | Shared flexible size labels and legacy frozen numeric compatibility. |
| `src/modules/pos/components/VariantPicker.tsx` | Use shared merchant size/order/color-only helpers; keep exact shelf/stock/cart refusal behavior. |
| `src/modules/pos/data/index.ts` | Select persistence only through the shared explicit validated mode; invalid Production cannot fall back to Demo. |
| `src/modules/pos/hooks/PosProvider.tsx` | Use validated shared catalogue factory instead of credential-presence fallback selection. |
| `src/modules/pos/services/transactionCenter.ts` | Explicit validated persistence branch for payment/void operations, preserving authorization. |
| `src/modules/products/__tests__/flexibleVariants.selftest.ts` | Seven additional exact flexible/legacy/color-only/bilingual label regressions. |
| `src/modules/products/data/index.ts` | Select persistence only through the shared explicit validated mode; invalid Production cannot fall back to Demo. |
| `src/modules/registers/services/registerService.ts` | Explicit validated backend selection; no silent local register mode from absent credentials. |
| `src/modules/returns/data/index.ts` | Select persistence only through the shared explicit validated mode; invalid Production cannot fall back to Demo. |
| `src/modules/settings/data/index.ts` | Select persistence only through the shared explicit validated mode; invalid Production cannot fall back to Demo. |
| `src/modules/settings/services/systemReset.ts` | Explicit validated reset backend selection without changing preview/permission/financial safeguards. |
| `src/modules/shifts/data/index.ts` | Select persistence only through the shared explicit validated mode; invalid Production cannot fall back to Demo. |
| `src/modules/storefront/data/storefrontCatalog.ts` | Use explicit validated catalogue backend selection; never missing-config fake public catalogue. |
| `src/modules/system/pages/HealthCenterPage.tsx` | Display/export nonsecret release identity and use supported Card testId for Health facts. |
| `src/vite-env.d.ts` | Declare explicit app mode and release environment public build variables. |
| `vite.config.ts` | Load/validate actual build environment, derive checkout identity and inspect final copied/inlined artifact; safe dev error identity. |
