/**
 * Online storefront module — domain types (Phase 9).
 *
 * The customer-facing website and the POS are two faces of one shop, so these
 * types reuse the catalogue and money vocabulary that already exist instead of
 * inventing a parallel one:
 *
 *   - `Product` / `Category`   (catalogue)   what is sold
 *   - `Sale`                   (POS)         what an approved order becomes
 *   - `PaymentMethod`          (POS)         how it is paid — extended with 'cod'
 *   - `StockMovement`          (inventory)   the deduction an approval makes
 *
 * Two lifecycles, two columns. An order has a **status** (where the goods are)
 * and a **payment status** (where the money is), and they move independently:
 * a cash-on-delivery order is approved and packed while its money is still
 * uncollected, and an InstaPay order can be paid before anyone has looked at it.
 * Merging them into one field is what makes "paid but not shipped" impossible
 * to represent.
 *
 * Stock is protected by *reservation*, not by deduction: a pending order holds
 * units so two customers cannot both be promised the last one, and the hold is
 * released on cancellation or converted into a real deduction on approval.
 * Available-to-promise is therefore `stock_quantity − Σ reserved`.
 */

// ── order lifecycle ─────────────────────────────────────────────────────────

/** Where the goods are. Forward-only, except cancellation. */
export const ONLINE_ORDER_STATUSES = [
  "pending",
  "approved",
  "processing",
  "ready",
  "completed",
  "cancelled",
] as const;
export type OnlineOrderStatus = (typeof ONLINE_ORDER_STATUSES)[number];

/** Where the money is. Never set to `paid` by the customer. */
export const ONLINE_PAYMENT_STATUSES = [
  "pending",
  "paid",
  "failed",
  "verification_required",
] as const;
export type OnlinePaymentStatus = (typeof ONLINE_PAYMENT_STATUSES)[number];

/**
 * How a website order is paid. Deliberately a subset of the POS `PaymentMethod`:
 * the till takes cash and card face to face, the website takes cash on delivery
 * or an InstaPay transfer that a human verifies.
 */
export const ONLINE_PAYMENT_METHODS = ["cod", "instapay"] as const;
export type OnlinePaymentMethod = (typeof ONLINE_PAYMENT_METHODS)[number];

export const DELIVERY_TYPES = ["delivery", "pickup"] as const;
export type DeliveryType = (typeof DELIVERY_TYPES)[number];

/** What happened to an order, in the order it happened. */
export const ORDER_EVENT_KINDS = [
  "placed",
  "approved",
  "processing",
  "ready",
  "completed",
  "cancelled",
  "payment_submitted",
  "payment_approved",
  "payment_rejected",
  "note",
] as const;
export type OrderEventKind = (typeof ORDER_EVENT_KINDS)[number];

/** What an employee may do to an order. */
export const ORDER_ACTIONS = [
  "approve",
  "cancel",
  "processing",
  "ready",
  "complete",
  "payment_approve",
  "payment_reject",
] as const;
export type OrderAction = (typeof ORDER_ACTIONS)[number];

/** A pending order's hold on stock. */
export const RESERVATION_STATUSES = ["reserved", "released", "converted"] as const;
export type ReservationStatus = (typeof RESERVATION_STATUSES)[number];

// ── addresses ───────────────────────────────────────────────────────────────

export interface CustomerAddress {
  id: string;
  /** "Home", "Office" — whatever the customer calls it. */
  label: string;
  full_name: string;
  phone: string;
  city: string;
  area: string;
  street: string;
  building: string;
  floor: string;
  apartment: string;
  is_default: boolean;
  notes: string | null;
}

/** The address as the order recorded it — a snapshot, never a live join. */
export type OrderAddress = CustomerAddress;

// ── orders ──────────────────────────────────────────────────────────────────

export interface OnlineOrderItem {
  id: string;
  order_id: string;
  product_id: string;
  /** Snapshot of the product at order time, exactly like `SaleItem`. */
  name_ar: string;
  name_en: string;
  sku: string;
  barcode: string | null;
  /** Unit price after any live campaign discount, as the server computed it. */
  unit_price: number;
  quantity: number;
  line_total: number;
}

export interface OrderEvent {
  id: string;
  order_id: string;
  kind: OrderEventKind;
  note: string | null;
  /** Null for customer-side events (placed, proof submitted). */
  user_id: string | null;
  user_name: string | null;
  created_at: string;
}

export interface OnlineOrder {
  id: string;
  /** Human-readable sequential number, e.g. WEB-000001. */
  order_number: string;
  /** Client-generated idempotency key: a double tap cannot reserve stock twice. */
  client_ref: string;

  store_customer_id: string | null;
  customer_name: string;
  customer_phone: string;
  customer_email: string | null;

  delivery_type: DeliveryType;
  address: OrderAddress | null;

  /** Merchandise, before discount and before any delivery fee. */
  subtotal: number;
  discount_code: string | null;
  discount_amount: number;
  /**
   * Charged on top of the merchandise. A POS sale cannot carry it (its total is
   * constrained to `subtotal − discount`), so an approved order becomes a sale
   * for the goods and the fee stays here — online reports show both.
   */
  delivery_fee: number;
  total: number;

  payment_method: OnlinePaymentMethod;
  payment_status: OnlinePaymentStatus;
  status: OnlineOrderStatus;

  // InstaPay verification: what the customer submitted, and who judged it.
  payment_reference: string | null;
  payment_proof_url: string | null;
  payment_submitted_at: string | null;
  payment_verified_by: string | null;
  payment_verified_by_name: string | null;
  payment_verified_at: string | null;
  payment_rejected_reason: string | null;

  /** Set once approval created the POS sale — the link into the register. */
  sale_id: string | null;
  sale_number: string | null;

  notes: string | null;
  cancellation_reason: string | null;
  approved_by: string | null;
  approved_by_name: string | null;
  approved_at: string | null;
  cancelled_by: string | null;
  cancelled_by_name: string | null;
  cancelled_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;

  items: OnlineOrderItem[];
  events: OrderEvent[];
}

/** Reservation rows are internal, but the POS shows how much stock is held. */
export interface StockReservation {
  id: string;
  online_order_id: string;
  product_id: string;
  quantity: number;
  status: ReservationStatus;
  created_at: string;
  resolved_at: string | null;
}

/* ── reservation repair (Phase 15) ──────────────────────────────────────────
 * A hold is written by checkout and resolved by the order workflow: approving
 * converts it (the sale takes the units), cancelling releases it. Nothing else
 * may touch one — which is exactly why a hold that misses its transition sticks:
 * the units stay out of the pool forever and the website understates what it can
 * sell. These types are the vocabulary of the repair pass, and they are the only
 * write path to `stock_reservations` besides the workflow itself.
 *
 * The rule the whole design hangs on: **a repair never writes
 * `products.stock_quantity`.** By the time a hold is wrong, the stock effect of
 * the order's transition has already happened (the sale deducted, or the cancel
 * restored). Moving stock again would be the double-count the reservation model
 * exists to prevent, so a repair only settles the hold's own bookkeeping — and
 * says so in the audit trail and on the order's timeline.
 */

/** What a repair pass may do to a hold. */
export const RESERVATION_REPAIR_ACTIONS = ["release", "convert", "reconcile", "hold"] as const;
export type ReservationRepairAction = (typeof RESERVATION_REPAIR_ACTIONS)[number];

export interface ReservationRepairInput {
  /** `hold` creates a row, so it has its own input below. */
  action: Exclude<ReservationRepairAction, "hold">;
  /**
   * Corrected quantity, for `reconcile` only — and only when it equals what the
   * order line actually asks for. Both repositories check that rather than
   * trusting the caller, so a repair cannot invent a hold of its own size.
   */
  quantity?: number | null;
  /** Why this needed repairing. Lands on the order timeline and in the audit trail. */
  reason: string;
  user_id: string;
  user_name: string;
}

export interface ReservationHoldInput {
  online_order_id: string;
  product_id: string;
  /** Ignored unless it matches the order line — see `ReservationRepairInput.quantity`. */
  quantity?: number | null;
  reason: string;
  user_id: string;
  user_name: string;
}

export interface ReservationRepairResult {
  reservation: StockReservation;
  /**
   * True when the row was already in the requested state, so nothing was
   * written. The same idempotence `pos_settle_refund` offers: repeating a repair
   * is safe, and reversing one is refused rather than silently applied.
   */
  alreadyResolved: boolean;
  /** What the repair changed, for the audit row and the toast. */
  before: { status: ReservationStatus; quantity: number; resolved_at: string | null };
}

/** What checkout sends. Prices are never taken from it. */
export interface PlaceOrderInput {
  client_ref: string;
  customer_name: string;
  customer_phone: string;
  customer_email?: string | null;
  store_customer_id?: string | null;
  delivery_type: DeliveryType;
  address: OrderAddress | null;
  lines: { product_id: string; qty: number }[];
  coupon_code?: string | null;
  payment_method: OnlinePaymentMethod;
  notes?: string | null;
}

export interface ResolveOrderInput {
  action: OrderAction;
  reason?: string | null;
  user_id: string;
  user_name: string;
}

export interface PaymentProofInput {
  order_number: string;
  customer_phone: string;
  payment_reference: string;
  payment_proof_url?: string | null;
}

// ── website accounts ────────────────────────────────────────────────────────

export interface StoreCustomer {
  id: string;
  name: string;
  email: string | null;
  phone: string;
  addresses: CustomerAddress[];
  /** Product ids the customer favourited. */
  wishlist: string[];
  notes: string | null;
  created_at: string;
  last_login_at: string | null;
}

// ── marketing ───────────────────────────────────────────────────────────────

export type CouponTarget = "all" | "products" | "categories";

export interface Coupon {
  id: string;
  /** Always stored uppercase; matching is case-insensitive. */
  code: string;
  discount_type: "percent" | "fixed";
  value: number;
  min_subtotal: number;
  /** Percent coupons only: caps the discount. `null` = uncapped. */
  max_discount: number | null;
  usage_limit: number | null;
  /** Incremented on approval, decremented on cancellation. */
  used_count: number;
  applies_to: CouponTarget;
  target_ids: string[];
  active: boolean;
  starts_at: string | null;
  ends_at: string | null;
  created_at: string;
  updated_at: string;
}

export type CampaignKind = "flash_sale" | "promotion";

/** A flash sale or promotion: a discount on a set of products for a window. */
export interface Campaign {
  id: string;
  name_ar: string;
  name_en: string;
  kind: CampaignKind;
  discount_type: "percent" | "fixed";
  discount_value: number;
  product_ids: string[];
  /** Optional badge text, e.g. "Flash sale" / "تخفيضات". */
  badge_ar: string | null;
  badge_en: string | null;
  starts_at: string;
  ends_at: string;
  active: boolean;
  created_at: string;
  updated_at: string;
}

// ── storefront content ──────────────────────────────────────────────────────

export interface StoreFaq {
  id: string;
  question_ar: string;
  question_en: string;
  answer_ar: string;
  answer_en: string;
  sort_order: number;
  active: boolean;
  created_at: string;
  updated_at: string;
}

/** `product_id` null → a homepage testimonial; set → a review of that product. */
export interface StoreReview {
  id: string;
  product_id: string | null;
  author_name: string;
  rating: number;
  body: string;
  visible: boolean;
  sort_order: number;
  created_at: string;
}

export interface ProductSpec {
  id: string;
  label_ar: string;
  label_en: string;
  value_ar: string;
  value_en: string;
}

/**
 * Storefront-only extras for a product: brand, slug, SEO and specifications.
 * Kept out of `products` so the catalogue, its Excel import/export and its
 * policies stay exactly as they were.
 */
export interface ProductContent {
  product_id: string;
  brand_ar: string | null;
  brand_en: string | null;
  slug: string | null;
  seo_title: string | null;
  seo_description: string | null;
  specs: ProductSpec[];
  created_at: string;
  updated_at: string;
}

// ── website settings (the appearance document) ──────────────────────────────

/**
 * Font choices are stacks of locally available faces rather than web fonts: the
 * app must render identically offline and must not make a request to a third
 * party on every page view.
 */
export const STORE_FONT_STACKS = ["system", "modern", "classic", "rounded"] as const;
export type StoreFontKey = (typeof STORE_FONT_STACKS)[number];

export const BUTTON_STYLES = ["rounded", "pill", "square"] as const;
export type ButtonStyle = (typeof BUTTON_STYLES)[number];

export const HEADER_STYLES = ["solid", "compact", "overlay"] as const;
export type HeaderStyle = (typeof HEADER_STYLES)[number];

export interface HeroSlide {
  id: string;
  image_url: string | null;
  title_ar: string;
  title_en: string;
  subtitle_ar: string;
  subtitle_en: string;
  cta_label_ar: string;
  cta_label_en: string;
  cta_href: string;
  /** Where the text sits over the image. */
  align: "start" | "center" | "end";
}

export interface PromoBanner {
  id: string;
  image_url: string | null;
  title_ar: string;
  title_en: string;
  caption_ar: string;
  caption_en: string;
  href: string;
  badge_ar: string;
  badge_en: string;
}

/** Every image the admin can change without touching code. */
export interface StoreImages {
  logo_url: string | null;
  favicon_url: string | null;
  hero_slides: HeroSlide[];
  /** Page background (behind everything). */
  background_url: string | null;
  /** Per-section imagery, keyed by homepage section key. */
  section_images: Partial<Record<HomepageSectionKey, string | null>>;
  promo_banners: PromoBanner[];
  about_image_url: string | null;
}

export interface StoreTheme {
  primary_color: string;
  secondary_color: string;
  accent_color: string;
  background_color: string;
  surface_color: string;
  text_color: string;
  muted_text_color: string;
  font_stack: StoreFontKey;
  button_style: ButtonStyle;
  header_style: HeaderStyle;
  /** Rounded corner scale in pixels, applied to cards and inputs. */
  corner_radius: number;
  /** Storefront only — the POS keeps its own fixed design. */
  dark_mode: boolean;
}

/** The homepage sections an admin can hide, reorder and retitle. */
export const HOMEPAGE_SECTIONS = [
  "hero",
  "categories",
  "featured",
  "bestSellers",
  "newArrivals",
  "promoBanners",
  "brands",
  "reviews",
  "faq",
  "contact",
] as const;
export type HomepageSectionKey = (typeof HOMEPAGE_SECTIONS)[number];

export interface HomepageSectionConfig {
  key: HomepageSectionKey;
  visible: boolean;
  /** Ascending; ties keep the default order. */
  order: number;
  title_ar: string;
  title_en: string;
  /** How many products a product section shows. Ignored by other sections. */
  limit: number;
}

export interface StoreSocialLinks {
  facebook: string;
  instagram: string;
  tiktok: string;
  /** A phone number ("201001234567") or a full wa.me link. */
  whatsapp: string;
  /** The InstaPay link the customer is sent to at checkout. */
  instapay_link: string;
  /** The account name shown next to that link, e.g. "alyq@instapay". */
  instapay_account: string;
  /** The legal holder name of the InstaPay account, shown with the account. */
  instapay_holder: string;
  instapay_qr_url: string | null;
}

export interface StoreContact {
  store_name_ar: string;
  store_name_en: string;
  tagline_ar: string;
  tagline_en: string;
  phone: string;
  email: string;
  address_ar: string;
  address_en: string;
  hours_ar: string;
  hours_en: string;
  map_url: string;
}

/**
 * Delivery and pickup. `enabled` and `fee` are the exact keys the checkout RPC
 * reads server-side, so the fee can never be set by the customer's browser.
 */
export interface DeliverySettings {
  enabled: boolean;
  fee: number;
  /** Free delivery at or above this subtotal; `null` = never free. */
  free_delivery_threshold: number | null;
  note_ar: string;
  note_en: string;
  pickup_enabled: boolean;
  pickup_address_ar: string;
  pickup_address_en: string;
  /** Which payment methods the storefront offers. */
  cod_enabled: boolean;
  instapay_enabled: boolean;
  /**
   * Optional customer instructions that replace the built-in step list at
   * checkout and on the confirmation page when non-empty. Bilingual like
   * every other storefront copy.
   */
  instapay_instructions_ar: string;
  instapay_instructions_en: string;
  /**
   * Whether the storefront asks an InstaPay customer for the transfer proof
   * (the panel on the confirmation and tracking pages). Default true — the
   * behaviour the shop shipped with. Turning it off changes only what the
   * customer is asked for: the order still starts at `verification_required`
   * and still waits for an employee with `confirm_payment` to judge it.
   */
  instapay_proof_required: boolean;
}

export interface SeoSettings {
  meta_title: string;
  meta_description: string;
  keywords: string;
  og_image_url: string | null;
}

export interface AnnouncementSettings {
  enabled: boolean;
  text_ar: string;
  text_en: string;
  /** Optional link the announcement bar points at. */
  href: string;
}

export interface WebsiteSettings {
  /** Bumped if the document's shape ever changes incompatibly. */
  version: 1;
  /** Fixed: the whole app prices in Egyptian pounds. */
  currency: "EGP";
  contact: StoreContact;
  theme: StoreTheme;
  images: StoreImages;
  sections: HomepageSectionConfig[];
  social: StoreSocialLinks;
  delivery: DeliverySettings;
  seo: SeoSettings;
  announcement: AnnouncementSettings;
}

/** Who changed the settings — shown next to "last saved". */
export interface SettingsSaveInput {
  settings: WebsiteSettings;
  user_id: string;
  user_name: string;
}

export interface WebsiteSettingsMeta {
  updated_at: string;
  updated_by_name: string | null;
}

// ── numbering ───────────────────────────────────────────────────────────────

/** `WEB-000001` — the same format the database sequence produces. */
export function formatOrderNumber(n: number): string {
  return `WEB-${String(n).padStart(6, "0")}`;
}

/** A fresh idempotency key for one checkout attempt. */
export function newOrderClientRef(): string {
  const rand =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2) + Date.now().toString(36);
  return `web-${rand}`;
}
