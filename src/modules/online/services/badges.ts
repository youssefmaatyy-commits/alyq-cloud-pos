/**
 * Product badges — "New", "Sale", "Best seller".
 *
 * All three are *derived*, never stored as a flag on the product. A badge that
 * is a column goes stale the moment the thing it describes changes: a product
 * marked "new" is still marked new in a year, and a product marked "best seller"
 * keeps the badge after it stops selling. Deriving them from dates and from what
 * actually sold means the storefront can never show a badge that is a lie.
 *
 *   new          created within the last `NEW_ARRIVAL_DAYS`
 *   sale         a live campaign covers it right now
 *   bestSeller   it is in the top N by units sold (POS sales, excluding voids,
 *                plus website orders that were not cancelled)
 *   featured     the catalogue's own `is_featured` — the one badge an admin sets
 *                by hand, because featuring a product is a merchandising choice
 */
import type { Campaign, OnlineOrder } from "../types";
import { isCampaignLive, campaignCovers } from "./pricing";

export const PRODUCT_BADGES = ["new", "sale", "bestSeller", "featured"] as const;
export type ProductBadge = (typeof PRODUCT_BADGES)[number];

/** How long a product counts as new. A month is a shop's usual sense of it. */
export const NEW_ARRIVAL_DAYS = 30;

/** How many products the "best sellers" section shows. */
export const BEST_SELLER_LIMIT = 8;

export function isNewArrival(
  createdAt: string | null | undefined,
  now: Date = new Date(),
  days: number = NEW_ARRIVAL_DAYS,
): boolean {
  if (!createdAt) return false;
  const created = Date.parse(createdAt);
  if (!Number.isFinite(created)) return false;
  const ageDays = (now.getTime() - created) / 86_400_000;
  return ageDays >= 0 && ageDays <= days;
}

export interface SoldUnit {
  product_id: string;
  quantity: number;
}

/**
 * Units sold per product, from the two places demand is recorded.
 *
 * A voided POS sale is not demand — it is a reversal. A cancelled website order
 * is not demand either. A *pending* website order counts: somebody wanted it,
 * and a best-seller list that ignored the website until staff approved each
 * order would lag by however long the queue takes.
 */
export function unitsSold(input: {
  sales: readonly {
    status: string;
    items: readonly { product_id: string; quantity: number }[];
  }[];
  onlineOrders: readonly OnlineOrder[];
}): Map<string, number> {
  const totals = new Map<string, number>();
  const add = (productId: string, quantity: number) => {
    totals.set(productId, (totals.get(productId) ?? 0) + quantity);
  };

  for (const sale of input.sales) {
    if (sale.status === "voided") continue;
    for (const item of sale.items) add(item.product_id, item.quantity);
  }
  for (const order of input.onlineOrders) {
    if (order.status === "cancelled") continue;
    for (const item of order.items) add(item.product_id, item.quantity);
  }
  return totals;
}

/** The ids of the best-selling products, strongest first. */
export function bestSellerIds(
  units: ReadonlyMap<string, number>,
  limit: number = BEST_SELLER_LIMIT,
): string[] {
  return [...units.entries()]
    .filter(([, quantity]) => quantity > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([productId]) => productId);
}

/** Every badge a product carries right now, most attention-grabbing first. */
export function productBadges(input: {
  product: { id: string; is_featured: boolean; created_at: string };
  campaigns: readonly Campaign[];
  bestSellerIds: readonly string[];
  now?: Date;
  newArrivalDays?: number;
}): ProductBadge[] {
  const now = input.now ?? new Date();
  const badges: ProductBadge[] = [];

  const onSale = input.campaigns.some(
    (campaign) => isCampaignLive(campaign, now) && campaignCovers(campaign, input.product.id),
  );
  if (onSale) badges.push("sale");
  if (input.bestSellerIds.includes(input.product.id)) badges.push("bestSeller");
  if (isNewArrival(input.product.created_at, now, input.newArrivalDays)) badges.push("new");
  if (input.product.is_featured) badges.push("featured");

  return badges;
}

/** The campaign badge text an admin wrote, if this product is in a live one. */
export function campaignBadgeText(
  productId: string,
  campaigns: readonly Campaign[],
  pick: (arabic: string | null, english: string | null) => string,
  now: Date = new Date(),
): string | null {
  const campaign = campaigns.find(
    (candidate) => isCampaignLive(candidate, now) && campaignCovers(candidate, productId),
  );
  if (!campaign) return null;
  return pick(campaign.badge_ar, campaign.badge_en) || pick(campaign.name_ar, campaign.name_en) || null;
}
