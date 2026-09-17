/**
 * Storefront pricing — what a cart costs, and why.
 *
 * Pure and server-mirrored: `place_online_order` recomputes exactly these
 * numbers from the catalogue, so a customer cannot pay less by editing the
 * request. Everything here is also what the checkout screen shows, which is the
 * point — the arithmetic the customer sees and the arithmetic the database
 * performs are the same arithmetic.
 *
 * Order of operations, and it matters:
 *   1. unit price  = catalogue price, less the best live campaign on it
 *   2. line total  = round(unit × qty, 2)
 *   3. subtotal    = Σ line totals
 *   4. discount    = the coupon, applied to the subtotal (and capped)
 *   5. delivery    = the shop's fee, free at or above the threshold, 0 for pickup
 *   6. total       = subtotal − discount + delivery
 *
 * A coupon is applied to the subtotal *after* campaign prices, never on top of
 * them as a second percentage: two stacked discounts on one line is how a shop
 * sells below cost by accident.
 */
import type { Campaign, Coupon, DeliveryArea, DeliverySettings, ProductContent } from "../types";

/** Money is Egyptian pounds, rounded to piastres. */
export function round2(value: number): number {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

export interface PricedLine {
  product_id: string;
  /**
   * Phase 43: the exact combination priced, when the product sells by variant.
   * Null on a product-level line.
   */
  variant_id: string | null;
  quantity: number;
  /** Catalogue price, before any campaign. */
  list_price: number;
  /** Price actually charged, after the campaign. */
  unit_price: number;
  line_total: number;
  /** The campaign that lowered it, when there is one. */
  campaign_id: string | null;
}

export interface CartTotals {
  lines: PricedLine[];
  subtotal: number;
  discount_code: string | null;
  discount_amount: number;
  delivery_fee: number;
  total: number;
  /** Units across every line — the header's "3 items". */
  unit_count: number;
}

/** A campaign is live when it is switched on and the clock is inside its window. */
export function isCampaignLive(campaign: Campaign, now: Date = new Date()): boolean {
  if (!campaign.active) return false;
  const start = Date.parse(campaign.starts_at);
  const end = Date.parse(campaign.ends_at);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return false;
  const at = now.getTime();
  return at >= start && at <= end;
}

/** Campaigns currently running, strongest discount first. */
export function liveCampaigns(campaigns: readonly Campaign[], now: Date = new Date()): Campaign[] {
  return campaigns
    .filter((campaign) => isCampaignLive(campaign, now))
    .sort((a, b) => discountStrength(b) - discountStrength(a));
}

/**
 * A rough strength so the best offer wins when several overlap. A percentage and
 * a fixed amount are not directly comparable without a price, so this orders by
 * kind first (percent before fixed, since a percent scales with the product) and
 * then by value. Deterministic, and only ever picks between live campaigns.
 */
function discountStrength(campaign: Campaign): number {
  return campaign.discount_type === "percent"
    ? 1000 + campaign.discount_value
    : campaign.discount_value;
}

/** Does this campaign cover this product? An empty list means "everything". */
export function campaignCovers(campaign: Campaign, productId: string): boolean {
  if (campaign.product_ids.length === 0) return true;
  return campaign.product_ids.includes(productId);
}

/** The best live campaign for one product, or null. */
export function campaignFor(
  productId: string,
  campaigns: readonly Campaign[],
  now: Date = new Date(),
): Campaign | null {
  return liveCampaigns(campaigns, now).find((campaign) => campaignCovers(campaign, productId)) ?? null;
}

/**
 * The price a product sells at right now.
 *
 * A fixed discount can never take a price below zero; a percentage is applied to
 * the catalogue price and rounded once, so 33.33 EGP at 15% is 28.33 and not
 * 28.3304999.
 */
export function unitPriceOf(
  listPrice: number,
  campaign: Campaign | null,
): number {
  if (!campaign) return round2(listPrice);
  if (campaign.discount_type === "percent") {
    const percent = Math.min(Math.max(campaign.discount_value, 0), 100);
    return round2((listPrice * (100 - percent)) / 100);
  }
  return round2(Math.max(listPrice - campaign.discount_value, 0));
}

// ── variants (Phase 43) ─────────────────────────────────────────────────────

/**
 * The published shape of a combination, as `storefront_product_variants()`
 * returns it. Never cost, never the low-stock threshold — the same rule the
 * product window has.
 */
export interface StoreVariant {
  id: string;
  product_id: string;
  sku: string;
  color_key: string;
  color_ar: string | null;
  color_en: string | null;
  color_hex: string | null;
  size: number | null;
  size_label: string | null;
  image_url: string | null;
  /** Null → the product's own selling_price (campaigns may then apply). */
  price_override: number | null;
  stock_quantity: number;
  active: boolean;
  sort_order: number;
}

/**
 * What one combination sells for, under the same rule the database prices with:
 *
 *   · a combination with its own price override sells at that override, FIXED —
 *     a campaign never stacks on top, because a shop that marked one size down
 *     did so deliberately;
 *   · every other combination sells at the product price, campaigns included.
 */
export function variantUnitPriceOf(
  variant: Pick<StoreVariant, "price_override">,
  productPrice: number,
  campaign: Campaign | null,
): number {
  if (variant.price_override !== null) return round2(Math.max(variant.price_override, 0));
  return unitPriceOf(productPrice, campaign);
}

/**
 * Display order: colour, then NUMERIC size, then the shop's own ordering —
 * `16 → 16.5 → 17 → 17.5`, never lexicographically. The storefront's twin of
 * the catalogue's `compareVariants`, kept here because the customer side never
 * imports the catalogue's internals.
 */
export function sortStoreVariants<T extends Pick<StoreVariant, "color_key" | "size" | "size_label" | "sort_order" | "sku">>(
  variants: readonly T[],
): T[] {
  return [...variants].sort((a, b) => {
    if (a.color_key !== b.color_key) return a.color_key.localeCompare(b.color_key);
    if (a.size !== null && b.size !== null && a.size !== b.size) return a.size - b.size;
    if (a.size === null && b.size !== null) return 1;
    if (a.size !== null && b.size === null) return -1;
    if ((a.size_label ?? "") !== (b.size_label ?? "")) {
      return (a.size_label ?? "").localeCompare(b.size_label ?? "");
    }
    if (a.sort_order !== b.sort_order) return a.sort_order - b.sort_order;
    return a.sku.localeCompare(b.sku);
  });
}

/** One colour's row in the picker: the swatch and the sizes it opens. */
export interface StoreVariantColorGroup {
  color_key: string;
  color_ar: string | null;
  color_en: string | null;
  color_hex: string | null;
  variants: StoreVariant[];
}

/**
 * Group a product's combinations by colour for the picker: one row of swatches,
 * each opening the numeric sizes of that colour. A size-only product yields one
 * group with an empty colour key; a colour-only product yields one variant per
 * group.
 */
export function colorGroupsOf(variants: readonly StoreVariant[]): StoreVariantColorGroup[] {
  const groups = new Map<string, StoreVariantColorGroup>();
  for (const variant of sortStoreVariants(variants)) {
    const existing = groups.get(variant.color_key);
    if (existing) {
      existing.variants.push(variant);
    } else {
      groups.set(variant.color_key, {
        color_key: variant.color_key,
        color_ar: variant.color_ar,
        color_en: variant.color_en,
        color_hex: variant.color_hex,
        variants: [variant],
      });
    }
  }
  return [...groups.values()];
}

// ── coupons ─────────────────────────────────────────────────────────────────

/** Why a coupon was refused. Keys, so the UI can translate them. */
export type CouponRejection =
  | "not_found"
  | "inactive"
  | "not_started"
  | "expired"
  | "exhausted"
  | "min_subtotal"
  | "not_applicable";

export type CouponCheck =
  | { ok: true; coupon: Coupon; discount: number }
  | { ok: false; reason: CouponRejection };

export interface CouponContext {
  subtotal: number;
  /** Product ids in the cart, with their category ids, for restricted coupons. */
  lines: { product_id: string; category_id: string | null; line_total: number }[];
  now?: Date;
}

/** A coupon's window and switch, ignoring the cart. */
export function isCouponUsable(coupon: Coupon, now: Date = new Date()): CouponRejection | null {
  if (!coupon.active) return "inactive";
  const at = now.getTime();
  if (coupon.starts_at) {
    const start = Date.parse(coupon.starts_at);
    if (Number.isFinite(start) && at < start) return "not_started";
  }
  if (coupon.ends_at) {
    const end = Date.parse(coupon.ends_at);
    if (Number.isFinite(end) && at > end) return "expired";
  }
  if (coupon.usage_limit !== null && coupon.used_count >= coupon.usage_limit) return "exhausted";
  return null;
}

/**
 * Does a restricted coupon apply to this cart?
 *
 * `products` requires at least one listed product in the cart; `categories`
 * requires at least one line whose product is in a listed category. A coupon
 * scoped to nothing (`all`) always applies.
 */
export function couponApplies(coupon: Coupon, context: CouponContext): boolean {
  if (coupon.applies_to === "all") return true;
  if (coupon.applies_to === "products") {
    return context.lines.some((line) => coupon.target_ids.includes(line.product_id));
  }
  return context.lines.some(
    (line) => line.category_id !== null && coupon.target_ids.includes(line.category_id),
  );
}

/**
 * Validate a code against a cart and compute the discount.
 *
 * The discount is taken from the **whole subtotal**, not from the eligible lines
 * of a restricted coupon: a coupon on "earrings" that takes 20 EGP off an order
 * containing earrings is what a customer expects, and it can never exceed the
 * subtotal, so it cannot make an order negative.
 */
export function checkCoupon(
  coupon: Coupon | null,
  context: CouponContext,
): CouponCheck {
  if (!coupon) return { ok: false, reason: "not_found" };

  const now = context.now ?? new Date();
  const unusable = isCouponUsable(coupon, now);
  if (unusable) return { ok: false, reason: unusable };
  if (!couponApplies(coupon, context)) return { ok: false, reason: "not_applicable" };
  if (context.subtotal < coupon.min_subtotal) return { ok: false, reason: "min_subtotal" };

  let discount: number;
  if (coupon.discount_type === "percent") {
    const percent = Math.min(Math.max(coupon.value, 0), 100);
    discount = round2((context.subtotal * percent) / 100);
    if (coupon.max_discount !== null) discount = Math.min(discount, round2(coupon.max_discount));
  } else {
    discount = round2(coupon.value);
  }
  // Never below zero, never more than the merchandise itself.
  discount = Math.min(Math.max(discount, 0), round2(context.subtotal));

  return { ok: true, coupon, discount };
}

/** Normalise what the customer typed: stored codes are uppercase and trimmed. */
export function normalizeCouponCode(raw: string): string {
  return raw.trim().toUpperCase().replace(/\s+/g, "");
}

// ── delivery ────────────────────────────────────────────────────────────────

/**
 * What delivery costs for this order.
 *
 * Pickup is always free. Delivery is the shop's fee, waived at or above the free
 * threshold, and 0 when delivery is switched off (the checkout then offers pickup
 * only, and the server refuses a delivery order outright).
 */
export function deliveryFeeFor(
  delivery: DeliverySettings,
  deliveryType: "delivery" | "pickup",
  subtotalAfterDiscount: number,
): number {
  if (deliveryType === "pickup") return 0;
  if (!delivery.enabled) return 0;
  const threshold = delivery.free_delivery_threshold;
  if (threshold !== null && threshold > 0 && subtotalAfterDiscount >= threshold) return 0;
  return round2(Math.max(delivery.fee, 0));
}

/**
 * The shop's delivery areas, cleaned: trimmed, empties dropped. An entry is a
 * place name the customer's city is matched against, in either language.
 */
export function deliveryAreasOf(delivery: DeliverySettings): DeliveryArea[] {
  return (delivery.areas ?? [])
    .map((area) => ({ ar: (area?.ar ?? "").trim(), en: (area?.en ?? "").trim() }))
    .filter((area) => area.ar.length > 0 || area.en.length > 0);
}

/** A place name compared the way a person would: trimmed, case-folded, spaced. */
export function normalizePlaceName(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

/**
 * Is the address one of the places the shop delivers to?
 *
 * The shop lists places — "Ismailia", "حي الأربعين" — and the customer's city
 * *and* area are both checked against every entry, in either language, because
 * a shop at the edge of a city often names the neighbourhood rather than the
 * city. An empty list means the shop has not restricted delivery. The server
 * compares the same way (0042), so a cart that passes here passes there.
 */
export function deliveryAreaSupported(
  delivery: DeliverySettings,
  city: string,
  area: string,
): boolean {
  const places = deliveryAreasOf(delivery);
  if (places.length === 0) return true; // no list = delivers anywhere
  const wanted = [normalizePlaceName(city), normalizePlaceName(area)].filter(Boolean);
  if (wanted.length === 0) return false;
  return places.some((place) => {
    const names = [normalizePlaceName(place.ar), normalizePlaceName(place.en)].filter(Boolean);
    return names.some((name) => wanted.includes(name));
  });
}

/**
 * How much more the goods must be worth before delivery is allowed; 0 when the
 * order already qualifies (or no minimum is set, or this is a pickup).
 *
 * The same number the order function computes server-side — the message the
 * customer reads and the refusal they would get must agree.
 */
export function deliveryMinimumShortfall(
  delivery: DeliverySettings,
  deliveryType: "delivery" | "pickup",
  subtotalAfterDiscount: number,
): number {
  if (deliveryType !== "delivery") return 0;
  const minimum = delivery.minimum_order;
  if (minimum === null || minimum === undefined || minimum <= 0) return 0;
  return round2(Math.max(minimum - subtotalAfterDiscount, 0));
}

/** True when the order is close enough to the threshold to be worth saying so. */
export function freeDeliveryProgress(
  delivery: DeliverySettings,
  subtotalAfterDiscount: number,
): { eligible: boolean; remaining: number; threshold: number } | null {
  const threshold = delivery.free_delivery_threshold;
  if (!delivery.enabled || threshold === null || threshold <= 0) return null;
  const remaining = round2(Math.max(threshold - subtotalAfterDiscount, 0));
  return { eligible: remaining === 0, remaining, threshold };
}

// ── the cart ────────────────────────────────────────────────────────────────

export interface PriceCartItem {
  product_id: string;
  /** Catalogue price. The campaign is looked up here, never trusted from a cart. */
  list_price: number;
  quantity: number;
  category_id?: string | null;
  /**
   * Phase 43: the combination being priced, and the price it is fixed at when it
   * has its own override. A priced line for a variant product carries both; a
   * legacy line carries neither.
   */
  variant_id?: string | null;
  /** Non-null → the line prices at exactly this, campaigns never applied. */
  fixed_price?: number | null;
}

/**
 * Price a cart end to end.
 *
 * `cataloguePrice` exists so the caller can hand in the live catalogue price
 * rather than whatever the cart was holding when the product was added: a price
 * change between "add to cart" and "checkout" must be charged at the new price,
 * and the customer sees that in the summary before they commit.
 */
export function priceCart(input: {
  items: readonly PriceCartItem[];
  campaigns: readonly Campaign[];
  coupon?: Coupon | null;
  couponCode?: string | null;
  delivery: DeliverySettings;
  deliveryType: "delivery" | "pickup";
  now?: Date;
}): CartTotals {
  const now = input.now ?? new Date();

  const lines: PricedLine[] = input.items.map((item) => {
    // A combination with its own price is priced by that override and nothing
    // else — the same decision `place_online_order` makes.
    const fixed = item.fixed_price !== null && item.fixed_price !== undefined;
    const campaign = fixed ? null : campaignFor(item.product_id, input.campaigns, now);
    const unitPrice = fixed
      ? round2(Math.max(item.fixed_price as number, 0))
      : unitPriceOf(item.list_price, campaign);
    const quantity = Math.max(Math.trunc(item.quantity) || 0, 0);
    return {
      product_id: item.product_id,
      variant_id: item.variant_id ?? null,
      quantity,
      list_price: round2(item.list_price),
      unit_price: unitPrice,
      line_total: round2(unitPrice * quantity),
      campaign_id: campaign?.id ?? null,
    };
  });

  const subtotal = round2(lines.reduce((sum, line) => sum + line.line_total, 0));
  const unitCount = lines.reduce((sum, line) => sum + line.quantity, 0);

  const coupon = input.coupon ?? null;
  const check = coupon
    ? checkCoupon(coupon, {
        subtotal,
        lines: input.items.map((item, index) => ({
          product_id: item.product_id,
          category_id: item.category_id ?? null,
          line_total: lines[index]?.line_total ?? 0,
        })),
        now,
      })
    : null;

  const discountAmount = check?.ok ? check.discount : 0;
  const deliveryFee = deliveryFeeFor(input.delivery, input.deliveryType, round2(subtotal - discountAmount));

  return {
    lines,
    subtotal,
    discount_code: check?.ok ? coupon?.code ?? null : null,
    discount_amount: discountAmount,
    delivery_fee: deliveryFee,
    total: round2(subtotal - discountAmount + deliveryFee),
    unit_count: unitCount,
  };
}

/**
 * The merchandise total an approved order turns into a POS sale for.
 *
 * The delivery fee is deliberately excluded: `sales.total = subtotal − discount`
 * is a table constraint, and a fee is neither. It stays on the order, where the
 * online reports pick it up.
 */
export function goodsTotalOf(order: {
  subtotal: number;
  discount_amount: number;
}): number {
  return round2(order.subtotal - order.discount_amount);
}

// ── brands ──────────────────────────────────────────────────────────────────

export interface BrandEntry {
  /** The display name in each language, and how many products carry it. */
  name_ar: string;
  name_en: string;
  count: number;
}

/**
 * The brands section: every distinct brand in the visible catalogue, most
 * products first. Derived from `product_content`, so adding a brand is a matter
 * of typing it against a product — there is no brands table to maintain.
 */
export function brandsOf(
  contents: readonly ProductContent[],
  pick: (arabic: string | null, english: string | null) => string,
  visibleProductIds?: ReadonlySet<string>,
): BrandEntry[] {
  const byKey = new Map<string, BrandEntry>();

  for (const content of contents) {
    if (visibleProductIds && !visibleProductIds.has(content.product_id)) continue;
    const nameAr = content.brand_ar?.trim() ?? "";
    const nameEn = content.brand_en?.trim() ?? "";
    if (!nameAr && !nameEn) continue;

    // One entry per brand, not per spelling: keys are case- and space-insensitive
    // on the English name (or the Arabic one when there is no English).
    const key = (nameEn || nameAr).toLowerCase().replace(/\s+/g, " ");
    const existing = byKey.get(key);
    if (existing) {
      existing.count += 1;
      existing.name_ar = existing.name_ar || nameAr;
      existing.name_en = existing.name_en || nameEn;
    } else {
      byKey.set(key, { name_ar: nameAr, name_en: nameEn, count: 1 });
    }
  }

  return [...byKey.values()].sort(
    (a, b) => b.count - a.count || pick(a.name_ar, a.name_en).localeCompare(pick(b.name_ar, b.name_en)),
  );
}
