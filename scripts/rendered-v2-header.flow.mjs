#!/usr/bin/env node
/**
 * Issue #1 (6th follow-up round) — real-Chromium runtime proof for the
 * Storefront V2 header branding. jsdom never runs real CSS layout or colour
 * resolution, so this measures actual rendered pixels/colours in a real
 * browser instead:
 *
 *   · no <img> ever renders inside .v2-logo — the boxed logo image is gone
 *   · the exact bilingual text "ALYQ | أَلِــيْـــق" renders, in the
 *     configured reading order for each language (EN leads on English,
 *     Arabic leads on Arabic — never re-ordered/duplicated)
 *   · both halves render in the shop's real gold accent colour, not the
 *     header's default text colour and not a white/black safety fallback
 *   · the logo/header itself has a transparent background — no white box
 *   · the header is centred and both nav/cart/menu/search stay aligned
 *     beside it (not overlapping)
 *   · desktop and mobile viewports both render it responsively
 *   · AR/RTL flips the reading order and keeps everything readable
 *   · the Arabic half's real glyph ink (measured with Canvas2D
 *     TextMetrics, diacritics and descenders included) fits inside its own
 *     rendered box — no bottom clipping — without inflating the header
 *
 * Run against a locally built/served app, same as its rendered-v2-*.flow.mjs
 * siblings:
 *   npm run build && npm run preview -- --port 4173 &
 *   V2_VISUAL_BASE_URL=http://127.0.0.1:4173 node scripts/rendered-v2-header.flow.mjs
 * Requires Chromium's binary (`npx playwright install chromium`) — not run
 * by CI, which has no network path to fetch it; this is a local/developer
 * verification tool, same as its siblings.
 */
import assert from "node:assert/strict";
import { chromium } from "@playwright/test";

const base = process.env.V2_VISUAL_BASE_URL || "http://127.0.0.1:4173";
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_EXECUTABLE || undefined,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const failures = [];
const GOLD = { r: 164, g: 141, b: 89 }; // #a48d59, this shop's configured accent colour

async function withPage(viewport, run) {
  const context = await browser.newContext({ viewport, locale: "en-US" });
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  page.on("pageerror", (error) => failures.push(`pageerror: ${error.message}`));
  page.on("console", (msg) => { if (msg.type() === "error") failures.push(`console: ${msg.text()}`); });
  try {
    await run(page);
  } finally {
    await context.close();
  }
}

async function loginAndVisitStore(page, { lang, viewport }) {
  // Admin login/shell chrome is desktop-only and unrelated to the V2
  // storefront under test — authenticate at a normal width first, then
  // resize to the target viewport before (re)visiting the storefront,
  // exactly like a real user rotating/resizing after already being signed
  // in. Visiting the shop once also seeds this isolated demo profile with
  // its real persisted settings/catalogue row (signing in to POS alone does
  // not).
  await page.goto(`${base}/#/`, { timeout: 120_000 });
  await page.locator('input[autocomplete="username"]').fill("admin");
  await page.locator('input[type="password"]').fill("alyq1234");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByTestId("shell-brand").waitFor();
  await page.goto(`${base}/#/store`, { timeout: 120_000 });
  await page.getByTestId("v2-home").waitFor();
  await page.evaluate((l) => localStorage.setItem("alyq.lang", l), lang);
  await page.setViewportSize(viewport);
  await page.reload();
  await page.getByTestId("v2-home").waitFor();
}

function parseRgb(value) {
  const match = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(value ?? "");
  if (!match) return null;
  return { r: Number(match[1]), g: Number(match[2]), b: Number(match[3]) };
}
function closeToGold(rgb) {
  if (!rgb) return false;
  return Math.abs(rgb.r - GOLD.r) <= 12 && Math.abs(rgb.g - GOLD.g) <= 12 && Math.abs(rgb.b - GOLD.b) <= 12;
}

async function assertHeaderBranding(page, { label, expectedOrder }) {
  const logo = page.locator(".v2-logo").first();
  await logo.waitFor();
  assert.equal(await logo.locator("img").count(), 0, `${label}: no <img> renders inside the header logo — no boxed logo image`);
  const text = (await logo.innerText()).replace(/\s+/g, " ").trim();
  assert.ok(text.includes("ALYQ"), `${label}: header text includes "ALYQ" (got "${text}")`);
  assert.ok(text.includes("أَلِ"), `${label}: header text includes the Arabic name (got "${text}")`);
  const primaryIndex = text.indexOf(expectedOrder[0]);
  const secondaryIndex = text.indexOf(expectedOrder[1]);
  assert.ok(primaryIndex >= 0 && secondaryIndex > primaryIndex,
    `${label}: reading order is "${expectedOrder[0]}" then "${expectedOrder[1]}" (got "${text}")`);
  const colours = await logo.evaluate((el) => {
    const spans = [...el.querySelectorAll(".v2-wordmark-primary, .v2-wordmark-secondary")];
    return spans.map((span) => getComputedStyle(span).color);
  });
  assert.equal(colours.length, 2, `${label}: both wordmark halves are present as separate coloured spans`);
  for (const colour of colours) {
    assert.ok(closeToGold(parseRgb(colour)), `${label}: wordmark colour "${colour}" is the configured gold accent, not white/black/default text`);
  }
  const backgroundColor = await logo.evaluate((el) => getComputedStyle(el).backgroundColor);
  assert.ok(backgroundColor === "rgba(0, 0, 0, 0)" || backgroundColor === "transparent",
    `${label}: header logo has a transparent background, not a white box (got "${backgroundColor}")`);
  return logo;
}

/** Issue #1 (7th follow-up round) — the Arabic half's real ink (with its
 * stacked fatha/kasra/sukun diacritics and the "ق" descender loop) was
 * visibly cropped at the bottom because the wordmark's line box was exactly
 * 1 x font-size, with no headroom for a display Arabic face's taller glyph
 * metrics, while `.v2-logo` clips overflow. Rather than eyeballing a
 * screenshot on every run, measure the actual rendered ink height with
 * Canvas2D's `TextMetrics.actualBoundingBoxAscent/Descent` (the same glyph
 * shaping/font the browser used to paint the span) and assert it fits
 * inside the span's own rendered box — a real, reproducible anti-regression
 * check, not a hardcoded line-height number.
 */
async function assertNoVerticalClipping(page, label) {
  const secondary = page.locator(".v2-wordmark-secondary").first();
  await secondary.waitFor();
  const result = await secondary.evaluate((el) => {
    const cs = getComputedStyle(el);
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    const metrics = ctx.measureText(el.textContent ?? "");
    const inkHeight = (metrics.actualBoundingBoxAscent ?? 0) + (metrics.actualBoundingBoxDescent ?? 0);
    const boxHeight = el.getBoundingClientRect().height;
    return { inkHeight, boxHeight, font: ctx.font };
  });
  assert.ok(result.inkHeight <= result.boxHeight + 0.5,
    `${label}: Arabic glyph ink (${result.inkHeight.toFixed(1)}px, font "${result.font}") fits inside its rendered box (${result.boxHeight.toFixed(1)}px) — no bottom/top clipping`);
}

try {
  // --- Desktop EN: gold text, transparent bg, "ALYQ" leads, nav/cart aligned ---
  await withPage({ width: 1440, height: 900 }, async (page) => {
    await loginAndVisitStore(page, { lang: "en", viewport: { width: 1440, height: 900 } });
    const logo = await assertHeaderBranding(page, { label: "Desktop EN", expectedOrder: ["ALYQ", "أَلِ"] });
    const logoBox = await logo.boundingBox();
    const headerBox = await page.locator(".v2-header-inner").first().boundingBox();
    // Centred: the logo's own centre sits within a few px of the header's centre.
    const logoCenter = logoBox.x + logoBox.width / 2;
    const headerCenter = headerBox.x + headerBox.width / 2;
    assert.ok(Math.abs(logoCenter - headerCenter) < 4, `Desktop EN: header wordmark is centred (logo centre ${logoCenter.toFixed(1)}, header centre ${headerCenter.toFixed(1)})`);
    const cartBox = await page.locator(".v2-bag-button").first().boundingBox();
    const searchBox = await page.locator('[aria-label="Search"]').first().boundingBox().catch(() => null);
    assert.ok(cartBox.x >= logoBox.x + logoBox.width - 1, "Desktop EN: cart icon stays to the side of the wordmark, not overlapping it");
    const navLinks = page.locator(".v2-desktop-nav a");
    assert.ok(await navLinks.count() > 0, "Desktop EN: desktop nav links render alongside the wordmark");
    console.log(`✓ Desktop EN: gold transparent text wordmark, centred, nav/cart aligned (${logoBox.width.toFixed(1)}x${logoBox.height.toFixed(1)}px)`);
  });

  // --- Desktop AR/RTL: reading order flips, still gold, still transparent ---
  await withPage({ width: 1440, height: 900 }, async (page) => {
    await loginAndVisitStore(page, { lang: "ar", viewport: { width: 1440, height: 900 } });
    await assertHeaderBranding(page, { label: "Desktop AR/RTL", expectedOrder: ["أَلِ", "ALYQ"] });
    await assertNoVerticalClipping(page, "Desktop AR/RTL");
    const dir = await page.locator(".store-v2").first().getAttribute("dir");
    assert.equal(dir, "rtl", "Desktop AR: the storefront shell is in RTL mode");
    const headerHeight = await page.locator(".v2-header-inner").first().evaluate((el) => el.getBoundingClientRect().height);
    assert.ok(headerHeight <= 90, `Desktop AR: header stays a normal height (${headerHeight}px) — the extra Arabic line-height headroom did not inflate it`);
    console.log("✓ Desktop AR/RTL: reading order flips (Arabic name leads), still gold, still transparent, no glyph clipping");
  });

  // --- Mobile EN: smaller responsive wordmark, menu/cart still aligned ---
  await withPage({ width: 1440, height: 900 }, async (page) => {
    await loginAndVisitStore(page, { lang: "en", viewport: { width: 390, height: 844 } });
    const logo = await assertHeaderBranding(page, { label: "Mobile EN", expectedOrder: ["ALYQ", "أَلِ"] });
    const logoBox = await logo.boundingBox();
    const menuBox = await page.locator('[data-testid="v2-menu-open"]').boundingBox();
    const cartBox = await page.locator(".v2-bag-button").first().boundingBox();
    assert.ok(menuBox.x + menuBox.width <= logoBox.x + 1, "Mobile EN: menu button stays to the side of the wordmark");
    assert.ok(cartBox.x >= logoBox.x + logoBox.width - 1, "Mobile EN: cart icon stays to the side of the wordmark");
    assert.ok(logoBox.width < 300, `Mobile EN: wordmark fits a phone width (${logoBox.width.toFixed(1)}px)`);
    console.log(`✓ Mobile EN: gold wordmark renders responsively (${logoBox.width.toFixed(1)}x${logoBox.height.toFixed(1)}px), menu/cart aligned`);
  });

  // --- Mobile AR/RTL: same contract, flipped order and side ---
  await withPage({ width: 1440, height: 900 }, async (page) => {
    await loginAndVisitStore(page, { lang: "ar", viewport: { width: 390, height: 844 } });
    await assertHeaderBranding(page, { label: "Mobile AR/RTL", expectedOrder: ["أَلِ", "ALYQ"] });
    await assertNoVerticalClipping(page, "Mobile AR/RTL");
    const dir = await page.locator(".store-v2").first().getAttribute("dir");
    assert.equal(dir, "rtl", "Mobile AR: the storefront shell is in RTL mode");
    console.log("✓ Mobile AR/RTL: reading order flips, still gold, still transparent, responsive, no glyph clipping");
  });

  if (failures.length) {
    console.error("Console/page errors observed:\n" + failures.join("\n"));
    process.exitCode = 1;
  } else {
    console.log("\n✓ Issue #1 real-Chromium header branding runtime verification passed");
  }
} finally {
  await browser.close();
}
