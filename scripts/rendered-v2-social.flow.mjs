#!/usr/bin/env node
/** Amendment 2, real Chromium: shared Admin draft -> Save/reload -> V2 footer,
 * EN/LTR and AR/RTL at every requested width, keyboard/touch/contrast, a light
 * and a dark footer, long links/messages, disable, legacy and POS isolation.
 * A local demo-mode Vite server must be running. Screenshots are ignored. */
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "@playwright/test";
import { assertRenderedArabicFont } from "./lib/rendered-arabic-font.mjs";

const base = process.env.V2_VISUAL_BASE_URL || "http://127.0.0.1:4317";
const output = "coverage/visual-v2-social";
const widths = [320, 360, 375, 390, 414, 430, 768, 820, 1024, 1280, 1366, 1440, 1920];
const platforms = ["facebook", "instagram", "tiktok", "whatsapp"];
const english = "Hello! I would like to know more about sizes and the pieces & delivery options.";
const arabic = "مرحباً، أرغب في معرفة تفاصيل المجموعة والمقاسات والتوصيل. ".repeat(9).trim();
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE || undefined,
  args: ["--no-sandbox", "--disable-dev-shm-usage"], ignoreDefaultArgs: ["--hide-scrollbars"] });
const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, locale: "en-US" });
const page = await context.newPage();
page.setDefaultTimeout(30_000);
const failures = [];
page.on("pageerror", (error) => failures.push(`pageerror: ${error.message}`));
page.on("console", (message) => { if (message.type() === "error") failures.push(`console: ${message.text()}`); });
page.on("response", (response) => {
  if (response.status() >= 400 && response.url().startsWith(base)) failures.push(`${response.status()} ${response.url()}`);
});
const go = async (hash, selector) => {
  await page.goto(`${base}/${hash}`, { timeout: 120_000 });
  if (selector) await page.locator(selector).first().waitFor({ timeout: 60_000 });
};
const save = async () => {
  const button = page.getByRole("button", { name: "Save", exact: true });
  await button.click();
  await button.waitFor({ state: "visible" });
};
const saved = () => page.evaluate(() => JSON.parse(localStorage.getItem("alyq.demo.website_settings.v1"))?.settings);
const ratio = (left, right) => {
  const brightness = (color) => {
    const components = color.match(/[\d.]+/g)?.slice(0, 3).map(Number);
    assert.ok(components?.length === 3, `color ${color} is RGB`);
    return components.map((value) => {
      const v = value / 255;
      return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    }).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
  };
  const [a, b] = [brightness(left), brightness(right)].sort((x, y) => y - x);
  return (a + 0.05) / (b + 0.05);
};
const publicGeometry = () => page.evaluate(() => {
  const root = document.querySelector(".store-v2");
  const footer = root?.querySelector(".v2-footer");
  const group = footer?.querySelector(".v2-footer-social");
  const anchors = [...(group?.querySelectorAll("a[data-platform]") ?? [])];
  const waAction = root?.querySelector('[data-testid="v2-whatsapp-contact"]');
  const rect = (node) => {
    const box = node.getBoundingClientRect();
    return { x: box.x, right: box.right, width: box.width, height: box.height };
  };
  return {
    dir: root?.getAttribute("dir"), overflow: document.documentElement.scrollWidth - innerWidth,
    groupName: group?.getAttribute("aria-label"),
    background: footer && getComputedStyle(footer).backgroundColor,
    entries: anchors.map((node) => ({ platform: node.dataset.platform, href: node.href,
      label: node.getAttribute("aria-label"), target: node.target, rel: node.rel,
      icon: Boolean(node.querySelector("svg")), color: getComputedStyle(node).color,
      ...rect(node), svg: node.querySelector("svg")?.getBoundingClientRect().width })),
    whatsAppEntries: [...root.querySelectorAll('a[href*="wa.me/"]')].length,
    action: waAction && { href: waAction.href, label: waAction.getAttribute("aria-label"),
      text: waAction.textContent, target: waAction.target, rel: waAction.rel, ...rect(waAction) },
  };
});

try {
  await go("#/", 'input[autocomplete="username"]');
  await page.locator('input[autocomplete="username"]').fill("admin");
  await page.locator('input[type="password"]').fill("alyq1234");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByTestId("shell-brand").waitFor();
  await go("#/online/website?tab=v2", '[data-testid="v2-studio"]');
  const original = JSON.stringify(await saved());
  for (const platform of platforms) {
    const switchButton = page.getByTestId(`social-channel-${platform}`).getByRole("switch");
    if (await switchButton.getAttribute("aria-checked") !== "true") await switchButton.click();
  }
  await page.getByTestId("social-url-facebook").fill("https://www.facebook.com/new.shop/" + "?ref=" + "a".repeat(220));
  await page.getByTestId("social-url-instagram").fill("javascript:alert(1)");
  await save();
  assert.equal(JSON.stringify(await saved()), original, "one unsafe channel refuses the whole Save");
  assert.equal(await page.getByTestId("social-url-instagram").getAttribute("aria-invalid"), "true");
  console.log("✓ real Admin rejects unsafe profile without publishing another channel");
  await page.getByTestId("social-url-instagram").fill("https://www.instagram.com/new.shop/?ref=" + "b".repeat(210));
  await page.getByTestId("social-url-tiktok").fill("https://www.tiktok.com/@new.shop");
  await page.getByTestId("social-url-whatsapp").fill("+20 (100) 123-4567");
  await page.getByTestId("social-message-en").fill(english);
  await page.getByTestId("social-message-ar").fill(arabic);
  await page.getByTestId("v2-hex-footer_bg").fill("#161a25");
  await page.getByTestId("v2-hex-footer_link").fill("#161a25"); // deliberately low contrast
  const preview = page.getByTestId("v2-draft-preview");
  await preview.locator('.v2-footer-social [data-platform="whatsapp"]').waitFor();
  assert.equal(await preview.locator('.v2-footer-social [data-platform]').count(), 4);
  assert.equal(await preview.locator('.v2-footer-social a').count(), 0, "draft icons are never outbound");
  assert.equal(JSON.stringify(await saved()), original, "preview is unpublished");
  await page.getByTestId("v2-preview-ar").click();
  assert.equal(await preview.locator(".store-v2").getAttribute("dir"), "rtl");
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: width <= 390 ? 780 : 960 });
    // The Admin shell animates its sidebar padding for 200 ms after a
    // breakpoint change. Measure the settled layout rather than one frame of
    // the old desktop padding at a new 320 px viewport.
    await page.waitForFunction(() => {
      const el = document.querySelector('[data-testid="v2-draft-preview"] .store-v2');
      return el && el.scrollWidth <= el.clientWidth + 1 && document.documentElement.scrollWidth <= innerWidth + 1;
    }, null, { timeout: 5_000 });
  }
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.getByTestId("v2-preview-en").click();
  await save();
  await page.waitForFunction(() => {
    const current = JSON.parse(localStorage.getItem("alyq.demo.website_settings.v1"))?.settings;
    return current?.social_links?.length === 4 &&
      current.social_links.every((item) => item.enabled) && current.social.whatsapp === "201001234567" &&
      current.storefront_v2?.footer_bg === "#161a25";
  });
  assert.equal((await saved()).social_links.find((item) => item.platform === "whatsapp")?.message_ar, arabic);
  await page.reload();
  assert.equal(await page.getByTestId("social-message-ar").inputValue(), arabic, "reload restores long Arabic prefill");
  assert.equal(await page.getByTestId("social-url-instagram").inputValue(),
    "https://www.instagram.com/new.shop/?ref=" + "b".repeat(210));
  console.log("✓ inert bilingual draft, then shared Save/reload with long profile links and long Arabic copy");

  let cases = 0;
  for (const lang of ["en", "ar"]) {
    await page.evaluate((language) => localStorage.setItem("alyq.lang", language), lang);
    await go("#/store", '[data-testid="store-v2"]');
    await page.reload(); // I18nProvider reads the preference on fresh boot
    await page.locator('.v2-footer-social a[data-platform="whatsapp"]').waitFor();
    if (lang === "ar") await assertRenderedArabicFont(page);
    for (const width of widths) {
      await page.setViewportSize({ width, height: width <= 414 ? 780 : 960 });
      const observed = await publicGeometry();
      assert.equal(observed.dir, lang === "ar" ? "rtl" : "ltr", `${lang}/${width}: page direction`);
      assert.ok(observed.overflow <= 1, `${lang}/${width}: no horizontal document overflow (${observed.overflow}px)`);
      assert.ok(observed.groupName && observed.entries.length === 4, `${lang}/${width}: named four-channel group`);
      assert.equal(observed.whatsAppEntries, 2, `${lang}/${width}: footer icon and one contact entry, no floating duplicate`);
      assert.ok(observed.action?.label && observed.action.height >= 44, `${lang}/${width}: accessible contact target`);
      assert.ok(observed.action.x >= -1 && observed.action.right <= width + 1, `${lang}/${width}: contact fits viewport`);
      const whatsapp = observed.entries.find((entry) => entry.platform === "whatsapp");
      assert.equal(observed.action.href, whatsapp.href, `${lang}/${width}: identical prefill URLs`);
      assert.equal(new URL(whatsapp.href).searchParams.get("text"), lang === "ar" ? arabic : english);
      assert.ok(ratio(observed.background, whatsapp.color) >= 4.5, `${lang}/${width}: footer link contrast`);
      for (const [index, platform] of platforms.entries()) {
        const entry = observed.entries[index];
        assert.equal(entry.platform, platform, `${lang}/${width}: icon order`);
        assert.ok(entry.href.startsWith("https://") && entry.icon && entry.svg >= 20,
          `${lang}/${width}: safe, recognizable ${platform} SVG`);
        assert.ok(entry.label && entry.target === "_blank" && entry.rel.includes("noopener") && entry.rel.includes("noreferrer"),
          `${lang}/${width}: labelled safe new-tab ${platform}`);
        assert.ok(entry.width >= 44 && entry.height >= 44 && entry.x >= -1 && entry.right <= width + 1,
          `${lang}/${width}: ${platform} touch area fits viewport`);
      }
      if ([320, 1440].includes(width)) {
        await page.locator(".v2-footer-social").scrollIntoViewIfNeeded();
        await page.screenshot({ path: `${output}/social-${lang}-${width}-dark.png`, fullPage: true });
      }
      cases++;
    }
    await page.keyboard.press("Tab");
    await page.locator('.v2-footer-social a[data-platform="facebook"]').focus();
    assert.equal(await page.locator('.v2-footer-social a[data-platform="facebook"]').evaluate((el) =>
      el.matches(":focus-visible") && getComputedStyle(el).outlineStyle !== "none"), true,
    `${lang}: keyboard focus remains visible on an icon`);
    console.log(`✓ ${lang === "ar" ? "AR/RTL" : "EN/LTR"}: ${widths.length} widths, four touch-friendly accessible safe icons, WhatsApp prefill, no overflow`);
  }
  console.log(`✓ ${cases}/${widths.length * 2} real-browser V2 dark-footer width/language combinations`);

  // A light footer with an owner-entered white-on-white link is adapted to a
  // legible color. Shared accounts and messages must not be edited by this.
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.evaluate(() => localStorage.setItem("alyq.lang", "en"));
  await go("#/online/website?tab=v2", '[data-testid="v2-studio"]');
  await page.reload();
  await page.getByTestId("v2-studio").waitFor();
  const shared = JSON.stringify((await saved()).social_links);
  await page.getByTestId("v2-hex-footer_bg").fill("#fcfbf6");
  await page.getByTestId("v2-hex-footer_link").fill("#ffffff");
  await save();
  await page.waitForFunction(() => JSON.parse(localStorage.getItem("alyq.demo.website_settings.v1"))?.settings?.storefront_v2?.footer_bg === "#fcfbf6");
  assert.equal(JSON.stringify((await saved()).social_links), shared);
  for (const lang of ["en", "ar"]) {
    await page.evaluate((language) => localStorage.setItem("alyq.lang", language), lang);
    await go("#/store", '[data-testid="store-v2"]');
    await page.reload();
    await page.locator('.v2-footer-social a[data-platform="whatsapp"]').waitFor();
    for (const width of [320, 1440]) {
      await page.setViewportSize({ width, height: 860 });
      const observed = await publicGeometry();
      assert.equal(observed.entries.length, 4);
      assert.ok(observed.overflow <= 1, `light footer ${lang}/${width}: no overflow`);
      assert.ok(ratio(observed.background, observed.entries[0].color) >= 4.5,
        `light footer ${lang}/${width}: icon contrast adapted`);
      await page.locator(".v2-footer-social").scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${output}/social-${lang}-${width}-light.png`, fullPage: true });
    }
  }
  console.log("✓ light and dark configured footers preserve contrast and shared social fields");

  // The shared editor itself is bilingual, not just the public footer. Its
  // Arabic copy must still distinguish the shared accounts from V2-only reset.
  await go("#/online/website?tab=v2", '[data-testid="v2-studio"]');
  await page.reload();
  await page.getByTestId("v2-social-editor").waitFor();
  const arabicEditor = await page.getByTestId("v2-social-editor").innerText();
  assert.ok(arabicEditor.includes("مشترك · القديم + V2") &&
    arabicEditor.includes("رسالة واتساب الافتراضية (العربية)") &&
    arabicEditor.includes("إعادة مظهر V2"), "Arabic Admin explains ownership and prefill");
  assert.equal(await page.getByTestId("social-message-ar").inputValue(), arabic);
  console.log("✓ Arabic Admin social editor labels the shared owner and bilingual WhatsApp copy");

  await page.evaluate(() => localStorage.setItem("alyq.lang", "en"));
  await go("#/online/website?tab=v2", '[data-testid="v2-studio"]');
  await page.reload();
  await page.getByTestId("v2-studio").waitFor();
  for (const platform of platforms) {
    const switchButton = page.getByTestId(`social-channel-${platform}`).getByRole("switch");
    assert.equal(await switchButton.getAttribute("aria-checked"), "true");
    await switchButton.click();
  }
  await preview.locator('.v2-footer-social [data-platform]').first().waitFor({ state: "detached" });
  await save();
  await page.waitForFunction(() => JSON.parse(localStorage.getItem("alyq.demo.website_settings.v1"))?.settings?.social_links?.every((item) => !item.enabled));
  assert.ok((await saved()).social_links.every((item) => item.url), "turning off never deletes saved accounts");
  for (const lang of ["en", "ar"]) {
    await page.evaluate((language) => localStorage.setItem("alyq.lang", language), lang);
    await go("#/store", '[data-testid="store-v2"]');
    await page.reload();
    await page.locator('.v2-footer').waitFor();
    for (const width of [320, 1440]) {
      await page.setViewportSize({ width, height: 860 });
      const observed = await publicGeometry();
      assert.equal(observed.entries.length, 0, `disabled ${lang}/${width}: no icons`);
      assert.equal(observed.whatsAppEntries, 0, `disabled ${lang}/${width}: no WhatsApp action`);
      assert.ok(observed.overflow <= 1);
    }
  }
  await go("#/store/contact", '[data-testid="v2-contact"]');
  assert.equal(await page.getByTestId("store-v2").count(), 1, "canonical contact uses V2 and hides disabled channels");
  assert.equal(await page.locator('.v2-contact-channels a').count(), 0);
  await go("#/pos", '[data-testid="pos-scan-search"]');
  assert.equal(await page.getByTestId("store-v2").count(), 0, "POS remains outside V2");
  assert.deepEqual(failures, [], "browser had no page errors, console errors or 4xx on the preview server");
  console.log("✓ enable → disable survives canonical reload EN/AR; Contact and POS remain isolated; no browser errors");
  console.log("✓ Chromium screenshots: coverage/visual-v2-social (eight dark/light widths and languages)");
} finally {
  await browser.close();
}
