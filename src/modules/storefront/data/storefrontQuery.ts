/**
 * Storefront search and filtering — pure functions.
 * Reuses the Arabic-aware normalizer from the products module.
 */

import type { Product, Category } from "@/modules/products/types";
import { stockStatus } from "@/modules/products/types";
import { normalizeText } from "@/modules/products/services/productQuery";

export interface StorefrontFilters {
  search: string;
  categoryId: string; // "all" | category id
  inStockOnly: boolean;
  sort: "featured" | "price_asc" | "price_desc" | "name";
}

export const EMPTY_STOREFRONT_FILTERS: StorefrontFilters = {
  search: "",
  categoryId: "all",
  inStockOnly: false,
  sort: "featured",
};

/** Filter + sort storefront-visible products. */
export function queryStorefront(
  products: Product[],
  filters: StorefrontFilters,
): Product[] {
  const needle = normalizeText(filters.search);
  const terms = needle ? needle.split(" ") : [];

  let result = products.filter((p) => {
    // Category filter
    if (filters.categoryId !== "all" && p.category_id !== filters.categoryId) return false;

    // Stock filter
    if (filters.inStockOnly) {
      const status = stockStatus(p);
      if (status === "out") return false;
    }

    // Search
    if (terms.length > 0) {
      const haystack = normalizeText(
        [p.sku, p.barcode ?? "", p.name_ar, p.name_en, p.description_en ?? "", p.description_ar ?? ""].join(" "),
      );
      for (const term of terms) {
        if (!haystack.includes(term)) return false;
      }
    }

    return true;
  });

  // Sort
  switch (filters.sort) {
    case "price_asc":
      result = [...result].sort((a, b) => a.selling_price - b.selling_price);
      break;
    case "price_desc":
      result = [...result].sort((a, b) => b.selling_price - a.selling_price);
      break;
    case "name":
      result = [...result].sort((a, b) => a.name_en.localeCompare(b.name_en, "en"));
      break;
    case "featured":
    default:
      result = [...result].sort((a, b) => {
        if (a.is_featured !== b.is_featured) return a.is_featured ? -1 : 1;
        return a.name_en.localeCompare(b.name_en, "en");
      });
      break;
  }

  return result;
}

/** Count products per category (for the category sidebar). */
export function countByCategory(products: Product[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const p of products) {
    const id = p.category_id ?? "__uncategorized__";
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
}

/** Resolve a category name from its ID. */
export function categoryName(
  category: Category | undefined,
  lang: "en" | "ar",
): string {
  if (!category) return lang === "ar" ? "بدون تصنيف" : "Uncategorized";
  return lang === "ar" ? category.name_ar : category.name_en;
}

/** Resolve a product name for the current language. */
export function productName(product: Product, lang: "en" | "ar"): string {
  return lang === "ar" ? product.name_ar || product.name_en : product.name_en || product.name_ar;
}

/** Resolve a product description for the current language. */
export function productDescription(product: Product, lang: "en" | "ar"): string | null {
  return lang === "ar"
    ? product.description_ar ?? product.description_en
    : product.description_en ?? product.description_ar;
}
