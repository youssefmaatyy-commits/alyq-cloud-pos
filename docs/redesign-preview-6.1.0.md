# ALYQ redesign preview — 6.1.0-preview.1

## Public-site inspection (read-only)

On 2026-10-22, the publicly served homepage at `https://alyq-store.vercel.app` was inspected as page text. It showed category tiles with “Image unavailable” placeholders, several product cards with unavailable product images, and a product named `test` in the New Arrivals section. No production data was changed. The site uses HashRouter routes; this environment had no interactive browser, so other client-side routes, actual mobile/tablet rendering, screenshots, and live purchase interactions could not be truthfully verified.

## Changes in this preview

- Shop-by-category cards are now text-only bilingual Arabic/English cards with a restrained gold border, cream surface, direction-aware arrow, keyboard focus, and reduced-motion-aware hover/touch states. Category selection still requires an active category with a visible product; archived categories are filtered out. The empty state is intentional and has no unavailable category links.
- Named variant/model products stay one parent product in the catalogue; cards preview up to four in-stock model images and the number of sellable shapes. The PDP adds an all-model grid with each model's image/name/price/available quantity, sold-out state, photo zoom, explicit selection and per-model add-to-cart. Existing product/variant identifiers, pricing, reservation and order services remain authoritative; no migration was created.
- Storefront section and catalogue spacing was reduced modestly while retaining ALYQ's configured palette and typography.
- Electron launches at `#/login`; `eg.alyq.pos`, Electron `userData`, `desktop-config.v1.json` and the existing uninstall data-retention setting are unchanged.
- System settings now checks the pinned official GitHub Releases feed. Without Authenticode signing, updates remain manual: it opens only the official repository release page and never downloads, installs, or restarts the app. No fake transfer progress or silent install is shown.

## Validation boundary

- Automated local fixture: 12 named BR101 models, 12 distinct images, varied prices/stocks, one sold out; one parent product and shared parent barcode. Verified card preview, all PDP models, exact model UUID in cart and placed local demo order, correct variant name snapshot, sold-out purchase refusal, zoom, Arabic/English + RTL/LTR and archived-category exclusion. No Supabase or Production writes.
- `npm run typecheck`: passed. `npm run test:e2e -- storefront-v2 staff-entry`: passed (63 checks across these flows, including the exact model-order path and the `logpos` login route). Release-check and desktop-security focused logic suites passed. `npm run db:check`: all 98 migration files applied/idempotency-checked in local PGlite only; no migration was run against a hosted database.
- Full existing test suites are not all green on this checkout: `npm test` has one failure in `src/modules/mobile/__tests__/mobile.selftest.ts` because its expected Android `versionCode 2` does not match the repository's conditional `versionCode ... ? 3 : 2`. Full `npm run test:e2e` reports six failures in the existing `store`, `lifecycle`, `storefront`, `promotions`, `final`, and `storepolish` flows; failures are in legacy POS/catalogue/return workflows, not the new model/gallery/update checks. See command output for exact assertions.
- `npm run lint` passed with 41 existing warnings and no errors; no warning was added in modified TS/TSX files.
- Real Chromium, physical Windows, printers/scanners, and a test Staging Supabase were not available. CSS geometry screenshots, hardware, offline install-over-version and physical sync were not tested.
- Windows NSIS packaging was attempted after a successful web build but failed while Electron Builder fetched its Windows runtime (`unable to verify the first certificate`). No `.exe` was produced. Unsigned binaries would in any case be manual-only and may trigger Windows SmartScreen.

## Preview/deployment status

This is a development-branch build only. The connected Vercel account returned no projects (including no `alyq-store` project), so no Vercel Preview could be created without configuring an existing project; no new project was made. The repo branch is `arena/f498e340-alyq-cloud-pos`. Production website, production database, GitHub Releases and final Windows release were not changed.
