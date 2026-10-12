/**
 * Phase 46 · POS UX — scan/search-first register over the proven sale engine.
 *
 * Drives the REDESIGNED register surface (one scan/search box + compact
 * result rows, no browsable product-card grid) and proves the behaviour
 * underneath did not move. The variant engine (Gold/17 = 2, Silver/17 = 2,
 * third refused) is the Phase 43/46 regression — re-proven here through the
 * new UI so a restyle can never quietly break the till.
 *
 *  1. the till opens: scan/search box + right sale panel, ready to sell
 *  2. search finds the product (name / SKU / barcode) as compact rows
 *  3. keyboard-first: arrows move, Enter adds the highlighted row, Escape closes
 *  4. a variant product NEVER auto-adds: the picker demands an exact shelf
 *  5. Gold / 17 × 2 is accepted under its exact variant UUID
 *  6. the THIRD Gold / 17 is refused at the shelf
 *  7. Silver / 17 lands as a SEPARATE cart line
 *  8. a customer can be attached to the sale
 *  9. the sale completes through the existing flow (cash, change computed)
 * 10. the receipt preserves the exact variants on every line
 * 11. a shelf BARCODE scan (code + Enter) adds the exact variant, exactly once
 */
import { createUxHarness } from "./lib/ux-harness.mjs";

const ux = await createUxHarness({
  beforeImport: ({ localStorage: ls }) => {
    for (const key of Object.keys(ls)) {
      if (key.startsWith("alyq.demo.") || key.startsWith("alyq.store.")) ls.removeItem(key);
    }
  },
});
const {
  assert,
  dom,
  documentWrites,
  bodyText,
  waitFor,
  navigate,
  clickEl,
  click,
  clickExact,
  testid,
  setField,
  setReactValue,
  setNative,
  setInputValue,
  signInAs,
  dialogs,
} = ux;
const { document } = dom.window;

const buttons = () => [...document.querySelectorAll("button")];
const GOLD_SKU = "UX2-RING-GOLD-17";
const SILVER_SKU = "UX2-RING-SILVER-17";
const SKU = "UX2-RING";

const catalog = () => ux.readJson("alyq.demo.catalog.v1") ?? { products: [], variants: [] };

// ── register helpers: the scan/search box and its compact result rows ──────
const searchBox = () => testid("pos-scan-search");
const resultsBox = () => testid("pos-search-results");
const rows = () => [...document.querySelectorAll('[data-pos-result-index]')];
const rowFor = (name) => rows().find((b) => (b.textContent ?? "").includes(name));
const pressKey = (key) =>
  ux.flushSync(() => searchBox().dispatchEvent(new dom.window.KeyboardEvent("keydown", { key, bubbles: true })));
const searchFor = async (text) => {
  setField('[data-testid="pos-scan-search"]', text);
  await waitFor(() => searchBox()?.value === text && (text.trim()
    ? resultsBox() || testid("pos-search-no-results") : testid("pos-catalog")), { label: "typed POS search committed" });
};

await signInAs("admin");
await waitFor(() => (catalog().products ?? []).length > 0, { label: "the demo catalogue to seed" });

// ── seed: the two-shelf variant ring, Gold=2 / Silver=2 ─────────────────────
await navigate("#/products/new");
await waitFor(() => document.querySelector("#sku"), { label: "the product form" });
setField("#name_ar", "خاتم اليوكس ٢");
setField("#name_en", "UX2 Ring");
setField("#sku", SKU);
setField("#selling_price", "120");
setField("#cost_price", "60");
setField("#tax_rate", "0");
setField("#stock_quantity", "4");
setField("#low_stock_level", "1");
const categorySelect = document.querySelector("#category_id");
if (categorySelect) {
  const option = [...categorySelect.options].find((o) => o.value !== "");
  if (option) setReactValue(categorySelect, option.value);
}
clickExact("Save");
await waitFor(() => !ux.dom.window.location.hash.includes("/new") && ux.dom.window.location.hash.includes("/products"), { label: "the save to land" });
const productId = catalog().products.find((p) => p.sku === SKU)?.id;
assert.ok(productId, "the ring is in the catalogue");

await navigate(`#/products/${productId}/edit`);
await waitFor(() => testid("variant-editor"), { label: "the variant editor" });
clickEl(testid("variant-generate"));
await waitFor(() => dialogs().length > 0, { label: "the generator" });
const genDialog = dialogs().at(-1);
const colorsArea = [...genDialog.querySelectorAll("textarea")].find((t) => (t.placeholder ?? "").includes("Gold"));
setNative(colorsArea, dom.window.HTMLTextAreaElement)("Gold | ذهبي | #d4af37\nSilver | فضي | #c0c0c0");
const sizesInput = [...genDialog.querySelectorAll("input")].find((i) => (i.placeholder ?? "").includes("16, 16.5"));
setNative(sizesInput, dom.window.HTMLInputElement)("17");
await waitFor(() => [...genDialog.querySelectorAll("button")].some((b) => b.textContent.trim() === "Create 2" && !b.disabled), { label: "two exact shelves ready to generate" });
clickEl([...genDialog.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim() === "Create 2"));
await waitFor(() => testid(`variant-row-${GOLD_SKU}`), { label: "the gold row" });
clickEl(testid("variant-mode-toggle"));
await waitFor(() => testid("variant-enable-panel"), { label: "the enable panel" });
const openingSet = (sku, value) => {
  const input = testid(`opening-${sku}`);
  setNative(input, dom.window.HTMLInputElement)(value);
};
openingSet(GOLD_SKU, "2");
openingSet(SILVER_SKU, "2");
await waitFor(() => !testid("variant-enable-confirm").disabled, { label: "the balanced 2+2" });
clickEl(testid("variant-enable-confirm"));
await waitFor(() => catalog().products.find((p) => p.id === productId)?.variants_enabled === true, {
  label: "the mode flip",
});
const ring = catalog().variants.filter((v) => v.product_id === productId);
assert.equal(ring.length, 2, "two shelves exist");
assert.equal(ring.find((v) => v.sku === GOLD_SKU)?.stock_quantity, 2, "Gold / 17 opens at 2");
assert.equal(ring.find((v) => v.sku === SILVER_SKU)?.stock_quantity, 2, "Silver / 17 opens at 2");

// give Silver / 17 a shelf barcode, the way a merchant labels a ring size
const silverRow = testid(`variant-row-${SILVER_SKU}`);
const editBtn = [...silverRow.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim() === "Edit");
clickEl(editBtn);
await waitFor(() => {
  const dlg = dialogs().at(-1);
  return dlg && [...dlg.querySelectorAll("label")].some((l) => (l.textContent ?? "").includes("Barcode"));
}, { label: "the variant form" });
const modal = dialogs().at(-1);
const barcodeLabel = [...modal.querySelectorAll("label")].find((l) => (l.textContent ?? "").includes("Barcode"));
const barcodeInput = barcodeLabel.nextElementSibling.matches("input")
  ? barcodeLabel.nextElementSibling
  : barcodeLabel.nextElementSibling.querySelector("input");
assert.ok(barcodeInput, "the barcode input is on the variant form");

setReactValue(barcodeInput, "6220100999117");
const saveVariantBtn = [...dialogs().at(-1).querySelectorAll("button")].find((b) => (b.textContent ?? "").trim() === "Save");
assert.ok(saveVariantBtn, "the variant form has a Save button");
clickEl(saveVariantBtn);
await waitFor(() => dialogs().length === 0 && catalog().variants.find((v) => v.sku === SILVER_SKU)?.barcode === "6220100999117", { label: "shelf barcode saved and form closed" });
assert.ok(!dialogs().length, "the variant form closed");
assert.equal(catalog().variants.find((v) => v.sku === SILVER_SKU)?.barcode, "6220100999117", "the shelf is labelled");
console.log("  ✓ seeded the two-shelf ring: Gold / 17 = 2, Silver / 17 = 2 (Silver carries a shelf barcode)");

// ── 1 · the till opens ──────────────────────────────────────────────────────
await navigate("#/shifts");
await waitFor(() => bodyText().includes("No shift is currently open"), { label: "a closed drawer" });
click("Open shift");
await waitFor(() => dialogs().at(-1)?.querySelector('input[inputmode="decimal"]'), { label: "opening shift form" });
const shiftDialog = dialogs().at(-1);
const shiftInputs = [...shiftDialog.querySelectorAll("input")];
setInputValue(shiftInputs.find((i) => !i.readOnly && i.type === "text"), "Main branch");
setInputValue(shiftInputs.find((i) => i.inputMode === "decimal"), "100");
clickEl([...shiftDialog.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim() === "Open shift"));
await waitFor(() => /SH-\d{6}/.test(bodyText()), { label: "the shift to open" });

await navigate("#/pos");
await waitFor(() => searchBox(), { label: "the scan/search box" });
await waitFor(() => document.activeElement === searchBox(), { label: "the box to take focus" });
assert.equal(searchBox().getAttribute("aria-label"), "Scan or search");
assert.equal(searchBox().getAttribute("placeholder"), "Scan barcode or search by name or code...");
assert.ok(testid("pos-catalog"), "the catalog renders, with a browseable catalogue");
assert.ok(!resultsBox(), "no result list before the cashier types");
assert.ok(!testid("pos-grid"), "the catalogue cards render");
assert.ok(
  document.querySelectorAll('[data-testid^="pos-catalog-product-"]').length > 0,
  "catalogue cards render",
);
assert.ok(
  document.querySelectorAll('[role="tab"]').length > 0,
  "category chips render",
);
await waitFor(() => testid("cash-input"), { label: "the sale panel's cash field" });
await waitFor(() => buttons().some((b) => (b.textContent ?? "").includes("Complete sale")), {
  label: "the complete-sale control",
});
console.log("  ✓ the till opens: scan/search box + sale panel, ready to sell");

// ── 2 · search finds ────────────────────────────────────────────────────────
await searchFor("UX2");
await waitFor(() => rows().length === 1, { label: "the search to isolate the ring row" });
const ringRow = testid(`pos-result-${productId}`);
assert.ok(ringRow, "the ring has its own compact result row");
assert.ok(ringRow.textContent.includes("UX2 Ring"), "the row names the product");
assert.ok(ringRow.textContent.includes("UX2-RING"), "the row carries the SKU");
assert.ok(ringRow.textContent.includes("120.00"), "the row carries the price");
assert.ok(ringRow.textContent.includes("Colour & size"), "the row says a variant must be chosen");
assert.equal(ringRow.querySelector(`[data-testid="pos-result-price-${productId}"]`)?.dir, "ltr");
console.log("  ✓ name search isolates the ring as one compact row");

// SKU, shelf barcode and Arabic name all resolve to the same row.
await searchFor("UX2-RING");
await waitFor(() => rows().length === 1, { label: "the SKU search" });
assert.equal(testid(`pos-result-${productId}`)?.tagName, "BUTTON", "the SKU row is selectable");
await searchFor("6220100999117");
await waitFor(() => rows().length === 1, { label: "the shelf-barcode search" });
assert.ok(rowFor("UX2 Ring"), "the shelf barcode surfaces the parent ring");
await searchFor("اليوكس");
await waitFor(() => rows().length === 1, { label: "the Arabic-name search" });
assert.ok(rowFor("UX2 Ring"), "the Arabic name finds the ring");
console.log("  ✓ SKU, shelf barcode and Arabic-name searches find the ring");

// Misses and unsellable products: a plain message, never a catalogue.
await searchFor("does-not-exist-zzz");
await waitFor(() => testid("pos-search-no-results"), { label: "the no-results message" });
assert.equal(rows().length, 0, "nothing to select on a miss");
assert.ok(testid("pos-search-no-results").textContent.includes("No matching products"));
await searchFor("Wrapping");
await waitFor(() => testid("pos-search-no-results") && rows().length === 0, { label: "unsellable search shows no rows" });
assert.equal(rows().length, 0, "the non-tracked service is never offered");
assert.ok(testid("pos-search-no-results"), "the miss message shows instead");
await searchFor("Watch");
await waitFor(() => testid("pos-search-no-results") && rows().length === 0, { label: "unsellable search shows no rows" });
assert.equal(rows().length, 0, "the inactive product is never offered");
console.log("  ✓ misses, services and inactive products offer no row");

// ── 3 · keyboard-first ──────────────────────────────────────────────────────
// Four seed SKUs share the ALYQ-10 prefix; none is an exact code, so Enter
// must act on the highlighted row — and only the highlighted row.
await searchFor("ALYQ-10");
await waitFor(() => rows().length === 4, { label: "the four matching seed rows" });
assert.ok(!testid("pos-search-no-results"), "matches, not the miss message");
pressKey("ArrowDown");
await waitFor(() => rows()[0]?.getAttribute("aria-selected") === "true", { label: "first keyboard row highlighted" });
assert.equal(rows()[0].getAttribute("aria-selected"), "true", "first row highlighted");
pressKey("ArrowDown");
await waitFor(() => rows()[1]?.getAttribute("aria-selected") === "true", { label: "second keyboard row highlighted" });
assert.equal(rows()[0].getAttribute("aria-selected"), "false", "highlight moved on");
assert.equal(rows()[1].getAttribute("aria-selected"), "true", "second row highlighted");
assert.ok(rows()[1].textContent.includes("ALYQ-1002"), "the highlight sits on the Classic Gold Ring");
pressKey("Enter");
await waitFor(() => testid("cart-line-prd-1002::"), { label: "the highlighted row to land in the cart" });
assert.equal(searchBox().value, "", "the box clears for the next scan");
assert.equal(document.activeElement, searchBox(), "focus returns to the box");
assert.ok(!resultsBox(), "the list closes after the add");
console.log("  ✓ arrows move the highlight; Enter adds exactly that row");

// Escape dismisses the list without touching the typed query.
await searchFor("ALYQ-10");
await waitFor(() => rows().length === 4, { label: "the list to reopen" });
pressKey("Escape");
await waitFor(() => !resultsBox(), { label: "Escape dismissed POS results" });
assert.ok(!resultsBox(), "Escape closes the result list");
assert.equal(searchBox().value, "ALYQ-10", "Escape keeps the typed query");
await searchFor("");
await waitFor(() => testid("pos-catalog"), { label: "the catalog" });
const confirmClearCart = async () => {
  clickEl(testid("pos-clear-cart"));
  await waitFor(() => [...document.querySelectorAll('[role="dialog"]')].some((d) => d.textContent.includes("Clear items")), { label: "clear merchandise confirmation" });
  const dialog = [...document.querySelectorAll('[role="dialog"]')].pop();
  const confirm = [...(dialog?.querySelectorAll("button") ?? [])].find((button) =>
    (button.textContent ?? "").includes("Clear items"),
  );
  assert.ok(confirm, "populated cart asks for clear confirmation");
  clickEl(confirm);
};
await confirmClearCart();
await waitFor(() => testid("pos-mobile-cart-open") === null || [...document.querySelectorAll('[data-testid^="cart-line-"]')].length === 0, {
  label: "the cart to empty",
});
assert.equal([...document.querySelectorAll('[data-testid^="cart-line-"]')].length, 0);
console.log("  ✓ Escape closes the list; the box is ready for the variant scenes");

// ── 4 · the picker demands an exact shelf ───────────────────────────────────
const cartLines = () => [...document.querySelectorAll('[data-testid^="cart-line-"]')];
const goldId = catalog().variants.find((v) => v.sku === GOLD_SKU)?.id;
const silverId = catalog().variants.find((v) => v.sku === SILVER_SKU)?.id;
assert.ok(goldId && silverId, "both shelf UUIDs resolve from the catalogue");
const qtyOf = (variantId) =>
  testid(`cart-line-${productId}::${variantId}`)?.querySelector('[data-testid^="cart-quantity-"]')
    ?.value ?? "0";

await searchFor("UX2");
await waitFor(() => rowFor("UX2 Ring"), { label: "the ring row" });
assert.equal(cartLines().length, 0, "nothing pre-selected");
clickEl(rowFor("UX2 Ring"));
const picker = () =>
  [...document.querySelectorAll('[role="dialog"]')].find((d) => (d.textContent ?? "").includes("Choose colour and size"));
await waitFor(() => picker(), { label: "the combination picker" });
assert.equal(cartLines().length, 0, "the picker opened instead of adding");
const sizeButton = (label) =>
  [...picker().querySelectorAll("button")].find((b) => (b.getAttribute("aria-label") ?? "").startsWith(`${label} — `));
await waitFor(() => sizeButton("Gold / 17"), { label: "Gold / 17 grid committed after default-colour effect" });
assert.ok(!sizeButton("Silver / 17"), "the grid shows only the chosen colour's shelves");
assert.ok(sizeButton("Gold / 17"), "Gold / 17 is a shelf in the grid");
console.log("  ✓ no auto-add: the exact-shelf picker stands between tap and cart");

// ── 5 · Gold / 17 × 2 accepted, under its exact UUID ────────────────────────
await waitFor(() => sizeButton("Gold / 17"), { label: "exact Gold / 17 picker shelf" });
clickEl(sizeButton("Gold / 17"));
await waitFor(() => !picker(), { label: "the picker to close after the first pick" });
await waitFor(() => testid(`cart-line-${productId}::${goldId}`), { label: "the Gold cart line" });
assert.equal(qtyOf(goldId), "1", "one Gold / 17 under its own UUID");
assert.equal(searchBox().value, "", "the box clears after a picker add");
assert.equal(document.activeElement, searchBox(), "focus returns to the box");
await searchFor("UX2");
await waitFor(() => rowFor("UX2 Ring"), { label: "the ring row again" });
clickEl(rowFor("UX2 Ring"));
await waitFor(() => picker(), { label: "the picker again" });
await waitFor(() => sizeButton("Gold / 17"), { label: "exact Gold / 17 picker shelf" });
clickEl(sizeButton("Gold / 17"));
await waitFor(() => qtyOf(goldId) === "2", { label: "two Gold / 17 on the exact line" });
await waitFor(() => cartLines().length === 1, { label: "one cart line" });
assert.ok(cartLines()[0].textContent.includes("Gold / 17"), "the line names the exact shelf");
console.log("  ✓ Gold / 17 × 2 accepted — the line names the shelf and carries its UUID");

// ── 6 · the third Gold / 17 is refused ─────────────────────────────────────
await searchFor("UX2");
await waitFor(() => rowFor("UX2 Ring"), { label: "the ring row a third time" });
clickEl(rowFor("UX2 Ring"));
await waitFor(() => picker(), { label: "the picker a third time" });
await waitFor(() => sizeButton("Gold / 17"), { label: "exact Gold / 17 picker shelf" });
assert.equal(sizeButton("Gold / 17").disabled, true, "the exhausted exact shelf is disabled before the third attempt");
clickEl(sizeButton("Gold / 17"));
assert.ok(picker(), "the refused pick leaves the picker open — nothing was added");
assert.equal(qtyOf(goldId), "2", "the THIRD Gold / 17 never reached the cart");
console.log("  ✓ the third Gold / 17 is refused (shelf = 2, the Phase 43 rule holds)");

// ── 7 · Silver / 17, a separate line ───────────────────────────────────────
const colorChip = (name) =>
  [...picker().querySelectorAll("button")].find(
    (b) => !(b.getAttribute("aria-label") ?? "").includes("—") && (b.textContent ?? "").includes(name),
  );
clickEl(colorChip("Silver"));
await waitFor(() => sizeButton("Silver / 17"), { label: "Silver / 17 colour grid" });
clickEl(sizeButton("Silver / 17"));
await waitFor(() => !picker(), { label: "the picker to close" });
await waitFor(() => cartLines().length === 2, { label: "two cart lines" });
assert.ok(testid(`cart-line-${productId}::${silverId}`), "Silver lands under its own UUID");
assert.ok(cartLines().some((l) => l.textContent.includes("Gold / 17")), "line 1 stays Gold / 17");
assert.ok(cartLines().some((l) => l.textContent.includes("Silver / 17")), "line 2 is Silver / 17 — never merged");
console.log("  ✓ Silver / 17 is its own line — shelves never merge in the cart");

// ── 8 · attach a customer ───────────────────────────────────────────────────
await waitFor(() => document.querySelector('input[aria-label="Select customer"]'), {
  label: "the customer picker",
});
setField('input[aria-label="Select customer"]', "سارة");
await waitFor(() => [...(document.querySelector('[role="listbox"]')?.querySelectorAll("button") ?? [])].some((b) => b.textContent.includes("سارة")), { label: "matching customer offered" });
const listbox = document.querySelector('[role="listbox"]');
assert.ok(listbox, "the picker's listbox is open");
const option = [...listbox.querySelectorAll("button")].find((b) => (b.textContent ?? "").includes("سارة"));
assert.ok(option, "the matching customer is offered");
// the options pick on mousedown (beating the input's blur) — press it like a
// finger, then require the at-rest input to show the chosen NAME, which only
// a real selection produces (the typed query would satisfy nothing)
ux.flushSync(() => {
  option.dispatchEvent(new dom.window.MouseEvent("mousedown", { bubbles: true, cancelable: true }));
  option.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
});
await waitFor(() => document.querySelector('input[aria-label="Select customer"]')?.value === "سارة المحمود", { label: "selected customer attached, not just a typed query" });
assert.equal(
  document.querySelector('input[aria-label="Select customer"]').value,
  "سارة المحمود",
  "the picker holds the chosen customer, not the typed query",
);
console.log("  ✓ the customer is attached to the sale");

// The customer is sale state, not cart-line state. Exercise the actual controls
// (including discounts and an empty cart) before accepting the sale.
const customerName = () => document.querySelector('input[aria-label="Select customer"]')?.value;
const expectCustomer = (action) => assert.equal(customerName(), "سارة المحمود", `customer survives ${action}`);
const lineFor = (label) => cartLines().find((line) => line.textContent.includes(label));
const quantityFor = (label) => lineFor(label)?.querySelector('[data-testid^="cart-quantity-"]')?.value;
clickEl(lineFor("Silver / 17").querySelector('button[aria-label="Increase quantity"]'));
await waitFor(() => quantityFor("Silver / 17") === "2", { label: "Silver increase" });
assert.equal(quantityFor("Gold / 17"), "2", "increasing Silver does not touch Gold");
expectCustomer("increasing Silver");
clickEl(lineFor("Silver / 17").querySelector('button[aria-label="Decrease quantity"]'));
await waitFor(() => quantityFor("Silver / 17") === "1", { label: "Silver decrease" });
expectCustomer("decreasing Silver");
setReactValue(lineFor("Silver / 17").querySelector('select[aria-label="Item discount"]'), "percent");
await waitFor(() => lineFor("Silver / 17")?.querySelector('input[aria-label="Discount value"]'), { label: "per-item discount field" });
setReactValue(lineFor("Silver / 17").querySelector('input[aria-label="Discount value"]'), "5");
await waitFor(() => lineFor("Silver / 17")?.querySelector('span.text-rose-700')?.textContent.startsWith("−"), { label: "line discount to apply" });
expectCustomer("an item discount");
setReactValue(lineFor("Silver / 17").querySelector('input[aria-label="Discount value"]'), "0");
setReactValue(lineFor("Silver / 17").querySelector('select[aria-label="Item discount"]'), "none");
setReactValue(document.querySelector('select[aria-label="Invoice discount"]'), "percent");
await waitFor(() => document.querySelector('input[aria-label="Discount value"]:not([type="number"])'), { label: "invoice discount field" });
setReactValue(document.querySelector('input[aria-label="Discount value"]:not([type="number"])'), "5");
expectCustomer("an invoice discount");
setReactValue(document.querySelector('input[aria-label="Discount value"]:not([type="number"])'), "0");
setReactValue(document.querySelector('select[aria-label="Invoice discount"]'), "none");
clickEl(lineFor("Silver / 17").querySelector('[data-testid^="cart-remove-"]'));
await waitFor(() => cartLines().length === 1, { label: "remove only the Silver line" });
assert.equal(quantityFor("Gold / 17"), "2");
expectCustomer("removing the Silver line");
await searchFor("UX2");
await waitFor(() => rowFor("UX2 Ring"), { label: "the ring row after removal" });
clickEl(rowFor("UX2 Ring"));
await waitFor(() => picker(), { label: "the picker after removal" });
clickEl(colorChip("Silver"));
await waitFor(() => sizeButton("Silver / 17"), { label: "Silver size after removal" });
clickEl(sizeButton("Silver / 17"));
await waitFor(() => cartLines().length === 2, { label: "Silver returned as its own line" });
expectCustomer("adding the Silver line again");
console.log("  ✓ increase, decrease, discounts, remove and re-add preserve the same selected customer and exact shelves");

// ── 9 · complete the sale through the existing flow ─────────────────────────
setField('[data-testid="cash-input"]', "500");
await waitFor(() => buttons().some((b) => b.textContent.trim().startsWith("✓") && b.textContent.includes("Complete sale") && !b.disabled), { label: "cash sale payable" });
const completeBtn = buttons().find(
  (b) => (b.textContent ?? "").trim().startsWith("✓") && (b.textContent ?? "").includes("Complete sale"),
);
assert.ok(completeBtn && !completeBtn.disabled, "the sale is payable");
clickEl(completeBtn);
await waitFor(() => /INV-\d{6}/.test(bodyText()), { label: "the sale to complete" });
const receiptNo = (bodyText().match(/INV-\d{6}/) ?? [])[0];
assert.ok(receiptNo, `completed as ${receiptNo}`);
assert.ok(bodyText().includes("Change"), "change is computed against the cash tendered");
expectCustomer("a completed sale; only the merchandise was cleared");
console.log("  ✓ the sale completes through the proven flow, with change and the selected customer");

// ── 10 · the receipt preserves the variants ────────────────────────────────
const printBtn = buttons().find((b) => (b.textContent ?? "").includes("Print receipt"));
assert.ok(printBtn, "the print action is on the confirmation");
clickEl(printBtn);
await waitFor(() => documentWrites.join("\n").includes(receiptNo) && documentWrites.join("\n").includes("Silver / 17"), { label: "exact-shelf receipt rendered" });
const receiptHtml = documentWrites.join("\n");
assert.ok(receiptHtml.includes("Gold / 17"), "the receipt line names Gold / 17");
assert.ok(receiptHtml.includes("Silver / 17"), "the receipt line names Silver / 17");
assert.ok(receiptHtml.includes(receiptNo), "the receipt carries the sale number");
console.log("  ✓ the printed receipt preserves both exact shelves");

// ── 11 · a shelf barcode scan adds the exact variant, exactly once ──────────
clickExact("New sale");
await waitFor(() => cartLines().length === 0, { label: "the fresh sale" });
expectCustomer("opening a new, empty sale");
const silver = catalog().variants.find((v) => v.sku === SILVER_SKU);
assert.ok(silver?.barcode, `Silver / 17 carries a barcode (${silver?.barcode})`);
setField('[data-testid="pos-scan-search"]', silver.barcode);
pressKey("Enter");
await waitFor(() => cartLines().length === 1, { label: "one scanned line" });
assert.equal(quantityFor("Silver / 17"), "1", "the scan added exactly one unit — never a double");
assert.ok(testid(`cart-line-${productId}::${silverId}`), "the scan resolved Silver / 17 to its exact UUID");
assert.equal(searchBox().value, "", "the box clears for the next scan");
assert.equal(document.activeElement, searchBox(), "focus stays in the box between scans");
expectCustomer("an exact-variant barcode scan");
await confirmClearCart();
await waitFor(() => cartLines().length === 0, { label: "clear items to empty the cart" });
expectCustomer("Clear items (which must NOT clear the customer)");
setField('[data-testid="pos-scan-search"]', silver.barcode);
pressKey("Enter");
await waitFor(() => cartLines().length === 1, { label: "scanning after clearing the cart" });
expectCustomer("scanning after Clear items");
clickEl(cartLines()[0].querySelector('[data-testid^="cart-remove-"]'));
await waitFor(() => cartLines().length === 0, { label: "last-line removal" });
expectCustomer("removing the last item");
const explicitClear = document.querySelector('button[title="Walk-in customer (no account)"]');
assert.ok(explicitClear, "only the customer picker has the explicit customer-clear control");
clickEl(explicitClear);
await waitFor(() => customerName() === "", { label: "explicitly clearing the customer" });
console.log("  ✓ shelf barcode targets Silver / 17 exactly once; Clear items and last-line removal keep the customer until explicitly cleared");

await navigate("#/");
ux.finish("POS UX");
