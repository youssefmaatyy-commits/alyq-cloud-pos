/**
 * Persistence contracts for the online storefront (Phase 9).
 *
 * Three interfaces, because three different callers touch this data and they
 * must not be able to reach each other's operations:
 *
 *   `OnlineOrdersRepository` — checkout and order tracking for customers, and
 *     the staff workflow for the POS. Writes that move money or stock go through
 *     a server-side function in live mode, never through a client-side update.
 *   `WebsiteRepository`      — the appearance document, storefront content and
 *     marketing (coupons, campaigns). Admin only.
 *   `StoreAccountsRepository`— website accounts: register, sign in, addresses,
 *     wishlist. Credentials never appear in the domain model.
 *
 * One class implements all three per mode (`demo` = localStorage, `supabase` =
 * live), which keeps a single source of truth for the shared state — an approved
 * order has to release its reservation and create its sale in the same breath.
 */
import type {
  Campaign,
  Coupon,
  CustomerAddress,
  DeliveryType,
  DeliveryZone,
  OnlineOrder,
  OnlineOrderStatus,
  OnlinePaymentStatus,
  PaymentProofInput,
  PlaceOrderInput,
  ProductContent,
  PromoCodeUsage,
  Promotion,
  PromotionTarget,
  PromotionTargetDraft,
  ResolveOrderInput,
  SettingsSaveInput,
  StoreCustomer,
  StoreFaq,
  StorefrontCategoryContent,
  StorefrontCategoryContentDraft,
  StoreReview,
  StockReservation,
  ReservationHoldInput,
  ReservationRepairInput,
  ReservationRepairResult,
  WebsiteSettings,
  WebsiteSettingsMeta,
} from "../types";

export type OnlineMode = "supabase" | "demo";

// ── errors ──────────────────────────────────────────────────────────────────

/**
 * Why a storefront operation failed, as a stable machine code.
 *
 * The customer has to be told something actionable — "only 2 left" is a
 * different sentence from "this coupon has expired" — and neither can be
 * inferred from a translated message string. Codes are dictionary keys' worth of
 * information; the UI picks the wording.
 */
export const ONLINE_ERROR_CODES = [
  "empty_cart",
  "insufficient_stock",
  "invalid_quantity",
  /** Phase 43: a variant-product line arrived without its exact combination. */
  "variant_required",
  /** Phase 43: the combination named does not belong to the product (or it). */
  "variant_mismatch",
  "product_unavailable",
  "product_not_found",
  "product_not_online",
  "missing_contact",
  "missing_address",
  "delivery_unavailable",
  /**
   * The shop listed the places it delivers to and this address is not one of
   * them (0042 / `deliveryAreaSupported`). The customer can still choose pickup.
   */
  "delivery_area_unsupported",
  /**
   * The goods total is under the shop's minimum for delivery. Pickup is never
   * gated by it, so the refusal names the alternative too.
   */
  "delivery_minimum_not_met",
  "pickup_unavailable",
  /**
   * The zone id the cart carried is gone, disabled, or was removed by the
   * admin between the checkout page loading and the customer submitting
   * (0054's trigger and 0050's `place_online_order` both raise "Delivery zone
   * is not available" for this). Distinct from `delivery_area_unsupported`
   * (a free-text address outside the shop's places): here the shopper picked
   * a real zone that stopped being valid, and the fix is to choose again.
   */
  "delivery_zone_unavailable",
  "payment_unavailable",
  "coupon_invalid",
  "coupon_expired",
  "coupon_not_started",
  "coupon_limit_reached",
  "coupon_min_subtotal",
  "coupon_not_applicable",
  "order_not_found",
  /**
   * A fulfilment transition the order cannot take — already completed, not
   * approved yet, backwards, unknown, or a value the status enum does not
   * hold. The operator reads "this order cannot be moved to that status",
   * never the database's own wording.
   */
  "status_transition_refused",
  /**
   * The order was accepted and written, but reading it back for the
   * confirmation screen failed. The customer is told the order exists (with its
   * number) instead of being told it failed — a re-order is what must not
   * happen next.
   */
  "order_unreadable",
  "workflow_refused",
  "invalid_credentials",
  "identifier_taken",
  "not_signed_in",
  "upload_failed",
  "network",
  "not_configured",
  "settings_invalid",
  /**
   * PostgREST 42501 — RLS's `with check (public.can('…'))` rejected the write
   * itself, distinct from the client-side gate that hid the button. Before
   * this mapping, an admin whose session or custom role had drifted out of
   * sync with the server's own capability computation saw the bare `db`
   * text and nothing else, indistinguishable from an actual schema defect —
   * e.g. delivery-zone saves (0049's `delivery_zones_update_managers`).
   */
  "forbidden",
  "db",
] as const;
export type OnlineErrorCode = (typeof ONLINE_ERROR_CODES)[number];

export class OnlineError extends Error {
  readonly code: OnlineErrorCode;
  /** Form field to highlight, when the failure belongs to one. */
  readonly field: string | null;
  /** Machine detail for codes that need it, e.g. `{ sku, requested, available }`. */
  readonly detail: Record<string, unknown>;

  constructor(
    code: OnlineErrorCode,
    message?: string,
    options: { field?: string | null; detail?: Record<string, unknown> } = {},
  ) {
    super(message ?? code);
    this.name = "OnlineError";
    this.code = code;
    this.field = options.field ?? null;
    this.detail = options.detail ?? {};
  }
}

/**
 * What actually arrived, read off anything that can be thrown.
 *
 * Supabase hands back its `PostgrestError` as a **plain object**
 * (`{ code, details, hint, message }`) rather than an `Error` instance, so
 * `String(error)` on it is `"[object Object]"` — which hides the server's
 * wording, the SQLSTATE and PostgREST's hint, and leaves nothing to recognise.
 * Everything is therefore read field by field, and a value that is not an error
 * at all degrades to a readable phrase instead of an object tag.
 */
export interface ThrownDescription {
  message: string;
  code: string | null;
  details: string | null;
  hint: string | null;
}

/**
 * The message to actually use: trimmed, non-empty, and never the tag left
 * behind by stringifying an object (`"[object Object]"` says nothing, so it is
 * replaced by a phrase that at least tells the reader there is nothing to read).
 */
function readable(value: string | null | undefined, fallback = "Unknown error"): string {
  const text = value?.trim() ?? "";
  if (!text || text === "[object Object]") return fallback;
  return text;
}

function textOf(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  return null;
}

/** Reads `{ message, code, details, hint }` off an unknown throwable. */
export function describeThrown(error: unknown): ThrownDescription {
  if (error === null || error === undefined) {
    return { message: "Unknown error", code: null, details: null, hint: null };
  }
  if (typeof error === "string") {
    return { message: readable(error), code: null, details: null, hint: null };
  }
  if (error instanceof Error) {
    const extra = error as Error & { code?: unknown; details?: unknown; hint?: unknown };
    return {
      message: readable(textOf(error.message) ?? error.name),
      code: textOf(extra.code),
      details: textOf(extra.details),
      hint: textOf(extra.hint),
    };
  }
  if (typeof error === "object") {
    const record = error as Record<string, unknown>;
    const message =
      textOf(record.message) ??
      textOf(record.error_description) ??
      textOf(record.error) ??
      textOf(record.details) ??
      textOf(record.hint);
    return {
      message: readable(message),
      code: textOf(record.code) ?? textOf(record.status),
      details: textOf(record.details),
      hint: textOf(record.hint),
    };
  }
  return { message: String(error), code: null, details: null, hint: null };
}

/** The item a server refusal names, so the customer is told which one it was. */
function skuOf(message: string): string | null {
  const match =
    /\bof ([A-Za-z0-9._-]+) available\b/i.exec(message) ??
    /\bproduct ([A-Za-z0-9._-]+) (?:is not|cannot|not found)/i.exec(message);
  return match?.[1] ?? null;
}

/** Anything thrown, normalized — so callers only ever catch one shape. */
export function toOnlineError(error: unknown): OnlineError {
  if (error instanceof OnlineError) return error;
  const described = describeThrown(error);
  const message = described.message;

  if (/SUPABASE_NOT_CONFIGURED|NOT_CONFIGURED/i.test(message)) {
    return new OnlineError("not_configured", message);
  }
  if (/website settings|theme\.|unsafe configured URL|settings document/i.test(message)) {
    return new OnlineError("settings_invalid", message, { field: "theme" });
  }
  if (/fetch|network|Failed to fetch/i.test(message)) {
    return new OnlineError("network", message);
  }
  if (/UPLOAD_FAILED|IMAGE_TYPE_NOT_ALLOWED|IMAGE_TOO_LARGE/i.test(message)) {
    return new OnlineError("upload_failed", message);
  }
  // Live mode: Postgres raises with the wording written in migration 0018.
  if (/only \d+ of .* available/i.test(message)) {
    return new OnlineError("insufficient_stock", message, {
      field: "lines",
      detail: { sku: skuOf(message) },
    });
  }
  // Phase 43's `place_online_order` variant branch: a line arrived with no
  // combination at all ("Choose the colour and the size for %"), or the
  // combination it named does not belong to that product / is no longer sold
  // ("That colour and size does not belong to %", "% is no longer sold").
  // Both used to fall through to the bare `db` code even though
  // `variant_required` / `variant_mismatch` already existed as codes and
  // dictionary strings — nothing ever routed a live error to them.
  if (/choose the colour and the size for/i.test(message)) {
    return new OnlineError("variant_required", message, { field: "lines" });
  }
  if (
    /does not belong to/i.test(message) ||
    /is no longer sold/i.test(message)
  ) {
    return new OnlineError("variant_mismatch", message, { field: "lines" });
  }
  if (/coupon .* is not valid/i.test(message)) {
    return new OnlineError("coupon_invalid", message, { field: "coupon_code" });
  }
  if (/coupon .* is not active yet/i.test(message)) {
    return new OnlineError("coupon_not_started", message, { field: "coupon_code" });
  }
  if (/coupon .* has expired/i.test(message)) {
    return new OnlineError("coupon_expired", message, { field: "coupon_code" });
  }
  if (/coupon .* (has been fully used|has reached its usage limit)/i.test(message)) {
    return new OnlineError("coupon_limit_reached", message, { field: "coupon_code" });
  }
  if (/coupon .* (needs a subtotal|requires a subtotal)/i.test(message)) {
    return new OnlineError("coupon_min_subtotal", message, { field: "coupon_code" });
  }
  if (/coupon .* does not apply to this cart/i.test(message)) {
    return new OnlineError("coupon_not_applicable", message, { field: "coupon_code" });
  }
  if (/delivery to .* is not available/i.test(message)) {
    return new OnlineError("delivery_area_unsupported", message, { field: "address" });
  }
  // Phase 50/54: `place_online_order` (the zone branch) and the
  // `online_order_delivery_snapshot` trigger both raise this exact wording
  // when the `delivery_zone_id` the cart sent no longer names an enabled row.
  // Before this mapping it fell through to the bare `db` code and the
  // customer was told "something went wrong" for an order that just needed
  // them to pick a zone again.
  if (/delivery zone is not available/i.test(message)) {
    return new OnlineError("delivery_zone_unavailable", message, { field: "delivery_zone_id" });
  }
  if (/delivery orders need at least/i.test(message)) {
    const minimum = /delivery orders need at least ([\d.]+)/i.exec(message);
    return new OnlineError("delivery_minimum_not_met", message, {
      field: "delivery_type",
      detail: { minimum: minimum ? Number(minimum[1]) : null },
    });
  }
  if (/delivery is not available/i.test(message)) {
    return new OnlineError("delivery_unavailable", message, { field: "delivery_type" });
  }
  if (/delivery address is required/i.test(message)) {
    return new OnlineError("missing_address", message, { field: "address" });
  }
  if (/not available on the website/i.test(message)) {
    return new OnlineError("product_unavailable", message, {
      field: "lines",
      detail: { sku: skuOf(message) },
    });
  }
  if (/product .* cannot be ordered online/i.test(message)) {
    return new OnlineError("product_not_online", message, {
      field: "lines",
      detail: { sku: skuOf(message) },
    });
  }
  if (/product .* not found/i.test(message)) {
    return new OnlineError("product_not_found", message, {
      field: "lines",
      detail: { sku: skuOf(message) },
    });
  }
  if (/empty cart/i.test(message)) {
    return new OnlineError("empty_cart", message, { field: "lines" });
  }
  if (/invalid quantity/i.test(message)) {
    return new OnlineError("invalid_quantity", message, { field: "lines" });
  }
  if (/invalid delivery type/i.test(message)) {
    return new OnlineError("delivery_unavailable", message, { field: "delivery_type" });
  }
  if (/invalid payment method/i.test(message)) {
    return new OnlineError("payment_unavailable", message, { field: "payment_method" });
  }
  if (/customer (name|phone) is required/i.test(message)) {
    return new OnlineError("missing_contact", message, { field: "customer_name" });
  }
  if (/order not found/i.test(message)) {
    return new OnlineError("order_not_found", message, { field: "order_number" });
  }
  // Staff order transitions (`resolve_online_order`): the refusal names the
  // rule, not the data. Every wording below is a 23514/check_violation raise
  // from the workflow — and `invalid input value for enum` is the 22P02 the
  // old server produced by casting the action word `"complete"` straight into
  // `online_order_status`. All of them mean the same thing to the operator:
  // this order cannot be moved to that status. The server's own wording rides
  // along in `message` for the dev log only — the UI keys its copy off `code`.
  if (/invalid input value for enum/i.test(message)) {
    return new OnlineError("status_transition_refused", message);
  }
  if (
    /must be approved first/i.test(message) ||
    /can be approved/i.test(message) ||
    /already completed/i.test(message) ||
    /cannot go back to/i.test(message) ||
    /cannot be cancelled/i.test(message) ||
    /unknown action/i.test(message)
  ) {
    return new OnlineError("status_transition_refused", message);
  }
  // Live mode: `repair_stock_reservation` (migration 0025) raises with this
  // wording when a repair is asked to reverse a resolution — releasing a hold
  // the sale already converted, which would put taken units back on the shelf.
  if (/cannot be (released|converted)/i.test(message)) {
    return new OnlineError("workflow_refused", message);
  }
  // PostgREST 42501: an RLS `with check` (or plain `using`) rejected the row —
  // the server's own `public.can('…')` disagreed with whatever let the button
  // render client-side (a stale session, a custom role the server no longer
  // grants that capability to). This used to fall through to the bare `db`
  // code, indistinguishable from a genuine schema defect; an admin who hits
  // it needs "you're not allowed", not "the database refused the request".
  if (
    described.code === "42501" ||
    /row-level security policy/i.test(message) ||
    /permission denied for (table|function|relation)/i.test(message)
  ) {
    return new OnlineError("forbidden", message, {
      detail: { server_code: described.code, server_details: described.details, server_hint: described.hint },
    });
  }
  // Nothing recognisable: hand the operator the server's own wording, code,
  // details and hint (the storefront itself only ever renders the friendly
  // `store.error.db` text) — never a stringified object.
  return new OnlineError("db", message, {
    detail: {
      server_code: described.code,
      server_details: described.details,
      server_hint: described.hint,
    },
  });
}

// ── orders ──────────────────────────────────────────────────────────────────

export interface PlaceOrderResult {
  order: OnlineOrder;
  /** True when this `client_ref` had already been placed: a double submit. */
  duplicate: boolean;
}

export interface OnlineOrderFilter {
  status: OnlineOrderStatus | "all";
  paymentStatus: OnlinePaymentStatus | "all";
  /** Order number, customer name or phone. */
  search: string;
  /** ISO date bounds on `created_at`, inclusive. */
  from: string | null;
  to: string | null;
  limit: number | null;
}

export const EMPTY_ORDER_FILTER: OnlineOrderFilter = {
  status: "all",
  paymentStatus: "all",
  search: "",
  from: null,
  to: null,
  limit: null,
};

/**
 * Is the queue showing everything?
 *
 * The stock-hold review needs to know. A hold whose order is merely outside the
 * current filter is not an orphan, and a reviewer that cannot see the whole queue
 * cannot tell the difference — so the review sets those rows aside instead of
 * reporting them, and this is the predicate that decides when that applies.
 */
export function isEmptyOrderFilter(filter: Partial<OnlineOrderFilter> | null | undefined): boolean {
  if (!filter) return true;
  return (
    (filter.status ?? "all") === EMPTY_ORDER_FILTER.status &&
    (filter.paymentStatus ?? "all") === EMPTY_ORDER_FILTER.paymentStatus &&
    !(filter.search ?? "").trim() &&
    !filter.from &&
    !filter.to &&
    !filter.limit
  );
}

/** The counts the POS badge and the dashboard tiles show. */
export interface OrderCounts {
  total: number;
  pending: number;
  approved: number;
  processing: number;
  ready: number;
  completed: number;
  cancelled: number;
  /** Awaiting an employee's decision about an InstaPay proof. */
  needs_payment: number;
  /** Merchandise value of orders that are neither completed nor cancelled. */
  open_value: number;
}

export const EMPTY_ORDER_COUNTS: OrderCounts = {
  total: 0,
  pending: 0,
  approved: 0,
  processing: 0,
  ready: 0,
  completed: 0,
  cancelled: 0,
  needs_payment: 0,
  open_value: 0,
};

export interface OnlineOrdersRepository {
  readonly kind: OnlineMode;

  // Staff side
  listOrders(filter?: Partial<OnlineOrderFilter>): Promise<OnlineOrder[]>;
  getOrder(id: string): Promise<OnlineOrder>;
  /**
   * The website order that became this POS sale, if any. Returns uses it to
   * refund what the customer actually paid per unit (the snapshot), never the
   * invoice's list prices. Null for till sales and legacy rows.
   */
  getOrderBySaleId(saleId: string): Promise<OnlineOrder | null>;
  /** Every legal state change; refuses illegal ones rather than ignoring them. */
  resolveOrder(id: string, input: ResolveOrderInput): Promise<OnlineOrder>;
  /** Stock currently held by pending orders — the POS shows it per product. */
  listReservations(): Promise<StockReservation[]>;

  /**
   * Settle a hold that missed its transition (Phase 15).
   *
   * The only write path to `stock_reservations` outside the order workflow. It
   * refuses to reverse a resolution — releasing a converted hold would hand back
   * units the sale already took — repeats a resolution as a no-op, and never
   * writes `products.stock_quantity`.
   */
  repairReservation(id: string, input: ReservationRepairInput): Promise<ReservationRepairResult>;

  /** Create the hold a pending order should already have (Phase 15). */
  reserveStockForOrder(input: ReservationHoldInput): Promise<StockReservation>;
  counts(filter?: Partial<OnlineOrderFilter>): Promise<OrderCounts>;

  // Customer side
  /** Checkout. Repriced and availability-checked on the authoritative side. */
  placeOrder(input: PlaceOrderInput): Promise<PlaceOrderResult>;
  /** Guest tracking: the order number and the phone it was placed with. */
  lookupOrder(orderNumber: string, phone: string): Promise<OnlineOrder>;
  /** InstaPay proof submission. Never marks the order paid. */
  submitPaymentProof(input: PaymentProofInput): Promise<OnlineOrder>;
  /** A signed-in customer's own orders. */
  listMyOrders(storeCustomerId: string | null): Promise<OnlineOrder[]>;
}

// ── website settings, content, marketing ────────────────────────────────────

/**
 * Everything a *visitor* needs to render the shop, in one round trip.
 *
 * Coupons are deliberately absent. In live mode the codes are staff-only rows —
 * a public read would hand every visitor the shop's complete discount list — so
 * the storefront asks about the one code a customer typed, through `checkCoupon`.
 * Demo mode could include them and does not, so both modes exercise the same
 * path and a code that only works offline is never shipped.
 */
export interface WebsiteSnapshot {
  settings: WebsiteSettings;
  meta: WebsiteSettingsMeta | null;
  contents: ProductContent[];
  faqs: StoreFaq[];
  reviews: StoreReview[];
  campaigns: Campaign[];
  /** Phase 45: the shop-window face of the active categories. */
  categoryContents: StorefrontCategoryContent[];
  /** Delivery choices at checkout (enabled zones, admin order). */
  deliveryZones: DeliveryZone[];
  /** Live automatic offers (struck-through prices read these). */
  promotions: Promotion[];
  promotionTargets: PromotionTarget[];
}

/** What the marketing screen manages: codes and campaigns. Staff only. */
export interface MarketingSnapshot {
  coupons: Coupon[];
  campaigns: Campaign[];
  promotions: Promotion[];
  promotionTargets: PromotionTarget[];
}

/** A coupon check, as the checkout form needs it. */
export type CouponCheckResult =
  | { valid: true; code: string; discount: number; discountType: "percent" | "fixed" | "free_shipping"; value: number; freeShipping?: boolean }
  | { valid: false; reason: CouponCheckReason; minSubtotal?: number };

export const COUPON_CHECK_REASONS = [
  "not_found",
  "invalid",
  "not_started",
  "expired",
  "exhausted",
  "min_subtotal",
  "not_applicable",
  /** The customer exhausted their personal uses, or it is first-orders-only. */
  "limit_reached",
] as const;
export type CouponCheckReason = (typeof COUPON_CHECK_REASONS)[number];

export interface CouponCheckInput {
  code: string;
  /** Merchandise total after campaign pricing, before any discount. */
  subtotal: number;
  productIds: string[];
  categoryIds: string[];
  /** Store account id, else `phone:<digits>` — for per-customer rules. Null skips them (advisory). */
  customerKey?: string | null;
}

/** The advisory checkout breakdown: automatic promotion, code, fee, total. */
export interface PricingPreviewInput {
  lines: { product_id: string; qty: number; variant_id?: string | null }[];
  couponCode?: string | null;
  deliveryZoneId?: string | null;
  customerKey?: string | null;
  deliveryType: DeliveryType;
}

export interface PricingPreviewLine {
  product_id: string;
  variant_id: string | null;
  qty: number;
  unit_price: number;
  line_total: number;
  discounted_unit_price: number;
}

export interface PricingPreview {
  subtotal: number;
  autoDiscount: number;
  autoPromotionId: string | null;
  autoPromotionName: string | null;
  /** The typed code (normalized), whether or not it won the stacking contest. */
  promoCode: string | null;
  promoValid: boolean;
  promoReason: CouponCheckReason | null;
  promoDiscount: number;
  promoFreeShipping: boolean;
  deliveryFee: number;
  shippingDiscount: number;
  shippingSource: string;
  zoneId: string | null;
  zoneName: string | null;
  totalDiscount: number;
  total: number;
  lines: PricingPreviewLine[];
}

/** Drafts: `id` absent means create, present means update. */
export type DeliveryZoneDraft = Partial<Omit<DeliveryZone, "id" | "created_at" | "updated_at">> & {
  id?: string;
};
export type PromotionDraft = Partial<Omit<Promotion, "id" | "created_at" | "updated_at">> & {
  id?: string;
};

/** One row of the best-sellers list: an id and how many units it moved. */
export interface BestSellerRow {
  product_id: string;
  units: number;
}

/** Drafts: `id` absent means create, present means update. */
export type ProductContentDraft = Partial<Omit<ProductContent, "product_id">> & {
  product_id: string;
};
export type FaqDraft = Partial<Omit<StoreFaq, "id" | "created_at" | "updated_at">> & {
  id?: string;
};
export type ReviewDraft = Partial<Omit<StoreReview, "id" | "created_at" | "updated_at">> & {
  id?: string;
};
export type CouponDraft = Partial<Omit<Coupon, "id" | "created_at" | "updated_at" | "used_count">> & {
  id?: string;
};
export type CampaignDraft = Partial<
  Omit<Campaign, "id" | "created_at" | "updated_at">
> & { id?: string };

export interface WebsiteRepository {
  readonly kind: OnlineMode;

  /**
   * Everything the storefront needs in one round trip.
   *
   * A shop page that fetches settings, content, FAQs, reviews and campaigns
   * separately shows a half-styled page while the rest arrive; one call means
   * the first paint is the real one.
   */
  getSnapshot(): Promise<WebsiteSnapshot>;
  getSettings(): Promise<WebsiteSnapshot["settings"]>;
  saveSettings(input: SettingsSaveInput): Promise<WebsiteSettingsMeta>;

  /** Coupons + campaigns, for the marketing screen. */
  getMarketing(): Promise<MarketingSnapshot>;

  /**
   * The full advisory checkout breakdown — automatic promotion, promo code,
   * delivery fee and total — computed without writing anything. The checkout
   * shows this; placement recomputes it authoritatively, so a customer who
   * edits their cart afterwards cannot check out on the old numbers.
   */
  previewPricing(input: PricingPreviewInput): Promise<PricingPreview>;

  // ── delivery zones (Part 9): the admin owns the per-governorate pricing ──

  /** All zones, enabled-first by sort order. Public read, `manage_website` writes. */
  listDeliveryZones(): Promise<DeliveryZone[]>;
  saveDeliveryZone(draft: DeliveryZoneDraft): Promise<DeliveryZone>;
  deleteDeliveryZone(id: string): Promise<void>;

  // ── automatic promotions (Part 10): codeless discounts ──

  /** All automatic promotions. Public read, `manage_website` writes. */
  listPromotions(): Promise<Promotion[]>;
  /** The rows one offer covers. Empty for store scope. */
  listPromotionTargets(promotionId: string): Promise<PromotionTarget[]>;
  savePromotion(draft: PromotionDraft, targets: PromotionTargetDraft[]): Promise<Promotion>;
  deletePromotion(id: string): Promise<void>;

  /** Usage history for reporting (and per-customer enforcement server-side). Staff only. */
  listPromoCodeUsages(couponId?: string): Promise<PromoCodeUsage[]>;

  /**
   * Is this code usable on this cart, and what is it worth?
   *
   * Advisory by design: the amount is recomputed server-side at checkout, so a
   * customer who edits the cart afterwards cannot check out on the old number.
   */
  checkCoupon(input: CouponCheckInput): Promise<CouponCheckResult>;

  /**
   * Best-selling website products, strongest first.
   *
   * Derived from real demand (till sales excluding voids, website orders
   * excluding cancellations) rather than a flag, so the homepage cannot keep
   * advertising a product that stopped selling.
   */
  bestSellers(limit?: number): Promise<BestSellerRow[]>;

  listProductContents(): Promise<ProductContent[]>;
  saveProductContent(draft: ProductContentDraft): Promise<ProductContent>;
  deleteProductContent(productId: string): Promise<void>;

  /**
   * Phase 45: the shop-window face of categories. Reads are public (the
   * storefront renders them); every write is RLS-gated on `manage_website`
   * server-side. Only ACTIVE categories are published to the storefront, and
   * deleting a category removes its content with it (ON DELETE CASCADE).
   */
  listCategoryContents(): Promise<StorefrontCategoryContent[]>;
  saveCategoryContent(draft: StorefrontCategoryContentDraft): Promise<StorefrontCategoryContent>;
  deleteCategoryContent(categoryId: string): Promise<void>;

  listFaqs(): Promise<StoreFaq[]>;
  saveFaq(draft: FaqDraft): Promise<StoreFaq>;
  deleteFaq(id: string): Promise<void>;

  listReviews(): Promise<StoreReview[]>;
  saveReview(draft: ReviewDraft): Promise<StoreReview>;
  deleteReview(id: string): Promise<void>;

  listCoupons(): Promise<Coupon[]>;
  saveCoupon(draft: CouponDraft): Promise<Coupon>;
  deleteCoupon(id: string): Promise<void>;

  listCampaigns(): Promise<Campaign[]>;
  saveCampaign(draft: CampaignDraft): Promise<Campaign>;
  deleteCampaign(id: string): Promise<void>;
}

// ── website accounts ────────────────────────────────────────────────────────

export interface StoreCustomerPatch {
  name?: string;
  phone?: string;
  email?: string | null;
  addresses?: CustomerAddress[];
  wishlist?: string[];
  notes?: string | null;
}

/**
 * Website accounts.
 *
 * Both modes are served by the same local account store, and that is a decision
 * rather than a shortcut. The Supabase project has one auth realm, and the POS
 * trusts a session from it: signing a shopper in there would create what the app
 * reads as a staff session, in the same browser, with no profile and no role.
 * Rather than change authentication — which this project protects — website
 * accounts live in the browser profile: name, phone, saved addresses, wishlist,
 * and the list of orders that browser placed.
 *
 * Order *history* is still authoritative: a signed-in shopper's orders are
 * fetched with `lookupOrder`, which the database gates on the order number plus
 * the phone it was placed with. The local record only remembers which numbers to
 * ask about, so nothing a shopper sees can be invented client-side.
 */
export interface StoreAccountsRepository {
  readonly kind: OnlineMode;

  register(input: {
    name: string;
    phone: string;
    email?: string | null;
    password: string;
  }): Promise<StoreCustomer>;
  /** Phone or email plus password. */
  login(input: { identifier: string; password: string }): Promise<StoreCustomer>;
  logout(): Promise<void>;
  /** The signed-in customer, or null. Restored across reloads. */
  current(): Promise<StoreCustomer | null>;
  update(id: string, patch: StoreCustomerPatch): Promise<StoreCustomer>;
  /** A payment proof, resized before it leaves the device. */
  uploadProofImage(file: File): Promise<string>;
  /** Remember an order this account placed, so its history can be looked up. */
  rememberOrder(
    customerId: string | null,
    orderNumber: string,
    phone: string,
  ): Promise<void>;
}
