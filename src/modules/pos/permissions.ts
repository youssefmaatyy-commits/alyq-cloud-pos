import { getCurrentUser, type InventoryUser } from "@/modules/inventory/permissions";
import { hasCapability } from "@/lib/permissions/roles";

/**
 * POS permission checks.
 *
 * The acting user still comes from the shared accessor (Phase 3) — now backed
 * by the auth session — but every decision delegates to the canonical
 * capability matrix (`src/lib/permissions/roles.ts`). No permission was
 * removed; the matrix simply states each one once.
 *
 * Authentication-phase fix: `canCompleteSale` previously listed roles by hand
 * and omitted `cashier`, so a signed-in cashier could not sell even though the
 * matrix grants `cashier` the `sell` capability. It now asks the matrix, which
 * is the behaviour the role model documents.
 */

/** Cashiers, clerks, managers and admins may run sales. Viewers cannot. */
export function canCompleteSale(user: InventoryUser = getCurrentUser()): boolean {
  return hasCapability(user?.role, "sell");
}

/** Discounts are a manager-level action — cashiers sell at full price only. */
export function canApplyDiscount(user: InventoryUser = getCurrentUser()): boolean {
  return hasCapability(user?.role, "apply_discount");
}

/** Voiding a completed sale is restricted to managers / admins. */
export function canVoidSale(user: InventoryUser = getCurrentUser()): boolean {
  return hasCapability(user?.role, "void_sale");
}

/** Confirming a pending InstaPay payment uses the same staff tier as selling. */
export function canConfirmPayment(user: InventoryUser = getCurrentUser()): boolean {
  return hasCapability(user?.role, "confirm_payment");
}

/** Roles the POS role switcher offered (kept for compatibility). */
export const POS_ROLES = ["admin", "manager", "inventory_clerk"] as const;
export type PosRole = (typeof POS_ROLES)[number];
