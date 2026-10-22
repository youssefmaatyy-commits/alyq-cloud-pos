import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useI18n, type TranslationKey } from "@/lib/i18n/I18nProvider";
import { useStorefront } from "../hooks/StorefrontProvider";
import { EMPTY_CATALOG_FILTERS, searchCatalog } from "../services/catalogQuery";
import { activeEditorialCampaigns, activeTrustItems } from "../services/settingsDefaults";
import { resolvedBanners, resolvedSlides, sectionImage, sectionLimit, sectionTitle } from "../services/sections";
import { absoluteUrl, applyDocumentMeta, applyJsonLd, clearDocumentMeta, keywordList, storeJsonLd } from "../services/seo";
import type { HomepageSectionConfig } from "../types";
import { V2ProductCard } from "./ProductCard";
import { V2ActionLink, V2Image, V2ProductGrid, V2Section, V2State } from "./Primitives";
import { resolvedV2SocialChannels } from "./SocialChannels";
import { SocialIcon } from "../components/storefront/SocialIcon";
import { v2Price } from "./viewModel";
import { v2Href } from "./appearance";

export function StorefrontV2Home() {
  const { pick, t, lang } = useI18n();
  const {
    settings, products, categories, categoryContents, sections, catalogContext,
    bestSellerIds, brands, faqs, reviews, loading, error, refresh,
    variantsOf, campaigns, promotions, promotionTargets,
  } = useStorefront();
  // The shared resolver applies ALYQ's language fallback. Keep genuinely blank
  // fields blank rather than rendering the i18n picker's placeholder dash.
  const slides = useMemo(() => resolvedSlides(settings, pick).map((slide) => {
    const source = settings.images.hero_slides.find((item) => item.id === slide.id);
    return {
      ...slide,
      title: source?.title_ar || source?.title_en ? slide.title : "",
      subtitle: source?.subtitle_ar || source?.subtitle_en ? slide.subtitle : "",
      // The primary hero action is always a clear, localized route to the
      // published catalogue. Keep merchant copy when it exists in this
      // language; otherwise use the storefront's own bilingual fallback.
      ctaLabel: lang === "ar"
        ? source?.cta_label_ar?.trim() || t("store.v2.shopCollection")
        : source?.cta_label_en?.trim() || t("store.v2.shopCollection"),
      ctaHref: "#/store/products",
      secondaryCtaLabel: source?.secondary_cta_label_ar || source?.secondary_cta_label_en ? slide.secondaryCtaLabel : "",
    };
  }).filter((slide) => slide.title || slide.imageUrl || slide.mobileImageUrl), [settings, pick, lang, t]);
  const [heroIndex, setHeroIndex] = useState(0);
  const [heroPaused, setHeroPaused] = useState(false);
  useEffect(() => {
    if (slides.length < 2 || heroPaused || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const timer = window.setInterval(() => setHeroIndex((index) => (index + 1) % slides.length), 6500);
    return () => window.clearInterval(timer);
  }, [slides.length, heroPaused]);
  const categoryMap = useMemo(() => new Map(categoryContents.map((row) => [row.category_id, row])), [categoryContents]);
  const all = useMemo(() => searchCatalog(products, EMPTY_CATALOG_FILTERS, catalogContext), [products, catalogContext]);
  const recent = useMemo(() => searchCatalog(products, { ...EMPTY_CATALOG_FILTERS, sort: "newest" }, catalogContext),
    [products, catalogContext]);

  useEffect(() => {
    const baseUrl = window.location.href.split("#")[0];
    const storeName = pick(settings.contact.store_name_ar, settings.contact.store_name_en);
    applyDocumentMeta({
      title: settings.seo.meta_title.trim() || storeName,
      description: settings.seo.meta_description.trim() ||
        pick(settings.contact.tagline_ar, settings.contact.tagline_en) || t("store.section.hero"),
      canonical: absoluteUrl(baseUrl, "#/store"), keywords: keywordList(settings.seo.keywords),
      ogImage: settings.seo.og_image_url, locale: lang === "ar" ? "ar_EG" : "en_US", siteName: storeName,
    });
    applyJsonLd(storeJsonLd(settings, baseUrl));
    return () => clearDocumentMeta();
  }, [lang, pick, settings, t]);

  if (loading && products.length === 0) return <V2State kind="loading" />;
  if (error && products.length === 0) return <V2State kind="error" onRetry={() => void refresh()} />;

  function heading(section: HomepageSectionConfig) {
    return section.title_ar || section.title_en ? sectionTitle(section, pick)
      : t(`store.section.${section.key}` as TranslationKey);
  }
  function action(section: HomepageSectionConfig, fallback = "#/store/products") {
    const label = section.cta_ar || section.cta_en ? pick(section.cta_ar, section.cta_en) : t("store.v2.viewAll");
    return <V2ActionLink href={section.cta_href || fallback} className="v2-text-link">{label}<span aria-hidden></span></V2ActionLink>;
  }

  const render = (section: HomepageSectionConfig) => {
    const image = section.image_url || sectionImage(settings, section.key);
    const title = heading(section);
    switch (section.key) {
      case "hero": {
        const slide = slides[heroIndex % slides.length];
        if (!slide) return null;
        return (
          <section key="hero" className={`v2-hero v2-hero-${slide.height}`} aria-label={slide.title || title}
            data-testid="v2-hero" onMouseEnter={() => setHeroPaused(true)} onMouseLeave={() => setHeroPaused(false)}
            onFocusCapture={() => setHeroPaused(true)} onBlurCapture={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget)) setHeroPaused(false);
            }}>
            {(slide.imageUrl || slide.mobileImageUrl) ? (
              <><V2Image src={slide.imageUrl} mobileSrc={slide.mobileImageUrl} alt="" priority className="v2-hero-photo" />
                {/* A minimum scrim keeps white copy legible even when the shared
                    slide overlay is set to zero against a pale photograph. */}
                <div className="v2-hero-scrim" style={{ opacity: Math.max(0.58, (slide.overlay ?? 36) / 100) }} aria-hidden /></>
            ) : null}
            <div className={`v2-hero-content v2-hero-${slide.contentPosition}`}>
              {slide.title ? <h1>{slide.title}</h1> : null}
              {slide.subtitle ? <p className="v2-hero-subtitle">{slide.subtitle}</p> : null}
              <div className="v2-hero-actions">
                {slide.ctaLabel ? <V2ActionLink href={slide.ctaHref} className="v2-hero-button">{slide.ctaLabel}<span aria-hidden></span></V2ActionLink> : null}
                {slide.secondaryCtaLabel ? <V2ActionLink href={slide.secondaryCtaHref} className="v2-hero-secondary">{slide.secondaryCtaLabel}</V2ActionLink> : null}
              </div>
            </div>
            {slides.length > 1 ? <div className="v2-hero-pages" role="group" aria-label={t("store.v2.gallery")}>
              {slides.map((item, index) => <button key={item.id} type="button" aria-pressed={index === heroIndex % slides.length}
                aria-label={t("store.product.viewImage", { number: index + 1 })}
                onClick={() => setHeroIndex(index)} />)}
              <span aria-hidden>{String(heroIndex % slides.length + 1).padStart(2, "0")} / {String(slides.length).padStart(2, "0")}</span>
            </div> : null}
          </section>
        );
      }
      case "categories": {
        const active = categories.filter((category) => category.active && products.some((product) => product.category_id === category.id));
        const curated = section.category_ids?.length ? section.category_ids
          : categoryContents.filter((row) => row.featured).sort((a, b) => a.sort_order - b.sort_order).map((row) => row.category_id);
        const ids = curated.length ? curated : active.map((row) => row.id);
        const entries = ids.map((id) => active.find((row) => row.id === id)).filter((row) => row !== undefined).slice(0, sectionLimit(section));
        return (
          <V2Section key="categories" id="categories" title={title} action={entries.length ? action(section) : undefined}>
            {entries.length ? <div className="v2-category-grid">
              {entries.map((category) => {
                const content = categoryMap.get(category.id);
                const arabic = content?.title_ar || category.name_ar;
                const english = content?.title_en || category.name_en;
                return (
                  <Link key={category.id} to={`/store/products?category=${encodeURIComponent(category.id)}`} className="v2-category">
                    <span className="v2-category-copy">
                      <span className="v2-category-ar" lang="ar" dir="rtl">{arabic}</span>
                      <span className="v2-category-en" lang="en" dir="ltr">{english}</span>
                    </span>
                    <span className="v2-category-arrow" aria-hidden>↗</span>
                  </Link>
                );
              })}
            </div> : <p className="v2-category-empty" role="status">{t("store.v2.categoriesEmpty")}</p>}
          </V2Section>
        );
      }
      case "featured":
      case "bestSellers":
      case "newArrivals":
      case "collection":
      case "sale": {
        let entries = section.key === "featured" ? all.filter((entry) => entry.product.is_featured)
          : section.key === "bestSellers" ? bestSellerIds.map((id) => all.find((entry) => entry.product.id === id)).filter((row) => row !== undefined)
            : section.key === "newArrivals" ? recent.filter((entry) => entry.isNew)
              : section.key === "collection" ? (section.product_ids ?? []).map((id) => all.find((entry) => entry.product.id === id)).filter((row) => row !== undefined)
                : all.filter((entry) => {
                  const price = v2Price(entry.product, variantsOf(entry.product.id), campaigns,
                    promotions, promotionTargets, null, catalogContext.reservedVariant);
                  return price.price < price.list;
                });
        entries = entries.slice(0, sectionLimit(section));
        if (entries.length === 0) return null;
        return (
          <V2Section key={section.key} id={section.key} title={title}
            action={action(section, section.key === "sale" ? "#/store/products?offer=1"
              : section.key === "newArrivals" ? "#/store/products?sort=newest"
                : section.key === "bestSellers" ? "#/store/products?sort=best_selling" : "#/store/products")}>
            {section.key === "newArrivals" && entries.length <= 3
              ? <div className={`v2-new-arrivals v2-new-arrivals-${entries.length}`} data-count={entries.length} data-testid="v2-new-arrivals">
                {entries.map((entry, index) => <div key={entry.product.id} className="v2-new-arrival-item"
                  data-featured={entries.length === 3 && index === 0 ? true : undefined}>
                  <V2ProductCard entry={entry} priority={index < 2} />
                </div>)}
              </div>
              : <V2ProductGrid>{entries.map((entry, index) =>
                <V2ProductCard key={entry.product.id} entry={entry} priority={index < 2} />)}</V2ProductGrid>}
          </V2Section>
        );
      }
      case "campaigns": {
        const blocks = activeEditorialCampaigns(settings).filter((item) => item.placement === "homepage").slice(0, sectionLimit(section));
        if (!blocks.length) return null;
        return (
          <V2Section key="campaigns" id="campaigns" title={title}>
            <div className="v2-editorial-stack">
              {blocks.map((block) => <div key={block.id} className="v2-editorial v2-campaign">
                <V2Image src={block.desktop_image_url} mobileSrc={block.mobile_image_url} alt="" />
                <div className="v2-editorial-copy">
                  <h3>{pick(block.title_ar, block.title_en)}</h3>
                  {block.subtitle_ar || block.subtitle_en ? <p>{pick(block.subtitle_ar, block.subtitle_en)}</p> : null}
                  {block.cta_ar || block.cta_en ? <V2ActionLink href={block.cta_href} className="v2-text-link">{pick(block.cta_ar, block.cta_en)}</V2ActionLink> : null}
                </div>
              </div>)}</div>
          </V2Section>
        );
      }
      case "promoBanners": {
        const banners = resolvedBanners(settings, pick);
        if (!banners.length) return null;
        return <V2Section key="promoBanners" title={title}><div className="v2-promo-row">
          {banners.map((banner) => {
            const raw = settings.images.promo_banners.find((entry) => entry.id === banner.id);
            const details = <>{banner.imageUrl ? <V2Image src={banner.imageUrl} alt="" /> : null}
              <span>{raw?.badge_ar || raw?.badge_en ? <small>{banner.badge}</small> : null}
                {raw?.title_ar || raw?.title_en ? <strong>{banner.title}</strong> : null}
                {raw?.caption_ar || raw?.caption_en ? <span>{banner.caption}</span> : null}</span></>;
            return v2Href(banner.href) ? <V2ActionLink key={banner.id} href={banner.href} className="v2-promo-card">
              {details}</V2ActionLink> : <div key={banner.id} className="v2-promo-card">{details}</div>;
          })}
        </div></V2Section>;
      }
      case "lookbook":
      case "editorial":
      case "textImage":
      case "aboutPreview": {
        const about = section.key === "aboutPreview";
        const body = about ? (settings.about.body_ar || settings.about.body_en
          ? pick(settings.about.body_ar, settings.about.body_en) : "")
          : section.body_ar || section.body_en ? pick(section.body_ar, section.body_en) : "";
        const cover = image || (about ? settings.about.image_url : null);
        if (!body && !cover) return null;
        const link = about ? settings.about.cta_href : section.cta_href;
        const cta = about ? (settings.about.cta_ar || settings.about.cta_en
          ? pick(settings.about.cta_ar, settings.about.cta_en) : "")
          : section.cta_ar || section.cta_en ? pick(section.cta_ar, section.cta_en) : "";
        return <V2Section key={section.key} id={section.key} title={title} className="v2-editorial-section">
          <div className="v2-editorial">
            {cover ? <V2Image src={cover} mobileSrc={section.mobile_image_url} alt="" /> : null}
            <div className="v2-editorial-copy"><p className="v2-eyebrow">{t("store.v2.stories")}</p>
              <h3>{title}</h3>{body ? <p>{body}</p> : null}
              {cta ? <V2ActionLink href={link} className="v2-text-link">{cta}</V2ActionLink> : null}
            </div>
          </div>
        </V2Section>;
      }
      case "trustStrip": {
        const items = activeTrustItems(settings).slice(0, 4);
        return items.length ? <V2Section key="trustStrip" id="trustStrip" title={title}><div className="v2-trust-grid">
          {items.map((item) => <div key={item.id} className="v2-trust-item"><span aria-hidden>✦</span>
            <strong>{pick(item.title_ar, item.title_en)}</strong>
            {item.desc_ar || item.desc_en ? <p>{pick(item.desc_ar, item.desc_en)}</p> : null}</div>)}
        </div></V2Section> : null;
      }
      case "newsletter": {
        const email = settings.contact.email.trim();
        if (!email.includes("@")) return null;
        return <V2Section key="newsletter" id="newsletter" title={title} className="v2-newsletter-section">
          <div className="v2-newsletter"><p>{section.body_ar || section.body_en ? pick(section.body_ar, section.body_en) : t("store.v2.newsletterIntro")}</p>
            <a href={`mailto:${encodeURIComponent(email)}?subject=${encodeURIComponent("ALYQ news")}`}
              className="v2-outline-button">{t("store.v2.newsletterAction")}</a>
            <small>{t("store.v2.newsletterNote")}</small>
          </div>
        </V2Section>;
      }
      case "brands": {
        if (!brands.length) return null;
        return <V2Section key="brands" title={title}><div className="v2-chip-row">{brands.map((brand) => (
          <Link key={brand.name_en || brand.name_ar} to={`/store/products?brand=${encodeURIComponent(brand.name_en || brand.name_ar)}`}
            className="v2-category-chip">{pick(brand.name_ar, brand.name_en)}</Link>
        ))}</div></V2Section>;
      }
      case "reviews": {
        const visible = reviews.filter((review) => review.visible && review.product_id === null).slice(0, section.limit);
        if (!visible.length) return null;
        return <V2Section key="reviews" title={title}><div className="v2-review-grid">{visible.map((review) => (
          <blockquote key={review.id}><span aria-label={`${review.rating}/5`}>{"★".repeat(review.rating)}</span><p>{review.body}</p><cite>{review.author_name}</cite></blockquote>
        ))}</div></V2Section>;
      }
      case "faq": {
        const visible = faqs.filter((faq) => faq.active).slice(0, section.limit);
        if (!visible.length) return null;
        return <V2Section key="faq" title={title}><div className="v2-faq">{visible.map((faq) => (
          <details key={faq.id}><summary>{pick(faq.question_ar, faq.question_en)}</summary><p>{pick(faq.answer_ar, faq.answer_en)}</p></details>
        ))}</div></V2Section>;
      }
      case "socialGallery": {
        // The optional editorial social section shows profiles; WhatsApp has
        // one deliberate contact action in the footer instead of a third CTA.
        const links = resolvedV2SocialChannels(settings, lang).filter((link) => link.platform !== "whatsapp");
        if (!links.length) return null;
        return <V2Section key="socialGallery" title={title}><div className="v2-chip-row">
          {links.map((link) => <V2ActionLink key={link.platform} href={link.href}
            className="v2-category-chip v2-social-gallery-link">
            <SocialIcon kind={link.platform} />{link.label}
          </V2ActionLink>)}
        </div></V2Section>;
      }
      case "contact": {
        if (!settings.contact.phone && !settings.contact.email) return null;
        return <V2Section key="contact" title={title}><div className="v2-contact-band">
          <p>{pick(settings.contact.address_ar, settings.contact.address_en)}</p>
          <Link to="/store/contact" className="v2-text-link">{t("store.nav.contact")}</Link>
        </div></V2Section>;
      }
    }
  };

  const rendered = sections.map(render).filter(Boolean);
  return <div className="v2-home" data-testid="v2-home">{rendered.length ? rendered : (
    <div className="v2-container v2-home-empty"><V2State kind="empty" />
      <Link to="/store/products" className="v2-outline-button">{t("store.product.browseAll")}</Link>
    </div>
  )}</div>;
}
