#!/usr/bin/env node
/** Real-Chromium V2 visual geometry, images and RTL. Requires a separately
 * started Vite preview (0.0.0.0) and an available Chromium executable:
 *   CHROMIUM_EXECUTABLE=/path/to/chromium V2_VISUAL_BASE_URL=http://127.0.0.1:4173 node scripts/rendered-v2.flow.mjs
 * The screenshots live under ignored coverage/visual-v2/, not in Git.
 */
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "@playwright/test";
import { assertRenderedArabicFont } from "./lib/rendered-arabic-font.mjs";

const base = process.env.V2_VISUAL_BASE_URL || "http://127.0.0.1:4173";
const output = "coverage/visual-v2";
// All thirteen release-candidate targets, plus the 600/900/1728px seams.
const widths = [320, 360, 375, 390, 414, 430, 600, 768, 820, 900, 1024, 1280, 1366, 1440, 1728, 1920];
const pages = [
  { id: "home", hash: "#/store", selector: '[data-testid="v2-home"]' },
  { id: "catalog", hash: "#/store/products", selector: '[data-testid="v2-catalog"]' },
  { id: "pdp", hash: "#/store/products/prd-1001", selector: '[data-testid="v2-product"]' },
];

await mkdir(output, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE || undefined,
  args: ["--no-sandbox", "--disable-dev-shm-usage"], ignoreDefaultArgs: ["--hide-scrollbars"] });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: "en-US" });
const page = await context.newPage();
page.setDefaultTimeout(30_000);
const failures = [];
page.on("pageerror", (error) => failures.push(`pageerror: ${error.message}`));
page.on("console", (message) => { if (message.type() === "error") failures.push(`console: ${message.text()}`); });
page.on("response", (response) => {
  if (response.status() >= 400 && response.url().startsWith(base)) failures.push(`${response.status()} ${response.url()}`);
});
let measured = 0;
try {
  await page.goto(`${base}/#/store`, { timeout: 120_000 });
  await page.getByTestId("v2-card-prd-1001").waitFor({ timeout: 60_000 });
  for (const lang of ["en", "ar"]) {
    await page.evaluate((next) => localStorage.setItem("alyq.lang", next), lang);
    await page.goto(`${base}/#/store`);
    await page.reload({ timeout: 120_000 });
    await page.getByTestId("v2-home").waitFor();
    if (lang === "ar") await assertRenderedArabicFont(page);
    for (const width of widths) {
      const height = width <= 414 ? 780 : width === 768 ? 900 : 960;
      await page.setViewportSize({ width, height });
      for (const item of pages) {
        // page.goto on the same origin's hash route is a client-side navigation.
        await page.goto(`${base}/${item.hash}`);
        await page.locator(item.selector).waitFor();
        await page.evaluate(async () => {
          // A full-page screenshot alone does NOT load lazy media. Scroll through
          // each page so real asset success/failure is observable.
          for (let y = 0; y < document.documentElement.scrollHeight; y += 700) {
            window.scrollTo(0, y);
            await new Promise((resolve) => setTimeout(resolve, 18));
          }
          window.scrollTo(0, 0);
          await document.fonts.ready;
          await Promise.all([...document.images].filter((img) => img.currentSrc).map((img) =>
            Promise.race([img.decode().catch(() => {}), new Promise((resolve) => setTimeout(resolve, 3500))])));
        });
        const geometry = await page.evaluate(() => {
          const grid = document.querySelector("main .v2-product-grid");
          const images = [...document.querySelectorAll("main img")];
          const header = document.querySelector(".v2-header-inner");
          const logo = document.querySelector(".v2-logo");
          const hero = document.querySelector(".v2-hero");
          const headingOverflow = [...document.querySelectorAll("main h1, main h2")]
            .filter((node) => node.scrollWidth > node.clientWidth + 2)
            .map((node) => node.textContent.trim().slice(0, 70));
          // overflow-x: clip on the shell can conceal misplaced children without
          // widening the document. Also inspect actual painted content bounds.
          const clippedContent = [...document.querySelectorAll(
            ".v2-logo, .v2-product-card, .v2-pdp-layout, .v2-footer-inner, .v2-footer-bottom",
          )].filter((node) => {
            const rect = node.getBoundingClientRect();
            return rect.width > 0 && (rect.left < -1 || rect.right > innerWidth + 1);
          }).map((node) => `${node.className}: ${node.getBoundingClientRect().toJSON().x}`);
          const midpoint = (el) => { const r = el.getBoundingClientRect(); return r.x + r.width / 2; };
          const footer = document.querySelector(".v2-footer");
          const footerBottom = document.querySelector(".v2-footer-bottom");
          const scroller = document.scrollingElement;
          scroller.scrollTop = scroller.scrollHeight;
          return {
            viewport: innerWidth, documentWidth: document.documentElement.scrollWidth,
            bodyWidth: document.body.scrollWidth, dir: document.documentElement.dir,
            shellDir: document.querySelector(".store-v2")?.getAttribute("dir"),
            columns: grid ? getComputedStyle(grid).gridTemplateColumns.split(" ").length : 0,
            loaded: images.filter((img) => img.naturalWidth > 0).length,
            broken: images.filter((img) => img.complete && img.naturalWidth === 0).map((img) => img.currentSrc),
            headingOverflow, clippedContent,
            footerReachable: Boolean(footer && footerBottom && footerBottom.getBoundingClientRect().bottom <= innerHeight + 2),
            footerLinks: footer?.querySelectorAll("a[href]").length ?? 0,
            hero: hero ? hero.getBoundingClientRect().toJSON() : null,
            centerDiff: header && logo ? Math.abs(midpoint(header) - midpoint(logo)) : 99,
            headerActions: {
              search: Boolean(document.querySelector('.v2-header-start button[aria-expanded]')),
              account: Boolean(document.querySelector('.v2-header-end a[href="#/store/account"]')),
              cart: Boolean(document.querySelector('.v2-header-end a[href="#/store/cart"]')),
              mobileMenu: Boolean(document.querySelector('.v2-mobile-only')?.getClientRects().length),
              desktopNav: Boolean(document.querySelector('.v2-desktop-nav')?.getClientRects().length),
            },
          };
        });
        const label = `${item.id}/${lang}/${width}`;
        assert.equal(geometry.viewport, width, `${label}: viewport`);
        assert.equal(geometry.dir, lang === "ar" ? "rtl" : "ltr", `${label}: document direction`);
        assert.equal(geometry.shellDir, geometry.dir, `${label}: isolated shell direction`);
        assert.ok(geometry.documentWidth <= width + 1 && geometry.bodyWidth <= width + 1,
          `${label}: no horizontal page overflow — ${JSON.stringify(geometry)}`);
        assert.ok(geometry.centerDiff < 2, `${label}: wordmark stays geometrically centered`);
        assert.ok(geometry.headerActions.search && geometry.headerActions.account && geometry.headerActions.cart,
          `${label}: configured search, account and cart entries exist`);
        assert.equal(geometry.headerActions.mobileMenu, width < 768, `${label}: mobile menu is breakpoint-correct`);
        assert.equal(geometry.headerActions.desktopNav, width >= 768, `${label}: desktop navigation is breakpoint-correct`);
        assert.deepEqual(geometry.headingOverflow, [], `${label}: headings do not clip`);
        assert.deepEqual(geometry.clippedContent, [], `${label}: card, PDP, logo and footer bounds fit viewport`);
        assert.ok(geometry.footerReachable && geometry.footerLinks > 0,
          `${label}: the footer and its configured links are reachable by vertical scrolling`);
        assert.deepEqual(geometry.broken, [], `${label}: real media loads`);
        assert.ok(geometry.loaded > 0, `${label}: at least one configured/catalogue image loaded`);
        if (item.id === "home" || item.id === "catalog") {
          const expected = width < 640 ? 2 : width < 1024 ? 3 : 4;
          assert.equal(geometry.columns, expected, `${label}: expected ${expected} rendered product columns`);
        }
        if (item.id === "home") {
          assert.ok(geometry.hero && geometry.hero.width <= width + 1 && geometry.hero.height > 300,
            `${label}: hero uses viewport width and a sensible height`);
          if (width === 320) {
            const before = await page.evaluate(() => location.hash);
            await page.locator(".v2-skip").focus();
            await page.keyboard.press("Enter");
            assert.equal(await page.evaluate(() => location.hash), before,
              `${label}: skip link must not become a HashRouter route`);
            assert.equal(await page.evaluate(() => document.activeElement?.id), "v2-main",
              `${label}: keyboard skip focuses main content`);
          }
        }
        if (item.id === "catalog" && width <= 414) {
          const chips = await page.locator(".v2-category-chips").evaluate((element) => {
            const max = element.scrollWidth - element.clientWidth;
            element.scrollLeft = getComputedStyle(element).direction === "rtl" ? -max : max;
            return { max, offset: element.scrollLeft };
          });
          assert.ok(chips.max <= 2 || Math.abs(chips.offset) >= chips.max - 2,
            `${label}: horizontally scrollable category chips reach the last chip in ${lang}`);
        }
        if (item.id === "pdp") {
          const add = page.getByTestId("v2-pdp-add");
          assert.equal(await add.isDisabled(), false, `${label}: plain-stock product is orderable`);
        }
        // A sticky header would otherwise be composited near the footer in a
        // full-page screenshot taken while the document is scrolled to the end.
        await page.evaluate(() => { document.scrollingElement.scrollTop = 0; });
        if (([320, 390, 768, 1440, 1920].includes(width) && item.id === "home") ||
          (width === 390 && ["catalog", "pdp"].includes(item.id))) {
          await page.screenshot({ path: `${output}/${item.id}-${lang}-${width}.png`, fullPage: true });
        }
        measured++;
        console.log(`✓ ${label}: ${geometry.columns || "PDP"} columns, ${geometry.loaded} loaded photos, no overflow, centered wordmark`);
      }
      if (width <= 414) {
        await page.goto(`${base}/#/store`);
        await page.getByTestId("v2-home").waitFor();
        await page.getByTestId("v2-menu-open").click();
        const drawer = page.getByRole("dialog", { name: lang === "ar" ? "القائمة" : "Menu" });
        await drawer.waitFor();
        await page.waitForFunction(() => {
          const r = document.querySelector('.v2-drawer')?.getBoundingClientRect();
          return r && r.left >= -1 && r.right <= innerWidth + 1;
        });
        const bounds = await drawer.boundingBox();
        assert.ok(bounds && bounds.x >= -1 && bounds.x + bounds.width <= width + 1,
          `${lang}/${width}: drawer fits in the viewport`);
        const drawerScroll = await drawer.locator(".v2-drawer-scroll").evaluate((element) => {
          element.scrollTop = element.scrollHeight;
          return { top: element.scrollTop, max: element.scrollHeight - element.clientHeight };
        });
        assert.ok(drawerScroll.top >= drawerScroll.max - 2,
          `${lang}/${width}: long drawer content scrolls to its last item`);
        await page.waitForFunction(() => document.body.style.overflow === "hidden");
        await page.keyboard.press("Escape");
        assert.equal(await page.locator('.v2-drawer-layer').getAttribute("data-open"), "false",
          `${lang}/${width}: Escape closes the drawer`);
        await page.waitForFunction(() => document.body.style.overflow !== "hidden");
      }
    }
  }
  // An isolated browser-profile demo fixture exercises the *rendered* colour +
  // size controls. Unlike the ordinary seeded demo range, this test-only ring
  // has exact numeric, fractional, letter and sold-out shelves. No app seed,
  // catalogue repository or production merchandising is modified.
  const variantIds = {
    gold17: "4fb4125a-0f26-461e-8a94-31e365342101",
    gold18: "4fb4125a-0f26-461e-8a94-31e365342102",
    silverXS: "4fb4125a-0f26-461e-8a94-31e365342103",
    silverHalf: "4fb4125a-0f26-461e-8a94-31e365342104",
  };
  const variantProductId = await page.evaluate((ids) => {
    const key = "alyq.demo.catalog.v1";
    const state = JSON.parse(localStorage.getItem(key));
    const ring = state.products.find((product) => product.sku === "ALYQ-1002");
    if (!ring) throw new Error("The demo ring required for the rendered variant fixture is missing");
    ring.variants_enabled = true;
    ring.stock_quantity = 5;
    ring.low_stock_level = 1;
    const shelf = (id, color, size, sizeLabel, stock, override = null) => ({
      id, product_id: ring.id, sku: `V2-RENDER-${color}-${sizeLabel || size}`, barcode: null,
      color_key: color, color_en: color === "gold" ? "Gold" : "Silver",
      color_ar: color === "gold" ? "ذهبي" : "فضي",
      color_hex: color === "gold" ? "#cba556" : "#c9c9c9",
      size, size_label: sizeLabel, image_url: null, price_override: override, cost_override: null,
      stock_quantity: stock, low_stock_level: 1, active: true, sort_order: 1,
      created_at: ring.created_at, updated_at: ring.updated_at,
    });
    state.variants = [
      ...state.variants.filter((variant) => variant.product_id !== ring.id),
      shelf(ids.gold17, "gold", 17, null, 2, 88),
      shelf(ids.gold18, "gold", 18, null, 0),
      shelf(ids.silverXS, "silver", null, "XS", 1),
      shelf(ids.silverHalf, "silver", 16.5, null, 2),
    ];
    localStorage.setItem(key, JSON.stringify(state));
    return ring.id;
  }, variantIds);
  let variantCases = 0;
  for (const lang of ["en", "ar"]) {
    await page.evaluate((next) => {
      localStorage.setItem("alyq.lang", next);
      localStorage.removeItem("alyq.store.cart.v2");
    }, lang);
    await page.goto(`${base}/#/store/products/${variantProductId}`);
    await page.reload({ timeout: 120_000 });
    await page.getByTestId("v2-color-gold").waitFor({ timeout: 60_000 });
    for (const width of widths) {
      await page.setViewportSize({ width, height: width <= 414 ? 780 : width === 768 ? 900 : 960 });
      const label = `variants/${lang}/${width}`;
      assert.equal(await page.locator(".store-v2").getAttribute("dir"), lang === "ar" ? "rtl" : "ltr", label);
      const add = page.getByTestId("v2-pdp-add");
      await page.getByTestId("v2-color-gold").click();
      assert.equal(await add.isDisabled(), true, `${label}: colour alone never selects a size`);
      assert.equal(await page.getByTestId("v2-size-18").isDisabled(), true, `${label}: sold-out Gold/18 is disabled`);
      assert.equal(await page.getByTestId("v2-size-XS").count(), 0, `${label}: Silver-only XS is not invented for Gold`);
      await page.getByTestId("v2-size-17").click();
      assert.equal(await add.isEnabled(), true, `${label}: Gold/17 enables the exact shelf`);
      await page.getByTestId("v2-color-silver").click();
      assert.equal(await add.isDisabled(), true, `${label}: switching colour clears the old size`);
      assert.equal(await page.getByTestId("v2-size-16.5").isEnabled(), true, `${label}: decimal 16.5 renders`);
      await page.getByTestId("v2-size-XS").click();
      assert.equal(await add.isEnabled(), true, `${label}: letter size XS renders and is orderable`);
      const controls = await page.evaluate(() => {
        const nodes = [...document.querySelectorAll(".v2-pdp-info .v2-color-option, .v2-pdp-info .v2-size-option")];
        return {
          pageWidth: document.documentElement.scrollWidth,
          clipped: nodes.filter((node) => {
            const rect = node.getBoundingClientRect();
            return rect.left < -1 || rect.right > innerWidth + 1 || node.scrollWidth > node.clientWidth + 2;
          }).map((node) => node.textContent.trim()),
        };
      });
      assert.ok(controls.pageWidth <= width + 1, `${label}: no document overflow`);
      assert.deepEqual(controls.clipped, [], `${label}: rendered colour and size controls are not clipped`);
      if (width === 320) {
        await add.click();
        const lines = await page.evaluate(() => JSON.parse(localStorage.getItem("alyq.store.cart.v2"))?.lines || []);
        assert.ok(lines.some((line) => line.variant_id === variantIds.silverXS),
          `${label}: browser cart receives the exact Silver/XS UUID`);
      }
      if ([320, 390, 768, 1440, 1920].includes(width)) {
        await page.goto(`${base}/#/store/products`);
        const quickAdd = page.getByTestId(`v2-quick-add-${variantProductId}`);
        await quickAdd.waitFor();
        await quickAdd.click();
        await page.getByTestId("v2-card-options").waitFor();
        const cardBounds = await page.getByTestId(`v2-card-${variantProductId}`).evaluate((node) => {
          const rect = node.getBoundingClientRect();
          return { left: rect.left, right: rect.right, documentWidth: document.documentElement.scrollWidth };
        });
        assert.ok(cardBounds.left >= -1 && cardBounds.right <= width + 1 && cardBounds.documentWidth <= width + 1,
          `${label}: an expanded product-card chooser fits its grid cell`);
        await page.goto(`${base}/#/store/products/${variantProductId}`);
        await page.getByTestId("v2-color-gold").waitFor();
      }
      variantCases++;
      console.log(`✓ ${label}: exact colour/size choices, sold-out state and unclipped controls`);
    }
  }
  console.log(`✓ ${variantCases}/${widths.length * 2} rendered variant PDP cases + expanded card samples`);

  // The existing website settings are still authoritative: a saved palette,
  // section toggle and product-card controls alter V2 after a *real reload*.
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.evaluate(() => {
    const key = "alyq.demo.website_settings.v1";
    const snapshot = JSON.parse(localStorage.getItem(key));
    snapshot.settings.theme.primary_color = "#0f766e";
    snapshot.settings.product_card.desktop_columns = 5;
    snapshot.settings.product_card.aspect = "square";
    snapshot.settings.product_card.show_price = false;
    snapshot.settings.product_card.show_wishlist = false;
    snapshot.settings.product_card.show_quick_add = false;
    snapshot.settings.sections = snapshot.settings.sections.map((section) =>
      section.key === "featured" ? { ...section, visible: false } : section);
    localStorage.setItem(key, JSON.stringify(snapshot));
  });
  await page.goto(`${base}/#/store/products`);
  await page.reload();
  await page.getByTestId("v2-catalog").waitFor();
  await page.getByTestId("v2-card-prd-1001").waitFor();
  const saved = await page.evaluate(() => ({
    color: getComputedStyle(document.querySelector(".store-v2")).getPropertyValue("--v2-primary").trim(),
    columns: getComputedStyle(document.querySelector(".v2-product-grid")).gridTemplateColumns.split(" ").length,
    media: document.querySelector(".v2-product-media")?.getBoundingClientRect().toJSON(),
    prices: document.querySelectorAll(".v2-card-price").length,
    wishlist: document.querySelectorAll(".v2-wishlist").length,
    quickAdd: document.querySelectorAll(".v2-card-add").length,
  }));
  assert.equal(saved.color, "#0f766e", "saved palette reaches V2 tokens after reload");
  assert.equal(saved.columns, 5, "saved desktop card count reaches V2 grid");
  assert.ok(saved.media && Math.abs(saved.media.width - saved.media.height) < 2, "saved card aspect reaches V2");
  assert.equal(saved.prices + saved.wishlist + saved.quickAdd, 0, "saved card visibility flags reach V2");
  await page.goto(`${base}/#/store`);
  await page.getByTestId("v2-home").waitFor();
  assert.equal(await page.locator("#featured").count(), 0, "saved section visibility reaches V2 homepage");
  console.log("✓ saved theme, card visibility/aspect/columns and homepage section flags survive reload in Chromium");
  await page.goto(`${base}/#/store/products`);
  await page.getByTestId("v2-catalog").waitFor();
  assert.equal(await page.getByTestId("store-v2").count(), 1, "canonical catalogue uses the V2 shell in Chromium");
  assert.deepEqual(failures, [], "no Chromium console/network failures");
  console.log(`\n✓ ${measured}/${widths.length * 2 * pages.length} rendered viewports, EN/LTR + AR/RTL, canonical home/catalogue/PDP`);
  console.log(`✓ representative screenshots under ${output}/ (ignored by Git)`);
} finally {
  await browser.close();
}
