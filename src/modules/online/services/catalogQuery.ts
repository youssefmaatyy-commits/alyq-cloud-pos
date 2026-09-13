/**
 * Storefront catalogue query — search, filters, sorting, related products.
 *
 * This is the customer-facing counterpart to the POS product search, and it
 * differs in the ways that matter to a shopper rather than to a cashier:
 *
 *   - a *price* filter and sort must use the price the customer will actually
 *     pay, so campaign pricing is applied before sorting. Sorting by list price
 *     while the tile shows a sale price puts the cheapest item in the middle.
 *   - *availability* is available-to-promise, not stock on hand: a pending
 *     website order is holding units, and showing them as buyable would create
 *     the exact oversell the reservation exists to prevent.
 *   - *best selling* is derived from real demand (POS sales plus website orders)
 *     rather than a flag somebody set once.
 *   - a search matches barcode and SKU exactly, because a customer who types a
 *     barcode wants that one product, not a fuzzy list.
 *
 * The existing `storefrontQuery.ts` is left alone: the current storefront pages
 * still use it, and this module supersedes it as those pages are rebuilt.
 */
import type { Category, Product } from "@/modules/products/types";
import { normalizeText } from "@/modules/products/services/productQuery";
import type { Campaign, ProductContent } from "../types";
import { availableToPromise, reservedOf } from "./availability";
import { campaignFor, unitPriceOf } from "./pricing";
import { isNewArrival, productBadges, type ProductBadge } from "./badges";

export const STOREFRONT_SORTS = [
  "featured",
  "newest",
  "price_asc",
  "price_desc",
  "best_selling",
  "name",
] as const;
export type StorefrontSort = (typeof STOREFRONT_SORTS)[number];

export const AVAILABILITY_FILTERS = ["any", "in_stock", "out_of_stock"] as const;
export type AvailabilityFilter = (typeof AVAILABILITY_FILTERS)[number];

export interface CatalogFilters {
  /** Free text: name, description, brand, SKU or barcode. */
  search: string;
  /** `"all"` or a category id. */
  categoryId: string;
  /** Normalized brand name, or `null` for every brand. */
  brand: string | null;
  /** Inclusive price bounds on the effective price; `null` = unbounded. */
  minPrice: number | null;
  maxPrice: number | null;
  availability: AvailabilityFilter;
  sort: StorefrontSort;
  /** Restrict to these products (a campaign, a best-seller list, a wishlist). */
  productIds: readonly string[] | null;
  /** Cap the result count, for homepage sections. `null` = no cap. */
  limit: number | null;
}

export const EMPTY_CATALOG_FILTERS: CatalogFilters = {
  search: "",
  categoryId: "all",
  brand: null,
  minPrice: null,
  maxPrice: null,
  availability: "any",
  sort: "featured",
  productIds: null,
  limit: null,
};

/** Everything the query needs beyond the products themselves. */
export interface CatalogContext {
  campaigns: readonly Campaign[];
  /** Product id → units sold, from `unitsSold()`. */
  units: ReadonlyMap<string, number>;
  /** Product id → storefront content (brand, slug, SEO). */
  contents: ReadonlyMap<string, ProductContent>;
  /** Product id → units held by pending orders. */
  reserved: ReadonlyMap<string, number>;
  now?: Date;
  newArrivalDays?: number;
}

export const EMPTY_CATALOG_CONTEXT: CatalogContext = {
  campaigns: [],
  units: new Map(),
  contents: new Map(),
  reserved: new Map(),
};

/** A product with everything the storefront renders about it, resolved once. */
export interface CatalogProduct {
  product: Product;
  content: ProductContent | null;
  /** What the customer pays per unit, campaigns included. */
  price: number;
  /** The catalogue price, for the strikethrough. Equal to `price` when not on sale. */
  listPrice: number;
  onSale: boolean;
  /** Percent off, rounded down — "Save 20%" reads better than "19.6%". */
  discountPercent: number;
  badges: ProductBadge[];
  brand: string;
  /** Units that may still be promised; `null` when stock is not tracked. */
  available: number | null;
  inStock: boolean;
  isNew: boolean;
  unitsSold: number;
}

/** The brand a product is sold under, normalized for grouping. */
export function brandKey(content: ProductContent | null): string {
  const value = (content?.brand_en || content?.brand_ar || "").trim();
  return value ? normalizeText(value) : "";
}

function toCatalogProduct(product: Product, context: CatalogContext): CatalogProduct {
  const content = context.contents.get(product.id) ?? null;
  const now = context.now ?? new Date();
  const campaign = campaignFor(product.id, context.campaigns, now);
  const price = unitPriceOf(product.selling_price, campaign);
  const listPrice = Math.max(product.selling_price, 0);
  const available = availableToPromise(product, reservedOf(context.reserved, product.id));
  const unitsSold = context.units.get(product.id) ?? 0;

  return {
    product,
    content,
    price,
    listPrice,
    onSale: price < listPrice - 0.001,
    discountPercent:
      price < listPrice && listPrice > 0 ? Math.floor(((listPrice - price) / listPrice) * 100) : 0,
    badges: productBadges({
      product,
      campaigns: context.campaigns,
      bestSellerIds: bestSellerIdsFrom(context),
      now,
      newArrivalDays: context.newArrivalDays,
    }),
    brand: brandKey(content),
    available,
    inStock: available === null || available > 0,
    isNew: isNewArrival(product.created_at, now, context.newArrivalDays),
    unitsSold,
  };
}

// Recomputing the best-seller list per product would be quadratic; callers pass
// it in through the context memo, and this is the cache for that.
const bestSellerCache = new WeakMap<CatalogContext, string[]>();

function bestSellerIdsFrom(context: CatalogContext): string[] {
  const cached = bestSellerCache.get(context);
  if (cached) return cached;
  const computed = [...context.units.entries()]
    .filter(([, quantity]) => quantity > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 8)
    .map(([productId]) => productId);
  bestSellerCache.set(context, computed);
  return computed;
}

/** Only what a shopper may see: active, flagged for the website. */
export function storefrontProducts(products: readonly Product[]): Product[] {
  return products.filter((product) => product.active && product.show_on_website);
}

/** Exact-identifier match: barcode or SKU typed in full or as a prefix. */
function matchesIdentifier(product: Product, needle: string): boolean {
  if (needle.length < 3) return false;
  const barcode = (product.barcode ?? "").trim().toLowerCase();
  const sku = product.sku.trim().toLowerCase();
  return (
    (barcode.length > 0 && (barcode === needle || barcode.startsWith(needle))) ||
    (sku.length > 0 && (sku === needle || sku.startsWith(needle)))
  );
}

/**
 * Search, filter and sort the catalogue.
 *
 * Every filter is applied to the resolved `CatalogProduct`, which is why price
 * bounds and availability behave the way a customer expects: they test the price
 * on the tile and the stock the customer can actually be promised.
 */
export function searchCatalog(
  products: readonly Product[],
  filters: CatalogFilters,
  context: CatalogContext = EMPTY_CATALOG_CONTEXT,
): CatalogProduct[] {
  const needle = normalizeText(filters.search);
  const terms = needle ? needle.split(" ").filter(Boolean) : [];
  const identifier = filters.search.trim().toLowerCase();
  const wantedIds = filters.productIds ? new Set(filters.productIds) : null;
  const brandNeedle = filters.brand ? normalizeText(filters.brand) : null;
  const min = filters.minPrice !== null && Number.isFinite(filters.minPrice) ? filters.minPrice : null;
  const max = filters.maxPrice !== null && Number.isFinite(filters.maxPrice) ? filters.maxPrice : null;

  const resolved: CatalogProduct[] = [];
  for (const product of storefrontProducts(products)) {
    if (wantedIds && !wantedIds.has(product.id)) continue;
    if (filters.categoryId !== "all" && product.category_id !== filters.categoryId) continue;

    const entry = toCatalogProduct(product, context);

    if (brandNeedle && entry.brand !== brandNeedle) continue;
    if (min !== null && entry.price < min) continue;
    if (max !== null && entry.price > max) continue;

    if (filters.availability === "in_stock" && !entry.inStock) continue;
    if (filters.availability === "out_of_stock" && entry.inStock) continue;

    if (terms.length > 0) {
      // An exact barcode or SKU beats a text match: the customer knows what they
      // want, so put it first rather than making them read a list.
      if (!matchesIdentifier(product, identifier)) {
        const haystack = normalizeText(
          [
            product.sku,
            product.barcode ?? "",
            product.name_ar,
            product.name_en,
            product.description_en ?? "",
            product.description_ar ?? "",
            entry.content?.brand_en ?? "",
            entry.content?.brand_ar ?? "",
          ].join(" "),
        );
        if (!terms.every((term) => haystack.includes(term))) continue;
      }
    }

    resolved.push(entry);
  }

  const byName = (a: CatalogProduct, b: CatalogProduct) =>
    (a.product.name_en || a.product.name_ar).localeCompare(b.product.name_en || b.product.name_ar, "en");

  resolved.sort((a, b) => {
    switch (filters.sort) {
      case "price_asc":
        return a.price - b.price || byName(a, b);
      case "price_desc":
        return b.price - a.price || byName(a, b);
      case "newest":
        return (
          Date.parse(b.product.created_at || "") - Date.parse(a.product.created_at || "") ||
          byName(a, b)
        );
      case "best_selling":
        return b.unitsSold - a.unitsSold || byName(a, b);
      case "name":
        return byName(a, b);
      case "featured":
      default: {
        // A barcode match is the strongest possible signal, then featured, then
        // best selling, then alphabetical so the list is stable between visits.
        const aExact = matchesIdentifier(a.product, identifier) ? 1 : 0;
        const bExact = matchesIdentifier(b.product, identifier) ? 1 : 0;
        if (aExact !== bExact) return bExact - aExact;
        if (a.product.is_featured !== b.product.is_featured) {
          return a.product.is_featured ? -1 : 1;
        }
        return b.unitsSold - a.unitsSold || byName(a, b);
      }
    }
  });

  if (filters.limit !== null && filters.limit > 0) return resolved.slice(0, filters.limit);
  return resolved;
}

/** Resolve one product for a product page, by slug or by id. */
export function findCatalogProduct(
  key: string,
  products: readonly Product[],
  contents: readonly ProductContent[],
): Product | null {
  const needle = decodeURIComponent(key || "").trim();
  if (!needle) return null;
  const byId = products.find((product) => product.id === needle);
  if (byId) return byId;
  const normalized = normalizeText(needle).replace(/\s+/g, "-").toLowerCase();
  const bySlug = contents.find(
    (content) => (content.slug ?? "").trim().toLowerCase() === normalized,
  );
  return bySlug ? products.find((product) => product.id === bySlug.product_id) ?? null : null;
}

/**
 * Products to show beside this one.
 *
 * Same category first, then same brand, then whatever is selling: a customer who
 * has looked at one ring should be shown other rings before other best
 * sellers, and never the product they are already looking at.
 */
export function relatedProducts(
  product: Product,
  products: readonly Product[],
  context: CatalogContext,
  limit = 4,
): CatalogProduct[] {
  const pool = searchCatalog(products, { ...EMPTY_CATALOG_FILTERS, sort: "best_selling" }, context);
  const sameCategory = pool.filter(
    (entry) =>
      entry.product.id !== product.id &&
      product.category_id !== null &&
      entry.product.category_id === product.category_id,
  );
  const brand = brandKey(context.contents.get(product.id) ?? null);
  const sameBrand = brand
    ? pool.filter((entry) => entry.product.id !== product.id && entry.brand === brand)
    : [];

  const picked: CatalogProduct[] = [];
  const seen = new Set<string>();
  for (const entry of [...sameCategory, ...sameBrand, ...pool]) {
    if (entry.product.id === product.id || seen.has(entry.product.id)) continue;
    seen.add(entry.product.id);
    picked.push(entry);
    if (picked.length >= limit) break;
  }
  return picked;
}

/** The lowest and highest effective price in the catalogue — the slider bounds. */
export function priceRangeOf(
  products: readonly Product[],
  context: CatalogContext = EMPTY_CATALOG_CONTEXT,
): { min: number; max: number } | null {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const product of storefrontProducts(products)) {
    const price = unitPriceOf(product.selling_price, campaignFor(product.id, context.campaigns));
    if (price < min) min = price;
    if (price > max) max = price;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
  return { min: Math.floor(min), max: Math.ceil(max) };
}

/** Brand facet with counts, strongest first — the filter list the sidebar shows. */
export function brandFacet(
  products: readonly Product[],
  contents: readonly ProductContent[],
): { key: string; label: string; count: number }[] {
  const contentByProduct = new Map(contents.map((content) => [content.product_id, content]));
  const totals = new Map<string, { label: string; count: number }>();
  for (const product of storefrontProducts(products)) {
    const content = contentByProduct.get(product.id) ?? null;
    const key = brandKey(content);
    if (!key) continue;
    const label = (content?.brand_en || content?.brand_ar || key).trim();
    const entry = totals.get(key);
    if (entry) entry.count += 1;
    else totals.set(key, { label, count: 1 });
  }
  return [...totals.entries()]
    .map(([key, value]) => ({ key, ...value }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, "en"));
}

/** Category facet with counts, in the catalogue's own order. */
export function categoryFacet(
  products: readonly Product[],
  categories: readonly Category[],
): { id: string; name_ar: string; name_en: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const product of storefrontProducts(products)) {
    if (product.category_id === null) continue;
    counts.set(product.category_id, (counts.get(product.category_id) ?? 0) + 1);
  }
  return categories
    .map((category) => ({
      id: category.id,
      name_ar: category.name_ar,
      name_en: category.name_en,
      count: counts.get(category.id) ?? 0,
    }))
    .filter((entry) => entry.count > 0);
}

/** Read the filters out of a URL's search params, tolerating junk. */
export function filtersFromSearchParams(params: URLSearchParams): CatalogFilters {
  const sort = params.get("sort") as StorefrontSort | null;
  const availability = params.get("availability") as AvailabilityFilter | null;
  const min = Number(params.get("min"));
  const max = Number(params.get("max"));
  return {
    search: params.get("q") ?? "",
    categoryId: params.get("category") ?? "all",
    brand: params.get("brand"),
    minPrice: params.get("min") !== null && Number.isFinite(min) ? min : null,
    maxPrice: params.get("max") !== null && Number.isFinite(max) ? max : null,
    availability: availability && AVAILABILITY_FILTERS.includes(availability) ? availability : "any",
    sort: sort && STOREFRONT_SORTS.includes(sort) ? sort : "featured",
    productIds: null,
    limit: null,
  };
}

/** Write the filters back into a URL's search params, dropping empty ones. */
export function filtersToSearchParams(filters: CatalogFilters): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.search.trim()) params.set("q", filters.search.trim());
  if (filters.categoryId !== "all") params.set("category", filters.categoryId);
  if (filters.brand) params.set("brand", filters.brand);
  if (filters.minPrice !== null) params.set("min", String(filters.minPrice));
  if (filters.maxPrice !== null) params.set("max", String(filters.maxPrice));
  if (filters.availability !== "any") params.set("availability", filters.availability);
  if (filters.sort !== "featured") params.set("sort", filters.sort);
  return params;
}
