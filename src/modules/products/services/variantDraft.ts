import {
  colorKeyOf, generateCombinations, sizeLabelOf, suggestVariantSku,
  type ProductVariant, type VariantColorDraft,
} from "../variants";

export type ProductVariantMode = "none" | "colors" | "sizes" | "colors_sizes";
export interface VariantColorRow {
  /** Stable UI identity. For saved colours this is the original color_key. */
  id: string;
  color_ar: string;
  color_en: string;
  color_hex: string;
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
  size: string;
  size_label: string;
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
  sizes: number[];
  rows: ProductVariantDraft[];
}
export const EMPTY_PRODUCT_VARIANT_FORM: ProductVariantFormValue = {
  mode: "none", colors: [], sizes: [], rows: [],
};

export const usesColors = (mode: ProductVariantMode) => mode === "colors" || mode === "colors_sizes";
export const usesSizes = (mode: ProductVariantMode) => mode === "sizes" || mode === "colors_sizes";

const pairKey = (colorId: string, size: number | null, label = "") =>
  `${colorId}|${size === null ? `label:${label}` : `number:${sizeLabelOf(size, null)}`}`;
const rowKey = (row: ProductVariantDraft) => pairKey(
  row.color_id,
  row.size.trim() ? Number(row.size.replace(",", ".")) : null,
  row.size_label,
);

/** New combinations are generated as the employee edits chips/rows — no second "generate" step. */
export function reconcileVariantDraft(value: ProductVariantFormValue, productSku: string): ProductVariantFormValue {
  if (value.mode === "none") return value; // a mode change never silently erases work
  const colors = usesColors(value.mode)
    ? value.colors.filter((row) => (row.color_en || row.color_ar).trim())
    : [];
  const sizes = usesSizes(value.mode) ? value.sizes : [];
  if ((usesColors(value.mode) && !colors.length) || (usesSizes(value.mode) && !sizes.length)) {
    return { ...value, rows: value.rows.filter((row) => row.persistedId) };
  }
  const byPair = new Map(value.rows.map((row) => [rowKey(row), row]));
  const taken = value.rows.map((row) => row.sku);
  const combinations = generateCombinations(
    colors.map((row): VariantColorDraft => ({ color_ar: row.color_ar || null, color_en: row.color_en || null, color_hex: row.color_hex || null })),
    sizes,
  );
  const rows = combinations.map((combination) => {
    // The generator de-duplicates normalized colour keys; use the same identity
    // here. Duplicate labels are reported by validateVariantDraft, not saved.
    const color = combination.color ? colors.find((row) => colorKeyOf(row) === combination.color_key) : null;
    const colorId = color?.id ?? "";
    const previous = byPair.get(pairKey(colorId, combination.size, combination.size_label ?? ""));
    if (previous) return {
      ...previous, color_ar: color?.color_ar ?? "", color_en: color?.color_en ?? "",
      color_hex: color?.color_hex ?? "",
    };
    const sku = suggestVariantSku(productSku, combination.color, combination.size, combination.size_label, taken);
    taken.push(sku);
    return {
      id: `draft:${colorId}:${combination.size ?? combination.size_label ?? ""}`,
      // A renamed saved colour keeps its original identity even for NEW sizes.
      // Otherwise Gold → Yellow Gold would put size 19 on a different colour
      // shelf than the existing sizes 17/18, and reopen the editor as a
      // duplicate-label draft that cannot be saved.
      persistedId: null, color_id: colorId,
      color_key: colorId && !colorId.startsWith("color:") ? colorId : "",
      color_ar: color?.color_ar ?? "", color_en: color?.color_en ?? "",
      color_hex: color?.color_hex ?? "",
      size: combination.size === null ? "" : sizeLabelOf(combination.size, null),
      size_label: combination.size_label ?? "",
      sku, barcode: "", stock_quantity: "0", low_stock_level: "0",
      price_override: "", cost_override: "", image_url: "", active: true,
    } satisfies ProductVariantDraft;
  });
  // Existing combinations removed from the chips are *never* deleted here.
  // The persisted row remains visible, and the editor prevents removing an
  // option with saved shelves. Archiving/deletion has a separate guarded path.
  rows.push(...value.rows.filter((row) => row.persistedId && !rows.some((next) => next.id === row.id)));
  return { ...value, rows };
}

/** Reuse the same simple controls for Edit Product; no loss of SKUs or stock. */
export function variantDraftFromSaved(variants: readonly ProductVariant[]): ProductVariantFormValue {
  if (!variants.length) return EMPTY_PRODUCT_VARIANT_FORM;
  const active = variants.filter((row) => row.active);
  const available = active.length ? active : variants;
  const hasColors = available.some((row) => Boolean(row.color_key));
  const hasSizes = available.some((row) => row.size !== null || Boolean(row.size_label));
  const mode: ProductVariantMode = hasColors && hasSizes ? "colors_sizes" : hasColors ? "colors" : "sizes";
  const colors: VariantColorRow[] = [];
  const sizes: number[] = [];
  for (const row of available) {
    if (hasColors && row.color_key && !colors.some((color) => color.id === row.color_key)) {
      colors.push({ id: row.color_key, color_ar: row.color_ar ?? "", color_en: row.color_en ?? "",
        color_hex: row.color_hex ?? "", image_url: row.image_url ?? "" });
    }
    if (row.size !== null && !sizes.includes(row.size)) sizes.push(row.size);
  }
  return {
    mode, colors, sizes: sizes.sort((a, b) => a - b),
    rows: variants.map((row) => ({
      id: row.id, persistedId: row.id, color_id: row.color_key, color_key: row.color_key,
      color_ar: row.color_ar ?? "", color_en: row.color_en ?? "", color_hex: row.color_hex ?? "",
      size: row.size === null ? "" : sizeLabelOf(row.size, null), size_label: row.size_label ?? "",
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
  if (usesColors(value.mode)) {
    if (!value.colors.length || value.colors.some((c) => !(c.color_en || c.color_ar).trim())) return "colorsRequired";
    const keys = value.colors.map(colorKeyOf);
    if (new Set(keys).size !== keys.length) return "duplicateColor";
    if (value.colors.some((c) => c.color_hex.trim() && !/^#[0-9a-fA-F]{6}$/.test(c.color_hex.trim()))) return "invalidColor";
  }
  // Legacy One Size / textual-size rows have no numeric chip; they must remain
  // editable without inventing a new numeric combination just to press Save.
  if (usesSizes(value.mode) && !value.sizes.length &&
      !value.rows.some((row) => row.persistedId && row.size_label.trim())) return "sizesRequired";
  if (value.rows.length === 0) return "nothingToGenerate";
  const codes = new Set([productSku.trim().toUpperCase()]);
  const barcodes = new Set(productBarcode.trim() ? [productBarcode.trim().toUpperCase()] : []);
  for (const row of value.rows) {
    const sku = row.sku.trim().toUpperCase();
    if (!sku || codes.has(sku) || sku.length > 40) return "duplicateSku";
    codes.add(sku);
    const barcode = row.barcode.trim().toUpperCase();
    if (barcode && (barcodes.has(barcode) || barcode.length > 80)) return "duplicateBarcode";
    if (barcode) barcodes.add(barcode);
    if (!/^(0|[1-9]\d*)$/.test(row.stock_quantity) ||
        !/^(0|[1-9]\d*)$/.test(row.low_stock_level)) return "invalidQuantity";
    if (!row.active && Number(row.stock_quantity) > 0 && !row.persistedId) return "inactiveStock";
    for (const field of [row.price_override, row.cost_override]) {
      if (field.trim() && (!Number.isFinite(Number(field)) || Number(field) < 0)) return "invalidPrice";
    }
  }
  return null;
}
