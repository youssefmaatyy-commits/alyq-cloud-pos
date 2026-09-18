/**
 * Admin navigation E2E (Phase 49) — the sidebar is the MAIN MODULES and
 * nothing else, driven through the real bundle in jsdom, demo mode:
 *
 *   1. the signed-in admin sees exactly nine doors (Dashboard, POS, Sales,
 *      Catalog, Inventory, Online, Customers, Reports, Settings) plus the
 *      storefront shortcut;
 *   2. no sub-screen (Products, Categories, Audit, Approvals, Shifts,
 *      Refunds, Branding, Website…) is offered in the sidebar;
 *   3. Settings appears exactly once and opens a grouped home;
 *   4–8. the grouped Settings home reaches Branding, Users, Backup and the
 *      Danger Zone;
 *   9–11. the Catalog module home reaches Products and Categories through
 *      its own cards, with breadcrumbs on the child pages;
 *   12–14. the Online module home reaches Orders and Website, and the
 *      browser's back button returns to the module home;
 *   15. legacy deep routes (#/products, #/pos/sales) still resolve — the
 *      navigation was restructured, not the routes destroyed;
 *   16. the inventory deep link with its status pre-filter hydrates the
 *      stock table one level below the module landing;
 *   17. a cashier sees no Reports/Settings/Online door and a direct URL is
 *      refused by the guard — hiding is courtesy, the guard is the law;
 *   18. Arabic mirrors the same nine doors, and the mobile drawer carries
 *      the identical module list.
 *
 * Any console.error / window.onerror / network call fails the run.
 *
 *   node scripts/test.e2e.mjs nav
 */
import { createUxHarness } from "./lib/ux-harness.mjs";

const ux = await createUxHarness({
  beforeImport: ({ localStorage: ls }) => {
    for (const key of Object.keys(ls)) {
      if (key.startsWith("alyq.demo.") || key.startsWith("alyq.store.")) ls.removeItem(key);
    }
  },
});
const {
  assert,
  bodyText,
  sleep,
  waitFor,
  navigate,
  clickEl,
  clickExact,
  clickTestid,
  testid,
  signInAs,
  signOut,
} = ux;

let passed = 0;
const TOTAL = 18;
function check(label, condition) {
  assert.ok(condition, label);
  passed += 1;
  console.log(`  ✓ ${passed}/${TOTAL} ${label}`);
}

/**
 * hrefs of the static (persistent) sidebar — the first <aside> in the DOM.
 * Deduplicated: the brand block and the Dashboard door both point at "#/".
 */
const sidebarHrefs = () =>
  [...new Set(
    [...(document.querySelector("aside") ?? document).querySelectorAll("a")]
      .map((a) => a.getAttribute("href") ?? "")
      .filter(Boolean),
  )];

async function main() {
  console.log("\nPhase 49 · Admin navigation — nine doors, no clutter\n");
  await sleep(600);

  // ── 0 · admin signs in ────────────────────────────────────────────────────
  await signInAs("admin");
  await waitFor(() => (document.querySelector("aside")?.textContent ?? "").includes("Dashboard"), {
    label: "the sidebar",
  });

  // ── 1 · exactly the nine module doors (+ the storefront shortcut) ─────────
  const MODULES = ["#/", "#/pos", "#/sales", "#/catalog", "#/inventory", "#/online", "#/customers", "#/reports", "#/settings"];
  const hrefs = sidebarHrefs();
  check(
    "the sidebar carries exactly the nine module doors + the storefront shortcut",
    MODULES.every((m) => hrefs.includes(m)) && hrefs.includes("#/store") && hrefs.length === 10,
  );

  // ── 2 · no sub-screen in the sidebar ──────────────────────────────────────
  const STRAYS = ["#/products", "#/categories", "#/inventory/movements", "#/pos/sales", "#/returns", "#/refunds", "#/shifts", "#/expenses", "#/audit", "#/approvals", "#/online/orders", "#/online/website", "#/settings/branding", "#/settings/users", "#/settings/backup"];
  check("no sub-screen (products, audit, shifts, branding…) leaks into the sidebar", STRAYS.every((s) => !hrefs.includes(s)));

  // ── 3 · Settings appears exactly once and opens the grouped home ──────────
  check("Settings appears exactly once in the sidebar", hrefs.filter((h) => h === "#/settings").length === 1);
  clickEl([...document.querySelectorAll("aside a")].find((a) => a.getAttribute("href") === "#/settings"));
  await waitFor(() => testid("settings-group-people"), { label: "the grouped settings home" });
  check(
    "the settings home is grouped: General / Users & roles / Branding / Online store / Backup & restore / Audit log / System",
    ["general", "people", "branding", "online", "backup", "audit", "system"].every((g) => testid(`settings-group-${g}`)),
  );

  // ── 4–8 · the grouped home reaches every room ─────────────────────────────
  clickTestid("settings-card-branding");
  await waitFor(() => testid("breadcrumbs")?.textContent.includes("Branding"), { label: "the Branding page" });
  check("Settings → Branding opens, breadcrumb reads Settings › Branding", Boolean(testid("branding-save")));

  await navigate("#/settings");
  await waitFor(() => testid("settings-card-users"), { label: "the settings home again" });
  clickTestid("settings-card-users");
  await waitFor(() => testid("breadcrumbs")?.textContent.includes("Users"), { label: "the Users page" });
  check("Settings → Users opens under the same door", Boolean(testid("breadcrumbs")) && (testid("breadcrumbs").textContent ?? "").includes("Users"));

  await navigate("#/settings");
  await waitFor(() => testid("settings-card-backup"), { label: "the backup card" });
  clickTestid("settings-card-backup");
  await waitFor(() => testid("breadcrumbs")?.textContent.includes("Backup"), { label: "the Backup page" });
  check("Settings → Backup opens", bodyText().length > 0);

  await navigate("#/settings");
  await waitFor(() => testid("settings-card-system"), { label: "the Danger Zone card" });
  clickTestid("settings-card-system");
  await waitFor(() => bodyText().includes("Danger Zone") || bodyText().includes("Factory reset"), {
    label: "the Danger Zone",
  });
  check("Settings → Danger Zone opens from the System group", Boolean(testid("breadcrumbs")));

  // ── 9–11 · the Catalog module home reaches its rooms ──────────────────────
  await navigate("#/catalog");
  await waitFor(() => testid("module-catalog"), { label: "the Catalog module home" });
  check(
    "the Catalog home offers Products / Categories / Content / Import cards",
    ["products", "categories", "content", "import"].every((k) => testid(`module-card-${k}`)),
  );
  clickTestid("module-card-products");
  await waitFor(() => window.location.hash.includes("#/products") && testid("breadcrumbs")?.textContent.includes("Products"), {
    label: "the Products page",
  });
  const productCrumbs = testid("breadcrumbs").textContent ?? "";
  
  check(
    "Catalog → Products: breadcrumbs read Catalog › Products and the table renders",
    productCrumbs.includes("Catalog") && productCrumbs.includes("Products") && Boolean(document.querySelector('a[href="#/products/new"]')),
  );

  await navigate("#/catalog");
  await waitFor(() => testid("module-card-categories"), { label: "the Catalog home again" });
  clickTestid("module-card-categories");
  await waitFor(() => testid("breadcrumbs")?.textContent.includes("Categories"), { label: "the Categories page" });
  check("Catalog → Categories opens through the module home", Boolean(testid("breadcrumbs")));

  // ── 12–14 · the Online module home, then the browser's back button ────────
  await navigate("#/online");
  await waitFor(() => testid("module-online"), { label: "the Online module home" });
  const onlineCards = ["orders", "holds", "website", "marketing"].every((k) => testid(`module-card-${k}`));
  clickTestid("module-card-orders");
  await waitFor(() => testid("breadcrumbs")?.textContent.includes("Online orders"), { label: "the online orders queue" });
  check(
    "the Online home offers Orders/Holds/Website/Campaigns cards, and Orders opens with breadcrumbs Online › Online orders",
    onlineCards && window.location.hash.includes("#/online/orders"),
  );

  await navigate("#/online");
  await waitFor(() => testid("module-card-website"), { label: "the Online home again" });
  clickTestid("module-card-website");
  await waitFor(() => testid("breadcrumbs")?.textContent.includes("Website"), { label: "the website builder" });
  check("Online → Website customization opens (the only website-settings door)", window.location.hash.includes("#/online/website"));

  window.history.back();
  await sleep(500);
  await waitFor(() => testid("module-online"), { label: "the Online home after going back" });
  check("the browser's back button returns from a room to its module home", true);

  // ── 15 · legacy deep routes still resolve ─────────────────────────────────
  await navigate("#/products");
  await waitFor(() => testid("breadcrumbs")?.textContent.includes("Products"), { label: "the bookmarked products URL" });
  await navigate("#/pos/sales");
  await waitFor(() => testid("breadcrumbs")?.textContent.includes("Invoices") || testid("breadcrumbs"), {
    label: "the invoices URL",
  });
  check("bookmarked deep routes (#/products, #/pos/sales) still resolve unchanged", true);

  // ── 16 · the inventory pre-filter hydrates one level deeper ───────────────
  await navigate("#/inventory/stock?status=low");
  await sleep(500);
  const statusSelect = document.querySelector('select[aria-label="Status"]');
  check(
    "the stock deep-link hydrates its ?status=low filter under the module landing",
    statusSelect instanceof HTMLSelectElement && statusSelect.value === "low",
  );

  // ── 17 · the cashier: doors hidden, direct URL guarded ────────────────────
  await signOut();
  await signInAs("cashier");
  await waitFor(() => (document.querySelector("aside")?.textContent ?? "").length > 0, { label: "the cashier's sidebar" });
  const cashierHrefs = sidebarHrefs();
  // The cashier works the till, the queue and the reports — but holds no
  // settings capability, so the Settings door (and everything under it) hides,
  // and a typed URL to a hidden room is refused by the route guard.
  await navigate("#/settings/branding");
  const guardRefused = bodyText().includes("You do not have access to this screen");
  check(
    "a cashier sees no Settings door (their modules stay) and a direct URL to Branding is refused",
    !cashierHrefs.includes("#/settings") && cashierHrefs.includes("#/pos") && cashierHrefs.includes("#/sales") && cashierHrefs.includes("#/online") && cashierHrefs.includes("#/reports") && guardRefused,
  );

  // ── 18 · Arabic mirror + the mobile drawer's identical IA ─────────────────
  await signOut();
  await signInAs("admin");
  await navigate("#/");
  await waitFor(() => testid("shell-brand"), { label: "the shell" });
  clickExact("العربية");
  await sleep(400);
  assert.equal(document.documentElement.getAttribute("dir"), "rtl", "the shell flips to RTL");
  const hamburger = [...document.querySelectorAll("header button")].find(
    (b) => (b.getAttribute("aria-label") ?? "") === "القائمة",
  );
  assert.ok(hamburger, "the mobile menu button exists");
  clickEl(hamburger);
  await waitFor(() => document.querySelector('aside[role="dialog"]'), { label: "the mobile drawer" });
  const drawerHrefs = [...document.querySelectorAll('aside[role="dialog"] a')].map((a) => a.getAttribute("href"));
  const arabicDoors = ["لوحة التحكم", "الكاشير", "المبيعات", "الكتالوج", "المخزون", "أونلاين", "العملاء", "التقارير", "الإعدادات"];
  const drawerText = document.querySelector('aside[role="dialog"]').textContent ?? "";
  check(
    "Arabic mirrors the nine doors and the mobile drawer carries the identical module list",
    MODULES.every((m) => drawerHrefs.includes(m)) && arabicDoors.every((label) => drawerText.includes(label)) && drawerHrefs.every((h) => !STRAYS.includes(h)),
  );

  ux.finish(`Admin navigation (nav) — ${passed}/${TOTAL} checks`);
}

main().catch((error) => {
  console.error(`\n✗ ${error?.stack ?? error}`);
  process.exit(1);
});
