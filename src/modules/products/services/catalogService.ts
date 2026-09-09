import { getCatalogRepository } from "../data";
import { AppError } from "../data/repository";
import type { Category, NewCategory, Product } from "../types";
import { categoryUsage, isDescendant, validateCategoryDraft, validateProductDraft, type CategoryFormValues, type ProductFormValues } from "../validation";
import { resolveProductImages } from "./imageStorage";

/** i18n keys for every AppError the service can raise. */
const APP_ERROR_KEY: Record<string, string> = {
  NOT_CONFIGURED: "mode.demoHint",
  NOT_FOUND: "common.notFound",
  DUPLICATE_SKU: "validation.skuTaken",
  DUPLICATE_BARCODE: "validation.barcodeTaken",
  CATEGORY_IN_USE: "categories.deleteBlockedTitle",
  CATEGORY_CYCLE: "categories.moveUnderSelf",
  VALIDATION: "validation.fixErrors",
  NETWORK: "error.network",
  DB: "validation.serverError",
};

export function appErrorKey(error: AppError): string {
  if (error.pgCode && APP_ERROR_KEY[`error.${error.pgCode}`]) {
    return `error.${error.pgCode}`;
  }
  return APP_ERROR_KEY[error.code] ?? "common.error";
}

/** Translate any thrown value into a user-facing message key + field. */
export function describeError(error: unknown): { key: string; field?: string; error: AppError } {
  const appError =
    error instanceof AppError ? error : new AppError("DB", error instanceof Error ? error.message : String(error));
  return { key: appErrorKey(appError), field: appError.field, error: appError };
}

export interface SaveProductArgs {
  values: ProductFormValues;
  products: Product[];
  categories: Category[];
  currentId?: string;
}

/**
 * Validate + persist a product. All catalog rules (required bilingual names,
 * non-negative prices, SKU/barcode uniqueness) are enforced here, before any
 * network call, so the UI never duplicates business logic.
 */
export async function saveProduct({
  values,
  products,
  categories,
  currentId,
}: SaveProductArgs): Promise<{ product: Product; isNew: boolean }> {
  const { errors, data } = validateProductDraft(values, { products, categories, currentId });
  if (!data) {
    const firstField = Object.keys(errors)[0] ?? "sku";
    const err = new AppError("VALIDATION", `Invalid product draft (${firstField})`, firstField);
    (err as AppError & { fieldErrors?: unknown }).fieldErrors = errors;
    throw err;
  }

  // Upload any newly selected files and fill in the real image URLs before
  // the record is written. Remote images pass through unchanged.
  const resolved = await resolveProductImages(values.images ?? []);
  data.image_url = resolved.image_url;
  data.images = resolved.images;

  const repository = getCatalogRepository();
  if (currentId) {
    const existing = products.find((p) => p.id === currentId);
    if (!existing) throw new AppError("NOT_FOUND");
    const product = await repository.updateProduct(currentId, data);
    return { product, isNew: false };
  }
  const product = await repository.createProduct(data);
  return { product, isNew: true };
}

export interface SaveCategoryArgs {
  values: CategoryFormValues;
  categories: Category[];
  currentId?: string;
}

/** Validate + persist a category (includes the "cannot be its own ancestor" rule). */
export async function saveCategory({
  values,
  categories,
  currentId,
}: SaveCategoryArgs): Promise<{ category: Category; isNew: boolean }> {
  const { errors, data } = validateCategoryDraft(values, { categories, currentId });
  if (!data) {
    const firstField = Object.keys(errors)[0] ?? "name_ar";
    const err = new AppError("VALIDATION", `Invalid category draft (${firstField})`, firstField);
    (err as AppError & { fieldErrors?: unknown }).fieldErrors = errors;
    throw err;
  }

  const repository = getCatalogRepository();
  if (currentId) {
    if (data.parent_id && currentId && isDescendant(data.parent_id, currentId, categories)) {
      throw new AppError("CATEGORY_CYCLE", "Cannot move a category under itself", "parent_id");
    }
    const category = await repository.updateCategory(currentId, data as NewCategory);
    return { category, isNew: false };
  }
  const category = await repository.createCategory(data as NewCategory);
  return { category, isNew: true };
}

export interface DeleteCategoryCheck {
  products: Product[];
  categories: Category[];
}

/** Deletion is only allowed for empty categories — otherwise deactivate. */
export function assertCategoryDeletable(id: string, ctx: DeleteCategoryCheck): void {
  const usage = categoryUsage(id, ctx.products, ctx.categories);
  if (usage.productCount > 0 || usage.childCount > 0) {
    throw new AppError("CATEGORY_IN_USE", `Category ${id} still has content`);
  }
}

export async function deleteCategory(id: string, ctx: DeleteCategoryCheck): Promise<void> {
  assertCategoryDeletable(id, ctx);
  await getCatalogRepository().deleteCategory(id);
}

export async function setProductActive(id: string, active: boolean): Promise<Product> {
  return getCatalogRepository().setProductActive(id, active);
}

export async function loadCatalog(): Promise<{ products: Product[]; categories: Category[] }> {
  const repository = getCatalogRepository();
  const [categories, products] = await Promise.all([
    repository.listCategories(),
    repository.listProducts(),
  ]);
  return { products, categories };
}
