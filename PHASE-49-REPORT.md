# Phase 49 — Navigation Simplification + Premium Storefront Polish

**Date:** 2026-09-18 · **Base:** `0caa8dd577348fefef47201e8fa626390b4d0da5` (Phase 48 final) · **Type:** UX / IA / visual only

---

## 1. Complete?

**YES — READY.** Both goals delivered: the admin navigation is materially simpler (24 sidebar entries → 9 module doors + 1 storefront shortcut), sub-screens are grouped behind five module landing pages, and the storefront carries the warm-neutral editorial system (gold-on-ivory, slim header, editorial rhythm, quiet quick-add) while every Phase 45 customization control still governs it. All six gates pass; all 18 E2E suites pass; no migration was created; canonical and the hosted Supabase are untouched.

## 2. Base SHA

`0caa8dd577348fefef47201e8fa626390b4d0da5`

## 3. Final HEAD

See §37 (filled at commit time).

## 4. Nav audit — what changed and why it is safe

The sidebar was the sitemap: 24 entries (Products, Categories, Inventory, Movements, Sales, Online Orders, Stock Holds, Customers, Returns, Refunds, Shifts, Shift History, Expenses, Reports, Advanced Reports, Audit, Approvals, Online Reports, Website Settings, Marketing, Website Content, Settings Home, Branding, Users, Roles, Backup). Phase 49 replaces it with the **main modules**, one row each, and moves sub-screens onto module landing pages. **Every old route still exists** — nothing was destroyed, only re-housed. The route guard (`ROUTE_CAPABILITIES`) is unchanged for every pre-existing path; visibility still hides what a role may not open, and typed URLs are still refused by the guard.

## 5. Sidebar IA (final)

Dashboard · POS (`#/pos`) · Sales (`#/sales`, approvals badge) · Catalog (`#/catalog`) · Inventory (`#/inventory`) · Online (`#/online`, pending-orders badge) · Customers (`#/customers`) · Reports (`#/reports`) · Settings (`#/settings`) · ↗ View website (`#/store`, new tab, permission-held). Capabilities: `/sales`→`sell`; `/online`→`manage_online_orders` (website-capability roles see the door; its website cards hide per-card); Settings door renders only for a role holding at least one settings capability. Mobile drawer renders the **same nine doors** (`SidebarNav` is shared) — the long list never returns on mobile.

## 6. Per-module organization

- **Sales home** (`ModuleHomePage`): Invoices, Returns, Refunds, Shifts, Expenses (capability `add_expense`-held), Approvals inbox — each card keeps its own route; `/approvals` keeps its self-guard and stays readable by every signed-in role from the card.
- **Catalog home**: Products, Categories, Product Content, Import/Export (all product-capability held).
- **Inventory home**: Stock overview (`/inventory/stock`), Low stock (`?status=low`), Out of stock (`?status=out`), Movements. `/inventory` became the landing; the stock table moved to `/inventory/stock` **with its `?status=` hydration intact** — dashboard KPI links, Movements back-links and the QA suite all target the new path.
- **Online home**: Online Orders, Stock Holds, Online Reports (`manage_online_orders`) + Website Customization, Campaigns, Website Content, Delivery & Payment (`manage_website`, hidden per-card) — no duplicated website settings; the single editor remains `/online/website`, also reachable from Settings → Online store.
- **Customers**: stays its own hub (list + history only, unchanged).
- **Reports**: stays its own hub (tabs unchanged; Advanced Reports remains a route reached from the hub — its sidebar leaf is gone, its URL untouched).

## 7. Breadcrumbs & deep links

`PageHeader` gained `crumbs?: {label, to?}[]` rendering `data-testid="breadcrumbs"` (last crumb plain text). Applied to: Products, Product detail (Catalog › Products › name), Categories, Stock (`/inventory/stock`), Movements, Invoices, Sale receipt (Sales › Invoices › number), Returns, Refunds detail paths, all six Online pages, Approvals, Approval rules, Users, Roles, Branding, Backup, Audit, Danger Zone, Settings home itself. Deep-link compatibility proven by E2E: `#/products`, `#/pos/sales`, `#/inventory/stock?status=low` (filter hydrates), `#/online/reservations`, `#/settings/backup` redirect-preservation, browser back (room → module home).

## 8. Mobile navigation

The drawer shares `SidebarNav`: nine doors + storefront shortcut, badges included; the long list is gone at every width. Arabic RTL mirrors it (E2E: Arabic door labels لوحة التحكم / الكاشير / المبيعات / الكتالوج / المخزون / أونلاين / العملاء / التقارير / الإعدادات, no stray sub-links).

## 9. Settings Home structure (final, per the specified grouping)

- **General** → Approval rules
- **Users & roles** → Users, Roles
- **Branding** → Branding
- **Online store** → Website settings (`/online/website` — the one website editor)
- **Backup & restore** → Backup
- **Audit log** → Audit trail
- **System** → Danger Zone (last, styled apart)

Every card states its own capability; groups hide whole when empty. One deliberate route-table change: the settings **index** dropped `manage_settings` (the directory must not be wider than its widest room — a manager reading backups/audit could not open the page listing them); `"/settings/approvals"` now states its own `manage_settings` gate explicitly, and every other room keeps its existing gate. `General` holds the workflow thresholds — no fake pages were invented.

## 10–11. Catalog / Online home structure

See §6.

## 12–23. Storefront polish (all settings-driven; zero hardcoded redesign)

- **Palette / theme.ts:** the accent fallback `#f59e0b` (the codebase's only amber) → `#b08d57` antique gold. Verified computed tokens: `--store-accent #b08d57`, `--store-bg #faf7f2`, primary espresso `#1c1917`, surfaces `#fffdfb`. No orange anywhere (E2E scans inline styles for five orange hexes).
- **Presets:** the theme tab gains **three safe enum presets** — ALYQ Ivory (default), Dark, Editorial — each writing only the fields the tab already owns (7 colours, font_stack, button/header style, corner radius, dark flag). No arbitrary CSS, no theme-builder rewrite; Save still gates everything.
- **Hero:** gradient fallback `linear-gradient(140deg, var(--store-secondary), var(--store-primary))` replaces the flat colour field (never orange); the admin's image still dominates when configured (desktop + mobile image paths preserved); new **secondary CTA** ("Our story → /store/about") — three optional fields on `HeroSlide`, normalized + builder-edited + resolved per language; absent fields render nothing (old slides unchanged).
- **Header:** one slim row at every width — desktop nav (categories + Products + About + Contact) left / centred wordmark / search + account + cart (+ language) right; the expanding search row opens at all widths; sticky per admin setting with hairline + blur.
- **Homepage rhythm:** new default section order hero → categories → **newArrivals → editorial** → bestSellers → lookbook → collection → trustStrip → newsletter (rest in shipped order). Stored documents keep their own order (`repairSections` semantics unchanged); the admin can reorder everything.
- **Categories:** default layout `tiles` → `editorial` (image-first aspect-[3/4] tiles with scrim); normalized + still per-section configurable.
- **Product cards / grid:** quick-add changed from a slab of primary colour to a **quiet hairline button that fills on hover** (sold-out still visibly disabled); grid stays 2-col mobile; variant behavior untouched (Phase 43 exact).
- **PDP / cart / checkout:** PDP untouched structurally (sticky buy panel, accordions); cart lines show variant label, media slot, stepper, remove, subtotal; checkout hierarchy verified in order (Contact → fulfilment → Payment → Order summary) with delivery/pickup/COD/InstaPay — **zero logic changes**.
- **Footer:** brand / shop / information columns + delivery-payment summary + copyright; the **newsletter band is the admin's switch** — E2E enables it through the builder UI and proves it renders above the columns; external links rel-safe.
- **RTL/mobile:** storefront RTL mirror per screen (visual audit); grid 2-col at 375/390/430 verified structurally (jsdom computes no layout; the responsive classes and overflow-safe containers are asserted, and screens were reviewed at 375/390/430 during development).

## 24. Customization-center compatibility

Nothing bypasses Phase 45: presets are enums over existing fields; the hero second CTA, categories default layout and homepage default order are all defaults the builder already exposes (layout per section, section order/visibility/titles, hero slides); footer newsletter stays the builder switch. The storefront customization suite (builder → live shop) passes unchanged.

## 25. Migration

**None.** All changes are presentation/route-structure; no persistence requirement. 0043–0048 untouched; hosted Supabase stays through 0043.

## 26. Six gates (all on the final tree)

| Gate | Result |
|---|---|
| `npm run typecheck` | PASS |
| `npm test` | PASS — 35/35 suites, 0 failures |
| `npm run db:check` | PASS — 48 migrations clean/idempotent |
| `npm run test:e2e` | PASS — **18/18 suites** |
| `npm run build` | PASS (6.1s) |
| `npm run lint` | PASS — 0 errors (33 warnings, pre-existing style notes) |

## 27. Regression results (explicit)

Variants ✓ (variants.flow + storepolish Phase-43 proof: nothing preselected, Gold/17=2 selectable, qty-3 refused — stepper capped at shelf, Silver/17=2 own line) · Categories ✓ · Storefront customization ✓ (storefront.flow) · Store checkout ✓ (store.flow incl. COD/InstaPick/proof + storepolish hierarchy) · Dashboard UX ✓ (dashboardux incl. `?status=low` hydration at its new path) · POS UX ✓ (posux) · Branding ✓ · Danger Zone ✓ · Backup ✓ · Reports differential ✓ (91 comparisons) · Final integrated flow ✓ (22/22) · **Admin nav E2E ✓ 18/18** · **Storefront polish E2E ✓ 23/23** · Visual audit ✓ (17 admin + 8 storefront screens, RTL each) · smoke/auth/lifecycle/crash/reports ✓.

Three selftests encoded the old UI shape and were updated to the Phase 49 contract (assertion strength kept): `systemQa` sidebar-count bound (now 9–12, orphan check intact), `enforcement` badge-placement regex (badge now on the capability-gated Online module door), online `logic` default-section-order expectation.

## 28. Files changed

47 modified + 4 new: `src/components/layout/ModuleHomePage.tsx`, `src/components/layout/moduleHomes.tsx`, `scripts/nav.flow.mjs` (18 asserts), `scripts/storepolish.flow.mjs` (23 asserts). Key edits: AppShell (nav rewrite), App.tsx (4 module-home routes + `/inventory/stock`), routes.ts, SettingsHomePage, 21 child pages (breadcrumbs), StoreLayout (header), StoreHomePage (hero/rhythm/categories), ProductCard (quiet quick-add), theme.ts, types.ts, settingsDefaults.ts, sections.ts, WebsiteSettingsPage (presets + secondary CTA), dictionary.ts (EN+AR keys), dashboard links, 9 E2E flows re-targeted, test.e2e.mjs (+2 suites).

## 29–36. SHAs, tree, canonical/hosted

Filled below at delivery (§37–38).

## 37. Commit / session / canonical

- Session branch: `arena/01a0b007-alyq-cloud-pos` — implementation commit + this report, pushed to origin only.
- Canonical `arena/01a0a01f-alyq-cloud-pos` (`a96b9f3721f42f1983dcf968ac6b159c01980f1f`): **untouched, not pushed.**
- Hosted Supabase: **untouched** — migrations 0044–0048 remain pending, by design.

## 38. Working tree

Clean after commit; no stash; no force/reset/rebase used (one workspace re-provision this round was recovered by fetch + old-value-guarded `git update-ref` FF, worktree proven byte-identical to `0caa8dd` first).
