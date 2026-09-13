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
 * Persistence contract for the catalog module.
 * Implemented twice: `supabaseRepository` (live) and `demoRepository` (offline).
 */
export interface CatalogRepository {
  readonly kind: "supabase" | "demo";

  listProducts(): Promise<Product[]>;
  createProduct(input: NewProduct): Promise<Product>;
  updateProduct(id: string, patch: ProductPatch): Promise<Product>;
  setProductActive(id: string, active: boolean): Promise<Product>;

  listCategories(): Promise<Category[]>;
  createCategory(input: NewCategory): Promise<Category>;
  updateCategory(id: string, patch: CategoryPatch): Promise<Category>;
  /** Throws `CATEGORY_IN_USE` when products still reference the category. */
  deleteCategory(id: string): Promise<void>;
}
