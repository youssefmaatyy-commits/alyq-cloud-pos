import { getSupabaseClient } from "@/lib/supabase/client";
import { AppError, toAppError } from "@/modules/products/data/repository";

export interface StockTransfer {
  id: string;
  client_ref: string;
  reference: string;
  source_branch_id: string;
  destination_branch_id: string;
  product_id: string;
  variant_id: string | null;
  quantity: number;
  reason: string | null;
  status: "completed";
  initiated_by: string;
  initiated_by_name: string;
  created_at: string;
  completed_at: string;
}

export interface TransferStockInput {
  clientRef: string;
  destinationBranchId: string;
  productId: string;
  variantId: string | null;
  quantity: number;
  reason: string | null;
}

interface TransferEnvelope {
  ok?: boolean;
  replayed?: boolean;
  transfer?: StockTransfer;
}

/** Calls the one atomic server operation; source branch comes from the session. */
export async function transferSupabaseStock(
  input: TransferStockInput,
): Promise<{ transfer: StockTransfer; replayed: boolean }> {
  const client = getSupabaseClient();
  if (!client) throw new AppError("NOT_CONFIGURED");
  const { data, error } = await client.rpc("inventory_transfer_stock", {
    p_client_ref: input.clientRef,
    p_destination_branch_id: input.destinationBranchId,
    p_product_id: input.productId,
    p_variant_id: input.variantId,
    p_quantity: Math.trunc(input.quantity),
    p_reason: input.reason,
  });
  if (error) throw toAppError(error);
  const result = data as TransferEnvelope | null;
  if (!result?.ok || !result.transfer) {
    throw new AppError("DB", "The authoritative transfer returned no transfer record");
  }
  return { transfer: result.transfer, replayed: Boolean(result.replayed) };
}

export async function listSupabaseTransfers(limit = 8): Promise<StockTransfer[]> {
  const client = getSupabaseClient();
  if (!client) throw new AppError("NOT_CONFIGURED");
  const { data, error } = await client
    .from("stock_transfers")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(Math.max(1, Math.min(Math.trunc(limit), 50)));
  if (error) throw toAppError(error);
  return (data as StockTransfer[] | null) ?? [];
}
