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
  mode: "supabase" | "demo";
}> {
  if (isSupabaseConfigured) {
    const client = getSupabaseClient();
    if (!client) throw new Error("Supabase client unavailable");

    // Both functions filter and order for the shop window: featured first, then
    // by name; categories by their sort order. The two calls are independent,
    // so they travel together.
    const [productResult, categoryResult] = await Promise.all([
      client.rpc("storefront_catalogue"),
      client.rpc("storefront_categories"),
    ]);

    if (productResult.error) throw productResult.error;
    if (categoryResult.error) throw categoryResult.error;

    return {
      products: ((productResult.data ?? []) as StorefrontProductRow[]).map(toProduct),
      categories: (categoryResult.data ?? []) as StorefrontCategoryRow[],
      mode: "supabase",
    };
  }

  // Demo mode — filter the demo seed for website-visible products.
  const repo = getDemoRepository();
  const [allProducts, allCategories] = await Promise.all([
    repo.listProducts(),
    repo.listCategories(),
  ]);

  return {
    products: allProducts.filter((p) => p.active && p.show_on_website),
    categories: allCategories.filter((c) => c.active),
    mode: "demo",
  };
}
