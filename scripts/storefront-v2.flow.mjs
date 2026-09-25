#!/usr/bin/env node
/** V2 Phase 1 E2E in the real app bundle, with an isolated demo catalogue.
 * jsdom proves routing/data/cart/RTL semantics, NOT rendered CSS geometry.
 * The companion rendered-v2.flow.mjs runs that geometry in real Chromium.
 * Run through: npm run test:e2e storefront-v2
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { transform } from "esbuild";
import { createUxHarness } from "./lib/ux-harness.mjs";

// The repo's own demo data is the fixture; add one exact-variant ring *in this
// test's localStorage only* to exercise a real UUID, numeric/letter sizes,
// a sold-out option and per-shelf override. Production merchandising is untouched.
const seedSource = await readFile(fileURLToPath(new URL("../src/modules/products/data/demoSeed.ts", import.meta.url)), "utf8");
const seedModule = await transform(seedSource, { loader: "ts", format: "esm" });
const { buildDemoProducts, buildDemoCategories } = await import(`data:text/javascript;base64,${Buffer.from(seedModule.code).toString("base64")}`);
const products = buildDemoProducts();
const categories = buildDemoCategories();
const ring = products.find((product) => product.sku === "ALYQ-1002");
ring.variants_enabled = true;
ring.stock_quantity = 5;
ring.low_stock_level = 1;
const UUID = {
  gold17: "4fb4125a-0f26-461e-8a94-31e365342101",
  gold18: "4fb4125a-0f26-461e-8a94-31e365342102",
  silverXS: "4fb4125a-0f26-461e-8a94-31e365342103",
  silverHalf: "4fb4125a-0f26-461e-8a94-31e365342104",
};
const variant = (id, color, size, sizeLabel, stock, override = null) => ({
  id, product_id: ring.id, sku: `V2-TEST-${color}-${sizeLabel || size}`,
  barcode: null, color_key: color, color_en: color === "gold" ? "Gold" : "Silver",
  color_ar: color === "gold" ? "ذهبي" : "فضي", color_hex: color === "gold" ? "#cba556" : "#c9c9c9",
  size, size_label: sizeLabel, image_url: null, price_override: override, cost_override: null,
  stock_quantity: stock, low_stock_level: 1, active: true, sort_order: 1,
  created_at: ring.created_at, updated_at: ring.updated_at,
});
const variants = [
  variant(UUID.gold17, "gold", 17, null, 2, 88),
  variant(UUID.gold18, "gold", 18, null, 0),
  variant(UUID.silverXS, "silver", null, "XS", 1),
  variant(UUID.silverHalf, "silver", 16.5, null, 2),
];

const ux = await createUxHarness({ beforeImport: ({ localStorage }) => {
  localStorage.setItem("alyq.lang", "en");
  localStorage.setItem("alyq.demo.catalog.v1", JSON.stringify({
    seed_revision: 3, categories, products, variants,
  }));
} });
const { dom, assert, waitFor, navigate, clickEl, clickTestid, setField, readJson, sleep, finish } = ux;
const { document } = dom.window;
const cart = () => readJson("alyq.store.cart.v2")?.lines ?? [];
let passed = 0;
function check(label, condition) { assert.ok(condition, label); console.log(`  ✓ ${++passed}. ${label}`); }

await navigate("#/store", 750);
await waitFor(() => Boolean(document.querySelector('[data-testid="v2-home"] #featured .v2-product-card')),
  { label: "V2 homepage, seeded catalogue and featured rail" });
check("V2 is public and inside the three existing shop providers", Boolean(document.querySelector('[data-testid="store-v2"]')));
check("configured hero image/CTA and category tiles render from the settings/catalogue",
  Boolean(document.querySelector('.v2-hero img[src]')) &&
  Boolean(document.querySelector('#categories a[href*="/store/products?category="]')) &&
  Boolean(document.querySelector('.v2-hero a[href^="#/store/products"]')));
check("the canonical public shop is indexable with its real URL, not the old preview URL",
  document.querySelector('meta[name="robots"]')?.content === "index, follow" &&
  document.querySelector('link[rel="canonical"]')?.href.endsWith("#/store"));
check("legacy store layout did not leak into the V2 header",
  document.querySelectorAll('header').length === 1 &&
  Boolean(document.querySelector('.v2-header a[href="#/store"]')));
const routeBeforeSkip = dom.window.location.hash;
clickEl(document.querySelector('.v2-skip'));
check("keyboard skip targets main content without changing the HashRouter route",
  dom.window.location.hash === routeBeforeSkip && document.activeElement?.id === "v2-main");

await navigate("#/store/products", 500);
await waitFor(() => Boolean(document.querySelector(`[data-testid="v2-card-${ring.id}"]`)), { label: "V2 ring tile" });
const ringCard = () => document.querySelector(`[data-testid="v2-card-${ring.id}"]`);
check("a card shows its live image/price and explicit options", Boolean(ringCard()?.querySelector('.v2-card-price')) &&
  (ringCard()?.querySelector('button.v2-card-add')?.textContent ?? "").includes("Choose options"));
check("card swatches derive from the published color groups", ringCard().querySelectorAll('.v2-card-swatches button').length === 2);
clickEl(ringCard().querySelector('.v2-card-swatches button[aria-label*="Gold"]'));
await sleep(40);
check("card swatch marks the color without adding a line", ringCard().querySelector('.v2-card-swatches button[aria-pressed="true"]') && cart().length === 0);
clickTestid(`v2-quick-add-${ring.id}`);
await waitFor(() => Boolean(ringCard()?.querySelector('[data-testid="v2-card-options"]')), { label: "the card's variant chooser" });
check("a variant product is never added without a choice", cart().length === 0);
const gold = ringCard().querySelector('[data-testid="v2-color-gold"]');
clickEl(gold);
await sleep(80);
const goldSizes = ringCard().querySelector('[data-testid="v2-card-options"]');
check("Gold / 18 is visible, unavailable and disabled",
  goldSizes.querySelector('[data-testid="v2-size-18"]')?.disabled === true);
check("a sold-out combination is not silently replaced with Gold / 17",
  goldSizes.querySelector('.v2-solid-button')?.disabled === true);
clickEl(goldSizes.querySelector('[data-testid="v2-size-17"]'));
await sleep(50);
clickEl(ringCard().querySelector('.v2-card-options .v2-solid-button'));
await waitFor(() => cart().some((line) => line.variant_id === UUID.gold17), { label: "Gold / 17 line persisted" });
check("Quick Add preserves the exact variant UUID", cart()[0].variant_id === UUID.gold17);
check("the catalogue stock was not decremented by a cart action",
  readJson("alyq.demo.catalog.v1").variants.find((shelf) => shelf.id === UUID.gold17).stock_quantity === 2);

await navigate(`#/store/products/${ring.id}`, 500);
await waitFor(() => Boolean(document.querySelector('[data-testid="v2-product"]')), { label: "V2 PDP by id" });
const buy = () => document.querySelector('[data-testid="v2-pdp-add"]');
check("PDP requires a combination before it can add to the cart", buy()?.disabled === true);
clickEl(document.querySelector('[data-testid="v2-color-silver"]'));
await sleep(50);
check("PDP supports the letter XS and arbitrary 16.5 size from exact shelves",
  Boolean(document.querySelector('[data-testid="v2-size-XS"]')) &&
  Boolean(document.querySelector('[data-testid="v2-size-16.5"]')));
clickEl(document.querySelector('[data-testid="v2-size-XS"]'));
await sleep(60);
check("selected shelf enables the PDP add button", buy()?.disabled === false);
clickEl(buy());
await waitFor(() => cart().some((line) => line.variant_id === UUID.silverXS), { label: "Silver / XS persisted" });
check("Silver / XS remains a separate exact UUID; Gold / 17 is untouched",
  cart().length === 2 && cart().some((line) => line.variant_id === UUID.gold17));
clickEl(document.querySelector('[data-testid="v2-color-gold"]'));
await sleep(50);
check("changing color clears the previously selected size, without substitution", buy()?.disabled === true);
clickEl(document.querySelector('[data-testid="v2-size-17"]'));
await sleep(50);
check("variant override is reflected on the advisory PDP price",
  (document.querySelector('.v2-pdp-price')?.textContent ?? "").includes("88.00"));
clickEl(buy());
await waitFor(() => cart().find((line) => line.variant_id === UUID.gold17)?.quantity === 2,
  { label: "same exact shelf merges two units, max quantity 2" });
check("the two purchases of one shelf merge, never mixing Silver", cart().length === 2);

await navigate("#/store/products?q=classic", 450);
await waitFor(() => Boolean(document.querySelector('[data-testid="v2-catalog"]')), { label: "filtered V2 catalogue" });
check("query-string search filters product results", document.querySelectorAll('.v2-product-card').length === 1 &&
  Boolean(ringCard()));
await navigate("#/store/products?q=not-a-product-ever", 300);
check("empty search renders an intentional, translated state", Boolean(document.querySelector('[data-testid="v2-empty"]')));

await navigate("#/store", 300);
await waitFor(() => Boolean(document.querySelector('[data-testid="v2-home"]')) &&
  dom.window.location.hash === "#/store", { label: "canonical home route settled" });
clickTestid("v2-menu-open");
await waitFor(() => document.querySelector('.v2-drawer-layer')?.getAttribute('data-open') === 'true', { label: "drawer open" });
check("drawer is a real dialog and can close without navigating",
  document.querySelector('.v2-drawer')?.getAttribute('aria-modal') === 'true');
clickTestid("v2-menu-close");
await sleep(50);
check("closed drawer is inert", document.querySelector('.v2-drawer-layer')?.hasAttribute('inert') === true);
clickTestid("v2-menu-open");
const language = document.querySelector('.v2-drawer-foot button');
clickEl(language);
await waitFor(() => document.documentElement.dir === 'rtl', { label: "Arabic RTL" });
check("AR translations + RTL scope appear on the same public route",
  document.querySelector('.store-v2')?.getAttribute('dir') === 'rtl' &&
  (document.querySelector('.v2-desktop-nav')?.textContent ?? '').includes('الرئيسية'));
await navigate(`#/store/products/${ring.id}`, 320);
check("variant color names switch to Arabic without changing shelf IDs",
  Boolean(document.querySelector('[data-testid="v2-color-gold"]')?.textContent?.includes('ذهبي')));
await navigate("#/store/cart", 450);
await waitFor(() => Boolean(document.querySelector('[data-testid="v2-cart"]')), { label: "canonical V2 bag" });
check("canonical V2 bag reuses the existing exact-variant cart provider",
  Boolean(document.querySelector('[data-testid="store-v2"]')) &&
  cart().some((line) => line.variant_id === UUID.silverXS));
await navigate("#/store/products", 450);
check("existing /store/products deep links now render the V2 catalogue",
  Boolean(document.querySelector('[data-testid="store-v2"]')) &&
  Boolean(document.querySelector('[data-testid="v2-catalog"]')));

console.log(`\n${passed} V2 DOM end-to-end checks passed (CSS geometry is tested separately in Chromium).`);
finish("Storefront V2 public presentation + exact cart handoff");
