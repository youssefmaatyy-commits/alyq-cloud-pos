/**
 * Dashboard query — the website half (Phase 46).
 *
 * Same contract as `dashboardQuery.ts`: stateless reducers over domain
 * records the providers already hold — no new fetches, no second source of
 * truth. The dashboard reads the online-orders provider's page (the same rows
 * the Online Orders screen shows), the catalog, and the inventory provider's
 * variants, and derives:
 *
 *   · website KPIs (orders/sales today, pending review, InstaPay awaiting
 *     verification, delivery/pickup, cancelled, AOV, last-24h, COD vs
 *     InstaPay, delivery fees),
 *   · top online products and categories (from order line snapshots joined to
 *     the catalog for the category name),
 *   · variant-aware inventory alerts — a product whose rollup says "in stock"
 *     still lands here when every one of its active combinations is gone, and
 *     an alert NAMES the exact combination ("Gold / 17"), because that is what
 *     the shelf needs.
 *
 * There is deliberately no coupon KPI: no coupon system exists in this
 * installation (`discount_code` is a stored string with no redemption rules),
 * so there is nothing honest to count.
 */
import type { OnlineOrder, OnlineOrderItem } from "@/modules/online/types";
import type { Product } from "@/modules/products/types";
import type { ProductVariant } from "@/modules/products/variants";
import { variantLabel, variantStatus } from "@/modules/products/variants";

// ── windows ─────────────────────────────────────────────────────────────────

function startOfToday(): Date {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

function isToday(iso: string): boolean {
  return new Date(iso) >= startOfToday();
}

function isWithinHours(iso: string, hours: number): boolean {
  return Date.now() - new Date(iso).getTime() <= hours * 60 * 60 * 1000;
}

/** Money that counts: a cancelled order never sold anything. */
const countable = (order: OnlineOrder) => order.status !== "cancelled";
const ACTIVE_STATUSES = new Set(["pending", "approved", "processing", "ready"]);

// ── website KPIs ────────────────────────────────────────────────────────────

export interface OnlineKpis {
  /** Non-cancelled orders created today. */
  ordersToday: number;
  /** Their merchandise + delivery fee, net of discount — the money taken. */
  salesToday: number;
  /** Awaiting review (status `pending`). */
  pendingReview: number;
  /** InstaPay transfers a human has not verified yet. */
  instapayAwaiting: number;
  /** Active (not completed/cancelled) delivery orders. */
  deliveryActive: number;
  /** Active pickup orders. */
  pickupActive: number;
  /** Cancelled orders in the loaded queue. */
  cancelled: number;
  /** Average order value across today's orders (0 when none). */
  avgOrderToday: number;
  /** Orders created in the last 24 hours. */
  last24h: number;
  /** COD orders in the loaded queue (non-cancelled). */
  codCount: number;
  /** InstaPay orders in the loaded queue (non-cancelled). */
  instapayCount: number;
  /** Delivery fees on non-cancelled orders in the loaded queue. */
  deliveryFees: number;
}

export function computeOnlineKpis(orders: readonly OnlineOrder[]): OnlineKpis {
  const today = orders.filter((order) => countable(order) && isToday(order.created_at));
  const salesToday = today.reduce(
    (sum, order) => sum + (order.total - order.delivery_fee) + order.delivery_fee,
    0,
  );
  let cod = 0;
  let instapay = 0;
  let fees = 0;
  for (const order of orders) {
    if (!countable(order)) continue;
    if (order.payment_method === "cod") cod += 1;
    else instapay += 1;
    fees += order.delivery_fee;
  }
  return {
    ordersToday: today.length,
    salesToday,
    pendingReview: orders.filter((order) => order.status === "pending").length,
    instapayAwaiting: orders.filter(
      (order) =>
        order.payment_method === "instapay" && order.payment_status === "verification_required",
    ).length,
    deliveryActive: orders.filter((order) => ACTIVE_STATUSES.has(order.status) && order.delivery_type === "delivery")
      .length,
    pickupActive: orders.filter((order) => ACTIVE_STATUSES.has(order.status) && order.delivery_type === "pickup")
      .length,
    cancelled: orders.filter((order) => order.status === "cancelled").length,
    avgOrderToday: today.length > 0 ? salesToday / today.length : 0,
    last24h: orders.filter((order) => countable(order) && isWithinHours(order.created_at, 24)).length,
    codCount: cod,
    instapayCount: instapay,
    deliveryFees: fees,
  };
}

// ── top online products / categories ────────────────────────────────────────

export interface TopOnlineRow {
  /** Product id where the catalog still knows it, else the snapshot name. */
  id: string;
  nameAr: string;
  nameEn: string;
  units: number;
  revenue: number;
}

function lineRevenue(item: OnlineOrderItem): number {
  return typeof item.line_total === "number" ? item.line_total : item.unit_price * item.quantity;
}

/** Best sellers across the loaded website orders (cancelled excluded). */
export function computeTopOnlineProducts(
  orders: readonly OnlineOrder[],
  limit = 5,
): TopOnlineRow[] {
  const byProduct = new Map<string, TopOnlineRow>();
  for (const order of orders) {
    if (!countable(order)) continue;
    for (const item of order.items) {
      const current = byProduct.get(item.product_id) ?? {
        id: item.product_id,
        nameAr: item.name_ar,
        nameEn: item.name_en,
        units: 0,
        revenue: 0,
      };
      current.units += item.quantity;
      current.revenue += lineRevenue(item);
      byProduct.set(item.product_id, current);
    }
  }
  return [...byProduct.values()].sort((a, b) => b.units - a.units).slice(0, limit);
}

/** The same lines grouped by the product's catalog category. */
export function computeTopOnlineCategories(
  orders: readonly OnlineOrder[],
  productById: ReadonlyMap<string, Pick<Product, "id" | "category_id" | "name_ar" | "name_en">>,
  categoryNameById: ReadonlyMap<string, string>,
  limit = 5,
): Array<TopOnlineRow & { categoryLabel: string }> {
  const byCategory = new Map<string, TopOnlineRow & { categoryLabel: string }>();
  for (const order of orders) {
    if (!countable(order)) continue;
    for (const item of order.items) {
      const product = productById.get(item.product_id);
      const key = product?.category_id ?? "";
      const label = (key && categoryNameById.get(key)) || "—";
      const current = byCategory.get(key) ?? {
        id: key || "none",
        nameAr: "",
        nameEn: "",
        categoryLabel: label,
        units: 0,
        revenue: 0,
      };
      current.units += item.quantity;
      current.revenue += lineRevenue(item);
      byCategory.set(key, current);
    }
  }
  return [...byCategory.values()].sort((a, b) => b.units - a.units).slice(0, limit);
}

// ── variant-aware inventory alerts ──────────────────────────────────────────

export interface InventoryAlert {
  productId: string;
  productNameAr: string;
  productNameEn: string;
  sku: string;
  /** Exact combination, or null for a plain product. */
  variantId: string | null;
  variantText: string | null;
  quantity: number;
  kind: "low" | "out";
}

export interface InventoryAlerts {
  low: InventoryAlert[];
  out: InventoryAlert[];
  /** Total SKUs (variants + plain products) the inventory tracks. */
  totalSkus: number;
  lowCount: number;
  outCount: number;
}

/**
 * Alerts that respect the combination shelf. A variant-tracked product is
 * judged per active variant — the product rollup never claims "out" while one
 * combination still has units, and never hides a sold-out combination behind a
 * healthy-looking total. Plain products keep the product-level rule.
 */
export function computeInventoryAlerts(
  products: readonly Product[],
  variantsByProduct: ReadonlyMap<string, ProductVariant[]>,
  lang: "ar" | "en" = "en",
): InventoryAlerts {
  const low: InventoryAlert[] = [];
  const out: InventoryAlert[] = [];
  let totalSkus = 0;

  for (const product of products) {
    const variants = variantsByProduct.get(product.id) ?? [];
    const activeVariants = variants.filter((variant) => variant.active);
    totalSkus += activeVariants.length > 0 ? activeVariants.length : 1;

    if (activeVariants.length > 0) {
      for (const variant of activeVariants) {
        const status = variantStatus(variant);
        if (status !== "low" && status !== "out") continue;
        const alert: InventoryAlert = {
          productId: product.id,
          productNameAr: product.name_ar,
          productNameEn: product.name_en,
          sku: variant.sku,
          variantId: variant.id,
          variantText: variantLabel(variant, lang),
          quantity: variant.stock_quantity,
          kind: status,
        };
        (status === "out" ? out : low).push(alert);
      }
      continue;
    }

    // Plain product — the existing product-level rule (tracked products only;
    // a service item with tracking off can never be "out of stock").
    if (!product.active || !product.stock_tracking_enabled) continue;
    if (product.stock_quantity <= 0) {
      out.push({
        productId: product.id,
        productNameAr: product.name_ar,
        productNameEn: product.name_en,
        sku: product.sku,
        variantId: null,
        variantText: null,
        quantity: product.stock_quantity,
        kind: "out",
      });
    } else if (product.low_stock_level > 0 && product.stock_quantity <= product.low_stock_level) {
      low.push({
        productId: product.id,
        productNameAr: product.name_ar,
        productNameEn: product.name_en,
        sku: product.sku,
        variantId: null,
        variantText: null,
        quantity: product.stock_quantity,
        kind: "low",
      });
    }
  }

  return { low, out, totalSkus, lowCount: low.length, outCount: out.length };
}

/** The dashboard's alert line: "Gold Ring · Gold / 17 · Out of stock". */
export function inventoryAlertLine(
  alert: InventoryAlert,
  pick: (ar: string, en: string) => string,
  lowWord: string,
  outWord: string,
): string {
  const name = pick(alert.productNameAr, alert.productNameEn);
  const parts = [name];
  if (alert.variantText) parts.push(alert.variantText);
  parts.push(alert.kind === "out" ? outWord : lowWord);
  return parts.join(" · ");
}
