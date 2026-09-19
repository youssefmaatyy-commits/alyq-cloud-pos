/** Real Chromium layout acceptance. Unlike jsdom this measures actual pixels.
 * Start Vite, then: npm run test:rendered
 * Optional: CHROMIUM_EXECUTABLE=/path/to/chromium (for a provisioned sandbox).
 * Evidence is written to ignored coverage/visual, never bundled with the app.
 */
import { chromium, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const base = process.env.VISUAL_BASE_URL ?? 'http://127.0.0.1:5173';
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
async function go(route) {
  await page.goto(`${base}/#${route}`);
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
          await page.getByTestId('variant-color-gold').click();
          await page.getByRole('option', { name: '17', exact: true }).click();
          for (const height of await page.getByTestId('store-variant-picker').getByRole('option').evaluateAll((els) => els.map((el) => el.getBoundingClientRect().height))) assert.ok(height >= 44, 'variant touch targets');
        }
        await layout(`${lang}-${width}-${name}`);
        if (name === 'home') await page.locator('footer').screenshot({ path: `${output}/${lang}-${width}-footer.png` });
      }
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
}
