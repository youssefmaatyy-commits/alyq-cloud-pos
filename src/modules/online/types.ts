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

import type { Category } from "@/modules/products/types";

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

/**
 * Action → the stored status it produces. THE canonical mapping — UI text is
 * NOT the DB value.
 *
 * The employee presses "Mark completed" (action `"complete"`); the row becomes
 * `"completed"`, the only label `online_order_status` accepts. Sending the
 * action word to the database raises `invalid input value for enum
 * online_order_status: "complete"` (22P02), which is exactly the live bug this
 * table closes: every layer reads the status here instead of scattering the
 * literal — the workflow, the demo repository, the Supabase read-back guard
 * and the SQL `resolve_online_order` itself. Payment actions move the money
 * axis, not the status axis, so they map to `null`.
 */
export const ORDER_ACTION_TO_STATUS: Record<OrderAction, OnlineOrderStatus | null> = {
  approve: "approved",
  cancel: "cancelled",
  processing: "processing",
  ready: "ready",
  complete: "completed",
  payment_approve: null,
  payment_reject: null,
};

/**
 * A stored status read back, or `null` for anything the enum does not hold.
 * The read-back guard in the Supabase repository uses this so a server that
 * still answers with an action word (or anything unexpected) becomes a typed
 * `status_transition_refused` instead of a row the screens cannot render.
 */
export function normalizeOrderStatus(raw: unknown): OnlineOrderStatus | null {
  return typeof raw === "string" &&
    (ONLINE_ORDER_STATUSES as readonly string[]).includes(raw)
    ? (raw as OnlineOrderStatus)
    : null;
}

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
  /**
   * Phase 43: the exact combination ordered. Null on every legacy line — those
   * keep rendering from the product snapshot alone.
   */
  variant_id: string | null;
  /** Frozen colour and size, exactly like `SaleItem` — rename-proof. */
  variant_color_ar: string | null;
  variant_color_en: string | null;
  variant_size: number | null;
  variant_size_label: string | null;
  /** Snapshot of the product at order time, exactly like `SaleItem`. */
  name_ar: string;
  name_en: string;
  sku: string;
  barcode: string | null;
  /** Unit price after any live campaign discount, as the server computed it. */
  unit_price: number;
  quantity: number;
  line_total: number;
  /**
   * What the unit actually cost after every ORDER-level discount (automatic
   * promotion, promo code), allocated proportionally across lines. Returns
   * refund this, never the list price. Null on legacy rows predating it.
   */
  discounted_unit_price: number | null;
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
   * The automatic promotion that lowered this order, when one did. A later
   * edit of the promotion never rewrites history — the snapshot below is the
   * record, this id is the link.
   */
  promotion_id: string | null;
  /**
   * What the customer actually paid and why, written once at placement:
   * promo code, promotion id/name, discount type and amounts, original and
   * final subtotals, gross and net shipping, zone, totals. Changing or
   * deleting a promotion later must not change this object.
   */
  price_snapshot: PriceSnapshot | null;
  /**
   * Charged on top of the merchandise. A POS sale cannot carry it (its total is
   * constrained to `subtotal − discount`), so an approved order becomes a sale
   * for the goods and the fee stays here — online reports show both.
   */
  delivery_fee: number;
  delivery_zone_id?: string | null;
  delivery_zone_name_en?: string | null;
  delivery_zone_name_ar?: string | null;
  delivery_free_shipping?: boolean;
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
  /**
   * Phase 43: the exact combination being held, when the product sells by
   * variant. Available-to-promise is per combination — a hold on Gold / 17
   * must not shadow Silver / 17.
   */
  variant_id: string | null;
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
  /**
   * Phase 43: the exact combination the hold covers, when the product sells by
   * variant. Omitted (null) for a product-level hold — the meaning the 8-argument
   * repair function has always had.
   */
  variant_id?: string | null;
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
  /**
   * Phase 43: a line for a product that sells by variant names the exact
   * combination. The server refuses a variant-product line that names none —
   * the storefront never picks a colour or a size for the customer.
   */
  lines: { product_id: string; qty: number; variant_id?: string | null }[];
  coupon_code?: string | null;
  /**
   * The delivery zone the customer chose (see `DeliveryZone`). Omitted for
   * pickup and for shops on the legacy settings fee — the server prices from
   * the row and never trusts a browser-sent fee.
   */
  delivery_zone_id?: string | null;
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

/** A promo code's kind. `free_shipping` waives the delivery fee instead of money. */
export type PromoDiscountType = "percent" | "fixed" | "free_shipping";

export interface Coupon {
  id: string;
  /** Always stored uppercase; matching is case-insensitive. */
  code: string;
  title_en: string;
  title_ar: string;
  description_en: string | null;
  description_ar: string | null;
  discount_type: PromoDiscountType;
  value: number;
  min_subtotal: number;
  /** Percent coupons only: caps the discount. `null` = uncapped. */
  max_discount: number | null;
  usage_limit: number | null;
  /** Incremented on placement, decremented on cancellation. */
  used_count: number;
  /** Per-customer cap, counted over non-cancelled orders. Null = unlimited. */
  per_customer_limit: number | null;
  /** Only customers with no prior non-cancelled order may use it. */
  first_order_only: boolean;
  /** May combine with the automatic promotion (which must agree). */
  stackable: boolean;
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

// ── delivery zones ─────────────────────────────────────────────────────────

/**
 * Per-governorate delivery pricing, owned by the admin. Checkout names the
 * zone id; the server prices fee, minimum and free-shipping threshold from
 * the row and never trusts a browser-sent fee. The shipped defaults
 * (Ismailia free, Cairo, Suez, other governorates) are seed rows an admin
 * edits — never constants in code.
 */
export interface DeliveryZone {
  id: string;
  /** Stable slug (`ismailia`, `cairo`, …) — identity for seeds, not display. */
  key: string;
  name_en: string;
  name_ar: string;
  governorate_key: string | null;
  shipping_fee: number;
  minimum_order_amount: number;
  /** Null = no free-shipping threshold: the fee always applies. */
  free_shipping_threshold: number | null;
  estimated_delivery_text_en: string | null;
  estimated_delivery_text_ar: string | null;
  /** Optional for legacy fixtures; missing means shown. */
  show_estimated_delivery?: boolean;
  enabled: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

// ── automatic promotions ───────────────────────────────────────────────────

export type PromotionScope = "store" | "category" | "product" | "variant";
export type PromotionChannel = "online" | "pos" | "both";

/**
 * An automatic (codeless) discount: the storewide sale, a category offer, a
 * product or variant offer. The best applicable one is chosen per order by
 * priority then size; it combines with a promo code only when both are
 * stackable, otherwise the larger discount wins alone.
 */
export interface Promotion {
  id: string;
  enabled: boolean;
  /** Explicit sales channel; old rows default to both. */
  channel?: PromotionChannel;
  name_en: string;
  name_ar: string;
  description_en: string | null;
  description_ar: string | null;
  discount_type: "percent" | "fixed";
  value: number;
  scope: PromotionScope;
  minimum_order_amount: number;
  /** Percent promotions only. Null = uncapped. */
  maximum_discount_amount: number | null;
  starts_at: string | null;
  ends_at: string | null;
  /** Higher wins when several apply; ties break toward the larger discount. */
  priority: number;
  stackable: boolean;
  created_at: string;
  updated_at: string;
}

export type PromotionTargetKind = "category" | "product" | "variant";

/** Relational targeting: which categories, products or variants an offer covers. */
export interface PromotionTarget {
  promotion_id: string;
  target_kind: PromotionTargetKind;
  target_id: string;
  created_at: string;
}

/** Draft: `promotion_id` is filled by the repository on save. */
export type PromotionTargetDraft = { target_kind: PromotionTargetKind; target_id: string };

/** One promo-code application, per order per customer — the usage history. */
export interface PromoCodeUsage {
  id: string;
  coupon_id: string;
  order_id: string;
  /** Store account id, else `phone:<digits>`. */
  customer_key: string;
  used_at: string;
}

/**
 * The order's price history, written once at placement. Changing or deleting
 * a promotion later must not change this object — returns, reports and the
 * confirmation screen all read it, never the live promotion rows.
 */
export interface PriceSnapshot {
  promo_code: string | null;
  promotion_id: string | null;
  promotion_name: string | null;
  auto_discount: number;
  promo_discount: number;
  promo_free_shipping: boolean;
  original_subtotal: number;
  final_subtotal: number;
  gross_shipping_fee: number;
  shipping_discount: number;
  shipping_source: string;
  zone_id: string | null;
  zone_name: string | null;
  total_discount: number;
  final_total: number;
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
  /**
   * Phase 45, the redesigned product page's editorial fields. Nullable like
   * everything above: an absent field renders no accordion, and a row written
   * before the phase simply has none of them.
   */
  short_description_ar?: string | null;
  short_description_en?: string | null;
  description_ar?: string | null;
  description_en?: string | null;
  materials_ar?: string | null;
  materials_en?: string | null;
  dimensions_ar?: string | null;
  dimensions_en?: string | null;
  care_ar?: string | null;
  care_en?: string | null;
  shipping_ar?: string | null;
  shipping_en?: string | null;
  returns_ar?: string | null;
  returns_en?: string | null;
  gift_note_ar?: string | null;
  gift_note_en?: string | null;
  media?: ProductContentMediaItem[];
  created_at: string;
  updated_at: string;
}

/** One content field group on the product page, ready to render or skip. */
export interface ProductContentSection {
  key: string;
  title_ar: string;
  title_en: string;
  body_ar: string;
  body_en: string;
}

/** Assemble the product page's accordions from whatever content exists. */
export function productContentSections(content: ProductContent | null): ProductContentSection[] {
  if (!content) return [];
  const section = (key: string, titleAr: string, titleEn: string, ar?: string | null, en?: string | null) => ({
    key,
    title_ar: titleAr,
    title_en: titleEn,
    body_ar: (ar ?? "").trim(),
    body_en: (en ?? "").trim(),
  });
  return [
    section("description", "الوصف", "Description", content.description_ar, content.description_en),
    section("materials", "المواد", "Materials", content.materials_ar, content.materials_en),
    section("dimensions", "المقاسات", "Dimensions", content.dimensions_ar, content.dimensions_en),
    section("care", "العناية", "Care", content.care_ar, content.care_en),
    section("shipping", "الشحن", "Shipping", content.shipping_ar, content.shipping_en),
    section("returns", "الاستبدال والإرجاع", "Exchanges & returns", content.returns_ar, content.returns_en),
    section("gift", "ملاحظة هدية", "Gift note", content.gift_note_ar, content.gift_note_en),
  ].filter((s) => s.body_ar !== "" || s.body_en !== "");
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
  /**
   * Phase 45, the redesigned hero: a second, phone-shaped image, how dark the
   * scrim over it is, where the words sit and how tall the stage is. Absent
   * fields fall back to the desktop image and the shipped presentation, so a
   * slide saved before this phase renders exactly as it did.
   */
  mobile_image_url?: string | null;
  /** 0–100: how strong the dark overlay over the imagery is. */
  overlay?: number;
  /** Which corner (or centre) the copy block sits in. */
  content_position?: "start" | "center" | "end";
  /** Preset heights; `editorial` is the tall, image-led default. */
  height?: "compact" | "classic" | "editorial";
  /**
   * Phase 49: an optional second, quieter call to action beside the primary
   * one — the fashion-house "Shop now / Our story" pair. Absent fields render
   * nothing, so every slide saved before this phase is unchanged.
   */
  secondary_cta_label_ar?: string;
  secondary_cta_label_en?: string;
  secondary_cta_href?: string;
}

export const HERO_HEIGHTS = ["compact", "classic", "editorial"] as const;
export type HeroHeight = (typeof HERO_HEIGHTS)[number];

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

/** Every homepage section an admin can hide, reorder and retitle (Phase 45 set). */
export const HOMEPAGE_SECTIONS = [
  "hero", "categories", "newArrivals", "campaigns", "bestSellers",
  "lookbook", "featured", "collection", "trustStrip", "newsletter",
  // Optional chapters remain available in the builder, not all shown at once.
  "editorial", "promoBanners", "sale", "aboutPreview", "socialGallery",
  "textImage", "brands", "reviews", "faq", "contact",
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
  /**
   * Phase 45 per-section content, optional so an old document merges cleanly.
   * Which fields mean what depends on the key — a `categories` section reads
   * `category_ids` (the exact shop window the admin chose, never inferred),
   * an `editorial`/`textImage`/`lookbook` section reads the body/CTA pair,
   * `collection`/`sale` read `product_ids`.
   */
  category_ids?: string[];
  product_ids?: string[];
  /** Presentation preset for `categories`: image tiles, a mobile carousel, or a wide editorial split. */
  layout?: "tiles" | "carousel" | "editorial";
  body_ar?: string;
  body_en?: string;
  image_url?: string | null;
  mobile_image_url?: string | null;
  cta_ar?: string;
  cta_en?: string;
  cta_href?: string;
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
/**
 * One place the shop delivers to, as the customer's `city` is matched against
 * it. Bilingual because the storefront renders in both languages.
 */
export interface DeliveryArea {
  ar: string;
  en: string;
}

export interface DeliverySettings {
  enabled: boolean;
  fee: number;
  /** Free delivery at or above this subtotal; `null` = never free. */
  free_delivery_threshold: number | null;
  /**
   * Where the shop delivers. Empty = anywhere (the behaviour before areas
   * existed, so an untouched document keeps working). Non-empty = the checkout
   * offers exactly these and `place_online_order` refuses anything else.
   */
  areas: DeliveryArea[];
  /**
   * Smallest goods total (after discount) a delivery order may have; `null` =
   * no minimum. Pickup is never gated by it — collecting in person is how a
   * customer orders less.
   */
  minimum_order: number | null;
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
  /**
   * Phase 45: the bar becomes a small stage. `static` shows one message;
   * `rotate` fades between them; `scroll` runs them as a marquee. Absent with
   * the legacy single text, the bar renders exactly as it always did.
   */
  mode?: "static" | "rotate" | "scroll";
  /** Bar background; falls back to the theme's secondary colour. */
  bg_color?: string;
  /** Bar text colour; falls back to a readable colour on the background. */
  text_color?: string;
  /** Rotation interval for `rotate`, in milliseconds (clamped 2s–15s). */
  interval_ms?: number;
  /** The messages themselves, in display order. */
  messages?: AnnouncementMessage[];
}

export interface AnnouncementMessage {
  id: string;
  enabled: boolean;
  text_ar: string;
  text_en: string;
  /** Optional destination: an in-app `#/…` route or a safe http(s) URL. */
  href?: string;
  /** Optional call-to-action word shown after the message. */
  cta_ar?: string;
  cta_en?: string;
}

// ── Phase 45: the redesigned storefront's own settings groups ───────────────

/** How a product card presents itself, from safe presets only. */
export const PRODUCT_CARD_ASPECTS = ["portrait", "square", "landscape"] as const;
export type ProductCardAspect = (typeof PRODUCT_CARD_ASPECTS)[number];
export const PRODUCT_CARD_FITS = ["cover", "contain"] as const;
export type ProductCardFit = (typeof PRODUCT_CARD_FITS)[number];
export const PRODUCT_CARD_GAPS = ["cozy", "normal", "airy"] as const;
export type ProductCardGap = (typeof PRODUCT_CARD_GAPS)[number];
export const PRODUCT_CARD_ALIGNS = ["start", "center"] as const;
export type ProductCardAlign = (typeof PRODUCT_CARD_ALIGNS)[number];

export interface ProductCardSettings {
  /** Columns on a phone. 2 is the fashion-house default. */
  mobile_columns: 1 | 2 | 3;
  /** Columns at desktop width. */
  desktop_columns: 2 | 3 | 4 | 5 | 6;
  aspect: ProductCardAspect;
  image_fit: ProductCardFit;
  gap: ProductCardGap;
  text_align: ProductCardAlign;
  show_price: boolean;
  show_badge: boolean;
  show_wishlist: boolean;
  show_quick_add: boolean;
  show_swatches: boolean;
}

/** Which storefront badges may render. A badge that is off never renders. */
export interface BadgeSettings {
  show_new: boolean;
  show_sale: boolean;
  show_best_seller: boolean;
  show_limited: boolean;
}

/** Icons are keys into the app's own safe set — never uploaded markup. */
export const TRUST_ICONS = [
  "shield",
  "truck",
  "support",
  "exchange",
  "gift",
  "star",
  "store",
  "clock",
] as const;
export type TrustIcon = (typeof TRUST_ICONS)[number];

export interface TrustItem {
  id: string;
  enabled: boolean;
  icon: TrustIcon;
  title_ar: string;
  title_en: string;
  desc_ar: string;
  desc_en: string;
  sort_order: number;
}

export interface TrustSettings {
  items: TrustItem[];
}

export interface AboutSettings {
  title_ar: string;
  title_en: string;
  body_ar: string;
  body_en: string;
  image_url: string | null;
  cta_ar: string;
  cta_en: string;
  cta_href: string;
}

export interface FooterPolicyLink {
  id: string;
  enabled: boolean;
  label_ar: string;
  label_en: string;
  href: string;
}

export interface FooterSettings {
  description_ar: string;
  description_en: string;
  newsletter_enabled: boolean;
  newsletter_note_ar: string;
  newsletter_note_en: string;
  show_social: boolean;
  copyright_ar: string;
  copyright_en: string;
  policy_links: FooterPolicyLink[];
}

/** Checkout copy. Words only — the rules stay server-side and out of reach. */
export interface CheckoutCopySettings {
  heading_ar: string;
  heading_en: string;
  delivery_note_ar: string;
  delivery_note_en: string;
  pickup_note_ar: string;
  pickup_note_en: string;
  payment_note_ar: string;
  payment_note_en: string;
  cod_note_ar: string;
  cod_note_en: string;
  instapay_note_ar: string;
  instapay_note_en: string;
  proof_note_ar: string;
  proof_note_en: string;
  place_order_ar: string;
  place_order_en: string;
}

export interface ConfirmationCopySettings {
  title_ar: string;
  title_en: string;
  message_ar: string;
  message_en: string;
  guidance_ar: string;
  guidance_en: string;
  support_cta_ar: string;
  support_cta_en: string;
  /** Where the support CTA points: a route or a safe external URL. */
  support_href: string;
  /** Show a "continue on WhatsApp" button when a number is configured. */
  whatsapp_cta: boolean;
}

/**
 * Phase 46: the shared brand identity, stored once in the same settings
 * document the storefront already reads.
 *
 * There is deliberately ONE brand source. The primary logo is the storefront's
 * existing `images.logo_url` (the store header, login, receipts and the admin
 * shell all read it); this group carries only what the primary logo cannot
 * express. Nothing here is ever injected as raw SVG/HTML — every URL is a
 * media URL validated like the rest of the images group.
 */
export interface BrandSettings {
  /** Display name override in Arabic. Empty → the ALYQ wordmark default. */
  display_name_ar: string;
  /** Display name override in English. Empty → the ALYQ wordmark default. */
  display_name_en: string;
  /** Compact mark for the collapsed sidebar and tight spots. */
  mark_url: string | null;
  /** Logo tuned for dark surfaces (the admin sidebar). Null → light logo. */
  logo_dark_url: string | null;
  /** Print the brand logo on POS and return receipts. */
  receipt_logo_enabled: boolean;
}

/**
 * An editorial campaign block: an image, words, a CTA and a window. Pure
 * presentation — it sells nothing by itself, so its schedule is a rendering
 * rule (who sees it when), not a pricing rule; every price stays
 * server-derived exactly as before.
 */
export interface EditorialCampaign {
  /** Curated layouts only; absent values retain the legacy split composition. */
  layout?: "full" | "split" | "alternating";
  id: string;
  enabled: boolean;
  title_ar: string;
  title_en: string;
  subtitle_ar: string;
  subtitle_en: string;
  desktop_image_url: string | null;
  mobile_image_url: string | null;
  cta_ar: string;
  cta_en: string;
  cta_href: string;
  /** ISO instants; `null` = open-ended on that side. */
  starts_at: string | null;
  ends_at: string | null;
  /** `homepage` renders in the campaigns section; `banner` also under the header. */
  placement: "homepage" | "banner";
  sort_order: number;
}

export const SOCIAL_PLATFORMS = ["instagram", "facebook", "tiktok", "whatsapp"] as const;
export type SocialPlatform = (typeof SOCIAL_PLATFORMS)[number];

export interface SocialLinkConfig {
  platform: SocialPlatform;
  enabled: boolean;
  /** Profile URL, or an international phone number for WhatsApp. */
  url: string;
  label_ar: string;
  label_en: string;
  /** Optional shared contact-link copy, used only for WhatsApp (not order updates). */
  message_ar?: string;
  message_en?: string;
}

export interface HeaderSettings {
  sticky: boolean;
  search_enabled: boolean;
  account_enabled: boolean;
  /** The cart can be hidden only cosmetically; checkout stays reachable. */
  cart_enabled: boolean;
}

export interface ProductContentMediaItem {
  url: string;
  alt_ar: string;
  alt_en: string;
  kind: "product" | "lifestyle";
  sort_order: number;
}

/**
 * Storefront-only category extras (`storefront_category_content`, 0045) — the
 * shop-window face of a category. Nothing here can archive, restore or move a
 * category; Phase 44's lifecycle stays the only writer of `categories.active`.
 */
export interface StorefrontCategoryContent {
  id: string;
  category_id: string;
  title_ar: string | null;
  title_en: string | null;
  description_ar: string | null;
  description_en: string | null;
  image_url: string | null;
  mobile_image_url: string | null;
  homepage_image_url: string | null;
  featured: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export type StorefrontCategoryContentDraft = Omit<
  StorefrontCategoryContent,
  "id" | "created_at" | "updated_at"
> & { id?: string };

/**
 * A category as the storefront sees it: the live row plus whatever content the
 * admin wrote. `category` is always ACTIVE — an archived category produces no
 * view of itself anywhere on the shop window.
 */
export interface StorefrontCategory {
  category: Category;
  content: StorefrontCategoryContent | null;
}

/**
 * Staff WhatsApp order-update copy (Phase 55). Stored in the existing settings
 * document — not a second settings system, and not a delivery log.
 *
 * Keys are the real order statuses (plus pickup vs delivery, which the status
 * machine already distinguishes). There is no invented status.
 */
export const WHATSAPP_TEMPLATE_KEYS = [
  "approved",
  "processing",
  "ready_delivery",
  "ready_pickup",
  "completed_delivery",
  "completed_pickup",
] as const;
export type WhatsAppTemplateKey = (typeof WHATSAPP_TEMPLATE_KEYS)[number];

/** Placeholders a customer message may contain. Each one is backed by order data. */
export const WHATSAPP_PLACEHOLDERS = [
  "customer_name",
  "order_number",
  "order_total",
  "delivery_governorate",
  "tracking_link",
  "payment_method",
  "delivery_method",
] as const;
export type WhatsAppPlaceholder = (typeof WHATSAPP_PLACEHOLDERS)[number];

export interface WhatsAppMessageTemplate {
  ar: string;
  en: string;
}

export interface WhatsAppUpdatesSettings {
  templates: Record<WhatsAppTemplateKey, WhatsAppMessageTemplate>;
}

export const V2_BODY_FONTS = ["inherit", "system", "modern", "classic"] as const;
export type V2BodyFont = (typeof V2_BODY_FONTS)[number];
export const V2_DISPLAY_FONTS = ["inherit", "editorial", "modern", "classic"] as const;
export type V2DisplayFont = (typeof V2_DISPLAY_FONTS)[number];
export const V2_BADGE_STYLES = ["inherit", "pill", "square"] as const;
export const V2_BUTTON_STYLES = ["inherit", "rounded", "pill", "square"] as const;

/** Nullable values inherit shared website settings (or the V2 default). This
 * group only changes V2's presentation; it is not a second content CMS. */
export interface StorefrontV2Settings {
  mobile_logo_url: string | null;
  logo_height: number | null;
  mobile_logo_height: number | null;
  header_bg: string | null;
  header_text: string | null;
  page_bg: string | null;
  surface_bg: string | null;
  text_color: string | null;
  muted_text: string | null;
  accent_color: string | null;
  border_color: string | null;
  button_bg: string | null;
  button_text: string | null;
  button_style: (typeof V2_BUTTON_STYLES)[number];
  badge_bg: string | null;
  badge_text: string | null;
  badge_style: (typeof V2_BADGE_STYLES)[number];
  hero_bg: string | null;
  hero_text: string | null;
  announcement_bg: string | null;
  announcement_text: string | null;
  footer_bg: string | null;
  footer_text: string | null;
  footer_link: string | null;
  body_font: V2BodyFont;
  display_font: V2DisplayFont;
  /** Null inherits shared mobile_columns, clamped to the V2 1–2 range. */
  mobile_columns: 1 | 2 | null;
  sticky_header: boolean | null;
  show_search: boolean | null;
  show_account: boolean | null;
  show_cart: boolean | null;
  show_language: boolean;
}

export interface WebsiteSettings {
  /** Opt-in V2 appearance overrides; legacy #/store never reads this group. */
  storefront_v2: StorefrontV2Settings;
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
  /** Phase 45: the redesigned storefront's groups. Every field deep-merges. */
  header: HeaderSettings;
  product_card: ProductCardSettings;
  badges: BadgeSettings;
  trust: TrustSettings;
  about: AboutSettings;
  footer: FooterSettings;
  checkout_copy: CheckoutCopySettings;
  confirmation: ConfirmationCopySettings;
  campaigns: EditorialCampaign[];
  social_links: SocialLinkConfig[];
  /** Phase 46: shared brand identity (see {@link BrandSettings}). */
  brand: BrandSettings;
  /**
   * Phase 55: editable Arabic and English WhatsApp order-update templates.
   * Deep-link copy only — opening a link is not delivery.
   */
  whatsapp_updates: WhatsAppUpdatesSettings;
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
