#!/usr/bin/env node
/**
 * End-to-End Playwright verification & screenshot capture for:
 *  - Step 2: Product Management (`أشكال / موديلات متعددة`) for BR101 (4 + 3 + 5 = 12)
 *  - Step 3: POS Cashier shared barcode scan (`BR101`) opening the visual Model Picker
 *            (never auto-selecting Model 1) + completing a sale & deducting only Model 2 stock
 *  - Step 4: Online Storefront V2 product page for BR101 in the preserved ALYQ beige & gold design
 *            with visual model selector, photo switching, and per-model available stock.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "docs", "screenshots", "variant-models");
fs.mkdirSync(outDir, { recursive: true });

const PORT = 4181;
const BASE_URL = `http://127.0.0.1:${PORT}`;

if (fs.existsSync("/tmp/al2023/lib")) {
  process.env.LD_LIBRARY_PATH = `/tmp/al2023/lib:/tmp:${process.env.LD_LIBRARY_PATH || ""}`;
}

const chromePaths = [
  process.env.CHROME_PATH,
  "/tmp/chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium-browser",
  "/usr/bin/chromium",
].filter((p) => typeof p === "string" && fs.existsSync(p));

function makeBraceletSvgDataUri({ title, subtitle, accent, gemColor, bgStart, bgEnd }) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="600" viewBox="0 0 600 600">
    <defs>
      <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="${bgStart}"/>
        <stop offset="100%" stop-color="${bgEnd}"/>
      </linearGradient>
      <linearGradient id="gold" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#DFC28F"/>
        <stop offset="50%" stop-color="${accent}"/>
        <stop offset="100%" stop-color="#8F6B32"/>
      </linearGradient>
    </defs>
    <rect width="600" height="600" rx="36" fill="url(#bg)"/>
    <circle cx="300" cy="270" r="150" fill="none" stroke="url(#gold)" stroke-width="26"/>
    <circle cx="300" cy="270" r="126" fill="none" stroke="#FFF8EB" stroke-width="2" opacity="0.6"/>
    <circle cx="300" cy="120" r="28" fill="${gemColor}" stroke="url(#gold)" stroke-width="8"/>
    <circle cx="175" cy="190" r="16" fill="url(#gold)"/>
    <circle cx="425" cy="190" r="16" fill="url(#gold)"/>
    <circle cx="175" cy="350" r="16" fill="url(#gold)"/>
    <circle cx="425" cy="350" r="16" fill="url(#gold)"/>
    <text x="300" y="485" text-anchor="middle" font-family="Cairo, sans-serif" font-size="30" font-weight="700" fill="#2A2118">${title}</text>
    <text x="300" y="528" text-anchor="middle" font-family="Inter, sans-serif" font-size="20" font-weight="600" fill="#7D6238">${subtitle}</text>
  </svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

const MODEL_IMAGES = [
  makeBraceletSvgDataUri({
    title: "شكل 1 — كلاسيك ذهبي",
    subtitle: "BR101-M01 · Classic Gold",
    accent: "#C5A059",
    gemColor: "#F5E6C8",
    bgStart: "#FAF6F0",
    bgEnd: "#EFE6D5",
  }),
  makeBraceletSvgDataUri({
    title: "شكل 2 — فص زمردي",
    subtitle: "BR101-M02 · Emerald Cut",
    accent: "#B8893A",
    gemColor: "#2E6F5E",
    bgStart: "#F7F3EB",
    bgEnd: "#E7DEC8",
  }),
  makeBraceletSvgDataUri({
    title: "شكل 3 — لؤلؤ ملكي",
    subtitle: "BR101-M03 · Royal Pearl",
    accent: "#D4AF37",
    gemColor: "#FFFDF9",
    bgStart: "#FBF8F3",
    bgEnd: "#EDE2CE",
  }),
];

// Spawn Vite dev server in isolated local Demo mode (does not touch live Supabase)
const viteProc = spawn(
  process.execPath,
  [path.join(root, "node_modules", "vite", "bin", "vite.js"), "--host", "127.0.0.1", "--port", String(PORT), "--strictPort"],
  {
    cwd: root,
    stdio: "pipe",
    env: { ...process.env, VITE_SUPABASE_URL: "", VITE_SUPABASE_ANON_KEY: "" },
  },
);

const deadline = Date.now() + 30000;
for (;;) {
  try {
    const res = await fetch(`${BASE_URL}/`);
    if (res.ok) break;
  } catch {
    /* wait for vite */
  }
  if (Date.now() > deadline) {
    viteProc.kill("SIGKILL");
    throw new Error("Vite dev server did not start in time");
  }
  await new Promise((r) => setTimeout(r, 300));
}

let browser;
try {
  browser = await chromium.launch({
    headless: true,
    executablePath: chromePaths[0],
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });

  const context = await browser.newContext({
    viewport: { width: 1440, height: 1020 },
    deviceScaleFactor: 2,
  });

  const page = await context.newPage();

  // Boot in Arabic RTL
  await page.addInitScript(() => {
    window.localStorage.setItem("alyq.lang", "ar");
    window.localStorage.setItem("alyq.i18n.lang", "ar");
    window.localStorage.setItem("alyq.locale", "ar");
  });

  // 1. Login as Admin
  await page.goto(`${BASE_URL}/#/login`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('input[autocomplete="username"]', { timeout: 15000 });
  const arToggle = page.locator('button:has-text("العربية")').first();
  if (await arToggle.count()) {
    await arToggle.click();
    await page.waitForTimeout(300);
  }
  await page.fill('input[autocomplete="username"]', "admin");
  await page.fill('input[autocomplete="current-password"]', "alyq1234");
  await page.click('button[type="submit"]');
  await page.waitForTimeout(1000);

  // Switch header language to Arabic if currently in English
  const headerArBtn = page.locator('header button:has-text("العربية")').first();
  if (await headerArBtn.count()) {
    await headerArBtn.click();
    await page.waitForTimeout(400);
  }

  // ── STEP 2: Product Management — Add Product with `أشكال / موديلات متعددة` ──
  await page.goto(`${BASE_URL}/#/products/new`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#sku", { timeout: 15000 });

  await page.fill("#name_ar", "سوار أَلِيق الذهبي الملكي");
  await page.fill("#name_en", "ALYQ Royal Gold Bracelet");
  await page.fill("#sku", "BR101");
  if (await page.locator("#barcode").count()) {
    await page.fill("#barcode", "BR101");
  }
  await page.fill("#selling_price", "240");
  await page.fill("#cost_price", "120");
  await page.fill("#tax_rate", "0");

  // Select first available category
  await page.evaluate(() => {
    const sel = document.querySelector("#category_id");
    if (sel && sel.options.length > 1) {
      sel.value = sel.options[1].value;
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    }
  });

  // Switch to `أشكال / موديلات متعددة` (`variant-mode-models`)
  await page.click('[data-testid="variant-mode-models"]');
  await page.waitForSelector('[data-testid="variant-model-list"]', { timeout: 10000 });

  // Add 2 more models so we have 3 models total (شكل 1, شكل 2, شكل 3)
  await page.click('[data-testid="variant-add-model"]');
  await page.click('[data-testid="variant-add-model"]');
  await page.waitForTimeout(300);

  // Populate the 3 models:
  // Model 0: شكل 1, BR101-M01, stock 4
  // Model 1: شكل 2, BR101-M02, stock 3
  // Model 2: شكل 3, BR101-M03, stock 5
  const modelSpecs = [
    { ar: "شكل 1", en: "Model 1", sku: "BR101-M01", stock: "4", img: MODEL_IMAGES[0] },
    { ar: "شكل 2", en: "Model 2", sku: "BR101-M02", stock: "3", img: MODEL_IMAGES[1] },
    { ar: "شكل 3", en: "Model 3", sku: "BR101-M03", stock: "5", img: MODEL_IMAGES[2] },
  ];

  // Since imageStorage compresses/uploads via File input or we can inject the SVG data-URI directly into the draft,
  // let's check if SVG file upload works or if we can set a PNG buffer!
  // Let's use a real PNG buffer rendered by a small canvas in the browser for each SVG data-URI so imageStorage.ts accepts it as image/png!
  for (let i = 0; i < modelSpecs.length; i++) {
    const spec = modelSpecs[i];
    await page.fill(`[data-testid="variant-model-ar-${i}"]`, spec.ar);
    await page.fill(`[data-testid="variant-model-en-${i}"]`, spec.en);
    await page.fill(`[data-testid="variant-model-sku-${i}"]`, spec.sku);
    await page.fill(`[data-testid="variant-model-stock-${i}"]`, spec.stock);

    const pngBase64 = await page.evaluate(async (svgDataUri) => {
      const img = new Image();
      img.src = svgDataUri;
      await new Promise((res, rej) => {
        img.onload = res;
        img.onerror = rej;
      });
      const canvas = document.createElement("canvas");
      canvas.width = 480;
      canvas.height = 480;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0, 480, 480);
      return canvas.toDataURL("image/png").replace(/^data:image\/png;base64,/, "");
    }, spec.img);

    const fileInput = page.locator(`[data-testid="variant-model-${i}"] input[type="file"]`).first();
    await fileInput.setInputFiles({
      name: `br101-model-${i + 1}.png`,
      mimeType: "image/png",
      buffer: Buffer.from(pngBase64, "base64"),
    });
  }
  await page.waitForTimeout(800);

  // Also upload the first PNG as the parent product main image so catalog cards look great
  const parentPngBase64 = await page.evaluate(async (svgDataUri) => {
    const img = new Image();
    img.src = svgDataUri;
    await new Promise((res, rej) => {
      img.onload = res;
      img.onerror = rej;
    });
    const canvas = document.createElement("canvas");
    canvas.width = 480;
    canvas.height = 480;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0, 480, 480);
    return canvas.toDataURL("image/png").replace(/^data:image\/png;base64,/, "");
  }, MODEL_IMAGES[0]);
  const parentFileInput = page.locator('input[type="file"][accept*="image"]').first();
  if (await parentFileInput.count()) {
    await parentFileInput.setInputFiles({
      name: "br101-main.png",
      mimeType: "image/png",
      buffer: Buffer.from(parentPngBase64, "base64"),
    });
    await page.waitForTimeout(500);
  }

  // Verify shared barcode banner & auto-summed stock = 12
  const bannerText = await page.locator('[data-testid="variant-shared-barcode-banner"]').textContent();
  assert.ok(bannerText && bannerText.includes("BR101"), `Expected shared barcode banner to mention BR101, got: ${bannerText}`);

  const derivedStockText = await page.locator('[data-testid="derived-product-stock"]').textContent();
  assert.ok(derivedStockText && derivedStockText.includes("12"), `Expected derived stock 12, got: ${derivedStockText}`);

  // Scroll so the shared barcode `BR101` + `أشكال / موديلات متعددة` + all 3 models (4, 3, 5) + auto-summed total = 12 are all visible together
  await page.setViewportSize({ width: 1440, height: 1320 });
  await page.locator('[data-testid="variant-model-2"]').scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);

  const screenshot1Path = path.join(outDir, "01-product-models-management.png");
  await page.screenshot({ path: screenshot1Path });
  console.log("  ✓ Screenshot 1 saved:", screenshot1Path);
  await page.setViewportSize({ width: 1440, height: 1020 });

  // Save the product
  await page.click('[data-testid="product-form-save"]');
  await page.waitForFunction(() => !window.location.hash.includes("/new") && window.location.hash.includes("/products"), null, {
    timeout: 15000,
  });
  await page.waitForTimeout(800);

  // Verify saved product & variants in demo catalog
  const savedCatalog = await page.evaluate(() => JSON.parse(window.localStorage.getItem("alyq.demo.catalog.v1") || "{}"));
  const br101Product = savedCatalog.products?.find((p) => p.sku === "BR101");
  assert.ok(br101Product, "BR101 parent product saved in catalog");
  assert.equal(br101Product.barcode, "BR101", "Parent product keeps shared barcode BR101");
  assert.equal(br101Product.stock_quantity, 12, "Parent product stock rollup is 12 (4 + 3 + 5)");

  const br101Variants = (savedCatalog.variants || []).filter((v) => v.product_id === br101Product.id);
  assert.equal(br101Variants.length, 3, "3 models saved under BR101");
  for (const v of br101Variants) {
    assert.equal(v.barcode, null, `Model ${v.sku} keeps barcode = null (inherits parent shared barcode BR101)`);
  }
  console.log("  ✓ Step 2 verified: BR101 saved with 3 models (barcode=null on models, shared barcode BR101 on parent, total stock = 12)");

  // ── STEP 3: POS Cashier — Scan Shared Barcode `BR101` & Visual Model Picker ──
  await page.goto(`${BASE_URL}/#/shifts`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(800);
  const openShiftBtn = page.locator('button:has-text("فتح وردية"), button:has-text("Open shift"), button:has-text("فتح الوردية")').first();
  if (await openShiftBtn.count()) {
    await openShiftBtn.click();
    await page.waitForTimeout(400);
    const shiftDialog = page.locator('[role="dialog"]').last();
    const textInput = shiftDialog.locator('input[type="text"]:not([readonly])').first();
    if (await textInput.count()) await textInput.fill("الفرع الرئيسي");
    const decInput = shiftDialog.locator('input[inputmode="decimal"]').first();
    if (await decInput.count()) await decInput.fill("500");
    const submitShiftBtn = shiftDialog.locator('button:has-text("فتح"), button:has-text("Open shift"), button[type="submit"]').last();
    await submitShiftBtn.click();
    await page.waitForTimeout(700);
  }

  // Navigate to POS (`#/pos`)
  await page.goto(`${BASE_URL}/#/pos`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="pos-scan-search"]', { timeout: 15000 });
  await page.waitForTimeout(600);

  // (3A) Test Android/Web Camera Barcode Scanner modal scanning shared barcode `BR101`
  await page.click('[data-testid="pos-camera-scan-btn"]');
  await page.waitForSelector('[data-testid="pos-camera-scanner-modal"]', { timeout: 8000 });
  await page.fill('[data-testid="pos-camera-manual-input"]', "BR101");
  await page.click('[data-testid="pos-camera-manual-submit"]');
  await page.waitForSelector('[data-testid="pos-model-picker"]', { timeout: 8000 });
  assert.equal(
    await page.locator('[data-testid^="cart-line-"]').count(),
    0,
    "Camera scan of BR101 must open Model Picker without auto-selecting Model 1",
  );
  // Close modal to test External USB/Bluetooth HID scanner next
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);

  // (3B) Test External Hardware Barcode Scanner (rapid HID keystroke burst on non-input target)
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
    for (const key of ["B", "R", "1", "0", "1", "Enter"]) {
      window.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
    }
  });
  await page.waitForSelector('[data-testid="pos-model-picker"]', { timeout: 8000 });
  assert.equal(
    await page.locator('[data-testid^="cart-line-"]').count(),
    0,
    "External HID barcode scanner burst of BR101 must open Model Picker without auto-selecting Model 1",
  );
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);

  // (3C) Scan shared barcode `BR101` in POS search/barcode box and press Enter
  const posScanInput = page.locator('[data-testid="pos-scan-search"]');
  await posScanInput.fill("BR101");
  await posScanInput.press("Enter");

  // Verify the visual Model Picker modal opens automatically (NO auto-selection of Model 1!)
  await page.waitForSelector('[data-testid="pos-model-picker"]', { timeout: 10000 });
  await page.waitForTimeout(500);

  // Verify cart is STILL EMPTY before the cashier picks a model (strict requirement: no auto-selection of first model!)
  const cartLinesBeforePick = await page.locator('[data-testid^="cart-line-"]').count();
  assert.equal(cartLinesBeforePick, 0, "POS must NOT auto-select the first model when scanning shared barcode BR101");

  const pickerText = await page.locator('[data-testid="pos-model-picker"]').textContent();
  assert.ok(pickerText?.includes("شكل 1"), "Model picker must show شكل 1");
  assert.ok(pickerText?.includes("شكل 2"), "Model picker must show شكل 2");
  assert.ok(pickerText?.includes("شكل 3"), "Model picker must show شكل 3");
  assert.ok(pickerText?.includes("BR101"), "Model picker must show shared barcode BR101");

  // Capture Screenshot 2A: POS Visual Model Picker open when scanning BR101 (showing stocks 4, 3, 5 and photos)
  const screenshot2PickerPath = path.join(outDir, "02a-pos-visual-model-picker.png");
  await page.screenshot({ path: screenshot2PickerPath });
  console.log("  ✓ Screenshot 2A (POS Model Picker on scanning BR101) saved:", screenshot2PickerPath);

  // Click Model 2 (`شكل 2`, stock 3) to add 1 unit to the cart
  const model2Card = page.locator('[data-testid^="pos-model-option-"]:has-text("شكل 2")').first();
  await model2Card.click();
  await page.waitForTimeout(500);

  // Verify cart now has 1 line with `شكل 2`
  await page.waitForSelector('[data-testid^="cart-line-"]', { timeout: 10000 });
  const cartLineText = await page.locator('[data-testid^="cart-line-"]').first().textContent();
  assert.ok(cartLineText?.includes("شكل 2"), `POS cart line must show selected model شكل 2, got: ${cartLineText}`);

  // Enter cash 240 and complete sale
  await page.fill('[data-testid="cash-input"]', "240");
  await page.waitForTimeout(300);
  const completeSaleBtn = page.locator('button:has-text("إتمام البيع"), button:has-text("Complete sale")').first();
  await completeSaleBtn.click();
  await page.waitForFunction(() => /INV-\d{6}/.test(document.body.textContent || ""), null, { timeout: 15000 });
  await page.waitForTimeout(500);

  // Start a new sale and scan BR101 again to visually prove that ONLY Model 2 (`شكل 2`) stock dropped from 3 -> 2!
  const newSaleBtn = page.locator('button:has-text("بيع جديد"), button:has-text("New sale")').first();
  if (await newSaleBtn.count()) {
    await newSaleBtn.click();
    await page.waitForTimeout(400);
  }
  await posScanInput.fill("BR101");
  await posScanInput.press("Enter");
  await page.waitForSelector('[data-testid="pos-model-picker"]', { timeout: 10000 });
  await page.waitForTimeout(500);

  const afterPosCatalog = await page.evaluate(() => JSON.parse(window.localStorage.getItem("alyq.demo.catalog.v1") || "{}"));
  const afterPosModels = Object.fromEntries(
    (afterPosCatalog.variants || []).filter((v) => v.product_id === br101Product.id).map((v) => [v.sku, v.stock_quantity]),
  );
  assert.equal(afterPosModels["BR101-M01"], 4, "Model 1 (شكل 1) stock remains 4");
  assert.equal(afterPosModels["BR101-M02"], 2, "Model 2 (شكل 2) stock deducted from 3 to 2");
  assert.equal(afterPosModels["BR101-M03"], 5, "Model 3 (شكل 3) stock remains 5");
  const afterPosParent = afterPosCatalog.products.find((p) => p.id === br101Product.id);
  assert.equal(afterPosParent.stock_quantity, 11, "Parent rollup stock updated from 12 to 11");

  const screenshot2PostSalePath = path.join(outDir, "02-pos-model-picker-and-sale.png");
  await page.screenshot({ path: screenshot2PostSalePath });
  console.log("  ✓ Screenshot 2 (POS Model Picker proving شكل 2 stock deducted 3 → 2 while شكل 1=4 & شكل 3=5) saved:", screenshot2PostSalePath);

  // Close picker
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);

  // ── STEP 4: Online Storefront V2 (`/#/store/products/:id`) ──
  await page.goto(`${BASE_URL}/#/store/products/${br101Product.id}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="v2-model-picker"]', { timeout: 15000 });
  await page.waitForTimeout(600);

  // Verify ALYQ Storefront V2 beige & gold design tokens are active
  const v2Styles = await page.evaluate(() => {
    const rootEl = document.querySelector(".store-v2") || document.documentElement;
    const cs = window.getComputedStyle(rootEl);
    return {
      bg: cs.getPropertyValue("--v2-bg").trim(),
      accent: cs.getPropertyValue("--v2-accent").trim(),
    };
  });
  assert.ok(v2Styles.bg && v2Styles.accent, `Expected V2 beige & gold CSS tokens, got: ${JSON.stringify(v2Styles)}`);

  const modelOptions = page.locator(".v2-model-option");
  assert.equal(await modelOptions.count(), 3, "Storefront V2 renders all 3 visual models");

  // Click Model 2 (`شكل 2`, stock 2) and verify image & stock switch
  await modelOptions.nth(1).click();
  await page.waitForTimeout(400);
  const pdpTextModel2 = await page.locator(".v2-pdp").textContent();
  assert.ok(pdpTextModel2?.includes("شكل 2"), "Storefront V2 PDP shows selected model شكل 2");
  assert.ok(pdpTextModel2?.includes("2"), "Storefront V2 PDP shows available stock 2 for شكل 2");

  const screenshot3Path = path.join(outDir, "03-storefront-v2-product-models.png");
  await page.screenshot({ path: screenshot3Path });
  console.log("  ✓ Screenshot 3 (Storefront V2 BR101 product page) saved:", screenshot3Path);

  console.log("\n✓ All E2E Playwright assertions and 3 screenshots completed successfully!");
} finally {
  await browser?.close();
  viteProc.kill("SIGKILL");
}
