import { getSupabaseClient } from "@/lib/supabase/client";
import { AppError, toAppError } from "@/modules/products/data/repository";
import type { CreateReturnInput, RefundRecord, ReturnItem, SalesReturn } from "../types";
import type { ReturnRepository } from "./repository";

interface ReturnRow {
  id: string;
  return_number: string;
  sale_id: string;
  sale_number: string;
  customer_id: string | null;
  customer_name: string | null;
  reason: string;
  refund_amount: number | string;
  refund_method: "cash" | "visa" | "instapay";
  refund_status: "completed" | "pending";
  user_id: string;
  user_name: string;
  created_at: string;
}

interface ReturnItemRow {
  id: string;
  return_id: string;
  sale_item_id: string;
  product_id: string;
  name_ar: string;
  name_en: string;
  sku: string;
  barcode: string | null;
  unit_price: number | string;
  quantity: number;
  line_total: number | string;
}

interface RefundRow {
  id: string;
  refund_number: string;
  sale_id: string;
  sale_number: string;
  return_id: string | null;
  amount: number | string;
  payment_method: "cash" | "visa" | "instapay";
  status: "completed" | "pending";
  reason: string | null;
  user_id: string;
  user_name: string;
  created_at: string;
}

function toNumber(value: number | string | null | undefined): number {
  if (typeof value === "number") return value;
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function mapReturn(row: ReturnRow, items: ReturnItemRow[] = []): SalesReturn {
  return {
    id: row.id,
    return_number: row.return_number,
    sale_id: row.sale_id,
    sale_number: row.sale_number,
    customer_id: row.customer_id,
    customer_name: row.customer_name,
    reason: row.reason,
    refund_amount: toNumber(row.refund_amount),
    refund_method: row.refund_method,
    refund_status: row.refund_status,
    user_id: row.user_id,
    user_name: row.user_name,
    created_at: row.created_at,
    items: items.map((i) => ({
      id: i.id,
      return_id: i.return_id,
      sale_item_id: i.sale_item_id,
      product_id: i.product_id,
      name_ar: i.name_ar,
      name_en: i.name_en,
      sku: i.sku,
      barcode: i.barcode,
      unit_price: toNumber(i.unit_price),
      quantity: i.quantity,
      line_total: toNumber(i.line_total),
    })),
  };
}

function mapRefund(row: RefundRow): RefundRecord {
  return {
    id: row.id,
    refund_number: row.refund_number,
    sale_id: row.sale_id,
    sale_number: row.sale_number,
    return_id: row.return_id,
    amount: toNumber(row.amount),
    payment_method: row.payment_method,
    status: row.status,
    reason: row.reason,
    user_id: row.user_id,
    user_name: row.user_name,
    created_at: row.created_at,
  };
}

export class SupabaseReturnRepository implements ReturnRepository {
  readonly kind = "supabase" as const;

  private require() {
    const client = getSupabaseClient();
    if (!client) throw new AppError("NOT_CONFIGURED");
    return client;
  }

  async listReturns(): Promise<SalesReturn[]> {
    try {
      const client = this.require();
      const { data: returnsData, error } = await client
        .from("sales_returns")
        .select("*")
        .order("created_at", { ascending: false });
      if (error) throw toAppError(error);

      const returnsList = (returnsData as ReturnRow[]) ?? [];
      const { data: itemsData, error: itemsError } = await client
        .from("return_items")
        .select("*");
      if (itemsError) throw toAppError(itemsError);

      const itemsByReturn = new Map<string, ReturnItemRow[]>();
      for (const item of (itemsData as ReturnItemRow[]) ?? []) {
        const prev = itemsByReturn.get(item.return_id) ?? [];
        prev.push(item);
        itemsByReturn.set(item.return_id, prev);
      }

      return returnsList.map((row) => mapReturn(row, itemsByReturn.get(row.id) ?? []));
    } catch (err) {
      if (err instanceof AppError) throw err;
      throw toAppError(err);
    }
  }

  async getReturn(id: string): Promise<SalesReturn> {
    try {
      const client = this.require();
      const { data: returnData, error } = await client
        .from("sales_returns")
        .select("*")
        .eq("id", id)
        .single();
      if (error) throw toAppError(error);

      const { data: itemsData, error: itemsError } = await client
        .from("return_items")
        .select("*")
        .eq("return_id", id);
      if (itemsError) throw toAppError(itemsError);

      return mapReturn(returnData as ReturnRow, (itemsData as ReturnItemRow[]) ?? []);
    } catch (err) {
      if (err instanceof AppError) throw err;
      throw toAppError(err);
    }
  }

  async createReturn(
    input: CreateReturnInput,
  ): Promise<{ returnRecord: SalesReturn; refundRecord: RefundRecord }> {
    try {
      const client = this.require();
      const { data, error } = await client.rpc("pos_process_return", {
        p_payload: {
          sale_id: input.sale_id,
          reason: input.reason.trim(),
          refund_method: input.refund_method,
          refund_status: input.refund_status ?? "completed",
          items: input.items,
          user_id: input.user_id,
          user_name: input.user_name,
        },
      });
      if (error) throw toAppError(error);

      const res = data as { return_id: string; refund_id: string };
      const returnRecord = await this.getReturn(res.return_id);
      const { data: refData, error: refError } = await client
        .from("refund_records")
        .select("*")
        .eq("id", res.refund_id)
        .single();
      if (refError) throw toAppError(refError);

      return {
        returnRecord,
        refundRecord: mapRefund(refData as RefundRow),
      };
    } catch (err) {
      if (err instanceof AppError) throw err;
      throw toAppError(err);
    }
  }

  async listRefunds(): Promise<RefundRecord[]> {
    try {
      const client = this.require();
      const { data, error } = await client
        .from("refund_records")
        .select("*")
        .order("created_at", { ascending: false });
      if (error) throw toAppError(error);
      return ((data as RefundRow[]) ?? []).map(mapRefund);
    } catch (err) {
      if (err instanceof AppError) throw err;
      throw toAppError(err);
    }
  }

  async getRefundsForSale(saleId: string): Promise<RefundRecord[]> {
    try {
      const client = this.require();
      const { data, error } = await client
        .from("refund_records")
        .select("*")
        .eq("sale_id", saleId)
        .order("created_at", { ascending: false });
      if (error) throw toAppError(error);
      return ((data as RefundRow[]) ?? []).map(mapRefund);
    } catch (err) {
      if (err instanceof AppError) throw err;
      throw toAppError(err);
    }
  }
}

let singleton: SupabaseReturnRepository | null = null;
export function getSupabaseReturnRepository(): SupabaseReturnRepository {
  if (!singleton) singleton = new SupabaseReturnRepository();
  return singleton;
}

export type { ReturnItem };
