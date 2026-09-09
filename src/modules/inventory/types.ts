/**
 * Inventory module — domain types (Phase 3).
 *
 * Stock state already lives on `Product.stock_quantity` / `low_stock_level` /
 * `stock_tracking_enabled`. This module only adds:
 *   - an immutable movement ledger (`StockMovement`)
 *   - the public adjustment DTO
 *   - aggregation helpers reused by the dashboard, list and history pages.
 *
 * Movement `delta` is always non-negative in magnitude; the `type` decides
 * whether it adds to or subtracts from `stock_quantity`.
 */

import type { Product } from "@/modules/products/types";

export const STOCK_MOVEMENT_TYPES = [
  "adjustment_in",
  "adjustment_out",
  "receive",
  "issue",
  "transfer",
  "correction",
] as const;

export type StockMovementType = (typeof STOCK_MOVEMENT_TYPES)[number];

export const STOCK_REASONS = [
  "purchase",
  "supplier_return",
  "customer_return",
  "damaged",
  "expired",
  "lost",
  "theft",
  "recount",
  "transfer_in",
  "transfer_out",
  "other",
] as const;

export type StockReason = (typeof STOCK_REASONS)[number];

export interface StockMovement {
  id: string;
  product_id: string;
  /** Positive number; sign implied by `type`. */
  delta: number;
  quantity_before: number;
  quantity_after: number;
  type: StockMovementType;
  reason: StockReason;
  notes: string | null;
  user_id: string;
  user_name: string;
  created_at: string;
}

/** Input the UI/CLI sends; the persistence layer fills id, timestamps and the
 *  before/after snapshot once the change has been applied. */
export type NewStockMovement = Omit<StockMovement, "id" | "created_at" | "quantity_before" | "quantity_after">;

/** Stored shape (snake_case) — what the repository writes back to disk. */

/** Snapshot payload for a recorded movement — same shape as `StockMovement`. */
export type MovementSnapshot = StockMovement;

/** Adjustable values supplied by the admin via the Stock Adjustment dialog. */
export interface StockAdjustmentFormValues {
  type: StockMovementType;
  reason: StockReason;
  quantity: string;
  notes: string;
}

export const EMPTY_ADJUSTMENT_FORM: StockAdjustmentFormValues = {
  type: "adjustment_in",
  reason: "recount",
  quantity: "0",
  notes: "",
};

/** Movement types that decrease stock. */
export function isOutbound(type: StockMovementType): boolean {
  return type === "adjustment_out" || type === "issue" || type === "transfer";
}

/** Human label for the direction pill. */
export function directionLabel(type: StockMovementType): "in" | "out" {
  return isOutbound(type) ? "out" : "in";
}

/** Apply a delta to a product snapshot, returning a new product with updated stock. */
export function applyStockDelta(
  product: Pick<Product, "stock_quantity" | "stock_tracking_enabled">,
  type: StockMovementType,
  delta: number,
): number {
  if (!product.stock_tracking_enabled) return product.stock_quantity;
  if (isOutbound(type)) {
    return Math.max(0, product.stock_quantity - delta);
  }
  return Math.max(0, product.stock_quantity + delta);
}

/** Absolute value of the delta when applied to the product. */
export function signedDelta(type: StockMovementType, delta: number): number {
  return isOutbound(type) ? -delta : delta;
}
