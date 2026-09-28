/** Shared V2 presentation blocks. Prices/orders/proof continue to come from the
 * existing cart, pricing preview, order result and proof-upload providers. */
import { useState, type CSSProperties, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { useStorefront } from "../hooks/StorefrontProvider";
import { useStoreCart } from "../hooks/StoreCartProvider";
import type { OnlineOrder } from "../types";
import { deliveryHintKey } from "../services/orderWorkflow";
import { PaymentProofPanel } from "../components/storefront/PaymentProofPanel";
import { V2Image } from "./Primitives";

export function V2Panel({ title, children, className = "", testId }: {
  title?: string; children: ReactNode; className?: string; testId?: string;
}) {
  return <section className={`v2-journey-panel ${className}`} data-testid={testId}>
    {title ? <h2>{title}</h2> : null}{children}
  </section>;
}

/** Coupon checks and breakdowns are advisory. The single shared cart/provider
 * owns apply/remove, and the placement RPC recomputes the actual discount. */
export function V2Coupon() {
  const { t } = useI18n();
  const { couponCode, couponInput, setCouponInput, couponError, applyingCoupon,
    applyCoupon, clearCoupon, preview } = useStoreCart();
  const [draft, setDraft] = useState(couponInput);
  const current = couponCode ?? preview?.promoCode;
  return <div className="v2-coupon" data-testid="v2-coupon">
    <label htmlFor="v2-coupon-code">{t("store.cart.coupon")}</label>
    {current ? <div className="v2-coupon-applied"><strong>{current}</strong>
      <button type="button" onClick={() => { clearCoupon(); setDraft(""); }}>
        {t("store.cart.removeCoupon")}</button></div> : <div className="v2-coupon-entry">
      <input id="v2-coupon-code" autoComplete="off" value={draft} placeholder={t("store.cart.couponPlaceholder")}
        onChange={(event) => { setDraft(event.target.value); setCouponInput(event.target.value); }}
        onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void applyCoupon(draft); } }} />
      <button type="button" className="v2-outline-button" disabled={applyingCoupon || !draft.trim()}
        onClick={() => void applyCoupon(draft)}>{applyingCoupon ? t("common.loading") : t("store.cart.applyCoupon")}</button>
    </div>}
    {couponError && !couponCode ? <p role="alert" className="v2-field-error">{t(`store.coupon.${couponError}` as never)}</p> : null}
    {current && !couponError ? <p role="status" className="v2-field-success">{t("store.coupon.applied")}</p> : null}
    <p className="v2-small">{t("store.v2.journey.advisoryCoupon")}</p>
  </div>;
}

export function V2CartTotals({ showDelivery = false }: { showDelivery?: boolean }) {
  const { t, pick, money } = useI18n();
  const { settings } = useStorefront();
  const { totals, preview, previewLoading, deliveryType, deliveryZoneId, freeDelivery,
    couponCode } = useStoreCart();
  const zone = useStorefront().deliveryZones.find((entry) => entry.id === deliveryZoneId && entry.enabled);
  // The advisory preview is debounced, so for a moment after a coupon is
  // applied (or removed) it still describes the PREVIOUS coupon state — and
  // that stale breakdown still carries the automatic promotion the coupon has
  // just displaced, which is what made the cart render a discount that no
  // longer applies. Only trust a preview whose own code matches the coupon the
  // cart currently holds; otherwise fall back to the locally reconciled
  // totals until the fresh preview lands.
  const shown = preview && preview.promoCode === couponCode ? preview : null;
  return <div data-testid="v2-cart-totals">
    <dl className="v2-totals">
      <div><dt>{t("store.cart.subtotal")}</dt><dd>{money(shown?.subtotal ?? totals.subtotal)}</dd></div>
      {(shown?.autoDiscount ?? totals.auto_discount) > 0 ? <div className="v2-totals-discount"><dt>
        {t("store.checkout.productDiscounts")}{(shown?.autoPromotionName ?? totals.auto_promotion_name) ? ` · ${shown?.autoPromotionName ?? totals.auto_promotion_name}` : ""}
      </dt><dd>−{money(shown?.autoDiscount ?? totals.auto_discount)}</dd></div> : null}
      {(shown?.promoDiscount ?? totals.discount_amount) > 0 ? <div className="v2-totals-discount"><dt>
        {t("store.cart.discount")}{shown?.promoCode ?? totals.discount_code ? ` · ${shown?.promoCode ?? totals.discount_code}` : ""}
      </dt><dd>−{money(shown?.promoDiscount ?? totals.discount_amount)}</dd></div> : null}
      {showDelivery ? <div><dt>{deliveryType === "pickup" ? t("store.checkout.pickup") :
        zone ? pick(zone.name_ar, zone.name_en) : t("store.cart.deliveryFee")}</dt>
        <dd>{(shown?.deliveryFee ?? totals.delivery_fee) > 0
          ? money(shown?.deliveryFee ?? totals.delivery_fee) : t("store.checkout.free")}</dd></div> : null}
      {showDelivery && (shown?.shippingDiscount ?? 0) > 0 ? <div className="v2-totals-discount"><dt>
        {t("store.checkout.deliveryDiscount")}</dt><dd>−{money(shown?.shippingDiscount ?? 0)}</dd></div> : null}
      <div className="v2-totals-grand"><dt>{t("store.cart.total")}</dt>
        <dd>{money(shown?.total ?? totals.total)}</dd></div>
    </dl>
    {freeDelivery && deliveryType === "delivery" && !freeDelivery.eligible ?
      <p className="v2-small">{t("store.cart.freeDeliveryRemaining", { amount: money(freeDelivery.remaining) })}</p> : null}
    {previewLoading ? <p className="v2-small" role="status">{t("store.v2.journey.checkingPrices")}</p> : null}
    <p className="v2-small">{t("store.v2.journey.advisoryTotal")}{settings.delivery.enabled && !zone &&
      deliveryType === "delivery" ? ` · ${t("store.v2.journey.zoneEstimate")}` : ""}</p>
  </div>;
}

/** Only order snapshots and event/status fields returned by the authoritative
 * order lookup/result are shown; no locally reconstructed prices or timelines. */
export function V2OrderDetails({ order, timeline = false }: { order: OnlineOrder; timeline?: boolean }) {
  const { t, pick, money, lang } = useI18n();
  const { products, settings } = useStorefront();
  return <div className="v2-order-details" data-testid="v2-order-details">
    <V2Panel title={t("store.confirmation.details")}>
      <dl className="v2-order-facts">
        <div><dt>{t("store.checkout.contactSection")}</dt><dd>{order.customer_name}
          <span dir="ltr">{order.customer_phone}</span></dd></div>
        <div><dt>{t("store.checkout.payment")}</dt><dd>{t(order.payment_method === "instapay" ? "store.checkout.instapay" : "store.checkout.cod")}</dd></div>
        <div><dt>{t("store.checkout.fulfilment")}</dt><dd>{order.delivery_type === "pickup"
          ? pick(settings.delivery.pickup_address_ar, settings.delivery.pickup_address_en) || t("store.checkout.pickup")
          : order.address ? [order.address.street, order.address.area, order.address.city].filter(Boolean).join("، ") : t("store.checkout.delivery")}</dd></div>
        {order.notes ? <div><dt>{t("store.checkout.orderNotes")}</dt><dd>{order.notes}</dd></div> : null}
      </dl>
    </V2Panel>
    <V2Panel title={t("store.track.items")}>
      <ul className="v2-order-items">{order.items.map((item) => {
        const product = products.find((row) => row.id === item.product_id);
        return <li key={item.id}><V2Image src={product?.image_url ?? product?.images[0]} alt={pick(item.name_ar, item.name_en)} />
          <div><strong>{pick(item.name_ar, item.name_en)}</strong>
            {item.variant_id ? <span data-testid="v2-order-variant">{pick(item.variant_color_ar, item.variant_color_en)}
              {item.variant_size !== null ? ` / ${item.variant_size}` : item.variant_size_label ? ` / ${item.variant_size_label}` : ""}
            </span> : null}
            <small>{t("store.checkout.quantityTimes", { count: item.quantity })} · {item.sku}</small>
          </div><b>{money(item.line_total)}</b></li>;
      })}</ul>
      <dl className="v2-totals"><div><dt>{t("store.cart.subtotal")}</dt><dd>{money(order.subtotal)}</dd></div>
        {order.discount_amount > 0 ? <div className="v2-totals-discount"><dt>{t("store.cart.discount")}
          {order.discount_code ? ` · ${order.discount_code}` : ""}</dt><dd>−{money(order.discount_amount)}</dd></div> : null}
        <div><dt>{t("store.cart.deliveryFee")}</dt><dd>{order.delivery_fee > 0 ? money(order.delivery_fee) : t("store.checkout.free")}</dd></div>
        <div className="v2-totals-grand"><dt>{t("store.cart.total")}</dt><dd>{money(order.total)}</dd></div>
      </dl>
    </V2Panel>
    {timeline ? <V2Panel title={t("store.track.history")}>
      <p className="v2-small">{t(deliveryHintKey(order))}</p>
      {order.status === "cancelled" ? <p role="status" className="v2-alert">{t("store.track.cancelled")}
        {order.cancellation_reason ? ` · ${order.cancellation_reason}` : ""}</p> : null}
      {order.events.length ? <ol className="v2-order-timeline">{order.events.map((event) => <li key={event.id}>
        <strong>{t(`store.track.event.${event.kind}` as never)}</strong>
        {event.note ? <span>{event.note}</span> : null}
        <time dateTime={event.created_at}>{new Date(event.created_at).toLocaleString(lang === "ar" ? "ar-EG" : "en-GB")}</time>
      </li>)}</ol> : <p className="v2-small">{t("store.track.hint.pending")}</p>}
    </V2Panel> : null}
    {order.payment_status === "verification_required" ? <p className="v2-alert" role="status">{t("store.track.verificationPending")}</p> : null}
    {order.payment_status === "failed" ? <p className="v2-alert" role="status">{t("store.track.paymentRejected")}
      {order.payment_rejected_reason ? ` · ${order.payment_rejected_reason}` : ""}</p> : null}
  </div>;
}

/** Preserve the exact, battle-tested upload/reference state machine. Token
 * aliases are confined to this wrapper; no second proof or payment backend. */
export function V2ProofPanel({ order }: { order: OnlineOrder }) {
  const { settings } = useStorefront();
  if (order.payment_method !== "instapay" || order.payment_status === "paid" ||
    !settings.delivery.instapay_proof_required) return null;
  const tokens = {
    "--store-primary": "var(--v2-button-bg)", "--store-on-primary": "var(--v2-button-text)",
    "--store-primary-soft": "var(--v2-bg)", "--store-border": "var(--v2-border)",
    "--store-surface": "var(--v2-surface)", "--store-text-primary": "var(--v2-surface-text)",
    "--store-text-secondary": "var(--v2-surface-muted)",
    "--store-radius": "var(--v2-card-radius)", "--store-radius-button": "var(--v2-button-radius)",
  } as CSSProperties;
  return <div className="v2-proof" style={tokens} data-testid="v2-payment-proof">
    <PaymentProofPanel key={`${order.id}:${order.payment_reference ?? ""}`} orderNumber={order.order_number}
      phone={order.customer_phone} total={order.total}
      submitted={order.payment_submitted_at !== null && order.payment_status !== "failed"}
      storedReference={order.payment_reference} />
  </div>;
}

/** Styling-only wrapper for routes that should stay V2. */
export function V2Continue({ to, children }: { to: string; children: ReactNode }) {
  return <Link to={to} className="v2-outline-button">{children}</Link>;
}
