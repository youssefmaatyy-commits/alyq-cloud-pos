import type { Product } from "../types";
import { stockStatus, UNCATEGORIZED_ID } from "../types";
import type { ProductFiltersValue } from "../components/ProductFilters";

/**
 * Search / filter / sort engine for the products list.
 * Pure functions so the behaviour is identical in demo and Supabase mode,
 * and testable without React.
 */

/** Normalise Arabic + Latin text for forgiving search. */
export function normalizeText(input: string): string {
  return input
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u064B-\u065F\u0670\u0640]/g, "") // harakat, hamza marks, tatweel
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ؤ/g, "و")
    .replace(/ئ/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/\s+/g, " ")
    .trim();
}

export function buildSearchIndex(product: Product): string {
  return normalizeText(
    [
      product.sku,
      product.barcode ?? "",
      product.name_ar,
      product.name_en,
      product.description_ar ?? "",
      product.description_en ?? "",
    ].join(" \u0001 "),
  );
}

export interface CategoryNameResolver {
  (categoryId: string | null): string;
}

export function queryProducts(
  products: Product[],
  filters: ProductFiltersValue,
  categoryName: CategoryNameResolver,
): Product[] {
  const needle = normalizeText(filters.search);
  const terms = needle ? needle.split(" ") : [];

  const filtered = products.filter((product) => {
    if (filters.status === "active" && !product.active) return false;
    if (filters.status === "inactive" && product.active) return false;

    if (filters.type !== "all" && product.product_type !== filters.type) return false;

    if (filters.featured && !product.is_featured) return false;

    if (filters.stock !== "all" && stockStatus(product) !== filters.stock) return false;

    if (filters.visibility === "visible" && !product.show_on_website) return false;
    if (filters.visibility === "hidden" && product.show_on_website) return false;

    if (filters.categoryId === UNCATEGORIZED_ID) {
      if (product.category_id) return false;
    } else if (filters.categoryId !== "all" && product.category_id !== filters.categoryId) {
      return false;
    }

    if (terms.length > 0) {
      const haystack = buildSearchIndex(product);
      const categoryHaystack = normalizeText(categoryName(product.category_id));
      for (const term of terms) {
        if (!haystack.includes(term) && !categoryHaystack.includes(term)) return false;
      }
    }

    return true;
  });

  return sortProducts(filtered, filters.sort);
}

export function sortProducts(products: Product[], sort: ProductFiltersValue["sort"]): Product[] {
  const list = [...products];
  switch (sort) {
    case "sku":
      list.sort((a, b) => a.sku.localeCompare(b.sku, "en"));
      break;
    case "price_asc":
      list.sort((a, b) => a.selling_price - b.selling_price);
      break;
    case "price_desc":
      list.sort((a, b) => b.selling_price - a.selling_price);
      break;
    case "updated":
      list.sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at));
      break;
    case "name":
    default:
      list.sort((a, b) => a.name_en.localeCompare(b.name_en, "en"));
      break;
  }
  return list;
}

export function paginate<T>(items: T[], page: number, pageSize: number): T[] {
  const start = (page - 1) * pageSize;
  return items.slice(start, start + pageSize);
}

export function totalPagesFor(total: number, pageSize: number): number {
  return Math.max(1, Math.ceil(total / pageSize));
}

/** Summary tiles above the list. */
export function summarize(products: Product[], categories: { id: string; active: boolean }[]) {
  const active = products.filter((p) => p.active).length;
  const inactive = products.length - active;
  const withBarcode = products.filter((p) => p.barcode).length;
  const services = products.filter((p) => p.product_type === "service").length;
  const activeCategories = categories.filter((c) => c.active).length;
  const lowStock = products.filter((p) => stockStatus(p) === "low").length;
  const outOfStock = products.filter((p) => stockStatus(p) === "out").length;
  const featured = products.filter((p) => p.is_featured).length;
  const hiddenOnWebsite = products.filter((p) => !p.show_on_website).length;
  return {
    total: products.length,
    active,
    inactive,
    withBarcode,
    services,
    activeCategories,
    lowStock,
    outOfStock,
    featured,
    hiddenOnWebsite,
  };
}
