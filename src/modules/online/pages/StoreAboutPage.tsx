/**
 * The About page — Phase 45.
 *
 * Whatever the shop wants to say about itself, from `website_settings.about`:
 * a title, a body, an image and one call to action, each in Arabic and English.
 * The page is a frame, not a source — with nothing configured it still renders
 * (the shop's own tagline and a route back to browsing), because a linked page
 * that 404s is worse than a modest one.
 */
import { useEffect } from "react";
import { Link } from "react-router-dom";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { useStorefront } from "../hooks/StorefrontProvider";
import { StoreImage } from "../components/storefront/StorePrimitives";
import { externalHref, internalHref } from "../services/settingsDefaults";
import { absoluteUrl, applyDocumentMeta, clearDocumentMeta, keywordList } from "../services/seo";

export function StoreAboutPage() {
  const { t, pick, lang } = useI18n();
  const { settings } = useStorefront();
  const about = settings.about;

  const storeName = pick(settings.contact.store_name_ar, settings.contact.store_name_en) || "ALYQ";
  const title = pick(about.title_ar, about.title_en).trim() || t("store.nav.about");
  const body = pick(about.body_ar, about.body_en).trim();
  const ctaLabel = pick(about.cta_ar, about.cta_en).trim();

  useEffect(() => {
    const baseUrl = typeof window === "undefined" ? "" : window.location.href.split("#")[0];
    applyDocumentMeta({
      title: `${title} — ${storeName}`,
      description: body.slice(0, 160) || pick(settings.contact.tagline_ar, settings.contact.tagline_en),
      canonical: absoluteUrl(baseUrl, "#/store/about"),
      keywords: keywordList(settings.seo.keywords),
      ogImage: about.image_url,
      ogType: "website",
      locale: lang === "ar" ? "ar_EG" : "en_US",
      siteName: storeName,
    });
    return () => clearDocumentMeta();
  }, [about.image_url, body, lang, pick, settings.contact.tagline_ar, settings.contact.tagline_en, settings.seo.keywords, storeName, title]);

  const href = internalHref(about.cta_href)?.slice(1) ?? externalHref(about.cta_href);

  return (
    <div className="mx-auto w-full max-w-[var(--store-max-width)] px-4 py-12 sm:px-6 lg:grid lg:grid-cols-2 lg:items-center lg:gap-x-16" data-testid="store-about">
      <h1
        className="text-4xl font-normal tracking-tight text-[var(--store-text-primary)] md:text-4xl"
        style={{ fontFamily: "var(--store-font-display)" }}
      >
        {title}
      </h1>
      <div className="mt-8 lg:col-start-1 lg:row-span-4 lg:row-start-1 lg:mt-0">
        {about.image_url ? (
          <StoreImage src={about.image_url} alt={title} ratio="aspect-[4/5]" className="w-full" priority />
        ) : null}
      </div>
      {body ? (
        <div className="mt-8 space-y-4 text-[15px] leading-loose text-[var(--store-text-secondary)]">
          {body
            .split(/\n{2,}/)
            .map((paragraph) => paragraph.trim())
            .filter(Boolean)
            .map((paragraph) => (
              <p key={paragraph.slice(0, 32)}>{paragraph}</p>
            ))}
        </div>
      ) : (
        <p className="mt-6 text-sm leading-relaxed text-[var(--store-text-secondary)]">
          {pick(settings.contact.tagline_ar, settings.contact.tagline_en)}
        </p>
      )}
      {ctaLabel && href ? (
        href.startsWith("#") || href.startsWith("/") ? (
          <Link
            to={href.startsWith("#") ? href.slice(1) : href}
            className="mt-8 inline-block bg-[var(--store-primary)] px-6 py-3 text-xs font-black uppercase tracking-[0.18em] text-[var(--store-on-primary)] transition hover:bg-[var(--store-primary-hover)]"
            style={{ borderRadius: "var(--store-radius-button)" }}
          >
            {ctaLabel}
          </Link>
        ) : (
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-8 inline-block bg-[var(--store-primary)] px-6 py-3 text-xs font-black uppercase tracking-[0.18em] text-[var(--store-on-primary)] transition hover:bg-[var(--store-primary-hover)]"
            style={{ borderRadius: "var(--store-radius-button)" }}
          >
            {ctaLabel}
          </a>
        )
      ) : null}
      <div className="mt-10 lg:col-span-2 border-t border-[var(--store-hairline)] pt-6">
        <Link
          to="/store/products"
          className="text-[11px] font-black uppercase tracking-[0.2em] text-[var(--store-text-secondary)] transition hover:text-[var(--store-text-primary)]"
        >
          {t("store.product.browseAll")}
        </Link>
      </div>
    </div>
  );
}
