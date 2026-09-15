import type {
  Category,
  CategoryPatch,
  NewCategory,
  NewProduct,
  Product,
  ProductPatch,
} from "../types";

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
   * Permanent delete refused: the product is referenced by business history
   * (sales, returns, the stock ledger, online orders or reservations). Archive
   * it instead — the record must outlive its selling life.
   */
  | "PRODUCT_HAS_HISTORY"
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

/** Map any thrown value into an AppError. */
export function toAppError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (message === "SUPABASE_NOT_CONFIGURED") {
    return new AppError("NOT_CONFIGURED", message);
  }
  if (/fetch|network|Failed to fetch/i.test(message)) {
    return new AppError("NETWORK", message);
  }
  return new AppError("DB", message);
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

  listCategories(): Promise<Category[]>;
  createCategory(input: NewCategory): Promise<Category>;
  updateCategory(id: string, patch: CategoryPatch): Promise<Category>;
  /** Throws `CATEGORY_IN_USE` when products still reference the category. */
  deleteCategory(id: string): Promise<void>;
}
