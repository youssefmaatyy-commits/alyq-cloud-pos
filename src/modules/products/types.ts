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
export type NewProduct = Omit<Product, "id" | "created_at" | "updated_at">;
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

/** Generate a stable, collision-safe id for an image item (used as React key). */
export function newImageId(prefix = "img"): string {
  const rand =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID().slice(0, 13)
      : Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  return `${prefix}-${rand}`;
}

/** Stock state derived from a product's tracking + quantity + threshold. */
export type StockStatus = "none" | "in" | "low" | "out";

/** Pure stock-status derivation, shared by lists, badges and filters. */
export function stockStatus(
  product: Pick<Product, "stock_tracking_enabled" | "stock_quantity" | "low_stock_level">,
): StockStatus {
  if (!product.stock_tracking_enabled) return "none";
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
