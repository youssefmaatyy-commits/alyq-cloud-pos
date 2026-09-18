/**
 * The storefront homepage — Phase 45.
 *
 * The page is not a layout with data poured into it — it is the admin's list of
 * sections, rendered in the order they chose, with the titles they wrote and the
 * limits they set. A section they hid is not rendered at all (not hidden with
 * CSS), so it costs the visitor nothing.
 *
 * Phase 45 adds the editorial vocabulary around the product rails: a full-bleed
 * hero with scrim and content position, category tiles that read the shop
 * window (`storefront_category_content`), explicit collection/sale rails,
 * campaign blocks with a schedule, image+text editorial sections, the trust
 * strip, the social gallery and a newsletter band. All copy is bilingual, all
 * URLs pass the one safe-URL policy, and nothing here renders raw markup.
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
import {
  activeEditorialCampaigns,
  activeTrustItems,
  configuredHref,
  externalHref,
  internalHref,
  resolvedSocialLinks,
} from "../services/settingsDefaults";
import type { HomepageSectionConfig, HomepageSectionKey, TrustIcon } from "../types";
import { ProductCard, ProductGrid } from "../components/storefront/ProductCard";
import { SectionShell, StarRating, StoreImage, StoreLink } from "../components/storefront/StorePrimitives";
import { whatsappHref } from "../components/storefront/StoreLayout";
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

/** The hero's height presets — tall, image-led by default. */
const HERO_HEIGHT: Record<string, string> = {
  compact: "min-h-[42vh] md:min-h-[46vh]",
  classic: "min-h-[56vh] md:min-h-[60vh]",
  editorial: "min-h-[68vh] md:min-h-[78vh]",
};

/** The trust strip's icons: keys into this safe, hand-drawn set. */
function TrustGlyph({ icon }: { icon: TrustIcon }) {
  const paths: Record<TrustIcon, string> = {
    shield: "M12 3 5 5.5v5c0 4.4 3 8.4 7 9.5 4-1.1 7-5.1 7-9.5v-5L12 3Zm-1 12-3-3 1.4-1.4L11 12.2l4.6-4.6L17 9l-6 6Z",
    truck: "M3 6h11v9H3V6Zm12 3h3.2L21 12.2V15h-2.1a2.4 2.4 0 0 0-4.7 0H15V9ZM6.6 16.9a1.5 1.5 0 1 1 3 0 1.5 1.5 0 0 1-3 0Zm9.1 0a1.5 1.5 0 1 1 3 0 1.5 1.5 0 0 1-3 0Z",
    support: "M12 4a7 7 0 0 1 7 7v4a3 3 0 0 1-3 3h-1v-6h2.5A5.5 5.5 0 0 0 12 6.5 5.5 5.5 0 0 0 6.5 12H9v6H8a3 3 0 0 1-3-3v-4a7 7 0 0 1 7-7Z",
    exchange: "M7 5l-4 4 4 4V9.5h8v-2H7V5Zm10 5.5v3.5H9v2h8V19l4-4-4-4.5Z",
    gift: "M4 8h16v3h-1v9H5v-9H4V8Zm6 2h3V6.5A1.5 1.5 0 1 0 10 8v2Zm4.6-3.8c.5-1.2-.4-2.4-1.6-2.2-.9.2-1.5 1-2 1.9.5.2 1.1.3 1.7.3h1.9Z",
    star: "m12 4 2.4 4.9 5.4.8-3.9 3.8.9 5.4-4.8-2.5-4.8 2.5.9-5.4L4.2 9.7l5.4-.8L12 4Z",
    store: "M4 5h16l1.5 4.5c0 1.4-1 2.5-2.4 2.5-.9 0-1.7-.5-2.1-1.2-.4.7-1.2 1.2-2.1 1.2s-1.7-.5-2.1-1.2c-.4.7-1.2 1.2-2.1 1.2s-1.7-.5-2.1-1.2c-.4.7-1.2 1.2-2.1 1.2A2.45 2.45 0 0 1 4 9.5L4 5Zm1 9.5V20h14v-5.5a4.4 4.4 0 0 1-3.5-.6 4.4 4.4 0 0 1-3.5.6 4.4 4.4 0 0 1-3.5.6 4.4 4.4 0 0 1-3.5.6Z",
    clock: "M12 4a8 8 0 1 1 0 16 8 8 0 0 1 0-16Zm-.8 3v5.2l4 2.4.8-1.3-3.2-2V7h-1.6Z",
  };
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden>
      <path fill="currentColor" d={paths[icon]} />
    </svg>
  );
}

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
    categoryContents,
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

    // Explicit picks, in the admin's order — the collection rail is curated,
    // never inferred. Ids that no longer resolve (archived, removed) drop out.
    const collection = (() => {
      const section = sections.find((entry) => entry.key === "collection");
      const ids = section?.product_ids ?? [];
      if (ids.length === 0) return [];
      const found = searchCatalog(
        products,
        { ...EMPTY_CATALOG_FILTERS, sort: "featured", limit: ids.length, productIds: ids },
        catalogContext,
      );
      const byId = new Map(found.map((entry) => [entry.product.id, entry]));
      return ids.map((id) => byId.get(id)).filter((entry) => entry !== undefined);
    })();

    return {
      // "Featured" is the one badge an admin sets by hand, so the rail shows
      // exactly what they flagged rather than whatever sold best.
      featured: query("featured", "featured").filter((entry) => entry.product.is_featured),
      bestSellers: query("bestSellers", "best_selling"),
      newArrivals: query("newArrivals", "newest"),
      collection,
      onSale: searchCatalog(products, { ...EMPTY_CATALOG_FILTERS, sort: "price_asc" }, catalogContext)
        .filter((entry) => entry.onSale)
        .slice(0, limitFor("sale")),
    };
  }, [catalogContext, products, sections]);

  const heading = (key: HomepageSectionKey, fallback: string) => {
    const section = sections.find((entry) => entry.key === key);
    const own = section ? sectionTitle(section, pick) : "";
    return own || t(fallback as never);
  };

  const sectionCta = (section: HomepageSectionConfig): { label: string; to: string } | null => {
    const label = pick(section.cta_ar ?? "", section.cta_en ?? "").trim();
    if (!label) return null;
    const href = section.cta_href ?? "";
    const safe = internalHref(href)?.slice(1) ?? externalHref(href);
    if (!safe) return null;
    return { label, to: safe };
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
      // ── the hero ──────────────────────────────────────────────────────────
      case "hero": {
        if (slides.length === 0) return null;
        const slide = slides[Math.min(slideIndex, slides.length - 1)];
        const overlay = slide.overlay ?? 42;
        const position =
          slide.contentPosition === "start"
            ? "items-end justify-start text-start"
            : slide.contentPosition === "end"
              ? "items-end justify-end text-end"
              : "items-center justify-center text-center";
        const ctaHref =
          internalHref(slide.ctaHref)?.slice(1) ?? externalHref(slide.ctaHref) ?? "/store/products";
        const secondaryLabel = slide.secondaryCtaLabel;
        const secondaryHref = slide.secondaryCtaHref
          ? internalHref(slide.secondaryCtaHref)?.slice(1) ?? externalHref(slide.secondaryCtaHref)
          : null;
        return (
          <section
            key="hero"
            aria-label={slide.title || storeName}
            // Without imagery the stage falls back to the admin's own colours —
            // a quiet gradient from the secondary into the primary. Never a
            // colour the shop did not choose.
            className="relative overflow-hidden"
            style={{
              backgroundImage: "linear-gradient(140deg, var(--store-secondary) 0%, var(--store-primary) 100%)",
            }}
            onMouseEnter={() => setPaused(true)}
            onMouseLeave={() => setPaused(false)}
            onFocus={() => setPaused(true)}
            onBlur={() => setPaused(false)}
          >
            {/* full-bleed imagery: a phone-shaped picture on phones */}
            <div className="absolute inset-0" aria-hidden>
              {slide.imageUrl ? (
                <img
                  src={slide.imageUrl}
                  alt=""
                  className={cn(
                    "h-full w-full object-cover",
                    slide.mobileImageUrl ? "hidden md:block" : "block",
                  )}
                  loading="eager"
                  decoding="async"
                />
              ) : null}
              {slide.mobileImageUrl ? (
                <img
                  src={slide.mobileImageUrl}
                  alt=""
                  className={cn("h-full w-full object-cover md:hidden", slide.imageUrl ? "md:hidden" : "")}
                  loading="eager"
                  decoding="async"
                />
              ) : null}
              {/* the scrim — strength is the admin's call */}
              <div className="absolute inset-0 bg-black" style={{ opacity: overlay / 100 }} />
            </div>

            <div
              className={cn(
                "relative mx-auto flex w-full max-w-[var(--store-max-width)] px-6 sm:px-10",
                HERO_HEIGHT[slide.height ?? "editorial"] ?? HERO_HEIGHT.editorial,
                position,
              )}
            >
              <div className="max-w-xl py-16">
                {slide.title ? (
                  <h1
                    className="text-3xl font-black leading-[1.1] tracking-tight text-white sm:text-5xl lg:text-6xl"
                    style={{ fontFamily: "var(--store-font-display)" }}
                  >
                    {slide.title}
                  </h1>
                ) : null}
                {slide.subtitle ? (
                  <p className="mt-4 max-w-md text-sm font-medium leading-relaxed text-white/85 sm:text-base">
                    {slide.subtitle}
                  </p>
                ) : null}
                {slide.ctaLabel || (secondaryLabel && secondaryHref) ? (
                  <div className="mt-8 flex flex-wrap items-center gap-3">
                    {slide.ctaLabel ? (
                      <Link
                        // The CTA target is admin-typed: an in-app "#/…" route or a
                        // safe absolute http(s) URL. Anything else — including the
                        // "#javascript:…" slice bypass — falls back to the shop's
                        // own products route rather than rendering an unsafe href.
                        to={ctaHref}
                        className="inline-block bg-white px-7 py-3 text-xs font-black uppercase tracking-[0.18em] text-[var(--store-text)] transition hover:bg-[var(--store-secondary)] hover:text-[var(--store-on-secondary)]"
                        style={{ borderRadius: "var(--store-radius-button)" }}
                      >
                        {slide.ctaLabel}
                      </Link>
                    ) : null}
                    {secondaryLabel && secondaryHref ? (
                      <Link
                        to={secondaryHref}
                        className="inline-block border border-white/60 px-7 py-3 text-xs font-bold uppercase tracking-[0.18em] text-white/90 transition hover:border-white hover:bg-white/10 hover:text-white"
                        style={{ borderRadius: "var(--store-radius-button)" }}
                      >
                        {secondaryLabel}
                      </Link>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </div>

            {slides.length > 1 ? (
              <div className="absolute bottom-5 flex gap-2" style={{ insetInlineStart: "50%", transform: "translateX(-50%)" }}>
                {slides.map((candidate, index) => (
                  <button
                    key={candidate.id}
                    type="button"
                    onClick={() => setSlideIndex(index)}
                    aria-label={t("store.hero.goToSlide", { count: index + 1 })}
                    aria-current={index === slideIndex}
                    className={cn(
                      "h-1.5 rounded-full transition-all",
                      index === slideIndex ? "w-7 bg-white" : "w-1.5 bg-white/50",
                    )}
                  />
                ))}
              </div>
            ) : null}
          </section>
        );
      }

      // ── categories: the shop window, exactly as curated ───────────────────
      case "categories": {
        const contentBy = new Map(categoryContents.map((row) => [row.category_id, row]));
        const active = new Map(categories.filter((category) => category.active).map((c) => [c.id, c]));
        // Explicit curation wins: the admin's chosen ids, in their order.
        // Archived or removed ids drop out silently — Phase 44's rule that an
        // archived category produces no shop-window view of itself holds even
        // inside a stale configuration.
        const ids =
          section.category_ids && section.category_ids.length > 0
            ? section.category_ids
            : [...contentBy.entries()]
                .filter(([, content]) => content.featured)
                .sort((a, b) => a[1].sort_order - b[1].sort_order)
                .map(([id]) => id);
        const list = (ids.length > 0 ? ids : [...active.keys()])
          .map((id) => ({ category: active.get(id), content: contentBy.get(id) ?? null }))
          .filter((row): row is { category: NonNullable<typeof row.category>; content: typeof row.content } =>
            Boolean(row.category),
          )
          .slice(0, ids.length > 0 ? ids.length : sectionLimit(section));
        if (list.length === 0) return null;
        const layout = section.layout ?? "editorial";
        const seeAll = <StoreLink href="#/store/products">{t("store.section.seeAll")}</StoreLink>;
        const tile = (row: (typeof list)[number]) => {
          const label = pick(
            row.content?.title_ar ?? row.category.name_ar,
            row.content?.title_en ?? row.category.name_en,
          );
          const description = pick(row.content?.description_ar ?? "", row.content?.description_en ?? "").trim();
          const cover =
            row.content?.homepage_image_url ??
            row.content?.image_url ??
            sectionImage(settings, "categories");
          return (
            <Link
              key={row.category.id}
              to={`/store/products?category=${encodeURIComponent(row.category.id)}`}
              className="group relative block overflow-hidden bg-[var(--store-surface-alt)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--store-text)]"
              style={{ borderRadius: "var(--store-radius)" }}
            >
              <div className="aspect-[3/4] w-full">
                <StoreImage
                  src={cover ?? null}
                  alt={label}
                  ratio=""
                  className="absolute inset-0 h-full w-full transition duration-700 group-hover:scale-[1.04]"
                />
              </div>
              <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-black/10 to-transparent" aria-hidden />
              <div className="absolute inset-x-0 bottom-0 p-4 text-start">
                <p
                  className="text-sm font-black uppercase tracking-[0.12em] text-white"
                  style={{ fontFamily: "var(--store-font-display)" }}
                >
                  {label}
                </p>
                {description ? (
                  <p className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-white/80">{description}</p>
                ) : null}
                <span className="mt-2 inline-block text-[10px] font-bold uppercase tracking-[0.2em] text-white/90 underline-offset-4 group-hover:underline">
                  {t("store.section.seeAll")}
                </span>
              </div>
            </Link>
          );
        };

        if (layout === "carousel") {
          return (
            <SectionShell
              key="categories"
              id="categories"
              title={heading("categories", "store.section.categories")}
              image={null}
              action={seeAll}
            >
              <div className="-mx-4 flex snap-x snap-mandatory gap-3 overflow-x-auto px-4 pb-2 sm:mx-0 sm:px-0" style={{ scrollbarWidth: "thin" }}>
                {list.map((row) => (
                  <div key={row.category.id} className="w-40 shrink-0 snap-start sm:w-48">
                    {tile(row)}
                  </div>
                ))}
              </div>
            </SectionShell>
          );
        }

        if (layout === "editorial") {
          const [first, ...rest] = list;
          if (!first) return null;
          return (
            <SectionShell
              key="categories"
              id="categories"
              title={heading("categories", "store.section.categories")}
              image={null}
              action={seeAll}
            >
              <div className="grid gap-3 md:grid-cols-2">
                <div>{tile(first)}</div>
                <div className="grid grid-cols-2 gap-3">
                  {rest.slice(0, 4).map((row) => tile(row))}
                </div>
              </div>
            </SectionShell>
          );
        }

        return (
          <SectionShell
            key="categories"
            id="categories"
            title={heading("categories", "store.section.categories")}
            image={null}
            action={seeAll}
          >
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
              {list.map((row) => tile(row))}
            </div>
          </SectionShell>
        );
      }

      // ── the product rails ─────────────────────────────────────────────────
      case "featured":
      case "bestSellers":
      case "newArrivals":
      case "collection":
      case "sale": {
        const entries =
          key === "featured"
            ? rails.featured
            : key === "bestSellers"
              ? rails.bestSellers
              : key === "newArrivals"
                ? rails.newArrivals
                : key === "collection"
                  ? rails.collection
                  : rails.onSale;
        if (entries.length === 0) return null;
        const fallback =
          key === "featured"
            ? "store.section.featured"
            : key === "bestSellers"
              ? "store.section.bestSellers"
              : key === "newArrivals"
                ? "store.section.newArrivals"
                : key === "collection"
                  ? "store.section.collection"
                  : "store.section.onSale";
        const cta = sectionCta(section);
        return (
          <SectionShell
            key={key}
            id={key}
            title={heading(key, fallback)}
            image={image}
            action={
              cta ? (
                cta.to.startsWith("#") ? (
                  <StoreLink href={cta.to}>{cta.label}</StoreLink>
                ) : (
                  <a
                    href={cta.to}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs font-bold text-[var(--store-primary)] underline-offset-4 hover:underline"
                  >
                    {cta.label}
                  </a>
                )
              ) : (
                <StoreLink href="#/store/products">{t("store.section.seeAll")}</StoreLink>
              )
            }
          >
            <ProductGrid>
              {entries.map((entry, index) => (
                <ProductCard key={entry.product.id} entry={entry} priority={index < 4 && key === "featured"} />
              ))}
            </ProductGrid>
          </SectionShell>
        );
      }

      // ── the legacy promo banners (still available) ────────────────────────
      case "promoBanners": {
        if (banners.length === 0) return null;
        return (
          <SectionShell key="promoBanners" id="promotions" title={heading("promoBanners", "store.section.promoBanners")} image={image}>
            <div className="grid gap-4 md:grid-cols-2">
              {banners.map((banner) => (
                <a
                  key={banner.id}
                  // Same policy as the hero CTA: an in-app "#/…" route, a safe
                  // absolute http(s) URL, or the default products route — never
                  // a raw value, never a bare "#".
                  href={
                    internalHref(banner.href)?.slice(1) ??
                    externalHref(banner.href) ??
                    "#/store/products"
                  }
                  className="group relative flex min-h-40 items-end overflow-hidden bg-[var(--store-secondary)] p-5"
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

      // ── Phase 45 editorial campaign blocks ────────────────────────────────
      case "campaigns": {
        const blocks = activeEditorialCampaigns(settings).filter((c) => c.placement === "homepage");
        if (blocks.length === 0) return null;
        return (
          <SectionShell key="campaigns" id="campaigns" title={heading("campaigns", "store.section.campaigns")} image={null}>
            <div className="space-y-6">
              {blocks.map((campaign) => {
                const title = pick(campaign.title_ar, campaign.title_en).trim();
                const subtitle = pick(campaign.subtitle_ar, campaign.subtitle_en).trim();
                const ctaLabel = pick(campaign.cta_ar, campaign.cta_en).trim();
                const href = configuredHref(campaign.cta_href);
                const body = (
                  <>
                    <div className="relative hidden md:block md:w-1/2">
                      {campaign.desktop_image_url ? (
                        <StoreImage
                          src={campaign.desktop_image_url}
                          alt=""
                          ratio=""
                          className="absolute inset-0 h-full w-full"
                        />
                      ) : null}
                    </div>
                    {campaign.mobile_image_url ?? campaign.desktop_image_url ? (
                      <div className="relative md:hidden">
                        <StoreImage
                          src={campaign.mobile_image_url ?? campaign.desktop_image_url}
                          alt=""
                          ratio="aspect-[16/9]"
                          className="w-full"
                        />
                      </div>
                    ) : null}
                    <div className="flex flex-1 flex-col items-start justify-center gap-3 p-6 md:p-10">
                      <h3
                        className="text-xl font-black leading-tight text-[var(--store-text)] md:text-3xl"
                        style={{ fontFamily: "var(--store-font-display)" }}
                      >
                        {title}
                      </h3>
                      {subtitle ? (
                        <p className="max-w-md text-sm leading-relaxed text-[var(--store-muted)]">{subtitle}</p>
                      ) : null}
                      {ctaLabel && href ? (
                        <span className="mt-2 border-b border-[var(--store-text)] pb-0.5 text-[11px] font-black uppercase tracking-[0.2em] text-[var(--store-text)]">
                          {ctaLabel}
                        </span>
                      ) : null}
                    </div>
                  </>
                );
                const shell = "flex flex-col overflow-hidden bg-[var(--store-surface-alt)] md:flex-row";
                return href && href.startsWith("#") ? (
                  <Link
                    key={campaign.id}
                    to={href.slice(1)}
                    className={cn(shell, "transition hover:opacity-95")}
                    style={{ borderRadius: "var(--store-radius)" }}
                  >
                    {body}
                  </Link>
                ) : href ? (
                  <a
                    key={campaign.id}
                    href={href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={shell}
                    style={{ borderRadius: "var(--store-radius)" }}
                  >
                    {body}
                  </a>
                ) : (
                  <div key={campaign.id} className={shell} style={{ borderRadius: "var(--store-radius)" }}>
                    {body}
                  </div>
                );
              })}
            </div>
          </SectionShell>
        );
      }

      // ── image + text editorial sections ───────────────────────────────────
      case "editorial":
      case "lookbook":
      case "textImage": {
        const title = heading(key, `store.section.${key}`);
        const body = pick(section.body_ar ?? "", section.body_en ?? "").trim();
        const cta = sectionCta(section);
        const desktop = section.image_url ?? null;
        const mobile = section.mobile_image_url ?? null;
        if (!title && !body && !desktop && !mobile) return null;
        return (
          <section key={key} id={key} className="mx-auto w-full max-w-[var(--store-max-width)] px-4 py-[calc(var(--store-space-section)/2)] sm:px-6">
            {title && key !== "textImage" ? (
              <h2
                className="mb-6 text-center text-2xl font-black tracking-tight text-[var(--store-text)] md:text-3xl"
                style={{ fontFamily: "var(--store-font-display)" }}
              >
                {title}
              </h2>
            ) : null}
            <div className={cn("grid items-center gap-6 md:gap-10", key === "textImage" ? "md:grid-cols-2" : "md:grid-cols-2")}>
              <div className={cn("grid gap-3", key === "lookbook" ? "grid-cols-2" : "grid-cols-1")}>
                {desktop ? (
                  <StoreImage
                    src={desktop}
                    alt={title || body.slice(0, 40)}
                    ratio={key === "lookbook" ? "aspect-[3/4]" : "aspect-[4/3]"}
                    className="w-full"
                    sizes="(max-width: 768px) 100vw, 50vw"
                  />
                ) : null}
                {key === "lookbook" && mobile ? (
                  <StoreImage src={mobile} alt="" ratio="aspect-[3/4]" className="w-full" />
                ) : null}
              </div>
              <div className="text-center md:text-start">
                {key === "textImage" && title ? (
                  <h2
                    className="text-2xl font-black tracking-tight text-[var(--store-text)] md:text-3xl"
                    style={{ fontFamily: "var(--store-font-display)" }}
                  >
                    {title}
                  </h2>
                ) : null}
                {body ? (
                  <p className={cn("text-sm leading-loose text-[var(--store-muted)] md:text-[15px]", key === "textImage" && "mt-4")}>
                    {body}
                  </p>
                ) : null}
                {cta ? (
                  cta.to.startsWith("#") ? (
                    <Link
                      to={cta.to.slice(1)}
                      className="mt-6 inline-block border-b border-[var(--store-text)] pb-0.5 text-[11px] font-black uppercase tracking-[0.2em] text-[var(--store-text)]"
                    >
                      {cta.label}
                    </Link>
                  ) : (
                    <a
                      href={cta.to}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="mt-6 inline-block border-b border-[var(--store-text)] pb-0.5 text-[11px] font-black uppercase tracking-[0.2em] text-[var(--store-text)]"
                    >
                      {cta.label}
                    </a>
                  )
                ) : null}
              </div>
            </div>
          </section>
        );
      }

      // ── about preview ─────────────────────────────────────────────────────
      case "aboutPreview": {
        const about = settings.about;
        const title = heading("aboutPreview", "store.section.aboutPreview");
        const body = pick(about.body_ar, about.body_en).trim();
        const ctaLabel = pick(about.cta_ar, about.cta_en).trim();
        if (!title && !body && !about.image_url) return null;
        const href = internalHref(about.cta_href)?.slice(1) ?? externalHref(about.cta_href) ?? "/store/about";
        return (
          <section key="aboutPreview" id="about" className="mx-auto w-full max-w-[var(--store-max-width)] px-4 py-[calc(var(--store-space-section)/2)] sm:px-6">
            <div className="grid items-center gap-6 md:grid-cols-2 md:gap-10">
              <div className="order-2 text-center md:order-1 md:text-start">
                <h2
                  className="text-2xl font-black tracking-tight text-[var(--store-text)] md:text-3xl"
                  style={{ fontFamily: "var(--store-font-display)" }}
                >
                  {pick(about.title_ar, about.title_en).trim() || title}
                </h2>
                {body ? (
                  <p className="mt-4 text-sm leading-loose text-[var(--store-muted)] md:text-[15px]">{body}</p>
                ) : null}
                <Link
                  to={href.startsWith("#") ? href.slice(1) : href}
                  className="mt-6 inline-block border-b border-[var(--store-text)] pb-0.5 text-[11px] font-black uppercase tracking-[0.2em] text-[var(--store-text)]"
                >
                  {ctaLabel || t("store.about.shopCta")}
                </Link>
              </div>
              <div className="order-1 md:order-2">
                {about.image_url ? (
                  <StoreImage
                    src={about.image_url}
                    alt={pick(about.title_ar, about.title_en) || title}
                    ratio="aspect-[4/3]"
                    className="w-full"
                  />
                ) : null}
              </div>
            </div>
          </section>
        );
      }

      // ── trust strip ───────────────────────────────────────────────────────
      case "trustStrip": {
        const items = activeTrustItems(settings).slice(0, 4);
        if (items.length === 0) return null;
        return (
          <section key="trustStrip" aria-label={t("store.section.trustStrip")} className="border-y border-[var(--store-hairline)] bg-[var(--store-surface)]">
            <div className="mx-auto grid w-full max-w-[var(--store-max-width)] grid-cols-2 gap-6 px-6 py-8 md:grid-cols-4">
              {items.map((item) => (
                <div key={item.id} className="flex items-start gap-3">
                  <span className="mt-0.5 text-[var(--store-accent)]">
                    <TrustGlyph icon={item.icon} />
                  </span>
                  <div>
                    <p className="text-xs font-bold text-[var(--store-text)]">
                      {pick(item.title_ar, item.title_en)}
                    </p>
                    {pick(item.desc_ar, item.desc_en).trim() ? (
                      <p className="mt-0.5 text-[11px] leading-relaxed text-[var(--store-muted)]">
                        {pick(item.desc_ar, item.desc_en)}
                      </p>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          </section>
        );
      }

      // ── social gallery ────────────────────────────────────────────────────
      case "socialGallery": {
        const links = resolvedSocialLinks(settings).filter((link) => {
          if (!link.enabled) return false;
          return link.platform === "whatsapp"
            ? whatsappHref(link.url) !== null
            : externalHref(link.url) !== null;
        });
        if (links.length === 0) return null;
        return (
          <SectionShell key="socialGallery" id="social" title={heading("socialGallery", "store.section.socialGallery")} image={null}>
            <div className="flex flex-wrap items-center justify-center gap-3">
              {links.map((link) => {
                const label = pick(link.label_ar, link.label_en).trim() || link.platform;
                const href =
                  link.platform === "whatsapp"
                    ? whatsappHref(link.url)
                    : externalHref(link.url);
                if (!href) return null;
                return (
                  <a
                    key={link.platform}
                    href={href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="border border-[var(--store-hairline)] px-5 py-2.5 text-[11px] font-black uppercase tracking-[0.2em] text-[var(--store-text)] transition hover:border-[var(--store-text)] hover:bg-[var(--store-primary-soft)]"
                    style={{ borderRadius: "var(--store-radius-button)" }}
                  >
                    {label}
                  </a>
                );
              })}
            </div>
          </SectionShell>
        );
      }

      // ── newsletter band ───────────────────────────────────────────────────
      case "newsletter": {
        const body = pick(section.body_ar ?? "", section.body_en ?? "").trim();
        return (
          <section key="newsletter" className="mx-auto w-full max-w-[var(--store-max-width)] px-4 py-[calc(var(--store-space-section)/2)] sm:px-6">
            <div
              className="flex flex-col items-center gap-4 bg-[var(--store-surface)] px-6 py-12 text-center"
              style={{ borderRadius: "var(--store-radius)" }}
            >
              <h2
                className="text-xl font-black tracking-tight text-[var(--store-text)] md:text-2xl"
                style={{ fontFamily: "var(--store-font-display)" }}
              >
                {heading("newsletter", "store.section.newsletter")}
              </h2>
              {body ? <p className="max-w-md text-sm text-[var(--store-muted)]">{body}</p> : null}
              <form
                className="flex w-full max-w-sm items-center gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  // No mailing-list backend exists; the honest subscribe is a
                  // mail draft to the shop's own address.
                  const input = event.currentTarget.elements.namedItem("email") as HTMLInputElement | null;
                  const address = input?.value.trim() ?? "";
                  if (settings.contact.email && address) {
                    window.location.href = `mailto:${settings.contact.email}?subject=${encodeURIComponent(
                      "ALYQ newsletter",
                    )}&body=${encodeURIComponent(address)}`;
                  }
                }}
              >
                <label className="sr-only" htmlFor="home-newsletter-email">
                  {t("store.footer.emailLabel")}
                </label>
                <input
                  id="home-newsletter-email"
                  name="email"
                  type="email"
                  required
                  placeholder={t("store.footer.emailPlaceholder")}
                  className="min-w-0 flex-1 border-0 border-b border-[var(--store-hairline)] bg-transparent px-1 py-2 text-sm text-[var(--store-text)] outline-none placeholder:text-[var(--store-muted)] focus:border-[var(--store-text)]"
                />
                <button
                  type="submit"
                  className="shrink-0 px-5 py-2.5 text-[11px] font-black uppercase tracking-[0.2em] text-[var(--store-on-primary)] transition hover:opacity-90"
                  style={{ backgroundColor: "var(--store-primary)", borderRadius: "var(--store-radius-button)" }}
                >
                  {t("store.footer.subscribe")}
                </button>
              </form>
            </div>
          </section>
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
                  className="border border-[var(--store-hairline)] bg-[var(--store-surface)] px-4 py-2 text-xs font-bold text-[var(--store-text)] transition hover:border-[var(--store-text)]"
                  style={{ borderRadius: "9999px" }}
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
                  className="flex h-full flex-col gap-2 bg-[var(--store-surface)] p-5"
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
            <div className="mx-auto max-w-3xl divide-y divide-[var(--store-hairline)] border border-[var(--store-hairline)] bg-[var(--store-surface)]" style={{ borderRadius: "var(--store-radius)" }}>
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
            image={image}
            action={<StoreLink href="#/store/contact">{t("store.contact.pageLink")}</StoreLink>}
          >
            <div
              className="grid gap-4 border border-[var(--store-hairline)] bg-[var(--store-surface)] p-5 sm:grid-cols-3"
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
      {campaigns.some((campaign) => campaign.active) ? (
        <p className="pb-8 text-center text-xs font-medium text-[var(--store-muted)]">
          {t("store.section.campaignNote")}
        </p>
      ) : null}
    </>
  );
}
