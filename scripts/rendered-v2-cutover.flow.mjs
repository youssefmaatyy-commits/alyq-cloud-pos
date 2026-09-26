#!/usr/bin/env node
/** Phase 4A: the shipped static build in real Chromium, exercising historical
 * hash bookmarks, canonical reloads, metadata, keyboard escape and Admin/POS.
 * Run with CHROMIUM_EXECUTABLE and V2_VISUAL_BASE_URL against a local Vite
 * preview; no remote backend or production deployment is involved. */
import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import { assertRenderedArabicFont } from "./lib/rendered-arabic-font.mjs";

const base = process.env.V2_VISUAL_BASE_URL || "http://127.0.0.1:4173";
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE || undefined,
  args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, locale: "en-US" });
page.setDefaultTimeout(30_000);
const failures = [];
page.on("pageerror", (error) => failures.push(`pageerror: ${error.message}`));
page.on("console", (message) => { if (message.type() === "error") failures.push(`console: ${message.text()}`); });
page.on("response", (response) => {
  if (response.status() >= 400 && response.url().startsWith(base)) failures.push(`${response.status()} ${response.url()}`);
});
const go = async (hash, id) => {
  await page.goto(`${base}/${hash}`, { timeout: 120_000 });
  await page.getByTestId(id).waitFor({ timeout: 60_000 });
};
const head = () => page.evaluate(() => ({ title: document.title,
  robots: document.querySelector('meta[name="robots"]')?.content,
  canonical: document.querySelector('link[rel="canonical"]')?.getAttribute("href") ?? "",
}));
let passed = 0;
function check(label) { console.log(`✓ ${++passed}. ${label}`); }

try {
  await go("#/store/v2", "v2-home");
  assert.equal(new URL(page.url()).hash, "#/store");
  assert.equal((await head()).robots, "index, follow");
  assert.ok((await head()).canonical.endsWith("#/store"));
  assert.equal(await page.locator('.store-v2 a[href^="#/store/v2"]').count(), 0);
  check("old preview home replaces the hash; normal public links and indexable head are canonical");

  const filters = "?q=Ring&sort=price_asc&color=gold&size_label=XS";
  await go(`#/store/v2/products${filters}`, "v2-catalog");
  assert.equal(new URL(page.url()).hash, `#/store/products${filters}`);
  await page.reload();
  await page.getByTestId("v2-catalog").waitFor();
  assert.equal(await page.locator("#v2-search-input").inputValue(), "Ring");
  assert.equal(new URL(page.url()).hash, `#/store/products${filters}`);
  assert.equal((await head()).robots, "index, follow");
  check("search, sort, colour and letter-size state survive a real redirect and reload");

  const slug = await page.evaluate(() => JSON.parse(localStorage.getItem("alyq.demo.product_contents.v1"))
    .find((item) => item.product_id === "prd-1001")?.slug?.trim());
  assert.ok(slug, "the published demo product has a shareable slug");
  for (const key of ["prd-1001", slug]) {
    await go(`#/store/v2/products/${key}`, "v2-product");
    assert.equal(new URL(page.url()).hash, `#/store/products/${key}`);
    assert.ok((await head()).canonical.endsWith(`#/store/products/${slug}`));
    assert.equal((await head()).robots, "index, follow");
    assert.equal(await page.getByTestId("store-v2").count(), 1);
  }
  await page.reload();
  await page.getByTestId("v2-product").waitFor();
  assert.equal(new URL(page.url()).hash, `#/store/products/${slug}`);
  check("old ID and slug PDP links preserve identity, metadata and canonical refresh");

  await page.goBack({ waitUntil: "domcontentloaded" });
  assert.ok(new URL(page.url()).hash.startsWith("#/store/products/"));
  assert.ok(!new URL(page.url()).hash.startsWith("#/store/v2/"), "back never re-enters a redirect loop");
  check("back navigation returns to a canonical route, not a preview redirect loop");

  await go("#/store/v2/track?number=WEB-000001&phone=01012345678&token=secret", "v2-track");
  assert.equal(new URL(page.url()).hash, "#/store/track?number=WEB-000001");
  assert.equal(await page.locator(".v2-track-form input").first().inputValue(), "WEB-000001");
  assert.equal(await page.getByTestId("v2-tracked-order").count(), 0);
  assert.equal((await head()).robots, "noindex, nofollow");
  await page.getByTestId("v2-track-submit").click();
  await page.locator('.v2-track-form [role="alert"]').waitFor();
  await page.reload();
  assert.equal(await page.locator(".v2-track-form input").first().inputValue(), "WEB-000001");
  assert.equal(await page.locator('.v2-track-form input[type="tel"]').inputValue(), "");
  check("private tracking keeps only the reference and still requires a phone after reload");

  await go("#/store/v2/account?tab=orders&token=secret", "v2-account");
  assert.equal(new URL(page.url()).hash, "#/store/account?tab=orders");
  assert.equal((await head()).robots, "noindex, nofollow");
  await go("#/store/v2/about", "v2-about");
  assert.equal(new URL(page.url()).hash, "#/store/about");
  assert.ok((await head()).canonical.endsWith("#/store/about"));
  await go("#/store/v2/contact", "v2-contact");
  assert.equal(new URL(page.url()).hash, "#/store/contact");
  assert.ok((await head()).canonical.endsWith("#/store/contact"));
  check("account tab, About and Contact bookmarks redirect with correct private/public heads");

  await go("#/store/v2/unknown?phone=01012345678", "v2-home");
  assert.equal(new URL(page.url()).hash, "#/store");
  await go("#/store/unknown", "v2-home");
  assert.equal(new URL(page.url()).hash, "#/store");
  await go("#/store/products/unpublished", "store-v2");
  await page.locator(".v2-not-found").waitFor();
  assert.equal((await head()).robots, "noindex, nofollow");
  await page.reload();
  await page.locator(".v2-not-found").waitFor();
  assert.equal((await head()).robots, "noindex, nofollow");
  await go("#/store/confirmation", "v2-confirmation");
  await page.getByTestId("v2-receipt-private").waitFor();
  assert.equal(await page.getByTestId("v2-order-number").count(), 0);
  check("unknown routes fail closed, missing product is noindex and receipt never leaks on refresh");

  // A browser-local merchant setting enables InstaPay. The order still goes
  // through the existing demo repository and proof never changes it to paid.
  await go("#/store", "v2-home");
  await page.evaluate(() => {
    const key = "alyq.demo.website_settings.v1";
    const row = JSON.parse(localStorage.getItem(key));
    row.settings.delivery.instapay_enabled = true;
    row.settings.delivery.instapay_proof_required = true;
    row.settings.social.instapay_account = "01000000000";
    localStorage.setItem(key, JSON.stringify(row));
  });
  await page.reload();
  await go("#/store/products/prd-1001", "v2-product");
  await page.getByTestId("v2-pdp-add").click();
  await page.getByTestId("v2-pdp-add").waitFor();
  await go("#/store/cart", "v2-cart");
  await page.getByTestId("v2-cart-line").waitFor();
  await go("#/store/checkout", "v2-checkout");
  await page.locator('.v2-checkout-form input[autocomplete="name"]').fill("Phase Four Shopper");
  await page.locator('.v2-checkout-form input[autocomplete="tel"]').fill("01012345678");
  await page.locator(".v2-choice-grid").first().getByRole("button", { name: "Pickup", exact: true }).click();
  await page.locator(".v2-choice-grid").nth(1).getByRole("button", { name: "InstaPay", exact: true }).click();
  assert.ok((await page.getByTestId("v2-checkout").innerText()).includes("employee confirms the payment"));
  await page.getByTestId("v2-place-order").click();
  await page.getByTestId("v2-order-number").waitFor();
  await page.getByTestId("v2-payment-proof").waitFor();
  const snapshot = () => page.evaluate(() => JSON.parse(localStorage.getItem("alyq.demo.online_orders.v1"))?.at(-1));
  assert.equal((await snapshot()).payment_method, "instapay");
  assert.equal((await snapshot()).payment_status, "verification_required");
  assert.equal(new URL(page.url()).hash, "#/store/confirmation");
  await page.getByTestId("v2-payment-proof").locator('input[autocomplete="off"]').fill("P4A-BROWSER-PROOF");
  await page.getByTestId("v2-payment-proof").locator('input[type="file"]').setInputFiles({
    name: "transfer.png", mimeType: "image/png",
    buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/owAAAABJRU5ErkJggg==", "base64"),
  });
  await page.getByTestId("v2-payment-proof").getByRole("button", { name: "Send the proof" }).click();
  await page.waitForFunction(() => Boolean(JSON.parse(localStorage.getItem("alyq.demo.online_orders.v1"))?.at(-1)?.payment_submitted_at));
  assert.equal((await snapshot()).payment_reference, "P4A-BROWSER-PROOF");
  assert.equal((await snapshot()).payment_status, "verification_required");
  assert.ok((await snapshot()).payment_proof_url, "proof is saved without an automatic paid claim");
  check("canonical InstaPay placement and proof upload stay awaiting employee verification in Chromium");

  await go("#/store", "v2-home");
  await page.evaluate(() => localStorage.setItem("alyq.lang", "ar"));
  await page.reload();
  await page.getByTestId("v2-home").waitFor();
  await assertRenderedArabicFont(page);
  assert.equal(await page.getByTestId("store-v2").getAttribute("dir"), "rtl");
  assert.equal((await head()).robots, "index, follow");
  const beforeSkip = new URL(page.url()).hash;
  await page.locator(".v2-skip").focus();
  await page.keyboard.press("Enter");
  assert.equal(await page.evaluate(() => document.activeElement?.id), "v2-main");
  assert.equal(new URL(page.url()).hash, beforeSkip, "skip never mutates the hash route");
  await page.setViewportSize({ width: 320, height: 780 });
  await page.getByTestId("v2-menu-open").click();
  await page.getByTestId("v2-menu-close").waitFor();
  await page.keyboard.press("Escape");
  assert.equal(await page.getByTestId("v2-menu-open").getAttribute("aria-expanded"), "false");
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  check("Arabic RTL skip/focus and mobile drawer Escape work without hash drift or phone overflow");

  await page.evaluate(() => localStorage.setItem("alyq.lang", "en"));
  await page.reload();
  await go("#/login", "login-brand-name");
  await page.locator('input[autocomplete="username"]').fill("admin");
  await page.locator('input[type="password"]').fill("alyq1234");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByTestId("shell-brand").waitFor({ state: "attached" });
  await go("#/online/website?tab=v2", "v2-studio");
  assert.equal(await page.getByTestId("v2-preview-open-saved").getAttribute("href"), "#/store");
  await go("#/pos", "pos-scan-search");
  assert.equal(await page.getByTestId("store-v2").count(), 0);
  assert.equal((await head()).canonical, "");
  assert.equal((await head()).robots, undefined);
  assert.deepEqual(failures, [], "no browser console errors, page errors or same-origin 4xx/5xx");
  check("Admin design link targets the canonical site; POS has no V2 shell or public metadata");

  console.log(`\n✓ ${passed}/${passed} real-Chromium cutover route/metadata/accessibility groups passed.`);
} finally {
  await browser.close();
}
