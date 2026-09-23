import { assertSensitiveAction } from "@/lib/permissions/actions";
import { recordAudit } from "@/modules/audit/services/auditService";
import {
  assertRequestApplicable,
  assertWithinApprovalLimit,
  markRequestApplied,
  requirementForPriceChange,
} from "@/modules/approvals/services/approvalService";
import { getCatalogRepository } from "../data";
import { AppError, type ProductReferenceCounts } from "../data/repository";
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
  CATEGORY_NOT_EMPTY: "categories.deleteBlockedTitle",
  CATEGORY_HAS_CHILDREN: "categories.childrenBlockDelete",
  CATEGORY_ARCHIVED: "categories.archivedTarget",
  CATEGORY_CYCLE: "categories.moveUnderSelf",
  PRODUCT_HAS_HISTORY: "products.errorHasHistory",
  FORBIDDEN: "common.forbidden",
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
  const repository = getCatalogRepository();
  // The label is read before the delete so the trail names what was removed.
  const category = ctx.categories.find((c) => c.id === id);
  await repository.deleteCategory(id);
  if (repository.kind === "demo") {
    // Live mode writes category.deleted from the categories_audit trigger
    // (0044); the demo writes the same event from here. Fire-and-forget for
    // the same reason as every audit row above: a failed trail must not
    // undo a succeeded change.
    void recordAudit({
      action: "category.deleted",
      entity: "category",
      entity_id: id,
      entity_label: category?.name_en ?? id,
      details: {
        name_ar: category?.name_ar ?? null,
        name_en: category?.name_en ?? null,
        was_active: category?.active ?? null,
      },
    });
  }
}

/**
 * Archive (`active = false`) or reactivate a category. Archiving is *not*
 * deleting: products stay exactly where they are and keep selling — the
 * category only leaves the pickers, the register filter and the storefront
 * navigation, and can no longer accept new products.
 *
 * Live mode goes through `public.set_category_active` (0044), which re-checks
 * `edit_product` and lets the categories_audit trigger write
 * category.archived / category.reactivated, so the trail exists however the
 * flip was made. Demo mode records the same event from here.
 */
export async function setCategoryActive(id: string, active: boolean): Promise<Category> {
  assertCanEditCategory();
  const repository = getCatalogRepository();
  const before = (await repository.listCategories()).find((c) => c.id === id);
  const category = await repository.setCategoryActive(id, active);
  if (category.active === (before?.active ?? null)) return category; // idempotent replay: no event
  if (repository.kind === "demo") {
    void recordAudit({
      action: active ? "category.reactivated" : "category.archived",
      entity: "category",
      entity_id: category.id,
      entity_label: category.name_en,
      details: {
        name_ar: category.name_ar,
        name_en: category.name_en,
        previous: !active,
        next: active,
      },
    });
  }
  return category;
}

export interface MoveCategoryArgs {
  sourceId: string;
  targetId: string;
}

/**
 * Move every product from the source category to the target and delete the
 * emptied source — ONE server-side transaction (`public.
 * move_products_and_delete_category`, 0044): both categories locked, target
 * must be active, source must have no children, the move is one statement and
 * zero-remaining is verified before the delete commits. Needs BOTH the
 * authority to edit products (the move) and to delete a category (the
 * deletion). Demo mode mirrors the same checks in the repository and records
 * category.products_moved + category.deleted from here.
 */
export async function moveProductsAndDeleteCategory({
  sourceId,
  targetId,
}: MoveCategoryArgs): Promise<{ moved: number }> {
  assertCanEditCategory();
  assertCanDeleteCategory();
  const repository = getCatalogRepository();
  const result = await repository.moveProductsAndDeleteCategory(sourceId, targetId);
  if (repository.kind === "demo") {
    void recordAudit({
      action: "category.products_moved",
      entity: "category",
      entity_id: targetId,
      entity_label: result.target.name_en,
      details: {
        source_id: sourceId,
        source_name: result.source.name_en,
        target_id: targetId,
        target_name: result.target.name_en,
        moved: result.moved,
        source_deleted: true,
      },
    });
    void recordAudit({
      action: "category.deleted",
      entity: "category",
      entity_id: sourceId,
      entity_label: result.source.name_en,
      details: {
        name_ar: result.source.name_ar,
        name_en: result.source.name_en,
        was_active: result.source.active,
      },
    });
  }
  return { moved: result.moved };
}

/**
 * Archive (`active = false`) or reactivate (`true`) a product. An archived
 * product keeps every sale, movement, return, order and audit row that
 * references it — it only stops being sellable: the POS grid, the storefront
 * catalogue, the online checkout and the demo sale path all honour `active`.
 *
 * Live mode goes through `public.set_product_active` (0037), which re-checks
 * `edit_product` and writes product.archived / product.reactivated inside the
 * database, so the trail exists however the call was made. Demo mode records
 * the same event from here, exactly as the price-change events are written —
 * and fire-and-forget for the same reason: a failed audit row must not roll
 * back a finished transition.
 */
export async function setProductActive(id: string, active: boolean): Promise<Product> {
  assertCanToggleProduct();
  const repository = getCatalogRepository();
  const product = await repository.setProductActive(id, active);
  if (repository.kind === "demo") {
    void recordAudit({
      action: active ? "product.reactivated" : "product.archived",
      entity: "product",
      entity_id: product.id,
      entity_label: product.sku,
      details: { product: product.name_en, sku: product.sku, previous: !active, next: active },
    });
  }
  return product;
}

/**
 * Permanent delete — allowed only for a product with NO history.
 *
 * The rule lives at the data layer in both modes, so a caller that skips this
 * service gets the same answer: live mode through `public.delete_product`
 * (0037: re-checks `delete_product`, counts the referencing rows in
 * sale_items / return_items / stock_movements / online_order_items /
 * stock_reservations and raises RESTRICT_VIOLATION on any, writes
 * product.deleted before the delete, and cascades only to the two storefront
 * tables that declared `on delete cascade`), demo mode through the same guard
 * in the demo repository. Nothing in either path removes a historical row.
 */
export async function deleteProduct(id: string): Promise<void> {
  assertCanDeleteProduct();
  const repository = getCatalogRepository();
  // The label is read before the delete so the trail names what was removed;
  // the price events above do the same for the same reason.
  const product = (await repository.listProducts()).find((p) => p.id === id);
  if (!product) throw new AppError("NOT_FOUND", `Product ${id} not found`);
  await repository.deleteProduct(id);
  if (repository.kind === "demo") {
    void recordAudit({
      action: "product.deleted",
      entity: "product",
      entity_id: product.id,
      entity_label: product.sku,
      details: { product: product.name_en, sku: product.sku, barcode: product.barcode },
    });
  }
}

/**
 * Every product id that carries preserved history, with per-table counts —
 * the input the products screen uses to offer Archive instead of a destructive
 * action and to say why. Deleting still remains the repository's call: this
 * map is for rendering, not for enforcement.
 */
export async function listProductReferences(): Promise<Record<string, ProductReferenceCounts>> {
  return getCatalogRepository().listProductReferences();
}

export async function loadCatalog(): Promise<{ products: Product[]; categories: Category[] }> {
  const repository = getCatalogRepository();
  const [categories, products] = await Promise.all([
    repository.listCategories(),
    repository.listProducts(),
  ]);
  return { products, categories };
}
