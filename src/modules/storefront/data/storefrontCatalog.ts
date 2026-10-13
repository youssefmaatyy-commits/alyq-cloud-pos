/**
 * Storefront data layer — public-facing product catalog.
 *
 * Only returns products where `active = true` AND `show_on_website = true`.
 * Works in both Supabase mode (live) and demo mode (localStorage seed).
 * No authentication required — this is the public storefront.
 *
 * In live mode the two reads go through `storefront_catalogue()` and
 * `storefront_categories_v2()` instead of through the tables, and that is not a
 * stylistic choice: every policy on `products` and `categories` is
 * `to authenticated`, so a visitor's select on the table returns zero rows and
 * the shop window is empty. The functions are `security definer` with a fixed
 * column list (migration 0030), so an anonymous caller gets exactly the public
 * fields — never `cost_price`, never `low_stock_level`, never who created the
 * row — and cannot widen the query, add a filter or reach a hidden product,
 * because the shape of the answer is decided in the database rather than here.
 */

import { getSupabaseClient, getRepositoryMode } from "@/lib/supabase/client";
import type { Product, Category } from "@/modules/products/types";
import type { StoreVariant } from "@/modules/online/services/pricing";
import { getDemoRepository } from "@/modules/products/data/demoRepository";


export interface StoreColorImage {
  id: string;
  product_id: string;
  color_key: string;
  image_url: string;
  alt_ar: string | null;
  alt_en: string | null;
  sort_order: number;
  is_primary: boolean;
}

/**
 * What `storefront_catalogue()` returns: every `Product` column except the two
 * that are internal to the business. Both are filled in by {@link toProduct}
 * with values that cannot change what the storefront renders — no storefront
 * code path reads a margin, and `stockStatus()` (the only consumer of
 * `low_stock_level`) is never called from the public side.
 */
type StorefrontProductRow = Omit<Product, "cost_price" | "low_stock_level">;

/**
 * Phase 45: `storefront_categories_v2()` returns the same row with the shop
 * window's content columns appended. The content itself is read through the
 * settings snapshot (`storefront_category_content` is anon-readable by policy);
 * here the extras are stripped so the storefront's `Category` objects stay
 * exactly the catalogue's — one shape, one set of rules.
 */
type StorefrontCategoryV2Row = Category & {
  content_title_ar: string | null;
  content_title_en: string | null;
  content_description_ar: string | null;
  content_description_en: string | null;
  content_image_url: string | null;
  content_mobile_image_url: string | null;
  content_homepage_image_url: string | null;
  featured: boolean;
  storefront_sort: number | null;
};

const toPublicCategory = (row: StorefrontCategoryV2Row): Category => ({
  id: row.id,
  name_ar: row.name_ar,
  name_en: row.name_en,
  parent_id: row.parent_id,
  active: row.active,
  sort_order: row.sort_order,
  created_at: row.created_at,
  updated_at: row.updated_at,
});

export const toProduct = (row: StorefrontProductRow): Product => ({
  ...row,
  // Absent from the published read on purpose. 0 is inert here: `stockStatus()`
  // only treats a threshold as meaningful when it is greater than 0.
  cost_price: 0,
  low_stock_level: 0,
  // `storefront_catalogue()` (migration 0030) predates `variants_enabled`
  // (migration 0043) and was never updated to select it, so this column is
  // simply missing from every live row — `...row` leaves it `undefined`,
  // which is falsy. That silently hid the PDP's colour/size chooser for
  // every variant product on a live (Supabase) storefront, however many
  // real, active combinations it had — a bug demo-mode testing could not
  // catch, because demo mode reads full `Product` rows straight from the
  // repository and never goes through this RPC. Default to false here and
  // let `patchVariantsEnabled` below correct it from real variant presence.
  variants_enabled: false,
});

/**
 * Recovers the `variants_enabled` flag `storefront_catalogue()` cannot supply
 * yet, without widening what the RPC returns or touching the schema. Its
 * companion, `storefront_product_variants()`, already enforces
 * `p.variants_enabled = true` in its own WHERE clause (migration 0043) — so a
 * product appearing at all in that result is proof positive the flag is true
 * in the database, no matter what `storefront_catalogue()` said. A variant
 * product with zero currently-active combinations still reads as a simple,
 * non-variant, out-of-stock product, which is the honest fallback: there is
 * nothing left to choose between.
 */
export function patchVariantsEnabled(products: Product[], variants: readonly StoreVariant[]): Product[] {
  const productIdsWithVariants = new Set(variants.map((variant) => variant.product_id));
  if (productIdsWithVariants.size === 0) return products;
  return products.map((product) =>
    productIdsWithVariants.has(product.id) ? { ...product, variants_enabled: true } : product);
}

/** Fetch only website-visible, active products + active categories. */
export async function fetchStorefrontCatalog(): Promise<{
  products: Product[];
  categories: Category[];
  /**
   * Phase 43: the published combinations of the published variant products.
   * Empty for a shop that sells nothing by variant — the pages render exactly
   * as they did before this existed.
   */
  variants: StoreVariant[];
  colorImages: StoreColorImage[];
  mode: "supabase" | "demo";
}> {
  if (getRepositoryMode() === "supabase") {
    const client = getSupabaseClient();
    if (!client) throw new Error("Supabase client unavailable");

    // The three reads are independent, so they travel together. The variant one
    // goes through `storefront_product_variants()` (0043) for the same reason
    // the other two go through their functions: the shape of the answer is
    // decided in the database, and it is the public shape — colour, size,
    // swatch, price override, stock on hand — never cost, never a threshold,
    // never an unpublished product or an archived combination.
    const [productResult, categoryResult, variantResult,colorImageResult] = await Promise.all([
      client.rpc("storefront_catalogue"),
      client.rpc("storefront_categories_v2"),
      client.rpc("storefront_branch_product_variants"),
      client.rpc("storefront_color_images"),
    ]);

    if (productResult.error) throw productResult.error;
    if (categoryResult.error) throw categoryResult.error;
    // A shop upgraded before 0043 has no such function yet; an empty shelf of
    // combinations is the honest answer, not a broken storefront.
    if (variantResult.error) {
      console.warn("[storefront] variant list unavailable", variantResult.error.message);
    }

    const liveVariants = (variantResult.error ? [] : (variantResult.data ?? [])) as StoreVariant[];
    return {
      products: patchVariantsEnabled(
        ((productResult.data ?? []) as StorefrontProductRow[]).map(toProduct),
        liveVariants,
      ),
      categories: ((categoryResult.data ?? []) as StorefrontCategoryV2Row[]).map(toPublicCategory),
      variants: liveVariants,
      colorImages: (colorImageResult.error ? [] : (colorImageResult.data ?? [])) as StoreColorImage[],
      mode: "supabase",
    };
  }

  // Demo mode — filter the demo seed for website-visible products, and the
  // combinations down to those of the visible variant products, shaped as the
  // live RPC shapes them: no cost, no threshold. The storefront has no use for
  // either, and demo should not render one either.
  const repo = getDemoRepository();
  const [allProducts, allCategories, allVariants,allColorImages] = await Promise.all([
    repo.listProducts(),
    repo.listCategories(),
    repo.listVariants(),
    repo.listColorImages(),
  ]);

  const visible = new Set(
    allProducts.filter((p) => p.active && p.show_on_website && p.variants_enabled).map((p) => p.id),
  );
  const variants: StoreVariant[] = allVariants
    .filter((v) => visible.has(v.product_id) && v.active)
    .map((v) => ({
      id: v.id,
      product_id: v.product_id,
      sku: v.sku,
      color_key: v.color_key,
      color_ar: v.color_ar,
      color_en: v.color_en,
      color_hex: v.color_hex,
      size: v.size,
      size_label: v.size_label,
      size_value: v.size_value,
      size_sort_order: v.size_sort_order,
      image_url: v.image_url,
      price_override: v.price_override,
      stock_quantity: v.stock_quantity,
      active: v.active,
      sort_order: v.sort_order,
    }));

  return {
    products: allProducts.filter((p) => p.active && p.show_on_website),
    categories: allCategories.filter((c) => c.active),
    variants,
    colorImages: allColorImages.filter((image)=>visible.has(image.product_id)),
    mode: "demo",
  };
}
