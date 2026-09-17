/**
 * Order tracking.
 *
 * A customer who has spent money wants two answers and nothing else: where is my
 * order, and have you got my money. Those are separate questions with separate
 * answers, so this screen shows them separately — an order can be approved and
 * packed while its cash-on-delivery payment is still uncollected, and it is more
 * honest to say so than to collapse both into one reassuring word.
 *
 * Lookup is by order number plus the phone the order was placed with; that pair
 * is the only thing the customer definitely still has. No account required, so a
 * guest checkout can be tracked too.
 */
import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { cn } from "@/utils/cn";
import { useStoreAccount } from "../hooks/StoreAccountProvider";
import { useStorefront } from "../hooks/StorefrontProvider";
import { ONLINE_ORDER_STATUSES, type OnlineOrder } from "../types";
import { Money, OrderStatusPill, OrderSummary, PaymentStatusPill, StoreImage } from "../components/storefront/StorePrimitives";
import { PaymentProofPanel } from "../components/storefront/PaymentProofPanel";
import { applyDocumentMeta, clearDocumentMeta } from "../services/seo";
import { deliveryHintKey } from "../services/orderWorkflow";

/** The forward path a customer follows; cancellation is a branch, not a step. */
const TIMELINE = ONLINE_ORDER_STATUSES.filter((status) => status !== "cancelled");

export function StoreTrackPage() {
  const { t, pick } = useI18n();
  const { track } = useStoreAccount();
  const { settings, products } = useStorefront();
  const [params, setParams] = useSearchParams();

  const [number, setNumber] = useState(params.get("order") ?? "");
  const [phone, setPhone] = useState(params.get("phone") ?? "");
  const [state, setState] = useState<"idle" | "loading" | "found" | "missing">("idle");
  const [order, setOrder] = useState<OnlineOrder | null>(null);

  useEffect(() => {
    applyDocumentMeta({ title: t("store.track.title"), description: t("store.track.hint"), noIndex: true });
    return () => clearDocumentMeta();
  }, [t]);

  const lookup = async (orderNumber: string, customerPhone: string) => {
    setState("loading");
    const found = await track(orderNumber.trim(), customerPhone.trim());
    if (found) {
      setOrder(found);
      setState("found");
      setParams({ order: orderNumber.trim(), phone: customerPhone.trim() }, { replace: true });
    } else {
      setOrder(null);
      setState("missing");
    }
  };

  // A link from the confirmation page already carries both halves.
  useEffect(() => {
    const fromUrl = params.get("order");
    const phoneFromUrl = params.get("phone");
    if (fromUrl && phoneFromUrl) void lookup(fromUrl, phoneFromUrl);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const inputClass =
    "w-full rounded-lg border border-[var(--store-border)] bg-[var(--store-surface)] px-3 py-2 text-sm text-[var(--store-text)] outline-none transition focus:border-[var(--store-primary)]";

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6">
      <h1 className="text-2xl font-black tracking-tight text-[var(--store-text)]">{t("store.track.title")}</h1>
      <p className="mt-1 text-sm text-[var(--store-muted)]">{t("store.track.hint")}</p>

      <form
        className="mt-5 grid gap-3 sm:grid-cols-[1fr_1fr_auto]"
        onSubmit={(event) => {
          event.preventDefault();
          if (!number.trim() || !phone.trim()) return;
          void lookup(number, phone);
        }}
      >
        <label className="block">
          <span className="mb-1 block text-xs font-bold text-[var(--store-text)]">{t("store.track.orderNumber")}</span>
          <input
            value={number}
            onChange={(event) => setNumber(event.target.value)}
            className={inputClass}
            placeholder="WEB-000001"
            autoComplete="off"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-bold text-[var(--store-text)]">{t("store.checkout.phone")}</span>
          <input value={phone} onChange={(event) => setPhone(event.target.value)} className={inputClass} inputMode="tel" autoComplete="off" />
        </label>
        <button
          type="submit"
          disabled={state === "loading" || !number.trim() || !phone.trim()}
          className="self-end bg-[var(--store-primary)] px-5 py-2.5 text-sm font-black text-[var(--store-on-primary)] transition hover:bg-[var(--store-primary-hover)] disabled:opacity-40"
          style={{ borderRadius: "var(--store-radius-button)" }}
        >
          {state === "loading" ? t("common.loading") : t("store.track.search")}
        </button>
      </form>

      {state === "missing" ? (
        <div className="mt-5 border border-rose-200 bg-rose-50 p-4 text-sm font-semibold text-rose-800" style={{ borderRadius: "var(--store-radius)" }}>
          {t("store.track.notFound")}
          <span className="mt-1 block text-xs font-medium">{t("store.track.notFoundHint")}</span>
        </div>
      ) : null}

      {order ? (
        <div className="mt-6 flex flex-col gap-4">
          <section className="border border-[var(--store-border)] bg-[var(--store-surface)] p-4" style={{ borderRadius: "var(--store-radius)" }}>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="text-[11px] font-black uppercase tracking-widest text-[var(--store-muted)]">
                  {t("store.confirmation.orderNumber")}
                </p>
                <p className="text-xl font-black tabular-nums text-[var(--store-text)]">{order.order_number}</p>
                <p className="mt-0.5 text-xs text-[var(--store-muted)]">
                  {new Date(order.created_at).toLocaleString(pick("ar-EG", "en-GB"))}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <OrderStatusPill status={order.status} />
                <PaymentStatusPill status={order.payment_status} />
              </div>
            </div>

            <p className="mt-3 text-sm font-semibold text-[var(--store-muted)]">
              {t(deliveryHintKey(order))}
            </p>

            {order.status === "cancelled" ? (
              <div className="mt-4 border border-rose-200 bg-rose-50 p-3 text-sm" style={{ borderRadius: "var(--store-radius)" }}>
                <p className="font-black text-rose-800">{t("store.track.cancelled")}</p>
                {order.cancellation_reason ? (
                  <p className="mt-1 text-xs leading-relaxed text-rose-700">{order.cancellation_reason}</p>
                ) : null}
                <p className="mt-2 text-xs font-semibold text-rose-700">{t("store.track.stockReleased")}</p>
              </div>
            ) : (
              <ol className="mt-5 flex items-center gap-1">
                {TIMELINE.map((status, index) => {
                  const currentIndex = order.status === "cancelled" ? -1 : TIMELINE.indexOf(order.status);
                  const reached = index <= currentIndex;
                  return (
                    <li key={status} className="flex flex-1 flex-col items-center gap-1.5 text-center">
                      <span
                        className={cn(
                          "grid h-8 w-8 place-items-center rounded-full border-2 text-xs font-black transition",
                          reached
                            ? "border-[var(--store-primary)] bg-[var(--store-primary)] text-[var(--store-on-primary)]"
                            : "border-[var(--store-border)] text-[var(--store-muted)]",
                        )}
                        aria-hidden
                      >
                        {index + 1}
                      </span>
                      <span
                        className={cn(
                          "text-[10px] font-bold leading-tight",
                          reached ? "text-[var(--store-text)]" : "text-[var(--store-muted)]",
                        )}
                      >
                        {t(`online.status.${status}` as never)}
                      </span>
                    </li>
                  );
                })}
              </ol>
            )}

            {order.payment_status === "verification_required" ? (
              <p className="mt-4 rounded-lg bg-amber-50 p-3 text-xs font-bold leading-relaxed text-amber-800">
                {t("store.track.verificationPending")}
              </p>
            ) : null}
            {order.payment_status === "failed" && order.payment_rejected_reason ? (
              <p className="mt-4 rounded-lg bg-rose-50 p-3 text-xs font-bold leading-relaxed text-rose-700">
                {t("store.track.paymentRejected")}: {order.payment_rejected_reason}
              </p>
            ) : null}
          </section>

          {order.payment_method === "instapay" &&
          order.payment_status !== "paid" &&
          settings.delivery.instapay_proof_required ? (
            <PaymentProofPanel
              orderNumber={order.order_number}
              phone={order.customer_phone}
              total={order.total}
              submitted={order.payment_submitted_at !== null && order.payment_status !== "failed"}
              storedReference={order.payment_reference}
            />
          ) : null}

          <section className="border border-[var(--store-border)] bg-[var(--store-surface)] p-4" style={{ borderRadius: "var(--store-radius)" }}>
            <h2 className="text-sm font-black uppercase tracking-widest text-[var(--store-muted)]">
              {t("store.track.items")}
            </h2>
            <ul className="mt-3 flex flex-col gap-3">
              {order.items.map((item) => (
                <li key={item.id} className="flex items-start gap-3">
                  <StoreImage
                    src={
                      products.find((candidate) => candidate.id === item.product_id)?.image_url ?? null
                    }
                    alt={pick(item.name_ar, item.name_en)}
                    ratio=""
                    className="h-12 w-12"
                    sizes="48px"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-bold text-[var(--store-text)]">
                      {pick(item.name_ar, item.name_en)}
                    </span>
                    {item.variant_id ? (
                      <span className="block text-xs font-bold text-[var(--store-text)]">
                        {pick(item.variant_color_ar, item.variant_color_en)}
                        {item.variant_size !== null
                          ? ` / ${Math.round(item.variant_size * 100) / 100}`
                          : item.variant_size_label
                            ? ` / ${item.variant_size_label}`
                            : ""}
                      </span>
                    ) : null}
                    <span className="block text-xs text-[var(--store-muted)]">
                      {t("store.checkout.quantityTimes", { count: item.quantity })} · {item.sku}
                    </span>
                  </span>
                  <Money value={item.line_total} className="shrink-0 text-sm font-black text-[var(--store-text)]" />
                </li>
              ))}
            </ul>

                        <OrderSummary
              subtotal={order.subtotal}
              discountAmount={order.discount_amount}
              discountCode={order.discount_code}
              deliveryFee={order.delivery_fee}
              total={order.total}
            />
          </section>

          <section className="border border-[var(--store-border)] bg-[var(--store-surface)] p-4" style={{ borderRadius: "var(--store-radius)" }}>
            <h2 className="text-sm font-black uppercase tracking-widest text-[var(--store-muted)]">
              {t("store.confirmation.details")}
            </h2>
            <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-xs font-bold text-[var(--store-muted)]">{t("store.checkout.contactSection")}</dt>
                <dd className="font-semibold text-[var(--store-text)]">
                  {order.customer_name}
                  <span className="block text-xs font-medium text-[var(--store-muted)]">{order.customer_phone}</span>
                </dd>
              </div>
              <div>
                <dt className="text-xs font-bold text-[var(--store-muted)]">
                  {order.delivery_type === "pickup" ? t("store.checkout.pickup") : t("store.checkout.delivery")}
                </dt>
                <dd className="text-xs font-semibold text-[var(--store-text)]">
                  {order.delivery_type === "pickup"
                    ? pick(settings.delivery.pickup_address_ar, settings.delivery.pickup_address_en) ||
                      t("store.footer.pickupAvailable")
                    : order.address
                      ? [order.address.street, order.address.area, order.address.city, order.address.building]
                          .filter(Boolean)
                          .join("، ")
                      : "—"}
                </dd>
              </div>
              <div>
                <dt className="text-xs font-bold text-[var(--store-muted)]">{t("store.checkout.payment")}</dt>
                <dd className="font-semibold text-[var(--store-text)]">
                  {order.payment_method === "instapay" ? t("store.checkout.instapay") : t("store.checkout.cod")}
                </dd>
              </div>
              {order.sale_number ? (
                <div>
                  <dt className="text-xs font-bold text-[var(--store-muted)]">{t("store.track.posSale")}</dt>
                  <dd className="font-semibold text-[var(--store-text)]">{order.sale_number}</dd>
                </div>
              ) : null}
              {order.notes ? (
                <div className="sm:col-span-2">
                  <dt className="text-xs font-bold text-[var(--store-muted)]">{t("store.checkout.orderNotes")}</dt>
                  <dd className="text-xs text-[var(--store-text)]">{order.notes}</dd>
                </div>
              ) : null}
            </dl>
          </section>

          {order.events.length > 0 ? (
            <section className="border border-[var(--store-border)] bg-[var(--store-surface)] p-4" style={{ borderRadius: "var(--store-radius)" }}>
              <h2 className="text-sm font-black uppercase tracking-widest text-[var(--store-muted)]">
                {t("store.track.history")}
              </h2>
              <ol className="mt-3 flex flex-col gap-2">
                {order.events
                  .slice()
                  .reverse()
                  .map((event) => (
                    <li key={event.id} className="flex items-start justify-between gap-3 text-xs">
                      <span>
                        <span className="block font-black text-[var(--store-text)]">
                          {t(`store.track.event.${event.kind}` as never)}
                        </span>
                        {event.note ? (
                          <span className="block text-[var(--store-muted)]">{event.note}</span>
                        ) : null}
                      </span>
                      <span className="shrink-0 font-semibold text-[var(--store-muted)]">
                        {new Date(event.created_at).toLocaleString(pick("ar-EG", "en-GB"))}
                      </span>
                    </li>
                  ))}
              </ol>
            </section>
          ) : null}

          <Link
            to="/store/products"
            className="self-start border border-[var(--store-border)] px-4 py-2.5 text-sm font-black text-[var(--store-text)]"
            style={{ borderRadius: "var(--store-radius-button)" }}
          >
            {t("store.cart.continueShopping")}
          </Link>
        </div>
      ) : null}
    </div>
  );
}
