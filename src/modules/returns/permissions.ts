import { getCurrentUser, type InventoryUser } from "@/modules/inventory/permissions";

/**
 * Returns & refunds permission preparation (Phase 7).
 * Cashiers, managers, and admins can process returns and refunds.
 */
export function canProcessReturn(user: InventoryUser = getCurrentUser()): boolean {
  return (
    user.role === "admin" ||
    user.role === "manager" ||
    user.role === "inventory_clerk" ||
    (user.role as string) === "cashier"
  );
}

export function canProcessRefund(user: InventoryUser = getCurrentUser()): boolean {
  return canProcessReturn(user);
}
