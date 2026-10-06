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
import type {
  Campaign,
  Coupon,
  DeliveryArea,
  DeliverySettings,
  DeliveryType,
  DeliveryZone,
  ProductContent,
  Promotion,
  PromotionChannel,
  PromotionOfferType,
} from "../types";
import { storeSizeLabel } from "./variantLabel";

export function isCouponPromotion(
  promo: { mode?: string | null; code?: string | null } | null | undefined
): boolean {
  if (!promo) return false;

  if (
    promo.mode === "coupon" ||
    (typeof promo.mode === "string" &&
      promo.mode.toLowerCase() === "coupon")
  ) {
    return true;
  }

  if (promo.code && promo.code.trim().length > 0) {
    return true;
  }

  return false;
}

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
  /** The coupon code, when one is both entered and currently applying. */
  discount_code: string | null;
  /** The coupon's own discount — never the automatic promotion's (see
   * `auto_discount`), so a screen that shows "Discount code: −X" never
   * mislabels the storewide sale as if the typed code had produced it. */
  discount_amount: number;
  /**
   * The automatic (codeless) promotion's discount, already reconciled against
   * any applied coupon by `reconcileAutomaticAndCoupon` — zero whenever a
   * non-stackable coupon is applied, so this and `discount_amount` never both
   * count the same saving.
   */
  auto_discount: number;
  auto_promotion_id: string | null;
  auto_promotion_name: string | null;
  delivery_fee: number;
  total: number;
  /** Units across every line — the header's "3 items". */
  unit_count: number;
}

/**
 * The non-stacking rule applied when an automatic promotion and a coupon code
 * both discount the same cart: both survive only when both are marked
 * stackable, otherwise the COUPON always wins and the automatic promotion is
 * switched off entirely.
 *
 * There is deliberately no "larger discount wins" contest any more. A shopper
 * who types a valid code has made an explicit choice, and the cart must answer
 * it unambiguously: one code in, one discount line out. The old size contest
 * meant a code could be accepted and then silently produce nothing (the
 * storewide sale simply stayed on screen instead), which read to shoppers as
 * the cart ignoring their coupon — and, while the advisory preview caught up,
 * as an automatic discount that had already been displaced still being shown.
 */
export function reconcileAutomaticAndCoupon(
  autoDiscount: number,
  autoStackable: boolean,
  couponDiscount: number,
  couponStackable: boolean,
): { autoDiscount: number; couponDiscount: number } {
  const auto = Math.max(autoDiscount, 0);
  const coupon = Math.max(couponDiscount, 0);
  // A valid coupon (one actually worth something) disables the automatic
  // promotion outright unless BOTH sides opted into stacking.
  if (coupon > 0 && !(autoStackable && couponStackable)) {
    return { autoDiscount: 0, couponDiscount: coupon };
  }
  return { autoDiscount: auto, couponDiscount: coupon };
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
  size_value?: string | null;
  size_sort_order?: number;
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
const storeSizeCollator = new Intl.Collator(undefined,{numeric:true,sensitivity:"base"});
export const storeVariantSizeValue = (
  variant: Pick<StoreVariant,"size"|"size_label"> & Partial<Pick<StoreVariant,"size_value">>,
): string => (variant.size_value ?? storeSizeLabel(variant.size,variant.size_label)).trim();

export function sortStoreVariants<T extends Pick<StoreVariant, "color_key" | "size" | "size_label" | "sort_order" | "sku"> & Partial<Pick<StoreVariant,"size_value"|"size_sort_order">>>(
  variants: readonly T[],
): T[] {
  return [...variants].sort((a, b) => {
    if (a.color_key !== b.color_key) return a.color_key.localeCompare(b.color_key);
    if ((a.size_sort_order ?? 0) !== (b.size_sort_order ?? 0)) return (a.size_sort_order ?? 0) - (b.size_sort_order ?? 0);
    const sizeOrder=storeSizeCollator.compare(storeVariantSizeValue(a),storeVariantSizeValue(b));
    if(sizeOrder!==0)return sizeOrder;
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
  | "not_applicable"
  /** The customer's personal uses are spent, or the code is first-orders-only. */
  | "limit_reached";

export type CouponCheck =
  | { ok: true; coupon: Coupon; discount: number }
  | { ok: false; reason: CouponRejection };

/**
 * Context for evaluating a coupon.
 *
 * IMPORTANT: `subtotal` MUST be the **post-campaign subtotal** (i.e., the sum of
 * line totals after any automatic/campaign discounts have been applied). The
 * pricing ladder is: list price → campaign price = line price → subtotal = Σ
 * line totals → coupon discount → total. The coupon minimum is therefore
 * assessed against the live subtotal the customer sees, not the struck list
 * price. Both the TypeScript engine and the SQL `evaluate_order_pricing` /
 * `check_storefront_coupon` follow this rule.
 */
export interface CouponContext {
  /** Sum of line totals after campaign discounts. */
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
 *
 * IMPORTANT: `context.subtotal` must be the post-campaign subtotal (after
 * automatic/campaign discounts). The coupon minimum is assessed against this
 * live subtotal, matching the SQL `evaluate_order_pricing` and
 * `check_storefront_coupon`.
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
  if (coupon.discount_type === "free_shipping") {
    // A free-shipping code takes no money off the merchandise — its benefit
    // is the waived fee, resolved where the fee is resolved.
    discount = 0;
  } else if (coupon.discount_type === "percent") {
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
export function normalizeCouponCode(raw: string | null | undefined): string {
  if (!raw) return "";
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

/**
 * Checkout progress follows the same authority as delivery pricing. Any zone
 * rows disable the legacy/global fallback: a shopper must select an enabled
 * zone, whose threshold is then measured against discounted goods. Pickup can
 * never advertise delivery progress.
 */
export function checkoutFreeDeliveryProgress(input: {
  delivery: DeliverySettings;
  deliveryType: DeliveryType;
  subtotalAfterDiscount: number;
  zones: readonly DeliveryZone[];
  selectedZoneId: string | null;
}): { eligible: boolean; remaining: number; threshold: number } | null {
  if (input.deliveryType !== "delivery" || !input.delivery.enabled) return null;

  let threshold: number | null;
  if (input.zones.length > 0) {
    const selected = input.zones.find(
      (zone) => zone.id === input.selectedZoneId && zone.enabled,
    );
    if (!selected) return null;
    threshold = selected.free_shipping_threshold;
  } else {
    threshold = input.delivery.free_delivery_threshold;
  }

  if (threshold === null || threshold <= 0) return null;
  const remaining = round2(Math.max(threshold - input.subtotalAfterDiscount, 0));
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
    // priceCart is the campaign-only step: automatic promotions are evaluated
    // afterwards, across the whole order, by evaluateCartPricing — never here.
    auto_discount: 0,
    auto_promotion_id: null,
    auto_promotion_name: null,
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

// ── delivery zones + automatic promotions (the demo-side pricing engine) ────
// Mirrors `evaluate_order_pricing` in the database, rule for rule: the demo
// checkout and the advisory preview compute here what live mode computes in
// SQL, so both modes charge the same order the same total. Section order
// follows the SQL core — automatic promotion, promo code, stacking, fee,
// allocation — so a drift between the two is found by reading them side by
// side.

/**
 * Who is buying, for per-customer limits and first-order-only: the account id
 * when signed in, else `phone:<digits>`, else a per-order fallback that keeps
 * the key non-null (an unidentifiable customer counts as new, never as an
 * error). Same normalization the server uses.
 */
export function customerKeyFor(
  storeCustomerId: string | null | undefined,
  phone: string,
  orderRef?: string | null,
): string | null {
  const account = (storeCustomerId ?? "").trim();
  if (account) return account;
  const digits = phone.replace(/[^0-9]/g, "");
  if (digits) return `phone:${digits}`;
  return orderRef ? `order:${orderRef}` : null;
}

/** A promotion is live when it is switched on and the clock is inside its window. */
export function isPromotionLive(promotion: Promotion, now: Date = new Date()): boolean {
  if (!promotion.enabled) return false;
  const at = now.getTime();
  const startStr = promotion.start_date || promotion.starts_at;
  if (startStr) {
    const start = Date.parse(startStr);
    if (Number.isFinite(start) && at < start) return false;
  }
  const endStr = promotion.end_date || promotion.ends_at;
  if (endStr) {
    const end = Date.parse(endStr);
    if (Number.isFinite(end) && at > end) return false;
  }
  return true;
}

export interface PromotionCartLine {
  product_id: string;
  category_id: string | null;
  variant_id: string | null;
  line_total: number;
  qty?: number;
  unit_price?: number;
}

export interface PromotionEvaluationResult {
  promotion: Promotion;
  discount: number;
  rule_type: PromotionOfferType;
  buy_x?: number | null;
  get_y?: number | null;
  reward_qty?: number;
  rewardedUnits: { line_index: number; product_id: string; variant_id: string | null; unit_price: number; discount: number }[];
  lineDiscounts: number[];
  lineRewardedQty: number[];
}

/** Does a scoped offer touch this cart? Store scope always does. */
export function promotionApplies(
  promotion: Promotion,
  targetIds: ReadonlySet<string>,
  lines: readonly PromotionCartLine[],
): boolean {
  // Targets ride as `kind:id` so a product id can never match a category
  // scope — exactly like the SQL core's per-kind checks.
  if (promotion.scope === "store") return true;
  if (promotion.scope === "category") {
    return lines.some(
      (line) => line.category_id !== null && targetIds.has(`category:${line.category_id}`),
    );
  }
  if (promotion.scope === "product") {
    return lines.some((line) => targetIds.has(`product:${line.product_id}`));
  }
  return lines.some((line) => line.variant_id !== null && targetIds.has(`variant:${line.variant_id}`));
}

/**
 * Evaluates a candidate promotion against a set of cart lines, computing the total
 * discount and line-level allocations according to its offer type (Standard, Buy X Get Y, Cheapest Item).
 */
export function evaluatePromotionAgainstLines(
  promotion: Promotion,
  targetIds: ReadonlySet<string>,
  lines: readonly PromotionCartLine[],
  subtotal: number,
): PromotionEvaluationResult | null {
  const minSubtotal = promotion.minimum_order_amount ?? 0;
  if (subtotal < minSubtotal) return null;

  if (lines.length === 0) {
    if (promotion.scope !== "store" || subtotal <= 0) return null;
    const isPercent =
      promotion.discount_type === "percent" ||
      promotion.type === "percent" ||
      promotion.type === "percentage";
    let disc = 0;
    if (isPercent) {
      const percent = Math.min(Math.max(promotion.value, 0), 100);
      disc = round2((subtotal * percent) / 100);
      const maxDiscount = promotion.maximum_discount_amount ?? promotion.max_discount_amount;
      if (maxDiscount != null && maxDiscount > 0) {
        disc = Math.min(disc, round2(maxDiscount));
      }
    } else {
      disc = round2(Math.min(promotion.value, subtotal));
    }
    disc = Math.min(Math.max(disc, 0), subtotal);
    if (disc <= 0) return null;
    return {
      promotion,
      discount: disc,
      rule_type: "standard",
      rewardedUnits: [],
      lineDiscounts: [],
      lineRewardedQty: [],
    };
  }

  // 1. Identify eligible lines inside the promotion's eligible scope
  const eligibleIndices: number[] = [];
  lines.forEach((line, index) => {
    let hit = false;
    if (promotion.scope === "store") {
      hit = true;
    } else if (promotion.scope === "category") {
      hit = line.category_id !== null && targetIds.has(`category:${line.category_id}`);
    } else if (promotion.scope === "product") {
      hit = targetIds.has(`product:${line.product_id}`);
    } else if (promotion.scope === "variant") {
      hit = line.variant_id !== null && targetIds.has(`variant:${line.variant_id}`);
    }
    if (hit) eligibleIndices.push(index);
  });

  if (eligibleIndices.length === 0) return null;

  const offerType: PromotionOfferType = promotion.offer_type ?? promotion.rule_type ?? "standard";
  const lineDiscounts = new Array<number>(lines.length).fill(0);
  const lineRewardedQty = new Array<number>(lines.length).fill(0);
  const rewardedUnits: { line_index: number; product_id: string; variant_id: string | null; unit_price: number; discount: number }[] = [];

  let totalDiscount = 0;
  let buy_x: number | null = null;
  let get_y: number | null = null;
  let reward_qty = 0;

  if (offerType === "standard") {
    const eligibleBase = round2(eligibleIndices.reduce((sum, idx) => sum + lines[idx].line_total, 0));
    const isPercent =
      promotion.discount_type === "percent" ||
      promotion.type === "percent" ||
      promotion.type === "percentage";
    if (isPercent) {
      const percent = Math.min(Math.max(promotion.value, 0), 100);
      totalDiscount = round2((eligibleBase * percent) / 100);
      const maxDiscount = promotion.maximum_discount_amount ?? promotion.max_discount_amount;
      if (maxDiscount != null && maxDiscount > 0) {
        totalDiscount = Math.min(totalDiscount, round2(maxDiscount));
      }
    } else {
      totalDiscount = round2(Math.min(promotion.value, eligibleBase));
    }
    totalDiscount = Math.min(Math.max(totalDiscount, 0), subtotal);

    if (totalDiscount > 0 && eligibleBase > 0) {
      let remainder = totalDiscount;
      eligibleIndices.forEach((idx, k) => {
        if (k < eligibleIndices.length - 1) {
          const share = round2((totalDiscount * lines[idx].line_total) / eligibleBase);
          lineDiscounts[idx] = share;
          remainder = round2(remainder - share);
        } else {
          lineDiscounts[idx] = round2(remainder);
        }
      });
    }
  } else if (offerType === "bxgy") {
    buy_x = Math.max(promotion.buy_x ?? 2, 1);
    get_y = Math.max(promotion.get_y ?? 1, 1);
    const repeat = promotion.repeat_offer !== false;
    const groupSize = buy_x + get_y;

    // Expand eligible units
    const units: { line_index: number; product_id: string; variant_id: string | null; unit_price: number }[] = [];
    for (const idx of eligibleIndices) {
      const line = lines[idx];
      const qty = Math.max(line.qty ?? 1, 1);
      const unitPrice = line.unit_price ?? (line.line_total / qty);
      for (let u = 0; u < qty; u++) {
        units.push({
          line_index: idx,
          product_id: line.product_id,
          variant_id: line.variant_id,
          unit_price: round2(unitPrice),
        });
      }
    }

    const totalEligibleQty = units.length;
    const completeGroups = Math.floor(totalEligibleQty / groupSize);

    if (completeGroups > 0) {
      reward_qty = repeat ? completeGroups * get_y : get_y;
      reward_qty = Math.min(reward_qty, totalEligibleQty);

      // Sort units by unit_price ASC (cheapest eligible item first)
      units.sort((a, b) => a.unit_price - b.unit_price);
      const chosen = units.slice(0, reward_qty);

      const rewardType = promotion.reward_type ?? "free";
      const rewardVal = promotion.reward_value ?? (rewardType === "free" ? 100 : promotion.value ?? 100);

      for (const unit of chosen) {
        let uDisc = 0;
        if (rewardType === "free" || rewardVal >= 100) {
          uDisc = unit.unit_price;
        } else if (rewardType === "percent") {
          uDisc = round2((unit.unit_price * Math.min(rewardVal, 100)) / 100);
        } else {
          uDisc = Math.min(unit.unit_price, rewardVal);
        }
        uDisc = Math.min(uDisc, unit.unit_price);
        totalDiscount = round2(totalDiscount + uDisc);
        lineDiscounts[unit.line_index] = round2(lineDiscounts[unit.line_index] + uDisc);
        lineRewardedQty[unit.line_index] += 1;
        rewardedUnits.push({
          line_index: unit.line_index,
          product_id: unit.product_id,
          variant_id: unit.variant_id,
          unit_price: unit.unit_price,
          discount: uDisc,
        });
      }

      const rawDiscount = totalDiscount;
      if (promotion.maximum_discount_amount && promotion.maximum_discount_amount > 0) {
        totalDiscount = Math.min(totalDiscount, round2(promotion.maximum_discount_amount));
      }
      totalDiscount = Math.min(Math.max(totalDiscount, 0), subtotal);

      if (totalDiscount < rawDiscount && rawDiscount > 0) {
        let remainder = totalDiscount;
        const discIdx = eligibleIndices.filter((idx) => (lineDiscounts[idx] ?? 0) > 0);
        discIdx.forEach((idx, k) => {
          if (k < discIdx.length - 1) {
            const share = round2((totalDiscount * lineDiscounts[idx]) / rawDiscount);
            lineDiscounts[idx] = share;
            remainder = round2(remainder - share);
          } else {
            lineDiscounts[idx] = round2(remainder);
          }
        });
      }
    }
  } else if (offerType === "cheapest_item") {
    const minQty = Math.max(promotion.min_quantity ?? promotion.buy_x ?? 3, 1);
    const repeat = promotion.repeat_offer === true;

    // Expand eligible units
    const units: { line_index: number; product_id: string; variant_id: string | null; unit_price: number }[] = [];
    for (const idx of eligibleIndices) {
      const line = lines[idx];
      const qty = Math.max(line.qty ?? 1, 1);
      const unitPrice = line.unit_price ?? (line.line_total / qty);
      for (let u = 0; u < qty; u++) {
        units.push({
          line_index: idx,
          product_id: line.product_id,
          variant_id: line.variant_id,
          unit_price: round2(unitPrice),
        });
      }
    }

    const totalEligibleQty = units.length;
    if (totalEligibleQty >= minQty) {
      reward_qty = repeat ? Math.floor(totalEligibleQty / minQty) : 1;
      reward_qty = Math.min(reward_qty, totalEligibleQty);

      // Sort units by unit_price ASC (cheapest first)
      units.sort((a, b) => a.unit_price - b.unit_price);
      const chosen = units.slice(0, reward_qty);

      const rewardType = promotion.reward_type ?? (promotion.discount_type === "fixed" ? "fixed" : promotion.value >= 100 ? "free" : "percent");
      const rewardVal = promotion.reward_value ?? promotion.value ?? 100;

      for (const unit of chosen) {
        let uDisc = 0;
        if (rewardType === "free" || (rewardType === "percent" && rewardVal >= 100) || (promotion.discount_type === "percent" && promotion.value >= 100)) {
          uDisc = unit.unit_price;
        } else if (rewardType === "percent" || (rewardType === null && promotion.discount_type === "percent")) {
          uDisc = round2((unit.unit_price * Math.min(rewardVal, 100)) / 100);
        } else {
          uDisc = Math.min(unit.unit_price, rewardVal);
        }
        uDisc = Math.min(uDisc, unit.unit_price);
        totalDiscount = round2(totalDiscount + uDisc);
        lineDiscounts[unit.line_index] = round2(lineDiscounts[unit.line_index] + uDisc);
        lineRewardedQty[unit.line_index] += 1;
        rewardedUnits.push({
          line_index: unit.line_index,
          product_id: unit.product_id,
          variant_id: unit.variant_id,
          unit_price: unit.unit_price,
          discount: uDisc,
        });
      }

      const rawDiscount = totalDiscount;
      if (promotion.maximum_discount_amount && promotion.maximum_discount_amount > 0) {
        totalDiscount = Math.min(totalDiscount, round2(promotion.maximum_discount_amount));
      }
      totalDiscount = Math.min(Math.max(totalDiscount, 0), subtotal);

      if (totalDiscount < rawDiscount && rawDiscount > 0) {
        let remainder = totalDiscount;
        const discIdx = eligibleIndices.filter((idx) => (lineDiscounts[idx] ?? 0) > 0);
        discIdx.forEach((idx, k) => {
          if (k < discIdx.length - 1) {
            const share = round2((totalDiscount * lineDiscounts[idx]) / rawDiscount);
            lineDiscounts[idx] = share;
            remainder = round2(remainder - share);
          } else {
            lineDiscounts[idx] = round2(remainder);
          }
        });
      }
    }
  }

  if (totalDiscount <= 0) return null;

  return {
    promotion,
    discount: totalDiscount,
    rule_type: offerType,
    buy_x,
    get_y,
    reward_qty,
    rewardedUnits,
    lineDiscounts,
    lineRewardedQty,
  };
}

/**
 * Backward-compatible helper for single-value discount calculation.
 */
export function promotionDiscount(
  promotion: Promotion,
  targetIds: ReadonlySet<string>,
  lines: readonly PromotionCartLine[],
  subtotal: number,
): number {
  const result = evaluatePromotionAgainstLines(promotion, targetIds, lines, subtotal);
  return result ? result.discount : 0;
}

export interface AutomaticPromotionSelection {
  promotion: Promotion;
  discount: number;
  evaluation?: PromotionEvaluationResult;
}

/**
 * The best applicable automatic offer: highest priority wins, ties break
 * toward the larger discount, and the first candidate sets a bar only a
 * strictly larger discount displaces. Deterministic — no compounding.
 */
export function selectAutomaticPromotion(
  promotions: readonly Promotion[],
  targetsByPromotion: ReadonlyMap<string, ReadonlySet<string>>,
  lines: readonly PromotionCartLine[],
  subtotal: number,
  now: Date = new Date(),
  channel: PromotionChannel = "online",
): AutomaticPromotionSelection | null {
  const ordered = [...promotions].sort((a, b) => {
    const pA = a.priority ?? 0;
    const pB = b.priority ?? 0;
    if (pB !== pA) return pB - pA;
    return (a.created_at ?? "").localeCompare(b.created_at ?? "");
  });
  let best: AutomaticPromotionSelection | null = null;
  for (const promotion of ordered) {
    if (isCouponPromotion(promotion)) continue;
    if (!isPromotionLive(promotion, now)) continue;
    if (
      promotion.channel &&
      promotion.channel !== "both" &&
      promotion.channel !== channel &&
      !(channel === "both")
    ) {
      continue;
    }
    const minSubtotal = promotion.minimum_order_amount ?? 0;
    if (subtotal < minSubtotal) continue;
    const targetIds = targetsByPromotion.get(promotion.id) ?? new Set<string>();
    if (!promotionApplies(promotion, targetIds, lines)) continue;
    const evalResult = evaluatePromotionAgainstLines(promotion, targetIds, lines, subtotal);
    if (!evalResult || evalResult.discount <= 0) continue;
    if (!best || evalResult.discount > best.discount) {
      best = { promotion, discount: evalResult.discount, evaluation: evalResult };
    }
  }
  return best;
}

export interface PromoUsageSummary {
  /** Non-cancelled uses of this code by this customer. */
  customerUses: number;
  /** Whether the customer has any prior non-cancelled order. */
  hasPriorOrder: boolean;
}

export type PromoCheck =
  | { ok: true; coupon: Coupon; discount: number; freeShipping: boolean }
  | { ok: false; reason: CouponRejection };

/**
 * The extended code validation: the base rules plus free-shipping (no money
 * off, the benefit is the waived fee), per-customer limits and
 * first-order-only. Usage totals (`used_count`) are read from the coupon row
 * the caller locked; personal history arrives as a summary so this stays pure.
 */
export function checkPromoCode(
  coupon: Coupon | null,
  context: CouponContext,
  usage: PromoUsageSummary,
): PromoCheck {
  const base = checkCoupon(coupon, context);
  if (!base.ok) return base;
  if (!coupon) return { ok: false, reason: "not_found" };
  if (
    coupon.per_customer_limit !== null &&
    usage.customerUses >= coupon.per_customer_limit
  ) {
    return { ok: false, reason: "limit_reached" };
  }
  if (coupon.first_order_only && usage.hasPriorOrder) {
    return { ok: false, reason: "limit_reached" };
  }
  return { ok: true, coupon, discount: base.discount, freeShipping: coupon.discount_type === "free_shipping" };
}

export interface EvaluatedCartLine extends PromotionCartLine {
  product_id: string;
  category_id: string | null;
  variant_id: string | null;
  line_total: number;
  qty: number;
  unit_price: number;
  discounted_unit_price: number;
  rewarded_qty?: number;
  discount_amount?: number;
  promotion_id?: string | null;
  promotion_name?: string | null;
  rewarded_units?: number;
}

export interface CartPricingInput {
  /** Campaign-priced lines; the engine writes the discounted prices. */
  lines: Omit<EvaluatedCartLine, "discounted_unit_price">[];
  subtotal: number;
  /** Raw typed code (or null). Normalized here, like the server. */
  promoCode: string | null;
  coupons: readonly Coupon[];
  promotions: readonly Promotion[];
  targetsByPromotion: ReadonlyMap<string, ReadonlySet<string>>;
  usageFor: (couponId: string) => PromoUsageSummary;
  customerKey: string | null;
  zone: DeliveryZone | null;
  legacy: { fee: number; minimum: number; threshold: number };
  deliveryType: DeliveryType;
  now?: Date;
  /** Storefront defaults to online; POS supplies pos explicitly. */
  channel?: PromotionChannel;
}

export interface EvaluatedCart {
  subtotal: number;
  autoDiscount: number;
  autoPromotionId: string | null;
  autoPromotionName: string | null;
  autoPromotionRuleType?: PromotionOfferType | null;
  autoPromotionBuyX?: number | null;
  autoPromotionGetY?: number | null;
  autoPromotionRewardQty?: number | null;
  autoPromotionRewardedUnits?: { line_index: number; product_id: string; variant_id: string | null; unit_price: number; discount: number }[] | null;
  promoCode: string | null;
  promoDiscount: number;
  promoFreeShipping: boolean;
  couponPromotionId?: string | null;
  couponPromotionName?: string | null;
  couponPromotionRuleType?: PromotionOfferType | null;
  couponPromotionBuyX?: number | null;
  couponPromotionGetY?: number | null;
  couponPromotionRewardQty?: number | null;
  couponPromotionRewardedUnits?: { line_index: number; product_id: string; variant_id: string | null; unit_price: number; discount: number }[] | null;
  winningPromotionId?: string | null;
  winningPromotionName?: string | null;
  winningRuleType?: PromotionOfferType | null;
  winningBuyX?: number | null;
  winningGetY?: number | null;
  winningRewardQty?: number | null;
  grossShippingFee: number;
  shippingDiscount: number;
  shippingSource: string;
  deliveryFee: number;
  zoneId: string | null;
  zoneName: string | null;
  totalDiscount: number;
  total: number;
  lines: EvaluatedCartLine[];
}

export type CartPricingResult =
  | { ok: true; pricing: EvaluatedCart }
  | { ok: false; reason: CouponRejection; message: string };

/**
 * The combined evaluation — automatic promotion, promo code, stacking,
 * delivery fee, per-line allocation — mirroring `evaluate_order_pricing`.
 * Refusals carry the server's wordings so demo and live fail identically.
 */
export function evaluateCartPricing(input: CartPricingInput): CartPricingResult {
  const now = input.now ?? new Date();
  const lines = (input.lines ?? []).map((line) => {
    const qty = (line as { qty?: number }).qty ?? 1;
    const unit_price =
      (line as { unit_price?: number }).unit_price ??
      (qty > 0 && line.line_total != null ? line.line_total / qty : 0);
    const line_total = line.line_total ?? round2(unit_price * qty);
    return {
      ...line,
      qty,
      unit_price,
      line_total,
    };
  });
  const subtotal = round2(
    Math.max(
      input.subtotal != null && Number.isFinite(input.subtotal)
        ? input.subtotal
        : lines.reduce((sum, line) => sum + line.line_total, 0),
      0,
    ),
  );

  const auto =
    input.deliveryType !== "pickup" && input.deliveryType !== "delivery" && input.deliveryType !== undefined
      ? null
      : selectAutomaticPromotion(
          input.promotions ?? [],
          input.targetsByPromotion ?? new Map(),
          lines,
          subtotal,
          now,
          input.channel ?? "online",
        );

  let code: string | null = null;
  let promoDiscount = 0;
  let promoFreeShipping = false;
  let promoStackable = false;
  let appliedCoupon: Coupon | null = null;
  let appliedCouponPromo: Promotion | null = null;
  let evalCoupon: PromotionEvaluationResult | null = null;
  if (input.promoCode) {
    code = normalizeCouponCode(input.promoCode);
    if (!code) {
      return { ok: false, reason: "not_found", message: `Coupon ${input.promoCode} is not valid` };
    }
    const couponPromo = (input.promotions ?? []).find(
      (candidate) =>
        candidate.mode === "coupon" &&
        candidate.code &&
        normalizeCouponCode(candidate.code) === code,
    );
    if (couponPromo) {
      if (!couponPromo.enabled) {
        return { ok: false, reason: "inactive", message: `Coupon ${code} is not valid` };
      }
      const channel = input.channel ?? "online";
      if (
        couponPromo.channel &&
        couponPromo.channel !== "both" &&
        couponPromo.channel !== channel &&
        !(channel === "both")
      ) {
        return { ok: false, reason: "not_applicable", message: `Coupon ${code} does not apply to this channel` };
      }
      const startStr = couponPromo.start_date || couponPromo.starts_at;
      if (startStr && Date.parse(startStr) > now.getTime()) {
        return { ok: false, reason: "not_started", message: `Coupon ${code} is not active yet` };
      }
      const endStr = couponPromo.end_date || couponPromo.ends_at;
      if (endStr && Date.parse(endStr) < now.getTime()) {
        return { ok: false, reason: "expired", message: `Coupon ${code} has expired` };
      }
      if (
        couponPromo.usage_limit !== null &&
        couponPromo.usage_limit !== undefined &&
        (couponPromo.used_count ?? 0) >= couponPromo.usage_limit
      ) {
        return { ok: false, reason: "exhausted", message: `Coupon ${code} has been fully used` };
      }
      const minSub = couponPromo.minimum_order_amount ?? 0;
      if (subtotal < minSub) {
        return {
          ok: false,
          reason: "min_subtotal",
          message: `Coupon ${code} needs a subtotal of at least ${minSub}`,
        };
      }
      const targets = input.targetsByPromotion?.get(couponPromo.id) ?? new Set<string>();
      if (!promotionApplies(couponPromo, targets, lines)) {
        return { ok: false, reason: "not_applicable", message: `Coupon ${code} does not apply to this cart` };
      }
      evalCoupon = evaluatePromotionAgainstLines(couponPromo, targets, lines, subtotal);
      promoDiscount = evalCoupon ? evalCoupon.discount : 0;
      if (promoDiscount <= 0) {
        return { ok: false, reason: "not_applicable", message: `Coupon ${code} does not apply to this cart` };
      }
      promoFreeShipping = false;
      promoStackable = Boolean(couponPromo.stackable);
      appliedCouponPromo = couponPromo;
    } else {
      const coupon = (input.coupons ?? []).find((candidate) => candidate.code === code) ?? null;
      const usage = input.usageFor ? input.usageFor(coupon?.id ?? "") : { customerUses: 0, hasPriorOrder: false };
      const check = checkPromoCode(
        coupon,
        {
          subtotal,
          lines: lines.map((line) => ({
            product_id: line.product_id,
            category_id: line.category_id,
            line_total: line.line_total,
          })),
          now,
        },
        usage,
      );
      if (!check.ok) {
        const messages: Record<CouponRejection, string> = {
          not_found: `Coupon ${code} is not valid`,
          inactive: `Coupon ${code} is not valid`,
          not_started: `Coupon ${code} is not active yet`,
          expired: `Coupon ${code} has expired`,
          exhausted: `Coupon ${code} has been fully used`,
          min_subtotal: `Coupon ${code} needs a subtotal of at least ${coupon?.min_subtotal ?? 0}`,
          not_applicable: `Coupon ${code} does not apply to this cart`,
          limit_reached: `Coupon ${code} has reached its usage limit`,
        };
        return { ok: false, reason: check.reason, message: messages[check.reason] };
      }
      promoDiscount = check.discount;
      promoFreeShipping = check.freeShipping;
      promoStackable = check.coupon.stackable;
      appliedCoupon = check.coupon;
    }
  }

  // Stacking: both only when both agree, otherwise the coupon alone. There is
  // no size contest — a code that actually discounts always switches the
  // automatic promotion off, exactly like `reconcileAutomaticAndCoupon` and
  // the SQL core, `evaluate_order_pricing_channel`.
  let autoDiscount = auto?.discount ?? 0;
  let autoId = auto?.promotion.id ?? null;
  let autoName: string | null = auto ? (auto.promotion.name_en || auto.promotion.name_ar || null) : null;
  let autoRuleType = auto?.evaluation?.rule_type ?? (auto ? (auto.promotion.offer_type ?? auto.promotion.rule_type ?? "standard") : null);
  let autoBuyX = auto?.evaluation?.buy_x ?? auto?.promotion.buy_x ?? null;
  let autoGetY = auto?.evaluation?.get_y ?? auto?.promotion.get_y ?? null;
  let autoRewardQty = auto?.evaluation?.reward_qty ?? null;
  let autoRewardedUnits = auto?.evaluation?.rewardedUnits ?? null;

  if (code && auto) {
    if (auto.promotion.stackable && promoStackable) {
      // both apply
    } else if (promoDiscount > 0) {
      // The coupon always wins, however small. Only a code carrying NO goods
      // discount at all (a free-shipping coupon) leaves the automatic
      // promotion standing — see the branch below.
      autoDiscount = 0;
      autoId = null;
      autoName = null;
      autoRuleType = null;
      autoBuyX = null;
      autoGetY = null;
      autoRewardQty = null;
      autoRewardedUnits = null;
    } else {
      // A free-shipping-only code: worth nothing against the goods, so it
      // must not be allowed to cancel a real automatic discount. Unchanged
      // behaviour — the automatic promotion stands and the code stands down.
      promoDiscount = 0;
      promoFreeShipping = false;
    }
  }
  const goodsDiscount = Math.min(round2(autoDiscount + promoDiscount), subtotal);

  // Delivery fee: the zone's numbers, or the legacy settings', never the cart's.
  let grossFee = 0;
  let shipDiscount = 0;
  let shipSource = "pickup";
  let zoneId: string | null = null;
  let zoneName: string | null = null;
  if (input.deliveryType === "delivery") {
    const goods = round2(subtotal - goodsDiscount);
    if (input.zone) {
      if (!input.zone.enabled) {
        return { ok: false, reason: "not_applicable", message: "Delivery zone is not available" };
      }
      grossFee = round2(Math.max(input.zone.shipping_fee, 0));
      shipSource = "zone";
      zoneId = input.zone.id;
      zoneName = input.zone.name_en || input.zone.name_ar;
      if (input.zone.minimum_order_amount > 0 && goods < input.zone.minimum_order_amount) {
        return {
          ok: false,
          reason: "not_applicable",
          message: `Delivery orders need at least ${input.zone.minimum_order_amount}`,
        };
      }
      if (
        input.zone.free_shipping_threshold !== null &&
        input.zone.free_shipping_threshold > 0 &&
        goods >= input.zone.free_shipping_threshold
      ) {
        shipDiscount = grossFee;
        grossFee = 0;
      }
    } else {
      grossFee = round2(Math.max(input.legacy.fee, 0));
      shipSource = "settings";
      if (input.legacy.minimum > 0 && goods < input.legacy.minimum) {
        return {
          ok: false,
          reason: "not_applicable",
          message: `Delivery orders need at least ${input.legacy.minimum}`,
        };
      }
      if (input.legacy.threshold > 0 && goods >= input.legacy.threshold) {
        shipDiscount = grossFee;
        grossFee = 0;
      }
    }
    if (promoFreeShipping && grossFee > 0) {
      shipDiscount = round2(shipDiscount + grossFee);
      grossFee = 0;
      shipSource = `${shipSource}+promo`;
    }
  }

  const total = round2(subtotal - goodsDiscount + grossFee);

  // Scoped allocation, mirroring the server: each discount spreads over ITS
  // eligible lines (a category offer never touches an out-of-scope line).
  const couponTargets = code ? (appliedCoupon?.target_ids ?? []) : [];
  const couponScope = appliedCoupon?.applies_to ?? "all";
  const couponPromoTargets = appliedCouponPromo ? (input.targetsByPromotion.get(appliedCouponPromo.id) ?? new Set<string>()) : new Set<string>();
  const autoTargets = autoId && auto ? (input.targetsByPromotion.get(autoId) ?? new Set<string>()) : new Set<string>();
  const autoEligible = lines.map(
    (line) =>
      autoDiscount > 0 &&
      autoId !== null &&
      auto !== null &&
      promotionApplies(auto.promotion, autoTargets, [line]),
  );
  const codeEligible = lines.map((line) => {
    if (!code || promoDiscount <= 0) return false;
    if (appliedCouponPromo) {
      return promotionApplies(appliedCouponPromo, couponPromoTargets, [line]);
    }
    if (couponScope === "all") return true;
    if (couponScope === "products") return couponTargets.includes(line.product_id);
    return line.category_id !== null && couponTargets.includes(line.category_id);
  });
  const shares = new Array<number>(lines.length).fill(0);
  const spread = (amount: number, eligible: boolean[]) => {
    const base = round2(
      lines.reduce((sum, line, i) => (eligible[i] ? sum + line.line_total : sum), 0),
    );
    const idx = lines.map((_, i) => i).filter((i) => eligible[i]);
    let remainder = amount;
    idx.forEach((i, k) => {
      if (k < idx.length - 1 && base > 0) {
        const share = round2((amount * lines[i].line_total) / base);
        shares[i] = round2(shares[i] + share);
        remainder = round2(remainder - share);
      } else if (k === idx.length - 1) {
        shares[i] = round2(shares[i] + remainder);
      }
    });
  };

  if (autoDiscount > 0) {
    if (auto?.evaluation && (auto.evaluation.rule_type === "bxgy" || auto.evaluation.rule_type === "cheapest_item")) {
      auto.evaluation.lineDiscounts.forEach((disc, i) => {
        shares[i] = round2((shares[i] ?? 0) + disc);
      });
    } else {
      spread(autoDiscount, autoEligible);
    }
  }
  if (promoDiscount > 0) {
    if (appliedCouponPromo && evalCoupon && (evalCoupon.rule_type === "bxgy" || evalCoupon.rule_type === "cheapest_item")) {
      evalCoupon.lineDiscounts.forEach((disc, i) => {
        shares[i] = round2((shares[i] ?? 0) + disc);
      });
    } else {
      spread(promoDiscount, codeEligible);
    }
  }

  const priced: EvaluatedCartLine[] = lines.map((line, index) => {
    const lineShare = Math.max(shares[index] ?? 0, 0);
    const discounted = round2(
      Math.max(line.line_total - lineShare, 0) / Math.max(line.qty, 1),
    );
    const autoRewarded = auto?.evaluation?.lineRewardedQty?.[index] ?? 0;
    const couponRewarded = (appliedCouponPromo && evalCoupon) ? (evalCoupon.lineRewardedQty?.[index] ?? 0) : 0;
    const rewardedQty = autoRewarded + couponRewarded;
    const isCovered = (autoEligible[index] && autoDiscount > 0) || (codeEligible[index] && promoDiscount > 0) || lineShare > 0 || rewardedQty > 0;
    const promoId = autoId ?? (promoDiscount > 0 && appliedCouponPromo ? appliedCouponPromo.id : null);
    const promoName = autoName ?? (promoDiscount > 0 && appliedCouponPromo ? (appliedCouponPromo.name_en || appliedCouponPromo.name_ar) : null);
    return {
      ...line,
      discounted_unit_price: discounted,
      rewarded_qty: rewardedQty,
      discount_amount: lineShare,
      promotion_id: isCovered ? promoId : null,
      promotion_name: isCovered ? promoName : null,
      rewarded_units: rewardedQty,
    };
  });

  const winningPromoId = autoId ?? (promoDiscount > 0 && appliedCouponPromo ? appliedCouponPromo.id : null);
  const winningPromoName = autoName ?? (promoDiscount > 0 && appliedCouponPromo ? (appliedCouponPromo.name_en || appliedCouponPromo.name_ar) : null);
  const winningRuleType = autoRuleType ?? (promoDiscount > 0 && appliedCouponPromo && evalCoupon ? evalCoupon.rule_type : null);
  const winningBuyX = autoBuyX ?? (promoDiscount > 0 && appliedCouponPromo && evalCoupon ? evalCoupon.buy_x ?? null : null);
  const winningGetY = autoGetY ?? (promoDiscount > 0 && appliedCouponPromo && evalCoupon ? evalCoupon.get_y ?? null : null);
  const winningRewardQty = autoRewardQty ?? (promoDiscount > 0 && appliedCouponPromo && evalCoupon ? evalCoupon.reward_qty ?? null : null);

  return {
    ok: true,
    pricing: {
      subtotal,
      autoDiscount: round2(autoDiscount),
      autoPromotionId: autoId,
      autoPromotionName: autoName,
      autoPromotionRuleType: autoRuleType,
      autoPromotionBuyX: autoBuyX,
      autoPromotionGetY: autoGetY,
      autoPromotionRewardQty: autoRewardQty,
      autoPromotionRewardedUnits: autoRewardedUnits,
      promoCode: code,
      promoDiscount: round2(promoDiscount),
      promoFreeShipping,
      couponPromotionId: appliedCouponPromo ? appliedCouponPromo.id : null,
      couponPromotionName: appliedCouponPromo ? (appliedCouponPromo.name_en || appliedCouponPromo.name_ar) : null,
      couponPromotionRuleType: appliedCouponPromo && evalCoupon ? evalCoupon.rule_type : null,
      couponPromotionBuyX: appliedCouponPromo && evalCoupon ? evalCoupon.buy_x ?? null : null,
      couponPromotionGetY: appliedCouponPromo && evalCoupon ? evalCoupon.get_y ?? null : null,
      couponPromotionRewardQty: appliedCouponPromo && evalCoupon ? evalCoupon.reward_qty ?? null : null,
      couponPromotionRewardedUnits: appliedCouponPromo && evalCoupon ? evalCoupon.rewardedUnits : [],
      winningPromotionId: winningPromoId,
      winningPromotionName: winningPromoName,
      winningRuleType: winningRuleType,
      winningBuyX: winningBuyX,
      winningGetY: winningGetY,
      winningRewardQty: winningRewardQty,
      grossShippingFee: round2(grossFee + shipDiscount),
      shippingDiscount: round2(shipDiscount),
      shippingSource: shipSource,
      deliveryFee: round2(grossFee),
      zoneId,
      zoneName,
      totalDiscount: round2(goodsDiscount),
      total,
      lines: priced,
    },
  };
}

/**
 * The price one unit shows on a card: the best applicable automatic offer with
 * no cart-level minimum, so the struck-through price is never a promise the
 * checkout cannot keep. Targeted offers read their rows; the checkout (which
 * knows the whole cart) is the authority, this is the display.
 */
export function promotionUnitPrice(
  productId: string,
  variantId: string | null,
  categoryId: string | null,
  unitPrice: number,
  promotions: readonly Promotion[],
  targetsByPromotion: ReadonlyMap<string, ReadonlySet<string>>,
  now: Date = new Date(),
  channel: PromotionChannel = "online",
  couponCode?: string | null,
): {
  unit: number;
  promotionId: string | null;
  promotionName?: string | null;
  discountAmount?: number;
  percentOff?: number | null;
  offerType?: PromotionOfferType | null;
  buy_x?: number | null;
  get_y?: number | null;
} {
  const line: PromotionCartLine = {
    product_id: productId,
    category_id: categoryId,
    variant_id: variantId,
    line_total: unitPrice,
    qty: 1,
    unit_price: unitPrice,
  };
  let best: {
    unit: number;
    promotionId: string;
    promotionName: string;
    discountAmount: number;
    percentOff: number | null;
    offerType?: PromotionOfferType | null;
    buy_x?: number | null;
    get_y?: number | null;
  } | null = null;
  const ordered = [...promotions].sort((a, b) => {
    const pA = a.priority ?? 0;
    const pB = b.priority ?? 0;
    if (pB !== pA) return pB - pA;
    return (a.created_at ?? "").localeCompare(b.created_at ?? "");
  });
  const normalizedCode = normalizeCouponCode(couponCode);
  for (const promotion of ordered) {
    if (promotion.mode === "coupon") {
      if (!normalizedCode || normalizeCouponCode(promotion.code) !== normalizedCode) {
        continue;
      }
    }
    // Display-only offers: no minimum its cart cannot prove, live, in scope.
    if (promotion.minimum_order_amount && promotion.minimum_order_amount > 0) continue;
    if (!isPromotionLive(promotion, now)) continue;
    if (
      promotion.channel &&
      promotion.channel !== "both" &&
      promotion.channel !== channel &&
      !(channel === "both")
    ) {
      continue;
    }
    const targetIds = targetsByPromotion.get(promotion.id) ?? new Set<string>();
    if (!promotionApplies(promotion, targetIds, [line])) continue;

    const offerType: PromotionOfferType = promotion.offer_type ?? promotion.rule_type ?? "standard";
    const name = promotion.name_en || promotion.name_ar || "";

    if (offerType === "bxgy" || offerType === "cheapest_item") {
      // For multi-item offers, single card unit price is not discounted, but the offer info is made available for badge display
      if (!best) {
        best = {
          unit: round2(unitPrice),
          promotionId: promotion.id,
          promotionName: name,
          discountAmount: 0,
          percentOff: null,
          offerType,
          buy_x: promotion.buy_x,
          get_y: promotion.get_y,
        };
      }
      continue;
    }

    const discount = promotionDiscount(promotion, targetIds, [line], unitPrice);
    const unit = round2(Math.max(unitPrice - discount, 0));
    const saving = round2(unitPrice - unit);
    if (!best || unit < best.unit) {
      const isPercent =
        promotion.type === "percentage" ||
        promotion.type === "percent" ||
        promotion.discount_type === "percent";
      const percentOff = isPercent
        ? Math.round(promotion.value)
        : unitPrice > 0
          ? Math.round((saving / unitPrice) * 100)
          : null;
      best = {
        unit,
        promotionId: promotion.id,
        promotionName: name,
        discountAmount: saving,
        percentOff,
        offerType: "standard",
      };
    }
  }
  return (
    best ?? {
      unit: round2(unitPrice),
      promotionId: null,
      promotionName: null,
      discountAmount: 0,
      percentOff: null,
      offerType: null,
    }
  );
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
