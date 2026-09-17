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
import { safeStorage } from "@/modules/products/data/demoSeed";
import { getDemoSalesRepository } from "@/modules/pos/data/demoRepository";
import type {
  Campaign,
  Coupon,
  CustomerAddress,
  OnlineOrder,
  OnlineOrderItem,
  OrderEvent,
  OrderEventKind,
  PaymentProofInput,
  PlaceOrderInput,
  ProductContent,
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
import { formatOrderNumber } from "../types";
import {
  DEFAULT_WEBSITE_SETTINGS,
  mergeSettings,
  resolveSettings,
} from "../services/settingsDefaults";
import {
  checkCoupon,
  deliveryAreaSupported,
  deliveryFeeFor,
  deliveryMinimumShortfall,
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
  type FaqDraft,
  type MarketingSnapshot,
  type OnlineOrderFilter,
  type OrderCounts,
  type PlaceOrderResult,
  type ProductContentDraft,
  type ReviewDraft,
  type StoreCustomerPatch,
  type WebsiteSnapshot,
  type OnlineOrdersRepository,
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

  if (safeStorage.get(KEYS.coupons) === null) {
    const coupons: Coupon[] = [
      {
        id: newId("cpn"),
        code: "WELCOME10",
        discount_type: "percent",
        value: 10,
        min_subtotal: 200,
        max_discount: 150,
        usage_limit: 100,
        used_count: 0,
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
  private coupons: Coupon[] = readArray<Coupon>(KEYS.coupons);
  private campaigns: Campaign[] = readArray<Campaign>(KEYS.campaigns);
  private seeded = false;

  /** Seed once per session, after the catalogue demo repo has its own data. */
  private async ensureSeeded(): Promise<Product[]> {
    const products = await getDemoRepository().listProducts();
    if (!this.seeded && safeStorage.get(KEYS.seeded) !== "1") {
      seedContent(products);
      safeStorage.set(KEYS.seeded, "1");
      // Re-read what the seed wrote.
      this.contents = readArray<ProductContent>(KEYS.contents);
      this.faqs = readArray<StoreFaq>(KEYS.faqs);
      this.reviews = readArray<StoreReview>(KEYS.reviews);
      this.coupons = readArray<Coupon>(KEYS.coupons);
      this.campaigns = readArray<Campaign>(KEYS.campaigns);
      this.settingsDoc = readObject(KEYS.settings) ?? this.settingsDoc;
      this.seeded = true;
    } else {
      this.seeded = true;
    }
    return products;
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

  async getOrder(id: string): Promise<OnlineOrder> {
    await this.ensureSeeded();
    const order = this.orders.find((candidate) => candidate.id === id);
    if (!order) throw new OnlineError("order_not_found", `Order ${id} not found`);
    return delay(order);
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
        if (!deliveryAreaSupported(settings.delivery, city, area)) {
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
        coupon,
        delivery: settings.delivery,
        deliveryType: input.delivery_type,
      });

      if (coupon) {
        const check = checkCoupon(coupon, {
          subtotal: totals.subtotal,
          lines: totals.lines.map((line) => ({
            product_id: line.product_id,
            category_id: byId.get(line.product_id)?.category_id ?? null,
            line_total: line.line_total,
          })),
        });
        if (!check.ok) {
          const codeByReason: Record<string, "coupon_invalid" | "coupon_expired" | "coupon_not_started" | "coupon_limit_reached" | "coupon_min_subtotal"> = {
            inactive: "coupon_invalid",
            not_found: "coupon_invalid",
            not_applicable: "coupon_invalid",
            expired: "coupon_expired",
            not_started: "coupon_not_started",
            exhausted: "coupon_limit_reached",
            min_subtotal: "coupon_min_subtotal",
          };
          throw new OnlineError(
            codeByReason[check.reason] ?? "coupon_invalid",
            `Coupon ${coupon.code} cannot be used`,
            { field: "coupon_code", detail: { reason: check.reason } },
          );
        }
      }

      // The shop's minimum for delivery, measured on the goods total after the
      // coupon — and only for delivery: collecting in person is how a customer
      // orders less than the delivery minimum.
      const goodsTotal = round2(totals.subtotal - totals.discount_amount);
      const shortfall = deliveryMinimumShortfall(
        settings.delivery,
        input.delivery_type,
        goodsTotal,
      );
      if (shortfall > 0) {
        throw new OnlineError(
          "delivery_minimum_not_met",
          `Delivery orders need at least ${settings.delivery.minimum_order ?? 0}`,
          { field: "delivery_type", detail: { minimum: settings.delivery.minimum_order, shortfall } },
        );
      }

      // The delivery fee is the shop's number, never the cart's.
      const deliveryFee = deliveryFeeFor(
        settings.delivery,
        input.delivery_type,
        round2(totals.subtotal - totals.discount_amount),
      );

      const orderId = newId("ord");
      this.counter += 1;
      const at = nowIso();

      const items: OnlineOrderItem[] = totals.lines.map((line) => {
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
          quantity: line.quantity,
          line_total: line.line_total,
        };
      });

      const order: OnlineOrder = {
        id: orderId,
        order_number: formatOrderNumber(this.counter),
        client_ref: input.client_ref,
        store_customer_id: input.store_customer_id ?? null,
        customer_name: name,
        customer_phone: phone,
        customer_email: input.customer_email?.trim() || null,
        delivery_type: input.delivery_type,
        address: input.delivery_type === "delivery" ? input.address : null,
        subtotal: totals.subtotal,
        discount_code: coupon ? coupon.code : null,
        discount_amount: totals.discount_amount,
        delivery_fee: deliveryFee,
        total: round2(totals.subtotal - totals.discount_amount + deliveryFee),
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

      // A code is consumed when it is used, and given back if the order dies.
      if (coupon) {
        this.coupons = this.coupons.map((candidate) =>
          candidate.id === coupon?.id
            ? { ...candidate, used_count: candidate.used_count + 1, updated_at: at }
            : candidate,
        );
        write(KEYS.coupons, this.coupons);
      }

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
    const check = checkAction(order, input.action, { canVoidSale: true });
    if (!check.ok) {
      throw new OnlineError("workflow_refused", `Cannot ${input.action} this order`, {
        detail: { reason: check.reason, action: input.action },
      });
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

          if (order.sale_id) {
            await getDemoSalesRepository().voidSale(order.sale_id, {
              user_id: input.user_id,
              user_name: input.user_name,
              reason: `Online order ${order.order_number} cancelled${reason ? `: ${reason}` : ""}`,
            });
          }

          if (order.discount_code) {
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
          next = { ...next, status: "processing" };
          push("processing", "Order is being prepared");
          break;

        case "ready":
          next = {
            ...next,
            status: "ready",
          };
          push(
            "ready",
            order.delivery_type === "pickup"
              ? "Order is ready for pickup"
              : "Order is ready for delivery",
          );
          break;

        case "complete":
          next = { ...next, status: "completed", completed_at: at };
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
    // No coupons here: a visitor never sees the code list, in either mode.
    return delay({
      settings: this.settings(),
      meta: this.settingsDoc.meta,
      contents: this.contents,
      faqs: [...this.faqs].sort((a, b) => a.sort_order - b.sort_order),
      reviews: [...this.reviews].sort((a, b) => a.sort_order - b.sort_order),
      campaigns: this.campaigns,
      categoryContents: [...this.categoryContents],
    });
  }

  async getMarketing(): Promise<MarketingSnapshot> {
    await this.ensureSeeded();
    return delay({ coupons: this.coupons, campaigns: this.campaigns });
  }

  async checkCoupon(input: CouponCheckInput): Promise<CouponCheckResult> {
    await this.ensureSeeded();
    const code = normalizeCouponCode(input.code);
    if (!code) return { valid: false, reason: "not_found" };
    const coupon = this.coupons.find((candidate) => candidate.code === code) ?? null;
    if (!coupon) return { valid: false, reason: "not_found" };

    const check = checkCoupon(coupon, {
      subtotal: round2(Math.max(input.subtotal, 0)),
      lines: input.productIds.map((productId, index) => ({
        product_id: productId,
        category_id: input.categoryIds[index] ?? null,
        line_total: 0,
      })),
    });
    if (!check.ok) {
      // The local vocabulary is finer than the storefront's; both mean "no".
      const reason: CouponCheckReason =
        check.reason === "inactive" || check.reason === "not_found"
          ? "invalid"
          : (check.reason as CouponCheckReason);
      return {
        valid: false,
        reason,
        ...(reason === "min_subtotal" ? { minSubtotal: coupon.min_subtotal } : {}),
      };
    }
    return {
      valid: true,
      code: coupon.code,
      discount: check.discount,
      discountType: coupon.discount_type,
      value: coupon.value,
    };
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
    const merged = mergeSettings(DEFAULT_WEBSITE_SETTINGS, input.settings as unknown);
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
      discount_type: draft.discount_type ?? existing?.discount_type ?? "percent",
      value: Math.max(draft.value ?? existing?.value ?? 0, 0),
      min_subtotal: Math.max(draft.min_subtotal ?? existing?.min_subtotal ?? 0, 0),
      max_discount: draft.max_discount ?? existing?.max_discount ?? null,
      usage_limit: draft.usage_limit ?? existing?.usage_limit ?? null,
      used_count: existing?.used_count ?? 0,
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
    return delay(next);
  }

  async deleteCoupon(id: string): Promise<void> {
    await this.ensureSeeded();
    this.coupons = this.coupons.filter((coupon) => coupon.id !== id);
    write(KEYS.coupons, this.coupons);
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
