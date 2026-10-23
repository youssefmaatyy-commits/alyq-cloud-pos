#!/usr/bin/env node
/** Capture local-only screenshots using demo content plus the read-only Staging BR101 snapshot. */
import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { transform } from "esbuild";
import { chromium } from "@playwright/test";
import { stagingBr101Snapshot } from "./staging-br101.snapshot.mjs";

const base = process.env.ALYQ_PREVIEW_URL || "http://127.0.0.1:4173";
const output = process.env.ALYQ_SCREENSHOT_DIR || "coverage/alyq-preview";
const capturePrefix = process.env.ALYQ_CAPTURE_PREFIX || "after";
const baselineCapture = process.env.ALYQ_CAPTURE_BASELINE === "1";
const seedPath = fileURLToPath(new URL("../src/modules/products/data/demoSeed.ts", import.meta.url));
const seedSource = await readFile(seedPath, "utf8");
const seedModule = await transform(seedSource, { loader: "ts", format: "esm" });
const { buildDemoProducts, buildDemoCategories } = await import(
  `data:text/javascript;base64,${Buffer.from(seedModule.code).toString("base64")}`
);

const products = buildDemoProducts();
const categories = [...buildDemoCategories(), ...stagingBr101Snapshot.categories];
const parent = { ...products[0], ...stagingBr101Snapshot.product };
products.push(parent);
const models = stagingBr101Snapshot.variants.map((model) => ({
  ...model,
  cost_override: null,
  low_stock_level: 1,
  created_at: parent.created_at,
  updated_at: parent.updated_at,
}));
const catalog = { seed_revision: 3, categories, products, variants: models };
const coreRoutes = [
  ["home", "#/store", "v2-home"],
  ["catalog", "#/store/products", "v2-catalog"],
  ["product", `#/store/products/${parent.id}`, "v2-product"],
  ["cart", "#/store/cart", "v2-cart"],
  ["checkout", "#/store/checkout", "v2-checkout"],
];

async function captureSection(page, selector, path) {
  const section = page.locator(selector);
  await section.evaluate((element) => {
    const header = document.querySelector(".v2-header");
    const top = window.scrollY + element.getBoundingClientRect().top;
    window.scrollTo(0, Math.max(0, top - (header?.getBoundingClientRect().height ?? 0) - 12));
  });
  await section.screenshot({ path, animations: "disabled" });
}

async function assertCategorySvgArrows(page, label) {
  const arrows = await page.locator("#categories .v2-category-arrow").evaluateAll((elements) => elements.map((element) => {
    const icon = element.querySelector("svg");
    const iconRect = icon?.getBoundingClientRect();
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    const cardStyle = getComputedStyle(element.closest(".v2-category"));
    const iconStyle = icon ? getComputedStyle(icon) : null;
    return {
      text: element.textContent.trim(),
      viewBox: icon?.getAttribute("viewBox"),
      fill: icon?.getAttribute("fill"),
      stroke: icon?.getAttribute("stroke"),
      strokeWidth: Number(icon?.getAttribute("stroke-width")),
      geometry: icon ? [...icon.querySelectorAll("path")].map((path) => path.getAttribute("d")).join("|") : "",
      width: rect.width,
      height: rect.height,
      borderRadius: style.borderRadius,
      borderWidth: style.borderTopWidth,
      goldMatchesCard: style.borderTopColor === cardStyle.borderTopColor,
      iconWidth: iconRect?.width ?? 0,
      iconHeight: iconRect?.height ?? 0,
      inheritedColor: iconStyle?.color === style.color && iconStyle.stroke === iconStyle.color,
    };
  }));
  assert.ok(arrows.length > 0, `${label}: category SVG arrows must exist`);
  for (const arrow of arrows) {
    assert.equal(arrow.text, "", `${label}: arrow must not contain Unicode/emoji text`);
    assert.equal(arrow.viewBox, "0 0 24 24", `${label}: fixed SVG viewBox`);
    assert.equal(arrow.fill, "none", `${label}: outline icon fill`);
    assert.equal(arrow.stroke, "currentColor", `${label}: icon inherits ALYQ color`);
    assert.equal(arrow.strokeWidth, 1.55, `${label}: thin icon stroke`);
    assert.equal(arrow.geometry, "M7 17 17 7|M7 7h10v10", `${label}: ArrowUpRight geometry`);
    assert.ok(Math.abs(arrow.width - 34) < 0.1 && Math.abs(arrow.height - 34) < 0.1,
      `${label}: original 34px circle dimensions are unchanged`);
    assert.equal(arrow.borderRadius, "50%", `${label}: golden circle remains round`);
    assert.equal(arrow.borderWidth, "1px", `${label}: original circle border width`);
    assert.ok(arrow.goldMatchesCard, `${label}: circle retains the configured gold accent`);
    assert.ok(Math.abs(arrow.iconWidth - 17) < 0.1 && Math.abs(arrow.iconHeight - 17) < 0.1,
      `${label}: deterministic 17px SVG geometry on mobile and desktop`);
    assert.ok(arrow.inheritedColor, `${label}: SVG stroke and color inherit the ALYQ theme`);
  }
  console.log(`✓ ${label}: ${arrows.length} category arrows are thin themed SVGs inside the unchanged golden circles`);
}

async function waitForGalleryImages(page, label) {
  await page.waitForFunction(() => [...document.querySelectorAll(".v2-model-gallery-card")].every((card) => {
    const image = card.querySelector(".v2-model-gallery-photo img");
    return Boolean(card.querySelector(".v2-model-gallery-photo-missing")) || Boolean(image?.complete && image.naturalWidth > 0);
  }), null, { timeout: 20_000 });
  const gallery = await page.locator(".v2-model-gallery-card").evaluateAll((cards) => cards.map((card) => ({
    name: card.querySelector(".v2-model-gallery-name")?.textContent?.trim() ?? "",
    stock: card.querySelector(".v2-model-gallery-stock")?.textContent?.trim() ?? "",
    source: card.querySelector(".v2-model-gallery-photo img")?.getAttribute("src") ?? null,
    placeholder: Boolean(card.querySelector(".v2-model-gallery-photo-missing")),
  })));
  const rtl = await page.locator("html").getAttribute("dir") === "rtl";
  const expectedNames = rtl ? ["شكل 1", "شكل 2", "شكل 3"] : ["Model 1", "Model 2", "Model 3"];
  assert.deepEqual(gallery.map((model) => model.name), expectedNames,
    `${label} must show the exact Staging model names in the current language`);
  assert.ok(gallery.every((model) => model.stock.length > 0), `${label} must show each model's stock status`);
  assert.ok(gallery.every((model, index) => model.source === stagingBr101Snapshot.variants[index].image_url || model.placeholder),
    `${label} images must be the recorded Staging URLs or the neutral on-error placeholder`);
  console.log(`${label}: ${gallery.filter((model) => model.source && !model.placeholder).length} actual Staging photos loaded; ${gallery.filter((model) => model.placeholder).length} neutral placeholders`);
}

async function checkResponsiveRoutes(page, language) {
  for (const width of [360, 390, 768, 1366, 1920]) {
    await page.setViewportSize({ width, height: width < 768 ? 844 : 900 });
    for (const [label, route, testId] of coreRoutes) {
      await page.goto(`${base}/${route}`, { waitUntil: "domcontentloaded" });
      await page.getByTestId(testId).waitFor();
      const metrics = await page.evaluate(() => ({
        viewport: document.documentElement.clientWidth,
        document: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
        direction: document.documentElement.dir,
        text: document.body.innerText.toLowerCase(),
      }));
      assert.ok(metrics.document <= metrics.viewport + 1,
        `${language} ${label} at ${width}px has horizontal overflow: ${metrics.document}/${metrics.viewport}`);
      assert.equal(metrics.direction, language === "ar" ? "rtl" : "ltr",
        `${language} ${label} at ${width}px must keep the correct writing direction`);
      assert.ok(!metrics.text.includes("the alyq edit") && !metrics.text.includes("مختارات أَلِــيْـــق"),
        `${language} ${label} at ${width}px must not render the removed tagline`);
      if (testId === "v2-product") {
        assert.equal(await page.locator(".v2-model-gallery-card").count(), stagingBr101Snapshot.variants.length,
          `${language} gallery at ${width}px must show only the Staging model rows`);
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        if (width < 768 && !baselineCapture) {
          await page.getByTestId("v2-sticky-buy").waitFor({ state: "visible" });
        } else {
          assert.equal(await page.getByTestId("v2-sticky-buy").isVisible().catch(() => false), false,
            `${language} product sticky bar must be hidden outside mobile widths`);
        }
      } else {
        assert.equal(await page.getByTestId("v2-sticky-buy").count(), 0,
          `${language} ${label} must not show the PDP-only sticky bar`);
      }
    }
    console.log(`✓ ${language} storefront routes fit ${width}px without horizontal overflow`);
  }
}

async function captureLocale(browser, language, device, viewport) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1,
    isMobile: device === "mobile", hasTouch: device === "mobile" });
  await context.addInitScript((fixture) => {
    if (location.protocol !== "http:" && location.protocol !== "https:") return;
    localStorage.setItem("alyq.demo.catalog.v1", JSON.stringify(fixture.catalog));
    localStorage.setItem("alyq.lang", fixture.language);
    localStorage.removeItem("alyq.store.cart.v2");
    localStorage.removeItem("alyq.store.account.v2");
  }, { catalog, language });
  const page = await context.newPage();
  // Browser sandbox egress is deliberately limited. These configured external
  // catalogue URLs fail closed here; the storefront's real neutral image
  // fallback is what the capture verifies rather than replacing them locally.
  await page.route("https://**/*", (route) => route.abort());
  const pageErrors = [];
  page.setDefaultTimeout(45_000);
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const width = viewport.width;
  const prefix = `${output}/${capturePrefix}`;
  try {
    await page.goto(`${base}/#/store`, { waitUntil: "domcontentloaded" });
    await page.getByTestId("v2-home").waitFor();
    await page.locator("#categories .v2-category").first().waitFor();
    await assertCategorySvgArrows(page, `${language}/${device}/${width}px`);
    assert.ok(!/the alyq edit/i.test(await page.locator("body").innerText()), `${language} home must omit the removed tagline`);
    await page.screenshot({ path: `${prefix}-home-${device}-${language}-${width}.png`, fullPage: true, animations: "disabled" });
    const arrivals = page.locator("#newArrivals .v2-product-card");
    if (await arrivals.count()) {
      const arrivalIds = await arrivals.evaluateAll((cards) => cards.map((card) => card.getAttribute("data-testid")));
      assert.equal(new Set(arrivalIds).size, arrivalIds.length, `${language} New Arrivals must not duplicate a product`);
      assert.ok(arrivalIds.every((id) => catalog.products.some((product) => id === `v2-card-${product.id}` &&
        product.active && product.show_on_website)), `${language} New Arrivals must only contain published products`);
      const arrivalLayout = page.locator('#newArrivals [data-testid="v2-new-arrivals"]');
      if (arrivalIds.length <= 3 && !baselineCapture) {
        const geometry = await arrivalLayout.evaluate((element) => {
          const box = element.getBoundingClientRect();
          const section = element.parentElement.getBoundingClientRect();
          return { classes: element.className, count: element.children.length,
            centered: Math.abs(box.left + box.width / 2 - (section.left + section.width / 2)) < 1,
            featured: element.querySelectorAll('[data-featured="true"]').length };
        });
        assert.ok(geometry.classes.includes(`v2-new-arrivals-${arrivalIds.length}`),
          `${language} New Arrivals must select its count-matched composition`);
        if (arrivalIds.length < 3) assert.ok(geometry.centered,
          `${language} New Arrivals with ${arrivalIds.length} item(s) must be centered`);
        if (arrivalIds.length === 3) assert.equal(geometry.featured, 1,
          `${language} three-item New Arrivals must have one featured lead`);
      }
      await captureSection(page, "#newArrivals", `${prefix}-new-arrivals-${device}-${language}-${width}.png`);
    }
    await captureSection(page, "#categories", `${prefix}-categories-${device}-${language}-${width}.png`);

    await page.goto(`${base}/#/store/products`, { waitUntil: "domcontentloaded" });
    await page.getByTestId(`v2-card-${parent.id}`).waitFor();
    await page.screenshot({ path: `${prefix}-catalog-${device}-${language}-${width}.png`, fullPage: true, animations: "disabled" });

    await page.goto(`${base}/#/store/products/${parent.id}`, { waitUntil: "domcontentloaded" });
    await page.getByTestId("v2-model-gallery").waitFor();
    assert.equal(await page.locator(".v2-model-gallery-card").count(), stagingBr101Snapshot.variants.length,
      `${language} capture must include exactly the three real Staging variants`);
    await waitForGalleryImages(page, `${language}/${device} gallery`);
    await page.screenshot({ path: `${prefix}-product-gallery-${device}-${language}-${width}.png`, fullPage: true, animations: "disabled" });

    if (width < 768) {
      await page.locator(".v2-model-gallery-card:nth-child(1) .v2-model-gallery-select").click();
      if (baselineCapture) {
        await page.locator(".v2-pdp-buy-row").scrollIntoViewIfNeeded();
        await page.screenshot({ path: `${prefix}-product-purchase-${device}-${language}-${width}.png`, animations: "disabled" });
      } else {
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        const sticky = page.getByTestId("v2-sticky-buy");
        await sticky.waitFor({ state: "visible" });
        const selectedLabel = await sticky.locator(".v2-sticky-buy-copy span").innerText();
        assert.ok(selectedLabel.includes(language === "ar" ? "شكل 1" : "Model 1"),
          `${language} sticky purchase must reflect the selected Staging model`);
        assert.match(await sticky.locator(".v2-sticky-buy-copy strong").innerText(), /240/,
          `${language} sticky purchase must show the selected model's current price`);
        assert.equal(await page.locator(".v2-model-gallery-card:nth-child(1) .v2-model-gallery-select").getAttribute("aria-pressed"), "true",
          `${language} gallery must retain its exact selected model`);
        assert.equal(await page.getByTestId("v2-sticky-add").isDisabled(), false,
          `${language} available model must enable sticky add`);
        await page.screenshot({ path: `${prefix}-product-purchase-${device}-${language}-${width}.png`, animations: "disabled" });
        await page.getByTestId("v2-image-zoom").click();
        await page.getByTestId("v2-lightbox").waitFor({ state: "visible" });
        assert.ok(await page.locator(".v2-lightbox-navigation button").evaluateAll((buttons) =>
          buttons.length === 2 && buttons.every((button) => button.textContent.trim() === "" && Boolean(button.querySelector("svg")))),
        `${language}/${device}: lightbox navigation must use SVG arrows without emoji text`);
        assert.equal(await sticky.isVisible(), false, `${language} sticky bar must yield to the image lightbox`);
        await page.locator(".v2-lightbox-close").click();
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await sticky.waitFor({ state: "visible" });
        await page.getByTestId("v2-sticky-add").click();
        await page.getByTestId("v2-mini-cart").waitFor({ state: "visible" });
        assert.equal(await sticky.isVisible(), false, `${language} sticky bar must yield to the mini-cart drawer`);
        assert.equal(await page.locator("[data-testid='v2-mini-cart-line']").first().getAttribute("data-variant-id"),
          stagingBr101Snapshot.variants[0].id, `${language} sticky add must preserve the selected exact model ID`);
        await page.screenshot({ path: `${prefix}-mini-cart-${device}-${language}-${width}.png`, animations: "disabled" });
        await page.locator(".v2-cart-drawer-close").click();
      }
    }
    if (width < 768 && !baselineCapture) await page.waitForTimeout(1700);

    await page.locator(".v2-model-gallery-card:nth-child(3) .v2-model-gallery-add").click();
    if (baselineCapture) {
      await page.screenshot({ path: `${prefix}-mini-cart-${device}-${language}-${width}.png`, animations: "disabled" });
    } else {
      await page.getByTestId("v2-mini-cart").waitFor({ state: "visible" });
      const drawerVariantIds = await page.locator("[data-testid='v2-mini-cart-line']")
        .evaluateAll((lines) => lines.map((line) => line.getAttribute("data-variant-id")));
      assert.deepEqual(drawerVariantIds,
        [...(width < 768 ? [stagingBr101Snapshot.variants[0].id] : []), stagingBr101Snapshot.variants[2].id],
        `${language} mini-cart must preserve the exact selected model IDs`);
      await page.screenshot({ path: `${prefix}-mini-cart-${device}-${language}-${width}.png`, animations: "disabled" });
      await page.locator(".v2-cart-drawer-close").click();
    }
    await page.goto(`${base}/#/store/cart`, { waitUntil: "domcontentloaded" });
    await page.getByTestId("v2-cart").waitFor();
    await page.screenshot({ path: `${prefix}-cart-${device}-${language}-${width}.png`, fullPage: true, animations: "disabled" });
    await page.goto(`${base}/#/store/checkout`, { waitUntil: "domcontentloaded" });
    await page.getByTestId("v2-checkout").waitFor();
    assert.ok(!/the alyq edit/i.test(await page.locator("body").innerText()), `${language} checkout must omit the removed tagline`);
    await page.screenshot({ path: `${prefix}-checkout-${device}-${language}-${width}.png`, fullPage: true, animations: "disabled" });

    await checkResponsiveRoutes(page, language);
    assert.deepEqual(pageErrors, [], `${language}/${device} browser errors: ${pageErrors.join("; ")}`);
  } finally {
    await context.close();
  }
}

await mkdir(output, { recursive: true });
const launchArgs = process.env.ALYQ_CHROMIUM_ARGS
  ? JSON.parse(process.env.ALYQ_CHROMIUM_ARGS)
  : ["--no-sandbox"];
const browser = await chromium.launch({
  headless: true,
  args: launchArgs,
  ...(process.env.ALYQ_CHROMIUM_EXECUTABLE_PATH
    ? { executablePath: process.env.ALYQ_CHROMIUM_EXECUTABLE_PATH }
    : {}),
});
try {
  for (const [language, device, viewport] of [
    ["en", "desktop", { width: 1366, height: 900 }],
    ["ar", "desktop", { width: 1366, height: 900 }],
    ["en", "mobile", { width: 390, height: 844 }],
    ["ar", "mobile", { width: 390, height: 844 }],
  ]) {
    await captureLocale(browser, language, device, viewport);
  }
  console.log(`Captured ${capturePrefix} local screenshots; verified EN/AR routes at 360, 390, 768, 1366 and 1920px under ${output}`);
} finally {
  await browser.close();
}
