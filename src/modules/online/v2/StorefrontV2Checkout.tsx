/** Customer-facing V2 checkout. It presents the EXISTING cart/checkout
 * provider and its placeOrder() abstraction; prices and stock remain advisory
 * until the existing authoritative place_online_order path accepts the order. */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type RefObject } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { useStoreCart, type CheckoutInput } from "../hooks/StoreCartProvider";
import { useStoreAccount } from "../hooks/StoreAccountProvider";
import { useStorefront } from "../hooks/StorefrontProvider";
import { deliveryAreaSupported, deliveryAreasOf } from "../services/pricing";
import { externalHref, safeImageField } from "../services/settingsDefaults";
import { applyDocumentMeta, clearDocumentMeta } from "../services/seo";
import type { CustomerAddress, DeliveryZone } from "../types";
import { rememberV2Receipt, v2CheckoutIssues } from "./journeyModel";
import { V2CartTotals, V2Coupon, V2Panel } from "./JourneyParts";
import { V2Icon, V2Image } from "./Primitives";

const blankAddress = (): CustomerAddress => ({ id: "", label: "", full_name: "", phone: "",
  city: "", area: "", street: "", building: "", floor: "", apartment: "", notes: "", is_default: false });
const fields = ["city", "area", "street", "building", "floor", "apartment"] as const;

/** Issue #1 (8th follow-up round): the delivery-zone/governorate picker is a
 * closed-by-default dropdown, not an always-visible card list — a shop with
 * many zones no longer pushes the whole checkout page down just to show its
 * options. Popup positioning is `position: absolute` (see .v2-zone-select in
 * storefront-v2.css), so opening it never changes document flow/height;
 * only the popup's own bounded pane scrolls. Pricing/eligibility logic is
 * completely untouched — this only replaces how the SAME zones/fee/ETA data
 * already computed by the cart provider is presented. */
function V2ZoneSelect({ zones, value, onChange, invalid, triggerRef }: {
  zones: DeliveryZone[]; value: string | null; onChange: (id: string) => void; invalid: boolean;
  triggerRef?: RefObject<HTMLButtonElement | null>;
}) {
  const { t, pick, money } = useI18n();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const selected = zones.find((zone) => zone.id === value) ?? null;

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { setOpen(false); rootRef.current?.querySelector("button")?.focus(); }
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const zoneMeta = (zone: DeliveryZone) => {
    const parts = [zone.shipping_fee ? t("store.checkout.zoneFee", { amount: money(zone.shipping_fee) }) : t("store.checkout.free")];
    if (zone.minimum_order_amount) parts.push(t("store.checkout.zoneMinimum", { amount: money(zone.minimum_order_amount) }));
    const eta = zone.show_estimated_delivery !== false ? pick(zone.estimated_delivery_text_ar, zone.estimated_delivery_text_en) : "";
    if (eta) parts.push(eta);
    return parts.join(" · ");
  };

  return <div className="v2-zone-select" ref={rootRef}>
    <span className="v2-zone-select-label" id="v2-zone-select-label">{t("store.checkout.chooseZone")}</span>
    <button type="button" ref={triggerRef} className="v2-zone-select-trigger" data-testid="v2-zone-select-trigger"
      aria-haspopup="listbox" aria-expanded={open} aria-labelledby="v2-zone-select-label v2-zone-select-value"
      aria-invalid={invalid} onClick={() => setOpen((current) => !current)}>
      <span className="v2-zone-select-value" id="v2-zone-select-value" data-testid="v2-zone-select-value">
        {selected ? pick(selected.name_ar, selected.name_en) : t("store.checkout.zonePlaceholder")}
      </span>
      <V2Icon name="chevronDown" />
    </button>
    {open ? <ul className="v2-zone-select-popup" role="listbox" aria-labelledby="v2-zone-select-label"
      data-testid="v2-zone-select-popup">
      {zones.map((zone) => {
        const isSelected = zone.id === value;
        return <li key={zone.id} role="presentation">
          <button type="button" role="option" aria-selected={isSelected} className="v2-zone-option"
            data-selected={isSelected} data-testid={`v2-zone-option-${zone.key}`}
            onClick={() => { onChange(zone.id); setOpen(false); }}>
            <span className="v2-zone-option-text">
              <strong>{pick(zone.name_ar, zone.name_en)}</strong>
              <small>{zoneMeta(zone)}</small>
            </span>
            {isSelected ? <V2Icon name="check" /> : null}
          </button>
        </li>;
      })}
    </ul> : null}
  </div>;
}

/** Scrolls (and, where it makes sense, focuses) the first invalid field after
 * a failed submit. The header's own rendered height is measured live — not
 * hardcoded — so the target always clears the sticky header regardless of
 * screen size, logo height or whether the merchant even enabled a sticky
 * header at all. `preventScroll` on focus stops the browser's own
 * focus-triggered scroll from fighting this one (the classic iOS Safari
 * double-jump when a text input's keyboard opens mid-scroll); the short
 * delay lets the scroll settle before the keyboard appears. */
function scrollCheckoutFieldIntoView(el: HTMLElement | null, focusField: boolean) {
  if (!el || typeof window === "undefined") return;
  const header = document.querySelector<HTMLElement>(".store-v2 .v2-header.v2-header-sticky");
  const headerOffset = header ? header.getBoundingClientRect().height : 0;
  const rect = el.getBoundingClientRect();
  const target = Math.max(0, window.scrollY + rect.top - headerOffset - 16);
  const reduceMotion = Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);
  window.scrollTo({ top: target, behavior: reduceMotion ? "auto" : "smooth" });
  if (!focusField) return;
  window.setTimeout(() => {
    try { el.focus({ preventScroll: true }); } catch { el.focus(); }
  }, reduceMotion ? 0 : 350);
}

export function StorefrontV2Checkout() {
  const { t, pick, money } = useI18n();
  const navigate = useNavigate();
  const { settings, deliveryZones, loading, error, refresh } = useStorefront();
  const { customer, addresses } = useStoreAccount();
  const cart = useStoreCart();
  const { entries, lines, totals, preview, isEmpty, problems, placing, checkout, checkoutError,
    prunedCount, acknowledgePruned, clearCheckoutError, deliveryType, setDeliveryType, paymentMethod, setPaymentMethod,
    deliveryZoneId, setDeliveryZoneId, setDeliveryLocation, deliveryQuoteReady, couponCode } = cart;
  // Same stale-preview guard the cart totals use: the debounced preview keeps
  // describing the previous coupon state for a moment after a code is applied
  // or removed, and that older breakdown still carries the automatic
  // promotion the coupon has displaced. Ignore it until its own code matches
  // the coupon the cart currently holds, so the amount the shopper is asked
  // to pay never comes from a breakdown for a different coupon.
  const livePreview = preview && preview.promoCode === couponCode ? preview : null;
  const [name, setName] = useState(customer?.name ?? "");
  const [phone, setPhone] = useState(customer?.phone ?? "");
  const [email, setEmail] = useState(customer?.email ?? "");
  const [address, setAddress] = useState<CustomerAddress>(blankAddress);
  const [addressId, setAddressId] = useState<string | null>(null);
  const [notes, setNotes] = useState("");
  const [touched, setTouched] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const pending = useRef(false);
  // Incremented on every submit attempt (whether or not it already failed
  // once before) so the focus-the-first-invalid-field effect below reruns
  // for repeat failures too, always targeting whatever is still wrong.
  const [submitAttempt, setSubmitAttempt] = useState(0);
  const nameRef = useRef<HTMLInputElement>(null);
  const phoneRef = useRef<HTMLInputElement>(null);
  const zoneTriggerRef = useRef<HTMLButtonElement>(null);
  const addressFieldRefs = useRef<Partial<Record<(typeof fields)[number], HTMLInputElement | null>>>({});
  const shortfallRef = useRef<HTMLParagraphElement>(null);
  const defaultAddress = addresses.find((row) => row.is_default) ?? addresses[0] ?? null;
  const zones = useMemo(() => deliveryZones.filter((zone) => zone.enabled), [deliveryZones]);
  const places = useMemo(() => deliveryAreasOf(settings.delivery), [settings.delivery]);
  const goodsTotal = Math.max(0, (livePreview?.subtotal ?? totals.subtotal) -
    (livePreview?.totalDiscount ?? totals.discount_amount + totals.auto_discount));
  const issues = v2CheckoutIssues({ name, phone, address, deliveryType, deliveryZoneId,
    goodsTotal, blockedLines: problems.length + Math.max(0, lines.length - entries.length) +
      entries.filter((entry) => !entry.product.stock_tracking_enabled).length }, settings, zones);
  const orderable = !issues.fulfilment && !issues.payment && !issues.stock;
  const showErrors = touched;
  const copy = settings.checkout_copy;
  const checkoutHeading = pick(copy.heading_ar, copy.heading_en).trim() || t("store.checkout.title");
  const instapayInstructions = pick(settings.delivery.instapay_instructions_ar,
    settings.delivery.instapay_instructions_en).trim();
  const instapayHref = externalHref(settings.social.instapay_link);
  const qr = safeImageField(settings.social.instapay_qr_url);

  useEffect(() => {
    applyDocumentMeta({ title: t("store.checkout.title"), description: "", noIndex: true });
    return () => clearDocumentMeta();
  }, [t]);
  useEffect(() => {
    if (!customer) return;
    setName((current) => current || customer.name);
    setPhone((current) => current || customer.phone);
    setEmail((current) => current || customer.email || "");
    if (defaultAddress) {
      setAddress((current) => current.city || current.street ? current : defaultAddress);
      setAddressId((current) => current ?? defaultAddress.id);
    }
    // Prefill only on account change; do not erase a shopper's typed edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customer?.id]);
  useEffect(() => {
    if (deliveryType === "delivery" && !settings.delivery.enabled && settings.delivery.pickup_enabled) setDeliveryType("pickup");
    if (deliveryType === "pickup" && !settings.delivery.pickup_enabled && settings.delivery.enabled) setDeliveryType("delivery");
    if (paymentMethod === "cod" && !settings.delivery.cod_enabled && settings.delivery.instapay_enabled) setPaymentMethod("instapay");
    if (paymentMethod === "instapay" && !settings.delivery.instapay_enabled && settings.delivery.cod_enabled) setPaymentMethod("cod");
  }, [deliveryType, paymentMethod, setDeliveryType, setPaymentMethod, settings.delivery]);
  useEffect(() => {
    if (deliveryZoneId && !zones.some((zone) => zone.id === deliveryZoneId)) setDeliveryZoneId(null);
  }, [deliveryZoneId, setDeliveryZoneId, zones]);
  // Cart totals do not own the address form. Publish a quote-ready marker only
  // when this checkout has every required contact/location field and (where the
  // merchant configured zones) a selected enabled zone. Any edit clears the
  // old fee until the debounced advisory pricing run completes again.
  useLayoutEffect(() => {
    if (deliveryType !== "delivery") {
      setDeliveryLocation(null);
      return;
    }
    setDeliveryLocation({
      customer_name: name,
      customer_phone: phone,
      city: address.city,
      area: address.area,
      street: address.street,
      zone_ready: zones.length > 0
        ? Boolean(deliveryZoneId && zones.some((zone) => zone.id === deliveryZoneId))
        : deliveryAreaSupported(settings.delivery, address.city, address.area),
    });
  }, [address.area, address.city, address.street, deliveryType, deliveryZoneId, name, phone, setDeliveryLocation, settings.delivery, zones]);

  // Runs after a failed submit (and only then — the ref lookups below read
  // the DOM that has already re-rendered with `touched=true`, so the error
  // text/aria-invalid state this targets is the same state the shopper sees).
  // Order mirrors the form's own visual top-to-bottom order exactly: contact
  // fields, then delivery area (zone), then city/area/street, then the
  // minimum-order notice. Fields that pass validation, or that do not even
  // apply to the current delivery type, are simply skipped.
  useEffect(() => {
    if (submitAttempt === 0) return;
    const candidates: Array<{ invalid: boolean; el: HTMLElement | null; focusField: boolean }> = [
      { invalid: issues.name, el: nameRef.current, focusField: true },
      { invalid: issues.phone, el: phoneRef.current, focusField: true },
      { invalid: issues.zone, el: zoneTriggerRef.current, focusField: true },
      { invalid: issues.address && !address.city.trim(), el: addressFieldRefs.current.city ?? null, focusField: true },
      { invalid: (issues.address && !address.area.trim()) || issues.area, el: addressFieldRefs.current.area ?? null, focusField: true },
      { invalid: issues.address && !address.street.trim(), el: addressFieldRefs.current.street ?? null, focusField: true },
      { invalid: issues.shortfall > 0, el: shortfallRef.current, focusField: false },
    ];
    const first = candidates.find((candidate) => candidate.invalid && candidate.el);
    if (first?.el) scrollCheckoutFieldIntoView(first.el, first.focusField);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [submitAttempt]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending.current || placing) return;
    setTouched(true);
    setSubmitAttempt((count) => count + 1);
    clearCheckoutError();
    if (!orderable || issues.name || issues.phone || issues.address || issues.area || issues.zone || issues.shortfall > 0) return;
    pending.current = true; // synchronous guard, before React disables the button
    setSubmitting(true);
    try {
      const input: CheckoutInput = { customer_name: name.trim(), customer_phone: phone.trim(),
        customer_email: email.trim() || null, address: deliveryType === "delivery" ? address : null,
        notes: notes.trim() || null };
      const order = await checkout(input);
      if (order) {
        try { rememberV2Receipt(order, window.sessionStorage); } catch { /* tracking is still available */ }
        navigate("/store/confirmation", { replace: true });
      }
    } finally {
      pending.current = false;
      setSubmitting(false);
    }
  };

  return <div className="v2-journey v2-container" data-testid="v2-checkout">
    <p className="v2-eyebrow">{t("store.v2.eyebrow")}</p>
    <h1>{checkoutHeading}</h1>
    {!customer ? <p className="v2-small">{t("store.checkout.guestNote")}{" "}
      <Link to="/store/account">{t("store.account.signIn")}</Link></p> : null}
    {prunedCount > 0 ? <p role="status" className="v2-alert">{t("store.v2.journey.cartPruned")}
      <button type="button" onClick={acknowledgePruned}>{t("common.dismiss")}</button></p> : null}
    {loading && isEmpty ? <p role="status" className="v2-small">{t("common.loading")}</p> : null}
    {error && isEmpty ? <V2Panel><p role="alert">{t("store.v2.error")}</p>
      <button type="button" className="v2-outline-button" onClick={() => void refresh()}>{t("store.v2.retry")}</button></V2Panel> : null}
    {!loading && !error && isEmpty ? <V2Panel className="v2-journey-empty"><p>{t("store.cart.emptyHint")}</p>
      <Link to="/store/products" className="v2-primary-button">{t("store.cart.startShopping")}</Link></V2Panel> : null}
    {!isEmpty ? <form onSubmit={(event) => void submit(event)} noValidate>
      {checkoutError ? <p role="alert" className="v2-alert" data-testid="v2-checkout-error">
        {t(`store.error.${checkoutError.code}` as never)}
        {typeof checkoutError.detail.sku === "string" ? ` · ${checkoutError.detail.sku}` : ""}
        {typeof checkoutError.detail.order_number === "string" ? ` · ${checkoutError.detail.order_number}` : ""}
        <button type="button" onClick={clearCheckoutError}>{t("common.dismiss")}</button></p> : null}
      {issues.stock ? <p role="alert" className="v2-alert">{t("store.cart.stockProblem")}{" "}
        <Link to="/store/cart">{t("store.cart.title")}</Link></p> : null}
      <div className="v2-journey-grid"><div className="v2-checkout-form">
        <V2Panel title={t("store.checkout.contactSection")}>
          <div className="v2-form-grid">
            <label className="v2-field">{t("store.checkout.fullName")}
              <input ref={nameRef} autoComplete="name" required value={name} onChange={(event) => setName(event.target.value)}
                aria-invalid={showErrors && issues.name} />
              {showErrors && issues.name ? <span role="alert" className="v2-field-error">{t("store.checkout.nameRequired")}</span> : null}</label>
            <label className="v2-field">{t("store.checkout.phone")}
              <input ref={phoneRef} inputMode="tel" autoComplete="tel" required value={phone} onChange={(event) => setPhone(event.target.value)}
                placeholder="01xxxxxxxxx" dir="ltr" aria-invalid={showErrors && issues.phone} />
              {showErrors && issues.phone ? <span role="alert" className="v2-field-error">{phone.trim()
                ? t("store.checkout.phoneInvalid") : t("store.checkout.phoneRequired")}</span>
                : <small>{t("store.checkout.phoneHint")}</small>}</label>
            <label className="v2-field">{t("store.checkout.email")} ({t("common.optional")})
              <input type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} /></label>
          </div>
        </V2Panel>
        <V2Panel title={t("store.checkout.fulfilment")}>
          {issues.fulfilment ? <p className="v2-alert" role="status">{settings.delivery.pickup_enabled
            ? t("store.checkout.deliveryDisabled") : t("store.checkout.orderingDisabled")}</p> : null}
          <div className="v2-choice-grid" role="group" aria-label={t("store.checkout.fulfilment")}>
            {settings.delivery.enabled ? <button type="button" aria-pressed={deliveryType === "delivery"}
              onClick={() => setDeliveryType("delivery")}>{t("store.checkout.delivery")}</button> : null}
            {settings.delivery.pickup_enabled ? <button type="button" aria-pressed={deliveryType === "pickup"}
              onClick={() => setDeliveryType("pickup")}>{t("store.checkout.pickup")}</button> : null}
          </div>
          {deliveryType === "delivery" && settings.delivery.enabled ? <>
            {zones.length ? <>
              <V2ZoneSelect zones={zones} value={deliveryZoneId} onChange={setDeliveryZoneId}
                invalid={showErrors && issues.zone} triggerRef={zoneTriggerRef} />
              {showErrors && issues.zone ? <p role="alert" className="v2-field-error">{t("store.checkout.zoneRequired")}</p> : null}
            </> : null}

            {places.length ? <datalist id="v2-delivery-places">{places.map((place, index) =>
              <option key={`${place.en}-${index}`} value={pick(place.ar, place.en)} />)}</datalist> : null}
            {addresses.length ? <fieldset className="v2-address-list"><legend>{t("store.account.tabAddresses")}</legend>
              {addresses.map((row) => <label key={row.id} className="v2-address-option" data-selected={row.id === addressId}>
                <input type="radio" name="v2-address" checked={row.id === addressId}
                  onChange={() => { setAddressId(row.id); setAddress(row);
                    if (row.full_name) setName(row.full_name); if (row.phone) setPhone(row.phone); }} />
                <span><strong>{row.label || row.full_name}</strong><small>{[row.street, row.area, row.city].filter(Boolean).join("، ")}</small></span>
              </label>)}
              <button type="button" className="v2-text-link" onClick={() => {
                setAddressId(null); setAddress({ ...blankAddress(), full_name: name, phone });
              }}>{t("store.account.useNewAddress")}</button>
            </fieldset> : null}
            <div className="v2-form-grid">{fields.map((field) => <label key={field} className="v2-field">
              {t(`store.checkout.${field}`)}
              <input ref={(el) => { addressFieldRefs.current[field] = el; }} value={address[field]} autoComplete={field === "city" ? "address-level2" :
                field === "area" ? "address-level3" : field === "street" ? "street-address" : undefined}
                list={places.length && (field === "city" || field === "area") ? "v2-delivery-places" : undefined}
                aria-invalid={showErrors && issues.address && (field === "city" || field === "area" || field === "street") && !address[field].trim()}
                onChange={(event) => { setAddressId(null); setAddress((current) => ({ ...current, [field]: event.target.value })); }} />
            </label>)}
              <label className="v2-field v2-field-wide">{t("store.checkout.addressNotes")}
                <input value={address.notes ?? ""} onChange={(event) => setAddress((current) => ({ ...current, notes: event.target.value }))} /></label>
            </div>
            {showErrors && issues.address ? <p className="v2-field-error" role="alert">{t("store.checkout.addressRequired")}</p> : null}
            {issues.area ? <p className="v2-field-error" role="alert">{t("store.checkout.areaNotServed")}</p> : null}
            {!deliveryQuoteReady && !issues.area ? <p className="v2-small" role="status">{t("store.cart.deliveryCalculatedAtCheckout")}</p> : null}
            {issues.shortfall > 0 ? <p ref={shortfallRef} className="v2-alert" role="status">{t("store.checkout.minimumOrder", {
              amount: money(issues.minimum), remaining: money(issues.shortfall) })}</p> : null}
            {pick(copy.delivery_note_ar, copy.delivery_note_en) ? <p className="v2-small">
              {pick(copy.delivery_note_ar, copy.delivery_note_en)}</p> : null}
          </> : <p className="v2-small">{pick(copy.pickup_note_ar, copy.pickup_note_en) ||
            t("store.checkout.pickupNote", { address: pick(settings.delivery.pickup_address_ar,
              settings.delivery.pickup_address_en) || pick(settings.contact.address_ar, settings.contact.address_en) })}</p>}
        </V2Panel>
        <V2Panel title={t("store.checkout.payment")}>
          {pick(copy.payment_note_ar, copy.payment_note_en) ? <p className="v2-small">
            {pick(copy.payment_note_ar, copy.payment_note_en)}</p> : null}
          <div className="v2-choice-grid" role="group" aria-label={t("store.checkout.payment")}>
            {settings.delivery.cod_enabled ? <button type="button" aria-pressed={paymentMethod === "cod"}
              onClick={() => setPaymentMethod("cod")}>{t("store.checkout.cod")}</button> : null}
            {settings.delivery.instapay_enabled ? <button type="button" aria-pressed={paymentMethod === "instapay"}
              onClick={() => setPaymentMethod("instapay")}>{t("store.checkout.instapay")}</button> : null}
          </div>
          {paymentMethod === "cod" ? <p className="v2-small">{pick(copy.cod_note_ar, copy.cod_note_en) ||
            t("store.checkout.codHint")}</p> : <div className="v2-payment-instructions">
            <h3>{t("store.checkout.instapaySteps")}</h3>
            {instapayInstructions ? <p className="v2-preline">{instapayInstructions}</p> :
              <ol><li>{t("store.checkout.instapayStep1", { amount: money(livePreview?.total ?? totals.total) })}</li>
                <li>{t("store.checkout.instapayStep2")}</li><li>{t("store.checkout.instapayStep3")}</li></ol>}
            {settings.social.instapay_holder ? <p>{t("store.checkout.instapayHolder")}: {settings.social.instapay_holder}</p> : null}
            {settings.social.instapay_account ? <p dir="ltr">{settings.social.instapay_account}</p> : null}
            {instapayHref ? <a className="v2-outline-button" href={instapayHref} target="_blank" rel="noopener noreferrer">
              {t("store.checkout.openInstapay")}</a> : null}
            {qr ? <V2Image src={qr} alt={t("store.checkout.instapayQr")} fit="contain" className="v2-instapay-qr" /> : null}
            {pick(copy.instapay_note_ar, copy.instapay_note_en) ? <p className="v2-preline">
              {pick(copy.instapay_note_ar, copy.instapay_note_en)}</p> : null}
            <p className="v2-alert" role="status">{t("store.checkout.instapayNeverAutomatic")}</p>
          </div>}
          {/* Order notes is a single optional field -- folded into the
             payment panel instead of its own full bordered section, which
             only added an extra card's worth of border/padding/heading to a
             checkout that already has four other sections above it. */}
          <label className="v2-field">{t("store.checkout.orderNotes")} ({t("common.optional")})
            <textarea value={notes} rows={3} placeholder={t("store.checkout.orderNotesPlaceholder")}
              onChange={(event) => setNotes(event.target.value)} /></label>
        </V2Panel>
      </div><aside className="v2-journey-aside"><V2Panel title={t("store.cart.summary")}>
        <ul className="v2-checkout-items">{entries.map((entry) => <li key={`${entry.product.id}::${entry.variant?.id ?? ""}`}>
          <span>{pick(entry.product.name_ar, entry.product.name_en)}
            {entry.variantLabel ? <small data-testid="v2-checkout-variant">{entry.variantLabel} · {entry.variant?.sku}</small> : null}
            <small>{t("store.checkout.quantityTimes", { count: entry.quantity })}</small></span>
          <strong>{money(entry.lineTotal)}</strong></li>)}</ul>
        <V2CartTotals showDelivery />
        <V2Coupon />
        <button type="submit" className="v2-primary-button v2-checkout-submit"
          disabled={submitting || placing || !orderable} data-testid="v2-place-order">
          {submitting || placing ? t("store.checkout.placing") : pick(copy.place_order_ar, copy.place_order_en).trim() || t("store.checkout.placeOrder")}
        </button>
        <p className="v2-small">{t("store.checkout.placementNote")}</p>
        <p className="v2-small">{t("store.v2.journey.advisoryTotal")}</p>
      </V2Panel></aside></div>
    </form> : null}
  </div>;
}
