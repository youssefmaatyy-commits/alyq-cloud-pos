import { assertSensitiveAction } from "@/lib/permissions/actions";
import { recordAudit } from "@/modules/audit/services/auditService";
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

/** Any movement of stock needs `adjust_stock` — a cashier sells, they do not adjust. */
export function assertCanAdjustStock(): void {
  assertSensitiveAction("stock.adjust");
}

/**
 * A correction is an adjustment recorded as a `recount` — the reason the movement
 * list uses for "the shelf and the system disagreed" — so it needs the same
 * capability. It gets its own entry in the register because it is the one staff
 * most often mean when they say "I fixed the stock", and the question "who may
 * fix the stock?" deserves an answer that is written down.
 */
export function assertCanCorrectStock(): void {
  assertSensitiveAction("stock.correct");
}

/**
 * Applying an opening-stock import needs `import_data`.
 *
 * The parser (`services/stockImport.ts`) is pure and stays ungated — parsing a
 * file is not writing to it. This is the gate for the funnel that applies rows,
 * and every row it applies is an adjustment, so `adjust_stock` is checked again
 * per row below.
 */
export function assertCanImportStock(): void {
  assertSensitiveAction("stock.import");
}

export async function adjustStock(args: {
  productId: string;
  type: StockMovement["type"];
  reason: StockMovement["reason"];
  quantity: number;
  notes: string | null;
}): Promise<InventoryAdjustmentResult> {
  assertCanAdjustStock();
  // `recount` is the movement list's word for a correction: the count on the
  // shelf disagreed with the system and somebody wrote the system down to match.
  if (args.reason === "recount") assertCanCorrectStock();
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

  // Requirement 6: stock is money on a shelf, and a manual movement is the one
  // act that changes it without a sale, a purchase or a return behind it. The
  // trail keeps the before/after pair the movement already snapshots, so a
  // correction can be read back as "the system said 12, the shelf said 9, this
  // person wrote 9" — which is the whole question an owner asks. A `recount` is
  // recorded as a correction and every other reason as an adjustment, matching
  // the two capabilities the funnel asserts above (`stock.correct` / `stock.adjust`).
  void recordAudit({
    action: args.reason === "recount" ? "stock.corrected" : "stock.adjusted",
    entity: "stock",
    entity_id: result.product.id,
    entity_label: result.product.sku,
    details: {
      product: result.product.name_en,
      movement: result.movement.type,
      reason: result.movement.reason,
      delta: result.movement.delta,
      before: result.movement.quantity_before,
      after: result.movement.quantity_after,
      notes: result.movement.notes ?? null,
    },
  });

  return { ...result, status: deriveStatus(result.product) };
}

/** Tiny re-derivation so the page can re-render badges without re-importing. */
function deriveStatus(
  product: Pick<Product, "stock_tracking_enabled" | "stock_quantity" | "low_stock_level">,
) {
  return stockStatus(product);
}
