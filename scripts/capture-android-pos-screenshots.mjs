#!/usr/bin/env node
/**
 * Captures real Chromium mobile viewport (390×844) screenshots of the unified
 * ALYQ Full POS Android application across all core modules.
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "docs", "screenshots", "android-pos");
fs.mkdirSync(outDir, { recursive: true });

const PORT = 4179;
const BASE_URL = `http://127.0.0.1:${PORT}`;

async function waitForServer(url, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

const server = spawn(
  "npx",
  ["vite", "--host", "127.0.0.1", "--port", String(PORT), "--strictPort"],
  { cwd: root, stdio: "inherit" },
);

try {
  await waitForServer(BASE_URL);
  const browser = await chromium.launch({ headless: true });
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
  await page.goto(`${BASE_URL}/#/`, { waitUntil: "networkidle" });
  await page.waitForSelector('input[autocomplete="username"]', { timeout: 15000 });
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(outDir, "01-android-pos-login.png") });

  // Sign in as admin
  await page.fill('input[autocomplete="username"]', "admin");
  await page.fill('input[autocomplete="current-password"]', "alyq123");
  await page.click('button[type="submit"]');
  await page.waitForSelector('[data-testid="mobile-pos-bottom-nav"]', { timeout: 15000 });
  await page.waitForTimeout(800);

  // 2. Dashboard (English)
  await page.screenshot({ path: path.join(outDir, "02-android-pos-dashboard-en.png") });

  // 3. Dashboard (Arabic RTL)
  const langToggle = page.locator('header button:has-text("العربية")');
  if (await langToggle.count()) {
    await langToggle.click();
    await page.waitForTimeout(600);
    await page.screenshot({ path: path.join(outDir, "03-android-pos-dashboard-ar.png") });
  }

  // 4. All POS Modules Bottom Sheet (Arabic RTL)
  await page.click('[data-testid="mobile-pos-modules-trigger"]');
  await page.waitForSelector('[data-testid="mobile-pos-modules-sheet"]', { timeout: 10000 });
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(outDir, "04-android-pos-modules-sheet.png") });
  await page.click('[data-testid="mobile-pos-modules-close"]');
  await page.waitForTimeout(300);

  // Open a shift first so POS checkout is ready
  await page.goto(`${BASE_URL}/#/dashboard/shifts`, { waitUntil: "networkidle" });
  await page.waitForTimeout(600);
  const openShiftBtn = page.locator('button:has-text("فتح وردية"), button:has-text("Open shift")').first();
  if (await openShiftBtn.count()) {
    await openShiftBtn.click();
    await page.waitForTimeout(400);
    const dialog = page.locator('[role="dialog"]').last();
    const textInput = dialog.locator('input[type="text"]:not([readonly])').first();
    if (await textInput.count()) await textInput.fill("Main branch");
    const decInput = dialog.locator('input[inputmode="decimal"]').first();
    if (await decInput.count()) await decInput.fill("500");
    await dialog.locator('button:has-text("فتح"), button:has-text("Open shift")').last().click();
    await page.waitForTimeout(600);
  }
  await page.screenshot({ path: path.join(outDir, "12-android-pos-shifts-expenses.png") });

  // 5. POS Register / Cashier
  await page.goto(`${BASE_URL}/#/dashboard/pos`, { waitUntil: "networkidle" });
  await page.waitForSelector('[data-testid="pos-scan-search"]', { timeout: 15000 });
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(outDir, "05-android-pos-register-cashier.png") });

  // 6. Camera Barcode Scanner Modal
  await page.click('[data-testid="pos-camera-scan-btn"]');
  await page.waitForSelector('[data-testid="pos-camera-scanner-modal"]', { timeout: 10000 });
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(outDir, "06-android-pos-camera-scanner.png") });

  // Find a product SKU and submit via camera scanner modal
  const firstSku = await page.locator('[data-testid^="pos-catalog-product-"] span.font-mono').first().textContent();
  await page.fill('[data-testid="pos-camera-manual-input"]', (firstSku ?? "").trim());
  await page.click('[data-testid="pos-camera-manual-submit"]');
  await page.waitForTimeout(400);

  const variantOption = page.locator('[data-testid^="variant-option-"]:not([disabled])').first();
  if (await variantOption.count()) {
    await variantOption.click();
    await page.waitForTimeout(400);
  }

  // 7. Mobile Cart & Checkout Drawer
  await page.waitForSelector('[data-testid="pos-mobile-cart-open"]', { timeout: 10000 });
  await page.click('[data-testid="pos-mobile-cart-open"]');
  await page.waitForSelector('[data-testid="pos-mobile-cart-drawer"]', { timeout: 10000 });
  await page.waitForTimeout(400);
  const drawer = page.locator('[data-testid="pos-mobile-cart-drawer"]');
  await drawer.locator('[data-testid="cash-input"]').fill("2000");
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(outDir, "07-android-pos-cart-checkout-drawer.png") });

  // 8. Complete Sale & Receipt Print Modal
  await drawer.locator('button:has-text("✓")').click();
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(outDir, "08-android-pos-sale-completed-receipt.png") });
  const closeSaleModalBtn = page.locator('[role="dialog"] button').first();
  if (await closeSaleModalBtn.count()) await closeSaleModalBtn.click();
  await page.waitForTimeout(300);

  // 9. Products & Barcodes
  await page.goto(`${BASE_URL}/#/dashboard/products`, { waitUntil: "networkidle" });
  await page.waitForTimeout(700);
  await page.screenshot({ path: path.join(outDir, "09-android-pos-products-barcodes.png") });

  // 10. Inventory & Exact Shelves
  await page.goto(`${BASE_URL}/#/dashboard/inventory/stock`, { waitUntil: "networkidle" });
  await page.waitForTimeout(700);
  await page.screenshot({ path: path.join(outDir, "10-android-pos-inventory-shelves.png") });

  // 11. Online Orders
  await page.goto(`${BASE_URL}/#/dashboard/online/orders`, { waitUntil: "networkidle" });
  await page.waitForTimeout(700);
  await page.screenshot({ path: path.join(outDir, "11-android-pos-online-orders.png") });

  // 13. Offline POS Sync Center
  await page.goto(`${BASE_URL}/#/dashboard/sync`, { waitUntil: "networkidle" });
  await page.waitForTimeout(700);
  await page.screenshot({ path: path.join(outDir, "13-android-pos-offline-sync.png") });

  // 14. Legacy Mobile Management (/mobile/more) with Full POS Bridge
  await page.goto(`${BASE_URL}/#/mobile/more`, { waitUntil: "networkidle" });
  await page.waitForTimeout(700);
  await page.screenshot({ path: path.join(outDir, "14-android-pos-legacy-mobile-more.png") });

  await browser.close();
  console.log("✓ Captured all 14 Android Full POS screenshots in docs/screenshots/android-pos/");
} finally {
  server.kill("SIGTERM");
}
