import { getCurrentUser, type InventoryUser } from "@/modules/inventory/permissions";
import { hasCapability } from "@/lib/permissions/roles";

/**
 * Cashier-shift, expense and audit permission checks (Phase 8).
 *
 * These functions keep their original names and signatures, but the decision
 * itself now lives in the shared role/capability matrix
 * (`src/lib/permissions/roles.ts`) — the step that prepares the model for the
 * Authentication phase. Behaviour for the roles the app ships today is
 * unchanged; the matrix additionally gives the `cashier` role a real
 * definition (till work yes, manager-level actions no).
 *
 * A `cashier` role is recognised alongside the shared roles. The shared role
 * list in the inventory module is owned by Phase 3 and is intentionally not
 * modified here.
 */

/** Cashiers, clerks, managers and admins work a till. */
export function canOpenShift(user: InventoryUser = getCurrentUser()): boolean {
  return hasCapability(user?.role, "open_shift");
}

/** Whoever opened the shift (or a manager/admin) may close it. */
export function canCloseShift(user: InventoryUser = getCurrentUser()): boolean {
  return hasCapability(user?.role, "close_shift");
}

/** Recording a shift expense — same staff tier that runs the till. */
export function canAddExpense(user: InventoryUser = getCurrentUser()): boolean {
  return hasCapability(user?.role, "add_expense");
}

/** Editing an existing expense is manager-level; deleting is admin-level. */
export function canEditExpense(user: InventoryUser = getCurrentUser()): boolean {
  return hasCapability(user?.role, "edit_expense");
}

export function canDeleteExpense(user: InventoryUser = getCurrentUser()): boolean {
  return hasCapability(user?.role, "delete_expense");
}

/** Reading shift history is allowed for every internal role. */
export function canViewAllShifts(user: InventoryUser = getCurrentUser()): boolean {
  return hasCapability(user?.role, "view_shifts");
}

/** Signing off a cash difference / adjustment — managers and admins only. */
export function canApproveAdjustment(user: InventoryUser = getCurrentUser()): boolean {
  return hasCapability(user?.role, "approve_shift_adjustment");
}

/** Reading the audit log is an oversight action — managers and admins. */
export function canViewAuditLog(user: InventoryUser = getCurrentUser()): boolean {
  return hasCapability(user?.role, "view_audit_log");
}
