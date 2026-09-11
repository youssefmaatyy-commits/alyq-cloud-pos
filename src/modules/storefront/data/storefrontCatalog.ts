/**
 * Storefront data layer — public-facing product catalog.
 *
 * Only returns products where `active = true` AND `show_on_website = true`.
 * Works in both Supabase mode (live) and demo mode (localStorage seed).
 * No authentication required — this is the public storefront.
 */

import { getSupabaseClient, isSupabaseConfigured } from "@/lib/supabase/client";
import type { Product, Category } from "@/modules/products/types";
import { getDemoRepository } from "@/modules/products/data/demoRepository";

/** Fetch only website-visible, active products + active categories. */
export async function fetchStorefrontCatalog(): Promise<{
  products: Product[];
  categories: Category[];
  mode: "supabase" | "demo";
}> {
  if (isSupabaseConfigured) {
    const client = getSupabaseClient();
    if (!client) throw new Error("Supabase client unavailable");

    const [productResult, categoryResult] = await Promise.all([
      client
        .from("products")
        .select("*")
        .eq("active", true)
        .eq("show_on_website", true)
        .order("is_featured", { ascending: false })
        .order("name_en", { ascending: true }),
      client
        .from("categories")
        .select("*")
        .eq("active", true)
        .order("sort_order", { ascending: true })
        .order("name_en", { ascending: true }),
    ]);

    if (productResult.error) throw productResult.error;
    if (categoryResult.error) throw categoryResult.error;

    return {
      products: (productResult.data ?? []) as unknown as Product[],
      categories: (categoryResult.data ?? []) as unknown as Category[],
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
