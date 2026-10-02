/**
 * Permission foundation — normalized module.action catalog and `can()` API.
 *
 * Focused coverage for the foundation contract:
 *   - default/admin and cashier mappings preserve existing access;
 *   - allowed, denied and unknown decisions are fail-closed;
 *   - legacy capability helpers, demo identities and custom-role lists remain
 *     compatible with the normalized permission names.
 */
import assert from "node:assert/strict";

import { DEMO_USERS } from "@/lib/auth/demoUsers";
import { createSession } from "@/lib/auth/services/authService";
import { clearStoredSession, writeStoredSession } from "@/lib/auth/services/sessionStore";
import {
  DEFAULT_ROLE_PERMISSIONS,
  PERMISSION_CATALOG,
  PERMISSIONS,
  capabilityForPermission,
  catalogProblems,
  isPermission,
  permissionForCapability,
  permissionsOfRole,
  rolesWithPermission,
} from "../catalog";
import { can } from "../enforce";
import { pathPermits, permissionForPath, ROUTE_PERMISSIONS } from "../routes";
import {
  APP_ROLES,
  CAPABILITIES,
  capabilitiesOf,
  hasCapability,
  type AppRole,
} from "../roles";

type TestCase = { name: string; fn: () => void };
const tests: TestCase[] = [];
const test = (name: string, fn: () => void): void => void tests.push({ name, fn });

function roleSubject(role: AppRole) {
  return { role, capabilities: capabilitiesOf(role) };
}

test("catalog has one module.action permission for every existing capability", () => {
  assert.deepEqual(catalogProblems(), []);
  assert.equal(PERMISSIONS.length, CAPABILITIES.length);
  assert.equal(new Set(PERMISSIONS).size, PERMISSIONS.length);
  assert.equal(
    new Set(PERMISSIONS.map((permission) => PERMISSION_CATALOG[permission].capability)).size,
    CAPABILITIES.length,
  );
  assert.equal(capabilityForPermission("pos.sell"), "sell");
  assert.equal(capabilityForPermission("orders.view"), "manage_online_orders");
  assert.equal(capabilityForPermission("inventory.adjust"), "adjust_stock");
  for (const capability of CAPABILITIES) {
    assert.notEqual(permissionForCapability(capability), null, `${capability} is catalogued`);
  }
});

test("routes use the normalized catalog, including explicit module reads and alternates", () => {
  assert.equal(permissionForPath("/"), "dashboard.view");
  assert.equal(permissionForPath("/products/sku-1"), "products.view");
  assert.equal(permissionForPath("/products/new"), "products.create");
  assert.equal(permissionForPath("/products/sku-1/edit"), "products.edit");
  assert.equal(permissionForPath("/pos/sales/invoice-1"), "sales.view");
  assert.equal(permissionForPath("/pos"), "pos.sell");
  assert.equal(permissionForPath("/unknown"), null);
  assert.equal(pathPermits("/", (permission) => permission === "dashboard.view"), true);
  assert.equal(pathPermits("/", () => false), false);
  assert.equal(pathPermits("/sales", (permission) => permission === "returns.process"), true);
  assert.equal(pathPermits("/sales", (permission) => permission === "products.view"), false);
  for (const [, permission] of ROUTE_PERMISSIONS) {
    assert.equal(isPermission(permission), true, `${permission} is a catalog permission`);
  }
});

test("privileged admin permissions include the complete catalog", () => {
  assert.deepEqual(DEFAULT_ROLE_PERMISSIONS.admin, PERMISSIONS);
  for (const permission of PERMISSIONS) {
    assert.equal(can(permission, roleSubject("admin")), true, `admin may ${permission}`);
  }
  assert.equal(can("users.manage", roleSubject("admin")), true);
  assert.equal(can("roles.manage", roleSubject("admin")), true);
  assert.equal(can("system.reset", roleSubject("admin")), true);
  assert.deepEqual(rolesWithPermission("users.manage"), ["admin"]);
});

test("manager keeps privileged operations without gaining admin-only custody", () => {
  const manager = roleSubject("manager");
  assert.equal(can("pos.apply_discount", manager), true);
  assert.equal(can("refunds.approve", manager), true);
  assert.equal(can("audit.view", manager), true);
  assert.equal(can("users.manage", manager), false);
  assert.equal(can("roles.manage", manager), false);
  assert.equal(can("system.reset", manager), false);
});

test("cashier permissions preserve existing till access and denials", () => {
  const cashier = roleSubject("cashier");
  for (const permission of [
    "pos.sell",
    "payments.confirm",
    "orders.view",
    "returns.process",
    "refunds.process",
    "shifts.open",
    "expenses.create",
    "inventory.view",
  ]) {
    assert.equal(can(permission, cashier), true, `cashier may ${permission}`);
  }
  for (const permission of [
    "inventory.adjust",
    "pos.apply_discount",
    "sales.void",
    "refunds.approve",
    "audit.view",
    "users.manage",
  ]) {
    assert.equal(can(permission, cashier), false, `cashier may not ${permission}`);
  }
});

test("allowed and denied permissions use the current demo session", () => {
  const cashier = DEMO_USERS.find((user) => user.role === "cashier");
  assert.ok(cashier);
  writeStoredSession(createSession(cashier, false), "session");
  assert.equal(can("pos.sell"), true, "an allowed permission returns true");
  assert.equal(can("inventory.adjust"), false, "a denied permission returns false");
  clearStoredSession();
});

test("unknown permissions fail closed for every identity", () => {
  const admin = roleSubject("admin");
  for (const permission of ["", "pos", "pos.fly", "POS.SELL", "toString", "__proto__"]) {
    assert.equal(isPermission(permission), false, `${permission || "empty"} is unknown`);
    assert.equal(capabilityForPermission(permission), null);
    assert.equal(can(permission, admin), false, `${permission || "empty"} is denied`);
    assert.deepEqual(rolesWithPermission(permission), []);
  }

  const demoAdmin = DEMO_USERS.find((user) => user.role === "admin");
  assert.ok(demoAdmin);
  writeStoredSession(createSession(demoAdmin, false), "session");
  assert.equal(can("unknown.permission"), false, "current-session checks also fail closed");
  clearStoredSession();
});

test("default role mappings exactly match the existing capability matrix", () => {
  for (const role of APP_ROLES) {
    const expected = PERMISSIONS.filter((permission) =>
      hasCapability(role, PERMISSION_CATALOG[permission].capability),
    );
    assert.deepEqual(DEFAULT_ROLE_PERMISSIONS[role], expected, `${role} mapping is compatible`);
    assert.deepEqual(permissionsOfRole(role), expected, `${role} lookup is compatible`);
    for (const permission of PERMISSIONS) {
      assert.equal(
        can(permission, { role }),
        hasCapability(role, PERMISSION_CATALOG[permission].capability),
        `${role}/${permission} agrees with hasCapability`,
      );
    }
  }
  assert.deepEqual(permissionsOfRole("unknown"), []);
  assert.deepEqual(permissionsOfRole("owner"), DEFAULT_ROLE_PERMISSIONS.admin, "role aliases still work");
});

test("demo users and resolved custom-role lists remain compatible", () => {
  for (const user of DEMO_USERS) {
    for (const permission of PERMISSIONS) {
      const capability = PERMISSION_CATALOG[permission].capability;
      assert.equal(can(permission, user), user.capabilities.includes(capability), `${user.username}/${permission}`);
    }
  }

  const narrowed = { role: "admin", capabilities: ["sell"] };
  assert.equal(can("pos.sell", narrowed), true, "an explicit custom-role grant applies");
  assert.equal(can("users.manage", narrowed), false, "the base role does not widen a resolved list");
  assert.equal(can("not.real", { role: "admin", capabilities: ["not_real"] }), false);
});

let passed = 0;
for (const { name, fn } of tests) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } finally {
    clearStoredSession();
  }
}
console.log(`\n${passed}/${tests.length} permission-foundation tests passed.\n`);
