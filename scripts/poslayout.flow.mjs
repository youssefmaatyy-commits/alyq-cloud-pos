/**
 * POS product-pane DOM regression. A crowded catalogue must keep the last
 * product as a real focusable, selectable card, not a clipped carousel item.
 *
 * jsdom intentionally has NO pixel/layout engine: the width, scroll distance
 * and checkout position at 1366/1920/tablet are verified separately in the
 * Chromium checks in rendered.flow.mjs. This suite protects the reachable DOM
 * and add-to-cart interaction in every `npm run test:e2e` run.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
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

// ── POS grip scrollbar: long-thumb regression ────────────────────────────
// jsdom has no layout engine and cannot measure a rendered scrollbar thumb, so
// the geometry is asserted against the stylesheet the browser actually applies,
// and the DOM half below proves the class stays scoped to the POS surfaces.
// Block comments are dropped first: the Firefox gate's own comment names
// `scrollbar-width/-color` and would otherwise read as a leaked declaration.
const stripComments = (source) => {
  let out = "";
  for (let i = 0; i < source.length; i += 1) {
    if (source[i] === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      i = end < 0 ? source.length : end + 1;
      continue;
    }
    out += source[i];
  }
  return out;
};
const css = stripComments(
  await readFile(fileURLToPath(new URL("../src/index.css", import.meta.url)), "utf8"),
);

/** Span of the first `{ … }` at or after `from`, brace-matched; null if none. */
const blockSpan = (source, from) => {
  if (from < 0) return null;
  const open = source.indexOf("{", from);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}" && --depth === 0) return [open + 1, i];
  }
  return null;
};
const bodyAt = (source, from) => {
  const span = blockSpan(source, from);
  return span && source.slice(span[0], span[1]);
};
const ruleBody = (source, selector) => bodyAt(source, source.indexOf(`${selector} {`));
/** Leading pixel length of one declaration; NaN when it is not a px value. */
const px = (body, property) => {
  const value = (body ?? "")
    .split(";")
    .map((decl) => decl.trim())
    .find((decl) => decl.startsWith(`${property}:`))
    ?.slice(property.length + 1)
    .trim() ?? "";
  let i = 0;
  while (i < value.length && value[i] >= "0" && value[i] <= "9") i += 1;
  return i > 0 && value.startsWith("px", i) ? Number(value.slice(0, i)) : NaN;
};

const lane = ruleBody(css, ".pos-grip-scrollbar::-webkit-scrollbar");
const thumb = ruleBody(css, ".pos-grip-scrollbar::-webkit-scrollbar-thumb");
const thumbHover = ruleBody(css, ".pos-grip-scrollbar::-webkit-scrollbar-thumb:hover");
assert.ok(lane && thumb && thumbHover, "the POS grip scrollbar rules are present in src/index.css");

assert.equal(px(lane, "width"), 14, "POS keeps its 14px scrollbar lane");
assert.equal(px(lane, "height"), 14, "POS keeps the same 14px lane horizontally");

// The transparent border sits inside the thumb box and trims both edges, so it
// is subtracted twice: that remainder is the grip a till operator really drags.
const border = px(thumb, "border");
const visibleGrip = px(thumb, "min-height") - 2 * border;
assert.ok(visibleGrip >= 80 && visibleGrip <= 100,
  `the POS thumb stays a long, grabbable ~90px (got ${visibleGrip}px visible)`);
assert.equal(px(lane, "width") - 2 * border, 8, "the 14px lane keeps its ~8px visible grip width");
assert.ok(thumb.includes("var(--color-stone-400)"), "the thumb keeps stone-400");
assert.ok(thumbHover.includes("var(--color-stone-500)"), "the hovered thumb keeps stone-500");

// Firefox has to stay gated: Chromium 121+ disables ::-webkit-scrollbar styling
// for any element that sets scrollbar-width/-color, which would lose the lane.
const gate = blockSpan(css, css.indexOf("@supports not selector(::-webkit-scrollbar)"));
assert.ok(gate, "Firefox rules stay behind an @supports not selector(::-webkit-scrollbar) gate");
const firefoxRules = css.slice(gate[0], gate[1]);
assert.ok(firefoxRules.includes(".pos-grip-scrollbar") && firefoxRules.includes("scrollbar-width"),
  "Firefox keeps scrollbar-width inside the gate");
assert.ok(firefoxRules.includes("scrollbar-color"), "Firefox keeps scrollbar-color inside the gate");
const outsideGate = css.slice(0, gate[0] - 1) + css.slice(gate[1] + 1);
assert.ok(!outsideGate.includes("scrollbar-width") && !outsideGate.includes("scrollbar-color"),
  "scrollbar-width/color never leak outside the Firefox gate, or Chromium loses the 14px lane");

// The global (Admin/Storefront) scrollbar is untouched — matched at line start
// so `.pos-grip-scrollbar::-webkit-scrollbar` cannot satisfy it.
let lineStart = 0;
let globalAt = -1;
for (const line of css.split("\n")) {
  if (line.trim().startsWith("::-webkit-scrollbar {")) { globalAt = lineStart; break; }
  lineStart += line.length + 1;
}
const globalScrollbar = bodyAt(css, globalAt);
assert.ok(globalScrollbar, "the global scrollbar rule still exists");
assert.equal(px(globalScrollbar, "width"), 10, "the global scrollbar stays 10px wide");
assert.equal(px(globalScrollbar, "height"), 10, "the global scrollbar stays 10px tall");

// Scope: only the POS checkout/cart surfaces, never the product grid.
assert.ok(checkout.classList.contains("pos-grip-scrollbar"), "the desktop checkout panel keeps the grip scrollbar");
const checkoutLines = checkout.querySelector('[data-testid^="cart-line-"]')?.closest("ul");
assert.ok(checkoutLines?.classList.contains("pos-grip-scrollbar"), "the cart line-items list keeps the grip scrollbar");
assert.ok(drawer.classList.contains("pos-grip-scrollbar"), "the mobile/tablet cart drawer keeps the grip scrollbar");
assert.ok(!grid.classList.contains("pos-grip-scrollbar"), "the product grid does NOT get the POS grip scrollbar");
assert.ok(!grid.querySelector(".pos-grip-scrollbar"), "no product card gets the POS grip scrollbar");
const strays = [...document.querySelectorAll(".pos-grip-scrollbar")]
  .filter((el) => el !== checkout && el !== drawer && !checkout.contains(el) && !drawer.contains(el))
  .map((el) => `${el.tagName.toLowerCase()}.${el.className}`);
assert.deepEqual(strays, [], `the grip scrollbar stays on the POS cart/checkout surfaces only: ${strays.join(", ")}`);
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
