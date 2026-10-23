/** Storefront V2's presentation adapter. The admin saves a small typed group
 * inside the existing website_settings JSON document. Only this V2 root receives
 * the tokens; legacy storefront, POS and Admin never read or inherit them. */
import type { CSSProperties } from "react";
import type { StorefrontV2Settings, WebsiteSettings } from "../types";
import {
  configuredHref, DEFAULT_STORE_NAME_AR, DEFAULT_STORE_NAME_EN, safeImageField, safeV2Color,
  sanitizeStorefrontV2Settings, STORE_PALETTE,
} from "../services/settingsDefaults";
import { buttonRadiusOf, fontStackOf, shade } from "../services/theme";
import { canonicalConfiguredStorePath } from "./storeRoutes";

export type V2AppearanceOverrides = Partial<StorefrontV2Settings>;

function luminance(hex: string): number {
  const raw = safeV2Color(hex, "#000000").slice(1);
  const full = raw.length === 3 ? raw.split("").map((digit) => digit + digit).join("") : raw;
  const values = [0, 2, 4].map((index) => {
    const unit = parseInt(full.slice(index, index + 2), 16) / 255;
    return unit <= 0.04045 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
  });
  return values[0] * 0.2126 + values[1] * 0.7152 + values[2] * 0.0722;
}

/** Minimum WCAG AA contrast for small text, including custom dark surfaces. */
export function contrastRatio(first: string, second: string): number {
  const a = luminance(first);
  const b = luminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

function on(bg: string, requested?: string | null): string {
  const desired = safeV2Color(requested, "");
  if (desired && contrastRatio(bg, desired) >= 4.5) return desired;
  return contrastRatio(bg, "#111820") >= contrastRatio(bg, "#ffffff") ? "#111820" : "#ffffff";
}

const DISPLAY_STACKS = {
  editorial: '"Iowan Old Style", "Palatino Linotype", Georgia, "Amiri", "Noto Naskh Arabic", serif',
  modern: '"Inter", "Segoe UI", "Noto Sans Arabic", Tahoma, Arial, sans-serif',
  classic: 'Georgia, "Times New Roman", "Amiri", "Noto Naskh Arabic", Tahoma, serif',
} as const;
const ARABIC_BODY_STACK = '"Noto Sans Arabic", "Cairo", Tahoma, Arial, sans-serif';
const ARABIC_DISPLAY_STACK = '"Noto Naskh Arabic", "Amiri", Tahoma, Arial, serif';

const ALYQ_TRANSPARENT_HEADER_LOGO = "/brand/alyq-logo-transparent.png";

function normalizedArabicBrandName(value: string): string {
  return value.normalize("NFD").replace(/\p{M}/gu, "").replace(/\u0640/g, "").replace(/\s+/g, "").toLowerCase();
}

function isDefaultBrand(settings: WebsiteSettings): boolean {
  const english = (settings.brand.display_name_en || settings.contact.store_name_en).trim().toLowerCase();
  const arabic = normalizedArabicBrandName(settings.brand.display_name_ar || settings.contact.store_name_ar);
  return english === DEFAULT_STORE_NAME_EN.toLowerCase()
    && arabic === normalizedArabicBrandName(DEFAULT_STORE_NAME_AR);
}

function isBundledOpaqueMark(safe: string | null): boolean {
  return Boolean(safe && /^\/alyq-logo\.(?:png|jpe?g)(?:[?#].*)?$/i.test(safe));
}

export function adaptV2Appearance(settings: WebsiteSettings, overrides: V2AppearanceOverrides = {}) {
  // Defend at the renderer too: old SQL validates shared theme fields, but does
  // not validate V2-only JSON. Invalid stored URLs, enums or CSS never render.
  const v2 = sanitizeStorefrontV2Settings({ ...settings.storefront_v2, ...overrides });
  const theme = settings.theme;
  const bg = safeV2Color(v2.page_bg, safeV2Color(theme.background_color, STORE_PALETTE.background_color));
  const surface = safeV2Color(v2.surface_bg, safeV2Color(theme.surface_color, bg));
  const primary = safeV2Color(theme.primary_color, STORE_PALETTE.primary_color);
  const accent = safeV2Color(v2.accent_color, safeV2Color(theme.accent_color, primary));
  const header = safeV2Color(v2.header_bg, safeV2Color(theme.secondary_color, surface));
  const footer = safeV2Color(v2.footer_bg, safeV2Color(theme.secondary_color, primary));
  const announcement = safeV2Color(v2.announcement_bg, safeV2Color(settings.announcement.bg_color, primary));
  const hero = safeV2Color(v2.hero_bg, primary);
  const text = v2.text_color ?? theme.text_color;
  const muted = v2.muted_text ?? theme.muted_text_color;
  const button = safeV2Color(v2.button_bg, primary);
  const badge = safeV2Color(v2.badge_bg, accent);
  const border = safeV2Color(v2.border_color, shade(bg, contrastRatio(bg, "#111820") > 4.5 ? -0.19 : 0.2));
  const headerText = on(header, v2.header_text);
  const bodyFont = v2.body_font === "inherit" ? fontStackOf(theme.font_stack) : fontStackOf(v2.body_font);
  const displayFont = v2.display_font === "inherit" ? DISPLAY_STACKS.editorial : DISPLAY_STACKS[v2.display_font];
  const buttonStyle = v2.button_style === "inherit" ? theme.button_style : v2.button_style;
  // Replace only the default brand's bundled opaque square mark; merchant
  // uploads remain authoritative and retain their previous default dimensions.
  const defaultBrand = isDefaultBrand(settings);
  const configuredHeaderLogo = luminance(header) < 0.179
    ? settings.brand.logo_dark_url ?? settings.images.logo_url
    : settings.images.logo_url;
  const safeHeaderLogo = safeImageField(configuredHeaderLogo);
  const usesTransparentMaster = defaultBrand && (!safeHeaderLogo || isBundledOpaqueMark(safeHeaderLogo));
  const headerLogoUrl = usesTransparentMaster ? ALYQ_TRANSPARENT_HEADER_LOGO : safeHeaderLogo;
  const safeMobileLogo = safeImageField(v2.mobile_logo_url);
  const mobileLogoUrl = v2.mobile_logo_url
    ? (defaultBrand && isBundledOpaqueMark(safeMobileLogo)
      ? ALYQ_TRANSPARENT_HEADER_LOGO
      : safeMobileLogo) ?? headerLogoUrl
    : headerLogoUrl;
  // Keep the larger 72px/56px defaults scoped to this official, transparent
  // mark. Admin slider values and all custom-store defaults are unchanged.
  const height = v2.logo_height ?? (usesTransparentMaster ? 72 : 52);
  const mobileHeight = v2.mobile_logo_height ?? (usesTransparentMaster ? 56 : 40);
  const variables = {
    "--v2-bg": bg,
    "--v2-surface": surface,
    "--v2-text": on(bg, text),
    "--v2-muted": on(bg, muted),
    "--v2-surface-text": on(surface, text),
    "--v2-surface-muted": on(surface, muted),
    "--v2-primary": primary,
    "--v2-primary-text": on(primary),
    "--v2-accent": accent,
    "--v2-accent-text": on(bg, accent),
    "--v2-focus": on(bg, accent),
    "--v2-border": border,
    "--v2-header-bg": header,
    "--v2-header-text": headerText,
    "--v2-header-accent-text": on(header, accent),
    "--v2-announcement-bg": announcement,
    "--v2-announcement-text": on(announcement, v2.announcement_text ?? settings.announcement.text_color),
    "--v2-footer-bg": footer,
    "--v2-footer-text": on(footer, v2.footer_text),
    "--v2-footer-link": on(footer, v2.footer_link ?? v2.footer_text),
    "--v2-button-bg": button,
    "--v2-button-text": on(button, v2.button_text),
    "--v2-badge-bg": badge,
    "--v2-badge-text": on(badge, v2.badge_text),
    "--v2-button-radius": `${buttonRadiusOf(buttonStyle, Number.isFinite(theme.corner_radius) ? theme.corner_radius : 4)}px`,
    "--v2-badge-radius": v2.badge_style === "pill" ? "9999px" : "0px",
    "--v2-card-radius": `${Math.min(16, Math.max(0, Number.isFinite(theme.corner_radius) ? theme.corner_radius : 4))}px`,
    "--v2-hero-bg": hero,
    "--v2-hero-text": on(hero, v2.hero_text),
    "--v2-font-body": bodyFont,
    "--v2-font-display": displayFont,
    "--v2-font-arabic-body": v2.body_font === "classic" ? ARABIC_DISPLAY_STACK : ARABIC_BODY_STACK,
    "--v2-font-arabic-display": v2.display_font === "modern" ? ARABIC_BODY_STACK : ARABIC_DISPLAY_STACK,
    "--v2-logo-height": `${height}px`,
    "--v2-mobile-logo-height": `${mobileHeight}px`,
  } as CSSProperties;
  return {
    variables,
    stickyHeader: v2.sticky_header ?? settings.header.sticky,
    showSearch: v2.show_search ?? settings.header.search_enabled,
    showAccount: v2.show_account ?? settings.header.account_enabled,
    showCart: v2.show_cart ?? settings.header.cart_enabled,
    showLanguage: v2.show_language,
    mobileColumns: v2.mobile_columns ?? (settings.product_card.mobile_columns === 1 ? 1 : 2),
    logoUrl: safeImageField(settings.images.logo_url),
    headerLogoUrl,
    mobileLogoUrl,
  };
}

/** Stored canonical shop links stay canonical; saved preview links become
 * canonical too. Validate first and never mutate the merchant's settings. */
export function v2Href(raw: unknown): string | null {
  const href = configuredHref(raw);
  if (!href) return null;
  if (!href.startsWith("#/")) return href;
  const path = href.slice(1);
  if (path.startsWith("//") || path.includes("\\") || [...path].some((char) => char.charCodeAt(0) < 32)) return null;
  return canonicalConfiguredStorePath(path);
}
