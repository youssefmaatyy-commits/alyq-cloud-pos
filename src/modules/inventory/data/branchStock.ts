import type { SupabaseClient } from "@supabase/supabase-js";
import type { Product } from "@/modules/products/types";
import type { ProductVariant } from "@/modules/products/variants";

export interface BranchStockRow {
  branch_id: string;
  branch_code: string;
  branch_name_en: string;
  branch_name_ar: string;
  product_id: string;
  variant_id: string | null;
  quantity: number | string | null;
  reorder_level: number | string | null;
}

export interface BranchStockIndex {
  branchId: string | null;
  productShelves: ReadonlyMap<string, { quantity: number; reorderLevel: number }>;
  variantShelves: ReadonlyMap<string, { quantity: number; reorderLevel: number }>;
  variantTotals: ReadonlyMap<string, number>;
}

function number(value: number | string | null | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Reads the server-resolved active branch; callers never supply a branch id. */
export async function readActiveBranchStock(client: SupabaseClient): Promise<BranchStockIndex> {
  const { data, error } = await client.rpc("inventory_branch_stock", { p_branch_id: null });
  if (error) throw error;

  const productShelves = new Map<string, { quantity: number; reorderLevel: number }>();
  const variantShelves = new Map<string, { quantity: number; reorderLevel: number }>();
  const variantTotals = new Map<string, number>();
  let branchId: string | null = null;

  for (const row of (data ?? []) as BranchStockRow[]) {
    branchId ??= row.branch_id;
    const shelf = { quantity: number(row.quantity), reorderLevel: number(row.reorder_level) };
    if (row.variant_id) {
      variantShelves.set(row.variant_id, shelf);
      variantTotals.set(row.product_id, (variantTotals.get(row.product_id) ?? 0) + shelf.quantity);
    } else {
      productShelves.set(row.product_id, shelf);
    }
  }

  return { branchId, productShelves, variantShelves, variantTotals };
}

/** Replaces global compatibility rollups with quantities from the active branch. */
export function withActiveBranchProductStock(product: Product, stock: BranchStockIndex): Product {
  if (!product.stock_tracking_enabled) return product;
  if (product.variants_enabled) {
    return {
      ...product,
      stock_quantity: stock.variantTotals.get(product.id) ?? 0,
      // Variant products reorder by exact shelf; the parent has no branch shelf.
      low_stock_level: 0,
    };
  }
  const shelf = stock.productShelves.get(product.id);
  return {
    ...product,
    stock_quantity: shelf?.quantity ?? 0,
    low_stock_level: shelf?.reorderLevel ?? 0,
  };
}

export function withActiveBranchVariantStock(
  variant: ProductVariant,
  stock: BranchStockIndex,
): ProductVariant {
  const shelf = stock.variantShelves.get(variant.id);
  return {
    ...variant,
    stock_quantity: shelf?.quantity ?? 0,
    low_stock_level: shelf?.reorderLevel ?? 0,
  };
}
