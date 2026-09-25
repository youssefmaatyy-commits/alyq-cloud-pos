# Storefront V2 — Phase 4B: dependency-audited local release candidate

**Local acceptance record:** 2026-09-25 (Africa/Cairo) · branch `arena/01a0ce43-alyq-cloud-pos` · demo repositories and a locally served, built single-file app. **Not a deployment, live-order test, payment certification, database migration, or claim of reliable crawler indexing.** Phase 3 and 4A baselines: [Phase 3](STOREFRONT_V2_PHASE_3.md) and [Phase 4A](STOREFRONT_V2_PHASE_4A.md). Counts below are **fresh Phase 4B** runs unless explicitly identified as a pre-cleanup comparison.

## Dependency audit and bounded cleanup

### 1. Decision and scope
Phase 4A's canonical cutover was already complete. Phase 4B audited the *current* source before cleanup, removed only proven-unused public import edges, retained test-dependent legacy source, added a repeatable dependency guard, and repeated local release-candidate validation. There was no commerce rewrite, second public route tree, debug switch, production order or deployment.

### 2. Worktree preservation, provenance and SQL stop line
The checkout started substantially dirty at `0582c5f`; tracked and untracked Phase 1–4A work was preserved. `supabase/tests/scenarios.sql` was already modified and `supabase/migrations/0061_last_active_variant_guard.sql` already untracked. Their authorship remains **C — unprovable from local evidence** (the SQL provenance classification, **not** the dead-code classification below). Neither SQL file was edited, deleted, moved, applied or deployed in Phase 4B. No migration, RLS/RPC, Edge Function, backend authority, database or staff-permission change was authorized or made.

### 3. Audit method and limits
Inspected `App.tsx`, `StorefrontApp.tsx`, the online-module barrel, all online page/component imports, dynamic/test references, rollback plugin, Admin previews, CSS entry points, i18n uses and Phase 3/4A reports. Compared esbuild **metafile input graphs** for `src/main.tsx` both with and without the ten-suite, test-only rollback projection; inspected files absent from both graphs and ran the actual registered suites. A metafile can include parsed but eventually tree-shaken files, so **absence** establishes no import edge; mere presence does not establish executed UI or bundled bytes. The runnable guard is `node scripts/storefront-v2-dependency.audit.mjs`.

### 4. Classification A — canonical V2
`src/App.tsx`'s ten public shopper destinations, `StorefrontApp.tsx`'s single provider/shell boundary, the twelve `v2/StorefrontV2*` route/shell/redirect components, V2 cards/chooser/primitives, models/appearance/route adapter and `v2/storefront-v2.css` are active. `src/modules/online/components/admin/StorefrontV2DraftPreview.tsx` also imports the V2 stylesheet for the Admin editor. Preserve all of these.

### 5. Classification B — shared commerce and proof
`StorefrontProvider`, `StoreCartProvider`, `StoreAccountProvider`, online repositories, public catalogue, pricing/promotions/coupons/zones/orders/tracking/account/media/settings/theme/SEO, `PaymentProofPanel` and `StorePrimitives` still have public or Admin dependencies. The V2 confirmation/tracking journey renders the existing proof panel (and its `FieldNote`/`Money` primitives). Cart line and order authority remain in the shared implementation; removal or parallel replacement is not cleanup.

### 6. Classification B — Admin and POS dependencies
`pages/StoreContentPage.tsx` is the authenticated content editor, **not** a retired shopper page. `WebsiteSettingsPage.tsx` still mounts both the older `StorefrontPreview` fragment and the V2 Studio/draft preview; `services/theme.ts`, shared `--store-*` tokens and `online.preview.*` translations serve those screens. The POS/Admin routes, dashboard notification/provider imports and other module-barrel exports remain required. Do not delete them on the basis of a `Store*` or `Storefront*` name.

### 7. Classification B — retained legacy test dependencies
All **ten** older shopper pages (`StoreHomePage`, `StoreProductsPage`, `StoreProductPage`, `StoreCartPage`, `StoreCheckoutPage`, `StoreConfirmationPage`, `StoreTrackPage`, `StoreAccountPage`, `StoreAboutPage`, `StoreContactPage`) are loaded by `scripts/lib/legacy-store-rollback.plugin.mjs` for **ten registered historical E2E suites**. `components/storefront/StoreLayout.tsx`, `ProductCard.tsx` and `VariantPicker.tsx` are reachable from that same projection; a branding logic test also reads five legacy files by path. They are **not** public routes after the cutover but are **not proven unused across tests/scripts**. Retained 13/13 legacy presentation modules, without a production rollback URL.

### 8. Classification C — actually proven unused
After routing the test harness to direct file imports, the **ten legacy page re-exports** in the production `src/modules/online/index.ts` barrel had no consumer. Removed those ten re-export *edges*, not their source files or behavior. The old `StoreLayout`-resident **export location** of `SocialIcon` was also unnecessary for V2 once its SVG component was moved verbatim to a small shared module. No other online production/test source file qualified: the union of both input graphs covered **every non-test `.ts`/`.tsx`/`.css` file under `src/modules/online`** in the audit. **Legacy files deleted: 0; legacy page barrel exports removed: 10.** There is no claim that test-dependent legacy files were deleted.

### 9. Classification D — uncertain or not separable safely
No CSS selector, Tailwind-generated utility, image, theme token or `store.*`/`online.*` dictionary key was removed by a guessed textual usage count. Tailwind v4 scans the source tree; dynamically assembled i18n keys and Admin/rollback dependencies make name-only deletion unsafe. There is no separate legacy CSS file: the two relevant authored stylesheets are `src/index.css` (global/shared) and `src/modules/online/v2/storefront-v2.css` (active V2/Admin). Keep D candidates until a separate per-selector/per-key proof exists; do not call them dead or claim a smaller CSS payload.

### 10. Production barrel cleanup
`src/modules/online/index.ts` now exports the active root, back-office pages and providers without re-exporting ten retired shopper pages. `src/App.tsx` still imports `StorefrontApp` and Admin/POS-related exports normally; the public route table remains untouched. This eliminates the production barrel's static path to the retired shopper page tree without removing the rollback test's source. No dynamic production import or implicit legacy URL was found.

### 11. Shared SVG dependency extraction
Moved the original five-platform `SocialIcon` implementation out of the monolithic legacy `StoreLayout.tsx` to `components/storefront/SocialIcon.tsx`. V2 shell, home and social-channel renderer import the new provider-free module; the retained legacy layout imports it too. The SVG paths, labels and social URL policy were not rewritten; the old shell is no longer imported to render V2 icons. `PaymentProofPanel`/`StorePrimitives` deliberately remain shared rather than being copied or deleted.

### 12. Rollback harness after isolation
The **test-only** esbuild plugin now imports each retained legacy page by its direct path instead of the production online barrel, then substitutes legacy routes/shell only inside a temporary jsdom bundle. Ten historical suite IDs use this rollback projection; the other **16** registered suites run the actual canonical bundle (the `store` suite additionally boots the canonical bundle for forged-social checks). This is a test architecture, **not** a shipped switch, duplicate customer route or default rollback. Any future *actual* route-level rollback would need an explicit route/shell change and link/SEO review.

### 13. Repeatable graph/build evidence
Before isolation: **470 public / 452 rollback** parsed esbuild inputs and **486** Vite-transformed modules. With the locked dependencies restored by `npm ci`: **458 public / 453 rollback** parsed inputs, **474** Vite-transformed modules. The audit asserts **13** legacy modules absent from the public graph and present in rollback, **7** shared/Admin modules and **12** canonical V2 route/shell modules present in public. Baseline single-file HTML was **3,300,929 bytes**; final **3,300,899 bytes** (gzip approximately **876.9 kB** in both). This is source-boundary evidence, **not** a meaningful performance/byte-saving claim; CSS/i18n remain shared.

### 14. CSS, assets and presentation policy
No legacy CSS or shared styling was removed. V2 CSS is `.store-v2`-scoped; the Admin draft also uses it. Brand/product media, fallback images, responsive utilities and `--store-*` tokens remain available to the shop, Admin fragment and proof panel. No arbitrary CSS purge, image deletion, palette change or global restyle was necessary for a truthful cleanup.

### 15. I18n and dynamic-reference policy
English/Arabic dictionary entries for V2, Admin, shared order/proof/status surfaces and legacy regression were kept. Dynamic status, badge and variant translation keys are assembled at runtime, so static string counts cannot prove they are unused. The cleanup adds no dead-translation assertion or mass key deletion. Shipped page titles and configured branding still use the existing translated/content pathways.

## Canonical routing and shopper acceptance

### 16. Sole public V2 route tree
One `#/store` V2 shell serves home; `products` and `products/:key` (published slug or ID); cart, checkout, confirmation, track, account, About and Contact. `#/store/v2/*` is a **redirect only**, with `replace`; there is no live legacy shopper tree or debug path. These routes stay outside the authenticated POS/Admin provider chain.

### 17. Former preview-bookmark redirects
Known former preview URLs redirect one way to their same canonical destinations. The product path segment retains the actual slug/identifier; navigation back does not loop into the preview prefix. Unknown preview URLs fail closed to `#/store`. DOM **26** cutover checks and Chromium **10/10** cutover groups covered route/reload/back behavior.

### 18. Safe URL query and private identifier policy
The adapter allowlists known catalogue search/facets/sort, a shareable tracking `number`, and supported account tab values. It strips `phone`, `token`, other unexpected query fields and former fragment data; the tracking phone is never copied into a canonical URL. Configured saved preview links use the same canonicalizer after existing URL safety validation. Neither query nor displayed prices are order authority.

### 19. Missing products and unknown canonical paths
Unknown canonical store paths return home, not a second renderer. An unknown/unpublished `products/:key` stays on a V2 not-found view with `noindex, nofollow`, without exposing order information. These states are covered by canonical DOM and Chromium cutover probes.

### 20. V2 links and stored merchant destinations
Header, drawer, home CTAs, product cards, breadcrumbs, journey pages, footer, Admin **Open saved V2** and configured valid internal links target `#/store/*`, not the old preview prefix. Valid external URLs use the existing safe link policy and `noopener noreferrer` where opened in a new tab; no policy page was invented from an unknown link. Editing a merchant's saved settings is not triggered by following an old bookmark.

### 21. One provider chain and order authority
The public root continues to mount `StorefrontProvider → StoreAccountProvider → StoreCartProvider → StorefrontV2Shell → Outlet`. V2 is a presentation/journey layer over existing public reads and placement. In live mode the existing order repository/`place_online_order` contract must accept availability, quantities, delivery, coupons and totals; the demo/browser previews cannot grant inventory or mark a payment paid.

### 22. Search, filters and deep links
Catalogue search, category, colour, numeric/letter size, brand, availability, offer and sort remain URL-backed and use published data. Redirected safe filters, direct canonical entry and reload preserve the query; no-result and clear-filter actions remain available. Rendered/DOM flows checked search input, price sort, data-derived size filters and mobile drawer behavior.

### 23. Product detail, media and focus
The PDP resolves actual content and stored media, with accessible fallback, size guidance and related products. Chromium scrolled lazy media into view and checked image loads/no broken assets in the sampled pages; keyboard gallery/lightbox arrows and Escape/focus return were exercised. No new catalogue/media backend or stock imagery was introduced during cleanup.

### 24. Exact variant UUID and orderability
Gold/17, sold-out Gold/18, Silver/XS, numeric/decimal and letter sizes remained independently selectable according to actual active published variant rows. Colour alone cannot substitute a different size or sibling UUID; switching colour clears invalid previous size. Quick-add, cart and reorder preserve the **exact variant UUID**, or `null` for a simple product. The browser matrix exercised **32/32** public variant cases and **26/26** customized variant cases across EN/AR.

### 25. Cart identity, limits and stale persistence
Cart lines retain product ID, exact variant ID, quantity/SKU; stock-tracked orderability and reserved/current quantities constrain adds. Persisted wrong-product/inactive/missing variant lines are pruned **after** a successful catalogue load with a dismissible notice, not replaced by a convenient shelf. In the browser, valid Silver/XS landed in the existing cart under its own UUID; quantity and empty-bag actions stayed intact.

### 26. Advisory totals, coupons and fulfilment
Subtotal, promotions, coupon precheck, configured zone fee, minimum, delivery/pickup and displayed total use the shared preview and loading indication. They remain explicitly **advisory** until authoritative placement. Checkout validates contact/address/zone/stock, keeps the selected fulfilment and payment current, and guards double submission; no new pricing, coupon, inventory or reservation algorithm was added here.

### 27. COD checkout
The registered V2 DOM journey and rendered browser journey placed **demo-only** COD orders through the shared cart/repository, with one authoritative demo snapshot, correct exact-SKU items, pending order state and unpaid COD payment. No production order, staff action or new backend endpoint was exercised.

### 28. InstaPay selection
The existing configured InstaPay choice and merchant instructions remain available where enabled. Chromium's canonical cutover flow placed a demo InstaPay order and confirmed `verification_required`; the UI did not claim paid/settled at placement or on the receipt. Real bank settlement and staff verification were deliberately not simulated as frontend capabilities.

### 29. Transfer proof and human verification
The shared `PaymentProofPanel` still accepts a transfer reference/image and submits to the existing order path. The canonical Chromium check observed proof data saved while payment **remained `verification_required`**. The panel was kept as B; it is not a dead legacy component and no automatic proof approval was introduced.

### 30. Confirmation truth and refresh privacy
The V2 receipt uses the placed order/lookup snapshot for reference, line/SKU, fulfilment, payment and totals, not a product-page recomputation. A short-lived same-tab session pair (reference, phone, timestamp; **not** order body) permits re-query after refresh; another tab without it receives a private/track prompt. The receipt URL does not carry the phone or payment proof.

### 31. Reference-plus-phone tracking
A reference alone does not reveal an order. The lookup requires the matching phone off-URL, reports genuine not-found/loading states, and displays only repository-returned item, status and timeline data. The preview redirect keeps only the shareable reference; DOM and real Chromium checked forged-phone stripping, reload and private lookup.

### 32. Browser-local shopper account
Profile, addresses, wishlist and remembered references use the existing shopper account provider/repository. This is **browser-local** convenience, not staff Supabase Auth or verified cross-device customer identity. Guest and signed-in paths and fresh-profile empty history were exercised; existing auth architecture was not changed.

### 33. History, wishlist and reorder
History re-reads remembered references with the required phone; wishlist cards still draw from published catalogue entries. `planV2Reorder()` admits a valid stock-tracked simple item and an exact active variant, checks holds/current-cart totals and rejects stale/foreign/inactive/untracked/sold-out lines without substituting another UUID. Reorder waits for catalogue loading to finish.

### 34. Partial reorder feedback
In a mixed old order, only still-valid original lines enter the shared cart. EN and AR show the unavailable item's name/SKU, partial-success notice and a bag link after cart state commits; a removed variant is not quietly replaced by the same size in another colour. The real-browser journey exercised this in both languages.

### 35. About and Contact
About uses saved bilingual merchant content and an intentional optional-content fallback. Contact uses configured details, zones, validated WhatsApp composition and safe social destinations; without WhatsApp it does **not** imply a fictional onsite inbox. The seven-route journey matrix includes both pages with saved-content checks.

### 36. Saved design and Admin Studio
The V2 Studio edits a draft, previews it inertly in Admin, saves through the existing settings path, then reloads the canonical shop. Chromium checked logo/media, colours, contrast adaptation, button/badge shapes, ticker direction/focus/reduced motion and one/two mobile columns without changing the POS palette or order data. Admin draft geometry was checked at **all 13 release widths**; the public configured matrix passed **52/52** home/catalogue, **26/26** exact variant and **12/12** two-column phone cases.

### 37. Social channels and WhatsApp
Shared settings own enabled profile links and language-specific WhatsApp prefill. Admin rejects an unsafe profile without partial publication; the public footer emits safe, labelled SVG links with proper external-link attributes and 44px targets, one contact action, contrast-aware light/dark styling and no duplicate floating action. Browser check passed **26/26** dark-footer EN/AR width cases and inspected configured light-footers, enable/disable reload and POS/Contact isolation.

### 38. EN/AR, RTL and requested width coverage
Every **requested width** was exercised in real Chromium: **320, 360, 375, 390, 414, 430, 768, 820, 1024, 1280, 1366, 1440, 1920 px**. Public and seven-journey matrices also cover **600, 900 and 1728** (16 widths × 2 languages); Studio/social cover all 13 requested widths. This explicitly corrects Phase 4A's erroneous description of its then-14-width list as a superset: **820 and 1366 were missing there**, and have now actually been tested. RTL direction, headings, footer reachability and clipped/overflow bounds were checked at the listed widths.

### 39. Readable Arabic font and practical accessibility
Screenshot review initially exposed an **environment-only** false pass: minimal serverless Fontconfig drew *no Arabic glyphs* despite DOM and RTL assertions. The final runs used the host's installed system fonts and added `scripts/lib/rendered-arabic-font.mjs`, a canvas-ink guard that rejects that broken setup (0 painted pixels) and accepts visible Arabic. Final Arabic screenshots were re-reviewed (phone checkout, home and social footer); English home and Admin draft were also reviewed. Checked skip-to-main focus/hash safety, named controls, disabled sold-out options, dialog/drawer Escape/focus, status/alert roles, touch targets and reduced motion. This is **not** a formal WCAG or assistive-technology certification.

### 40. Empty, loading and recoverable errors
Chromium checked catalogue loading skeleton, zero results/clear filters, empty cart/browse link, empty local history, required tracking phone, disabled pending lookup, private not-found state and stale-bag notice; DOM flows cover checkout validation and partial reorder feedback. Implemented retry affordances do not amount to a simulated production service outage. No known critical local journey failure remained.

### 41. Canonical metadata and private exclusions
Client-rendered home/catalogue/published PDP/About/Contact set appropriate browser `index, follow`, canonical `#/store/*` links and applicable title/description/Open Graph/structured data. Cart, checkout, receipt, tracking, account and missing products use `noindex, nofollow`. Leaving the shop clears public metadata/JSON-LD; the rendered cutover suite verified POS head isolation.

### 42. SEO/host honesty
Admin can **download** sitemap/robots text containing public pages and published products, but `public/` and `dist/` contain **no deployed `sitemap.xml` or `robots.txt`**. HashRouter and client-side head mutation in a single-file SPA are weak crawler targets; the static initial HTML has only generic metadata. No SSR, prerender, host routing, deployed SEO asset, indexing guarantee, crawler certification or production performance assertion is made.

## Fresh validation and release decision

### 43. Logic and canonical DOM
After restoring lockfile dependencies with `npm ci`, `npm test` passed **48/48 logic suites**, including shared online **99/99**, V2 journey **9/9**, V2 logic/route **11/11** and social **9/9**. The registered canonical DOM suites passed their **28** V2 shop, **21** Studio, **20** social, **29** journey and **26** cutover checks. `node scripts/storefront-v2-dependency.audit.mjs` passed after isolation on the same locked install.

### 44. Full E2E, rollback honesty and POS/Admin
`npm run test:e2e` passed **26/26 registered suites** *after* `npm ci`: **16** against the actual shipped canonical app and **10** against the explicitly test-only legacy rollback projection. The latter validate retained source; they are not proof that old markup still exists on a public URL. POS, layouts, navigation, authenticated Admin edit/save/permissions, existing payment/return/order and report regressions passed; the report suite uses an isolated in-memory database, **not** the production database.

### 45. Built-app Chromium acceptance
On the final single-file Vite build (local preview, no remote backend), the **font-guarded** rerun passed **96/96** EN/AR home/catalogue/PDP viewport cases, **32/32** exact variants, **224/224** populated seven-journey route cases, Studio **52/52 + 26/26 + 12/12**, social **26/26**, and cutover **10/10** groups. Additional flows covered actual demo COD and InstaPay proof status, confirmation refresh/tab privacy, wrong-phone tracking, partial reorder, media, keyboard and empty/error states. Each rendered suite collected and rejected browser page/console/same-origin HTTP errors; representative screenshots are under Git-ignored `coverage/visual-v2*` and were sampled, **not** exhaustively visually certified. Chromium 153 was installed for QA outside Git; no browser package was added to `package.json` or the lockfile.

### 46. Static gate, isolation, remaining limits and decision
Final locked `npm run typecheck` and `npm run build` passed (**474 transformed modules**, single-file `dist/index.html`); `npm run lint` passed with **0 errors / 32 warnings**, *not* warning-free; `git diff --check` passed. A local `0.0.0.0` Vite preview served HTTP 200; it is not production. SQL remains the pre-existing modified/untracked pair in point 2 and is outside this gate. No backend/migration/frontend deployment, live anonymous Supabase checkout, bank confirmation, host-level SEO deployment, real-customer order, production load or formal accessibility review occurred. **All requested local source-boundary, functionality and release-candidate gates passed; remaining qualifications are deployment/live-environment work, not a failed local gate.**

STOREFRONT V2 LOCAL RELEASE CANDIDATE: READY

PHASE 4B STATUS: COMPLETE
