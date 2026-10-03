import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseClient } from "@/lib/supabase/client";
import { AppError, toAppError } from "@/modules/products/data/repository";
import type {
  CompleteSaleInput,
  ConfirmPaymentInput,
  Sale,
  SaleItem,
  SalePayment,
  VoidSaleInput,
} from "../types";
import type { SaleListQuery, SalesRepository } from "./repository";
import { SALES_ROW_CAP } from "./repository";

interface SaleRow {
  id: string;
  sale_number: string;
  client_ref: string;
  status: Sale["status"];
  payment_method: Sale["payment_method"];
  payment_status: Sale["payment_status"];
  subtotal: number | string;
  discount_type: Sale["discount_type"];
  discount_value: number | string;
  discount_amount: number | string;
  item_discount_amount?: number | string | null;
  total_discount_amount?: number | string | null;
  automatic_discount_amount?: number | string | null;
  automatic_promotion_id?: string | null;
  automatic_promotion_name?: string | null;
  promotion_rule_type?: string | null;
  promotion_buy_x?: number | string | null;
  promotion_get_y?: number | string | null;
  promotion_reward_qty?: number | string | null;
  promotion_rewarded_units?: unknown;
  total: number | string;
  amount_received: number | string | null;
  change: number | string | null;
  user_id: string;
  user_name: string;
  customer_id?: string | null;
  customer_name?: string | null;
  customer_phone?: string | null;
  created_at: string;
  voided_at: string | null;
  void_reason: string | null;
  paid_at: string | null;
  paid_by: string | null;
  paid_by_name: string | null;
  /** Frozen originating branch (migration 0071). */
  branch_id?: string | null;
  /** Present from migration 0017 onward; older rows simply lack it. */
  source?: Sale["source"] | null;
  /** The open shift the till sale was completed under (migration 0040). */
  shift_id?: string | null;
  notes?: string | null;
}

interface SalePaymentRow {
  id: string;
  sale_id: string;
  method: SalePayment["method"];
  amount: number | string;
  status: SalePayment["status"];
  paid_at: string | null;
  paid_by: string | null;
  paid_by_name: string | null;
}

interface SaleItemRow {
  id: string;
  sale_id: string;
  product_id: string;
  variant_id: string | null;
  variant_color_ar: string | null;
  variant_color_en: string | null;
  variant_size: number | string | null;
  variant_size_label?: string | null;
  name_ar: string;
  name_en: string;
  sku: string;
  barcode: string | null;
  unit_price: number | string;
  quantity: number;
  line_total: number | string;
  refundable_total?: number | string | null;
  gross_total?: number | string | null;
  discount_type?: SaleItem["discount_type"] | null;
  discount_value?: number | string | null;
  discount_amount?: number | string | null;
  automatic_promotion_id?: string | null;
  automatic_promotion_name?: string | null;
  automatic_discount_amount?: number | string | null;
  rewarded_qty?: number | string | null;
  promotion_rule_type?: string | null;
  /** Present from migration 0055 onward; older rows are null (unknown cost). */
  unit_cost?: number | string | null;
}

function toNumber(value: number | string | null | undefined): number {
  if (typeof value === "number") return value;
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function mapPayment(row: SalePaymentRow): SalePayment {
  return {
    id: row.id,
    sale_id: row.sale_id,
    method: row.method,
    amount: toNumber(row.amount),
    status: row.status,
    paid_at: row.paid_at ?? null,
    paid_by: row.paid_by ?? null,
    paid_by_name: row.paid_by_name ?? null,
  };
}

function mapSale(row: SaleRow, items: SaleItemRow[] = [], payments: SalePaymentRow[] = []): Sale {
  return {
    id: row.id,
    sale_number: row.sale_number,
    client_ref: row.client_ref,
    status: row.status,
    payment_method: row.payment_method,
    payment_status: row.payment_status,
    subtotal: toNumber(row.subtotal),
    discount_type: row.discount_type,
    discount_value: toNumber(row.discount_value),
    discount_amount: toNumber(row.discount_amount),
    item_discount_amount: row.item_discount_amount == null ? undefined : toNumber(row.item_discount_amount),
    total_discount_amount: row.total_discount_amount == null ? undefined : toNumber(row.total_discount_amount),
    automatic_discount_amount: row.automatic_discount_amount == null ? undefined : toNumber(row.automatic_discount_amount),
    automatic_promotion_id: row.automatic_promotion_id ?? null,
    automatic_promotion_name: row.automatic_promotion_name ?? null,
    promotion_rule_type: row.promotion_rule_type ?? null,
    promotion_buy_x: row.promotion_buy_x == null ? null : toNumber(row.promotion_buy_x),
    promotion_get_y: row.promotion_get_y == null ? null : toNumber(row.promotion_get_y),
    promotion_reward_qty: row.promotion_reward_qty == null ? null : toNumber(row.promotion_reward_qty),
    promotion_rewarded_units: row.promotion_rewarded_units ?? [],
    total: toNumber(row.total),
    amount_received: row.amount_received == null ? null : toNumber(row.amount_received),
    change: row.change == null ? null : toNumber(row.change),
    user_id: row.user_id,
    user_name: row.user_name,
    items: items.map((i) => ({
      id: i.id,
      sale_id: i.sale_id,
      product_id: i.product_id,
      // Phase 43: the exact combination sold, with the colour and size frozen at
      // sale time — a renamed or archived variant still reads on this invoice.
      variant_id: i.variant_id ?? null,
      variant_color_ar: i.variant_color_ar ?? null,
      variant_color_en: i.variant_color_en ?? null,
      variant_size:
        i.variant_size === null || i.variant_size === undefined ? null : toNumber(i.variant_size),
      variant_size_label: i.variant_size_label ?? null,
      name_ar: i.name_ar,
      name_en: i.name_en,
      sku: i.sku,
      barcode: i.barcode,
      unit_price: toNumber(i.unit_price),
      quantity: i.quantity,
      gross_total: i.gross_total == null ? undefined : toNumber(i.gross_total),
      line_total: toNumber(i.line_total),
      refundable_total: i.refundable_total == null ? null : toNumber(i.refundable_total),
      discount_type: i.discount_type ?? "none",
      discount_value: i.discount_value == null ? 0 : toNumber(i.discount_value),
      discount_amount: i.discount_amount == null ? 0 : toNumber(i.discount_amount),
      automatic_promotion_id: i.automatic_promotion_id ?? null,
      automatic_promotion_name: i.automatic_promotion_name ?? null,
      automatic_discount_amount: i.automatic_discount_amount == null ? 0 : toNumber(i.automatic_discount_amount),
      rewarded_qty: i.rewarded_qty == null ? 0 : toNumber(i.rewarded_qty),
      promotion_rule_type: i.promotion_rule_type ?? null,
      unit_cost: i.unit_cost == null ? null : toNumber(i.unit_cost),
    })),
    payments: payments.map(mapPayment),
    customer_id: row.customer_id ?? null,
    customer_name: row.customer_name ?? null,
    customer_phone: row.customer_phone ?? null,
    created_at: row.created_at,
    voided_at: row.voided_at,
    void_reason: row.void_reason,
    paid_at: row.paid_at ?? null,
    paid_by: row.paid_by ?? null,
    paid_by_name: row.paid_by_name ?? null,
    branch_id: row.branch_id ?? null,
    source: row.source ?? "pos",
    shift_id: row.shift_id ?? null,
    notes: row.notes ?? null,
  };
}

/**
 * Live Supabase repository.
 *
 * Completion runs through the `pos_complete_sale` Postgres function (migration
 * 0007), which is a single transaction: it re-reads stock, recalculates
 * totals, inserts the sale + items, deducts stock and writes the stock
 * movements — all or nothing. The client never trusts its own totals.
 */
export class SupabaseSalesRepository implements SalesRepository {
  readonly kind = "supabase" as const;

  /**
   * Injectable so the contract test can drive this class against a stub client —
   * CI has no reachable Supabase project, so the live read path would otherwise
   * be unverified code. Production never passes one: `getSupabaseSalesRepository()`
   * builds the singleton, which takes the shared client.
   */
  constructor(private readonly injected: SupabaseClient | null = null) {}

  private require() {
    const client = this.injected ?? getSupabaseClient();
    if (!client) throw new AppError("NOT_CONFIGURED");
    return client;
  }

  async completeSale(input: CompleteSaleInput, approvalRequestId?: string | null): Promise<Sale> {
    try {
      const client = this.require();
      const { data, error } = await client.rpc("pos_complete_sale", {
        // Migration 0035: an over-limit discount is refused unless a real,
        // approved, unspent request stands behind it. Validated in the database,
        // spent in the same transaction as the sale it produced.
        p_approval_request_id: approvalRequestId ?? null,
        p_payload: {
          client_ref: input.client_ref,
          lines: input.lines,
          discount_type: input.discount_type,
          discount_value: input.discount_value,
          coupon_code: input.coupon_code ?? input.promo_code ?? null,
          promo_code: input.promo_code ?? input.coupon_code ?? null,
          payments: input.payments,
          customer_id: input.customer_id ?? null,
          customer_name: input.customer_name ?? null,
          customer_phone: input.customer_phone ?? null,
          notes: input.notes?.trim() || null,
          user_id: input.user_id,
          user_name: input.user_name,
          source: input.source ?? "pos",
        },
      });
      if (error) throw toAppError(error);
      const saleId = (data as { sale_id?: string } | null)?.sale_id;
      if (!saleId) throw new AppError("DB", "Sale id missing from response");
      return this.getSale(saleId);
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw toAppError(error);
    }
  }

  async listSales(query: SaleListQuery = {}): Promise<Sale[]> {
    try {
      const client = this.require();
      let salesQuery = client
        .from("sales")
        .select("*")
        .order("created_at", { ascending: false });

      // Push the bounds into SQL rather than fetching history and filtering it
      // in the browser. An unbounded select stops at the project's row cap and
      // reports nothing about what it dropped.
      if (query.from) salesQuery = salesQuery.gte("created_at", query.from);
      if (query.to) salesQuery = salesQuery.lte("created_at", query.to);
      if (query.limit !== undefined || query.offset !== undefined) {
        const offset = Math.max(0, query.offset ?? 0);
        const limit = Math.max(1, query.limit ?? SALES_ROW_CAP);
        salesQuery = salesQuery.range(offset, offset + limit - 1);
      }

      const { data, error } = await salesQuery;
      if (error) throw toAppError(error);
      const sales = (data as SaleRow[] | null) ?? [];

      const pageIds = sales.map((row) => row.id);

      // Lines and payments are both scoped to the page's sales. The payments
      // query used to select every row ever written, on every refresh, no
      // matter how few sales were shown; `sale_items` was not fetched at all,
      // which is what made a list-mapped sale arrive with `items: []` — and an
      // empty item list is indistinguishable from "nothing left to return", so
      // the returns modal reported a brand-new invoice as fully returned
      // (Phase 27 regression). Both reads are bounded the same way.
      const itemsBySale = new Map<string, SaleItemRow[]>();
      const paymentsBySale = new Map<string, SalePaymentRow[]>();
      if (pageIds.length > 0) {
        const { data: items, error: itemsError } = await client
          .from("sale_items")
          .select("*")
          .in("sale_id", pageIds)
          .order("created_at", { ascending: true });
        if (itemsError) throw toAppError(itemsError);
        for (const i of (items as SaleItemRow[] | null) ?? []) {
          const list = itemsBySale.get(i.sale_id) ?? [];
          list.push(i);
          itemsBySale.set(i.sale_id, list);
        }

        const { data: payments, error: payError } = await client
          .from("sale_payments")
          .select("*")
          .in("sale_id", pageIds)
          .order("created_at", { ascending: true });
        if (payError) throw toAppError(payError);
        for (const p of (payments as SalePaymentRow[] | null) ?? []) {
          const list = paymentsBySale.get(p.sale_id) ?? [];
          list.push(p);
          paymentsBySale.set(p.sale_id, list);
        }
      }

      return sales.map((row) =>
        mapSale(row, itemsBySale.get(row.id) ?? [], paymentsBySale.get(row.id) ?? []),
      );
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw toAppError(error);
    }
  }

  async countSales(query: SaleListQuery = {}): Promise<number | null> {
    try {
      const client = this.require();
      let countQuery = client
        .from("sales")
        .select("id", { count: "exact", head: true });
      if (query.from) countQuery = countQuery.gte("created_at", query.from);
      if (query.to) countQuery = countQuery.lte("created_at", query.to);
      const { count, error } = await countQuery;
      if (error || typeof count !== "number") return null;
      return count;
    } catch {
      // A count refines the answer; it must never be able to fail the refresh.
      // null means "unknown", and callers report unknown as unknown.
      return null;
    }
  }

  async getSale(id: string): Promise<Sale> {
    try {
      const client = this.require();
      const { data: sale, error } = await client
        .from("sales")
        .select("*")
        .eq("id", id)
        .single();
      if (error) throw toAppError(error);
      const { data: items, error: itemsError } = await client
        .from("sale_items")
        .select("*")
        .eq("sale_id", id)
        .order("created_at", { ascending: true });
      if (itemsError) throw toAppError(itemsError);
      const { data: payments, error: paymentsError } = await client
        .from("sale_payments")
        .select("*")
        .eq("sale_id", id)
        .order("created_at", { ascending: true });
      if (paymentsError) throw toAppError(paymentsError);
      return mapSale(
        sale as SaleRow,
        (items as SaleItemRow[] | null) ?? [],
        (payments as SalePaymentRow[] | null) ?? [],
      );
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw toAppError(error);
    }
  }

  async confirmPayment(id: string, input: ConfirmPaymentInput): Promise<Sale> {
    try {
      const client = this.require();
      const { data, error } = await client.rpc("pos_confirm_payment", {
        p_sale_id: id,
        p_user_id: input.user_id,
        p_user_name: input.user_name,
      });
      if (error) throw toAppError(error);
      const saleId = (data as { sale_id?: string } | null)?.sale_id ?? id;
      return this.getSale(saleId);
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw toAppError(error);
    }
  }

  async voidSale(id: string, input: VoidSaleInput): Promise<Sale> {
    try {
      const client = this.require();
      const { data, error } = await client.rpc("pos_void_sale", {
        p_sale_id: id,
        p_user_id: input.user_id,
        p_user_name: input.user_name,
        p_reason: input.reason,
      });
      if (error) throw toAppError(error);
      const saleId = (data as { sale_id?: string } | null)?.sale_id ?? id;
      return this.getSale(saleId);
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw toAppError(error);
    }
  }
}

let singleton: SupabaseSalesRepository | null = null;
export function getSupabaseSalesRepository(): SupabaseSalesRepository {
  if (!singleton) singleton = new SupabaseSalesRepository();
  return singleton;
}

// Keep SaleItem import used in the mapped type position for future columns.
export type { SaleItem };
