#!/usr/bin/env node
/** Phase 4A canonical storefront and former-preview compatibility. The shipped
 * app bundle is exercised directly, never the test-only legacy projection. */
import { createUxHarness } from "./lib/ux-harness.mjs";

const ux = await createUxHarness({ beforeImport: ({ localStorage }) => localStorage.setItem("alyq.lang", "en") });
const { assert, dom, navigate, waitFor, readJson, clickEl, signInAs, testid } = ux;
const { document } = dom.window;
const robots = () => document.querySelector('meta[name="robots"]')?.content;
const canonical = () => document.querySelector('link[rel="canonical"]')?.getAttribute("href") ?? "";
let passed = 0;
function check(name, result) { assert.ok(result, name); console.log(`  ✓ ${++passed}. ${name}`); }
const go = async (hash, id) => {
  await navigate(hash, 320);
  await waitFor(() => testid(id), { label: `${hash} renders ${id}` });
};

await go("#/store", "v2-home");
await waitFor(() => testid("v2-card-prd-1001"), { label: "the published home product" });
check("public canonical home uses one V2 shell and never mounts the old layout",
  Boolean(testid("store-v2")) && !testid("store-layout") && dom.window.location.hash === "#/store");
check("home has indexable metadata, a canonical public URL and real Store JSON-LD",
  robots() === "index, follow" && canonical().endsWith("#/store") &&
  document.querySelector('#alyq-store-jsonld')?.textContent.includes('"@type":"Store"'));
check("normal public header, merchandising and footer links are canonical",
  [...testid("store-v2").querySelectorAll('a[href^="#/store"]')].length >= 7 &&
  !testid("store-v2").querySelector('a[href^="#/store/v2"]'));

await go("#/store/products?q=Ring&sort=price_asc", "v2-catalog");
check("canonical search and sort survive deep linking inside a single catalogue",
  Boolean(document.querySelector('#v2-search-input')?.value === "Ring") &&
  dom.window.location.hash.includes("sort=price_asc") && robots() === "index, follow" &&
  canonical().endsWith("#/store/products"));
await go("#/store/products/prd-1001", "v2-product");
const slug = readJson("alyq.demo.product_contents.v1")?.find((item) => item.product_id === "prd-1001")?.slug?.trim();
check("canonical PDP resolves a product ID and declares the published slug or ID, not the preview path",
  robots() === "index, follow" && canonical().endsWith(`#/store/products/${slug || "prd-1001"}`));
check("public PDP metadata describes the actual catalogue product",
  Boolean(document.title.trim()) && document.querySelector('meta[property="og:type"]')?.content === "product" &&
  document.querySelector('#alyq-store-jsonld')?.textContent.includes('"@type":"Product"'));

for (const [path, id, visibility] of [
  ["cart", "v2-cart", "noindex, nofollow"], ["checkout", "v2-checkout", "noindex, nofollow"],
  ["confirmation", "v2-confirmation", "noindex, nofollow"], ["track", "v2-track", "noindex, nofollow"],
  ["account", "v2-account", "noindex, nofollow"], ["about", "v2-about", "index, follow"],
  ["contact", "v2-contact", "index, follow"],
]) {
  await go(`#/store/${path}`, id);
  await waitFor(() => robots() === visibility, { label: `${path} metadata ${visibility}` });
  check(`${path} uses the canonical V2 page with appropriate public/private indexing`,
    Boolean(testid("store-v2")) && dom.window.location.hash === `#/store/${path}` && robots() === visibility);
}
check("About and Contact never canonicalize to the old preview URLs",
  canonical().endsWith("#/store/contact") && !canonical().includes("/store/v2"));

await go("#/store/v2", "v2-home");
check("old preview home replaces its URL with the public canonical home",
  dom.window.location.hash === "#/store" && robots() === "index, follow");
await go("#/store/v2/products/prd-1001", "v2-product");
check("old product ID bookmark redirects without changing the product",
  dom.window.location.hash === "#/store/products/prd-1001" && Boolean(testid("v2-product")));
if (slug) {
  await go(`#/store/v2/products/${slug}`, "v2-product");
  check("old published slug bookmark keeps the exact slug and product",
    dom.window.location.hash === `#/store/products/${slug}` && Boolean(testid("v2-product")));
}
const oldFilters = "?q=Ring&sort=price_asc&color=gold&size_label=XS";
await go(`#/store/v2/products${oldFilters}`, "v2-catalog");
check("preview catalogue redirect preserves safe search, sorting, colour and letter-size state",
  dom.window.location.hash === `#/store/products${oldFilters}` &&
  document.querySelector('#v2-search-input')?.value === "Ring" && robots() === "index, follow");
await go("#/store/v2/track?number=WEB-000001&phone=01012345678&token=secret", "v2-track");
check("old tracking link preserves only its shareable reference and strips sensitive extras",
  dom.window.location.hash === "#/store/track?number=WEB-000001" &&
  document.querySelector('.v2-track-form input')?.value === "WEB-000001" &&
  document.querySelector('.v2-track-form input[type="tel"]')?.value === "" &&
  !testid("v2-tracked-order") && robots() === "noindex, nofollow");
clickEl(testid("v2-track-submit"));
await waitFor(() => document.querySelector('.v2-track-form [role="alert"]'),
  { label: "phone-required tracking error" });
check("tracking requires a phone even when the reference came from an old link",
  !testid("v2-tracked-order") && Boolean(document.querySelector('.v2-track-form [role="alert"]')));
await go("#/store/v2/account?tab=orders&token=secret", "v2-account");
check("old account tab query survives redirect without exposing private history",
  dom.window.location.hash === "#/store/account?tab=orders" && robots() === "noindex, nofollow");
await go("#/store/v2/does-not-exist?phone=01012345678", "v2-home");
check("unknown preview URLs fail closed to public home, not a legacy/debug route",
  dom.window.location.hash === "#/store");
await go("#/store/does-not-exist", "v2-home");
check("unknown canonical store paths safely return home", dom.window.location.hash === "#/store");
await go("#/store/products/unknown-item", "store-v2");
check("missing product stays inside V2, shows a noindex not-found state and no order info",
  !testid("v2-product") && Boolean(document.querySelector('.v2-not-found h1')) &&
  robots() === "noindex, nofollow" && !testid("v2-order-details"));

await navigate("#/login", 320);
await signInAs("admin");
await go("#/online/website?tab=v2", "v2-studio");
check("Admin opens saved design at the canonical public URL, not a draft or preview route",
  testid("v2-preview-open-saved")?.getAttribute("href") === "#/store" &&
  testid("v2-draft-preview")?.querySelectorAll(".v2-footer-social a").length === 0);
await go("#/pos", "pos-scan-search");
check("POS has no V2 shell or residual public canonical metadata",
  !testid("store-v2") && !document.querySelector('link[rel="canonical"]') &&
  !document.querySelector('#alyq-store-jsonld') && !document.querySelector('meta[name="robots"]'));

console.log(`\n${passed} canonical cutover/compatibility DOM checks passed.`);
ux.finish("Phase 4A public cutover, metadata, safe preview redirects, Admin link and POS isolation");
