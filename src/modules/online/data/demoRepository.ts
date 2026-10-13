/**
 * Demo (localStorage) implementation of the online storefront repositories.
 *
 * Demo mode is not a mock: it is the same contract as live mode, with the same
 * rules enforced in the same order, so a shop can be run end to end — browse,
 * checkout, approve in the POS, stock deducted, payment verified — with no
 * backend at all. That means the checkout here re-prices from the catalogue,
 * checks availability against outstanding reservations, validates coupons and
 * refuses illegal state changes, exactly as `place_online_order` and
 * `resolve_online_order` do in Postgres.
 *
 * Two differences are inherent to a browser and are documented rather than
 * hidden:
 *
 *   - **Authority.** Live mode checks `manage_online_orders` / `confirm_payment`
 *     inside the database function, where no client can argue. Here the check
 *     lives in the UI (routes + capabilities), because localStorage has no
 *     notion of a role. Anything that must be unforgeable is a live-mode
 *     guarantee.
 *   - **Passwords.** `auth.users` does not exist offline, so a website account's
 *     secret is a salted digest kept beside the account in localStorage. It is
 *     enough to make the sign-in flow behave correctly and is explicitly not a
 *     way to store a password.
 *
 * Stock movements, sale numbering and the audit trail all come from the existing
 * demo repositories, so an online order leaves the same fingerprints as a till
 * sale.
 */
import type { Product } from "@/modules/products/types";
import { getDemoRepository } from "@/modules/products/data/demoRepository";
import { recordAudit } from "@/modules/audit/services/auditService";
import { safeStorage } from "@/modules/products/data/demoSeed";
import { getDemoSalesRepository } from "@/modules/pos/data/demoRepository";
import type {
  Campaign,
  Coupon,
  CustomerAddress,
  DeliveryZone,
  OnlineOrder,
  OnlineOrderItem,
  OrderEvent,
  OrderEventKind,
  PaymentProofInput,
  PlaceOrderInput,
  PriceSnapshot,
  ProductContent,
  PromoCodeUsage,
  Promotion,
  PromotionTarget,
  PromotionTargetDraft,
  ResolveOrderInput,
  SettingsSaveInput,
  StockReservation,
  ReservationHoldInput,
  ReservationRepairInput,
  ReservationRepairResult,
  StoreCustomer,
  StoreFaq,
  StoreReview,
  StorefrontCategoryContent,
  StorefrontCategoryContentDraft,
  WebsiteSettings,
  WebsiteSettingsMeta,
} from "../types";
import { ORDER_ACTION_TO_STATUS, formatOrderNumber } from "../types";
import {
  DEFAULT_WEBSITE_SETTINGS,
  mergeSettings,
  resolveSettings,
} from "../services/settingsDefaults";
import {
  customerKeyFor,
  deliveryAreaSupported,
  evaluateCartPricing,
  normalizeCouponCode,
  priceCart,
  round2,
} from "../services/pricing";
import {
  availableToPromise,
  holdsReservation,
  reservedByProduct,
  reservedByVariant,
  variantAvailableToPromise,
} from "../services/availability";
import { variantLabelOf } from "../services/variantLabel";
import type { ProductVariant } from "@/modules/products/variants";
import { unitsSold } from "../services/badges";
import { checkAction, initialPaymentStatus, requiresReason } from "../services/orderWorkflow";
import { sanitizeSettings } from "../services/settingsDefaults";
import { slugifyAscii } from "../services/seo";
import { getLocalStoreAccounts, normalizePhone } from "./localAccounts";
import {
  EMPTY_ORDER_COUNTS,
  OnlineError,
  toOnlineError,
  type BestSellerRow,
  type CampaignDraft,
  type CouponCheckInput,
  type CouponCheckReason,
  type CouponCheckResult,
  type CouponDraft,
  type DeliveryZoneDraft,
  type FaqDraft,
  type MarketingSnapshot,
  type OnlineOrderFilter,
  type OrderCounts,
  type PlaceOrderResult,
  type PricingPreview,
  type PricingPreviewInput,
  type ProductContentDraft,
  type PromotionDraft,
  type ReviewDraft,
  type StoreCustomerPatch,
  type WebsiteSnapshot,
  type OnlineOrdersRepository,
  type PendingOrderAlert,
  type StoreAccountsRepository,
  type WebsiteRepository,
} from "./repository";

const KEYS = {
  orders: "alyq.demo.online_orders.v1",
  counter: "alyq.demo.online_order_counter.v1",
  reservations: "alyq.demo.stock_reservations.v1",
  settings: "alyq.demo.website_settings.v1",
  contents: "alyq.demo.product_contents.v1",
  categoryContents: "alyq.demo.storefront_category_contents.v1",
  faqs: "alyq.demo.store_faqs.v1",
  reviews: "alyq.demo.store_reviews.v1",
  coupons: "alyq.demo.coupons.v1",
  campaigns: "alyq.demo.campaigns.v1",
  deliveryZones: "alyq.demo.delivery_zones.v1",
  promotions: "alyq.demo.promotions.v1",
  promotionTargets: "alyq.demo.promotion_targets.v1",
  promoUsages: "alyq.demo.promo_code_usages.v1",
  seeded: "alyq.demo.online_seeded.v1",
} as const;

const LATENCY = 90;

function delay<T>(value: T, ms = LATENCY): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(resolveValue(value)), ms));
}

// Structured cloning keeps callers from mutating the authoritative state through
// a returned reference — the mistake that makes a demo "work" until it doesn't.
function resolveValue<T>(value: T): T {
  return typeof structuredClone === "function"
    ? structuredClone(value)
    : (JSON.parse(JSON.stringify(value)) as T);
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Rows written before the promotion fields existed gain their defaults, so an
 * installation seeded by an older release behaves like a fresh one. New rows
 * always carry every field (see `saveCoupon`).
 */
function normalizeCoupon(stored: Coupon): Coupon {
  return {
    ...stored,
    title_en: stored.title_en ?? "",
    title_ar: stored.title_ar ?? "",
    description_en: stored.description_en ?? null,
    description_ar: stored.description_ar ?? null,
    per_customer_limit: stored.per_customer_limit ?? null,
    first_order_only: stored.first_order_only ?? false,
    stackable: stored.stackable ?? false,
  };
}

/** Units an order's lines ask for of one product, or `null` when it is not in the order. */
function orderedQuantity(
  order: OnlineOrder,
  productId: string,
  variantId: string | null = null,
): number | null {
  let total = 0;
  let found = false;
  for (const item of order.items) {
    if (item.product_id !== productId) continue;
    // Phase 43: a hold names a shelf — product AND combination. A hold for
    // Gold / 17 reconciles against the Gold / 17 lines only, and a legacy
    // product-level hold against the lines that name no combination.
    if ((item.variant_id ?? null) !== (variantId ?? null)) continue;
    found = true;
    total += Math.max(0, Math.trunc(item.quantity));
  }
  return found ? total : null;
}

function newId(prefix: string): string {
  const random =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return `${prefix}-${Date.now().toString(36)}-${random}`;
}

function readArray<T>(key: string): T[] {
  const raw = safeStorage.get(key);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function readObject<T>(key: string): T | null {
  const raw = safeStorage.get(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function write(key: string, value: unknown): void {
  safeStorage.set(key, JSON.stringify(value));
}

// ── demo seeding ────────────────────────────────────────────────────────────

/**
 * First-run content, so the storefront is a shop rather than an empty frame.
 *
 * Everything here is ordinary editable data — an admin can rename, hide or
 * delete it — and it is written once, guarded by its own flag, so it never
 * overwrites something the shop has changed.
 */
function seedContent(products: readonly Product[]) {
  const visible = products.filter((product) => product.active && product.show_on_website);
  const brands = [
    { ar: "محمصة العقبة", en: "ALYQ Roastery" },
    { ar: "مطاحن النيل", en: "Nile Mills" },
    { ar: "صناعة القاهرة", en: "Cairo Craft" },
  ];

  if (safeStorage.get(KEYS.contents) === null) {
    const contents: ProductContent[] = visible.map((product, index) => {
      const brand = brands[index % brands.length];
      const name = product.name_en || product.name_ar;
      return {
        product_id: product.id,
        brand_ar: brand.ar,
        brand_en: brand.en,
        slug: slugifyAscii(name, product.sku) || null,
        seo_title: `${name} | ALYQ`,
        seo_description:
          product.description_en?.trim() ||
          product.description_ar?.trim() ||
          `${name} — available for delivery across Egypt, or collect from the store.`,
        specs: [
          {
            id: newId("spec"),
            label_ar: "الوحدة",
            label_en: "Unit",
            value_ar: " piece",
            value_en: "piece",
          },
        ],
        created_at: nowIso(),
        updated_at: nowIso(),
      };
    });
    write(KEYS.contents, contents);
  }

  // Phase 49 visual pass: the shop window opens dressed — each category carries
  // its bundled editorial tile and a curation order, exactly as an admin would
  // set them in Website Content (every field here stays admin-editable; a
  // cleared image simply falls back to the section's own treatment).
  if (safeStorage.get(KEYS.categoryContents) === null) {
    const now = nowIso();
    const tiles: Array<[string, string, boolean, number]> = [
      // [category_id, bundled tile, featured in the shop window, order]
      ["cat-beverages", "/brand/categories/jewellery.jpg", true, 1],
      ["cat-coffee", "/brand/categories/earrings.jpg", true, 2],
      ["cat-juices", "/brand/categories/necklaces.jpg", true, 3],
      ["cat-rings", "/brand/categories/rings.jpg", true, 4],
      ["cat-grocery", "/brand/categories/fashion-accessories.jpg", true, 5],
      ["cat-dairy", "/brand/categories/bracelets.jpg", true, 6],
    ];
    const categoryContents: StorefrontCategoryContent[] = tiles.map(
      ([category_id, tile, featured, sort_order], index) => ({
        id: `ccontent-${index + 1}`,
        category_id,
        title_ar: null,
        title_en: null,
        description_ar: null,
        description_en: null,
        image_url: null,
        mobile_image_url: null,
        homepage_image_url: tile,
        featured,
        sort_order,
        created_at: now,
        updated_at: now,
      }),
    );
    write(KEYS.categoryContents, categoryContents);
  }

  if (safeStorage.get(KEYS.coupons) === null) {
    const coupons: Coupon[] = [
      {
        id: newId("cpn"),
        code: "WELCOME10",
        title_en: "Welcome discount",
        title_ar: "خصم الترحيب",
        description_en: null,
        description_ar: null,
        discount_type: "percent",
        value: 10,
        min_subtotal: 200,
        max_discount: 150,
        usage_limit: 100,
        used_count: 0,
        per_customer_limit: null,
        first_order_only: false,
        stackable: false,
        applies_to: "all",
        target_ids: [],
        active: true,
        starts_at: null,
        ends_at: null,
        created_at: nowIso(),
        updated_at: nowIso(),
      },
    ];
    write(KEYS.coupons, coupons);
  }

  // The house delivery pricing, mirroring the 0049 seed rows: the demo shop
  // and a fresh live project open with the same four choices, and the admin
  // edits them the same way in both modes.
  if (safeStorage.get(KEYS.deliveryZones) === null) {
    const at = nowIso();
    const zones: DeliveryZone[] = [
      {
        id: newId("dz"), key: "ismailia", name_en: "Ismailia", name_ar: "الإسماعيلية",
        governorate_key: "ismailia", shipping_fee: 0, minimum_order_amount: 0,
        free_shipping_threshold: null, estimated_delivery_text_en: "Same-day delivery",
        estimated_delivery_text_ar: "توصيل في نفس اليوم", show_estimated_delivery: true, enabled: true, sort_order: 10,
        created_at: at, updated_at: at,
      },
      {
        id: newId("dz"), key: "cairo", name_en: "Cairo", name_ar: "القاهرة",
        governorate_key: "cairo", shipping_fee: 70, minimum_order_amount: 0,
        free_shipping_threshold: null, estimated_delivery_text_en: "1–2 business days",
        estimated_delivery_text_ar: "١–٢ يوم عمل", show_estimated_delivery: true, enabled: true, sort_order: 20,
        created_at: at, updated_at: at,
      },
      {
        id: newId("dz"), key: "suez", name_en: "Suez", name_ar: "السويس",
        governorate_key: "suez", shipping_fee: 50, minimum_order_amount: 0,
        free_shipping_threshold: null, estimated_delivery_text_en: "1–2 business days",
        estimated_delivery_text_ar: "١–٢ يوم عمل", show_estimated_delivery: true, enabled: true, sort_order: 30,
        created_at: at, updated_at: at,
      },
      {
        id: newId("dz"), key: "other", name_en: "Other governorates", name_ar: "باقي المحافظات",
        governorate_key: null, shipping_fee: 80, minimum_order_amount: 0,
        free_shipping_threshold: null, estimated_delivery_text_en: "2–4 business days",
        estimated_delivery_text_ar: "٢–٤ يوم عمل", show_estimated_delivery: true, enabled: true, sort_order: 100,
        created_at: at, updated_at: at,
      },
    ];
    write(KEYS.deliveryZones, zones);
  }

  if (safeStorage.get(KEYS.promotions) === null) {
    write(KEYS.promotions, []);
  }
  if (safeStorage.get(KEYS.promotionTargets) === null) {
    write(KEYS.promotionTargets, []);
  }
  if (safeStorage.get(KEYS.promoUsages) === null) {
    write(KEYS.promoUsages, []);
  }

  if (safeStorage.get(KEYS.campaigns) === null && visible.length > 0) {
    const startsAt = new Date(Date.now() - 86_400_000).toISOString();
    const endsAt = new Date(Date.now() + 13 * 86_400_000).toISOString();
    const campaigns: Campaign[] = [
      {
        id: newId("cmp"),
        name_ar: "تخفيضات الأسبوع",
        name_en: "Weekly flash sale",
        kind: "flash_sale",
        discount_type: "percent",
        discount_value: 15,
        // The first two products only: a flash sale over everything is just a
        // price change, and the demo should show what targeting looks like.
        product_ids: visible.slice(0, 2).map((product) => product.id),
        badge_ar: "خصم ١٥٪",
        badge_en: "15% off",
        starts_at: startsAt,
        ends_at: endsAt,
        active: true,
        created_at: nowIso(),
        updated_at: nowIso(),
      },
    ];
    write(KEYS.campaigns, campaigns);
  }

  if (safeStorage.get(KEYS.faqs) === null) {
    const faqs: StoreFaq[] = [
      {
        id: newId("faq"),
        question_ar: "كم تستغرق التوصيلة؟",
        question_en: "How long does delivery take?",
        answer_ar: "عادة من ٢٤ إلى ٤٨ ساعة داخل المدن الرئيسية.",
        answer_en: "Usually 24–48 hours inside the main cities.",
        sort_order: 1,
        active: true,
        created_at: nowIso(),
        updated_at: nowIso(),
      },
      {
        id: newId("faq"),
        question_ar: "هل يمكن الدفع عند الاستلام؟",
        question_en: "Can I pay on delivery?",
        answer_ar: "نعم، الدفع عند الاستلام متاح للطلبات داخل نطاق التوصيل.",
        answer_en: "Yes, cash on delivery is available inside the delivery area.",
        sort_order: 2,
        active: true,
        created_at: nowIso(),
        updated_at: nowIso(),
      },
      {
        id: newId("faq"),
        question_ar: "كيف أتتبع طلبي؟",
        question_en: "How do I track my order?",
        answer_ar: "ادخل رقم الطلب ورقم الهاتف في صفحة تتبع الطلب.",
        answer_en: "Enter your order number and phone number on the track-order page.",
        sort_order: 3,
        active: true,
        created_at: nowIso(),
        updated_at: nowIso(),
      },
    ];
    write(KEYS.faqs, faqs);
  }

  if (safeStorage.get(KEYS.reviews) === null) {
    const reviews: StoreReview[] = [
      {
        id: newId("rev"),
        product_id: null,
        author_name: "Mona A.",
        rating: 5,
        body: "Ordering was easy and the earrings arrived beautifully packed.",
        visible: true,
        sort_order: 1,
        created_at: nowIso(),
      },
      {
        id: newId("rev"),
        product_id: null,
        author_name: "Ahmed S.",
        rating: 4,
        body: "Good prices, and the pickup option saved the delivery fee.",
        visible: true,
        sort_order: 2,
        created_at: nowIso(),
      },
    ];
    write(KEYS.reviews, reviews);
  }

  if (safeStorage.get(KEYS.settings) === null) {
    write(KEYS.settings, { settings: DEFAULT_WEBSITE_SETTINGS, meta: null });
  }
}

/** One write at a time per tab, mirroring the POS demo repository's guard. */
let inFlight = false;

export class DemoOnlineRepository
  implements OnlineOrdersRepository, WebsiteRepository, StoreAccountsRepository
{
  readonly kind = "demo" as const;

  private orders: OnlineOrder[] = readArray<OnlineOrder>(KEYS.orders);
  private counter = Math.max(
    Number(safeStorage.get(KEYS.counter)) || 0,
    this.orders.length,
  );
  private reservations: StockReservation[] = readArray<StockReservation>(KEYS.reservations);
  private settingsDoc: { settings: unknown; meta: WebsiteSettingsMeta | null } =
    readObject<{ settings: unknown; meta: WebsiteSettingsMeta | null }>(KEYS.settings) ?? {
      settings: null,
      meta: null,
    };

  private contents: ProductContent[] = readArray<ProductContent>(KEYS.contents);
  private categoryContents: StorefrontCategoryContent[] = readArray<StorefrontCategoryContent>(
    KEYS.categoryContents,
  );
  private faqs: StoreFaq[] = readArray<StoreFaq>(KEYS.faqs);
  private reviews: StoreReview[] = readArray<StoreReview>(KEYS.reviews);
  private coupons: Coupon[] = readArray<Coupon>(KEYS.coupons).map(normalizeCoupon);
  private campaigns: Campaign[] = readArray<Campaign>(KEYS.campaigns);
  private deliveryZones: DeliveryZone[] = readArray<DeliveryZone>(KEYS.deliveryZones);
  private promotions: Promotion[] = readArray<Promotion>(KEYS.promotions);
  private promotionTargets: PromotionTarget[] = readArray<PromotionTarget>(KEYS.promotionTargets);
  private promoUsages: PromoCodeUsage[] = readArray<PromoCodeUsage>(KEYS.promoUsages);
  private seeded = false;

  /** Seed once per session, after the catalogue demo repo has its own data. */
  private async ensureSeeded(): Promise<Product[]> {
    const products = await getDemoRepository().listProducts();
    if (!this.seeded && safeStorage.get(KEYS.seeded) !== "1") {
      seedContent(products);
      safeStorage.set(KEYS.seeded, "1");
      // Re-read what the seed wrote.
      this.contents = readArray<ProductContent>(KEYS.contents);
      this.categoryContents = readArray<StorefrontCategoryContent>(KEYS.categoryContents);
      this.faqs = readArray<StoreFaq>(KEYS.faqs);
      this.reviews = readArray<StoreReview>(KEYS.reviews);
      this.coupons = readArray<Coupon>(KEYS.coupons).map(normalizeCoupon);
      this.campaigns = readArray<Campaign>(KEYS.campaigns);
      this.deliveryZones = readArray<DeliveryZone>(KEYS.deliveryZones);
      this.promotions = readArray<Promotion>(KEYS.promotions);
      this.promotionTargets = readArray<PromotionTarget>(KEYS.promotionTargets);
      this.promoUsages = readArray<PromoCodeUsage>(KEYS.promoUsages);
      this.settingsDoc = readObject(KEYS.settings) ?? this.settingsDoc;
      this.seeded = true;
    } else {
      this.seeded = true;
    }
    return products;
  }

  /**
   * Marketing is editable in another tab. Unlike catalogue state, coupon
   * eligibility is checked on demand, so re-read its three shared sources
   * before each pricing/validation call rather than accepting a stale singleton.
   */
  private refreshCouponSources(): void {
    this.coupons = readArray<Coupon>(KEYS.coupons).map(normalizeCoupon);
    this.promotions = readArray<Promotion>(KEYS.promotions);
    this.promotionTargets = readArray<PromotionTarget>(KEYS.promotionTargets);
    this.promoUsages = readArray<PromoCodeUsage>(KEYS.promoUsages);
  }

  private persistOrders(): void {
    write(KEYS.orders, this.orders);
    write(KEYS.counter, String(this.counter));
    write(KEYS.reservations, this.reservations);
  }

  private settings(): WebsiteSettings {
    return resolveSettings(this.settingsDoc.settings);
  }

  private event(kind: OrderEventKind, note: string | null, actor?: {
    user_id: string;
    user_name: string;
  }): OrderEvent {
    return {
      id: newId("evt"),
      order_id: "pending",
      kind,
      note,
      user_id: actor?.user_id ?? null,
      user_name: actor?.user_name ?? null,
      created_at: nowIso(),
    };
  }

  // ── staff: listing ────────────────────────────────────────────────────────

  async listOrders(filter: Partial<OnlineOrderFilter> = {}): Promise<OnlineOrder[]> {
    await this.ensureSeeded();
    const merged: OnlineOrderFilter = {
      status: filter.status ?? "all",
      paymentStatus: filter.paymentStatus ?? "all",
      deliveryType: filter.deliveryType ?? "all",
      paymentMethod: filter.paymentMethod ?? "all",
      search: (filter.search ?? "").trim(),
      from: filter.from ?? null,
      to: filter.to ?? null,
      limit: filter.limit ?? null,
    };

    const needle = merged.search.toLowerCase();
    const from = merged.from ? Date.parse(merged.from) : null;
    const to = merged.to ? Date.parse(merged.to) + 86_399_999 : null;

    const result = this.orders
      .filter((order) => {
        if (merged.status !== "all" && order.status !== merged.status) return false;
        if (merged.paymentStatus !== "all" && order.payment_status !== merged.paymentStatus) {
          return false;
        }
        if (merged.deliveryType !== "all" && order.delivery_type !== merged.deliveryType) return false;
        if (merged.paymentMethod !== "all" && order.payment_method !== merged.paymentMethod) return false;
        if (needle) {
          const haystack = [
            order.order_number,
            order.customer_name,
            order.customer_phone,
            order.discount_code ?? "",
            order.sale_number ?? "",
          ]
            .join(" ")
            .toLowerCase();
          if (!haystack.includes(needle)) return false;
        }
        if (from !== null && Number.isFinite(from)) {
            const at = Date.parse(order.created_at);
            if (Number.isFinite(at) && at < from) return false;
        }
        if (to !== null && Number.isFinite(to)) {
          const at = Date.parse(order.created_at);
          if (Number.isFinite(at) && at > to) return false;
        }
        return true;
      })
      // Newest first: the queue is worked from the top.
      .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));

    const limited = merged.limit && merged.limit > 0 ? result.slice(0, merged.limit) : result;
    return delay(limited);
  }

  async listPendingOrderAlerts(limit = 100): Promise<PendingOrderAlert[]> {
    await this.ensureSeeded();
    return delay(
      this.orders
        .filter((order) => order.status === "pending")
        .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
        .slice(0, Math.max(1, limit))
        .map((order) => ({ id: order.id, orderNumber: order.order_number, createdAt: order.created_at })),
    );
  }

  async getOrder(id: string): Promise<OnlineOrder> {
    await this.ensureSeeded();
    const order = this.orders.find((candidate) => candidate.id === id);
    if (!order) throw new OnlineError("order_not_found", `Order ${id} not found`);
    return delay(order);
  }

  async getOrderBySaleId(saleId: string): Promise<OnlineOrder | null> {
    await this.ensureSeeded();
    return delay(this.orders.find((candidate) => candidate.sale_id === saleId) ?? null);
  }

  async listReservations(): Promise<StockReservation[]> {
    await this.ensureSeeded();
    return delay(this.reservations);
  }

  /**
   * Settle a hold that missed its transition (Phase 15).
   *
   * Three rules, in the order they are checked:
   *
   *   1. **A reason is required.** This is a hand repairing the book, and the
   *      trail has to say why — the same insistence the refund settlement and the
   *      order cancellation both make.
   *   2. **Never reverse a resolution.** Releasing a hold that was already
   *      converted would put units back into the pool that the sale has already
   *      taken off the shelf — an oversell created by the repair tool itself.
   *      Repeating the same direction is a no-op that reports
   *      `alreadyResolved`, so a double-click or a retried request cannot
   *      double-release either.
   *   3. **Never write `stock_quantity`.** The order's transition already had its
   *      stock effect; a repair only settles the hold's own row.
   */
  async repairReservation(
    id: string,
    input: ReservationRepairInput,
  ): Promise<ReservationRepairResult> {
    await this.ensureSeeded();
    const reason = input.reason?.trim() ?? "";
    if (!reason) {
      throw new OnlineError("workflow_refused", "A reason is required", {
        field: "reason",
        detail: { reason: "missing_reason", action: input.action },
      });
    }

    const index = this.reservations.findIndex((reservation) => reservation.id === id);
    if (index < 0) {
      throw new OnlineError("db", "Reservation not found", { detail: { id } });
    }
    const current = this.reservations[index];
    const before = {
      status: current.status,
      quantity: current.quantity,
      resolved_at: current.resolved_at,
    };
    const at = nowIso();
    const actor = { user_id: input.user_id, user_name: input.user_name };
    const order = this.orders.find((candidate) => candidate.id === current.online_order_id) ?? null;

    // ── rule 2: a resolved hold is only ever re-settled in the same direction ──
    if (current.status !== "reserved") {
      const wanted = input.action === "release" ? "released" : "converted";
      if (input.action === "reconcile") {
        // The one thing a resolved row can still be wrong about is its own
        // timestamp: the schema requires one, and a hand-edited store may not
        // have it. Stamping it changes no quantity and no stock.
        if (current.resolved_at) {
          return { reservation: current, alreadyResolved: true, before };
        }
        const stamped: StockReservation = { ...current, resolved_at: at };
        this.reservations[index] = stamped;
        this.persistOrders();
        this.noteRepair(order, actor, `Hold reconciled · resolved timestamp recorded · ${reason}`);
        return { reservation: stamped, alreadyResolved: false, before };
      }
      if (current.status === wanted) {
        return { reservation: current, alreadyResolved: true, before };
      }
      throw new OnlineError(
        "workflow_refused",
        `This hold was already ${current.status}; it cannot be ${wanted}`,
        { detail: { id, status: current.status, action: input.action } },
      );
    }

    // ── reconcile an open hold: the quantity must be the order's own ─────────
    if (input.action === "reconcile") {
      if (!order) {
        throw new OnlineError("order_not_found", "The order behind this hold no longer exists", {
          detail: { id, action: "reconcile" },
        });
      }
      if (!holdsReservation(order.status)) {
        throw new OnlineError(
          "workflow_refused",
          `A ${order.status} order does not hold stock — release or convert the hold instead`,
          { detail: { id, order_status: order.status },
        });
      }
      const expected = orderedQuantity(order, current.product_id, current.variant_id);
      if (expected === null) {
        throw new OnlineError(
          "workflow_refused",
          "The order has no line for this shelf — release the hold instead",
          { detail: { id, product_id: current.product_id, variant_id: current.variant_id } },
        );
      }
      if (input.quantity != null && Math.trunc(input.quantity) !== expected) {
        throw new OnlineError(
          "workflow_refused",
          `The order asks for ${expected}; a repair cannot hold a different number`,
          { field: "quantity", detail: { id, expected, requested: Math.trunc(input.quantity) } },
        );
      }
      if (expected === current.quantity) {
        return { reservation: current, alreadyResolved: true, before };
      }
      const corrected: StockReservation = { ...current, quantity: expected };
      this.reservations[index] = corrected;
      this.persistOrders();
      this.noteRepair(
        order,
        actor,
        `Hold reconciled · ${current.quantity} → ${expected} units · ${reason}`,
      );
      return { reservation: corrected, alreadyResolved: false, before };
    }

    // ── release / convert ────────────────────────────────────────────────────
    const status = input.action === "release" ? "released" : "converted";
    const repaired: StockReservation = { ...current, status, resolved_at: at };
    this.reservations[index] = repaired;
    this.persistOrders();
    this.noteRepair(
      order,
      actor,
      `Hold ${status} during reconciliation · ${current.quantity} unit(s) · ${reason}`,
    );
    return { reservation: repaired, alreadyResolved: false, before };
  }

  /**
   * Create the hold a pending order should already have (Phase 15).
   *
   * The mirror image of a stuck hold: an order that is holding nothing, so the
   * website is promising units it cannot deliver. The quantity is the order
   * line's own — a caller cannot invent one — and an existing open hold for the
   * same order and product is returned unchanged rather than duplicated, because
   * two holds on one line would hide stock twice.
   */
  async reserveStockForOrder(input: ReservationHoldInput): Promise<StockReservation> {
    await this.ensureSeeded();
    const reason = input.reason?.trim() ?? "";
    if (!reason) {
      throw new OnlineError("workflow_refused", "A reason is required", {
        field: "reason",
        detail: { reason: "missing_reason", action: "hold" },
      });
    }
    const order = this.orders.find((candidate) => candidate.id === input.online_order_id) ?? null;
    if (!order) {
      throw new OnlineError("order_not_found", "Order not found", {
        detail: { id: input.online_order_id },
      });
    }
    if (!holdsReservation(order.status)) {
      throw new OnlineError(
        "workflow_refused",
        `A ${order.status} order does not hold stock, so there is nothing to repair`,
        { detail: { order_status: order.status } },
      );
    }
    const variantId = input.variant_id ?? null;
    const expected = orderedQuantity(order, input.product_id, variantId);
    if (expected === null || expected <= 0) {
      throw new OnlineError("workflow_refused", "The order has no line for this shelf", {
        detail: { product_id: input.product_id, variant_id: variantId },
      });
    }
    if (input.quantity != null && Math.trunc(input.quantity) !== expected) {
      throw new OnlineError(
        "workflow_refused",
        `The order asks for ${expected}; a repair cannot hold a different number`,
        { field: "quantity", detail: { expected, requested: Math.trunc(input.quantity) } },
      );
    }
    const existing = this.reservations.find(
      (reservation) =>
        reservation.online_order_id === order.id &&
        reservation.product_id === input.product_id &&
        (reservation.variant_id ?? null) === variantId &&
        reservation.status === "reserved",
    );
    if (existing) return delay(existing);

    const created: StockReservation = {
      id: newId("rsv"),
      online_order_id: order.id,
      product_id: input.product_id,
      variant_id: variantId,
      quantity: expected,
      status: "reserved",
      created_at: nowIso(),
      resolved_at: null,
    };
    this.reservations.push(created);
    this.persistOrders();
    this.noteRepair(
      order,
      { user_id: input.user_id, user_name: input.user_name },
      `Hold restored · ${expected} unit(s) · ${reason}`,
    );
    return delay(created);
  }

  /** A repair leaves a line on the order's own timeline, not only in the audit log. */
  private noteRepair(
    order: OnlineOrder | null,
    actor: { user_id: string; user_name: string },
    note: string,
  ): void {
    if (!order) return;
    const index = this.orders.findIndex((candidate) => candidate.id === order.id);
    if (index < 0) return;
    this.orders[index] = {
      ...this.orders[index],
      updated_at: nowIso(),
      events: [
        ...this.orders[index].events,
        { ...this.event("note", note, actor), order_id: order.id },
      ],
    };
    this.persistOrders();
  }

  async counts(filter: Partial<OnlineOrderFilter> = {}): Promise<OrderCounts> {
    const orders = await this.listOrders(filter);
    const counts: OrderCounts = { ...EMPTY_ORDER_COUNTS, total: orders.length };
    for (const order of orders) {
      counts[order.status] += 1;
      if (order.payment_status === "verification_required" && order.status !== "cancelled") {
        counts.needs_payment += 1;
      }
      if (order.status !== "cancelled" && order.status !== "completed") {
        counts.open_value = round2(counts.open_value + order.subtotal - order.discount_amount);
      }
    }
    return counts;
  }

  // ── customer: checkout ────────────────────────────────────────────────────

  async placeOrder(input: PlaceOrderInput): Promise<PlaceOrderResult> {
    await this.ensureSeeded();

    // Idempotency first, exactly like the till: a double tap returns the order
    // that already exists rather than reserving the same stock twice.
    const existing = this.orders.find((order) => order.client_ref === input.client_ref);
    if (existing) return { order: resolveValue(existing), duplicate: true };

    if (inFlight) {
      throw new OnlineError("db", "An order is already being processed");
    }
    inFlight = true;
    try {
      const settings = this.settings();
      const name = input.customer_name.trim();
      const phone = input.customer_phone.trim();
      if (!name || !phone) {
        throw new OnlineError("missing_contact", "Name and phone are required", {
          field: name ? "customer_phone" : "customer_name",
        });
      }
      if (input.lines.length === 0) {
        throw new OnlineError("empty_cart", "The cart is empty", { field: "lines" });
      }
      if (input.delivery_type === "delivery" && !settings.delivery.enabled) {
        throw new OnlineError("delivery_unavailable", "Delivery is not available", {
          field: "delivery_type",
        });
      }
      if (input.delivery_type === "pickup" && !settings.delivery.pickup_enabled) {
        throw new OnlineError("pickup_unavailable", "Pickup is not available", {
          field: "delivery_type",
        });
      }
      if (input.payment_method === "cod" && !settings.delivery.cod_enabled) {
        throw new OnlineError("payment_unavailable", "Cash on delivery is not available", {
          field: "payment_method",
        });
      }
      if (input.payment_method === "instapay" && !settings.delivery.instapay_enabled) {
        throw new OnlineError("payment_unavailable", "InstaPay is not available", {
          field: "payment_method",
        });
      }
      if (input.delivery_type === "delivery") {
        const address = input.address;
        const city = address?.city.trim() ?? "";
        const area = address?.area.trim() ?? "";
        const street = address?.street.trim() ?? "";
        // The same rule as `place_online_order`: a driver needs the whole
        // address, and an address outside the places the shop serves is refused
        // with the shop's own wording.
        if (!address || !city || !area || !street) {
          throw new OnlineError("missing_address", "A delivery address is required", {
            field: "address",
          });
        }
        // A named zone replaces the areas list: the zone IS the place the shop
        // serves. Without one, the legacy list still decides.
        if (!input.delivery_zone_id && !deliveryAreaSupported(settings.delivery, city, area)) {
          throw new OnlineError(
            "delivery_area_unsupported",
            `Delivery to ${city || area} is not available`,
            { field: "address", detail: { place: city || area } },
          );
        }
      }

      const products = await getDemoRepository().listProducts();
      const byId = new Map(products.map((product) => [product.id, product]));

      // Phase 43: every combination of every variant product, so a line that
      // names a combination can be validated against THAT shelf — its own
      // stock, its own holds, its own price. The same reads the SQL does.
      const variants = await getDemoRepository().listVariants();
      // Active combinations only — an archived one stopped being sold, and the
      // SQL refuses it at the same point.
      const variantById = new Map<string, ProductVariant>(
        variants.filter((variant) => variant.active).map((variant) => [variant.id, variant]),
      );

      // Aggregate quantities per SHELF: two lines of the same product add up,
      // and so do two lines of the same combination — the same piece added
      // twice must not be promised the last unit twice.
      const wanted = new Map<string, number>();
      const lineVariant = new Map<string, string | null>();
      const shelfKey = (productId: string, variantId: string | null) =>
        `${productId}::${variantId ?? ""}`;
      for (const line of input.lines) {
        const quantity = Math.trunc(line.qty);
        if (!Number.isFinite(quantity) || quantity <= 0) {
          throw new OnlineError("empty_cart", "Invalid quantity", { field: "lines" });
        }
        const product = byId.get(line.product_id);
        if (!product) {
          throw new OnlineError("product_unavailable", `Product ${line.product_id} not found`, {
            field: "lines",
          });
        }
        if (!product.active || !product.show_on_website) {
          throw new OnlineError("product_unavailable", `${product.sku} is not on the website`, {
            field: "lines",
            detail: { sku: product.sku },
          });
        }
        // Approval turns the order into a POS sale, which can only carry
        // stock-tracked products. Refusing here means the customer hears it now.
        if (!product.stock_tracking_enabled) {
          throw new OnlineError("product_unavailable", `${product.sku} cannot be ordered online`, {
            field: "lines",
            detail: { sku: product.sku },
          });
        }

        // ── which combination, exactly ──
        // A variant-product line names one; the storefront never picks a
        // colour or a size for the customer, and neither does this function.
        let variantId: string | null = null;
        if (product.variants_enabled) {
          const raw = line.variant_id ?? null;
          variantId = raw && variantById.has(raw) ? raw : null;
          if (!raw || !variantId) {
            throw new OnlineError(
              "variant_required",
              `Choose the colour and the size for ${product.sku}`,
              { field: "lines", detail: { sku: product.sku } },
            );
          }
          const variant = variantById.get(variantId) as ProductVariant;
          if (variant.product_id !== product.id) {
            throw new OnlineError(
              "variant_mismatch",
              `That colour and size does not belong to ${product.sku}`,
              { field: "lines", detail: { sku: product.sku } },
            );
          }
        } else if (line.variant_id) {
          // A combination named on a product that sells whole is junk, not a
          // hint — refusing keeps the order line honest.
          throw new OnlineError(
            "variant_mismatch",
            `${product.sku} does not sell by colour and size`,
            { field: "lines", detail: { sku: product.sku } },
          );
        }

        const key = shelfKey(product.id, variantId);
        wanted.set(key, (wanted.get(key) ?? 0) + quantity);
        lineVariant.set(key, variantId);
      }

      // Availability is stock minus what pending orders are already holding —
      // per combination for a variant line, per product otherwise.
      const reserved = reservedByProduct(this.reservations);
      const reservedVariant = reservedByVariant(this.reservations);
      const shelfSku = new Map<string, string>();
      const shelfAvailable = new Map<string, number | null>();
      for (const [key, quantity] of wanted) {
        const [productId, variantId] = key.split("::");
        const product = byId.get(productId);
        if (!product) continue;
        const variant = variantId ? variantById.get(variantId) : undefined;
        if (variant) {
          shelfSku.set(key, variant.sku);
          const available = variantAvailableToPromise(
            variant,
            reservedVariant.get(variant.id) ?? 0,
          );
          shelfAvailable.set(key, available);
          if (quantity > available) {
            throw new OnlineError(
              "insufficient_stock",
              `Only ${available} of ${variantLabelOf(variant)} available`,
              {
                field: "lines",
                detail: {
                  sku: product.sku,
                  variant_id: variant.id,
                  requested: quantity,
                  available,
                },
              },
            );
          }
          continue;
        }
        shelfSku.set(key, product.sku);
        const available = availableToPromise(product, reserved.get(productId) ?? 0);
        shelfAvailable.set(key, available);
        if (available !== null && quantity > available) {
          throw new OnlineError(
            "insufficient_stock",
            `Only ${available} of ${product.sku} available`,
            {
              field: "lines",
              detail: { sku: product.sku, requested: quantity, available },
            },
          );
        }
      }

      // Delivery zone, when the customer chose one: unknown or switched-off
      // zones are refused, like the server. Without a zone the legacy
      // settings path (areas list, global fee) applies below.
      const zoneId = input.delivery_zone_id ?? null;
      const zone = zoneId
        ? (this.deliveryZones.find((candidate) => candidate.id === zoneId) ?? null)
        : null;
      if (zoneId && (!zone || !zone.enabled)) {
        throw new OnlineError("delivery_unavailable", "Delivery zone is not available", {
          field: "delivery_type",
        });
      }

      // Coupon, validated against its own rules and the recomputed subtotal.
      const couponCode = normalizeCouponCode(input.coupon_code ?? "");
      let coupon: Coupon | null = null;
      if (couponCode) {
        coupon = this.coupons.find((candidate) => candidate.code === couponCode) ?? null;
        if (!coupon) {
          throw new OnlineError("coupon_invalid", `Coupon ${couponCode} is not valid`, {
            field: "coupon_code",
          });
        }
      }

      const totals = priceCart({
        items: [...wanted.entries()].map(([key, quantity]) => {
          const [productId, variantId] = key.split("::");
          const product = byId.get(productId) as Product;
          const variant = variantId ? (variantById.get(variantId) as ProductVariant) : null;
          return {
            product_id: productId,
            quantity,
            list_price: product.selling_price,
            category_id: product.category_id,
            // The priced line keeps its combination, and a combination with
            // its own override prices at exactly that — campaigns never stack
            // on top, the same rule `place_online_order` applies.
            variant_id: variantId || null,
            fixed_price: variant?.price_override ?? null,
          };
        }),
        campaigns: this.campaigns,
        // No coupon here: order-level discounts (automatic promotion, promo
        // code, stacking) are evaluated once below, mirroring the server core.
        coupon: null,
        delivery: settings.delivery,
        deliveryType: input.delivery_type,
      });

      // The one pricing evaluation: automatic promotion, extended coupon
      // rules, stacking, zone-aware fee, per-line allocation. Refusals carry
      // live mode's wording so both modes fail identically.
      const customerKey = customerKeyFor(
        input.store_customer_id ?? null,
        phone,
        input.client_ref,
      );
      const evaluated = evaluateCartPricing({
        lines: totals.lines.map((line) => ({
          product_id: line.product_id,
          category_id: byId.get(line.product_id)?.category_id ?? null,
          variant_id: line.variant_id,
          qty: line.quantity,
          unit_price: line.unit_price,
          line_total: line.line_total,
        })),
        subtotal: totals.subtotal,
        promoCode: couponCode || null,
        coupons: this.coupons,
        promotions: this.promotions,
        targetsByPromotion: this.targetsByPromotion(),
        usageFor: (couponId) => this.usageSummary(couponId, customerKey),
        customerKey,
        zone,
        legacy: {
          fee: settings.delivery.fee,
          minimum: settings.delivery.minimum_order ?? 0,
          threshold: settings.delivery.free_delivery_threshold ?? 0,
        },
        deliveryType: input.delivery_type,
      });
      if (!evaluated.ok) {
        throw this.pricingRefusal(evaluated.reason, evaluated.message, couponCode || null);
      }
      const pricing = evaluated.pricing;

      const orderId = newId("ord");
      this.counter += 1;
      const at = nowIso();

      const items: OnlineOrderItem[] = totals.lines.map((line, index) => {
        const product = byId.get(line.product_id) as Product;
        // The snapshot names the COMBINATION's own code — the invoice and the
        // pick list say "ALYQ-G17", not the product's — frozen beside the
        // colour and size, exactly like `SaleItem` and like the SQL writes.
        const variant = line.variant_id
          ? (variantById.get(line.variant_id) as ProductVariant)
          : null;
        return {
          id: newId("oli"),
          order_id: orderId,
          product_id: product.id,
          variant_id: variant?.id ?? null,
          variant_color_ar: variant?.color_ar ?? null,
          variant_color_en: variant?.color_en ?? null,
          variant_size: variant?.size ?? null,
          variant_size_label: variant?.size_label ?? null,
          name_ar: product.name_ar,
          name_en: product.name_en,
          sku: variant?.sku ?? product.sku,
          barcode: variant?.barcode ?? product.barcode,
          unit_price: line.unit_price,
          // What this unit actually cost after every order-level discount —
          // what a return refunds. Allocated proportionally by the engine.
          discounted_unit_price: pricing.lines[index]?.discounted_unit_price ?? line.unit_price,
          quantity: line.quantity,
          line_total: line.line_total,
        };
      });

      const snapshot: PriceSnapshot = {
        promo_code: pricing.promoCode,
        promotion_id: pricing.autoPromotionId,
        promotion_name: pricing.autoPromotionName,
        auto_discount: pricing.autoDiscount,
        promo_discount: pricing.promoDiscount,
        promo_free_shipping: pricing.promoFreeShipping,
        original_subtotal: pricing.subtotal,
        final_subtotal: round2(pricing.subtotal - pricing.totalDiscount),
        gross_shipping_fee: pricing.grossShippingFee,
        shipping_discount: pricing.shippingDiscount,
        shipping_source: pricing.shippingSource,
        zone_id: pricing.zoneId,
        zone_name: pricing.zoneName,
        total_discount: pricing.totalDiscount,
        final_total: pricing.total,
      };

      const order: OnlineOrder = {
        id: orderId,
        order_number: formatOrderNumber(this.counter),
        client_ref: input.client_ref,
        store_customer_id: input.store_customer_id ?? null,
        customer_name: name,
        customer_phone: phone,
        customer_email: input.customer_email?.trim() || null,
        delivery_type: input.delivery_type,
        address:
          input.delivery_type === "delivery"
            ? {
                ...(input.address as CustomerAddress),
                ...(zone
                  ? { zone_id: zone.id, zone_name: zone.name_en || zone.name_ar }
                  : {}),
              }
            : null,
        subtotal: pricing.subtotal,
        discount_code: pricing.promoCode,
        discount_amount: pricing.totalDiscount,
        promotion_id: pricing.autoPromotionId,
        price_snapshot: snapshot,
        delivery_fee: pricing.deliveryFee,
        delivery_zone_id: zone?.id ?? null,
        delivery_zone_name_en: zone?.name_en ?? null,
        delivery_zone_name_ar: zone?.name_ar ?? null,
        delivery_free_shipping: input.delivery_type === "delivery" && pricing.deliveryFee === 0,
        total: pricing.total,
        payment_method: input.payment_method,
        payment_status: initialPaymentStatus(input.payment_method),
        status: "pending",
        payment_reference: null,
        payment_proof_url: null,
        payment_submitted_at: null,
        payment_verified_by: null,
        payment_verified_by_name: null,
        payment_verified_at: null,
        payment_rejected_reason: null,
        sale_id: null,
        sale_number: null,
        notes: input.notes?.trim() || null,
        cancellation_reason: null,
        approved_by: null,
        approved_by_name: null,
        approved_at: null,
        cancelled_by: null,
        cancelled_by_name: null,
        cancelled_at: null,
        completed_at: null,
        created_at: at,
        updated_at: at,
        items,
        events: [
          {
            ...this.event(
              "placed",
              `Order placed on the website (${input.delivery_type})`,
            ),
            order_id: orderId,
          },
        ],
      };

      // Reservations: the units this order is holding while it waits — per
      // SHELF, so a hold on Gold / 17 shadows Gold / 17 only. Same order, same
      // product, same combination → the holds add up instead of hiding the
      // same units twice behind a duplicate row.
      for (const item of items) {
        const existing = this.reservations.find(
          (reservation) =>
            reservation.online_order_id === orderId &&
            reservation.product_id === item.product_id &&
            (reservation.variant_id ?? null) === (item.variant_id ?? null) &&
            reservation.status === "reserved",
        );
        if (existing) {
          existing.quantity += item.quantity;
          continue;
        }
        this.reservations.push({
          id: newId("res"),
          online_order_id: orderId,
          product_id: item.product_id,
          variant_id: item.variant_id ?? null,
          quantity: item.quantity,
          status: "reserved",
          created_at: at,
          resolved_at: null,
        });
      }

      // 6. Coupon & promo tracking: Pending orders do NOT consume usage_limit.
      // Usage is consumed atomically upon order approval/confirmation (in resolveOrder).

      this.orders.push(order);
      this.persistOrders();
      return { order: resolveValue(order), duplicate: false };
    } catch (error) {
      throw toOnlineError(error);
    } finally {
      inFlight = false;
    }
  }

  async lookupOrder(orderNumber: string, phone: string): Promise<OnlineOrder> {
    await this.ensureSeeded();
    const number = orderNumber.trim().toUpperCase();
    const digits = normalizePhone(phone);
    const order = this.orders.find(
      (candidate) =>
        candidate.order_number.toUpperCase() === number &&
        (normalizePhone(candidate.customer_phone) === digits ||
          candidate.customer_phone.trim() === phone.trim()),
    );
    // Knowing the number AND the phone is what proves the order is yours.
    if (!order) {
      throw new OnlineError("order_not_found", "No order matches that number and phone", {
        field: "order_number",
      });
    }
    return delay(order);
  }

  async submitPaymentProof(input: PaymentProofInput): Promise<OnlineOrder> {
    await this.ensureSeeded();
    const order = await this.lookupOrder(input.order_number, input.customer_phone);
    const index = this.orders.findIndex((candidate) => candidate.id === order.id);
    if (index === -1) throw new OnlineError("order_not_found");

    const current = this.orders[index];
    if (current.payment_method !== "instapay") {
      throw new OnlineError("workflow_refused", "This order is not paid by InstaPay", {
        detail: { reason: "not_instapay" },
      });
    }
    if (current.payment_status === "paid") {
      throw new OnlineError("workflow_refused", "This payment has already been verified", {
        detail: { reason: "payment_already_paid" },
      });
    }
    if (current.status === "cancelled") {
      throw new OnlineError("workflow_refused", "This order was cancelled", {
        detail: { reason: "already_cancelled" },
      });
    }
    const reference = input.payment_reference.trim();
    if (!reference) {
      throw new OnlineError("workflow_refused", "A transaction reference is required", {
        field: "payment_reference",
        detail: { reason: "missing_reference" },
      });
    }

    const at = nowIso();
    // Submission moves the order to "verification required". It never marks it
    // paid: a screenshot is a claim, and only an employee can settle it.
    const updated: OnlineOrder = {
      ...current,
      payment_reference: reference,
      payment_proof_url: input.payment_proof_url?.trim() || current.payment_proof_url,
      payment_submitted_at: at,
      payment_status: "verification_required",
      payment_rejected_reason: null,
      updated_at: at,
      events: [
        ...current.events,
        {
          ...this.event("payment_submitted", `InstaPay reference ${reference} submitted`),
          order_id: current.id,
        },
      ],
    };
    this.orders[index] = updated;
    this.persistOrders();
    return delay(updated);
  }

  async listMyOrders(storeCustomerId: string | null): Promise<OnlineOrder[]> {
    await this.ensureSeeded();
    if (!storeCustomerId) return [];

    const own = this.orders.filter((order) => order.store_customer_id === storeCustomerId);
    const seen = new Set(own.map((order) => order.id));

    // An order placed as a guest and then claimed by signing in is still this
    // shopper's: the remembered reference proves it, because looking an order up
    // needs the number AND the phone it was placed with.
    for (const ref of this.placedRefs(storeCustomerId)) {
      if (own.some((order) => order.order_number === ref.order_number)) continue;
      const match = this.orders.find(
        (order) =>
          order.order_number === ref.order_number &&
          normalizePhone(order.customer_phone) === normalizePhone(ref.phone),
      );
      if (match && !seen.has(match.id)) {
        seen.add(match.id);
        own.push(match);
      }
    }

    return delay(own.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at)));
  }

  // ── staff: the workflow ───────────────────────────────────────────────────

  async resolveOrder(id: string, input: ResolveOrderInput): Promise<OnlineOrder> {
    await this.ensureSeeded();
    const index = this.orders.findIndex((order) => order.id === id);
    if (index === -1) throw new OnlineError("order_not_found", `Order ${id} not found`);

    const order = this.orders[index];
    const check = checkAction(order, input.action);
    if (!check.ok) {
      // Transition refusals (wrong state, backwards, unknown) read as "this
      // order cannot be moved to that status" — the same code live mode maps
      // the workflow raises to. Capability and payment refusals stay
      // `workflow_refused`: they are about the actor, not the state.
      const transition =
        check.reason === "not_pending" ||
        check.reason === "already_cancelled" ||
        check.reason === "already_completed" ||
        check.reason === "not_approved" ||
        check.reason === "backwards" ||
        check.reason === "unknown";
      throw new OnlineError(
        transition ? "status_transition_refused" : "workflow_refused",
        `Cannot ${input.action} this order`,
        {
          detail: { reason: check.reason, action: input.action },
        },
      );
    }
    const reason = input.reason?.trim() || null;
    if (requiresReason(input.action) && !reason) {
      throw new OnlineError("workflow_refused", "A reason is required", {
        field: "reason",
        detail: { reason: "missing_reason", action: input.action },
      });
    }

    if (inFlight) {
      throw new OnlineError("db", "Another order change is being processed");
    }
    inFlight = true;
    try {
      const at = nowIso();
      const actor = { user_id: input.user_id, user_name: input.user_name };
      let next: OnlineOrder = { ...order, updated_at: at };
      const push = (kind: OrderEventKind, note: string | null) => {
        next = {
          ...next,
          events: [...next.events, { ...this.event(kind, note, actor), order_id: next.id }],
        };
      };

      switch (input.action) {
        case "approve": {
          const products = await getDemoRepository().listProducts();
          const byId = new Map(products.map((product) => [product.id, product]));
          // Phase 43: the sale carries the order's exact combinations, so the
          // deduction lands on the right shelf and the invoice reads the same
          // colour and size the customer chose.
          const variants = await getDemoRepository().listVariants();
          const variantById = new Map(variants.map((variant) => [variant.id, variant]));

          // The sale's lines come out at catalogue price, so everything that
          // lowered them at checkout — a flash sale, a coupon, both — travels
          // across as one fixed discount. Otherwise the register books more
          // revenue than the customer paid. A combination's own override IS a
          // catalogue price, so it counts at that, not at the product's.
          //
          // RECONCILIATION:
          // - order.subtotal = post-campaign goods total (e.g., 462.40)
          // - order.discount_amount = campaign + coupon (e.g., 127.84 = 81.60 + 46.24)
          // - listTotal = pre-discount list price total (e.g., 544)
          // - goodsTotal = order.subtotal - order.discount_amount = net goods (e.g., 334.56)
          // - saleDiscount = listTotal - goodsTotal = TOTAL markdown from list (e.g., 127.84)
          // This equals the online order's discount_amount, so POS and online agree on
          // the total discount. OnlineReportsPage breaks it down into campaign vs coupon.
          const listTotal = round2(
            order.items.reduce((sum, item) => {
              const product = byId.get(item.product_id);
              const variant = item.variant_id
                ? variantById.get(item.variant_id) ?? null
                : null;
              const unit =
                variant?.price_override ?? product?.selling_price ?? item.unit_price;
              return sum + unit * item.quantity;
            }, 0),
          );
          const goodsTotal = round2(order.subtotal - order.discount_amount);
          const saleDiscount = Math.max(round2(listTotal - goodsTotal), 0);

          const sale = await getDemoSalesRepository().completeSale({
            client_ref: `online-${order.id}`,
            source: "online",
            lines: order.items.map((item) => ({
              product_id: item.product_id,
              qty: item.quantity,
              variant_id: item.variant_id,
            })),
            discount_type: saleDiscount > 0 ? "fixed" : "none",
            discount_value: saleDiscount,
            payments: [
              {
                method: order.payment_method === "cod" ? "cod" : "instapay",
                amount: goodsTotal,
                // Cash on delivery has not been collected; an InstaPay order can
                // only be approved once its payment has been verified.
                status: order.payment_status === "paid" ? "paid" : "pending",
              },
            ],
            customer_id: order.store_customer_id,
            customer_name: order.customer_name,
            customer_phone: order.customer_phone,
            user_id: input.user_id,
            user_name: input.user_name,
          });

          // The hold becomes the deduction the sale just made.
          this.reservations = this.reservations.map((reservation) =>
            reservation.online_order_id === order.id && reservation.status === "reserved"
              ? { ...reservation, status: "converted" as const, resolved_at: at }
              : reservation,
          );

          // Atomic consumption of coupon & promo usage upon approval
          if (order.discount_code) {
            const normalized = normalizeCouponCode(order.discount_code);
            const usedPromo = this.promotions.find(
              (p) => p.mode === "coupon" && p.code && normalizeCouponCode(p.code) === normalized,
            );
            if (usedPromo) {
              if (usedPromo.usage_limit != null && (usedPromo.used_count ?? 0) >= usedPromo.usage_limit) {
                throw new Error(`Coupon ${order.discount_code} has reached its usage limit`);
              }
              this.promotions = this.promotions.map((p) =>
                p.id === usedPromo.id
                  ? { ...p, used_count: (p.used_count ?? 0) + 1, updated_at: at }
                  : p,
              );
              write(KEYS.promotions, this.promotions);
            }
            const used = this.coupons.find((candidate) => candidate.code === order.discount_code);
            if (used) {
              if (used.usage_limit != null && used.used_count >= used.usage_limit) {
                throw new Error(`Coupon ${order.discount_code} has reached its usage limit`);
              }
              this.coupons = this.coupons.map((candidate) =>
                candidate.id === used.id
                  ? { ...candidate, used_count: candidate.used_count + 1, updated_at: at }
                  : candidate,
              );
              write(KEYS.coupons, this.coupons);
              if (order.customer_phone) {
                this.promoUsages.push({
                  id: newId("pus"),
                  coupon_id: used.id,
                  order_id: order.id,
                  customer_key: order.customer_phone,
                  used_at: at,
                });
                write(KEYS.promoUsages, this.promoUsages);
              }
            }
          }
          if (order.promotion_id) {
            this.promotions = this.promotions.map((p) =>
              p.id === order.promotion_id
                ? { ...p, used_count: (p.used_count ?? 0) + 1, updated_at: at }
                : p,
            );
            write(KEYS.promotions, this.promotions);
          }

          next = {
            ...next,
            status: "approved",
            sale_id: sale.id,
            sale_number: sale.sale_number,
            approved_by: input.user_id,
            approved_by_name: input.user_name,
            approved_at: at,
          };
          push("approved", `Order approved · sale ${sale.sale_number}`);
          break;
        }

        case "cancel": {
          // Give the units back: the hold is released, and if a sale already
          // exists it is voided, which is what restores the stock.
          this.reservations = this.reservations.map((reservation) =>
            reservation.online_order_id === order.id && reservation.status === "reserved"
              ? { ...reservation, status: "released" as const, resolved_at: at }
              : reservation,
          );

          // Safe coupon & promotion lifecycle: release consumed count ONLY if order was approved
          if ((order.status === "approved" || order.sale_id) && order.discount_code) {
            const normalized = normalizeCouponCode(order.discount_code);
            this.promotions = this.promotions.map((p) =>
              p.mode === "coupon" && p.code && normalizeCouponCode(p.code) === normalized
                ? { ...p, used_count: Math.max((p.used_count ?? 0) - 1, 0), updated_at: at }
                : p,
            );
            write(KEYS.promotions, this.promotions);

            this.coupons = this.coupons.map((coupon) =>
              coupon.code === order.discount_code
                ? {
                    ...coupon,
                    used_count: Math.max(coupon.used_count - 1, 0),
                    updated_at: at,
                  }
                : coupon,
            );
            write(KEYS.coupons, this.coupons);

            this.promoUsages = this.promoUsages.filter((u) => u.order_id !== order.id);
            write(KEYS.promoUsages, this.promoUsages);
          }

          if ((order.status === "approved" || order.sale_id) && order.promotion_id) {
            this.promotions = this.promotions.map((p) =>
              p.id === order.promotion_id
                ? { ...p, used_count: Math.max((p.used_count ?? 0) - 1, 0), updated_at: at }
                : p,
            );
            write(KEYS.promotions, this.promotions);
          }

          next = {
            ...next,
            status: "cancelled",
            cancellation_reason: reason,
            cancelled_by: input.user_id,
            cancelled_by_name: input.user_name,
            cancelled_at: at,
          };
          push("cancelled", `Order cancelled${reason ? `: ${reason}` : ""}`);
          break;
        }

        case "processing":
          // The stored status is the canonical mapping's answer, never the
          // action word — mirroring what `resolve_online_order` writes.
          next = { ...next, status: ORDER_ACTION_TO_STATUS.processing ?? "processing" };
          push("processing", "Order is being prepared");
          break;

        case "ready":
          next = {
            ...next,
            status: ORDER_ACTION_TO_STATUS.ready ?? "ready",
          };
          push(
            "ready",
            order.delivery_type === "pickup"
              ? "Order is ready for pickup"
              : "Order is ready for delivery",
          );
          break;

        case "complete":
          next = { ...next, status: ORDER_ACTION_TO_STATUS.complete ?? "completed", completed_at: at };
          push("completed", "Order completed");
          break;

        case "payment_approve": {
          next = {
            ...next,
            payment_status: "paid",
            payment_verified_by: input.user_id,
            payment_verified_by_name: input.user_name,
            payment_verified_at: at,
            payment_rejected_reason: null,
          };
          push(
            "payment_approved",
            `Payment verified${order.payment_reference ? ` · reference ${order.payment_reference}` : ""}`,
          );
          // If the order already became a sale, the register has to agree that
          // the money arrived — otherwise the till shows a debt that is paid.
          if (order.sale_id && order.payment_method === "instapay") {
            await getDemoSalesRepository().confirmPayment(order.sale_id, {
              user_id: input.user_id,
              user_name: input.user_name,
            });
          }
          break;
        }

        case "payment_reject":
          next = {
            ...next,
            payment_status: "failed",
            payment_rejected_reason: reason,
          };
          push("payment_rejected", `Payment rejected${reason ? `: ${reason}` : ""}`);
          break;

        default:
          throw new OnlineError("workflow_refused", `Unknown action ${input.action}`, {
            detail: { action: input.action },
          });
      }

      this.orders[index] = next;
      this.persistOrders();

      // Phase 48 audit parity: the live RPCs write these rows (0018 lines for
      // payment_approved / approved), and demo mode now writes the same acts
      // with the same vocabulary — the trail means one thing in both modes.
      // Fire-and-forget: an audit failure must not undo an approved order.
      const auditAction =
        input.action === "approve"
          ? "online_order.approved"
          : input.action === "payment_approve"
            ? "online_order.payment_approved"
            : input.action === "payment_reject"
              ? "online_order.payment_rejected"
              : null;
      if (auditAction) {
        void recordAudit({
          action: auditAction,
          entity: "online_order",
          entity_id: next.id,
          entity_label: next.order_number,
          details: {
            order: next.order_number,
            total: next.total,
            delivery_type: next.delivery_type,
            payment_method: next.payment_method,
            payment_status: next.payment_status,
            status: next.status,
          },
        });
      }
      return resolveValue(next);
    } catch (error) {
      throw toOnlineError(error);
    } finally {
      inFlight = false;
    }
  }

  // ── website settings + content + marketing ────────────────────────────────

  async getSnapshot(): Promise<WebsiteSnapshot> {
    await this.ensureSeeded();
    // BroadcastChannel causes StorefrontProvider to reload this snapshot after
    // an admin write in another tab; refresh the shared marketing sources then.
    this.refreshCouponSources();
    // No coupons here: a visitor never sees the code list, in either mode.
    return delay({
      settings: this.settings(),
      meta: this.settingsDoc.meta,
      contents: this.contents,
      faqs: [...this.faqs].sort((a, b) => a.sort_order - b.sort_order),
      reviews: [...this.reviews].sort((a, b) => a.sort_order - b.sort_order),
      campaigns: this.campaigns,
      categoryContents: [...this.categoryContents],
      deliveryZones: this.sortedZones(),
      promotions: this.promotions,
      promotionTargets: this.promotionTargets,
    });
  }

  /** Enabled zones first, in the admin's order — the checkout's choices. */
  private sortedZones(): DeliveryZone[] {
    return [...this.deliveryZones].sort((a, b) => {
      if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
      return a.sort_order - b.sort_order;
    });
  }

  async getMarketing(): Promise<MarketingSnapshot> {
    await this.ensureSeeded();
    return delay({
      coupons: this.coupons,
      campaigns: this.campaigns,
      promotions: this.promotions,
      promotionTargets: this.promotionTargets,
    });
  }

  async checkCoupon(input: CouponCheckInput): Promise<CouponCheckResult> {
    await this.ensureSeeded();
    this.refreshCouponSources();
    const code = normalizeCouponCode(input.code);
    if (!code) return { valid: false, reason: "not_found" };

    const lines =
      input.lines ??
      (input.productIds ?? []).map((product_id) => ({ product_id, qty: 1, variant_id: null }));
    try {
      // Use the exact same evaluator as the demo checkout preview. This is the
      // central-promotion fix: never look only in legacy `coupons` here.
      const preview = await this.previewPricing({
        lines,
        couponCode: code,
        customerKey: input.customerKey ?? null,
        deliveryType: "pickup",
      });
      const promotion = this.promotions.find(
        (candidate) =>
          candidate.mode === "coupon" &&
          candidate.code &&
          normalizeCouponCode(candidate.code) === code,
      );
      const coupon = promotion
        ? null
        : this.coupons.find((candidate) => normalizeCouponCode(candidate.code) === code) ?? null;
      if (!promotion && !coupon) return { valid: false, reason: "not_found" };
      return {
        valid: true,
        code,
        discount: preview.promoDiscount,
        discountType: (promotion?.discount_type ?? coupon?.discount_type ?? "percent") as "percent" | "fixed" | "free_shipping",
        value: promotion?.value ?? coupon?.value ?? 0,
        stackable: promotion?.stackable ?? coupon?.stackable ?? false,
        ...(preview.promoFreeShipping ? { freeShipping: true as const } : {}),
      };
    } catch (error) {
      const online = toOnlineError(error);
      const reasonByCode: Partial<Record<OnlineError["code"], CouponCheckReason>> = {
        coupon_invalid: "invalid",
        coupon_not_started: "not_started",
        coupon_expired: "expired",
        coupon_limit_reached: "exhausted",
        coupon_min_subtotal: "min_subtotal",
        coupon_not_applicable: "not_applicable",
      };
      const promotion = this.promotions.find(
        (candidate) => candidate.mode === "coupon" && candidate.code && normalizeCouponCode(candidate.code) === code,
      );
      const coupon = promotion ? null : this.coupons.find((candidate) => normalizeCouponCode(candidate.code) === code) ?? null;
      const reason: CouponCheckReason = !promotion && !coupon
        ? "not_found"
        : (reasonByCode[online.code] ?? "invalid");
      return {
        valid: false,
        reason,
        ...(reason === "min_subtotal"
          ? { minSubtotal: promotion?.minimum_order_amount ?? coupon?.min_subtotal ?? 0 }
          : {}),
      };
    }
  }

  /**
   * Personal history for one code: non-cancelled uses by this customer, and
   * whether they have any prior non-cancelled order. Cancelled orders are
   * excluded by filter — the history stays the history, like the SQL join.
   */
  private usageSummary(
    couponId: string,
    customerKey: string | null,
  ): { customerUses: number; hasPriorOrder: boolean } {
    if (!customerKey) return { customerUses: 0, hasPriorOrder: false };
    const live = (order: OnlineOrder) => order.status !== "cancelled";
    const customerUses = this.promoUsages.filter(
      (usage) =>
        usage.coupon_id === couponId &&
        usage.customer_key === customerKey &&
        this.orders.some((order) => order.id === usage.order_id && live(order)),
    ).length;
    const hasPriorOrder = this.orders.some(
      (order) =>
        live(order) &&
        (order.store_customer_id === customerKey ||
          customerKeyFor(null, order.customer_phone) === customerKey),
    );
    return { customerUses, hasPriorOrder };
  }

  async bestSellers(limit = 8): Promise<BestSellerRow[]> {
    await this.ensureSeeded();
    // The same derivation the live RPC uses: till sales minus voids, website
    // orders minus cancellations.
    const sales = await getDemoSalesRepository().listSales();
    const units = unitsSold({ sales, onlineOrders: this.orders });
    return [...units.entries()]
      .filter(([, quantity]) => quantity > 0)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, Math.max(limit, 1))
      .map(([product_id, quantity]) => ({ product_id, units: quantity }));
  }

  async getSettings(): Promise<WebsiteSettings> {
    await this.ensureSeeded();
    return delay(this.settings());
  }

  async saveSettings(input: SettingsSaveInput): Promise<WebsiteSettingsMeta> {
    await this.ensureSeeded();
    // Stored as given; read back through `resolveSettings`, so a document from an
    // older release still renders and gains whatever it is missing.
    const merged = sanitizeSettings(mergeSettings(DEFAULT_WEBSITE_SETTINGS, input.settings as unknown));
    const meta: WebsiteSettingsMeta = {
      updated_at: nowIso(),
      updated_by_name: input.user_name || null,
    };
    this.settingsDoc = { settings: merged, meta };
    write(KEYS.settings, this.settingsDoc);
    return delay(meta);
  }

  async listProductContents(): Promise<ProductContent[]> {
    await this.ensureSeeded();
    return delay(this.contents);
  }

  async saveProductContent(draft: ProductContentDraft): Promise<ProductContent> {
    await this.ensureSeeded();
    const at = nowIso();
    const existing = this.contents.find((content) => content.product_id === draft.product_id);
    const slug = draft.slug?.trim() ? slugifyAscii(draft.slug, draft.product_id) : null;
    if (slug && this.contents.some((content) =>
      content.product_id !== draft.product_id && content.slug === slug)) {
      throw new OnlineError("db", "That slug is already used by another product", {
        field: "slug",
      });
    }
    const next: ProductContent = {
      product_id: draft.product_id,
      brand_ar: draft.brand_ar ?? existing?.brand_ar ?? null,
      brand_en: draft.brand_en ?? existing?.brand_en ?? null,
      slug,
      seo_title: draft.seo_title ?? existing?.seo_title ?? null,
      seo_description: draft.seo_description ?? existing?.seo_description ?? null,
      specs: draft.specs ?? existing?.specs ?? [],
      created_at: existing?.created_at ?? at,
      updated_at: at,
    };
    this.contents = existing
      ? this.contents.map((content) =>
          content.product_id === draft.product_id ? next : content,
        )
      : [...this.contents, next];
    write(KEYS.contents, this.contents);
    return delay(next);
  }

  async deleteProductContent(productId: string): Promise<void> {
    await this.ensureSeeded();
    this.contents = this.contents.filter((content) => content.product_id !== productId);
    write(KEYS.contents, this.contents);
    await delay(null);
  }

  // ── storefront category content (Phase 45) ──────────────────────────────
  // The demo mirror of `storefront_category_content` (0045): same shape, same
  // cascade-by-hand on category delete, same publish-only-active discipline —
  // the storefront reads these beside the ACTIVE category list, so an archived
  // category's content is unreachable by construction.

  async listCategoryContents(): Promise<StorefrontCategoryContent[]> {
    await this.ensureSeeded();
    return delay([...this.categoryContents]);
  }

  async saveCategoryContent(draft: StorefrontCategoryContentDraft): Promise<StorefrontCategoryContent> {
    await this.ensureSeeded();
    const now = nowIso();
    const existing = this.categoryContents.find((row) => row.category_id === draft.category_id);
    const saved: StorefrontCategoryContent = {
      id: existing?.id ?? newId("scc"),
      category_id: draft.category_id,
      title_ar: draft.title_ar?.trim() || null,
      title_en: draft.title_en?.trim() || null,
      description_ar: draft.description_ar?.trim() || null,
      description_en: draft.description_en?.trim() || null,
      image_url: draft.image_url?.trim() || null,
      mobile_image_url: draft.mobile_image_url?.trim() || null,
      homepage_image_url: draft.homepage_image_url?.trim() || null,
      featured: draft.featured ?? false,
      sort_order: draft.sort_order ?? 0,
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };
    this.categoryContents = existing
      ? this.categoryContents.map((row) => (row.category_id === draft.category_id ? saved : row))
      : [...this.categoryContents, saved];
    write(KEYS.categoryContents, this.categoryContents);
    return delay(saved);
  }

  async deleteCategoryContent(categoryId: string): Promise<void> {
    await this.ensureSeeded();
    this.categoryContents = this.categoryContents.filter((row) => row.category_id !== categoryId);
    write(KEYS.categoryContents, this.categoryContents);
    await delay(null);
  }

  async listFaqs(): Promise<StoreFaq[]> {
    await this.ensureSeeded();
    return delay([...this.faqs].sort((a, b) => a.sort_order - b.sort_order));
  }

  async saveFaq(draft: FaqDraft): Promise<StoreFaq> {
    await this.ensureSeeded();
    const at = nowIso();
    const existing = draft.id ? this.faqs.find((faq) => faq.id === draft.id) ?? null : null;
    const next: StoreFaq = {
      id: existing?.id ?? newId("faq"),
      question_ar: draft.question_ar ?? existing?.question_ar ?? "",
      question_en: draft.question_en ?? existing?.question_en ?? "",
      answer_ar: draft.answer_ar ?? existing?.answer_ar ?? "",
      answer_en: draft.answer_en ?? existing?.answer_en ?? "",
      sort_order: draft.sort_order ?? existing?.sort_order ?? this.faqs.length + 1,
      active: draft.active ?? existing?.active ?? true,
      created_at: existing?.created_at ?? at,
      updated_at: at,
    };
    this.faqs = existing
      ? this.faqs.map((faq) => (faq.id === next.id ? next : faq))
      : [...this.faqs, next];
    write(KEYS.faqs, this.faqs);
    return delay(next);
  }

  async deleteFaq(id: string): Promise<void> {
    await this.ensureSeeded();
    this.faqs = this.faqs.filter((faq) => faq.id !== id);
    write(KEYS.faqs, this.faqs);
    await delay(null);
  }

  async listReviews(): Promise<StoreReview[]> {
    await this.ensureSeeded();
    return delay([...this.reviews].sort((a, b) => a.sort_order - b.sort_order));
  }

  async saveReview(draft: ReviewDraft): Promise<StoreReview> {
    await this.ensureSeeded();
    const at = nowIso();
    const existing = draft.id
      ? this.reviews.find((review) => review.id === draft.id) ?? null
      : null;
    const rating = Math.min(5, Math.max(1, Math.round(draft.rating ?? existing?.rating ?? 5)));
    const next: StoreReview = {
      id: existing?.id ?? newId("rev"),
      product_id: draft.product_id ?? existing?.product_id ?? null,
      author_name: draft.author_name ?? existing?.author_name ?? "",
      rating,
      body: draft.body ?? existing?.body ?? "",
      visible: draft.visible ?? existing?.visible ?? true,
      sort_order: draft.sort_order ?? existing?.sort_order ?? this.reviews.length + 1,
      // `store_reviews` carries no updated_at: a testimonial is either shown or
      // it is not, and when it was written is the only date worth keeping.
      created_at: existing?.created_at ?? at,
    };
    this.reviews = existing
      ? this.reviews.map((review) => (review.id === next.id ? next : review))
      : [...this.reviews, next];
    write(KEYS.reviews, this.reviews);
    return delay(next);
  }

  async deleteReview(id: string): Promise<void> {
    await this.ensureSeeded();
    this.reviews = this.reviews.filter((review) => review.id !== id);
    write(KEYS.reviews, this.reviews);
    await delay(null);
  }

  async listCoupons(): Promise<Coupon[]> {
    await this.ensureSeeded();
    return delay(this.coupons);
  }

  async saveCoupon(draft: CouponDraft): Promise<Coupon> {
    await this.ensureSeeded();
    const at = nowIso();
    const existing = draft.id ? this.coupons.find((coupon) => coupon.id === draft.id) ?? null : null;
    const code = normalizeCouponCode(draft.code ?? existing?.code ?? "");
    if (!code) {
      throw new OnlineError("db", "A coupon code is required", { field: "code" });
    }
    if (this.coupons.some((coupon) => coupon.code === code && coupon.id !== existing?.id)) {
      throw new OnlineError("db", "That coupon code already exists", { field: "code" });
    }
    const next: Coupon = {
      id: existing?.id ?? newId("cpn"),
      code,
      title_en: draft.title_en ?? existing?.title_en ?? "",
      title_ar: draft.title_ar ?? existing?.title_ar ?? "",
      description_en: draft.description_en ?? existing?.description_en ?? null,
      description_ar: draft.description_ar ?? existing?.description_ar ?? null,
      discount_type: draft.discount_type ?? existing?.discount_type ?? "percent",
      value: Math.max(draft.value ?? existing?.value ?? 0, 0),
      min_subtotal: Math.max(draft.min_subtotal ?? existing?.min_subtotal ?? 0, 0),
      max_discount: draft.max_discount ?? existing?.max_discount ?? null,
      usage_limit: draft.usage_limit ?? existing?.usage_limit ?? null,
      used_count: existing?.used_count ?? 0,
      per_customer_limit: draft.per_customer_limit ?? existing?.per_customer_limit ?? null,
      first_order_only: draft.first_order_only ?? existing?.first_order_only ?? false,
      stackable: draft.stackable ?? existing?.stackable ?? false,
      applies_to: draft.applies_to ?? existing?.applies_to ?? "all",
      target_ids: draft.target_ids ?? existing?.target_ids ?? [],
      active: draft.active ?? existing?.active ?? true,
      starts_at: draft.starts_at ?? existing?.starts_at ?? null,
      ends_at: draft.ends_at ?? existing?.ends_at ?? null,
      created_at: existing?.created_at ?? at,
      updated_at: at,
    };
    this.coupons = existing
      ? this.coupons.map((coupon) => (coupon.id === next.id ? next : coupon))
      : [...this.coupons, next];
    write(KEYS.coupons, this.coupons);
    const wasActive = existing?.active ?? true;
    void recordAudit({
      action: !existing
        ? "promo_code.created"
        : wasActive && !next.active
          ? "promo_code.disabled"
          : "promo_code.changed",
      entity: "promo_code",
      entity_id: next.id,
      entity_label: next.code,
      details: {
        discount_type: next.discount_type,
        value: next.value,
        active: next.active,
        stackable: next.stackable,
        first_order_only: next.first_order_only,
      },
    });
    return delay(next);
  }

  async deleteCoupon(id: string): Promise<void> {
    await this.ensureSeeded();
    const removed = this.coupons.find((coupon) => coupon.id === id) ?? null;
    this.coupons = this.coupons.filter((coupon) => coupon.id !== id);
    write(KEYS.coupons, this.coupons);
    if (removed) {
      void recordAudit({
        action: "promo_code.changed",
        entity: "promo_code",
        entity_id: removed.id,
        entity_label: removed.code,
        details: { deleted: true },
      });
    }
    await delay(null);
  }

  async listCampaigns(): Promise<Campaign[]> {
    await this.ensureSeeded();
    return delay(this.campaigns);
  }

  async saveCampaign(draft: CampaignDraft): Promise<Campaign> {
    await this.ensureSeeded();
    const at = nowIso();
    const existing = draft.id
      ? this.campaigns.find((campaign) => campaign.id === draft.id) ?? null
      : null;
    const startsAt = draft.starts_at ?? existing?.starts_at ?? at;
    const endsAt = draft.ends_at ?? existing?.ends_at ?? at;
    if (Date.parse(endsAt) <= Date.parse(startsAt)) {
      throw new OnlineError("db", "A campaign must end after it starts", { field: "ends_at" });
    }
    const next: Campaign = {
      id: existing?.id ?? newId("cmp"),
      name_ar: draft.name_ar ?? existing?.name_ar ?? "",
      name_en: draft.name_en ?? existing?.name_en ?? "",
      kind: draft.kind ?? existing?.kind ?? "promotion",
      discount_type: draft.discount_type ?? existing?.discount_type ?? "percent",
      discount_value: Math.max(draft.discount_value ?? existing?.discount_value ?? 0, 0),
      product_ids: draft.product_ids ?? existing?.product_ids ?? [],
      badge_ar: draft.badge_ar ?? existing?.badge_ar ?? null,
      badge_en: draft.badge_en ?? existing?.badge_en ?? null,
      starts_at: startsAt,
      ends_at: endsAt,
      active: draft.active ?? existing?.active ?? true,
      created_at: existing?.created_at ?? at,
      updated_at: at,
    };
    this.campaigns = existing
      ? this.campaigns.map((campaign) => (campaign.id === next.id ? next : campaign))
      : [...this.campaigns, next];
    write(KEYS.campaigns, this.campaigns);
    return delay(next);
  }

  async deleteCampaign(id: string): Promise<void> {
    await this.ensureSeeded();
    this.campaigns = this.campaigns.filter((campaign) => campaign.id !== id);
    write(KEYS.campaigns, this.campaigns);
    await delay(null);
  }

  // ── advisory pricing: the checkout preview, nothing written ───────────────

  async previewPricing(input: PricingPreviewInput): Promise<PricingPreview> {
    await this.ensureSeeded();
    const products = await getDemoRepository().listProducts();
    const byId = new Map(products.map((product) => [product.id, product]));
    const variants = await getDemoRepository().listVariants();
    const variantById = new Map(variants.map((variant) => [variant.id, variant]));
    const priced = input.lines.map((line) => {
      const product = byId.get(line.product_id);
      if (!product) {
        throw new OnlineError("product_not_found", `Product ${line.product_id} not found`, {
          field: "lines",
        });
      }
      const variant = line.variant_id ? (variantById.get(line.variant_id) ?? null) : null;
      const now = new Date();
      const live = this.campaigns
        .filter(
          (campaign) =>
            campaign.active &&
            Date.parse(campaign.starts_at) <= now.getTime() &&
            Date.parse(campaign.ends_at) >= now.getTime() &&
            (campaign.product_ids.length === 0 || campaign.product_ids.includes(product.id)),
        )
        .sort((a, b) => b.discount_value - a.discount_value)[0];
      let unit = variant?.price_override ?? product.selling_price;
      if ((variant?.price_override ?? null) === null && live) {
        unit =
          live.discount_type === "percent"
            ? round2((unit * (100 - live.discount_value)) / 100)
            : round2(Math.max(unit - live.discount_value, 0));
      }
      const qty = Math.max(0, Math.trunc(line.qty) || 0);
      return {
        product_id: product.id,
        category_id: product.category_id,
        variant_id: variant?.id ?? null,
        qty,
        unit_price: unit,
        line_total: round2(unit * qty),
      };
    });
    const subtotal = round2(priced.reduce((sum, line) => sum + line.line_total, 0));
    // A zone is resolved when one was actually chosen; the Cart page itself
    // never requires one — it previews with the legacy delivery settings
    // (below, inside evaluateCartPricing) until a zone is picked, exactly
    // like `preview_storefront_pricing` in production, which only looks up
    // `p_zone_id` when it is not null. Requiring a zone up front here (as this
    // used to) broke the Cart-page preview for every shopper who had not yet
    // reached the checkout step and chosen one, which then silently fell back
    // to unreconciled local totals. The zone IS required to actually place a
    // delivery order — that is enforced separately in `placeOrder` below.
    const enabledZones = this.deliveryZones.filter((candidate) => candidate.enabled);
    let zone: DeliveryZone | null = null;
    if (input.deliveryType === "delivery" && input.deliveryZoneId) {
      zone = enabledZones.find((candidate) => candidate.id === input.deliveryZoneId) ?? null;
      if (!zone) {
        throw new OnlineError("delivery_unavailable", "Delivery zone is not available", {
          field: "delivery_type",
        });
      }
    }
    const settings = resolveSettings(this.settingsDoc.settings).delivery;
    const evaluated = evaluateCartPricing({
      lines: priced,
      subtotal,
      promoCode: input.couponCode ?? null,
      coupons: this.coupons,
      promotions: this.promotions,
      targetsByPromotion: this.targetsByPromotion(),
      usageFor: (couponId) => this.usageSummary(couponId, input.customerKey ?? null),
      customerKey: input.customerKey ?? null,
      zone,
      legacy: {
        fee: settings.fee,
        minimum: settings.minimum_order ?? 0,
        threshold: settings.free_delivery_threshold ?? 0,
      },
      deliveryType: input.deliveryType,
    });
    if (!evaluated.ok) {
      throw this.pricingRefusal(evaluated.reason, evaluated.message, input.couponCode);
    }
    const pricing = evaluated.pricing;
    return delay({
      subtotal: pricing.subtotal,
      autoDiscount: pricing.autoDiscount,
      autoPromotionId: pricing.autoPromotionId,
      autoPromotionName: pricing.autoPromotionName,
      promoCode: pricing.promoCode,
      promoValid: pricing.promoCode !== null,
      promoReason: null,
      promoDiscount: pricing.promoDiscount,
      promoFreeShipping: pricing.promoFreeShipping,
      deliveryFee: pricing.deliveryFee,
      shippingDiscount: pricing.shippingDiscount,
      shippingSource: pricing.shippingSource,
      zoneId: pricing.zoneId,
      zoneName: pricing.zoneName,
      totalDiscount: pricing.totalDiscount,
      total: pricing.total,
      lines: pricing.lines.map((line) => ({
        product_id: line.product_id,
        variant_id: line.variant_id,
        qty: line.qty,
        unit_price: line.unit_price,
        line_total: line.line_total,
        discounted_unit_price: line.discounted_unit_price,
        promotion_id: line.promotion_id ?? null,
        promotion_name: line.promotion_name ?? null,
        rewarded_units: line.rewarded_units ?? 0,
      })),
    });
  }

  /** Targets grouped by promotion as `kind:id`, for the pricing engine. */
  private targetsByPromotion(): Map<string, Set<string>> {
    const plain = new Map<string, Set<string>>();
    for (const target of this.promotionTargets) {
      const set = plain.get(target.promotion_id) ?? new Set<string>();
      set.add(`${target.target_kind}:${target.target_id}`);
      plain.set(target.promotion_id, set);
    }
    return plain;
  }

  /** A pricing refusal with live mode's code and wording. */
  private pricingRefusal(reason: string, message: string, code?: string | null): OnlineError {
    // The zone/legacy minimum speaks for itself in both modes (the server
    // raises the same sentence, mapped to the same code).
    if (message.startsWith("Delivery orders need at least")) {
      const minimum = Number(/at least ([\d.]+)/.exec(message)?.[1] ?? 0);
      return new OnlineError("delivery_minimum_not_met", message, {
        field: "delivery_type",
        detail: { minimum: Number.isFinite(minimum) ? minimum : 0 },
      });
    }
    if (reason === "not_applicable" && !code) {
      return new OnlineError("delivery_unavailable", message, { field: "delivery_type" });
    }
    if (reason === "not_applicable" && !code) {
      return new OnlineError("delivery_unavailable", message, { field: "delivery_type" });
    }
    if (reason === "limit_reached") {
      return new OnlineError("coupon_limit_reached", message, { field: "coupon_code" });
    }
    const couponCodes: Record<string, OnlineError["code"]> = {
      not_found: "coupon_invalid",
      inactive: "coupon_invalid",
      not_started: "coupon_not_started",
      expired: "coupon_expired",
      exhausted: "coupon_limit_reached",
      min_subtotal: "coupon_min_subtotal",
      not_applicable: "coupon_not_applicable",
    };
    return new OnlineError(couponCodes[reason] ?? "coupon_invalid", message, {
      field: "coupon_code",
      detail: { reason },
    });
  }

  // ── delivery zones: the admin owns the per-governorate pricing ────────────

  async listDeliveryZones(): Promise<DeliveryZone[]> {
    await this.ensureSeeded();
    return delay(this.sortedZones());
  }

  async saveDeliveryZone(draft: DeliveryZoneDraft): Promise<DeliveryZone> {
    await this.ensureSeeded();
    const at = nowIso();
    const existing = draft.id
      ? (this.deliveryZones.find((zone) => zone.id === draft.id) ?? null)
      : null;
    const key = (draft.key ?? existing?.key ?? "").trim().toLowerCase();
    if (!key) throw new OnlineError("db", "A zone needs a key", { field: "key" });
    if (this.deliveryZones.some((zone) => zone.key === key && zone.id !== existing?.id)) {
      throw new OnlineError("db", "That zone key already exists", { field: "key" });
    }
    const next: DeliveryZone = {
      id: existing?.id ?? newId("dz"),
      key,
      name_en: draft.name_en ?? existing?.name_en ?? "",
      name_ar: draft.name_ar ?? existing?.name_ar ?? "",
      governorate_key: draft.governorate_key ?? existing?.governorate_key ?? null,
      shipping_fee: Math.max(draft.shipping_fee ?? existing?.shipping_fee ?? 0, 0),
      minimum_order_amount: Math.max(draft.minimum_order_amount ?? existing?.minimum_order_amount ?? 0, 0),
      free_shipping_threshold:
        draft.free_shipping_threshold ?? existing?.free_shipping_threshold ?? null,
      estimated_delivery_text_en:
        draft.estimated_delivery_text_en ?? existing?.estimated_delivery_text_en ?? null,
      estimated_delivery_text_ar:
        draft.estimated_delivery_text_ar ?? existing?.estimated_delivery_text_ar ?? null,
      show_estimated_delivery: draft.show_estimated_delivery ?? existing?.show_estimated_delivery ?? true,
      enabled: draft.enabled ?? existing?.enabled ?? true,
      sort_order: draft.sort_order ?? existing?.sort_order ?? 0,
      created_at: existing?.created_at ?? at,
      updated_at: at,
    };
    if (!next.name_en.trim() || !next.name_ar.trim()) {
      throw new OnlineError("db", "A zone needs names in both languages", { field: "name_en" });
    }
    this.deliveryZones = existing
      ? this.deliveryZones.map((zone) => (zone.id === next.id ? next : zone))
      : [...this.deliveryZones, next];
    write(KEYS.deliveryZones, this.deliveryZones);
    void recordAudit({
      action: existing ? "delivery_zone.changed" : "delivery_zone.created",
      entity: "delivery_zone",
      entity_id: next.id,
      entity_label: next.name_en,
      details: { key: next.key, shipping_fee: next.shipping_fee, enabled: next.enabled },
    });
    return delay(next);
  }

  async deleteDeliveryZone(id: string): Promise<void> {
    await this.ensureSeeded();
    const removed = this.deliveryZones.find((zone) => zone.id === id) ?? null;
    this.deliveryZones = this.deliveryZones.filter((zone) => zone.id !== id);
    write(KEYS.deliveryZones, this.deliveryZones);
    if (removed) {
      void recordAudit({
        action: "delivery_zone.changed",
        entity: "delivery_zone",
        entity_id: removed.id,
        entity_label: removed.name_en,
        details: { key: removed.key, deleted: true },
      });
    }
    await delay(null);
  }

  // ── automatic promotions: codeless discounts ──────────────────────────────

  async listPromotions(): Promise<Promotion[]> {
    await this.ensureSeeded();
    return delay(this.promotions);
  }

  async listPromotionTargets(promotionId: string): Promise<PromotionTarget[]> {
    await this.ensureSeeded();
    return delay(this.promotionTargets.filter((target) => target.promotion_id === promotionId));
  }

  async savePromotion(draft: PromotionDraft, targets: PromotionTargetDraft[]): Promise<Promotion> {
    await this.ensureSeeded();
    const at = nowIso();
    const existing = draft.id
      ? (this.promotions.find((promotion) => promotion.id === draft.id) ?? null)
      : null;
    // An admin edit may deliberately clear a schedule. `??` would silently
    // retain the old timestamp and make a just-reactivated coupon look stale.
    const startsAt = Object.prototype.hasOwnProperty.call(draft, "starts_at")
      ? (draft.starts_at ?? null)
      : (existing?.starts_at ?? null);
    const endsAt = Object.prototype.hasOwnProperty.call(draft, "ends_at")
      ? (draft.ends_at ?? null)
      : (existing?.ends_at ?? null);
    if (startsAt && endsAt && Date.parse(endsAt) < Date.parse(startsAt)) {
      throw new OnlineError("db", "A promotion must end after it starts", { field: "ends_at" });
    }
    const scope = draft.scope ?? existing?.scope ?? "store";
    const cleanTargets =
      scope === "store"
        ? []
        : targets.filter((target) => target.target_id.trim()).map((target) => ({
            promotion_id: "",
            target_kind: target.target_kind,
            target_id: target.target_id.trim(),
            created_at: at,
          }));
    if (scope !== "store" && cleanTargets.length === 0) {
      throw new OnlineError("db", "A targeted promotion needs at least one target", {
        field: "scope",
      });
    }
    const wasEnabled = existing?.enabled ?? false;
    const mode = draft.mode ?? existing?.mode ?? "automatic";
    const code =
      mode === "coupon"
        ? (draft.code ? draft.code.trim().toUpperCase().replace(/\s+/g, "") : (existing?.code ?? null))
        : null;
    if (mode === "coupon" && (!code || !/^[A-Z0-9_-]{2,30}$/.test(code))) {
      throw new OnlineError("db", "A valid coupon code is required for coupon mode", { field: "code" });
    }
    if (mode === "coupon" && code) {
      const dup = this.promotions.find(
        (p) => p.id !== (existing?.id ?? draft.id) && p.mode === "coupon" && p.code && p.code.trim().toUpperCase().replace(/\s+/g, "") === code,
      );
      if (dup) {
        throw new OnlineError("db", "A coupon with this code already exists", { field: "code" });
      }
    }
    const offerType = draft.offer_type ?? draft.rule_type ?? existing?.offer_type ?? existing?.rule_type ?? "standard";
    const next: Promotion = {
      id: existing?.id ?? newId("prm"),
      enabled: draft.enabled ?? existing?.enabled ?? true,
      mode,
      code,
      channel: draft.channel ?? existing?.channel ?? "both",
      name_en: draft.name_en ?? existing?.name_en ?? "",
      name_ar: draft.name_ar ?? existing?.name_ar ?? "",
      description_en: draft.description_en ?? existing?.description_en ?? null,
      description_ar: draft.description_ar ?? existing?.description_ar ?? null,
      offer_type: offerType,
      rule_type: offerType,
      discount_type: draft.discount_type ?? existing?.discount_type ?? "percent",
      value: Math.max(draft.value ?? existing?.value ?? 0, 0),
      scope,
      minimum_order_amount: Math.max(draft.minimum_order_amount ?? existing?.minimum_order_amount ?? 0, 0),
      maximum_discount_amount: draft.maximum_discount_amount ?? existing?.maximum_discount_amount ?? null,
      starts_at: startsAt,
      ends_at: endsAt,
      priority: draft.priority ?? existing?.priority ?? 0,
      stackable: draft.stackable ?? existing?.stackable ?? false,
      buy_x: draft.buy_x ?? existing?.buy_x ?? null,
      get_y: draft.get_y ?? existing?.get_y ?? null,
      reward_type: draft.reward_type ?? existing?.reward_type ?? "free",
      reward_value: draft.reward_value ?? existing?.reward_value ?? null,
      repeat_offer: draft.repeat_offer ?? existing?.repeat_offer ?? true,
      min_quantity: draft.min_quantity ?? existing?.min_quantity ?? null,
      created_at: existing?.created_at ?? at,
      updated_at: at,
    };
    if (!next.name_en.trim() || !next.name_ar.trim()) {
      throw new OnlineError("db", "A promotion needs names in both languages", { field: "name_en" });
    }
    if (offerType === "standard") {
      if (next.discount_type === "percent" && (next.value <= 0 || next.value > 100)) {
        throw new OnlineError("db", "Percentage discount must be between 0 and 100", { field: "value" });
      }
      if (next.discount_type === "fixed" && next.value <= 0) {
        throw new OnlineError("db", "A promotion needs a positive value", { field: "value" });
      }
    }
    this.promotions = existing
      ? this.promotions.map((promotion) => (promotion.id === next.id ? next : promotion))
      : [...this.promotions, next];
    this.promotionTargets = [
      ...this.promotionTargets.filter((target) => target.promotion_id !== next.id),
      ...cleanTargets.map((target) => ({ ...target, promotion_id: next.id })),
    ];
    write(KEYS.promotions, this.promotions);
    write(KEYS.promotionTargets, this.promotionTargets);
    const statusFlipped = existing && wasEnabled !== next.enabled;
    void recordAudit({
      action: !existing
        ? "promotion.created"
        : statusFlipped
          ? next.enabled
            ? "promotion.activated"
            : "promotion.deactivated"
          : "promotion.changed",
      entity: "promotion",
      entity_id: next.id,
      entity_label: next.name_en,
      details: { scope: next.scope, value: next.value, enabled: next.enabled },
    });
    return delay(next);
  }

  async deletePromotion(id: string): Promise<void> {
    await this.ensureSeeded();
    const removed = this.promotions.find((promotion) => promotion.id === id) ?? null;
    this.promotions = this.promotions.filter((promotion) => promotion.id !== id);
    this.promotionTargets = this.promotionTargets.filter((target) => target.promotion_id !== id);
    write(KEYS.promotions, this.promotions);
    write(KEYS.promotionTargets, this.promotionTargets);
    if (removed) {
      void recordAudit({
        action: "promotion.changed",
        entity: "promotion",
        entity_id: removed.id,
        entity_label: removed.name_en,
        details: { scope: removed.scope, deleted: true },
      });
    }
    await delay(null);
  }

  async listPromoCodeUsages(couponId?: string): Promise<PromoCodeUsage[]> {
    await this.ensureSeeded();
    return delay(
      couponId ? this.promoUsages.filter((usage) => usage.coupon_id === couponId) : this.promoUsages,
    );
  }

  // ── website accounts ──────────────────────────────────────────────────────
  //
  // Delegated to the shared local account store: the same code serves demo and
  // live mode, because website accounts never touch Supabase Auth (see
  // `localAccounts.ts` for why). The demo repository only adds the part that is
  // genuinely its own — an order history that can be read straight out of its
  // in-memory list, since it wrote every order there itself.

  private readonly accounts = getLocalStoreAccounts("demo");

  register(input: {
    name: string;
    phone: string;
    email?: string | null;
    password: string;
  }): Promise<StoreCustomer> {
    return this.accounts.register(input);
  }

  login(input: { identifier: string; password: string }): Promise<StoreCustomer> {
    return this.accounts.login(input);
  }

  logout(): Promise<void> {
    return this.accounts.logout();
  }

  current(): Promise<StoreCustomer | null> {
    return this.accounts.current();
  }

  update(id: string, patch: StoreCustomerPatch): Promise<StoreCustomer> {
    return this.accounts.update(id, patch);
  }

  uploadProofImage(file: File): Promise<string> {
    return this.accounts.uploadProofImage(file);
  }

  rememberOrder(
    customerId: string | null,
    orderNumber: string,
    phone: string,
  ): Promise<void> {
    return this.accounts.rememberOrder(customerId, orderNumber, phone);
  }

  /** The order references this account placed — used when the list is empty. */
  placedRefs(customerId: string | null) {
    return this.accounts.placedRefs(customerId);
  }
}

// ── address helpers (used by the account page and checkout) ─────────────────

export function newAddressId(): string {
  return newId("adr");
}

/** A blank address for the "add address" form. */
export function emptyAddress(): CustomerAddress {
  return {
    id: newAddressId(),
    label: "",
    full_name: "",
    phone: "",
    city: "",
    area: "",
    street: "",
    building: "",
    floor: "",
    apartment: "",
    is_default: false,
    notes: null,
  };
}

/** Keep exactly one default address — the one the customer marked, else the first. */
export function normalizeAddresses(addresses: readonly CustomerAddress[]): CustomerAddress[] {
  const list = addresses.filter((address) =>
    address.full_name.trim() || address.street.trim() || address.city.trim(),
  );
  const hasDefault = list.some((address) => address.is_default);
  return list.map((address, index) => ({
    ...address,
    is_default: hasDefault ? address.is_default : index === 0,
  }));
}

let singleton: DemoOnlineRepository | null = null;

export function getDemoOnlineRepository(): DemoOnlineRepository {
  if (!singleton) singleton = new DemoOnlineRepository();
  return singleton;
}

/** Test hook: drop the in-memory state so a suite starts from storage alone. */
export function resetDemoOnlineRepository(): void {
  singleton = null;
  inFlight = false;
}
