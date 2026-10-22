/** V2 cart presentation over the existing StoreCartProvider. No separate line
 * identity, price, coupon, stock or checkout implementation. */
import { useEffect } from "react";
import { Link } from "react-router-dom";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { useStoreCart, storeLineKey } from "../hooks/StoreCartProvider";
import { useStorefront } from "../hooks/StorefrontProvider";
import { applyDocumentMeta, clearDocumentMeta } from "../services/seo";
import { V2Image, V2Status } from "./Primitives";
import { V2CartTotals, V2Coupon, V2Panel } from "./JourneyParts";

export function StorefrontV2Cart() {
  const { t, pick, money } = useI18n();
  const { settings, mode, loading, error, refresh } = useStorefront();
  const { entries, lines, unitCount, isEmpty, increase, decrease, remove, clear,
    totals, problems, prunedCount, acknowledgePruned, preview } = useStoreCart();
  useEffect(() => {
    applyDocumentMeta({ title: t("store.cart.title"), description: "", noIndex: true });
    return () => clearDocumentMeta();
  }, [t]);
  const unlisted = Math.max(0, lines.length - entries.length);
  const blocked = problems.length > 0 || unlisted > 0 || entries.some((entry) => !entry.product.stock_tracking_enabled);
  const canCheckout = !blocked && (settings.delivery.enabled || settings.delivery.pickup_enabled) &&
    (settings.delivery.cod_enabled || settings.delivery.instapay_enabled);

  return <div className="v2-journey v2-container" data-testid="v2-cart">
    <h1>{t("store.cart.title")}</h1>
    {prunedCount > 0 ? <p role="status" className="v2-alert" data-testid="v2-cart-pruned">
      {t("store.v2.journey.cartPruned")}
      <button type="button" onClick={acknowledgePruned}>{t("common.dismiss")}</button></p> : null}
    {loading && !entries.length ? <p className="v2-small" role="status">{t("common.loading")}</p> : null}
    {error && !entries.length ? <V2Panel><p role="alert">{t("store.v2.error")}</p>
      <button type="button" className="v2-outline-button" onClick={() => void refresh()}>{t("store.v2.retry")}</button></V2Panel> : null}
    {!loading && !error && isEmpty ? <V2Panel className="v2-journey-empty">
      <p>{t("store.cart.emptyHint")}</p>
      <Link to="/store/products" className="v2-primary-button">{t("store.cart.startShopping")}</Link>
    </V2Panel> : null}
    {!isEmpty ? <>
      <p className="v2-small">{t("store.cart.itemCount", { count: unitCount })}</p>
      {blocked ? <p role="alert" className="v2-alert">{t("store.cart.stockProblem")}</p> : null}
      <div className="v2-journey-grid">
        <div className="v2-cart-lines" aria-label={t("store.cart.title")}>
          {entries.map((entry) => {
            const variantId = entry.variant?.id ?? null;
            const key = storeLineKey(entry.product.id, variantId);
            const issue = problems.find((problem) => storeLineKey(problem.product_id, problem.variant_id) === key);
            const linePreview = preview?.lines.find((candidate) => candidate.product_id === entry.product.id && (candidate.variant_id ?? null) === variantId);
            const lineEffectiveTotal = linePreview ? linePreview.line_total : entry.lineTotal;
            const lineOriginalTotal = linePreview ? linePreview.unit_price * entry.quantity : entry.listPrice * entry.quantity;
            const hasLineDiscount = lineEffectiveTotal < lineOriginalTotal;
            const path = `/store/products/${encodeURIComponent(entry.content?.slug?.trim() || entry.product.id)}`;
            const name = pick(entry.product.name_ar, entry.product.name_en);
            return <article className="v2-cart-line" key={key} data-testid="v2-cart-line" data-variant-id={variantId ?? ""}>
              <Link to={path} className="v2-cart-photo" aria-label={name}>
                <V2Image src={(entry.variant?.images ?? [])[0] || entry.variant?.image_url || entry.product.image_url || entry.product.images[0]}
                  alt={name} fit="contain" />
              </Link>
              <div className="v2-cart-line-body"><div className="v2-cart-line-head">
                <Link to={path} className="v2-cart-line-name">{name}</Link>
                <button type="button" className="v2-cart-remove" aria-label={`${t("store.cart.remove")}: ${name}`}
                  onClick={() => remove(entry.product.id, variantId)}>{t("store.cart.remove")}</button>
              </div>
                {entry.variantLabel ? <p className="v2-cart-variant" data-testid="v2-cart-variant">
                  {entry.variantLabel} · {entry.variant?.sku}</p> : <p className="v2-small">{entry.product.sku}</p>}
                {linePreview?.promotion_name ? <p className="v2-small font-bold text-emerald-700" style={{ color: "var(--v2-success, #059669)" }}>
                  🏷️ {linePreview.promotion_name}
                  {linePreview.rewarded_units && linePreview.rewarded_units > 0 ? ` · 🎁 ${t("online.promos.rewardedUnit")} (${linePreview.rewarded_units})` : ""}
                </p> : null}
                <V2Status available={entry.available} mode={mode} tracked={entry.product.stock_tracking_enabled} />
                {issue ? <p className="v2-field-error" role="alert">{t("store.cart.onlyAvailable", { count: issue.available })}</p> : null}
                <div className="v2-cart-line-bottom"><div className="v2-stepper" role="group" aria-label={`${t("store.v2.quantity")}: ${name}`}>
                  <button type="button" onClick={() => decrease(entry.product.id, variantId)} aria-label={t("store.cart.decrease")}>−</button>
                  <output aria-label={t("store.v2.quantity")}>{entry.quantity}</output>
                  <button type="button" onClick={() => increase(entry.product.id, variantId)}
                    disabled={entry.available !== null && entry.quantity >= entry.available}
                    aria-label={t("store.cart.increase")}>+</button>
                </div><div className="v2-cart-line-price"><span>{money(entry.price)} × {entry.quantity}</span>
                  <strong>{money(lineEffectiveTotal)}</strong>
                  {hasLineDiscount ? <del>{money(lineOriginalTotal)}</del> : null}
                </div></div>
              </div>
            </article>;
          })}
          <div className="v2-cart-actions"><Link to="/store/products" className="v2-text-link">
            {t("store.cart.continueShopping")}</Link>
            <button type="button" onClick={clear}>{t("store.cart.clear")}</button>
          </div>
        </div>
        <aside className="v2-journey-aside"><V2Panel title={t("store.cart.summary")}>
          <V2CartTotals showDelivery />
          <V2Coupon />
          {!canCheckout ? <p className="v2-field-error" role="status">{blocked ? t("store.cart.stockProblem")
            : t("store.checkout.orderingDisabled")}</p> : null}
          <Link to="/store/checkout" aria-disabled={!canCheckout} tabIndex={canCheckout ? 0 : -1}
            onClick={(event) => { if (!canCheckout) event.preventDefault(); }}
            className="v2-primary-button v2-cart-checkout" data-testid="v2-cart-checkout">
            {t("store.cart.checkout")}</Link>
          <p className="v2-small">{t("store.v2.stockAtCheckout")}</p>
        </V2Panel></aside>
      </div>
    </> : null}
    {/* Advisory totals are explicitly not the amount the RPC will accept. */}
    <span className="sr-only" aria-live="polite">{!isEmpty && totals.unit_count}</span>
  </div>;
}
