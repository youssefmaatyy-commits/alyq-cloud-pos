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
import { getOfflineDb } from "./db";
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
