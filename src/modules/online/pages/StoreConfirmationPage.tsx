/**
 * Order confirmation.
 *
 * The screen that decides whether the customer trusts the shop. It states the
 * order number plainly (and copies on a tap, because that is what they will be
 * asked for on the phone), it says what happens next rather than implying the
 * order is already on its way, and — for InstaPay — it puts the payment proof
 * form directly here, at the one moment the customer definitely still has the
 * transfer open.
 *
 * The numbers shown come from the order the server wrote, not from the cart:
 * if a campaign ended between the two screens this is where the truth appears.
 */
import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { useStoreCart } from "../hooks/StoreCartProvider";
import { useStorefront } from "../hooks/StorefrontProvider";
import { whatsappHref } from "../components/storefront/StoreLayout";
import { Money, OrderStatusPill, PaymentStatusPill } from "../components/storefront/StorePrimitives";
import { PaymentProofPanel } from "../components/storefront/PaymentProofPanel";
import { applyDocumentMeta, clearDocumentMeta } from "../services/seo";

export function StoreConfirmationPage() {
  const { t, pick } = useI18n();
  const navigate = useNavigate();
  const { settings } = useStorefront();
  const { lastOrder, lastWasDuplicate, dismissLastOrder } = useStoreCart();
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    applyDocumentMeta({ title: t("store.confirmation.title"), description: "", noIndex: true });
    return () => clearDocumentMeta();
  }, [t]);

  useEffect(() => {
    if (!lastOrder) navigate("/store/cart", { replace: true });
  }, [lastOrder, navigate]);

  if (!lastOrder) return null;

  const order = lastOrder;
  const number = order.order_number;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(number);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard permission denied is not worth an error; the number is on screen.
    }
  };

  const whatsNext = [
    t("store.confirmation.step1"),
    t("store.confirmation.step2"),
    t("store.confirmation.step3"),
  ];

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6">
      <div
        className="border border-emerald-200 bg-emerald-50 p-5 text-center"
        style={{ borderRadius: "var(--store-radius)" }}
      >
        <p className="text-xs font-black uppercase tracking-widest text-emerald-700">
          {lastWasDuplicate ? t("store.confirmation.duplicateTitle") : t("store.confirmation.received")}
        </p>
        <h1 className="mt-2 text-2xl font-black tracking-tight text-emerald-900">
          {lastWasDuplicate ? t("store.confirmation.duplicateHeading") : t("store.confirmation.thankYou")}
        </h1>

        <div className="mt-4 inline-flex flex-col items-center gap-1 rounded-xl bg-white/70 px-5 py-3">
          <span className="text-[11px] font-bold uppercase tracking-widest text-emerald-700">
            {t("store.confirmation.orderNumber")}
          </span>
          <button
            type="button"
            onClick={() => void copy()}
            className="text-xl font-black tabular-nums tracking-tight text-emerald-900 hover:underline"
            title={t("store.confirmation.copyNumber")}
          >
            {number}
          </button>
          <span className="text-[11px] font-semibold text-emerald-700">
            {copied ? t("store.confirmation.copied") : t("store.confirmation.tapToCopy")}
          </span>
        </div>

        {lastWasDuplicate ? (
          <p className="mx-auto mt-3 max-w-md text-xs leading-relaxed text-emerald-800">
            {t("store.confirmation.duplicateNote")}
          </p>
        ) : null}
      </div>

      <div className="mt-6 grid gap-4 md:grid-cols-2">
        <section className="border border-[var(--store-border)] bg-[var(--store-surface)] p-4" style={{ borderRadius: "var(--store-radius)" }}>
          <h2 className="text-sm font-black uppercase tracking-widest text-[var(--store-muted)]">
            {t("store.confirmation.whatHappensNext")}
          </h2>
          <ol className="mt-3 list-decimal space-y-1.5 ps-5 text-sm text-[var(--store-text)]">
            {whatsNext.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <OrderStatusPill status={order.status} />
            <PaymentStatusPill status={order.payment_status} />
          </div>
        </section>

        <section className="border border-[var(--store-border)] bg-[var(--store-surface)] p-4" style={{ borderRadius: "var(--store-radius)" }}>
          <h2 className="text-sm font-black uppercase tracking-widest text-[var(--store-muted)]">
            {t("store.confirmation.details")}
          </h2>
          <dl className="mt-3 space-y-2 text-sm">
            <div className="flex justify-between gap-2">
              <dt className="text-[var(--store-muted)]">{t("store.checkout.contactSection")}</dt>
              <dd className="text-end font-semibold text-[var(--store-text)]">
                {order.customer_name}
                <span className="block text-xs font-medium text-[var(--store-muted)]">{order.customer_phone}</span>
              </dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-[var(--store-muted)]">
                {order.delivery_type === "pickup" ? t("store.checkout.pickup") : t("store.checkout.delivery")}
              </dt>
              <dd className="max-w-[60%] text-end text-xs font-semibold text-[var(--store-text)]">
                {order.delivery_type === "pickup"
                  ? pick(settings.delivery.pickup_address_ar, settings.delivery.pickup_address_en) ||
                    t("store.footer.pickupAvailable")
                  : order.address
                    ? [order.address.street, order.address.area, order.address.city].filter(Boolean).join("، ")
                    : "—"}
              </dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-[var(--store-muted)]">{t("store.checkout.payment")}</dt>
              <dd className="font-semibold text-[var(--store-text)]">
                {order.payment_method === "instapay" ? t("store.checkout.instapay") : t("store.checkout.cod")}
              </dd>
            </div>
          </dl>

          <dl className="mt-4 space-y-1.5 border-t border-[var(--store-border)] pt-3 text-sm">
            <div className="flex justify-between gap-2">
              <dt className="text-[var(--store-muted)]">{t("store.cart.subtotal")}</dt>
              <dd className="font-bold"><Money value={order.subtotal} /></dd>
            </div>
            {order.discount_amount > 0 ? (
              <div className="flex justify-between gap-2 text-emerald-700">
                <dt>{t("store.cart.discount")}{order.discount_code ? ` · ${order.discount_code}` : ""}</dt>
                <dd className="font-bold">−<Money value={order.discount_amount} /></dd>
              </div>
            ) : null}
            {order.delivery_fee > 0 ? (
              <div className="flex justify-between gap-2">
                <dt className="text-[var(--store-muted)]">{t("store.cart.deliveryFee")}</dt>
                <dd className="font-bold"><Money value={order.delivery_fee} /></dd>
              </div>
            ) : null}
            <div className="flex justify-between gap-2 border-t border-[var(--store-border)] pt-2 text-base">
              <dt className="font-black text-[var(--store-text)]">{t("store.cart.total")}</dt>
              <dd className="font-black text-[var(--store-text)]"><Money value={order.total} /></dd>
            </div>
          </dl>
        </section>
      </div>

      {order.payment_method === "instapay" ? (
        <div className="mt-4">
          <PaymentProofPanel
            orderNumber={number}
            phone={order.customer_phone}
            total={order.total}
            submitted={order.payment_submitted_at !== null || order.payment_status === "paid"}
            storedReference={order.payment_reference}
          />
        </div>
      ) : (
        <p className="mt-4 border border-[var(--store-border)] bg-[var(--store-surface)] p-4 text-sm leading-relaxed text-[var(--store-muted)]" style={{ borderRadius: "var(--store-radius)" }}>
          {t("store.confirmation.codNote")}
        </p>
      )}

      <div className="mt-6 flex flex-wrap items-center gap-3">
        <Link
          to={`/store/track?order=${encodeURIComponent(number)}&phone=${encodeURIComponent(order.customer_phone)}`}
          className="bg-[var(--store-primary)] px-5 py-3 text-sm font-black text-[var(--store-on-primary)]"
          style={{ borderRadius: "var(--store-radius-button)" }}
        >
          {t("store.confirmation.trackOrder")}
        </Link>
        <button
          type="button"
          onClick={() => {
            dismissLastOrder();
            navigate("/store/products");
          }}
          className="border border-[var(--store-border)] px-5 py-3 text-sm font-black text-[var(--store-text)]"
          style={{ borderRadius: "var(--store-radius-button)" }}
        >
          {t("store.cart.continueShopping")}
        </button>
        {whatsappHref(settings.social.whatsapp) ? (
          <a
            href={
              whatsappHref(
                settings.social.whatsapp,
                t("store.confirmation.whatsappMessage", { number }),
              ) ?? "#"
            }
            target="_blank"
            rel="noopener noreferrer"
            className="border border-[var(--store-border)] px-5 py-3 text-sm font-black text-[var(--store-primary)]"
            style={{ borderRadius: "var(--store-radius-button)" }}
          >
            {t("store.confirmation.askOnWhatsapp")}
          </a>
        ) : null}
      </div>
    </div>
  );
}
