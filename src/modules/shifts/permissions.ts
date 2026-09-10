import { getCurrentUser, type InventoryUser } from "@/modules/inventory/permissions";

/**
 * Cashier-shift + expense permission checks (Phase 8).
 *
 * Reuses the shared internal user from the inventory module so one identity
 * drives every module. Everything here is additive — no existing role gains a
 * lost capability. A `cashier` role is recognised alongside the shared roles
 * (the shared list is owned by the inventory module and is not modified here).
 */

type Role = InventoryUser["role"] | "cashier" | "viewer";

function roleOf(user: InventoryUser): Role {
  return user.role as Role;
}

/** Cashiers, clerks, managers and admins work a till. */
export function canOpenShift(user: InventoryUser = getCurrentUser()): boolean {
  return (
    roleOf(user) === "admin" ||
    roleOf(user) === "manager" ||
    roleOf(user) === "inventory_clerk" ||
    roleOf(user) === "cashier"
  );
}

/** Whoever opened the shift (or a manager/admin) may close it. */
export function canCloseShift(user: InventoryUser = getCurrentUser()): boolean {
  return canOpenShift(user);
}

/** Recording a shift expense — same staff tier that runs the till. */
export function canAddExpense(user: InventoryUser = getCurrentUser()): boolean {
  return canOpenShift(user);
}

/** Editing an existing expense is manager-level; deleting is admin-level. */
export function canEditExpense(user: InventoryUser = getCurrentUser()): boolean {
  return roleOf(user) === "admin" || roleOf(user) === "manager";
}

export function canDeleteExpense(user: InventoryUser = getCurrentUser()): boolean {
  return roleOf(user) === "admin" || roleOf(user) === "manager";
}

/** Reading shift history is allowed for every internal role. */
export function canViewAllShifts(user: InventoryUser = getCurrentUser()): boolean {
  return Boolean(user?.role);
}

/** Signing off a cash difference / adjustment — managers and admins only. */
export function canApproveAdjustment(user: InventoryUser = getCurrentUser()): boolean {
  return roleOf(user) === "admin" || roleOf(user) === "manager";
}

/** Reading the audit log is an oversight action — managers and admins. */
export function canViewAuditLog(user: InventoryUser = getCurrentUser()): boolean {
  return roleOf(user) === "admin" || roleOf(user) === "manager";
}
