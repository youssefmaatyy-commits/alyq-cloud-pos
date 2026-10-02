/**
 * Phase 58 — workspaces, path alternates, import kinds, and sensitive money.
 *
 * Shipped role matrices are not narrowed here. A floor seat is a custom-role
 * fixture. Admin still holds every capability through the matrix, and a direct
 * path is refused when the capability is missing — hiding a nav item is not
 * the check.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ar, en } from "@/lib/i18n/dictionary";
import { buildFinancialSheets, OPEN_DATE_RANGE } from "@/modules/reports/services/financialExport";
import { buildProductAnalyticsSheets } from "@/modules/reports/services/analyticsExport";
import { importKindAdmitted, importKindsAdmitted } from "@/modules/import/services/access";
import { assertManageUsersRemains, countCapabilityHolders } from "@/modules/settings/services/lockout";
import { AppError } from "@/modules/products/data/repository";
import { capabilityForPath, pathAdmits } from "../routes";
import { PREVIEW_SCREENS, previewAccess } from "../preview";
import { capabilitiesOf, type Capability } from "../roles";
import {
  CASHIER_FLOOR_CAPABILITIES,
  INVENTORY_SEAT_CAPABILITIES,
  ONLINE_SEAT_CAPABILITIES,
  maySeeSensitiveMoney,
  operationsAccess,
  workspaceDoors,
} from "../workspaces";

const tests: { name: string; fn: () => void | Promise<void> }[] = [];
function test(name: string, fn: () => void | Promise<void>) {
  tests.push({ name, fn });
}

const can = (held: readonly string[]) => (capability: Capability) => held.includes(capability);
const t = (key: string) => key;

test("operations opens on health or settings, and capabilityForPath stays one capability", () => {
  assert.equal(capabilityForPath("/settings/operations"), "run_health_check");
  assert.equal(pathAdmits("/settings/operations", can(["run_health_check"])), true);
  assert.equal(pathAdmits("/settings/operations", can(["manage_settings"])), true);
  assert.equal(pathAdmits("/settings/operations", can(["view_reports"])), false);
  assert.equal(pathAdmits("/pos", can([])), false);
  assert.equal(pathAdmits("/", can([])), false, "dashboard read is explicit");
  assert.equal(pathAdmits("/", can(["view_dashboard"])), true);

  assert.deepEqual(operationsAccess(can(["run_health_check"])), { view: true, cleanup: false });
  assert.deepEqual(operationsAccess(can(["manage_settings"])), { view: true, cleanup: true });
  assert.deepEqual(operationsAccess(can(["view_inventory"])), { view: false, cleanup: false });
});

test("shipped roles that can open operations already hold the health check", () => {
  for (const role of ["admin", "manager", "cashier", "inventory_clerk", "viewer"] as const) {
    const held = capabilitiesOf(role);
    if (!pathAdmits("/settings/operations", can(held))) continue;
    assert.ok(held.includes("run_health_check"), `${role} opens operations without the health check`);
  }
});

test("the eight new preview screens follow the same door as the route guard", () => {
  const added = [
    "/products/import",
    "/settings/operations",
    "/settings/backup",
    "/settings/system",
    "/online/zones",
    "/online/discounts",
    "/settings/branding",
    "/settings/approvals",
  ];
  for (const screen of added) {
    assert.ok(PREVIEW_SCREENS.some((entry) => entry.path === screen), `${screen} is previewed`);
  }
  const health = new Set<string>(["run_health_check"]);
  const preview = previewAccess({ role: "viewer", customRole: { capabilities: [...health], active: true } });
  assert.ok(preview.screens.visible.some((screen) => screen.path === "/settings/operations"));
  assert.ok(preview.screens.hidden.every((screen) => screen.capability && !health.has(screen.capability)));
  assert.equal(previewAccess({ role: "admin" }).screens.hidden.length, 0);
});

test("import kinds follow the write each commit already asserts", () => {
  assert.deepEqual(importKindsAdmitted(can(["import_data"])), []);
  assert.deepEqual(importKindsAdmitted(can(["add_product"])), []);
  assert.deepEqual(
    importKindsAdmitted(can(["import_data", "add_product", "edit_customer"])),
    ["products", "variants", "customers", "categories"],
  );
  assert.equal(importKindAdmitted("stock", can(["import_data", "view_inventory"])), false);
  assert.equal(importKindAdmitted("stock", can(["import_data", "adjust_stock"])), true);
  assert.equal(importKindAdmitted("products", can(["import_data", "edit_product"])), true);
});

test("a floor seat is not the shipped cashier, and sensitive money is view_cost", () => {
  const shipped = capabilitiesOf("cashier");
  assert.ok(shipped.includes("import_data"), "the shipped cashier is not narrowed");
  assert.ok(shipped.includes("view_cost"));
  const floor = can(CASHIER_FLOOR_CAPABILITIES);
  assert.equal(floor("sell"), true);
  assert.equal(floor("view_cost"), false);
  assert.equal(floor("import_data"), false);
  assert.equal(floor("manage_online_orders"), false);
  assert.equal(floor("adjust_stock"), false);
  assert.equal(maySeeSensitiveMoney(floor), false);
  assert.equal(maySeeSensitiveMoney(can(INVENTORY_SEAT_CAPABILITIES)), false);
  assert.equal(can(ONLINE_SEAT_CAPABILITIES)("manage_online_orders"), true);
  assert.equal(maySeeSensitiveMoney(can(ONLINE_SEAT_CAPABILITIES)), false);

  const doors = workspaceDoors(new Set(CASHIER_FLOOR_CAPABILITIES));
  assert.equal(doors.find((door) => door.key === "cashier")?.open, true);
  assert.equal(doors.find((door) => door.key === "inventory")?.open, false);
  assert.equal(doors.find((door) => door.key === "oversight")?.open, false);
});

test("financial and product workbooks drop cost columns and the matching totals", () => {
  const input = {
    sales: [],
    products: [],
    expenses: [],
    returnsList: [],
    refundsList: [],
    shifts: [],
    summaryFor: () => null,
    range: OPEN_DATE_RANGE,
    t,
  };
  const shown = buildFinancialSheets(input);
  const hidden = buildFinancialSheets({ ...input, maySeeCost: false });
  const labels = (sheets: typeof shown) => sheets[0].rows.map((row) => String(row[0]));
  assert.ok(labels(shown).includes("export.metric.cogs"));
  assert.equal(labels(hidden).includes("export.metric.cogs"), false);
  assert.equal(labels(hidden).includes("export.metric.grossProfit"), false);
  assert.equal(labels(hidden).includes("export.metric.netProfit"), false);
  assert.ok(labels(hidden).includes("export.metric.revenue"));
  assert.equal(hidden[0].notes.includes("export.note.profit"), false);

  const products = buildProductAnalyticsSheets({
    sales: [],
    products: [],
    range: OPEN_DATE_RANGE,
    t,
    pick: (arName, enName) => enName || arName || "",
    maySeeCost: false,
  });
  assert.equal(products.some((sheet) => sheet.name === "export.sheet.stockValue"), false);
  for (const sheet of products) {
    if (sheet.totals) assert.equal(sheet.totals.length, sheet.header.length, sheet.name);
    for (const header of ["export.col.unitCost", "export.col.profit", "export.col.margin", "export.col.tiedUp"]) {
      assert.equal(sheet.header.includes(header), false, `${sheet.name} still has ${header}`);
    }
  }
});

test("last-holder refusal does not fire on an empty directory", () => {
  assert.doesNotThrow(() => assertManageUsersRemains([], [], [], []));
  const users = [{ id: "cashier", active: true, role: "cashier", custom_role_id: null, extra_capabilities: [], denied_capabilities: [] }];
  assert.equal(countCapabilityHolders(users, [], "manage_users"), 0);
  assert.doesNotThrow(() => assertManageUsersRemains(users, [], users, []));
});

test("new copy exists in both languages", () => {
  for (const key of [
    "settings.roles.lockout",
    "settings.roles.picker.workspaceHint",
    "settings.preview.workspaces",
    "settings.preview.workspace.cashier",
    "importCenter.noKinds",
    "operations.denied",
  ]) {
    assert.equal(typeof (en as Record<string, string>)[key], "string", key);
    assert.equal(typeof (ar as Record<string, string>)[key], "string", key);
  }
});

test("demo danger-zone admin is the capability, not a role conjunction", () => {
  const source = fs.readFileSync(path.join(process.cwd(), "src/modules/settings/services/systemReset.ts"), "utf8");
  const body = source.slice(source.indexOf("function demoIsAdmin"));
  assert.equal(body.includes('user.role === "admin"'), false);
  assert.ok(body.includes("manage_system_reset"));
});

let passed = 0;
const failures: string[] = [];
for (const { name, fn } of tests) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failures.push(`${name}: ${error instanceof AppError ? error.message : error instanceof Error ? error.message : String(error)}`);
    console.error(`  ✗ ${name}`);
    console.error(error);
  }
}
if (failures.length > 0) {
  console.error(`\n${failures.length} failed, ${passed} passed`);
  process.exit(1);
}
console.log(`\n${passed}/${tests.length} passed`);
