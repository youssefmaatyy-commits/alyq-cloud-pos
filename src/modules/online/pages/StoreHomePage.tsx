/**
 * The storefront homepage.
 *
 * The page is not a layout with data poured into it — it is the admin's list of
 * sections, rendered in the order they chose, with the titles they wrote and the
 * limits they set. A section they hid is not rendered at all (not hidden with
 * CSS), so it costs the visitor nothing.
 *
 * The hero rotates on a timer and stops rotating when the visitor is reading
 * something else, because a slider that keeps moving under a finger is a slider
 * nobody can tap.
 */
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { cn } from "@/utils/cn";
import { useStorefront } from "../hooks/StorefrontProvider";
import {
  searchCatalog,
  EMPTY_CATALOG_FILTERS,
  type StorefrontSort,
} from "../services/catalogQuery";
import {
  DEFAULT_SECTION_LIMITS,
  resolvedBanners,
  resolvedSlides,
  sectionImage,
  sectionLimit,
  sectionTitle,
} from "../services/sections";
import type { HomepageSectionKey } from "../types";
import { ProductCard, ProductGrid } from "../components/storefront/ProductCard";
import { SectionShell, StarRating, StoreImage, StoreLink } from "../components/storefront/StorePrimitives";
import {
  absoluteUrl,
  applyDocumentMeta,
  applyJsonLd,
  clearDocumentMeta,
  keywordList,
  storeJsonLd,
} from "../services/seo";

/** How long a hero slide stays up before the next one. */
const SLIDE_MS = 6000;

export function StoreHomePage() {
  const { t, pick, lang } = useI18n();
  const {
    settings,
    products,
    sections,
    catalogContext,
    campaigns,
    reviews,
    faqs,
    brands,
    categories,
    loading,
  } = useStorefront();

  const [slideIndex, setSlideIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const [openFaq, setOpenFaq] = useState<string | null>(null);

  const slides = useMemo(() => resolvedSlides(settings, pick), [pick, settings]);
  const banners = useMemo(() => resolvedBanners(settings, pick), [pick, settings]);

  const storeName = pick(settings.contact.store_name_ar, settings.contact.store_name_en);

  // This is the page a search engine judges the shop by, so it carries the SEO
  // document the admin wrote, a canonical URL and the shop's own structured data
  // — never the back office's default title. Everything here comes from settings,
  // so writing a meta description in the builder is what changes it.
  useEffect(() => {
    const baseUrl = typeof window === "undefined" ? "" : window.location.href.split("#")[0];
    applyDocumentMeta({
      title: settings.seo.meta_title.trim() || storeName,
      description:
        settings.seo.meta_description.trim() ||
        pick(settings.contact.tagline_ar, settings.contact.tagline_en) ||
        t("store.section.hero"),
      canonical: absoluteUrl(baseUrl, "#/store"),
      keywords: keywordList(settings.seo.keywords),
      ogImage: settings.seo.og_image_url,
      ogType: "website",
      locale: lang === "ar" ? "ar_EG" : "en_US",
      siteName: storeName,
    });
    applyJsonLd(storeJsonLd(settings, baseUrl));
    return () => clearDocumentMeta();
  }, [lang, pick, settings, storeName, t]);

  useEffect(() => {
    if (slides.length < 2 || paused) return;
    const timer = window.setInterval(
      () => setSlideIndex((index) => (index + 1) % slides.length),
      SLIDE_MS,
    );
    return () => window.clearInterval(timer);
  }, [paused, slides.length]);

  // Product rails, each computed once for the whole page. A section the admin
  // hid still gets a limit from the defaults, so unhiding it later shows a
  // sensible number of products rather than an empty row.
  const rails = useMemo(() => {
    const limitFor = (key: HomepageSectionKey) => {
      const section = sections.find((entry) => entry.key === key);
      return section ? sectionLimit(section) : DEFAULT_SECTION_LIMITS[key];
    };
    const query = (key: HomepageSectionKey, sort: StorefrontSort) =>
      searchCatalog(products, { ...EMPTY_CATALOG_FILTERS, sort, limit: limitFor(key) }, catalogContext);

    return {
      // "Featured" is the one badge an admin sets by hand, so the rail shows
      // exactly what they flagged rather than whatever sold best.
      featured: query("featured", "featured").filter((entry) => entry.product.is_featured),
      bestSellers: query("bestSellers", "best_selling"),
      newArrivals: query("newArrivals", "newest"),
      onSale: searchCatalog(products, { ...EMPTY_CATALOG_FILTERS, sort: "price_asc" }, catalogContext)
        .filter((entry) => entry.onSale)
        .slice(0, 5),
    };
  }, [catalogContext, products, sections]);

  const heading = (key: HomepageSectionKey, fallback: string) => {
    const section = sections.find((entry) => entry.key === key);
    const own = section ? sectionTitle(section, pick) : "";
    return own || t(fallback as never);
  };

  if (loading && products.length === 0) {
    return (
      <div className="mx-auto w-full max-w-[var(--store-max-width,72rem)] px-4 py-20 text-center text-sm font-semibold text-[var(--store-muted)] sm:px-6">
        {t("common.loading")}
      </div>
    );
  }

  const rendered = sections.map((section) => {
    const key = section.key;
    const image = sectionImage(settings, key);

    switch (key) {
      case "hero": {
        if (slides.length === 0) return null;
        const slide = slides[Math.min(slideIndex, slides.length - 1)];
        return (
          <section
            key="hero"
            className="relative overflow-hidden bg-[var(--store-secondary)]"
            onMouseEnter={() => setPaused(true)}
            onMouseLeave={() => setPaused(false)}
            onFocus={() => setPaused(true)}
            onBlur={() => setPaused(false)}
          >
            <div className="relative mx-auto w-full max-w-[var(--store-max-width,72rem)] px-4 sm:px-6">
              <div
                className={cn(
                  "grid items-center gap-6 py-10 sm:py-16",
                  slide.imageUrl ? "md:grid-cols-2" : "",
                )}
              >
                <div
                  className={cn(
                    "text-center",
                    slide.align === "start" ? "md:text-start" : "",
                    slide.align === "end" ? "md:text-end" : "",
                    slide.align === "center" ? "md:text-center" : "",
                  )}
                >
                  <h1 className="text-3xl font-black leading-tight tracking-tight text-[var(--store-on-secondary)] sm:text-4xl lg:text-5xl">
                    {slide.title}
                  </h1>
                  {slide.subtitle ? (
                    <p className="mt-3 text-sm font-medium leading-relaxed text-[var(--store-on-secondary)] opacity-85 sm:text-base">
                      {slide.subtitle}
                    </p>
                  ) : null}
                  {slide.ctaLabel ? (
                    <Link
                      to={slide.ctaHref.startsWith("#") ? slide.ctaHref.slice(1) : slide.ctaHref || "/store/products"}
                      className="mt-6 inline-block bg-[var(--store-primary)] px-6 py-3 text-sm font-black text-[var(--store-on-primary)] shadow-lg transition hover:bg-[var(--store-primary-hover)]"
                      style={{ borderRadius: "var(--store-radius-button)" }}
                    >
                      {slide.ctaLabel}
                    </Link>
                  ) : null}
                </div>

                {slide.imageUrl ? (
                  <StoreImage
                    src={slide.imageUrl}
                    alt={slide.title}
                    ratio="aspect-[4/3]"
                    priority
                    sizes="(max-width: 768px) 100vw, 50vw"
                    className="w-full"
                    style={{ borderRadius: "var(--store-radius)" }}
                  />
                ) : null}
              </div>

              {slides.length > 1 ? (
                <div className="flex justify-center gap-2 pb-6">
                  {slides.map((candidate, index) => (
                    <button
                      key={candidate.id}
                      type="button"
                      onClick={() => setSlideIndex(index)}
                      aria-label={t("store.hero.goToSlide", { number: index + 1 })}
                      aria-current={index === slideIndex}
                      className={cn(
                        "h-2 rounded-full transition-all",
                        index === slideIndex
                          ? "w-6 bg-[var(--store-primary)]"
                          : "w-2 bg-[var(--store-on-secondary)] opacity-40",
                      )}
                    />
                  ))}
                </div>
              ) : null}
            </div>
          </section>
        );
      }

      case "categories": {
        const list = categories.filter((category) => category.active).slice(0, sectionLimit(section));
        if (list.length === 0) return null;
        return (
          <SectionShell
            key="categories"
            id="categories"
            title={heading("categories", "store.section.categories")}
            image={image}
            action={<StoreLink href="#/store/products">{t("store.section.seeAll")}</StoreLink>}
          >
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
              {list.map((category) => (
                <Link
                  key={category.id}
                  to={`/store/products?category=${encodeURIComponent(category.id)}`}
                  className="group flex flex-col items-center gap-2 border border-[var(--store-border)] bg-[var(--store-surface)] p-4 text-center transition hover:border-[var(--store-primary)]"
                  style={{ borderRadius: "var(--store-radius)" }}
                >
                  <span
                    className="grid h-12 w-12 place-items-center bg-[var(--store-primary-soft)] text-lg font-black text-[var(--store-primary)]"
                    style={{ borderRadius: "var(--store-radius-button)" }}
                  >
                    {pick(category.name_ar, category.name_en).slice(0, 2)}
                  </span>
                  <span className="text-xs font-bold text-[var(--store-text)]">
                    {pick(category.name_ar, category.name_en)}
                  </span>
                </Link>
              ))}
            </div>
          </SectionShell>
        );
      }

      case "featured":
      case "bestSellers":
      case "newArrivals": {
        const entries =
          key === "featured"
            ? rails.featured
            : key === "bestSellers"
              ? rails.bestSellers
              : rails.newArrivals;
        if (entries.length === 0) return null;
        const fallback =
          key === "featured"
            ? "store.section.featured"
            : key === "bestSellers"
              ? "store.section.bestSellers"
              : "store.section.newArrivals";
        return (
          <SectionShell
            key={key}
            id={key}
            title={heading(key, fallback)}
            image={image}
            action={<StoreLink href="#/store/products">{t("store.section.seeAll")}</StoreLink>}
          >
            <ProductGrid>
              {entries.map((entry) => (
                <ProductCard key={entry.product.id} entry={entry} compact />
              ))}
            </ProductGrid>
          </SectionShell>
        );
      }

      case "promoBanners": {
        if (banners.length === 0) return null;
        return (
          <SectionShell key="promoBanners" id="promotions" title={heading("promoBanners", "store.section.promoBanners")} image={image}>
            <div className="grid gap-4 md:grid-cols-2">
              {banners.map((banner) => (
                <a
                  key={banner.id}
                  href={banner.href ? (banner.href.startsWith("#") ? banner.href.slice(1) : banner.href) : "#/store/products"}
                  className="group relative flex min-h-40 items-end overflow-hidden border border-[var(--store-border)] bg-[var(--store-secondary)] p-5"
                  style={{ borderRadius: "var(--store-radius)" }}
                >
                  {banner.imageUrl ? (
                    <img
                      src={banner.imageUrl}
                      alt=""
                      aria-hidden
                      loading="lazy"
                      decoding="async"
                      className="absolute inset-0 h-full w-full object-cover opacity-60 transition group-hover:scale-105"
                    />
                  ) : null}
                  <div className="relative">
                    {banner.badge ? (
                      <span className="mb-2 inline-block bg-[var(--store-accent)] px-2 py-0.5 text-[10px] font-black uppercase tracking-wide text-[var(--store-on-accent)]">
                        {banner.badge}
                      </span>
                    ) : null}
                    <p className="text-lg font-black text-[var(--store-on-secondary)]">{banner.title}</p>
                    {banner.caption ? (
                      <p className="mt-1 text-xs font-medium text-[var(--store-on-secondary)] opacity-85">
                        {banner.caption}
                      </p>
                    ) : null}
                  </div>
                </a>
              ))}
            </div>
          </SectionShell>
        );
      }

      case "brands": {
        if (brands.length === 0) return null;
        return (
          <SectionShell key="brands" id="brands" title={heading("brands", "store.section.brands")} image={image}>
            <div className="flex flex-wrap gap-2">
              {brands.map((brand) => (
                <Link
                  key={brand.name_en || brand.name_ar}
                  to={`/store/products?brand=${encodeURIComponent(brand.name_en || brand.name_ar)}`}
                  className="border border-[var(--store-border)] bg-[var(--store-surface)] px-4 py-2 text-xs font-bold text-[var(--store-text)] transition hover:border-[var(--store-primary)] hover:text-[var(--store-primary)]"
                  style={{ borderRadius: "var(--store-radius-pill,9999px)" }}
                >
                  {pick(brand.name_ar, brand.name_en)}
                  <span className="ms-1.5 text-[var(--store-muted)]">{brand.count}</span>
                </Link>
              ))}
            </div>
          </SectionShell>
        );
      }

      case "reviews": {
        const visible = reviews.filter((review) => review.visible).slice(0, sectionLimit(section));
        if (visible.length === 0) return null;
        return (
          <SectionShell key="reviews" id="reviews" title={heading("reviews", "store.section.reviews")} image={image}>
            <div className="grid gap-4 md:grid-cols-3">
              {visible.map((review) => (
                <figure
                  key={review.id}
                  className="flex h-full flex-col gap-2 border border-[var(--store-border)] bg-[var(--store-surface)] p-4"
                  style={{ borderRadius: "var(--store-radius)" }}
                >
                  <StarRating value={review.rating} />
                  <blockquote className="flex-1 text-sm leading-relaxed text-[var(--store-text)]">
                    “{review.body}”
                  </blockquote>
                  <figcaption className="text-xs font-bold text-[var(--store-muted)]">
                    {review.author_name}
                  </figcaption>
                </figure>
              ))}
            </div>
          </SectionShell>
        );
      }

      case "faq": {
        const visible = faqs.filter((faq) => faq.active).slice(0, sectionLimit(section));
        if (visible.length === 0) return null;
        return (
          <SectionShell key="faq" id="faq" title={heading("faq", "store.section.faq")} image={image}>
            <div className="mx-auto max-w-3xl divide-y divide-[var(--store-border)] border border-[var(--store-border)] bg-[var(--store-surface)]" style={{ borderRadius: "var(--store-radius)" }}>
              {visible.map((faq) => {
                const open = openFaq === faq.id;
                return (
                  <div key={faq.id}>
                    <button
                      type="button"
                      onClick={() => setOpenFaq(open ? null : faq.id)}
                      aria-expanded={open}
                      className="flex w-full items-center justify-between gap-3 px-4 py-3 text-start text-sm font-bold text-[var(--store-text)]"
                    >
                      {pick(faq.question_ar, faq.question_en)}
                      <span className={cn("shrink-0 text-[var(--store-primary)] transition", open && "rotate-45")}>
                        +
                      </span>
                    </button>
                    {open ? (
                      <p className="px-4 pb-4 text-sm leading-relaxed text-[var(--store-muted)]">
                        {pick(faq.answer_ar, faq.answer_en)}
                      </p>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </SectionShell>
        );
      }

      case "contact": {
        const address = pick(settings.contact.address_ar, settings.contact.address_en);
        const hours = pick(settings.contact.hours_ar, settings.contact.hours_en);
        if (!settings.contact.phone && !settings.contact.email && !address) return null;
        return (
          <SectionShell
            key="contact"
            id="contact"
            title={heading("contact", "store.section.contact")}
            image={image ?? settings.images.about_image_url}
            action={<StoreLink href="#/store/contact">{t("store.contact.pageLink")}</StoreLink>}
          >
            <div
              className="grid gap-4 border border-[var(--store-border)] bg-[var(--store-surface)] p-5 sm:grid-cols-3"
              style={{ borderRadius: "var(--store-radius)" }}
            >
              {settings.contact.phone ? (
                <div>
                  <p className="text-xs font-black uppercase tracking-widest text-[var(--store-muted)]">
                    {t("store.contact.phone")}
                  </p>
                  <a href={`tel:${settings.contact.phone}`} className="mt-1 block text-sm font-bold text-[var(--store-primary)]">
                    {settings.contact.phone}
                  </a>
                </div>
              ) : null}
              {settings.contact.email ? (
                <div>
                  <p className="text-xs font-black uppercase tracking-widest text-[var(--store-muted)]">
                    {t("store.contact.email")}
                  </p>
                  <a href={`mailto:${settings.contact.email}`} className="mt-1 block text-sm font-bold text-[var(--store-primary)]">
                    {settings.contact.email}
                  </a>
                </div>
              ) : null}
              {address ? (
                <div>
                  <p className="text-xs font-black uppercase tracking-widest text-[var(--store-muted)]">
                    {t("store.contact.address")}
                  </p>
                  <p className="mt-1 text-sm font-medium text-[var(--store-text)]">{address}</p>
                  {hours ? <p className="mt-0.5 text-xs text-[var(--store-muted)]">{hours}</p> : null}
                </div>
              ) : null}
            </div>
          </SectionShell>
        );
      }

      default:
        return null;
    }
  });

  return (
    <>
      {rendered}
      {rails.onSale.length > 0 ? (
        <SectionShell title={t("store.section.onSale")} image={null}>
          <ProductGrid>
            {rails.onSale.map((entry) => (
              <ProductCard key={entry.product.id} entry={entry} compact />
            ))}
          </ProductGrid>
        </SectionShell>
      ) : null}
      {campaigns.some((campaign) => campaign.active) ? (
        <p className="pb-8 text-center text-xs font-medium text-[var(--store-muted)]">
          {t("store.section.campaignNote")}
        </p>
      ) : null}
    </>
  );
}
