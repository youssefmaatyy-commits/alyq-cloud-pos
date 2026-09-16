import type { Sale } from "@/modules/pos/types";
import type { ReturnItemInput, SalesReturn, RefundRecord } from "./types";
import { round2 } from "@/modules/pos/services/posMath";

export interface ItemReturnValidation {
  sale_item_id: string;
  product_id: string;
  name_ar: string;
  name_en: string;
  sku: string;
  barcode: string | null;
  unit_price: number;
  sold_quantity: number;
  previously_returned: number;
  returnable_quantity: number;
  requested_quantity: number;
  line_total: number;
}

export interface ReturnValidationResult {
  valid: boolean;
  errors: Record<string, string>;
  items: ItemReturnValidation[];
  calculatedRefundAmount: number;
  remainingRefundable: number;
}

export const MAX_RETURN_REASON_LENGTH = 300;

export function getRemainingReturnableQuantities(
  sale: Sale,
  existingReturns: SalesReturn[],
): Map<string, number> {
  // Map of sale_item_id -> returned count.
  //
  // A REJECTED return is a cancelled return: its goods were written back out
  // when the refund was rejected (pos_settle_refund, migration 0041 — the
  // demo repository mirrors the same), so it must not hold the quantity.
  // Pending and completed both hold it: in both states the goods are on the
  // shelf, and counting a rejected row here is what made a rejected return
  // permanently block every further one.
  const returnedCounts = new Map<string, number>();
  for (const ret of existingReturns) {
    if (ret.sale_id !== sale.id) continue;
    if (ret.refund_status === "rejected") continue;
    for (const item of ret.items) {
      const prev = returnedCounts.get(item.sale_item_id) ?? 0;
      returnedCounts.set(item.sale_item_id, prev + item.quantity);
    }
  }

  const returnableMap = new Map<string, number>();
  for (const item of sale.items) {
    const alreadyReturned = returnedCounts.get(item.id) ?? 0;
    const remaining = Math.max(0, item.quantity - alreadyReturned);
    returnableMap.set(item.id, remaining);
  }
  return returnableMap;
}

export function getTotalRefundedForSale(sale: Sale, refunds: RefundRecord[]): number {
  // Same rule as the database (pos_process_return, 0016): a rejected refund
  // never moved money, so it does not consume the sale's refundable balance —
  // pending and completed both do.
  let sum = 0;
  for (const ref of refunds) {
    if (ref.sale_id === sale.id && ref.status !== "rejected") {
      sum += ref.amount;
    }
  }
  return round2(sum);
}

export function validateReturnDraft(
  sale: Sale,
  itemsToReturn: ReturnItemInput[],
  reason: string,
  refundMethod: string,
  existingReturns: SalesReturn[],
  existingRefunds: RefundRecord[],
): ReturnValidationResult {
  const errors: Record<string, string> = {};
  const returnableMap = getRemainingReturnableQuantities(sale, existingReturns);

  if (sale.status === "voided") {
    errors.sale = "Sale is voided and cannot be returned";
  }

  const cleanReason = reason.trim();
  if (!cleanReason) {
    errors.reason = "reasonRequired";
  } else if (cleanReason.length > MAX_RETURN_REASON_LENGTH) {
    errors.reason = "reasonTooLong";
  }

  if (refundMethod !== "cash" && refundMethod !== "visa" && refundMethod !== "instapay") {
    errors.refund_method = "invalidMethod";
  }

  const itemValidations: ItemReturnValidation[] = [];
  let totalRefund = 0;
  let activeReturnCount = 0;

  for (const input of itemsToReturn) {
    const saleItem = sale.items.find((i) => i.id === input.sale_item_id);
    if (!saleItem) continue;

    const returnable = returnableMap.get(saleItem.id) ?? 0;
    const qty = Math.trunc(input.quantity || 0);

    if (qty > 0) {
      activeReturnCount++;
    }

    if (qty < 0) {
      errors[`item_${saleItem.id}`] = "qtyPositive";
    } else if (qty > returnable) {
      errors[`item_${saleItem.id}`] = "qtyExceedsSold";
    }

    const itemRefund = round2(saleItem.unit_price * qty);
    totalRefund += itemRefund;

    itemValidations.push({
      sale_item_id: saleItem.id,
      product_id: saleItem.product_id,
      name_ar: saleItem.name_ar,
      name_en: saleItem.name_en,
      sku: saleItem.sku,
      barcode: saleItem.barcode,
      unit_price: saleItem.unit_price,
      sold_quantity: saleItem.quantity,
      previously_returned: saleItem.quantity - returnable,
      returnable_quantity: returnable,
      requested_quantity: qty,
      line_total: itemRefund,
    });
  }

  if (activeReturnCount === 0) {
    errors.items = "noItemsSelected";
  }

  const previouslyRefunded = getTotalRefundedForSale(sale, existingRefunds);
  const remainingRefundable = round2(Math.max(0, sale.total - previouslyRefunded));

  // Cap refund amount so it does not exceed remaining refundable amount on the sale
  const calculatedRefundAmount = round2(Math.min(totalRefund, remainingRefundable));

  if (totalRefund > remainingRefundable) {
    errors.refund = "exceedsSaleError";
  }

  return {
    valid: Object.keys(errors).length === 0,
    errors,
    items: itemValidations,
    calculatedRefundAmount,
    remainingRefundable,
  };
}
