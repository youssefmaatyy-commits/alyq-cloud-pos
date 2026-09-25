/** V2 About: one editorial source in WebsiteSettings.about, not hard-coded
 * company facts. Missing optional content gets a modest, localized fallback. */
import { useEffect } from "react";
import { Link } from "react-router-dom";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { useStorefront } from "../hooks/StorefrontProvider";
import { absoluteUrl, applyDocumentMeta, clearDocumentMeta, keywordList } from "../services/seo";
import { V2ActionLink, V2Image } from "./Primitives";

export function StorefrontV2About() {
  const { t, pick, lang } = useI18n();
  const { settings } = useStorefront();
  const about = settings.about;
  const title = pick(about.title_ar, about.title_en).trim() || t("store.nav.about");
  const body = pick(about.body_ar, about.body_en).trim();
  const storeName = pick(settings.contact.store_name_ar, settings.contact.store_name_en) || "ALYQ";
  const cta = pick(about.cta_ar, about.cta_en).trim();
  useEffect(() => {
    applyDocumentMeta({ title: `${title} — ${storeName}`,
      description: body.slice(0, 160) || pick(settings.contact.tagline_ar, settings.contact.tagline_en),
      canonical: absoluteUrl(window.location.href.split("#")[0], "#/store/about"),
      keywords: keywordList(settings.seo.keywords), ogImage: about.image_url,
      locale: lang === "ar" ? "ar_EG" : "en_US", siteName: storeName });
    return () => clearDocumentMeta();
  }, [about.image_url, body, lang, pick, settings.contact.tagline_ar, settings.contact.tagline_en,
    settings.seo.keywords, storeName, title]);
  return <div className="v2-journey v2-container v2-about" data-testid="v2-about">
    <p className="v2-eyebrow">{t("store.v2.eyebrow")}</p>
    <div className="v2-about-layout">{about.image_url ? <div className="v2-about-photo">
      <V2Image src={about.image_url} alt={title} priority /></div> : null}
      <div className="v2-about-copy"><h1>{title}</h1>
        {body ? body.split(/\n{2,}/).map((paragraph, index) => <p key={index} className="v2-preline">{paragraph.trim()}</p>)
          : <p>{pick(settings.contact.tagline_ar, settings.contact.tagline_en)}</p>}
        {cta && about.cta_href ? <V2ActionLink href={about.cta_href} className="v2-primary-button">{cta} ↗</V2ActionLink> : null}
        <Link to="/store/products" className="v2-text-link">{t("store.cart.continueShopping")} ↗</Link>
      </div></div>
  </div>;
}
