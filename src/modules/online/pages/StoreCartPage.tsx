/**
 * The cart.
 *
 * Three things this screen has to get right. It shows the price the customer will
 * actually pay — campaign price, with the catalogue price struck through — so the
 * total on the next screen is not a surprise. It says plainly when a line cannot
 * be fulfilled, rather than letting checkout refuse it. And it takes a coupon
 * code here, where there is room to explain why one was rejected, instead of at
 * the last step.
 */
import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { useStoreCart } from "../hooks/StoreCartProvider";
import { useStorefront } from "../hooks/StorefrontProvider";
import { Money, StoreImage, FreeDeliveryBar } from "../components/storefront/StorePrimitives";
import { applyDocumentMeta, clearDocumentMeta } from "../services/seo";

export function StoreCartPage() {
  const { t, pick, money } = useI18n();

  // A basket is one shopper's private state: it gets a sensible title in the
  // browser tab and is kept out of the index.
  useEffect(() => {
    applyDocumentMeta({ title: t("store.cart.title"), description: "", noIndex: true });
    return () => clearDocumentMeta();
  }, [t]);
  const navigate = useNavigate();
  const { settings } = useStorefront();
  const {
    entries,
    isEmpty,
    increase,
    decrease,
    remove,
    clear,
    totals,
    problems,
    couponCode,
    couponInput,
    setCouponInput,
    couponError,
    applyingCoupon,
    applyCoupon,
    clearCoupon,
    freeDelivery,
    preview,
  } = useStoreCart();

  const [codeDraft, setCodeDraft] = useState(couponInput);

  if (isEmpty) {
    return (
      <div className="mx-auto w-full max-w-2xl px-4 py-20 text-center">
        <p className="text-lg font-black text-[var(--store-text-primary)]">{t("store.cart.empty")}</p>
        <p className="mt-2 text-sm text-[var(--store-text-secondary)]">{t("store.cart.emptyHint")}</p>
        <Link
          to="/store/products"
          className="mt-6 inline-block bg-[var(--store-primary)] px-6 py-3 text-sm font-black text-[var(--store-on-primary)]"
          style={{ borderRadius: "var(--store-radius-button)" }}
        >
          {t("store.cart.startShopping")}
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-[var(--store-max-width,72rem)] px-4 py-6 sm:px-6">
      <h1 className="text-2xl font-black tracking-tight text-[var(--store-text-primary)]">{t("store.cart.title")}</h1>
      <p className="mt-1 text-xs font-semibold text-[var(--store-text-secondary)]">
        {t("store.cart.itemCount", { count: totals.unit_count })}
      </p>

      {problems.length > 0 ? (
        <div className="mt-4 border border-amber-300 bg-amber-50 p-3 text-sm font-semibold text-amber-900" style={{ borderRadius: "var(--store-radius)" }}>
          {t("store.cart.stockProblem")}
        </div>
      ) : null}

      <div className="mt-5 grid gap-6 lg:grid-cols-[1fr_20rem]">
        <div className="flex flex-col gap-3">
          {entries.map((entry) => {
            // Phase 43: a line IS a combination — the key and every operation
            // name product + variant, so Gold / 17 and Silver / 17 are two
            // rows that never merge and never reach into each other's shelf.
            const lineKey = `${entry.product.id}::${entry.variant?.id ?? ""}`;
            const problem = problems.find(
              (candidate) =>
                candidate.product_id === entry.product.id &&
                (candidate.variant_id ?? null) === (entry.variant?.id ?? null),
            );
            return (
              <article
                key={lineKey}
                className="flex gap-3 border border-[var(--store-border)] bg-[var(--store-surface)] p-3"
                style={{ borderRadius: "var(--store-radius)" }}
              >
                <Link to={`/store/products/${encodeURIComponent(entry.content?.slug?.trim() || entry.product.id)}`} className="shrink-0">
                  <StoreImage
                    src={entry.product.image_url ?? entry.product.images[0] ?? null}
                    alt={pick(entry.product.name_ar, entry.product.name_en)}
                    ratio=""
                    className="h-20 w-20"
                    sizes="80px"
                  />
                </Link>

                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <div className="flex items-start justify-between gap-2">
                    <Link
                      to={`/store/products/${encodeURIComponent(entry.content?.slug?.trim() || entry.product.id)}`}
                      className="line-clamp-2 text-sm font-bold text-[var(--store-text-primary)] hover:text-[var(--store-primary)]"
                    >
                      {pick(entry.product.name_ar, entry.product.name_en)}
                    </Link>
                    <button
                      type="button"
                      onClick={() => remove(entry.product.id, entry.variant?.id ?? null)}
                      className="shrink-0 text-xs font-bold text-[var(--store-text-secondary)] hover:text-rose-600"
                      aria-label={t("store.cart.remove")}
                    >
                      {t("store.cart.remove")}
                    </button>
                  </div>

                  {entry.variantLabel ? (
                    <p
                      className="text-xs font-black text-[var(--store-text-primary)]"
                      data-testid="cart-line-variant"
                    >
                      {entry.variantLabel}
                    </p>
                  ) : null}

                  <p className="text-[11px] font-semibold text-[var(--store-text-secondary)]">
                    {entry.variant?.sku ?? entry.product.sku}
                    {entry.content?.brand_en || entry.content?.brand_ar
                      ? ` · ${pick(entry.content?.brand_ar ?? null, entry.content?.brand_en ?? null)}`
                      : ""}
                  </p>

                  <div className="mt-auto flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => decrease(entry.product.id, entry.variant?.id ?? null)}
                        className="grid h-8 w-8 place-items-center rounded-lg border border-[var(--store-border)] font-bold text-[var(--store-text-secondary)]"
                        aria-label={t("store.cart.decrease")}
                      >
                        −
                      </button>
                      <span className="min-w-6 text-center text-sm font-black tabular-nums text-[var(--store-text-primary)]">
                        {entry.quantity}
                      </span>
                      <button
                        type="button"
                        onClick={() => increase(entry.product.id, entry.variant?.id ?? null)}
                        disabled={entry.available !== null && entry.quantity >= entry.available}
                        className="grid h-8 w-8 place-items-center rounded-lg border border-[var(--store-border)] font-bold text-[var(--store-primary)] disabled:opacity-40"
                        aria-label={t("store.cart.increase")}
                      >
                        +
                      </button>
                    </div>

                    <p className="flex items-baseline gap-2">
                      <Money value={entry.lineTotal} className="text-sm font-black text-[var(--store-text-primary)]" />
                      {entry.price < entry.listPrice ? (
                        <Money value={entry.listPrice * entry.quantity} strike className="text-xs" />
                      ) : null}
                    </p>
                  </div>

                  {problem ? (
                    <p className="mt-1 text-[11px] font-bold text-rose-600">
                      {t("store.cart.onlyAvailable", { count: problem.available })}
                    </p>
                  ) : entry.available !== null && entry.available <= 5 && entry.available > 0 ? (
                    <p className="mt-1 text-[11px] font-bold text-amber-600">
                      {t("store.product.onlyLeft", { count: entry.available })}
                    </p>
                  ) : null}
                </div>
              </article>
            );
          })}

          <div className="flex items-center justify-between gap-3 pt-1">
            <Link to="/store/products" className="text-xs font-bold text-[var(--store-primary)] hover:underline">
              {t("store.cart.continueShopping")}
            </Link>
            <button
              type="button"
              onClick={clear}
              className="text-xs font-bold text-[var(--store-text-secondary)] hover:text-rose-600"
            >
              {t("store.cart.clear")}
            </button>
          </div>
        </div>

        <aside className="flex flex-col gap-4 lg:sticky lg:top-24 lg:self-start">
          <div className="border border-[var(--store-border)] bg-[var(--store-surface)] p-4" style={{ borderRadius: "var(--store-radius)" }}>
            <h2 className="text-sm font-black uppercase tracking-widest text-[var(--store-text-secondary)]">
              {t("store.cart.summary")}
            </h2>

            <dl className="mt-3 space-y-2 text-sm">
              <div className="flex justify-between gap-2">
                <dt className="text-[var(--store-text-secondary)]">{t("store.cart.subtotal")}</dt>
                <dd className="font-bold text-[var(--store-text-primary)]"><Money value={preview?.subtotal ?? totals.subtotal} /></dd>
              </div>
              {(preview?.autoDiscount ?? 0) > 0 ? (
                <div className="flex justify-between gap-2 text-emerald-700">
                  <dt>
                    {t("store.checkout.productDiscounts")}
                    {preview?.autoPromotionName ? ` · ${preview.autoPromotionName}` : ""}
                  </dt>
                  <dd className="font-bold">−{money(preview?.autoDiscount ?? 0)}</dd>
                </div>
              ) : null}
              {(preview?.promoDiscount ?? totals.discount_amount) > 0 ? (
                <div className="flex justify-between gap-2 text-emerald-700">
                  <dt>
                    {t("store.cart.discount")}
                    {(preview?.promoCode ?? totals.discount_code) ? ` · ${preview?.promoCode ?? totals.discount_code}` : ""}
                  </dt>
                  <dd className="font-bold">−{money(preview?.promoDiscount ?? totals.discount_amount)}</dd>
                </div>
              ) : null}
              {(preview?.deliveryFee ?? totals.delivery_fee) > 0 ? (
                <div className="flex justify-between gap-2">
                  <dt className="text-[var(--store-text-secondary)]">
                    {t("store.cart.deliveryFee")}
                    {preview?.zoneName ? ` · ${preview.zoneName}` : ""}
                  </dt>
                  <dd className="font-bold text-[var(--store-text-primary)]"><Money value={preview?.deliveryFee ?? totals.delivery_fee} /></dd>
                </div>
              ) : null}
              {(preview?.shippingDiscount ?? 0) > 0 ? (
                <div className="flex justify-between gap-2 text-emerald-700">
                  <dt>{t("store.checkout.deliveryDiscount")}</dt>
                  <dd className="font-bold">−{money(preview?.shippingDiscount ?? 0)}</dd>
                </div>
              ) : null}
              <div className="flex justify-between gap-2 border-t border-[var(--store-border)] pt-2 text-base">
                <dt className="font-black text-[var(--store-text-primary)]">{t("store.cart.total")}</dt>
                <dd className="font-black text-[var(--store-text-primary)]"><Money value={preview?.total ?? totals.total} /></dd>
              </div>
            </dl>

            {freeDelivery ? (
              <div className="mt-3">
                <FreeDeliveryBar
                  eligible={freeDelivery.eligible}
                  remaining={freeDelivery.remaining}
                  threshold={freeDelivery.threshold}
                />
              </div>
            ) : null}

            <button
              type="button"
              onClick={() => navigate("/store/checkout")}
              disabled={problems.length > 0}
              className="mt-4 w-full bg-[var(--store-primary)] px-4 py-3 text-sm font-black text-[var(--store-on-primary)] transition hover:bg-[var(--store-primary-hover)] disabled:cursor-not-allowed disabled:bg-[var(--store-border)] disabled:text-[var(--store-text-secondary)]"
              style={{ borderRadius: "var(--store-radius-button)" }}
            >
              {t("store.cart.checkout")}
            </button>
            <p className="mt-2 text-[11px] font-medium text-[var(--store-text-secondary)]">
              {t("store.cart.pricesRefreshed")}
            </p>
          </div>

          <div className="border border-[var(--store-border)] bg-[var(--store-surface)] p-4" style={{ borderRadius: "var(--store-radius)" }}>
            <h2 className="text-sm font-black uppercase tracking-widest text-[var(--store-text-secondary)]">
              {t("store.cart.coupon")}
            </h2>
            {couponCode ? (
              <div className="mt-3 flex items-center justify-between gap-2 rounded-lg bg-[var(--store-primary-soft)] px-3 py-2">
                <p className="text-sm font-black text-[var(--store-primary)]">{couponCode}</p>
                <button
                  type="button"
                  onClick={clearCoupon}
                  className="text-xs font-bold text-[var(--store-text-secondary)] hover:text-rose-600"
                >
                  {t("store.cart.removeCoupon")}
                </button>
              </div>
            ) : (
              <form
                className="mt-3 flex gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  void applyCoupon(codeDraft);
                }}
              >
                <input
                  value={codeDraft}
                  onChange={(event) => {
                    setCodeDraft(event.target.value);
                    setCouponInput(event.target.value);
                  }}
                  placeholder={t("store.cart.couponPlaceholder")}
                  className="min-w-0 flex-1 rounded-lg border border-[var(--store-border)] bg-[var(--store-surface)] px-3 py-2 text-sm uppercase outline-none focus:border-[var(--store-primary)]"
                />
                <button
                  type="submit"
                  disabled={applyingCoupon || !codeDraft.trim()}
                  className="shrink-0 rounded-lg border border-[var(--store-primary)] px-3 py-2 text-xs font-black text-[var(--store-primary)] transition hover:bg-[var(--store-primary-soft)] disabled:opacity-40"
                >
                  {applyingCoupon ? t("common.loading") : t("store.cart.applyCoupon")}
                </button>
              </form>
            )}
            {couponError ? (
              <p className="mt-2 text-xs font-bold text-rose-600">
                {t(`store.coupon.${couponError}` as never)}
              </p>
            ) : null}
            {!couponError && couponCode ? (
              <p className="mt-2 text-xs font-bold text-emerald-600">{t("store.coupon.applied")}</p>
            ) : null}
          </div>

          {pick(settings.delivery.note_ar, settings.delivery.note_en) ? (
            <p className="px-1 text-[11px] leading-relaxed text-[var(--store-text-secondary)]">
              {pick(settings.delivery.note_ar, settings.delivery.note_en)}
            </p>
          ) : null}
        </aside>
      </div>
    </div>
  );
}
