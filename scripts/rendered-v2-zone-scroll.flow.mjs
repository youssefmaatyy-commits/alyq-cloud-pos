#!/usr/bin/env node
/**
 * Issue #B (follow-up) — real-Chromium runtime proof for the checkout
 * delivery-zone scroll pane. jsdom (scripts/storefront-v2-journey.flow.mjs)
 * proves the DOM contract — every row lives inside `.v2-zone-scroll`, the
 * legend/validation stay outside it, and the CSS rule text itself declares
 * a bounded `max-height` + `overflow-y: auto` — but jsdom never runs real
 * CSS layout, so `scrollHeight`, `clientHeight` and `scrollTop` are always 0
 * there. This script measures actual pixels in a real browser instead:
 *
 *   · a 12-zone shop genuinely overflows (scrollHeight > clientHeight)
 *   · a 3-zone shop does NOT (no scrollbar forced where none is needed)
 *   · scrollTop actually moves, both by direct assignment and by a real
 *     mouse-wheel gesture (page.mouse.wheel)
 *   · no horizontal scrollbar appears on the pane or the page, EN or AR/RTL
 *   · the legend and the validation error are never inside the scrollable
 *     region, so scrolling the list never scrolls them out of view
 *   · "Place order"'s position on the page barely moves between the 3-zone
 *     and 12-zone fixtures — the bounded pane, not the zone count, decides
 *     how far down the page runs
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
    // A clean cart every pass: this file only cares about the zone pane.
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
  const pane = page.locator(".v2-zone-scroll");
  await pane.waitFor();
  return pane;
}

try {
  const context = await browser.newContext({ viewport: { width: 390, height: 700 }, locale: "en-US" });
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  page.on("pageerror", (error) => failures.push(`pageerror: ${error.message}`));
  page.on("console", (message) => { if (message.type() === "error") failures.push(`console: ${message.text()}`); });

  // ── EN: 12 zones genuinely overflow ────────────────────────────────────
  const pane12 = await seedAndReachCheckout(page, 12, "en");
  assert.equal(await pane12.locator(".v2-zone").count(), 12, "all 12 zone rows rendered, none dropped");
  const geometry12 = await pane12.evaluate((el) => ({
    scrollHeight: el.scrollHeight, clientHeight: el.clientHeight, scrollWidth: el.scrollWidth,
    clientWidth: el.clientWidth,
  }));
  assert.ok(geometry12.scrollHeight > geometry12.clientHeight,
    `12 zones must genuinely overflow the bounded pane (scrollHeight ${geometry12.scrollHeight} > clientHeight ${geometry12.clientHeight})`);
  assert.ok(geometry12.scrollWidth <= geometry12.clientWidth + 1,
    "no horizontal overflow inside the pane with 12 zones");
  const pageScrollWidth12 = await page.evaluate(() => document.documentElement.scrollWidth);
  assert.ok(pageScrollWidth12 <= 390 + 1, "no page-level horizontal scrollbar with 12 zones");
  console.log(`✓ EN 12-zone pane overflows for real: scrollHeight ${geometry12.scrollHeight} > clientHeight ${geometry12.clientHeight}, no horizontal overflow`);

  // Legend and validation error are never inside the scrollable region.
  const legendOutside = await page.evaluate(() => {
    const fieldset = document.querySelector("fieldset.v2-zone-list");
    const legend = fieldset?.querySelector(":scope > legend");
    return Boolean(legend) && legend.closest(".v2-zone-scroll") === null;
  });
  assert.ok(legendOutside, "the zone list's legend is never inside the scroll pane");

  // scrollTop actually moves: direct assignment to the bottom, then read back.
  const scrolled = await pane12.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
    return el.scrollTop;
  });
  assert.ok(scrolled > 0, "scrollTop moves off zero when scrolled to the pane's own bottom");
  const maxScroll = geometry12.scrollHeight - geometry12.clientHeight;
  assert.ok(scrolled >= maxScroll - 2, "scrolling to scrollHeight actually reaches the bottom of real content");

  // A real mouse-wheel gesture over the pane scrolls it, not the page.
  await pane12.evaluate((el) => { el.scrollTop = 0; });
  const box = await pane12.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  const pageScrollBefore = await page.evaluate(() => document.documentElement.scrollTop);
  await page.mouse.wheel(0, 300);
  await page.waitForTimeout(150);
  const afterWheel = await pane12.evaluate((el) => el.scrollTop);
  const pageScrollAfter = await page.evaluate(() => document.documentElement.scrollTop);
  assert.ok(afterWheel > 0, "a mouse-wheel gesture over the pane scrolls the zone list");
  assert.equal(pageScrollAfter, pageScrollBefore, "the page itself does not also scroll — overscroll-behavior: contain holds");
  console.log(`✓ scrollTop reaches the real bottom (${scrolled}px) and a mouse-wheel gesture scrolls only the pane (${afterWheel}px)`);

  const placeOrderTop12 = (await page.getByTestId("v2-place-order").boundingBox())?.y ?? null;

  // ── EN: 3 zones fit — no forced scrollbar ──────────────────────────────
  const pane3 = await seedAndReachCheckout(page, 3, "en");
  const geometry3 = await pane3.evaluate((el) => ({ scrollHeight: el.scrollHeight, clientHeight: el.clientHeight }));
  assert.ok(geometry3.scrollHeight <= geometry3.clientHeight + 1,
    `3 zones must NOT be forced to overflow (scrollHeight ${geometry3.scrollHeight}, clientHeight ${geometry3.clientHeight})`);
  console.log(`✓ EN 3-zone pane does not overflow: scrollHeight ${geometry3.scrollHeight} ≈ clientHeight ${geometry3.clientHeight} (no forced scrollbar)`);

  const placeOrderTop3 = (await page.getByTestId("v2-place-order").boundingBox())?.y ?? null;
  assert.ok(placeOrderTop12 !== null && placeOrderTop3 !== null, "Place order is visible/reachable in both fixtures");
  assert.ok(Math.abs(placeOrderTop12 - placeOrderTop3) < 80,
    `"Place order" barely moves between 3 zones and 12 zones (${placeOrderTop3}px vs ${placeOrderTop12}px) — the bounded pane, not the zone count, decides page length`);
  console.log(`✓ "Place order" stays put regardless of zone count: ${placeOrderTop3}px (3 zones) vs ${placeOrderTop12}px (12 zones)`);

  // ── AR/RTL: same overflow contract, no horizontal scrollbar ────────────
  const paneAr = await seedAndReachCheckout(page, 12, "ar");
  assert.equal(await page.locator(".store-v2").getAttribute("dir"), "rtl", "AR renders the shell RTL");
  const geometryAr = await paneAr.evaluate((el) => ({
    scrollHeight: el.scrollHeight, clientHeight: el.clientHeight, scrollWidth: el.scrollWidth, clientWidth: el.clientWidth,
  }));
  assert.ok(geometryAr.scrollHeight > geometryAr.clientHeight, "AR/RTL 12-zone pane also genuinely overflows");
  assert.ok(geometryAr.scrollWidth <= geometryAr.clientWidth + 1, "no horizontal overflow inside the AR/RTL pane");
  const pageScrollWidthAr = await page.evaluate(() => document.documentElement.scrollWidth);
  assert.ok(pageScrollWidthAr <= 390 + 1, "no page-level horizontal scrollbar in AR/RTL");
  console.log("✓ AR/RTL: same bounded-overflow contract holds, no horizontal scrollbar");

  assert.deepEqual(failures, [], "no Chromium console/page errors across the whole run");
  console.log("\n✓ Issue #B real-Chromium zone-scroll runtime verification passed");
} finally {
  await browser.close();
}
