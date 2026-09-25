#!/usr/bin/env node
/** Phase 3 real-Chromium shopper acceptance. A demo-only browser profile
 * exercises real hash navigation, exact shelves, media, filters, checkout,
 * receipt privacy and account history across EN/AR and sixteen viewport widths.
 * Run against a locally built/served app; screenshots are Git-ignored. */
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "@playwright/test";
import { assertRenderedArabicFont } from "./lib/rendered-arabic-font.mjs";

const base = process.env.V2_VISUAL_BASE_URL || "http://127.0.0.1:4173";
const output = "coverage/visual-v2-phase3";
// All thirteen release-candidate targets, plus the 600/900/1728px seams.
const widths = [320, 360, 375, 390, 414, 430, 600, 768, 820, 900, 1024, 1280, 1366, 1440, 1728, 1920];
const silverXS = "4fb4125a-0f26-461e-8a94-31e365342103";
const gold17 = "4fb4125a-0f26-461e-8a94-31e365342101";
const phone = "01012345678";
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_EXECUTABLE || undefined,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: "en-US" });
const page = await context.newPage();
page.setDefaultTimeout(30_000);
const failures = [];
page.on("pageerror", (error) => failures.push(`pageerror: ${error.message}`));
page.on("console", (message) => { if (message.type() === "error") failures.push(`console: ${message.text()}`); });
page.on("response", (response) => {
  if (response.status() >= 400 && response.url().startsWith(base)) failures.push(`${response.status()} ${response.url()}`);
});
const go = async (hash, testId) => {
  await page.goto(`${base}/${hash}`, { timeout: 120_000 });
  if (testId) await page.getByTestId(testId).waitFor({ timeout: 60_000 });
};
const stored = async (key) => page.evaluate((name) => JSON.parse(localStorage.getItem(name)), key);
let orderNumber;
try {
  await go("#/store", "v2-home");
  await page.getByTestId("v2-card-prd-1002").waitFor();
  await page.evaluate(({ silverXS, gold17 }) => {
    const catalogKey = "alyq.demo.catalog.v1";
    const catalog = JSON.parse(localStorage.getItem(catalogKey));
    const ring = catalog.products.find((item) => item.id === "prd-1002");
    ring.variants_enabled = true;
    ring.stock_quantity = 4;
    ring.low_stock_level = 1;
    ring.images = ["/brand/products/gold-pearl-earrings.jpg"];
    const shelf = (id, color, size, label, stock, price = null) => ({
      id, product_id: ring.id, sku: `V2-PHASE3-${color}-${label || size}`, barcode: null,
      color_key: color, color_en: color === "gold" ? "Gold" : "Silver",
      color_ar: color === "gold" ? "ذهبي" : "فضي",
      color_hex: color === "gold" ? "#cba556" : "#c9c9c9",
      size, size_label: label, image_url: null, price_override: price, cost_override: null,
      stock_quantity: stock, low_stock_level: 1, active: true, sort_order: 1,
      created_at: ring.created_at, updated_at: ring.updated_at,
    });
    catalog.variants = [
      ...catalog.variants.filter((item) => item.product_id !== ring.id),
      shelf(gold17, "gold", 17, null, 3, 88),
      shelf("4fb4125a-0f26-461e-8a94-31e365342102", "gold", 18, null, 0),
      shelf(silverXS, "silver", null, "XS", 1, 74),
      shelf("4fb4125a-0f26-461e-8a94-31e365342104", "silver", 16.5, null, 2),
    ];
    localStorage.setItem(catalogKey, JSON.stringify(catalog));
    const key = "alyq.demo.product_contents.v1";
    const contents = JSON.parse(localStorage.getItem(key));
    contents.find((item) => item.product_id === ring.id).dimensions_en = "Size 17: 17 millimetres; XS is a different shelf.";
    contents.find((item) => item.product_id === ring.id).dimensions_ar = "المقاس 17: قطر 17 ملم؛ إكس إس خيار آخر.";
    localStorage.setItem(key, JSON.stringify(contents));
    const settingsKey = "alyq.demo.website_settings.v1";
    const row = JSON.parse(localStorage.getItem(settingsKey));
    row.settings.about.title_en = "Our independent jewellery house";
    row.settings.about.title_ar = "دار المجوهرات المستقلة";
    row.settings.contact.email = "jewellery@example.com";
    localStorage.setItem(settingsKey, JSON.stringify(row));
  }, { silverXS, gold17 });
  await go("#/store/products/prd-1002", "v2-product");
  await page.reload();
  await page.getByTestId("v2-color-gold").waitFor();
  const add = page.getByTestId("v2-pdp-add");
  await page.getByTestId("v2-color-gold").click();
  assert.equal(await page.getByTestId("v2-size-18").isDisabled(), true, "sold-out combination is blocked");
  await page.getByTestId("v2-size-17").click();
  assert.equal(await add.isEnabled(), true, "selected Gold/17 is orderable");
  await page.locator(".v2-size-guide-link").click();
  assert.equal(await page.locator("#v2-size-guide").getAttribute("open"), "", "merchant size guide opens");
  await page.getByTestId("v2-image-zoom").click();
  await page.getByTestId("v2-lightbox").waitFor();
  assert.equal(await page.getByTestId("v2-lightbox").getAttribute("aria-modal"), "true");
  const before = await page.locator(".v2-lightbox-picture img").getAttribute("src");
  await page.keyboard.press("ArrowRight");
  assert.notEqual(await page.locator(".v2-lightbox-picture img").getAttribute("src"), before,
    "arrow keys browse actual PDP gallery media");
  await page.keyboard.press("Escape");
  await page.getByTestId("v2-lightbox").waitFor({ state: "detached" });
  assert.equal(await page.evaluate(() => document.activeElement?.dataset.testid), "v2-image-zoom",
    "lightbox restores keyboard focus");
  console.log("✓ published Gold/17, sold-out Gold/18, configured size guide and accessible gallery keyboard loop");

  await go("#/store/products", "v2-catalog");
  await page.locator("#v2-search-input").fill("Ring");
  await page.locator(".v2-catalog-search button").click();
  await page.waitForFunction(() => location.hash.includes("q=Ring"));
  await page.waitForFunction(() => /\(1\)/.test(document.querySelector(".v2-filter-toggle")?.textContent || ""));
  assert.match(await page.locator(".v2-filter-toggle").textContent(), /\(1\)/,
    "search is included in the active filter count");
  await page.locator(".v2-filter-toggle").click();
  const drawer = page.locator(".v2-filter-controls");
  assert.equal(await drawer.getAttribute("role"), "dialog", "mobile filters are a labelled dialog");
  await drawer.locator('select').first().selectOption("price_asc");
  await page.waitForFunction(() => location.hash.includes("sort=price_asc"));
  await drawer.locator('select').filter({ has: page.locator('option[value="silver"]') }).selectOption("silver");
  await page.waitForFunction(() => location.hash.includes("color=silver"));
  await drawer.locator('select').filter({ has: page.locator('option[value="l:XS"]') }).selectOption("l:XS");
  await page.waitForFunction(() => location.hash.includes("size_label=XS"));
  assert.equal(await page.getByTestId("v2-card-prd-1002").count(), 1);
  assert.equal(await page.getByTestId("v2-quick-add-prd-1002").isEnabled(), true);
  await page.keyboard.press("Escape");
  assert.equal(await drawer.getAttribute("data-open"), "false", "Escape closes mobile filters");
  await page.reload();
  await page.getByTestId("v2-card-prd-1002").waitFor();
  assert.equal(await page.locator("#v2-search-input").inputValue(), "Ring", "URL filters survive a real reload");
  assert.equal(await page.locator('.v2-active-filters button').count() >= 3, true,
    "search, colour and letter size have removable active chips");
  console.log("✓ URL-backed search, data-derived silver/XS, active count, price sort and Escape-safe mobile drawer");

  await go("#/store/account", "v2-account");
  await page.getByRole("button", { name: "Create an account", exact: true }).click();
  await page.locator('.v2-account-form input[autocomplete="name"]').fill("Phase Three Shopper");
  await page.locator('.v2-account-form input[autocomplete="tel"]').fill(phone);
  await page.locator('.v2-account-form input[autocomplete="new-password"]').fill("samplepass9");
  await page.getByRole("button", { name: "Create account" }).click();
  await page.getByRole("heading", { name: /Phase Three Shopper/ }).waitFor();
  await go("#/store/products/prd-1002", "v2-product");
  await page.getByTestId("v2-color-gold").click();
  await page.getByTestId("v2-size-17").click();
  await add.click();
  await go("#/store/cart", "v2-cart");
  assert.match(await page.getByTestId("v2-cart").innerText(), /Gold.*17/s);
  assert.ok((await stored("alyq.store.cart.v2")).lines.some((line) => line.variant_id === gold17),
    "shared cart preserves the exact variant UUID");
  await page.getByTestId("v2-cart-checkout").click();
  await page.getByTestId("v2-checkout").waitFor();
  await page.locator(".v2-choice-grid").first().getByRole("button", { name: "Pickup", exact: true }).click();
  await page.getByTestId("v2-place-order").click();
  await page.getByTestId("v2-order-number").waitFor();
  await page.getByTestId("v2-order-details").waitFor();
  orderNumber = (await page.getByTestId("v2-order-number").innerText()).trim();
  assert.equal((await stored("alyq.demo.online_orders.v1")).length, 1);
  assert.equal((await stored("alyq.demo.online_orders.v1"))[0].items[0].variant_id, gold17,
    "authoritative placed order and cart match exact variant");
  assert.equal(new URL(page.url()).hash.includes(phone), false, "phone is never in the URL");
  await page.reload();
  await page.getByTestId("v2-order-details").waitFor();
  assert.equal((await page.getByTestId("v2-order-number").innerText()).trim(), orderNumber,
    "refresh-safe confirmation uses a short-lived reference+phone lookup");
  assert.ok((await page.getByTestId("v2-order-details").innerText()).includes("V2-PHASE3-gold-17"),
    "restored receipt settles to the authoritative exact-SKU snapshot");
  const receipt = await page.evaluate(() => JSON.parse(sessionStorage.getItem("alyq.v2.confirmation.session")));
  assert.deepEqual(Object.keys(receipt).sort(), ["at", "order", "phone"], "receipt tab storage contains no order object");
  const privateTab = await context.newPage();
  await privateTab.goto(`${base}/#/store/confirmation`);
  await privateTab.getByTestId("v2-receipt-private").waitFor();
  assert.equal(await privateTab.getByTestId("v2-order-number").count(), 0,
    "the same account in a different tab cannot see an unshared confirmation");
  await privateTab.close();
  console.log("✓ real Chromium COD receipt, shared exact-variant order, refresh-safe private tab confirmation");

  await go(`#/store/track?number=${orderNumber}`, "v2-track");
  await page.getByTestId("v2-track-submit").click();
  assert.equal(await page.getByTestId("v2-tracked-order").count(), 0, "reference alone reveals no order");
  await page.locator('.v2-track-form input[type="tel"]').fill("01099999999");
  await page.getByTestId("v2-track-submit").click();
  await page.getByTestId("v2-track-error").waitFor();
  await page.locator('.v2-track-form input[type="tel"]').fill(phone);
  await page.getByTestId("v2-track-submit").click();
  await page.getByTestId("v2-tracked-order").waitFor();
  await page.getByTestId("v2-order-details").waitFor();
  assert.ok((await page.getByTestId("v2-tracked-order").innerText()).includes("V2-PHASE3-gold-17"),
    "private tracking settles to the placed exact-SKU detail and timeline");
  assert.equal(new URL(page.url()).hash.includes(phone), false);
  await go("#/store/account?tab=orders", "v2-account");
  await page.getByTestId("v2-history-order").first().waitFor();
  await page.waitForFunction(() => document.querySelector('.v2-account-content button.v2-text-link')?.disabled === false);
  assert.ok((await page.getByTestId("v2-history-order").first().innerText()).includes(orderNumber),
    "private account history settles before asserting the order number");
  console.log("✓ private tracking needs reference + phone; signed-in history re-reads through shared account provider");

  const routes = [
    { id: "cart", hash: "#/store/cart", selector: "v2-cart" },
    { id: "checkout", hash: "#/store/checkout", selector: "v2-checkout" },
    { id: "confirmation", hash: "#/store/confirmation", selector: "v2-confirmation" },
    { id: "track", hash: `#/store/track?number=${orderNumber}`, selector: "v2-track" },
    { id: "account", hash: "#/store/account?tab=orders", selector: "v2-account" },
    { id: "about", hash: "#/store/about", selector: "v2-about" },
    { id: "contact", hash: "#/store/contact", selector: "v2-contact" },
  ];
  // The order clears the cart; add one different exact shelf for the populated
  // cart/checkout geometry (without mutating or replacing the placed order).
  await go("#/store/products/prd-1002", "v2-product");
  await page.getByTestId("v2-color-silver").click();
  await page.getByTestId("v2-size-XS").click();
  await page.getByTestId("v2-pdp-add").click();
  assert.equal((await stored("alyq.store.cart.v2")).lines[0].variant_id, silverXS);
  let measured = 0;
  for (const lang of ["en", "ar"]) {
    await page.evaluate((next) => localStorage.setItem("alyq.lang", next), lang);
    await page.reload();
    // A route's shell appears before its asynchronous catalogue/settings load.
    // Wait for the saved settings, not just for the static About skeleton.
    await go("#/store/about", "v2-about");
    await page.waitForFunction(() => document.querySelector(".v2-about h1")?.textContent?.includes(
      JSON.parse(localStorage.getItem("alyq.demo.website_settings.v1"))?.settings?.about?.title_en) ||
      document.querySelector(".v2-about h1")?.textContent?.includes(
        JSON.parse(localStorage.getItem("alyq.demo.website_settings.v1"))?.settings?.about?.title_ar));
    if (lang === "ar") await assertRenderedArabicFont(page);
    for (const width of widths) {
      await page.setViewportSize({ width, height: width <= 414 ? 780 : 960 });
      for (const route of routes) {
        await go(route.hash, route.selector);
        if (route.id === "confirmation") await page.getByTestId("v2-order-number").waitFor();
        if (route.id === "account") {
          await page.getByTestId("v2-history-order").first().waitFor();
          await page.waitForFunction(() => document.querySelector('.v2-account-content button.v2-text-link')?.disabled === false);
        }
        if (route.id === "cart" || route.id === "checkout") {
          await page.waitForFunction(() => {
            const totals = document.querySelector('[data-testid="v2-cart-totals"]');
            return totals && !totals.querySelector('[role="status"]');
          });
        }
        await page.evaluate(() => document.fonts.ready);
        const info = await page.evaluate(() => {
          const inView = (node) => {
            const rect = node.getBoundingClientRect();
            return rect.width === 0 || (rect.left >= -1 && rect.right <= innerWidth + 1);
          };
          const heading = document.querySelector("main h1");
          const footer = document.querySelector(".v2-footer-bottom");
          document.scrollingElement.scrollTop = document.scrollingElement.scrollHeight;
          return {
            width: innerWidth,
            document: document.documentElement.scrollWidth,
            body: document.body.scrollWidth,
            dir: document.querySelector(".store-v2")?.getAttribute("dir"),
            heading: Boolean(heading?.textContent.trim()),
            clipped: [...document.querySelectorAll(
              ".v2-cart-line, .v2-cart-totals, .v2-journey-main, .v2-journey-aside, .v2-account-content, .v2-footer-inner, .v2-footer-bottom",
            )].filter((node) => !inView(node)).map((node) => node.className),
            footerReachable: Boolean(footer && footer.getBoundingClientRect().bottom <= innerHeight + 2),
            links: {
              account: Boolean(document.querySelector('.v2-header-end a[href="#/store/account"]')),
              cart: Boolean(document.querySelector('.v2-header-end a[href="#/store/cart"]')),
            },
          };
        });
        const label = `${route.id}/${lang}/${width}`;
        assert.equal(info.width, width, `${label}: browser viewport`);
        assert.equal(info.dir, lang === "ar" ? "rtl" : "ltr", `${label}: configured direction`);
        assert.ok(info.document <= width + 1 && info.body <= width + 1,
          `${label}: no horizontal scroll — ${JSON.stringify(info)}`);
        assert.deepEqual(info.clipped, [], `${label}: content remains inside viewport`);
        assert.ok(info.heading && info.footerReachable && info.links.account && info.links.cart,
          `${label}: heading, scrollable footer and V2 header actions remain accessible`);
        if (route.id === "about") {
          const text = await page.getByTestId("v2-about").innerText();
          assert.ok(text.includes(lang === "ar" ? "دار المجوهرات المستقلة" : "Our independent jewellery house"),
            `${label}: saved About heading was not rendered — stored=${(await stored("alyq.demo.website_settings.v1"))?.settings?.about?.title_en}, UI=${text.slice(0, 200)}`);
        }
        if (route.id === "contact") assert.ok((await page.getByTestId("v2-contact").innerText()).includes("jewellery@example.com"), label);
        if ([320, 390, 768, 1440, 1920].includes(width)) {
          await page.evaluate(() => { document.scrollingElement.scrollTop = 0; });
          await page.screenshot({ path: `${output}/${route.id}-${lang}-${width}.png`, fullPage: true });
        }
        measured++;
      }
      console.log(`✓ ${lang}/${width}: seven journey pages, headings, V2 actions, scrollable footer, no clipped content`);
    }
  }
  console.log(`✓ ${measured}/${widths.length * 2 * routes.length} rendered Phase 3 routes across EN/LTR + AR/RTL`);

  // A separate profile starts with a persisted stale/sold-out shelf. Only a
  // successful catalogue fetch may prune it; the V2 shopper gets a dismissible
  // notice. The browser uses the same demo catalogue, not a test-only cart.
  const staleContext = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: "en-US" });
  const stale = await staleContext.newPage();
  await stale.goto(`${base}/#/store`);
  await stale.getByTestId("v2-card-prd-1002").waitFor();
  await stale.evaluate(() => {
    localStorage.setItem("alyq.store.cart.v2", JSON.stringify({ version: 2, lines: [
      { product_id: "nonexistent", variant_id: null, quantity: 1 },
      { product_id: "prd-1002", variant_id: "wrong-product-variant", quantity: 1 },
    ], couponCode: null }));
  });
  await stale.reload();
  await stale.goto(`${base}/#/store/cart`);
  await stale.getByTestId("v2-cart-pruned").waitFor();
  assert.equal((await stale.evaluate(() => JSON.parse(localStorage.getItem("alyq.store.cart.v2")))).lines.length, 0);
  await stale.getByTestId("v2-cart-pruned").getByRole("button").click();
  assert.equal(await stale.getByTestId("v2-cart-pruned").count(), 0);
  await staleContext.close();
  console.log("✓ stale saved-cart lines are pruned after loading, with a dismissible shopper notice");

  // A clean profile exercises *actual rendered* loading, empty and refusal
  // states before buying two lines. The admin catalogue then unpublishes only
  // the historical Gold/17 shelf, so Orders must keep the valid simple item,
  // name the refused exact SKU and offer a cart link in both languages.
  const stateContext = await browser.newContext({ viewport: { width: 320, height: 780 }, locale: "en-US" });
  const state = await stateContext.newPage();
  state.setDefaultTimeout(30_000);
  state.on("pageerror", (error) => failures.push(`state pageerror: ${error.message}`));
  state.on("console", (message) => { if (message.type() === "error") failures.push(`state console: ${message.text()}`); });
  state.on("response", (response) => {
    if (response.status() >= 400 && response.url().startsWith(base)) failures.push(`state ${response.status()} ${response.url()}`);
  });
  const visitState = async (hash, testId) => {
    await state.goto(`${base}/${hash}`, { timeout: 120_000 });
    if (testId) await state.getByTestId(testId).waitFor({ timeout: 60_000 });
  };
  await state.goto(`${base}/#/store/products?q=never-a-real-piece`, { waitUntil: "domcontentloaded" });
  await state.getByTestId("v2-loading").waitFor();
  assert.equal(await state.getByTestId("v2-loading").getAttribute("role"), "status");
  assert.ok(await state.getByTestId("v2-loading").getAttribute("aria-label"));
  await state.getByTestId("v2-empty").waitFor();
  await state.getByTestId("v2-loading").waitFor({ state: "detached" });
  assert.equal(await state.getByTestId("v2-empty").getAttribute("role"), "status");
  await state.locator(".v2-active-filters").getByRole("button", { name: "Clear filters" }).click();
  await state.getByTestId("v2-card-prd-1002").waitFor();
  const accessibility = await state.evaluate(() => ({
    main: document.querySelectorAll("main").length,
    headings: document.querySelectorAll("main h1").length,
    search: document.querySelectorAll('form[role="search"]').length,
    unnamedInputs: [...document.querySelectorAll("main input:not([type=hidden])")]
      .filter((input) => !input.labels?.length && !input.getAttribute("aria-label") &&
        !input.getAttribute("aria-labelledby")).map((input) => input.outerHTML.slice(0, 90)),
    unlabelledImages: [...document.querySelectorAll("main img")]
      .filter((image) => image.getAttribute("alt") === null).length,
  }));
  assert.deepEqual(accessibility, { main: 1, headings: 1, search: 1, unnamedInputs: [], unlabelledImages: 0 },
    "catalogue exposes a main landmark, heading, search, labelled controls and alternative image text");
  await visitState("#/store/cart", "v2-cart");
  await state.locator('.v2-journey-empty a[href="#/store/products"]').waitFor();
  await visitState("#/store/track", "v2-track");
  await state.getByTestId("v2-track-submit").click();
  assert.equal(await state.locator('.v2-track-form input[aria-invalid="true"]').count(), 2,
    "required tracking fields expose errors accessibly without revealing an order");
  await state.locator('.v2-track-form input[autocomplete="off"]').fill("NO-SUCH-ORDER");
  await state.locator('.v2-track-form input[type="tel"]').fill(phone);
  await state.getByTestId("v2-track-submit").click();
  assert.equal(await state.getByTestId("v2-track-submit").isDisabled(), true,
    "private lookup visibly disables repeat submission while loading");
  await state.getByTestId("v2-track-error").waitFor();
  assert.equal(await state.getByTestId("v2-track-error").getAttribute("role"), "alert");
  assert.equal(await state.getByTestId("v2-tracked-order").count(), 0);
  console.log("✓ clean-profile skeleton, zero results, empty bag, labelled form and private lookup error/loading states");

  await visitState("#/store/account", "v2-account");
  await state.getByRole("button", { name: "Create an account", exact: true }).click();
  await state.locator('.v2-account-form input[autocomplete="name"]').fill("Partial Reorder Shopper");
  await state.locator('.v2-account-form input[autocomplete="tel"]').fill(phone);
  await state.locator('.v2-account-form input[autocomplete="new-password"]').fill("samplepass9");
  await state.getByRole("button", { name: "Create account" }).click();
  await state.getByRole("heading", { name: /Partial Reorder Shopper/ }).waitFor();
  await visitState("#/store/account?tab=orders", "v2-account");
  await state.waitForFunction(() => document.querySelector('.v2-account-content button.v2-text-link')?.disabled === false);
  await state.getByText("No orders yet").waitFor();
  assert.equal(await state.getByTestId("v2-history-order").count(), 0);
  console.log("✓ new browser-local shopper history resolves to a genuine empty state");

  // Reuse the real demo catalogue seeded for the earlier exact-variant order,
  // not a substitute product or test-only reorder implementation.
  const seededCatalog = await stored("alyq.demo.catalog.v1");
  await state.evaluate((catalog) => localStorage.setItem("alyq.demo.catalog.v1", JSON.stringify(catalog)), seededCatalog);
  await visitState("#/store/products/prd-1002", "v2-product");
  // Hash navigation does not recreate the already-mounted demo repository.
  await state.reload();
  await state.getByTestId("v2-color-gold").click();
  await state.getByTestId("v2-size-17").click();
  await state.getByTestId("v2-pdp-add").click();
  await state.waitForFunction((id) => JSON.parse(localStorage.getItem("alyq.store.cart.v2"))?.lines
    .some((line) => line.variant_id === id), gold17);
  await visitState("#/store/products/prd-2001", "v2-product");
  await state.getByTestId("v2-pdp-add").click();
  await state.waitForFunction(() => JSON.parse(localStorage.getItem("alyq.store.cart.v2"))?.lines
    .some((line) => line.product_id === "prd-2001"));
  await visitState("#/store/checkout", "v2-checkout");
  await state.locator(".v2-choice-grid").first().getByRole("button", { name: "Pickup", exact: true }).click();
  await state.locator('.v2-checkout-form input[autocomplete="name"]').fill("Partial Reorder Shopper");
  await state.locator('.v2-checkout-form input[autocomplete="tel"]').fill(phone);
  await state.getByTestId("v2-place-order").click();
  await state.getByTestId("v2-order-details").waitFor();
  const partialOrder = (await state.evaluate(() => JSON.parse(localStorage.getItem("alyq.demo.online_orders.v1")))).at(-1);
  const refusedItem = partialOrder.items.find((item) => item.variant_id === gold17);
  assert.equal(partialOrder.items.length, 2);
  assert.ok(refusedItem && partialOrder.items.some((item) => item.product_id === "prd-2001" && !item.variant_id));
  await state.evaluate((id) => {
    const key = "alyq.demo.catalog.v1";
    const catalog = JSON.parse(localStorage.getItem(key));
    catalog.variants.find((row) => row.id === id).active = false;
    localStorage.setItem(key, JSON.stringify(catalog));
  }, gold17);
  await visitState("#/store/account?tab=orders", "v2-account");
  await state.reload(); // the provider must reload the now-inactive shelf
  await state.getByTestId("v2-history-order").waitFor();
  await state.waitForFunction(() => document.querySelector('.v2-account-content button.v2-text-link')?.disabled === false);
  await state.getByTestId("v2-history-order").getByRole("button", { name: "Order again" }).click();
  await state.getByTestId("v2-reorder-error").waitFor();
  const englishProblem = await state.getByTestId("v2-reorder-error").innerText();
  assert.ok(englishProblem.includes(refusedItem.sku) && englishProblem.includes(refusedItem.name_en),
    "partial reorder names the exact refused historical item and SKU");
  const englishStatus = state.locator('.v2-account-content [role="status"]');
  await englishStatus.waitFor();
  assert.ok((await englishStatus.innerText()).includes("Only the available original items were added"));
  assert.equal(await englishStatus.locator('a[href="#/store/cart"]').count(), 1);
  await state.waitForFunction(() => JSON.parse(localStorage.getItem("alyq.store.cart.v2"))?.lines.length === 1);
  assert.deepEqual((await state.evaluate(() => JSON.parse(localStorage.getItem("alyq.store.cart.v2")))).lines
    .map((line) => [line.product_id, line.variant_id]), [["prd-2001", null]],
  "no unavailable UUID or replacement enters the cart");
  assert.ok(state.url().includes("#/store/account?tab=orders"), "partial reorder stays with the warning and bag link");

  await state.evaluate(() => {
    const key = "alyq.store.cart.v2";
    const cart = JSON.parse(localStorage.getItem(key));
    localStorage.setItem(key, JSON.stringify({ ...cart, lines: [] }));
    localStorage.setItem("alyq.lang", "ar");
  });
  // No same-document hash navigation between storage edit and reload: the
  // mounted provider could otherwise persist its prior bag over our fixture.
  await state.reload();
  await state.getByTestId("v2-account").waitFor();
  await state.getByTestId("v2-history-order").waitFor();
  await state.waitForFunction(() => document.querySelector('.v2-account-content button.v2-text-link')?.disabled === false);
  assert.deepEqual(await state.evaluate(() => JSON.parse(localStorage.getItem("alyq.store.cart.v2"))?.lines), [],
    "Arabic fixture starts with a truly empty shared cart");
  await state.getByTestId("v2-history-order").locator("button").click();
  await state.getByTestId("v2-reorder-error").waitFor();
  const arabicProblem = await state.getByTestId("v2-reorder-error").innerText();
  assert.ok(arabicProblem.includes(refusedItem.sku) && arabicProblem.includes(refusedItem.name_ar));
  const arabicStatus = state.locator('.v2-account-content [role="status"]');
  await arabicStatus.waitFor();
  assert.ok((await arabicStatus.innerText()).includes("أضفنا الأصناف الأصلية المتاحة فقط"));
  assert.equal(await arabicStatus.locator('a[href="#/store/cart"]').count(), 1);
  await state.waitForFunction(() => JSON.parse(localStorage.getItem("alyq.store.cart.v2"))?.lines.length === 1);
  assert.deepEqual((await state.evaluate(() => JSON.parse(localStorage.getItem("alyq.store.cart.v2")))).lines
    .map((line) => [line.product_id, line.variant_id]), [["prd-2001", null]]);
  assert.equal(await state.locator(".store-v2").getAttribute("dir"), "rtl");
  await stateContext.close();
  console.log("✓ EN + AR partial reorder retains the valid simple line, refuses the inactive exact UUID and links to the bag");

  await go("#/store/does-not-exist", "v2-home");
  assert.ok(page.url().endsWith("#/store"), "unknown public shop route safely returns to canonical home");
  await go("#/store/cart", "v2-cart");
  assert.equal(await page.getByTestId("store-v2").count(), 1, "canonical bag uses the V2 shell");
  assert.deepEqual(failures, [], "no Chromium console, page, or same-origin media/network failures");
  console.log(`\n✓ Phase 3 Chromium journey passed; screenshots: ${output}/ (ignored by Git)`);
} finally {
  await browser.close();
}
