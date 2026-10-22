#!/usr/bin/env node
/** Capture the branch's LOCAL demo storefront for review; never connects to Supabase or Production. */
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
const parent = products.find((product) => product.sku === "ALYQ-1002");
assert.ok(parent, "the local catalogue must include the ring fixture");
parent.variants_enabled = true;
parent.stock_quantity = 66;
parent.low_stock_level = 2;
const modelImages = [
  "/brand/products/classic-gold-ring.jpg",
  "/brand/products/gold-pearl-earrings.jpg",
  "/brand/products/minimal-bracelet.jpg",
  "/brand/products/pearl-necklace.jpg",
  "/brand/products/jewellery-set.jpg",
  "/brand/products/gift-wrapping.jpg",
  "/brand/products/styling-membership.jpg",
];
const models = Array.from({ length: 12 }, (_, index) => ({
  id: `9caa4fe0-4147-4af0-9982-${String(index + 201).padStart(12, "0")}`,
  product_id: parent.id,
  sku: `ALYQ-PREVIEW-M${String(index + 1).padStart(2, "0")}`,
  barcode: parent.barcode,
  color_key: "", color_ar: null, color_en: null, color_hex: null,
  size: null, size_label: null, size_value: null,
  image_url: modelImages[index % modelImages.length], images: [modelImages[index % modelImages.length]],
  display_name_ar: `موديل ${String(index + 1).padStart(2, "0")}`,
  display_name_en: `Preview model ${String(index + 1).padStart(2, "0")}`,
  price_override: 145 + index * 5,
  stock_quantity: index === 11 ? 0 : index + 1,
  low_stock_level: 1,
  active: true,
  sort_order: index + 1,
  created_at: parent.created_at,
  updated_at: parent.updated_at,
}));
const catalog = { seed_revision: 3, categories, products, variants: models };

await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 980 }, deviceScaleFactor: 1 });
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
  await page.screenshot({ path: `${output}/home-desktop-en.png`, fullPage: true, animations: "disabled" });
  await page.locator("#categories").screenshot({ path: `${output}/categories-text-only-desktop.png`, animations: "disabled" });

  await page.goto(`${base}/#/store/products`, { waitUntil: "domcontentloaded" });
  await page.getByTestId(`v2-card-${parent.id}`).waitFor();
  await page.screenshot({ path: `${output}/catalog-desktop-en.png`, fullPage: true, animations: "disabled" });

  await page.goto(`${base}/#/store/products/${parent.id}`, { waitUntil: "domcontentloaded" });
  await page.getByTestId("v2-model-gallery").waitFor();
  assert.equal(await page.locator(".v2-model-gallery-card").count(), 12, "fixture must show all twelve model tiles");
  await page.screenshot({ path: `${output}/product-gallery-desktop-en.png`, fullPage: true, animations: "disabled" });
  await page.locator(".v2-model-gallery-card:nth-child(3) .v2-model-gallery-add").click();
  await page.goto(`${base}/#/store/cart`, { waitUntil: "domcontentloaded" });
  await page.getByTestId("v2-cart").waitFor();
  await page.screenshot({ path: `${output}/cart-desktop-en.png`, fullPage: true, animations: "disabled" });

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
  await mobile.screenshot({ path: `${output}/home-mobile-ar.png`, fullPage: true, animations: "disabled" });
  await mobile.locator("#categories").screenshot({ path: `${output}/categories-text-only-mobile-ar.png`, animations: "disabled" });
  await mobile.goto(`${base}/#/store/products/${parent.id}`, { waitUntil: "domcontentloaded" });
  await mobile.getByTestId("v2-model-gallery").waitFor();
  assert.equal(await mobile.locator(".v2-model-gallery-card").count(), 12, "mobile fixture must show all twelve models");
  await mobile.screenshot({ path: `${output}/product-gallery-mobile-ar.png`, fullPage: true, animations: "disabled" });
  assert.deepEqual(pageErrors, [], `unexpected browser errors: ${pageErrors.join("; ")}`);
  await mobileContext.close();
  console.log(`Captured desktop/mobile local-demo screenshots under ${output}`);
} finally {
  await browser.close();
}
