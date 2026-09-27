#!/usr/bin/env node
/**
 * Issue #1 (8th follow-up round) — real-Chromium runtime proof for the
 * checkout delivery-zone DROPDOWN. jsdom (scripts/storefront-v2-journey.flow.mjs)
 * proves the DOM/CSS-text contract — the popup is `position: absolute` off
 * a `position: relative` wrapper, every option lives inside it, and the CSS
 * rule text itself declares a bounded `max-height` + `overflow-y: auto` —
 * but jsdom never runs real CSS layout, so `scrollHeight`, `clientHeight`
 * and `scrollTop` are always 0 there, and it cannot prove the popup floats
 * over the page without expanding it. This script measures actual pixels
 * in a real browser instead:
 *
 *   · closed by default: the popup is not in the DOM until the trigger is
 *     clicked, and opening it does not change the page's own scroll height
 *   · a 12-zone shop genuinely overflows the popup (scrollHeight > clientHeight)
 *   · a 3-zone shop does NOT (no scrollbar forced where none is needed) and
 *     opens with the exact same trigger position (no page reflow either way)
 *   · scrollTop actually moves, both by direct assignment and by a real
 *     mouse-wheel gesture (page.mouse.wheel) and a real touch-drag gesture
 *     (page.touchscreen), and only the popup scrolls — never the page
 *   · no horizontal scrollbar appears on the popup or the page, EN or AR/RTL
 *   · clicking an option selects it (checkmark + trigger label update) and
 *     closes the popup
 *
 * Run against a locally built/served app (matches the other
 * scripts/rendered-v2-*.flow.mjs siblings):
 *   npm run build && npm run preview -- --port 4173 &
 *   V2_VISUAL_BASE_URL=http://127.0.0.1:4173 node scripts/rendered-v2-zone-scroll.flow.mjs
 * (or just `node scripts/rendered-v2-zone-scroll.flow.mjs` once a server is
 * already up on the default port). Requires Chromium's binary
 * (`npx playwright install chromium`) — not run by CI, which has no
 * network path to fetch it; this is a local/developer verification tool,
 * same as its rendered-v2-*.flow.mjs siblings.
 */
import assert from "node:assert/strict";
import { chromium } from "@playwright/test";

const base = process.env.V2_VISUAL_BASE_URL || "http://127.0.0.1:4173";
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_EXECUTABLE || undefined,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const failures = [];

/** A realistic Egyptian-governorate fixture. Duplicated (not imported) on
 * purpose: this file must stay runnable stand-alone against a served build,
 * where the repository's TypeScript sources are not on the page's module
 * graph — only what a real browser session can localStorage.setItem. */
function buildZones(count) {
  const base10 = [
    ["ismailia", "Ismailia", "الإسماعيلية", 0],
    ["cairo", "Cairo", "القاهرة", 70],
    ["suez", "Suez", "السويس", 50],
    ["alexandria", "Alexandria", "الإسكندرية", 60],
    ["giza", "Giza", "الجيزة", 65],
    ["luxor", "Luxor", "الأقصر", 90],
    ["aswan", "Aswan", "أسوان", 95],
    ["sohag", "Sohag", "سوهاج", 85],
    ["minya", "Minya", "المنيا", 80],
    ["beni-suef", "Beni Suef", "بني سويف", 75],
    ["fayoum", "Fayoum", "الفيوم", 78],
    ["other", "Other governorates", "باقي المحافظات", 80],
  ];
  const now = new Date().toISOString();
  return base10.slice(0, count).map(([key, en, ar, fee], index) => ({
    id: `dz-${key}`, key, name_en: en, name_ar: ar, governorate_key: key,
    shipping_fee: fee, minimum_order_amount: 0, free_shipping_threshold: null,
    estimated_delivery_text_en: "1–2 business days", estimated_delivery_text_ar: "١–٢ يوم عمل",
    show_estimated_delivery: true, enabled: true, sort_order: (index + 1) * 10,
    created_at: now, updated_at: now,
  }));
}

async function seedAndReachCheckout(page, zoneCount, lang) {
  await page.goto(`${base}/#/store`, { timeout: 120_000 });
  await page.getByTestId("v2-home").waitFor({ timeout: 60_000 });
  await page.evaluate(({ zones, lang }) => {
    localStorage.setItem("alyq.demo.delivery_zones.v1", JSON.stringify(zones));
    localStorage.setItem("alyq.lang", lang);
    // A clean cart every pass: this file only cares about the zone dropdown.
    localStorage.removeItem("alyq.store.cart.v2");
  }, { zones: buildZones(zoneCount), lang });
  await page.reload();
  await page.getByTestId("v2-home").waitFor();
  await page.goto(`${base}/#/store/products/prd-2001`, { timeout: 60_000 });
  await page.getByTestId("v2-pdp-add").waitFor();
  await page.getByTestId("v2-pdp-add").click();
  await page.goto(`${base}/#/store/checkout`, { timeout: 60_000 });
  await page.getByTestId("v2-checkout").waitFor();
  const deliveryLabel = lang === "ar" ? "توصيل" : "Delivery";
  const codLabel = lang === "ar" ? "الدفع عند الاستلام" : "Cash on delivery";
  await page.locator(".v2-choice-grid").first().getByRole("button", { name: deliveryLabel, exact: true }).click();
  await page.getByRole("button", { name: codLabel, exact: true }).click();
  const trigger = page.getByTestId("v2-zone-select-trigger");
  await trigger.waitFor();
  return trigger;
}

try {
  const context = await browser.newContext({ viewport: { width: 390, height: 700 }, locale: "en-US",
    hasTouch: true, isMobile: true });
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  page.on("pageerror", (error) => failures.push(`pageerror: ${error.message}`));
  page.on("console", (message) => { if (message.type() === "error") failures.push(`console: ${message.text()}`); });

  // ── EN: dropdown starts closed, opening it never expands the page ─────
  const trigger12 = await seedAndReachCheckout(page, 12, "en");
  assert.equal(await trigger12.getAttribute("aria-expanded"), "false", "the dropdown starts closed");
  assert.equal(await page.getByTestId("v2-zone-select-popup").count(), 0, "the popup is not in the DOM until opened");
  const pageHeightClosed = await page.evaluate(() => document.documentElement.scrollHeight);
  await trigger12.click();
  const popup12 = page.getByTestId("v2-zone-select-popup");
  await popup12.waitFor();
  assert.equal(await trigger12.getAttribute("aria-expanded"), "true", "opening the dropdown flips aria-expanded");
  const pageHeightOpen = await page.evaluate(() => document.documentElement.scrollHeight);
  assert.ok(pageHeightOpen <= pageHeightClosed + 2,
    `opening the popup must not expand the page's own scroll height (closed ${pageHeightClosed}px, open ${pageHeightOpen}px)`);
  console.log(`✓ EN: dropdown closed by default; opening it does not expand the page (closed ${pageHeightClosed}px, open ${pageHeightOpen}px)`);

  // ── EN: 12 zones genuinely overflow the popup ──────────────────────────
  assert.equal(await popup12.locator('[role="option"]').count(), 12, "all 12 zone options rendered, none dropped");
  const geometry12 = await popup12.evaluate((el) => ({
    scrollHeight: el.scrollHeight, clientHeight: el.clientHeight, scrollWidth: el.scrollWidth,
    clientWidth: el.clientWidth,
  }));
  assert.ok(geometry12.scrollHeight > geometry12.clientHeight,
    `12 zones must genuinely overflow the bounded popup (scrollHeight ${geometry12.scrollHeight} > clientHeight ${geometry12.clientHeight})`);
  assert.ok(geometry12.scrollWidth <= geometry12.clientWidth + 1,
    "no horizontal overflow inside the popup with 12 zones");
  const pageScrollWidth12 = await page.evaluate(() => document.documentElement.scrollWidth);
  assert.ok(pageScrollWidth12 <= 390 + 1, "no page-level horizontal scrollbar with 12 zones");
  console.log(`✓ EN 12-zone popup overflows for real: scrollHeight ${geometry12.scrollHeight} > clientHeight ${geometry12.clientHeight}, no horizontal overflow`);

  // scrollTop actually moves: direct assignment to the bottom, then read back.
  const scrolled = await popup12.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
    return el.scrollTop;
  });
  assert.ok(scrolled > 0, "scrollTop moves off zero when scrolled to the popup's own bottom");
  const maxScroll = geometry12.scrollHeight - geometry12.clientHeight;
  assert.ok(scrolled >= maxScroll - 2, "scrolling to scrollHeight actually reaches the bottom of real content");

  // A real mouse-wheel gesture over the popup scrolls it, not the page.
  await popup12.evaluate((el) => { el.scrollTop = 0; });
  const box = await popup12.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  const pageScrollBefore = await page.evaluate(() => document.documentElement.scrollTop);
  await page.mouse.wheel(0, 300);
  await page.waitForTimeout(150);
  const afterWheel = await popup12.evaluate((el) => el.scrollTop);
  const pageScrollAfter = await page.evaluate(() => document.documentElement.scrollTop);
  assert.ok(afterWheel > 0, "a mouse-wheel gesture over the popup scrolls the zone list");
  assert.equal(pageScrollAfter, pageScrollBefore, "the page itself does not also scroll — overscroll-behavior: contain holds");
  console.log(`✓ mouse-wheel scrolls only the popup (${afterWheel}px), the page stays put`);

  // A real touch-drag gesture over the popup scrolls it too (mobile
  // contract) — driven through CDP's `Input.dispatchTouchEvent`, which DOES
  // drive Chromium's real touch-scroll pipeline (unlike synthetic DOM
  // `touchstart`/`touchmove` events, which do not trigger native scrolling).
  await popup12.evaluate((el) => { el.scrollTop = 0; });
  const touchStartY = box.y + box.height - 20;
  const touchEndY = box.y + 20;
  const cdpSession = await context.newCDPSession(page);
  await cdpSession.send("Input.dispatchTouchEvent", {
    type: "touchStart", touchPoints: [{ x: box.x + box.width / 2, y: touchStartY }],
  });
  await cdpSession.send("Input.dispatchTouchEvent", {
    type: "touchMove", touchPoints: [{ x: box.x + box.width / 2, y: (touchStartY + touchEndY) / 2 }],
  });
  await cdpSession.send("Input.dispatchTouchEvent", {
    type: "touchMove", touchPoints: [{ x: box.x + box.width / 2, y: touchEndY }],
  });
  await cdpSession.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await page.waitForTimeout(200);
  const afterTouch = await popup12.evaluate((el) => el.scrollTop);
  assert.ok(afterTouch > 0, `a real touch-drag gesture over the popup scrolls the zone list (scrollTop ${afterTouch})`);
  console.log(`✓ a real touch-drag gesture scrolls the popup too (${afterTouch}px) — mobile scrolling verified`);

  // ── EN: selecting an option updates the trigger and closes the popup ──
  await popup12.evaluate((el) => { el.scrollTop = 0; });
  const cairoOption = popup12.locator('[role="option"]', { hasText: "Cairo" });
  await cairoOption.click();
  await page.getByTestId("v2-zone-select-popup").waitFor({ state: "detached" });
  assert.equal(await trigger12.getAttribute("aria-expanded"), "false", "selecting an option closes the popup");
  assert.ok((await page.getByTestId("v2-zone-select-value").innerText()).includes("Cairo"),
    "the closed trigger reflects the selected zone");
  await trigger12.click();
  const reopened = page.getByTestId("v2-zone-select-popup");
  await reopened.waitFor();
  const reopenedCairo = reopened.locator('[role="option"]', { hasText: "Cairo" });
  assert.equal(await reopenedCairo.getAttribute("aria-selected"), "true", "re-opening shows the checkmark on the selected row");
  await trigger12.click();
  await page.getByTestId("v2-zone-select-popup").waitFor({ state: "detached" });
  console.log("✓ selecting a zone updates the trigger label, shows a checkmark on re-open, and closes the popup");

  // ── EN: 3 zones fit — no forced scrollbar, no page reflow either way ──
  const trigger3 = await seedAndReachCheckout(page, 3, "en");
  // Scroll the trigger fully into view FIRST: a freshly-revealed off-screen
  // button naturally moves once focused/clicked (ordinary browser
  // scroll-into-view behaviour, unrelated to this dropdown) — the contract
  // under test is that the POPUP itself never reflows the page once the
  // trigger is already in a settled position.
  await trigger3.scrollIntoViewIfNeeded();
  await page.waitForTimeout(50);
  const trigger3Box = await trigger3.boundingBox();
  await trigger3.click();
  const popup3 = page.getByTestId("v2-zone-select-popup");
  await popup3.waitFor();
  const geometry3 = await popup3.evaluate((el) => ({ scrollHeight: el.scrollHeight, clientHeight: el.clientHeight }));
  assert.ok(geometry3.scrollHeight <= geometry3.clientHeight + 1,
    `3 zones must NOT be forced to overflow (scrollHeight ${geometry3.scrollHeight}, clientHeight ${geometry3.clientHeight})`);
  const trigger3BoxAfterOpen = await trigger3.boundingBox();
  assert.ok(Math.abs(trigger3Box.y - trigger3BoxAfterOpen.y) <= 1,
    `opening a 3-zone popup does not move the trigger — the popup floats, it does not push layout (before ${trigger3Box.y}, after ${trigger3BoxAfterOpen.y})`);
  console.log(`✓ EN 3-zone popup does not overflow: scrollHeight ${geometry3.scrollHeight} ≈ clientHeight ${geometry3.clientHeight} (no forced scrollbar), and opening it does not reflow the page`);

  // ── AR/RTL: same overflow contract, no horizontal scrollbar ────────────
  const triggerAr = await seedAndReachCheckout(page, 12, "ar");
  assert.equal(await page.locator(".store-v2").getAttribute("dir"), "rtl", "AR renders the shell RTL");
  await triggerAr.click();
  const popupAr = page.getByTestId("v2-zone-select-popup");
  await popupAr.waitFor();
  const geometryAr = await popupAr.evaluate((el) => ({
    scrollHeight: el.scrollHeight, clientHeight: el.clientHeight, scrollWidth: el.scrollWidth, clientWidth: el.clientWidth,
  }));
  assert.ok(geometryAr.scrollHeight > geometryAr.clientHeight, "AR/RTL 12-zone popup also genuinely overflows");
  assert.ok(geometryAr.scrollWidth <= geometryAr.clientWidth + 1, "no horizontal overflow inside the AR/RTL popup");
  const pageScrollWidthAr = await page.evaluate(() => document.documentElement.scrollWidth);
  assert.ok(pageScrollWidthAr <= 390 + 1, "no page-level horizontal scrollbar in AR/RTL");
  const arCairoOption = popupAr.locator('[role="option"]', { hasText: "القاهرة" });
  await arCairoOption.click();
  assert.ok((await page.getByTestId("v2-zone-select-value").innerText()).includes("القاهرة"),
    "AR/RTL: selecting a zone updates the closed trigger with the Arabic name");
  console.log("✓ AR/RTL: same bounded-overflow contract holds, no horizontal scrollbar, selection works");

  // ── Desktop viewport: same contract at a wider size ────────────────────
  await context.close();
  const desktopContext = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "en-US" });
  const desktopPage = await desktopContext.newPage();
  desktopPage.setDefaultTimeout(30_000);
  desktopPage.on("pageerror", (error) => failures.push(`pageerror(desktop): ${error.message}`));
  desktopPage.on("console", (message) => { if (message.type() === "error") failures.push(`console(desktop): ${message.text()}`); });
  const desktopTrigger = await seedAndReachCheckout(desktopPage, 12, "en");
  await desktopTrigger.click();
  const desktopPopup = desktopPage.getByTestId("v2-zone-select-popup");
  await desktopPopup.waitFor();
  const desktopGeometry = await desktopPopup.evaluate((el) => ({ scrollHeight: el.scrollHeight, clientHeight: el.clientHeight }));
  assert.ok(desktopGeometry.scrollHeight > desktopGeometry.clientHeight, "desktop 1440px: 12-zone popup also genuinely overflows");
  const desktopPageScrollWidth = await desktopPage.evaluate(() => document.documentElement.scrollWidth);
  assert.ok(desktopPageScrollWidth <= 1440 + 1, "no page-level horizontal scrollbar on desktop");
  console.log("✓ desktop 1440px: same bounded-overflow contract holds");
  await desktopContext.close();

  assert.deepEqual(failures, [], `no Chromium console/page errors across the whole run: ${JSON.stringify(failures)}`);
  console.log("\n✓ Issue #1 (8th follow-up round) real-Chromium zone-dropdown runtime verification passed");
} finally {
  await browser.close();
}
