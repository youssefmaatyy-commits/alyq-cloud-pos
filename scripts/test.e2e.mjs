#!/usr/bin/env node
/**
 * End-to-end runner — builds the real application bundle once and drives it in
 * jsdom through both DOM suites.
 *
 *   node scripts/test.e2e.mjs               # every suite
 *   node scripts/test.e2e.mjs smoke         # only scripts/smoke.dom.mjs
 *   node scripts/test.e2e.mjs auth          # only scripts/auth.flow.mjs
 *   node scripts/test.e2e.mjs store         # only scripts/store.flow.mjs
 *   node scripts/test.e2e.mjs crash         # only scripts/crash.flow.mjs
 *   node scripts/test.e2e.mjs reports       # only scripts/reports.aggregates.mjs
 *
 * Each suite imports the bundle from the OS temp dir (os.tmpdir()), so the build step here
 * is what the header comments of those files describe by hand. The exception is
  * `crash`, which bundles `scripts/lib/crash-entry.ts` to its own temp file
 * because it needs a component that throws on demand and the app has none, and
  * `reports`, which bundles `scripts/lib/reportAggregates-entry.ts` to its own temp file because
  * it compares the database's aggregates against the shipped builder functions rather than
  * against a rendered screen.
 * Exit code 1 if a suite fails. Exits 2 without a bundle when esbuild is unavailable.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { DEFAULT_BUNDLE, LEGACY_ROLLBACK_BUNDLE, buildAppBundle } from "./lib/app-bundle.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BUNDLE = DEFAULT_BUNDLE;
const FILTERS = process.argv.slice(2).filter((a) => !a.startsWith("-"));
// These historical suites assert the retained legacy UI's markup and theming.
// Exercise that rollback source in an ephemeral test-only bundle; do not expose
// a legacy URL or localStorage switch in the public application. Every other
// suite, including canonical shopping/checkout, runs on the shipped route tree.
const LEGACY_ROLLBACK_SUITES = new Set(["store", "lifecycle", "storefront", "promotions",
  "dashboardux", "final", "theme", "storepolish", "dangerzone", "visualaudit"]);

const SUITES = [
  { id: "smoke", file: "scripts/smoke.dom.mjs", title: "DOM smoke (products, inventory, POS, returns, shifts)" },
  { id: "auth", file: "scripts/auth.flow.mjs", title: "Authentication acceptance flow" },
  { id: "store", file: "scripts/store.flow.mjs", title: "Storefront → POS flow (browse, checkout, approve, verify, cancel)" },
  {
    id: "lifecycle",
    file: "scripts/lifecycle.flow.mjs",
    title: "Product lifecycle (unused delete, referenced block, archive → hidden, reactivate, audit)",
  },
  {
    id: "variants",
    file: "scripts/variants.flow.mjs",
    title: "Variant Test Ring (generate, balanced enable, per-shelf sale + refusal, breakdown, disable block)",
  },
  {
    id: "categories",
    file: "scripts/categories.flow.mjs",
    title: "Category lifecycle (empty delete, blocked delete w/ count, archive → hidden, reactivate, atomic move+delete, archived destination refused)",
  },
  {
    id: "storefront",
    file: "scripts/storefront.flow.mjs",
    title: "Storefront customization (Phase 45): builder → live shop window, AR/RTL, variant ring sells, checkout copy",
  },
  {
    id: "promotions",
    file: "scripts/promotions.flow.mjs",
    title: "Promotions (Parts 9–11, 19–23): zones, automatic discounts, promo codes, discounted returns",
  },
  { id: "backup", file: "scripts/backup.flow.mjs", title: "Backup & recovery flow (snapshot, download, health, schedule, restore, permissions)" },
  {
    id: "dashboardux",
    file: "scripts/dashboardux.flow.mjs",
    title: "Dashboard / Admin UX (Phase 46): KPI routing, website split, variant-aware alerts, mobile drawer, RTL, permissions",
  },
  {
    id: "final",
    file: "scripts/final.flow.mjs",
    title: "Final integrated flow (Phase 48): login → shift → customer → variant ring → POS → return → storefront → delivery/COD/InstaPay → settle → category → KPIs → reports → Danger Zone preview → permissions → audit",
  },
  {
    id: "theme",
    file: "scripts/theme.flow.mjs",
    title: "Saved storefront theme (admin preview, invalid hex rejection, public routes, POS isolation)",
  },
  {
    id: "storepolish",
    file: "scripts/storepolish.flow.mjs",
    title: "Storefront polish (Phase 49): gold-on-ivory palette, hero CTAs + fallback, slim header, editorial rhythm, quiet quick-add, Phase 43 variant proof, cart/checkout hierarchy, RTL, footer",
  },
  {
    id: "storefront-v2",
    file: "scripts/storefront-v2.flow.mjs",
    title: "Storefront V2 Phase 1 regressions on canonical routes: configured content, exact variants, cart, AR/RTL",
  },
  {
    id: "storefront-bootstrap",
    file: "scripts/storefront-bootstrap.flow.mjs",
    title: "Storefront V2 refresh & bootstrap flash defense (neutral shield, safe cache, atomic paint)",
  },
  {
    id: "v2-studio",
    file: "scripts/storefront-v2-studio.flow.mjs",
    title: "Storefront V2 Phase 2 regressions: Admin draft/save/reload, scoped reset, ticker, RTL, canonical shop and POS",
  },
  {
    id: "v2-social",
    file: "scripts/storefront-v2-social.flow.mjs",
    title: "Storefront V2 Phase 2 social regressions: shared Admin save/reload, safe links, RTL, canonical shop and POS",
  },
  {
    id: "v2-journey",
    file: "scripts/storefront-v2-journey.flow.mjs",
    title: "Storefront V2 Phase 3: exact-variant bag, COD/InstaPay, private tracking, browser account and safe reorder",
  },
  {
    id: "v2-cutover",
    file: "scripts/storefront-v2-cutover.flow.mjs",
    title: "Storefront V2 Phase 4A: canonical public routing, metadata, saved links, safe preview redirects and POS isolation",
  },
  {
    id: "nav",
    file: "scripts/nav.flow.mjs",
    title: "Admin navigation (Phase 49): six primary areas, grouped settings, module homes, breadcrumbs, deep links, permissions, Arabic drawer",
  },
  {
    id: "sidebar",
    file: "scripts/sidebar.flow.mjs",
    title: "Sidebar collapse/expand bug fix: collapse, expand after collapse, repeated toggling, active item + route preserved, no reload, RTL/LTR",
  },
  {
    id: "dangerzone",
    file: "scripts/dangerzone.flow.mjs",
    title: "Danger Zone (Phase 47): admin-only cards, wizard gates, preview, re-auth, phrase, operational clear, factory reset, audit survival",
  },
  {
    id: "branding",
    file: "scripts/branding.flow.mjs",
    title: "Branding (Phase 46): one shared source — set/save, live sidebar, dashboard, receipt logo, login, ALYQ fallback, cashier refused",
  },
  {
    id: "visualaudit",
    file: "scripts/visualaudit.flow.mjs",
    title: "Visual-consistency audit (Phase 46): 13 screens — page standard, shared tokens, RTL mirror, per-screen identity",
  },
  {
    id: "posux",
    file: "scripts/posux.flow.mjs",
    title: "POS UX (Phase 46): scan/search register, keyboard-first, exact-shelf picker, third-refusal, separate lines, receipt variants, barcode scan",
  },
  {
    id: "poslayout",
    file: "scripts/poslayout.flow.mjs",
    title: "POS scan/search workspace: no grid, capped results, exact-code adds, stable checkout and RTL",
  },
  { id: "crash", file: "scripts/crash.flow.mjs", title: "Crash recovery (ErrorBoundary: the screen, no leaked detail, the sibling survives)" },
  {
    id: "authprovider",
    file: "scripts/authProvider.live.flow.mjs",
    title: "AuthProvider live-mode request lifecycle (Task 10): nav no-refresh, deduped resume, in-flight dedup, sign-in/out races, role/branch freshness",
  },
  {
    id: "reports",
    file: "scripts/reports.aggregates.mjs",
    title: "Report aggregates — PostgreSQL vs the shipped builders over 2,500 invoices",
  },
  {
    id: "import",
    file: "scripts/import.flow.mjs",
    title: "Master Excel Import Center (all-or-nothing, templates, branch stock, error reports)",
  },
  {
    id: "export",
    file: "scripts/export.flow.mjs",
    title: "Universal Data Export Center (multi-domain, multi-sheet full business export, formula defense)",
  },
  {
    id: "android-pos",
    file: "scripts/android-pos.flow.mjs",
    title: "Android Full POS Mobile UX (native /dashboard entry, 24 modules sheet, camera barcode scanner, mobile cart checkout, ALYQAndroidPrint)",
  },
];

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
};

try {
  await import("esbuild");
} catch {
  console.error(c.red("✗ esbuild is not installed. Run `npm install` first."));
  process.exit(2);
}

const selected = SUITES.filter((s) => FILTERS.length === 0 || FILTERS.includes(s.id));
if (selected.length === 0) {
  console.error(c.red(`✗ no suite matched ${FILTERS.join(", ")} (try: smoke, auth, store, backup, crash, reports)`));
  process.exit(1);
}

// ── build ─────────────────────────────────────────────────────────────────
// `scripts/lib/app-bundle.mjs` owns the esbuild options so this runner and the
// logic runner cannot drift apart again:
//   - `import.meta.env` is inlined — the app reads it at module scope.
//   - `.css` is empty — Tailwind's entry is not needed to exercise behaviour.
//   - image imports (`@/assets/alyq-logo.png`) are mocked to the public URL the
//     receipts document and assert. Plain esbuild has no `.png` loader, so
//     without the plugin the build dies before any suite runs; `dataurl` builds
//     but replaces `/alyq-logo.png` with base64, which the receipt assertions
//     in `scripts/smoke.dom.mjs` can never match.
// The bundle is rebuilt every run so the suites can never test stale code.
console.log(c.bold("\nBuilding application bundle…"));
let bytes;
try {
  ({ bytes } = await buildAppBundle({ outfile: BUNDLE }));
} catch (error) {
  console.error(c.red("✗ bundling failed"));
  for (const e of error?.errors ?? []) console.error(c.dim(`  ${e.text}`));
  if (!error?.errors) console.error(c.dim(`  ${String(error)}`));
  process.exit(1);
}
console.log(c.dim(`  ${BUNDLE} (${(bytes / 1024).toFixed(0)} kB)`));
if (selected.some((suite) => LEGACY_ROLLBACK_SUITES.has(suite.id))) {
  try {
    const legacy = await buildAppBundle({ outfile: LEGACY_ROLLBACK_BUNDLE, legacyRollback: true });
    console.log(c.dim(`  ${LEGACY_ROLLBACK_BUNDLE} (${(legacy.bytes / 1024).toFixed(0)} kB) — test-only legacy rollback`));
  } catch (error) {
    console.error(c.red(`✗ legacy rollback test bundle failed: ${error}`));
    process.exit(1);
  }
}
console.log();

// ── run ───────────────────────────────────────────────────────────────────
const results = [];

for (const suite of selected) {
  console.log(c.bold(`▶ ${suite.title}${LEGACY_ROLLBACK_SUITES.has(suite.id) ? " [test-only legacy rollback bundle]" : ""}`));
  const run = spawnSync(process.execPath, [path.join(ROOT, suite.file)], {
    stdio: "inherit",
    cwd: ROOT,
    env: { ...process.env, ALYQ_TEST_BUNDLE: LEGACY_ROLLBACK_SUITES.has(suite.id)
      ? LEGACY_ROLLBACK_BUNDLE : BUNDLE },
  });
  const ok = run.status === 0;
  results.push({ ...suite, ok });
  console.log(ok ? c.green(`  ✓ ${suite.id} passed\n`) : c.red(`  ✗ ${suite.id} exited ${run.status}\n`));
}

const failed = results.filter((r) => !r.ok);
if (failed.length === 0) {
  console.log(c.bold(c.green(`✓ ${results.length}/${results.length} E2E suites passed\n`)));
  process.exit(0);
}

console.log(c.bold(c.red(`✗ ${failed.length}/${results.length} E2E suites failed\n`)));
for (const f of failed) console.log(`${c.red("•")} ${f.id} — ${f.title}`);
console.log();
process.exit(1);
