import type { Product, ProductPatch } from "@/modules/products/types";
import { AppError } from "@/modules/products/data/repository";
import type { NewStockMovement, StockMovement, StockMovementType, StockReason } from "../types";

/**
 * Persistence contract for the inventory module. Implemented twice: against
 * Supabase (live) and against in-memory localStorage (demo). Both follow the
 * same atomicity rule: a single `adjustStock` call must write a movement
 * record and the new `stock_quantity` together; partial updates are not
 * allowed.
 */
export interface InventoryRepository {
  readonly kind: "supabase" | "demo";

  listProducts(): Promise<Product[]>;
  updateProductStock(productId: string, patch: ProductPatch): Promise<Product>;

  listMovements(): Promise<StockMovement[]>;
  listMovementsForProduct(productId: string): Promise<StockMovement[]>;
  recordMovement(input: NewStockMovement): Promise<StockMovement>;
}

/** Atomic stock-change operation. */
export interface AdjustStockArgs {
  productId: string;
  type: StockMovementType;
  reason: StockReason;
  quantity: number; // positive integer
  notes: string | null;
  userId: string;
  userName: string;
}

export { AppError };
