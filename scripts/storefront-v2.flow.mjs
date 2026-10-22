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
import { stagingBr101Snapshot } from "./staging-br101.snapshot.mjs";

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
categories.push(...stagingBr101Snapshot.categories);
const modelProductId = stagingBr101Snapshot.product.id;
const modelProduct = { ...products[0], ...stagingBr101Snapshot.product };
products.push(modelProduct);
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
// Snapshot holds only the three real Staging rows. M03's image is omitted in
// this isolated UI fixture only to exercise the missing-photo state; its ID,
// SKU, name, stock, and price remain the exact Staging values. No extra models
// or image assets are synthesized.
const modelVariantIds = stagingBr101Snapshot.variants.map((model) => model.id);
const modelPhoto = (index) => stagingBr101Snapshot.variants[index]?.image_url ?? null;
const modelVariants = stagingBr101Snapshot.variants.map((model, index) => ({
  ...model,
  image_url: index === 2 ? null : model.image_url,
  images: index === 2 ? [] : model.images,
  cost_override: null,
  low_stock_level: 1,
  created_at: modelProduct.created_at,
  updated_at: modelProduct.updated_at,
}));
variants.push(...modelVariants);

const ux = await createUxHarness({ beforeImport: ({ localStorage }) => {
  localStorage.setItem("alyq.lang", "en");
  localStorage.setItem("alyq.demo.catalog.v1", JSON.stringify({
    seed_revision: 3, categories, products, variants,
  }));
} });
const { dom, assert, waitFor, navigate, clickEl, clickTestid, setField, readJson, sleep, finish } = ux;
const { document } = dom.window;
const cart = () => readJson("alyq.store.cart.v2")?.lines ?? [];
const orders = () => readJson("alyq.demo.online_orders.v1") ?? [];
const removedTaglines = ["the alyq edit", "مختارات أَلِــيْـــق"];
const hasRemovedTagline = () => removedTaglines.some((phrase) => (document.body.textContent ?? "").toLocaleLowerCase().includes(phrase.toLocaleLowerCase()));
let passed = 0;
function check(label, condition) { assert.ok(condition, label); console.log(`  ✓ ${++passed}. ${label}`); }

await navigate("#/store", 750);
await waitFor(() => Boolean(document.querySelector('[data-testid="v2-home"] #featured .v2-product-card')),
  { label: "V2 homepage, seeded catalogue and featured rail" });
check("V2 is public and inside the three existing shop providers", Boolean(document.querySelector('[data-testid="store-v2"]')));
check("the removed campaign tagline is absent from the English home and categories", !hasRemovedTagline());
check("configured hero image/CTA and typographic category tiles render without category photos",
  Boolean(document.querySelector('.v2-hero img[src]')) &&
  Boolean(document.querySelector('#categories a[href*="/store/products?category="]')) &&
  !document.querySelector('#categories .v2-category img') &&
  Boolean(document.querySelector('#categories .v2-category-ar[lang="ar"]')) &&
  Boolean(document.querySelector('#categories .v2-category-en[lang="en"]')) &&
  Boolean(document.querySelector('.v2-hero a[href^="#/store/products"]')));
check("archived categories are not exposed as shop links even when present in the fixture",
  ![...document.querySelectorAll('#categories a[href*="category="]')].some((link) => link.getAttribute("href").includes("cat-office")));
await waitFor(() => document.querySelector('meta[name="robots"]')?.content === "index, follow" &&
  Boolean(document.querySelector('link[rel="canonical"]')?.href), { label: "home page metadata" });
check("the canonical public shop is indexable with its real URL, not the old preview URL",
  document.querySelector('meta[name="robots"]')?.content === "index, follow" &&
  document.querySelector('link[rel="canonical"]')?.href.endsWith("#/store"));
check("legacy store layout did not leak into the V2 header",
  document.querySelectorAll('header').length === 1 &&
  Boolean(document.querySelector('.v2-header a[href="#/store"]')));
// Issue #6: the header is the shop's own bilingual name (ALYQ | أَلِــيْـــق by
// default), read from Website Settings' brand/contact fields — not a second
// hardcoded logo. English leads in the English UI; the Arabic name trails as
// a single accessible logo link, styled by the theme's own accent colour.
check("header shows the configured bilingual wordmark with English leading in the English UI",
  document.querySelector('.v2-logo .v2-wordmark-primary')?.textContent === "ALYQ" &&
  Boolean(document.querySelector('.v2-logo .v2-wordmark-secondary')?.textContent?.includes("ي")) &&
  document.querySelector('a.v2-logo')?.getAttribute("aria-label") === "ALYQ");
const routeBeforeSkip = dom.window.location.hash;
clickEl(document.querySelector('.v2-skip'));
check("keyboard skip targets main content without changing the HashRouter route",
  dom.window.location.hash === routeBeforeSkip && document.activeElement?.id === "v2-main");
const firstCategory = document.querySelector("#categories .v2-category");
const expectedCategoryRoute = firstCategory?.getAttribute("href") ?? "";
clickEl(firstCategory);
await waitFor(() => dom.window.location.hash === expectedCategoryRoute && Boolean(document.querySelector('[data-testid="v2-catalog"]')),
  { label: "category link opens its own filtered catalogue" });
check("category tile opens the exact category without changing its active state",
  new URLSearchParams(dom.window.location.hash.split("?")[1] ?? "").get("category") ===
    new URLSearchParams(expectedCategoryRoute.split("?")[1] ?? "").get("category") &&
  categories.find((category) => category.id === new URLSearchParams(expectedCategoryRoute.split("?")[1] ?? "").get("category"))?.active === true);

await navigate("#/store/products", 500);
await waitFor(() => Boolean(document.querySelector(`[data-testid="v2-card-${ring.id}"]`)), { label: "V2 ring tile" });
check("the removed campaign tagline is absent from the English product list", !hasRemovedTagline());
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
check("the removed campaign tagline is absent from the English product detail", !hasRemovedTagline());
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
check("the removed campaign tagline is absent from the Arabic home and categories", !hasRemovedTagline());
check("AR translations + RTL scope appear on the same public route",
  document.querySelector('.store-v2')?.getAttribute('dir') === 'rtl' &&
  (document.querySelector('.v2-desktop-nav')?.textContent ?? '').includes('الرئيسية'));
check("in Arabic RTL the header wordmark flips lead — Arabic name first, ALYQ trailing",
  document.querySelector('.v2-logo .v2-wordmark')?.getAttribute('dir') === 'rtl' &&
  Boolean(document.querySelector('.v2-logo .v2-wordmark-primary')?.textContent?.includes('ي')) &&
  document.querySelector('.v2-logo .v2-wordmark-secondary')?.textContent === 'ALYQ');
await navigate(`#/store/products/${ring.id}`, 320);
check("the removed campaign tagline is absent from the Arabic product detail", !hasRemovedTagline());
check("variant color names switch to Arabic without changing shelf IDs",
  Boolean(document.querySelector('[data-testid="v2-color-gold"]')?.textContent?.includes('ذهبي')));
await navigate("#/store/cart", 450);
await waitFor(() => Boolean(document.querySelector('[data-testid="v2-cart"]')), { label: "canonical V2 bag" });
check("the removed campaign tagline is absent from the Arabic cart", !hasRemovedTagline());
check("canonical V2 bag reuses the existing exact-variant cart provider",
  Boolean(document.querySelector('[data-testid="store-v2"]')) &&
  cart().some((line) => line.variant_id === UUID.silverXS));
await navigate("#/store/products", 450);
check("existing /store/products deep links now render the V2 catalogue",
  Boolean(document.querySelector('[data-testid="store-v2"]')) &&
  Boolean(document.querySelector('[data-testid="v2-catalog"]')));
await navigate("#/store/products", 350);
await waitFor(() => Boolean(document.querySelector(`[data-testid="v2-card-${modelProductId}"]`)), { label: "single BR101 parent card" });
const modelCard = document.querySelector(`[data-testid="v2-card-${modelProductId}"]`);
check("BR101 remains one catalogue product in the catalogue", document.querySelectorAll(`[data-testid="v2-card-${modelProductId}"]`).length === 1);
check("the BR101 catalogue card previews only the two available photos, without filling the missing M03 photo",
  modelCard.querySelectorAll(".v2-model-preview-images img").length === 2);
check("the BR101 catalogue card reports the available model count", /3/.test(modelCard.querySelector(".v2-model-preview")?.textContent ?? ""));
await navigate(`#/store/products/${modelProductId}`, 350);
await waitFor(() => Boolean(document.querySelector('[data-testid="v2-model-gallery"]')), { label: "three Staging model cards" });
const modelCards = [...document.querySelectorAll('[data-testid="v2-model-gallery"] .v2-model-gallery-card')];
const modelStocks = modelCards.map((card) => card.querySelector(".v2-model-gallery-stock")?.textContent ?? "");
const normalizedStock = (text) => text.replace(/[٠-٩]/g, (digit) => String("٠١٢٣٤٥٦٧٨٩".indexOf(digit)));
const expectedModelNames = document.documentElement.dir === "rtl" ? "شكل 1|شكل 2|شكل 3" : "Model 1|Model 2|Model 3";
check("all three real BR101 model rows render with their exact labels and stock 4/3/5",
  modelCards.length === 3 &&
  modelCards.map((card) => card.querySelector(".v2-model-gallery-name")?.textContent).join("|") === expectedModelNames &&
  /4/.test(normalizedStock(modelStocks[0])) && /3/.test(normalizedStock(modelStocks[1])) && /5/.test(normalizedStock(modelStocks[2])));
check("a missing model photo keeps its real name and stock beside a neutral placeholder",
  Boolean(document.querySelector('[data-testid="v2-model-gallery"] .v2-model-gallery-card:nth-child(3) .v2-model-gallery-photo-missing')) &&
  document.querySelector('[data-testid="v2-model-gallery"] .v2-model-gallery-card:nth-child(3) .v2-model-gallery-name')?.textContent === expectedModelNames.split("|")[2] &&
  /5/.test(normalizedStock(document.querySelector('[data-testid="v2-model-gallery"] .v2-model-gallery-card:nth-child(3) .v2-model-gallery-stock')?.textContent ?? "")));
const brokenModelImage = document.querySelector('[data-testid="v2-model-gallery"] .v2-model-gallery-card:nth-child(1) .v2-model-gallery-photo img');
brokenModelImage.dispatchEvent(new dom.window.Event("error"));
await sleep(40);
check("a failed photo URL becomes a neutral placeholder without hiding the exact name or stock",
  Boolean(document.querySelector('[data-testid="v2-model-gallery"] .v2-model-gallery-card:nth-child(1) .v2-model-gallery-photo-missing')) &&
  !document.querySelector('[data-testid="v2-model-gallery"] .v2-model-gallery-card:nth-child(1) .v2-model-gallery-photo img') &&
  document.querySelector('[data-testid="v2-model-gallery"] .v2-model-gallery-card:nth-child(1) .v2-model-gallery-name')?.textContent === expectedModelNames.split("|")[0] &&
  /4/.test(normalizedStock(document.querySelector('[data-testid="v2-model-gallery"] .v2-model-gallery-card:nth-child(1) .v2-model-gallery-stock')?.textContent ?? "")));
clickEl(document.querySelector(`[data-testid="v2-model-gallery"] .v2-model-gallery-card:nth-child(1) .v2-model-gallery-select`));
await sleep(40);
check("selecting a model card chooses its exact Staging variant ID and preserves the parent price",
  document.querySelector('[data-testid="v2-model-gallery"] .v2-model-gallery-card:nth-child(1) .v2-model-gallery-select')?.getAttribute("aria-pressed") === "true" &&
  /240/.test(document.querySelector('.v2-pdp-price')?.textContent ?? ""));
clickEl(document.querySelector(`[data-testid="v2-model-gallery"] .v2-model-gallery-card:nth-child(2) .v2-model-gallery-zoom`));
await waitFor(() => Boolean(document.querySelector('[data-testid="v2-lightbox"]')), { label: "selected model photo zoom" });
check("a real Staging model photo can be enlarged in the existing accessible lightbox",
  document.querySelector("[data-testid='v2-lightbox'] img")?.getAttribute("src") === modelPhoto(1));
clickEl(document.querySelector('[data-testid="v2-lightbox"] .v2-lightbox-close'));
await sleep(40);
clickEl(document.querySelector(`[data-testid="v2-model-gallery"] .v2-model-gallery-card:nth-child(3) .v2-model-gallery-add`));
await waitFor(() => cart().some((line) => line.variant_id === modelVariantIds[2]), { label: "exact BR101 model cart line" });
const exactModelLine = cart().find((line) => line.variant_id === modelVariantIds[2]);
check("direct add from the gallery preserves the actual M03 SKU, variant ID, and shared parent product",
  exactModelLine?.product_id === modelProductId && exactModelLine?.variant_id === modelVariantIds[2] &&
  cart().filter((line) => line.product_id === modelProductId).length === 1);
await navigate("#/store/checkout", 350);
await waitFor(() => Boolean(document.querySelector('[data-testid="v2-checkout"]')), { label: "model checkout" });
check("the removed campaign tagline is absent from checkout in Arabic", !hasRemovedTagline());
const pickup = [...document.querySelectorAll(".v2-choice-grid button")].find((button) => /Pickup|استلام/.test(button.textContent ?? ""));
if (pickup) clickEl(pickup);
setField('.v2-checkout-form input[autocomplete="name"]', "BR101 Test Shopper");
setField('.v2-checkout-form input[autocomplete="tel"]', "01012345678");
await sleep(70);
clickTestid("v2-place-order");
await waitFor(() => Boolean(document.querySelector('[data-testid="v2-order-details"]')) && orders().length === 1,
  { label: "model's exact order item" });
const modelOrderItem = orders()[0].items.find((item) => item.variant_id === modelVariantIds[2]);
check("the local demo order records exact Staging model M03 on its one BR101 parent product",
  modelOrderItem?.product_id === modelProductId && modelOrderItem.variant_id === modelVariantIds[2] &&
  /Model 3|شكل 3/.test(modelOrderItem.variant_display_name ?? modelOrderItem.variant_name ?? "") &&
  products.filter((product) => product.barcode === "BR101").length === 1);

console.log(`\n${passed} V2 DOM end-to-end checks passed (CSS geometry is tested separately in Chromium).`);
finish("Storefront V2 public presentation + exact cart handoff");
