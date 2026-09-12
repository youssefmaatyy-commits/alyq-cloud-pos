/**
 * Live Supabase implementation of the online storefront repositories.
 *
 * Every operation that moves money or stock goes through a Postgres function
 * (migration 0018) rather than a client-side write, because that is where the
 * guarantees live: `place_online_order` re-prices from the catalogue and checks
 * availability against outstanding reservations; `resolve_online_order` refuses
 * an illegal state change, converts the reservation into a real deduction and
 * creates the POS sale in one transaction. This file's job is to send the right
 * payload and to map what comes back — including what comes back as an error —
 * into something the UI can act on.
 *
 * Reads are plain selects under row-level security: staff see orders when they
 * hold `manage_online_orders`, shoppers see storefront content because it is
 * public, and nobody can select their way into someone else's order.
 */
import { getSupabaseClient } from "@/lib/supabase/client";
import type {
  Campaign,
  Coupon,
  CustomerAddress,
  OnlineOrder,
  OnlineOrderItem,
  OnlinePaymentMethod,
  OrderEvent,
  PaymentProofInput,
  PlaceOrderInput,
  ProductContent,
  ProductSpec,
  ResolveOrderInput,
  SettingsSaveInput,
  StockReservation,
  StoreCustomer,
  StoreFaq,
  StoreReview,
  WebsiteSettings,
  WebsiteSettingsMeta,
} from "../types";
import { resolveSettings } from "../services/settingsDefaults";
import { normalizeCouponCode } from "../services/pricing";
import { slugifyAscii } from "../services/seo";
import { getLocalStoreAccounts } from "./localAccounts";
import {
  COUPON_CHECK_REASONS,
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
  type OnlineMode,
  type OnlineOrderFilter,
  type OnlineOrdersRepository,
  type OrderCounts,
  type PlaceOrderResult,
  type ProductContentDraft,
  type ReviewDraft,
  type StoreAccountsRepository,
  type StoreCustomerPatch,
  type WebsiteRepository,
  type WebsiteSnapshot,
} from "./repository";

// ── row shapes ──────────────────────────────────────────────────────────────

type Numeric = number | string | null;

interface OnlineOrderRow {
  id: string;
  order_number: string;
  client_ref: string;
  store_customer_id: string | null;
  customer_name: string;
  customer_phone: string;
  customer_email: string | null;
  delivery_type: OnlineOrder["delivery_type"];
  address: Partial<CustomerAddress> | Record<string, never> | null;
  subtotal: Numeric;
  discount_code: string | null;
  discount_amount: Numeric;
  delivery_fee: Numeric;
  total: Numeric;
  payment_method: string;
  payment_status: OnlineOrder["payment_status"];
  status: OnlineOrder["status"];
  payment_reference: string | null;
  payment_proof_url: string | null;
  payment_submitted_at: string | null;
  payment_verified_by: string | null;
  payment_verified_by_name: string | null;
  payment_verified_at: string | null;
  payment_rejected_reason: string | null;
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
}

interface OnlineOrderItemRow {
  id: string;
  order_id: string;
  product_id: string;
  name_ar: string;
  name_en: string;
  sku: string;
  barcode: string | null;
  unit_price: Numeric;
  quantity: number;
  line_total: Numeric;
}

interface OrderEventRow {
  id: string;
  order_id: string;
  kind: OrderEvent["kind"];
  note: string | null;
  user_id: string | null;
  user_name: string | null;
  created_at: string;
}

interface StockReservationRow {
  id: string;
  online_order_id: string;
  product_id: string;
  quantity: number;
  status: StockReservation["status"];
  created_at: string;
  resolved_at: string | null;
}

interface ProductContentRow {
  product_id: string;
  brand_ar: string | null;
  brand_en: string | null;
  slug: string | null;
  seo_title: string | null;
  seo_description: string | null;
  specs: ProductSpec[] | null;
  created_at: string;
  updated_at: string;
}

interface StoreFaqRow {
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

interface StoreReviewRow {
  id: string;
  product_id: string | null;
  author_name: string;
  rating: number;
  body: string;
  visible: boolean;
  sort_order: number;
  created_at: string;
}

interface CouponRow {
  id: string;
  code: string;
  discount_type: Coupon["discount_type"];
  value: Numeric;
  min_subtotal: Numeric;
  max_discount: Numeric;
  usage_limit: number | null;
  used_count: number;
  applies_to: Coupon["applies_to"];
  target_ids: string[] | null;
  active: boolean;
  starts_at: string | null;
  ends_at: string | null;
  created_at: string;
  updated_at: string;
}

interface CampaignRow {
  id: string;
  name_ar: string;
  name_en: string;
  kind: Campaign["kind"];
  discount_type: Campaign["discount_type"];
  discount_value: Numeric;
  product_ids: string[] | null;
  badge_ar: string | null;
  badge_en: string | null;
  starts_at: string;
  ends_at: string;
  active: boolean;
  created_at: string;
  updated_at: string;
}

interface WebsiteSettingsRow {
  id: number;
  settings: unknown;
  updated_at: string;
  updated_by: string | null;
  updated_by_name: string | null;
}

// ── mapping ─────────────────────────────────────────────────────────────────

/** Postgres numerics arrive as strings; the domain model wants numbers. */
function toNumber(value: Numeric): number {
  if (typeof value === "number") return value;
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** The website only ever uses two of the POS payment methods. */
function toOnlinePaymentMethod(value: string): OnlinePaymentMethod {
  return value === "cod" ? "cod" : "instapay";
}

/**
 * A pickup order stores `{}` for its address (the column is `not null`), and an
 * empty object is not an address — mapping it to `null` keeps the checkout form
 * and the order screen from rendering a row of blanks.
 */
function toAddress(raw: OnlineOrderRow["address"]): CustomerAddress | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Partial<CustomerAddress>;
  const hasContent = Object.values(value).some(
    (field) => typeof field === "string" ? field.trim().length > 0 : field === true,
  );
  if (!hasContent) return null;
  return {
    id: value.id ?? "",
    label: value.label ?? "",
    full_name: value.full_name ?? "",
    phone: value.phone ?? "",
    city: value.city ?? "",
    area: value.area ?? "",
    street: value.street ?? "",
    building: value.building ?? "",
    floor: value.floor ?? "",
    apartment: value.apartment ?? "",
    is_default: value.is_default ?? false,
    notes: value.notes ?? null,
  };
}

function mapItem(row: OnlineOrderItemRow): OnlineOrderItem {
  return {
    id: row.id,
    order_id: row.order_id,
    product_id: row.product_id,
    name_ar: row.name_ar,
    name_en: row.name_en,
    sku: row.sku,
    barcode: row.barcode ?? null,
    unit_price: toNumber(row.unit_price),
    quantity: row.quantity,
    line_total: toNumber(row.line_total),
  };
}

function mapEvent(row: OrderEventRow): OrderEvent {
  return {
    id: row.id,
    order_id: row.order_id,
    kind: row.kind,
    note: row.note ?? null,
    user_id: row.user_id ?? null,
    user_name: row.user_name ?? null,
    created_at: row.created_at,
  };
}

function mapOrder(
  row: OnlineOrderRow,
  items: OnlineOrderItemRow[] = [],
  events: OrderEventRow[] = [],
): OnlineOrder {
  return {
    id: row.id,
    order_number: row.order_number,
    client_ref: row.client_ref,
    store_customer_id: row.store_customer_id ?? null,
    customer_name: row.customer_name,
    customer_phone: row.customer_phone,
    customer_email: row.customer_email ?? null,
    delivery_type: row.delivery_type,
    address: toAddress(row.address),
    subtotal: toNumber(row.subtotal),
    discount_code: row.discount_code ?? null,
    discount_amount: toNumber(row.discount_amount),
    delivery_fee: toNumber(row.delivery_fee),
    total: toNumber(row.total),
    payment_method: toOnlinePaymentMethod(row.payment_method),
    payment_status: row.payment_status,
    status: row.status,
    payment_reference: row.payment_reference ?? null,
    payment_proof_url: row.payment_proof_url ?? null,
    payment_submitted_at: row.payment_submitted_at ?? null,
    payment_verified_by: row.payment_verified_by ?? null,
    payment_verified_by_name: row.payment_verified_by_name ?? null,
    payment_verified_at: row.payment_verified_at ?? null,
    payment_rejected_reason: row.payment_rejected_reason ?? null,
    sale_id: row.sale_id ?? null,
    sale_number: row.sale_number ?? null,
    notes: row.notes ?? null,
    cancellation_reason: row.cancellation_reason ?? null,
    approved_by: row.approved_by ?? null,
    approved_by_name: row.approved_by_name ?? null,
    approved_at: row.approved_at ?? null,
    cancelled_by: row.cancelled_by ?? null,
    cancelled_by_name: row.cancelled_by_name ?? null,
    cancelled_at: row.cancelled_at ?? null,
    completed_at: row.completed_at ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    items: items.map(mapItem),
    events: events.map(mapEvent),
  };
}

function mapReservation(row: StockReservationRow): StockReservation {
  return {
    id: row.id,
    online_order_id: row.online_order_id,
    product_id: row.product_id,
    quantity: row.quantity,
    status: row.status,
    created_at: row.created_at,
    resolved_at: row.resolved_at ?? null,
  };
}

function mapContent(row: ProductContentRow): ProductContent {
  return {
    product_id: row.product_id,
    brand_ar: row.brand_ar ?? null,
    brand_en: row.brand_en ?? null,
    slug: row.slug ?? null,
    seo_title: row.seo_title ?? null,
    seo_description: row.seo_description ?? null,
    specs: Array.isArray(row.specs) ? row.specs : [],
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function mapCoupon(row: CouponRow): Coupon {
  return {
    id: row.id,
    code: row.code,
    discount_type: row.discount_type,
    value: toNumber(row.value),
    min_subtotal: toNumber(row.min_subtotal),
    max_discount: row.max_discount == null ? null : toNumber(row.max_discount),
    usage_limit: row.usage_limit ?? null,
    used_count: row.used_count ?? 0,
    applies_to: row.applies_to,
    target_ids: Array.isArray(row.target_ids) ? row.target_ids : [],
    active: row.active,
    starts_at: row.starts_at ?? null,
    ends_at: row.ends_at ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function mapCampaign(row: CampaignRow): Campaign {
  return {
    id: row.id,
    name_ar: row.name_ar,
    name_en: row.name_en,
    kind: row.kind,
    discount_type: row.discount_type,
    discount_value: toNumber(row.discount_value),
    product_ids: Array.isArray(row.product_ids) ? row.product_ids : [],
    badge_ar: row.badge_ar ?? null,
    badge_en: row.badge_en ?? null,
    starts_at: row.starts_at,
    ends_at: row.ends_at,
    active: row.active,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function groupBy<T>(rows: readonly T[], key: (row: T) => string): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const row of rows) {
    const id = key(row);
    const list = grouped.get(id) ?? [];
    list.push(row);
    grouped.set(id, list);
  }
  return grouped;
}

// ── repository ──────────────────────────────────────────────────────────────

export class SupabaseOnlineRepository
  implements OnlineOrdersRepository, WebsiteRepository, StoreAccountsRepository
{
  readonly kind: OnlineMode = "supabase";

  /** Website accounts stay local in both modes — see `localAccounts.ts`. */
  private readonly accounts = getLocalStoreAccounts("supabase");

  private require() {
    const client = getSupabaseClient();
    if (!client) throw new OnlineError("not_configured");
    return client;
  }

  // ── orders: staff side ────────────────────────────────────────────────────

  async listOrders(filter: Partial<OnlineOrderFilter> = {}): Promise<OnlineOrder[]> {
    try {
      const client = this.require();
      let query = client.from("online_orders").select("*");

      if (filter.status && filter.status !== "all") query = query.eq("status", filter.status);
      if (filter.paymentStatus && filter.paymentStatus !== "all") {
        query = query.eq("payment_status", filter.paymentStatus);
      }
      const search = (filter.search ?? "").trim();
      if (search) {
        // Order number, name or phone — one box, because staff do not think in
        // columns when a customer is on the phone.
        const escaped = search.replace(/[%_,]/g, " ");
        query = query.or(
          `order_number.ilike.%${escaped}%,customer_name.ilike.%${escaped}%,customer_phone.ilike.%${escaped}%`,
        );
      }
      if (filter.from) query = query.gte("created_at", filter.from);
      if (filter.to) query = query.lte("created_at", `${filter.to}T23:59:59.999Z`);

      query = query.order("created_at", { ascending: false });
      if (filter.limit && filter.limit > 0) query = query.limit(filter.limit);

      const { data, error } = await query;
      if (error) throw toOnlineError(error);
      const orders = (data as OnlineOrderRow[] | null) ?? [];
      if (orders.length === 0) return [];

      const ids = orders.map((order) => order.id);
      const [{ data: itemRows, error: itemError }, { data: eventRows, error: eventError }] =
        await Promise.all([
          client.from("online_order_items").select("*").in("order_id", ids),
          client.from("order_events").select("*").in("order_id", ids).order("created_at", {
            ascending: true,
          }),
        ]);
      if (itemError) throw toOnlineError(itemError);
      if (eventError) throw toOnlineError(eventError);

      const itemsByOrder = groupBy((itemRows as OnlineOrderItemRow[] | null) ?? [], (row) => row.order_id);
      const eventsByOrder = groupBy((eventRows as OrderEventRow[] | null) ?? [], (row) => row.order_id);

      return orders.map((row) =>
        mapOrder(row, itemsByOrder.get(row.id) ?? [], eventsByOrder.get(row.id) ?? []),
      );
    } catch (error) {
      throw toOnlineError(error);
    }
  }

  async getOrder(id: string): Promise<OnlineOrder> {
    try {
      const client = this.require();
      const { data, error } = await client
        .from("online_orders")
        .select("*")
        .eq("id", id)
        .maybeSingle();
      if (error) throw toOnlineError(error);
      if (!data) throw new OnlineError("order_not_found", `Order ${id} not found`);

      const [{ data: itemRows, error: itemError }, { data: eventRows, error: eventError }] =
        await Promise.all([
          client.from("online_order_items").select("*").eq("order_id", id),
          client
            .from("order_events")
            .select("*")
            .eq("order_id", id)
            .order("created_at", { ascending: true }),
        ]);
      if (itemError) throw toOnlineError(itemError);
      if (eventError) throw toOnlineError(eventError);

      return mapOrder(
        data as OnlineOrderRow,
        (itemRows as OnlineOrderItemRow[] | null) ?? [],
        (eventRows as OrderEventRow[] | null) ?? [],
      );
    } catch (error) {
      throw toOnlineError(error);
    }
  }

  async resolveOrder(id: string, input: ResolveOrderInput): Promise<OnlineOrder> {
    try {
      const client = this.require();
      const { error } = await client.rpc("resolve_online_order", {
        p_payload: {
          action: input.action,
          order_id: id,
          reason: input.reason ?? null,
          user_id: input.user_id,
          user_name: input.user_name,
        },
      });
      if (error) throw toOnlineError(error);
      return this.getOrder(id);
    } catch (error) {
      throw toOnlineError(error);
    }
  }

  async listReservations(): Promise<StockReservation[]> {
    try {
      const client = this.require();
      const { data, error } = await client.from("stock_reservations").select("*");
      if (error) throw toOnlineError(error);
      return ((data as StockReservationRow[] | null) ?? []).map(mapReservation);
    } catch (error) {
      throw toOnlineError(error);
    }
  }

  async counts(filter: Partial<OnlineOrderFilter> = {}): Promise<OrderCounts> {
    try {
      const client = this.require();
      let query = client
        .from("online_orders")
        .select("status,payment_status,subtotal,discount_amount");
      if (filter.status && filter.status !== "all") query = query.eq("status", filter.status);
      if (filter.paymentStatus && filter.paymentStatus !== "all") {
        query = query.eq("payment_status", filter.paymentStatus);
      }
      if (filter.from) query = query.gte("created_at", filter.from);
      if (filter.to) query = query.lte("created_at", `${filter.to}T23:59:59.999Z`);

      const { data, error } = await query;
      if (error) throw toOnlineError(error);

      const counts: OrderCounts = { ...EMPTY_ORDER_COUNTS };
      for (const row of (data as Pick<
        OnlineOrderRow,
        "status" | "payment_status" | "subtotal" | "discount_amount"
      >[] | null) ?? []) {
        counts.total += 1;
        counts[row.status] += 1;
        if (row.payment_status === "verification_required" && row.status !== "cancelled") {
          counts.needs_payment += 1;
        }
        if (row.status !== "cancelled" && row.status !== "completed") {
          counts.open_value = Math.round(
            (counts.open_value + toNumber(row.subtotal) - toNumber(row.discount_amount)) * 100,
          ) / 100;
        }
      }
      return counts;
    } catch (error) {
      throw toOnlineError(error);
    }
  }

  // ── orders: customer side ─────────────────────────────────────────────────

  async placeOrder(input: PlaceOrderInput): Promise<PlaceOrderResult> {
    try {
      const client = this.require();
      const { data, error } = await client.rpc("place_online_order", {
        p_payload: {
          client_ref: input.client_ref,
          customer_name: input.customer_name,
          customer_phone: input.customer_phone,
          customer_email: input.customer_email ?? null,
          store_customer_id: input.store_customer_id ?? null,
          delivery_type: input.delivery_type,
          // A pickup order sends no address; the column is `not null`, so `{}`.
          address: input.address ?? {},
          lines: input.lines,
          coupon_code: input.coupon_code ? normalizeCouponCode(input.coupon_code) : null,
          payment_method: input.payment_method,
          notes: input.notes ?? null,
        },
      });
      if (error) throw toOnlineError(error);

      const result = data as { order_id?: string; duplicate?: boolean } | null;
      const orderId = result?.order_id;
      if (!orderId) throw new OnlineError("db", "Order id missing from response");
      const order = await this.getOrder(orderId);
      return { order, duplicate: result?.duplicate === true };
    } catch (error) {
      throw toOnlineError(error);
    }
  }

  async lookupOrder(orderNumber: string, phone: string): Promise<OnlineOrder> {
    try {
      const client = this.require();
      const { data, error } = await client.rpc("lookup_online_order", {
        p_order_number: orderNumber.trim(),
        p_phone: phone.trim(),
      });
      if (error) throw toOnlineError(error);
      const payload = data as {
        order?: OnlineOrderRow;
        items?: OnlineOrderItemRow[];
        events?: OrderEventRow[];
      } | null;
      if (!payload?.order) {
        throw new OnlineError("order_not_found", "No order matches that number and phone", {
          field: "order_number",
        });
      }
      // The tracking payload's events are a projection (no ids, no user ids), so
      // they are mapped loosely rather than through the staff-side mapper.
      const events: OrderEvent[] = (payload.events ?? []).map((event, index) => ({
        id: `${payload.order?.id ?? "order"}-${index}`,
        order_id: payload.order?.id ?? "",
        kind: event.kind,
        note: event.note ?? null,
        user_id: null,
        user_name: (event as { user_name?: string | null }).user_name ?? null,
        created_at: event.created_at,
      }));
      const order = mapOrder(payload.order, payload.items ?? []);
      return { ...order, events };
    } catch (error) {
      throw toOnlineError(error);
    }
  }

  async submitPaymentProof(input: PaymentProofInput): Promise<OnlineOrder> {
    try {
      const client = this.require();
      const reference = input.payment_reference.trim();
      if (!reference) {
        throw new OnlineError("workflow_refused", "A transaction reference is required", {
          field: "payment_reference",
          detail: { reason: "missing_reference" },
        });
      }
      const { error } = await client.rpc("submit_online_payment_proof", {
        p_payload: {
          order_number: input.order_number.trim(),
          customer_phone: input.customer_phone.trim(),
          payment_reference: reference,
          payment_proof_url: input.payment_proof_url ?? null,
        },
      });
      if (error) throw toOnlineError(error);
      // The function returns only the number and the new payment status; the
      // customer is looking at their order, so fetch it with the same gate.
      return this.lookupOrder(input.order_number, input.customer_phone);
    } catch (error) {
      throw toOnlineError(error);
    }
  }

  async listMyOrders(storeCustomerId: string | null): Promise<OnlineOrder[]> {
    if (!storeCustomerId) return [];
    const refs = this.accounts.placedRefs(storeCustomerId).slice(0, 25);
    if (refs.length === 0) return [];

    // Each lookup is gated server-side on number + phone, so a stale or edited
    // reference simply yields nothing rather than somebody else's order.
    const settled = await Promise.allSettled(
      refs.map((ref) => this.lookupOrder(ref.order_number, ref.phone)),
    );
    const orders = settled
      .filter((result): result is PromiseFulfilledResult<OnlineOrder> => result.status === "fulfilled")
      .map((result) => result.value);
    return orders.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  }

  // ── website settings, content, marketing ──────────────────────────────────

  async getSnapshot(): Promise<WebsiteSnapshot> {
    try {
      // Fail fast with one clear error if Supabase is not configured; each read
      // below then runs in parallel, so the storefront waits once rather than
      // five times. Coupons are not read here: they are staff-only rows, and a
      // visitor validates a typed code through `checkCoupon` instead.
      this.require();
      const [settings, contents, faqs, reviews, campaigns] = await Promise.all([
        this.readSettingsRow(),
        this.listProductContents(),
        this.listFaqs(),
        this.listReviews(),
        this.listCampaigns(),
      ]);
      return {
        settings: settings.settings,
        meta: settings.meta,
        contents,
        faqs,
        reviews,
        campaigns,
      };
    } catch (error) {
      throw toOnlineError(error);
    }
  }

  async getMarketing(): Promise<MarketingSnapshot> {
    try {
      this.require();
      const [coupons, campaigns] = await Promise.all([
        this.listCoupons(),
        this.listCampaigns(),
      ]);
      return { coupons, campaigns };
    } catch (error) {
      throw toOnlineError(error);
    }
  }

  async checkCoupon(input: CouponCheckInput): Promise<CouponCheckResult> {
    try {
      const client = this.require();
      const code = normalizeCouponCode(input.code);
      if (!code) return { valid: false, reason: "not_found" };

      const { data, error } = await client.rpc("check_storefront_coupon", {
        p_code: code,
        p_subtotal: Math.max(input.subtotal, 0),
        p_product_ids: input.productIds,
        p_category_ids: input.categoryIds,
      });
      if (error) throw toOnlineError(error);

      const result = data as {
        valid?: boolean;
        reason?: string;
        code?: string;
        discount?: Numeric;
        discount_type?: "percent" | "fixed";
        value?: Numeric;
        min_subtotal?: Numeric;
      } | null;

      if (!result?.valid) {
        const reason = (result?.reason ?? "invalid") as CouponCheckReason;
        return {
          valid: false,
          reason: COUPON_CHECK_REASONS.includes(reason) ? reason : "invalid",
          ...(result?.min_subtotal != null
            ? { minSubtotal: toNumber(result.min_subtotal) }
            : {}),
        };
      }
      return {
        valid: true,
        code: result.code ?? code,
        discount: toNumber(result.discount ?? 0),
        discountType: result.discount_type ?? "percent",
        value: toNumber(result.value ?? 0),
      };
    } catch (error) {
      throw toOnlineError(error);
    }
  }

  async bestSellers(limit = 8): Promise<BestSellerRow[]> {
    try {
      const client = this.require();
      const { data, error } = await client.rpc("storefront_best_sellers", {
        p_limit: Math.max(limit, 1),
      });
      if (error) throw toOnlineError(error);
      return ((data as { product_id: string; units: Numeric }[] | null) ?? []).map((row) => ({
        product_id: row.product_id,
        units: toNumber(row.units),
      }));
    } catch (error) {
      // A shop with no sales yet has no best sellers; that is an empty row, not
      // an error the homepage should show.
      return [];
    }
  }

  private async readSettingsRow(): Promise<{
    settings: WebsiteSettings;
    meta: WebsiteSettingsMeta | null;
  }> {
    const client = this.require();
    const { data, error } = await client
      .from("website_settings")
      .select("*")
      .eq("id", 1)
      .maybeSingle();
    if (error) throw toOnlineError(error);
    const row = data as WebsiteSettingsRow | null;
    return {
      // Merged over the defaults in TypeScript: a document written by an older
      // release still renders, and gains whatever sections it is missing.
      settings: resolveSettings(row?.settings ?? null),
      meta: row
        ? { updated_at: row.updated_at, updated_by_name: row.updated_by_name ?? null }
        : null,
    };
  }

  async getSettings(): Promise<WebsiteSettings> {
    try {
      return (await this.readSettingsRow()).settings;
    } catch (error) {
      throw toOnlineError(error);
    }
  }

  async saveSettings(input: SettingsSaveInput): Promise<WebsiteSettingsMeta> {
    try {
      const client = this.require();
      const { error } = await client.from("website_settings").upsert(
        {
          id: 1,
          settings: input.settings as unknown as Record<string, unknown>,
          updated_by: input.user_id || null,
          updated_by_name: input.user_name || null,
        },
        { onConflict: "id" },
      );
      if (error) throw toOnlineError(error);
      const saved = await this.readSettingsRow();
      return (
        saved.meta ?? { updated_at: new Date().toISOString(), updated_by_name: input.user_name }
      );
    } catch (error) {
      throw toOnlineError(error);
    }
  }

  async listProductContents(): Promise<ProductContent[]> {
    const client = this.require();
    const { data, error } = await client.from("product_content").select("*");
    if (error) throw toOnlineError(error);
    return ((data as ProductContentRow[] | null) ?? []).map(mapContent);
  }

  async saveProductContent(draft: ProductContentDraft): Promise<ProductContent> {
    try {
      const client = this.require();
      const slug = draft.slug?.trim() ? slugifyAscii(draft.slug, draft.product_id) : null;
      const { data, error } = await client
        .from("product_content")
        .upsert(
          {
            product_id: draft.product_id,
            brand_ar: draft.brand_ar ?? null,
            brand_en: draft.brand_en ?? null,
            slug,
            seo_title: draft.seo_title ?? null,
            // The column is capped at 320 characters; clipping here means the
            // admin's text is kept rather than the write being refused.
            seo_description: draft.seo_description
              ? draft.seo_description.slice(0, 320)
              : null,
            specs: draft.specs ?? [],
            updated_at: new Date().toISOString(),
          },
          { onConflict: "product_id" },
        )
        .select()
        .single();
      if (error) throw toOnlineError(error);
      return mapContent(data as ProductContentRow);
    } catch (error) {
      throw toOnlineError(error);
    }
  }

  async deleteProductContent(productId: string): Promise<void> {
    try {
      const client = this.require();
      const { error } = await client.from("product_content").delete().eq("product_id", productId);
      if (error) throw toOnlineError(error);
    } catch (error) {
      throw toOnlineError(error);
    }
  }

  async listFaqs(): Promise<StoreFaq[]> {
    const client = this.require();
    const { data, error } = await client
      .from("store_faqs")
      .select("*")
      .order("sort_order", { ascending: true });
    if (error) throw toOnlineError(error);
    return ((data as StoreFaqRow[] | null) ?? []).map((row) => ({
      id: row.id,
      question_ar: row.question_ar,
      question_en: row.question_en,
      answer_ar: row.answer_ar,
      answer_en: row.answer_en,
      sort_order: row.sort_order,
      active: row.active,
      created_at: row.created_at,
      updated_at: row.updated_at,
    }));
  }

  async saveFaq(draft: FaqDraft): Promise<StoreFaq> {
    try {
      const client = this.require();
      if (!draft.question_en?.trim() && !draft.question_ar?.trim()) {
        throw new OnlineError("db", "A question is required", { field: "question_en" });
      }
      const payload = {
        ...(draft.id ? { id: draft.id } : {}),
        question_ar: draft.question_ar ?? "",
        question_en: draft.question_en ?? "",
        answer_ar: draft.answer_ar ?? "",
        answer_en: draft.answer_en ?? "",
        sort_order: draft.sort_order ?? 0,
        active: draft.active ?? true,
        updated_at: new Date().toISOString(),
      };
      const { data, error } = await client
        .from("store_faqs")
        .upsert(payload)
        .select()
        .single();
      if (error) throw toOnlineError(error);
      const row = data as StoreFaqRow;
      return {
        id: row.id,
        question_ar: row.question_ar,
        question_en: row.question_en,
        answer_ar: row.answer_ar,
        answer_en: row.answer_en,
        sort_order: row.sort_order,
        active: row.active,
        created_at: row.created_at,
        updated_at: row.updated_at,
      };
    } catch (error) {
      throw toOnlineError(error);
    }
  }

  async deleteFaq(id: string): Promise<void> {
    try {
      const client = this.require();
      const { error } = await client.from("store_faqs").delete().eq("id", id);
      if (error) throw toOnlineError(error);
    } catch (error) {
      throw toOnlineError(error);
    }
  }

  async listReviews(): Promise<StoreReview[]> {
    const client = this.require();
    const { data, error } = await client
      .from("store_reviews")
      .select("*")
      .order("sort_order", { ascending: true });
    if (error) throw toOnlineError(error);
    return ((data as StoreReviewRow[] | null) ?? []).map((row) => ({
      id: row.id,
      product_id: row.product_id ?? null,
      author_name: row.author_name,
      rating: row.rating,
      body: row.body ?? "",
      visible: row.visible,
      sort_order: row.sort_order,
      created_at: row.created_at,
    }));
  }

  async saveReview(draft: ReviewDraft): Promise<StoreReview> {
    try {
      const client = this.require();
      if (!draft.author_name?.trim()) {
        throw new OnlineError("db", "An author name is required", { field: "author_name" });
      }
      const rating = Math.min(5, Math.max(1, Math.round(draft.rating ?? 5)));
      const payload = {
        ...(draft.id ? { id: draft.id } : {}),
        product_id: draft.product_id ?? null,
        author_name: draft.author_name.trim(),
        rating,
        body: draft.body ?? "",
        visible: draft.visible ?? true,
        sort_order: draft.sort_order ?? 0,
      };
      const { data, error } = await client.from("store_reviews").upsert(payload).select().single();
      if (error) throw toOnlineError(error);
      const row = data as StoreReviewRow;
      return {
        id: row.id,
        product_id: row.product_id ?? null,
        author_name: row.author_name,
        rating: row.rating,
        body: row.body ?? "",
        visible: row.visible,
        sort_order: row.sort_order,
        created_at: row.created_at,
      };
    } catch (error) {
      throw toOnlineError(error);
    }
  }

  async deleteReview(id: string): Promise<void> {
    try {
      const client = this.require();
      const { error } = await client.from("store_reviews").delete().eq("id", id);
      if (error) throw toOnlineError(error);
    } catch (error) {
      throw toOnlineError(error);
    }
  }

  async listCoupons(): Promise<Coupon[]> {
    const client = this.require();
    const { data, error } = await client.from("coupons").select("*").order("code", {
      ascending: true,
    });
    if (error) throw toOnlineError(error);
    return ((data as CouponRow[] | null) ?? []).map(mapCoupon);
  }

  async saveCoupon(draft: CouponDraft): Promise<Coupon> {
    try {
      const client = this.require();
      const code = normalizeCouponCode(draft.code ?? "");
      if (!code) throw new OnlineError("db", "A coupon code is required", { field: "code" });
      const payload = {
        ...(draft.id ? { id: draft.id } : {}),
        code,
        discount_type: draft.discount_type ?? "percent",
        value: Math.max(draft.value ?? 0, 0),
        min_subtotal: Math.max(draft.min_subtotal ?? 0, 0),
        max_discount: draft.max_discount ?? null,
        usage_limit: draft.usage_limit ?? null,
        applies_to: draft.applies_to ?? "all",
        target_ids: draft.target_ids ?? [],
        active: draft.active ?? true,
        starts_at: draft.starts_at ?? null,
        ends_at: draft.ends_at ?? null,
        updated_at: new Date().toISOString(),
      };
      const { data, error } = await client.from("coupons").upsert(payload).select().single();
      if (error) throw toOnlineError(error);
      return mapCoupon(data as CouponRow);
    } catch (error) {
      throw toOnlineError(error);
    }
  }

  async deleteCoupon(id: string): Promise<void> {
    try {
      const client = this.require();
      const { error } = await client.from("coupons").delete().eq("id", id);
      if (error) throw toOnlineError(error);
    } catch (error) {
      throw toOnlineError(error);
    }
  }

  async listCampaigns(): Promise<Campaign[]> {
    const client = this.require();
    const { data, error } = await client
      .from("campaigns")
      .select("*")
      .order("starts_at", { ascending: false });
    if (error) throw toOnlineError(error);
    return ((data as CampaignRow[] | null) ?? []).map(mapCampaign);
  }

  async saveCampaign(draft: CampaignDraft): Promise<Campaign> {
    try {
      const client = this.require();
      const startsAt = draft.starts_at ?? new Date().toISOString();
      const endsAt = draft.ends_at ?? startsAt;
      if (Date.parse(endsAt) <= Date.parse(startsAt)) {
        throw new OnlineError("db", "A campaign must end after it starts", { field: "ends_at" });
      }
      const payload = {
        ...(draft.id ? { id: draft.id } : {}),
        name_ar: draft.name_ar ?? "",
        name_en: draft.name_en ?? "",
        kind: draft.kind ?? "promotion",
        discount_type: draft.discount_type ?? "percent",
        discount_value: Math.max(draft.discount_value ?? 0, 0),
        product_ids: draft.product_ids ?? [],
        badge_ar: draft.badge_ar ?? null,
        badge_en: draft.badge_en ?? null,
        starts_at: startsAt,
        ends_at: endsAt,
        active: draft.active ?? true,
        updated_at: new Date().toISOString(),
      };
      const { data, error } = await client.from("campaigns").upsert(payload).select().single();
      if (error) throw toOnlineError(error);
      return mapCampaign(data as CampaignRow);
    } catch (error) {
      throw toOnlineError(error);
    }
  }

  async deleteCampaign(id: string): Promise<void> {
    try {
      const client = this.require();
      const { error } = await client.from("campaigns").delete().eq("id", id);
      if (error) throw toOnlineError(error);
    } catch (error) {
      throw toOnlineError(error);
    }
  }

  // ── website accounts (local in both modes) ────────────────────────────────

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
}

let singleton: SupabaseOnlineRepository | null = null;

export function getSupabaseOnlineRepository(): SupabaseOnlineRepository {
  if (!singleton) singleton = new SupabaseOnlineRepository();
  return singleton;
}

export function resetSupabaseOnlineRepository(): void {
  singleton = null;
}
