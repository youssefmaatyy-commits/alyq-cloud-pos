import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { chromium } from "playwright";

const PORT = 4187;
const SCREENSHOT_DIR = path.resolve("docs/screenshots/iphone-product-fix");

async function main() {
  const server = spawn(
    "node",
    ["./node_modules/vite/bin/vite.js", "--port", String(PORT), "--strictPort", "--host", "127.0.0.1"],
    {
      cwd: process.cwd(),
      env: { ...process.env, VITE_SUPABASE_URL: "", VITE_SUPABASE_ANON_KEY: "" },
      stdio: "pipe",
    },
  );

  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("vite startup timeout")), 15000);
    server.stdout.on("data", (d) => {
      if (d.toString().includes(String(PORT))) {
        clearTimeout(t);
        resolve();
      }
    });
  });

  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || "/tmp/chromium",
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-gpu"],
  });

  try {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
      locale: "ar-EG",
    });
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${PORT}/#/login`, { waitUntil: "networkidle" });

    // Sign in as Admin
    await page.locator("input").first().fill("admin");
    await page.locator('input[type="password"]').first().fill("alyq1234");
    await page.locator('button[type="submit"]').first().click();
    await page.waitForURL(/#\/(dashboard|pos)/, { timeout: 15000 });

    await page.goto(`http://127.0.0.1:${PORT}/#/dashboard/products`, { waitUntil: "networkidle" });

    // Seed BR104 in an archived category with legacy variant BR104-R-2 (color_key = 'r')
    const br104Id = await page.evaluate(() => {
      localStorage.setItem("alyq.lang", "ar");
      const raw = localStorage.getItem("alyq.demo.catalog.v1");
      if (!raw) return null;
      const state = JSON.parse(raw);
      const id = "0d9fc36f-b4cc-4526-8b63-f0048b559278";
      const catId = state.categories[0]?.id || "cat-1";
      // Archive the category to reproduce Production state
      if (state.categories[0]) {
        state.categories[0].active = false;
      }
      state.products = state.products.filter((p) => p.id !== id && p.sku !== "BR104");
      state.products.unshift({
        id,
        sku: "BR104",
        barcode: "BR104",
        name_ar: "BR-104",
        name_en: "BR-104",
        description_ar: null,
        description_en: null,
        category_id: catId,
        product_type: "physical",
        selling_price: 220,
        cost_price: 85,
        tax_rate: 0,
        stock_tracking_enabled: true,
        variants_enabled: false,
        stock_quantity: 3,
        low_stock_level: 5,
        show_on_website: true,
        is_featured: false,
        active: true,
        image_url: null,
        images: [],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
      state.variants = (state.variants || []).filter((v) => v.product_id !== id);
      state.variants.push({
        id: "257b57df-6bc4-48e9-9eb4-62e894d4fd9a",
        product_id: id,
        sku: "BR104-R-2",
        barcode: "BR104-R-2",
        color_key: "r",
        color_ar: "روز",
        color_en: "ROSE",
        color_hex: "#ec4899",
        size: null,
        size_label: null,
        size_value: null,
        size_sort_order: 0,
        image_url: null,
        display_name_ar: null,
        display_name_en: null,
        images: [],
        price_override: null,
        cost_override: null,
        stock_quantity: 0,
        low_stock_level: 5,
        active: true,
        sort_order: 1,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
      localStorage.setItem("alyq.demo.catalog.v1", JSON.stringify(state));
      return id;
    });

    await page.reload({ waitUntil: "networkidle" });
    await page.goto(`http://127.0.0.1:${PORT}/#/dashboard/products/${br104Id}/edit`, { waitUntil: "networkidle" });
    await page.waitForSelector('[data-testid="variant-editor"]', { timeout: 10000 });
    await page.waitForTimeout(400);

    // 1. Check zero horizontal overflow across iPhone viewports (375, 390, 430)
    for (const width of [375, 390, 430]) {
      await page.setViewportSize({ width, height: 844 });
      await page.waitForTimeout(150);
      const metrics = await page.evaluate(() => {
        const skuInput = document.querySelector('[data-testid^="variant-field-sku-"]');
        const barcodeInput = document.querySelector('[data-testid^="variant-field-barcode-"]');
        const saveBtn = document.querySelector('[data-testid="variant-simple-save"]');
        return {
          innerWidth: window.innerWidth,
          docScrollWidth: document.documentElement.scrollWidth,
          skuRect: skuInput ? skuInput.getBoundingClientRect().toJSON() : null,
          barcodeRect: barcodeInput ? barcodeInput.getBoundingClientRect().toJSON() : null,
          saveBtnRect: saveBtn ? saveBtn.getBoundingClientRect().toJSON() : null,
        };
      });
      console.log(`Viewport ${width}px metrics:`, JSON.stringify(metrics));
      assert.ok(metrics.docScrollWidth <= metrics.innerWidth + 1, `Expected no horizontal overflow at ${width}px, got ${metrics.docScrollWidth}`);
      assert.ok(metrics.skuRect.left >= 0 && metrics.skuRect.right <= metrics.innerWidth, `SKU input clipped at ${width}px`);
      assert.ok(metrics.barcodeRect.left >= 0 && metrics.barcodeRect.right <= metrics.innerWidth, `Barcode input clipped at ${width}px`);
    }

    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(200);
    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, "03-after-iphone-390-variants.png"),
      fullPage: false,
    });

    const tableEl = page.locator('[data-testid="product-variant-table"]').first();
    await tableEl.scrollIntoViewIfNeeded();
    await page.waitForTimeout(200);
    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, "04-after-iphone-390-mobile-cards.png"),
      fullPage: false,
    });

    // 2. Add RED color keystroke by keystroke alongside ROSE (BR104-R-2) and click Save Combinations
    await page.locator('[data-testid="variant-add-color"]').click();
    await page.locator('[data-testid="variant-color-ar-1"]').fill("أحمر");
    const colorEn1 = page.locator('[data-testid="variant-color-en-1"]');
    await colorEn1.fill("R");
    await colorEn1.fill("RE");
    await colorEn1.fill("RED");

    const skuInputs = page.locator('[data-testid^="variant-field-sku-"]');
    assert.equal(await skuInputs.count(), 2);
    assert.equal(await skuInputs.nth(0).inputValue(), "BR104-R-2");
    assert.equal(await skuInputs.nth(1).inputValue(), "BR104-RED");

    await page.locator('[data-testid="variant-simple-save"]').click();
    await page.waitForTimeout(400);

    await page.locator('[data-testid="product-variant-table"]').scrollIntoViewIfNeeded();
    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, "05-after-iphone-390-saved-combinations.png"),
      fullPage: false,
    });

    // Verify persistence after reload
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForSelector('[data-testid="variant-editor"]', { timeout: 10000 });
    const afterReload = await page.evaluate((id) => {
      const state = JSON.parse(localStorage.getItem("alyq.demo.catalog.v1"));
      const prod = state.products.find((p) => p.id === id);
      const vars = state.variants.filter((v) => v.product_id === id);
      return { prod, vars };
    }, br104Id);
    console.log("After Save Combinations reload:", JSON.stringify({
      stock: afterReload.prod.stock_quantity,
      variants: afterReload.vars.map((v) => ({ id: v.id, sku: v.sku, color_key: v.color_key, color_en: v.color_en })),
    }));
    assert.equal(afterReload.prod.stock_quantity, 3);
    assert.equal(afterReload.vars.length, 2);
    assert.equal(afterReload.vars[0].sku, "BR104-R-2");
    assert.equal(afterReload.vars[0].color_key, "rose");
    assert.equal(afterReload.vars[1].sku, "BR104-RED");
    assert.equal(afterReload.vars[1].color_key, "red");

    // 3. Edit product name on BR104 (in archived category) AND edit a variant price, then click main ProductForm Save
    await page.locator('[data-testid="variant-field-price-257b57df-6bc4-48e9-9eb4-62e894d4fd9a"]').fill("250");
    await page.locator('#name_ar').fill("إسورة ذهبية BR-104");
    await page.locator('#name_en').fill("Gold Bracelet BR-104");
    await page.locator('[data-testid="product-form-save"]').click();
    await page.waitForURL(new RegExp(`#/dashboard/products/${br104Id}$`), { timeout: 10000 });

    const afterProductSave = await page.evaluate((id) => {
      const state = JSON.parse(localStorage.getItem("alyq.demo.catalog.v1"));
      const prod = state.products.find((p) => p.id === id);
      const vars = state.variants.filter((v) => v.product_id === id);
      return { prod, vars };
    }, br104Id);
    assert.equal(afterProductSave.prod.name_ar, "إسورة ذهبية BR-104");
    assert.equal(afterProductSave.prod.name_en, "Gold Bracelet BR-104");
    assert.equal(afterProductSave.prod.stock_quantity, 3);
    assert.equal(afterProductSave.vars.find((v) => v.sku === "BR104-R-2").price_override, 250);
    console.log("After Save Product + auto-flushed variant edit: PASS");

    // 4. Desktop (1280x800) check & screenshot in a true Desktop context
    const storageState = await context.storageState();
    const desktopContext = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      deviceScaleFactor: 2,
      isMobile: false,
      hasTouch: false,
      locale: "ar-EG",
      storageState,
    });
    const desktopPage = await desktopContext.newPage();
    await desktopPage.goto(`http://127.0.0.1:${PORT}/#/dashboard/products/${br104Id}/edit`, { waitUntil: "networkidle" });
    await desktopPage.waitForSelector('[data-testid="product-variant-table"]', { timeout: 10000 });
    await desktopPage.locator('[data-testid="product-variant-table"]').scrollIntoViewIfNeeded();
    await desktopPage.waitForTimeout(200);
    const desktopDisplay = await desktopPage.evaluate(() => {
      const t = document.querySelector('[data-testid="product-variant-table"]');
      return t ? getComputedStyle(t).display : null;
    });
    assert.equal(desktopDisplay, "table");
    await desktopPage.screenshot({
      path: path.join(SCREENSHOT_DIR, "06-after-desktop-1280-unchanged.png"),
      fullPage: false,
    });
    await desktopContext.close();
    console.log("Desktop 1280x800 table layout verified: PASS");
  } finally {
    await browser.close();
    server.kill("SIGKILL");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
