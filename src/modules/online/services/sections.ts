/**
 * Homepage sections — what the admin's order and visibility choices mean.
 *
 * The homepage is a list of sections, each with `visible`, `order`, a title and a
 * product limit. Three rules keep that list predictable:
 *
 *   - `order` is dense and ascending after every edit. Dragging "Brands" above
 *     "Featured" renumbers the whole list rather than swapping two numbers, so
 *     two sections can never end up with the same order and be sorted by chance.
 *   - a section that is missing from a stored document (because it was added in a
 *     later release) comes back at its default position, visible. `repairSections`
 *     in settingsDefaults.ts does the filling; this file only reads the result.
 *   - titles fall back to the dictionary. An admin who clears a title gets the
 *     built-in wording, not an empty heading above a row of products.
 */
import type {
  HeroSlide,
  HomepageSectionConfig,
  HomepageSectionKey,
  PromoBanner,
  WebsiteSettings,
} from "../types";
import { resolveSettings } from "./settingsDefaults";

/** Default product count per section, when the admin has not chosen one. */
export const DEFAULT_SECTION_LIMITS: Record<HomepageSectionKey, number> = {
  hero: 0,
  categories: 8,
  featured: 8,
  bestSellers: 8,
  newArrivals: 8,
  promoBanners: 0,
  // Phase 45 sections.
  collection: 8,
  sale: 8,
  campaigns: 4,
  editorial: 0,
  lookbook: 0,
  aboutPreview: 0,
  trustStrip: 4,
  socialGallery: 6,
  textImage: 0,
  newsletter: 0,
  brands: 12,
  reviews: 6,
  faq: 8,
  contact: 0,
};

/** Sections that show products, and therefore honour `limit`. */
export const PRODUCT_SECTIONS: readonly HomepageSectionKey[] = [
  "featured",
  "bestSellers",
  "newArrivals",
  "collection",
  "sale",
];

/** Visible sections, in the order the admin put them in. */
export function visibleSections(settings: WebsiteSettings | null): HomepageSectionConfig[] {
  const resolved = resolveSettings(settings);
  return [...resolved.sections]
    .filter((section) => section.visible)
    .sort((a, b) => a.order - b.order || defaultOrderOf(a.key) - defaultOrderOf(b.key));
}

/** Every section, in display order — what the builder renders. */
export function orderedSections(settings: WebsiteSettings | null): HomepageSectionConfig[] {
  const resolved = resolveSettings(settings);
  return [...resolved.sections].sort(
    (a, b) => a.order - b.order || defaultOrderOf(a.key) - defaultOrderOf(b.key),
  );
}

/** The section with a given key, or null if the document does not have it. */
export function sectionOf(
  settings: WebsiteSettings | null,
  key: HomepageSectionKey,
): HomepageSectionConfig | null {
  return orderedSections(settings).find((section) => section.key === key) ?? null;
}

function defaultOrderOf(key: HomepageSectionKey): number {
  const defaults = resolveSettings(null).sections;
  return defaults.find((section) => section.key === key)?.order ?? 99;
}

/** The heading to render: what the admin wrote, else the dictionary key. */
export function sectionTitle(
  section: HomepageSectionConfig,
  pick: (arabic: string | null, english: string | null) => string,
): string {
  const own = pick(section.title_ar || null, section.title_en || null).trim();
  return own; // Empty means the caller falls back to `store.section.<key>`.
}

/** Dictionary key for a section's built-in title. */
export function sectionTitleKey(key: HomepageSectionKey): string {
  return `store.section.${key}`;
}

/** How many products a product section shows. */
export function sectionLimit(section: HomepageSectionConfig): number {
  if (!PRODUCT_SECTIONS.includes(section.key)) return DEFAULT_SECTION_LIMITS[section.key];
  const limit = Math.floor(section.limit);
  if (!Number.isFinite(limit) || limit <= 0) return DEFAULT_SECTION_LIMITS[section.key];
  return Math.min(limit, 24); // A homepage is not a catalogue page.
}

/** The image the admin attached to a section, if any. */
export function sectionImage(
  settings: WebsiteSettings | null,
  key: HomepageSectionKey,
): string | null {
  return resolveSettings(settings).images.section_images[key] ?? null;
}

// ── editing the list ────────────────────────────────────────────────────────

/** Renumber `order` densely, keeping the given sequence. */
function renumber(sections: readonly HomepageSectionConfig[]): HomepageSectionConfig[] {
  return sections.map((section, index) => ({ ...section, order: index }));
}

/**
 * Move a section to a new position — what a drag-and-drop builder calls.
 *
 * Both indices are positions in the *display* order, not raw `order` values, so
 * the caller never has to reason about gaps.
 */
export function moveSection(
  settings: WebsiteSettings,
  fromIndex: number,
  toIndex: number,
): HomepageSectionConfig[] {
  const sections = orderedSections(settings);
  if (fromIndex === toIndex) return sections;
  if (fromIndex < 0 || fromIndex >= sections.length) return sections;
  const clamped = Math.max(0, Math.min(sections.length - 1, toIndex));
  const next = [...sections];
  const [moved] = next.splice(fromIndex, 1);
  next.splice(clamped, 0, moved);
  return renumber(next);
}

/** Show or hide a section without touching its position. */
export function setSectionVisible(
  settings: WebsiteSettings,
  key: HomepageSectionKey,
  visible: boolean,
): HomepageSectionConfig[] {
  return orderedSections(settings).map((section) =>
    section.key === key ? { ...section, visible } : section,
  );
}

/** Rename a section. Empty strings restore the dictionary fallback. */
export function setSectionTitle(
  settings: WebsiteSettings,
  key: HomepageSectionKey,
  title: { ar: string; en: string },
): HomepageSectionConfig[] {
  return orderedSections(settings).map((section) =>
    section.key === key
      ? { ...section, title_ar: title.ar.trim(), title_en: title.en.trim() }
      : section,
  );
}

/** Change how many products a product section shows. */
export function setSectionLimit(
  settings: WebsiteSettings,
  key: HomepageSectionKey,
  limit: number,
): HomepageSectionConfig[] {
  const safe = Math.max(1, Math.min(24, Math.floor(limit) || DEFAULT_SECTION_LIMITS[key]));
  return orderedSections(settings).map((section) =>
    section.key === key ? { ...section, limit: safe } : section,
  );
}

/** Put every section back to its default order, visibility and titles. */
export function resetSections(settings: WebsiteSettings | null): HomepageSectionConfig[] {
  void settings;
  return resolveSettings(null).sections.map((section) => ({ ...section }));
}

// ── hero + banners ──────────────────────────────────────────────────────────

export interface ResolvedSlide {
  id: string;
  imageUrl: string | null;
  title: string;
  subtitle: string;
  ctaLabel: string;
  ctaHref: string;
  align: HeroSlide["align"];
  /** Phase 45 presentation: phone image, scrim strength, copy corner, height. */
  mobileImageUrl: string | null;
  overlay: number | null;
  contentPosition: HeroSlide["content_position"];
  height: HeroSlide["height"];
}

/**
 * Hero slides with their text resolved for the current language.
 *
 * A slide with neither a title nor an image carries nothing, so it is dropped:
 * an admin who cleared a slide to hide it should not get an empty panel instead.
 */
export function resolvedSlides(
  settings: WebsiteSettings | null,
  pick: (arabic: string | null, english: string | null) => string,
): ResolvedSlide[] {
  return resolveSettings(settings)
    .images.hero_slides.map((slide) => ({
      id: slide.id,
      imageUrl: slide.image_url,
      title: pick(slide.title_ar, slide.title_en).trim(),
      subtitle: pick(slide.subtitle_ar, slide.subtitle_en).trim(),
      ctaLabel: pick(slide.cta_label_ar, slide.cta_label_en).trim(),
      ctaHref: slide.cta_href.trim(),
      align: slide.align,
      mobileImageUrl: slide.mobile_image_url ?? null,
      overlay: typeof slide.overlay === "number" ? Math.min(100, Math.max(0, Math.round(slide.overlay))) : null,
      contentPosition: slide.content_position ?? "center",
      height: slide.height ?? "editorial",
    }))
    .filter((slide) => slide.title.length > 0 || slide.imageUrl);
}

export interface ResolvedBanner {
  id: string;
  imageUrl: string | null;
  title: string;
  caption: string;
  href: string;
  badge: string;
}

export function resolvedBanners(
  settings: WebsiteSettings | null,
  pick: (arabic: string | null, english: string | null) => string,
): ResolvedBanner[] {
  return resolveSettings(settings)
    .images.promo_banners.map((banner: PromoBanner) => ({
      id: banner.id,
      imageUrl: banner.image_url,
      title: pick(banner.title_ar, banner.title_en).trim(),
      caption: pick(banner.caption_ar, banner.caption_en).trim(),
      href: banner.href.trim(),
      badge: pick(banner.badge_ar, banner.badge_en).trim(),
    }))
    .filter((banner) => banner.title.length > 0 || banner.imageUrl);
}
