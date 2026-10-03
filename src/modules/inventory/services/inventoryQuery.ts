import { stockStatus, type Product, type StockStatus, UNCATEGORIZED_ID } from "@/modules/products/types";
import { normalizeText } from "@/modules/products/services/productQuery";
import type { ProductVariant } from "@/modules/products/variants";
import type { StockMovement } from "../types";

/**
 * Query / aggregation helpers for the inventory module — pure, testable.

 */
export interface InventoryFiltersValue {
  search: string;
  categoryId: string;
  status: StockStatus | "all";
}

export const EMPTY_INVENTORY_FILTERS: InventoryFiltersValue = {
  search: "",
  categoryId: "all",
  status: "all",
};

export function buildProductSearchIndex(product: Product): string {
  return normalizeText(
    [product.sku, product.barcode ?? "", product.name_ar, product.name_en].join(" \u0001 "),
  );
}

export interface CategoryNameResolver {
  (categoryId: string | null): string;
}

export function queryInventory(
  products: Product[],
  filters: InventoryFiltersValue,
  categoryName: CategoryNameResolver,
  variants: readonly ProductVariant[] = [],
): Product[] {
  const variantsByProduct = new Map<string, ProductVariant[]>();
  for (const variant of variants) {
    const list = variantsByProduct.get(variant.product_id) ?? [];
    list.push(variant);
    variantsByProduct.set(variant.product_id, list);
  }
  const needle = normalizeText(filters.search);
  const terms = needle ? needle.split(" ") : [];

  return products.filter((product) => {
    if (!product.stock_tracking_enabled) return false;

    if (filters.categoryId === UNCATEGORIZED_ID) {
      if (product.category_id) return false;
    } else if (filters.categoryId !== "all" && product.category_id !== filters.categoryId) {
      return false;
    }

    const ownVariants = (variantsByProduct.get(product.id) ?? []).filter((variant) => variant.active);
    if (filters.status !== "all") {
      if (product.variants_enabled && ownVariants.length > 0) {
        const statuses = ownVariants.map((variant) =>
          variant.stock_quantity <= 0
            ? "out"
            : variant.low_stock_level > 0 && variant.stock_quantity <= variant.low_stock_level
              ? "low"
              : "in",
        );
        if (filters.status === "none") return false;
        if (filters.status === "in" ? statuses.some((status) => status !== "in") : !statuses.includes(filters.status)) return false;
      } else if (stockStatus(product) !== filters.status) return false;
    }

    if (terms.length > 0) {
      const variantHaystack = normalizeText(ownVariants.map((variant) => [
        variant.sku,
        variant.barcode ?? "",
        variant.color_ar ?? "",
        variant.color_en ?? "",
        variant.size_label ?? variant.size ?? "",
      ].join(" ")).join(" "));
      const haystack = buildProductSearchIndex(product);
      const categoryHaystack = normalizeText(categoryName(product.category_id));
      for (const term of terms) {
        if (!haystack.includes(term) && !variantHaystack.includes(term) && !categoryHaystack.includes(term)) return false;
      }
    }
    return true;
  });
}

export function paginate<T>(items: T[], page: number, pageSize: number): T[] {
  const start = (page - 1) * pageSize;
  return items.slice(start, start + pageSize);
}

export function totalPagesFor(total: number, pageSize: number): number {
  return Math.max(1, Math.ceil(total / pageSize));
}

/** Aggregates used by the dashboard tiles + KPI strip. */
export interface InventoryStats {
  totalProducts: number;
  trackedProducts: number;
  totalStock: number;
  lowStock: number;
  outOfStock: number;
  inStock: number;
  movementsLast7d: number;
}

export function summarizeInventory(
  products: Product[],
  movements: StockMovement[],
  now: Date = new Date(),
): InventoryStats {
  const tracked = products.filter((p) => p.stock_tracking_enabled);
  let inStock = 0;
  let lowStock = 0;
  let outOfStock = 0;
  let totalStock = 0;
  for (const product of tracked) {
    const status = stockStatus(product);
    if (status === "in") inStock += 1;
    if (status === "low") lowStock += 1;
    if (status === "out") outOfStock += 1;
    totalStock += product.stock_quantity;
  }
  const horizon = now.getTime() - 7 * 24 * 60 * 60 * 1000;
  const movementsLast7d = movements.filter((m) => Date.parse(m.created_at) >= horizon).length;
  return {
    totalProducts: products.length,
    trackedProducts: tracked.length,
    totalStock,
    lowStock,
    outOfStock,
    inStock,
    movementsLast7d,
  };
}
