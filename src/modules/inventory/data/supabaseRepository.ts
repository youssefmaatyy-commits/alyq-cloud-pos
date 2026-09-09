import type { Product, ProductPatch } from "@/modules/products/types";
import { AppError, toAppError } from "@/modules/products/data/repository";
import type { StockMovement } from "../types";
import type { AdjustStockArgs, InventoryRepository } from "./repository";
import { signedDelta } from "../types";
import { getSupabaseClient } from "@/lib/supabase/client";

interface MovementRow {
  id: string;
  product_id: string;
  delta: number;
  quantity_before: number;
  quantity_after: number;
  type: string;
  reason: string;
  notes: string | null;
  user_id: string;
  user_name: string;
  created_at: string;
}

function toNumber(value: number | string | null | undefined): number {
  if (typeof value === "number") return value;
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function mapMovement(row: MovementRow): StockMovement {
  return {
    id: row.id,
    product_id: row.product_id,
    delta: toNumber(row.delta),
    quantity_before: toNumber(row.quantity_before),
    quantity_after: toNumber(row.quantity_after),
    type: row.type as StockMovement["type"],
    reason: row.reason as StockMovement["reason"],
    notes: row.notes ?? null,
    user_id: row.user_id,
    user_name: row.user_name,
    created_at: row.created_at,
  };
}

const PRODUCTS_SELECT = "id, sku, name_en, name_ar, stock_quantity, stock_tracking_enabled";
const MOVEMENTS_SELECT = "*";

/**
 * Live Supabase repository. The intended production behaviour is:
 *   1. insert the movement row (audit trail durable)
 *   2. update `products.stock_quantity` (with `WHERE stock_quantity = $expected`
 *      for optimistic concurrency, coming in Phase 4+)
 * For now the two writes are sequenced client-side; a future migration can
 * wrap them in a Postgres RPC (`adjust_stock`).
 */
export class SupabaseInventoryRepository implements InventoryRepository {
  readonly kind = "supabase" as const;

  async listProducts(): Promise<Product[]> {
    const client = getSupabaseClient();
    if (!client) throw new AppError("NOT_CONFIGURED");
    const { data, error } = await client.from("products").select(PRODUCTS_SELECT);
    if (error) throw toAppError(error);
    return (data as Product[] | null) ?? [];
  }

  async updateProductStock(productId: string, patch: ProductPatch): Promise<Product> {
    const client = getSupabaseClient();
    if (!client) throw new AppError("NOT_CONFIGURED");
    const { data, error } = await client
      .from("products")
      .update(patch)
      .eq("id", productId)
      .select(PRODUCTS_SELECT)
      .single();
    if (error) throw toAppError(error);
    return data as Product;
  }

  async listMovements(): Promise<StockMovement[]> {
    const client = getSupabaseClient();
    if (!client) throw new AppError("NOT_CONFIGURED");
    const { data, error } = await client
      .from("stock_movements")
      .select(MOVEMENTS_SELECT)
      .order("created_at", { ascending: false });
    if (error) throw toAppError(error);
    return (data as MovementRow[] | null ?? []).map(mapMovement);
  }

  async listMovementsForProduct(productId: string): Promise<StockMovement[]> {
    const client = getSupabaseClient();
    if (!client) throw new AppError("NOT_CONFIGURED");
    const { data, error } = await client
      .from("stock_movements")
      .select(MOVEMENTS_SELECT)
      .eq("product_id", productId)
      .order("created_at", { ascending: false });
    if (error) throw toAppError(error);
    return (data as MovementRow[] | null ?? []).map(mapMovement);
  }

  async recordMovement(input: Omit<StockMovement, "id" | "created_at" | "quantity_before" | "quantity_after">): Promise<StockMovement> {
    const client = getSupabaseClient();
    if (!client) throw new AppError("NOT_CONFIGURED");
    const { data, error } = await client
      .from("stock_movements")
      .insert({
        product_id: input.product_id,
        delta: input.delta,
        quantity_before: 0,
        quantity_after: 0,
        type: input.type,
        reason: input.reason,
        notes: input.notes,
        user_id: input.user_id,
        user_name: input.user_name,
      })
      .select(MOVEMENTS_SELECT)
      .single();
    if (error) throw toAppError(error);
    return mapMovement(data as MovementRow);
  }
}

let singleton: SupabaseInventoryRepository | null = null;
export function getSupabaseInventoryRepository(): SupabaseInventoryRepository {
  if (!singleton) singleton = new SupabaseInventoryRepository();
  return singleton;
}

/**
 * Two-step live adjustment. The movement is inserted first; if the subsequent
 * stock update fails we re-raise so the caller can decide to roll back.
 */
export async function applySupabaseAdjustment(
  args: AdjustStockArgs,
  products: Product[],
  repo = getSupabaseInventoryRepository(),
): Promise<{ product: Product; movement: StockMovement }> {
  const current = products.find((p) => p.id === args.productId);
  if (!current) throw new AppError("NOT_FOUND");
  if (!current.stock_tracking_enabled) {
    throw new AppError("VALIDATION", "Stock tracking is disabled for this product", "quantity");
  }
  const quantityBefore = current.stock_quantity;
  const newQty = Math.max(0, quantityBefore + signedDelta(args.type, args.quantity));

  const movement = await repo.recordMovement({
    product_id: current.id,
    delta: args.quantity,
    type: args.type,
    reason: args.reason,
    notes: args.notes,
    user_id: args.userId,
    user_name: args.userName,
  });

  // Patch the just-inserted row with the snapshot (Supabase has no RETURNING
  // trick here, so we update by id). Single round-trip.
  const client = getSupabaseClient();
  if (client) {
    const { error: patchErr } = await client
      .from("stock_movements")
      .update({ quantity_before: quantityBefore, quantity_after: newQty })
      .eq("id", movement.id);
    if (patchErr) throw toAppError(patchErr);
  }

  const product = await repo.updateProductStock(current.id, { stock_quantity: newQty });
  return {
    product,
    movement: { ...movement, quantity_before: quantityBefore, quantity_after: newQty },
  };
}
