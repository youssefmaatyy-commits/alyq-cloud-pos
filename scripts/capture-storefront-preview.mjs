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
  for (const width of [360, 390, 768, 1366]) {
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
      }
    }
    console.log(`✓ ${language} storefront routes fit ${width}px without horizontal overflow`);
  }
}

async function captureLocale(browser, language, device, viewport) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1 });
  await context.addInitScript((fixture) => {
    if (location.protocol !== "http:" && location.protocol !== "https:") return;
    localStorage.setItem("alyq.demo.catalog.v1", JSON.stringify(fixture.catalog));
    localStorage.setItem("alyq.lang", fixture.language);
    localStorage.removeItem("alyq.store.cart.v2");
    localStorage.removeItem("alyq.store.account.v2");
  }, { catalog, language });
  const page = await context.newPage();
  const pageErrors = [];
  page.setDefaultTimeout(45_000);
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const width = viewport.width;
  const prefix = `${output}/preview`;
  try {
    await page.goto(`${base}/#/store`, { waitUntil: "domcontentloaded" });
    await page.getByTestId("v2-home").waitFor();
    await page.locator("#categories .v2-category").first().waitFor();
    assert.ok(!/the alyq edit/i.test(await page.locator("body").innerText()), `${language} home must omit the removed tagline`);
    await page.screenshot({ path: `${prefix}-home-${device}-${language}-${width}.png`, fullPage: true, animations: "disabled" });
    await page.locator("#categories").screenshot({ path: `${prefix}-categories-${device}-${language}-${width}.png`, animations: "disabled" });

    await page.goto(`${base}/#/store/products`, { waitUntil: "domcontentloaded" });
    await page.getByTestId(`v2-card-${parent.id}`).waitFor();
    await page.screenshot({ path: `${prefix}-catalog-${device}-${language}-${width}.png`, fullPage: true, animations: "disabled" });

    await page.goto(`${base}/#/store/products/${parent.id}`, { waitUntil: "domcontentloaded" });
    await page.getByTestId("v2-model-gallery").waitFor();
    assert.equal(await page.locator(".v2-model-gallery-card").count(), stagingBr101Snapshot.variants.length,
      `${language} capture must include exactly the three real Staging variants`);
    await waitForGalleryImages(page, `${language}/${device} gallery`);
    await page.screenshot({ path: `${prefix}-product-gallery-${device}-${language}-${width}.png`, fullPage: true, animations: "disabled" });

    await page.locator(".v2-model-gallery-card:nth-child(3) .v2-model-gallery-add").click();
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
  console.log(`Captured current-commit local screenshots; verified EN/AR routes at 360, 390, 768 and 1366px under ${output}`);
} finally {
  await browser.close();
}
