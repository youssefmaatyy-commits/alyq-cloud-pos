/**
 * Variant Test Ring E2E (Phase 43) — the acceptance example, driven through the
 * real bundle in jsdom, demo mode, exactly as an admin would:
 *
 *   1. create "Variant Ring" (SKU VAR-RING) with FOUR units on the product;
 *   2. generate its combinations — Gold/17 and Silver/17 — from the editor;
 *   3. switch it to variant stock with an opening distribution of 2 + 2 (the
 *      confirm stays disabled until the distribution adds up);
 *   4. the catalogue chip shows the two combinations;
 *   5. at the POS the tile opens the picker: Gold/17 added twice sells, the
 *      THIRD Gold/17 is refused even though the product's rollup still reads 4 —
 *      the acceptance rule, at the till;
 *   6. the two Gold rings complete as a sale: Gold/17 lands at 0, Silver/17
 *      keeps its 2, and the rollup follows the shelves (4 → 2);
 *   7. the inventory screen exposes the shelves behind the rollup, and the
 *      adjustment modal is per-combination: +1 on Silver/17 moves THAT shelf
 *      (2 → 3) and the rollup with it, Gold untouched;
 *   8. leaving variant mode is refused once history names a combination.
 *
 * The database half of the same rule (the RPCs refusing an unbalanced opening,
 * an overselling line, a delete with history) is locked by `npm run db:check`
 * (supabase/tests/scenarios.sql); the pure logic half by the online selftests.
 *
 * Any console.error / window.onerror / network call fails the run.
 *
 *   node scripts/test.e2e.mjs variants
 */
import { JSDOM } from "jsdom";
import assert from "node:assert/strict";
import { bundleFileUrl } from "./lib/app-bundle.mjs";

const dom = new JSDOM('<!doctype html><html lang="en"><body><div id="root"></div></body></html>', {
  url: "http://localhost/",
  pretendToBeVisual: true,
  runScripts: "outside-only",
});

const errors = [];

globalThis.window = dom.window;
globalThis.document = dom.window.document;
try {
  Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
} catch {
  /* node owns navigator */
}
globalThis.localStorage = dom.window.localStorage;
globalThis.sessionStorage = dom.window.sessionStorage;
globalThis.FormData = dom.window.FormData;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.HTMLInputElement = dom.window.HTMLInputElement;
globalThis.HTMLSelectElement = dom.window.HTMLSelectElement;
globalThis.Element = dom.window.Element;
globalThis.Node = dom.window.Node;
globalThis.getComputedStyle = dom.window.getComputedStyle;
globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
globalThis.File = dom.window.File;
globalThis.Blob = dom.window.Blob;
globalThis.FileReader = dom.window.FileReader;
URL.createObjectURL = (_blob) => `blob:mock-${Math.random().toString(36).slice(2)}`;
URL.revokeObjectURL = () => {};

const networkCalls = [];
const blockedFetch = (input) => {
  const url = String(typeof input === "object" && input !== null ? (input.url ?? input) : input);
  networkCalls.push(`fetch ${url}`);
  return Promise.reject(new Error(`blocked network call: ${url}`));
};
dom.window.fetch = blockedFetch;
globalThis.fetch = blockedFetch;
class BlockedXHR {
  open(method, url) {
    networkCalls.push(`${method} ${url}`);
  }
  send() {
    throw new Error(`blocked network call: ${networkCalls.at(-1) ?? "XHR"}`);
  }
  setRequestHeader() {}
  addEventListener() {}
  removeEventListener() {}
}
dom.window.XMLHttpRequest = BlockedXHR;
globalThis.XMLHttpRequest = BlockedXHR;

dom.window.console.error = (...args) => {
  errors.push(args.map((a) => (a?.stack ?? String(a))).join(" "));
  process.stderr.write(`[console.error] ${args.map(String).join(" ")}\n`);
};
dom.window.addEventListener("error", (event) => errors.push(`window.onerror: ${event.message}`));
process.on("unhandledRejection", (reason) => {
  errors.push(`unhandledRejection: ${reason?.stack ?? String(reason)}`);
});
dom.window.open = () => ({ document: { open() {}, write() {}, close() {} }, focus() {}, print() {} });

await import(bundleFileUrl());

// ── helpers ────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const bodyText = () => document.body.textContent ?? "";

async function waitFor(condition, { label, timeout = 15_000, interval = 150 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (condition()) return;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}.`);
    await sleep(interval);
  }
}

const navigate = async (hash, settle = 400) => {
  dom.window.location.hash = hash;
  dom.window.dispatchEvent(new dom.window.HashChangeEvent("hashchange"));
  await sleep(settle);
};

const clickEl = (el) =>
  el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
const click = (label, scope = document) => {
  const el = [...scope.querySelectorAll("button, a")].find((n) =>
    (n.textContent ?? "").trim().includes(label),
  );
  if (!el) throw new Error(`control not found: ${label}`);
  clickEl(el);
  return el;
};
const clickExact = (label, scope = document) => {
  const el = [...scope.querySelectorAll("button, a")].find(
    (n) => (n.textContent ?? "").trim() === label,
  );
  if (!el) throw new Error(`control not found (exact): ${label}`);
  clickEl(el);
  return el;
};
const setNative = (input, proto) => (value) => {
  Object.getOwnPropertyDescriptor(proto.prototype, "value").set.call(input, value);
  input.dispatchEvent(
    new dom.window.Event(input.tagName === "SELECT" ? "change" : "input", { bubbles: true }),
  );
};
/** Set any field by selector: input, textarea or select. */
const setField = (selector, value) => {
  const input = document.querySelector(selector);
  if (!input) throw new Error(`field not found: ${selector}`);
  const proto =
    input.tagName === "TEXTAREA"
      ? dom.window.HTMLTextAreaElement
      : input.tagName === "SELECT"
        ? dom.window.HTMLSelectElement
        : dom.window.HTMLInputElement;
  setNative(input, proto)(value);
};
const setTestid = (testid, value) => {
  const input = document.querySelector(`[data-testid="${testid}"]`);
  if (!input) throw new Error(`field not found: [data-testid=${testid}]`);
  const proto = input.tagName === "SELECT" ? dom.window.HTMLSelectElement : dom.window.HTMLInputElement;
  setNative(input, proto)(value);
};

const toastText = () =>
  [...document.querySelectorAll('[aria-live="polite"]')].map((n) => n.textContent ?? "").join("\n");

const readJson = (key) => {
  const raw = globalThis.localStorage.getItem(key);
  if (raw === null) return null;
  return JSON.parse(raw);
};
const catalog = () => readJson("alyq.demo.catalog.v1") ?? { products: [], variants: [] };

/* ── Authentication ── */
const DEMO_PASSWORD = "alyq1234";
const usernameField = () => document.querySelector("input[autocomplete='username']");
const isSignedIn = () => bodyText().includes("Signed in as");
const signOut = async () => {
  if (!isSignedIn()) return;
  click("Sign out");
  for (let i = 0; i < 20 && !usernameField(); i += 1) await sleep(200);
  await sleep(200);
};
const signInAs = async (username, password = DEMO_PASSWORD) => {
  await signOut();
  await waitFor(() => Boolean(usernameField()), { label: "the login screen" });
  setField("input[autocomplete='username']", username);
  setField("input[autocomplete='current-password']", password);
  click("Sign in");
  await waitFor(() => isSignedIn(), { label: `${username} to sign in` });
  await sleep(400);
};

// ── the flow ────────────────────────────────────────────────────────────────

async function main() {
  console.log("\nVariant Test Ring · per-shelf stock enforcement\n");
  await sleep(500);

  const SKU = "VAR-RING";
  const GOLD_SKU = "VAR-RING-GOLD-17";
  const SILVER_SKU = "VAR-RING-SILVER-17";

  // 0 ─ admin
  assert.ok(usernameField(), "the app boots on the login screen");
  await signInAs("admin");
  assert.ok(isSignedIn(), "admin signed in");

  // 1 ─ real Add Product acceptance: configure four combinations BEFORE the
  // first save. The older two-shelf flow below remains as the focused stock-sale
  // proof; this first scene proves the requested creation UX.
  const UI_SKU = "VAR-UI-RING";
  await navigate("#/products/new");
  await waitFor(() => document.querySelector("#sku"), { label: "the product form" });
  assert.ok(document.querySelector('[data-testid="variant-mode"]'), "Add Product exposes Variant Mode");
  setField("#name_ar", "خاتم اختبار الواجهات");
  setField("#name_en", "Variant UI Ring");
  setField("#sku", UI_SKU);
  setField("#selling_price", "200");
  setField("#cost_price", "100");
  setField("#tax_rate", "0");
  const setSelect = (selector, predicate) => {
    const select = document.querySelector(selector);
    if (!select) throw new Error(`select not found: ${selector}`);
    const option = [...select.options].find(predicate);
    if (!option) throw new Error(`no option matches in ${selector}`);
    setField(selector, option.value);
  };
  setSelect("#category_id", (o) => o.value !== "");
  setField('[data-testid="variant-mode"]', "colors_sizes");
  setField('[data-testid="variant-colors"]', "Gold | ذهبي | #D4AF37\nSilver | فضي | #C0C0C0");
  setField('[data-testid="variant-sizes"]', "17, 18");
  clickEl(document.querySelector('[data-testid="variant-generate"]'));
  await waitFor(() => document.querySelectorAll('[data-testid^="product-variant-"]:not([data-testid="product-variant-table"])').length === 4, {
    label: "four generated Add Product combinations",
  });
  const uiRows = [...document.querySelectorAll('[data-testid^="product-variant-"]:not([data-testid="product-variant-table"])')];
  const uiStocks = [2, 4, 5, 1];
  for (let index = 0; index < uiRows.length; index += 1) {
    const inputs = [...uiRows[index].querySelectorAll("input")];
    assert.ok(inputs.length >= 7, "variant table exposes SKU, barcode, stock, low stock, prices, and image");
    setNative(inputs[0], dom.window.HTMLInputElement)(`UI-${index + 1}`);
    setNative(inputs[1], dom.window.HTMLInputElement)(`UI-BAR-${index + 1}`);
    setNative(inputs[2], dom.window.HTMLInputElement)(String(uiStocks[index]));
    setNative(inputs[3], dom.window.HTMLInputElement)("1");
    setNative(inputs[6], dom.window.HTMLInputElement)(`https://example.test/variant-${index + 1}.jpg`);
  }
  assert.equal(document.querySelector("#stock_quantity").value, "12", "product stock is derived from variant stock");
  clickEl(document.querySelector('[data-testid="product-form-save"]'));
  await waitFor(() => dom.window.location.hash === "#/products", { label: "Add Product variant save" });
  await waitFor(() => bodyText().includes(UI_SKU), { label: "the saved variant product" });
  const uiProduct = catalog().products.find((p) => p.sku === UI_SKU);
  assert.ok(uiProduct?.variants_enabled, "the one Save flow enables variant stock");
  const uiVariants = catalog().variants.filter((variant) => variant.product_id === uiProduct.id);
  assert.deepEqual(uiVariants.map((variant) => `${variant.color_en} / ${variant.size}`), [
    "Gold / 17", "Gold / 18", "Silver / 17", "Silver / 18",
  ]);
  assert.equal(uiVariants.reduce((sum, variant) => sum + variant.stock_quantity, 0), 12);
  console.log("  ✓ Add Product created four exact combinations with rollup 12");

  await navigate(`#/products/${uiProduct.id}/edit`);
  await waitFor(() => document.querySelectorAll('[data-testid^="variant-row-"]').length === 4, {
    label: "four variants after Edit Product reload",
  });
  await navigate("#/inventory/stock");
  await waitFor(() => document.querySelector('input[placeholder*="Search by product"]'), { label: "inventory stock screen" });
  const inventoryRefresh = document.querySelector('button[title="Retry"]');
  if (inventoryRefresh) clickEl(inventoryRefresh);
  await sleep(500);
  setField('input[placeholder="Search by product, SKU or barcode…"]', UI_SKU);
  await waitFor(() => document.querySelector(`[data-testid="variant-breakdown-toggle-${UI_SKU}"]`), { label: "four variants in inventory" });
  clickEl(document.querySelector(`[data-testid="variant-breakdown-toggle-${UI_SKU}"]`));
  await waitFor(() => {
    const text = document.querySelector(`[data-testid="variant-breakdown-${UI_SKU}"]`)?.textContent ?? "";
    return ["Gold", "Silver", "17", "18"].every((part) => text.includes(part));
  }, { label: "all four inventory shelves" });
  await navigate("#/pos");
  await waitFor(() => [...document.querySelectorAll("button")].some((button) => (button.textContent ?? "").includes("Variant UI Ring")), { label: "variant product in POS" });
  await navigate(`#/store/products/${uiProduct.id}`);
  await waitFor(() => bodyText().includes("Gold") && bodyText().includes("Silver"), { label: "variant colors in storefront" });
  console.log("  ✓ Edit Product, Inventory, POS, and Storefront expose all four combinations");

  // 2 ─ focused two-shelf stock-sale proof
  await navigate("#/products/new");
  await waitFor(() => document.querySelector("#sku"), { label: "the product form" });
  setField("#name_ar", "خاتم متعدد");
  setField("#name_en", "Variant Ring");
  setField("#sku", SKU);
  setField("#selling_price", "200");
  setField("#cost_price", "100");
  setField("#tax_rate", "0");
  setField("#stock_quantity", "4");
  setField("#low_stock_level", "1");
  setSelect("#category_id", (o) => o.value !== "");
  clickExact("Save");
  await waitFor(() => dom.window.location.hash === "#/products", {
    label: "the save to route back to the catalogue",
  });
  await waitFor(() => bodyText().includes(SKU), { label: "the new product to appear" });
  const productId = catalog().products.find((p) => p.sku === SKU)?.id;
  assert.ok(productId, "the ring is in the demo catalogue");
  console.log("  ✓ created Variant Ring (VAR-RING) holding 4 units");

  // 2 ─ the editor: generate Gold/17 + Silver/17 from colours × sizes
  await navigate(`#/products/${productId}/edit`);
  await waitFor(() => document.querySelector('[data-testid="variant-editor"]'), {
    label: "the variant editor under the form",
  });
  // ProductForm has its own Generate (barcode) button; the editor's generator
  // is named by testid, not by label.
  clickEl(document.querySelector('[data-testid="variant-generate"]'));
  await waitFor(() => document.querySelectorAll('[role="dialog"]').length > 0, {
    label: "the generator dialog",
  });
  const genDialog = [...document.querySelectorAll('[role="dialog"]')].pop();
  const colorsArea = [...genDialog.querySelectorAll("textarea")].find((t) =>
    (t.placeholder ?? "").includes("Gold"),
  );
  assert.ok(colorsArea, "the colours textarea is in the generator");
  setNative(colorsArea, dom.window.HTMLTextAreaElement)(
    "Gold | ذهبي | #d4af37\nSilver | فضي | #c0c0c0",
  );
  const sizesInput = [...genDialog.querySelectorAll("input")].find((i) =>
    (i.placeholder ?? "").includes("16, 16.5"),
  );
  assert.ok(sizesInput, "the sizes input is in the generator");
  setNative(sizesInput, dom.window.HTMLInputElement)("17");
  await sleep(250);
  const genConfirm = [...genDialog.querySelectorAll("button")].find((b) =>
    (b.textContent ?? "").trim() === "Create 2",
  );
  assert.ok(genConfirm && !genConfirm.disabled, "two combinations are previewed and generable");
  clickEl(genConfirm);
  await waitFor(
    () =>
      document.querySelector(`[data-testid="variant-row-${GOLD_SKU}"]`) &&
      document.querySelector(`[data-testid="variant-row-${SILVER_SKU}"]`),
    { label: "both combination rows" },
  );
  assert.equal(
    catalog().products.find((p) => p.id === productId).stock_quantity,
    4,
    "drafting combinations must not zero the product the conversion will split",
  );
  console.log("  ✓ generated Gold/17 and Silver/17 from the editor");

  // 3 ─ enable variant stock: the distribution must add up to the product's 4
  clickEl(document.querySelector('[data-testid="variant-mode-toggle"]'));
  await waitFor(() => document.querySelector('[data-testid="variant-enable-panel"]'), {
    label: "the enable panel",
  });
  const confirmEnable = () => document.querySelector('[data-testid="variant-enable-confirm"]');
  assert.ok(confirmEnable().disabled, "an empty distribution cannot be confirmed");
  setTestid(`opening-${GOLD_SKU}`, "3");
  setTestid(`opening-${SILVER_SKU}`, "2");
  assert.ok(confirmEnable().disabled, "3 + 2 ≠ 4 is refused in the UI before any write");
  setTestid(`opening-${GOLD_SKU}`, "2");
  await waitFor(() => !confirmEnable().disabled, { label: "the balanced distribution to unlock" });
  clickEl(confirmEnable());
  await waitFor(
    () =>
      catalog().products.find((p) => p.id === productId)?.variants_enabled === true &&
      catalog().variants.filter((variant) => variant.product_id === productId).length === 2,
    { label: "the mode flip to land in the demo catalogue" },
  );
  const shelves = Object.fromEntries(
    catalog().variants.map((v) => [v.sku, { stock: v.stock_quantity, active: v.active, id: v.id }]),
  );
  assert.equal(shelves[GOLD_SKU].stock, 2, "Gold / 17 opens with its 2");
  assert.equal(shelves[SILVER_SKU].stock, 2, "Silver / 17 opens with its 2");
  assert.equal(catalog().products.find((p) => p.id === productId).stock_quantity, 4);
  console.log("  ✓ switched to variant stock: 2 + 2, nothing created or destroyed");

  // 4 ─ the catalogue chip
  await navigate("#/products");
  await waitFor(() => document.querySelector(`[data-testid="variant-chip-${SKU}"]`), {
    label: "the variant chip on the product row",
  });
  console.log("  ✓ the catalogue row carries the combinations chip");

  // 5 ─ POS: Gold/17 sells twice; the THIRD is refused at the shelf
  await navigate("#/shifts");
  await waitFor(() => bodyText().includes("No shift is currently open"), { label: "a closed drawer" });
  click("Open shift");
  await sleep(400);
  const shiftDialog = [...document.querySelectorAll('[role="dialog"]')].pop();
  const shiftInputs = [...shiftDialog.querySelectorAll("input")];
  const fillShift = (input, value) => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value").set.call(
      input,
      value,
    );
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  };
  fillShift(shiftInputs.find((i) => !i.readOnly && i.type === "text"), "Main branch");
  fillShift(shiftInputs.find((i) => i.inputMode === "decimal"), "100");
  clickEl(
    [...shiftDialog.querySelectorAll("button")].find(
      (b) => (b.textContent ?? "").trim() === "Open shift",
    ),
  );
  await waitFor(() => /SH-\d{6}/.test(bodyText()), { label: "the shift to open" });

  await navigate("#/pos");
  const tile = () =>
    [...document.querySelectorAll("button")].find((b) => (b.textContent ?? "").includes("Variant Ring"));
  await waitFor(() => tile(), { label: "the ring tile in the POS grid" });
  assert.ok(!tile().disabled, "the rollup says 4, so the tile is sellable");
  clickEl(tile());
  const picker = () =>
    [...document.querySelectorAll('[role="dialog"]')].find((d) =>
      (d.textContent ?? "").includes("Choose colour and size"),
    );
  await waitFor(() => picker(), { label: "the combination picker" });
  // The size grid shows the SELECTED colour's shelves; the colour chip carries
  // the per-colour stock, the size button names its own shelf.
  const colorChip = (name) =>
    [...picker().querySelectorAll("button")].find(
      (b) => !(b.getAttribute("aria-label") ?? "").includes("—") && (b.textContent ?? "").includes(name),
    );
  const sizeButton = (label) =>
    [...picker().querySelectorAll("button")].find(
      (b) => (b.getAttribute("aria-label") ?? "").startsWith(`${label} — `),
    );
  assert.ok(colorChip("Gold") && colorChip("Silver"), "both colours are offered");
  assert.ok(sizeButton("Gold / 17"), "Gold / 17 is a shelf in the grid");
  assert.equal(
    (sizeButton("Gold / 17").getAttribute("aria-label") ?? "").endsWith("2"),
    true,
    "Gold / 17 says 2 — its own stock, not a share",
  );
  assert.ok(!sizeButton("Silver / 17"), "the grid never mixes two colours' sizes");

  clickEl(sizeButton("Gold / 17")); // 1st
  await waitFor(() => !picker(), { label: "the picker to close after the first pick" });
  const qtyBadge = () => {
    const t = tile();
    return t ? t.querySelector("span.rounded-full")?.textContent ?? "0" : null;
  };
  await waitFor(() => qtyBadge() === "1", { label: "the cart badge to show one ring" });
  clickEl(tile());
  await waitFor(() => picker(), { label: "the picker again" });
  clickEl(sizeButton("Gold / 17")); // 2nd
  await waitFor(() => qtyBadge() === "2", { label: "the cart badge to show two rings" });

  clickEl(tile()); // the third Gold/17
  await waitFor(() => picker(), { label: "the picker a third time" });
  clickEl(sizeButton("Gold / 17"));
  await sleep(500);
  assert.ok(picker(), "the refused pick leaves the picker open — nothing was added");
  assert.equal(qtyBadge(), "2", "the THIRD Gold / 17 never reached the cart (shelf says 2)");
  console.log("  ✓ acceptance: Gold/17 ×3 refused while the product rollup still reads 4");

  // Silver / 17 is untouched and sellable: its colour chip answers, its shelf
  // is there — but this sale stays Gold-only, so close and pay.
  clickEl(colorChip("Silver"));
  await sleep(200);
  assert.ok(sizeButton("Silver / 17"), "Silver / 17 answers once its colour is chosen");
  clickEl([...picker().querySelectorAll("button")].find((b) => (b.textContent ?? "").trim() === "×"));
  await waitFor(() => !picker(), { label: "the picker to close" });
  setField('[data-testid="cash-input"]', "500");
  await sleep(250);
  const completeBtn = [...document.querySelectorAll("button")].find(
    (b) => (b.textContent ?? "").trim().startsWith("✓") && (b.textContent ?? "").includes("Complete sale"),
  );
  assert.ok(completeBtn && !completeBtn.disabled, "the sale is payable");
  clickEl(completeBtn);
  await waitFor(() => /INV-\d{6}/.test(bodyText()), { label: "the sale to complete" });
  click("New sale");
  await sleep(300);

  const afterSale = Object.fromEntries(
    catalog().variants.map((v) => [v.sku, v.stock_quantity]),
  );
  assert.equal(afterSale[GOLD_SKU], 0, "Gold / 17 is empty — its own shelf, not a share");
  assert.equal(afterSale[SILVER_SKU], 2, "Silver / 17 untouched by the Gold sale");
  assert.equal(
    catalog().products.find((p) => p.id === productId).stock_quantity,
    2,
    "the rollup follows the shelves (4 → 2)",
  );
  console.log("  ✓ sale completed: Gold/17 → 0, Silver/17 → 2, rollup → 2");

  // 7 ─ inventory: the breakdown, then a per-shelf adjustment
  await navigate("#/inventory/stock");
  await waitFor(
    () => [...document.querySelectorAll("input")].find((i) => (i.placeholder ?? "").includes("SKU or barcode")),
    { label: "the inventory screen" },
  );
  // The provider re-reads on the realtime bus; in this offline run the page's
  // own refresh button is the honest way to pick up what the sale just wrote.
  const retryBtn = [...document.querySelectorAll("button[title]")].find((b) =>
    (b.getAttribute("title") ?? "").toLowerCase().includes("retry"),
  );
  if (retryBtn) clickEl(retryBtn);
  await sleep(600);
  setField('input[placeholder="Search by product, SKU or barcode…"]', SKU);
  await sleep(400);
  const breakdownToggle = () =>
    document.querySelector(`[data-testid="variant-breakdown-toggle-${SKU}"]`);
  await waitFor(() => breakdownToggle(), { label: "the per-shelf breakdown toggle" });
  assert.ok((breakdownToggle().textContent ?? "").includes("2"), "the toggle names two combinations");
  clickEl(breakdownToggle());
  await waitFor(() => document.querySelector(`[data-testid="variant-breakdown-${SKU}"]`), {
    label: "the breakdown to open",
  });
  const breakdownText = document.querySelector(`[data-testid="variant-breakdown-${SKU}"]`).textContent ?? "";
  assert.ok(breakdownText.includes("Gold") && breakdownText.includes("0"), "Gold / 17 reads 0");
  assert.ok(breakdownText.includes("Silver") && breakdownText.includes("2"), "Silver / 17 reads 2");

  // the adjustment modal is per-combination
  const adjustBtn = [...document.querySelectorAll("button")].find(
    (b) => (b.textContent ?? "").trim() === "Adjust stock" && !b.disabled,
  );
  assert.ok(adjustBtn, "the row offers Adjust stock");
  clickEl(adjustBtn);
  await waitFor(() => document.querySelector('[data-testid="adjust-variant-select"]'), {
    label: "the combination picker inside the adjustment modal",
  });
  const variantSelect = document.querySelector('[data-testid="adjust-variant-select"]');
  const silverOption = [...variantSelect.options].find((o) => o.textContent.includes("Silver"));
  assert.ok(silverOption, "Silver / 17 is one of the countable shelves");
  setNative(variantSelect, dom.window.HTMLSelectElement)(silverOption.value);
  setField("#inv-qty", "1");
  await sleep(200);
  const modal = [...document.querySelectorAll('[role="dialog"]')].pop();
  const modalAdjust = [...modal.querySelectorAll("button")].find(
    (b) => (b.textContent ?? "").trim().includes("Adjust stock") && !b.disabled,
  );
  assert.ok(modalAdjust, "the adjustment is submittable");
  clickEl(modalAdjust);
  await waitFor(
    () => catalog().variants.find((v) => v.sku === SILVER_SKU)?.stock_quantity === 3,
    { label: "Silver / 17 to take the recount" },
  );
  assert.equal(catalog().variants.find((v) => v.sku === GOLD_SKU)?.stock_quantity, 0, "Gold untouched");
  assert.equal(catalog().products.find((p) => p.id === productId).stock_quantity, 3, "rollup → 3");
  console.log("  ✓ per-shelf adjustment: +1 on Silver/17 only, rollup follows");

  // 8 ─ leaving variant mode is refused once history names a combination
  await navigate(`#/products/${productId}/edit`);
  await waitFor(() => document.querySelector('[data-testid="variant-editor"]'), {
    label: "the variant editor",
  });
  clickEl(document.querySelector('[data-testid="variant-mode-toggle"]'));
  await waitFor(() => document.querySelector('[data-testid="variant-disable-panel"]'), {
    label: "the disable panel",
  });
  const disableConfirm = document.querySelector('[data-testid="variant-disable-confirm"]');
  assert.ok(!disableConfirm.disabled, "the consolidated figure is prefilled and balanced");
  clickEl(disableConfirm);
  await sleep(600);
  assert.ok(
    catalog().products.find((p) => p.id === productId).variants_enabled === true,
    "the mode flip was refused — history names Gold / 17",
  );
  assert.ok(
    (toastText() + bodyText()).includes("variant"),
    "the refusal is explained, not silent",
  );
  console.log("  ✓ disable refused with the reason: a sold combination keeps the mode");

  // 9 ─ the reports screen reads the shelves too: the Variants tab renders the
  //      per-combination performance from the rows this device holds (demo has
  //      no database, so this exercises the fallback that mirrors the RPC).
  await navigate("#/reports/advanced", 700);
  const tabButton = [...document.querySelectorAll("button")].find(
    (b) => (b.textContent ?? "").trim().startsWith("Variants"),
  );
  assert.ok(tabButton, "the Variants tab is on the advanced reports screen");
  assert.ok(/\d+/.test(tabButton.textContent ?? ""), "the tab counts saved combinations");
  clickEl(tabButton);
  await waitFor(() => bodyText().includes("Per-combination performance"), {
    label: "the variants report section",
  });
  await waitFor(() => bodyText().includes("Computed from the rows this device holds"), {
    label: "the source note (demo runs the fallback, and says so)",
  });
  const section = () =>
    [...document.querySelectorAll("table")].find((table) =>
      (table.textContent ?? "").includes("Gold"),
    );
  await waitFor(() => section(), { label: "the combinations table" });
  // The combination cell is built from spans, so whitespace is layout, not
  // content — compare with all of it squeezed out.
  const tableText = (section().textContent ?? "").replace(/\s+/g, "");
  assert.ok(tableText.includes("Gold/17"), "Gold / 17 has its row");
  assert.ok(tableText.includes("Silver/17"), "Silver / 17 has its row");
  assert.ok(
    tableText.includes("400.00"),
    "Gold / 17 reads its 400.00 revenue from the two rings sold",
  );
  assert.ok(tableText.includes("Total"), "the totals row is present");
  console.log("  ✓ the reports Variants tab reads the shelves (fallback source, labelled)");

  assert.equal(networkCalls.length, 0, `no network in demo mode: ${networkCalls[0] ?? ""}`);
  assert.deepEqual(errors, [], "no console errors across the ring");
  console.log("\nVariant Test Ring passed — 9/9 scenes\n");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(`\n✗ ${error?.stack ?? error}`);
    process.exit(1);
  });
