/**
 * Website settings — the defaults and the merge rule.
 *
 * The stored document may be `{}` (a fresh install), may predate a knob that was
 * added later, or may have been edited by hand. `resolveSettings` therefore
 * deep-merges whatever is stored over the defaults below, so:
 *
 *   - a missing field renders the shop's default rather than `undefined`,
 *   - adding a setting never needs a data migration,
 *   - the storefront can always trust the shape it receives.
 *
 * The defaults are the design the storefront shipped with: the same indigo the
 * POS uses, EGP, and every homepage section visible in a sensible order.
 */
import type {
  HeroSlide,
  HomepageSectionConfig,
  HomepageSectionKey,
  WebsiteSettings,
} from "../types";
import { HOMEPAGE_SECTIONS } from "../types";

/** The shop's name before the admin sets one. Both languages, like everything. */
const DEFAULT_STORE_NAME_AR = "أَلِــيْـــق";
const DEFAULT_STORE_NAME_EN = "ALYQ";

export const DEFAULT_HERO_SLIDES: HeroSlide[] = [
  {
    id: "hero-1",
    image_url: null,
    title_ar: "أَلِــيْـــق",
    title_en: "ALYQ",
    subtitle_ar: "إكسسوارات أَلِــيْـــق",
    subtitle_en: "ALYQ Accessories Store",
    cta_label_ar: "تسوق الآن",
    cta_label_en: "Shop now",
    cta_href: "#/store/products",
    align: "start",
  },
  {
    id: "hero-2",
    image_url: null,
    title_ar: "عروض الأسبوع",
    title_en: "This week's offers",
    subtitle_ar: "خصومات على المنتجات المميزة لفترة محدودة",
    subtitle_en: "Limited-time discounts on featured products",
    cta_label_ar: "شاهد العروض",
    cta_label_en: "See the offers",
    cta_href: "#/store/products?sort=newest",
    align: "center",
  },
];

/** Every section, visible, in the order the homepage renders them. */
export function defaultSections(): HomepageSectionConfig[] {
  return HOMEPAGE_SECTIONS.map((key: HomepageSectionKey, index) => ({
    key,
    visible: true,
    order: index,
    title_ar: DEFAULT_SECTION_TITLES[key].ar,
    title_en: DEFAULT_SECTION_TITLES[key].en,
    limit: 8,
  }));
}

const DEFAULT_SECTION_TITLES: Record<HomepageSectionKey, { ar: string; en: string }> = {
  hero: { ar: "", en: "" },
  categories: { ar: "تسوق حسب الفئة", en: "Shop by category" },
  featured: { ar: "منتجات مميزة", en: "Featured products" },
  bestSellers: { ar: "الأكثر مبيعًا", en: "Best sellers" },
  newArrivals: { ar: "وصل حديثًا", en: "New arrivals" },
  promoBanners: { ar: "عروض حالية", en: "Current offers" },
  brands: { ar: "العلامات التجارية", en: "Brands" },
  reviews: { ar: "آراء عملائنا", en: "What our customers say" },
  faq: { ar: "أسئلة شائعة", en: "Frequently asked questions" },
  contact: { ar: "تواصل معنا", en: "Get in touch" },
};

/** The settings a brand-new shop gets. */
export const DEFAULT_WEBSITE_SETTINGS: WebsiteSettings = {
  version: 1,
  currency: "EGP",
  contact: {
    store_name_ar: DEFAULT_STORE_NAME_AR,
    store_name_en: DEFAULT_STORE_NAME_EN,
    tagline_ar: "إكسسوارات أَلِــيْـــق",
    tagline_en: "ALYQ Accessories Store",
    phone: "01000000000",
    email: "hello@alyq.example",
    address_ar: "شارع السلطان حسين، الإسماعيلية، مصر",
    address_en: "Sultan Hussein St, Ismailia, Egypt",
    hours_ar: "يوميًا من ٨ صباحًا حتى ١٢ منتصف الليل",
    hours_en: "Daily, 8:00 – 24:00",
    map_url: "",
  },
  theme: {
    // An accessories-house palette: warm cream paper, soft white surfaces,
    // espresso ink, and a muted antique gold used for details rather than
    // surfaces. The previous defaults were the POS's own indigo and violet,
    // chosen so the shop and the till looked like one product — which is
    // precisely what makes a shop read as a back office instead of a brand.
    // These tokens are namespaced `--store-*` and removed when the storefront
    // unmounts, so the till does not change by one pixel either way.
    primary_color: "#1c1917", // espresso: dark buttons, cream type on top
    secondary_color: "#44403c", // warm stone, for the announcement bar
    accent_color: "#b08d57", // antique gold: badges, rules, small details
    background_color: "#faf7f2", // warm cream paper
    surface_color: "#fffdfb", // soft white cards
    text_color: "#1c1917",
    muted_text_color: "#78716c",
    font_stack: "system",
    button_style: "rounded",
    header_style: "solid",
    // Tight corners. A 16px radius reads as an app; a fashion house keeps its
    // edges close to square and lets whitespace do the work.
    corner_radius: 4,
    dark_mode: false,
  },
  images: {
    logo_url: null,
    favicon_url: null,
    hero_slides: DEFAULT_HERO_SLIDES,
    background_url: null,
    section_images: {},
    promo_banners: [
      {
        id: "promo-1",
        image_url: null,
        title_ar: "اشترِ ٢ واحصل على خصم",
        title_en: "Buy two, save more",
        caption_ar: "على كل القطع المختارة",
        caption_en: "On every selected piece",
        href: "#/store/products",
        badge_ar: "عرض",
        badge_en: "Offer",
      },
    ],
    about_image_url: null,
  },
  sections: defaultSections(),
  social: {
    facebook: "",
    instagram: "",
    tiktok: "",
    whatsapp: "",
    instapay_link: "",
    instapay_account: "",
    instapay_holder: "",
    instapay_qr_url: null,
  },
  delivery: {
    enabled: true,
    fee: 30,
    free_delivery_threshold: 500,
    // No restriction and no minimum out of the box: the shop names its areas
    // (and, if it wants one, a minimum) in the website settings.
    areas: [],
    minimum_order: null,
    note_ar: "التوصيل خلال ٢٤ ساعة داخل الإسماعيلية",
    note_en: "Delivery within 24 hours inside Ismailia",
    pickup_enabled: true,
    pickup_address_ar: "فرع الإسماعيلية — شارع السلطان حسين",
    pickup_address_en: "Ismailia branch — Sultan Hussein St",
    cod_enabled: true,
    instapay_enabled: true,
    // Empty = the storefront keeps its built-in step list; filled = the shop's
    // own words replace it at checkout and on the confirmation page.
    instapay_instructions_ar: "",
    instapay_instructions_en: "",
    // The shop shipped asking every InstaPay customer for the transfer proof;
    // the default must not silently change that behaviour.
    instapay_proof_required: true,
  },
  seo: {
    meta_title: "ALYQ Accessories Store | أَلِــيْـــق",
    meta_description:
      "ALYQ Accessories Store — إكسسوارات أَلِــيْـــق. Order online with delivery across Ismailia, or collect from the branch. Pay with InstaPay or cash on delivery.",
    keywords: "alyq, أَلِــيْـــق, accessories, إكسسوارات أَلِــيْـــق, ismailia, online order, instapay, delivery",
    og_image_url: null,
  },
  announcement: {
    enabled: false,
    text_ar: "",
    text_en: "",
    href: "",
  },
};

type Json = Record<string, unknown>;

const isPlainObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Deep-merge `stored` over `defaults`.
 *
 * Arrays are replaced, never merged: a section list or a hero carousel the admin
 * edited is theirs, and interleaving it with the defaults would resurrect slides
 * they deleted. Objects merge key by key so a partially stored group (say a
 * theme saved before `corner_radius` existed) still gets the new default.
 */
export function mergeSettings<T>(defaults: T, stored: unknown): T {
  if (!isPlainObject(stored)) return defaults;
  if (!isPlainObject(defaults)) return (stored as unknown as T);

  const out: Json = { ...stored };
  for (const [key, defaultValue] of Object.entries(defaults as unknown as Json)) {
    const storedValue = (stored as Json)[key];
    if (storedValue === undefined || storedValue === null) {
      out[key] = defaultValue;
    } else if (isPlainObject(defaultValue) && isPlainObject(storedValue)) {
      out[key] = mergeSettings(defaultValue, storedValue);
    } else {
      out[key] = storedValue;
    }
  }
  return out as unknown as T;
}

/**
 * The settings the storefront and the admin panel both work from: whatever is
 * stored, filled in with defaults, with the section list repaired.
 *
 * Section repair matters because it is the one list an admin reorders: a key
 * added in a later release must appear (visible, at the end) rather than be
 * silently missing, and a stored key that no longer exists must be dropped.
 */
export function resolveSettings(stored: unknown): WebsiteSettings {
  const merged = mergeSettings(DEFAULT_WEBSITE_SETTINGS, stored);
  return { ...merged, sections: repairSections(merged.sections) };
}

/** Fill in missing sections, drop unknown ones, and make the order total. */
export function repairSections(
  sections: HomepageSectionConfig[] | undefined,
): HomepageSectionConfig[] {
  const known = new Set<string>(HOMEPAGE_SECTIONS);
  const byKey = new Map<HomepageSectionKey, HomepageSectionConfig>();

  for (const section of Array.isArray(sections) ? sections : []) {
    if (!section || !known.has(section.key)) continue;
    const fallback = DEFAULT_WEBSITE_SETTINGS.sections.find((s) => s.key === section.key);
    byKey.set(section.key, {
      key: section.key,
      visible: typeof section.visible === "boolean" ? section.visible : true,
      order: Number.isFinite(section.order) ? section.order : (fallback?.order ?? 0),
      title_ar: typeof section.title_ar === "string" ? section.title_ar : (fallback?.title_ar ?? ""),
      title_en: typeof section.title_en === "string" ? section.title_en : (fallback?.title_en ?? ""),
      limit: Number.isFinite(section.limit) && section.limit > 0 ? section.limit : 8,
    });
  }

  // Anything the admin has never seen gets appended, visible, after what they
  // arranged — a new section should show up, not hide.
  return HOMEPAGE_SECTIONS.map((key, index) => {
    const existing = byKey.get(key);
    if (existing) return existing;
    const fallback = DEFAULT_WEBSITE_SETTINGS.sections.find((s) => s.key === key);
    return {
      key,
      visible: true,
      order: 100 + index,
      title_ar: fallback?.title_ar ?? "",
      title_en: fallback?.title_en ?? "",
      limit: fallback?.limit ?? 8,
    };
  }).sort((a, b) => a.order - b.order || HOMEPAGE_SECTIONS.indexOf(a.key) - HOMEPAGE_SECTIONS.indexOf(b.key));
}

/** A hex colour the browser can use, or the fallback when it cannot. */
export function safeColor(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(trimmed) ? trimmed : fallback;
}

/**
 * The one safe-href policy for every link a shopper can click whose value comes
 * out of the settings document: social profiles, the map, InstaPay, the
 * announcement bar, hero CTAs and promo banners.
 *
 * Same rule as `storefrontLink.ts` applies to `VITE_STOREFRONT_URL`: a URL that
 * comes from settings is configuration an admin typed, and an `href` is an
 * injection point — `javascript:`, `data:` and `vbscript:` all execute or render
 * in that position, and the storefront is public. Only absolute http(s) URLs
 * pass, normalized through `new URL` (which also collapses case and strips the
 * tab/newline characters browsers ignore inside URLs); everything else — blank,
 * relative, custom schemes, control-character obfuscation — yields `null`, and
 * callers render no link at all. An unset or unusable URL must never become a
 * broken or dangerous button, and never a bare `#`.
 */
export function externalHref(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (!value) return null;
  if (!/^https?:\/\//i.test(value)) return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

/**
 * An in-app hash route (`#/store/products`), or `null`.
 *
 * Hero CTAs, promo banners and the announcement bar historically hold routes
 * inside the shop itself. Only `#/…` qualifies: a bare `#` must never become a
 * link, and `#javascript:alert(1)` is not a route — it is the bypass this
 * check exists to refuse.
 */
export function internalHref(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  return value.startsWith("#/") ? value : null;
}

/** What an admin meant for a field that takes either kind: the app route or a safe external URL. */
export function configuredHref(raw: unknown): string | null {
  return internalHref(raw) ?? externalHref(raw);
}

/**
 * Readable text on a colour, by relative luminance. Used for button labels so an
 * admin who picks a pale primary colour does not end up with white-on-white.
 */
export function readableOn(hex: string): "#ffffff" | "#0f172a" {
  const value = hex.replace("#", "");
  const full =
    value.length === 3
      ? value
          .split("")
          .map((c) => c + c)
          .join("")
      : value.slice(0, 6);
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) || 0);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.6 ? "#0f172a" : "#ffffff";
}
