#!/usr/bin/env node
/**
 * Windows-runner smoke check for an already-installed ALYQ Electron build.
 * Connects to that process over loopback-only Chromium DevTools Protocol; it
 * never signs in, creates an order, or accesses a Supabase write path.
 */
import assert from "node:assert/strict";
import { chromium } from "@playwright/test";

const args = new Map(process.argv.slice(2).map((arg) => {
  const [key, ...value] = arg.replace(/^--/, "").split("=");
  return [key, value.join("=")];
}));
const port = Number(args.get("port"));
const expectedVersion = args.get("version");
assert.ok(Number.isInteger(port) && port > 0, "provide --port=<local-debug-port>");
assert.ok(expectedVersion, "provide --version=<expected-app-version>");

const deadline = Date.now() + 45_000;
let browser;
let lastError;
while (!browser && Date.now() < deadline) {
  try {
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 2_000 });
  } catch (error) {
    lastError = error;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}
assert.ok(browser, `could not connect to the installed desktop app on loopback port ${port}: ${lastError}`);
try {
  let page;
  let observedUrls = [];
  const pageDeadline = Date.now() + 30_000;
  while (!page && Date.now() < pageDeadline) {
    const pages = browser.contexts().flatMap((context) => context.pages());
    observedUrls = pages.map((candidate) => candidate.url());
    page = pages.find((candidate) => candidate.url().startsWith("file:"));
    if (!page) await new Promise((resolve) => setTimeout(resolve, 300));
  }
  assert.ok(page, `the installed app did not open a packaged file:// renderer; observed pages: ${observedUrls.join(", ") || "none"}`);
  const allowMissingApi = args.has("allow-missing-desktop-api");
  await page.waitForFunction(() => document.readyState === "complete" && Boolean(document.body?.innerText?.trim()), null, { timeout: 20_000 });
  const url = new URL(page.url());
  const legacyBaseline = allowMissingApi && expectedVersion === "6.0.0";
  if (legacyBaseline) {
    assert.ok(url.hash === "" || url.hash === "#/login", "6.0.0 baseline may have no hash, but must not open a different route");
  } else {
    assert.equal(url.hash, "#/login", "installed app must start on the employee login route");
  }
  const body = (await page.locator("body").innerText()).toLocaleLowerCase();
  assert.ok(/sign in|تسجيل الدخول|دخول/.test(body), "the first installed screen must be the real employee login UI");
  let desktopApiReady = await page.evaluate(() => Boolean(window.alyqDesktop?.getContext && window.alyqDesktop?.getConfig));
  if (!desktopApiReady) {
    try {
      await page.waitForFunction(() => Boolean(window.alyqDesktop?.getContext && window.alyqDesktop?.getConfig), null, {
        timeout: allowMissingApi ? 5_000 : 20_000,
      });
      desktopApiReady = true;
    } catch (error) {
      if (!allowMissingApi) {
        const title = await page.title();
        throw new Error(`packaged desktop preload API was not exposed (title=${JSON.stringify(title)}, login UI is visible): ${error.message}`, { cause: error });
      }
    }
  }
  if (!desktopApiReady) {
    console.log(`Installed legacy-app smoke passed: version=${expectedVersion}, route=${url.hash}, packaged login UI visible; this archived build exposes no desktop preload API.`);
  } else {
    const context = await page.evaluate(() => window.alyqDesktop.getContext());
    assert.equal(context?.runtime, "electron", "renderer must be running inside Electron");
    assert.equal(context?.packaged, true, "app must be the installed/packaged executable");
    assert.equal(context?.version, expectedVersion, "installed executable version did not match");
    let config = await page.evaluate(() => window.alyqDesktop.getConfig());
    assert.ok(/^[0-9a-f-]{36}$/i.test(config?.installationId ?? ""), "desktop userData config must initialize a valid installation identity");
    assert.equal(config.installationId, context.installationId, "app context and userData must expose the same installation identity");
    assert.ok(config?.hardware && Number.isFinite(config.hardware.paperWidthMm), "desktop hardware defaults must load from userData");
    if (args.has("seed-paper-width")) {
      const paperWidthMm = Number(args.get("seed-paper-width"));
      assert.ok([58, 80].includes(paperWidthMm), "seeded paper width must be a supported hardware setting");
      const hardware = { ...config.hardware, paperWidthMm };
      await page.evaluate((value) => window.alyqDesktop.saveHardwareConfig(value), hardware);
      config = await page.evaluate(() => window.alyqDesktop.getConfig());
      assert.equal(config.hardware.paperWidthMm, paperWidthMm, "isolated custom printer setting must persist before upgrade");
    }
    if (args.has("expect-paper-width")) {
      assert.equal(config.hardware.paperWidthMm, Number(args.get("expect-paper-width")), "custom hardware setting did not survive installer upgrade");
    }
    console.log(`Installed-app smoke passed: version=${context.version}, route=${url.hash}, packaged=${context.packaged}, paperWidthMm=${config.hardware.paperWidthMm}`);
  }
} finally {
  await browser.close();
}
