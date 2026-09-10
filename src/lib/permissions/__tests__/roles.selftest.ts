/**
 * Shared role + capability model self-test (headless).
 * Run with:
 *   npx esbuild src/lib/permissions/__tests__/roles.selftest.ts \
 *     --bundle --format=esm --platform=node --outfile=/tmp/alyq-roles.mjs && node /tmp/alyq-roles.mjs
 *
 * Two jobs:
 *   1. PROVE the shared matrix reproduces the behaviour of every permission
 *      helper the app ships today (the four existing roles), so preparing the
 *      model for the Authentication phase changed nothing.
 *   2. PIN the `cashier` role definition and the fail-closed normalisation that
 *      the future login phase will rely on.
 */
import assert from "node:assert/strict";
import type { InventoryUser } from "@/modules/inventory/permissions";
import {
  canAdjustStock,
  canViewInventory,
} from "@/modules/inventory/permissions";
import {
  canApplyDiscount,
  canCompleteSale,
  canConfirmPayment,
  canVoidSale,
} from "@/modules/pos/permissions";
import { canProcessRefund, canProcessReturn } from "@/modules/returns/permissions";
import {
  canAddExpense,
  canApproveAdjustment,
  canCloseShift,
  canDeleteExpense,
  canEditExpense,
  canOpenShift,
  canViewAllShifts,
  canViewAuditLog,
} from "@/modules/shifts/permissions";
import {
  APP_ROLES,
  CAPABILITIES,
  capabilitiesOf,
  hasCapability,
  isAppRole,
  normalizeRole,
  rolesWithCapability,
  type Capability,
} from "../roles";

type TestCase = { name: string; fn: () => void };
const tests: TestCase[] = [];
const test = (name: string, fn: () => void) => tests.push({ name, fn });

/** A user with an explicit role, for tests (never reads storage). */
const userWith = (role: string): InventoryUser =>
  ({ id: `u-${role}`, name: `Test ${role}`, role }) as InventoryUser;

/** The roles the application ships today (inventory owns this list). */
const SHIPPED_ROLES = ["admin", "manager", "inventory_clerk", "viewer"] as const;

console.log("\nPermissions · parity with the existing helpers");

test("shared matrix matches every existing permission helper, role by role", () => {
  // capability → the legacy helper that decides it today
  const parity: { capability: Capability; legacy: (u: InventoryUser) => boolean }[] = [
    { capability: "view_inventory", legacy: canViewInventory },
    { capability: "adjust_stock", legacy: canAdjustStock },
    { capability: "sell", legacy: canCompleteSale },
    { capability: "apply_discount", legacy: canApplyDiscount },
    { capability: "void_sale", legacy: canVoidSale },
    { capability: "confirm_payment", legacy: canConfirmPayment },
    { capability: "process_return", legacy: canProcessReturn },
    { capability: "process_refund", legacy: canProcessRefund },
    { capability: "open_shift", legacy: canOpenShift },
    { capability: "close_shift", legacy: canCloseShift },
    { capability: "add_expense", legacy: canAddExpense },
    { capability: "edit_expense", legacy: canEditExpense },
    { capability: "delete_expense", legacy: canDeleteExpense },
    { capability: "view_shifts", legacy: canViewAllShifts },
    { capability: "approve_shift_adjustment", legacy: canApproveAdjustment },
    { capability: "view_audit_log", legacy: canViewAuditLog },
  ];

  const mismatches: string[] = [];
  for (const role of SHIPPED_ROLES) {
    for (const { capability, legacy } of parity) {
      const fromMatrix = hasCapability(role, capability);
      const fromLegacy = legacy(userWith(role));
      if (fromMatrix !== fromLegacy) {
        mismatches.push(`${role}/${capability}: matrix=${fromMatrix} legacy=${fromLegacy}`);
      }
    }
  }
  assert.deepEqual(mismatches, [], `matrix drifted from the shipped helpers:\n${mismatches.join("\n")}`);
});

test("every shipped role is a member of the canonical model", () => {
  for (const role of SHIPPED_ROLES) {
    assert.ok(APP_ROLES.includes(role as (typeof APP_ROLES)[number]), `${role} is an app role`);
  }
  assert.equal(APP_ROLES.length, 5, "the model is exactly the five approved roles");
});

console.log("\nPermissions · the cashier role (prepared, not yet selectable)");

test("cashier runs the till but holds no manager-level capability", () => {
  for (const capability of [
    "view_inventory",
    "sell",
    "confirm_payment",
    "process_return",
    "process_refund",
    "open_shift",
    "close_shift",
    "add_expense",
    "view_shifts",
  ] as Capability[]) {
    assert.equal(hasCapability("cashier", capability), true, `cashier may ${capability}`);
  }
  for (const capability of [
    "adjust_stock",
    "apply_discount",
    "void_sale",
    "edit_expense",
    "delete_expense",
    "approve_shift_adjustment",
    "view_audit_log",
  ] as Capability[]) {
    assert.equal(hasCapability("cashier", capability), false, `cashier may not ${capability}`);
  }
});

test("known pre-auth difference: POS canCompleteSale does not accept cashier yet", () => {
  // The returns and shifts helpers already recognise `cashier`; the POS helper
  // does not, because no UI can select the role today. The matrix defines the
  // intended answer; this assertion documents the difference so the gap cannot
  // be forgotten when the cashier role becomes a login role.
  assert.equal(hasCapability("cashier", "sell"), true, "matrix says a cashier sells");
  assert.equal(canCompleteSale(userWith("cashier")), false, "POS helper still says no");
});

test("cashier inherits the clerk's till capabilities minus stock authority", () => {
  const cashier = capabilitiesOf("cashier").sort();
  const clerk = capabilitiesOf("inventory_clerk").sort();
  const onlyClerk = clerk.filter((c) => !cashier.includes(c));
  assert.deepEqual(onlyClerk, ["adjust_stock"], "the single difference is stock adjustment");
});

console.log("\nPermissions · normalisation is fail-closed");

test("aliases from an external system map onto app roles", () => {
  assert.equal(normalizeRole("inventory_clerk"), "inventory_clerk");
  assert.equal(normalizeRole("CASHIER"), "cashier");
  assert.equal(normalizeRole("  Manager "), "manager");
  assert.equal(normalizeRole("clerk"), "inventory_clerk");
  assert.equal(normalizeRole("stock_clerk"), "inventory_clerk");
  assert.equal(normalizeRole("owner"), "admin");
  assert.equal(normalizeRole("super_admin"), "admin");
  assert.equal(normalizeRole("superadmin"), "admin");
  assert.equal(normalizeRole("auditor"), "viewer");
});

test("unknown or missing roles resolve to null — never to a privileged role", () => {
  for (const raw of ["", "   ", "superuser", "root", "ADMINISTRATOR", null, undefined, "admin,"]) {
    assert.equal(normalizeRole(raw as string), null, `${JSON.stringify(raw)} is not a role`);
    assert.equal(isAppRole(raw as string), false);
    assert.deepEqual(capabilitiesOf(raw as string), [], `${JSON.stringify(raw)} holds nothing`);
    for (const capability of CAPABILITIES) {
      assert.equal(hasCapability(raw as string, capability), false, `${JSON.stringify(raw)} cannot ${capability}`);
    }
  }
});

console.log("\nPermissions · matrix integrity");

test("every capability is granted to at least one role (no dead gates)", () => {
  const orphans = CAPABILITIES.filter((capability) => rolesWithCapability(capability).length === 0);
  assert.deepEqual(orphans, [], `capabilities nobody holds: ${orphans.join(", ")}`);
});

test("read-only role can read but never mutate", () => {
  const viewer = capabilitiesOf("viewer").sort();
  assert.deepEqual(viewer, ["view_inventory", "view_shifts"]);
});

test("oversight capabilities are limited to admin + manager", () => {
  for (const capability of [
    "apply_discount",
    "void_sale",
    "edit_expense",
    "delete_expense",
    "approve_shift_adjustment",
    "view_audit_log",
  ] as Capability[]) {
    assert.deepEqual(
      rolesWithCapability(capability),
      ["admin", "manager"],
      `${capability} is manager/admin only`,
    );
  }
});

let passed = 0;
for (const { name, fn } of tests) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}
console.log(`\n${passed}/${tests.length} role-model tests passed.\n`);
