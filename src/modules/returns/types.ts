/**
 * Returns & Refunds module — domain types (Phase 7; refund lifecycle in Phase 13).
 */

export type RefundMethod = "cash" | "visa" | "instapay";

/**
 * The refund lifecycle (Phase 13, requirement 3). Mirrors the Postgres
 * `refund_status` enum extended by migration 0016: a refund is born pending or
 * completed, is settled once, and a settled refund never moves again.
 */
export const REFUND_STATUSES = ["pending", "completed", "rejected"] as const;
export type RefundStatus = (typeof REFUND_STATUSES)[number];

/** The two ways an approver can finish a pending refund. */
export type RefundDecision = "completed" | "rejected";

/** Who settles a refund, and what they wrote on it. */
export interface SettleRefundInput {
  decision: RefundDecision;
  /** Required for a rejection — the reason recorded against the refusal. */
  reason: string | null;
  user_id: string;
  user_name: string;
}

/** The outcome of a settlement attempt. */
export interface SettleRefundResult {
  refund: RefundRecord;
  /** True when the refund had already been settled in the same direction. */
  alreadySettled: boolean;
}

export interface ReturnItem {
  id: string;
  return_id: string;
  sale_item_id: string;
  product_id: string;
  name_ar: string;
  name_en: string;
  sku: string;
  barcode: string | null;
  unit_price: number;
  quantity: number;
  line_total: number;
}

export interface SalesReturn {
  id: string;
  return_number: string;
  sale_id: string;
  sale_number: string;
  customer_id: string | null;
  customer_name: string | null;
  reason: string;
  refund_amount: number;
  refund_method: RefundMethod;
  refund_status: RefundStatus;
  user_id: string;
  user_name: string;
  items: ReturnItem[];
  created_at: string;
}

export interface RefundRecord {
  id: string;
  refund_number: string;
  sale_id: string;
  sale_number: string;
  return_id: string | null;
  amount: number;
  payment_method: RefundMethod;
  status: RefundStatus;
  reason: string | null;
  user_id: string;
  user_name: string;
  created_at: string;
  // Settlement trail (Phase 13, requirement 3): who finished it, when, and —
  // for a refusal — why. Never rewritten once set.
  rejection_reason: string | null;
  settled_at: string | null;
  settled_by: string | null;
  settled_by_name: string | null;
}

export interface ReturnItemInput {
  sale_item_id: string;
  product_id: string;
  quantity: number;
}

export interface CreateReturnInput {
  sale_id: string;
  reason: string;
  refund_method: RefundMethod;
  refund_status?: RefundStatus;
  items: ReturnItemInput[];
  user_id: string;
  user_name: string;
}

export interface ReturnFiltersValue {
  search: string;
}

export const EMPTY_RETURN_FILTERS: ReturnFiltersValue = {
  search: "",
};
