#!/usr/bin/env node
/**
 * Captures real Chromium mobile viewport (390×844) screenshots of the unified
 * ALYQ Full POS Android application across all core modules.
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright-core";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "docs", "screenshots", "android-pos");
fs.mkdirSync(outDir, { recursive: true });

const PORT = 4179;
const BASE_URL = `http://127.0.0.1:${PORT}`;

const chromePaths = [
  process.env.CHROME_PATH,
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium-browser",
  "/usr/bin/chromium",
].filter((p) => typeof p === "string" && fs.existsSync(p));

const viteServer = await createServer({
  root,
  server: { host: "127.0.0.1", port: PORT, strictPort: true },
  logLevel: "error",
});
await viteServer.listen();

let browser;
try {
  browser = await chromium.launch({
    headless: true,
    executablePath: chromePaths[0],
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });

  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  });

  const page = await context.newPage();

  // Enable Native Android POS mode before boot
  await page.addInitScript(() => {
    window.localStorage.setItem("alyq.mobile.native_pos.v1", "1");
    window.ALYQAndroidPrint = {
      isSupported: () => true,
      printHtml: () => true,
    };
  });

  // 1. Login Screen (#/ redirects to #/dashboard -> #/login)
  await page.goto(`${BASE_URL}/#/`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('input[autocomplete="username"]', { timeout: 15000 });
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(outDir, "01-android-pos-login.png") });
  console.log("  ✓ 01-android-pos-login.png");

  // Sign in as admin
  await page.fill('input[autocomplete="username"]', "admin");
  await page.fill('input[autocomplete="current-password"]', "alyq123");
  await page.click('button[type="submit"]');
  await page.waitForSelector('[data-testid="mobile-pos-bottom-nav"]', { timeout: 15000 });
  await page.waitForTimeout(800);

  // 2 & 3. Dashboard (default language & toggled language)
  const htmlDir = await page.getAttribute("html", "dir");
  if (htmlDir === "rtl") {
    await page.screenshot({ path: path.join(outDir, "03-android-pos-dashboard-ar.png") });
    console.log("  ✓ 03-android-pos-dashboard-ar.png");
    const langBtn = page.locator('header button:has-text("English")').first();
    if (await langBtn.count()) {
      await langBtn.click();
      await page.waitForTimeout(600);
    }
    await page.screenshot({ path: path.join(outDir, "02-android-pos-dashboard-en.png") });
    console.log("  ✓ 02-android-pos-dashboard-en.png");
    // Switch back to Arabic RTL for the modules sheet screenshot
    const arBtn = page.locator('header button:has-text("العربية")').first();
    if (await arBtn.count()) {
      await arBtn.click();
      await page.waitForTimeout(500);
    }
  } else {
    await page.screenshot({ path: path.join(outDir, "02-android-pos-dashboard-en.png") });
    console.log("  ✓ 02-android-pos-dashboard-en.png");
    const arBtn = page.locator('header button:has-text("العربية")').first();
    if (await arBtn.count()) {
      await arBtn.click();
      await page.waitForTimeout(600);
    }
    await page.screenshot({ path: path.join(outDir, "03-android-pos-dashboard-ar.png") });
    console.log("  ✓ 03-android-pos-dashboard-ar.png");
  }

  // 4. All POS Modules Bottom Sheet
  await page.click('[data-testid="mobile-pos-modules-trigger"]');
  await page.waitForSelector('[data-testid="mobile-pos-modules-sheet"]', { timeout: 10000 });
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(outDir, "04-android-pos-modules-sheet.png") });
  console.log("  ✓ 04-android-pos-modules-sheet.png");
  await page.click('[data-testid="mobile-pos-modules-close"]');
  await page.waitForTimeout(300);

  // 12. Shifts & Open Shift
  await page.goto(`${BASE_URL}/#/dashboard/shifts`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(700);
  try {
    const openShiftBtn = page.locator('button:has-text("فتح وردية"), button:has-text("Open shift")').first();
    if (await openShiftBtn.count()) {
      await openShiftBtn.click();
      await page.waitForTimeout(400);
      const dialog = page.locator('[role="dialog"]').last();
      const textInput = dialog.locator('input[type="text"]:not([readonly])').first();
      if (await textInput.count()) await textInput.fill("Main branch");
      const decInput = dialog.locator('input[inputmode="decimal"]').first();
      if (await decInput.count()) await decInput.fill("500");
      const confirmShiftBtn = dialog.locator('button:has-text("فتح وردية"), button:has-text("Open shift")').last();
      if (await confirmShiftBtn.count()) {
        await confirmShiftBtn.click();
        await page.waitForTimeout(600);
      }
    }
  } catch (err) {
    console.warn("Shift open warning:", err);
  }
  await page.screenshot({ path: path.join(outDir, "12-android-pos-shifts-expenses.png") });
  console.log("  ✓ 12-android-pos-shifts-expenses.png");

  // 5. POS Register / Cashier
  await page.goto(`${BASE_URL}/#/dashboard/pos`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="pos-scan-search"]', { timeout: 15000 });
  await page.waitForTimeout(700);
  await page.screenshot({ path: path.join(outDir, "05-android-pos-register-cashier.png") });
  console.log("  ✓ 05-android-pos-register-cashier.png");

  // Read first SKU before opening modal
  let firstSku = "";
  const skuLocator = page.locator('[data-testid^="pos-catalog-product-"] span.font-mono').first();
  if (await skuLocator.count()) {
    firstSku = ((await skuLocator.textContent()) ?? "").trim();
  }

  // 6. Camera Barcode Scanner Modal
  await page.click('[data-testid="pos-camera-scan-btn"]');
  await page.waitForSelector('[data-testid="pos-camera-scanner-modal"]', { timeout: 10000 });
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(outDir, "06-android-pos-camera-scanner.png") });
  console.log("  ✓ 06-android-pos-camera-scanner.png");

  if (firstSku) {
    await page.fill('[data-testid="pos-camera-manual-input"]', firstSku);
    await page.click('[data-testid="pos-camera-manual-submit"]');
    await page.waitForTimeout(500);
  } else {
    await page.click('[data-testid="pos-camera-scanner-close"]');
    await page.waitForTimeout(300);
  }

  const variantOption = page.locator('[data-testid^="variant-option-"]:not([disabled])').first();
  if (await variantOption.count()) {
    await variantOption.click();
    await page.waitForTimeout(400);
  }

  // 7. Mobile Cart & Checkout Drawer
  const cartOpenBtn = page.locator('[data-testid="pos-mobile-cart-open"]');
  if (await cartOpenBtn.count()) {
    await cartOpenBtn.click();
    await page.waitForSelector('[data-testid="pos-mobile-cart-drawer"]', { timeout: 10000 });
    await page.waitForTimeout(400);
    const drawer = page.locator('[data-testid="pos-mobile-cart-drawer"]');
    const cashInput = drawer.locator('[data-testid="cash-input"]');
    if (await cashInput.count()) {
      await cashInput.fill("2000");
      await page.waitForTimeout(300);
    }
    await page.screenshot({ path: path.join(outDir, "07-android-pos-cart-checkout-drawer.png") });
    console.log("  ✓ 07-android-pos-cart-checkout-drawer.png");

    // 8. Complete Sale & Receipt Print Modal
    const completeBtn = drawer.locator('button:has-text("✓")').first();
    if (await completeBtn.count()) {
      await completeBtn.click();
      await page.waitForTimeout(700);
    }
    await page.screenshot({ path: path.join(outDir, "08-android-pos-sale-completed-receipt.png") });
    console.log("  ✓ 08-android-pos-sale-completed-receipt.png");
  } else {
    await page.screenshot({ path: path.join(outDir, "07-android-pos-cart-checkout-drawer.png") });
    await page.screenshot({ path: path.join(outDir, "08-android-pos-sale-completed-receipt.png") });
  }

  // 9. Products & Barcodes
  await page.goto(`${BASE_URL}/#/dashboard/products`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(700);
  await page.screenshot({ path: path.join(outDir, "09-android-pos-products-barcodes.png") });
  console.log("  ✓ 09-android-pos-products-barcodes.png");

  // 10. Inventory & Exact Shelves
  await page.goto(`${BASE_URL}/#/dashboard/inventory/stock`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(700);
  await page.screenshot({ path: path.join(outDir, "10-android-pos-inventory-shelves.png") });
  console.log("  ✓ 10-android-pos-inventory-shelves.png");

  // 11. Online Orders
  await page.goto(`${BASE_URL}/#/dashboard/online/orders`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(700);
  await page.screenshot({ path: path.join(outDir, "11-android-pos-online-orders.png") });
  console.log("  ✓ 11-android-pos-online-orders.png");

  // 13. Offline POS Sync Center
  await page.goto(`${BASE_URL}/#/dashboard/sync`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(700);
  await page.screenshot({ path: path.join(outDir, "13-android-pos-offline-sync.png") });
  console.log("  ✓ 13-android-pos-offline-sync.png");

  // 14. Legacy Mobile Management (/mobile/more) with Full POS Bridge
  await page.goto(`${BASE_URL}/#/mobile/more`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(700);
  await page.screenshot({ path: path.join(outDir, "14-android-pos-legacy-mobile-more.png") });
  console.log("  ✓ 14-android-pos-legacy-mobile-more.png");

  console.log("✓ Captured all 14 Android Full POS screenshots in docs/screenshots/android-pos/");
} finally {
  if (browser) await browser.close();
  await viteServer.close();
}
process.exit(0);
