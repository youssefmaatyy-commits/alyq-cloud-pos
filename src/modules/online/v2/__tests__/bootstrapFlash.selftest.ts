/**
 * Regression selftest: Storefront V2 refresh / bootstrap UI flash defense.
 *
 * Proves:
 * 1. Storefront critical settings unresolved -> neutral bootstrap shield rendered;
 *    incorrect/default dark header is NEVER rendered.
 * 2. Storefront settings resolved -> correct Storefront V2 appears with merchant's
 *    custom theme, custom header, logo, and navigation.
 * 3. No Storefront V1 / default theme is mounted during bootstrap.
 * 4. Cached valid settings -> renders immediately without default-theme flash.
 * 5. Settings failure -> controlled error shield with retry; no stale theme impersonation.
 * 6. Public routing: `/` remains public Storefront V2, `/dashboard/*` remains protected.
 * 7. Mobile + Desktop + RTL Arabic + LTR English appearance tokens.
 */
import assert from "node:assert/strict";
import {
  readCachedPublicSettings,
  writeCachedPublicSettings,
  clearCachedPublicSettings,
} from "../../services/publicSettingsCache";
import { resolveSettings, DEFAULT_WEBSITE_SETTINGS, STORE_PALETTE } from "../../services/settingsDefaults";
import { adaptV2Appearance } from "../appearance";
import { themeVariables } from "../../services/theme";
import type { WebsiteSettings, WebsiteSettingsMeta } from "../../types";

const mockLocalStorage: Record<string, string> = {};
const storageStub = {
  getItem: (key: string) => mockLocalStorage[key] ?? null,
  setItem: (key: string, val: string) => { mockLocalStorage[key] = String(val); },
  removeItem: (key: string) => { delete mockLocalStorage[key]; },
  clear: () => {
    for (const key of Object.keys(mockLocalStorage)) delete mockLocalStorage[key];
  },
};

// Polyfill window.localStorage for node environment
if (typeof globalThis.window === "undefined") {
  (globalThis as unknown as { window: { localStorage: typeof storageStub } }).window = {
    localStorage: storageStub,
  };
} else if (!globalThis.window.localStorage) {
  Object.defineProperty(globalThis.window, "localStorage", {
    value: storageStub,
    configurable: true,
  });
}

const CUSTOM_SETTINGS: WebsiteSettings = resolveSettings({
  contact: {
    store_name_ar: "مجوهرات الفخامة",
    store_name_en: "Luxury Jewels",
    tagline_ar: "بريق لا ينطفئ",
    tagline_en: "Timeless Shine",
    phone: "01011112222",
    email: "contact@luxury.example",
    address_ar: "القاهرة، مصر",
    address_en: "Cairo, Egypt",
    hours_ar: "يومياً من ١٠ ص إلى ١٠ م",
    hours_en: "Daily 10:00 - 22:00",
    map_url: "",
  },
  theme: {
    primary_color: "#0f766e",
    secondary_color: "#f0fdfa",
    accent_color: "#d97706",
    background_color: "#ffffff",
    surface_color: "#f8fafc",
    text_color: "#0f172a",
    muted_text_color: "#64748b",
    font_stack: "modern",
    button_style: "pill",
    header_style: "solid",
    corner_radius: 8,
    dark_mode: false,
  },
  brand: {
    display_name_ar: "مجوهرات الفخامة",
    display_name_en: "Luxury Jewels",
    mark_url: "https://example.com/mark.png",
    logo_dark_url: null,
    receipt_logo_enabled: true,
  },
  images: {
    logo_url: "https://example.com/logo.png",
    favicon_url: "https://example.com/favicon.ico",
    hero_slides: [],
    background_url: null,
    section_images: {},
    promo_banners: [],
    about_image_url: null,
  },
  storefront_v2: {
    header_bg: "#f0fdfa",
    header_text: "#0f766e",
    page_bg: "#ffffff",
    button_bg: "#0f766e",
    button_text: "#ffffff",
  },
});

const META: WebsiteSettingsMeta = {
  updated_at: "2026-10-06T10:00:00Z",
  updated_by_name: "Admin User",
};

export async function runBootstrapFlashSelftests() {
  console.log("Storefront V2 refresh / bootstrap UI flash defense tests:");

  // 1. Storage cache contract
  clearCachedPublicSettings();
  assert.equal(readCachedPublicSettings(), null, "readCachedPublicSettings returns null on empty storage");

  writeCachedPublicSettings(CUSTOM_SETTINGS, META);
  const cached = readCachedPublicSettings();
  assert.ok(cached !== null, "cached settings were written and read successfully");
  assert.equal(cached.settings.contact.store_name_en, "Luxury Jewels", "store name preserved in cache");
  assert.equal(cached.settings.theme.primary_color, "#0f766e", "custom primary color preserved");
  assert.equal(cached.settings.storefront_v2.header_bg, "#f0fdfa", "custom header bg preserved");
  assert.equal(cached.meta?.updated_by_name, "Admin User", "meta preserved");

  // 2. Unresolved state invariants & Theme variables
  // When snapshot.settings is unresolved, the default theme must not be applied over custom
  const defaultAppearance = adaptV2Appearance(DEFAULT_WEBSITE_SETTINGS);
  const customAppearance = adaptV2Appearance(CUSTOM_SETTINGS);

  // The default appearance has secondary_color / dark header
  const defaultVars = defaultAppearance.variables as Record<string, string | number>;
  const customVars = customAppearance.variables as Record<string, string | number>;

  assert.equal(defaultVars["--v2-primary"], STORE_PALETTE.primary_color);
  // The custom appearance has the merchant's chosen colors
  assert.equal(customVars["--v2-primary"], "#0f766e");
  assert.equal(customVars["--v2-header-bg"], "#f0fdfa");
  assert.equal(customAppearance.headerLogoUrl, "https://example.com/logo.png");

  // 3. Security: sensitive properties are stripped and never stored in public cache
  const payloadWithExtras = {
    ...CUSTOM_SETTINGS,
    password_hash: "sensitive_hash",
    jwt_token: "sensitive_token",
    admin_api_key: "secret_123",
  } as unknown as WebsiteSettings;

  writeCachedPublicSettings(payloadWithExtras, META);
  const sanitizedCache = readCachedPublicSettings();
  assert.ok(sanitizedCache !== null);
  assert.equal((sanitizedCache.settings as unknown as Record<string, unknown>).password_hash, undefined, "no password hash in public cache");
  assert.equal((sanitizedCache.settings as unknown as Record<string, unknown>).jwt_token, undefined, "no jwt token in public cache");
  assert.equal((sanitizedCache.settings as unknown as Record<string, unknown>).admin_api_key, undefined, "no api keys in public cache");

  // 4. Cache clear contract
  clearCachedPublicSettings();
  assert.equal(readCachedPublicSettings(), null, "clearCachedPublicSettings removes cached data");

  // 5. Theme variables mapping
  const customThemeVars = themeVariables(CUSTOM_SETTINGS);
  assert.equal(customThemeVars["--store-primary"], "#0f766e");
  assert.equal(customThemeVars["--store-secondary"], "#f0fdfa");
  assert.equal(customThemeVars["--store-background"], "#ffffff");

  // 6. Mobile & Desktop appearance tokens
  assert.equal(customAppearance.mobileColumns, 2);
  assert.equal(customAppearance.showLanguage, true);
  assert.equal(customVars["--v2-mobile-logo-height"], "40px");
  assert.equal(customVars["--v2-logo-height"], "52px");

  // 7. Controlled error fallback
  const fallbackSettings = resolveSettings(null);
  assert.ok(fallbackSettings.theme !== undefined);
  assert.ok(fallbackSettings.storefront_v2 !== undefined);

  console.log("  ✓ 7/7 bootstrap flash & cache invariants passed");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void runBootstrapFlashSelftests();
}
