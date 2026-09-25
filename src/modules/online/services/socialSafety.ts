/** Shared website social/contact link policy. No new CMS or phone-identity logic:
 * a shopper-facing WhatsApp destination needs an explicit international code,
 * and a profile link must actually lead to its named service. */
import type { SocialPlatform, WebsiteSettings } from "../types";

type ProfilePlatform = Exclude<SocialPlatform, "whatsapp">;
const PROFILE_HOSTS: Record<ProfilePlatform, readonly string[]> = {
  facebook: ["facebook.com", "www.facebook.com", "m.facebook.com", "web.facebook.com", "fb.com", "www.fb.com"],
  instagram: ["instagram.com", "www.instagram.com"],
  tiktok: ["tiktok.com", "www.tiktok.com", "m.tiktok.com"],
};

/** Reject lookalike hosts, credentials, HTTP, executable schemes and empty
 * service homepages. URL() only runs after the literal HTTPS check. */
export function socialProfileHref(platform: ProfilePlatform, raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (value.length > 500 || !/^https:\/\//i.test(value) || /[\s\\]/.test(value) ||
    [...value].some((char) => char.charCodeAt(0) === 127)) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash ||
      !PROFILE_HOSTS[platform].includes(url.hostname) || url.pathname === "/") return null;
    if (platform === "instagram" && !/^\/[a-z\d._]+\/?$/i.test(url.pathname)) return null;
    if (platform === "tiktok" && !/^\/@[a-z\d._]+\/?$/i.test(url.pathname)) return null;
    return url.href;
  } catch {
    return null;
  }
}

/** `wa.me` URLs already saved by older shops can still be edited. New input
 * may be +CC (or 00CC) with spaces/brackets/dashes, or an existing bare E.164
 * number. A local 0… number is *not* silently prefixed with Egypt's code. */
function whatsappUrl(raw: string): URL | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.hostname !== "wa.me" || url.username || url.password || url.port || url.hash ||
      !/^\/[1-9]\d{7,14}\/?$/.test(url.pathname) ||
      [...url.searchParams.keys()].some((key) => key !== "text") || [...url.searchParams.keys()].length > 1 ||
      !validWhatsAppMessage(url.searchParams.get("text") ?? "")) return null;
    return url;
  } catch {
    return null;
  }
}

export function normalizeWhatsAppPhone(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (!value || value.length > 500 || value.includes("\\") ||
    [...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) return null;
  let digits: string;
  let explicitCode: boolean;
  if (/^https?:\/\//i.test(value)) {
    const url = whatsappUrl(value);
    if (!url) return null;
    digits = url.pathname.slice(1).replace(/\/$/, "");
    explicitCode = true;
  } else {
    if (!/^\+?[0-9][0-9 ()-]*$/.test(value) || value.startsWith("+00") ||
      // Stray/misordered brackets are not mere presentation characters.
      value.replace(/\([^()]*\)/g, "").includes("(") || value.replace(/\([^()]*\)/g, "").includes(")")) return null;
    explicitCode = value.startsWith("+") || value.startsWith("00");
    digits = value.replace(/[ ()-]/g, "").replace(/^\+/, "").replace(/^00/, "");
  }
  // +20 (0)100... explicitly supplies Egypt's code and a redundant trunk 0.
  if (/^2001\d{9}$/.test(digits)) digits = `20${digits.slice(3)}`;
  if (!/^[1-9]\d{7,14}$/.test(digits)) return null;
  if (!explicitCode && digits.length < 11) return null;
  if (digits.startsWith("20") && !/^201\d{9}$/.test(digits)) return null;
  return digits;
}

/** Plain bilingual copy, not HTML. The length cap keeps generated links within
 * practical browser limits; encodeURIComponent is guarded against bad UTF-16. */
export function validWhatsAppMessage(raw: unknown): raw is string {
  if (typeof raw !== "string" || raw.length > 800 || [...raw].some((char) => {
    const code = char.codePointAt(0)!;
    return code === 127 || (code < 32 && code !== 9 && code !== 10 && code !== 13);
  })) return false;
  try { encodeURIComponent(raw); return true; } catch { return false; }
}

export function whatsappChannelHref(raw: unknown, message = ""): string | null {
  const number = normalizeWhatsAppPhone(raw);
  if (!number || !validWhatsAppMessage(message)) return null;
  // A previously saved wa.me?text=… keeps its existing copy unless the owner
  // enters a new message in the shared Social editor.
  const legacyCopy = typeof raw === "string" && /^https:\/\//i.test(raw.trim())
    ? whatsappUrl(raw.trim())?.searchParams.get("text") ?? "" : "";
  const text = message.trim() || legacyCopy.trim();
  return `https://wa.me/${number}${text ? `?text=${encodeURIComponent(text)}` : ""}`;
}

export function socialChannelHref(platform: SocialPlatform, raw: unknown, message = ""): string | null {
  return platform === "whatsapp" ? whatsappChannelHref(raw, message) : socialProfileHref(platform, raw);
}

export type SocialFieldError = {
  platform: SocialPlatform;
  field: "url" | "message";
  reason: "invalid" | "required";
};

/** The Admin validates the *whole draft* before writing one settings row. The
 * legacy flat fields and the enabled rows both matter: neither may smuggle an
 * unsafe or wrongly branded URL through the other editor. Disabled accounts
 * may retain valid values for re-enabling, but enabled rows need a destination. */
export function invalidSocialSetting(settings: WebsiteSettings): SocialFieldError | null {
  for (const platform of ["facebook", "instagram", "tiktok", "whatsapp"] as const) {
    const flat = settings.social[platform];
    const row = settings.social_links.find((entry) => entry.platform === platform);
    if (flat && !socialChannelHref(platform, flat)) return { platform, field: "url", reason: "invalid" };
    if (row?.url && !socialChannelHref(platform, row.url)) return { platform, field: "url", reason: "invalid" };
    if (row?.enabled && !(row.url?.trim() || flat?.trim())) return { platform, field: "url", reason: "required" };
    if (platform === "whatsapp" && row &&
      (!validWhatsAppMessage(row.message_ar ?? "") || !validWhatsAppMessage(row.message_en ?? ""))) {
      return { platform, field: "message", reason: "invalid" };
    }
  }
  return null;
}
