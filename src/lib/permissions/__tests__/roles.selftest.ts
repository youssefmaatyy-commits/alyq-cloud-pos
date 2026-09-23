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
  type AppRole,
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

/**
 * Every capability the app had before Phase 10 named the granular ones. Used by
 * the "no role lost a capability" test below.
 */
const PRE_PHASE_10_CAPABILITIES: readonly Capability[] = [
  "view_inventory",
  "adjust_stock",
  "sell",
  "apply_discount",
  "void_sale",
  "confirm_payment",
  "process_return",
  "process_refund",
  "approve_refund",
  "open_shift",
  "close_shift",
  "add_expense",
  "edit_expense",
  "delete_expense",
  "view_shifts",
  "approve_shift_adjustment",
  "view_audit_log",
  "manage_online_orders",
  "manage_website",
];

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

test("the POS gate agrees with the matrix for the cashier role", () => {
  // Pre-auth this helper listed roles by hand and omitted `cashier`, even though
  // the matrix granted it `sell`. The Authentication phase made every helper ask
  // the matrix, so the gap is closed and stays closed.
  assert.equal(hasCapability("cashier", "sell"), true, "matrix says a cashier sells");
  assert.equal(canCompleteSale(userWith("cashier")), true, "the POS gate agrees");
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
  // Phase 10 added three capabilities here — `view_reports`, `export_reports`
  // and `export_data` — and every one is a read (or an export) of data the
  // viewer could already open: `/reports` was reachable through `view_shifts`
  // (Phase 23 re-gated it on `view_reports`, which the viewer also holds, so
  // this list did not move) and the export buttons were not gated at all. Phase 17 added two more reads,
  // `view_customers` and `view_cost`, both of which any signed-in seat could
  // already do because nothing gated the customer book or the cost column. The
  // write list below is the real assertion: the viewer holds none of it.
  assert.deepEqual(viewer, [
    "export_data",
    "export_reports",
    "view_cost",
    "view_customers",
    "view_inventory",
    "view_reports",
    "view_shifts",
  ]);

  const writes: Capability[] = [
    "adjust_stock",
    "sell",
    "apply_discount",
    "void_sale",
    "edit_sale",
    "confirm_payment",
    "process_return",
    "approve_return",
    "process_refund",
    "approve_refund",
    "open_shift",
    "close_shift",
    "add_expense",
    "edit_expense",
    "delete_expense",
    "approve_expense",
    "approve_shift_adjustment",
    "add_product",
    "edit_product",
    "change_price",
    "change_cost",
    "delete_product",
    "import_data",
    "add_customer",
    "edit_customer",
    "delete_customer",
    "manage_online_orders",
    "manage_website",
    "manage_users",
    "manage_roles",
    "manage_settings",
  ];
  for (const capability of writes) {
    assert.equal(hasCapability("viewer", capability), false, `viewer may not ${capability}`);
  }
});

test("Phase 17 named the customer book and cost price, and tightened one thing", () => {
  // Before Phase 17 nothing gated the customer book at all: any signed-in seat
  // could add, edit or delete a customer, and cost price was written from the
  // product form by anybody who could edit a product. Naming those acts is what
  // makes them assignable — and the grants below keep every working seat exactly
  // as capable as it was.
  const named: Capability[] = [
    "view_customers",
    "add_customer",
    "edit_customer",
    "delete_customer",
    "view_cost",
    "change_cost",
  ];
  for (const capability of named) {
    assert.ok(CAPABILITIES.includes(capability), `${capability} is a capability`);
  }

  // The till keeps its customers and its cost price: a sale needs a customer, and
  // the product form the cashier could already edit is where cost is written.
  for (const role of ["cashier", "inventory_clerk", "manager", "admin"] as const) {
    const keeps: Capability[] = ["view_customers", "add_customer", "edit_customer", "view_cost", "change_cost"];
    for (const capability of keeps) {
      assert.equal(hasCapability(role, capability), true, `${role} keeps ${capability}`);
    }
  }

  // Deleting a customer erases a purchase history, so it is an oversight act.
  assert.equal(hasCapability("manager", "delete_customer"), true);
  assert.equal(hasCapability("admin", "delete_customer"), true);
  assert.equal(hasCapability("cashier", "delete_customer"), false, "the till may not erase a customer");
  assert.equal(hasCapability("inventory_clerk", "delete_customer"), false);

  // The one deliberate tightening: a viewer could previously write the customer
  // book because nothing checked. Every other change in Phase 17 is a naming.
  assert.equal(hasCapability("viewer", "add_customer"), false);
  assert.equal(hasCapability("viewer", "edit_customer"), false);
  assert.equal(hasCapability("viewer", "delete_customer"), false);
  assert.equal(hasCapability("viewer", "change_cost"), false);
  assert.equal(hasCapability("viewer", "view_customers"), true, "…but may still read it");
});

test("no role lost a capability when Phase 10 extended the matrix", () => {
  // The matrix may only ever grow for a shipped role: tightening is something an
  // admin does per custom role, never something a release does to everyone.
  // These are the five role definitions as they stood before Phase 10.
  const before: Record<AppRole, readonly Capability[]> = {
    admin: PRE_PHASE_10_CAPABILITIES,
    manager: PRE_PHASE_10_CAPABILITIES,
    cashier: [
      "view_inventory",
      "sell",
      "confirm_payment",
      "process_return",
      "process_refund",
      "open_shift",
      "close_shift",
      "add_expense",
      "view_shifts",
      "manage_online_orders",
    ],
    inventory_clerk: [
      "view_inventory",
      "adjust_stock",
      "sell",
      "confirm_payment",
      "process_return",
      "process_refund",
      "open_shift",
      "close_shift",
      "add_expense",
      "view_shifts",
      "manage_online_orders",
    ],
    viewer: ["view_inventory", "view_shifts"],
  };

  const lost: string[] = [];
  for (const role of APP_ROLES) {
    const now = capabilitiesOf(role);
    for (const capability of before[role]) {
      if (!now.includes(capability)) lost.push(`${role}/${capability}`);
    }
  }
  assert.deepEqual(lost, [], `capabilities removed from a shipped role: ${lost.join(", ")}`);
});

test("manager differs from admin only by what admin keeps to itself", () => {
  // Phase 10 is the first time the two oversight roles are not identical: who
  // manages users, roles and system settings is admin's alone.
  //
  // Phase 18 adds two more, and they are a different kind of thing. A manager may
  // protect the installation — see the snapshots, take one, run the health check —
  // but not replace it and not carry it out:
  //
  //   restore_backup  deletes every row written since the snapshot, including
  //                   sales already taken at the till. That is a decision about
  //                   the business, not about the shift.
  //   export_backup   the file *is* the database: every customer's phone number,
  //                   every sale, and the staff directory. Seeing that a backup
  //                   exists (`view_backups`, which a manager holds) and holding a
  //                   copy are deliberately two permissions.
  //
  // Both stay capabilities rather than role checks, so an installation that wants
  // a second person able to restore grants it in the Permission Builder instead of
  // making them an admin. This list is pinned because it is the whole answer to
  // "what can the owner do that the manager cannot?" — a change here should be a
  // decision somebody made, not something that happened.
  const admin = capabilitiesOf("admin");
  const manager = capabilitiesOf("manager");
  const onlyAdmin = admin.filter((c) => !manager.includes(c)).sort();
  const onlyManager = manager.filter((c) => !admin.includes(c));
  assert.deepEqual(onlyAdmin, [
    "export_backup",
    "manage_roles",
    "manage_settings",
    // Phase 47: the Danger Zone — the one act that must never reach an
    // ordinary oversight seat.
    "manage_system_reset",
    "manage_users",
    "restore_backup",
  ]);
  assert.deepEqual(onlyManager, [], "manager holds nothing admin lacks");
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

test("the cashier role is a first-class till role (authentication phase)", () => {
  // The Authentication phase replaced the demo switcher with real accounts, so
  // the hand-written role lists that used to omit `cashier` were replaced by the
  // matrix. This pins the outcome: a signed-in cashier runs the register.
  const cashier = userWith("cashier");
  assert.equal(canCompleteSale(cashier), true, "a cashier can complete a sale");
  assert.equal(canConfirmPayment(cashier), true, "a cashier can confirm an InstaPay payment");
  assert.equal(canProcessReturn(cashier), true);
  assert.equal(canProcessRefund(cashier), true);
  assert.equal(canOpenShift(cashier), true);
  assert.equal(canCloseShift(cashier), true);
  assert.equal(canAddExpense(cashier), true);
  assert.equal(canApplyDiscount(cashier), false, "discounts stay manager-level");
  assert.equal(canVoidSale(cashier), false, "voiding stays manager-level");
  assert.equal(canAdjustStock(cashier), false, "stock stays with clerks and above");
  assert.equal(canEditExpense(cashier), false);
  assert.equal(canDeleteExpense(cashier), false);
  assert.equal(canApproveAdjustment(cashier), false);
  assert.equal(canViewAuditLog(cashier), false, "the audit trail stays oversight-only");
});

test("a signed-out user is denied by every helper", () => {
  // `ANONYMOUS_USER` carries an empty role, which is not a model role.
  const anonymous = { id: "", name: "", role: "" } as InventoryUser;
  const helpers = [
    canViewInventory,
    canAdjustStock,
    canCompleteSale,
    canApplyDiscount,
    canVoidSale,
    canConfirmPayment,
    canProcessReturn,
    canProcessRefund,
    canOpenShift,
    canCloseShift,
    canAddExpense,
    canEditExpense,
    canDeleteExpense,
    canViewAllShifts,
    canApproveAdjustment,
    canViewAuditLog,
  ];
  for (const helper of helpers) {
    assert.equal(helper(anonymous), false, `${helper.name} denies a signed-out user`);
  }
  assert.equal(canViewAllShifts(userWith("viewer")), true, "a viewer may still read shift history");
});

let passed = 0;
for (const { name, fn } of tests) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}
console.log(`\n${passed}/${tests.length} role-model tests passed.\n`);
