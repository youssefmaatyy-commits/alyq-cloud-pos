/**
 * Catalog cache — the till's "last known" copy of products and variants.
 *
 * Written every time a LIVE catalog load succeeds; read only as a fallback
 * when a live load fails with a network error. The cached rows are the exact
 * `Product`/`ProductVariant` objects the server returned — nothing is
 * invented, no variant is fabricated, and every field Phase 3 of the offline
 * brief asks for (name EN/AR, SKU, barcode, exact variant UUID, colour,
 * size, last known stock, price, price override, active status) is simply
 * whatever the live objects already carry.
 *
 * Offline stock is explicitly LAST-KNOWN, not live: `cachedAt` is surfaced so
 * the UI can say so, and the server re-validates every line's real stock at
 * sync time regardless of what the till believed while offline (see
 * `outbox.ts` and `pos_complete_sale`, migration 0055 §2).
 */
import type { Product } from "@/modules/products/types";
import type { ProductVariant } from "@/modules/products/variants";
import { AppError } from "@/modules/products/data/repository";
import type { CompleteSaleInput } from "../types";
import { getOfflineDb, type OfflineWrite } from "./db";
import type { CachedCatalogSnapshot, CachedProduct, CachedVariant } from "./types";

const CATALOG_CACHED_AT_KEY = "catalog_cached_at";

export async function cacheCatalogSnapshot(products: Product[], variants: ProductVariant[]): Promise<void> {
  const db = getOfflineDb();
  const cachedAt = new Date().toISOString();
  const cachedProducts: CachedProduct[] = products.map((product) => ({ ...product, cached_at: cachedAt }));
  const cachedVariants: CachedVariant[] = variants.map((variant) => ({ ...variant, cached_at: cachedAt }));
  await db.clear("cached_products");
  await db.clear("cached_variants");
  await db.putMany("cached_products", cachedProducts);
  await db.putMany("cached_variants", cachedVariants);
  await db.put("sync_metadata", { key: CATALOG_CACHED_AT_KEY, value: cachedAt });
}

export async function readCachedCatalog(): Promise<CachedCatalogSnapshot> {
  const db = getOfflineDb();
  const [products, variants, meta] = await Promise.all([
    db.getAll<CachedProduct>("cached_products"),
    db.getAll<CachedVariant>("cached_variants"),
    db.get<{ key: string; value: string }>("sync_metadata", CATALOG_CACHED_AT_KEY),
  ]);
  return { products, variants, cachedAt: meta?.value ?? null };
}

export interface OfflineInventoryPlan {
  products: Product[];
  variants: ProductVariant[];
  /** Rows committed in the SAME transaction as the sale and outbox entry. */
  writes: OfflineWrite[];
}

/**
 * Optimistically deduct one offline sale from the last verified catalogue.
 *
 * This is deliberately pure: callers calculate the next UI state first, then
 * hand `writes` to `enqueueOfflineSale`, which commits stock + receipt + lines +
 * outbox atomically. Re-running sync never calls this function, so reconnect
 * cannot decrement local stock a second time. The server remains authoritative
 * and re-checks the exact variant when the queued payload reaches the RPC.
 */
export function planOfflineInventory(
  products: readonly Product[],
  variants: readonly ProductVariant[],
  lines: readonly CompleteSaleInput["lines"][number][],
  cachedAt: string | null,
): OfflineInventoryPlan {
  const productMap = new Map(products.map((product) => [product.id, { ...product }]));
  const variantMap = new Map(variants.map((variant) => [variant.id, { ...variant }]));
  const changedProducts = new Set<string>();
  const changedVariants = new Set<string>();

  for (const line of lines) {
    const qty = Number(line.qty);
    const product = productMap.get(line.product_id);
    if (!product?.active || !product.stock_tracking_enabled || !Number.isInteger(qty) || qty <= 0) {
      throw new AppError("VALIDATION", "Cached product is not available for this offline sale", "cart");
    }

    if (line.variant_id) {
      const variant = variantMap.get(line.variant_id);
      if (!product.variants_enabled || !variant?.active || variant.product_id !== product.id) {
        throw new AppError("VARIANT_UNAVAILABLE", "Cached product variant is not available", "cart");
      }
      if (variant.stock_quantity < qty) {
        throw new AppError("VARIANT_STOCK_INSUFFICIENT", `Only ${variant.stock_quantity} of ${qty} in cached stock`, "cart");
      }
      variant.stock_quantity -= qty;
      variantMap.set(variant.id, variant);
      changedVariants.add(variant.id);
    } else {
      if (product.variants_enabled) {
        throw new AppError("VARIANT_REQUIRED", "An exact product variant is required", "cart");
      }
      if (product.stock_quantity < qty) {
        throw new AppError("VALIDATION", `Only ${product.stock_quantity} of ${qty} in cached stock`, "cart");
      }
    }

    // For variant products this is the server-maintained rollup. Keeping it in
    // step locally makes every pre-variant stock badge agree with the exact shelf.
    if (product.stock_quantity < qty) {
      throw new AppError("VARIANT_STOCK_INSUFFICIENT", "Cached product stock is insufficient", "cart");
    }
    product.stock_quantity -= qty;
    productMap.set(product.id, product);
    changedProducts.add(product.id);
  }

  const stamp = cachedAt ?? new Date().toISOString();
  const nextProducts = products.map((product) => productMap.get(product.id) ?? product);
  const nextVariants = variants.map((variant) => variantMap.get(variant.id) ?? variant);
  const writes: OfflineWrite[] = [
    ...[...changedProducts].map((id) => ({
      store: "cached_products" as const,
      value: { ...productMap.get(id)!, cached_at: stamp } satisfies CachedProduct,
    })),
    ...[...changedVariants].map((id) => ({
      store: "cached_variants" as const,
      value: { ...variantMap.get(id)!, cached_at: stamp } satisfies CachedVariant,
    })),
  ];
  return { products: nextProducts, variants: nextVariants, writes };
}
