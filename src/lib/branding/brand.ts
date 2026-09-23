/**
 * The one brand source (Phase 46).
 *
 * Every screen that shows "who we are" — the admin shell, the login page, the
 * dashboard, POS and the printed receipts — resolves its identity through this
 * module and therefore through ONE stored document: `website_settings.brand`
 * plus the storefront's existing `images.logo_url` as the primary logo.
 *
 * There are deliberately no admin_logo / website_logo / receipt_logo splits:
 * the Branding screen edits the same fields the storefront header renders, and
 * a receipt prints the same logo the sidebar shows (unless the merchant turns
 * the receipt logo off).
 *
 * Pure and testable: {@link resolveBrand} never touches storage or network.
 */
import { getWebsiteRepository } from "@/modules/online/data";
import {
  DEFAULT_STORE_NAME_AR,
  DEFAULT_STORE_NAME_EN,
  resolveSettings,
} from "@/modules/online/services/settingsDefaults";
import type { WebsiteSettings } from "@/modules/online/types";
import { useEffect, useState } from "react";

/** The official wordmarks — the same constants the storefront defaults use. */
export const BRAND_DEFAULT_NAME_EN = DEFAULT_STORE_NAME_EN;
export const BRAND_DEFAULT_NAME_AR = DEFAULT_STORE_NAME_AR;

export interface BrandInfo {
  /** Primary logo (the storefront header's logo). */
  logoUrl: string | null;
  /** Compact mark; falls back to the primary logo. */
  markUrl: string | null;
  /** Logo tuned for dark surfaces; falls back to the primary logo. */
  darkLogoUrl: string | null;
  displayNameAr: string;
  displayNameEn: string;
  /** Print the brand logo on receipts (default true). */
  receiptLogoEnabled: boolean;
}

const FALLBACK: BrandInfo = {
  logoUrl: null,
  markUrl: null,
  darkLogoUrl: null,
  displayNameAr: "",
  displayNameEn: "",
  receiptLogoEnabled: true,
};

/**
 * Resolve the brand from a settings document (or from nothing — every field
 * degrades to the shipped ALYQ identity, so a load failure never blanks the
 * app's name).
 */
export function resolveBrand(
  settings: WebsiteSettings | null | undefined,
): BrandInfo {
  if (!settings) return { ...FALLBACK };
  const brand = settings.brand;
  const logo = settings.images?.logo_url ?? null;
  return {
    logoUrl: logo,
    markUrl: brand?.mark_url ?? logo,
    darkLogoUrl: brand?.logo_dark_url ?? logo,
    displayNameAr: (brand?.display_name_ar ?? "").trim(),
    displayNameEn: (brand?.display_name_en ?? "").trim(),
    receiptLogoEnabled: brand?.receipt_logo_enabled ?? true,
  };
}

/** Effective display name for a language, with the official wordmark fallback. */
export function brandDisplayName(brand: BrandInfo, lang: "ar" | "en"): string {
  const override = lang === "ar" ? brand.displayNameAr : brand.displayNameEn;
  if (override) return override;
  return lang === "ar" ? BRAND_DEFAULT_NAME_AR : BRAND_DEFAULT_NAME_EN;
}

let cachedBrand: BrandInfo | null = null;
let cachedLoad: Promise<BrandInfo> | null = null;
const listeners = new Set<(brand: BrandInfo) => void>();

/**
 * Load the brand once per session. Public snapshot read → works signed in and
 * out, demo and live. Any failure degrades to the shipped wordmark.
 */
export function loadBrand(): Promise<BrandInfo> {
  if (cachedBrand) return Promise.resolve(cachedBrand);
  cachedLoad ??= (async () => {
    try {
      const snapshot = await getWebsiteRepository().getSnapshot();
      cachedBrand = resolveBrand(resolveSettings(snapshot.settings));
    } catch {
      cachedBrand = { ...FALLBACK };
    }
    return cachedBrand;
  })();
  return cachedLoad;
}

/**
 * Drop the session cache (after the Branding screen saves) and tell every
 * mounted surface — sidebar, login, dashboard — to read it again.
 */
export function invalidateBrandCache(): void {
  cachedBrand = null;
  cachedLoad = null;
  void loadBrand().then((brand) => {
    for (const listener of listeners) listener(brand);
  });
}

/** React binding: the resolved brand, or null until the first load lands.
 *  Re-reads when the Branding screen saves. */
export function useBrand(): BrandInfo | null {
  const [brand, setBrand] = useState<BrandInfo | null>(cachedBrand);
  useEffect(() => {
    let cancelled = false;
    void loadBrand().then((resolved) => {
      if (!cancelled) setBrand(resolved);
    });
    const listener = (next: BrandInfo) => {
      if (!cancelled) setBrand(next);
    };
    listeners.add(listener);
    return () => {
      cancelled = true;
      listeners.delete(listener);
    };
  }, []);
  return brand;
}
