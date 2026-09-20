/** Real Chromium layout acceptance. Unlike jsdom this measures actual pixels.
 *
 * Self-contained: `npm run test:rendered` starts its own Vite dev server on
 * 127.0.0.1:5173 (override the port with VISUAL_PORT), waits for readiness,
 * runs the Chromium checks, then shuts the server down — no manually started
 * dev server required. Point VISUAL_BASE_URL at a provisioned server (sandbox,
 * CI) to skip the managed one.
 * Optional: CHROMIUM_EXECUTABLE=/path/to/chromium (for a provisioned sandbox).
 * Evidence is written to ignored coverage/visual, never bundled with the app.
 */
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MANAGED_PORT_WANT = Number(process.env.VISUAL_PORT ?? 0);
let base = process.env.VISUAL_BASE_URL ?? null;
let server = null;
/** A free loopback port: a stale server from an earlier run can never squat it. */
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port;
      probe.close(() => resolve(port));
    });
  });
}
async function ensureServer() {
  if (base) return base; // provisioned server: use as-is
  const port = MANAGED_PORT_WANT > 0 ? MANAGED_PORT_WANT : await freePort();
  base = `http://127.0.0.1:${port}`;
  // The rendered acceptance is specified against DEMO mode (seeded accounts,
  // localStorage fixtures). A developer machine often carries a `.env.local`
  // with Supabase credentials, which would boot the server into live mode and
  // reject the demo login — so the managed server clears exactly those two
  // variables. Real process env wins over `.env*` files in Vite, and empty
  // strings fail `isSupabaseConfigured`, so the app falls back to demo mode.
  // A provisioned VISUAL_BASE_URL is used as-is: its mode is the operator's.
  server = spawn(
    process.execPath,
    [path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
    {
      cwd: ROOT,
      stdio: 'pipe',
      windowsHide: true,
      env: { ...process.env, VITE_SUPABASE_URL: '', VITE_SUPABASE_ANON_KEY: '' },
    },
  );
  const logged = [];
  server.stdout?.on('data', (chunk) => logged.push(String(chunk)));
  server.stderr?.on('data', (chunk) => logged.push(String(chunk)));
  const deadline = Date.now() + 90000;
  for (;;) {
    try {
      const res = await fetch(`${base}/`);
      if (res.ok) break;
    } catch { /* not up yet */ }
    if (server.exitCode !== null) {
      throw new Error(`Vite dev server exited early:\n${logged.join('').slice(-2000)}`);
    }
    if (Date.now() > deadline) {
      server.kill();
      throw new Error(`Vite dev server did not become ready at ${base}:\n${logged.join('').slice(-2000)}`);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return base;
}
await ensureServer();
const output = 'coverage/visual';
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_EXECUTABLE || undefined,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.setDefaultTimeout(15000);
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
const results = [];
let firstLoad = true;
async function go(route) {
  // The first navigation compiles the app in the dev server (cold Vite cache
  // after `npm ci` transforms 400+ modules — tens of seconds on Windows), so
  // it gets a generous budget; every later navigation is a same-document hash
  // change that resolves instantly, and a hang there is a real failure.
  await page.goto(`${base}/#${route}`, firstLoad ? { timeout: 180000 } : undefined);
  firstLoad = false;
  await page.waitForTimeout(400);
}
async function layout(name, fullPage = true) {
  // Trigger lazy loading by actually scrolling; a full-page screenshot alone
  // does not load off-screen photographs in Chromium.
  await page.evaluate(async () => {
    for (let y = 0; y < document.documentElement.scrollHeight; y += 600) {
      window.scrollTo(0, y);
      await new Promise((resolve) => setTimeout(resolve, 35));
    }
    window.scrollTo(0, 0);
    await document.fonts.ready;
    await Promise.all([...document.images].filter((im) => im.currentSrc && im.getBoundingClientRect().width > 0).map((im) => Promise.race([im.decode().catch(() => {}), new Promise((resolve) => setTimeout(resolve, 5000))])));
  });
  await page.waitForTimeout(120);
  const measurements = await page.evaluate(() => ({
    viewport: innerWidth, scroll: document.documentElement.scrollWidth,
    dir: document.documentElement.dir,
    brokenImages: [...document.images].filter((im) => im.currentSrc && im.getBoundingClientRect().width > 0 && !im.naturalWidth).map((im) => im.currentSrc),
  }));
  assert.ok(measurements.scroll <= measurements.viewport, `${name}: horizontal overflow ${JSON.stringify(measurements)}`);
  assert.deepEqual(measurements.brokenImages, [], `${name}: broken image`);
  await page.screenshot({ path: `${output}/${name}.png`, fullPage });
  results.push({ name, ...measurements });
  console.log(`✓ ${name}: ${measurements.viewport}px, no overflow, images loaded, ${measurements.dir}`);
}
try {
  await go('/');
  await page.locator('input[autocomplete="username"]').fill('admin');
  await page.locator('input[type="password"]').fill('alyq1234');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByTestId('shell-brand')).toBeVisible();
  const primary = ['#/', '#/pos', '#/management', '#/online', '#/reports', '#/settings'];
  for (const [route, name] of [['/', 'admin-dashboard'], ['/management', 'admin-management'], ['/online', 'admin-online'], ['/settings', 'admin-settings']]) {
    await go(route);
    const hrefs = await page.locator('aside nav a').evaluateAll((links) => links.map((a) => a.getAttribute('href')));
    assert.deepEqual(hrefs, [...primary, '#/store']);
    assert.equal(hrefs.filter((href) => href === '#/settings').length, 1);
    await layout(name);
  }
  // Editor query tabs and browser Back are real history entries.
  await go('/online');
  await page.getByTestId('module-card-social').click();
  await expect(page.getByTestId('social-settings')).toBeVisible();
  await page.getByRole('button', { name: 'Checkout', exact: true }).click();
  await expect(page.getByTestId('checkout-copy-settings')).toBeVisible();
  await page.goBack();
  await expect(page.getByTestId('social-settings')).toBeVisible();
  await page.goBack();
  await expect(page.getByTestId('module-online')).toBeVisible();
  // Legacy modules and the legacy stock-filter URL still resolve.
  for (const route of ['/catalog', '/sales', '/inventory']) { await go(route); await expect(page.locator('[data-testid^="module-"]').first()).toBeVisible(); }
  await go('/inventory?status=low');
  await expect(page.locator('select[aria-label="Status"]')).toHaveValue('low');

  // Real UI creates the exact two-shelf variant fixture (no direct stock writes).
  await go('/products/new');
  for (const [id, value] of Object.entries({name_ar:'خاتم الفحص', name_en:'Everyday Ring', sku:'RENDER-RING', selling_price:'200', cost_price:'100', tax_rate:'0', stock_quantity:'4', low_stock_level:'1'})) {
    await page.locator(`#${id}`).fill(value);
  }
  const category = await page.locator('#category_id option').evaluateAll((options) => options.find((o) => o.value)?.value);
  await page.locator('#category_id').selectOption(category);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.waitForURL('**/#/products');
  const productId = await page.evaluate(() => JSON.parse(localStorage.getItem('alyq.demo.catalog.v1')).products.find((p) => p.sku === 'RENDER-RING').id);
  await go(`/products/${productId}/edit`);
  await page.getByTestId('variant-generate').click();
  await page.getByRole('dialog').locator('textarea').fill('Gold | ذهبي | #d4af37\nSilver | فضي | #c0c0c0');
  await page.getByRole('dialog').getByPlaceholder('16, 16.5', { exact: false }).fill('17');
  await page.getByRole('button', { name: 'Create 2', exact: true }).click();
  await page.getByTestId('variant-row-RENDER-RING-GOLD-17').waitFor();
  await page.getByTestId('variant-mode-toggle').click();
  await page.getByTestId('opening-RENDER-RING-GOLD-17').fill('2');
  await page.getByTestId('opening-RENDER-RING-SILVER-17').fill('2');
  await page.getByTestId('variant-enable-confirm').click();
  await expect(page.getByTestId('variant-enable-panel')).toHaveCount(0);
  // Fixture photography only; stock is never patched. UI-created products do
  // not have an uploaded image, so use a bundled asset in this isolated browser.
  await page.evaluate((id) => {
    const key = 'alyq.demo.catalog.v1';
    const data = JSON.parse(localStorage.getItem(key));
    const product = data.products.find((p) => p.id === id);
    product.image_url = '/brand/products/classic-gold-ring.jpg';
    localStorage.setItem(key, JSON.stringify(data));
    const contentsKey = 'alyq.demo.product_contents.v1';
    const contents = JSON.parse(localStorage.getItem(contentsKey) ?? '[]');
    contents.push({ product_id: id, brand_ar: 'أَلِــيْـــق', brand_en: 'ALYQ', slug: null,
      seo_title: null, seo_description: null, specs: [], media: [],
      description_en: 'A simple silhouette, styled your way.', description_ar: 'تصميم بسيط تنسقينه بطريقتك.',
      materials_en: 'See the selected finish and size above.', materials_ar: 'راجعي اللون والمقاس المحددين أعلاه.',
      care_en: 'Keep dry and store separately.', care_ar: 'تحفظ جافة وبشكل منفصل.',
      shipping_en: 'Delivery and pickup options at checkout.', shipping_ar: 'خيارات التوصيل والاستلام عند إتمام الطلب.',
      returns_en: 'Contact our team for return assistance.', returns_ar: 'تواصلي مع فريقنا للمساعدة في الإرجاع.',
      created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
    localStorage.setItem(contentsKey, JSON.stringify(contents));
  }, productId);
  // A second, variant-free product funds the staff-queue order below. The
  // ring's own shelves must stay exactly 2 + 2 for every PDP assertion that
  // follows, so this order is placed BEFORE the ring lines enter the cart —
  // the cart screenshots later still show the full ring cart.
  await go('/products/new');
  for (const [id, value] of Object.entries({name_ar:'سوار الفحص', name_en:'Everyday Band', sku:'RENDER-BAND', selling_price:'150', cost_price:'80', tax_rate:'0', stock_quantity:'4', low_stock_level:'1'})) {
    await page.locator(`#${id}`).fill(value);
  }
  await page.locator('#category_id').selectOption(category);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.waitForURL('**/#/products');
  const bandId = await page.evaluate(() => JSON.parse(localStorage.getItem('alyq.demo.catalog.v1')).products.find((p) => p.sku === 'RENDER-BAND').id);
  await page.evaluate((id) => {
    const key = 'alyq.demo.catalog.v1';
    const data = JSON.parse(localStorage.getItem(key));
    data.products.find((p) => p.id === id).image_url = '/brand/products/minimal-bracelet.jpg';
    localStorage.setItem(key, JSON.stringify(data));
  }, bandId);
  await go(`/store/products/${bandId}`);
  await page.getByTestId('product-add-to-cart').click();
  // One real order, so the staff queue below renders with data (not just its
  // empty state): the overflow contract has to hold with rows on screen.
  await go('/store/checkout');
  await page.locator("input[autocomplete='name']").fill('Mona Mahmoud Abdelrahman');
  await page.locator("input[autocomplete='tel']").fill('01001234567');
  await page.getByRole('button', { name: /^Pickup/ }).first().click().catch(() => {});
  await page.locator('input[name="payment"][value="cod"]').check({ force: true }).catch(() => {});
  await page.getByRole('button', { name: 'Place the order' }).click();
  await page.waitForURL('**#/store/confirmation', { timeout: 15000 });
  await page.reload();
  await go(`/store/products/${productId}`);
  await expect(page.getByTestId('product-add-to-cart')).toBeDisabled();
  await page.getByTestId('variant-color-gold').click();
  await page.getByRole('option', { name: '17', exact: true }).click();
  await expect(page.getByTestId('product-stock-line')).toContainText('2');
  await page.getByRole('button', { name: 'Increase quantity' }).click();
  await expect(page.getByRole('button', { name: 'Increase quantity' })).toBeDisabled();
  await page.getByTestId('product-add-to-cart').click();
  await page.getByTestId('variant-color-silver').click();
  await page.getByRole('option', { name: '17', exact: true }).click();
  await expect(page.getByTestId('product-stock-line')).toContainText('2');
  await page.getByTestId('product-add-to-cart').click();

  const screens = [['/store', 'home'], ['/store/products', 'listing'], [`/store/products/${productId}`, 'pdp'], ['/store/cart', 'cart'], ['/store/checkout', 'checkout'], ['/store/about', 'about']];
  for (const lang of ['en', 'ar']) {
    await page.evaluate((language) => localStorage.setItem('alyq.lang', language), lang);
    await page.reload();
    for (const width of [1440, 375, 390, 430]) {
      await page.setViewportSize({ width, height: width === 1440 ? 1000 : 844 });
      for (const [route, name] of screens) {
        await go(route);
        if (name === 'home') {
          await expect(page.locator('main section').first().locator('img:visible')).toHaveCount(1);
          const grid = await page.getByTestId('product-grid').first().evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(' ').length);
          assert.equal(grid, width === 1440 ? 4 : 2, 'actual rendered product columns');
          const logo = await page.locator('header a[href="#/store"]').boundingBox();
          assert.ok(Math.abs(logo.x + logo.width / 2 - width / 2) < 5, 'wordmark is geometrically centered');
          for (const box of await page.locator('header a:visible, header button:visible').evaluateAll((els) => els.map((el) => el.getBoundingClientRect().height))) assert.ok(box >= 40, 'header touch targets');
        }
        if (name === 'pdp') {
          assert.ok((await page.getByTestId('product-add-to-cart').boundingBox()).width >= 160, 'purchase button never collapses into a narrow text column');
          // Silver: Gold's shelf is fully held by the staff-queue order placed
          // above (available 0, correctly unsellable), so the geometry probe
          // uses the shelf that is still promiseable. Gold's own selectability
          // is proven before checkout, above.
          await page.getByTestId('variant-color-silver').click();
          await page.getByRole('option', { name: '17', exact: true }).click();
          for (const height of await page.getByTestId('store-variant-picker').getByRole('option').evaluateAll((els) => els.map((el) => el.getBoundingClientRect().height))) assert.ok(height >= 44, 'variant touch targets');
        }
        await layout(`${lang}-${width}-${name}`);
        if (name === 'home') await page.locator('footer').screenshot({ path: `${output}/${lang}-${width}-footer.png` });
      }
      // The staff order queue, WITH a real order on screen: the page itself
      // must never scroll sideways (the wide table scrolls inside its own
      // card), filters and date inputs must wrap, and cards must not force
      // the viewport at 375/390/430 in either language.
      await go('/online/orders');
      await layout(`${lang}-${width}-online-orders`);
      if (width !== 1440) {
        await go('/management');
        await page.locator('header button[aria-label]').first().click();
        const drawer = page.locator('aside[role="dialog"]');
        await expect(drawer).toBeVisible();
        assert.deepEqual(await drawer.locator('nav a').evaluateAll((links) => links.map((a) => a.getAttribute('href'))), [...primary, '#/store']);
        await layout(`${lang}-${width}-admin-drawer`, false);
      }
    }
  }
  assert.deepEqual(errors, [], 'no browser errors');
  await writeFile(`${output}/measurements.json`, JSON.stringify(results, null, 2));
  console.log(`Rendered acceptance: ${results.length} screens passed; EN/AR at 1440, 375, 390, 430.`);
} finally {
  await browser.close();
  // SIGKILL (TerminateProcess on Windows): a plain SIGTERM has been observed
  // to leave the dev server behind, and the orphan then squats the port and
  // hangs the *next* run's first navigation.
  if (server) { try { server.kill('SIGKILL'); } catch { /* already gone */ } }
}
