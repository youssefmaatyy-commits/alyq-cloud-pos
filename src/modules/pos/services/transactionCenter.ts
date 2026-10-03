import { getSupabaseClient, isSupabaseConfigured } from "@/lib/supabase/client";
import type { Sale, PaymentMethod, SaleStatus } from "../types";
import type { RefundRecord, RefundStatus, SalesReturn } from "@/modules/returns/types";
import { normalizeText } from "@/modules/products/services/productQuery";
import { AppError } from "@/modules/products/data/repository";

export interface TransactionLink {
  id: string;
  reference: string;
  status: RefundStatus;
  amount: number;
  created_at: string;
  return_id?: string | null;
  payment_method?: string;
  settled_at?: string | null;
}

export interface TransactionCenterRow {
  id: string;
  sale_number: string;
  client_ref: string;
  created_at: string;
  status: SaleStatus;
  payment_status: "paid" | "pending";
  subtotal: number;
  discount_amount: number;
  total: number;
  customer_id: string | null;
  customer_name: string | null;
  customer_phone: string | null;
  cashier_id: string;
  cashier_name: string;
  source: string;
  shift_id: string | null;
  branch_id: string | null;
  branch_code: string | null;
  branch_name_en: string | null;
  branch_name_ar: string | null;
  item_count: number;
  payment_methods: PaymentMethod[];
  returns: TransactionLink[];
  refunds: TransactionLink[];
  /** Only money actually settled; pending/rejected never enter this total. */
  completed_refund_total: number;
  pending_refund_total: number;
}

export interface TransactionCenterFilters {
  query: string;
  saleStatus: SaleStatus | "all";
  refundStatus: RefundStatus | "none" | "all";
  paymentMethod: PaymentMethod | "all";
  paymentStatus: "paid" | "pending" | "all";
  dateFrom: string;
  dateTo: string;
  cashier: string;
  page: number;
  pageSize: number;
}

export interface TransactionCenterResult {
  rows: TransactionCenterRow[];
  total: number;
  page: number;
  page_size: number;
  page_count: number;
  branch_id: string | null;
}

export const EMPTY_TRANSACTION_FILTERS: TransactionCenterFilters = {
  query: "",
  saleStatus: "all",
  refundStatus: "all",
  paymentMethod: "all",
  paymentStatus: "all",
  dateFrom: "",
  dateTo: "",
  cashier: "",
  page: 1,
  pageSize: 25,
};

interface DemoTransactionData {
  sales: readonly Sale[];
  returns: readonly SalesReturn[];
  refunds: readonly RefundRecord[];
}

function number(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeRow(row: TransactionCenterRow): TransactionCenterRow {
  return {
    ...row,
    subtotal: number(row.subtotal),
    discount_amount: number(row.discount_amount),
    total: number(row.total),
    item_count: number(row.item_count),
    completed_refund_total: number(row.completed_refund_total),
    pending_refund_total: number(row.pending_refund_total),
    payment_methods: row.payment_methods ?? [],
    returns: (row.returns ?? []).map((item) => ({ ...item, amount: number(item.amount) })),
    refunds: (row.refunds ?? []).map((item) => ({ ...item, amount: number(item.amount) })),
  };
}

/**
 * Live mode delegates every filter and page boundary to PostgreSQL. Demo mode
 * applies the same semantics over its intentionally small local ledger.
 */
export async function searchTransactionCenter(
  filters: TransactionCenterFilters,
  demo: DemoTransactionData,
): Promise<TransactionCenterResult> {
  const client = isSupabaseConfigured ? getSupabaseClient() : null;
  if (client) {
    const dateTo = filters.dateTo ? `${filters.dateTo}T23:59:59.999` : null;
    const { data, error } = await client.rpc("transaction_center_search", {
      p_query: filters.query.trim() || null,
      p_sale_status: filters.saleStatus,
      p_refund_status: filters.refundStatus,
      p_payment_method: filters.paymentMethod,
      p_payment_status: filters.paymentStatus,
      p_date_from: filters.dateFrom ? `${filters.dateFrom}T00:00:00.000` : null,
      p_date_to: dateTo,
      p_cashier: filters.cashier.trim() || null,
      p_page: filters.page,
      p_page_size: filters.pageSize,
    });
    if (error) throw new AppError("DB", error.message);
    const result = data as TransactionCenterResult | null;
    if (!result || !Array.isArray(result.rows)) throw new AppError("DB", "Transaction search returned an invalid response");
    return { ...result, rows: result.rows.map(normalizeRow) };
  }

  const query = normalizeText(filters.query);
  const cashier = normalizeText(filters.cashier);
  const from = filters.dateFrom ? new Date(`${filters.dateFrom}T00:00:00`).getTime() : null;
  const to = filters.dateTo ? new Date(`${filters.dateTo}T23:59:59.999`).getTime() : null;
  const rows = demo.sales
    .filter((sale) => filters.saleStatus === "all" || sale.status === filters.saleStatus)
    .map((sale): TransactionCenterRow => {
      const returns = demo.returns.filter((item) => item.sale_id === sale.id);
      const refunds = demo.refunds.filter((item) => item.sale_id === sale.id);
      return {
        id: sale.id,
        sale_number: sale.sale_number,
        client_ref: sale.client_ref,
        created_at: sale.created_at,
        status: sale.status,
        payment_status: sale.payment_status,
        subtotal: sale.subtotal,
        discount_amount: sale.discount_amount,
        total: sale.total,
        customer_id: sale.customer_id ?? null,
        customer_name: sale.customer_name ?? null,
        customer_phone: sale.customer_phone ?? null,
        cashier_id: sale.user_id,
        cashier_name: sale.user_name,
        source: sale.source ?? "pos",
        shift_id: sale.shift_id ?? null,
        branch_id: null,
        branch_code: null,
        branch_name_en: null,
        branch_name_ar: null,
        item_count: sale.items.reduce((sum, item) => sum + item.quantity, 0),
        payment_methods: [...new Set(sale.payments.map((payment) => payment.method))],
        returns: returns.map((item) => ({ id: item.id, reference: item.return_number, status: item.refund_status, amount: item.refund_amount, created_at: item.created_at })),
        refunds: refunds.map((item) => ({ id: item.id, reference: item.refund_number, return_id: item.return_id, status: item.status, amount: item.amount, payment_method: item.payment_method, created_at: item.created_at, settled_at: item.settled_at })),
        completed_refund_total: refunds.filter((item) => item.status === "completed").reduce((sum, item) => sum + item.amount, 0),
        pending_refund_total: refunds.filter((item) => item.status === "pending").reduce((sum, item) => sum + item.amount, 0),
      };
    })
    .filter((row) => {
      const at = Date.parse(row.created_at);
      if (from !== null && at < from) return false;
      if (to !== null && at > to) return false;
      if (cashier && !normalizeText(row.cashier_name).includes(cashier)) return false;
      if (filters.paymentMethod !== "all" && !row.payment_methods.includes(filters.paymentMethod) && !row.refunds.some((refund) => refund.payment_method === filters.paymentMethod)) return false;
      if (filters.paymentStatus !== "all" && row.payment_status !== filters.paymentStatus) return false;
      if (filters.refundStatus === "none" && row.refunds.length > 0) return false;
      if (filters.refundStatus !== "all" && filters.refundStatus !== "none" && !row.refunds.some((refund) => refund.status === filters.refundStatus)) return false;
      if (!query) return true;
      const sale = demo.sales.find((item) => item.id === row.id);
      return normalizeText([
        row.sale_number, row.client_ref, row.customer_name ?? "", row.customer_phone ?? "", row.cashier_name,
        row.returns.map((item) => item.reference).join(" "), row.refunds.map((item) => item.reference).join(" "),
        sale?.items.map((item) => `${item.name_ar} ${item.name_en} ${item.sku} ${item.barcode ?? ""}`).join(" ") ?? "",
      ].join(" ")).includes(query);
    })
    .sort((a, b) => b.created_at.localeCompare(a.created_at));

  const pageSize = Math.min(Math.max(filters.pageSize, 1), 100);
  const page = Math.max(filters.page, 1);
  return {
    rows: rows.slice((page - 1) * pageSize, page * pageSize),
    total: rows.length,
    page,
    page_size: pageSize,
    page_count: rows.length === 0 ? 0 : Math.ceil(rows.length / pageSize),
    branch_id: null,
  };
}
