/**
 * "What can still be returned from this sale?" — one answer, computed once.
 *
 * The returns modal used to derive its state from `returnableMap` alone, and
 * that map has a blind spot: a sale whose LINES are missing produces exactly the
 * same empty map as a sale whose lines have all been returned. Both make
 * `hasAnyReturnable` false, and the UI then reported the missing-data case as
 * "all items on this invoice have already been returned" — telling a cashier
 * that a brand-new invoice had been fully returned when in fact its lines had
 * never arrived (a live-mode `listSales()` that mapped sales with `items: []`).
 *
 * So the state is decided on the sale itself, not on the aggregate:
 *
 *   unavailable     the sale carries no lines → the data is missing. Never
 *                   report this as a completed return; offer nothing to return.
 *   fully-returned  the lines are here and every one of them is exhausted.
 *   returnable      at least one unit is still returnable.
 *
 * The quantity arithmetic itself stays in `getRemainingReturnableQuantities`,
 * which encodes the rejected-return rule from migration 0041 (a rejected
 * refund's goods were written back, so it holds no quantity; pending and
 * completed both do). This module only names the state.
 */
import type { Sale } from "@/modules/pos/types";
import type { SalesReturn } from "../types";
import { getRemainingReturnableQuantities } from "../validation";

export type SaleReturnState = "unavailable" | "fully-returned" | "returnable";

export interface SaleReturnability {
  state: SaleReturnState;
  /** sale_item_id → units still returnable, for the lines that are present. */
  returnableMap: Map<string, number>;
}

export function saleReturnability(sale: Sale, existingReturns: SalesReturn[]): SaleReturnability {
  if (sale.items.length === 0) {
    return { state: "unavailable", returnableMap: new Map<string, number>() };
  }

  const returnableMap = getRemainingReturnableQuantities(sale, existingReturns);
  for (const remaining of returnableMap.values()) {
    if (remaining > 0) return { state: "returnable", returnableMap };
  }
  return { state: "fully-returned", returnableMap };
}
