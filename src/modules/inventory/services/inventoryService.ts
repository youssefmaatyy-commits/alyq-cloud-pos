import { assertSensitiveAction } from "@/lib/permissions/actions";
import { recordAudit } from "@/modules/audit/services/auditService";
import { AppError } from "@/modules/products/data/repository";
import { stockStatus, type Product, type StockStatus } from "@/modules/products/types";
import type { ProductVariant } from "@/modules/products/variants";
import { summarizeVariants } from "@/modules/products/variants";
import { applyDemoAdjustment, applySupabaseAdjustment, getInventoryRepository } from "../data";
import { getCurrentUser } from "../permissions";
import type { StockMovement, StockMovementType, StockReason } from "../types";

/**
 * Inventory service: thin wrapper over the repository that enforces the
 * data-safety rule. Every change to `stock_quantity` must come through
 * `adjustStock`, which records a `StockMovement` first and refuses to write
 * a negative quantity.
 */

export interface InventoryAdjustmentResult {
  product: Product;
  movement: StockMovement;
  /** The combination that moved, when the adjustment named one (Phase 43). */
  variant: ProductVariant | null;
  /** Re-derived status after the change so the UI doesn't have to recompute. */
  status: StockStatus;
}

export async function loadInventory(): Promise<{
  products: Product[];
  movements: StockMovement[];
  /** Every combination, display order (Phase 43) — the breakdown rows. */
  variants: ProductVariant[];
}> {
  const repository = getInventoryRepository();
  const [products, movements, variants] = await Promise.all([
    repository.listProducts(),
    repository.listMovements(),
    repository.listVariants(),
  ]);
  // A variant product's health is its ACTIVE variants' (stockStatus), so the
  // summary rides on the product row from the same read.
  const grouped = new Map<string, ProductVariant[]>();
  for (const variant of variants) {
    const list = grouped.get(variant.product_id);
    if (list) list.push(variant);
    else grouped.set(variant.product_id, [variant]);
  }
  const withSummaries = products.map((product) => {
    const own = grouped.get(product.id);
    return own && own.length > 0
      ? { ...product, variant_summary: summarizeVariants(own) }
      : product;
  });
  return { products: withSummaries, movements, variants };
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
  /**
   * Phase 43: which combination moved. Required when the product sells by
   * variant — the product rollup is derived and cannot be adjusted, so a caller
   * that does not name a variant is refused rather than guessing one.
   */
  variantId?: string | null;
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
  const [products, variants] = await Promise.all([
    repository.listProducts(),
    repository.listVariants(),
  ]);
  const adjustArgs = {
    productId: args.productId,
    variantId: args.variantId ?? null,
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
  const movement = result.movement;
  const adjustedVariant = movement.variant_id
    ? variants.find((v) => v.id === movement.variant_id) ?? null
    : null;
  void recordAudit({
    action: args.reason === "recount" ? "stock.corrected" : "stock.adjusted",
    entity: "stock",
    entity_id: result.product.id,
    entity_label: adjustedVariant ? adjustedVariant.sku : result.product.sku,
    details: {
      product: result.product.name_en,
      movement: movement.type,
      reason: movement.reason,
      delta: movement.delta,
      before: movement.quantity_before,
      after: movement.quantity_after,
      notes: movement.notes ?? null,
      // Phase 43: which combination, and what it looked like at the time. The
      // snapshot is what keeps the entry readable after a rename.
      variant_id: movement.variant_id,
      variant_sku: adjustedVariant?.sku ?? null,
      variant_color: movement.variant_color_en ?? movement.variant_color_ar ?? null,
      variant_size: movement.variant_size ?? movement.variant_size_label ?? null,
      product_stock: result.product.stock_quantity,
    },
  });

  return {
    ...result,
    variant: adjustedVariant,
    status: deriveStatus(result.product, variants),
  };
}

/**
 * The ledger line for a variant-stock move that is NOT a manual adjustment —
 * currently the opening distribution and the consolidation of the two
 * conversion functions. It writes the movement and sets the combination's
 * absolute figure, in that order, and never touches the product rollup (the
 * catalog repository moves that as the variants move).
 *
 * Live mode does not call this: migration 0043's functions perform the
 * conversion, its ledger rows and the mode flip inside one transaction. This
 * exists so demo mode tells the same story.
 */
export async function applyVariantMovement(args: {
  productId: string;
  variantId: string | null;
  type: StockMovementType;
  reason: StockReason;
  quantity: number;
  notes: string | null;
  /** Absolute figure the combination (or the product) must end at. */
  expectedAfter: number;
}): Promise<StockMovement> {
  const repository = getInventoryRepository();
  const user = getCurrentUser();
  const variants = await repository.listVariants();
  const variant = args.variantId ? variants.find((v) => v.id === args.variantId) ?? null : null;
  if (args.variantId && !variant) {
    throw new AppError("VARIANT_NOT_FOUND", `Variant ${args.variantId} not found`);
  }

  const movement = await repository.recordMovement({
    product_id: args.productId,
    variant_id: variant?.id ?? null,
    variant_color_ar: variant?.color_ar ?? null,
    variant_color_en: variant?.color_en ?? null,
    variant_size: variant?.size ?? null,
    variant_size_label: variant?.size_label ?? null,
    delta: Math.abs(args.quantity),
    type: args.type,
    reason: args.reason,
    notes: args.notes,
    user_id: user.id,
    user_name: user.name,
  });

  if (variant) {
    await repository.updateVariantStock(variant.id, args.expectedAfter);
  }
  return movement;
}

/**
 * Tiny re-derivation so the page can re-render badges without re-importing.
 * A variant product is classified from its ACTIVE VARIANTS (a product whose
 * Gold/17 just ran out is not "in stock" because Silver/17 still has some), so
 * the variants that were just read are passed through.
 */
function deriveStatus(
  product: Pick<
    Product,
    "id" | "stock_tracking_enabled" | "stock_quantity" | "low_stock_level"
  > &
    Partial<Pick<Product, "variants_enabled">>,
  variants: readonly ProductVariant[] = [],
): StockStatus {
  if (product.variants_enabled && variants.length > 0) {
    return stockStatus({
      ...product,
      variant_summary: summarizeVariants(variants.filter((v) => v.product_id === product.id)),
    } as Product);
  }
  return stockStatus(product);
}
