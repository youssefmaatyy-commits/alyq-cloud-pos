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
import {
  BUTTON_STYLES as BUTTON_KEY_STYLES,
  HEADER_STYLES as HEADER_KEY_STYLES,
  STORE_FONT_STACKS as STORE_FONT_KEYS,
  PRODUCT_CARD_ASPECTS as PRODUCT_CARD_ASPECT_KEYS,
  PRODUCT_CARD_FITS as PRODUCT_CARD_FIT_KEYS,
  PRODUCT_CARD_GAPS as PRODUCT_CARD_GAP_KEYS,
  PRODUCT_CARD_ALIGNS as PRODUCT_CARD_ALIGN_KEYS,
  TRUST_ICONS as TRUST_ICON_KEYS,
} from "../types";
import type {
  AnnouncementMessage,
  EditorialCampaign,
  HeroSlide,
  HomepageSectionConfig,
  HomepageSectionKey,
  SocialLinkConfig,
  TrustItem,
  WebsiteSettings,
} from "../types";
import { HOMEPAGE_SECTIONS } from "../types";

/** The shop's name before the admin sets one. Both languages, like everything. */
const DEFAULT_STORE_NAME_AR = "أَلِــيْـــق";
const DEFAULT_STORE_NAME_EN = "ALYQ";
export { DEFAULT_STORE_NAME_AR, DEFAULT_STORE_NAME_EN };

export const DEFAULT_HERO_SLIDES: HeroSlide[] = [
  {
    id: "hero-1",
    // The house editorial photograph, bundled with the app. Image-led is the
    // default; an admin replaces it (or clears it — a cleared slide falls back
    // to the quiet gradient of the shop's own colours) in the builder.
    image_url: "/brand/hero-editorial.jpg",
    title_ar: "أَلِــيْـــق",
    title_en: "ALYQ",
    subtitle_ar: "إكسسوارات أَلِــيْـــق",
    subtitle_en: "ALYQ Accessories Store",
    cta_label_ar: "تسوق الآن",
    cta_label_en: "Shop now",
    cta_href: "#/store/products",
    secondary_cta_label_ar: "قصتنا",
    secondary_cta_label_en: "Our story",
    secondary_cta_href: "#/store/about",
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
/**
 * Phase 49 visual pass: the editorial band opens dressed — the house's own
 * words and the bundled photograph — so a brand-new shop never shows a bare
 * heading. Every field here is a normal builder field (body, image, CTA);
 * an admin rewrites or clears any of them, and a cleared band hides itself.
 */
const DEFAULT_SECTION_EXTRAS: Partial<Record<HomepageSectionKey, Partial<HomepageSectionConfig>>> = {
  editorial: {
    body_ar: "أشياء قليلة، تُصنع ببطء. كل قطعة من أَلِــيْـــق تُنهى يدويًا بدفعات صغيرة — من ذهب يحافظ على بريقه، ولؤلؤ يُنتقى حبةً حبة.",
    body_en: "Fewer things, made slowly. Every ALYQ piece is finished by hand, in small batches — gold that keeps its shine, pearls chosen one by one.",
    image_url: "/brand/hero-editorial.jpg",
    cta_ar: "اقرأ قصتنا",
    cta_en: "Read our story",
    cta_href: "#/store/about",
  },
};

export function defaultSections(): HomepageSectionConfig[] {
  return HOMEPAGE_SECTIONS.map((key: HomepageSectionKey, index) => ({
    key,
    visible: true,
    order: index,
    title_ar: DEFAULT_SECTION_TITLES[key].ar,
    title_en: DEFAULT_SECTION_TITLES[key].en,
    limit: 8,
    ...DEFAULT_SECTION_EXTRAS[key],
  }));
}

const DEFAULT_SECTION_TITLES: Record<HomepageSectionKey, { ar: string; en: string }> = {
  hero: { ar: "", en: "" },
  categories: { ar: "تسوق حسب الفئة", en: "Shop by category" },
  featured: { ar: "منتجات مميزة", en: "Featured products" },
  bestSellers: { ar: "الأكثر مبيعًا", en: "Best sellers" },
  newArrivals: { ar: "وصل حديثًا", en: "New arrivals" },
  promoBanners: { ar: "عروض حالية", en: "Current offers" },
  collection: { ar: "التشكيلة المختارة", en: "Featured collection" },
  sale: { ar: "التخفيضات", en: "On sale" },
  campaigns: { ar: "حملات أَلِــيْـــق", en: "ALYQ campaigns" },
  editorial: { ar: "من عالم أَلِــيْـــق", en: "The world of ALYQ" },
  lookbook: { ar: "دليل الإطلالات", en: "Lookbook" },
  aboutPreview: { ar: "عن أَلِــيْـــق", en: "About ALYQ" },
  trustStrip: { ar: "لماذا أَلِــيْـــق", en: "Why ALYQ" },
  socialGallery: { ar: "تابعنا", en: "Follow along" },
  textImage: { ar: "", en: "" },
  newsletter: { ar: "انضم إلى قائمتنا", en: "Join our list" },
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
  brand: {
    display_name_ar: "",
    display_name_en: "",
    mark_url: null,
    logo_dark_url: null,
    receipt_logo_enabled: true,
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
    mode: "rotate",
    bg_color: "#1c1917",
    text_color: "#faf7f2",
    interval_ms: 5000,
    messages: [],
  },
  // ── Phase 45: the redesigned storefront ──────────────────────────────────
  header: {
    sticky: true,
    search_enabled: true,
    account_enabled: true,
    cart_enabled: true,
  },
  product_card: {
    mobile_columns: 2,
    desktop_columns: 4,
    aspect: "portrait",
    image_fit: "cover",
    gap: "normal",
    text_align: "start",
    show_price: true,
    show_badge: true,
    show_wishlist: true,
    show_quick_add: true,
    show_swatches: true,
  },
  badges: {
    show_new: true,
    show_sale: true,
    show_best_seller: true,
    show_limited: false,
  },
  trust: {
    items: [
      {
        id: "trust-delivery",
        enabled: true,
        icon: "truck",
        title_ar: "توصيل سريع",
        title_en: "Fast delivery",
        desc_ar: "خلال ٢٤ ساعة داخل الإسماعيلية",
        desc_en: "Within 24 hours across Ismailia",
        sort_order: 1,
      },
      {
        id: "trust-cod",
        enabled: true,
        icon: "shield",
        title_ar: "دفع آمن",
        title_en: "Secure payment",
        desc_ar: "الدفع عند الاستلام أو إنستاباي",
        desc_en: "Cash on delivery or InstaPay",
        sort_order: 2,
      },
      {
        id: "trust-exchange",
        enabled: true,
        icon: "exchange",
        title_ar: "استبدال سهل",
        title_en: "Easy exchange",
        desc_ar: "خلال ١٤ يومًا من الاستلام",
        desc_en: "Within 14 days of delivery",
        sort_order: 3,
      },
      {
        id: "trust-support",
        enabled: true,
        icon: "support",
        title_ar: "دعم حقيقي",
        title_en: "Real support",
        desc_ar: "فريقنا معك على واتساب",
        desc_en: "Our team is on WhatsApp",
        sort_order: 4,
      },
    ],
  },
  about: {
    title_ar: "عن أَلِــيْـــق",
    title_en: "About ALYQ",
    // Phase 49 visual pass: the preview opens dressed — the house line and the
    // bundled editorial photograph — all of it editable in the builder.
    body_ar: "بدأنا من ورشة صغيرة في الإسماعيلية بحُب للتفاصيل اليدوية. اليوم ما زلنا نصنع بدفعات صغيرة، ونغلّف كل قطعة كأنها هدية.",
    body_en: "We began in a small workshop in Ismailia, with a love for hand-finished detail. Today we still make in small batches — and wrap every piece as if it were a gift.",
    image_url: "/brand/categories/jewellery.jpg",
    cta_ar: "اقرأ المزيد",
    cta_en: "Read more",
    cta_href: "#/store/about",
  },
  footer: {
    description_ar: "",
    description_en: "",
    newsletter_enabled: false,
    newsletter_note_ar: "",
    newsletter_note_en: "",
    show_social: true,
    copyright_ar: "© أَلِــيْـــق. جميع الحقوق محفوظة.",
    copyright_en: "© ALYQ. All rights reserved.",
    policy_links: [],
  },
  checkout_copy: {
    heading_ar: "",
    heading_en: "",
    delivery_note_ar: "",
    delivery_note_en: "",
    pickup_note_ar: "",
    pickup_note_en: "",
    payment_note_ar: "",
    payment_note_en: "",
    cod_note_ar: "",
    cod_note_en: "",
    instapay_note_ar: "",
    instapay_note_en: "",
    proof_note_ar: "",
    proof_note_en: "",
    place_order_ar: "",
    place_order_en: "",
  },
  confirmation: {
    title_ar: "",
    title_en: "",
    message_ar: "",
    message_en: "",
    guidance_ar: "",
    guidance_en: "",
    support_cta_ar: "تواصل معنا",
    support_cta_en: "Contact us",
    support_href: "#/store/contact",
    whatsapp_cta: true,
  },
  campaigns: [],
  social_links: [
    { platform: "instagram", enabled: false, url: "", label_ar: "إنستغرام", label_en: "Instagram" },
    { platform: "facebook", enabled: false, url: "", label_ar: "فيسبوك", label_en: "Facebook" },
    { platform: "tiktok", enabled: false, url: "", label_ar: "تيك توك", label_en: "TikTok" },
    { platform: "whatsapp", enabled: false, url: "", label_ar: "واتساب", label_en: "WhatsApp" },
  ],
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
      // Phase 45 per-section content, carried through the repair with light
      // type discipline — an old document has none of it and loses nothing.
      ...(Array.isArray(section.category_ids)
        ? { category_ids: section.category_ids.filter((id) => typeof id === "string") }
        : {}),
      ...(Array.isArray(section.product_ids)
        ? { product_ids: section.product_ids.filter((id) => typeof id === "string") }
        : {}),
      ...(section.layout && ["tiles", "carousel", "editorial"].includes(section.layout)
        ? { layout: section.layout }
        : {}),
      ...(typeof section.body_ar === "string" ? { body_ar: section.body_ar } : {}),
      ...(typeof section.body_en === "string" ? { body_en: section.body_en } : {}),
      ...(section.image_url === null || typeof section.image_url === "string"
        ? { image_url: section.image_url }
        : {}),
      ...(section.mobile_image_url === null || typeof section.mobile_image_url === "string"
        ? { mobile_image_url: section.mobile_image_url }
        : {}),
      ...(typeof section.cta_ar === "string" ? { cta_ar: section.cta_ar } : {}),
      ...(typeof section.cta_en === "string" ? { cta_en: section.cta_en } : {}),
      ...(typeof section.cta_href === "string" ? { cta_href: section.cta_href } : {}),
      // Phase 49: a field the admin has never set (absent, not cleared) takes
      // the shipped editorial content; a cleared field ("") stays cleared.
      ...Object.fromEntries(
        Object.entries(DEFAULT_SECTION_EXTRAS[section.key] ?? {}).filter(
          ([field, value]) =>
            (section as unknown as Record<string, unknown>)[field] === undefined && value !== undefined && value !== "",
        ),
      ),
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

// ── Phase 45: resolvers over the redesigned storefront's settings ──────────

/**
 * The announcement messages to show, in order, enabled and non-empty.
 *
 * A document saved before Phase 45 has no `messages` array — its single
 * `text_ar`/`text_en`/`href` triple becomes the one message, so an old bar
 * renders exactly as it did. A document saved after has both; the legacy
 * fields are then inert history.
 */
export function resolvedAnnouncementMessages(
  settings: WebsiteSettings,
): AnnouncementMessage[] {
  const configured = (settings.announcement.messages ?? []).filter(
    (m) => m && m.enabled !== false && (m.text_ar.trim() !== "" || m.text_en.trim() !== ""),
  );
  if (configured.length > 0) return configured;
  const legacyAr = settings.announcement.text_ar.trim();
  const legacyEn = settings.announcement.text_en.trim();
  if (legacyAr === "" && legacyEn === "") return [];
  return [
    {
      id: "announcement-legacy",
      enabled: true,
      text_ar: settings.announcement.text_ar,
      text_en: settings.announcement.text_en,
      href: settings.announcement.href,
      cta_ar: "",
      cta_en: "",
    },
  ];
}

/** Rotation cadence, clamped so the bar never flickers or stalls. */
export function announcementIntervalMs(settings: WebsiteSettings): number {
  const raw = settings.announcement.interval_ms;
  return typeof raw === "number" && Number.isFinite(raw)
    ? Math.min(15_000, Math.max(2_000, raw))
    : 5_000;
}

/**
 * The social links to render, from the Phase 45 editor. A platform the admin
 * never configured falls back to the legacy `social` fields, enabled exactly
 * when they hold a value — so an existing shop keeps its links with zero
 * migration, and an admin who disables one keeps it hidden.
 */
export function resolvedSocialLinks(settings: WebsiteSettings): SocialLinkConfig[] {
  const configured = settings.social_links ?? [];
  const byPlatform = new Map(configured.map((link) => [link.platform, link]));
  const legacy: Record<string, string> = {
    instagram: settings.social.instagram,
    facebook: settings.social.facebook,
    tiktok: settings.social.tiktok,
    whatsapp: settings.social.whatsapp,
  };
  return (["instagram", "facebook", "tiktok", "whatsapp"] as const).map((platform) => {
    const own = byPlatform.get(platform);
    const url = legacy[platform] ?? "";
    // An explicitly configured URL wins; a configured-but-EMPTY entry yields to
    // the legacy contact field, so a shop that only ever filled those keeps
    // working (the old storefront rendered them whenever they were non-empty).
    if (own && own.url.trim() !== "") return own;
    if (url.trim() !== "") {
      return {
        platform,
        enabled: true,
        url,
        label_ar: own?.label_ar ?? "",
        label_en: own?.label_en ?? "",
      };
    }
    if (own) return own;
    return {
      platform,
      enabled: false,
      url: "",
      label_ar: "",
      label_en: "",
    };
  });
}

export type CampaignWindow = { starts_at: string | null; ends_at: string | null };

/** Is a scheduled block live at `now`? Open-ended on either side by `null`. */
export function campaignLiveAt(
  window: CampaignWindow,
  now: Date = new Date(),
): boolean {
  if (window.starts_at) {
    const start = new Date(window.starts_at);
    if (!Number.isNaN(start.getTime()) && now < start) return false;
  }
  if (window.ends_at) {
    const end = new Date(window.ends_at);
    if (!Number.isNaN(end.getTime()) && now > end) return false;
  }
  return true;
}

/** Enabled editorial campaigns inside their window, shop-window order. */
export function activeEditorialCampaigns(
  settings: WebsiteSettings,
  now: Date = new Date(),
): EditorialCampaign[] {
  return (settings.campaigns ?? [])
    .filter((c) => c && c.enabled !== false && campaignLiveAt(c, now))
    .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
}

/** Trust items that render, in the admin's order. */
export function activeTrustItems(settings: WebsiteSettings): TrustItem[] {
  return (settings.trust?.items ?? [])
    .filter((item) => item && item.enabled !== false)
    .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
}

// ── the client-side sanitizer, the SQL guard's twin ─────────────────────────

const clampInt = (value: unknown, min: number, max: number, fallback: number): number => {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.round(value) : fallback;
  return Math.min(max, Math.max(min, n));
};
const str = (value: unknown, max: number, fallback = ""): string => {
  if (typeof value !== "string") return fallback;
  return value.length > max ? value.slice(0, max) : value;
};
const bool = (value: unknown, fallback: boolean): boolean =>
  typeof value === "boolean" ? value : fallback;
const enumOf = <T extends readonly string[]>(
  value: unknown,
  allowed: T,
  fallback: T[number],
): T[number] => (typeof value === "string" && (allowed as readonly string[]).includes(value) ? value : fallback);
const safeUrlField = (value: unknown, max = 1000): string => {
  const raw = typeof value === "string" ? value.trim() : "";
  if (raw === "") return "";
  if (raw.length > max) return "";
  return configuredHref(raw) ?? "";
};
const safeImageField = (value: unknown): string | null => {
  const raw = typeof value === "string" ? value.trim() : "";
  if (raw === "") return null;
  // Images are media URLs from the project's own storage: absolute http(s), a
  // same-origin absolute path bundled with the app ("/brand/…" — how the
  // shipped editorial defaults travel), or null. Protocol-relative "//…" and
  // every scheme — data:/javascript: above all — are never a rendering image.
  if (raw.startsWith("/") && !raw.startsWith("//")) return raw;
  return externalHref(raw);
};
const oneOf = <T>(value: unknown, allowed: readonly T[], fallback: T): T =>
  (allowed as readonly unknown[]).includes(value as T) ? (value as T) : fallback;

/**
 * Normalize a settings draft into a document the database guard will accept
 * and the storefront can render safely: enums repaired to defaults rather
 * than trusted, hrefs dropped unless they pass the one safe-URL policy,
 * images reduced to http(s) media URLs, arrays bounded, numbers clamped.
 *
 * This runs before every save; the SQL trigger in 0045 re-checks the same
 * rules server-side, so a forged write fails there too.
 */
export function sanitizeSettings(input: unknown): WebsiteSettings {
  const base = resolveSettings(input) as unknown as Json;
  const out = base as unknown as WebsiteSettings;

  // theme
  const theme = out.theme as unknown as Json;
  for (const key of [
    "primary_color",
    "secondary_color",
    "accent_color",
    "background_color",
    "surface_color",
    "text_color",
    "muted_text_color",
  ]) {
    theme[key] = safeColor(theme[key] as string, String(DEFAULT_WEBSITE_SETTINGS.theme[key as keyof typeof DEFAULT_WEBSITE_SETTINGS.theme]));
  }
  theme.font_stack = enumOf(theme.font_stack, STORE_FONT_KEYS, "system");
  theme.button_style = enumOf(theme.button_style, BUTTON_KEY_STYLES, "rounded");
  theme.header_style = enumOf(theme.header_style, HEADER_KEY_STYLES, "solid");
  theme.corner_radius = clampInt(theme.corner_radius, 0, 32, 4);
  theme.dark_mode = bool(theme.dark_mode, false);

  // announcement
  const ann = out.announcement as unknown as Json;
  ann.mode = enumOf(ann.mode, ["static", "rotate", "scroll"] as const, "rotate");
  ann.bg_color = safeColor(ann.bg_color as string, "#1c1917");
  ann.text_color = safeColor(ann.text_color as string, "#faf7f2");
  ann.interval_ms = clampInt(ann.interval_ms, 2000, 15000, 5000);
  ann.href = safeUrlField(ann.href);
  ann.text_ar = str(ann.text_ar, 240);
  ann.text_en = str(ann.text_en, 240);
  const rawMessages = Array.isArray(ann.messages) ? (ann.messages as Json[]) : [];
  ann.messages = rawMessages.slice(0, 20).map((m, index) => ({
    id: str(m.id, 60) || `announcement-${index + 1}`,
    enabled: bool(m.enabled, true),
    text_ar: str(m.text_ar, 240),
    text_en: str(m.text_en, 240),
    href: safeUrlField(m.href),
    cta_ar: str(m.cta_ar, 40),
    cta_en: str(m.cta_en, 40),
  }));

  // hero slides
  out.images.hero_slides = (Array.isArray(out.images.hero_slides) ? out.images.hero_slides : []).slice(0, 6).map(
    (slide, index): HeroSlide => ({
      id: str(slide.id, 60) || `hero-${index + 1}`,
      image_url: safeImageField(slide.image_url),
      mobile_image_url: safeImageField(slide.mobile_image_url),
      title_ar: str(slide.title_ar, 120),
      title_en: str(slide.title_en, 120),
      subtitle_ar: str(slide.subtitle_ar, 240),
      subtitle_en: str(slide.subtitle_en, 240),
      cta_label_ar: str(slide.cta_label_ar, 40),
      cta_label_en: str(slide.cta_label_en, 40),
      cta_href: safeUrlField(slide.cta_href),
      secondary_cta_label_ar: str(slide.secondary_cta_label_ar ?? "", 40),
      secondary_cta_label_en: str(slide.secondary_cta_label_en ?? "", 40),
      secondary_cta_href: safeUrlField(slide.secondary_cta_href ?? ""),
      align: enumOf(slide.align, ["start", "center", "end"] as const, "start"),
      overlay: clampInt(slide.overlay ?? 35, 0, 100, 35),
      content_position: enumOf(slide.content_position, ["start", "center", "end"] as const, "center"),
      height: enumOf(slide.height, ["compact", "classic", "editorial"] as const, "editorial"),
    }),
  );

  // promo banners
  out.images.promo_banners = (Array.isArray(out.images.promo_banners) ? out.images.promo_banners : []).slice(0, 6).map(
    (banner, index) => ({
      id: str(banner.id, 60) || `promo-${index + 1}`,
      image_url: safeImageField(banner.image_url),
      title_ar: str(banner.title_ar, 120),
      title_en: str(banner.title_en, 120),
      caption_ar: str(banner.caption_ar, 240),
      caption_en: str(banner.caption_en, 240),
      href: safeUrlField(banner.href),
      badge_ar: str(banner.badge_ar, 40),
      badge_en: str(banner.badge_en, 40),
    }),
  );

  out.images.logo_url = safeImageField(out.images.logo_url);
  out.images.favicon_url = safeImageField(out.images.favicon_url);
  out.images.background_url = safeImageField(out.images.background_url);
  out.images.about_image_url = safeImageField(out.images.about_image_url);
  out.seo.og_image_url = safeImageField(out.seo.og_image_url);

  // brand (Phase 46) — same media-URL rules as images, bounded names.
  const brand = out.brand as unknown as Json;
  brand.display_name_ar = str(brand.display_name_ar, 60);
  brand.display_name_en = str(brand.display_name_en, 60);
  brand.mark_url = safeImageField(brand.mark_url);
  brand.logo_dark_url = safeImageField(brand.logo_dark_url);
  brand.receipt_logo_enabled = bool(brand.receipt_logo_enabled, true);

  // product card + badges + header
  const card = out.product_card as unknown as Json;
  card.mobile_columns = oneOf(card.mobile_columns, [1, 2, 3], 2);
  card.desktop_columns = oneOf(card.desktop_columns, [2, 3, 4, 5, 6], 4);
  card.aspect = enumOf(card.aspect, PRODUCT_CARD_ASPECT_KEYS, "portrait");
  card.image_fit = enumOf(card.image_fit, PRODUCT_CARD_FIT_KEYS, "cover");
  card.gap = enumOf(card.gap, PRODUCT_CARD_GAP_KEYS, "normal");
  card.text_align = enumOf(card.text_align, PRODUCT_CARD_ALIGN_KEYS, "start");
  for (const key of ["show_price", "show_badge", "show_wishlist", "show_quick_add", "show_swatches"]) {
    card[key] = bool(card[key], true);
  }
  const badgeKeys = ["show_new", "show_sale", "show_best_seller", "show_limited"] as const;
  for (const key of badgeKeys) {
    out.badges[key] = bool(out.badges[key], DEFAULT_WEBSITE_SETTINGS.badges[key]);
  }
  const header = out.header as unknown as Json;
  for (const key of ["sticky", "search_enabled", "account_enabled", "cart_enabled"]) {
    header[key] = bool(header[key], true);
  }

  // campaigns
  out.campaigns = (Array.isArray(out.campaigns) ? out.campaigns : []).slice(0, 50).map((c, index) => ({
    id: str(c.id, 60) || `campaign-${index + 1}`,
    enabled: bool(c.enabled, true),
    title_ar: str(c.title_ar, 120),
    title_en: str(c.title_en, 120),
    subtitle_ar: str(c.subtitle_ar, 240),
    subtitle_en: str(c.subtitle_en, 240),
    desktop_image_url: safeImageField(c.desktop_image_url),
    mobile_image_url: safeImageField(c.mobile_image_url),
    cta_ar: str(c.cta_ar, 40),
    cta_en: str(c.cta_en, 40),
    cta_href: safeUrlField(c.cta_href),
    starts_at: typeof c.starts_at === "string" && !Number.isNaN(new Date(c.starts_at).getTime()) ? c.starts_at : null,
    ends_at: typeof c.ends_at === "string" && !Number.isNaN(new Date(c.ends_at).getTime()) ? c.ends_at : null,
    placement: enumOf(c.placement, ["homepage", "banner"] as const, "homepage"),
    sort_order: clampInt(c.sort_order, 0, 9999, index),
  }));

  // social links
  out.social_links = (Array.isArray(out.social_links) ? out.social_links : []).slice(0, 8).map((l) => ({
    platform: oneOf(l.platform, ["instagram", "facebook", "tiktok", "whatsapp"] as const, "instagram"),
    enabled: bool(l.enabled, false),
    url: str(l.url, 500).trim(),
    label_ar: str(l.label_ar, 40),
    label_en: str(l.label_en, 40),
  }));

  // trust items
  out.trust.items = (Array.isArray(out.trust?.items) ? out.trust.items : []).slice(0, 12).map((item, index) => ({
    id: str(item.id, 60) || `trust-${index + 1}`,
    enabled: bool(item.enabled, true),
    icon: enumOf(item.icon, TRUST_ICON_KEYS, "star"),
    title_ar: str(item.title_ar, 60),
    title_en: str(item.title_en, 60),
    desc_ar: str(item.desc_ar, 160),
    desc_en: str(item.desc_en, 160),
    sort_order: clampInt(item.sort_order, 0, 9999, index + 1),
  }));

  // about / footer / copy groups
  const about = out.about as unknown as Json;
  about.title_ar = str(about.title_ar, 120);
  about.title_en = str(about.title_en, 120);
  about.body_ar = str(about.body_ar, 4000);
  about.body_en = str(about.body_en, 4000);
  about.image_url = safeImageField(about.image_url);
  about.cta_ar = str(about.cta_ar, 40);
  about.cta_en = str(about.cta_en, 40);
  about.cta_href = safeUrlField(about.cta_href);

  const footer = out.footer as unknown as Json;
  footer.description_ar = str(footer.description_ar, 600);
  footer.description_en = str(footer.description_en, 600);
  footer.newsletter_enabled = bool(footer.newsletter_enabled, false);
  footer.newsletter_note_ar = str(footer.newsletter_note_ar, 240);
  footer.newsletter_note_en = str(footer.newsletter_note_en, 240);
  footer.show_social = bool(footer.show_social, true);
  footer.copyright_ar = str(footer.copyright_ar, 200);
  footer.copyright_en = str(footer.copyright_en, 200);
  footer.policy_links = (Array.isArray(footer.policy_links) ? (footer.policy_links as Json[]) : [])
    .slice(0, 12)
    .map((link, index) => ({
      id: str(link.id, 60) || `policy-${index + 1}`,
      enabled: bool(link.enabled, true),
      label_ar: str(link.label_ar, 60),
      label_en: str(link.label_en, 60),
      href: safeUrlField(link.href),
    }));

  const checkout = out.checkout_copy as unknown as Json;
  for (const key of Object.keys(DEFAULT_WEBSITE_SETTINGS.checkout_copy)) {
    checkout[key] = str(checkout[key], 500);
  }
  const confirmation = out.confirmation as unknown as Json;
  for (const key of ["title_ar", "title_en", "message_ar", "message_en", "guidance_ar", "guidance_en", "support_cta_ar", "support_cta_en"]) {
    confirmation[key] = str(confirmation[key], 500);
  }
  confirmation.support_href = safeUrlField(confirmation.support_href);
  confirmation.whatsapp_cta = bool(confirmation.whatsapp_cta, true);

  // per-section config
  out.sections = out.sections.map((section) => ({
    ...section,
    ...(Array.isArray(section.category_ids)
      ? { category_ids: section.category_ids.filter((id) => typeof id === "string").slice(0, 24) }
      : {}),
    ...(Array.isArray(section.product_ids)
      ? { product_ids: section.product_ids.filter((id) => typeof id === "string").slice(0, 24) }
      : {}),
    ...(section.layout ? { layout: oneOf(section.layout, ["tiles", "carousel", "editorial"] as const, "editorial") } : {}),
    body_ar: str(section.body_ar ?? "", 2000),
    body_en: str(section.body_en ?? "", 2000),
    image_url: section.image_url ? safeImageField(section.image_url) : null,
    mobile_image_url: section.mobile_image_url ? safeImageField(section.mobile_image_url) : null,
    cta_ar: str(section.cta_ar ?? "", 40),
    cta_en: str(section.cta_en ?? "", 40),
    cta_href: safeUrlField(section.cta_href ?? ""),
  }));

  return out;
}
