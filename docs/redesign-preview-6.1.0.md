# ALYQ 6.1.0 preview — scope, evidence, and limits

## Branch and deployment boundary

- Work stays on `arena/f498e340-alyq-cloud-pos`; no merge, Production deploy, hosted migration, or final release is part of this preview.
- Existing V2 storefront, exact-variant/model gallery, `logpos` staff entry, and manual Windows update panel are continued in place.
- The Vercel connector reported no connected projects, so the available browser preview is the Arena Live Preview. The Windows screenshot workflow also captures the public Production site read-only for a before baseline; it never logs in or checks out there.

## Storefront changes and checks

- Removed the `store.v2.eyebrow` copy and every rendering site in both dictionaries. No replacement label or spacer is left. E2E assertions cover English and Arabic home/categories, catalogue, PDP, cart, and checkout; a dictionary self-test prevents the key/tagline from returning.
- Category tiles remain bilingual text-only cream/gold links. They are sourced only from active categories with visible products; archived categories are not reactivated, and the empty state remains an intentional message.
- Existing model gallery and cart/order ownership stay unchanged. The local E2E fixture verifies one parent product, a shared parent barcode, twelve distinct model IDs, correct model selection, sold-out refusal, and the exact variant ID/name in the local demo order.
- The screenshot harness checks RTL/LTR and horizontal overflow on home, catalogue, product, cart and checkout at 360, 390, 768 and 1366 px. It captures read-only Production before images and local-preview after images. No production cart or checkout is submitted.

## Read-only database/image findings (2026-10-22)

- Production `BR101` is one parent row with `variants_enabled=false`, stock 2, no cover/gallery images and no variant rows. No Production change was made.
- The Production catalogue has 44 active, website-visible products; the read-only query found all 44 with no product-level cover/gallery image. Production `product_content` had no rows, and its 12 variant rows had no images. The public site's broken/unavailable product imagery is therefore a data/storage-content problem, not caused by the V2 card layout. No substitute images were added.
- The Production product named `test` is a real row with SKU/name `TEST`/`test`, active and website-visible, in an active category, with no image. It remains untouched as requested.
- The separate Staging project contains only three BR101 variants (M01–M03), not the twelve-model record described in the prompt. The screenshot fixture uses those three Staging image URLs and deliberately leaves the other nine fixture cards image-less; it does not repeat or fabricate photos. A twelve-model **live Staging** purchase is not established by that database state.

## Validation

- Local: `npm run typecheck`, production web build, 10 focused logic suites, and the storefront/staff-entry E2E passed; the targeted storefront flow includes the local fixture order and `logpos` click/Enter path.
- Production-data safety: no Production rows, images, categories, stock, orders or settings were changed; no hosted migration was run.
- Full legacy test failures are compared against `main` at `f1d7ccb`: the one Android `versionCode 2` assertion and six legacy E2E suite failures also reproduce on `main`. They were not disabled or rewritten as passes.
- Full `production:preflight` intentionally rejects the preview version because that gate is pinned to `6.0.0`; this is not a Production deployment attempt.
- Dependency triage removed all Critical/High alerts and leaves zero vulnerabilities in the production dependency set. Eight Moderate findings remain in the Electron packaging/build chain; forcing an out-of-range downgrade introduced worse alerts and was reverted.

## Windows preview acceptance

- The Windows GitHub Actions workflow builds the unsigned 6.1.0-preview.1 x64 NSIS installer, emits a SHA-256 file, and uploads artifacts only (not a GitHub Release). It verifies `eg.alyq.pos`, `ALYQ POS`, `#/login`, `desktop-config.v1.json`, Electron userData, and uninstall retention.
- The current workflow also installs the checksummed, pre-existing 6.0.0 installer in a disposable Windows runner profile, launches both versions to verify the packaged login route, writes a userData sentinel, upgrades to 6.1.0-preview.1, then checks that the config and sentinel remain unchanged. This uses no customer profile or Production order.
- Physical receipt printer, barcode scanner, camera, live sync, and a live Staging checkout remain separate tests; logic/DOM tests are not hardware or cloud evidence.
