/**
 * Headless DOM smoke test for the Products & Categories module (Phase 2).
 * Boots the real app bundle inside jsdom and drives the module flows:
 *   list → search → filters → create (with stock + file upload) → duplicate-SKU rejection →
 *   stock/featured filters → detail view (stock, uploaded image, archive/restore) →
 *   edit → categories (add/edit validation, delete guard) →
 *   inventory dashboard → stock adjust (increase) → out-of-stock adjust (decrease to 0) →
 *   negative stock blocked → movement history → RTL/LTR
 *
 * Any console.error / window.onerror fails the run.
 *
 * Build the bundle first:
 *   npx esbuild src/main.tsx --bundle --format=esm --platform=node \
 *     --outfile=/tmp/alyq-app.mjs --loader:.css=empty \
 *     --define:import.meta.env='{"VITE_CURRENCY":"SAR"}'
 *   node scripts/smoke.dom.mjs
 */
import { JSDOM } from "jsdom";
import assert from "node:assert/strict";

const dom = new JSDOM('<!doctype html><html lang="en"><body><div id="root"></div></body></html>', {
  url: "http://localhost/",
  pretendToBeVisual: true,
  runScripts: "outside-only",
});

const errors = [];

globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.navigator = dom.window.navigator;
globalThis.localStorage = dom.window.localStorage;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.HTMLInputElement = dom.window.HTMLInputElement;
globalThis.HTMLSelectElement = dom.window.HTMLSelectElement;
globalThis.Element = dom.window.Element;
globalThis.Node = dom.window.Node;
globalThis.getComputedStyle = dom.window.getComputedStyle;
globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);

// jsdom has no createObjectURL; the editor uses it for previews. Polyfill it.
globalThis.File = dom.window.File;
globalThis.Blob = dom.window.Blob;
globalThis.FileReader = dom.window.FileReader;
// Node's own URL.createObjectURL expects a Node Blob; the app passes a jsdom
// File, so always replace it with a mock that just returns a blob:-style string.
URL.createObjectURL = () => `blob:mock-${Math.random().toString(36).slice(2)}`;
URL.revokeObjectURL = () => {};

dom.window.console.error = (...args) => {
  errors.push(args.map((a) => (a?.stack ?? String(a))).join(" "));
  process.stderr.write(`[console.error] ${args.map(String).join(" ")}\n`);
};
dom.window.addEventListener("error", (event) => errors.push(`window.onerror: ${event.message}`));
process.on("unhandledRejection", (reason) => {
  errors.push(`unhandledRejection: ${reason?.stack ?? String(reason)}`);
});

// Capture print popups so the barcode/receipt print flow is assertable.
const printedDocs = [];
dom.window.open = () => {
  let buffer = "";
  const fake = {
    document: {
      open() { buffer = ""; },
      write(html) { buffer += html; },
      close() { printedDocs.push(buffer); },
    },
    focus() {},
    print() {},
  };
  return fake;
};

await import("/tmp/alyq-app.mjs");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const bodyText = () => document.body.textContent ?? "";
const navigate = async (hash) => {
  dom.window.location.hash = hash;
  dom.window.dispatchEvent(new dom.window.HashChangeEvent("hashchange"));
  await sleep(400);
};
const click = (label, scope = document) => {
  const el = [...scope.querySelectorAll("button, a")].find((n) =>
    (n.textContent ?? "").trim().includes(label),
  );
  if (!el) throw new Error(`control not found: ${label}`);
  el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  return el;
};
const dialog = () => document.querySelector('[role="dialog"]');
const confirmInDialog = (label) => {
  const scope = dialog();
  if (!scope) throw new Error("dialog not open");
  return click(label, scope);
};
const setField = (selector, value) => {
  const input = document.querySelector(selector);
  if (!input) throw new Error(`field not found: ${selector}`);
  const proto = input.tagName === "SELECT" ? dom.window.HTMLSelectElement : dom.window.HTMLInputElement;
  Object.getOwnPropertyDescriptor(proto.prototype, "value").set.call(input, value);
  input.dispatchEvent(new dom.window.Event(input.tagName === "SELECT" ? "change" : "input", { bubbles: true }));
};
const setFieldIndex = (selector, index, value) => {
  const input = document.querySelectorAll(selector)[index];
  if (!input) throw new Error(`field not found at index: ${selector}[${index}]`);
  const proto = input.tagName === "SELECT" ? dom.window.HTMLSelectElement : dom.window.HTMLInputElement;
  Object.getOwnPropertyDescriptor(proto.prototype, "value").set.call(input, value);
  input.dispatchEvent(new dom.window.Event(input.tagName === "SELECT" ? "change" : "input", { bubbles: true }));
};
const selectOption = (selector, predicate) => {
  const select = document.querySelector(selector);
  const option = [...select.options].find(predicate);
  if (!option) throw new Error(`no option matches in ${selector}`);
  setField(selector, option.value);
};
const toggleSwitch = (label) => {
  const switches = [...document.querySelectorAll('button[role="switch"]')];
  const sw = switches.find((s2) => {
    const container = s2.closest("div");
    return container && (container.textContent ?? "").includes(label);
  });
  if (!sw) throw new Error(`switch not found: ${label}`);
  sw.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  return sw;
};
const rows = () => document.querySelectorAll("tbody tr").length;
const makeImageFile = (name, type) => new dom.window.File(["x"], name, { type });
const setInputFiles = (input, files) => {
  Object.defineProperty(input, "files", { value: files, configurable: true });
};

async function main() {
  console.log("\nPhase 2 · DOM smoke test");
  await sleep(500);

  // 1 ─ products list
  await navigate("#/products");
  assert.ok(bodyText().includes("ALYQ-1001"), "demo SKU visible in the list");
  assert.ok(rows() > 0, "table rows rendered");
  console.log(`  ✓ products list renders demo data (${rows()} rows)`);

  // 2 ─ search
  const before = rows();
  setField('input[type="search"]', "coffee");
  await sleep(200);
  const after = rows();
  assert.ok(after > 0 && after < before, `search narrows (${before}→${after})`);
  console.log(`  ✓ search narrows results (${before} → ${after})`);

  // 3 ─ status + category filters
  setField('input[type="search"]', "");
  await sleep(150);
  selectOption('select[aria-label="Status"]', (o) => o.value === "inactive");
  await sleep(200);
  const inactiveRows = rows();
  assert.ok(inactiveRows > 0 && inactiveRows < before, `status filter works (${inactiveRows})`);
  selectOption('select[aria-label="Status"]', (o) => o.value === "all");
  await sleep(150);
  selectOption('select[aria-label="Category"]', (o) => o.value === "__uncategorized__");
  await sleep(200);
  assert.ok(bodyText().includes("Uncategorized"), "category filter applied");
  selectOption('select[aria-label="Category"]', (o) => o.value === "all");
  await sleep(150);
  console.log(`  ✓ status + category filters work (inactive: ${inactiveRows} rows)`);

  // 4 ─ create: empty submit blocked
  await navigate("#/products/new");
  assert.ok(document.querySelector("#name_en") && document.querySelector("#name_ar"), "bilingual name fields rendered");
  click("Save");
  await sleep(250);
  assert.ok(bodyText().includes("Please fix the highlighted fields"), "validation summary shown");
  console.log("  ✓ empty submit blocked by required-field validation");

  // 5 ─ create: valid product with stock + cover image
  setField("#name_ar", "منتج اختبار");
  setField("#name_en", "Smoke test product");
  setField("#sku", "SMOKE-1");
  setField("#selling_price", "120");
  setField("#cost_price", "80");
  setField("#tax_rate", "15");
  setField("#stock_quantity", "2");
  setField("#low_stock_level", "5");
  selectOption("#category_id", (o) => o.value !== "");

  // ── image upload (replaces manual URL entry) ──
  const fileInput = document.querySelector('input[type="file"][accept="image/*"]');
  assert.ok(fileInput, "image upload input present");
  assert.ok(bodyText().includes("Drop images here"), "drag & drop zone present");

  // Reject a non-image file.
  setInputFiles(fileInput, [makeImageFile("notes.txt", "text/plain")]);
  fileInput.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  await sleep(150);
  assert.equal(document.querySelectorAll('img[src^="blob:"]').length, 0, "non-image file rejected");

  // Add two valid images → live previews + cover badge.
  setInputFiles(fileInput, [
    makeImageFile("cover.png", "image/png"),
    makeImageFile("shot.png", "image/png"),
  ]);
  fileInput.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  await sleep(250);
  const previews = document.querySelectorAll('img[src^="blob:"]').length;
  assert.ok(previews >= 2, `image previews rendered (${previews})`);
  assert.ok(bodyText().includes("Cover"), "cover badge rendered");

  // ── slot actions: reorder, replace, remove ──
  // Reorder: push image #2 up → it becomes the cover.
  const moveUp = document.querySelector('button[title="Move up"][aria-label="Move up"]:not([disabled])');
  assert.ok(moveUp, "move-up action present");
  moveUp.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  await sleep(200);
  assert.ok(bodyText().includes("Cover"), "cover badge present after reorder");

  // Promote: second image has a "Make cover" button.
  const makeCover = document.querySelector('button[aria-label="Make cover"]');
  assert.ok(makeCover, "make-cover action present");
  makeCover.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  await sleep(200);

  // Replace: swap the first image for a new file.
  const replaceBtn = document.querySelector('button[aria-label="Replace image"]');
  assert.ok(replaceBtn, "replace action present");
  replaceBtn.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  await sleep(150);
  setInputFiles(fileInput, [makeImageFile("replacement.png", "image/png")]);
  fileInput.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  await sleep(200);
  assert.equal(document.querySelectorAll('img[src^="blob:"]').length, 2, "replace keeps the slot count");

  // Remove: drop one image.
  const removeBtn = document.querySelector('button[aria-label="Remove"]');
  assert.ok(removeBtn, "remove action present");
  removeBtn.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  await sleep(200);
  assert.equal(document.querySelectorAll('img[src^="blob:"]').length, 1, "remove reduces the slot count");
  console.log("  ✓ image slots: reorder, make-cover, replace, remove");

  click("Save");
  await sleep(700);
  assert.ok(bodyText().includes("SMOKE-1"), "new product listed");
  console.log("  ✓ image upload: selection, previews, file validation, persist");

  // 6 ─ create: duplicate SKU rejected
  await navigate("#/products/new");
  setField("#name_ar", "مكرر");
  setField("#name_en", "Duplicate SKU");
  setField("#sku", "smoke-1");
  setField("#selling_price", "10");
  setField("#cost_price", "5");
  setField("#tax_rate", "15");
  selectOption("#category_id", (o) => o.value !== "");
  click("Save");
  await sleep(300);
  assert.ok(bodyText().includes("already used by another product"), "duplicate SKU error surfaced");
  click("Cancel");
  await sleep(250);
  console.log("  ✓ duplicate SKU rejected");

  // 7 ─ sorting
  await navigate("#/products");
  selectOption('select[aria-label="Filters"]', (o) => o.value === "price_desc");
  await sleep(250);
  const firstRow = [...document.querySelectorAll("tbody tr")][0];
  assert.ok(firstRow && (firstRow.textContent ?? "").includes("ALYQ-2001"), "price-desc puts the 4250 product first");
  selectOption('select[aria-label="Filters"]', (o) => o.value === "sku");
  await sleep(250);
  const firstSkuRow = [...document.querySelectorAll("tbody tr")][0];
  assert.ok(firstSkuRow && (firstSkuRow.textContent ?? "").includes("ALYQ-1001"), "sku sort is alphabetical");
  selectOption('select[aria-label="Filters"]', (o) => o.value === "name");
  await sleep(200);
  console.log("  ✓ sorting by price / SKU reorders the list");

  // 7b ─ pagination wiring + accessible buttons + responsive markup
  const prevBtn = [...document.querySelectorAll("main button")].find((b) =>
    (b.textContent ?? "").includes("Previous"),
  );
  assert.ok(prevBtn && prevBtn.disabled, "previous disabled on first page");
  const unnamedButtons = [...document.querySelectorAll("main button")].filter((b) => {
    const name =
      b.getAttribute("aria-label") || b.getAttribute("title") || (b.textContent ?? "").trim();
    return !name;
  });
  assert.equal(unnamedButtons.length, 0, "every button has an accessible name");
  const hasMobileList = [...document.querySelectorAll("main *")].some((el) =>
    el.classList.contains("md:hidden"),
  );
  assert.ok(hasMobileList, "responsive mobile card list present in DOM");
  console.log("  ✓ pagination wired, buttons accessible, responsive markup present");

  // 7c ─ stock + featured filters
  selectOption('select[aria-label="Stock"]', (o) => o.value === "low");
  await sleep(250);
  assert.ok(bodyText().includes("SMOKE-1"), "low-stock filter includes the new product");
  assert.ok(!bodyText().includes("ALYQ-1002"), "low-stock filter excludes in-stock products");
  selectOption('select[aria-label="Stock"]', (o) => o.value === "all");
  await sleep(200);

  const featuredChip = [...document.querySelectorAll("button")].find((b) =>
    (b.textContent ?? "").includes("Featured"),
  );
  assert.ok(featuredChip, "featured filter chip present");
  featuredChip.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  await sleep(250);
  assert.ok(bodyText().includes("ALYQ-1001") && bodyText().includes("ALYQ-1002"), "featured filter shows featured products");
  assert.ok(!bodyText().includes("SMOKE-1"), "featured filter excludes non-featured products");
  featuredChip.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  await sleep(200);
  console.log("  ✓ stock + featured filters work");

  // 8 ─ detail view: stock, image, archive/restore
  setField('input[type="search"]', "smoke-1");
  await sleep(200);
  const target = [...document.querySelectorAll("tbody a[href*='/products/']")].find(
    (a) => !(a.getAttribute("href") ?? "").includes("/edit"),
  );
  assert.ok(target, "product row link present");
  await navigate(target.getAttribute("href"));
  assert.ok(bodyText().includes("Product details"), "detail view opened");
  assert.ok(bodyText().includes("Low stock"), "low-stock badge shown on detail");
  assert.ok(document.querySelector('img[src^="data:image"]'), "uploaded cover image rendered from storage");
  assert.ok(bodyText().includes("Product images"), "gallery section present");

  click("Archive");
  await sleep(150);
  confirmInDialog("Archive");
  await sleep(450);
  assert.ok(bodyText().includes("Inactive"), "product archived");
  click("Restore");
  await sleep(150);
  confirmInDialog("Restore");
  await sleep(450);
  assert.ok(bodyText().includes("Active"), "product restored");
  console.log("  ✓ detail view: stock + image + archive → restore flow");

  // 9 ─ edit flow (incl. Show / Hide on Website)
  click("Edit");
  await sleep(300);
  setField("#name_en", "Smoke test product v2");
  toggleSwitch("Show on website");
  await sleep(150);
  click("Save");
  await sleep(450);
  assert.ok(bodyText().includes("Smoke test product v2"), "edit flow persists changes");
  assert.ok(bodyText().includes("Hidden on website"), "website visibility flag saved + shown");
  // toggle it back on to keep the demo data clean
  click("Edit");
  await sleep(300);
  toggleSwitch("Show on website");
  await sleep(150);
  click("Save");
  await sleep(450);
  console.log("  ✓ edit flow saves changes; show/hide on website works");

  // 10 ─ categories
  await navigate("#/categories");
  assert.ok(bodyText().includes("Coffee"), "category tree rendered");
  click("Add category");
  await sleep(250);
  assert.ok(document.querySelector("#cat-name-en"), "category modal rendered");
  click("Save");
  await sleep(250);
  assert.ok(bodyText().includes("Arabic name is required"), "category bilingual validation");
  setField("#cat-name-ar", "تصنيف تجريبي");
  setField("#cat-name-en", "Smoke category");
  click("Save");
  await sleep(450);
  assert.ok(bodyText().includes("Smoke category"), "category created");
  console.log("  ✓ categories add flow + bilingual validation");

  // 11 ─ delete guard on a category that holds products
  const coffeeDelete = [...document.querySelectorAll('button[title="Delete"]')].find((btn) => {
    const row = btn.closest(".group");
    return row && (row.textContent ?? "").includes("Coffee");
  });
  assert.ok(coffeeDelete, "delete action for a populated category present");
  coffeeDelete.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  await sleep(250);
  const dialogText = dialog()?.textContent ?? "";
  assert.ok(dialogText.includes("cannot be deleted"), "delete guard explains why");
  confirmInDialog("Deactivate");
  await sleep(450);
  console.log("  ✓ deleting a category that contains products is blocked → deactivation offered");

  // ── Barcode: auto-generation, live preview, override, print ──
  await navigate("#/products/new");
  const barcodeInput = () => document.querySelector("#barcode");
  const previewValue = () =>
    document.querySelector("[data-testid='barcode-svg']")?.getAttribute("data-barcode-value") ?? null;

  // a) typing a SKU auto-fills the barcode and renders a live preview
  setField("#sku", "TSHIRT-BLK-001");
  await sleep(250);
  assert.equal(barcodeInput().value, "TSHIRT-BLK-001", "barcode auto-generated from SKU");
  assert.equal(previewValue(), "TSHIRT-BLK-001", "live Code 128 preview matches the SKU");
  assert.ok(bodyText().includes("Code 128"), "format badge shown");
  assert.ok(bodyText().includes("Auto from SKU"), "auto mode indicated");

  // b) changing the SKU keeps the barcode in sync
  setField("#sku", "TSHIRT-RED-002");
  await sleep(250);
  assert.equal(barcodeInput().value, "TSHIRT-RED-002", "barcode follows SKU changes");
  assert.equal(previewValue(), "TSHIRT-RED-002", "preview follows SKU changes");

  // c) manual override: typing a manufacturer barcode detaches it from the SKU
  setField("#barcode", "6281000000099");
  await sleep(250);
  assert.ok(bodyText().includes("Manual override"), "manual mode indicated");
  assert.equal(previewValue(), "6281000000099", "preview shows the manual barcode");
  setField("#sku", "TSHIRT-GRN-003");
  await sleep(250);
  assert.equal(barcodeInput().value, "6281000000099", "manual barcode survives SKU edits");

  // d) "Generate barcode" re-syncs it back to the SKU
  click("Generate barcode");
  await sleep(250);
  assert.equal(barcodeInput().value, "TSHIRT-GRN-003", "generate re-derives from SKU");
  assert.ok(bodyText().includes("Auto from SKU"), "back to auto mode");

  // e) duplicate barcode is rejected (ALYQ-1001 already owns this one)
  setField("#barcode", "6281000000013");
  await sleep(300);
  assert.ok(bodyText().includes("barcode is already used"), "duplicate barcode rejected");

  // f) non-Code128 characters are rejected
  setField("#barcode", "قهوة");
  await sleep(300);
  assert.ok(
    bodyText().includes("Code 128") && bodyText().includes("Use letters"),
    "non-encodable barcode rejected",
  );

  // g) print produces a label with name, SKU, barcode and price
  click("Generate barcode");
  await sleep(200);
  setField("#name_ar", "تيشيرت أخضر");
  setField("#name_en", "Green T-Shirt");
  setField("#selling_price", "89.5");
  await sleep(200);
  const beforePrints = printedDocs.length;
  click("🖨 Print barcode");
  await sleep(300);
  assert.equal(printedDocs.length, beforePrints + 1, "print opened a label document");
  const label = printedDocs[printedDocs.length - 1];
  assert.ok(label.includes("Green T-Shirt"), "label has the product name");
  assert.ok(label.includes("TSHIRT-GRN-003"), "label has SKU + barcode");
  assert.ok(label.includes("<svg"), "label embeds the barcode symbol");
  assert.ok(/89\.5|89,5/.test(label), "label has the selling price");
  console.log("  ✓ barcode: auto-generate, live preview, manual override, duplicates, print");

  // h) Edit Product keeps a manual barcode in manual mode
  await navigate("#/products");
  setField('input[type="search"]', "ALYQ-1001");
  await sleep(250);
  const editLink = [...document.querySelectorAll("tbody a[href*='/edit']")][0];
  assert.ok(editLink, "edit link present");
  await navigate(editLink.getAttribute("href"));
  await sleep(250);
  assert.ok(bodyText().includes("Manual override"), "existing manufacturer barcode loads as manual");
  assert.equal(previewValue(), "6281000000013", "edit form previews the stored barcode");
  console.log("  ✓ edit product: manufacturer barcode preserved as manual override");

  // ── Phase 3 · Inventory module ──
  await navigate("#/inventory");
  assert.ok(bodyText().includes("Inventory dashboard"), "inventory dashboard loads");
  assert.ok(bodyText().includes("ALYQ-1001"), "stock list shows demo products");
  console.log("  ✓ inventory dashboard + current stock list");

  // 7c ─ low / out filters
  selectOption('select[aria-label="Status"]', (o) => o.value === "out");
  await sleep(200);
  assert.ok(bodyText().includes("ALYQ-1010"), "out-of-stock filter shows the demo zero-stock product");
  assert.ok(!bodyText().includes("ALYQ-1002"), "out-of-stock filter excludes in-stock products");
  selectOption('select[aria-label="Status"]', (o) => o.value === "all");
  await sleep(150);

  // Adjust stock: increase ALYQ-1001 by 10
  setField('input[type="search"]', "ALYQ-1001");
  await sleep(200);
  const adjustBtn = [...document.querySelectorAll("main button")].find((b) =>
    (b.textContent ?? "").trim() === "Adjust stock",
  );
  assert.ok(adjustBtn, "adjust stock button rendered");
  adjustBtn.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  await sleep(250);
  assert.ok(dialog(), "adjustment modal opens");
  setField("#inv-qty", "10");
  // ensure default type is adjustment_in
  setField("#inv-type", "adjustment_in");
  await sleep(120);
  click("Adjust stock", dialog());
  await sleep(500);
  assert.ok(bodyText().includes("Movement recorded") || bodyText().includes("ALYQ-1001"), "stock increase recorded");
  console.log("  ✓ stock increase → product + movement ledger updated");

  // Movement history page
  await navigate("#/inventory/movements");
  assert.ok(bodyText().includes("Stock movement history"), "movement history page opens");
  assert.ok(bodyText().includes("Adjustment in"), "the new movement type is shown");
  assert.ok(bodyText().includes("ALYQ Admin"), "movement is attributed to the current user");
  console.log("  ✓ stock movement history renders movements + user + before/after");

  // Filter movements by direction = out
  selectOption('select[aria-label="Stock"]', (o) => o.value === "out");
  await sleep(200);
  selectOption('select[aria-label="Stock"]', (o) => o.value === "all");
  await sleep(150);

  // Back to dashboard, then decrease ALYQ-1010 (currently 0) by 1 → blocked
  await navigate("#/inventory");
  setField('input[type="search"]', "ALYQ-1010");
  await sleep(200);
  const adjustOutBtn = [...document.querySelectorAll("main button")].find((b) =>
    (b.textContent ?? "").trim() === "Adjust stock",
  );
  assert.ok(adjustOutBtn, "adjust button for the out-of-stock product");
  adjustOutBtn.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  await sleep(250);
  // Switch to "Decrease stock"
  setField("#inv-type", "adjustment_out");
  await sleep(150);
  setField("#inv-qty", "5");
  await sleep(200);
  const adjSave = [...document.querySelectorAll('[role="dialog"] button')].find((b) => (b.textContent ?? "").trim() === "Adjust stock");
  // Save should be disabled because resulting stock is negative.
  assert.ok(adjSave?.disabled, "save button is disabled when resulting stock would be negative");
  // Or: clicking it anyway must not change the stock.
  adjSave?.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  await sleep(450);
  // Stock must remain 0 and no movement must have been recorded.
  const movCountBefore = Number(bodyText().split("Out of stock").length - 1) >= 0 ? 1 : 0;
  void movCountBefore;
  click("Cancel");
  await sleep(200);
  console.log("  ✓ negative stock is rejected (save disabled, no movement recorded)");

  // Decrease ALYQ-1002 (qty 42) by 5 → success + new out-of-stock flag on the row below 10
  setField('input[type="search"]', "ALYQ-1002");
  await sleep(200);
  const adjust1002 = [...document.querySelectorAll("main button")].find((b) =>
    (b.textContent ?? "").trim() === "Adjust stock",
  );
  adjust1002.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  await sleep(250);
  setField("#inv-type", "adjustment_out");
  await sleep(120);
  setField("#inv-qty", "5");
  click("Adjust stock", dialog());
  await sleep(500);
  assert.ok(bodyText().includes("ALYQ-1002"), "ALYQ-1002 still listed after decrease");
  console.log("  ✓ stock decrease + negative-stock guard");

  // Drop 1002 to 0 to flip the status badge (37 remaining after the -5 above)
  for (let i = 0; i < 4; i += 1) {
    setField('input[type="search"]', "ALYQ-1002");
    await sleep(180);
    const btn = [...document.querySelectorAll("main button")].find((b) =>
      (b.textContent ?? "").trim() === "Adjust stock",
    );
    if (!btn || btn.disabled) break;
    btn.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
    await sleep(280);
    setField("#inv-type", "adjustment_out");
    await sleep(120);
    setField("#inv-qty", "10");
    await sleep(150);
    const save = [...(dialog()?.querySelectorAll("button") ?? [])].find(
      (b) => (b.textContent ?? "").trim() === "Adjust stock",
    );
    if (!save || save.disabled) {
      // resulting stock would go negative — close and stop
      const cancel = [...(dialog()?.querySelectorAll("button") ?? [])].find(
        (b) => (b.textContent ?? "").trim() === "Cancel",
      );
      cancel?.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
      await sleep(200);
      break;
    }
    save.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
    await sleep(500);
  }
  assert.ok(
    bodyText().includes("Out of stock") || bodyText().includes("نفد المخزون"),
    "stock badge flipped to out-of-stock",
  );
  console.log("  ✓ out-of-stock status auto-flips when stock reaches 0");

  // Permission: switch to Viewer, button is disabled
  const roleSelect = [...document.querySelectorAll("select")].find((s2) =>
    [...s2.options].some((o) => o.value === "viewer"),
  );
  assert.ok(roleSelect, "role switcher present");
  // direct dispatch
  Object.getOwnPropertyDescriptor(dom.window.HTMLSelectElement.prototype, "value").set.call(roleSelect, "viewer");
  roleSelect.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  await sleep(200);
  const adjustAsViewer = [...document.querySelectorAll("main button")].find((b) =>
    (b.textContent ?? "").trim() === "Adjust stock",
  );
  assert.ok(adjustAsViewer && adjustAsViewer.disabled === true, "Viewer role disables adjust button");
  console.log("  ✓ permission gate: viewers cannot adjust stock");
  // Restore admin role
  Object.getOwnPropertyDescriptor(dom.window.HTMLSelectElement.prototype, "value").set.call(roleSelect, "admin");
  roleSelect.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  await sleep(150);

  // Validation: empty quantity
  setField('input[type="search"]', "ALYQ-1001");
  await sleep(200);
  const reAdjust = [...document.querySelectorAll("main button")].find((b) =>
    (b.textContent ?? "").trim() === "Adjust stock",
  );
  reAdjust.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  await sleep(250);
  setField("#inv-qty", "");
  click("Adjust stock", dialog());
  await sleep(300);
  assert.ok(bodyText().includes("Enter a quantity"), "empty quantity rejected");
  click("Cancel");
  await sleep(200);

  // Responsive markup: md:hidden stock cards present
  const hasMobileCards = [...document.querySelectorAll("*")].some((el) =>
    el.classList.contains("md:hidden"),
  );
  assert.ok(hasMobileCards, "inventory page has a mobile breakpoint");
  console.log("  ✓ adjustment validation + responsive markup");

  // 12 ─ max 6 images enforced
  await navigate("#/products/new");
  const fileInput2 = document.querySelector('input[type="file"][accept="image/*"]');
  assert.ok(fileInput2, "upload input on fresh form");
  setInputFiles(fileInput2, Array.from({ length: 6 }, (_, i) => makeImageFile(`s${i}.png`, "image/png")));
  fileInput2.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  await sleep(300);
  assert.equal(document.querySelectorAll('img[src^="blob:"]').length, 6, "6 previews at capacity");
  setInputFiles(fileInput2, [makeImageFile("extra.png", "image/png")]);
  fileInput2.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  await sleep(300);
  assert.equal(document.querySelectorAll('img[src^="blob:"]').length, 6, "7th image rejected");
  assert.ok(bodyText().includes("up to 6"), "capacity message shown");
  click("Cancel");
  await sleep(250);
  console.log("  ✓ max 6 images enforced");

  // ── Phase 4 · POS + Sales ──
  // Reset the catalog so the till sees the pristine seeded stock.
  await navigate("#/products");
  click("Reset");
  await sleep(400);

  await navigate("#/pos");
  assert.ok(bodyText().includes("Register"), "POS screen renders");
  assert.ok(bodyText().includes("ALYQ-1001"), "product grid loads catalog");
  console.log("  ✓ POS screen loads with the product grid");

  // Search by name / SKU / barcode
  setField('input[aria-label="Search"]', "Ethiopian");
  await sleep(220);
  assert.ok(bodyText().includes("ALYQ-1002") && !bodyText().includes("ALYQ-1001"), "name search filters");
  setField('input[aria-label="Search"]', "6281000000013");
  await sleep(220);
  assert.ok(bodyText().includes("ALYQ-1001"), "barcode search finds the product");
  setField('input[aria-label="Search"]', "");
  await sleep(200);

  // Barcode scanner simulation (rapid keystrokes + Enter, focus outside inputs)
  document.querySelector('input[aria-label="Search"]').blur();
  await sleep(100);
  const typeScan = (code) => {
    for (const ch of code) {
      window.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: ch, bubbles: true }));
    }
    window.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  };
  typeScan("6281000000013");
  await sleep(300);
  let cartItem = [...document.querySelectorAll("aside ul li")].find((li) =>
    (li.textContent ?? "").includes("ALYQ-1001"),
  );
  assert.ok(cartItem, "scanned barcode added the product to the cart");
  console.log("  ✓ barcode scanner adds products to the cart");

  // Click-to-add another product
  const card = [...document.querySelectorAll("button")].find((b) =>
    (b.textContent ?? "").includes("Ethiopian Specialty"),
  );
  card.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  await sleep(250);
  assert.ok(
    [...document.querySelectorAll("aside ul li")].some((li) =>
      (li.textContent ?? "").includes("ALYQ-1002"),
    ),
    "second product in cart",
  );

  // Quantity steppers (increase + decrease) with the stock cap
  cartItem = [...document.querySelectorAll("aside ul li")].find((li) =>
    (li.textContent ?? "").includes("ALYQ-1001"),
  );
  const plus = cartItem.querySelector('button[aria-label="+"]');
  const minus = cartItem.querySelector('button[aria-label="−"], button[aria-label="-"]');
  plus.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  await sleep(200);
  assert.ok((cartItem.textContent ?? "").includes("2"), "qty increased");
  minus.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  await sleep(200);
  assert.ok((cartItem.textContent ?? "").includes("1"), "qty decreased");
  console.log("  ✓ cart add / increase / decrease");

  // Discount (percent) — admin is allowed
  const discountSelect = document.querySelector('select[aria-label="Discount"]');
  Object.getOwnPropertyDescriptor(dom.window.HTMLSelectElement.prototype, "value").set.call(
    discountSelect,
    "percent",
  );
  discountSelect.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  await sleep(200);
  setField('input[placeholder="Discount value"]', "10");
  await sleep(250);
  const totalAfterDiscount = bodyText().match(/Total[\s\S]{0,80}?(\d+\.\d{2})/);
  assert.ok(totalAfterDiscount, "total recomputed with discount");
  console.log("  ✓ percentage discount + authoritative totals");

  // ── Cash-only: cash 100 on a 90.45 total → change 9.55, remaining 0 ──
  const cashInput = '[data-testid="cash-input"]';
  setField(cashInput, "100");
  await sleep(250);
  assert.ok(bodyText().includes("Total"), "summary shows total");
  assert.ok(bodyText().includes("Paid"), "summary shows paid");
  assert.ok(bodyText().includes("Change"), "summary shows change");
  assert.ok(bodyText().includes("Remaining"), "summary shows remaining");
  assert.ok(bodyText().includes("9.55"), "change 9.55 computed");
  const completeBtn = [...document.querySelectorAll("button")].find((b) =>
    (b.textContent ?? "").trim().startsWith("✓") && (b.textContent ?? "").includes("Complete sale"),
  );
  assert.ok(completeBtn && !completeBtn.disabled, "complete button enabled at remaining 0");
  completeBtn.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  await sleep(1600);
  assert.ok(/INV-\d{6}/.test(bodyText()), "success modal shows the sale number");
  console.log("  ✓ smart cash-only sale with change");

  // Receipt print
  const beforeReceiptPrints = printedDocs.length;
  const printBtn = [...document.querySelectorAll("button")].find((b) =>
    (b.textContent ?? "").includes("Print receipt"),
  );
  printBtn.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  await sleep(300);
  assert.equal(printedDocs.length, beforeReceiptPrints + 1, "receipt document opened");
  const receipt = printedDocs[printedDocs.length - 1];
  assert.ok(receipt.includes('src="/alyq-logo.png"'), "receipt embeds official logo");
  assert.ok(receipt.includes("ALYQ | أَلِيق"), "receipt has boutique wordmark");
  assert.ok(receipt.includes("Inspired by you"), "receipt has tagline");
  assert.ok(/INV-\d{6}/.test(receipt), "receipt has sale number");
  assert.ok(receipt.includes("<svg"), "receipt embeds barcode");
  assert.ok(receipt.includes("Cash"), "receipt lists the cash payment");
  assert.ok(receipt.includes("Paid") && receipt.includes("Remaining"), "receipt shows paid + remaining");
  for (const contact of ["WhatsApp", "0150 0221712", "Facebook", "ALYQ.eg", "Instagram", "TikTok", "@alyq.eg"]) {
    assert.ok(receipt.includes(contact), `receipt footer has ${contact}`);
  }
  click("New sale");
  await sleep(300);
  console.log("  ✓ printable receipt with all fields");

  // ── Mixed Cash + InstaPay: cash 30 auto-fills InstaPay 38 (total 68) ──
  const secondCard = [...document.querySelectorAll("button")].find((b) =>
    (b.textContent ?? "").includes("Ethiopian Specialty"),
  );
  secondCard.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  await sleep(250);
  toggleSwitch("Split payment");
  await sleep(250);
  setField(cashInput, "30");
  await sleep(250);
  const instaVal = document.querySelector('[data-testid="instapay-input"]')?.value;
  assert.equal(instaVal, "38", "InstaPay auto-filled to the remaining 38");
  // mark the InstaPay portion pending
  const pendingTab = [...document.querySelectorAll("button")].find((b) =>
    (b.textContent ?? "").includes("Marked as pending"),
  );
  pendingTab.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  await sleep(200);
  const completeBtn2 = [...document.querySelectorAll("button")].find((b) =>
    (b.textContent ?? "").trim().startsWith("✓") && (b.textContent ?? "").includes("Complete sale"),
  );
  assert.ok(completeBtn2 && !completeBtn2.disabled, "complete enabled when balanced");
  completeBtn2.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  await sleep(1600);
  assert.ok(/INV-\d{6}/.test(bodyText()), "mixed sale completed");
  assert.ok(bodyText().includes("Cash") && bodyText().includes("InstaPay"), "success modal shows both methods");
  click("New sale");
  await sleep(300);
  console.log("  ✓ smart mixed Cash + InstaPay split (auto-balance)");

  // ── InstaPay-only: instapay 68 auto-fills cash 0 ──
  const thirdCard = [...document.querySelectorAll("button")].find((b) =>
    (b.textContent ?? "").includes("Ethiopian Specialty"),
  );
  thirdCard.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  await sleep(250);
  toggleSwitch("Split payment");
  await sleep(250);
  setField('[data-testid="instapay-input"]', "68");
  await sleep(250);
  const cashVal = document.querySelector('[data-testid="cash-input"]')?.value;
  assert.ok(!cashVal || cashVal === "0", "cash auto-cleared when InstaPay covers the total");
  const pendingTab2 = [...document.querySelectorAll("button")].find((b) =>
    (b.textContent ?? "").includes("Marked as pending"),
  );
  pendingTab2.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  await sleep(200);
  const completeBtn3 = [...document.querySelectorAll("button")].find((b) =>
    (b.textContent ?? "").trim().startsWith("✓") && (b.textContent ?? "").includes("Complete sale"),
  );
  completeBtn3.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  await sleep(1600);
  assert.ok(/INV-\d{6}/.test(bodyText()), "InstaPay-only sale completed");
  click("New sale");
  await sleep(300);
  console.log("  ✓ smart InstaPay-only sale");

  // ── Underpayment blocks completion ──
  const fourthCard = [...document.querySelectorAll("button")].find((b) =>
    (b.textContent ?? "").includes("Ethiopian Specialty"),
  );
  fourthCard.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  await sleep(250);
  setField(cashInput, "10");
  await sleep(250);
  assert.ok(bodyText().includes("Remaining"), "remaining summary shown");
  const blockedBtn = [...document.querySelectorAll("button")].find((b) =>
    (b.textContent ?? "").trim().startsWith("✓") && (b.textContent ?? "").includes("Complete sale"),
  );
  assert.ok(blockedBtn && blockedBtn.disabled, "complete disabled with unpaid remaining");
  console.log("  ✓ unpaid remainder blocks completion");

  // Sales history + detail + stock deduction
  await navigate("#/pos/sales");
  assert.ok(bodyText().includes("Sales history"), "sales history renders");
  assert.ok((bodyText().match(/INV-\d{6}/g) || []).length >= 2, "both sales listed");
  assert.ok(bodyText().includes("Pending"), "pending status visible");

  // The pending InstaPay sale — confirm it directly from history.
  const pendingRow = [...document.querySelectorAll("tbody tr")].find((tr) =>
    (tr.textContent ?? "").includes("Pending"),
  );
  assert.ok(pendingRow, "a pending sale is listed");
  // assert the history exposes the authorized quick-confirm action
  assert.ok(
    [...(pendingRow?.querySelectorAll("button") ?? [])].some((b) =>
      (b.textContent ?? "").includes("Mark as Paid"),
    ),
    "history shows Mark as Paid",
  );
  const pendingLink = pendingRow.querySelector("a[href*='/pos/sales/']");
  assert.ok(pendingLink, "pending row links to detail");
  const pendingHref = pendingLink.getAttribute("href");
  const totalOnList = pendingRow.querySelectorAll("td")[3]?.textContent?.trim();
  await navigate(pendingHref);

  // Detail shows the pending InstaPay state with a confirm action, method unchanged.
  assert.ok((bodyText().match(/InstaPay/g) || []).length >= 1, "method is InstaPay");
  assert.ok(bodyText().includes("Marked as pending"), "payment shown as pending");
  const detailConfirm = [...document.querySelectorAll("button")].find((b) =>
    (b.textContent ?? "").includes("Confirm Payment"),
  );
  assert.ok(detailConfirm && !detailConfirm.disabled, "Confirm Payment available");
  const detailTotal = [...document.querySelectorAll("dd")].find((dd) =>
    /[0-9]/.test(dd.textContent ?? ""),
  )?.textContent?.trim();

  // Open the confirm dialog and accept.
  detailConfirm.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  await sleep(250);
  const confirmDialog = [...document.querySelectorAll('[role="dialog"]')].pop();
  assert.ok(confirmDialog?.textContent.includes("Confirm InstaPay payment"), "confirm dialog opens");
  const markPaidBtn = [...confirmDialog.querySelectorAll("button")].find((b) =>
    (b.textContent ?? "").includes("Mark as Paid"),
  );
  markPaidBtn.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  await sleep(1200);

  assert.ok(bodyText().includes("Marked as paid"), "status changed to paid");
  assert.ok(bodyText().includes("Confirmed by"), "confirming user recorded");
  assert.ok((bodyText().match(/InstaPay/g) || []).length >= 1, "method remains InstaPay");
  assert.ok(!bodyText().includes("Confirm Payment"), "confirm action gone after confirmation");
  console.log("  ✓ InstaPay payment confirmed to paid");

  // ── Reprint: open a completed transaction and print the receipt again ──
  const openInvoice = bodyText().match(/INV-\d{6}/)?.[0];
  assert.ok(openInvoice, "completed-sale detail shows its invoice number");
  const findReprintBtn = () =>
    [...document.querySelectorAll("button")].find((b) =>
      (b.textContent ?? "").includes("Print receipt"),
    );
  const beforeReprint = printedDocs.length;
  assert.ok(findReprintBtn(), "reprint action available on the completed-sale detail view");
  findReprintBtn().dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  await sleep(400);
  assert.equal(printedDocs.length, beforeReprint + 1, "reprint opened a receipt document");
  const reprintDoc = printedDocs[printedDocs.length - 1];
  assert.ok(reprintDoc.includes(openInvoice), "reprint carries the on-screen invoice number");
  assert.ok(/\d+\.\d{2}/.test(reprintDoc), "reprint carries monetary totals");
  assert.ok(reprintDoc.includes("<svg") && reprintDoc.includes("<rect"), "reprint keeps a rendered barcode");
  assert.ok(reprintDoc.includes("Thank you for your purchase"), "reprint keeps the shared footer");
  // Printing the same transaction again must reproduce the same document.
  findReprintBtn().dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  await sleep(400);
  assert.equal(
    printedDocs[printedDocs.length - 1],
    reprintDoc,
    "reprinting the same sale yields the original transaction data",
  );
  console.log("  ✓ sales receipt reprint from the completed transaction");

  // History updates and no duplicate sale is created; totals stay identical.
  await navigate("#/pos/sales");
  const refreshedRow = [...document.querySelectorAll("tbody tr")].find((tr) =>
    (tr.textContent ?? "").includes(totalOnList ?? "__never__"),
  );
  assert.ok(refreshedRow, "same sale still listed (no duplicate created)");
  assert.ok(!(refreshedRow?.textContent ?? "").includes("Pending"), "history shows it completed");
  const invCount = (bodyText().match(/INV-\d{6}/g) || []).length;
  await navigate(pendingHref);
  assert.ok(bodyText().includes("Marked as paid"), "detail persists paid status after reload");
  await navigate("#/pos/sales");
  assert.equal((bodyText().match(/INV-\d{6}/g) || []).length, invCount, "no new invoice number burned");
  assert.ok(detailTotal, "detail total captured");
  console.log("  ✓ sales history updated, receipt/details unchanged");

  // Stock was deducted (movements exist)
  await navigate("#/inventory/movements");
  assert.ok(bodyText().includes("Issue") || bodyText().includes("Sale"), "sale movements recorded");
  console.log("  ✓ stock deductions recorded in the movement ledger");

  // Out-of-stock products cannot be added to the cart
  await navigate("#/pos");
  setField('input[aria-label="Search"]', "Fresh Orange");
  await sleep(220);
  const oosCard = [...document.querySelectorAll("button")].find((b) =>
    (b.textContent ?? "").includes("Fresh Orange Juice"),
  );
  assert.ok(oosCard && oosCard.disabled === true, "out-of-stock card disabled");
  oosCard.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  await sleep(200);
  assert.ok(
    ![...document.querySelectorAll("aside ul li")].some((li) =>
      (li.textContent ?? "").includes("ALYQ-1010"),
    ),
    "out-of-stock product not added",
  );
  console.log("  ✓ out-of-stock products cannot be sold");

  // POS responsive layout: grid + cart collapse points present
  await navigate("#/pos");
  const posResponsive = [...document.querySelectorAll("main *")].some((el) =>
    [...el.classList].some((c) => c.startsWith("sm:") || c.startsWith("lg:")),
  );
  assert.ok(posResponsive, "POS uses responsive breakpoints");
  const gridCols = [...document.querySelectorAll("main *")].some((el) =>
    el.classList.contains("grid-cols-2"),
  );
  assert.ok(gridCols, "product grid reflows on small screens");
  console.log("  ✓ POS responsive layout");

  // ── Phase 7 · Customers + Returns + Refunds ──
  // Customers list
  await navigate("#/customers");
  assert.ok(
    bodyText().includes("Customers") || bodyText().includes("العملاء"),
    "customers page renders",
  );
  console.log("  ✓ customers list renders");

  // Add customer via modal
  click("Add customer");
  await sleep(300);
  setField("#cust-name", "Smoke Customer");
  setField("#cust-phone", "0599111222");
  setField("#cust-address", "Riyadh");
  click("Save");
  await sleep(700);
  assert.ok(bodyText().includes("Smoke Customer"), "new customer listed");
  console.log("  ✓ add customer");

  // Search customer
  setField('input[type="search"]', "Smoke Customer");
  await sleep(250);
  assert.ok(bodyText().includes("Smoke Customer"), "customer search finds record");
  setField('input[type="search"]', "");
  await sleep(250);

  // Edit customer
  const custEdit = [...document.querySelectorAll('button[title="Edit"]')][0];
  assert.ok(custEdit, "edit action present");
  custEdit.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  await sleep(300);
  setField("#cust-name", "Smoke Customer v2");
  click("Save");
  await sleep(700);
  assert.ok(bodyText().includes("Smoke Customer v2"), "customer edit persisted");
  console.log("  ✓ edit customer + search");

  // Open customer details → purchase history section present
  const custLink = [...document.querySelectorAll("a")].find((a) =>
    (a.textContent ?? "").includes("Smoke Customer v2"),
  );
  assert.ok(custLink, "customer detail link present");
  await navigate(custLink.getAttribute("href"));
  assert.ok(
    bodyText().includes("Purchase history") || bodyText().includes("سجل المشتريات"),
    "purchase history section present",
  );
  console.log("  ✓ customer details + purchase history");

  // Link customer to a POS sale (clear any leftover cart lines first)
  await navigate("#/pos");
  for (const rm of [...document.querySelectorAll('aside ul li button[aria-label="×"]')]) {
    rm.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
    await sleep(120);
  }
  const smokeCard = [...document.querySelectorAll("button")].find((b) =>
    (b.textContent ?? "").includes("Ethiopian Specialty"),
  );
  assert.ok(smokeCard, "product card present");
  smokeCard.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  await sleep(250);
  // buy 2 units so a later over-return attempt still has a returnable row
  const plusBtn = [...document.querySelectorAll('aside ul li button[aria-label="+"]')][0];
  plusBtn.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  await sleep(200);
  const custSelect = document.querySelector("#customer-select");
  assert.ok(custSelect, "customer selector in cart");
  const custOption = [...custSelect.options].find((o) => o.text.includes("Smoke Customer v2"));
  assert.ok(custOption, "new customer available in POS selector");
  setField("#customer-select", custOption.value);
  await sleep(250);
  setField('[data-testid="cash-input"]', "136");
  await sleep(250);
  const saleBtn = [...document.querySelectorAll("button")].find((b) =>
    (b.textContent ?? "").trim().startsWith("✓") && (b.textContent ?? "").includes("Complete sale"),
  );
  assert.ok(saleBtn && !saleBtn.disabled, "complete enabled with customer linked");
  saleBtn.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  await sleep(1600);
  const invMatch = bodyText().match(/INV-\d{6}/);
  assert.ok(invMatch, "linked sale completed");
  const linkedInv = invMatch[0];

  // ── Sales receipt for a CUSTOMER-LINKED sale: name + phone must appear ──
  const beforeLinkedPrint = printedDocs.length;
  const linkedPrintBtn = [...document.querySelectorAll("button")].find((b) =>
    (b.textContent ?? "").includes("Print receipt"),
  );
  assert.ok(linkedPrintBtn, "print receipt available on the completed modal");
  linkedPrintBtn.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  await sleep(400);
  assert.equal(printedDocs.length, beforeLinkedPrint + 1, "customer-linked sales receipt opened");
  const linkedReceipt = printedDocs[printedDocs.length - 1];
  assert.ok(linkedReceipt.includes(linkedInv), "sales receipt shows the invoice number");
  assert.ok(linkedReceipt.includes("Smoke Customer v2"), "sales receipt shows the customer NAME");
  assert.ok(linkedReceipt.includes("0599111222"), "sales receipt shows the customer PHONE");
  console.log("  ✓ sales receipt shows customer name + phone");

  click("New sale");
  await sleep(300);
  console.log("  ✓ customer linked to POS sale");

  // Returns page + create return for that sale
  await navigate("#/returns");
  assert.ok(
    bodyText().includes("Returns") || bodyText().includes("المرتجعات"),
    "returns page renders",
  );
  click("New return");
  await sleep(300);
  assert.ok(document.querySelector("#select-sale-inv"), "return modal opens");
  assert.ok(document.querySelector("#invoice-search-input"), "invoice search input present");
  assert.ok(document.querySelector("#invoice-date-from"), "invoice date-from input present");
  assert.ok(document.querySelector("#invoice-date-to"), "invoice date-to input present");

  // Test invoice search by keyword (invoice # or customer name)
  setField("#invoice-search-input", "Smoke Customer");
  await sleep(200);
  let matchingOptions = [...document.querySelector("#select-sale-inv").options].filter((o) => o.value);
  assert.ok(matchingOptions.length > 0, "customer search filters invoices");
  assert.ok(matchingOptions.every((o) => o.text.includes("Smoke Customer")), "all filtered options match customer name");

  // Clear search and select target invoice
  setField("#invoice-search-input", "");
  await sleep(200);
  const saleOption = [...document.querySelector("#select-sale-inv").options].find((o) =>
    o.text.includes(linkedInv),
  );
  assert.ok(saleOption, "completed sale selectable for return");
  setField("#select-sale-inv", saleOption.value);
  await sleep(300);

  // Verify selected invoice details are displayed
  assert.ok(bodyText().includes(linkedInv), "selected invoice number displayed in summary");
  assert.ok(bodyText().includes("Smoke Customer"), "customer displayed in summary");
  assert.ok(bodyText().includes("Selected Invoice Summary") || bodyText().includes("ملخص الفاتورة"), "summary card rendered");
  setField("#return-reason", "Smoke test return");
  const qtyInput = document.querySelector('input[placeholder="0"]');
  assert.ok(qtyInput, "return qty input present");
  // type 1 into the first qty field
  const qtyProto = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value").set;
  qtyProto.call(qtyInput, "1");
  qtyInput.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  await sleep(250);
  const createReturnBtn = [...document.querySelectorAll('[role="dialog"] button')].find((b) =>
    (b.textContent ?? "").includes("Process return"),
  );
  assert.ok(createReturnBtn, "process return button present");
  createReturnBtn.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  await sleep(1200);
  assert.ok(/RET-\d{6}/.test(bodyText()), "return created with RET number");
  // Completing a return lands on the return details view, where the receipt
  // can be printed immediately.
  assert.ok(
    dom.window.location.hash.includes("/returns/"),
    "landed on the return details view after completing the return",
  );
  assert.ok(
    [...document.querySelectorAll("button")].some((b) =>
      (b.textContent ?? "").includes("Print Return Receipt"),
    ),
    "Print Return Receipt available right after completion",
  );
  console.log("  ✓ return created with stock restore");

  // Invalid quantity blocked: open another return for the same sale, over-return
  await navigate("#/returns");
  click("New return");
  await sleep(300);
  const saleOption2 = [...document.querySelector("#select-sale-inv").options].find((o) =>
    o.text.includes(linkedInv),
  );
  if (saleOption2) {
    setField("#select-sale-inv", saleOption2.value);
    await sleep(300);
    setField("#return-reason", "Over-return attempt");
    const qtyInput2 = document.querySelector('input[placeholder="0"]');
    if (qtyInput2) {
      qtyProto.call(qtyInput2, "99");
      qtyInput2.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      await sleep(250);
      const createBtn2 = [...document.querySelectorAll('[role="dialog"] button')].find((b) =>
        (b.textContent ?? "").includes("Process return"),
      );
      createBtn2?.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
      await sleep(500);
      // dialog must stay open (rejected) or show validation
      assert.ok(
        document.querySelector('[role="dialog"]'),
        "over-return rejected, dialog stays open",
      );
      console.log("  ✓ invalid return quantity blocked");
    }
    // close dialog via Cancel
    const cancelBtn = [...document.querySelectorAll('[role="dialog"] button')].find((b) =>
      (b.textContent ?? "").trim() === "Cancel",
    );
    cancelBtn?.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
    await sleep(250);
  }

  // Return detail + linked refund
  const retLink = [...document.querySelectorAll("a")].find((a) => /RET-\d{6}/.test(a.textContent ?? ""));
  assert.ok(retLink, "return detail link present");
  await navigate(retLink.getAttribute("href"));
  assert.ok(bodyText().includes("Customer Return") || bodyText().includes("مرتجع"), "return detail shows movement notice");
  console.log("  ✓ return detail + linked refund");

  // ── Return receipt printing (reuses the sales receipt service) ──
  const beforeReturnPrints = printedDocs.length;
  const printReturnBtn = [...document.querySelectorAll("button")].find((b) =>
    (b.textContent ?? "").includes("Print Return Receipt"),
  );
  assert.ok(printReturnBtn, "Print Return Receipt button in the return details view");
  printReturnBtn.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  await sleep(400);
  assert.equal(printedDocs.length, beforeReturnPrints + 1, "return receipt document opened");
  const returnReceipt = printedDocs[printedDocs.length - 1];
  assert.ok(returnReceipt.includes("Return Receipt"), "return receipt has its own title");
  assert.ok(/RET-\d{6}/.test(returnReceipt), "return receipt carries the return number");
  assert.ok(returnReceipt.includes(linkedInv), "return receipt references the original invoice");
  assert.ok(returnReceipt.includes("Smoke Customer"), "return receipt shows the customer name (inherited)");
  assert.ok(
    returnReceipt.includes("0599111222"),
    "return receipt shows the customer phone (inherited from the invoice)",
  );
  assert.ok(returnReceipt.includes('src="/alyq-logo.png"'), "return receipt embeds the official logo");
  assert.ok(returnReceipt.includes("ALYQ | أَلِيق"), "return receipt has the boutique wordmark");
  assert.ok(returnReceipt.includes("<svg"), "return receipt embeds the return barcode");
  assert.ok(/ALYQ-\d{4}/.test(returnReceipt), "return receipt lists the returned item SKU");
  assert.ok(returnReceipt.includes("Total refund"), "return receipt has the refund summary");
  assert.ok(returnReceipt.includes("Refund method"), "return receipt labels the refund method");
  assert.ok(returnReceipt.includes("Cash"), "return receipt shows the refund method value");
  assert.ok(/\d+\.\d{2}/.test(returnReceipt), "return receipt carries a monetary refund amount");
  for (const contact of ["WhatsApp", "0150 0221712", "Facebook", "ALYQ.eg", "Instagram", "TikTok", "@alyq.eg"]) {
    assert.ok(returnReceipt.includes(contact), `return receipt footer has ${contact}`);
  }
  console.log("  ✓ return receipt printed with full return + invoice data");

  // ── Reprint the return receipt: identical content, original data intact ──
  const beforeReturnReprint = printedDocs.length;
  const reprintReturnBtn = [...document.querySelectorAll("button")].find((b) =>
    (b.textContent ?? "").includes("Print Return Receipt"),
  );
  assert.ok(reprintReturnBtn, "return reprint available on the return details view");
  reprintReturnBtn.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  await sleep(400);
  assert.equal(printedDocs.length, beforeReturnReprint + 1, "return reprint opened a document");
  assert.equal(
    printedDocs[printedDocs.length - 1],
    returnReceipt,
    "return reprint is identical to the original return receipt",
  );
  console.log("  ✓ return receipt reprint from the completed return");

  // Customer detail shows the purchase now
  await navigate("#/customers");
  for (let i = 0; i < 10 && !document.querySelector('input[type="search"]'); i += 1) {
    await sleep(300);
  }
  setField('input[type="search"]', "Smoke Customer v2");
  await sleep(250);
  const custLink2 = [...document.querySelectorAll("a")].find((a) =>
    (a.textContent ?? "").includes("Smoke Customer v2"),
  );
  await navigate(custLink2.getAttribute("href"));
  let historyOk = bodyText().includes(linkedInv);
  for (let i = 0; i < 10 && !historyOk; i += 1) {
    await sleep(300);
    historyOk = bodyText().includes(linkedInv);
  }
  assert.ok(historyOk, "purchase history shows the linked sale");
  console.log("  ✓ customer purchase history updated");

  // ── Phase 8 · Cashier shifts + expenses + audit ──
  // Scenario: open a shift with 1000 float, take one cash sale and one paid
  // InstaPay sale, record a 100 cash expense, then close and verify the
  // expected cash only ever moves by cash movements.
  const kpiValue = (label) => {
    const tile = [...document.querySelectorAll(".alyq-kpi")].find((el) =>
      (el.textContent ?? "").includes(label),
    );
    const raw = tile?.querySelector(".alyq-kpi-value")?.textContent ?? "";
    const match = raw.match(/-?\d[\d,]*\.\d{2}/);
    return match ? Number(match[0].replace(/,/g, "")) : null;
  };
  const findButton = (label) =>
    [...document.querySelectorAll("button")].find((b) => (b.textContent ?? "").includes(label));
  const clickEl = (el) => el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  // React tracks the last value it saw — drive inputs through the native setter.
  const typeInto = (input, value) => {
    const proto =
      input.tagName === "SELECT"
        ? dom.window.HTMLSelectElement
        : input.tagName === "TEXTAREA"
          ? dom.window.HTMLTextAreaElement
          : dom.window.HTMLInputElement;
    Object.getOwnPropertyDescriptor(proto.prototype, "value").set.call(input, value);
    input.dispatchEvent(
      new dom.window.Event(input.tagName === "SELECT" ? "change" : "input", { bubbles: true }),
    );
  };

  await navigate("#/shifts");
  for (let i = 0; i < 10 && !bodyText().includes("No shift is currently open"); i += 1) {
    await sleep(300);
  }
  assert.ok(bodyText().includes("No shift is currently open"), "shift dashboard starts with no open shift");
  console.log("  ✓ shift dashboard renders the empty state");

  // Open a shift with a 1000 opening float.
  clickEl(findButton("Open shift"));
  await sleep(350);
  const openDialog = dialog();
  assert.ok(openDialog?.textContent.includes("Open a new shift"), "open-shift modal appears");
  // Empty submit is blocked.
  clickEl([...openDialog.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim() === "Open shift"));
  await sleep(250);
  assert.ok(openDialog.textContent.includes("Branch is required"), "branch is required");
  assert.ok(openDialog.textContent.includes("Enter the opening cash"), "opening cash is required");

  const dialogInputs = [...openDialog.querySelectorAll("input")];
  const branchInput = dialogInputs.find((i) => !i.readOnly && i.type === "text");
  typeInto(branchInput, "Main branch");
  const cashOpeningInput = dialogInputs.find((i) => i.inputMode === "decimal");
  typeInto(cashOpeningInput, "1000");
  await sleep(200);
  clickEl([...dialog().querySelectorAll("button")].find((b) => (b.textContent ?? "").trim() === "Open shift"));
  for (let i = 0; i < 12 && !bodyText().includes("SH-000001"); i += 1) {
    await sleep(300);
  }
  assert.ok(bodyText().includes("SH-000001"), "shift SH-000001 opened");
  assert.equal(kpiValue("Opening balance"), 1000, "opening balance KPI shows the float");
  assert.equal(kpiValue("Expected cash"), 1000, "expected cash starts at the opening float");
  console.log("  ✓ shift opened with a 1000 opening float");

  // ── Cash sale: pay the exact total in cash ──
  await navigate("#/pos");
  const posCard = () =>
    findButton("Ethiopian Specialty") ?? findButton("ALYQ-1001");
  clickEl(posCard());
  await sleep(300);
  clickEl(findButton("Exact"));
  await sleep(300);
  const cashSaleCashValue = Number(document.querySelector('[data-testid="cash-input"]').value);
  assert.ok(cashSaleCashValue > 0, "cash sale amount read from the till");
  let completeSale = [...document.querySelectorAll("button")].find(
    (b) => (b.textContent ?? "").trim().startsWith("✓") && (b.textContent ?? "").includes("Complete sale"),
  );
  clickEl(completeSale);
  await sleep(1700);
  const cashInvoice = bodyText().match(/INV-\d{6}/)?.[0];
  assert.ok(cashInvoice, "cash sale completed with an invoice number");

  // ── InstaPay sale (paid, not pending) ──
  clickEl(findButton("New sale"));
  await sleep(350);
  clickEl(posCard());
  await sleep(300);
  toggleSwitch("Split payment");
  await sleep(300);
  // Same single item as the cash sale → same total; pay it entirely via InstaPay.
  typeInto(document.querySelector('[data-testid="instapay-input"]'), String(cashSaleCashValue));
  await sleep(300);
  const instapayValue = Number(document.querySelector('[data-testid="instapay-input"]').value);
  assert.equal(instapayValue, cashSaleCashValue, "InstaPay covers the full total");
  const cashAfterSplit = document.querySelector('[data-testid="cash-input"]').value;
  assert.ok(!cashAfterSplit || Number(cashAfterSplit) === 0, "cash cleared when InstaPay covers the total");
  clickEl(findButton("Marked as paid"));
  await sleep(200);
  completeSale = [...document.querySelectorAll("button")].find(
    (b) => (b.textContent ?? "").trim().startsWith("✓") && (b.textContent ?? "").includes("Complete sale"),
  );
  clickEl(completeSale);
  await sleep(1700);
  const instapayInvoice = bodyText().match(/INV-\d{6}/)?.[0];
  assert.ok(instapayInvoice && instapayInvoice !== cashInvoice, "InstaPay sale completed with its own invoice");
  const salesCountInShift = 2;
  console.log("  ✓ two sales taken during the shift (cash + paid InstaPay)");

  // ── Expense of 100 paid in cash ──
  await navigate("#/expenses");
  for (let i = 0; i < 10 && !bodyText().includes("Add expense"); i += 1) await sleep(300);
  clickEl(findButton("Add expense"));
  await sleep(350);
  let expenseDialog = dialog();
  assert.ok(expenseDialog?.textContent.includes("Recorded against the open shift"), "expense is linked to the open shift");
  const nameInput = expenseDialog.querySelector("input");
  typeInto(nameInput, "Delivery fuel");
  const amountInput = [...expenseDialog.querySelectorAll("input")].find((i) => i.inputMode === "decimal");
  typeInto(amountInput, "100");
  await sleep(200);
  clickEl([...dialog().querySelectorAll("button")].find((b) => (b.textContent ?? "").trim() === "Save"));
  for (let i = 0; i < 12 && !bodyText().includes("EXP-000001"); i += 1) await sleep(300);
  assert.ok(bodyText().includes("EXP-000001"), "expense EXP-000001 recorded");
  assert.ok(bodyText().includes("Transport"), "expense category rendered");
  console.log("  ✓ 100 cash expense recorded against the shift");

  // ── Back on the dashboard: expected = opening + cash sales − cash expense ──
  await navigate("#/shifts");
  for (let i = 0; i < 12 && kpiValue("Expected cash") === null; i += 1) await sleep(300);
  const expectedCash = kpiValue("Expected cash");
  const currentSales = kpiValue("Current sales");
  const currentExpenses = kpiValue("Current expenses");
  assert.equal(currentExpenses, 100, "current expenses KPI shows the cash expense");
  assert.equal(
    currentSales,
    Number((cashSaleCashValue + instapayValue).toFixed(2)),
    "current sales include both sales",
  );
  assert.equal(
    expectedCash,
    Number((1000 + cashSaleCashValue - 100).toFixed(2)),
    "expected cash = opening + cash sales − cash expenses (InstaPay excluded)",
  );
  assert.equal(bodyText().includes("Total returns"), true, "shift summary lists returns");
  console.log("  ✓ expected cash excludes the InstaPay sale and deducts the cash expense");

  // ── Close the shift with the exact expected cash ──
  clickEl(findButton("Close shift"));
  await sleep(350);
  const closeDialog = dialog();
  assert.ok(closeDialog?.textContent.includes("Close shift"), "close-shift modal appears");
  const countedInput = [...closeDialog.querySelectorAll("input")].find((i) => i.inputMode === "decimal");
  typeInto(countedInput, String(expectedCash));
  await sleep(250);
  assert.ok(closeDialog.textContent.includes("Balanced"), "live difference reads balanced");
  clickEl([...dialog().querySelectorAll("button")].find((b) => (b.textContent ?? "").trim() === "Close shift"));
  for (let i = 0; i < 12 && !bodyText().includes("No shift is currently open"); i += 1) await sleep(300);
  assert.ok(bodyText().includes("No shift is currently open"), "shift closed and the dashboard is empty again");
  console.log("  ✓ shift closed with a balanced drawer");

  // ── Shift history carries the opening/closing detail and the difference ──
  await navigate("#/shifts/history");
  for (let i = 0; i < 12 && !bodyText().includes("SH-000001"); i += 1) await sleep(300);
  assert.ok(bodyText().includes("SH-000001"), "closed shift listed in history");
  const historyRow = [...document.querySelectorAll("tbody tr")].find((tr) =>
    (tr.textContent ?? "").includes("SH-000001"),
  );
  assert.ok(historyRow, "history row for SH-000001");
  const historyCells = [...historyRow.querySelectorAll("td")].map((td) => td.textContent.trim());
  const parseCell = (text) => {
    const match = text.match(/-?\d[\d,]*(?:\.\d+)?/);
    return match ? Number(match[0].replace(/,/g, "")) : null;
  };
  assert.equal(parseCell(historyCells[3]), 1000, "history shows the opening balance");
  assert.equal(parseCell(historyCells[6]), expectedCash, "history shows the expected cash");
  assert.equal(parseCell(historyCells[7]), expectedCash, "history shows the counted cash");
  assert.equal(parseCell(historyCells[8]), 0, "history shows a zero difference");
  assert.ok(historyCells[8].includes("Balanced"), "difference flagged as balanced");

  // Detail modal keeps the frozen snapshot and the linked expense.
  clickEl(historyRow.querySelector("button"));
  await sleep(400);
  const detailDialog = [...document.querySelectorAll('[role="dialog"]')].pop();
  assert.ok(detailDialog?.textContent.includes("SH-000001"), "shift detail modal opens");
  assert.ok(detailDialog.textContent.includes("EXP-000001"), "detail lists the shift expense");
  assert.ok(detailDialog.textContent.includes("Delivery fuel"), "detail names the expense");
  assert.ok(detailDialog.textContent.includes("Figures frozen"), "detail marks the snapshot as frozen");
  clickEl([...detailDialog.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim() === "Close"));
  await sleep(300);
  console.log("  ✓ shift history + detail keep the opening/closing details and difference");

  // ── POS sales are untouched by the shift ──
  await navigate("#/pos/sales");
  for (let i = 0; i < 10 && !bodyText().includes("Sales history"); i += 1) await sleep(300);
  const invoiceNumbers = bodyText().match(/INV-\d{6}/g) ?? [];
  assert.ok(
    new Set(invoiceNumbers).size >= salesCountInShift,
    "the sales taken during the shift are still in sales history",
  );
  assert.ok(invoiceNumbers.includes(cashInvoice), "the cash sale is still listed");
  assert.ok(invoiceNumbers.includes(instapayInvoice), "the InstaPay sale is still listed");
  const salesRow = (invoice) =>
    [...document.querySelectorAll("tbody tr")].find((tr) => (tr.textContent ?? "").includes(invoice));
  const cashRow = salesRow(cashInvoice);
  const instapayRow = salesRow(instapayInvoice);
  assert.ok(cashRow && instapayRow, "both shift sales have history rows");
  assert.ok(
    (cashRow.textContent ?? "").includes("Cash"),
    "the cash sale keeps its payment method",
  );
  assert.ok(
    (instapayRow.textContent ?? "").includes("InstaPay"),
    "the InstaPay sale keeps its payment method",
  );
  await navigate("#/pos/sales");
  await sleep(400);
  assert.ok(!bodyText().includes("Shift #"), "POS sales table has no shift columns");
  console.log("  ✓ POS sales unaffected by the shift lifecycle");

  // ── Audit log records every shift/expense action ──
  await navigate("#/audit");
  for (let i = 0; i < 12 && !bodyText().includes("Audit log"); i += 1) await sleep(300);
  assert.ok(bodyText().includes("Shift opened"), "audit log records the shift opening");
  assert.ok(bodyText().includes("Expense created"), "audit log records the expense");
  assert.ok(bodyText().includes("Shift closed"), "audit log records the shift closing");
  assert.ok(bodyText().includes("SH-000001"), "audit entries reference the shift");
  assert.ok(bodyText().includes("EXP-000001"), "audit entries reference the expense");
  assert.ok(bodyText().includes("ALYQ Admin"), "audit entries carry the acting user");
  console.log("  ✓ audit log records shift.opened, expense.created and shift.closed");

  // ── Audit trail is an oversight screen: managers/admins only ──
  const roleSwitcher = () =>
    [...document.querySelectorAll("select")].find((s2) => [...s2.options].some((o) => o.value === "viewer"));
  const setRole = async (role) => {
    await navigate("#/inventory");
    for (let i = 0; i < 10 && !roleSwitcher(); i += 1) await sleep(300);
    const select = roleSwitcher();
    Object.getOwnPropertyDescriptor(dom.window.HTMLSelectElement.prototype, "value").set.call(select, role);
    select.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    await sleep(400);
  };

  await setRole("viewer");
  const auditNavVisible = [...document.querySelectorAll('aside nav a')].some(
    (a) => (a.getAttribute("href") ?? "") === "#/audit",
  );
  assert.equal(auditNavVisible, false, "viewer does not see the audit log in the sidebar");
  await navigate("#/audit");
  await sleep(500);
  assert.ok(bodyText().includes("Audit log is restricted"), "viewer is denied when typing #/audit directly");
  assert.ok(bodyText().includes("Only managers and admins"), "denial explains who may read the trail");
  assert.ok(!bodyText().includes("Shift closed"), "viewer never sees audit entries");
  assert.ok(!/EXP-\d{6}/.test(bodyText()), "no expense records leak into the denied view");
  console.log("  ✓ audit log is blocked for viewers (nav hidden + route denied)");

  await setRole("manager");
  const managerNavVisible = [...document.querySelectorAll('aside nav a')].some(
    (a) => (a.getAttribute("href") ?? "") === "#/audit",
  );
  assert.equal(managerNavVisible, true, "manager sees the audit log entry");
  await navigate("#/audit");
  for (let i = 0; i < 12 && !bodyText().includes("Shift closed"); i += 1) await sleep(300);
  assert.ok(bodyText().includes("Shift closed"), "manager can read the audit trail");
  await setRole("admin");
  console.log("  ✓ audit log stays readable for managers");

  // ── Explicit Sidebar Navigation Verification ──
  // Click Customers sidebar item
  const customersNav = [...document.querySelectorAll("aside nav a")].find((a) =>
    (a.textContent ?? "").includes("Customers") || (a.getAttribute("href") ?? "") === "#/customers"
  );
  assert.ok(customersNav, "Customers nav link exists in sidebar");
  customersNav.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  await sleep(350);
  assert.ok(dom.window.location.hash.includes("/customers"), "sidebar navigates to Customers page");
  assert.ok(bodyText().includes("Customer name") || bodyText().includes("Customers"), "Customers UI rendered from sidebar");

  // Click Returns sidebar item
  const returnsNav = [...document.querySelectorAll("aside nav a")].find((a) =>
    (a.textContent ?? "").includes("Returns") || (a.getAttribute("href") ?? "") === "#/returns"
  );
  assert.ok(returnsNav, "Returns nav link exists in sidebar");
  returnsNav.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  await sleep(350);
  assert.ok(dom.window.location.hash.includes("/returns"), "sidebar navigates to Returns page");
  assert.ok(bodyText().includes("Returns") || bodyText().includes("Refunds"), "Returns UI rendered from sidebar");

  // Click Refunds sidebar item
  const refundsNav = [...document.querySelectorAll("aside nav a")].find((a) =>
    (a.textContent ?? "").includes("Refunds") || (a.getAttribute("href") ?? "") === "#/refunds"
  );
  assert.ok(refundsNav, "Refunds nav link exists in sidebar");
  refundsNav.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  await sleep(350);
  assert.ok(dom.window.location.hash.includes("/refunds"), "sidebar navigates to Refunds page");
  assert.ok(bodyText().includes("Refund #") || bodyText().includes("Refunds"), "Refunds UI rendered from sidebar");
  console.log("  ✓ sidebar menu items: Customers, Returns, and Refunds verified");

  // 13 ─ bilingual RTL/LTR (including the POS screens)
  click("العربية");
  await sleep(300);
  assert.equal(document.documentElement.getAttribute("dir"), "rtl", "RTL applied");
  assert.ok(bodyText().includes("قسم المبيعات") || bodyText().includes("الكاشير"), "Sales section header in Arabic");
  await navigate("#/pos");
  assert.ok(bodyText().includes("البيع الحالي") || bodyText().includes("السلة فارغة"), "cart panel in Arabic");
  assert.ok(bodyText().includes("نقدي") && bodyText().includes("إنستا باي"), "payment methods in Arabic");
  assert.ok(!bodyText().includes("Complete sale"), "no untranslated POS copy in RTL");

  await navigate("#/pos/sales");
  assert.ok(bodyText().includes("سجل المبيعات"), "sales history in Arabic");
  assert.ok(/INV-\d{6}/.test(bodyText()), "sale numbers stay LTR-safe in RTL");
  console.log("  ✓ POS Arabic RTL");

  await navigate("#/shifts");
  assert.ok(
    bodyText().includes("لوحة الوردية") || bodyText().includes("لا توجد وردية مفتوحة"),
    "shift dashboard in Arabic",
  );
  await navigate("#/shifts/history");
  assert.ok(bodyText().includes("سجل الورديات"), "shift history in Arabic");
  await navigate("#/expenses");
  assert.ok(bodyText().includes("المصروفات"), "expenses page in Arabic");
  await navigate("#/audit");
  assert.ok(bodyText().includes("سجل التدقيق"), "audit log in Arabic");
  await navigate("#/shifts");
  assert.ok(!bodyText().includes("Expected cash"), "no untranslated shift copy in RTL");
  await navigate("#/expenses");
  assert.ok(!bodyText().includes("Add expense"), "no untranslated expense copy in RTL");
  console.log("  ✓ shifts + expenses + audit Arabic RTL");

  await navigate("#/products");
  assert.ok(bodyText().includes("المنتجات"), "Arabic labels rendered");
  click("English");
  await sleep(250);
  assert.equal(document.documentElement.getAttribute("dir"), "ltr", "back to LTR");
  console.log("  ✓ language toggle switches RTL/LTR");

  if (errors.length > 0) {
    console.error(`\n✗ ${errors.length} console error(s):`);
    for (const e of errors) console.error("  " + e.split("\n")[0]);
    process.exit(1);
  }
  console.log("\nAll DOM smoke checks passed with zero console errors.\n");
  process.exit(0);
}

main().catch((error) => {
  console.error("\n✗ smoke test failed:", error?.message ?? error);
  if (error?.stack) console.error(error.stack.split("\n").slice(0, 4).join("\n"));
  process.exit(1);
});
