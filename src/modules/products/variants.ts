/**
 * Product variants — colours, flexible ordered sizes, and exact-combination stock.
 *
 * This module is the one place that knows what a variant IS: the shape of the
 * row, how a combination is identified, how sizes are ordered, and how a
 * variant's stock health is read. Everything else (the catalogue form, the
 * register, the storefront, the inventory screen, the reports) imports from
 * here, so "Gold / 17" means the same thing on every screen and in both
 * repositories.
 *
 * The rules it encodes, and why:
 *
 *  · A combination's IDENTITY is `(product_id, color_key, size)` — never the
 *    display label. `color_key` is derived once from the first label and never
 *    rewritten, so renaming "Gold" to "Yellow Gold" (in either language) leaves
 *    the identity, the uniqueness rule and the history untouched.
 *
 *  · A size is an ordered merchant string. Numeric, letter, kids, pants,
 *    One Size, and future systems share `size_value`; `size_sort_order` is the
 *    explicit merchant order and natural comparison is the stable fallback.
 *
 *  · Stock belongs to the exact combination. `stock_quantity` here is that
 *    combination's own shelf — never a share of the product's rollup, never
 *    derived from a sibling. `product.stock_quantity` is the sum, kept for the
 *    reports and the readers that predate variants.
 */

import type { Product } from "./types";

// ── the row ─────────────────────────────────────────────────────────────────

export interface ProductVariant {
  id: string;
  product_id: string;
  sku: string;
  barcode: string | null;
  /** Stable colour identity — see the header. Empty for a size-only variant. */
  color_key: string;
  color_ar: string | null;
  color_en: string | null;
  /** Optional swatch. Never required: the shop may just type "Rose Gold". */
  color_hex: string | null;
  /** Legacy numeric projection, retained for old invoices and clients. */
  size: number | null;
  /** Legacy display snapshot compatibility. */
  size_label: string | null;
  /** Authoritative flexible size identity. */
  size_value?: string | null;
  /** Explicit merchant order for size options. */
  size_sort_order?: number;
  image_url: string | null;
  /**
   * Optional model/shape name ("شكل 1" / "Model 1") for a combination that has
   * no colour or size under a shared parent barcode (Migration 0097).
   */
  display_name_ar?: string | null;
  display_name_en?: string | null;
  /** Ordered variant gallery (max 5, https). Empty on legacy rows. */
  images?: string[];
  /** Null → the product's own selling_price. */
  price_override: number | null;
  /** Null → the product's own cost_price. */
  cost_override: number | null;
  stock_quantity: number;
  low_stock_level: number;
  active: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

/** What a form submits. `color_key` is derived by the database when omitted. */
export type NewProductVariant = Omit<ProductVariant, "id" | "color_key" | "size_value" | "size_sort_order" | "created_at" | "updated_at"> & {
  color_key?: string;
  size_value?: string | null;
  size_sort_order?: number;
};

export type ProductVariantPatch = Partial<NewProductVariant>;

/** One ordered image reference shared by every size of a product colour. */
export interface ProductColorImage {
  id: string;
  product_id: string;
  color_key: string;
  image_url: string;
  alt_ar: string | null;
  alt_en: string | null;
  sort_order: number;
  is_primary: boolean;
  created_at: string;
  updated_at: string;
}

export type ProductColorImageInput = Pick<
  ProductColorImage,
  "color_key" | "image_url" | "alt_ar" | "alt_en" | "sort_order" | "is_primary"
>;

/**
 * The parts of a variant a sale/order/return line carries with it.
 *
 * Frozen onto the line at the moment of the transaction, so an invoice still
 * reads "Gold / 17" after the variant has been renamed, re-priced or archived.
 */
export interface VariantSnapshot {
  variant_id: string;
  color_ar: string | null;
  color_en: string | null;
  size: number | null;
  size_label: string | null;
}

// ── health ──────────────────────────────────────────────────────────────────

export type VariantStatus = "in" | "low" | "out" | "archived";

/**
 * One variant's own health. `low` means its stock is at or under ITS OWN
 * threshold (a threshold of 0 means the shop never asked to be warned, so a
 * zero-stock variant is `out` rather than low).
 */
export function variantStatus(
  variant: Pick<ProductVariant, "active" | "stock_quantity" | "low_stock_level">,
): VariantStatus {
  if (!variant.active) return "archived";
  if (variant.stock_quantity <= 0) return "out";
  if (variant.low_stock_level > 0 && variant.stock_quantity <= variant.low_stock_level) return "low";
  return "in";
}

/** Counts a product can summarise itself with, without double counting. */
export interface VariantSummary {
  /** Every variant row, archived included. */
  total: number;
  /** Units across every variant — the same number as the product rollup. */
  units: number;
  /** Active variants with stock left. */
  available: number;
  /** Active variants at or under their own threshold (sold-out ones included). */
  low: number;
  /** Active variants with nothing left. */
  out: number;
}

export function summarizeVariants(variants: readonly ProductVariant[]): VariantSummary {
  let units = 0;
  let available = 0;
  let low = 0;
  let out = 0;
  for (const variant of variants) {
    units += variant.stock_quantity;
    if (!variant.active) continue;
    const status = variantStatus(variant);
    if (status === "out") {
      // Sold out: nothing left of THIS combination. A sold-out combination is
      // "at or under" any threshold it has, but the counts below stay disjoint
      // so the screen can say "2 low · 1 sold out" without double counting it.
      out += 1;
      continue;
    }
    if (status === "low") low += 1;
    if (variant.stock_quantity > 0) available += 1;
  }
  return { total: variants.length, units, available, low, out };
}

/** Group variants by their product, in display order. */
export function variantsByProduct(
  variants: readonly ProductVariant[],
): Map<string, ProductVariant[]> {
  const grouped = new Map<string, ProductVariant[]>();
  for (const variant of variants) {
    const list = grouped.get(variant.product_id);
    if (list) list.push(variant);
    else grouped.set(variant.product_id, [variant]);
  }
  for (const list of grouped.values()) list.sort(compareVariants);
  return grouped;
}

/**
 * Display order: colour, then NUMERIC size, then the shop's own ordering.
 *
 * `16 → 16.5 → 17 → 17.5` — never lexicographically ("17" before "16.5"), which
 * is what a string sort would give.
 */
export function compareVariants(a: ProductVariant, b: ProductVariant): number {
  if (a.color_key !== b.color_key) return a.color_key.localeCompare(b.color_key);
  if ((a.size_sort_order ?? 0) !== (b.size_sort_order ?? 0)) return (a.size_sort_order ?? 0) - (b.size_sort_order ?? 0);
  const sizeOrder = naturalSizeCompare(variantSizeValue(a), variantSizeValue(b));
  if (sizeOrder !== 0) return sizeOrder;
  if (a.sort_order !== b.sort_order) return a.sort_order - b.sort_order;
  const modelOrder = naturalSizeCollator.compare(modelNameOf(a) ?? "", modelNameOf(b) ?? "");
  if (modelOrder !== 0) return modelOrder;
  return a.sku.localeCompare(b.sku);
}

// ── presentation ────────────────────────────────────────────────────────────

/** 17 → "17", 17.5 → "17.5", 17.25 → "17.25" — no trailing zeros, ever. */
export function sizeLabelOf(size: number | null, fallback: string | null): string {
  if (size === null || !Number.isFinite(size)) return (fallback ?? "").trim();
  return String(Math.round(size * 100) / 100);
}

/** Flexible size, with a compatibility fallback for rows created before 0079. */
export function variantSizeValue(
  variant: Pick<ProductVariant, "size" | "size_label"> & Partial<Pick<ProductVariant, "size_value">>,
): string {
  return (variant.size_value ?? sizeLabelOf(variant.size, variant.size_label)).trim();
}

const LETTER_SIZE_ORDER = new Map([
  "XXXS", "XXS", "XS", "S", "M", "L", "XL", "XXL", "XXXL", "4XL", "5XL", "6XL",
].map((value, index) => [value, index]));
const naturalSizeCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** Natural fallback ordering across numeric, kids, pants and named systems. */
export function naturalSizeCompare(a: string, b: string): number {
  const left = a.trim();
  const right = b.trim();
  if (left.toLocaleLowerCase() === right.toLocaleLowerCase()) return 0;
  const leftLetter = LETTER_SIZE_ORDER.get(left.toUpperCase());
  const rightLetter = LETTER_SIZE_ORDER.get(right.toUpperCase());
  if (leftLetter !== undefined && rightLetter !== undefined) return leftLetter - rightLetter;
  if (leftLetter !== undefined) return -1;
  if (rightLetter !== undefined) return 1;
  const leftOne = /^(one[ -]?size|free[ -]?size|مقاس واحد)$/iu.test(left);
  const rightOne = /^(one[ -]?size|free[ -]?size|مقاس واحد)$/iu.test(right);
  if (leftOne !== rightOne) return leftOne ? 1 : -1;
  return naturalSizeCollator.compare(left, right);
}

/** The model name in the reader's language, falling back across the pair. */
export function modelNameOf(
  variant: Partial<Pick<ProductVariant, "display_name_ar" | "display_name_en">>,
  lang: "ar" | "en" = "en",
): string | null {
  const en = (variant.display_name_en ?? "").trim();
  const ar = (variant.display_name_ar ?? "").trim();
  const value = lang === "ar" ? ar || en : en || ar;
  return value || null;
}

/**
 * A free-size model: a named combination with no colour and no size. Such a
 * variant never asks the shopper or the cashier for a size.
 */
export function isFreeSizeModel(
  variant: Partial<Pick<ProductVariant, "color_key" | "color_en" | "color_ar" | "size" | "size_label" | "size_value" | "display_name_ar" | "display_name_en">>,
): boolean {
  const hasColour = Boolean((variant.color_key ?? "").trim() || (variant.color_en ?? "").trim() || (variant.color_ar ?? "").trim());
  const hasSize = Boolean(variantSizeValue({ size: variant.size ?? null, size_label: variant.size_label ?? null, size_value: variant.size_value }));
  return !hasColour && !hasSize && modelNameOf(variant) !== null;
}

/**
 * The variant's own pictures in shop order: its gallery first, then the cover
 * `image_url` if the gallery does not already carry it. Never shared with a
 * sibling variant.
 */
export function variantGalleryOf(
  variant: Partial<Pick<ProductVariant, "images" | "image_url">>,
): string[] {
  const gallery = (variant.images ?? []).filter((url): url is string => typeof url === "string" && url.trim() !== "");
  const cover = variant.image_url ?? null;
  const all = cover && !gallery.includes(cover) ? [...gallery, cover] : gallery;
  return [...new Set(all)];
}

/** Identity of a model name inside one product (case- and space-insensitive). */
export function modelKeyOf(variant: Partial<Pick<ProductVariant, "display_name_ar" | "display_name_en">>): string {
  return (modelNameOf(variant) ?? "").replace(/\s+/g, " ").toLocaleLowerCase();
}

/** Most photos one variant may carry (mirrors migration 0097). */
export const VARIANT_GALLERY_LIMIT = 5;

/** Why a gallery cannot be saved, or null when it can. */
export function variantGalleryProblem(urls: readonly string[]): string | null {
  if (urls.length > VARIANT_GALLERY_LIMIT) return "too_many";
  if (urls.some((url) => !/^https?:\/\/\S+$/i.test(url) || url.length > 2048)) return "invalid_url";
  return null;
}

/**
 * "Gold / 17" — the colour first, then the size, in the reader's language. A
 * free-size model has no colour or size, so its label is the model name
 * ("شكل 1" / "Model 1").
 */
export function variantLabel(
  variant: Pick<ProductVariant, "color_en" | "color_ar" | "size" | "size_label"> &
    Partial<Pick<ProductVariant, "size_value" | "display_name_ar" | "display_name_en">>,
  lang: "ar" | "en" = "en",
): string {
  const color = (lang === "ar" ? variant.color_ar || variant.color_en : variant.color_en || variant.color_ar) ?? "";
  const primary = color.trim() || modelNameOf(variant, lang) || "";
  const size = variantSizeValue(variant);
  return [primary, size].filter(Boolean).join(" / ");
}

/** The same label from a frozen snapshot (an invoice line, an order line). */
export function snapshotLabel(
  snapshot: Pick<VariantSnapshot, "color_en" | "color_ar" | "size" | "size_label"> & {
    variant_display_name?: string | null;
    display_name_ar?: string | null;
    display_name_en?: string | null;
  },
  lang: "ar" | "en" = "en",
): string {
  return variantLabel(
    {
      ...snapshot,
      display_name_ar: snapshot.display_name_ar ?? snapshot.variant_display_name ?? null,
      display_name_en: snapshot.display_name_en ?? snapshot.variant_display_name ?? null,
    },
    lang,
  );
}

/** What this variant actually sells for, given its product. */
export function variantPrice(
  variant: Pick<ProductVariant, "price_override">,
  product: Pick<Product, "selling_price">,
): number {
  return variant.price_override ?? product.selling_price;
}

/** What this variant actually costs, given its product. */
export function variantCost(
  variant: Pick<ProductVariant, "cost_override">,
  product: Pick<Product, "cost_price">,
): number {
  return variant.cost_override ?? product.cost_price;
}

/** The colour values a form can offer, in first-seen order. */
export interface VariantColorDraft {
  /** Either language may carry the colour; at least one is required in practice. */
  color_ar: string | null;
  color_en: string | null;
  color_hex: string | null;
}

// ── sizes ───────────────────────────────────────────────────────────────────

/**
 * Parse what the admin typed into NUMBERS.
 *
 * Accepts one per line or comma/space separated, an Arabic decimal separator,
 * and trailing separators — so "16، 17 17.5," is three sizes. Anything that is
 * not a positive number is dropped rather than guessed, and the result is
 * de-duplicated and sorted ascending: 16 → 16.5 → 17.
 */
export function parseSizes(raw: string): string[] {
  if (!raw.trim()) return [];
  const normalized = raw.replace(/[\u060C;]/g, ",").replace(/\r/g, "\n");
  let parts = normalized.split(/[,\n]+/).map((value) => value.trim()).filter(Boolean);
  // Preserve the familiar "16 17 18" shortcut only when every token is numeric.
  if (parts.length === 1 && /^\d+(?:[.\u066B]\d+)?(?:\s+\d+(?:[.\u066B]\d+)?)+$/.test(parts[0])) {
    parts = parts[0].split(/\s+/);
  }
  const seen = new Set<string>();
  const result: string[] = [];
  for (const part of parts) {
    const value = part.replace(/\u066B/g, ".").replace(/\s+/g, " ").trim();
    if (!value || value.length > 80) continue;
    const key = value.toLocaleLowerCase();
    if (!seen.has(key)) { seen.add(key); result.push(value); }
  }
  return result.sort(naturalSizeCompare);
}

/** The ordered size list back as comma-separated text. */
export function formatSizes(sizes: readonly string[]): string {
  return sizes.join(", ");
}

export interface GeneratedCombination {
  color: VariantColorDraft | null;
  /** Legacy numeric projection when the size is a simple positive number. */
  size: number | null;
  /** Authoritative flexible size identity. */
  size_value: string | null;
  /** Stable identity used to avoid duplicates and to suggest a SKU. */
  color_key: string;
  /** Legacy display compatibility copy. */
  size_label: string | null;
  size_sort_order: number;
}

const legacyNumericSize = (value: string | null): number | null => {
  if (!value || !/^[0-9]+(?:\.[0-9]{1,2})?$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 && parsed < 1_000_000 ? parsed : null;
};

/** colours × flexible sizes, preserving explicit merchant size order. */
export function generateCombinations(
  colors: readonly VariantColorDraft[],
  sizes: readonly string[],
): GeneratedCombination[] {
  const combinations: GeneratedCombination[] = [];
  const seen = new Set<string>();
  const push = (color: VariantColorDraft | null, sizeValue: string | null, sizeSortOrder: number) => {
    const normalized = sizeValue?.trim() || null;
    const key = `${color ? colorKeyOf(color) : ""}|${normalized?.toLocaleLowerCase() ?? ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    combinations.push({
      color,
      size: legacyNumericSize(normalized),
      size_value: normalized,
      color_key: color ? colorKeyOf(color) : "",
      size_label: normalized,
      size_sort_order: sizeSortOrder,
    });
  };
  const orderedSizes = sizes.map((value) => value.trim()).filter(Boolean);
  if (colors.length === 0) {
    orderedSizes.forEach((size, index) => push(null, size, index));
    return combinations;
  }
  for (const color of colors) {
    if (orderedSizes.length === 0) push(color, null, 0);
    else orderedSizes.forEach((size, index) => push(color, size, index));
  }
  return combinations;
}

/**
 * The colour's stable identity — the same normalisation the database uses
 * (`public.variant_color_key`): trimmed, whitespace collapsed, case-folded. It
 * is captured once, when the combination is created, and never rewritten by a
 * later rename, which is what keeps history and uniqueness pointing at the same
 * shelf after the shop renames a colour.
 */
export function colorKeyOf(color: {
  color_ar?: string | null;
  color_en?: string | null;
}): string {
  const en = (color.color_en ?? "").trim();
  const ar = (color.color_ar ?? "").trim();
  return (en || ar).replace(/\s+/g, " ").toLowerCase();
}

/**
 * A suggested SKU for a combination: `ALYQ-R001-G17`.
 *
 * A suggestion only — the admin can overtype it, and the database is what
 * enforces uniqueness. Kept short (the column allows 40 characters) and derived
 * from the colour and the size so a printed label is readable at a glance.
 */
export function suggestVariantSku(
  baseSku: string,
  color: { color_ar?: string | null; color_en?: string | null } | null,
  size: number | string | null,
  sizeLabel: string | null,
  taken: readonly string[] = [],
): string {
  const base = (baseSku || "VAR").toUpperCase().replace(/[^A-Z0-9-]/g, "").slice(0, 24) || "VAR";
  const en = (color?.color_en ?? "").trim();
  const ar = (color?.color_ar ?? "").trim();
  const colorPart = (en || ar)
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 6);
  const rawSize = size === null ? (sizeLabel ?? "") : String(size);
  const sizePart = rawSize.toUpperCase().replace(/[^A-Z0-9]/g, "").replace(".", "D").slice(0, 8);
  const stem = [base, colorPart, sizePart].filter(Boolean).join("-").slice(0, 36);

  let candidate = stem;
  let n = 1;
  const used = new Set(taken.map((sku) => sku.trim().toUpperCase()));
  while (used.has(candidate)) {
    n += 1;
    candidate = `${stem.slice(0, 36)}-${n}`;
  }
  return candidate;
}

/**
 * Suggest a unique internal SKU for an individual model/shape under a parent
 * product: e.g. `BR101` + model #1 -> `BR101-M01`, model #2 -> `BR101-M02`.
 */
export function suggestModelSku(
  baseSku: string,
  modelNumber: number,
  taken: readonly string[] = [],
): string {
  const base = (baseSku || "MOD").toUpperCase().replace(/[^A-Z0-9-]/g, "").slice(0, 28) || "MOD";
  const used = new Set(taken.map((sku) => sku.trim().toUpperCase()));
  let num = Math.max(1, Math.trunc(modelNumber) || 1);
  let candidate = `${base}-M${String(num).padStart(2, "0")}`;
  while (used.has(candidate)) {
    num += 1;
    candidate = `${base}-M${String(num).padStart(2, "0")}`;
  }
  return candidate;
}

// ── the exact combination, for the register and the storefront ──────────────

/**
 * The variants a customer may actually buy from a product right now: active,
 * and with stock left. Archived variants and empty shelves are excluded, which
 * is what makes a sold-out size button disabled rather than addable.
 */
export function sellableVariants(variants: readonly ProductVariant[]): ProductVariant[] {
  return variants.filter((variant) => variant.active && variant.stock_quantity > 0).sort(compareVariants);
}

/** True when this product needs the customer to pick a combination. */
export function needsVariantChoice(
  product: Pick<Product, "variants_enabled">,
  variants: readonly ProductVariant[],
): boolean {
  return product.variants_enabled && variants.length > 0;
}

/**
 * Find the exact combination a scanned code belongs to.
 *
 * Returns the variant ONLY when the code unambiguously identifies one variant;
 * otherwise returns null so the caller falls through to the product-level
 * lookup and opens the visual model/variant picker — never picking the first one.
 */
export function variantByCode(
  variants: readonly ProductVariant[],
  code: string,
): ProductVariant | null {
  const wanted = code.trim().toUpperCase();
  if (!wanted) return null;
  const matches = variants.filter(
    (variant) =>
      variant.sku.toUpperCase() === wanted ||
      (variant.barcode ?? "").toUpperCase() === wanted,
  );
  return matches.length === 1 ? matches[0] : null;
}
