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
import type { SalesRepository } from "./repository";

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
  name_ar: string;
  name_en: string;
  sku: string;
  barcode: string | null;
  unit_price: number | string;
  quantity: number;
  line_total: number | string;
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
    total: toNumber(row.total),
    amount_received: row.amount_received == null ? null : toNumber(row.amount_received),
    change: row.change == null ? null : toNumber(row.change),
    user_id: row.user_id,
    user_name: row.user_name,
    items: items.map((i) => ({
      id: i.id,
      sale_id: i.sale_id,
      product_id: i.product_id,
      name_ar: i.name_ar,
      name_en: i.name_en,
      sku: i.sku,
      barcode: i.barcode,
      unit_price: toNumber(i.unit_price),
      quantity: i.quantity,
      line_total: toNumber(i.line_total),
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

  private require() {
    const client = getSupabaseClient();
    if (!client) throw new AppError("NOT_CONFIGURED");
    return client;
  }

  async completeSale(input: CompleteSaleInput): Promise<Sale> {
    try {
      const client = this.require();
      const { data, error } = await client.rpc("pos_complete_sale", {
        p_payload: {
          client_ref: input.client_ref,
          lines: input.lines,
          discount_type: input.discount_type,
          discount_value: input.discount_value,
          payments: input.payments,
          customer_id: input.customer_id ?? null,
          customer_name: input.customer_name ?? null,
          customer_phone: input.customer_phone ?? null,
          user_id: input.user_id,
          user_name: input.user_name,
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

  async listSales(): Promise<Sale[]> {
    try {
      const client = this.require();
      const { data, error } = await client
        .from("sales")
        .select("*")
        .order("created_at", { ascending: false });
      if (error) throw toAppError(error);
      const sales = (data as SaleRow[] | null) ?? [];

      const { data: payments, error: payError } = await client
        .from("sale_payments")
        .select("*")
        .order("created_at", { ascending: true });
      if (payError) throw toAppError(payError);
      const paymentsBySale = new Map<string, SalePaymentRow[]>();
      for (const p of (payments as SalePaymentRow[] | null) ?? []) {
        const list = paymentsBySale.get(p.sale_id) ?? [];
        list.push(p);
        paymentsBySale.set(p.sale_id, list);
      }

      return sales.map((row) => mapSale(row, [], paymentsBySale.get(row.id) ?? []));
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw toAppError(error);
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
