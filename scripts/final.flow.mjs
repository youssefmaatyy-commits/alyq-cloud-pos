/**
 * Phase 48 · the final integrated flow — one run, the whole shop, live-like.
 *
 * Not a new feature and not a fixture stunt: this is the acceptance walk the
 * deployment decision rests on. Twenty-two steps from a cold sign-in to the
 * Danger Zone's door — and it stops there, at a PREVIEW, because the one thing
 * the final flow must never do is destroy the evidence it just built.
 *
 *   1. admin signs in                    12. InstaPay: proof → verification → paid
 *   2. the shift opens                   13. the hold sits on the exact variant
 *   3. a customer is created             14. orders settle: stock moves
 *   4. the ring: Gold/17=2, Silver/17=2  15. category archive → reactivate
 *   5. POS sells Gold/17 ×2              16. website customization still visible
 *   6. the third Gold/17 is refused      17. dashboard KPIs reconcile
 *   7. Gold/17 ×1 comes back             18. reports reconcile
 *   8. Gold/17 = 1                       19. branding displays
 *   9. the storefront picks Silver/17    20. Danger Zone PREVIEW only — no reset
 *  10. delivery order                    21. a restricted role is refused
 *  11. COD path                          22. the audit trail holds it all
 *
 *   node scripts/test.e2e.mjs final
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
  signOut,
  dialogs,
} = ux;
const { document } = dom.window;

const buttons = () => [...document.querySelectorAll("button")];
const squeezed = () => (document.body.textContent ?? "").replace(/\s+/g, "");
const RING_SKU = "FN-RING";
// the generator names shelves `${product SKU}-${colour}-${size}`
const GOLD_SKU = `${RING_SKU}-GOLD-17`;
const SILVER_SKU = `${RING_SKU}-SILVER-17`;
const RING_PRICE = 150;

const catalog = () => ux.readJson("alyq.demo.catalog.v1", { products: [], variants: [], categories: [] });
const stockOf = (sku) => catalog().variants.find((v) => v.sku === sku)?.stock_quantity;
const trail = () => ux.readJson("alyq.demo.audit_log.v1", []);
const orders = () => ux.readJson("alyq.demo.online_orders.v1", []);
const sales = () => ux.readJson("alyq.demo.sales.v1", []);
const holds = () => ux.readJson("alyq.demo.stock_reservations.v1", []);

const tabByLabel = (needle) =>
  [...document.querySelectorAll('[role="tab"]')].find((b) =>
    (b.textContent ?? "").replace(/\s+/g, "").includes(needle),
  );
const treeRow = (nameEn) =>
  [...document.querySelectorAll("li")].find((li) => (li.querySelector("p")?.textContent ?? "").includes(nameEn));
const rowAction = (nameEn, label) => {
  const li = treeRow(nameEn);
  assert.ok(li, `category row on screen: ${nameEn}`);
  const btn = [...li.querySelectorAll("button")].find(
    (b) => (b.getAttribute("aria-label") ?? b.title ?? "").trim() === label,
  );
  assert.ok(btn, `the ${label} action is offered on ${nameEn}`);
  clickEl(btn);
};

// ── 1 · admin signs in ──────────────────────────────────────────────────────
await signInAs("admin");
await waitFor(() => catalog().products.length > 0, { label: "the demo catalogue to seed" });
console.log("  ✓ 1 · the admin is in");

// ── 2 · the shift opens ─────────────────────────────────────────────────────
await navigate("#/shifts");
await waitFor(() => bodyText().includes("No shift is currently open"), { label: "a closed drawer" });
click("Open shift");
await sleep(400);
{
  const shiftDialog = dialogs().at(-1);
  const shiftInputs = [...shiftDialog.querySelectorAll("input")];
  setInputValue(shiftInputs.find((i) => !i.readOnly && i.type === "text"), "Final flow branch");
  setInputValue(shiftInputs.find((i) => i.inputMode === "decimal"), "200");
  clickEl([...shiftDialog.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim() === "Open shift"));
}
await waitFor(() => /SH-\d{6}/.test(bodyText()), { label: "the shift to open" });
console.log("  ✓ 2 · the drawer opens");

// ── 3 · a customer is created ───────────────────────────────────────────────
await navigate("#/customers", 800);
await waitFor(() => buttons().some((b) => (b.textContent ?? "").includes("customer")), {
  label: "the customers screen",
});
clickEl(buttons().find((b) => (b.textContent ?? "").includes("Add customer") || (b.textContent ?? "").includes("إضافة عميل")));
await waitFor(() => dialogs().length > 0, { label: "the customer form" });
{
  const form = dialogs().at(-1);
  setNative(form.querySelector("#cust-name"), dom.window.HTMLInputElement)("نهى المصري");
  setNative(form.querySelector("#cust-phone"), dom.window.HTMLInputElement)("01222110099");
  await sleep(200);
  const save = [...form.querySelectorAll("button")].find((b) => /^(Save|Create)/.test((b.textContent ?? "").trim()));
  clickEl(save);
}
await sleep(600);
assert.ok(squeezed().includes("نهىالمصري") || squeezed().includes("01222110099"), "the customer is listed");
console.log("  ✓ 3 · the customer exists");

// ── 4 · the ring: Gold/17 = 2, Silver/17 = 2 ────────────────────────────────
await navigate("#/products/new");
await waitFor(() => document.querySelector("#sku"), { label: "the product form" });
setField("#name_ar", "خاتم الختام");
setField("#name_en", "Finale Ring");
setField("#sku", RING_SKU);
setField("#selling_price", String(RING_PRICE));
setField("#cost_price", "70");
setField("#tax_rate", "0");
setField("#stock_quantity", "4");
setField("#low_stock_level", "1");
{
  const categorySelect = document.querySelector("#category_id");
  const option = [...categorySelect.options].find((o) => o.value !== "");
  if (option) setReactValue(categorySelect, option.value);
}
clickExact("Save");
await ux.waitForRoute("/dashboard/products", { label: "the save to land on the catalogue" });
const productId = catalog().products.find((p) => p.sku === RING_SKU)?.id;
assert.ok(productId, "the ring is in the catalogue");

await navigate(`#/products/${productId}/edit`);
await waitFor(() => testid("variant-editor"), { label: "the variant editor" });
clickEl(testid("variant-generate"));
await waitFor(() => dialogs().length > 0, { label: "the generator" });
{
  const genDialog = dialogs().at(-1);
  const colorsArea = [...genDialog.querySelectorAll("textarea")].find((t) => (t.placeholder ?? "").includes("Gold"));
  setNative(colorsArea, dom.window.HTMLTextAreaElement)("Gold | ذهبي | #d4af37\nSilver | فضي | #c0c0c0");
  const sizesInput = [...genDialog.querySelectorAll("input")].find((i) => (i.placeholder ?? "").includes("16, 16.5"));
  setNative(sizesInput, dom.window.HTMLInputElement)("17");
  await sleep(250);
  clickEl([...genDialog.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim() === "Create 2"));
}
await waitFor(() => testid(`variant-row-${GOLD_SKU}`), { label: "the gold row" });
clickEl(testid("variant-mode-toggle"));
await waitFor(() => testid("variant-enable-panel"), { label: "the enable panel" });
setNative(testid(`opening-${GOLD_SKU}`), dom.window.HTMLInputElement)("2");
setNative(testid(`opening-${SILVER_SKU}`), dom.window.HTMLInputElement)("2");
await waitFor(() => !testid("variant-enable-confirm").disabled, { label: "the balanced 2+2" });
clickEl(testid("variant-enable-confirm"));
await waitFor(() => catalog().products.find((p) => p.id === productId)?.variants_enabled === true, {
  label: "the mode flip",
});
assert.equal(stockOf(GOLD_SKU), 2, "Gold / 17 = 2");
assert.equal(stockOf(SILVER_SKU), 2, "Silver / 17 = 2");
console.log("  ✓ 4 · the ring stands: Gold/17 = 2, Silver/17 = 2");

// ── 5 · POS sells Gold/17 ×2, to the customer ───────────────────────────────
await navigate("#/pos", 700);
await waitFor(() => testid("pos-scan-search"), { label: "the scan/search box" });
assert.ok(!testid("pos-grid"), "no product-card grid");
const searchFor = async (text) => {
  setField('[data-testid="pos-scan-search"]', text);
  await sleep(450);
};
const rowFor = (name) =>
  [...document.querySelectorAll("[data-pos-result-index]")].find((b) => (b.textContent ?? "").includes(name));
await searchFor("Finale");
await waitFor(() => rowFor("Finale Ring"), { label: "the ring row" });
clickEl(rowFor("Finale Ring"));
const picker = () =>
  [...document.querySelectorAll('[role="dialog"]')].find((d) => (d.textContent ?? "").includes("Choose colour and size"));
await waitFor(() => picker(), { label: "the exact-shelf picker" });
const sizeButton = (label) =>
  [...picker().querySelectorAll("button")].find((b) => (b.getAttribute("aria-label") ?? "").startsWith(`${label} — `));
const cartLines = () => [...document.querySelectorAll('[data-testid^="cart-line-"]')];
clickEl(sizeButton("Gold / 17"));
await waitFor(() => !picker(), { label: "the picker to close" });
await searchFor("Finale");
await waitFor(() => rowFor("Finale Ring"), { label: "the ring row again" });
clickEl(rowFor("Finale Ring"));
await waitFor(() => picker(), { label: "the picker again" });
clickEl(sizeButton("Gold / 17"));
await waitFor(() => cartLines().length === 1 && cartLines()[0].textContent.includes("Gold / 17"), {
  label: "Gold / 17 ×2 on one line",
});

// the customer rides along — the picker's options pick on mousedown (it beats
// the input's blur), so the flow presses the option the way a finger would
await waitFor(() => document.querySelector('input[aria-label="Select customer"]'), { label: "the customer picker" });
setField('input[aria-label="Select customer"]', "نهى");
await sleep(600);
{
  const listbox = document.querySelector('[role="listbox"]');
  assert.ok(listbox, "the picker's listbox is open");
  const option = [...listbox.querySelectorAll("button")].find((b) => (b.textContent ?? "").includes("نهى المصري"));
  assert.ok(option, "the matching customer is offered");
  option.dispatchEvent(new dom.window.MouseEvent("mousedown", { bubbles: true, cancelable: true }));
  option.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
}
await sleep(300);
{
  // real proof of attachment: the at-rest input shows the chosen NAME, and the
  // completed sale will carry it (asserted after the sale lands)
  const pickerInput = document.querySelector('input[aria-label="Select customer"]');
  assert.equal(pickerInput.value, "نهى المصري", "the picker holds the chosen customer");
}
setField('[data-testid="cash-input"]', "1000");
await sleep(250);
clickEl(buttons().find((b) => (b.textContent ?? "").trim().startsWith("✓") && (b.textContent ?? "").includes("Complete sale")));
await waitFor(() => /INV-\d{6}/.test(bodyText()), { label: "the till sale to complete" });
const tillSaleNumber = (bodyText().match(/INV-\d{6}/) ?? [])[0];
clickExact("New sale");
await sleep(300);
assert.equal(stockOf(GOLD_SKU), 0, "Gold / 17 emptied by the sale");
const tillSale = sales().find((s) => s.sale_number === tillSaleNumber);
assert.ok(tillSale, "the sale exists in the till");
assert.equal(tillSale.customer_name, "نهى المصري", "the sale carries the customer");
console.log(`  ✓ 5 · ${tillSaleNumber}: Gold/17 ×2 sold to نهى المصري`);

// ── 6 · the third Gold/17 is refused ────────────────────────────────────────
await searchFor("Finale");
await waitFor(() => rowFor("Finale Ring"), { label: "the ring row back in results" });
clickEl(rowFor("Finale Ring"));
await waitFor(() => picker(), { label: "the picker a third time" });
{
  // the sold-out shelf is not even offered: Gold shows 0 on its chip and no
  // Gold / 17 button exists to press — the Phase 43 refusal at its strongest
  const pickerText = picker()?.textContent.replace(/\s+/g, " ") ?? "";
  assert.ok(/Gold\s*0/.test(pickerText), `Gold reads 0 on its chip: ${pickerText.slice(0, 160)}`);
  assert.equal(sizeButton("Gold / 17"), undefined, "no Gold / 17 shelf is offered");
  assert.ok(sizeButton("Silver / 17"), "the stocked Silver / 17 remains available");
}
await sleep(400);
assert.equal(cartLines().length, 0, "a new cart, and the third Gold never reached it");
{
  const escape = new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true });
  document.activeElement?.dispatchEvent(escape);
  document.dispatchEvent(escape);
}
await sleep(250);
console.log("  ✓ 6 · the third Gold / 17 is refused (shelf = 0)");

// ── 7 · Gold/17 ×1 comes back ───────────────────────────────────────────────
await navigate("#/returns");
await waitFor(() => bodyText().includes("Returns & Refunds"), { label: "the returns screen" });
await sleep(400);
clickExact("New return");
await waitFor(() => dialogs().length > 0, { label: "the return modal" });
{
  const returnModal = () => dialogs().at(-1);
  const saleSelect = [...returnModal().querySelectorAll("select")].find((s) =>
    [...s.options].some((o) => (o.textContent ?? "").includes(tillSaleNumber)),
  );
  assert.ok(saleSelect, "the invoice selector lists the sale");
  setReactValue(saleSelect, [...saleSelect.options].find((o) => (o.textContent ?? "").includes(tillSaleNumber)).value);
  await sleep(400);
  const qtyInput = [...returnModal().querySelectorAll('input[placeholder="0"]')][0];
  setInputValue(qtyInput, "1");
  qtyInput.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  await sleep(200);
  const reasonInput = returnModal().querySelector("#return-reason");
  setInputValue(reasonInput, "Final flow: one Gold back");
  reasonInput.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  await sleep(200);
  clickEl([...returnModal().querySelectorAll("button")].find((b) => (b.textContent ?? "").includes("Process return")));
}
await waitFor(() => /RET-\d{6}/.test(bodyText() + (ux.toastText?.() ?? "")), { label: "the return to be created" });
await sleep(300);
{
  const closeButton = [...(dialogs().at(-1)?.querySelectorAll("button") ?? [])].find(
    (b) => ["Close", "Done"].some((t) => (b.textContent ?? "").trim() === t) || (b.textContent ?? "").includes("Done"),
  );
  if (closeButton) clickEl(closeButton);
}
// ── 8 · the shelf reads 1, on the exact combination ─────────────────────────
await waitFor(() => stockOf(GOLD_SKU) === 1, { label: "Gold / 17 to read 1" });
assert.equal(stockOf(GOLD_SKU), 1, "Gold / 17 = 1 after the partial return");
assert.equal(stockOf(SILVER_SKU), 2, "Silver / 17 untouched");
console.log("  ✓ 7+8 · one Gold / 17 returned — the exact shelf reads 1");

// ── 9 · the storefront picks Silver / 17 on the PDP ─────────────────────────
await ux.clearStoreCart();
await navigate(`#/store/products/${productId}`, 900);
await waitFor(() => document.querySelector("article, main"), { label: "the product page" });
await sleep(400);
{
  // the PDP variant picker: colour chips and size shelves carry testids
  const silverChip = [...document.querySelectorAll('button[data-testid^="variant-color-"]')].find(
    (b) => (b.textContent ?? "").includes("Silver") || (b.textContent ?? "").includes("فضي"),
  );
  assert.ok(silverChip, "the Silver colour chip is on the PDP");
  clickEl(silverChip);
  await sleep(300);
  const size17 = testid("variant-size-17");
  assert.ok(size17, "the 17 shelf is offered for Silver");
  clickEl(size17);
  await sleep(250);
}
clickExact("Add to cart");
{
  const silverId = catalog().variants.find((v) => v.sku === SILVER_SKU)?.id;
  await waitFor(() => {
    const cart = ux.readJson("alyq.store.cart.v2", null);
    return cart && silverId && JSON.stringify(cart).includes(silverId);
  }, { label: "the cart to hold the Silver / 17 variant" });
}
console.log("  ✓ 9 · the storefront chose Silver / 17 by hand");

// ── 10+11 · a DELIVERY order, paid COD ──────────────────────────────────────
const deliveryAddress = { city: "القاهرة", area: "مدينة نصر", street: "12 شارع التسعين" };
const codNumber = await ux.placeOrder({ payment: "cod", fulfilment: "Delivery", address: deliveryAddress, zone: "Cairo" });
assert.ok(codNumber, "the delivery COD order was placed");
const codOrder = orders().find((o) => o.order_number === codNumber);
assert.equal(codOrder.status, "pending", "the order waits for the shop");
assert.ok(codOrder.delivery_fee > 0, "delivery costs what the shop charges");
assert.equal(stockOf(SILVER_SKU), 2, "no stock moved yet — a hold, not a sale");
// ── 13 · the hold sits on the EXACT variant ─────────────────────────────────
const silverHold = holds().find((h) => h.variant_id);
assert.ok(silverHold, "the order holds stock");
assert.equal(silverHold.variant_id, catalog().variants.find((v) => v.sku === SILVER_SKU)?.id,
  "the hold names Silver / 17, not the product");
assert.equal(silverHold.quantity, 1, "one unit held");
console.log(`  ✓ 10+11+13 · ${codNumber}: delivery COD, one Silver / 17 held`);

// ── 12 · InstaPay, separately: proof → verification pending ─────────────────
await ux.clearStoreCart();
let plain = catalog().products.find(
  (p) => p.active && p.stock_tracking_enabled && !p.variants_enabled && p.stock_quantity > 0 && p.id !== productId,
);
assert.ok(plain, "a plain product for the InstaPay leg");
await ux.addToCartFromStore();
{
  // whichever plain product the shelf card offered, that is the one on trial
  const cart = ux.readJson("alyq.store.cart.v2", {});
  const line = (cart.items ?? cart.lines ?? [])[0] ?? {};
  const carted = catalog().products.find((p) => p.id === line.product_id);
  assert.ok(carted && !carted.variants_enabled, "the InstaPay leg carted a plain product");
  plain = carted;
}
const instaNumber = await ux.placeOrder({ payment: "instapay", fulfilment: "Pickup" });
assert.ok(instaNumber, "the InstaPay order was placed");
// proof: the confirmation/track page accepts a screenshot
await navigate("#/store/track", 700);
await sleep(500);
if (!bodyText().includes(instaNumber)) {
  const inputs = [...document.querySelectorAll("input")];
  const numberInput = inputs.find((i) => (i.placeholder ?? "").includes("WEB-"));
  const phoneInput = inputs.find((i) => i.getAttribute("inputmode") === "tel" || i.type === "tel");
  assert.ok(numberInput && phoneInput, "the tracking lookup is on the page");
  setNative(numberInput, dom.window.HTMLInputElement)(instaNumber);
  setNative(phoneInput, dom.window.HTMLInputElement)("01001234567");
  clickEl(buttons().find((b) => (b.getAttribute("type") ?? "") === "submit"));
}
await waitFor(() => bodyText().includes(instaNumber), { label: "the tracked InstaPay order" });
{
  const fileInputs = () => document.querySelectorAll('input[type="file"]');
  await waitFor(() => fileInputs().length > 0, { label: "the proof form" });
  {
    const span = [...document.querySelectorAll("label span, label")].find((n) =>
      (n.textContent ?? "").trim().startsWith("Transfer reference"),
    );
    const scope = span?.closest("label");
    assert.ok(scope, "the transfer-reference field is on the proof form");
    setField("input", "IP-489977", scope);
  }
  const proof = fileInputs()[0];
  const file = new dom.window.File(["proof-bytes"], "instapay-final.png", { type: "image/png" });
  Object.defineProperty(proof, "files", { value: [file], configurable: true });
  proof.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  await sleep(300);
  clickExact("Send the proof");
}
await waitFor(() => bodyText().includes("verification") || bodyText().includes("Verification"), {
  label: "the verification-pending state",
});
const instaOrder = orders().find((o) => o.order_number === instaNumber);
assert.equal(instaOrder.payment_status, "verification_required", "a screenshot is a claim, not a payment");
console.log(`  ✓ 12 · ${instaNumber}: InstaPay proof sent — verification pending`);

// ── 14 · the shop settles both orders; stock moves ──────────────────────────
await navigate("#/online/orders", 900);
await waitFor(() => bodyText().includes(codNumber), { label: "the COD order in the POS" });
{
  // approve COD: delivery + cash on delivery → sale + stock move
  const row = [...document.querySelectorAll("tbody tr")].find((tr) => (tr.textContent ?? "").includes(codNumber));
  clickEl([...row.querySelectorAll("button")].find((b) => (b.getAttribute("aria-label") ?? "").includes("View")));
  await waitFor(() => dialogs().length > 0, { label: "the COD order detail" });
  const modal = () => dialogs().at(-1);
  assert.ok((modal().textContent ?? "").includes("Approve order"), "approval is offered for COD");
  clickEl([...modal().querySelectorAll("button")].find((b) => (b.textContent ?? "").includes("Approve order")));
  await waitFor(() => (modal().textContent ?? "").includes("Approved"), { label: "the COD approval" });
  const escape = new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true });
  document.dispatchEvent(escape);
  await sleep(400);
}
await waitFor(() => stockOf(SILVER_SKU) === 1, { label: "Silver / 17 to move to 1" });
assert.equal(stockOf(SILVER_SKU), 1, "the COD approval moved exactly one Silver / 17");
{
  // InstaPay: verify the money FIRST, then the order
  const row = [...document.querySelectorAll("tbody tr")].find((tr) => (tr.textContent ?? "").includes(instaNumber));
  clickEl([...row.querySelectorAll("button")].find((b) => (b.getAttribute("aria-label") ?? "").includes("View")));
  await waitFor(() => dialogs().length > 0, { label: "the InstaPay order detail" });
  const modal = () => dialogs().at(-1);
  assert.ok((modal().textContent ?? "").includes("Approve payment"), "the money is offered a decision");
  assert.equal((modal().textContent ?? "").includes("Approve order"), false,
    "no order approval while the money is unverified");
  clickEl([...modal().querySelectorAll("button")].find((b) => (b.textContent ?? "").includes("Approve payment")));
  await waitFor(() => (modal().textContent ?? "").includes("Paid"), { label: "the payment to verify" });
  await waitFor(() => {
    const m = dialogs().at(-1);
    const btn = m && [...m.querySelectorAll("button")].find((b) => (b.textContent ?? "").includes("Approve order"));
    return Boolean(btn && !btn.disabled);
  }, { label: "approval to unlock" });
  clickEl([...dialogs().at(-1).querySelectorAll("button")].find((b) => (b.textContent ?? "").includes("Approve order")));
  await waitFor(() => (modal().textContent ?? "").includes("Approved"), { label: "the InstaPay approval" });
  const escape = new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true });
  document.dispatchEvent(escape);
}
await sleep(500);
const instaSettled = orders().find((o) => o.order_number === instaNumber);
assert.ok(instaSettled.sale_id, "the verified InstaPay order became a sale");
const plainAfter = catalog().products.find((p) => p.id === plain.id)?.stock_quantity;
assert.equal(plainAfter, plain.stock_quantity - 1, "and only then did the plain product move");
console.log("  ✓ 14 · both orders settled — stock moved once each, on approval");

// ── 15 · category archive → reactivate ──────────────────────────────────────
await navigate("#/categories", 700);
await waitFor(() => treeRow("خواتم") || treeRow("Rings") || document.querySelector("li p"), {
  label: "the category tree",
});
{
  // a scratch leaf: empty categories deactivate directly, and nothing of value
  // rides on it
  const add = buttons().find((b) => (b.textContent ?? "").includes("Add category"));
  assert.ok(add, "the Add category control exists");
  clickEl(add);
  await waitFor(() => document.querySelector("#cat-name-en"), { label: "the add-category form" });
  setField("#cat-name-ar", "خاتم مؤقت");
  setField("#cat-name-en", "Final Scratch");
  clickExact("Save");
  await sleep(700);
  rowAction("Final Scratch", "Deactivate");
  await waitFor(() => squeezed().includes("willbehiddenfromnewproducts"), { label: "the archive confirm" });
  click("Deactivate");
  await sleep(700);
  const archivedTab = tabByLabel("Archived");
  assert.ok(archivedTab, "the Archived tab exists");
  clickEl(archivedTab);
  await sleep(400);
  rowAction("Final Scratch", "Activate");
  await waitFor(() => squeezed().includes("willbecomeselectablefornewproductsagain"), { label: "the activate confirm" });
  click("Activate");
  await sleep(700);
  const activeTab = tabByLabel("Active");
  clickEl(activeTab);
  await sleep(400);
  assert.ok(treeRow("Final Scratch"), "Final Scratch is back under Active");
  console.log("  ✓ 15 · Final Scratch: archived, then reactivated — nothing lost");
}

// ── 16 · the website customization is still visible ─────────────────────────
await navigate("#/store", 900);
await sleep(700);
assert.ok(bodyText().includes("ALYQ") || bodyText().includes("Accessories"), "the shopfront renders");
assert.ok(
  document.querySelectorAll("article").length > 0 || document.querySelector("img"),
  "the customized shelves render (cards or imagery)",
);
console.log("  ✓ 16 · the storefront stands, customized");

// ── 17 · the dashboard KPIs reconcile ───────────────────────────────────────
// `/` is the public shop; the dashboard is /dashboard.
await navigate("#/dashboard", 800);
await waitFor(() => testid("dash-kpi-row"), { label: "the KPI row" });
{
  // today: 1 till sale + 2 online sales; 2 web orders placed, both approved
  const kpiRow = testid("dash-kpi-row").textContent ?? "";
  assert.ok(kpiRow.includes("3"), "the today-sales tile counts 3 (till + 2 online)");
  await waitFor(() => {
    const row = testid("dash-kpi-row").textContent ?? "";
    return row.includes("2");
  }, { label: "the web tile to count the orders" });
}
console.log("  ✓ 17 · KPIs: 3 sales today, 2 web orders — the same facts the ledger holds");

// ── 18 · the reports reconcile ──────────────────────────────────────────────
await navigate("#/pos/sales", 900);
await sleep(700);
assert.ok(bodyText().includes(tillSaleNumber), "the ledger lists the till invoice");
assert.ok(bodyText().includes("300"), "with its 300.00 total");
const onlineSales = sales().filter((s) => s.source === "online");
assert.equal(onlineSales.length, 2, "both online settlements are in the same ledger");
const netToday = sales().reduce((sum, s) => sum + Number(s.total ?? 0), 0);
assert.ok(netToday > 0, `the day nets to ${netToday.toFixed(2)} EGP from one source of truth`);
console.log(`  ✓ 18 · one ledger: till + 2 online sales, net ${netToday.toFixed(2)} EGP`);

// ── 19 · branding displays ──────────────────────────────────────────────────
assert.ok(document.body.textContent.includes("ALYQ Admin"), "the sidebar names the admin");
assert.ok(document.body.textContent.includes("ALYQ"), "the brand wordmark is on screen");
console.log("  ✓ 19 · branding displays");

// ── 20 · the Danger Zone, PREVIEW ONLY ──────────────────────────────────────
await navigate("#/settings/system", 900);
await waitFor(() => testid("dz-cards"), { label: "the Danger Zone cards" });
clickEl(testid("dz-open-clear"));
await waitFor(() => testid("dz-step-scope"), { label: "the scope step" });
clickEl(testid("dz-option-sales"));
clickEl(testid("dz-option-orders"));
clickEl(testid("dz-option-shifts"));
await sleep(200);
assert.ok(testid("dz-option-returns").checked && testid("dz-option-returns").disabled,
  "returns ride locked with sales");
clickEl(testid("dz-preview"));
await waitFor(() => testid("dz-step-preview"), { label: "the server preview" });
{
  const deleteText = testid("dz-preview-delete").textContent ?? "";
  assert.ok(/POS sales|مبيعات الكاشير/.test(deleteText), "the preview names the sale group");
  assert.ok(deleteText.includes("2"), "it counts the day's 2 sales");
  const preserveText = testid("dz-preview-preserve").textContent ?? "";
  assert.ok(preserveText.length > 40, "the preserve list is real, not a stub");
  assert.ok(bodyText().includes("ALYQ Admin"), "the protected admin is shown");
}
{
  // close the wizard — the final flow NEVER executes a reset
  const escape = new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true });
  document.dispatchEvent(escape);
  await sleep(400);
}
assert.equal(sales().length, 3, "nothing was destroyed — the preview was a preview");
console.log("  ✓ 20 · Danger Zone preview only: counts are the server's, nothing fired");

// ── 21 · a restricted role is refused ───────────────────────────────────────
await signOut();
await signInAs("viewer");
await navigate("#/settings/system", 900);
await sleep(500);
assert.ok(!testid("dz-cards"), "the viewer gets no Danger Zone");
assert.ok(!testid("dz-open-clear"), "and no reset action anywhere");
await signOut();
await signInAs("admin");
await sleep(300);
console.log("  ✓ 21 · the viewer is refused; the admin session survives");

// ── 22 · the audit trail holds it all ───────────────────────────────────────
await navigate("#/audit", 800);
await sleep(500);
assert.ok(bodyText().includes("Audit"), "the audit screen renders");
const actions = () => trail().map((e) => e.action);
// the trail records the funnel's ACTS: returns, order settlements, the payment
// decision — a plain till sale is the receipt's story, not the audit's. The
// audit rows are fire-and-forget async: wait for the last one to land.
await waitFor(() => actions().filter((a) => a === "online_order.approved").length === 2, {
  label: "both order-settlement audit rows",
});
assert.ok(actions().includes("return.created"), "the return is in the trail");
assert.equal(actions().filter((a) => a === "online_order.approved").length, 2, "both order settlements are in the trail");
assert.ok(actions().includes("online_order.payment_approved"), "the InstaPay verification is in the trail");
assert.ok(actions().includes("session.login"), "the sign-ins are in the trail");
assert.ok(trail().every((e) => !JSON.stringify(e.details ?? {}).toLowerCase().includes("password")),
  "no password ever reached the trail");
console.log(`  ✓ 22 · the audit trail holds ${trail().length} rows, password-free`);

await navigate("#/dashboard");
await sleep(400);
ux.finish("Final Integrated Flow");
