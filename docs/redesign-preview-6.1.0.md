# ALYQ POS 6.1.0 preview — scope and verified evidence

## Branch / deployment boundary

- Accepted base: commit `1451e4a` on `arena/f498e340-alyq-cloud-pos`; current work is a small follow-up on that same branch.
- No merge, Production deployment, hosted migration, or Production data/order/stock/settings change was made.
- The local preview is isolated to a read-only Staging snapshot and demo-only cart/checkout. It rejects HTTP writes; no order from this preview reaches Staging or Production.

## Model gallery fixes

- Staging BR101's real model rows carry their Arabic model names in legacy `size_value`/`size_label` fields as well as `display_name_ar/en`. The V2 model detector now treats that duplicate compatibility label as a model name, not as a size option, so the real rows open the model gallery.
- A model card now shows a neutral localized missing-photo state when there is no image URL **or when the URL fails to load**. The model name, SKU-bound choice, availability, price, add action, and exact variant ID remain intact; a broken image no longer leaves a browser broken-image glyph.
- Screenshot and DOM fixtures use the exact read-only Staging snapshot in `scripts/staging-br101.snapshot.mjs`. They contain only the three existing records, no extra models, fabricated inventory/prices, repeated photos, or generated product images. One local negative-path test omits M03's photo only to test the fallback; it does not write the row back to Staging.

## Verified Staging data (read-only)

- Parent `BR101`: active and website-visible, product barcode `BR101`, listed price EGP 240, three active variants.
- `BR101-M01` / “Model 1” / `BR101-M01` barcode / stock 4; `BR101-M02` / “Model 2” / `BR101-M02` barcode / stock 3; `BR101-M03` / “Model 3” / `BR101-M03` barcode / stock 5. The three image URLs are actual Staging URLs. Staging has **no rows for models 04–12**; no such rows were invented.
- Production remains untouched. Previous read-only checks found no variants for Production BR101 and no product images on its active public catalogue. That data state is not repaired by this preview.

## Local checks and screenshots

- Passed locally: production preflight (26/26, with `--allow-dirty` while validating the follow-up); all 79 logic suites; typecheck; 49 storefront V2 DOM checks; 25 hidden-staff-entry checks; production build; targeted ESLint; workflow YAML parse; `git diff --check`.
- The complete 33-suite browser DOM runner still has six broader failures: store/POS navigation, product lifecycle save, old storefront flow, promotions return detail, final integrated flow, and storepolish save. The base commit `1451e4a` already had a failing full-E2E Actions job; these six are outside the focused gallery tests and remain unaccepted. The current release workflow also records those full-E2E failures. Do not represent the entire E2E suite as green.
- The new logic/DOM coverage verifies Staging's duplicate model-name/size fields, English/Arabic labels, real variant IDs/SKUs and stock 4/3/5, neutral fallback with a missing URL, and fallback after an image error. The demo checkout test is local-only.
- A headless local browser captured 24 current storefront screenshots (home, categories, catalogue, gallery, cart, checkout; EN/AR; desktop 1366px/mobile 390px) and checked home/catalogue/product/cart/checkout at 360, 390, 768 and 1366px in both directions. In this sandbox, the three external Staging photo hosts were unreachable; the screenshots therefore show the neutral fallback for all three URLs. This is an image-network limit, not proof that the URLs are broken for customers. No TLS verification was disabled.
- The live local preview uses a visible “local preview / demo checkout” notice and only GET/HEAD requests. The page can change browser-local demo cart state but cannot submit an order to Supabase.

## Windows and live Staging checkout

- The previous actual Windows run (`39804694194`, commit `1451e4a`) completed the build, checksum, typecheck and focused tests, but the 6.0.0-to-preview installed-app step failed. It is **not** counted as a passing upgrade.
- The follow-up Windows run (`39814281480`, commit `c794cee`) built the unsigned installer, checksum, and screenshot artifact, but failed its 6.0.0 packaged-app check before upgrading. Run `39824247277` (`2d0df9a`) showed the archived 6.0.0 renderer does not expose `window.alyqDesktop`. Run `39831261248` (`2709b84`) showed its initial renderer has no hash and no recognizable login text; the helper stopped before trying the explicit login route. The 6.1.0 installer was not run in these attempts; none is a passing upgrade.
- The current verifier handles the archived 6.0.0 bridge gap by opening that renderer's local `#/login` route through its hash router, then checks the actual login text. In the isolated runner it seeds a valid, harmless 58 mm receipt-width setting into the real 6.0.0 `userData` JSON, restarts 6.0.0, and checks that login remains visible and the setting/installation ID remain. It then writes a sentinel and upgrades to 6.1.0; the upgraded app must expose its desktop bridge, report `#/login`, read the same setting, and leave the config hash and sentinel unchanged. The next push exercises these assertions. Acceptance remains pending until a real Windows result says PASS.
- No live Staging order was submitted: there is no demonstrated safe, reversible cancellation path for a pending order. Checkout form/cart are exercised only in local demo mode.
- Physical printer, scanner, camera, and live sync have not been tested.
