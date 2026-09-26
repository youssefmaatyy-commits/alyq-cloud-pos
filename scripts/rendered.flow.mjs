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
let browser;
try {
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_EXECUTABLE || undefined,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
    // The POS checkout test drags a *real* scrollbar thumb, which Playwright
    // otherwise hides in headless Chromium by default.
    ignoreDefaultArgs: ['--hide-scrollbars'],
  });
} catch (error) {
  // A missing Chromium installation still must not orphan the managed Vite
  // server; otherwise a later visual run could silently hit stale code.
  if (server) { try { server.kill('SIGKILL'); } catch { /* already gone */ } }
  throw error;
}
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

/** Real scrollport geometry, wheel/trackpad input, scrollbar drag, and touch.
 * Both the desktop checkout and the tablet cart drawer use this contract. */
async function cashierScroll(panel, { lang, name, height, touch = false }) {
  await panel.evaluate((el) => { el.scrollTop = 0; });
  const start = await panel.evaluate((el) => {
    const cart = el.querySelector('[data-testid="pos-cart"]');
    const payment = el.lastElementChild;
    return {
      overflow: getComputedStyle(el).overflowY,
      rect: el.getBoundingClientRect().toJSON(),
      cart: cart.getBoundingClientRect().toJSON(),
      payment: payment.getBoundingClientRect().toJSON(),
      clientHeight: el.clientHeight,
      scrollHeight: el.scrollHeight,
      clientWidth: el.clientWidth,
      scrollWidth: el.scrollWidth,
      scrollbarWidth: el.offsetWidth - el.clientWidth,
    };
  });
  assert.equal(start.overflow, 'auto', `${name}: checkout is the scroll container`);
  assert.ok(start.clientHeight > 0 && start.scrollHeight > start.clientHeight + 10, `${name}: checkout must actually overflow`);
  assert.ok(start.cart.height >= 300, `${name}: cart/customer/discount must not collapse behind payment`);
  assert.ok(start.payment.top >= start.cart.bottom + 10, `${name}: payment must not overlap cart`);
  assert.ok(start.rect.bottom <= height + 1, `${name}: scrollport must end above the viewport bottom`);
  assert.ok(start.scrollWidth <= start.clientWidth + 2, `${name}: no sideways cashier scroll`);
  assert.ok(start.scrollbarWidth >= 8, `${name}: visible scrollbar can be dragged`);
  if (await panel.getAttribute('data-testid') === 'pos-checkout-panel') {
    assert.ok(await page.evaluate(() => document.documentElement.scrollHeight <= Math.max(
      innerHeight, innerWidth < 1280 ? 680 : 632,
    ) + 1), `${name}: expanding payment or the cart must not force additional document scrolling`);
  }

  const beforeWindowY = await page.evaluate(() => window.scrollY);
  const box = await panel.boundingBox();
  // Point at the payment area, not the nested cart-line list: the wheel must
  // scroll checkout rather than accidentally selecting a second scrollport.
  await page.mouse.move(box.x + box.width / 2, box.y + box.height - 30);
  await page.mouse.wheel(0, 5000);
  await expect.poll(() => panel.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  await expect.poll(() => panel.evaluate((el) => Math.abs(el.scrollHeight - el.clientHeight - el.scrollTop))).toBeLessThan(2);
  const complete = await panel.evaluate((el, language) => {
    const label = language === 'ar' ? 'إتمام البيع' : 'Complete sale';
    const button = [...el.querySelectorAll('button')].find((item) => item.textContent.includes(label));
    const pane = el.getBoundingClientRect();
    const rect = button?.getBoundingClientRect();
    return rect && { top: rect.top, bottom: rect.bottom, paneTop: pane.top, paneBottom: pane.bottom };
  }, lang);
  assert.ok(complete && complete.top >= complete.paneTop - 1 && complete.bottom <= complete.paneBottom + 1,
    `${name}: Complete sale is reachable at the bottom of checkout`);
  assert.equal(await page.evaluate(() => window.scrollY), beforeWindowY, `${name}: wheel did not move the whole page`);

  // Chrome's headless default hides scrollbars, so the launch above explicitly
  // enables them. Drag the thumb on the right in LTR or left in RTL.
  await panel.evaluate((el) => { el.scrollTop = 0; });
  const thumbX = lang === 'ar' ? box.x + 5 : box.x + box.width - 5;
  await page.mouse.move(thumbX, box.y + 30);
  await page.mouse.down();
  await page.mouse.move(thumbX, box.y + box.height - 30, { steps: 10 });
  await page.mouse.up();
  await expect.poll(() => panel.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);

  if (touch) {
    await panel.evaluate((el) => { el.scrollTop = 0; });
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
    try {
      const x = box.x + box.width / 2;
      const y = box.y + box.height - 35;
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
      for (let step = 1; step <= 14; step += 1) {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y - step * 32 }] });
        await page.waitForTimeout(15);
      }
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await expect.poll(() => panel.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
    } finally {
      await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false });
      await cdp.detach();
    }
    assert.equal(await page.evaluate(() => window.scrollY), beforeWindowY, `${name}: touch stays inside checkout`);
  }
  console.log(`✓ ${name}: wheel/trackpad, thumb drag${touch ? ', touch' : ''}, bottom controls reachable`);
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
  await page.locator('[data-testid="product-form-save"]').click();
  await page.waitForURL('**/#/products');
  const productId = await page.evaluate(() => JSON.parse(localStorage.getItem('alyq.demo.catalog.v1')).products.find((p) => p.sku === 'RENDER-RING').id);
  await go(`/products/${productId}/edit`);
  // The legacy generator is intentionally inside an Advanced disclosure now;
  // real browser clicks cannot reach a collapsed details element.
  await page.getByTestId('variant-advanced').locator('summary').click();
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
  await page.locator('[data-testid="product-form-save"]').click();
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
          if (lang === 'en' && width === 1440) {
            const palette = await page.evaluate(() => {
              const vars = getComputedStyle(document.documentElement);
              return {
                primary: vars.getPropertyValue('--store-primary').trim(),
                background: vars.getPropertyValue('--store-background').trim(),
                surface: vars.getPropertyValue('--store-surface').trim(),
                accent: vars.getPropertyValue('--store-accent').trim(),
                pageBackground: getComputedStyle(document.querySelector('header').parentElement).backgroundColor,
              };
            });
            assert.deepEqual(palette, { primary: '#202427', background: '#f8f9f6', surface: '#ffffff',
              accent: '#a48d59', pageBackground: 'rgb(248, 249, 246)' },
              'the real storefront renders the ivory/white/charcoal/gold default');
          }
          const grid = await page.getByTestId('product-grid').first().evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(' ').length);
          assert.equal(grid, width === 1440 ? 4 : 2, 'actual rendered product columns');
          const logo = await page.locator('header a[href="#/store"]').boundingBox();
          // With visible scrollbars, center in the content viewport rather
          // than the scrollbar gutter at the window edge.
          const contentWidth = await page.evaluate(() => document.documentElement.clientWidth);
          assert.ok(Math.abs(logo.x + logo.width / 2 - contentWidth / 2) < 5, 'wordmark is geometrically centered');
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
  // Admin customization must survive a REAL reload and affect rendered pages,
  // not just the builder's preview or the default theme used above.
  await page.evaluate(() => localStorage.setItem('alyq.lang', 'en'));
  await page.reload();
  await go('/online/website?tab=theme');
  await expect(page.getByTestId('theme-presets')).toBeVisible();
  await page.locator('input[aria-label="Primary"]:not([type="color"])').fill('#0f766e');
  await page.locator('input[aria-label="Background"]:not([type="color"])').fill('#f1fbf6');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('alyq.demo.website_settings.v1'))?.settings?.theme?.primary_color === '#0f766e');
  await expect(page.getByRole('button', { name: 'Save', exact: true }).locator('.animate-spin')).toHaveCount(0);
  await go('/store');
  await page.reload();
  await page.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue('--store-primary').trim() === '#0f766e');
  for (const width of [1440, 375]) {
    await page.setViewportSize({ width, height: width === 1440 ? 1000 : 844 });
    for (const [route, name] of [['/store', 'home'], ['/store/products', 'listing']]) {
      await go(route);
      const palette = await page.evaluate(() => {
        const vars = getComputedStyle(document.documentElement);
        return {
          primary: vars.getPropertyValue('--store-primary').trim(),
          background: vars.getPropertyValue('--store-background').trim(),
          pageBackground: getComputedStyle(document.querySelector('header').parentElement).backgroundColor,
        };
      });
      assert.deepEqual(palette, { primary: '#0f766e', background: '#f1fbf6', pageBackground: 'rgb(241, 251, 246)' },
        `saved settings render after reload on ${width}px ${name}`);
      await layout(`saved-en-${width}-${name}`);
    }
  }
  await go('/pos');
  await expect(page.locator('#alyq-store-theme')).toHaveCount(0);

  // The register needs more matches than fit on screen to prove the result
  // list scrolls inside its own dropdown instead of clipping or pushing the
  // checkout around. Clone a real seeded plain product ONLY in this browser's
  // demo fixture, then reload so the demo repository sees the data.
  // No stock/price/checkout implementation is changed by this visual fixture.
  await page.evaluate(() => {
    const key = 'alyq.demo.catalog.v1';
    const data = JSON.parse(localStorage.getItem(key));
    const baseProduct = data.products.find((product) => product.sku === 'ALYQ-1002');
    if (!baseProduct) throw new Error('Missing POS layout fixture template');
    for (let i = 0; i < 24; i += 1) {
      data.products.push({
        ...baseProduct,
        id: `pos-layout-${i}`,
        sku: `POS-LAYOUT-${i}`,
        barcode: null,
        name_en: `Long display bracelet number ${i}`,
        name_ar: `سوار عرض طويل رقم ${i}`,
        image_url: null,
        selling_price: 4250,
        stock_quantity: 12,
        low_stock_level: 1,
        show_on_website: false,
        is_featured: false,
      });
    }
    localStorage.setItem(key, JSON.stringify(data));
  });
  await page.reload();

  for (const lang of ['en', 'ar']) {
    await page.evaluate((language) => localStorage.setItem('alyq.lang', language), lang);
    await page.reload();
    // 1093×614 is the CSS viewport of a 1366×768 laptop at ~125% browser zoom.
    for (const [width, height] of [[1366, 768], [1920, 1080], [1366, 600], [1093, 614], [820, 900]]) {
      await page.setViewportSize({ width, height });
      await go('/pos');
      const search = page.getByTestId('pos-scan-search');
      await expect(search).toBeVisible();
      // No browsable catalogue may render, whatever the catalogue size.
      await expect(page.getByTestId('pos-grid')).toHaveCount(0);
      await expect(page.locator('[data-testid^="pos-product-"]')).toHaveCount(0);
      await expect(page.locator('[data-testid^="pos-category-chip-"]')).toHaveCount(0);
      // The variant ring announces its picker before any click.
      await search.fill('RENDER-RING');
      const ringRow = page.getByTestId(`pos-result-${productId}`);
      await expect(ringRow).toBeVisible();
      await expect(ringRow).toContainText(lang === 'ar' ? 'لون ومقاس' : 'Colour & size');

      await search.fill('Long display bracelet');
      const list = page.getByTestId('pos-search-results');
      const target = page.getByTestId('pos-result-pos-layout-23');
      await expect(target).toBeAttached();
      await page.evaluate(() => window.scrollTo(0, 0));

      // Measure *every* rendered row and its price + stock, including rows
      // below the fold. document.scrollWidth alone misses overflow trapped
      // inside the result list.
      const measure = await page.evaluate(() => {
        const element = (id) => document.querySelector(`[data-testid="${id}"]`);
        const box = element('pos-scan-search');
        const list = element('pos-search-results');
        const column = element('pos-search-column');
        const checkout = element('pos-checkout-panel');
        const listRect = list.getBoundingClientRect();
        const columnRect = column.getBoundingClientRect();
        const checkoutRect = checkout.getBoundingClientRect();
        const visibleCheckout = getComputedStyle(checkout).display !== 'none';
        const errors = [];
        const insideX = (inner, outer) => inner.left >= outer.left - 1 && inner.right <= outer.right + 1;
        const rows = [...list.querySelectorAll('[data-pos-result-index]')];
        for (const row of rows) {
          const rowRect = row.getBoundingClientRect();
          if (!insideX(rowRect, listRect) || !insideX(rowRect, columnRect)) errors.push(`${row.dataset.testid}: outside the search column`);
          if (row.scrollWidth > row.clientWidth + 2) errors.push(`${row.dataset.testid}: clipped row content`);
          for (const prefix of ['pos-result-price-', 'pos-result-stock-']) {
            const content = row.querySelector(`[data-testid^="${prefix}"]`);
            if (!content) errors.push(`${row.dataset.testid}: missing ${prefix === 'pos-result-price-' ? 'price' : 'stock'}`);
            else if (!insideX(content.getBoundingClientRect(), rowRect)) errors.push(`${row.dataset.testid}: ${prefix}clipped`);
          }
        }
        return {
          docWidth: document.documentElement.scrollWidth,
          docHeight: document.documentElement.scrollHeight,
          listWidth: list.scrollWidth,
          listClientWidth: list.clientWidth,
          listHeight: list.clientHeight,
          listScrollHeight: list.scrollHeight,
          boxHeight: box.getBoundingClientRect().height,
          columnRect: { left: columnRect.left, right: columnRect.right },
          checkoutRect: { left: checkoutRect.left, right: checkoutRect.right },
          visibleCheckout,
          rows: rows.length,
          errors,
          dir: document.documentElement.dir,
        };
      });
      assert.equal(measure.dir, lang === 'ar' ? 'rtl' : 'ltr', `${lang} register direction`);
      assert.equal(measure.rows, 24, `${lang}-${width}: the query matches the 24 fixtures`);
      assert.ok(measure.boxHeight >= 48, `${lang}-${width}: the scan box is a touch-sized target`);
      assert.ok(measure.docWidth <= width + 1, `${lang}-${width}: page overflows horizontally ${JSON.stringify(measure)}`);
      assert.ok(measure.listWidth <= measure.listClientWidth + 2, `${lang}-${width}: result list scrolls sideways ${JSON.stringify(measure)}`);
      assert.deepEqual(measure.errors, [], `${lang}-${width}: rows/details must not clip`);
      if (width >= 1024) {
        assert.equal(measure.visibleCheckout, true, 'desktop checkout stays beside the search column');
        // The register row is viewport-bounded (shell chrome above it); extra
        // document height would mean the result list escaped its column.
        assert.ok(measure.docHeight <= Math.max(height, 620) + 1,
          `${lang}-${width}: desktop page must not scroll beyond the register row ${JSON.stringify(measure)}`);
        assert.ok(measure.listScrollHeight > measure.listHeight, `${lang}-${width}: results must scroll vertically`);
        if (lang === 'ar') assert.ok(measure.checkoutRect.right <= measure.columnRect.left, 'RTL cart is on the left');
        else assert.ok(measure.checkoutRect.left >= measure.columnRect.right, 'LTR cart is on the right');
      } else {
        assert.equal(measure.visibleCheckout, false, 'tablet checkout lives in the mobile sheet');
      }
      await layout(`${lang}-${width}-pos-search`, false);

      const beforeScroll = await page.evaluate(() => window.scrollY);
      const listBox = await list.boundingBox();
      const targetBefore = await target.boundingBox();
      if (width >= 1024) {
        assert.ok(targetBefore.y > listBox.y + listBox.height, `${lang}-${width}: the target must START off-screen`);
        const panel = page.getByTestId('pos-checkout-panel');
        const panelBefore = await panel.boundingBox();
        await page.mouse.move(listBox.x + listBox.width / 2, listBox.y + listBox.height / 2);
        await page.mouse.wheel(0, 50000); // enough to reach the list bottom at laptop zoom
        await expect.poll(() => list.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
        await expect.poll(() => list.evaluate((element) =>
          Math.abs(element.scrollHeight - element.clientHeight - element.scrollTop))).toBeLessThan(2);
        const targetAfter = await target.boundingBox();
        assert.ok(targetAfter.y >= listBox.y - 1 && targetAfter.y + targetAfter.height <= listBox.y + listBox.height + 2,
          `${lang}-${width}: wheel/trackpad brings the tail row entirely into view ${JSON.stringify({ targetAfter, listBox, scroll: await list.evaluate((el) => [el.scrollTop, el.scrollHeight, el.clientHeight]) })}`);
        const panelAfter = await panel.boundingBox();
        for (const axis of ['x', 'y', 'width', 'height']) {
          assert.ok(Math.abs(panelAfter[axis] - panelBefore[axis]) < 2, `${lang}-${width}: checkout ${axis} moved with result scroll`);
        }
        assert.equal(await page.evaluate(() => window.scrollY), beforeScroll, `${lang}-${width}: wheel stays in the result list`);
      } else {
        // The wheel starts over the scan box — over the list it would (by
        // design) scroll the dropdown, not the page.
        assert.ok(targetBefore.y > height, `${lang}-${width}: tablet target starts below the fold`);
        const searchBoxPos = await search.boundingBox();
        await page.mouse.move(searchBoxPos.x + searchBoxPos.width / 2, searchBoxPos.y + searchBoxPos.height / 2);
        await page.mouse.wheel(0, 1200);
        await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
        await target.scrollIntoViewIfNeeded();
      }
      await target.click();
      if (width >= 1024) {
        const checkout = page.getByTestId('pos-checkout-panel');
        await expect(checkout.getByTestId('cart-line-pos-layout-23::')).toBeVisible();
        // Opening a variant row must still require an exact colour/size: the
        // layout may change, but the sale/stock rules must not.
        if (width === 1366 && height === 768) {
          await search.fill('RENDER-RING');
          await page.getByTestId(`pos-result-${productId}`).click();
          const picker = page.getByRole('dialog', { name: lang === 'ar' ? 'اختر اللون والمقاس' : 'Choose colour and size' });
          await expect(picker).toBeVisible();
          await picker.locator('button[aria-label]').first().click();
        }
        // The POS provider keeps the selected customer across page visits.
        // Explicitly switch to walk-in before testing the guest scenario.
        if (await checkout.locator('#customer-select').inputValue()) {
          await checkout.locator('button[title]').filter({ hasText: '✕' }).first().click();
        }
        await expect(checkout.locator('#customer-select')).toHaveValue('');
        const split = checkout.getByRole('switch');
        if (await split.getAttribute('aria-checked') !== 'true') await split.click();
        await checkout.getByTestId('cash-input').fill('50');
        await checkout.getByTestId('instapay-input').fill('100');
        await cashierScroll(checkout, { lang, height, name: `${lang}-${width}-walk-in-split` });

        if (width === 1366 && height === 768) {
          // A long cart previously collapsed to 0px under the tall payment
          // form. The cart rows must retain their own usable scrollport while
          // the whole cashier column can still reach Complete sale.
          for (let i = 0; i < 10; i += 1) {
            await search.fill(`POS-LAYOUT-${i}`);
            await search.press('Enter');
            await expect(checkout.getByTestId(`cart-line-pos-layout-${i}::`)).toBeVisible();
          }
          const customer = checkout.locator('#customer-select');
          await customer.fill('سارة');
          await checkout.locator('[role="listbox"] button').filter({ hasText: 'سارة' }).first().click();
          await expect(customer).toHaveValue('سارة المحمود');
          const cart = await checkout.getByTestId('pos-cart').evaluate((el) => {
            const list = el.querySelector('ul');
            return { count: list.children.length, client: list.clientHeight, scroll: list.scrollHeight };
          });
          assert.ok(cart.count >= 10 && cart.client > 32 && cart.scroll > cart.client,
            `${lang}: long-cart rows remain scrollable beside payment`);
          await cashierScroll(checkout, { lang, height, name: `${lang}-1366-selected-long-cart`, touch: true });
        }
      } else {
        for (let i = 0; i < 10; i += 1) {
          await search.fill(`POS-LAYOUT-${i}`);
          await search.press('Enter');
          await expect(page.getByTestId(`cart-line-pos-layout-${i}::`)).toBeAttached();
        }
        await page.getByTestId('pos-mobile-cart-open').click();
        const drawer = page.getByTestId('pos-mobile-cart-drawer');
        await expect(drawer.getByTestId('cart-line-pos-layout-23::')).toBeVisible();
        const split = drawer.getByRole('switch');
        if (await split.getAttribute('aria-checked') !== 'true') await split.click();
        await drawer.getByTestId('cash-input').fill('50');
        await drawer.getByTestId('instapay-input').fill('100');
        await cashierScroll(drawer, { lang, height, name: `${lang}-${width}-tablet-long-cart`, touch: true });
        await drawer.locator('button[aria-label]').first().click();
      }
      console.log(`✓ ${lang}-${width} POS: search-first register, tail row reached and selected, checkout scrollable`);
    }
  }
  assert.deepEqual(errors, [], 'no browser errors');
  await writeFile(`${output}/measurements.json`, JSON.stringify(results, null, 2));
  console.log(`Rendered acceptance: ${results.length} screens passed, including EN/AR POS at 1366×768, 1366×600, 1093×614, 1920 and tablet 820.`);
} finally {
  await browser.close();
  // SIGKILL (TerminateProcess on Windows): a plain SIGTERM has been observed
  // to leave the dev server behind, and the orphan then squats the port and
  // hangs the *next* run's first navigation.
  if (server) { try { server.kill('SIGKILL'); } catch { /* already gone */ } }
}
