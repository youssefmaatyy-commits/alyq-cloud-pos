# Storefront V2 — Phase 4A: canonical cutover and final local QA

Local acceptance record · 2026-09-25 (Africa/Cairo) · branch `arena/01a0ce43-alyq-cloud-pos` · builds and browser checks in **demo mode**. This is a route/presentation cutover in the working tree, **not** a production deployment or live-payment certification. The Phase 3 baseline is `docs/STOREFRONT_V2_PHASE_3.md`; the results below were run again for this phase.

## Pre-cutover decision and change boundary

### 1. Phase 4A decision and scope
The fresh pre-cutover gate passed before the canonical routes were edited, so V2 was promoted to the public `#/store` presentation. The work changes the route selection, public links, metadata, the downloadable sitemap and related tests. It does **not** start Phase 4B, change order authority, alter a database/backend, or deploy a site.

### 2. Initial worktree, attribution and SQL stop line
The checkout was already substantially dirty, including `supabase/tests/scenarios.sql` (modified) and `supabase/migrations/0061_last_active_variant_guard.sql` (untracked). Their authorship is **C — unprovable from local evidence**; neither was edited, deleted, applied, deployed or used to justify an unrelated rewrite. The tracked/untracked prior work, including Phase 1–3 V2 source, was preserved. No SQL migration, RLS/RPC, Edge Function or production database change was made for Phase 4A.

### 3. Architecture preflight
`src/App.tsx` previously mounted independent legacy canonical and V2 preview page trees. `StorefrontApp.tsx` selected its shell from the pathname but already wrapped both trees in **one** `StorefrontProvider → StoreAccountProvider → StoreCartProvider` chain. The preflight also audited configured links, V2 header/drawer/footer and social destinations, page metadata, the Admin saved-design link, route-sensitive test suites and the Phase 3 report.

### 4. Pre-cutover static gate
Before **any** route edit: `npm run typecheck` passed; `npm run build` passed (**484 modules**); `git diff --check` passed. This result belongs to the old route topology and is recorded separately from the final post-cutover build.

### 5. Pre-cutover focused logic gate
`node scripts/test.logic.mjs src/modules/online/v2` passed **3/3 suites**: journey **9/9**, V2 logic **10/10**, social safety **9/9**. The later Phase 4A route adapter adds one V2 logic assertion group; the pre-cutover **10/10** is not retroactively reported as **11/11**.

### 6. Pre-cutover rendered-DOM gate
`node scripts/test.e2e.mjs storefront-v2 v2-studio v2-social v2-journey` passed **4/4 suites** before the cutover. This included the critical exact-UUID shopper journey, COD, InstaPay proof status, private tracking, account and Admin/social flows, plus the old preview route integrity. Phase 3's historical Chromium results were background context, not substituted for this fresh gate.

### 7. Gate decision and isolation rule
Only after topics 4–6 passed was the route switch made. The cutover did not touch the cart/account provider implementations, price or stock authority, the online-order repository, payment-verification flow or POS/Admin routing. A critical regression outside routing/presentation would have stopped the switch rather than authorized a backend rewrite; none remained after final QA.

## Public routing and destination audit

### 8. Single canonical public route map
One V2 route tree now owns these public destinations under `src/App.tsx`, inside the unchanged three-provider storefront boundary:

| Canonical hash route | V2 presentation |
|---|---|
| `#/store` | home |
| `#/store/products`, `#/store/products/:key` | catalogue; product by slug **or** ID |
| `#/store/cart`, `#/store/checkout`, `#/store/confirmation` | bag; checkout; receipt |
| `#/store/track`, `#/store/account` | private lookup; shopper account |
| `#/store/about`, `#/store/contact` | merchant information and contact |

There is no second V2 page tree at `v2/*`; that route has only a redirect element.

### 9. Former preview-URL compatibility
`#/store/v2` and each known former preview destination redirect with React Router `replace` to its matching canonical route. Product IDs/slugs are kept as path segments; known catalogue filters, the tracking **reference**, and an allowed account tab survive. A real Chromium back-navigation check verified the redirect does not trap the shopper in a preview loop. There is no live legacy/debug customer route.

### 10. Query, identifier and privacy policy
`canonicalStorePathname` preserves the encoded product path rather than guessing another SKU or variant. `canonicalPreviewSearch` allowlists catalogue keys (`q`, category/brand/colour/size/price/sort/availability/offer), `track?number=…` and valid `account?tab=…`; it drops other preview query fields, notably `phone` and `token`, as well as old fragment data. Configured saved preview links use the same normalization after existing URL validation. Tests cover slug/ID links, filters and the stripping of a forged tracking phone; query state is **not** payment or order authority.

### 11. Unknown routes and missing products
Unknown former-preview and unknown canonical shop paths return to `#/store` without exposing a legacy presentation. A well-formed but unpublished/unknown `#/store/products/:key` stays on a V2 not-found page, carries `noindex, nofollow`, and does not show an order. Canonical deep links, reloads and not-found behavior passed in jsdom and Chromium.

### 12. Provider and backend-authority ownership
`StorefrontApp.tsx` now renders `StorefrontV2Shell` around the same `<Outlet />` and the same provider chain. V2 cards, bag, checkout, account and private order details still delegate to shared providers/repositories; no second cart, shopper identity, pricing engine or placement path was added. The browser's calculated total and coupon preview remain advisory; the existing order placement contract remains authoritative.

### 13. Retained legacy source
`StoreLayout`, all legacy storefront pages, components, CSS and shared helpers remain physically present for rollback/regression tests. They are **not** mounted at a new customer-facing debug URL. The route/shell selection in `src/App.tsx` and `src/modules/online/StorefrontApp.tsx` is the principal rollback boundary; no destructive dead-code cleanup was performed.

### 14. Normal V2 internal links
The home CTAs, product cards, breadcrumbs, catalogue facets, PDP actions, bag/checkout/receipt/tracking/account links, mobile drawer, header, footer, information links and social-contact actions now target canonical `#/store/*` destinations. A source audit found no production V2 link still hard-coded to `#/store/v2`; the compatibility prefix remains only in the route adapter. Configured catalogue searches use the existing URL-backed parser.

### 15. Stored merchant links and policies
`v2Href()` no longer rewrites saved canonical `#/store/*` links into a preview route. It validates links through existing `configuredHref`, normalizes saved former-preview links and leaves approved external destinations alone. Unknown configured policy destinations do **not** gain invented policy pages: they retain the validated URL and otherwise follow the canonical shop's safe fallback. No merchant settings row is mutated merely by following a link.

### 16. Admin public design entry
The Admin V2 Studio's **Open saved V2** action now uses `#/store` both in its anchor and new-window/fallback behavior. The inert draft preview remains inside the Admin form and is not mislabeled as the public page; its test ID was retained to avoid breaking editor selectors. Admin save/reload/reset and permission tests were rerun; a cashier remains unable to enter the V2 editor.

## Customer journey and design coverage

### 17. Canonical homepage
The V2 home reads the shared merchant hero, slides, categories, campaigns, product rails, trust/editorial sections, announcements and content; it does not substitute bundled stock photography for configured catalogue assets. Its public CTAs go to canonical routes, it now exposes an indexable shop title/description/canonical URL and real `Store` JSON-LD, and its saved appearance remains scoped to the V2 shell.

### 18. Canonical catalogue and filters
Search, category, brand, colour, numeric/letter size, prices, availability, offer and sorting remain URL-backed over the published catalogue. Former-preview URLs preserve known safe filter values, and a real browser reload retained `q`, `sort`, `color` and `size_label`. The mobile filter dialog, empty/clear state, sold-out combinations and no horizontal overflow were checked; filters do not invent stock or a variant.

### 19. Canonical product detail and exact variants
The PDP resolves either the product ID or its saved slug and publishes a canonical **slug-or-ID** metadata URL. Gold/17, sold-out Gold/18, Silver/XS and a fractional shelf were checked in isolated demo fixtures; cart/order lines preserve the chosen **variant UUID**, not an inferred colour/size substitute. Rendered gallery, size-guide, lightbox keyboard behavior, current media, price and availability were exercised in Chromium.

### 20. Bag identity and advisory totals
V2 bag links now stay at `#/store/cart`; its lines still use the existing cart provider, product ID and exact variant UUID. Increase, decrease, remove, clear, stale-line pruning, unavailable-stock messaging, coupons and advisory delivery/total display were exercised. Nothing in the route change silently replaces an unavailable historical variant or turns a browser total into a charge.

### 21. COD checkout and authoritative placement
Canonical COD pickup/delivery checks covered required contact fields, saved address/zone selection, a settled advisory estimate and the existing placement repository. The order snapshot and cart retained the exact requested shelf. Chromium placed a real **demo-mode** COD order through the canonical routes and restored its private receipt after reload; this does not prove a live Supabase order.

### 22. InstaPay and proof status
The same canonical checkout offers configured InstaPay instructions and still uses the shared authoritative placement path. A jsdom journey and a separate real-Chromium journey placed an InstaPay **demo-mode** order, uploaded a proof and confirmed `payment_status === "verification_required"` after submission. Proof is evidence for a human review, **not** an automatic paid/verified claim; no payment backend was changed.

### 23. Confirmation and receipt privacy
`#/store/confirmation` is noindex and reads the shared placement result or a short-lived same-tab **reference-plus-phone** pair. It does not persist the full order object as a browser receipt. Chromium verified a refresh restores only the matching receipt and a different tab cannot reveal it; an empty/direct confirmation shows the private fallback.

### 24. Reference-plus-phone tracking
`#/store/track?number=…` may carry a shareable order reference but never puts the customer's phone into the URL. A blank or incorrect phone exposes no order; a correct pair reads the authoritative timeline/status through the existing lookup. Old preview tracking bookmarks strip forged `phone`/`token` query values. Tracking and its missing/error states remain noindex.

### 25. Shopper account, wishlist, history and reorder
The browser-local account still uses `StoreAccountProvider` for profile, addresses, wishlist and private history; an order is read by the established private lookup. Reorder accepts only currently published exact UUIDs, warns about missing/sold-out/foreign shelves and preserves a valid partial reorder without navigating away from its warning. Chromium and DOM checked sign-up/history/partial reorder in EN and AR. This is local demo evidence, not a multi-device account certification.

### 26. About and Contact
Configured bilingual About content, canonical About links and Contact details render in the V2 shell. Contact uses valid phone/email/map destinations and the existing WhatsApp action rather than inventing a web inbox. Both pages are public/indexable; an About CTA and Contact/social destination still pass the existing configured-link safety rules.

### 27. Social channels and WhatsApp
The single shared WebsiteSettings social owner governs Facebook, Instagram, TikTok and WhatsApp; invalid schemes/hosts, local-only WhatsApp numbers and disabled channels fail closed. English and Arabic prefill is URL-encoded and external links are labeled `noopener noreferrer` new-tab actions. Admin draft icons stay inert; rendered dark/light footer checks covered enabled/disabled channels and no overflow. No new social data source was added.

### 28. Saved V2 customization
Admin's saved V2 colours, logos, columns, media aspect, section visibility, ticker and reduced-motion behavior reached the canonical public pages after reload. The legacy theme values remain separately stored, and V2 variables are scoped to `.store-v2`, not the document or POS. Both one- and two-column mobile choices and a deliberate low-contrast palette were exercised; reset affects only the V2 draft until the existing Save action.

## SEO, accessibility and fresh post-cutover QA

### 29. Language, direction and viewport matrix
EN/LTR and AR/RTL were exercised on all canonical journeys. The broad public/browser matrix used **14 widths**, a superset of the 13 requested targets: **320, 360, 375, 390, 414, 430, 600, 768, 900, 1024, 1280, 1440, 1728, 1920 px**. Header, centred wordmark, columns, real media, page/body width, heading bounds and reachable footer were checked; the sampled cases did not scroll horizontally or clip their content.

### 30. Practical accessibility, not certification
Checked one main landmark and meaningful headings; named search and tracking fields; image alt text; skip-link focus without corrupting HashRouter; drawer/filter Escape and focus return; lightbox keyboard behavior; disabled sold-out actions; alert/status roles; contrast adaptation and reduced-motion ticker. This is targeted practical QA, **not** an automated WCAG audit, assistive-technology study or formal accessibility certification.

### 31. Public metadata after promotion
Home, catalogue, published PDP, About and Contact no longer use preview-only `noindex`; the browser sees `index, follow`. Home/catalogue/PDP/About/Contact now name the canonical `#/store/*` URL, with per-product SEO copy, Open Graph fields and existing client-side structured data where available. Catalogue filters canonicalize to the base collection; canonical product metadata uses the published slug or ID rather than the preview prefix.

### 32. Private metadata and sitemap/robots honesty
Bag, checkout, confirmation, tracking, account and missing products stay `noindex, nofollow`; leaving the shop cleans up its meta/JSON-LD so POS is not branded as a product. The **downloadable** sitemap was aligned with indexable routes: home, products, About, Contact and published products; private cart/track pages were removed. The existing browser-generated sitemap/robots downloads are **not hosted** `sitemap.xml`/`robots.txt` endpoints. Hash routes and client rendering are weak crawler targets: no SSR, deployed sitemap, deployed robots file or reliable search indexing is claimed.

### 33. Logic and focused DOM after cutover
The final `npm test` passed **48/48 logic suites**; V2-focused logic passed journey **9/9**, route/appearance logic **11/11**, social **9/9**, and shared online logic **99/99**. The canonical DOM suites exercised **28** Phase 1 assertions, **21** Studio assertions, **20** social assertions, **29** shopping/identity assertions and **26** new cutover/compatibility assertions. The new DOM suite covers all ten canonical pages, public/private metadata, sensitive preview-query stripping, Admin link and POS isolation.

### 34. Registered E2E and honest legacy regression harness
`npm run test:e2e` passed **26/26 registered suites** on the final route code. **16** run the shipped canonical application bundle, including the five V2 suites (`storefront-v2`, `v2-studio`, `v2-social`, `v2-journey`, `v2-cutover`); **10** historical suites still assert retired legacy markup and run against a **separate test-only esbuild rollback projection**. The projection injects the retained old routes/shell into an ephemeral jsdom bundle and is never built into the shipped app; the legacy `store` suite also boots the *actual canonical bundle* separately to test forged social settings. Thus the pass does not misrepresent old DOM assertions as tests of the live V2 layout. The registered reports suite uses an isolated in-memory test database, not the production DB.

### 35. Chromium public and journey matrices
On the built static app, `rendered-v2.flow.mjs` passed **84/84** home/catalogue/PDP viewport-language cases and **28/28** exact-variant PDP cases. `rendered-v2-journey.flow.mjs` passed **196/196** cases for seven populated routes (bag, checkout, confirmation, tracking, account, About, Contact), plus COD, private receipt/tracking, fresh empty/error states, exact reorder, stale cart and EN/AR partial-reorder flows. Both matrices were rerun on the final built route code **after** the sensitive-preview-query allowlist was added.

### 36. Chromium Studio, social and cutover probes
The rendered Studio suite passed **40/40** saved home/catalogue configurations, **20/20** configured variant cases and **10/10** two-column mobile checks. The rendered social suite passed **16/16** footer language/width cases with safe profile links and encoded WhatsApp copy. The final `rendered-v2-cutover.flow.mjs` passed **10/10** real-Chromium groups: redirect/back/reload, filter preservation, ID/slug metadata, forged-phone stripping, not-found privacy, canonical InstaPay proof, RTL keyboard use, Admin entry and POS head cleanup. Console/page/same-origin HTTP error collectors were empty. Representative ignored screenshots in `coverage/visual-v2*` were visually reviewed (mobile EN home, AR checkout, desktop About and AR social footer); screenshots are QA artifacts, not a claim of exhaustive visual review.

### 37. Static checks, isolation and remaining limits
Final `npm run typecheck`, `npm run build` (**486 modules**), `npm run lint` and `git diff --check` passed. Lint reports **0 errors and 32 existing worktree warnings**, not a warning-free result. POS/Admin authenticated screens and providers remain outside the customer shell; the V2 design entry alone changed to a canonical link. Checks ran locally in demo repositories and static Vite preview: no live anonymous Supabase read/order, bank settlement, live media outage, production load, real host SEO response or formal accessibility assessment was claimed. The temporary browser QA server was not a production deployment.

### 38. Rollback boundary and *future* Phase 4B recommendation
Rollback is a deliberate **route-level** change: restore the legacy canonical page mappings in `src/App.tsx` and legacy shell selection in `StorefrontApp.tsx`, then reconcile Admin/public-link and SEO expectations with the selected presentation. The retained legacy source and the test-only rollback suites provide evidence without publishing a debug route; no database rollback is required from Phase 4A, and unrelated dirty SQL must not be bundled into one. A separately authorized **future Phase 4B** could plan a monitored production rollout, live Supabase/anonymous/ordering and human payment checks, an actual host-level crawl/robots/sitemap strategy, performance/recovery monitoring and an assistive-technology accessibility review. None of that work was started here; deployment, migration application and GitHub publication remain outside this completed local phase.

PHASE 4A STATUS: COMPLETE
