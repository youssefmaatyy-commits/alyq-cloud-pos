import type {
  Category,
  CategoryPatch,
  NewCategory,
  NewProduct,
  Product,
  ProductPatch,
} from "../types";
import type { NewProductVariant, ProductVariant, ProductVariantPatch } from "../variants";

/** Machine-readable failure codes the UI can react to. */
export type AppErrorCode =
  | "FORBIDDEN"
  | "NOT_CONFIGURED"
  | "NOT_FOUND"
  | "DUPLICATE_SKU"
  | "DUPLICATE_BARCODE"
  | "CATEGORY_IN_USE"
  | "CATEGORY_CYCLE"
  /**
   * Phase 44, category lifecycle — every one decided server-side; the codes
   * exist so the dialog states the real obstacle, never so the client can
   * decide.
   *
   *   CATEGORY_NOT_EMPTY    hard delete refused: products still reference the
   *                         category (count re-checked in-transaction).
   *   CATEGORY_HAS_CHILDREN hard delete / move refused: child categories hang
   *                         from it; move or delete them first.
   *   CATEGORY_ARCHIVED     the assignment or move target is an archived
   *                         category — reactivate it or pick another.
   */
  | "CATEGORY_NOT_EMPTY"
  | "CATEGORY_HAS_CHILDREN"
  | "CATEGORY_ARCHIVED"
  /** A till sale needs an open shift (Phase 27); the register must open one first. */
  | "SHIFT_REQUIRED"
  /**
   * Permanent delete refused: the product is referenced by business history
   * (sales, returns, the stock ledger, online orders or reservations). Archive
   * it instead — the record must outlive its selling life.
   */
  | "PRODUCT_HAS_HISTORY"
  /**
   * Phase 43, variants. Every one of these is also decided server-side; the
   * codes exist so the right field lights up and the right sentence is shown,
   * never so the client can decide.
   *
   *   VARIANT_REQUIRED            a product that sells by variant was used
   *                               without saying which colour and size.
   *   VARIANT_NOT_FOUND           the named combination is not one of its own
   *                               (another product's, deleted, or a stale id).
   *   VARIANT_UNAVAILABLE         the combination exists but is archived —
   *                               history must read, new sales must not.
   *   VARIANT_STOCK_INSUFFICIENT  the exact combination is short of units.
   *   VARIANT_IN_USE              a referenced combination cannot be deleted.
   *   VARIANTS_IN_USE             the product has variant history and may never
   *                               silently leave variant mode.
   *   VARIANTS_STOCK_MISMATCH     an opening distribution (or a consolidation)
   *                               does not add up — stock is never created or
   *                               destroyed by the conversion.
   *   VARIANT_STOCK_READONLY      a direct write to a variant product's stock
   *                               rollup: adjust the variant instead.
   */
  | "VARIANT_REQUIRED"
  | "VARIANT_NOT_FOUND"
  | "VARIANT_UNAVAILABLE"
  | "VARIANT_STOCK_INSUFFICIENT"
  | "VARIANT_IN_USE"
  | "VARIANTS_IN_USE"
  | "VARIANTS_STOCK_MISMATCH"
  | "VARIANT_STOCK_READONLY"
  /** The shelf moved since the stocktake snapshot. Nothing was adjusted. */
  | "STOCKTAKE_CONFLICT"
  /** A physical count is still missing. */
  | "STOCKTAKE_INCOMPLETE"
  /** The session is already historical. */
  | "STOCKTAKE_FINALIZED"
  | "VALIDATION"
  | "NETWORK"
  | "DB"
  /** Import: the file is over `IMPORT_LIMITS.maxBytes`. Refused before reading. */
  | "IMPORT_FILE_TOO_LARGE"
  /** Import: not a workbook and not text — a binary of some other kind. */
  | "IMPORT_FILE_UNSUPPORTED"
  /** Import: more rows than `IMPORT_LIMITS.maxRows`. Never silently truncated. */
  | "IMPORT_TOO_MANY_ROWS";

export class AppError extends Error {
  readonly code: AppErrorCode;
  /** Optional i18n key for a specific field, so forms can highlight it. */
  readonly field?: string;
  /** Supabase/Postgres error code when available (e.g. "23505"). */
  readonly pgCode?: string;

  constructor(code: AppErrorCode, message?: string, field?: string, pgCode?: string) {
    super(message ?? code);
    this.name = "AppError";
    this.code = code;
    this.field = field;
    this.pgCode = pgCode;
  }
}

function scalarErrorText(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  return null;
}

/**
 * Turn any throwable into text suitable for a cashier-facing error.
 *
 * Supabase/PostgREST network failures are plain objects, not `Error` instances:
 * `{ message: "TypeError: Failed to fetch", details, hint, code: "" }`.
 * `String(error)` turns that useful object into the useless "[object Object]",
 * which previously both hid the real failure and prevented `toAppError` from
 * classifying it as NETWORK (so the POS never reached its offline queue).
 */
export function readableErrorMessage(error: unknown, fallback = "Unknown error"): string {
  if (error instanceof Error) return error.message.trim() || error.name || fallback;
  const direct = scalarErrorText(error);
  if (direct && direct !== "[object Object]") return direct;
  if (error && typeof error === "object") {
    const value = error as Record<string, unknown>;
    for (const candidate of [value.message, value.error_description, value.error, value.details, value.hint]) {
      const text = scalarErrorText(candidate);
      if (text && text !== "[object Object]") return text;
      if (candidate && typeof candidate === "object" && candidate !== error) {
        const nested = readableErrorMessage(candidate, "");
        if (nested) return nested;
      }
    }
  }
  return fallback;
}

/** Map any thrown value into an AppError. */
export function toAppError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  const message = readableErrorMessage(error);
  const structured = error && typeof error === "object" ? error as Record<string, unknown> : null;
  const details = scalarErrorText(structured?.details);
  const sourceCode = scalarErrorText(structured?.code) ?? undefined;
  const diagnostic = `${message}\n${details ?? ""}`;
  if (message === "SUPABASE_NOT_CONFIGURED") {
    return new AppError("NOT_CONFIGURED", message);
  }
  if (/fetch|network|Failed to fetch|load failed|network request failed/i.test(diagnostic)) {
    return new AppError("NETWORK", message, undefined, sourceCode);
  }
  return new AppError("DB", message, undefined, sourceCode);
}

/**
 * How much preserved history a product has, per table. `total > 0` means the
 * product must never be permanently deleted — archive it instead.
 *
 * The tables are exactly the ones migration 0037 (`public.delete_product` /
 * `public.product_reference_counts`) and the demo guard enforce:
 *   sale_items, return_items, stock_movements, online_order_items,
 *   stock_reservations.
 */
export interface ProductReferenceCounts {
  sale_items: number;
  return_items: number;
  stock_movements: number;
  online_order_items: number;
  stock_reservations: number;
  total: number;
}

export const EMPTY_PRODUCT_REFERENCES: ProductReferenceCounts = {
  sale_items: 0,
  return_items: 0,
  stock_movements: 0,
  online_order_items: 0,
  stock_reservations: 0,
  total: 0,
};

/** product id → its reference counts (only products with total > 0 appear). */
export type ProductReferenceMap = Record<string, ProductReferenceCounts>;

/** variant id → how much preserved history names that exact combination. */
export type VariantReferenceMap = Record<string, number>;

/**
 * The distribution of stock already on the shelf when a product is switched to
 * variant stock (Phase 43, correction 1).
 *
 * `quantity` is units, keyed by the variant id they belong to. The sum is
 * checked against the product's existing stock — the conversion may neither
 * create nor destroy a unit, and it never defaults the lot onto one variant.
 */
export interface VariantOpening {
  variantId: string;
  quantity: number;
}

/**
 * Who is making a variant-stock transition. The live functions take the actor
 * explicitly (so the audit row names the person even when the session is a
 * service one) and the database overwrites attribution from `auth.uid()` when
 * there is one — the client cannot forge it either way.
 */
export interface VariantActor {
  userId: string;
  userName: string;
}

/**
 * Persistence contract for the catalog module.
 * Implemented twice: `supabaseRepository` (live) and `demoRepository` (offline).
 */
export interface CatalogRepository {
  readonly kind: "supabase" | "demo";

  listProducts(): Promise<Product[]>;
  createProduct(input: NewProduct): Promise<Product>;
  updateProduct(id: string, patch: ProductPatch): Promise<Product>;
  setProductActive(id: string, active: boolean): Promise<Product>;
  /**
   * Archive/delete support: every product id with preserved history and how
   * much of it, so the UI can disable permanent delete with a reason before
   * the click instead of failing after it.
   */
  listProductReferences(): Promise<ProductReferenceMap>;
  /**
   * Permanent delete. Throws `PRODUCT_HAS_HISTORY` when the product is
   * referenced by business history, `NOT_FOUND` when it does not exist and
   * `FORBIDDEN` without the capability. Never cascades into history.
   */
  deleteProduct(id: string): Promise<void>;

  // ── variants (Phase 43) ────────────────────────────────────────────────

  /** Every variant of every product, ordered by product then colour then size. */
  listVariants(): Promise<ProductVariant[]>;
  createVariant(input: NewProductVariant): Promise<ProductVariant>;
  updateVariant(id: string, patch: ProductVariantPatch): Promise<ProductVariant>;
  /** The guarded archive/reactivate path: cannot archive the last active shelf. */
  setVariantActive(id: string, active: boolean): Promise<ProductVariant>;
  /**
   * Permanently remove a combination. Refused with `VARIANT_IN_USE` when any
   * history names it, `VARIANT_REQUIRED` when it would remove the last active
   * shelf (or the only shelf), and `NOT_FOUND` when absent. Archive is the normal verb.
   */
  deleteVariant(id: string): Promise<void>;
  /** variant id → referenced-row count, so the screen can explain a refusal. */
  listVariantReferences(): Promise<VariantReferenceMap>;
  /**
   * Switch a product to variant stock, distributing what it already holds.
   * Refused with `VARIANTS_STOCK_MISMATCH` unless the opening sums to exactly
   * the product's current stock.
   */
  enableProductVariants(
    productId: string,
    opening: readonly VariantOpening[],
    actor: VariantActor,
  ): Promise<Product>;
  /**
   * Switch a product back to plain stock, consolidating every combination into
   * one figure. Refused with `VARIANTS_IN_USE` when any history references a
   * variant, and with `VARIANTS_STOCK_MISMATCH` unless the consolidated figure
   * equals the sum of the variants.
   */
  disableProductVariants(
    productId: string,
    consolidatedStock: number,
    actor: VariantActor,
  ): Promise<Product>;

  listCategories(): Promise<Category[]>;
  createCategory(input: NewCategory): Promise<Category>;
  updateCategory(id: string, patch: CategoryPatch): Promise<Category>;
  /**
   * Hard delete, server-adjudicated: the store locks the row and re-checks
   * inside the deleting transaction (Phase 44). Throws `CATEGORY_NOT_EMPTY`
   * with the structured product count, `CATEGORY_HAS_CHILDREN` when child
   * categories exist — archive or move them first.
   */
  deleteCategory(id: string): Promise<void>;
  /**
   * Archive (active=false) or reactivate. Products are untouched: an archived
   * category hides from pickers, the register and the storefront, while its
   * products stay sellable. Idempotent server-side.
   */
  setCategoryActive(id: string, active: boolean): Promise<Category>;
  /**
   * Move every product from `sourceId` to `targetId` and delete the source —
   * ONE server-side transaction. Throws on a missing side, a same-side call,
   * an archived target (`CATEGORY_ARCHIVED`) or a source with children
   * (`CATEGORY_HAS_CHILDREN`).
   */
  moveProductsAndDeleteCategory(
    sourceId: string,
    targetId: string,
  ): Promise<{ moved: number; source: Category; target: Category }>;
}
