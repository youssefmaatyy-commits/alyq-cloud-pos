import assert from "node:assert/strict";
import { dictionaries } from "@/lib/i18n/dictionary";
import {
  DEFAULT_STOREFRONT_V2_SETTINGS, DEFAULT_WEBSITE_SETTINGS, resolveSettings, sanitizeSettings,
} from "../../services/settingsDefaults";
import {
  invalidSocialSetting, normalizeWhatsAppPhone, socialProfileHref, whatsappChannelHref,
} from "../../services/socialSafety";
import { resolvedV2SocialChannels } from "../SocialChannels";
import type { WebsiteSettings } from "../../types";

let passed = 0;
function test(name: string, run: () => void) { run(); console.log(`✓ ${name}`); passed++; }
const platforms = ["facebook", "instagram", "tiktok", "whatsapp"] as const;
const samples = {
  facebook: "https://www.facebook.com/alyq.shop",
  instagram: "https://www.instagram.com/alyq.shop/",
  tiktok: "https://www.tiktok.com/@alyq.shop",
  whatsapp: "+20 (100) 123-4567",
};
function settings(): WebsiteSettings {
  const copy = structuredClone(DEFAULT_WEBSITE_SETTINGS);
  copy.social_links = copy.social_links.map((row) => ({ ...row,
    enabled: true, url: samples[row.platform] }));
  copy.social = { ...copy.social, ...samples };
  return copy;
}

test("all four enabled channels resolve to their own safe profiles/conversation in EN and AR", () => {
  const input = settings();
  for (const language of ["en", "ar"] as const) {
    const channels = resolvedV2SocialChannels(input, language);
    assert.deepEqual(channels.map((entry) => entry.platform), platforms);
    for (const entry of channels) {
      assert.ok(entry.href.startsWith("https://"));
      assert.ok(entry.label.includes(dictionaries[language][`online.settings.${entry.platform}`]));
    }
    assert.equal(channels[3].href, "https://wa.me/201001234567");
  }
});

test("Facebook, Instagram, TikTok and WhatsApp each disappear when disabled, not just when empty", () => {
  for (const platform of platforms) {
    const input = settings();
    input.social_links = input.social_links.map((entry) => entry.platform === platform
      ? { ...entry, enabled: false } : entry);
    assert.ok(!resolvedV2SocialChannels(input, "en").some((entry) => entry.platform === platform), platform);
    assert.equal(resolvedV2SocialChannels(input, "en").length, 3);
  }
});

test("empty channels never render; old flat contacts still work without a duplicate settings group", () => {
  assert.deepEqual(resolvedV2SocialChannels(DEFAULT_WEBSITE_SETTINGS, "en"), []);
  const input = resolveSettings({ social: { facebook: "https://facebook.com/old-shop", whatsapp: "201001234567" },
    social_links: [] });
  assert.deepEqual(resolvedV2SocialChannels(input, "en").map((entry) => entry.platform), ["facebook", "whatsapp"]);
  input.social_links = [{ platform: "facebook", enabled: false, url: "https://facebook.com/old-shop",
    label_ar: "", label_en: "" }];
  assert.deepEqual(resolvedV2SocialChannels(input, "ar").map((entry) => entry.platform), ["whatsapp"],
    "an explicit disabled row wins even if the flat legacy value still exists");
});

test("platform-specific HTTPS profiles reject unsafe schemes, lookalikes, credentials and empty pages", () => {
  for (const platform of ["facebook", "instagram", "tiktok"] as const) {
    assert.ok(socialProfileHref(platform, samples[platform]));
    for (const invalid of ["", "javascript:alert(1)", "data:text/html,x", "http://facebook.com/shop",
      "https://evil.example/profile", "https://facebook.com.evil.example/shop",
      "https://user:pass@facebook.com/shop", "https://facebook.com/", " https://facebook.com/hi\n@evil.example"]) {
      assert.equal(socialProfileHref(platform, invalid), null, `${platform}: ${invalid}`);
    }
  }
  assert.equal(socialProfileHref("instagram", "https://tiktok.com/@alyq"), null);
  assert.equal(socialProfileHref("tiktok", "https://www.tiktok.com/@alyq.shop"), "https://www.tiktok.com/@alyq.shop");
});

test("WhatsApp strips presentation characters but never guesses a missing international country code", () => {
  assert.equal(normalizeWhatsAppPhone("+20 (100) 123-4567"), "201001234567");
  assert.equal(normalizeWhatsAppPhone("+20 (0)100-123-4567"), "201001234567");
  assert.equal(normalizeWhatsAppPhone("0020 100-123-4567"), "201001234567");
  assert.equal(normalizeWhatsAppPhone("201001234567"), "201001234567");
  assert.equal(normalizeWhatsAppPhone("+971 (50) 123-4567"), "971501234567");
  assert.equal(normalizeWhatsAppPhone("https://wa.me/201001234567"), "201001234567");
  for (const invalid of ["", "01001234567", "12345678", "+20 100", "+001234567890", "201001234567x123",
    "00100", "https://evil.example/201001234567", "http://wa.me/201001234567", "javascript:20",
    "https://wa.me/201001234567?redirect=https://evil.example", "+20)100(1234567"]) {
    assert.equal(normalizeWhatsAppPhone(invalid), null, invalid);
    assert.equal(whatsappChannelHref(invalid), null, invalid);
  }
});

test("bilingual Arabic/English contact prefill is URL-encoded and optional; old wa.me copy survives", () => {
  const input = settings();
  const ar = "مرحبًا، هل تتوفر القطعة؟ & التفاصيل / الرابط؟ ".repeat(9).trim();
  const en = "Hello, can we talk about the collection & sizes?";
  const whatsapp = input.social_links.find((row) => row.platform === "whatsapp")!;
  whatsapp.message_ar = ar;
  whatsapp.message_en = en;
  const arabic = resolvedV2SocialChannels(input, "ar").find((row) => row.platform === "whatsapp")!.href;
  const english = resolvedV2SocialChannels(input, "en").find((row) => row.platform === "whatsapp")!.href;
  assert.equal(new URL(arabic).searchParams.get("text"), ar);
  assert.equal(new URL(english).searchParams.get("text"), en);
  assert.ok(arabic.includes("%D9") && arabic.includes("%26") && english.includes("%26"));
  whatsapp.message_ar = "";
  whatsapp.message_en = "";
  assert.equal(resolvedV2SocialChannels(input, "en")[3].href, "https://wa.me/201001234567");
  assert.equal(whatsappChannelHref("https://wa.me/201001234567?text=Old%20copy"),
    "https://wa.me/201001234567?text=Old%20copy");
  assert.equal(whatsappChannelHref("+201001234567", "\ud800"), null, "bad Unicode never throws in href builder");
});

test("Admin validation refuses invalid/empty enabled rows, invalid legacy fields and oversized messages", () => {
  const input = settings();
  assert.equal(invalidSocialSetting(input), null);
  input.social_links[0].url = "https://instagram.com.evil.example/shop";
  assert.equal(invalidSocialSetting(input)?.platform, "instagram");
  assert.throws(() => sanitizeSettings(input), /Invalid instagram url/,
    "even direct repository callers cannot silently save a malformed social draft");
  input.social_links[0].url = "";
  input.social.instagram = "";
  assert.equal(invalidSocialSetting(input)?.reason, "required");
  input.social_links[0].enabled = false;
  assert.equal(invalidSocialSetting(input), null);
  input.social.facebook = "javascript:alert(1)";
  assert.equal(invalidSocialSetting(input)?.platform, "facebook");
  input.social.facebook = samples.facebook;
  input.social_links.find((row) => row.platform === "whatsapp")!.message_ar = "ا".repeat(801);
  assert.equal(invalidSocialSetting(input)?.field, "message");
});

test("Admin save → JSON reload → V2 EN/AR + appearance-only reset preserve all shared accounts/messages", () => {
  const draft = settings();
  const whatsapp = draft.social_links.find((row) => row.platform === "whatsapp")!;
  whatsapp.message_ar = "مرحبًا بك في المتجر";
  whatsapp.message_en = "Hello from the shop";
  draft.storefront_v2.footer_bg = "#0d1720";
  const saved = sanitizeSettings(draft);
  assert.equal(saved.social.whatsapp, "201001234567", "flat legacy phone is normalized for the existing SQL guard");
  const reloaded = resolveSettings(JSON.parse(JSON.stringify(saved)));
  assert.equal(resolvedV2SocialChannels(reloaded, "ar").length, 4);
  assert.equal(new URL(resolvedV2SocialChannels(reloaded, "ar")[3].href).searchParams.get("text"),
    "مرحبًا بك في المتجر");
  const reset = sanitizeSettings({ ...reloaded, storefront_v2: structuredClone(DEFAULT_STOREFRONT_V2_SETTINGS) });
  assert.deepEqual(reset.social, saved.social);
  assert.deepEqual(reset.social_links, saved.social_links);
  assert.equal(reset.footer.show_social, saved.footer.show_social);
  assert.equal(reset.storefront_v2.footer_bg, null);
});

test("stored unsafe settings fail closed in both languages without creating a fake account", () => {
  const stored = settings();
  stored.social_links.find((row) => row.platform === "tiktok")!.url = "https://tiktok.com.evil/@shop";
  stored.social.whatsapp = "01001234567";
  stored.social_links.find((row) => row.platform === "whatsapp")!.url = "01001234567";
  const loaded = resolveSettings(stored);
  for (const language of ["ar", "en"] as const) {
    const visible = resolvedV2SocialChannels(loaded, language);
    assert.deepEqual(visible.map((entry) => entry.platform), ["facebook", "instagram"]);
  }
});

console.log(`\n${passed}/${passed} social safety/ownership tests passed`);
