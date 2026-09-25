/**
 * POS product-pane DOM regression. A crowded catalogue must keep the last
 * product as a real focusable, selectable card, not a clipped carousel item.
 *
 * jsdom intentionally has NO pixel/layout engine: the width, scroll distance
 * and checkout position at 1366/1920/tablet are verified separately in the
 * Chromium checks in rendered.flow.mjs. This suite protects the reachable DOM
 * and add-to-cart interaction in every `npm run test:e2e` run.
 */
import { createUxHarness } from "./lib/ux-harness.mjs";

const ux = await createUxHarness({
  beforeImport: ({ localStorage }) => {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith("alyq.demo.") || key.startsWith("alyq.store.")) localStorage.removeItem(key);
    }
    localStorage.setItem("alyq.lang", "en");
  },
});
const { assert, dom, waitFor, navigate, clickEl, clickExact, setField, setReactValue, signInAs, testid } = ux;
const { document } = dom.window;
const catalog = () => ux.readJson("alyq.demo.catalog.v1");

await signInAs("admin");
await waitFor(() => catalog()?.products?.length > 0, { label: "the demo catalogue" });

// Real product-form saves, so the POS reload path and the registration UI
// participate in the test. The original last sellable seed will be several
// complete rows beyond the initially visible products on desktop.
for (let i = 1; i <= 18; i += 1) {
  await navigate("#/products/new", 80);
  await waitFor(() => document.querySelector("#sku"), { label: `product form ${i}` });
  setField("#name_ar", `سوار التمرير ${i}`);
  setField("#name_en", `Scroll Test Bracelet ${i}`);
  setField("#sku", `POS-SCROLL-${i}`);
  setField("#selling_price", "4250");
  setField("#cost_price", "100");
  setField("#tax_rate", "0");
  setField("#stock_quantity", "12");
  const category = document.querySelector("#category_id");
  const firstCategory = [...category.options].find((option) => option.value);
  if (firstCategory) setReactValue(category, firstCategory.value);
  clickEl(testid("product-form-save"));
  await waitFor(() => dom.window.location.hash === "#/products", { label: `saved product ${i}` });
}

await navigate("#/pos");
await waitFor(() => testid("pos-grid")?.querySelectorAll('button[data-testid^="pos-product-"]').length >= 22, {
  label: "the crowded product pane",
});
const grid = testid("pos-grid");
const checkout = testid("pos-checkout-panel");
const cards = [...grid.querySelectorAll('button[data-testid^="pos-product-"]')];
const lastSeed = testid("pos-product-prd-2001");
assert.ok(lastSeed && cards.indexOf(lastSeed) >= 18, "the target follows at least 18 products");
assert.ok(!lastSeed.disabled, "the last seed can still be sold");
assert.ok(checkout?.contains(testid("pos-cart")), "checkout is separate from the product scroll container");
assert.ok(!grid.contains(checkout), "scrolling the products cannot move checkout inside their container");
// DOM-only contract: the real browser suite below proves scrollTop/wheel, while
// this suite catches a regression to a capped but non-scrollable checkout.
assert.ok(checkout.parentElement.parentElement.classList.contains("lg:h-[calc(100dvh-6.5rem)]"), "desktop register fits below the shell chrome");
assert.ok(checkout.classList.contains("lg:max-h-full"), "checkout remains inside the bounded register row");
assert.ok(checkout.classList.contains("lg:overflow-y-auto"), "checkout, not the page, owns its vertical overflow");
assert.ok(checkout.classList.contains("lg:overscroll-y-contain"), "checkout scroll cannot drag the whole page");
assert.ok(checkout.firstElementChild.classList.contains("lg:shrink-0"), "the cart never collapses under a tall payment form");
assert.ok(grid.style.gridTemplateColumns.includes("auto-fill"), "columns follow product-pane width");
assert.ok(grid.classList.contains("overflow-y-auto"), "the product list has native vertical scrolling");
assert.ok(grid.classList.contains("lg:overscroll-y-contain"), "desktop grid overscroll is contained without trapping the tablet page");
assert.ok(!grid.classList.contains("overflow-x-auto"), "there is no hidden horizontal card carousel");
assert.ok(
  document.querySelector('[role="group"][aria-label="Category"]')?.classList.contains("flex-wrap"),
  "category filters wrap instead of hiding behind a horizontal scrollbar",
);
assert.equal(lastSeed.querySelector('[data-testid="pos-product-price"]')?.textContent.trim(), "4250.00");
assert.equal(lastSeed.querySelector('[data-testid="pos-product-stock"]')?.textContent.trim(), "3");
assert.equal(lastSeed.querySelector('[data-testid="pos-product-action"]')?.textContent.trim(), "Add");

// jsdom cannot calculate the actual off-screen position or scrollTop range;
// keyboard focus + selection proves the tail card remains reachable. The
// Chromium counterpart below tests a real wheel scroll from above the fold.
lastSeed.focus();
assert.equal(document.activeElement, lastSeed, "tail card is keyboard focusable");
clickEl(lastSeed);
await waitFor(() => checkout.querySelector('[data-testid="cart-line-prd-2001::"]'), {
  label: "the formerly off-screen product to appear in checkout",
});
const cartRegion = checkout.firstElementChild;
assert.ok(cartRegion.classList.contains("lg:shrink-0"), "a nonempty cart must stay tall enough to operate");
assert.ok(cartRegion.classList.contains("lg:min-h-[22rem]"), "cart lines retain room for their own scroll list");
assert.equal(testid("pos-checkout-panel"), checkout, "adding a product does not replace the checkout panel");
assert.equal(testid("pos-product-prd-2001")?.querySelector("span.bg-stone-900")?.textContent.trim(), "1");
clickEl(testid("pos-mobile-cart-open"));
await waitFor(() => testid("pos-mobile-cart-drawer")?.querySelector('[data-testid="pos-cart"]'), {
  label: "the tablet cart drawer",
});
const drawer = testid("pos-mobile-cart-drawer");
const tabletCartWrapper = drawer.querySelector('[data-testid="pos-cart"]').parentElement;
assert.ok(tabletCartWrapper.classList.contains("shrink-0") && tabletCartWrapper.classList.contains("min-h-[22rem]"),
  "tablet cart stays usable beside the split-payment form");
clickEl(drawer.querySelector('button[aria-label]'));
console.log("  ✓ crowded POS grid retains the tail card, keyboard focus and Add-to-cart");

clickExact("العربية");
await waitFor(() => document.documentElement.dir === "rtl", { label: "Arabic register layout" });
const arabicCard = testid("pos-product-prd-2001");
assert.ok(arabicCard, "the same tail product is still reachable in RTL");
assert.equal(arabicCard.querySelector('[data-testid="pos-product-action"]')?.textContent.trim(), "إضافة");
assert.equal(arabicCard.querySelector('[data-testid="pos-product-price"]')?.textContent.trim(), "4250.00");
assert.equal(arabicCard.querySelector('[data-testid="pos-product-price"]')?.dir, "ltr", "decimal price stays legible in RTL");
assert.equal(testid("pos-checkout-panel"), checkout, "checkout remains mounted when switching direction");
clickEl(arabicCard);
await waitFor(() => testid("pos-product-prd-2001")?.querySelector("span.bg-stone-900")?.textContent.trim() === "2", {
  label: "the RTL tail card to add a second unit",
});
assert.equal(testid("pos-checkout-panel"), checkout);
console.log("  ✓ RTL card, stock, price and Add action remain selectable without moving checkout");

ux.finish("POS product pane layout DOM regression");
