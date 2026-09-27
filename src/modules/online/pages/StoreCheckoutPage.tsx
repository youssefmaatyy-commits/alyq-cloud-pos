/**
 * Checkout.
 *
 * The last screen before an order exists, so it is the one place where being
 * vague costs a sale. It asks only for what the order needs — who, where, how it
 * travels, how it is paid — and it hides the options the shop switched off, so a
 * customer is never offered pickup that cannot be collected or InstaPay that
 * cannot be verified.
 *
 * Nothing here decides a price. The cart's totals are shown, and
 * `place_online_order` recomputes them from the catalogue; if the two disagree
 * (a campaign ended mid-checkout) the server's number is the one that is written,
 * and the confirmation screen shows it.
 */
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { cn } from "@/utils/cn";
import { useStoreCart, type CheckoutInput } from "../hooks/StoreCartProvider";
import { useStoreAccount } from "../hooks/StoreAccountProvider";
import { useStorefront } from "../hooks/StorefrontProvider";
import type { OnlineError } from "../data/repository";
import type { CustomerAddress, DeliveryType, OnlinePaymentMethod } from "../types";
import { whatsappHref } from "../components/storefront/StoreLayout";
import { FieldNote, Money } from "../components/storefront/StorePrimitives";
import { applyDocumentMeta, clearDocumentMeta } from "../services/seo";
import { externalHref } from "../services/settingsDefaults";
import {
  deliveryAreaSupported,
  deliveryAreasOf,
  deliveryMinimumShortfall,
  round2,
} from "../services/pricing";

/** Egyptian mobile numbers: 11 digits, starting 01. */
const EGYPT_PHONE = /^01[0-25]\d{8}$/;

/**
 * The one fact a refusal names, appended to the friendly sentence: the item it
 * is about (a stock or availability refusal names its SKU) or — when the order
 * itself was accepted but could not be read back — its number, so the customer
 * can track what already exists instead of ordering it again.
 */
function errorSuffix(error: OnlineError): string {
  const sku = error.detail.sku;
  if (typeof sku === "string" && sku) return ` · ${sku}`;
  const orderNumber = error.detail.order_number;
  if (typeof orderNumber === "string" && orderNumber) return ` · ${orderNumber}`;
  return "";
}

/**
 * Standard autocomplete hints for the address fields that matter. City and area
 * map to the two administrative levels a browser knows; the street to
 * `street-address`. Optional fields carry no hint.
 */
const ADDRESS_AUTOCOMPLETE: Partial<Record<keyof CustomerAddress, string>> = {
  city: "address-level2",
  area: "address-level3",
  street: "street-address",
};

/** A blank address to type into. */
const blankAddress = (): CustomerAddress => ({
  id: "",
  label: "",
  full_name: "",
  phone: "",
  city: "",
  area: "",
  street: "",
  building: "",
  floor: "",
  apartment: "",
  notes: "",
  is_default: false,
});

export function StoreCheckoutPage() {
  const { t, pick, money } = useI18n();

  // Checkout holds personal details and is never a landing page.
  useEffect(() => {
    applyDocumentMeta({ title: t("store.checkout.title"), description: "", noIndex: true });
    return () => clearDocumentMeta();
  }, [t]);
  const navigate = useNavigate();
  const { settings, deliveryZones } = useStorefront();
  // The InstaPay link is admin-typed text bound for a public `href`: only an
  // absolute http(s) URL is rendered, and an unset or unsafe value shows no
  // button at all rather than a broken or dangerous one.
  const instapayPayHref = externalHref(settings.social.instapay_link);
  // The "need help" WhatsApp link is computed once: either it is safe, or no
  // link renders — never a `#` placeholder.
  const waHelpHref = whatsappHref(settings.social.whatsapp, t("store.contact.whatsappMessage"));
  // The shop's own instructions replace the built-in step list when set.
  const instapayInstructions = pick(
    settings.delivery.instapay_instructions_ar,
    settings.delivery.instapay_instructions_en,
  ).trim();
  const { customer, addresses } = useStoreAccount();
  const {
    entries,
    isEmpty,
    totals,
    problems,
    deliveryType,
    setDeliveryType,
    paymentMethod,
    setPaymentMethod,
    placing,
    checkout,
    checkoutError,
    clearCheckoutError,
    deliveryZoneId,
    setDeliveryZoneId,
    preview,
    couponCode,
    setCouponInput,
    couponError,
    applyingCoupon,
    applyCoupon,
    clearCoupon,
  } = useStoreCart();
  const [promoDraft, setPromoDraft] = useState("");

  const [name, setName] = useState(customer?.name ?? "");
  const [phone, setPhone] = useState(customer?.phone ?? "");
  const [email, setEmail] = useState(customer?.email ?? "");
  const [notes, setNotes] = useState("");
  const [address, setAddress] = useState<CustomerAddress>(blankAddress);
  const [savedAddressId, setSavedAddressId] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);

  const defaultAddress = addresses.find((entry) => entry.is_default) ?? addresses[0] ?? null;

  // A signed-in shopper starts from their saved address; they can still type a
  // different one for this order without editing the saved copy.
  useEffect(() => {
    if (!customer) return;
    setName((current) => current || customer.name);
    setPhone((current) => current || customer.phone);
    setEmail((current) => current || customer.email || "");
    if (defaultAddress && !savedAddressId) {
      setSavedAddressId(defaultAddress.id);
      setAddress(defaultAddress);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customer?.id]);

  // The shop can switch a channel off while a cart is open; do not let the
  // customer submit a choice that no longer exists.
  useEffect(() => {
    if (deliveryType === "delivery" && !settings.delivery.enabled && settings.delivery.pickup_enabled) {
      setDeliveryType("pickup");
    }
    if (deliveryType === "pickup" && !settings.delivery.pickup_enabled && settings.delivery.enabled) {
      setDeliveryType("delivery");
    }
    if (paymentMethod === "cod" && !settings.delivery.cod_enabled && settings.delivery.instapay_enabled) {
      setPaymentMethod("instapay");
    }
    if (paymentMethod === "instapay" && !settings.delivery.instapay_enabled && settings.delivery.cod_enabled) {
      setPaymentMethod("cod");
    }
  }, [deliveryType, paymentMethod, setDeliveryType, setPaymentMethod, settings.delivery]);

  // Phase 43: a shortage is a shelf's, keyed product + combination — Gold / 17
  // being short must not grey out Silver / 17 sitting in the same cart.
  const problemsByLine = useMemo(
    () =>
      new Map(
        problems.map((problem) => [
          `${problem.product_id}::${problem.variant_id ?? ""}`,
          problem,
        ]),
      ),
    [problems],
  );

  const nameError = touched && !name.trim() ? t("store.checkout.nameRequired") : null;
  const phoneError =
    touched && !phone.trim()
      ? t("store.checkout.phoneRequired")
      : touched && !EGYPT_PHONE.test(phone.replace(/\s+/g, ""))
        ? t("store.checkout.phoneInvalid")
        : null;

  // The shop's own delivery rules, computed live so they are visible before the
  // submit. `place_online_order` enforces the same numbers server-side, so a
  // cart that passes here passes there. With zones the chosen row decides;
  // without one the legacy settings do.
  const deliveryPlaces = useMemo(() => deliveryAreasOf(settings.delivery), [settings.delivery]);
  const enabledZones = useMemo(() => deliveryZones.filter((zone) => zone.enabled), [deliveryZones]);
  const activeZone = useMemo(
    () => enabledZones.find((zone) => zone.id === deliveryZoneId) ?? null,
    [deliveryZoneId, enabledZones],
  );

  // When zones exist the customer picks one: preselecting the first would price
  // a Cairo order at Ismailia's fee, so the choice stays empty until made —
  // and a zone that was disabled after being chosen is cleared instead.
  useEffect(() => {
    if (activeZone) return;
    if (deliveryZoneId !== null) setDeliveryZoneId(null);
  }, [activeZone, deliveryZoneId, setDeliveryZoneId]);

  // The advisory breakdown when it is fresh, else the local totals. Both read
  // the same engine; the preview additionally knows automatic offers, codes
  // beyond the coupon input, and the chosen zone.
  const shown = useMemo(() => {
    if (!preview) return null;
    return preview;
  }, [preview]);
  const goodsTotal = round2((shown?.subtotal ?? totals.subtotal) - (shown?.totalDiscount ?? totals.discount_amount));
  const zoneMinimum = activeZone && deliveryType === "delivery" ? activeZone.minimum_order_amount : null;
  const deliveryShortfall =
    zoneMinimum !== null
      ? round2(Math.max(zoneMinimum - goodsTotal, 0))
      : deliveryMinimumShortfall(settings.delivery, deliveryType, goodsTotal);
  const addressTyped = Boolean(address.city.trim() || address.area.trim());

  // A whole address — city, area and street — for a driver to find. The server
  // refuses anything less as well.
  const addressError =
    touched && deliveryType === "delivery" &&
    (!address.city.trim() || !address.area.trim() || !address.street.trim())
      ? t("store.checkout.addressRequired")
      : null;
  // Only when the customer has actually typed a place: an empty form is the
  // "address required" case, not the "we do not deliver there" one. A named
  // zone replaces the areas list — the zone IS the place the shop serves.
  const areaError =
    deliveryType === "delivery" &&
    !activeZone &&
    addressTyped &&
    !deliveryAreaSupported(settings.delivery, address.city, address.area)
      ? t("store.checkout.areaNotServed")
      : null;
  const zoneError =
    touched && deliveryType === "delivery" && enabledZones.length > 0 && !activeZone
      ? t("store.checkout.zoneRequired")
      : null;
  const blocked = problems.length > 0;
  const orderingOpen = settings.delivery.enabled || settings.delivery.pickup_enabled;
  const invalid =
    Boolean(nameError || phoneError || addressError || areaError || zoneError) ||
    blocked ||
    deliveryShortfall > 0 ||
    !orderingOpen;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setTouched(true);
    clearCheckoutError();
    if (invalid) return;

    const payload: CheckoutInput = {
      customer_name: name.trim(),
      customer_phone: phone.trim(),
      customer_email: email.trim() || null,
      address: deliveryType === "delivery" ? address : null,
      notes: notes.trim() || null,
    };
    const order = await checkout(payload);
    if (order) navigate("/store/confirmation");
  };

  if (isEmpty) {
    return (
      <div className="mx-auto w-full max-w-2xl px-4 py-20 text-center">
        <p className="text-lg font-black text-[var(--store-text-primary)]">{t("store.cart.empty")}</p>
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

  const inputClass =
    "w-full rounded-lg border border-[var(--store-border)] bg-[var(--store-surface)] px-3 py-2 text-sm text-[var(--store-text-primary)] outline-none transition focus:border-[var(--store-primary)]";

  // Phase 45: the admin's checkout words. Copy only — fees, thresholds,
  // minimums and the payment flow itself stay exactly as configured and
  // server-derived; these strings change nothing about the rules.
  const copy = settings.checkout_copy;
  const copyOr = (ar: string, en: string) => pick(ar, en).trim();
  const headingCopy = copyOr(copy.heading_ar, copy.heading_en);
  const deliveryNoteCopy = copyOr(copy.delivery_note_ar, copy.delivery_note_en);
  const pickupNoteCopy = copyOr(copy.pickup_note_ar, copy.pickup_note_en);
  const paymentNoteCopy = copyOr(copy.payment_note_ar, copy.payment_note_en);
  const codNoteCopy = copyOr(copy.cod_note_ar, copy.cod_note_en);
  const instapayNoteCopy = copyOr(copy.instapay_note_ar, copy.instapay_note_en);
  const placeOrderCopy = copyOr(copy.place_order_ar, copy.place_order_en);

  return (
    <form onSubmit={submit} className="mx-auto w-full max-w-[var(--store-max-width,72rem)] px-4 py-6 sm:px-6">
      <h1 className="text-2xl font-black tracking-tight text-[var(--store-text-primary)]">
        {headingCopy || t("store.checkout.title")}
      </h1>

      {!customer ? (
        <p className="mt-2 text-xs font-semibold text-[var(--store-text-secondary)]">
          {t("store.checkout.guestNote")}{" "}
          <Link to="/store/account" className="font-bold text-[var(--store-primary)] hover:underline">
            {t("store.account.signIn")}
          </Link>
        </p>
      ) : null}

      {checkoutError ? (
        <div className="mt-4 border border-rose-300 bg-rose-50 p-3 text-sm font-bold text-rose-800" style={{ borderRadius: "var(--store-radius)" }}>
          {t(`store.error.${checkoutError.code}` as never)}
          {errorSuffix(checkoutError)}
          <button type="button" onClick={clearCheckoutError} className="ms-2 underline">
            {t("common.dismiss")}
          </button>
        </div>
      ) : null}

      <div className="mt-5 grid gap-6 lg:grid-cols-[1fr_20rem]">
        <div className="flex flex-col gap-5">
          {/* contact */}
          <section className="border border-[var(--store-border)] bg-[var(--store-surface)] p-4" style={{ borderRadius: "var(--store-radius)" }}>
            <h2 className="text-sm font-black uppercase tracking-widest text-[var(--store-text-secondary)]">
              {t("store.checkout.contactSection")}
            </h2>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <label className="block">
                <span className="mb-1 block text-xs font-bold text-[var(--store-text-primary)]">{t("store.checkout.fullName")}</span>
                <input value={name} onChange={(event) => setName(event.target.value)} className={inputClass} autoComplete="name" />
                {nameError ? <FieldNote tone="error">{nameError}</FieldNote> : null}
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-bold text-[var(--store-text-primary)]">{t("store.checkout.phone")}</span>
                <input
                  value={phone}
                  onChange={(event) => setPhone(event.target.value)}
                  className={inputClass}
                  inputMode="tel"
                  autoComplete="tel"
                  placeholder="01xxxxxxxxx"
                />
                {phoneError ? (
                  <FieldNote tone="error">{phoneError}</FieldNote>
                ) : (
                  <FieldNote>{t("store.checkout.phoneHint")}</FieldNote>
                )}
              </label>
              <label className="block sm:col-span-2">
                <span className="mb-1 block text-xs font-bold text-[var(--store-text-primary)]">
                  {t("store.checkout.email")} <span className="font-medium text-[var(--store-text-secondary)]">({t("common.optional")})</span>
                </span>
                <input value={email} onChange={(event) => setEmail(event.target.value)} className={inputClass} type="email" autoComplete="email" />
              </label>
            </div>
          </section>

          {/* fulfilment */}
          <section className="border border-[var(--store-border)] bg-[var(--store-surface)] p-4" style={{ borderRadius: "var(--store-radius)" }}>
            <h2 className="text-sm font-black uppercase tracking-widest text-[var(--store-text-secondary)]">
              {t("store.checkout.fulfilment")}
            </h2>
            {!settings.delivery.enabled ? (
              <p className="mt-2 rounded-lg border border-amber-300 bg-amber-50 p-2 text-xs font-semibold text-amber-900">
                {settings.delivery.pickup_enabled
                  ? t("store.checkout.deliveryDisabled")
                  : t("store.checkout.orderingDisabled")}
              </p>
            ) : null}
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              {settings.delivery.enabled ? (
                <button
                  type="button"
                  onClick={() => setDeliveryType("delivery" as DeliveryType)}
                  className={cn(
                    "rounded-xl border-2 p-3 text-start transition",
                    deliveryType === "delivery"
                      ? "border-[var(--store-primary)] bg-[var(--store-primary-soft)]"
                      : "border-[var(--store-border)]",
                  )}
                >
                  <p className="text-sm font-black text-[var(--store-text-primary)]">{t("store.checkout.delivery")}</p>
                  <p className="mt-0.5 text-xs text-[var(--store-text-secondary)]">
                    {(shown?.deliveryFee ?? totals.delivery_fee) > 0
                      ? t("store.checkout.deliveryFeeAmount", { amount: money(shown?.deliveryFee ?? activeZone?.shipping_fee ?? settings.delivery.fee) })
                      : t("store.cart.freeDeliveryReached")}
                  </p>
                </button>
              ) : null}
              {settings.delivery.pickup_enabled ? (
                <button
                  type="button"
                  onClick={() => setDeliveryType("pickup" as DeliveryType)}
                  className={cn(
                    "rounded-xl border-2 p-3 text-start transition",
                    deliveryType === "pickup"
                      ? "border-[var(--store-primary)] bg-[var(--store-primary-soft)]"
                      : "border-[var(--store-border)]",
                  )}
                >
                  <p className="text-sm font-black text-[var(--store-text-primary)]">{t("store.checkout.pickup")}</p>
                  <p className="mt-0.5 text-xs text-[var(--store-text-secondary)]">
                    {pick(settings.delivery.pickup_address_ar, settings.delivery.pickup_address_en) ||
                      t("store.checkout.pickupFree")}
                  </p>
                </button>
              ) : null}
            </div>

            {deliveryType === "delivery" && enabledZones.length > 0 ? (
              <fieldset className="mt-3">
                <legend className="mb-1 block text-xs font-bold text-[var(--store-text-primary)]">
                  {t("store.checkout.chooseZone")}
                </legend>
                <div className="flex flex-col gap-2" data-testid="checkout-zone-picker">
                  {enabledZones.map((zone) => {
                    const selected = zone.id === deliveryZoneId;
                    const eta = zone.show_estimated_delivery !== false
                      ? pick(zone.estimated_delivery_text_ar, zone.estimated_delivery_text_en)
                      : null;
                    return (
                      <label
                        key={zone.id}
                        className={cn(
                          "flex cursor-pointer items-start gap-3 rounded-xl border-2 p-3 transition",
                          selected
                            ? "border-[var(--store-primary)] bg-[var(--store-primary-soft)]"
                            : "border-[var(--store-border)]",
                        )}
                      >
                        <input
                          type="radio"
                          name="delivery-zone"
                          checked={selected}
                          onChange={() => setDeliveryZoneId(zone.id)}
                          className="mt-0.5 accent-[var(--store-primary)]"
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block text-sm font-black text-[var(--store-text-primary)]">
                            {pick(zone.name_ar, zone.name_en)}
                          </span>
                          <span className="mt-0.5 block text-xs text-[var(--store-text-secondary)]">
                            {zone.shipping_fee > 0 ? (
                              t("store.checkout.zoneFee", { amount: money(zone.shipping_fee) })
                            ) : (
                              <span className="font-bold text-emerald-700">{t("store.checkout.free")}</span>
                            )}
                            {zone.minimum_order_amount > 0
                              ? ` · ${t("store.checkout.zoneMinimum", { amount: money(zone.minimum_order_amount) })}`
                              : ""}
                            {eta ? ` · ${eta}` : ""}
                          </span>
                        </span>
                      </label>
                    );
                  })}
                </div>
                {zoneError ? <FieldNote tone="error">{zoneError}</FieldNote> : null}
              </fieldset>
            ) : null}

            {deliveryNoteCopy && deliveryType === "delivery" ? (
              <p className="mt-3 text-xs leading-relaxed text-[var(--store-text-secondary)]">{deliveryNoteCopy}</p>
            ) : null}
            {pickupNoteCopy && deliveryType === "pickup" ? (
              <p className="mt-3 text-xs leading-relaxed text-[var(--store-text-secondary)]">{pickupNoteCopy}</p>
            ) : null}
            {deliveryType === "delivery" ? (
              <div className="mt-4">
                {addresses.length > 0 ? (
                  <div className="mb-3 flex flex-col gap-2">
                    {addresses.map((entry) => (
                      <label
                        key={entry.id}
                        className={cn(
                          "flex cursor-pointer items-start gap-2 rounded-xl border-2 p-3 transition",
                          savedAddressId === entry.id
                            ? "border-[var(--store-primary)] bg-[var(--store-primary-soft)]"
                            : "border-[var(--store-border)]",
                        )}
                      >
                        <input
                          type="radio"
                          name="saved-address"
                          checked={savedAddressId === entry.id}
                          onChange={() => {
                            setSavedAddressId(entry.id);
                            setAddress(entry);
                            if (entry.full_name) setName(entry.full_name);
                            if (entry.phone) setPhone(entry.phone);
                          }}
                          className="mt-0.5 accent-[var(--store-primary)]"
                        />
                        <span className="text-xs">
                          <span className="block font-black text-[var(--store-text-primary)]">
                            {entry.label || entry.full_name}
                            {entry.is_default ? ` · ${t("store.account.defaultAddress")}` : ""}
                          </span>
                          <span className="block text-[var(--store-text-secondary)]">
                            {[entry.street, entry.area, entry.city].filter(Boolean).join("، ")}
                          </span>
                        </span>
                      </label>
                    ))}
                    <button
                      type="button"
                      onClick={() => {
                        setSavedAddressId(null);
                        setAddress({ ...blankAddress(), full_name: name, phone });
                      }}
                      className="self-start text-xs font-bold text-[var(--store-primary)] hover:underline"
                    >
                      {t("store.account.useNewAddress")}
                    </button>
                  </div>
                ) : null}

                {deliveryPlaces.length > 0 ? (
                  <datalist id="store-delivery-places">
                    {deliveryPlaces.map((place, index) => (
                      <option key={`${place.en}-${index}`} value={pick(place.ar, place.en)} />
                    ))}
                  </datalist>
                ) : null}

                <div className="grid gap-3 sm:grid-cols-2">
                  {(
                    [
                      ["city", t("store.checkout.city")],
                      ["area", t("store.checkout.area")],
                      ["street", t("store.checkout.street")],
                      ["building", t("store.checkout.building")],
                      ["floor", t("store.checkout.floor")],
                      ["apartment", t("store.checkout.apartment")],
                    ] as [keyof CustomerAddress, string][]
                  ).map(([field, label]) => (
                    <label key={field} className="block">
                      <span className="mb-1 block text-xs font-bold text-[var(--store-text-primary)]">{label}</span>
                      <input
                        value={String(address[field] ?? "")}
                        onChange={(event) =>
                          setAddress((current) => ({ ...current, [field]: event.target.value }))
                        }
                        list={
                          deliveryPlaces.length > 0 && (field === "city" || field === "area")
                            ? "store-delivery-places"
                            : undefined
                        }
                        autoComplete={ADDRESS_AUTOCOMPLETE[field]}
                        className={inputClass}
                      />
                    </label>
                  ))}
                  <label className="block sm:col-span-2">
                    <span className="mb-1 block text-xs font-bold text-[var(--store-text-primary)]">
                      {t("store.checkout.addressNotes")}
                    </span>
                    <input
                      value={address.notes ?? ""}
                      onChange={(event) =>
                        setAddress((current) => ({ ...current, notes: event.target.value }))
                      }
                      className={inputClass}
                    />
                  </label>
                </div>
                {addressError ? <FieldNote tone="error">{addressError}</FieldNote> : null}
                {areaError ? <FieldNote tone="error">{areaError}</FieldNote> : null}
              </div>
            ) : (
              <p className="mt-3 text-xs leading-relaxed text-[var(--store-text-secondary)]">
                {t("store.checkout.pickupNote", {
                  address:
                    pick(settings.delivery.pickup_address_ar, settings.delivery.pickup_address_en) ||
                    pick(settings.contact.address_ar, settings.contact.address_en),
                })}
              </p>
            )}
          </section>

          {/* payment */}
          <section className="border border-[var(--store-border)] bg-[var(--store-surface)] p-4" style={{ borderRadius: "var(--store-radius)" }}>
            <h2 className="text-sm font-black uppercase tracking-widest text-[var(--store-text-secondary)]">
              {t("store.checkout.payment")}
            </h2>
            {paymentNoteCopy ? (
              <p className="mt-2 text-xs leading-relaxed text-[var(--store-text-secondary)]">{paymentNoteCopy}</p>
            ) : null}
            <div className="mt-3 flex flex-col gap-2">
              {settings.delivery.cod_enabled ? (
                <label
                  className={cn(
                    "flex cursor-pointer items-start gap-3 rounded-xl border-2 p-3 transition",
                    paymentMethod === "cod"
                      ? "border-[var(--store-primary)] bg-[var(--store-primary-soft)]"
                      : "border-[var(--store-border)]",
                  )}
                >
                  <input
                    type="radio"
                    name="payment"
                    value="cod"
                    checked={paymentMethod === "cod"}
                    onChange={() => setPaymentMethod("cod" as OnlinePaymentMethod)}
                    className="mt-0.5 accent-[var(--store-primary)]"
                  />
                  <span>
                    <span className="block text-sm font-black text-[var(--store-text-primary)]">{t("store.checkout.cod")}</span>
                    <span className="block text-xs text-[var(--store-text-secondary)]">{t("store.checkout.codHint")}</span>
                    {codNoteCopy ? (
                      <span className="mt-1 block text-xs leading-relaxed text-[var(--store-text-secondary)]">{codNoteCopy}</span>
                    ) : null}
                  </span>
                </label>
              ) : null}

              {settings.delivery.instapay_enabled ? (
                <label
                  className={cn(
                    "flex cursor-pointer items-start gap-3 rounded-xl border-2 p-3 transition",
                    paymentMethod === "instapay"
                      ? "border-[var(--store-primary)] bg-[var(--store-primary-soft)]"
                      : "border-[var(--store-border)]",
                  )}
                >
                  <input
                    type="radio"
                    name="payment"
                    value="instapay"
                    checked={paymentMethod === "instapay"}
                    onChange={() => setPaymentMethod("instapay" as OnlinePaymentMethod)}
                    className="mt-0.5 accent-[var(--store-primary)]"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-black text-[var(--store-text-primary)]">{t("store.checkout.instapay")}</span>
                    <span className="block text-xs text-[var(--store-text-secondary)]">{t("store.checkout.instapayHint")}</span>

                    {paymentMethod === "instapay" ? (
                      <span className="mt-3 block rounded-lg border border-[var(--store-border)] bg-[var(--store-surface-muted)] p-3">
                        <span className="block text-xs font-bold text-[var(--store-text-primary)]">
                          {t("store.checkout.instapaySteps")}
                        </span>
                        {instapayInstructions ? (
                          <p className="mt-2 whitespace-pre-line text-xs leading-relaxed text-[var(--store-text-secondary)]">
                            {instapayInstructions}
                          </p>
                        ) : (
                          <ol className="mt-2 list-decimal space-y-1 ps-4 text-xs text-[var(--store-text-secondary)]">
                            <li>{t("store.checkout.instapayStep1", { amount: money(shown?.total ?? totals.total) })}</li>
                            <li>{t("store.checkout.instapayStep2")}</li>
                            <li>{t("store.checkout.instapayStep3")}</li>
                          </ol>
                        )}
                        {settings.social.instapay_holder ? (
                          <span className="mt-2 block text-xs font-semibold text-[var(--store-text-secondary)]">
                            {t("store.checkout.instapayHolder")}: {settings.social.instapay_holder}
                          </span>
                        ) : null}
                        {settings.social.instapay_account ? (
                          <span className="mt-2 block text-xs font-black text-[var(--store-primary)]">
                            {settings.social.instapay_account}
                          </span>
                        ) : null}
                        {instapayPayHref ? (
                          <a
                            href={instapayPayHref}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="mt-2 inline-block rounded-lg bg-[var(--store-primary)] px-3 py-1.5 text-xs font-black text-[var(--store-on-primary)]"
                          >
                            {t("store.checkout.openInstapay")}
                          </a>
                        ) : null}
                        {settings.social.instapay_qr_url ? (
                          <img
                            src={settings.social.instapay_qr_url}
                            alt={t("store.checkout.instapayQr")}
                            loading="lazy"
                            decoding="async"
                            className="mt-3 h-32 w-32 rounded-lg border border-[var(--store-border)] bg-white object-contain p-1"
                          />
                        ) : null}
                        {instapayNoteCopy ? (
                          <span className="mt-2 block whitespace-pre-line text-xs leading-relaxed text-[var(--store-text-secondary)]">
                            {instapayNoteCopy}
                          </span>
                        ) : null}
                        <span className="mt-2 block text-[11px] font-semibold text-amber-700">
                          {t("store.checkout.instapayNeverAutomatic")}
                        </span>
                      </span>
                    ) : null}
                  </span>
                </label>
              ) : null}
            </div>
          </section>

          {/* notes */}
          <section className="border border-[var(--store-border)] bg-[var(--store-surface)] p-4" style={{ borderRadius: "var(--store-radius)" }}>
            <label className="block">
              <span className="mb-1 block text-xs font-bold text-[var(--store-text-primary)]">
                {t("store.checkout.orderNotes")} <span className="font-medium text-[var(--store-text-secondary)]">({t("common.optional")})</span>
              </span>
              <textarea
                value={notes}
                onChange={(event) => setNotes(event.target.value)}
                rows={3}
                className={inputClass}
                placeholder={t("store.checkout.orderNotesPlaceholder")}
              />
            </label>
          </section>
        </div>

        {/* summary */}
        <aside className="flex flex-col gap-4 lg:sticky lg:top-24 lg:self-start">
          <div className="border border-[var(--store-border)] bg-[var(--store-surface)] p-4" style={{ borderRadius: "var(--store-radius)" }}>
            <h2 className="text-sm font-black uppercase tracking-widest text-[var(--store-text-secondary)]">
              {t("store.cart.summary")}
            </h2>

            <ul className="mt-3 flex flex-col gap-2">
              {entries.map((entry) => {
                const problem = problemsByLine.get(
                  `${entry.product.id}::${entry.variant?.id ?? ""}`,
                );
                const linePreview = shown?.lines.find(
                  (candidate) =>
                    candidate.product_id === entry.product.id &&
                    (candidate.variant_id ?? null) === (entry.variant?.id ?? null),
                );
                const lineTotal = linePreview ? linePreview.line_total : entry.lineTotal;
                return (
                  <li
                    key={`${entry.product.id}::${entry.variant?.id ?? ""}`}
                    className="flex items-start justify-between gap-2 text-xs"
                  >
                    <span className="min-w-0">
                      <span className="block truncate font-bold text-[var(--store-text-primary)]">
                        {pick(entry.product.name_ar, entry.product.name_en)}
                      </span>
                      {entry.variantLabel ? (
                        <span className="block font-bold text-[var(--store-text-primary)]" data-testid="checkout-line-variant">
                          {entry.variantLabel}
                        </span>
                      ) : null}
                      {linePreview?.promotion_name ? (
                        <span className="mt-0.5 flex flex-wrap items-center gap-1 font-semibold text-emerald-700">
                          <span className="rounded bg-emerald-50 px-1 py-0.2 text-[10px] border border-emerald-200">
                            🏷️ {linePreview.promotion_name}
                          </span>
                          {linePreview.rewarded_units && linePreview.rewarded_units > 0 ? (
                            <span className="rounded bg-emerald-100 px-1 py-0.2 text-[10px] text-emerald-900 border border-emerald-300">
                              🎁 {t("online.promos.rewardedUnit")} ({linePreview.rewarded_units})
                            </span>
                          ) : null}
                        </span>
                      ) : null}
                      <span className="text-[var(--store-text-secondary)]">
                        {t("store.checkout.quantityTimes", { count: entry.quantity })}
                      </span>
                      {problem ? (
                        <span className="block font-bold text-rose-600">
                          {t("store.cart.onlyAvailable", { count: problem.available })}
                        </span>
                      ) : null}
                    </span>
                    <Money value={lineTotal} className="shrink-0 font-black text-[var(--store-text-primary)]" />
                  </li>
                );
              })}
            </ul>

            <dl className="mt-3 space-y-2 border-t border-[var(--store-border)] pt-3 text-sm">
              <div className="flex justify-between gap-2">
                <dt className="text-[var(--store-text-secondary)]">{t("store.cart.subtotal")}</dt>
                <dd className="font-bold text-[var(--store-text-primary)]"><Money value={shown?.subtotal ?? totals.subtotal} /></dd>
              </div>
              {(shown?.autoDiscount ?? 0) > 0 ? (
                <div className="flex justify-between gap-2 text-emerald-700">
                  <dt>
                    {t("store.checkout.productDiscounts")}
                    {shown?.autoPromotionName ? ` · ${shown.autoPromotionName}` : ""}
                  </dt>
                  <dd className="font-bold">−{money(shown?.autoDiscount ?? 0)}</dd>
                </div>
              ) : null}
              {(shown?.promoDiscount ?? totals.discount_amount) > 0 ? (
                <div className="flex justify-between gap-2 text-emerald-700">
                  <dt>
                    {t("store.cart.discount")}
                    {shown?.promoCode ?? totals.discount_code ? ` · ${shown?.promoCode ?? totals.discount_code}` : ""}
                  </dt>
                  <dd className="font-bold">−{money(shown?.promoDiscount ?? totals.discount_amount)}</dd>
                </div>
              ) : null}
              <div className="flex justify-between gap-2">
                <dt className="text-[var(--store-text-secondary)]">
                  {deliveryType === "pickup"
                    ? t("store.checkout.pickup")
                    : activeZone
                      ? pick(activeZone.name_ar, activeZone.name_en)
                      : t("store.cart.deliveryFee")}
                </dt>
                <dd className="font-bold text-[var(--store-text-primary)]">
                  {(shown?.deliveryFee ?? totals.delivery_fee) > 0 ? (
                    <Money value={shown?.deliveryFee ?? totals.delivery_fee} />
                  ) : (
                    t("store.checkout.free")
                  )}
                </dd>
              </div>
              {(shown?.shippingDiscount ?? 0) > 0 ? (
                <div className="flex justify-between gap-2 text-emerald-700">
                  <dt>
                    {t("store.checkout.deliveryDiscount")}
                    {shown?.promoFreeShipping ? ` · ${t("store.checkout.freeShippingApplied")}` : ""}
                  </dt>
                  <dd className="font-bold">−{money(shown?.shippingDiscount ?? 0)}</dd>
                </div>
              ) : null}
              <div className="flex justify-between gap-2 border-t border-[var(--store-border)] pt-2 text-base">
                <dt className="font-black text-[var(--store-text-primary)]">{t("store.cart.total")}</dt>
                <dd className="font-black text-[var(--store-text-primary)]"><Money value={shown?.total ?? totals.total} /></dd>
              </div>
            </dl>

            {couponCode || shown?.promoCode ? (
              <div className="mt-3 flex items-center justify-between gap-2 rounded-lg bg-[var(--store-primary-soft)] px-3 py-2">
                <p className="text-sm font-black text-[var(--store-primary)]">
                  {shown?.promoCode ?? couponCode}
                </p>
                <button
                  type="button"
                  onClick={clearCoupon}
                  className="text-xs font-bold text-[var(--store-text-secondary)] hover:text-rose-600"
                >
                  {t("store.cart.removeCoupon")}
                </button>
              </div>
            ) : (
              <div className="mt-3 flex gap-2">
                <input
                  value={promoDraft}
                  onChange={(event) => {
                    setPromoDraft(event.target.value);
                    setCouponInput(event.target.value);
                  }}
                  // No <form> here: this block already lives inside the
                  // checkout's own form, and a nested form is invalid HTML.
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      void applyCoupon(promoDraft);
                    }
                  }}
                  placeholder={t("store.cart.couponPlaceholder")}
                  aria-label={t("store.cart.coupon")}
                  className="min-w-0 flex-1 rounded-lg border border-[var(--store-border)] bg-[var(--store-surface)] px-3 py-2 text-sm uppercase outline-none focus:border-[var(--store-primary)]"
                />
                <button
                  type="button"
                  onClick={() => void applyCoupon(promoDraft)}
                  disabled={applyingCoupon || !promoDraft.trim()}
                  className="shrink-0 rounded-lg border border-[var(--store-primary)] px-3 py-2 text-xs font-black text-[var(--store-primary)] transition hover:bg-[var(--store-primary-soft)] disabled:opacity-40"
                >
                  {applyingCoupon ? t("common.loading") : t("store.cart.applyCoupon")}
                </button>
              </div>
            )}
            {couponError && !couponCode ? (
              <p className="mt-2 text-xs font-bold text-rose-600">
                {t(`store.coupon.${couponError}` as never)}
              </p>
            ) : null}
            {!couponError && (couponCode || shown?.promoCode) ? (
              <p className="mt-2 text-xs font-bold text-emerald-600">{t("store.coupon.applied")}</p>
            ) : null}

            {deliveryShortfall > 0 ? (
              <p className="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-2 text-xs font-semibold text-amber-900">
                {t("store.checkout.minimumOrder", {
                  amount: money(zoneMinimum ?? settings.delivery.minimum_order ?? 0),
                  remaining: money(deliveryShortfall),
                })}
              </p>
            ) : null}

            <button
              type="submit"
              disabled={placing || invalid}
              className="mt-4 w-full bg-[var(--store-primary)] px-4 py-3 text-sm font-black text-[var(--store-on-primary)] transition hover:bg-[var(--store-primary-hover)] disabled:cursor-not-allowed disabled:bg-[var(--store-border)] disabled:text-[var(--store-text-secondary)]"
              style={{ borderRadius: "var(--store-radius-button)" }}
            >
              {placing
                ? t("store.checkout.placing")
                : placeOrderCopy || t("store.checkout.placeOrder")}
            </button>
            <p className="mt-2 text-[11px] leading-relaxed text-[var(--store-text-secondary)]">
              {t("store.checkout.placementNote")}
            </p>
          </div>

          {waHelpHref ? (
            <a
              href={waHelpHref}
              target="_blank"
              rel="noopener noreferrer"
              className="rounded-xl border border-[var(--store-border)] bg-[var(--store-surface)] p-3 text-center text-xs font-bold text-[var(--store-primary)]"
            >
              {t("store.checkout.needHelp")}
            </a>
          ) : null}
        </aside>
      </div>
    </form>
  );
}
