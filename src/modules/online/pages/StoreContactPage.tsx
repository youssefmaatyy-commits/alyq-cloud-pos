/**
 * Contact.
 *
 * Everything a customer needs to reach a human, in the order they will look for
 * it: the phone number, WhatsApp, the address with a map link, the opening hours,
 * and the shop's social pages.
 *
 * There is deliberately no message form that pretends to deliver somewhere. The
 * shop has no inbox to receive one, so the "send us a message" box composes a
 * WhatsApp message instead and hands it to the app the customer already has —
 * the message genuinely arrives, at a number the shop owns.
 */
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { useStorefront } from "../hooks/StorefrontProvider";
import { whatsappHref } from "../components/storefront/StoreLayout";
import { applyDocumentMeta, applyJsonLd, clearDocumentMeta, storeJsonLd } from "../services/seo";
import { externalHref } from "../services/settingsDefaults";

export function StoreContactPage() {
  const { t, pick } = useI18n();
  const { settings } = useStorefront();
  const [message, setMessage] = useState("");

  const contact = settings.contact;
  const social = settings.social;
  const storeName = pick(contact.store_name_ar, contact.store_name_en);
  const address = pick(contact.address_ar, contact.address_en);
  const hours = pick(contact.hours_ar, contact.hours_en);
  const wa = whatsappHref(social.whatsapp, message.trim() || t("store.contact.whatsappMessage"));
  // Admin-typed URLs bound for public `href`s: only safe absolute http(s)
  // values render; anything else shows no link at all.
  const instapayLink = externalHref(social.instapay_link);
  const facebookLink = externalHref(social.facebook);
  const instagramLink = externalHref(social.instagram);
  const tiktokLink = externalHref(social.tiktok);
  const mapLink = externalHref(contact.map_url);

  useEffect(() => {
    applyDocumentMeta({
      title: `${t("store.contact.title")} — ${storeName}`,
      description: address || pick(contact.tagline_ar, contact.tagline_en) || storeName,
    });
    // The same store schema the homepage publishes, so a search engine crawling
    // either page learns the same facts about the shop.
    applyJsonLd(
      storeJsonLd(
        settings,
        typeof window === "undefined" ? "" : window.location.href.split("#")[0],
      ),
    );
    return () => clearDocumentMeta();
  }, [address, contact.tagline_ar, contact.tagline_en, pick, settings, storeName, t]);

  const channels = [
    facebookLink ? { key: "facebook", href: facebookLink, label: t("store.contact.facebook") } : null,
    instagramLink ? { key: "instagram", href: instagramLink, label: t("store.contact.instagram") } : null,
    tiktokLink ? { key: "tiktok", href: tiktokLink, label: t("store.contact.tiktok") } : null,
    wa ? { key: "whatsapp", href: wa, label: t("store.contact.whatsapp") } : null,
    instapayLink
      ? { key: "instapay", href: instapayLink, label: t("store.checkout.instapay") }
      : null,
  ].filter((entry): entry is { key: string; href: string; label: string } => entry !== null);

  const cardClass = "border border-[var(--store-border)] bg-[var(--store-surface)] p-4";

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-8 sm:px-6">
      <h1 className="text-2xl font-black tracking-tight text-[var(--store-text)] sm:text-3xl">
        {t("store.contact.title")}
      </h1>
      <p className="mt-1 text-sm text-[var(--store-muted)]">
        {pick(contact.tagline_ar, contact.tagline_en) || t("store.contact.subtitle")}
      </p>

      <div className="mt-6 grid gap-4 md:grid-cols-2">
        <section className={cardClass} style={{ borderRadius: "var(--store-radius)" }}>
          <h2 className="text-sm font-black uppercase tracking-widest text-[var(--store-muted)]">
            {t("store.contact.details")}
          </h2>
          <dl className="mt-3 flex flex-col gap-3 text-sm">
            {contact.phone ? (
              <div className="flex gap-3">
                <dt className="w-24 shrink-0 text-xs font-black uppercase tracking-wide text-[var(--store-muted)]">
                  {t("store.contact.phone")}
                </dt>
                <dd>
                  <a href={`tel:${contact.phone}`} className="font-bold text-[var(--store-primary)] hover:underline">
                    {contact.phone}
                  </a>
                </dd>
              </div>
            ) : null}
            {contact.email ? (
              <div className="flex gap-3">
                <dt className="w-24 shrink-0 text-xs font-black uppercase tracking-wide text-[var(--store-muted)]">
                  {t("store.contact.email")}
                </dt>
                <dd>
                  <a href={`mailto:${contact.email}`} className="font-bold text-[var(--store-primary)] hover:underline">
                    {contact.email}
                  </a>
                </dd>
              </div>
            ) : null}
            {address ? (
              <div className="flex gap-3">
                <dt className="w-24 shrink-0 text-xs font-black uppercase tracking-wide text-[var(--store-muted)]">
                  {t("store.contact.address")}
                </dt>
                <dd className="text-[var(--store-text)]">
                  {address}
                  {mapLink ? (
                    <a
                      href={mapLink}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="ms-2 text-xs font-bold text-[var(--store-primary)] hover:underline"
                    >
                      {t("store.contact.openMap")}
                    </a>
                  ) : null}
                </dd>
              </div>
            ) : null}
            {hours ? (
              <div className="flex gap-3">
                <dt className="w-24 shrink-0 text-xs font-black uppercase tracking-wide text-[var(--store-muted)]">
                  {t("store.contact.hours")}
                </dt>
                <dd className="whitespace-pre-line text-[var(--store-text)]">{hours}</dd>
              </div>
            ) : null}
          </dl>
        </section>

        <section className={cardClass} style={{ borderRadius: "var(--store-radius)" }}>
          <h2 className="text-sm font-black uppercase tracking-widest text-[var(--store-muted)]">
            {t("store.contact.sendMessage")}
          </h2>
          <label className="mt-3 block">
            <span className="mb-1 block text-xs font-bold text-[var(--store-text)]">{t("store.contact.message")}</span>
            <textarea
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              rows={4}
              className="w-full rounded-lg border border-[var(--store-border)] bg-[var(--store-surface)] px-3 py-2 text-sm text-[var(--store-text)] outline-none transition focus:border-[var(--store-primary)]"
              placeholder={t("store.contact.messagePlaceholder")}
            />
          </label>
          {wa ? (
            <a
              href={wa}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-3 inline-block bg-[var(--store-primary)] px-4 py-2.5 text-sm font-black text-[var(--store-on-primary)]"
              style={{ borderRadius: "var(--store-radius-button)" }}
            >
              {t("store.contact.sendOnWhatsapp")}
            </a>
          ) : (
            <p className="mt-3 text-xs font-semibold text-[var(--store-muted)]">
              {t("store.contact.noWhatsapp")}
            </p>
          )}
          <p className="mt-2 text-[11px] leading-relaxed text-[var(--store-muted)]">
            {t("store.contact.whatsappNote")}
          </p>
        </section>
      </div>

      {channels.length > 0 ? (
        <section className="mt-4 border border-[var(--store-border)] bg-[var(--store-surface)] p-4" style={{ borderRadius: "var(--store-radius)" }}>
          <h2 className="text-sm font-black uppercase tracking-widest text-[var(--store-muted)]">
            {t("store.contact.followUs")}
          </h2>
          <div className="mt-3 flex flex-wrap gap-2">
            {channels.map((channel) => (
              <a
                key={channel.key}
                href={channel.href}
                target="_blank"
                rel="noopener noreferrer"
                className="rounded-lg border border-[var(--store-border)] px-3 py-2 text-xs font-black text-[var(--store-text)] transition hover:border-[var(--store-primary)] hover:text-[var(--store-primary)]"
              >
                {channel.label}
              </a>
            ))}
          </div>
        </section>
      ) : null}

      <section className="mt-4 grid gap-4 md:grid-cols-2">
        {settings.delivery.enabled || settings.delivery.pickup_enabled ? (
          <div className={cardClass} style={{ borderRadius: "var(--store-radius)" }}>
            <h2 className="text-sm font-black uppercase tracking-widest text-[var(--store-muted)]">
              {t("store.footer.delivery")}
            </h2>
            <ul className="mt-3 flex flex-col gap-2 text-sm text-[var(--store-text)]">
              {settings.delivery.enabled ? (
                <li>
                  <span className="font-bold">{t("store.checkout.delivery")}: </span>
                  {settings.delivery.fee > 0
                    ? t("store.footer.deliveryFee", { amount: String(settings.delivery.fee) })
                    : t("store.checkout.free")}
                  {settings.delivery.free_delivery_threshold ? (
                    <span className="block text-xs text-[var(--store-muted)]">
                      {t("store.cart.freeDeliveryAt", {
                        amount: String(settings.delivery.free_delivery_threshold),
                      })}
                    </span>
                  ) : null}
                </li>
              ) : null}
              {settings.delivery.pickup_enabled ? (
                <li>
                  <span className="font-bold">{t("store.checkout.pickup")}: </span>
                  {pick(settings.delivery.pickup_address_ar, settings.delivery.pickup_address_en) ||
                    t("store.footer.pickupAvailable")}
                </li>
              ) : null}
              {pick(settings.delivery.note_ar, settings.delivery.note_en) ? (
                <li className="text-xs text-[var(--store-muted)]">
                  {pick(settings.delivery.note_ar, settings.delivery.note_en)}
                </li>
              ) : null}
            </ul>
          </div>
        ) : null}

        {settings.delivery.instapay_enabled && (social.instapay_account || social.instapay_link) ? (
          <div className={cardClass} style={{ borderRadius: "var(--store-radius)" }}>
            <h2 className="text-sm font-black uppercase tracking-widest text-[var(--store-muted)]">
              {t("store.checkout.instapay")}
            </h2>
            {social.instapay_holder ? (
              <p className="mt-3 text-xs font-semibold text-[var(--store-muted)]">
                {t("store.checkout.instapayHolder")}: {social.instapay_holder}
              </p>
            ) : null}
            {social.instapay_account ? (
              <p className="mt-1 text-sm font-black text-[var(--store-text)]">{social.instapay_account}</p>
            ) : null}
            {social.instapay_qr_url ? (
              <img
                src={social.instapay_qr_url}
                alt={t("store.checkout.instapayQr")}
                loading="lazy"
                decoding="async"
                className="mt-3 h-28 w-28 rounded-lg border border-[var(--store-border)] bg-white object-contain p-1"
              />
            ) : null}
            <p className="mt-3 text-xs leading-relaxed text-[var(--store-muted)]">
              {t("store.contact.instapayNote")}
            </p>
            <Link
              to="/store/track"
              className="mt-2 inline-block text-xs font-bold text-[var(--store-primary)] hover:underline"
            >
              {t("store.track.title")}
            </Link>
          </div>
        ) : null}
      </section>
    </div>
  );
}
