/** Representative, inert V2 draft-style preview. It shares the public adapter
 * and CSS tokens, but is NOT a mounted shop or a checkout. Open the saved V2
 * route for exact responsive behaviour and content. */
import { useState, type CSSProperties } from "react";
import type { Product } from "@/modules/products/types";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { dictionaries } from "@/lib/i18n/dictionary";
import type { WebsiteSettings } from "../../types";
import { resolvedAnnouncementMessages, safeImageField } from "../../services/settingsDefaults";
import { resolvedSlides } from "../../services/sections";
import { adaptV2Appearance } from "../../v2/appearance";
import { V2Icon } from "../../v2/Primitives";
import { resolvedV2SocialChannels, V2SocialIcons } from "../../v2/SocialChannels";
import "../../v2/storefront-v2.css";

export function StorefrontV2DraftPreview({ settings, products }: {
  settings: WebsiteSettings;
  products: Product[];
}) {
  const { lang, t } = useI18n();
  const [device, setDevice] = useState<"mobile" | "desktop">("mobile");
  const [language, setLanguage] = useState<"ar" | "en">(lang);
  const pick = (ar: string | null | undefined, en: string | null | undefined) =>
    language === "ar" ? (ar || en || "") : (en || ar || "");
  const copy = dictionaries[language];
  const appearance = adaptV2Appearance(settings);
  const name = pick(settings.brand.display_name_ar || settings.contact.store_name_ar,
    settings.brand.display_name_en || settings.contact.store_name_en);
  const slide = resolvedSlides(settings, pick)[0] ?? null;
  const heroImage = safeImageField(device === "mobile" ? slide?.mobileImageUrl || slide?.imageUrl : slide?.imageUrl);
  const messages = resolvedAnnouncementMessages(settings);
  const sample = products.filter((item) => item.active && item.show_on_website).slice(0, 3);
  const logo = device === "mobile" ? appearance.mobileLogoUrl : appearance.headerLogoUrl;
  const columns = device === "mobile" ? appearance.mobileColumns : Math.min(3, Number(settings.product_card.desktop_columns) || 3);
  const social = resolvedV2SocialChannels(settings, language);

  return <div data-testid="v2-draft-preview">
    <div className="mb-2 flex flex-wrap items-center gap-1 rounded-xl bg-slate-100 p-1">
      {(["mobile", "desktop"] as const).map((mode) => <button key={mode} type="button"
        data-testid={`v2-preview-${mode}`} aria-pressed={device === mode} onClick={() => setDevice(mode)}
        className={`min-h-9 flex-1 rounded-lg px-2 text-xs font-bold ${device === mode ? "bg-white shadow-sm" : "text-slate-600"}`}>
        {t(`online.v2.${mode}`)}
      </button>)}
      {(["en", "ar"] as const).map((locale) => <button key={locale} type="button"
        data-testid={`v2-preview-${locale}`} aria-pressed={language === locale} onClick={() => setLanguage(locale)}
        className={`min-h-9 rounded-lg px-2 text-xs font-bold ${language === locale ? "bg-white shadow-sm" : "text-slate-600"}`}>
        {locale.toUpperCase()}
      </button>)}
    </div>
    <div className="mx-auto max-w-full overflow-hidden rounded-lg border border-slate-300 shadow-sm"
      style={{ width: device === "mobile" ? 390 : "100%" }} role="group" aria-label={t("online.v2.previewTitle")}>
      <div className="store-v2 v2-admin-preview" dir={language === "ar" ? "rtl" : "ltr"} data-device={device}
        style={{ ...appearance.variables, minHeight: 0 }} aria-hidden="true">
        {settings.announcement.enabled && messages.length > 0 ? (
          <div className="v2-announcement">{pick(messages[0].text_ar, messages[0].text_en)}</div>
        ) : null}
        <div className="v2-header">
          <div className="v2-header-inner" style={{ width: "calc(100% - 24px)" }}>
            <div className="v2-header-start">
              {device === "mobile" ? <span className="v2-icon-button"><V2Icon name="menu" /></span> : null}
              {appearance.showSearch ? <span className="v2-icon-button"><V2Icon name="search" /></span> : null}
            </div>
            <div className="v2-logo">{logo ? <img src={logo} alt="" /> : <span>{name}</span>}</div>
            <div className="v2-header-end">
              {device === "desktop" && appearance.showLanguage ? <span className="v2-language-button">{language === "ar" ? "EN" : "عربي"}</span> : null}
              {appearance.showAccount ? <span className="v2-icon-button"><V2Icon name="user" /></span> : null}
              {appearance.showCart ? <span className="v2-icon-button"><V2Icon name="bag" /></span> : null}
            </div>
          </div>
          {device === "desktop" ? <div className="v2-desktop-nav" style={{ display: "flex" }}>
            {copy["store.nav.home"]} · {copy["store.nav.products"]}
          </div> : null}
        </div>
        {slide && settings.sections.some((section) => section.key === "hero" && section.visible) ? (
          <div className="v2-hero" style={{ minHeight: device === "mobile" ? 220 : 250 }}>
            {heroImage ? <><span className="v2-hero-photo"><picture><img src={heroImage} alt="" style={{ objectFit: "cover" }} /></picture></span>
              <div className="v2-hero-scrim" style={{ opacity: Math.max(0.58, (slide.overlay ?? 36) / 100) }} /></> : null}
            <div className={`v2-hero-content v2-hero-${slide.contentPosition}`} style={{ padding: "22px 0", width: "calc(100% - 36px)" }}>
              {slide.title ? <h1 style={{ fontSize: device === "mobile" ? 30 : 38 }}>{slide.title}</h1> : null}
              {slide.subtitle ? <p className="v2-hero-subtitle" style={{ fontSize: 12 }}>{slide.subtitle}</p> : null}
              {slide.ctaLabel ? <span className="v2-hero-button" style={{ marginTop: 12 }}>{slide.ctaLabel} ↗</span> : null}
            </div>
          </div>
        ) : null}
        <div style={{ padding: "20px 16px 26px" }}>
          <h2 className="v2-section-title" style={{ fontSize: 23, marginBottom: 15 }}>
            {copy["store.nav.products"]}
          </h2>
          {sample.length > 0 ? <div className="v2-product-grid" data-gap={settings.product_card.gap}
            style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`, gap: device === "mobile" ? 9 : 16 } as CSSProperties}>
            {sample.slice(0, Math.max(2, columns)).map((item) => <div className="v2-product-card" key={item.id}>
              <div className="v2-product-media" data-aspect={settings.product_card.aspect}>
                {safeImageField(item.image_url) ? <img src={safeImageField(item.image_url)!} alt=""
                  style={{ width: "100%", height: "100%", objectFit: settings.product_card.image_fit }} />
                  : <div className="v2-image-fallback">◇</div>}
                {settings.product_card.show_badge && item.is_featured ? <span className="v2-product-badge">
                  {copy["store.badge.featured"]}</span> : null}
              </div>
              <div className="v2-card-meta"><span className="v2-card-name" style={{ minHeight: 0 }}>
                {pick(item.name_ar, item.name_en)}</span>
                {settings.product_card.show_price ? <p className="v2-card-price">{item.selling_price.toLocaleString(language === "ar" ? "ar-EG" : "en-EG")} EGP</p> : null}
                {settings.product_card.show_quick_add ? <span className="v2-card-add">
                  {copy["store.v2.quickAdd"]} <span>＋</span></span> : null}
              </div>
            </div>)}
          </div> : <p className="v2-state" style={{ minHeight: 60 }}>
            {copy["online.v2.noProducts"]}
          </p>}
          <div style={{ display: "flex", gap: 8, alignItems: "center", paddingTop: 19 }}>
            <span className="v2-badge">{copy["online.v2.badge"]}</span>
            <span className="v2-primary-button" style={{ minHeight: 32, padding: "6px 12px" }}>
              {copy["online.v2.button"]}
            </span>
          </div>
        </div>
        <div className="v2-footer"><div className="v2-footer-inner" style={{ width: "calc(100% - 32px)", padding: "18px 0", display: "block" }}>
          <div className="v2-footer-wordmark" style={{ fontSize: 19 }}>{name}</div>
          <p style={{ marginTop: 5, fontSize: 11 }}>{pick(settings.footer.description_ar || settings.contact.tagline_ar,
            settings.footer.description_en || settings.contact.tagline_en)}</p>
          <span style={{ color: "var(--v2-footer-link)", fontSize: 11 }}>{copy["store.nav.products"]} · {copy["store.nav.contact"]}</span>
          {settings.footer.show_social ? <V2SocialIcons channels={social} inert /> : null}
          {social.some((channel) => channel.platform === "whatsapp") ? (
            <span className="v2-footer-contact-action" style={{ display: "flex", width: "fit-content", marginTop: 8 }}>
              {copy["store.v2.whatsappContact"]}
            </span>
          ) : null}
        </div></div>
      </div>
    </div>
    <p className="mt-2 text-[11px] leading-relaxed text-slate-600">{t("online.v2.previewHint")}</p>
  </div>;
}
