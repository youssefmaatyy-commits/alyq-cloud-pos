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
  const contexts = browser.contexts();
  const pages = contexts.flatMap((context) => context.pages());
  let page = pages.find((candidate) => candidate.url().startsWith("file:"));
  assert.ok(page, "the installed app did not open its packaged file:// renderer");
  await page.waitForFunction(() => Boolean(window.alyqDesktop?.getContext && window.alyqDesktop?.getConfig), null, { timeout: 20_000 });
  const url = new URL(page.url());
  assert.equal(url.hash, "#/login", "installed app must start on the employee login route");
  const context = await page.evaluate(() => window.alyqDesktop.getContext());
  assert.equal(context?.runtime, "electron", "renderer must be running inside Electron");
  assert.equal(context?.packaged, true, "app must be the installed/packaged executable");
  assert.equal(context?.version, expectedVersion, "installed executable version did not match");
  const body = (await page.locator("body").innerText()).toLocaleLowerCase();
  assert.ok(/sign in|تسجيل الدخول|دخول/.test(body), "the first installed screen must be the real employee login UI");
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
} finally {
  await browser.close();
}
