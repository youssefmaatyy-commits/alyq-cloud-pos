/** V2 receipt: render only the order returned by checkout or by the existing
 * reference+phone lookup. Session storage holds a short-lived *pair*, never
 * the order body. Another tab/device must use private tracking instead. */
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { useStoreCart } from "../hooks/StoreCartProvider";
import { useStorefront } from "../hooks/StorefrontProvider";
import { resolvedSocialLinks } from "../services/settingsDefaults";
import { socialChannelHref } from "../services/socialSafety";
import { applyDocumentMeta, clearDocumentMeta } from "../services/seo";
import type { OnlineOrder } from "../types";
import { readV2Receipt } from "./journeyModel";
import { V2ActionLink } from "./Primitives";
import { V2OrderDetails, V2Panel, V2ProofPanel } from "./JourneyParts";

export function StorefrontV2Confirmation() {
  const { t, pick } = useI18n();
  const { settings, lookupOrder } = useStorefront();
  const { lastOrder, lastWasDuplicate, dismissLastOrder } = useStoreCart();
  const [restored, setRestored] = useState<OnlineOrder | null>(null);
  const [loading, setLoading] = useState(!lastOrder);
  const [copied, setCopied] = useState(false);
  const order = lastOrder ?? restored;
  const copy = settings.confirmation;
  const message = pick(copy.message_ar, copy.message_en).trim();
  const whatsappRow = resolvedSocialLinks(settings).find((row) => row.platform === "whatsapp" && row.enabled);
  const whatsapp = order && copy.whatsapp_cta && whatsappRow ? socialChannelHref("whatsapp", whatsappRow.url,
    t("store.confirmation.whatsappMessage", { number: order.order_number })) : null;

  useEffect(() => {
    applyDocumentMeta({ title: t("store.confirmation.title"), description: "", noIndex: true });
    return () => clearDocumentMeta();
  }, [t]);
  useEffect(() => {
    if (lastOrder) { setLoading(false); return; }
    let pair = null;
    try { pair = readV2Receipt(window.sessionStorage); } catch { /* private storage */ }
    if (!pair) { setLoading(false); return; }
    let active = true;
    setLoading(true);
    void lookupOrder(pair.order, pair.phone).then((found) => {
      if (active) setRestored(found);
    }).catch(() => { if (active) setRestored(null); }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [lastOrder, lookupOrder]);

  const copyNumber = async () => {
    if (!order) return;
    try { await navigator.clipboard.writeText(order.order_number); setCopied(true); }
    catch { setCopied(false); }
  };

  return <div className="v2-journey v2-container" data-testid="v2-confirmation">
    <p className="v2-eyebrow">{t("store.confirmation.received")}</p>
    <h1>{pick(copy.title_ar, copy.title_en).trim() || t("store.confirmation.title")}</h1>
    {loading ? <V2Panel><p role="status" className="v2-small">{t("common.loading")}</p></V2Panel> : null}
    {!loading && !order ? <V2Panel className="v2-journey-empty" testId="v2-receipt-private">
      <p>{t("store.v2.journey.receiptPrivate")}</p>
      <Link to="/store/track" className="v2-primary-button">{t("store.confirmation.trackOrder")}</Link>
    </V2Panel> : null}
    {order && <>
      {lastWasDuplicate ? <p className="v2-alert" role="status">{t("store.confirmation.duplicateNote")}</p> : null}
      <div className="v2-journey-grid"><div className="v2-journey-main">
        <V2Panel className="v2-receipt-hero">
          <p>{message || t("store.confirmation.thankYou")}</p>
          <p className="v2-small">{pick(copy.guidance_ar, copy.guidance_en) || t("store.confirmation.step1")}</p>
          <div className="v2-receipt-number"><span>{t("store.confirmation.orderNumber")}</span>
            <strong dir="ltr" data-testid="v2-order-number">{order.order_number}</strong>
            <button type="button" className="v2-outline-button" onClick={() => void copyNumber()}>
              {copied ? t("store.confirmation.copied") : t("store.confirmation.copyNumber")}</button>
          </div>
          <div className="v2-order-badges"><span>{t(`online.status.${order.status}` as never)}</span>
            <span>{t(`online.paymentStatus.${order.payment_status}` as never)}</span></div>
          <p className="v2-small">{t("store.confirmation.step3")}</p>
        </V2Panel>
        <V2ProofPanel order={order} />
        <V2OrderDetails order={order} />
      </div><aside className="v2-journey-aside"><V2Panel title={t("store.confirmation.whatHappensNext")}>
        <ol className="v2-next-steps"><li>{t("store.confirmation.step1")}</li>
          <li>{t("store.confirmation.step2")}</li><li>{t("store.confirmation.step3")}</li></ol>
        {order.payment_method === "instapay" ? <p className="v2-alert" role="status">
          {t("store.checkout.instapayNeverAutomatic")}</p> : <p className="v2-small">{t("store.confirmation.codNote")}</p>}
        <Link to="/store/track" state={{ number: order.order_number, phone: order.customer_phone }}
          className="v2-primary-button">{t("store.confirmation.trackOrder")}</Link>
        {copy.support_href ? <V2ActionLink href={copy.support_href} className="v2-outline-button">
          {pick(copy.support_cta_ar, copy.support_cta_en) || t("store.nav.contact")}</V2ActionLink> : null}
        {whatsapp ? <a href={whatsapp} className="v2-text-link" target="_blank" rel="noopener noreferrer">
          {t("store.confirmation.askOnWhatsapp")}</a> : null}
        <Link to="/store/products" className="v2-text-link" onClick={dismissLastOrder}>
          {t("store.cart.continueShopping")}</Link>
      </V2Panel></aside></div>
    </>}
  </div>;
}
