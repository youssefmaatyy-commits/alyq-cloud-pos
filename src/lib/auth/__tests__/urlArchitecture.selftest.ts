/**
 * URL Architecture & Route Security Self-Test.
 *
 * Verifies:
 *   1. Public website routing: `/` and `/store/*` render Storefront V2.
 *   2. Authenticated staff application routing: `/dashboard/*` root and subroutes.
 *   3. Login and authentication guards: `/login` routing, session resolution,
 *      safe redirect handling, and open redirect protection.
 *   4. Legacy route compatibility and deterministic redirects.
 *   5. Permission, capability, and workspace door resolution across all `/dashboard/*` paths.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { resolveNextTarget } from "../components/RequireAuth";
import {
  ROUTE_PERMISSIONS,
  ROUTE_CAPABILITIES,
  capabilityForPath,
  isSelfGuardedPath,
  pathAdmits,
  pathPermits,
  permissionForPath,
} from "@/lib/permissions/routes";
import { capabilitiesOf, type Capability } from "@/lib/permissions/roles";

const tests: { name: string; fn: () => void | Promise<void> }[] = [];
function test(name: string, fn: () => void | Promise<void>) {
  tests.push({ name, fn });
}

function repoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, "src/App.tsx"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("cannot locate repository root");
}

const ROOT = repoRoot();
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), "utf8");

// ── 1. Safe Post-Login Target Resolution & Open Redirect Defense ─────────────

test("resolveNextTarget: empty and null inputs safely fallback to /dashboard", () => {
  assert.equal(resolveNextTarget(null), "/dashboard");
  assert.equal(resolveNextTarget(""), "/dashboard");
  assert.equal(resolveNextTarget("   "), "/dashboard");
  assert.equal(resolveNextTarget("/"), "/dashboard");
  assert.equal(resolveNextTarget("/?ref=old"), "/dashboard");
});

test("resolveNextTarget: valid internal /dashboard paths are preserved", () => {
  assert.equal(resolveNextTarget("/dashboard"), "/dashboard");
  assert.equal(resolveNextTarget("/dashboard/"), "/dashboard/");
  assert.equal(resolveNextTarget("/dashboard/pos"), "/dashboard/pos");
  assert.equal(resolveNextTarget("/dashboard/inventory/stock"), "/dashboard/inventory/stock");
  assert.equal(resolveNextTarget("/dashboard/inventory/stock?status=low"), "/dashboard/inventory/stock?status=low");
  assert.equal(resolveNextTarget("/dashboard/online/orders?status=pending"), "/dashboard/online/orders?status=pending");
  assert.equal(resolveNextTarget("/dashboard/settings/users"), "/dashboard/settings/users");
  assert.equal(resolveNextTarget("/dashboard/reports/advanced"), "/dashboard/reports/advanced");
});

test("resolveNextTarget: legacy staff paths are safely mapped under /dashboard", () => {
  assert.equal(resolveNextTarget("/pos"), "/dashboard/pos");
  assert.equal(resolveNextTarget("/products"), "/dashboard/products");
  assert.equal(resolveNextTarget("/inventory/stock?status=low"), "/dashboard/inventory/stock?status=low");
  assert.equal(resolveNextTarget("/settings/users"), "/dashboard/settings/users");
  assert.equal(resolveNextTarget("/online/orders"), "/dashboard/online/orders");
});

test("resolveNextTarget: open redirect attempts and hostile protocols are refused", () => {
  const hostile = [
    "https://evil.com",
    "http://evil.com",
    "https://evil.com/dashboard",
    "//evil.com",
    "//evil.com/dashboard",
    "//dashboard.attacker.com",
    "/\\evil.com",
    "\\evil.com",
    "javascript:alert(1)",
    "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==",
    "vbscript:msgbox(1)",
    "https://pos.example.com@evil.com",
    "%2F%2Fevil.com",
    "%2F%5Cevil.com",
    "   https://attacker.com   ",
  ];

  for (const target of hostile) {
    assert.equal(
      resolveNextTarget(target),
      "/dashboard",
      `Target should have been refused and defaulted to /dashboard: ${target}`,
    );
  }
});

test("resolveNextTarget: auth cycle loops are prevented", () => {
  assert.equal(resolveNextTarget("/login"), "/dashboard");
  assert.equal(resolveNextTarget("/login?next=/dashboard/pos"), "/dashboard");
  assert.equal(resolveNextTarget("/forgot-password"), "/dashboard");
  assert.equal(resolveNextTarget("/reset-password"), "/dashboard");
  assert.equal(resolveNextTarget("/change-password"), "/dashboard");
});

// ── 2. Permission and Capability Resolution across /dashboard/* ──────────────

test("permissionForPath and capabilityForPath correctly resolve all dashboard paths", () => {
  const expected: Array<[string, string | null, Capability | null]> = [
    ["/dashboard", "dashboard.view", "view_dashboard"],
    ["/dashboard/pos", "pos.sell", "sell"],
    ["/dashboard/pos/sales", "sales.view", "view_sales"],
    ["/dashboard/products", "products.view", "view_products"],
    ["/dashboard/products/new", "products.create", "add_product"],
    ["/dashboard/products/prd-1/edit", "products.edit", "edit_product"],
    ["/dashboard/products/import", "data.import", "import_data"],
    ["/dashboard/categories", "products.view", "view_products"],
    ["/dashboard/catalog", "products.view", "view_products"],
    ["/dashboard/management", "sales.view", "view_sales"],
    ["/dashboard/inventory", "inventory.view", "view_inventory"],
    ["/dashboard/inventory/stock", "inventory.view", "view_inventory"],
    ["/dashboard/inventory/movements", "inventory.view", "view_inventory"],
    ["/dashboard/inventory/stocktake", "inventory.view", "view_inventory"],
    ["/dashboard/sync", "pos.sell", "sell"],
    ["/dashboard/system-health", "reports.view", "view_reports"],
    ["/dashboard/sales", "sales.view", "view_sales"],
    ["/dashboard/customers", "customers.view", "view_customers"],
    ["/dashboard/returns", "returns.process", "process_return"],
    ["/dashboard/refunds", "refunds.process", "process_refund"],
    ["/dashboard/shifts", "shifts.view", "view_shifts"],
    ["/dashboard/shifts/history", "shifts.view", "view_shifts"],
    ["/dashboard/shifts/eod", "shifts.view", "view_shifts"],
    ["/dashboard/expenses", "shifts.view", "view_shifts"],
    ["/dashboard/approvals", null, null],
    ["/dashboard/reports", "reports.view", "view_reports"],
    ["/dashboard/reports/advanced", "reports.view", "view_reports"],
    ["/dashboard/orders", "orders.view", "manage_online_orders"],
    ["/dashboard/online", "orders.view", "manage_online_orders"],
    ["/dashboard/online/orders", "orders.view", "manage_online_orders"],
    ["/dashboard/online/reservations", "orders.view", "manage_online_orders"],
    ["/dashboard/online/reports", "orders.view", "manage_online_orders"],
    ["/dashboard/online/website", "website.manage", "manage_website"],
    ["/dashboard/online/marketing", "website.manage", "manage_website"],
    ["/dashboard/online/zones", "website.manage", "manage_website"],
    ["/dashboard/online/discounts", "website.manage", "manage_website"],
    ["/dashboard/online/content", "website.manage", "manage_website"],
    ["/dashboard/audit", "audit.view", "view_audit_log"],
    ["/dashboard/users", "users.manage", "manage_users"],
    ["/dashboard/settings", null, null],
    ["/dashboard/settings/users", "users.manage", "manage_users"],
    ["/dashboard/settings/roles", "roles.manage", "manage_roles"],
    ["/dashboard/settings/branches", "users.manage", "manage_users"],
    ["/dashboard/settings/registers", "registers.manage", "manage_registers"],
    ["/dashboard/settings/hardware", "hardware.configure", "configure_hardware"],
    ["/dashboard/settings/system", "system.preview_cleanup", "preview_data_cleanup"],
    ["/dashboard/settings/approvals", "settings.manage", "manage_settings"],
    ["/dashboard/settings/operations", "system.health_check", "run_health_check"],
    ["/dashboard/settings/backup", "backups.view", "view_backups"],
    ["/dashboard/settings/branding", "website.manage", "manage_website"],
  ];

  for (const [pathname, expectedPerm, expectedCap] of expected) {
    const perm = permissionForPath(pathname);
    const cap = capabilityForPath(pathname);
    assert.equal(perm, expectedPerm, `Permission mismatch for ${pathname}`);
    assert.equal(cap, expectedCap, `Capability mismatch for ${pathname}`);
  }
});

test("isSelfGuardedPath correctly identifies /audit and /dashboard/audit", () => {
  assert.equal(isSelfGuardedPath("/audit"), true);
  assert.equal(isSelfGuardedPath("/audit/"), true);
  assert.equal(isSelfGuardedPath("/dashboard/audit"), true);
  assert.equal(isSelfGuardedPath("/dashboard/audit/"), true);
  assert.equal(isSelfGuardedPath("/dashboard/pos"), false);
  assert.equal(isSelfGuardedPath("/dashboard"), false);
  assert.equal(isSelfGuardedPath("/"), false);
});

test("pathPermits and pathAdmits grant full access to admin across /dashboard/*", () => {
  const adminCapabilities = capabilitiesOf("admin");
  const check = (cap: Capability) => adminCapabilities.includes(cap);

  const testPaths = [
    "/dashboard",
    "/dashboard/pos",
    "/dashboard/pos/sales",
    "/dashboard/products",
    "/dashboard/products/new",
    "/dashboard/products/import",
    "/dashboard/categories",
    "/dashboard/inventory",
    "/dashboard/inventory/stock",
    "/dashboard/inventory/movements",
    "/dashboard/inventory/stocktake",
    "/dashboard/sync",
    "/dashboard/system-health",
    "/dashboard/sales",
    "/dashboard/customers",
    "/dashboard/returns",
    "/dashboard/refunds",
    "/dashboard/shifts",
    "/dashboard/expenses",
    "/dashboard/reports",
    "/dashboard/reports/advanced",
    "/dashboard/online/orders",
    "/dashboard/online/website",
    "/dashboard/audit",
    "/dashboard/settings/users",
    "/dashboard/settings/roles",
    "/dashboard/settings/system",
    "/dashboard/settings/backup",
    "/dashboard/settings/operations",
  ];

  for (const p of testPaths) {
    assert.ok(pathAdmits(p, check), `Admin should have access to ${p}`);
  }
});

test("pathAdmits enforces role boundaries for cashier and viewer on /dashboard/*", () => {
  const cashierCaps = capabilitiesOf("cashier");
  const cashierCan = (cap: Capability) => cashierCaps.includes(cap);

  assert.ok(pathAdmits("/dashboard/pos", cashierCan), "Cashier can open POS");
  assert.ok(pathAdmits("/dashboard/sync", cashierCan), "Cashier can open sync");
  assert.ok(pathAdmits("/dashboard/shifts", cashierCan), "Cashier can open shifts");
  assert.equal(pathAdmits("/dashboard/settings/users", cashierCan), false, "Cashier cannot manage users");
  assert.equal(pathAdmits("/dashboard/settings/roles", cashierCan), false, "Cashier cannot manage roles");
  assert.equal(pathAdmits("/dashboard/settings/system", cashierCan), false, "Cashier cannot access danger zone");

  const viewerCaps = capabilitiesOf("viewer");
  const viewerCan = (cap: Capability) => viewerCaps.includes(cap);

  assert.ok(pathAdmits("/dashboard", viewerCan), "Viewer can view dashboard");
  assert.ok(pathAdmits("/dashboard/products", viewerCan), "Viewer can view products");
  assert.ok(pathAdmits("/dashboard/reports", viewerCan), "Viewer can view reports");
  assert.equal(pathAdmits("/dashboard/pos", viewerCan), false, "Viewer cannot sell on POS");
  assert.equal(pathAdmits("/dashboard/settings/users", viewerCan), false, "Viewer cannot manage users");
});

test("ROUTE_PERMISSIONS and ROUTE_CAPABILITIES cover all system routes", () => {
  assert.ok(ROUTE_PERMISSIONS.length >= 30, "ROUTE_PERMISSIONS table is populated");
  assert.equal(ROUTE_PERMISSIONS.length, ROUTE_CAPABILITIES.length, "Permissions and capabilities tables stay in sync");
  assert.ok(pathPermits("/dashboard/pos", (perm) => perm === "pos.sell"), "pathPermits resolves pos.sell");
});

// ── 3. App Router & Structural Wiring Verification ───────────────────────────

test("App.tsx route architecture: Storefront V2 at root and /store, staff app at /dashboard", () => {
  const appSrc = read("src/App.tsx");

  // Public Storefront V2 at root /
  assert.ok(
    appSrc.includes('<Route path="/" element='),
    "App.tsx must route / to StorefrontApp",
  );

  // Storefront alias at /store
  assert.ok(
    appSrc.includes('<Route path="/store"'),
    "App.tsx must route /store to StorefrontApp",
  );

  // Staff application at /dashboard/*
  assert.ok(
    appSrc.includes('<Route path="/dashboard/*" element={<AuthenticatedApp />} />'),
    "App.tsx must route /dashboard/* to AuthenticatedApp",
  );

  // Staff login at /login
  assert.ok(
    appSrc.includes('<Route path="/login" element={<LoginRoute />} />'),
    "App.tsx must route /login to LoginRoute",
  );

  // Legacy staff route redirects
  const legacyStaffPaths = [
    "/pos/*",
    "/products/*",
    "/categories/*",
    "/catalog/*",
    "/management/*",
    "/inventory/*",
    "/sync/*",
    "/system-health/*",
    "/sales/*",
    "/customers/*",
    "/returns/*",
    "/refunds/*",
    "/shifts/*",
    "/expenses/*",
    "/approvals/*",
    "/reports/*",
    "/online/*",
    "/audit/*",
    "/settings/*",
    "/users/*",
    "/orders/*",
  ];

  for (const legacyPath of legacyStaffPaths) {
    assert.ok(
      appSrc.includes(`<Route path="${legacyPath}"`),
      `App.tsx must include legacy redirect for ${legacyPath}`,
    );
  }
});

test("Storefront V1 remains runtime-inactive", () => {
  const appSrc = read("src/App.tsx");
  assert.ok(
    !appSrc.includes("StoreHomePage") &&
    !appSrc.includes("StoreLayout") &&
    !appSrc.includes("StoreCartPage") &&
    !appSrc.includes("StoreCheckoutPage"),
    "Storefront V1 pages must not be directly imported or active in production App.tsx",
  );
});

// ── Runner ───────────────────────────────────────────────────────────────────

let passed = 0;
for (const { name, fn } of tests) {
  try {
    await fn();
    passed += 1;
  } catch (err) {
    console.error(`✗ ${name}`);
    console.error(err);
    process.exit(1);
  }
}
console.log(`✓ ${passed}/${tests.length} URL architecture & route security tests passed`);
