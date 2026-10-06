/**
 * Safe public storefront settings cache.
 *
 * Caches the latest known sanitized public website settings in localStorage
 * so that repeat visits and browser refreshes can immediately paint the
 * storefront in the merchant's chosen theme/colors/logo without a bootstrap
 * flicker while revalidating against Supabase in the background.
 *
 * Security: Only public display fields (theme, brand name, logo URLs, sections)
 * are stored here. Never store credentials, tokens, customer data, or admin settings.
 */
import type { WebsiteSettings, WebsiteSettingsMeta } from "../types";
import { resolveSettings, sanitizeSettings } from "./settingsDefaults";

const CACHE_KEY = "alyq.storefront.public_settings.v2";

export interface CachedPublicSettings {
  settings: WebsiteSettings;
  meta: WebsiteSettingsMeta | null;
  cachedAt: number;
}

export function readCachedPublicSettings(): { settings: WebsiteSettings; meta: WebsiteSettingsMeta | null } | null {
  if (typeof window === "undefined" || !window.localStorage) return null;
  try {
    const raw = window.localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || !parsed.settings) return null;
    return {
      settings: resolveSettings(parsed.settings),
      meta: parsed.meta ?? null,
    };
  } catch {
    return null;
  }
}

export function writeCachedPublicSettings(settings: WebsiteSettings, meta: WebsiteSettingsMeta | null): void {
  if (typeof window === "undefined" || !window.localStorage) return;
  try {
    const sanitized = sanitizeSettings(settings);
    // Explicitly allowlist only known public WebsiteSettings keys
    const safeSettings: WebsiteSettings = {
      storefront_v2: sanitized.storefront_v2,
      version: sanitized.version,
      currency: sanitized.currency,
      contact: sanitized.contact,
      theme: sanitized.theme,
      images: sanitized.images,
      brand: sanitized.brand,
      sections: sanitized.sections,
      social: sanitized.social,
      social_links: sanitized.social_links,
      delivery: sanitized.delivery,
      seo: sanitized.seo,
      announcement: sanitized.announcement,
      product_card: sanitized.product_card,
      badges: sanitized.badges,
      header: sanitized.header,
      campaigns: sanitized.campaigns,
      trust: sanitized.trust,
      about: sanitized.about,
      footer: sanitized.footer,
      checkout_copy: sanitized.checkout_copy,
      confirmation: sanitized.confirmation,
      whatsapp_updates: sanitized.whatsapp_updates,
    };
    const payload: CachedPublicSettings = {
      settings: safeSettings,
      meta: meta ? { updated_at: meta.updated_at, updated_by_name: meta.updated_by_name } : null,
      cachedAt: Date.now(),
    };
    window.localStorage.setItem(CACHE_KEY, JSON.stringify(payload));
  } catch {
    // Storage quota or private mode: non-fatal.
  }
}

export function clearCachedPublicSettings(): void {
  if (typeof window === "undefined" || !window.localStorage) return;
  try {
    window.localStorage.removeItem(CACHE_KEY);
  } catch {
    // Non-fatal
  }
}
