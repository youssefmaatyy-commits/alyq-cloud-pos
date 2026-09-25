/** UI-only guards for the opt-in V2 journey. No separate cart, customer store,
 * price calculator or order writer: the shared providers keep those roles. */
import type { Product } from "@/modules/products/types";
import type { CustomerAddress, DeliveryType, DeliveryZone, OnlineOrder, WebsiteSettings } from "../types";
import type { StoreVariant } from "../services/pricing";
import { availableToPromise, reservedOf, variantAvailableToPromise } from "../services/availability";
import { deliveryAreaSupported, deliveryMinimumShortfall, round2 } from "../services/pricing";

export const V2_RECEIPT_KEY = "alyq.v2.confirmation.session";
const RECEIPT_LIFETIME_MS = 2 * 60 * 60 * 1000;
export interface V2ReceiptPair { order: string; phone: string; at: number }
type ReceiptStore = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** A tab-scoped lookup pair, never an unverified order body. On refresh the
 * existing lookupOrder(reference, phone) rechecks both halves. A reference by
 * itself can never reveal a customer record. */
export function rememberV2Receipt(order: OnlineOrder, storage: ReceiptStore): void {
  try {
    storage.setItem(V2_RECEIPT_KEY, JSON.stringify({ order: order.order_number,
      phone: order.customer_phone, at: Date.now() } satisfies V2ReceiptPair));
  } catch { /* blocked/private storage: tracking remains the safe fallback */ }
}
export function readV2Receipt(storage: ReceiptStore, now = Date.now()): V2ReceiptPair | null {
  try {
    const raw = storage.getItem(V2_RECEIPT_KEY);
    if (!raw) return null;
    const pair: unknown = JSON.parse(raw);
    if (!pair || typeof pair !== "object") return null;
    const value = pair as Partial<V2ReceiptPair>;
    if (typeof value.order !== "string" || value.order.length < 3 || value.order.length > 80 ||
      typeof value.phone !== "string" || value.phone.length < 5 || value.phone.length > 40 ||
      !Number.isFinite(value.at) || (value.at ?? 0) > now || now - (value.at ?? 0) > RECEIPT_LIFETIME_MS) {
      storage.removeItem(V2_RECEIPT_KEY);
      return null;
    }
    return value as V2ReceiptPair;
  } catch { return null; }
}
export function forgetV2Receipt(storage: ReceiptStore): void {
  try { storage.removeItem(V2_RECEIPT_KEY); } catch { /* storage unavailable */ }
}

export interface V2CheckoutFields {
  name: string;
  phone: string;
  address: CustomerAddress | null;
  deliveryType: DeliveryType;
  deliveryZoneId: string | null;
  goodsTotal: number;
  blockedLines: number;
}
/** Same Egyptian shopper-phone, area and minimum rules the legacy checkout
 * already presents. The place-order RPC independently enforces the real rules.
 * Never send a browser-calculated price as an order authority. */
export function v2CheckoutIssues(fields: V2CheckoutFields, settings: WebsiteSettings,
  zones: readonly DeliveryZone[]) {
  const activeZones = zones.filter((zone) => zone.enabled);
  const zone = activeZones.find((entry) => entry.id === fields.deliveryZoneId) ?? null;
  const delivery = fields.deliveryType === "delivery";
  const phone = fields.phone.replace(/\s+/g, "");
  const address = fields.address;
  const missingAddress = delivery && (!address?.city.trim() || !address?.area.trim() || !address?.street.trim());
  const typedArea = Boolean(address?.city.trim() || address?.area.trim());
  const minimum = delivery && zone ? zone.minimum_order_amount : settings.delivery.minimum_order ?? 0;
  const shortfall = delivery && zone
    ? round2(Math.max(zone.minimum_order_amount - fields.goodsTotal, 0))
    : deliveryMinimumShortfall(settings.delivery, fields.deliveryType, fields.goodsTotal);
  return {
    name: !fields.name.trim(),
    phone: !/^01[0-25]\d{8}$/.test(phone),
    address: Boolean(missingAddress),
    zone: delivery && activeZones.length > 0 && !zone,
    area: delivery && !zone && typedArea &&
      !deliveryAreaSupported(settings.delivery, address?.city ?? "", address?.area ?? ""),
    fulfilment: !settings.delivery.enabled && !settings.delivery.pickup_enabled ||
      (delivery ? !settings.delivery.enabled : !settings.delivery.pickup_enabled),
    payment: !settings.delivery.cod_enabled && !settings.delivery.instapay_enabled,
    stock: fields.blockedLines > 0,
    shortfall,
    minimum,
    validZone: zone,
  };
}

export type V2ReorderLine = { product_id: string; variant_id: string | null; quantity: number };
export interface V2ReorderPlan { ready: V2ReorderLine[]; unavailable: string[] }
/** Match each historic line to the SAME currently sellable product/variant UUID
 * before asking the shared cart to add it. Stock tracking is required by the
 * V2 checkout too; a currently untracked product is not a valid reorder line.
 * Keep valid lines separate so the shopper can opt for a partial reorder while
 * the unavailable SKUs remain visible. The server rechecks everything at order. */
export function planV2Reorder(order: OnlineOrder, products: readonly Product[],
  variants: readonly StoreVariant[], heldProducts: ReadonlyMap<string, number> = new Map(),
  heldVariants: ReadonlyMap<string, number> = new Map(),
  cart: readonly V2ReorderLine[] = []): V2ReorderPlan {
  const byProduct = new Map(products.map((product) => [product.id, product]));
  const byVariant = new Map(variants.map((variant) => [variant.id, variant]));
  const unavailable: string[] = [];
  const ready: V2ReorderLine[] = [];
  const planned = new Map<string, number>();
  for (const item of order.items) {
    const product = byProduct.get(item.product_id);
    const variant = item.variant_id ? byVariant.get(item.variant_id) : null;
    const key = `${item.product_id}::${item.variant_id ?? ""}`;
    const existing = cart.filter((line) => line.product_id === item.product_id &&
      (line.variant_id ?? null) === (item.variant_id ?? null))
      .reduce((sum, line) => sum + line.quantity, 0);
    const available = product?.stock_tracking_enabled
      ? variant ? variantAvailableToPromise(variant, heldVariants.get(variant.id) ?? 0)
        : availableToPromise(product, reservedOf(heldProducts, product.id))
      : null;
    if (!product || !product.active || !product.show_on_website || !product.stock_tracking_enabled ||
      !Number.isSafeInteger(item.quantity) || item.quantity <= 0 ||
      (product.variants_enabled ? !variant || !variant.active || variant.product_id !== product.id
        : Boolean(item.variant_id)) || available === null ||
      available < existing + (planned.get(key) ?? 0) + item.quantity) {
      unavailable.push(item.sku);
      continue;
    }
    ready.push({ product_id: product.id, variant_id: variant?.id ?? null, quantity: item.quantity });
    planned.set(key, (planned.get(key) ?? 0) + item.quantity);
  }
  return { ready, unavailable };
}
