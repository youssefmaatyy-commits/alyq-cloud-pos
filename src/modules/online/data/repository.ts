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
  OnlineOrder,
  OnlineOrderStatus,
  OnlinePaymentStatus,
  PaymentProofInput,
  PlaceOrderInput,
  ProductContent,
  ResolveOrderInput,
  SettingsSaveInput,
  StoreCustomer,
  StoreFaq,
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
  "product_unavailable",
  "product_not_found",
  "product_not_online",
  "missing_contact",
  "missing_address",
  "delivery_unavailable",
  "pickup_unavailable",
  "payment_unavailable",
  "coupon_invalid",
  "coupon_expired",
  "coupon_not_started",
  "coupon_limit_reached",
  "coupon_min_subtotal",
  "coupon_not_applicable",
  "order_not_found",
  "workflow_refused",
  "invalid_credentials",
  "identifier_taken",
  "not_signed_in",
  "upload_failed",
  "network",
  "not_configured",
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

/** Anything thrown, normalized — so callers only ever catch one shape. */
export function toOnlineError(error: unknown): OnlineError {
  if (error instanceof OnlineError) return error;
  const message = error instanceof Error ? error.message : String(error);

  if (/SUPABASE_NOT_CONFIGURED|NOT_CONFIGURED/i.test(message)) {
    return new OnlineError("not_configured", message);
  }
  if (/fetch|network|Failed to fetch/i.test(message)) {
    return new OnlineError("network", message);
  }
  if (/UPLOAD_FAILED|IMAGE_TYPE_NOT_ALLOWED|IMAGE_TOO_LARGE/i.test(message)) {
    return new OnlineError("upload_failed", message);
  }
  // Live mode: Postgres raises with the wording written in migration 0018.
  if (/only \d+ of .* available/i.test(message)) {
    return new OnlineError("insufficient_stock", message, { field: "lines" });
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
  if (/delivery is not available/i.test(message)) {
    return new OnlineError("delivery_unavailable", message, { field: "delivery_type" });
  }
  if (/delivery address is required/i.test(message)) {
    return new OnlineError("missing_address", message, { field: "address" });
  }
  if (/not available on the website/i.test(message)) {
    return new OnlineError("product_unavailable", message, { field: "lines" });
  }
  if (/product .* cannot be ordered online/i.test(message)) {
    return new OnlineError("product_not_online", message, { field: "lines" });
  }
  if (/product .* not found/i.test(message)) {
    return new OnlineError("product_not_found", message, { field: "lines" });
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
  // Live mode: `repair_stock_reservation` (migration 0025) raises with this
  // wording when a repair is asked to reverse a resolution — releasing a hold
  // the sale already converted, which would put taken units back on the shelf.
  if (/cannot be (released|converted)/i.test(message)) {
    return new OnlineError("workflow_refused", message);
  }
  return new OnlineError("db", message);
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
}

/** What the marketing screen manages: codes and campaigns. Staff only. */
export interface MarketingSnapshot {
  coupons: Coupon[];
  campaigns: Campaign[];
}

/** A coupon check, as the checkout form needs it. */
export type CouponCheckResult =
  | { valid: true; code: string; discount: number; discountType: "percent" | "fixed"; value: number }
  | { valid: false; reason: CouponCheckReason; minSubtotal?: number };

export const COUPON_CHECK_REASONS = [
  "not_found",
  "invalid",
  "not_started",
  "expired",
  "exhausted",
  "min_subtotal",
  "not_applicable",
] as const;
export type CouponCheckReason = (typeof COUPON_CHECK_REASONS)[number];

export interface CouponCheckInput {
  code: string;
  /** Merchandise total after campaign pricing, before any discount. */
  subtotal: number;
  productIds: string[];
  categoryIds: string[];
}

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
