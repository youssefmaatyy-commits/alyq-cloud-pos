import type { Sale } from "@/modules/pos/types";
import type { ReturnItemInput, SalesReturn, RefundRecord } from "./types";
import { round2 } from "@/modules/pos/services/posMath";

/**
 * What a returned unit refunds: the snapshot price when the sale came from a
 * discounted website order (matched on product + combination, first match —
 * duplicate lines can differ by a rounding piastre), else the invoice's list
 * price. Never negative, never NaN: a missing snapshot is list price, exactly
 * as before.
 */
export function paidUnitOf(
  saleItem: { product_id: string; variant_id?: string | null; unit_price: number },
  paidPrices?: readonly PaidUnitPrice[] | null,
): number {
  const list = Number(saleItem.unit_price) || 0;
  if (!paidPrices) return list;
  const match = paidPrices.find(
    (line) =>
      line.product_id === saleItem.product_id &&
      (line.variant_id ?? null) === (saleItem.variant_id ?? null) &&
      line.discounted_unit_price !== null &&
      Number.isFinite(line.discounted_unit_price),
  );
  if (!match || match.discounted_unit_price === null) return list;
  return Math.max(0, match.discounted_unit_price);
}

/** POS returns use the sold net line and allocate the invoice discount
 * proportionally, so a refund can never exceed what was actually paid. */
export function paidUnitOfSale(sale: Sale, saleItem: Sale["items"][number], paidPrices?: readonly PaidUnitPrice[] | null): number {
  if (paidPrices) return paidUnitOf(saleItem, paidPrices);
  const qty = Math.max(1, saleItem.quantity);
  const lineNet = Number.isFinite(saleItem.line_total) ? Math.max(0, saleItem.line_total) : saleItem.unit_price * qty;
  const base = sale.items.reduce((sum, item) => sum + Math.max(0, item.line_total), 0);
  const invoiceFactor = base > 0 ? Math.max(0, 1 - Math.min(Math.max(0, sale.discount_amount), base) / base) : 1;
  return round2((lineNet / qty) * invoiceFactor);
}

export interface ItemReturnValidation {
  sale_item_id: string;
  product_id: string;
  /** The exact combination that was sold (Phase 43), copied off the sale line. */
  variant_id: string | null;
  variant_color_ar: string | null;
  variant_color_en: string | null;
  variant_size: number | null;
  variant_size_label: string | null;
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

export interface PaidUnitPrice {
  product_id: string;
  variant_id: string | null;
  /** What the unit actually cost after every order-level discount. */
  discounted_unit_price: number | null;
}

export function validateReturnDraft(
  sale: Sale,
  itemsToReturn: ReturnItemInput[],
  reason: string,
  refundMethod: string,
  existingReturns: SalesReturn[],
  existingRefunds: RefundRecord[],
  /**
   * The originating website order's lines, when the sale came from one. A
   * discounted order's sale lines read at list price while its discount rides
   * as one fixed sale discount — refunding those lines at list would hand back
   * money the customer never paid, so the matching snapshot price wins.
   * Till sales and legacy rows pass nothing and refund at list, as before.
   */
  paidPrices?: readonly PaidUnitPrice[] | null,
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

    const itemRefund = round2(paidUnitOfSale(sale, saleItem, paidPrices) * qty);
    totalRefund += itemRefund;

    itemValidations.push({
      sale_item_id: saleItem.id,
      product_id: saleItem.product_id,
      // Straight off the sold line: the variant being returned is a fact about
      // the sale, not a choice made at the counter today.
      variant_id: saleItem.variant_id ?? null,
      variant_color_ar: saleItem.variant_color_ar ?? null,
      variant_color_en: saleItem.variant_color_en ?? null,
      variant_size: saleItem.variant_size ?? null,
      variant_size_label: saleItem.variant_size_label ?? null,
      name_ar: saleItem.name_ar,
      name_en: saleItem.name_en,
      sku: saleItem.sku,
      barcode: saleItem.barcode,
      unit_price: paidUnitOfSale(sale, saleItem, paidPrices),
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
