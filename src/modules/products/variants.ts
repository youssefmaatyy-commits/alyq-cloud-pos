/**
 * Product variants — colours, numeric sizes, and the exact combination's stock.
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
 *  · Sizes are NUMBERS. `16, 16.5, 17, 17.5` sort numerically everywhere; the
 *    textual size (`size_label`) exists only for the "One Size" case, where
 *    there is no number to order by.
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
  /** The numeric size — the primary model. Null only for a textual size. */
  size: number | null;
  /** Textual fallback, used only when `size` is null ("One Size"). */
  size_label: string | null;
  image_url: string | null;
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
export type NewProductVariant = Omit<ProductVariant, "id" | "color_key" | "created_at" | "updated_at"> & {
  color_key?: string;
};

export type ProductVariantPatch = Partial<NewProductVariant>;

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
  if (a.size !== null && b.size !== null && a.size !== b.size) return a.size - b.size;
  if (a.size === null && b.size !== null) return 1;
  if (a.size !== null && b.size === null) return -1;
  if ((a.size_label ?? "") !== (b.size_label ?? "")) {
    return (a.size_label ?? "").localeCompare(b.size_label ?? "");
  }
  if (a.sort_order !== b.sort_order) return a.sort_order - b.sort_order;
  return a.sku.localeCompare(b.sku);
}

// ── presentation ────────────────────────────────────────────────────────────

/** 17 → "17", 17.5 → "17.5", 17.25 → "17.25" — no trailing zeros, ever. */
export function sizeLabelOf(size: number | null, fallback: string | null): string {
  if (size === null || !Number.isFinite(size)) return (fallback ?? "").trim();
  return String(Math.round(size * 100) / 100);
}

/** "Gold / 17" — the colour first, then the size, in the reader's language. */
export function variantLabel(
  variant: Pick<ProductVariant, "color_en" | "color_ar" | "size" | "size_label">,
  lang: "ar" | "en" = "en",
): string {
  const color = (lang === "ar" ? variant.color_ar || variant.color_en : variant.color_en || variant.color_ar) ?? "";
  const size = sizeLabelOf(variant.size, variant.size_label);
  return [color.trim(), size].filter(Boolean).join(" / ");
}

/** The same label from a frozen snapshot (an invoice line, an order line). */
export function snapshotLabel(
  snapshot: Pick<VariantSnapshot, "color_en" | "color_ar" | "size" | "size_label">,
  lang: "ar" | "en" = "en",
): string {
  return variantLabel(snapshot, lang);
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
export function parseSizes(raw: string): number[] {
  if (!raw) return [];
  const parts = raw
    .replace(/[\u066B]/g, ".") // ٫ Arabic decimal separator
    .replace(/[\u060C\u066C,;]/g, " ") // Arabic comma, Arabic thousands, comma, semicolon
    .split(/\s+/);
  const seen = new Set<number>();
  for (const part of parts) {
    if (!part) continue;
    const value = Number(part);
    if (!Number.isFinite(value) || value <= 0) continue;
    seen.add(Math.round(value * 100) / 100);
  }
  return [...seen].sort((a, b) => a - b);
}

/** The size list back as text, for the input field. */
export function formatSizes(sizes: readonly number[]): string {
  return [...sizes].sort((a, b) => a - b).map((size) => sizeLabelOf(size, null)).join(", ");
}

export interface GeneratedCombination {
  color: VariantColorDraft | null;
  size: number | null;
  /** Stable identity used to avoid duplicates and to suggest a SKU. */
  color_key: string;
  size_label: string | null;
}

/**
 * colours × sizes, in a stable order, with duplicates impossible.
 *
 * Passing an empty colour list generates the size-only variants; an empty size
 * list generates the colour-only ones. This is what the "generate combinations"
 * button calls.
 */
export function generateCombinations(
  colors: readonly VariantColorDraft[],
  sizes: readonly number[],
): GeneratedCombination[] {
  const combinations: GeneratedCombination[] = [];
  const seen = new Set<string>();

  const push = (color: VariantColorDraft | null, size: number | null, sizeLabel: string | null) => {
    const key = `${color ? colorKeyOf(color) : ""}|${size === null ? `t:${sizeLabel ?? ""}` : size}`;
    if (seen.has(key)) return;
    seen.add(key);
    combinations.push({
      color,
      size,
      color_key: color ? colorKeyOf(color) : "",
      size_label: sizeLabel,
    });
  };

  if (colors.length === 0) {
    for (const size of [...sizes].sort((a, b) => a - b)) push(null, size, null);
    return combinations;
  }

  for (const color of colors) {
    if (sizes.length === 0) {
      push(color, null, null);
      continue;
    }
    for (const size of [...sizes].sort((a, b) => a - b)) push(color, size, null);
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
  color_ar: string | null;
  color_en: string | null;
}): string {
  return (color.color_en || color.color_ar || "").trim().replace(/\s+/g, " ").toLowerCase();
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
  color: { color_ar: string | null; color_en: string | null } | null,
  size: number | null,
  sizeLabel: string | null,
  taken: readonly string[] = [],
): string {
  const base = (baseSku || "VAR").toUpperCase().replace(/[^A-Z0-9-]/g, "").slice(0, 24) || "VAR";
  const colorPart = color
    ? (color.color_en || color.color_ar || "")
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, "")
        .slice(0, 6)
    : "";
  const sizePart = size !== null
    ? String(Math.round(size * 100) / 100).replace(".", "D")
    : (sizeLabel ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 4);
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
 * Returns the variant and its product, or null. Callers must treat a null as
 * "no such variant" and fall through to the product-level lookup — never as
 * "pick the first one".
 */
export function variantByCode(
  variants: readonly ProductVariant[],
  code: string,
): ProductVariant | null {
  const wanted = code.trim().toUpperCase();
  if (!wanted) return null;
  return (
    variants.find(
      (variant) =>
        variant.sku.toUpperCase() === wanted ||
        (variant.barcode ?? "").toUpperCase() === wanted ||
        (variant.color_hex ?? "").toUpperCase() === wanted,
    ) ?? null
  );
}
