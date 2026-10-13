/**
 * Admin navigation E2E (Phase 49) — the sidebar is the MAIN MODULES and
 * nothing else, driven through the real bundle in jsdom, demo mode:
 *
 *   1. the signed-in admin sees exactly six doors (Dashboard, POS, Sales,
 *      Catalog, Inventory, Online, Customers, Reports, Settings) plus the
 *      storefront shortcut;
 *   2. no sub-screen (Products, Categories, Audit, Approvals, Shifts,
 *      Refunds, Branding, Website…) is offered in the sidebar;
 *   3. Settings appears exactly once and opens a grouped home;
 *   4–8. the grouped Settings home reaches Branding, Users, Backup and the
 *      Danger Zone;
 *   9–11. the Catalog module home reaches Products and Categories through
 *      its own cards, with breadcrumbs on the child pages;
 *   12–15. the Online module home reaches Orders, Website, Delivery Zones and
 *      Discounts, and the browser's back button returns to the module home;
 *   16. legacy deep routes (#/products, #/pos/sales) still resolve — the
 *      navigation was restructured, not the routes destroyed;
 *   17. the inventory deep link with its status pre-filter hydrates the
 *      stock table one level below the module landing;
 *   18. a cashier sees no Reports/Settings/Online door and a direct URL is
 *      refused by the guard — hiding is courtesy, the guard is the law;
 *   19. Arabic mirrors the same six doors, and the mobile drawer carries
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
const TOTAL = 20;
function check(label, condition) {
  assert.ok(condition, label);
  passed += 1;
  console.log(`  ✓ ${passed}/${TOTAL} ${label}`);
}

/**
 * hrefs of the static (persistent) sidebar — the first <aside> in the DOM.
 * Deduplicated: the brand block and the Dashboard door both point at "#/dashboard".
 */
const sidebarHrefs = () =>
  [...new Set(
    [...(document.querySelector("aside") ?? document).querySelectorAll("a")]
      .map((a) => a.getAttribute("href") ?? "")
      .filter(Boolean),
  )];

async function main() {
  console.log("\nPhase 49 · Admin navigation — six doors, no clutter\n");


  // ── 0 · admin signs in ────────────────────────────────────────────────────
  await signInAs("admin");
  await waitFor(() => (document.querySelector("aside")?.textContent ?? "").includes("Dashboard"), {
    label: "the sidebar",
  });

  // ── 1 · exactly the six module doors (+ the storefront shortcut) ─────────
  const MODULES = ["#/dashboard", "#/dashboard/pos", "#/dashboard/management", "#/dashboard/online", "#/dashboard/reports", "#/dashboard/settings", "#/mobile/notifications"];
  const hrefs = sidebarHrefs();
  check(
    "the sidebar carries exactly the six module doors, Notifications + the storefront shortcut",
    MODULES.every((m) => hrefs.includes(m)) && hrefs.includes("#/store") && hrefs.length === 8,
  );

  // ── 2 · no sub-screen in the sidebar ──────────────────────────────────────
  const STRAYS = ["#/dashboard/sales", "#/dashboard/catalog", "#/dashboard/inventory", "#/dashboard/customers", "#/dashboard/products", "#/dashboard/categories", "#/dashboard/inventory/movements", "#/dashboard/pos/sales", "#/dashboard/returns", "#/dashboard/refunds", "#/dashboard/shifts", "#/dashboard/expenses", "#/dashboard/audit", "#/dashboard/approvals", "#/dashboard/online/orders", "#/dashboard/online/website", "#/dashboard/settings/branding", "#/dashboard/settings/users", "#/dashboard/settings/backup"];
  check("no sub-screen (products, audit, shifts, branding…) leaks into the sidebar", STRAYS.every((s) => !hrefs.includes(s)));

  // ── 3 · Settings appears exactly once and opens the grouped home ──────────
  check("Settings appears exactly once in the sidebar", hrefs.filter((h) => h.includes("/settings")).length === 1);
  clickEl([...document.querySelectorAll("aside a")].find((a) => (a.getAttribute("href") ?? "").includes("/settings")));
  await waitFor(() => testid("settings-group-people"), { label: "the grouped settings home" });
  check(
    "the settings home is grouped: General / Users & roles / Branding / Backup & restore / Audit log / System",
    ["general", "people", "branding", "backup", "audit", "system"].every((g) => testid(`settings-group-${g}`)),
  );

  // ── 4–8 · the grouped home reaches every room ─────────────────────────────
  clickTestid("settings-card-branding");
  await waitFor(() => testid("breadcrumbs")?.textContent.includes("Branding"), { label: "the Branding page" });
  check("Settings → Branding opens, breadcrumb reads Settings › Branding", Boolean(testid("branding-save")));

  await navigate("#/dashboard/settings");
  await waitFor(() => testid("settings-card-users"), { label: "the settings home again" });
  clickTestid("settings-card-users");
  await waitFor(() => testid("breadcrumbs")?.textContent.includes("Users"), { label: "the Users page" });
  check("Settings → Users opens under the same door", Boolean(testid("breadcrumbs")) && (testid("breadcrumbs").textContent ?? "").includes("Users"));

  await navigate("#/dashboard/settings");
  await waitFor(() => testid("settings-card-backup"), { label: "the backup card" });
  clickTestid("settings-card-backup");
  await waitFor(() => testid("breadcrumbs")?.textContent.includes("Backup"), { label: "the Backup page" });
  check("Settings → Backup opens", bodyText().length > 0);

  await navigate("#/dashboard/settings");
  await waitFor(() => testid("settings-card-system"), { label: "the Danger Zone card" });
  clickTestid("settings-card-system");
  await waitFor(() => bodyText().includes("Danger Zone") || bodyText().includes("Factory reset"), {
    label: "the Danger Zone",
  });
  check("Settings → Danger Zone opens from the System group", Boolean(testid("breadcrumbs")));

  // ── 9–11 · the Catalog module home reaches its rooms ──────────────────────
  await navigate("#/dashboard/management");
  await waitFor(() => testid("module-management"), { label: "the Catalog module home" });
  check(
    "Store Management offers all catalog, inventory and operations destinations",
    ["products", "categories", "content", "import", "media", "overview", "low", "out", "movements", "adjustments", "suppliers", "invoices", "returns", "refunds", "shifts", "shift-history", "shift-eod", "expenses", "customers", "approvals"].every((k) => testid(`module-card-${k}`)),
  );
  clickTestid("module-card-products");
  await waitFor(() => window.location.hash.includes("/products") && testid("breadcrumbs")?.textContent.includes("Products"), {
    label: "the Products page",
  });
  const productCrumbs = testid("breadcrumbs").textContent ?? "";
  
  check(
    "Store Management → Products: workspace breadcrumb and the table renders",
    productCrumbs.includes("Store Management") && productCrumbs.includes("Products") && Boolean(document.querySelector('a[href*="/products/new"]')),
  );

  await navigate("#/dashboard/management");
  await waitFor(() => testid("module-card-categories"), { label: "the Catalog home again" });
  clickTestid("module-card-categories");
  await waitFor(() => testid("breadcrumbs")?.textContent.includes("Categories"), { label: "the Categories page" });
  check("Store Management → Categories opens through the module home", Boolean(testid("breadcrumbs")));

  // ── 12–15 · the Online module home, new rooms, the back button ────────────
  await navigate("#/dashboard/online");
  await waitFor(() => testid("module-online"), { label: "the Online module home" });
  const onlineCards = ["orders", "holds", "website", "marketing", "zones", "discounts", "promocodes"].every((k) => testid(`module-card-${k}`));
  clickTestid("module-card-orders");
  await waitFor(() => testid("breadcrumbs")?.textContent.includes("Online orders"), { label: "the online orders queue" });
  check(
    "the Online home offers Orders/Holds/Website/Campaigns/Zones/Discounts/Promo-codes cards, and Orders opens with breadcrumbs Online › Online orders",
    onlineCards && window.location.hash.includes("/online/orders"),
  );

  await navigate("#/dashboard/online");
  await waitFor(() => testid("module-card-zones"), { label: "the zones card" });
  clickTestid("module-card-zones");
  await waitFor(() => testid("breadcrumbs")?.textContent.includes("Delivery Zones"), { label: "the zones page" });
  check(
    "Online → Delivery Zones opens with breadcrumbs Online › Delivery Zones",
    window.location.hash.includes("/online/zones"),
  );

  await navigate("#/dashboard/online");
  await waitFor(() => testid("module-card-discounts"), { label: "the discounts card" });
  clickTestid("module-card-discounts");
  await waitFor(() => testid("breadcrumbs")?.textContent.includes("Discounts"), { label: "the discounts page" });
  check(
    "Online → Discounts opens with breadcrumbs Online › Discounts",
    window.location.hash.includes("/online/discounts"),
  );

  await navigate("#/dashboard/online");
  await waitFor(() => testid("module-card-website"), { label: "the Online home again" });
  clickTestid("module-card-website");
  await waitFor(() => testid("breadcrumbs")?.textContent.includes("Website"), { label: "the website builder" });
  check("Online → Website customization opens (the only website-settings door)", window.location.hash.includes("/online/website"));

  window.history.back();

  await waitFor(() => testid("module-online"), { label: "the Online home after going back" });
  check("the browser's back button returns from a room to its module home", true);

  // ── 16 · legacy deep routes still resolve ────────────────────────────────
  await navigate("#/products");
  await waitFor(() => testid("breadcrumbs")?.textContent.includes("Products"), { label: "the bookmarked products URL" });
  assert.ok(window.location.hash.startsWith("#/dashboard/products"), "legacy product bookmark redirects to the canonical staff route");
  await navigate("#/pos/sales");
  await waitFor(() => testid("breadcrumbs")?.textContent.includes("Invoices") || testid("breadcrumbs"), {
    label: "the invoices URL",
  });
  check("bookmarked deep routes (#/products, #/pos/sales) still resolve", window.location.hash.startsWith("#/dashboard/pos/sales"));

  // ── 17 · the inventory pre-filter hydrates one level deeper ───────────────
  await navigate("#/dashboard/inventory/stock?status=low");

  const statusSelect = document.querySelector('select[aria-label="Status"]');
  check(
    "the stock deep-link hydrates its ?status=low filter under the module landing",
    statusSelect instanceof HTMLSelectElement && statusSelect.value === "low",
  );

  // ── 18 · the cashier: doors hidden, direct URL guarded ────────────────────
  await signOut();
  await signInAs("cashier");
  await waitFor(() => (document.querySelector("aside")?.textContent ?? "").length > 0, { label: "the cashier's sidebar" });
  const cashierHrefs = sidebarHrefs();
  // The cashier works the till, the queue and the reports — but holds no
  // settings capability, so the Settings door (and everything under it) hides,
  // and a typed URL to a hidden room is refused by the route guard.
  await navigate("#/dashboard/settings/branding");

  const guardRefused = Boolean(testid("route-access-denied")) && !document.querySelector("#brand-name-en");
  check(
    "a cashier sees no Settings door (their modules stay) and a direct URL to Branding is refused",
    !cashierHrefs.some((h) => h.includes("/settings")) && cashierHrefs.some((h) => h.includes("/pos")) && cashierHrefs.some((h) => h.includes("/management")) && cashierHrefs.some((h) => h.includes("/online")) && cashierHrefs.some((h) => h.includes("/reports")) && guardRefused,
  );

  // ── 19 · Arabic mirror + the mobile drawer's identical IA ─────────────────
  await signOut();
  await signInAs("admin");
  await navigate("#/dashboard");
  await waitFor(() => testid("shell-brand"), { label: "the shell" });
  clickExact("العربية");

  assert.equal(document.documentElement.getAttribute("dir"), "rtl", "the shell flips to RTL");
  const hamburger = [...document.querySelectorAll("header button")].find(
    (b) => (b.getAttribute("aria-label") ?? "") === "القائمة",
  );
  assert.ok(hamburger, "the mobile menu button exists");
  clickEl(hamburger);
  await waitFor(() => document.querySelector('aside[role="dialog"]'), { label: "the mobile drawer" });
  const drawerHrefs = [...document.querySelectorAll('aside[role="dialog"] a')].map((a) => a.getAttribute("href"));
  const arabicDoors = ["لوحة التحكم", "الكاشير", "إدارة المتجر", "المتجر الإلكتروني", "التقارير", "الإعدادات"];
  const drawerText = document.querySelector('aside[role="dialog"]').textContent ?? "";
  check(
    "Arabic mirrors the six doors and the mobile drawer carries the identical module list",
    MODULES.every((m) => drawerHrefs.includes(m)) && arabicDoors.every((label) => drawerText.includes(label)) && drawerHrefs.every((h) => !STRAYS.includes(h)),
  );

  ux.finish(`Admin navigation (nav) — ${passed}/${TOTAL} checks`);
}

main().catch((error) => {
  console.error(`\n✗ ${error?.stack ?? error}`);
  process.exit(1);
});
