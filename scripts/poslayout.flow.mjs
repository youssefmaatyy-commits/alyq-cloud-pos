/**
 * POS scan/search workspace DOM regression.
 *
 * A crowded catalogue must NOT render a browsable product-card grid: the
 * register is one scan/search box plus a compact, capped result list. This
 * suite pins that contract — no grid, no cards, no category chips, no product
 * scrolling — while the cart keeps its own scroll and the checkout stays put.
 *
 * jsdom intentionally has NO pixel/layout engine: the desktop geometry at
 * 1366/1920/tablet is verified separately in the Chromium checks in
 * rendered.flow.mjs. This suite protects the reachable DOM and the
 * search/scan-to-cart interaction in every `npm run test:e2e` run.
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
const { assert, dom, sleep, waitFor, navigate, clickEl, clickExact, setField, setReactValue, signInAs, testid, toastText } = ux;
const { document } = dom.window;
const catalog = () => ux.readJson("alyq.demo.catalog.v1");

const searchBox = () => testid("pos-scan-search");
const resultsBox = () => testid("pos-search-results");
const rows = () => [...document.querySelectorAll('[data-pos-result-index]')];
const cartLines = () => [...document.querySelectorAll('[data-testid^="cart-line-"]')];
const searchFor = async (text) => {
  setField('[data-testid="pos-scan-search"]', text);
  await sleep(450);
};
const pressEnter = () =>
  searchBox().dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

await signInAs("admin");
await waitFor(() => catalog()?.products?.length > 0, { label: "the demo catalogue" });

// Real product-form saves, so the POS reload path and the registration UI
// participate in the test. 26 created + 5 sellable seeds = 31 matches for a
// one-letter query, which also proves the result list stays capped.
for (let i = 1; i <= 26; i += 1) {
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
const idOf = (sku) => catalog().products.find((p) => p.sku === sku)?.id;
assert.ok(idOf("POS-SCROLL-5"), "the created products are in the catalogue");

await navigate("#/pos");
await waitFor(() => searchBox(), { label: "the scan/search box" });
assert.equal(searchBox().getAttribute("placeholder"), "Scan barcode or search by name or code...");
assert.equal(searchBox().getAttribute("aria-label"), "Scan or search");
assert.ok(testid("pos-search-empty"), "the idle hint renders instead of a catalogue");

// ── the grid is gone, even with a crowded catalogue ─────────────────────────
assert.ok(!testid("pos-grid"), "no product-card grid renders");
assert.equal(document.querySelectorAll('[data-testid^="pos-product-"]').length, 0, "no product cards render");
assert.equal(
  document.querySelectorAll('[data-testid^="pos-category-chip-"]').length,
  0,
  "no category chips render",
);
const checkout = testid("pos-checkout-panel");
assert.ok(checkout?.contains(testid("pos-cart")), "checkout holds the cart beside the search column");
assert.ok(checkout.parentElement.parentElement.classList.contains("lg:h-[calc(100dvh-6.5rem)]"), "desktop register fits below the shell chrome");
assert.ok(checkout.classList.contains("lg:max-h-full"), "checkout remains inside the bounded register row");
assert.ok(checkout.classList.contains("lg:overflow-y-auto"), "checkout, not the page, owns its vertical overflow");
assert.ok(checkout.classList.contains("lg:overscroll-y-contain"), "checkout scroll cannot drag the whole page");
assert.ok(checkout.firstElementChild.classList.contains("lg:shrink-0"), "the cart never collapses under a tall payment form");
const searchColumn = testid("pos-search-column");
const desktopRow = checkout.parentElement;
assert.ok(desktopRow.classList.contains("lg:grid-cols-[minmax(0,35fr)_minmax(0,65fr)]"), "desktop tracks give search 35% and checkout 65%");
assert.ok(desktopRow.classList.contains("lg:rtl:grid-cols-[minmax(0,65fr)_minmax(0,35fr)]"), "RTL mirrors the desktop tracks");
assert.ok(searchColumn.classList.contains("lg:order-1") && searchColumn.classList.contains("lg:rtl:order-2"), "LTR search order is first and RTL search order is second");
assert.ok(checkout.classList.contains("lg:order-2") && checkout.classList.contains("lg:rtl:order-1"), "LTR checkout order is second and RTL checkout order is first");
assert.ok(!desktopRow.className.includes("_380px") && !desktopRow.className.includes("minmax(21rem,24rem)"), "old narrow and widened rails stay absent");
assert.ok(!searchColumn.className.includes("max-w-[96rem]"), "search column remains fluid without the reverted cap");
console.log("  ✓ crowded catalogue, no grid: one scan/search box beside a stable checkout");

// ── name search returns compact rows with price + stock ─────────────────────
await searchFor("Handmade");
await waitFor(() => rows().length === 1, { label: "the single matching row" });
const setRow = testid("pos-result-prd-2001");
assert.ok(setRow, "the jewellery set has its own compact row");
assert.ok(setRow.textContent.includes("Handmade Jewellery Set"), "the row names the product");
assert.ok(setRow.textContent.includes("ALYQ-2001"), "the row carries the SKU");
assert.equal(
  setRow.querySelector('[data-testid="pos-result-price-prd-2001"]')?.textContent.trim(),
  "4250.00",
  "the row carries the price",
);
assert.equal(
  setRow.querySelector('[data-testid="pos-result-price-prd-2001"]')?.dir,
  "ltr",
  "the price stays legible",
);
assert.equal(
  setRow.querySelector('[data-testid="pos-result-stock-prd-2001"]')?.textContent.trim(),
  "3",
  "the row carries the stock",
);
clickEl(setRow);
await waitFor(() => testid("cart-line-prd-2001::"), { label: "the row click to land in the cart" });
assert.equal(searchBox().value, "", "the box clears for the next scan");
assert.equal(document.activeElement, searchBox(), "focus returns to the box");
console.log("  ✓ name search → compact row (price + stock) → cart");

// ── SKU search + exact barcode add the item directly ─────────────────────────
await searchFor("POS-SCROLL-5");
await waitFor(() => testid(`pos-result-${idOf("POS-SCROLL-5")}`), { label: "the SKU row" });
pressEnter();
await waitFor(() => testid(`cart-line-${idOf("POS-SCROLL-5")}::`), { label: "the exact SKU to add" });
assert.equal(searchBox().value, "", "exact-code adds clear the box");
await searchFor("6281000000013");
await waitFor(() => testid("pos-result-prd-1001"), { label: "the barcode row" });
pressEnter();
await waitFor(() => testid("cart-line-prd-1001::"), { label: "the exact barcode to add" });
assert.equal(
  testid("cart-line-prd-1001::")?.querySelector('[data-testid^="cart-quantity-"]')?.textContent,
  "1",
  "the barcode added exactly one unit",
);
console.log("  ✓ SKU and exact-barcode searches add the item directly");

// ── out-of-stock can neither be clicked nor scanned in ──────────────────────
await searchFor("Pearl Necklace");
await waitFor(() => testid("pos-result-prd-1010"), { label: "the out-of-stock row" });
const oosRow = testid("pos-result-prd-1010");
assert.equal(oosRow.disabled, true, "the out-of-stock row is disabled");
clickEl(oosRow);
await sleep(250);
assert.ok(!testid("cart-line-prd-1010::"), "clicking a disabled row adds nothing");
await searchFor("6281000000037");
await waitFor(() => testid("pos-result-prd-1010"), { label: "the out-of-stock barcode row" });
pressEnter();
await sleep(450);
assert.ok(!testid("cart-line-prd-1010::"), "scanning an empty shelf adds nothing");
assert.equal(searchBox().value, "6281000000037", "a refused scan keeps the typed code");
assert.ok((toastText() ?? "").includes("Code not found"), "the refusal is explained");
console.log("  ✓ out-of-stock rows are disabled; scanning an empty shelf refuses with a reason");

// Unsellable products never surface, whatever the query.
await searchFor("Gift Wrapping");
await sleep(450);
assert.equal(rows().length, 0, "the non-tracked service is never offered");
await searchFor("Watch");
await sleep(450);
assert.equal(rows().length, 0, "the inactive product is never offered");
await searchFor("");
console.log("  ✓ services and inactive products stay out of results");

// ── the result list stays a capped dropdown, never a catalogue ──────────────
await searchFor("a");
await waitFor(() => rows().length === 30, { label: "the capped result list" });
assert.ok(
  (resultsBox().textContent ?? "").includes("+1 more"),
  "the remainder is named instead of rendered",
);
assert.ok(resultsBox().classList.contains("overflow-y-auto"), "the dropdown owns its own short scroll");
await searchFor("");
console.log("  ✓ 31 matches render as 30 compact rows + a named remainder");

// ── a long cart keeps its own scroll; checkout stays put ────────────────────
for (let i = 11; i <= 20; i += 1) {
  setField('[data-testid="pos-scan-search"]', `POS-SCROLL-${i}`);
  pressEnter();
  await sleep(120);
}
await waitFor(() => cartLines().length === 13, { label: "the long cart" });
const cartRegion = checkout.firstElementChild;
assert.ok(cartRegion.classList.contains("lg:shrink-0"), "a nonempty cart must stay tall enough to operate");
assert.ok(cartRegion.classList.contains("lg:min-h-[22rem]"), "cart lines retain room for their own scroll list");
const cartList = checkout.querySelector('[data-testid^="cart-line-"]')?.closest("ul");
assert.ok(cartList?.classList.contains("overflow-y-auto"), "the cart line list scrolls inside the cart");
assert.equal(testid("pos-checkout-panel"), checkout, "adding items does not replace the checkout panel");
clickEl(testid("pos-mobile-cart-open"));
await waitFor(() => testid("pos-mobile-cart-drawer")?.querySelector('[data-testid="pos-cart"]'), {
  label: "the tablet cart drawer",
});
const drawer = testid("pos-mobile-cart-drawer");
const tabletCartWrapper = drawer.querySelector('[data-testid="pos-cart"]').parentElement;
assert.ok(tabletCartWrapper.classList.contains("shrink-0") && tabletCartWrapper.classList.contains("min-h-[22rem]"),
  "tablet cart stays usable beside the split-payment form");
console.log("  ✓ long cart: 13 lines with their own scroll, checkout and tablet drawer stable");

// ── POS grip scrollbar: long-thumb regression ────────────────────────────
// jsdom has no layout engine and cannot measure a rendered scrollbar thumb, so
// the geometry is asserted against the stylesheet the browser actually applies,
// and the DOM half below proves the class stays scoped to the POS cart and
// checkout surfaces (there is no product grid left to scope it away from).
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

// Scope: only the POS checkout/cart surfaces.
assert.ok(checkout.classList.contains("pos-grip-scrollbar"), "the desktop checkout panel keeps the grip scrollbar");
const checkoutLines = checkout.querySelector('[data-testid^="cart-line-"]')?.closest("ul");
assert.ok(checkoutLines?.classList.contains("pos-grip-scrollbar"), "the cart line-items list keeps the grip scrollbar");
assert.ok(drawer.classList.contains("pos-grip-scrollbar"), "the mobile/tablet cart drawer keeps the grip scrollbar");
assert.ok(!resultsBox()?.classList.contains("pos-grip-scrollbar"), "the search dropdown keeps the default scrollbar");
const strays = [...document.querySelectorAll(".pos-grip-scrollbar")]
  .filter((el) => el !== checkout && el !== drawer && !checkout.contains(el) && !drawer.contains(el))
  .map((el) => `${el.tagName.toLowerCase()}.${el.className}`);
assert.deepEqual(strays, [], `the grip scrollbar stays on the POS cart/checkout surfaces only: ${strays.join(", ")}`);
clickEl(drawer.querySelector('button[aria-label]'));
console.log("  ✓ cart + checkout keep the long-thumb grip scrollbar, scoped to those surfaces");

clickExact("العربية");
await waitFor(() => document.documentElement.dir === "rtl", { label: "Arabic register layout" });
assert.equal(searchBox().getAttribute("placeholder"), "امسح الباركود أو ابحث بالاسم أو الكود...");
assert.equal(searchBox().getAttribute("aria-label"), "مسح أو بحث");
await searchFor("سوار التمرير");
await waitFor(() => rows().length === 26, { label: "the Arabic search rows" });
const arabicRow = testid(`pos-result-${idOf("POS-SCROLL-5")}`);
assert.ok(arabicRow, "the same product is reachable in RTL");
assert.equal(
  arabicRow.querySelector(`[data-testid="pos-result-price-${idOf("POS-SCROLL-5")}"]`)?.textContent.trim(),
  "4250.00",
);
assert.equal(
  arabicRow.querySelector(`[data-testid="pos-result-price-${idOf("POS-SCROLL-5")}"]`)?.dir,
  "ltr",
  "decimal price stays legible in RTL",
);
assert.equal(testid("pos-checkout-panel"), checkout, "checkout remains mounted when switching direction");
await searchFor("POS-SCROLL-5");
pressEnter();
await waitFor(
  () =>
    testid(`cart-line-${idOf("POS-SCROLL-5")}::`)?.querySelector('[data-testid^="cart-quantity-"]')
      ?.textContent === "2",
  { label: "the RTL exact-code add to raise the line to two" },
);
assert.equal(testid("pos-checkout-panel"), checkout);
await searchFor("");
await waitFor(() => testid("pos-search-empty"), { label: "the Arabic idle hint" });
assert.ok(
  (testid("pos-search-empty").textContent ?? "").includes("امسح باركود أو اكتب الاسم أو الكود"),
  "the idle hint is translated",
);
console.log("  ✓ RTL search, price, exact-code add and translated hint without moving checkout");

ux.finish("POS search/scan workspace DOM regression");
