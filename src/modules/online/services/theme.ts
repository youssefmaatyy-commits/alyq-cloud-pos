/**
 * Theme — turning the admin's choices into something the browser renders.
 *
 * The storefront is styled with Tailwind, but every colour it uses is a CSS
 * custom property rather than a baked-in palette. That is what makes the builder
 * honest: when an admin picks a primary colour, the buttons, links, focus rings
 * and badges change together, with no rebuild and no code. The variables are
 * written on `<html>` so they reach portals and the fixed-position elements the
 * storefront mounts outside its own subtree — the cart drawer, the toast stack.
 *
 * The POS is untouched by design. These variables are namespaced `--store-*` and
 * are removed when the storefront unmounts, so a shop can be rebranded without
 * the till screen changing by one pixel.
 *
 * Fonts are curated stacks rather than a free-text field. An arbitrary font
 * family is an arbitrary network request: it slows the first paint, it may fail,
 * and it may not have an Arabic face at all — which matters for a shop that
 * sells in both languages. Each stack below pairs a Latin face with an Arabic
 * one that is already present on the platform.
 */
import type { CSSProperties } from "react";
import type { ButtonStyle, StoreFontKey, WebsiteSettings } from "../types";
import { readableOn, safeColor } from "./settingsDefaults";

const FONT_STACKS: Record<StoreFontKey, string> = {
  // Nothing to download: the fastest possible first paint.
  system:
    'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans Arabic", "Helvetica Neue", Arial, sans-serif',
  modern:
    '"Inter", "Segoe UI Variable Text", "Noto Sans Arabic", ui-sans-serif, system-ui, sans-serif',
  classic:
    '"Source Serif 4", Georgia, "Times New Roman", "Amiri", "Noto Naskh Arabic", serif',
  rounded:
    '"Nunito", "Quicksand", "Segoe UI", "Cairo", "Noto Sans Arabic", ui-rounded, sans-serif',
};

/** The stack for a font key, falling back to the system stack. */
export function fontStackOf(key: StoreFontKey | string | null | undefined): string {
  return FONT_STACKS[(key ?? "system") as StoreFontKey] ?? FONT_STACKS.system;
}

/** Corner radius in pixels for the admin's button shape. */
export function buttonRadiusOf(style: ButtonStyle, cornerRadius: number): number {
  if (style === "pill") return 9999;
  if (style === "square") return 0;
  return Math.max(0, cornerRadius);
}

// ── colour maths ────────────────────────────────────────────────────────────

/** #rgb / #rrggbb → {r,g,b}, or null if it is not something we can parse. */
export function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const normalized = safeColor(hex, "#000000").replace("#", "");
  const full =
    normalized.length === 3
      ? normalized
          .split("")
          .map((digit) => digit + digit)
          .join("")
      : normalized.slice(0, 6);
  if (!/^[0-9a-f]{6}$/i.test(full)) return null;
  return {
    r: parseInt(full.slice(0, 2), 16),
    g: parseInt(full.slice(2, 4), 16),
    b: parseInt(full.slice(4, 6), 16),
  };
}

/**
 * Mix a colour toward black (amount < 0) or white (amount > 0).
 * Used for hover and pressed states, so an admin never has to pick three shades
 * of the same colour to get one coherent button.
 */
export function shade(hex: string, amount: number, fallback = "#4338ca"): string {
  const safe = safeColor(hex, fallback);
  const rgb = hexToRgb(safe);
  if (!rgb) return safe;
  const mix = (channel: number) => {
    const target = amount > 0 ? 255 : 0;
    return Math.round(channel + (target - channel) * Math.abs(amount));
  };
  const toHex = (value: number) =>
    Math.max(0, Math.min(255, value)).toString(16).padStart(2, "0");
  return `#${toHex(mix(rgb.r))}${toHex(mix(rgb.g))}${toHex(mix(rgb.b))}`;
}

/** Dark surfaces for a storefront the admin switched to dark mode. */
const DARK_FALLBACKS = {
  background: "#0b1220",
  surface: "#131c2e",
  text: "#f1f5f9",
  muted: "#94a3b8",
} as const;

/** The whole token set the storefront reads, as CSS custom properties. */
export function themeVariables(settings: WebsiteSettings): Record<string, string> {
  const theme = settings.theme;
  const primary = safeColor(theme.primary_color, "#4338ca");
  const secondary = safeColor(theme.secondary_color, "#0f172a");
  const accent = safeColor(theme.accent_color, "#f59e0b");
  const dark = theme.dark_mode;

  const background = safeColor(
    theme.background_color,
    dark ? DARK_FALLBACKS.background : "#f8fafc",
  );
  const surface = safeColor(theme.surface_color, dark ? DARK_FALLBACKS.surface : "#ffffff");
  const text = safeColor(theme.text_color, dark ? DARK_FALLBACKS.text : "#0f172a");
  const muted = safeColor(theme.muted_text_color, dark ? DARK_FALLBACKS.muted : "#64748b");

  return {
    "--store-primary": primary,
    "--store-primary-hover": shade(primary, -0.12, primary),
    "--store-primary-active": shade(primary, -0.24, primary),
    // A tint of the primary for chips, soft buttons and the free-delivery bar.
    "--store-primary-soft": dark ? shade(primary, -0.62, primary) : shade(primary, 0.88, "#eef2ff"),
    "--store-on-primary": readableOn(primary),
    "--store-secondary": secondary,
    "--store-on-secondary": readableOn(secondary),
    "--store-accent": accent,
    "--store-on-accent": readableOn(accent),
    "--store-bg": background,
    "--store-surface": surface,
    // One step between surface and background, for nested cards and table rows.
    "--store-surface-alt": dark ? shade(surface, 0.06, surface) : shade(surface, -0.04, surface),
    "--store-border": dark ? shade(surface, 0.16, surface) : shade(surface, -0.12, surface),
    "--store-text": text,
    "--store-muted": muted,
    "--store-radius": `${Math.max(0, theme.corner_radius)}px`,
    "--store-radius-button": `${buttonRadiusOf(theme.button_style, theme.corner_radius)}px`,
    "--store-font": fontStackOf(theme.font_stack),
  };
}

/**
 * Inline style object, for components that need the tokens on a single element.
 * React passes custom properties through untouched, so the `--` prefix stays.
 */
export function themeStyle(settings: WebsiteSettings): CSSProperties {
  return themeVariables(settings) as unknown as CSSProperties;
}

/** The storefront's base surface: page background, text colour and font. */
export function storefrontSurfaceStyle(settings: WebsiteSettings): CSSProperties {
  const variables = themeVariables(settings);
  return {
    backgroundColor: variables["--store-bg"],
    color: variables["--store-text"],
    fontFamily: variables["--store-font"],
    minHeight: "100vh",
  };
}

/**
 * The primary button.
 *
 * Shape comes from `button_style`; colour comes from the theme variables. One
 * helper means every call to action on the site is the same button, which is
 * what "button styles" in a builder is supposed to buy the admin.
 */
export function primaryButtonStyle(settings: WebsiteSettings): CSSProperties {
  const vars = themeVariables(settings);
  return {
    backgroundColor: vars["--store-primary"],
    color: vars["--store-on-primary"],
    borderRadius: vars["--store-radius-button"],
    fontWeight: 600,
  };
}

/** The quieter button: same shape, no fill. Used for "keep browsing" and filters. */
export function secondaryButtonStyle(settings: WebsiteSettings): CSSProperties {
  const vars = themeVariables(settings);
  return {
    backgroundColor: "transparent",
    color: vars["--store-primary"],
    border: `1px solid ${vars["--store-border"]}`,
    borderRadius: vars["--store-radius-button"],
    fontWeight: 600,
  };
}

/** Card surface: what every product tile, panel and drawer sits on. */
export function cardStyle(settings: WebsiteSettings): CSSProperties {
  const vars = themeVariables(settings);
  return {
    backgroundColor: vars["--store-surface"],
    color: vars["--store-text"],
    border: `1px solid ${vars["--store-border"]}`,
    borderRadius: vars["--store-radius"],
  };
}

/** Badge colours per kind — sale takes the accent, the rest stay quieter. */
export function badgeStyle(kind: "new" | "sale" | "bestSeller" | "featured"): CSSProperties {
  switch (kind) {
    case "sale":
      return {
        backgroundColor: "var(--store-accent)",
        color: "var(--store-on-accent)",
        borderRadius: "var(--store-radius-button)",
      };
    case "bestSeller":
      return {
        backgroundColor: "var(--store-secondary)",
        color: "var(--store-on-secondary)",
        borderRadius: "var(--store-radius-button)",
      };
    default:
      return {
        backgroundColor: "var(--store-primary-soft)",
        color: "var(--store-primary)",
        borderRadius: "var(--store-radius-button)",
      };
  }
}

// ── applying it to the document ─────────────────────────────────────────────

const THEME_STYLE_ID = "alyq-store-theme";

/**
 * Write the theme into the live document.
 *
 * Idempotent and cheap enough to call on every settings change. A `<style>`
 * element is used instead of setting properties one by one so that a later theme
 * fully replaces an earlier one — property-by-property, a variable an admin
 * removed would linger and keep colouring the site.
 *
 * The fonts are system stacks, so nothing here blocks rendering: there is no
 * webfont to download, which is why a shop on a phone network still paints
 * instantly after the admin restyles it.
 */
export function applyStoreTheme(settings: WebsiteSettings | null): void {
  if (typeof document === "undefined") return;

  if (!settings) {
    document.getElementById(THEME_STYLE_ID)?.remove();
    return;
  }

  const declarations = Object.entries(themeVariables(settings))
    .map(([key, value]) => `  ${key}: ${value};`)
    .join("\n");

  let style = document.getElementById(THEME_STYLE_ID) as HTMLStyleElement | null;
  if (!style) {
    style = document.createElement("style");
    style.id = THEME_STYLE_ID;
    document.head.appendChild(style);
  }
  style.textContent = `:root {\n${declarations}\n}\n`;
}

/** Favicon, from the admin's image or the app default. */
export function applyFavicon(url: string | null, defaultHref?: string | null): void {
  if (typeof document === "undefined") return;
  let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  const next = url || defaultHref;
  if (!next) return;
  if (!link) {
    link = document.createElement("link");
    link.rel = "icon";
    document.head.appendChild(link);
  }
  link.href = next;
}

/**
 * Leave the document as the POS expects it.
 *
 * The storefront and the back office share one document; a theme variable or a
 * favicon left behind would follow the user into the till.
 */
export function clearStoreTheme(defaultFaviconHref?: string | null): void {
  if (typeof document === "undefined") return;
  document.getElementById(THEME_STYLE_ID)?.remove();
  applyFavicon(null, defaultFaviconHref);
}

/** Attribute the storefront root carries, so dark mode can style children. */
export function storefrontThemeAttributes(settings: WebsiteSettings): Record<string, string> {
  return { "data-store-theme": settings.theme.dark_mode ? "dark" : "light" };
}
