import {
  colorKeyOf,
  generateCombinations,
  isFreeSizeModel,
  modelKeyOf,
  naturalSizeCompare,
  suggestModelSku,
  suggestVariantSku,
  variantGalleryProblem,
  variantSizeValue,
  type ProductColorImage,
  type ProductVariant,
  type VariantColorDraft,
} from "../variants";
import { deriveBarcodeFromSku } from "./barcode";

export type ProductVariantMode = "none" | "colors" | "sizes" | "colors_sizes" | "models";
export interface VariantColorRow {
  /** Stable UI identity. For saved colours this is the original color_key. */
  id: string;
  color_ar: string;
  color_en: string;
  color_hex: string;
  /** Ordered URLs shared by every size; first is primary. */
  image_urls: string[];
  /** Primary compatibility alias for older callers. */
  image_url: string;
}
export interface ProductVariantDraft {
  id: string;
  persistedId: string | null;
  color_id: string;
  /** Saved colour identity: NEVER recomputed when a label is renamed. */
  color_key: string;
  color_ar: string;
  color_en: string;
  color_hex: string;
  /** Authoritative flexible size value. */
  size: string;
  /** Legacy display compatibility. */
  size_label: string;
  size_sort_order: number;
  /** Model / shape name (for mode === "models"). */
  display_name_ar?: string;
  display_name_en?: string;
  /** Ordered model gallery (max 5 https URLs). */
  images?: string[];
  sku: string;
  barcode: string;
  stock_quantity: string;
  low_stock_level: string;
  price_override: string;
  cost_override: string;
  /** Optional per-combination image override. New rows inherit their colour URL. */
  image_url: string;
  active: boolean;
}
export interface ProductVariantFormValue {
  mode: ProductVariantMode;
  colors: VariantColorRow[];
  /** Ordered flexible values; array order is the explicit merchant order. */
  sizes: string[];
  rows: ProductVariantDraft[];
}
export const EMPTY_PRODUCT_VARIANT_FORM: ProductVariantFormValue = {
  mode: "none", colors: [], sizes: [], rows: [],
};

export const usesColors = (mode: ProductVariantMode) => mode === "colors" || mode === "colors_sizes";
export const usesSizes = (mode: ProductVariantMode) => mode === "sizes" || mode === "colors_sizes";
export const usesModels = (mode: ProductVariantMode) => mode === "models";

export function createModelDraftRow(
  productSku: string,
  modelNumber: number,
  takenSkus: readonly string[] = [],
): ProductVariantDraft {
  const num = Math.max(1, Math.trunc(modelNumber) || 1);
  const sku = suggestModelSku(productSku, num, takenSkus);
  return {
    id: `draft:model:${num}:${Math.random().toString(36).slice(2, 7)}`,
    persistedId: null,
    color_id: "",
    color_key: "",
    color_ar: "",
    color_en: "",
    color_hex: "",
    size: "",
    size_label: "",
    size_sort_order: num - 1,
    display_name_ar: `شكل ${num}`,
    display_name_en: `Model ${num}`,
    images: [],
    sku,
    // Models share the parent product's barcode by default (`barcode = ""` -> `null` in DB).
    barcode: "",
    stock_quantity: "0",
    low_stock_level: "0",
    price_override: "",
    cost_override: "",
    image_url: "",
    active: true,
  };
}

/** A color row is considered valid when at least one non-empty name exists in Arabic or English. */
export function hasValidColorName(color: {
  color_ar?: string | null;
  color_en?: string | null;
}): boolean {
  return Boolean((color.color_ar ?? "").trim() || (color.color_en ?? "").trim());
}

/** Check if distinct color rows contain duplicate identities or names. */
export function hasDuplicateColors(
  colors: readonly { color_ar?: string | null; color_en?: string | null; id?: string }[],
): boolean {
  const arSeen = new Set<string>();
  const enSeen = new Set<string>();
  const keySeen = new Set<string>();

  for (const c of colors) {
    const ar = (c.color_ar ?? "").trim().replace(/\s+/g, " ").toLowerCase();
    const en = (c.color_en ?? "").trim().replace(/\s+/g, " ").toLowerCase();
    const key = colorKeyOf(c);

    if (ar) {
      if (arSeen.has(ar)) return true;
      arSeen.add(ar);
    }
    if (en) {
      if (enSeen.has(en)) return true;
      enSeen.add(en);
    }
    if (key) {
      if (keySeen.has(key)) return true;
      keySeen.add(key);
    }
  }
  return false;
}

/** Check if sizes contain duplicate entries (case-insensitive & whitespace normalized). */
export function hasDuplicateSizes(sizes: readonly string[]): boolean {
  const seen = new Set<string>();
  for (const size of sizes) {
    const normalized = size.trim().toLowerCase();
    if (!normalized) continue;
    if (seen.has(normalized)) return true;
    seen.add(normalized);
  }
  return false;
}

const pairKey = (colorId: string, sizeValue: string | null) =>
  `${colorId}|${(sizeValue ?? "").trim().toLocaleLowerCase()}`;
const rowKey = (row: ProductVariantDraft) => pairKey(row.color_id, row.size);

/** New combinations are generated as the employee edits chips/rows — no second "generate" step. */
export function reconcileVariantDraft(value: ProductVariantFormValue, productSku: string): ProductVariantFormValue {
  if (value.mode === "none") return value; // a mode change never silently erases work
  if (value.mode === "models") {
    const modelRows = value.rows.filter(
      (row) => row.persistedId || row.id.startsWith("draft:model:") || (!row.color_id && !row.size),
    );
    const taken: string[] = [];
    const normalizedRows = modelRows.map((row, index) => {
      let nextSku = row.sku.trim();
      if (!row.persistedId && (!nextSku || /^MOD-M\d+$/i.test(nextSku)) && productSku.trim()) {
        nextSku = suggestModelSku(productSku, index + 1, taken);
      }
      if (nextSku) taken.push(nextSku);
      return {
        ...row,
        sku: nextSku,
        size_sort_order: index,
      };
    });
    return { ...value, rows: normalizedRows };
  }
  const colors = usesColors(value.mode)
    ? value.colors.filter((row) => hasValidColorName(row))
    : [];
  const sizes = usesSizes(value.mode)
    ? value.sizes.map((s) => s.trim()).filter(Boolean)
    : [];

  if ((usesColors(value.mode) && !colors.length) || (usesSizes(value.mode) && !sizes.length)) {
    return { ...value, rows: value.rows.filter((row) => row.persistedId) };
  }

  const byPair = new Map(value.rows.map((row) => [rowKey(row), row]));
  const taken = value.rows.map((row) => row.sku);

  // Cartesian generation: Colors × Sizes
  const combinations = generateCombinations(
    colors.map((row): VariantColorDraft => ({
      color_ar: row.color_ar?.trim() || null,
      color_en: row.color_en?.trim() || null,
      color_hex: row.color_hex?.trim() || null,
    })),
    sizes,
  );

  const rows = combinations.map((combination) => {
    // Match the exact color row from value.colors
    const color = combination.color
      ? colors.find((row) => {
          if (row.id && combination.color_key && row.id === combination.color_key) return true;
          const rowKey = colorKeyOf(row);
          if (rowKey && combination.color_key && rowKey === combination.color_key) return true;
          if (row.color_en?.trim() && combination.color?.color_en?.trim() &&
              row.color_en.trim().toLowerCase() === combination.color.color_en.trim().toLowerCase()) return true;
          if (row.color_ar?.trim() && combination.color?.color_ar?.trim() &&
              row.color_ar.trim().toLowerCase() === combination.color.color_ar.trim().toLowerCase()) return true;
          return false;
        }) ?? null
      : null;
    const colorId = color?.id ?? "";
    const previous = byPair.get(pairKey(colorId, combination.size_value));
    if (previous) {
      return {
        ...previous,
        color_ar: color?.color_ar?.trim() ?? "",
        color_en: color?.color_en?.trim() ?? "",
        color_hex: color?.color_hex?.trim() ?? "",
        size_sort_order: combination.size_sort_order,
      };
    }
    const sku = suggestVariantSku(productSku, combination.color, combination.size, combination.size_label, taken);
    taken.push(sku);
    return {
      id: `draft:${colorId}:${combination.size_value ?? ""}`,
      persistedId: null,
      color_id: colorId,
      color_key: colorId && !colorId.startsWith("color:") ? colorId : (color ? colorKeyOf(color) : ""),
      color_ar: color?.color_ar?.trim() ?? "",
      color_en: color?.color_en?.trim() ?? "",
      color_hex: color?.color_hex?.trim() ?? "",
      size: combination.size_value ?? "",
      size_label: combination.size_value ?? "",
      size_sort_order: combination.size_sort_order,
      sku,
      barcode: deriveBarcodeFromSku(sku),
      stock_quantity: "0",
      low_stock_level: "0",
      price_override: "",
      cost_override: "",
      image_url: "",
      active: true,
    } satisfies ProductVariantDraft;
  });

  // Retain any existing persisted combinations not in the generated set
  rows.push(...value.rows.filter((row) => row.persistedId && !rows.some((next) => next.id === row.id)));
  return { ...value, rows };
}

/** Reuse the same simple controls for Edit Product; no loss of SKUs or stock. */
export function variantDraftFromSaved(
  variants: readonly ProductVariant[],
  colorImages: readonly ProductColorImage[] = [],
): ProductVariantFormValue {
  if (!variants.length) return EMPTY_PRODUCT_VARIANT_FORM;
  const active = variants.filter((row) => row.active);
  const available = active.length ? active : variants;
  const hasColors = available.some((row) => Boolean(row.color_key));
  const hasSizes = available.some((row) => Boolean(variantSizeValue(row)));
  const hasModels = !hasColors && !hasSizes && available.some((row) => isFreeSizeModel(row));
  const mode: ProductVariantMode = hasModels
    ? "models"
    : hasColors && hasSizes
      ? "colors_sizes"
      : hasColors
        ? "colors"
        : "sizes";
  const colors: VariantColorRow[] = [];
  const sizes: string[] = [];
  for (const row of available) {
    if (hasColors && row.color_key && !colors.some((color) => color.id === row.color_key)) {
      const gallery = colorImages
        .filter((image) => image.product_id===row.product_id && image.color_key===row.color_key)
        .sort((a,b)=>Number(b.is_primary)-Number(a.is_primary)||a.sort_order-b.sort_order)
        .map((image)=>image.image_url);
      const imageUrls = gallery.length ? gallery : (row.image_url ? [row.image_url] : []);
      colors.push({ id: row.color_key, color_ar: row.color_ar ?? "", color_en: row.color_en ?? "",
        color_hex: row.color_hex ?? "", image_urls:imageUrls, image_url:imageUrls[0] ?? "" });
    }
    const sizeValue = variantSizeValue(row);
    if (sizeValue && !sizes.some((value) => value.toLocaleLowerCase() === sizeValue.toLocaleLowerCase())) sizes.push(sizeValue);
  }
  return {
    mode, colors, sizes: sizes.sort((a, b) => {
      const left = available.find((row) => variantSizeValue(row).toLocaleLowerCase() === a.toLocaleLowerCase())?.size_sort_order ?? 0;
      const right = available.find((row) => variantSizeValue(row).toLocaleLowerCase() === b.toLocaleLowerCase())?.size_sort_order ?? 0;
      return left === right ? naturalSizeCompare(a, b) : left - right;
    }),
    rows: variants.map((row) => ({
      id: row.id, persistedId: row.id, color_id: row.color_key, color_key: row.color_key,
      color_ar: row.color_ar ?? "", color_en: row.color_en ?? "", color_hex: row.color_hex ?? "",
      size: variantSizeValue(row), size_label: variantSizeValue(row),
      size_sort_order: row.size_sort_order ?? row.sort_order,
      display_name_ar: row.display_name_ar ?? "",
      display_name_en: row.display_name_en ?? "",
      images: row.images ?? [],
      sku: row.sku, barcode: row.barcode ?? "", stock_quantity: String(row.stock_quantity),
      low_stock_level: String(row.low_stock_level),
      price_override: row.price_override === null ? "" : String(row.price_override),
      cost_override: row.cost_override === null ? "" : String(row.cost_override),
      image_url: row.image_url ?? "", active: row.active,
    })),
  };
}

/** Stock total follows exact shelves (including an archived shelf if it still holds stock). */
export function variantDraftTotal(rows: readonly ProductVariantDraft[]): number {
  return rows.reduce((sum, row) => sum + (Number(row.stock_quantity) || 0), 0);
}

/** Refuse bad drafts *before* creating a product (a partly written product is not a form error). */
export function validateVariantDraft(value: ProductVariantFormValue, productSku: string, productBarcode = ""): string | null {
  if (value.mode === "none") return null;

  if (usesModels(value.mode)) {
    if (value.rows.length === 0) return "modelsRequired";
    const seenModelKeys = new Set<string>();
    for (const row of value.rows) {
      const key = modelKeyOf(row);
      if (!key) return "modelNameRequired";
      if (seenModelKeys.has(key)) return "duplicateModelName";
      seenModelKeys.add(key);
      if (row.price_override.trim()) return "invalidPrice";
      if (variantGalleryProblem(row.images ?? [])) return "invalidGallery";
    }
  }

  if (usesColors(value.mode)) {
    if (!value.colors.length || value.colors.some((c) => !hasValidColorName(c))) {
      return "colorsRequired";
    }
    if (hasDuplicateColors(value.colors)) {
      return "duplicateColor";
    }
    if (value.colors.some((c) => c.color_hex?.trim() && !/^#[0-9a-fA-F]{6}$/.test(c.color_hex.trim()))) {
      return "invalidColor";
    }
  }

  // Legacy One Size / textual-size rows have no numeric chip; they must remain
  // editable without inventing a new numeric combination just to press Save.
  if (usesSizes(value.mode)) {
    if (!value.sizes.length && !value.rows.some((row) => row.persistedId && row.size.trim())) {
      return "sizesRequired";
    }
    if (hasDuplicateSizes(value.sizes)) {
      return "duplicateSize";
    }
  }

  if (value.rows.length === 0) return "nothingToGenerate";
  const codes = new Set([productSku.trim().toUpperCase()]);
  const parentBarcode = productBarcode.trim().toUpperCase();
  const barcodes = new Set(parentBarcode ? [parentBarcode] : []);
  for (const row of value.rows) {
    const sku = row.sku.trim().toUpperCase();
    if (!sku || codes.has(sku) || sku.length > 40) return "duplicateSku";
    codes.add(sku);
    const barcode = row.barcode.trim().toUpperCase();
    const sharesParentBarcode = usesModels(value.mode) && (!barcode || barcode === parentBarcode);
    if (!sharesParentBarcode && barcode && (barcodes.has(barcode) || barcode.length > 80)) return "duplicateBarcode";
    if (!sharesParentBarcode && barcode) barcodes.add(barcode);
    if (!/^(0|[1-9]\d*)$/.test(row.stock_quantity) ||
        !/^(0|[1-9]\d*)$/.test(row.low_stock_level)) return "invalidQuantity";
    if (!row.active && Number(row.stock_quantity) > 0 && !row.persistedId) return "inactiveStock";
    for (const field of [row.price_override, row.cost_override]) {
      if (field.trim() && (!Number.isFinite(Number(field)) || Number(field) < 0)) return "invalidPrice";
    }
  }
  return null;
}
