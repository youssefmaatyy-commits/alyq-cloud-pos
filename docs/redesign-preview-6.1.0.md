# ALYQ POS 6.1.0 preview — scope and verified evidence

## Branch / deployment boundary

- Current work starts from `621be2bd` on `arena/f498e340-alyq-cloud-pos`; the final logo-fix commit is recorded in the delivery summary after it is created.
- No merge to `main`, official-site deployment, production migration, Production data/order/stock/settings change, or Staging write was made.
- Local storefront previews use the read-only Staging snapshot and demo-only cart/checkout; they cannot submit an order to Staging or Production.

## ALYQ header logo fix

- The official source `public/alyq-logo.png` remains unchanged for receipt compatibility. The header now uses `public/brand/alyq-logo-transparent.png`, a 767×338 alpha-transparent derivative cropped to the original artwork bounds. Its original bilingual gold `ALYQ | أليق` artwork and proportions are retained; the cream square canvas is not rendered.
- The default ALYQ mark is 72px high on desktop and 56px on mobile. `object-fit: contain` preserves all artwork; responsive grid columns keep the logo between the controls instead of overlapping them. Custom merchant logos and their 52px/40px default sizing remain unchanged; a custom brand without a logo retains its text fallback.
- Real-Chromium verification passed for desktop EN, desktop AR/RTL, mobile EN and mobile AR/RTL. It checked source load, transparent image corners, gold artwork, native ratio, actual responsive height, centering, direction, and non-overlap with menu/search/account/cart. The test is `scripts/rendered-v2-header.flow.mjs`.
- Actual before/after header captures are in `release-evidence/logo-comparison/`: `before-desktop-en.png`, `before-desktop-ar.png`, `before-mobile-en.png`, `before-mobile-ar.png`, and matching `after-*.png`. The Before captures use the legacy opaque `/alyq-logo.png` setting and show its cream rectangle; the After captures show the larger transparent source. These are local real-browser captures, not edited mockups.

## Model gallery and read-only Staging snapshot

- Staging BR101's model rows carry Arabic model names in legacy `size_value`/`size_label` fields as well as `display_name_ar/en`. The V2 model detector treats that compatibility label as a model name, not as a size option, so the real rows open the model gallery.
- A model card shows a neutral localized missing-photo state when there is no image URL or when its URL fails to load; model name, SKU-bound choice, availability, price, add action and exact variant ID remain intact.
- Screenshot/DOM fixtures use the exact read-only Staging snapshot in `scripts/staging-br101.snapshot.mjs`; no product rows, fabricated inventory/prices, repeated photos or generated product images were added.
- Last recorded read-only Staging catalog values: parent `BR101` is active and website-visible, listed at EGP 240, with three active variants. `BR101-M01` stock 4, `BR101-M02` stock 3, `BR101-M03` stock 5. These are Staging values only; Production was not checked or modified in this continuation.

## Checks and pre-existing E2E failures

- Current change: `npm run typecheck` passed; `npm run build` passed; three targeted logic suites passed (brand dictionary, online appearance 105/105, V2 bootstrap 7/7); the real-Chromium logo matrix passed 4/4.
- The full 33-suite browser DOM/E2E runner has six already-existing failures: **store/POS navigation; product lifecycle save; old storefront flow; promotions return detail; final integrated flow; storepolish save**. They were present on `main` and on the prior development commit `621be2b`; they are not suppressed, skipped, or claimed green here. CI run [39835400673](https://github.com/youssefmaatyy-commits/alyq-cloud-pos/actions/runs/39835400673) had Types & build, Migrations & schema, and Logic suites succeed, while E2E (jsdom) failed. The six broad failures were not rerun during this logo-only change to avoid repeating known unrelated flows.
- A previous V2 DOM matrix and the broader release checks are documented by the prior run; they are not a substitute for the six failing end-to-end flows.

## Windows artifact

- The successful Windows preview/upgrade run is [39835400652](https://github.com/youssefmaatyy-commits/alyq-cloud-pos/actions/runs/39835400652) at commit `621be2b`. The build, checksum, installed 6.0.0→6.1.0 preview upgrade, and screenshot steps all passed.
- Keep the existing installer artifact [ALYQ-POS-Setup-6.1.0-preview.1-x64](https://github.com/youssefmaatyy-commits/alyq-cloud-pos/actions/runs/39835400652/artifacts/12450512527) and its checksum. This logo-only continuation did not rebuild or replace the EXE. `windows-preview.yml` now ignores these storefront-only paths on `push`; manual dispatch remains available when a desktop rebuild is actually needed.

## Order WEB-000005 and inventory (Staging; read-only)

- Read-only Staging query: `WEB-000005` is still `pending`, has `sale_id = null`, and one `reserved` unit on variant SKU `BR101-M01`. Variant on-hand is 4, reserved is 1, and available-to-promise is 3. No cancellation or inventory mutation was performed.
- The correct authorized path is the Online Orders workspace: open `WEB-000005`, choose the pending-order **Reject** action (the UI labels the pending cancellation this way), enter the required reason, and confirm using a staff account with `manage_online_orders`. For orders already linked to a sale, cancellation also requires `canVoidSale`; this pending order has no sale link.
- Only after an authorized cancellation, verify status `cancelled`, the reservation `released` with a resolution timestamp, on-hand still 4, reserved 0 and available-to-promise 4. That post-cancellation check has **not** been performed because no authorized account/session was available.

## Vercel Preview / UAT

- Last known preview URL: https://alyq-store-3dkf5ke24-youssef-maaty.vercel.app . It was not verifiably reachable in this continuation: the prior deployment lookup returned 404, and the connected Vercel account currently lists no project or preview deployments. No hosted page is claimed as tested and no official deployment was made.
- After the development branch Preview is available, UAT should open the URL on desktop and a 390px mobile viewport; inspect `/` and `/#/store`, switch language EN↔AR, confirm the transparent bilingual header logo, navigation/control spacing, catalogue, product gallery, cart, and checkout validation. Do not place a real order; verify checkout remains demo-only.
