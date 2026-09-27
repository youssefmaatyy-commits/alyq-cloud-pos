#!/usr/bin/env node
/** Phase 2 Amendment 2: one shared Admin draft → Save → reload → V2 social
 * footer/contact; invalid-link rejection, EN/AR, enable/disable and V2 reset. */
import { createUxHarness } from "./lib/ux-harness.mjs";

const key = "alyq.demo.website_settings.v1";
const ux = await createUxHarness({ beforeImport: ({ localStorage }) => {
  localStorage.setItem("alyq.lang", "en");
  // Old shared fields predate Phase 45's switch rows; V2 must inherit them.
  localStorage.setItem(key, JSON.stringify({ settings: { social: {
    facebook: "https://facebook.com/legacy-shop", whatsapp: "201001234567",
  }, social_links: [] }, meta: null }));
} });
const { assert, dom, navigate, waitFor, clickEl, clickTestid, setReactValue, testid, readJson, signInAs } = ux;
const document = dom.window.document;
const saved = () => readJson(key)?.settings;
const row = (platform) => saved()?.social_links?.find((entry) => entry.platform === platform);
const group = (platform) => testid(`social-channel-${platform}`);
const value = (platform, next) => setReactValue(testid(`social-url-${platform}`), next);
const toggle = (platform) => {
  const control = group(platform)?.querySelector('[role="switch"]');
  assert.ok(control, `${platform} enable switch exists`);
  clickEl(control);
};
const link = (platform) => document.querySelector(`.v2-footer-social [data-platform="${platform}"]`);
const saveButton = () => [...document.querySelectorAll("button")].find((button) => button.textContent.trim() === "Save");
const save = async () => {
  await waitFor(() => saveButton() && !saveButton().disabled, { label: "Save button enabled" });
  clickEl(saveButton());
};
let passed = 0;
function check(name, condition) { assert.ok(condition, name); console.log(`  ✓ ${++passed}. ${name}`); }

await signInAs("admin");
await navigate("#/online/website?tab=v2", 750);
await waitFor(() => group("facebook") && testid("v2-draft-preview"), { label: "shared channel editor and V2 preview" });
check("all four channels editable in the V2 Studio, labelled Legacy + V2",
  ["facebook", "instagram", "tiktok", "whatsapp"].every((platform) => group(platform)) &&
  testid("v2-social-editor")?.textContent.includes("Legacy + V2"));
check("old shared Facebook and WhatsApp already show as inert draft icons",
  testid("v2-draft-preview").querySelectorAll('.v2-footer-social [data-platform]').length === 2 &&
  testid("v2-draft-preview").querySelectorAll(".v2-footer-social a").length === 0);
const first = JSON.stringify(saved());
value("facebook", "https://www.facebook.com/new-shop");
value("instagram", "javascript:alert(1)");
await waitFor(() => testid("social-validation-error") && testid("social-url-instagram").getAttribute("aria-invalid") === "true",
  { label: "unsafe social URL inline error" });
await save();
check("malformed profile blocks the entire save and leaves previous settings intact", JSON.stringify(saved()) === first);

// Issue #5 regression: the SAME still-invalid Instagram draft, but the admin
// is not on the Social tab at all — they switched to General to edit the
// store name, an edit that has nothing to do with social links. Before this
// fix, Save fell through to the generic `online.error.settings_invalid` toast
// ("some appearance values were invalid") no matter which tab was open, and
// gave no way to tell a real theme problem from a stale Instagram link. It
// must now name the exact platform, jump the admin to the Social tab to fix
// it, and leave every other still-invalid draft field (their unsaved store
// name edit included) exactly where they left it — nothing is saved half way.
await navigate("#/online/website?tab=general", 500);
const storeNameInput = () => [...document.querySelectorAll("label")]
  .find((label) => label.textContent?.trim().startsWith("Store name (English)"))
  ?.closest("div")?.querySelector("input");
await waitFor(() => storeNameInput(), { label: "General tab store-name field" });
setReactValue(storeNameInput(), "ALYQ Rebrand Draft");
await save();
check("an unrelated tab's Save is refused with the exact broken platform named, not a generic message",
  document.querySelector('[aria-live="polite"]')?.textContent?.includes("Instagram") ?? false);
check("refusal switches the admin straight to the Social tab that needs fixing",
  dom.window.location.hash.includes("tab=social"));
check("previous saved settings are untouched by the refused cross-tab save — no half-applied write",
  JSON.stringify(saved()) === first);
await navigate("#/online/website?tab=v2", 500);

value("instagram", "https://www.instagram.com/new.shop/");
toggle("instagram");
value("tiktok", "https://www.tiktok.com/@new.shop");
toggle("tiktok");
value("whatsapp", "01001234567");
await waitFor(() => testid("social-validation-error") && !testid("v2-draft-preview")
  .querySelector('.v2-footer-social [data-platform="whatsapp"]'), { label: "local phone refused in draft" });
await save();
check("WhatsApp without international prefix is rejected before save", JSON.stringify(saved()) === first);
value("whatsapp", "+20 (100) 123-4567");
const arabicMessage = "مرحبًا، أود معرفة تفاصيل القطعة والأسعار & المقاسات.";
setReactValue(testid("social-message-ar"), arabicMessage);
setReactValue(testid("social-message-en"), "Hello, I have a question about the pieces & sizes.");
await waitFor(() => !testid("social-validation-error") &&
  testid("v2-draft-preview").querySelectorAll('.v2-footer-social [data-platform]').length === 4,
  { label: "four safe draft icons before save" });
check("draft preview shows all four but persistence has not changed", JSON.stringify(saved()) === first &&
  testid("v2-draft-preview").textContent.includes("Chat on WhatsApp"));
await save();
await waitFor(() => saved()?.social_links?.length === 4 &&
  saved().social_links.every((entry) => entry.enabled) && saved().social.whatsapp === "201001234567",
  { label: "four shared channels and normalized number saved" });
const channels = structuredClone(saved().social_links);
check("one settings document stores four enable switches and bilingual prefill",
  channels.length === 4 && row("whatsapp").message_ar === arabicMessage &&
  saved().social.facebook === "https://www.facebook.com/new-shop" &&
  saved().social.whatsapp === "201001234567");
await navigate("#/store", 750);
await waitFor(() => link("whatsapp"), { label: "public V2 social footer" });
check("saved V2 footer renders exactly four recognizable brand SVG icons",
  document.querySelectorAll('.v2-footer-social a').length === 4 &&
  [...document.querySelectorAll('.v2-footer-social a')].every((anchor) => anchor.querySelector("svg")));
for (const platform of ["facebook", "instagram", "tiktok", "whatsapp"]) {
  const anchor = link(platform);
  check(`${platform} uses safe, labelled new-tab handling`, anchor?.href.startsWith("https://") &&
    anchor.target === "_blank" && anchor.rel.includes("noopener") && anchor.rel.includes("noreferrer") &&
    anchor.getAttribute("aria-label")?.includes(platform === "tiktok" ? "TikTok" :
      platform === "whatsapp" ? "WhatsApp" : platform === "instagram" ? "Instagram" : "Facebook"));
}
check("WhatsApp footer icon and one deliberate contact action share encoded English prefill",
  link("whatsapp").getAttribute("href") === testid("v2-whatsapp-contact")?.getAttribute("href") &&
  new URL(link("whatsapp").href).searchParams.get("text") === "Hello, I have a question about the pieces & sizes.");
clickEl(document.querySelector('.v2-header .v2-language-button'));
await waitFor(() => testid("store-v2")?.getAttribute("dir") === "rtl", { label: "public Arabic RTL" });
check("Arabic RTL uses its own encoded message and translated WhatsApp action",
  new URL(link("whatsapp").href).searchParams.get("text") === arabicMessage &&
  testid("v2-whatsapp-contact")?.textContent.includes("واتساب") &&
  link("facebook")?.getAttribute("aria-label")?.includes("فيسبوك"));
clickEl(document.querySelector('.v2-header .v2-language-button'));
await waitFor(() => testid("store-v2")?.getAttribute("dir") === "ltr", { label: "English LTR restored" });

// Reopen from storage, not the in-memory React draft; appearance reset must
// leave shared social/contact untouched even after another Save.
await navigate("#/online/website?tab=v2", 750);
await waitFor(() => group("whatsapp"), { label: "reloaded editor" });
check("Admin reload restores four channel values and WhatsApp copy",
  testid("social-url-instagram").value === "https://www.instagram.com/new.shop/" &&
  testid("social-message-ar").value === arabicMessage);
clickTestid("v2-reset-open");
await waitFor(() => testid("v2-reset-confirm"), { label: "V2 reset confirmation" });
clickTestid("v2-reset-confirm");
await waitFor(() => testid("v2-hex-header_bg")?.value === "", { label: "V2 appearance reset draft" });
check("V2-only reset has not touched the saved shared social rows", JSON.stringify(saved().social_links) === JSON.stringify(channels));
// Make the appearance reset a real write even when no V2 override was set.
setReactValue(testid("v2-hex-header_bg"), "#123456");
await save();
await waitFor(() => saved()?.storefront_v2?.header_bg === "#123456", { label: "V2 appearance first save" });
clickTestid("v2-reset-open");
await waitFor(() => testid("v2-reset-confirm"), { label: "V2 reset confirmation after save" });
clickTestid("v2-reset-confirm");
await save();
await waitFor(() => saved()?.storefront_v2?.header_bg === null, { label: "V2 appearance reset saved" });
check("saved V2-only reset preserves shared accounts, messages and footer switch",
  JSON.stringify(saved().social_links) === JSON.stringify(channels) && saved().footer.show_social === true);
await waitFor(() => saveButton()?.disabled && !saveButton()?.querySelector(".animate-spin"),
  { label: "V2 reset save fully settled" });

// Disable all four through the very same shared UI and save once. The existing
// legacy flat keys also become empty (without discarding saved row URLs).
for (const platform of ["facebook", "instagram", "tiktok", "whatsapp"]) toggle(platform);
await waitFor(() => !testid("v2-draft-preview").querySelector('.v2-footer-social [data-platform]') &&
  !testid("v2-draft-preview").textContent.includes("راسلنا على واتساب"), { label: "draft channels hidden" });
await save();
await waitFor(() => saved()?.social_links?.every((entry) => !entry.enabled), { label: "disabled rows persisted" });
check("disabling preserves row URLs/messages while hiding shared legacy flat channels",
  saved().social_links.every((entry) => Boolean(entry.url)) && saved().social.whatsapp === "" &&
  saved().social.facebook === "" && saved().social_links.find((entry) => entry.platform === "whatsapp").message_ar === arabicMessage);
await navigate("#/store", 700);
check("disabled channels have no footer icon or WhatsApp contact action after reload",
  !document.querySelector(".v2-footer-social a") && !testid("v2-whatsapp-contact"));
await navigate("#/store/contact", 650);
check("canonical V2 Contact also hides disabled shared channels",
  Boolean(testid("v2-contact")) && !document.querySelector('.v2-contact-channels a') &&
  !document.querySelector('a[aria-label="Facebook"]') && !document.querySelector('a[aria-label="WhatsApp"]'));
await navigate("#/pos", 650);
check("POS remains outside the V2 presentation scope", !testid("store-v2") &&
  !document.querySelector('[data-testid="v2-social-icons"]'));
console.log(`\n${passed} Phase 2 Amendment 2 Admin/social DOM checks passed.`);
ux.finish("V2 social/contact Admin draft, safe Save/reload, EN/AR, V2 reset and POS isolation");
