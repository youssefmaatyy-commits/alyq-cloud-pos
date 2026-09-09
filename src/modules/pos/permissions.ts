import { getCurrentUser, type InventoryUser } from "@/modules/inventory/permissions";

/**
 * POS permission checks.
 *
 * Reuses the shared internal user (Phase 3) so the same identity drives
 * inventory and POS. The cashier role was added to the shared role list;
 * everything here is additive.
 */

/** Cashiers, managers and admins may run sales. Viewers cannot. */
export function canCompleteSale(user: InventoryUser = getCurrentUser()): boolean {
  return (
    user.role === "admin" || user.role === "manager" || user.role === "inventory_clerk"
  );
}

/** Discounts are a manager-level action — cashiers sell at full price only. */
export function canApplyDiscount(user: InventoryUser = getCurrentUser()): boolean {
  return user.role === "admin" || user.role === "manager";
}

/** Voiding a completed sale is restricted to managers / admins. */
export function canVoidSale(user: InventoryUser = getCurrentUser()): boolean {
  return user.role === "admin" || user.role === "manager";
}

/**
 * Confirming a pending InstaPay payment uses the same staff tier that may
 * complete a sale (cashiers + managers + admins). Viewers cannot confirm.
 */
export function canConfirmPayment(user: InventoryUser = getCurrentUser()): boolean {
  return canCompleteSale(user);
}

/** Roles the POS role switcher offers (subset relevant to the till). */
export const POS_ROLES = ["admin", "manager", "inventory_clerk"] as const;
export type PosRole = (typeof POS_ROLES)[number];
