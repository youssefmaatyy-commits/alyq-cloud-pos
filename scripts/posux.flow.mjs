/**
 * Phase 46 · POS UX — speed-first register over the proven sale engine.
 *
 * Drives the REDESIGNED register surface and proves the behaviour underneath
 * did not move. The variant engine (Gold/17 = 2, Silver/17 = 2, third refused)
 * is the Phase 43/46 regression — re-proven here through the new UI so a
 * restyle can never quietly break the till.
 *
 *  1. the till opens: grid + right sale panel, ready to sell
 *  2. search finds the product (name / SKU / barcode)
 *  3. category chips narrow the grid
 *  4. a variant product NEVER auto-adds: the picker demands an exact shelf
 *  5. Gold / 17 × 2 is accepted (its own shelf count)
 *  6. the THIRD Gold / 17 is refused at the shelf
 *  7. Silver / 17 lands as a SEPARATE cart line
 *  8. a customer can be attached to the sale
 *  9. the sale completes through the existing flow (cash, change computed)
 * 10. the receipt preserves the exact variants on every line
 * 11. a shelf BARCODE scan (code + Enter) adds the exact variant
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
  sleep,
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
await waitFor(() => ux.dom.window.location.hash === "#/products", { label: "the save to land" });
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
await sleep(250);
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
await sleep(700);
assert.ok(!dialogs().length, "the variant form closed");
assert.equal(catalog().variants.find((v) => v.sku === SILVER_SKU)?.barcode, "6220100999117", "the shelf is labelled");
console.log("  ✓ seeded the two-shelf ring: Gold / 17 = 2, Silver / 17 = 2 (Silver carries a shelf barcode)");

// ── 1 · the till opens ──────────────────────────────────────────────────────
await navigate("#/shifts");
await waitFor(() => bodyText().includes("No shift is currently open"), { label: "a closed drawer" });
click("Open shift");
await sleep(400);
const shiftDialog = dialogs().at(-1);
const shiftInputs = [...shiftDialog.querySelectorAll("input")];
setInputValue(shiftInputs.find((i) => !i.readOnly && i.type === "text"), "Main branch");
setInputValue(shiftInputs.find((i) => i.inputMode === "decimal"), "100");
clickEl([...shiftDialog.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim() === "Open shift"));
await waitFor(() => /SH-\d{6}/.test(bodyText()), { label: "the shift to open" });

await navigate("#/pos", 700);
await waitFor(() => testid("pos-grid"), { label: "the product grid" });
await waitFor(() => testid("cash-input"), { label: "the sale panel's cash field" });
await waitFor(() => buttons().some((b) => (b.textContent ?? "").includes("Complete sale")), {
  label: "the complete-sale control",
});
console.log("  ✓ the till opens: grid + sale panel, ready to sell");

// ── 2 · search finds ────────────────────────────────────────────────────────
const searchBox = () => document.querySelector('input[aria-label="Search"]');
assert.ok(searchBox(), "the register search box exists");
setField('input[aria-label="Search"]', "UX2");
await sleep(450);
const visibleTiles = () => buttons().filter((b) => (b.textContent ?? "").includes("UX2 Ring"));
await waitFor(() => visibleTiles().length === 1, { label: "the search to isolate the ring" });
console.log("  ✓ search isolates the ring tile");

// ── 3 · category chips narrow the grid ──────────────────────────────────────
setField('input[aria-label="Search"]', "");
await sleep(350);
const chip = (label) =>
  buttons().find((b) => (b.getAttribute("data-testid") ?? "").startsWith("pos-category-chip-") && (b.textContent ?? "").trim() === label);
const allChip = document.querySelector('[data-testid="pos-category-chip-all"]');
assert.ok(allChip, "the All chip renders");
const tileCount = () => document.querySelectorAll("#pos-grid-grid, [data-testid='pos-grid'] button").length;
const beforeCount = tileCount();
const chips = buttons().filter((b) => (b.getAttribute("data-testid") ?? "").startsWith("pos-category-chip-"));
const targetChip = chips.find((b) => (b.textContent ?? "").trim() !== "All");
assert.ok(targetChip, "a real category chip renders");
const chipLabel = targetChip.textContent.trim();
clickEl(targetChip);
await sleep(400);
assert.ok(tileCount() !== beforeCount, `${chipLabel}: grid ${beforeCount} → ${tileCount()}`);
clickEl(chip("All") ?? allChip);
await sleep(350);
console.log(`  ✓ the ${chipLabel} chip narrows the grid`);

// ── 4 · the picker demands an exact shelf ───────────────────────────────────
const tileFor = (name) => buttons().find((b) => (b.textContent ?? "").includes(name));
await waitFor(() => tileFor("UX2 Ring"), { label: "the ring tile back on the grid" });
// the in-cart badge is the dark rounded chip on the tile's photo; status
// chips ("Out of stock") also render on the card, so scope to the dark one.
const cartBadge = () =>
  tileFor("UX2 Ring")?.querySelector("span.bg-stone-900")?.textContent ?? "0";
assert.equal(cartBadge(), "0", "nothing pre-selected");
clickEl(tileFor("UX2 Ring"));
const picker = () =>
  [...document.querySelectorAll('[role="dialog"]')].find((d) => (d.textContent ?? "").includes("Choose colour and size"));
await waitFor(() => picker(), { label: "the combination picker" });
assert.equal(cartBadge(), "0", "the picker opened instead of adding");
const sizeButton = (label) =>
  [...picker().querySelectorAll("button")].find((b) => (b.getAttribute("aria-label") ?? "").startsWith(`${label} — `));
assert.ok(!sizeButton("Silver / 17"), "the grid shows only the chosen colour's shelves");
assert.ok(sizeButton("Gold / 17"), "Gold / 17 is a shelf in the grid");
console.log("  ✓ no auto-add: the exact-shelf picker stands between tap and cart");

// ── 5 · Gold / 17 × 2 accepted ──────────────────────────────────────────────
clickEl(sizeButton("Gold / 17"));
await waitFor(() => !picker(), { label: "the picker to close after the first pick" });
await waitFor(() => cartBadge() === "1", { label: "the badge to count one" });
clickEl(tileFor("UX2 Ring"));
await waitFor(() => picker(), { label: "the picker again" });
clickEl(sizeButton("Gold / 17"));
await waitFor(() => cartBadge() === "2", { label: "the badge to count two" });
const cartLines = () => [...document.querySelectorAll('[data-testid^="cart-line-"]')];
await waitFor(() => cartLines().length === 1, { label: "one cart line" });
assert.ok(cartLines()[0].textContent.includes("Gold / 17"), "the line names the exact shelf");
console.log("  ✓ Gold / 17 × 2 accepted — the line names the shelf");

// ── 6 · the third Gold / 17 is refused ─────────────────────────────────────
clickEl(tileFor("UX2 Ring"));
await waitFor(() => picker(), { label: "the picker a third time" });
clickEl(sizeButton("Gold / 17"));
await sleep(500);
assert.ok(picker(), "the refused pick leaves the picker open — nothing was added");
assert.equal(cartBadge(), "2", "the THIRD Gold / 17 never reached the cart");
console.log("  ✓ the third Gold / 17 is refused (shelf = 2, the Phase 43 rule holds)");

// ── 7 · Silver / 17, a separate line ───────────────────────────────────────
const colorChip = (name) =>
  [...picker().querySelectorAll("button")].find(
    (b) => !(b.getAttribute("aria-label") ?? "").includes("—") && (b.textContent ?? "").includes(name),
  );
clickEl(colorChip("Silver"));
await sleep(250);
clickEl(sizeButton("Silver / 17"));
await waitFor(() => !picker(), { label: "the picker to close" });
await waitFor(() => cartLines().length === 2, { label: "two cart lines" });
assert.ok(cartLines().some((l) => l.textContent.includes("Gold / 17")), "line 1 stays Gold / 17");
assert.ok(cartLines().some((l) => l.textContent.includes("Silver / 17")), "line 2 is Silver / 17 — never merged");
console.log("  ✓ Silver / 17 is its own line — shelves never merge in the cart");

// ── 8 · attach a customer ───────────────────────────────────────────────────
await waitFor(() => document.querySelector('input[aria-label="Select customer"]'), {
  label: "the customer picker",
});
setField('input[aria-label="Select customer"]', "سارة");
await sleep(600);
const listbox = document.querySelector('[role="listbox"]');
assert.ok(listbox, "the picker's listbox is open");
const option = [...listbox.querySelectorAll("button")].find((b) => (b.textContent ?? "").includes("سارة"));
assert.ok(option, "the matching customer is offered");
// the options pick on mousedown (beating the input's blur) — press it like a
// finger, then require the at-rest input to show the chosen NAME, which only
// a real selection produces (the typed query would satisfy nothing)
option.dispatchEvent(new dom.window.MouseEvent("mousedown", { bubbles: true, cancelable: true }));
option.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
await sleep(300);
assert.equal(
  document.querySelector('input[aria-label="Select customer"]').value,
  "سارة المحمود",
  "the picker holds the chosen customer, not the typed query",
);
console.log("  ✓ the customer is attached to the sale");

// ── 9 · complete the sale through the existing flow ─────────────────────────
setField('[data-testid="cash-input"]', "500");
await sleep(250);
const completeBtn = buttons().find(
  (b) => (b.textContent ?? "").trim().startsWith("✓") && (b.textContent ?? "").includes("Complete sale"),
);
assert.ok(completeBtn && !completeBtn.disabled, "the sale is payable");
clickEl(completeBtn);
await waitFor(() => /INV-\d{6}/.test(bodyText()), { label: "the sale to complete" });
const receiptNo = (bodyText().match(/INV-\d{6}/) ?? [])[0];
assert.ok(receiptNo, `completed as ${receiptNo}`);
assert.ok(bodyText().includes("Change"), "change is computed against the cash tendered");
console.log("  ✓ the sale completes through the proven flow, with change");

// ── 10 · the receipt preserves the variants ────────────────────────────────
const printBtn = buttons().find((b) => (b.textContent ?? "").includes("Print receipt"));
assert.ok(printBtn, "the print action is on the confirmation");
clickEl(printBtn);
await sleep(800);
const receiptHtml = documentWrites.join("\n");
assert.ok(receiptHtml.includes("Gold / 17"), "the receipt line names Gold / 17");
assert.ok(receiptHtml.includes("Silver / 17"), "the receipt line names Silver / 17");
assert.ok(receiptHtml.includes(receiptNo), "the receipt carries the sale number");
console.log("  ✓ the printed receipt preserves both exact shelves");

// ── 11 · a shelf barcode scan adds the exact variant ────────────────────────
clickExact("New sale");
await sleep(400);
await waitFor(() => cartBadge() === "0", { label: "the fresh sale" });
const silver = catalog().variants.find((v) => v.sku === SILVER_SKU);
assert.ok(silver?.barcode, `Silver / 17 carries a barcode (${silver?.barcode})`);
setField('input[aria-label="Search"]', silver.barcode);
searchBox().dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
await sleep(600);
assert.ok(cartBadge() === "1", "the scan added exactly one unit");
await waitFor(() => cartLines().length === 1, { label: "one scanned line" });
assert.ok(cartLines()[0].textContent.includes("Silver / 17"), "the scan resolved Silver / 17 exactly");
console.log("  ✓ the shelf barcode scan adds Silver / 17 — never the rollup");

await navigate("#/");
await sleep(400);
ux.finish("POS UX");
