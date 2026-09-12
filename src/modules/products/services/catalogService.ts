import { assertSensitiveAction } from "@/lib/permissions/actions";
import { recordAudit } from "@/modules/audit/services/auditService";
import {
  assertRequestApplicable,
  assertWithinApprovalLimit,
  markRequestApplied,
  requirementForPriceChange,
} from "@/modules/approvals/services/approvalService";
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

// ── capability guards ───────────────────────────────────────────────────────
// Every one of these is an entry in `src/lib/permissions/actions.ts`, which is
// what makes the map checkable: the enforcement suite reads this file and fails
// if a guard stops being called. In live mode the same refusals come from RLS on
// `products` and `categories`; here they come first, in demo mode they are the
// only ones there are.

/** Adding a product to the catalog needs `add_product`. */
export function assertCanCreateProduct(): void {
  assertSensitiveAction("product.create");
}

/** Editing a product's details needs `edit_product`. */
export function assertCanEditProduct(): void {
  assertSensitiveAction("product.edit");
}

/**
 * Moving a selling price needs `change_price`, separately from `edit_product`.
 *
 * Two capabilities for one form is deliberate: the price is the number the till
 * charges and every profit figure is derived from it, so an installation can
 * hand a supervisor the catalog (names, images, categories, stock flags) without
 * handing them the price list.
 */
export function assertCanChangePrice(): void {
  assertSensitiveAction("product.price_change");
}

/**
 * Moving a purchase cost needs `change_cost` (Phase 17; it used to ride on
 * `change_price`). It drives margin rather than revenue, so a shop can hand
 * somebody the retail price without handing them what the shop pays — or the
 * reverse, for a buyer who records supplier invoices and never touches pricing.
 */
export function assertCanChangeCost(): void {
  assertSensitiveAction("product.cost_change");
}

/** Deleting a product needs `delete_product`. */
export function assertCanDeleteProduct(): void {
  assertSensitiveAction("product.delete");
}

/** Applying a catalog import needs `import_data` — parsing a file does not. */
export function assertCanImportProducts(): void {
  assertSensitiveAction("product.import");
}

/** Adding a category needs `add_product`: it is catalog authoring. */
export function assertCanCreateCategory(): void {
  assertSensitiveAction("category.create");
}

/** Renaming or moving a category needs `edit_product`. */
export function assertCanEditCategory(): void {
  assertSensitiveAction("category.edit");
}

/** Deleting a category needs `delete_product`, and the category must be empty. */
export function assertCanDeleteCategory(): void {
  assertSensitiveAction("category.delete");
}

/** Activating or deactivating a product is an edit. */
export function assertCanToggleProduct(): void {
  assertSensitiveAction("product.activate");
}

/**
 * What an edit is about to change, so the price gate can be asked only when a
 * price actually moves. Comparing numbers rather than form text keeps a re-save
 * of the same price from demanding an authority the user does not need.
 */
function priceChanges(existing: Product, next: Pick<Product, "selling_price" | "cost_price">): {
  selling: boolean;
  cost: boolean;
} {
  return {
    selling: Number(existing.selling_price) !== Number(next.selling_price),
    cost: Number(existing.cost_price ?? 0) !== Number(next.cost_price ?? 0),
  };
}

export interface SaveProductArgs {
  values: ProductFormValues;
  products: Product[];
  categories: Category[];
  currentId?: string;
  /** An approved price-change request being executed. See `ExpenseApproval`. */
  approval?: { requestId: string };
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
  approval,
}: SaveProductArgs): Promise<{ product: Product; isNew: boolean }> {
  // Permission first, payload second: an unauthorised caller is told they may
  // not do this, not that they filled the form in wrong. (The price/cost gates
  // below still need the validated draft, because they only fire when a value
  // actually moves.)
  if (currentId) assertCanEditProduct();
  else assertCanCreateProduct();

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
    assertCanEditProduct();
    // The price gate is asked only when a price really moves, and cost is asked
    // separately from retail: they are the same capability, but the audit entry
    // and the approval rule (when one is configured) name the field that changed.
    const changed = priceChanges(existing, data);
    if (changed.selling) assertCanChangePrice();
    if (changed.cost) assertCanChangeCost();

    // Phase 12, requirement 2: a shop may require a second signature on any
    // price or cost move. Asked only when a value really moves, so renaming a
    // product is never paperwork, and skipped for whoever holds the approval
    // authority — the limit binds the seats below it.
    if (changed.selling || changed.cost) {
      if (approval) {
        await assertRequestApplicable(approval.requestId, "price_change");
      } else {
        assertWithinApprovalLimit(
          await requirementForPriceChange(
            {
              selling_price: Number(existing.selling_price),
              cost_price: Number(existing.cost_price ?? 0),
            },
            {
              selling_price: Number(data.selling_price),
              cost_price: Number(data.cost_price ?? 0),
            },
          ),
        );
      }
    }

    const product = await repository.updateProduct(currentId, data);
    if ((changed.selling || changed.cost) && approval) {
      await markRequestApplied(approval.requestId, product.id);
    }

    // Requirement 6: a price move is the act that silently rewrites every margin
    // figure the shop has, so the trail keeps the value before and after — that
    // pair is what makes "why did this product stop being profitable?" answerable
    // months later, when nobody remembers and the receipt is long gone. Retail
    // and cost are separate actions because they are separate decisions: one is a
    // pricing choice, the other is a supplier fact. Both are written from here,
    // the one funnel every product edit passes through, and both are
    // fire-and-forget — a failed audit row must not roll back a saved product.
    const previousSelling = Number(existing.selling_price);
    const nextSelling = Number(product.selling_price);
    if (changed.selling) {
      void recordAudit({
        action: "product.price_changed",
        entity: "product",
        entity_id: product.id,
        entity_label: product.sku,
        details: {
          product: product.name_en,
          previous: previousSelling,
          next: nextSelling,
          delta: Math.round((nextSelling - previousSelling) * 100) / 100,
          percent:
            previousSelling > 0
              ? Math.round(((nextSelling - previousSelling) / previousSelling) * 10000) / 100
              : null,
          approval: approval?.requestId ?? null,
        },
      });
    }
    const previousCost = Number(existing.cost_price ?? 0);
    const nextCost = Number(product.cost_price ?? 0);
    if (changed.cost) {
      void recordAudit({
        action: "product.cost_changed",
        entity: "product",
        entity_id: product.id,
        entity_label: product.sku,
        details: {
          product: product.name_en,
          previous: previousCost,
          next: nextCost,
          delta: Math.round((nextCost - previousCost) * 100) / 100,
          approval: approval?.requestId ?? null,
        },
      });
    }
    return { product, isNew: false };
  }
  assertCanCreateProduct();
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
  // Same order as `saveProduct`: the refusal is about who is asking.
  if (currentId) assertCanEditCategory();
  else assertCanCreateCategory();

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
    assertCanEditCategory();
    const category = await repository.updateCategory(currentId, data as NewCategory);
    return { category, isNew: false };
  }
  assertCanCreateCategory();
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
  assertCanDeleteCategory();
  assertCategoryDeletable(id, ctx);
  await getCatalogRepository().deleteCategory(id);
}

export async function setProductActive(id: string, active: boolean): Promise<Product> {
  assertCanToggleProduct();
  return getCatalogRepository().setProductActive(id, active);
}

/**
 * Refused for everybody, at every privilege level — like `saleService.editSale`.
 *
 * Neither repository implements a product delete, and that is not an oversight:
 * a product that has ever been sold is referenced by `sale_items`, by stock
 * movements and by returns, so deleting it would either fail on the foreign key
 * or erase the history the numbers on every report are built from. The supported
 * answer is `setProductActive(id, false)`, which keeps the record and stops the
 * till selling it.
 *
 * `delete_product` stays in the matrix, and the capability is asserted here
 * before the refusal, so the day a real delete path is built it is already gated
 * rather than gated by whoever remembers.
 */
export async function deleteProduct(_id: string): Promise<never> {
  assertCanDeleteProduct();
  throw new AppError(
    "VALIDATION",
    "A product cannot be deleted once it has been sold. Deactivate it instead.",
    "product",
  );
}

export async function loadCatalog(): Promise<{ products: Product[]; categories: Category[] }> {
  const repository = getCatalogRepository();
  const [categories, products] = await Promise.all([
    repository.listCategories(),
    repository.listProducts(),
  ]);
  return { products, categories };
}
