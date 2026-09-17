/**
 * Storefront data layer — public-facing product catalog.
 *
 * Only returns products where `active = true` AND `show_on_website = true`.
 * Works in both Supabase mode (live) and demo mode (localStorage seed).
 * No authentication required — this is the public storefront.
 *
 * In live mode the two reads go through `storefront_catalogue()` and
 * `storefront_categories()` instead of through the tables, and that is not a
 * stylistic choice: every policy on `products` and `categories` is
 * `to authenticated`, so a visitor's select on the table returns zero rows and
 * the shop window is empty. The functions are `security definer` with a fixed
 * column list (migration 0030), so an anonymous caller gets exactly the public
 * fields — never `cost_price`, never `low_stock_level`, never who created the
 * row — and cannot widen the query, add a filter or reach a hidden product,
 * because the shape of the answer is decided in the database rather than here.
 */

import { getSupabaseClient, isSupabaseConfigured } from "@/lib/supabase/client";
import type { Product, Category } from "@/modules/products/types";
import type { StoreVariant } from "@/modules/online/services/pricing";
import { getDemoRepository } from "@/modules/products/data/demoRepository";

/**
 * What `storefront_catalogue()` returns: every `Product` column except the two
 * that are internal to the business. Both are filled in by {@link toProduct}
 * with values that cannot change what the storefront renders — no storefront
 * code path reads a margin, and `stockStatus()` (the only consumer of
 * `low_stock_level`) is never called from the public side.
 */
type StorefrontProductRow = Omit<Product, "cost_price" | "low_stock_level">;

/** What `storefront_categories()` returns: the whole `Category` shape. */
type StorefrontCategoryRow = Category;

const toProduct = (row: StorefrontProductRow): Product => ({
  ...row,
  // Absent from the published read on purpose. 0 is inert here: `stockStatus()`
  // only treats a threshold as meaningful when it is greater than 0.
  cost_price: 0,
  low_stock_level: 0,
});

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
  mode: "supabase" | "demo";
}> {
  if (isSupabaseConfigured) {
    const client = getSupabaseClient();
    if (!client) throw new Error("Supabase client unavailable");

    // The three reads are independent, so they travel together. The variant one
    // goes through `storefront_product_variants()` (0043) for the same reason
    // the other two go through their functions: the shape of the answer is
    // decided in the database, and it is the public shape — colour, size,
    // swatch, price override, stock on hand — never cost, never a threshold,
    // never an unpublished product or an archived combination.
    const [productResult, categoryResult, variantResult] = await Promise.all([
      client.rpc("storefront_catalogue"),
      client.rpc("storefront_categories"),
      client.rpc("storefront_product_variants"),
    ]);

    if (productResult.error) throw productResult.error;
    if (categoryResult.error) throw categoryResult.error;
    // A shop upgraded before 0043 has no such function yet; an empty shelf of
    // combinations is the honest answer, not a broken storefront.
    if (variantResult.error) {
      console.warn("[storefront] variant list unavailable", variantResult.error.message);
    }

    return {
      products: ((productResult.data ?? []) as StorefrontProductRow[]).map(toProduct),
      categories: (categoryResult.data ?? []) as StorefrontCategoryRow[],
      variants: (variantResult.error ? [] : (variantResult.data ?? [])) as StoreVariant[],
      mode: "supabase",
    };
  }

  // Demo mode — filter the demo seed for website-visible products, and the
  // combinations down to those of the visible variant products, shaped as the
  // live RPC shapes them: no cost, no threshold. The storefront has no use for
  // either, and demo should not render one either.
  const repo = getDemoRepository();
  const [allProducts, allCategories, allVariants] = await Promise.all([
    repo.listProducts(),
    repo.listCategories(),
    repo.listVariants(),
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
    mode: "demo",
  };
}
