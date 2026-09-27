#!/usr/bin/env node
/** Phase 2 real-Chromium acceptance: actual Admin save → reload → configured
 * V2 appearance, EN/AR at all thirteen release widths, 1/2 phone columns, ticker direction &
 * reduced motion, exact variants, canonical routes and POS isolation. Run with a local
 * demo-mode Vite server. Screenshots go to ignored coverage/visual-v2-phase2. */
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "@playwright/test";
import { assertRenderedArabicFont } from "./lib/rendered-arabic-font.mjs";

const base = process.env.V2_VISUAL_BASE_URL || "http://127.0.0.1:4317";
const output = "coverage/visual-v2-phase2";
const widths = [320, 360, 375, 390, 414, 430, 768, 820, 1024, 1280, 1366, 1440, 1920];
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE || undefined,
  args: ["--no-sandbox", "--disable-dev-shm-usage"], ignoreDefaultArgs: ["--hide-scrollbars"] });
const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, locale: "en-US" });
const page = await context.newPage();
page.setDefaultTimeout(30_000);
const failures = [];
page.on("pageerror", (error) => failures.push(`pageerror: ${error.message}`));
page.on("console", (msg) => { if (msg.type() === "error") failures.push(`console: ${msg.text()}`); });
page.on("response", (res) => { if (res.status() >= 400 && res.url().startsWith(base)) failures.push(`${res.status()} ${res.url()}`); });
const go = async (hash, selector) => {
  await page.goto(`${base}/${hash}`, { timeout: 120_000 });
  if (selector) await page.locator(selector).first().waitFor({ timeout: 60_000 });
};

try {
  await go("#/", 'input[autocomplete="username"]');
  await page.locator('input[autocomplete="username"]').fill("admin");
  await page.locator('input[type="password"]').fill("alyq1234");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByTestId("shell-brand").waitFor();
  // Signing in to POS does not load public catalogue settings. Visit the shop
  // first so the isolated demo profile has its actual persisted settings row.
  await go("#/store", '[data-testid="v2-home"]');
  await page.getByTestId("v2-card-prd-1001").waitFor();
  // A fixture restricted to this browser profile: existing shared settings,
  // including a 2-message announcement, and a real ring with exact variants.
  const variantId = await page.evaluate(() => {
    const key = "alyq.demo.website_settings.v1";
    const row = JSON.parse(localStorage.getItem(key));
    row.settings.announcement = { ...row.settings.announcement, enabled: true, mode: "scroll", interval_ms: 4000,
      messages: [
        { id: "studio-first", enabled: true, text_en: "First collection", text_ar: "التشكيلة الأولى",
          href: "#/store/products", cta_en: "View", cta_ar: "عرض" },
        { id: "studio-second", enabled: true, text_en: "Second collection", text_ar: "التشكيلة الثانية",
          href: "", cta_en: "", cta_ar: "" },
      ] };
    row.settings.product_card.mobile_columns = 2;
    delete row.settings.storefront_v2; // backwards-compatible old settings row
    localStorage.setItem(key, JSON.stringify(row));
    const catalogKey = "alyq.demo.catalog.v1";
    const catalog = JSON.parse(localStorage.getItem(catalogKey));
    const ring = catalog.products.find((item) => item.sku === "ALYQ-1002");
    ring.variants_enabled = true;
    ring.stock_quantity = 5;
    ring.low_stock_level = 1;
    const shelf = (id, color, size, label, stock) => ({
      id, product_id: ring.id, sku: `V2-STUDIO-${color}-${label || size}`, barcode: null,
      color_key: color, color_en: color === "gold" ? "Gold" : "Silver",
      color_ar: color === "gold" ? "ذهبي" : "فضي", color_hex: color === "gold" ? "#cba556" : "#c9c9c9",
      size, size_label: label, image_url: null, price_override: null, cost_override: null,
      stock_quantity: stock, low_stock_level: 1, active: true, sort_order: 1,
      created_at: ring.created_at, updated_at: ring.updated_at,
    });
    catalog.variants = [
      ...catalog.variants.filter((item) => item.product_id !== ring.id),
      shelf("4fb4125a-0f26-461e-8a94-31e365342101", "gold", 17, null, 2),
      shelf("4fb4125a-0f26-461e-8a94-31e365342102", "gold", 18, null, 0),
      shelf("4fb4125a-0f26-461e-8a94-31e365342103", "silver", null, "XS", 1),
      shelf("4fb4125a-0f26-461e-8a94-31e365342104", "silver", 16.5, null, 2),
    ];
    localStorage.setItem(catalogKey, JSON.stringify(catalog));
    return ring.id;
  });
  await page.reload();
  await go("#/online/website?tab=v2", '[data-testid="v2-studio"]');
  const preview = page.getByTestId("v2-draft-preview").locator(".store-v2");
  const beforeSave = await page.evaluate(() => localStorage.getItem("alyq.demo.website_settings.v1"));
  await page.getByTestId("v2-hex-header_bg").fill("#fefefe");
  await page.getByTestId("v2-hex-header_text").fill("#fefefe");
  await page.getByTestId("v2-hex-page_bg").fill("#101820");
  await page.getByTestId("v2-hex-surface_bg").fill("#eeeeee");
  await page.getByTestId("v2-hex-button_bg").fill("#eeeeee");
  await page.getByTestId("v2-hex-button_text").fill("#eeeeee");
  await page.getByTestId("v2-hex-footer_bg").fill("#202427");
  await page.getByTestId("v2-hex-badge_bg").fill("#a48d59");
  await page.getByTestId("v2-button-style").selectOption("square");
  await page.getByTestId("v2-badge-style").selectOption("pill");
  await page.getByTestId("v2-mobile-columns").selectOption("1");
  await page.getByTestId("v2-logo_height").fill("62");
  await page.getByTestId("v2-mobile_logo_height").fill("52");
  await page.getByTestId("v2-body-font").selectOption("modern");
  await page.getByTestId("v2-display-font").selectOption("classic");
  await page.getByTestId("v2-studio").locator('input[aria-label="Image URL"]').fill("/brand/hero-editorial-mobile.jpg");
  await page.getByTestId("v2-studio").getByRole("button", { name: "Use URL" }).click();
  await page.waitForFunction(() => document.querySelector('[data-testid="v2-draft-preview"] .store-v2')?.style.getPropertyValue("--v2-header-bg") === "#fefefe");
  assert.equal(await preview.evaluate((element) => element.style.getPropertyValue("--v2-button-radius")), "0px");
  assert.equal(await page.evaluate(() => localStorage.getItem("alyq.demo.website_settings.v1")), beforeSave,
    "draft preview cannot publish before Save");
  for (const width of widths) {
    await page.setViewportSize({ width, height: 900 });
    await page.getByTestId("v2-draft-preview").scrollIntoViewIfNeeded();
    const sample = await page.getByTestId("v2-draft-preview").evaluate((node) => ({
      documentWidth: document.documentElement.scrollWidth,
      bounds: node.getBoundingClientRect().toJSON(),
      logoHeight: node.querySelector(".v2-logo img")?.getBoundingClientRect().height,
    }));
    assert.ok(sample.documentWidth <= width + 1 && sample.bounds.left >= -1 && sample.bounds.right <= width + 1,
      `${width}: V2 editor's draft preview fits within the Admin viewport`);
    assert.ok(Math.abs(sample.logoHeight - 52) < 2, `${width}: mobile preview samples the V2 mobile logo height`);
    if ([320, 1440].includes(width)) await page.getByTestId("v2-draft-preview")
      .screenshot({ path: `${output}/admin-draft-en-${width}.png` });
  }
  await page.getByTestId("v2-preview-desktop").click();
  assert.equal(await preview.getAttribute("data-device"), "desktop");
  await page.getByTestId("v2-preview-ar").click();
  assert.equal(await preview.getAttribute("dir"), "rtl", "V2 draft can be previewed in Arabic independently");
  await page.getByTestId("v2-preview-en").click();
  await page.getByTestId("v2-preview-mobile").click();
  console.log(`✓ draft preview fits Admin at ${widths.length} release widths, simulates logo size and switches desktop/RTL`);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.waitForFunction(() => JSON.parse(localStorage.getItem("alyq.demo.website_settings.v1"))?.settings?.storefront_v2?.header_bg === "#fefefe");
  await go("#/store", '[data-testid="v2-home"]');
  await page.reload({ timeout: 120_000 });
  await page.getByTestId("v2-home").waitFor();
  assert.equal(await page.locator(".store-v2").evaluate((el) => el.style.getPropertyValue("--v2-bg")), "#101820");
  console.log("✓ real Admin draft → Save → browser reload → V2 appearance tokens");

  let viewportCases = 0;
  for (const lang of ["en", "ar"]) {
    await page.evaluate((language) => localStorage.setItem("alyq.lang", language), lang);
    await page.reload();
    if (lang === "ar") await assertRenderedArabicFont(page);
    for (const width of widths) {
      await page.setViewportSize({ width, height: width <= 414 ? 780 : width === 768 ? 900 : 960 });
      for (const [route, marker] of [
        ["#/store", '[data-testid="v2-home"]'],
        ["#/store/products", '[data-testid="v2-catalog"]'],
      ]) {
        await go(route, marker);
        const observed = await page.evaluate(() => {
          const root = document.querySelector(".store-v2");
          const grid = document.querySelector("main .v2-product-grid");
          const header = document.querySelector(".v2-header-inner");
          const logo = document.querySelector(".v2-logo");
          const track = document.querySelector(".v2-announcement-track");
          // Issue #1 (6th follow-up round): the live storefront header no
          // longer ever renders a logo <img>, regardless of any saved
          // images.logo_url/mobile_logo_url — it always shows the gold text
          // wordmark instead. (The admin's own settings-studio draft
          // preview below is a separate component and still shows a
          // configured image, so admins can preview an upload before
          // publishing — that is asserted elsewhere in this file.)
          const logoImage = document.querySelector(".v2-logo img");
          const wordmarkColour = logo.querySelector(".v2-wordmark-primary")
            ? getComputedStyle(logo.querySelector(".v2-wordmark-primary")).color : null;
          const head = header.getBoundingClientRect();
          const brand = logo.getBoundingClientRect();
          const varOf = (name) => getComputedStyle(root).getPropertyValue(name).trim();
          return {
            dir: root.dir, pageWidth: document.documentElement.scrollWidth,
            columns: getComputedStyle(grid).gridTemplateColumns.split(" ").length,
            header: { left: head.left, right: head.right, top: head.top, bottom: head.bottom },
            logo: { left: brand.left, right: brand.right, top: brand.top, bottom: brand.bottom },
            hasLogoImage: Boolean(logoImage), wordmarkColour,
            bg: varOf("--v2-bg"), headerBg: varOf("--v2-header-bg"), buttonRadius: varOf("--v2-button-radius"),
            badgeRadius: varOf("--v2-badge-radius"),
            motion: track && getComputedStyle(track).animationName,
            hiddenLinks: document.querySelectorAll('.v2-announcement-copy[aria-hidden="true"] a').length,
          };
        });
        const label = `${lang}/${width}/${route}`;
        assert.equal(observed.dir, lang === "ar" ? "rtl" : "ltr", `${label} locale`);
        assert.ok(observed.pageWidth <= width + 1, `${label} no page overflow: ${JSON.stringify(observed)}`);
        assert.equal(observed.columns, width < 640 ? 1 : width < 1024 ? 3 : 4,
          `${label} V2 one-column mobile override, shared tablet/desktop columns`);
        assert.ok(observed.logo.left >= -1 && observed.logo.right <= width + 1 &&
          observed.logo.top >= observed.header.top - 1 && observed.logo.bottom <= observed.header.bottom + 1,
          `${label} text wordmark stays within header`);
        assert.equal(observed.hasLogoImage, false, `${label} the live header never renders a logo image, only the gold text wordmark`);
        assert.equal(observed.wordmarkColour, "rgb(164, 141, 89)", `${label} header wordmark renders in the configured gold accent colour`);
        assert.equal(observed.bg, "#101820", `${label} saved V2 page colour`);
        assert.equal(observed.headerBg, "#fefefe", `${label} saved V2 header colour`);
        assert.equal(observed.buttonRadius, "0px", `${label} saved V2 button style`);
        assert.equal(observed.badgeRadius, "9999px", `${label} saved V2 badge style`);
        assert.equal(observed.motion, lang === "ar" ? "v2TickerRtl" : "v2Ticker", `${label} ticker direction`);
        assert.equal(observed.hiddenLinks, 0, `${label} duplicate ticker is not interactive`);
        if ([320, 390, 768, 1440, 1920].includes(width) && route === "#/store") {
          await page.evaluate(() => window.scrollTo(0, 0));
          await page.screenshot({ path: `${output}/v2-${lang}-${width}-one-column.png`, fullPage: true });
        }
        viewportCases++;
      }
      console.log(`✓ V2 saved overrides ${lang}/${width}: 1 phone column or 3/4 larger, ticker, logo, no overflow`);
    }
  }
  // A keyboard-focused link or hover pauses the ticker. Reduced-motion media
  // queries remove the animation and render every message statically once.
  await page.setViewportSize({ width: 390, height: 780 });
  await go("#/store", '[data-testid="v2-announcement-track"]');
  const messageLink = page.locator('.v2-announcement-copy:not([aria-hidden]) a').first();
  await messageLink.focus();
  assert.equal(await page.locator(".v2-announcement-track").evaluate((node) => getComputedStyle(node).animationPlayState), "paused");
  await page.emulateMedia({ reducedMotion: "reduce" });
  const reduced = await page.evaluate(() => ({
    animation: getComputedStyle(document.querySelector(".v2-announcement-track")).animationName,
    duplicate: getComputedStyle(document.querySelector('.v2-announcement-copy[aria-hidden="true"]')).display,
    first: [...document.querySelectorAll('.v2-announcement-copy:not([aria-hidden]) .v2-announcement-item')]
      .map((el) => ({ display: getComputedStyle(el).display, text: el.textContent.trim() })),
  }));
  assert.equal(reduced.animation, "none");
  assert.equal(reduced.duplicate, "none");
  assert.equal(reduced.first.length, 2);
  assert.ok(reduced.first.every((item) => item.display !== "none" && item.text));
  await page.emulateMedia({ reducedMotion: "no-preference" });
  console.log("✓ LTR/RTL ticker pauses on keyboard focus; reduced motion shows all messages without animation");

  // Exact variants remain selectable at every requested width under custom V2
  // colours and a one-column mobile grid, without any inventory/order writes.
  let variants = 0;
  for (const lang of ["en", "ar"]) {
    await page.evaluate((language) => localStorage.setItem("alyq.lang", language), lang);
    await go(`#/store/products/${variantId}`, '[data-testid="v2-product"]');
    await page.reload();
    await page.getByTestId("v2-color-gold").waitFor();
    for (const width of widths) {
      await page.setViewportSize({ width, height: width <= 414 ? 780 : 960 });
      await page.getByTestId("v2-color-gold").click();
      assert.equal(await page.getByTestId("v2-size-18").isDisabled(), true);
      assert.equal(await page.getByTestId("v2-size-XS").count(), 0);
      await page.getByTestId("v2-size-17").click();
      assert.equal(await page.getByTestId("v2-pdp-add").isEnabled(), true);
      await page.getByTestId("v2-color-silver").click();
      assert.equal(await page.getByTestId("v2-pdp-add").isDisabled(), true);
      await page.getByTestId("v2-size-XS").click();
      assert.equal(await page.getByTestId("v2-pdp-add").isEnabled(), true);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      variants++;
    }
  }
  console.log(`✓ ${variants}/${widths.length * 2} exact-variant PDP cases under customized V2`);

  // Change only V2 columns through Admin, save, reload, and verify both safe
  // phone choices across EN/AR without touching the shared two-column value.
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.evaluate(() => localStorage.setItem("alyq.lang", "en"));
  await page.reload();
  await go("#/online/website?tab=v2", '[data-testid="v2-studio"]');
  await page.getByTestId("v2-mobile-columns").selectOption("2");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.waitForFunction(() => JSON.parse(localStorage.getItem("alyq.demo.website_settings.v1"))?.settings?.storefront_v2?.mobile_columns === 2);
  await go("#/store/products", '[data-testid="v2-catalog"]');
  await page.reload();
  for (const lang of ["en", "ar"]) {
    await page.evaluate((language) => localStorage.setItem("alyq.lang", language), lang);
    await page.reload();
    for (const width of widths.filter((candidate) => candidate < 640)) {
      await page.setViewportSize({ width, height: 780 });
      const columnCount = await page.locator(".v2-product-grid").first().evaluate((node) =>
        getComputedStyle(node).gridTemplateColumns.split(" ").length);
      assert.equal(columnCount, 2, `${lang}/${width}: saved V2 two-column mobile override`);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    }
  }
  console.log("✓ saved one- and two-column options render at all six mobile widths, EN and AR");

  await go("#/store/products", '[data-testid="v2-catalog"]');
  assert.equal(await page.getByTestId("store-v2").count(), 1, "canonical catalogue uses the saved V2 design");
  assert.equal(await page.evaluate(() => document.documentElement.style.getPropertyValue("--v2-bg")), "",
    "V2 colours stay scoped to the storefront, not the document root");
  await go("#/pos", '[data-testid="pos-scan-search"]');
  assert.equal(await page.getByTestId("store-v2").count(), 0, "POS is not V2");
  assert.equal(await page.locator("#alyq-store-theme").count(), 0, "POS has no store theme");
  assert.deepEqual(failures, [], "no browser console/network failures");
  console.log(`\n✓ ${viewportCases}/${widths.length * 2 * 2} configured EN/LTR + AR/RTL home/catalogue cases at ${widths.length} widths, ${variants}/${widths.length * 2} variants, 12/12 two-column mobile checks`);
  console.log(`✓ screenshots: ${output}/ (ignored by Git)`);
} finally {
  await browser.close();
}
