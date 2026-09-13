/**
 * The live preview inside the website builder.
 *
 * "Reflects immediately" is only worth anything if what you are looking at is
 * what the customer will get, so this is not a mock-up with its own colours: it
 * renders through the same theme helpers the storefront uses
 * (`themeStyle`, `primaryButtonStyle`, `cardStyle`, `fontStackOf`) and reads the
 * same images. Change the primary colour here and the buttons in the preview
 * change with it, because they are computed the same way the real page computes
 * them.
 *
 * It is deliberately a fragment — header, hero, two product cards, footer strip —
 * rather than an iframe of the whole site: an iframe would need the storefront
 * mounted inside the admin, with its own providers and its own copy of the data.
 */
import { useI18n } from "@/lib/i18n/I18nProvider";
import type { WebsiteSettings } from "../../types";
import {
  badgeStyle,
  cardStyle,
  fontStackOf,
  primaryButtonStyle,
  secondaryButtonStyle,
  themeStyle,
} from "../../services/theme";
import { orderedSections, resolvedSlides, sectionImage } from "../../services/sections";

export function StorefrontPreview({ settings }: { settings: WebsiteSettings }) {
  const { t, pick } = useI18n();

  const storeName = pick(settings.contact.store_name_ar, settings.contact.store_name_en) || "ALYQ";
  const tagline = pick(settings.contact.tagline_ar, settings.contact.tagline_en);
  const slides = resolvedSlides(settings, (arabic, english) => pick(arabic, english));
  const slide = slides[0] ?? null;
  const sections = orderedSections(settings).slice(0, 4);
  const heroImage = slide?.imageUrl ?? sectionImage(settings, "hero");

  return (
    <div
      className="overflow-hidden rounded-2xl border border-slate-200 shadow-sm"
      style={{ ...themeStyle(settings), fontFamily: fontStackOf(settings.theme.font_stack) }}
      dir="ltr"
    >
      {settings.announcement.enabled ? (
        <p
          className="px-3 py-1.5 text-center text-[11px] font-bold"
          style={{
            background: "var(--store-secondary)",
            color: "var(--store-on-secondary)",
          }}
        >
          {pick(settings.announcement.text_ar, settings.announcement.text_en) ||
            t("online.preview.announcement")}
        </p>
      ) : null}

      <header
        className="flex items-center justify-between gap-3 px-4 py-3"
        style={{
          background: "var(--store-surface)",
          borderBottom: "1px solid var(--store-border)",
        }}
      >
        <span className="flex items-center gap-2">
          {settings.images.logo_url ? (
            <img
              src={settings.images.logo_url}
              alt=""
              className="h-8 w-8 object-contain"
              loading="lazy"
              decoding="async"
            />
          ) : (
            <span
              className="grid h-8 w-8 place-items-center text-xs font-black"
              style={{
                background: "var(--store-primary)",
                color: "var(--store-on-primary)",
                borderRadius: "var(--store-radius)",
              }}
            >
              {storeName.slice(0, 2).toUpperCase()}
            </span>
          )}
          <span>
            <span className="block text-sm font-black" style={{ color: "var(--store-text)" }}>
              {storeName}
            </span>
            {tagline ? (
              <span className="block text-[10px]" style={{ color: "var(--store-muted)" }}>
                {tagline}
              </span>
            ) : null}
          </span>
        </span>
        <span className="flex items-center gap-2">
          <span className="text-[10px] font-bold" style={{ color: "var(--store-muted)" }}>
            {t("online.preview.cart")}
          </span>
          <span
            className="grid h-6 w-6 place-items-center text-[10px] font-black"
            style={{
              background: "var(--store-accent)",
              color: "var(--store-on-accent)",
              borderRadius: "999px",
            }}
          >
            2
          </span>
        </span>
      </header>

      {sections.some((section) => section.key === "hero") ? (
        <div
          className="relative grid min-h-[9rem] place-items-center bg-cover bg-center px-4 py-8 text-center"
          style={{
            backgroundImage: heroImage ? `url("${heroImage}")` : undefined,
            background: heroImage
              ? undefined
              : "linear-gradient(135deg, var(--store-primary), var(--store-secondary))",
          }}
        >
          <div
            className="absolute inset-0"
            style={{ background: heroImage ? "rgba(15,23,42,0.45)" : undefined }}
            aria-hidden
          />
          <div className="relative">
            <p className="text-base font-black text-white">
              {slide?.title ?? t("online.preview.heroTitle")}
            </p>
            <p className="mt-1 text-[11px] font-medium text-white/85">
              {slide?.subtitle ?? t("online.preview.heroSubtitle")}
            </p>
            <span
              className="mt-3 inline-block px-4 py-2 text-[11px] font-black"
              style={primaryButtonStyle(settings)}
            >
              {slide?.ctaLabel ?? t("online.preview.shopNow")}
            </span>
          </div>
        </div>
      ) : null}

      <div className="px-4 py-4" style={{ background: "var(--store-surface-alt)" }}>
        <p
          className="text-[10px] font-black uppercase tracking-widest"
          style={{ color: "var(--store-muted)" }}
        >
          {t("online.preview.featured")}
        </p>
        <div className="mt-2 grid grid-cols-2 gap-2">
          {[0, 1].map((index) => (
            <article key={index} style={cardStyle(settings)} className="overflow-hidden">
              <div
                className="relative grid h-16 place-items-center text-[10px] font-bold"
                style={{ background: "var(--store-primary-soft)", color: "var(--store-primary)" }}
              >
                {index === 0 ? t("online.preview.sampleProduct") : t("online.preview.sampleProduct2")}
                {index === 0 ? (
                  <span
                    className="absolute top-1 start-1 px-1.5 py-0.5 text-[8px] font-black"
                    style={badgeStyle("sale")}
                  >
                    {t("online.preview.saleBadge")}
                  </span>
                ) : null}
              </div>
              <div className="p-2">
                <p className="text-[11px] font-bold" style={{ color: "var(--store-text)" }}>
                  {index === 0 ? t("online.preview.sampleProduct") : t("online.preview.sampleProduct2")}
                </p>
                <p className="text-[11px] font-black" style={{ color: "var(--store-primary)" }}>
                  {index === 0 ? "250.00" : "180.00"} {settings.currency}
                </p>
                <span
                  className="mt-1.5 inline-block w-full px-2 py-1 text-center text-[10px] font-black"
                  style={index === 0 ? primaryButtonStyle(settings) : secondaryButtonStyle(settings)}
                >
                  {t("online.preview.addToCart")}
                </span>
              </div>
            </article>
          ))}
        </div>
      </div>

      <footer
        className="flex items-center justify-between gap-2 px-4 py-3 text-[10px] font-semibold"
        style={{
          background: "var(--store-surface)",
          borderTop: "1px solid var(--store-border)",
          color: "var(--store-muted)",
        }}
      >
        <span>{storeName}</span>
        <span className="flex gap-2">
          {settings.social.facebook ? <span>f</span> : null}
          {settings.social.instagram ? <span>ig</span> : null}
          {settings.social.tiktok ? <span>tt</span> : null}
          {settings.social.whatsapp ? <span>wa</span> : null}
        </span>
      </footer>
    </div>
  );
}
