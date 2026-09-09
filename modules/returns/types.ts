/**
 * Returns & Refunds module — domain types (Phase 7).
 */

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
  refund_method: "cash" | "visa" | "instapay";
  refund_status: "completed" | "pending";
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
  payment_method: "cash" | "visa" | "instapay";
  status: "completed" | "pending";
  reason: string | null;
  user_id: string;
  user_name: string;
  created_at: string;
}

export interface ReturnItemInput {
  sale_item_id: string;
  product_id: string;
  quantity: number;
}

export interface CreateReturnInput {
  sale_id: string;
  reason: string;
  refund_method: "cash" | "visa" | "instapay";
  refund_status?: "completed" | "pending";
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
