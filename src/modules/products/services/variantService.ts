/**
 * Variant service (Phase 43) — the one funnel every variant write passes through.
 *
 * The rules themselves are enforced deeper down (the database in live mode, the
 * demo repository offline), so this layer is about three things the data layer
 * must not know:
 *
 *   1. **Capabilities.** Creating a combination is catalog authoring
 *      (`add_product`); editing one is an edit (`edit_product`); moving a
 *      combination's stock is a stock act (`adjust_stock`), which is why an
 *      inventory clerk can look after the shelves without being handed the
 *      catalogue. The same capabilities are re-checked server-side — these calls
 *      are what makes the refusal arrive as a sentence rather than a bare 403.
 *
 *   2. **The conversion funnel** (`enableVariants`). Switching a product to
 *      variant stock is the one moment stock could silently appear or vanish, so
 *      it is guarded here *and* in the database: the opening distribution must
 *      add up to exactly what the product already holds, and each variant's move
 *      is written to the ledger before the product's mode changes. There is no
 *      path that defaults the existing stock onto a variant.
 *
 *   3. **The trail.** Live mode writes the audit rows inside the functions;
 *      demo mode has no database to do that, so the same events are recorded
 *      from here — fire-and-forget, exactly like `product.archived` and
 *      `product.price_changed`, because a failed audit row must never roll back
 *      a finished change.
 */

import { assertSensitiveAction } from "@/lib/permissions/actions";
import { getCurrentAuthUser } from "@/lib/auth/services/sessionStore";
import { recordAudit } from "@/modules/audit/services/auditService";
import { applyVariantMovement } from "@/modules/inventory/services/inventoryService";
import { getCatalogRepository } from "../data";
import { AppError, type VariantActor, type VariantOpening } from "../data/repository";
import type { Product } from "../types";
import { deriveBarcodeFromSku } from "./barcode";
import {
  colorKeyOf,
  compareVariants,
  modelKeyOf,
  modelNameOf,
  summarizeVariants,
  variantGalleryProblem,
  variantLabel,
  variantSizeValue,
  type NewProductVariant,
  type ProductColorImage,
  type ProductColorImageInput,
  type ProductVariant,
  type ProductVariantPatch,
  type VariantColorDraft,
  type VariantSummary,
} from "../variants";

// ── capability guards ───────────────────────────────────────────────────────

/** Adding a combination to a product is catalog authoring. */
export function assertCanCreateVariant(): void {
  assertSensitiveAction("product.create");
}

/** Editing a combination's own fields is an edit. */
export function assertCanEditVariant(): void {
  assertSensitiveAction("product.edit");
}

/** Archiving/reactivating a combination is an edit — it stops it being sold. */
export function assertCanToggleVariant(): void {
  assertSensitiveAction("product.edit");
}

/** Deleting a combination needs `delete_product` (it can orphan no history). */
export function assertCanDeleteVariant(): void {
  assertSensitiveAction("product.delete");
}

/**
 * Moving a combination's stock needs `adjust_stock` — the same capability the
 * inventory screen requires, deliberately NOT `edit_product`: the shop hands the
 * shelves to an inventory clerk without handing over the catalogue. The rollup
 * follows the variants, so that clerk never needs catalogue rights.
 */
export function assertCanAdjustVariantStock(): void {
  assertSensitiveAction("stock.adjust");
}

/** Switching a product into or out of variant mode is a catalog edit. */
export function assertCanConvertVariants(): void {
  assertSensitiveAction("product.edit");
}

/** Who is acting — the live functions name the person in the audit row. */
export function currentVariantActor(): VariantActor {
  const user = getCurrentAuthUser();
  return { userId: user?.id ?? "", userName: user?.name ?? "" };
}

// ── reads ───────────────────────────────────────────────────────────────────

export async function listVariants(): Promise<ProductVariant[]> {
  const variants = await getCatalogRepository().listVariants();
  return [...variants].sort(compareVariants);
}

export async function listVariantReferences(): Promise<Record<string, number>> {
  return getCatalogRepository().listVariantReferences();
}

export async function listColorImages(productId?: string): Promise<ProductColorImage[]> {
  return getCatalogRepository().listColorImages(productId);
}

export async function replaceColorImages(
  productId: string,
  images: readonly ProductColorImageInput[],
): Promise<ProductColorImage[]> {
  assertCanEditVariant();
  return getCatalogRepository().replaceColorImages(productId, images);
}

/** Variants grouped by product, in display order — the shape screens render. */
export function groupByProduct(variants: readonly ProductVariant[]): Map<string, ProductVariant[]> {
  const grouped = new Map<string, ProductVariant[]>();
  for (const variant of [...variants].sort(compareVariants)) {
    const list = grouped.get(variant.product_id);
    if (list) list.push(variant);
    else grouped.set(variant.product_id, [variant]);
  }
  return grouped;
}

/** The counts the product table and the dashboard show, without double counting. */
export function variantSummary(variants: readonly ProductVariant[]): VariantSummary {
  return summarizeVariants(variants);
}

// ── create / edit ───────────────────────────────────────────────────────────

export interface SaveVariantArgs {
  product: Pick<Product, "id" | "sku" | "selling_price" | "cost_price"> & { barcode?: string | null };
  /** Fields as the form has them. `color_key` is derived, never typed. */
  values: Omit<NewProductVariant, "product_id" | "color_key"> & { color_key?: string };
  /** The combination being edited, when this is not a create. */
  currentId?: string;
  /** Every variant already on this product, so uniqueness is settled here too. */
  siblings: readonly ProductVariant[];
}

/**
 * Create or edit one combination. Uniqueness (SKU, barcode, colour+size+model) is
 * checked here for a friendly message and again by the database as the truth.
 */
export async function saveVariant({
  product,
  values,
  currentId,
  siblings,
}: SaveVariantArgs): Promise<{ variant: ProductVariant; isNew: boolean }> {
  if (currentId) assertCanEditVariant();
  else assertCanCreateVariant();

  const repository = getCatalogRepository();
  const sku = values.sku.trim();
  if (!sku) throw new AppError("VALIDATION", "A variant needs a SKU", "sku");
  if (!Number.isFinite(Number(values.low_stock_level)) || Number(values.low_stock_level) < 0) {
    throw new AppError("VALIDATION", "Low stock level cannot be negative", "low_stock_level");
  }

  const others = siblings.filter((v) => v.id !== currentId);
  const clash = others.find((v) => v.sku.trim().toUpperCase() === sku.toUpperCase());
  if (clash) {
    throw new AppError(
      "DUPLICATE_SKU",
      `${sku} already belongs to ${variantLabel(clash)} on this product`,
      "sku",
      "23505",
    );
  }
  const isNamedModel = modelNameOf(values) !== null;
  if (isNamedModel && values.price_override !== null && values.price_override !== undefined) {
    throw new AppError("VALIDATION", "A named model uses the product price", "price_override", "23514");
  }
  const gallery = (values.images ?? []).map((url) => url.trim()).filter(Boolean);
  if (variantGalleryProblem(gallery)) {
    throw new AppError("VALIDATION", "Invalid variant gallery", "images", "23514");
  }

  // Named models ("أشكال / موديلات متعددة") share the parent product's barcode by
  // default (`barcode = null` in DB), whereas colour/size combinations derive a
  // fallback barcode from SKU when left blank. An explicit distinct barcode wins.
  const rawBarcode = values.barcode?.trim() || null;
  const parentBarcode = (product.barcode ?? "").trim();
  const barcode = isNamedModel
    ? rawBarcode && (!parentBarcode || rawBarcode.toUpperCase() !== parentBarcode.toUpperCase())
      ? rawBarcode
      : null
    : rawBarcode || deriveBarcodeFromSku(sku) || null;
  if (barcode && others.some((v) => (v.barcode ?? "").toUpperCase() === barcode.toUpperCase())) {
    throw new AppError("DUPLICATE_BARCODE", `${barcode} already belongs to another variant`, "barcode", "23505");
  }

  const rawKey = values.color_key?.trim().toLowerCase() || "";
  const derivedKey = colorKeyOf(values);
  const sizeKey = (values.size_value ?? values.size_label ?? (values.size == null ? "" : String(values.size)))
    .trim()
    .toLocaleLowerCase();
  const modelKey = modelKeyOf(values);
  const canHealSingleCharKey =
    rawKey.length === 1 &&
    derivedKey.length > 1 &&
    derivedKey.startsWith(rawKey) &&
    !others.some(
      (v) =>
        v.color_key === derivedKey &&
        variantSizeValue(v).toLocaleLowerCase() === sizeKey &&
        modelKeyOf(v) === modelKey,
    );
  const colorKey = canHealSingleCharKey ? derivedKey : rawKey || derivedKey;

  if (!currentId || isNamedModel) {
    const twin = others.find(
      (v) =>
        v.color_key === colorKey &&
        variantSizeValue(v).toLocaleLowerCase() === sizeKey &&
        modelKeyOf(v) === modelKey,
    );
    if (twin) {
      throw new AppError(
        "VALIDATION",
        `${variantLabel(values)} already exists for this product`,
        isNamedModel ? "display_name_en" : "size",
        "23505",
      );
    }
  }

  // An `undefined` stock property is NOT the same as omitting it. The demo
  // repository spreads patches onto rows, and spreading `stock_quantity:
  // undefined` erased an existing shelf (then the rollup became NaN). Inventory
  // owns stock; the guarded setVariantActive RPC owns archive/reactivate. A
  // metadata edit must never silently bypass either shelf invariant.
  const current = currentId ? siblings.find((variant) => variant.id === currentId) : null;
  if (current && current.active !== values.active) {
    throw new AppError("VALIDATION", "Archive or reactivate this combination using its dedicated action", "active");
  }
  const normalizedValues = {
    ...values,
    color_key: colorKey,
    display_name_ar: values.display_name_ar?.trim() || null,
    display_name_en: values.display_name_en?.trim() || null,
    images: gallery,
  };
  const editPatch: ProductVariantPatch = { ...normalizedValues, sku, barcode, color_key: colorKey };
  delete editPatch.stock_quantity;
  delete editPatch.active;
  const variant = currentId
    ? await repository.updateVariant(currentId, editPatch)
    : await repository.createVariant({
        ...normalizedValues,
        sku,
        barcode,
        color_key: colorKey,
        product_id: product.id,
      });

  if (repository.kind === "demo") {
    void recordAudit({
      action: currentId ? "product.variant_updated" : "product.variant_created",
      entity: "product",
      entity_id: product.id,
      entity_label: product.sku,
      details: {
        product: product.sku,
        variant_id: variant.id,
        sku: variant.sku,
        color: variant.color_en ?? variant.color_ar ?? null,
        size: variantSizeValue(variant) || null,
        price_override: variant.price_override,
        cost_override: variant.cost_override,
      },
    });
  }
  return { variant, isNew: !currentId };
}

/**
 * Generate the combinations of colours × sizes that do not exist yet.
 *
 * The caller edits the list (a combination can be dropped before saving) and
 * every row is created through `saveVariant`, so identity, codes and uniqueness
 * behave exactly as they do for a hand-added combination.
 */
export interface GenerateVariantRow {
  color: VariantColorDraft | null;
  size: number | null;
  size_label: string | null;
  size_value: string | null;
  size_sort_order: number;
  /** Pre-filled from the suggested SKU; the admin can overtype it. */
  sku: string;
  /**
   * Pre-filled from the suggested SKU via `deriveBarcodeFromSku`; the admin
   * can overtype it. Optional only for callers that pre-date this field —
   * `generateVariants` derives one from `sku` whenever it is left blank, so a
   * generated combination never ends up without a barcode.
   */
  barcode?: string;
  /** Unchecked rows are simply not created. */
  enabled: boolean;
}

export interface GenerateVariantsArgs {
  product: Pick<Product, "id" | "sku" | "selling_price" | "cost_price">;
  rows: readonly GenerateVariantRow[];
  /** Existing variants, so the same combination is never created twice. */
  siblings: readonly ProductVariant[];
  lowStockLevel: number;
}

export async function generateVariants({
  product,
  rows,
  siblings,
  lowStockLevel,
}: GenerateVariantsArgs): Promise<ProductVariant[]> {
  assertCanCreateVariant();
  const repository = getCatalogRepository();
  const created: ProductVariant[] = [];
  let take = 0;

  for (const row of rows) {
    if (!row.enabled) continue;
    const colorKey = row.color ? colorKeyOf(row.color) : "";
    const twin = [...siblings, ...created].some(
      (v) =>
        v.color_key === colorKey &&
        variantSizeValue(v).toLocaleLowerCase() === (row.size_value ?? "").toLocaleLowerCase(),
    );
    if (twin) continue;

    take += 1;
    const sku = row.sku.trim();
    const variant = await repository.createVariant({
      product_id: product.id,
      sku,
      // Every generated combination is immediately scannable: the barcode
      // defaults to the deterministic SKU derivation unless the caller
      // already supplied one (e.g. a hand-edited preview row).
      barcode: row.barcode?.trim() || deriveBarcodeFromSku(sku) || null,
      color_key: colorKey,
      color_ar: row.color?.color_ar ?? null,
      color_en: row.color?.color_en ?? null,
      color_hex: row.color?.color_hex ?? null,
      size: row.size,
      size_label: row.size_label,
      size_value: row.size_value,
      size_sort_order: row.size_sort_order,
      image_url: null,
      price_override: null,
      cost_override: null,
      stock_quantity: 0,
      low_stock_level: lowStockLevel,
      active: true,
      sort_order: take,
    });
    created.push(variant);

    if (repository.kind === "demo") {
      void recordAudit({
        action: "product.variant_created",
        entity: "product",
        entity_id: product.id,
        entity_label: product.sku,
        details: {
          product: product.sku,
          variant_id: variant.id,
          sku: variant.sku,
          color: variant.color_en ?? variant.color_ar ?? null,
          size: variantSizeValue(variant) || null,
          generated: true,
        },
      });
    }
  }
  return created;
}

/**
 * Archive (`false`) or reactivate (`true`) one combination.
 *
 * Archiving keeps every sale, return, movement, order and reservation that names
 * it readable — it only stops the combination being sellable. Reactivating is
 * the way back; nothing here deletes history.
 */
export async function setVariantActive(id: string, active: boolean): Promise<ProductVariant> {
  assertCanToggleVariant();
  const repository = getCatalogRepository();
  const before = (await repository.listVariants()).find((v) => v.id === id);
  if (!before) throw new AppError("VARIANT_NOT_FOUND", `Variant ${id} not found`);
  if (before.active === active) return before;

  const variant = await repository.setVariantActive(id, active);
  if (repository.kind === "demo") {
    void recordAudit({
      action: active ? "product.variant_reactivated" : "product.variant_archived",
      entity: "product",
      entity_id: variant.product_id,
      entity_label: variant.sku,
      details: {
        variant_id: variant.id,
        sku: variant.sku,
        color: variant.color_en ?? variant.color_ar ?? null,
        size: variantSizeValue(variant) || null,
        previous: !active,
        next: active,
      },
    });
  }
  return variant;
}

/** Permanently remove a combination that no history names. */
export async function deleteVariant(id: string): Promise<void> {
  assertCanDeleteVariant();
  const repository = getCatalogRepository();
  const variant = (await repository.listVariants()).find((v) => v.id === id);
  if (!variant) throw new AppError("VARIANT_NOT_FOUND", `Variant ${id} not found`);
  await repository.deleteVariant(id);
  if (repository.kind === "demo") {
    void recordAudit({
      action: "product.variant_deleted",
      entity: "product",
      entity_id: variant.product_id,
      entity_label: variant.sku,
      details: {
        variant_id: variant.id,
        sku: variant.sku,
        color: variant.color_en ?? variant.color_ar ?? null,
        size: variantSizeValue(variant) || null,
      },
    });
  }
}

// ── the conversion funnel ───────────────────────────────────────────────────

/**
 * Switch a product to variant stock, distributing the stock it already holds.
 *
 * Correction 1, in code: the admin says where the existing units go, the sum is
 * checked against the product's own figure (never against the variants' — they
 * start empty), and the conversion is refused rather than guessed. Each variant's
 * opening quantity is then recorded as its own `adjustment_in` movement, so the
 * shelf, the ledger and the report all agree afterwards.
 */
export async function enableVariants(
  productId: string,
  opening: readonly VariantOpening[],
): Promise<Product> {
  assertCanConvertVariants();
  const repository = getCatalogRepository();
  const actor = currentVariantActor();
  const product = (await repository.listProducts()).find((p) => p.id === productId);
  if (!product) throw new AppError("NOT_FOUND", `Product ${productId} not found`);
  if (product.variants_enabled) return product;

  const variants = (await repository.listVariants()).filter((v) => v.product_id === productId);
  if (variants.length === 0) {
    throw new AppError(
      "VALIDATION",
      `Add at least one variant before switching ${product.sku} to variant stock`,
      "variants",
    );
  }
  const byId = new Map(opening.map((entry) => [entry.variantId, Math.trunc(entry.quantity)]));
  const unknown = opening.find((entry) => !variants.some((v) => v.id === entry.variantId));
  if (unknown) {
    throw new AppError(
      "VARIANT_NOT_FOUND",
      `The opening quantities name a variant that does not belong to ${product.sku}`,
    );
  }
  const total = variants.reduce((sum, v) => sum + (byId.get(v.id) ?? 0), 0);
  if (total !== product.stock_quantity) {
    throw new AppError(
      "VARIANTS_STOCK_MISMATCH",
      `The opening quantities add up to ${total}, but ${product.sku} holds ${product.stock_quantity}`,
      "stock_quantity",
    );
  }

  // Supabase does this atomically inside the RPC. Demo records one movement
  // per exact shelf; a retry after an interrupted distribution must SKIP a
  // shelf whose opening movement already landed, never count it twice.
  if (repository.kind === "demo") {
    for (const variant of variants) {
      const quantity = byId.get(variant.id) ?? 0;
      if (variant.stock_quantity > 0 && variant.stock_quantity !== quantity) {
        throw new AppError("VARIANTS_STOCK_MISMATCH",
          `Opening stock on ${variant.sku} changed; review Inventory before retrying`, "stock_quantity");
      }
      if (quantity > 0 && variant.stock_quantity === 0) {
        await applyVariantMovement({
          productId,
          variantId: variant.id,
          type: "adjustment_in",
          reason: "other",
          quantity,
          notes: `Variant opening balance — ${variant.sku} switched to variant stock`,
          expectedAfter: quantity,
        });
      }
    }
  }

  const updated = await repository.enableProductVariants(productId, opening, actor);
  if (repository.kind === "demo") {
    void recordAudit({
      action: "product.variants_enabled",
      entity: "product",
      entity_id: updated.id,
      entity_label: updated.sku,
      details: {
        product: updated.name_en,
        sku: updated.sku,
        units: total,
        // Audit details are flat scalar values; the distribution is written as a
        // readable list so the row can be understood without a join.
        opening: variants
          .map((v) => `${v.sku}: ${byId.get(v.id) ?? 0}`)
          .join(", "),
      },
    });
  }
  return updated;
}

/**
 * Leave variant mode. Refused while any history names a variant, and refused
 * unless the consolidated figure equals what the variants hold — never a silent
 * collapse (correction 4).
 */
export async function disableVariants(
  productId: string,
  consolidatedStock: number,
): Promise<Product> {
  assertCanConvertVariants();
  const repository = getCatalogRepository();
  const actor = currentVariantActor();
  const product = (await repository.listProducts()).find((p) => p.id === productId);
  if (!product) throw new AppError("NOT_FOUND", `Product ${productId} not found`);
  if (!product.variants_enabled) return product;

  const variants = (await repository.listVariants()).filter((v) => v.product_id === productId);
  const references = await repository.listVariantReferences();
  const inUse = variants.filter((v) => (references[v.id] ?? 0) > 0);
  if (inUse.length > 0) {
    throw new AppError(
      "VARIANTS_IN_USE",
      `${product.sku} has variants named by history (${inUse
        .map((v) => v.sku)
        .join(", ")}); it stays in variant mode`,
      "variants",
    );
  }
  const total = variants.reduce((sum, v) => sum + v.stock_quantity, 0);
  if (Math.trunc(consolidatedStock) !== total) {
    throw new AppError(
      "VARIANTS_STOCK_MISMATCH",
      `The consolidated figure is ${Math.trunc(consolidatedStock)} but the variants hold ${total}`,
      "stock_quantity",
    );
  }

  // One honest movement explaining where the units went, then the flip.
  if (repository.kind === "demo" && total > 0) {
    await applyVariantMovement({
      productId,
      variantId: null,
      type: "adjustment_out",
      reason: "other",
      quantity: total,
      notes: `${product.sku} left variant stock — ${total} units consolidated onto the product`,
      expectedAfter: total,
    });
  }

  const updated = await repository.disableProductVariants(productId, consolidatedStock, actor);
  if (repository.kind === "demo") {
    void recordAudit({
      action: "product.variants_disabled",
      entity: "product",
      entity_id: updated.id,
      entity_label: updated.sku,
      details: {
        product: updated.name_en,
        sku: updated.sku,
        units: total,
        variants: variants.map((v) => v.sku).join(", "),
      },
    });
  }
  return updated;
}

// ── presentation helpers the screens share ──────────────────────────────────

/** "Gold / 17" for a variant, in the reader's language. */
export function labelOf(variant: ProductVariant, lang: "ar" | "en" = "en"): string {
  return variantLabel(variant, lang);
}

/** "17" — the numeric size without trailing zeros, or the textual fallback. */
export function sizeOf(variant: Pick<ProductVariant, "size" | "size_label"> & Partial<Pick<ProductVariant,"size_value">>): string {
  return variantSizeValue(variant);
}

export type { ProductVariant, VariantSummary };
