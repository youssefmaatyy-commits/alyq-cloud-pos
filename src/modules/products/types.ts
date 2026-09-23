import type { VariantSummary } from "./variants";

/**
 * Products & Categories module — domain types.
 * Field names intentionally mirror the Supabase columns (snake_case) so no
 * mapping layer is needed between DB rows and the UI.
 */

export const PRODUCT_TYPES = [
  "physical",
  "service",
  "manufactured",
  "serial-tracked",
  "expiry-tracked",
] as const;

export type ProductType = (typeof PRODUCT_TYPES)[number];

export interface Product {
  id: string;
  sku: string;
  barcode: string | null;
  name_ar: string;
  name_en: string;
  description_ar: string | null;
  description_en: string | null;
  category_id: string | null;
  product_type: ProductType;
  selling_price: number;
  cost_price: number;
  tax_rate: number;
  stock_tracking_enabled: boolean;
  /** Current on-hand quantity (0 for non-tracked products). */
  stock_quantity: number;
  /** Alert threshold — warn when quantity ≤ this value (tracked products). */
  low_stock_level: number;
  /**
   * Phase 43: this product sells by variant (colour / size).
   *
   * When true, `product_variants.stock_quantity` is the stock authority and this
   * row's `stock_quantity` is the rollup the database keeps from it — for the
   * reports, the dashboard and every reader that predates variants. When false
   * the product-level stock behaves exactly as it always has.
   */
  variants_enabled: boolean;
  /**
   * Variant counts, filled in by whoever loaded the variants (the catalogue and
   * inventory lists, the POS, the storefront). Absent on a product that has none
   * loaded — which is also why it is optional rather than zeroed: "no variants"
   * and "not asked" are different answers.
   */
  variant_summary?: VariantSummary;
  /** Storefront visibility flag. */
  show_on_website: boolean;
  /** Featured / highlighted in the storefront. */
  is_featured: boolean;
  active: boolean;
  /** Primary (cover) image URL. */
  image_url: string | null;
  /** Additional gallery image URLs (cover is stored separately). */
  images: string[];
  created_at: string;
  updated_at: string;
}

export interface Category {
  id: string;
  name_ar: string;
  name_en: string;
  parent_id: string | null;
  active: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

/** Payload for creating a product (server fills id + timestamps). */
export type NewProduct = Omit<Product, "id" | "created_at" | "updated_at" | "variants_enabled"> & {
  /** Optional on create: the database defaults it to false. */
  variants_enabled?: boolean;
};
/** Patch for updating a product — partial, `id`/timestamps excluded. */
export type ProductPatch = Partial<NewProduct>;

export type NewCategory = Omit<Category, "id" | "created_at" | "updated_at">;
export type CategoryPatch = Partial<NewCategory>;

/** A category row enriched with tree metadata for the management page. */
export interface CategoryNode extends Category {
  children: CategoryNode[];
  depth: number;
  productCount: number;
  /** productCount including every descendant. */
  descendantProductCount: number;
  descendantCount: number;
}

export const UNCATEGORIZED_ID = "__uncategorized__";

/**
 * A single image slot in the product form. It is either an already-stored
 * image (`remote`) or a file freshly picked by the user that still needs to be
 * uploaded on save (`local`). The array order is meaningful: index 0 = cover.
 */
export type ProductImageItem =
  | { id: string; kind: "remote"; url: string }
  | { id: string; kind: "local"; file: File; previewUrl: string };

/** Stock state derived from a product's tracking + quantity + threshold. */
export type StockStatus = "none" | "in" | "low" | "out";

/**
 * Pure stock-status derivation, shared by lists, badges and filters.
 *
 * Phase 43: a variant product is classified from its ACTIVE VARIANTS, never from
 * the rollup. Twenty units of Silver/17 with none left of Gold/17 is not simply
 * "in stock" — somebody has to look at that shelf. The rules:
 *
 *   out  — no active variant has stock left (nothing can be sold)
 *   low  — something is sellable, but at least one active variant is at or under
 *          its own threshold
 *   in   — sellable, and nothing needs attention
 *
 * A legacy product keeps the exact rule it always had. When the summary has not
 * been loaded the function falls back to the rollup rather than pretending the
 * product is healthy — the rollup is still the sum, so "out" and "low" stay
 * conservative instead of wrong.
 */
export function stockStatus(
  product: Pick<Product, "stock_tracking_enabled" | "stock_quantity" | "low_stock_level"> &
    Partial<Pick<Product, "variants_enabled" | "variant_summary">>,
): StockStatus {
  if (!product.stock_tracking_enabled) return "none";

  if (product.variants_enabled && product.variant_summary && product.variant_summary.total > 0) {
    const summary = product.variant_summary;
    // Nothing sellable at all: the product is out, however many units the
    // rollup holds for archived rows.
    if (summary.available <= 0) return "out";
    // Something IS sellable, but at least one active combination is at or under
    // its own threshold — a sold-out size included, because that is exactly the
    // shelf nobody would notice from the product total.
    if (summary.low > 0 || summary.out > 0) return "low";
    return "in";
  }

  if (product.stock_quantity <= 0) return "out";
  if (product.low_stock_level > 0 && product.stock_quantity <= product.low_stock_level) {
    return "low";
  }
  return "in";
}

/** Derive a safe SKU suggestion from a name, used by the product form. */
export function suggestSku(name: string, existing: string[]): string {
  const base =
    (name || "ITEM")
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "")
      .slice(0, 6) || "ITEM";
  let candidate = base;
  let n = 1;
  const taken = new Set(existing.map((s) => s.toUpperCase()));
  while (taken.has(candidate)) {
    n += 1;
    candidate = `${base}-${String(n).padStart(3, "0")}`;
  }
  return candidate;
}

/** Margin as a percentage of the selling price. */
export function marginPct(selling: number, cost: number): number | null {
  if (!Number.isFinite(selling) || selling <= 0) return null;
  return ((selling - cost) / selling) * 100;
}
