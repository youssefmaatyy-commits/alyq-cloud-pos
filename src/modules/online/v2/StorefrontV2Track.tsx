/** Private order tracking. The existing lookupOrder(reference, phone) is the
 * only read; an order number in the URL is not enough to reveal a record. */
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useLocation, useSearchParams } from "react-router-dom";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { useStoreAccount } from "../hooks/StoreAccountProvider";
import { applyDocumentMeta, clearDocumentMeta } from "../services/seo";
import type { OnlineOrder } from "../types";
import { V2OrderDetails, V2Panel, V2ProofPanel } from "./JourneyParts";

export function StorefrontV2Track() {
  const { t } = useI18n();
  const { track } = useStoreAccount();
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const state = location.state as { number?: string; phone?: string } | null;
  const [number, setNumber] = useState(params.get("number") || state?.number || "");
  const [phone, setPhone] = useState(state?.phone || "");
  const [order, setOrder] = useState<OnlineOrder | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [touched, setTouched] = useState(false);
  const request = useRef(0);

  useEffect(() => {
    applyDocumentMeta({ title: t("store.track.title"), description: "", noIndex: true });
    return () => clearDocumentMeta();
  }, [t]);
  useEffect(() => () => { request.current += 1; }, []);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setTouched(true);
    setError(false);
    setOrder(null);
    if (!number.trim() || !phone.trim()) return;
    const id = ++request.current;
    setLoading(true);
    // A shareable order reference is harmless by itself. Never put the phone
    // or an order object in the hash/query string.
    setParams(number.trim() ? { number: number.trim() } : {}, { replace: true });
    try {
      const found = await track(number.trim(), phone.trim());
      if (request.current === id) { setOrder(found); setError(!found); }
    } catch {
      if (request.current === id) setError(true);
    } finally {
      if (request.current === id) setLoading(false);
    }
  };

  return <div className="v2-journey v2-container" data-testid="v2-track">
    <h1>{t("store.track.title")}</h1>
    <p className="v2-small">{t("store.track.hint")}</p>
    <div className="v2-journey-grid"><div className="v2-journey-main">
      <V2Panel><form className="v2-track-form" onSubmit={(event) => void submit(event)} noValidate>
        <label className="v2-field">{t("store.confirmation.orderNumber")}
          <input dir="ltr" autoComplete="off" value={number} onChange={(event) => { setNumber(event.target.value); setOrder(null); }}
            required aria-invalid={touched && !number.trim()} />
        </label>
        <label className="v2-field">{t("store.checkout.phone")}
          <input dir="ltr" type="tel" inputMode="tel" autoComplete="tel" value={phone}
            onChange={(event) => { setPhone(event.target.value); setOrder(null); }}
            required aria-invalid={touched && !phone.trim()} />
        </label>
        {touched && (!number.trim() || !phone.trim()) ? <p role="alert" className="v2-field-error">
          {t("store.v2.journey.trackBoth")}</p> : null}
        <button type="submit" disabled={loading} className="v2-primary-button" data-testid="v2-track-submit">
          {loading ? t("common.loading") : t("store.track.search")}</button>
      </form></V2Panel>
      {error ? <V2Panel><p role="alert" className="v2-alert" data-testid="v2-track-error">
        {t("store.track.notFound")}</p><p className="v2-small">{t("store.track.notFoundHint")}</p></V2Panel> : null}
      {order ? <div data-testid="v2-tracked-order"><V2Panel>
        <p className="v2-small">{t("store.confirmation.orderNumber")}</p>
        <h2 dir="ltr">{order.order_number}</h2>
        <div className="v2-order-badges"><span>{t(`online.status.${order.status}` as never)}</span>
          <span>{t(`online.paymentStatus.${order.payment_status}` as never)}</span></div>
      </V2Panel><V2ProofPanel order={order} /><V2OrderDetails order={order} timeline />
      </div> : null}
    </div><aside className="v2-journey-aside"><V2Panel title={t("store.confirmation.whatHappensNext")}>
      <p className="v2-small">{t("store.confirmation.step3")}</p>
      <Link to="/store/contact" className="v2-text-link">{t("store.nav.contact")}</Link>
    </V2Panel></aside></div>
  </div>;
}
