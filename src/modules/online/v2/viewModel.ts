/** Presentation-only price and image selectors. The original pricing helpers
 * are used without modifying placement/payment logic. Checkout and the SQL
 * place_online_order RPC remain authoritative over all discounts and holds.
 */
import type { Product } from "@/modules/products/types";
import type { Campaign, ProductContent, Promotion, PromotionTarget } from "../types";
import type { StoreVariant } from "../services/pricing";
import { campaignFor, promotionUnitPrice, variantUnitPriceOf, unitPriceOf } from "../services/pricing";
import { variantAvailableToPromise } from "../services/availability";
import { searchCatalog, variantMatchesCatalogFilters, type CatalogContext, type CatalogFilters, type CatalogProduct } from "../services/catalogQuery";

export function v2Price(
  product: Product,
  variants: readonly StoreVariant[],
  campaigns: readonly Campaign[],
  promotions: readonly Promotion[],
  targets: readonly PromotionTarget[],
  selected: StoreVariant | null = null,
  holds: ReadonlyMap<string, number> = new Map(),
) {
  const matching = product.variants_enabled ? variants.filter((variant) => variant.active &&
    variantAvailableToPromise(variant, holds.get(variant.id) ?? 0) > 0) : [];
  // Only a selected exact shelf or a published combination supplies its price;
  // never present a parent-level price as a substitute for a sold-out variant.
  const list = product.variants_enabled ? (selected ? [selected]
    : matching.length ? matching : variants.filter((v) => v.active)) : [null];
  const targetMap = new Map<string, Set<string>>();
  for (const target of targets) {
    const set = targetMap.get(target.promotion_id) ?? new Set<string>();
    set.add(`${target.target_kind}:${target.target_id}`);
    targetMap.set(target.promotion_id, set);
  }
  const prices = list.map((variant) => {
    const base = variant?.price_override ?? product.selling_price;
    const campaign = campaignFor(product.id, campaigns);
    const campaignPrice = variant
      ? variantUnitPriceOf(variant, product.selling_price, campaign)
      : unitPriceOf(product.selling_price, campaign);
    const offer = promotionUnitPrice(
      product.id, variant?.id ?? null, product.category_id, campaignPrice, promotions, targetMap,
    );
    return { id: variant?.id ?? null, price: Math.min(offer.unit, campaignPrice), list: base };
  });
  const lowest = prices.sort((a, b) => a.price - b.price)[0] ?? {
    id: null, price: product.selling_price, list: product.selling_price,
  };
  return { ...lowest, from: product.variants_enabled && list.length > 1 };
}

/** The V2 tile price is the V2 price/filter/sort authority in the browser.
 * Search, category, stock and brand still come from the shared catalogue query.
 * All of this is advisory; order placement recomputes on the server.
 */
export function v2CatalogResults(
  products: readonly Product[],
  filters: CatalogFilters,
  context: CatalogContext,
  campaigns: readonly Campaign[],
  promotions: readonly Promotion[],
  targets: readonly PromotionTarget[],
  offerOnly = false,
): CatalogProduct[] {
  const base = searchCatalog(products, { ...filters, minPrice: null, maxPrice: null, limit: null }, context);
  const narrowed = Boolean(filters.color || filters.size !== null || filters.sizeLabel);
  const priced = base.map((entry) => {
    const variants = context.variants?.get(entry.product.id) ?? [];
    const shown = narrowed ? variants.filter((variant) => variantMatchesCatalogFilters(variant, filters)) : variants;
    const view = v2Price(entry.product, shown, campaigns, promotions, targets, null, context.reservedVariant);
    const available = narrowed && entry.product.stock_tracking_enabled
      ? shown.reduce((count, variant) => count + variantAvailableToPromise(variant,
        context.reservedVariant?.get(variant.id) ?? 0), 0) : entry.available;
    return { entry: narrowed ? { ...entry, available, inStock: available !== null && available > 0 } : entry, view };
  });
  const filtered = priced.filter(({ view }) =>
    (filters.minPrice === null || view.price >= filters.minPrice) &&
    (filters.maxPrice === null || view.price <= filters.maxPrice) &&
    (!offerOnly || view.price < view.list),
  );
  if (filters.sort === "price_asc" || filters.sort === "price_desc") {
    const direction = filters.sort === "price_asc" ? 1 : -1;
    filtered.sort((a, b) => direction * (a.view.price - b.view.price) ||
      (a.entry.product.name_en || a.entry.product.name_ar).localeCompare(
        b.entry.product.name_en || b.entry.product.name_ar, "en"));
  }
  const entries = filtered.map(({ entry }) => entry);
  return filters.limit !== null && filters.limit > 0 ? entries.slice(0, filters.limit) : entries;
}

export function v2Gallery(product: Pick<Product, "image_url" | "images">, content: ProductContent | null) {
  const all = [product.image_url, ...product.images, ...(content?.media ?? [])
    .slice().sort((a, b) => a.sort_order - b.sort_order).map((media) => media.url)];
  return [...new Set(all.filter((url): url is string => Boolean(url?.trim())))];
}
