import { AppError } from "@/modules/products/data/repository";
import { stockStatus, type Product, type StockStatus } from "@/modules/products/types";
import { applyDemoAdjustment, applySupabaseAdjustment, getInventoryRepository } from "../data";
import { getCurrentUser } from "../permissions";
import type { StockMovement } from "../types";

/**
 * Inventory service: thin wrapper over the repository that enforces the
 * data-safety rule. Every change to `stock_quantity` must come through
 * `adjustStock`, which records a `StockMovement` first and refuses to write
 * a negative quantity.
 */

export interface InventoryAdjustmentResult {
  product: Product;
  movement: StockMovement;
  /** Re-derived status after the change so the UI doesn't have to recompute. */
  status: StockStatus;
}

export async function loadInventory(): Promise<{
  products: Product[];
  movements: StockMovement[];
}> {
  const repository = getInventoryRepository();
  const [products, movements] = await Promise.all([
    repository.listProducts(),
    repository.listMovements(),
  ]);
  return { products, movements };
}

export async function adjustStock(args: {
  productId: string;
  type: StockMovement["type"];
  reason: StockMovement["reason"];
  quantity: number;
  notes: string | null;
}): Promise<InventoryAdjustmentResult> {
  const user = getCurrentUser();
  const repository = getInventoryRepository();
  const products = await repository.listProducts();
  const adjustArgs = {
    productId: args.productId,
    type: args.type,
    reason: args.reason,
    quantity: Math.trunc(args.quantity),
    notes: args.notes,
    userId: user.id,
    userName: user.name,
  };

  const result =
    repository.kind === "supabase"
      ? await applySupabaseAdjustment(adjustArgs, products)
      : await applyDemoAdjustment(adjustArgs, products);

  // Hard guard — nothing in the pipeline should ever produce a negative qty.
  if (result.product.stock_quantity < 0) {
    throw new AppError("VALIDATION", "Stock cannot be negative", "quantity");
  }
  return { ...result, status: deriveStatus(result.product) };
}

/** Tiny re-derivation so the page can re-render badges without re-importing. */
function deriveStatus(
  product: Pick<Product, "stock_tracking_enabled" | "stock_quantity" | "low_stock_level">,
) {
  return stockStatus(product);
}
