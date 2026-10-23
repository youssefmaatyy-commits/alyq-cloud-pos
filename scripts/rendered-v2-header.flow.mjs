#!/usr/bin/env node
/** Real-Chromium check for the original transparent ALYQ header master mark. */
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "@playwright/test";

const base = process.env.V2_VISUAL_BASE_URL || "http://127.0.0.1:4173";
const logoPath = "/brand/alyq-logo-transparent.png";
const screenshotDir = process.env.V2_LOGO_SCREENSHOT_DIR;
if (screenshotDir) await mkdir(screenshotDir, { recursive: true });
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_EXECUTABLE || undefined,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const failures = [];

async function withPage(viewport, run) {
  const context = await browser.newContext({ viewport, locale: "en-US" });
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  page.on("pageerror", (error) => failures.push(`pageerror: ${error.message}`));
  page.on("requestfailed", (request) => {
    const url = new URL(request.url());
    const failure = request.failure()?.errorText ?? "unknown";
    if (url.hostname !== "images.unsplash.com" && failure !== "net::ERR_ABORTED") {
      failures.push(`requestfailed: ${request.url()} (${failure})`);
    }
  });
  page.on("console", (msg) => {
    if (msg.type() === "error" && !msg.text().startsWith("Failed to load resource:")) failures.push(`console: ${msg.text()}`);
  });
  try { await run(page); } finally { await context.close(); }
}

async function visitStore(page, lang, viewport) {
  await page.goto(`${base}/#/store`, { timeout: 120_000 });
  await page.getByTestId("v2-home").waitFor();
  await page.evaluate((value) => localStorage.setItem("alyq.lang", value), lang);
  await page.setViewportSize(viewport);
  await page.reload();
  await page.getByTestId("v2-home").waitFor();
}

async function assertTransparentGoldMaster(page, label, expectedHeight) {
  const logo = page.locator(".v2-logo").first();
  const image = logo.locator("img");
  await image.waitFor();
  assert.equal(await image.count(), 1, `${label}: one original ALYQ master mark is visible`);
  await page.waitForFunction((path) => {
    const image = document.querySelector(".v2-logo img");
    return image?.complete && image.naturalWidth > 0 && image.getAttribute("src")?.includes(path);
  }, logoPath);
  const style = await image.evaluate((el) => ({
    src: el.currentSrc,
    width: el.naturalWidth,
    height: el.naturalHeight,
    rendered: (() => { const r = el.getBoundingClientRect(); return { width: r.width, height: r.height }; })(),
    fit: getComputedStyle(el).objectFit,
    logoBackground: getComputedStyle(el.parentElement).backgroundColor,
    pixels: (() => {
      const canvas = document.createElement("canvas");
      canvas.width = el.naturalWidth;
      canvas.height = el.naturalHeight;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) return null;
      ctx.drawImage(el, 0, 0);
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      const corners = [[0, 0], [canvas.width - 1, 0], [0, canvas.height - 1], [canvas.width - 1, canvas.height - 1]]
        .map(([x, y]) => data[(y * canvas.width + x) * 4 + 3]);
      let gold = null;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] > 220 && data[i] > data[i + 1] && data[i + 1] > data[i + 2]) {
          gold = [data[i], data[i + 1], data[i + 2]];
          break;
        }
      }
      return { corners, gold };
    })(),
  }));
  assert.ok(style.src.endsWith(logoPath), `${label}: the official transparent ALYQ image is used`);
  assert.equal(style.fit, "contain", `${label}: the mark is not cropped or distorted`);
  assert.ok(style.pixels, `${label}: the logo PNG can be sampled without a cross-origin taint`);
  assert.deepEqual(style.pixels.corners, [0, 0, 0, 0], `${label}: canvas corners are transparent, not a pale rectangle`);
  assert.ok(style.pixels.gold && style.pixels.gold[0] > style.pixels.gold[1]
    && style.pixels.gold[1] > style.pixels.gold[2], `${label}: the original gold artwork is retained`);
  assert.equal(style.logoBackground, "rgba(0, 0, 0, 0)", `${label}: the image holder stays transparent`);
  assert.ok(Math.abs(style.rendered.height - expectedHeight) <= 1,
    `${label}: expected ${expectedHeight}px responsive mark height, got ${style.rendered.height}px`);
  const aspect = style.width / style.height;
  assert.ok(Math.abs(aspect - 767 / 338) < 0.02, `${label}: original artwork proportions remain intact (${aspect})`);
  return { logo, image, style };
}

try {
  for (const [label, lang, viewport, height] of [
    ["Desktop EN", "en", { width: 1440, height: 900 }, 72],
    ["Desktop AR/RTL", "ar", { width: 1440, height: 900 }, 72],
    ["Mobile EN", "en", { width: 390, height: 844 }, 56],
    ["Mobile AR/RTL", "ar", { width: 390, height: 844 }, 56],
  ]) {
    await withPage({ width: 1440, height: 900 }, async (page) => {
      await visitStore(page, lang, viewport);
      const { logo, style } = await assertTransparentGoldMaster(page, label, height);
      const logoBox = await logo.boundingBox();
      const headerBox = await page.locator(".v2-header-inner").first().boundingBox();
      assert.ok(Math.abs((logoBox.x + logoBox.width / 2) - (headerBox.x + headerBox.width / 2)) < 4,
        `${label}: the logo remains horizontally centred`);
      if (viewport.width < 768) {
        const start = await page.locator(".v2-header-start").boundingBox();
        const end = await page.locator(".v2-header-end").boundingBox();
        for (const [name, group] of [["menu/search", start], ["account/cart", end]]) {
          const separated = group.x + group.width <= logoBox.x + 1 || group.x >= logoBox.x + logoBox.width - 1;
          assert.ok(separated, `${label}: ${name} do not overlap the centered mark`);
        }
        assert.ok(logoBox.width < viewport.width * 0.48, `${label}: mark fits within the mobile header track`);
      } else {
        const cart = await page.locator(".v2-bag-button").first().boundingBox();
        assert.ok(cart.x + cart.width <= logoBox.x + 1 || cart.x >= logoBox.x + logoBox.width - 1,
          `${label}: cart does not overlap the mark`);
        assert.ok(await page.locator(".v2-desktop-nav a").count() > 0, `${label}: desktop navigation remains visible`);
      }
      const headerHeight = await page.locator(".v2-header-inner").first().evaluate((el) => el.getBoundingClientRect().height);
      assert.ok(headerHeight <= (viewport.width < 768 ? 82 : 98), `${label}: header height remains controlled (${headerHeight}px)`);
      const expectedDir = lang === "ar" ? "rtl" : "ltr";
      assert.equal(await page.locator(".store-v2").first().getAttribute("dir"), expectedDir,
        `${label}: language direction remains correct`);
      if (screenshotDir) {
        const device = viewport.width < 768 ? "mobile" : "desktop";
        const screenshotHeight = viewport.width < 768 ? 112 : 170;
        await page.screenshot({
          path: `${screenshotDir}/after-${device}-${lang}.png`,
          clip: { x: 0, y: 0, width: viewport.width, height: screenshotHeight },
          animations: "disabled",
        });
      }
      console.log(`✓ ${label}: transparent gold master ${style.rendered.width.toFixed(1)}×${style.rendered.height.toFixed(1)}px, centered, no overlap`);
    });
  }
  assert.deepEqual(failures, [], `browser errors: ${failures.join("; ")}`);
  console.log("\n✓ ALYQ logo desktop/mobile EN/AR Chromium checks passed");
} finally {
  await browser.close();
}
