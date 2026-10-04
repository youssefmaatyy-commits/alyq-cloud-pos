/** V2 Contact: real configured contact data, completed social settings and a
 * WhatsApp compose link (not a fictional website message inbox). */
import { useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { useStorefront } from "../hooks/StorefrontProvider";
import { externalHref, resolvedSocialLinks } from "../services/settingsDefaults";
import { socialChannelHref } from "../services/socialSafety";
import { absoluteUrl, applyDocumentMeta, applyJsonLd, clearDocumentMeta, storeJsonLd } from "../services/seo";
import { V2Panel } from "./JourneyParts";
import { resolvedV2SocialChannels } from "./SocialChannels";

export function StorefrontV2Contact() {
  const { t, pick, lang, money } = useI18n();
  const { settings, deliveryZones } = useStorefront();
  const [message, setMessage] = useState("");
  const contact = settings.contact;
  const address = pick(contact.address_ar, contact.address_en);
  const hours = pick(contact.hours_ar, contact.hours_en);
  const name = pick(contact.store_name_ar, contact.store_name_en);
  const map = externalHref(contact.map_url);
  const instapay = externalHref(settings.social.instapay_link);
  const channels = resolvedV2SocialChannels(settings, lang);
  const whatsapp = resolvedSocialLinks(settings).find((row) => row.platform === "whatsapp" && row.enabled);
  const send = whatsapp ? socialChannelHref("whatsapp", whatsapp.url,
    message.trim() || t("store.contact.whatsappMessage")) : null;
  const phoneHref = contact.phone ? `tel:${contact.phone.replace(/[^+\d]/g, "")}` : null;
  const emailHref = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact.email) ? `mailto:${contact.email}` : null;

  useEffect(() => {
    applyDocumentMeta({ title: `${t("store.contact.title")} — ${name}`,
      description: address || pick(contact.tagline_ar, contact.tagline_en) || name,
      canonical: absoluteUrl(window.location.href.split("#")[0], "#/store/contact") });
    applyJsonLd(storeJsonLd(settings, window.location.href.split("#")[0]));
    return () => clearDocumentMeta();
  }, [address, contact.tagline_ar, contact.tagline_en, name, pick, settings, t]);

  return <div className="v2-journey v2-container" data-testid="v2-contact">
    <p className="v2-eyebrow">{t("store.v2.eyebrow")}</p><h1>{t("store.contact.title")}</h1>
    <p className="v2-small">{pick(contact.tagline_ar, contact.tagline_en) || t("store.contact.subtitle")}</p>
    <div className="v2-journey-grid"><div className="v2-journey-main"><V2Panel title={t("store.contact.details")}>
      <dl className="v2-contact-list">
        {contact.phone ? <div><dt>{t("store.contact.phone")}</dt><dd>{phoneHref ?
          <a href={phoneHref} dir="ltr">{contact.phone}</a> : contact.phone}</dd></div> : null}
        {contact.email ? <div><dt>{t("store.contact.email")}</dt><dd>{emailHref ?
          <a href={emailHref}>{contact.email}</a> : contact.email}</dd></div> : null}
        {address ? <div><dt>{t("store.contact.address")}</dt><dd>{address}{" "}
          {map ? <a href={map} target="_blank" rel="noopener noreferrer">{t("store.contact.openMap")}</a> : null}</dd></div> : null}
        {hours ? <div><dt>{t("store.contact.hours")}</dt><dd className="v2-preline">{hours}</dd></div> : null}
      </dl>
    </V2Panel>
      <V2Panel title={t("store.contact.sendMessage")}><label className="v2-field">{t("store.contact.message")}
        <textarea value={message} rows={4} onChange={(event) => setMessage(event.target.value)}
          placeholder={t("store.contact.messagePlaceholder")} /></label>
        {send ? <a className="v2-primary-button" href={send} target="_blank" rel="noopener noreferrer">
          {t("store.contact.sendOnWhatsapp")}</a> : <p className="v2-small">{t("store.contact.noWhatsapp")}</p>}
        <p className="v2-small">{t("store.contact.whatsappNote")}</p>
      </V2Panel>
    </div><aside className="v2-journey-aside">
      {channels.length ? <V2Panel title={t("store.contact.followUs")}>
        <div className="v2-contact-channels">{channels.map((channel) => <a key={channel.platform}
          href={channel.href} target="_blank" rel="noopener noreferrer">{channel.label}</a>)}</div>
      </V2Panel> : null}
      {settings.delivery.enabled || settings.delivery.pickup_enabled ? <V2Panel title={t("store.footer.delivery")}>
        {settings.delivery.enabled ? <p>{t("store.checkout.delivery")}: {settings.delivery.fee
          ? t("store.footer.deliveryFee", { amount: money(settings.delivery.fee) }) : t("store.checkout.free")}</p> : null}
        {settings.delivery.pickup_enabled ? <p>{t("store.footer.pickupAvailable")}
          {pick(settings.delivery.pickup_address_ar, settings.delivery.pickup_address_en) ?
            ` · ${pick(settings.delivery.pickup_address_ar, settings.delivery.pickup_address_en)}` : ""}</p> : null}
        {deliveryZones.filter((zone) => zone.enabled).length > 0 ? <p className="v2-small">
          {deliveryZones.filter((zone) => zone.enabled).map((zone) => pick(zone.name_ar, zone.name_en)).join(" · ")}</p> : null}
      </V2Panel> : null}
      {instapay ? <V2Panel title={t("store.checkout.instapay")}><a href={instapay} target="_blank" rel="noopener noreferrer">
        {t("store.checkout.openInstapay")}</a><p className="v2-small">{t("store.contact.instapayNote")}</p></V2Panel> : null}
    </aside></div>
  </div>;
}
