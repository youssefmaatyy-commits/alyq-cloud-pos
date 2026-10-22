#!/usr/bin/env node
/** Capture local fixture pages plus read-only Production baseline screenshots; never writes to Supabase or Production. */
import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { transform } from "esbuild";
import { chromium } from "@playwright/test";

const base = process.env.ALYQ_PREVIEW_URL || "http://127.0.0.1:4173";
const output = process.env.ALYQ_SCREENSHOT_DIR || "coverage/alyq-preview";
const seedPath = fileURLToPath(new URL("../src/modules/products/data/demoSeed.ts", import.meta.url));
const seedSource = await readFile(seedPath, "utf8");
const seedModule = await transform(seedSource, { loader: "ts", format: "esm" });
const { buildDemoProducts, buildDemoCategories } = await import(
  `data:text/javascript;base64,${Buffer.from(seedModule.code).toString("base64")}`
);

const products = buildDemoProducts();
const categories = buildDemoCategories();
const ring = products.find((product) => product.sku === "ALYQ-1002");
assert.ok(ring, "the local catalogue must include the ring fixture");
const parent = {
  ...ring,
  id: "11111111-2222-4333-8444-000000000101",
  sku: "BR101",
  barcode: "BR101",
  name_en: "ALYQ Royal Gold Bracelet",
  name_ar: "سوار أَلِــيْـــق الذهبي",
  category_id: categories[0]?.id ?? ring.category_id,
  image_url: null,
  images: [],
  variants_enabled: true,
  stock_quantity: 66,
  low_stock_level: 2,
};
products.push(parent);
// These are the three actual public image URLs found on the existing Staging
// BR101 fixture. The other nine preview-only models intentionally have no
// image so the gallery shows its honest missing-photo state instead of a
// repeated or generated stand-in.
const actualStagingModelImages = [
  "https://images.unsplash.com/photo-1611591437281-460bfbe1220a?auto=format&fit=crop&w=900&q=80",
  "https://images.unsplash.com/photo-1573408301185-9146fe634ad0?auto=format&fit=crop&w=900&q=80",
  "https://images.unsplash.com/photo-1535632066927-ab7c9ab60908?auto=format&fit=crop&w=900&q=80",
];
const models = Array.from({ length: 12 }, (_, index) => {
  const image = actualStagingModelImages[index] ?? null;
  return {
    id: `9caa4fe0-4147-4af0-9982-${String(index + 201).padStart(12, "0")}`,
    product_id: parent.id,
    sku: `BR101-M${String(index + 1).padStart(2, "0")}`,
    barcode: null,
    color_key: "", color_ar: null, color_en: null, color_hex: null,
    size: null, size_label: null, size_value: null,
    image_url: image, images: image ? [image] : [],
    display_name_ar: `شكل ${String(index + 1).padStart(2, "0")}`,
    display_name_en: `Model ${String(index + 1).padStart(2, "0")}`,
    price_override: 145 + index * 5,
    stock_quantity: index === 11 ? 0 : index + 1,
    low_stock_level: 1,
    active: true,
    sort_order: index + 1,
    created_at: parent.created_at,
    updated_at: parent.updated_at,
  };
});
const catalog = { seed_revision: 3, categories, products, variants: models };
const coreRoutes = [
  ["home", "#/store", "v2-home"],
  ["catalog", "#/store/products", "v2-catalog"],
  ["product", `#/store/products/${parent.id}`, "v2-product"],
  ["cart", "#/store/cart", "v2-cart"],
  ["checkout", "#/store/checkout", "v2-checkout"],
];

async function assertStagingGalleryPhotos(page, viewport) {
  const images = page.locator(".v2-model-gallery-card img");
  const loaded = await images.evaluateAll(async (nodes) => Promise.all(nodes.map(async (image) => {
    try { await image.decode(); return image.naturalWidth > 0; } catch { return false; }
  })));
  assert.equal(loaded.length, 3, `${viewport} must render only the three Staging model photos`);
  assert.ok(loaded.every(Boolean), `${viewport} must load all three actual Staging model photos`);
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
        assert.equal(await page.locator(".v2-model-gallery-card").count(), 12,
          `${language} model gallery at ${width}px must show all twelve models`);
      }
    }
    console.log(`✓ ${language} storefront routes fit ${width}px without horizontal overflow`);
  }
}

await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
try {
  // Read-only baseline evidence from the user-provided live store. This only
  // performs page navigations/GETs; no login, cart mutation, or checkout.
  try {
    const before = await browser.newPage({ viewport: { width: 1366, height: 900 }, deviceScaleFactor: 1 });
    await before.goto("https://alyq-store.vercel.app/", { waitUntil: "domcontentloaded", timeout: 30_000 });
    await before.locator("body").waitFor();
    await before.waitForLoadState("networkidle", { timeout: 12_000 }).catch(() => {});
    await before.screenshot({ path: `${output}/before-production-home-desktop-1366.png`, fullPage: true, animations: "disabled" });
    const liveCategories = before.locator("#categories").first();
    if (await liveCategories.count()) {
      await liveCategories.screenshot({ path: `${output}/before-production-categories-desktop-1366.png`, animations: "disabled" });
    }
    await before.goto("https://alyq-store.vercel.app/#/store/products", { waitUntil: "domcontentloaded", timeout: 30_000 });
    await before.locator("body").waitFor();
    await before.waitForLoadState("networkidle", { timeout: 12_000 }).catch(() => {});
    await before.screenshot({ path: `${output}/before-production-catalog-desktop-1366.png`, fullPage: true, animations: "disabled" });
    const brokenImages = await before.locator("img").evaluateAll((images) => images.filter((image) => image.complete && image.naturalWidth === 0).length);
    console.log(`Read-only live baseline: ${brokenImages} image(s) failed to load on the catalogue page.`);
    await before.setViewportSize({ width: 390, height: 844 });
    await before.goto("https://alyq-store.vercel.app/", { waitUntil: "domcontentloaded", timeout: 30_000 });
    await before.locator("body").waitFor();
    await before.screenshot({ path: `${output}/before-production-home-mobile-390.png`, fullPage: true, animations: "disabled" });
    await before.close();
  } catch (error) {
    console.warn(`Read-only Production baseline capture unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }

  const context = await browser.newContext({ viewport: { width: 1366, height: 900 }, deviceScaleFactor: 1 });
  await context.addInitScript((fixture) => {
    localStorage.setItem("alyq.demo.catalog.v1", JSON.stringify(fixture.catalog));
    localStorage.setItem("alyq.lang", fixture.language);
    localStorage.removeItem("alyq.store.cart.v2");
    localStorage.removeItem("alyq.store.account.v2");
  }, { catalog, language: "en" });
  const page = await context.newPage();
  page.setDefaultTimeout(45_000);
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(`${base}/#/store`, { waitUntil: "domcontentloaded" });
  await page.getByTestId("v2-home").waitFor();
  await page.locator("#categories .v2-category").first().waitFor();
  assert.ok(!/the alyq edit/i.test(await page.locator("body").innerText()), "English home must omit the removed tagline");
  await page.screenshot({ path: `${output}/after-demo-home-desktop-en-1366.png`, fullPage: true, animations: "disabled" });
  await page.locator("#categories").screenshot({ path: `${output}/after-categories-text-only-desktop-en.png`, animations: "disabled" });

  await page.goto(`${base}/#/store/products`, { waitUntil: "domcontentloaded" });
  await page.getByTestId(`v2-card-${parent.id}`).waitFor();
  await page.screenshot({ path: `${output}/after-catalog-desktop-en-1366.png`, fullPage: true, animations: "disabled" });

  await page.goto(`${base}/#/store/products/${parent.id}`, { waitUntil: "domcontentloaded" });
  await page.getByTestId("v2-model-gallery").waitFor();
  assert.equal(await page.locator(".v2-model-gallery-card").count(), 12, "fixture must show all twelve model tiles");
  assert.equal(await page.locator(".v2-model-gallery-card img").count(), 3,
    "only the three photos actually present in Staging may appear; missing photos must remain honest placeholders");
  await assertStagingGalleryPhotos(page, "desktop");
  await page.screenshot({ path: `${output}/after-product-gallery-desktop-en-1366.png`, fullPage: true, animations: "disabled" });
  await page.locator(".v2-model-gallery-card:nth-child(3) .v2-model-gallery-add").click();
  await page.goto(`${base}/#/store/cart`, { waitUntil: "domcontentloaded" });
  await page.getByTestId("v2-cart").waitFor();
  await page.screenshot({ path: `${output}/after-cart-desktop-en-1366.png`, fullPage: true, animations: "disabled" });
  await page.goto(`${base}/#/store/checkout`, { waitUntil: "domcontentloaded" });
  await page.getByTestId("v2-checkout").waitFor();
  assert.ok(!/the alyq edit/i.test(await page.locator("body").innerText()), "English checkout must omit the removed tagline");
  await page.screenshot({ path: `${output}/after-checkout-desktop-en-1366.png`, fullPage: true, animations: "disabled" });
  await checkResponsiveRoutes(page, "en");
  await context.close();

  const mobileContext = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
  await mobileContext.addInitScript((fixture) => {
    localStorage.setItem("alyq.demo.catalog.v1", JSON.stringify(fixture.catalog));
    localStorage.setItem("alyq.lang", fixture.language);
    localStorage.removeItem("alyq.store.cart.v2");
    localStorage.removeItem("alyq.store.account.v2");
  }, { catalog, language: "ar" });
  const mobile = await mobileContext.newPage();
  mobile.setDefaultTimeout(45_000);
  mobile.on("pageerror", (error) => pageErrors.push(error.message));
  await mobile.goto(`${base}/#/store`, { waitUntil: "domcontentloaded" });
  await mobile.getByTestId("v2-home").waitFor();
  await mobile.locator("#categories .v2-category").first().waitFor();
  assert.ok(!/the alyq edit/i.test(await mobile.locator("body").innerText()), "Arabic home must omit the removed English tagline");
  await mobile.screenshot({ path: `${output}/after-home-mobile-ar-390.png`, fullPage: true, animations: "disabled" });
  await mobile.locator("#categories").screenshot({ path: `${output}/after-categories-text-only-mobile-ar-390.png`, animations: "disabled" });
  await mobile.goto(`${base}/#/store/products/${parent.id}`, { waitUntil: "domcontentloaded" });
  await mobile.getByTestId("v2-model-gallery").waitFor();
  assert.equal(await mobile.locator(".v2-model-gallery-card").count(), 12, "mobile fixture must show all twelve models");
  assert.equal(await mobile.locator(".v2-model-gallery-card img").count(), 3,
    "mobile fixture must not fill missing model photos with substitutes");
  await assertStagingGalleryPhotos(mobile, "mobile");
  await mobile.screenshot({ path: `${output}/after-product-gallery-mobile-ar-390.png`, fullPage: true, animations: "disabled" });
  await mobile.locator(".v2-model-gallery-card:nth-child(3) .v2-model-gallery-add").click();
  await mobile.goto(`${base}/#/store/cart`, { waitUntil: "domcontentloaded" });
  await mobile.getByTestId("v2-cart").waitFor();
  await mobile.screenshot({ path: `${output}/after-cart-mobile-ar-390.png`, fullPage: true, animations: "disabled" });
  await mobile.goto(`${base}/#/store/checkout`, { waitUntil: "domcontentloaded" });
  await mobile.getByTestId("v2-checkout").waitFor();
  await mobile.screenshot({ path: `${output}/after-checkout-mobile-ar-390.png`, fullPage: true, animations: "disabled" });
  await checkResponsiveRoutes(mobile, "ar");
  assert.deepEqual(pageErrors, [], `unexpected browser errors: ${pageErrors.join("; ")}`);
  await mobileContext.close();
  console.log(`Captured before/after screenshots; verified EN/AR routes at 360, 390, 768 and 1366px under ${output}`);
} finally {
  await browser.close();
}
