import { getCurrentUser, type InventoryUser } from "@/modules/inventory/permissions";
import { canActAs } from "@/lib/permissions/enforce";

/**
 * Returns & refunds permission checks (Phase 7; re-pointed at the shared
 * capability matrix in Phase 13).
 *
 * These keep their original names and signatures, but the decision now lives in
 * `src/lib/permissions/roles.ts` — the same place shifts, expenses, inventory
 * and the POS ask. That matters for two reasons: a custom role (Phase 10) can
 * grant or withhold `process_return` independently of its base role, and the
 * service layer refuses the same actions the UI hides, so a hand-built request
 * cannot slip past a disabled button.
 *
 * Refunds are split in two on purpose: *recording* one is till work
 * (`process_refund`, which a cashier holds), while *settling* one — completing
 * or rejecting money that is still pending — is oversight work
 * (`approve_refund`). Requirement 3 of Phase 13 asks for exactly that split.
 */

/** Recording a sales return: restores stock and opens a refund. */
export function canProcessReturn(user: InventoryUser = getCurrentUser()): boolean {
  return canActAs(user, "process_return");
}

/** Writing the refund record that accompanies a return. */
export function canProcessRefund(user: InventoryUser = getCurrentUser()): boolean {
  return canActAs(user, "process_refund");
}

/** Completing a pending refund — the money really left the drawer. */
export function canSettleRefund(user: InventoryUser = getCurrentUser()): boolean {
  return canActAs(user, "approve_refund");
}

/** Refusing a pending refund. Same capability, different direction. */
export function canRejectRefund(user: InventoryUser = getCurrentUser()): boolean {
  return canActAs(user, "approve_refund");
}

/** Approving the goods side of a return (manager-level sign-off). */
export function canApproveReturn(user: InventoryUser = getCurrentUser()): boolean {
  return canActAs(user, "approve_return");
}
