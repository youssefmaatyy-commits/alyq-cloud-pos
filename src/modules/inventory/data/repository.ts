import type { Product, ProductPatch } from "@/modules/products/types";
import type { ProductVariant } from "@/modules/products/variants";
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

  /**
   * Phase 43. A variant product's shelf is the VARIANT row: the inventory
   * screens read the combinations to show which one is short, and write the
   * exact one that moved. The product rollup follows both automatically.
   */
  listVariants(): Promise<ProductVariant[]>;
  /** Set one combination's stock to an absolute figure; returns the new row. */
  updateVariantStock(variantId: string, quantity: number): Promise<ProductVariant>;

  listMovements(): Promise<StockMovement[]>;
  listMovementsForProduct(productId: string): Promise<StockMovement[]>;
  recordMovement(input: NewStockMovement): Promise<StockMovement>;
}

/** Atomic stock-change operation. */
export interface AdjustStockArgs {
  productId: string;
  /**
   * The exact combination being adjusted, when the product sells by variant.
   * Required for a variant product (the rollup is not editable, and a movement
   * that does not say which shelf moved is not an audit trail), ignored for a
   * plain product.
   */
  variantId?: string | null;
  type: StockMovementType;
  reason: StockReason;
  quantity: number; // positive integer
  notes: string | null;
  userId: string;
  userName: string;
}

export { AppError };
