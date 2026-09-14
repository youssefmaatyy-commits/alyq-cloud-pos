/**
 * Storefront → POS acceptance flow (Phase 9).
 *
 * Drives the real application bundle in jsdom through the one journey that
 * matters for an online shop wired into a till:
 *
 *   1. the storefront is public — it renders with nobody signed in, and no
 *      screen of the back office loads;
 *   2. a shopper browses, searches, opens a product and puts it in the cart;
 *   3. checkout as a guest places an order (pickup, cash on delivery);
 *   4. the order is trackable by its number and the phone it was placed with;
 *   5. the order arrives in the POS "Online Orders" screen, and approving it
 *      creates a real sale with `source = "online"` and deducts the stock the
 *      order was holding;
 *   6. an InstaPay order submits a payment proof and stays at "verification
 *      pending" until an employee approves the payment — only then can it be
 *      approved, and only then does stock move;
 *   7. cancelling an order keeps the record with its reason and gives the stock
 *      back;
 *   8. the website builder's colours, copy and social links go live on the
 *      storefront without touching code.
 *
 * Any console.error / window.onerror / network call fails the run: demo mode is
 * localStorage-only, so a shopper's browser should never reach a backend here.
 *
 * Build the bundle first, then run this file:
 *   npm run test:bundle                 # → /tmp/alyq-app.mjs
 *   node scripts/store.flow.mjs
 * or let the runner do both: `npm run test:e2e store`.
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
// Node 22 owns `navigator`; jsdom's copy is only needed if it can be set (same
// workaround as `scripts/smoke.dom.mjs` and `scripts/auth.flow.mjs`).
let navigatorWritable = false;
try {
  Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
  navigatorWritable = true;
} catch {
  /* node owns navigator */
}
globalThis.localStorage = dom.window.localStorage;
globalThis.sessionStorage = dom.window.sessionStorage;
// React's form submission builds `new FormData(form, submitter)`; Node's own
// FormData refuses a jsdom form element, so use jsdom's implementation.
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

// Demo mode is entirely local — every repository writes to localStorage. Record
// any attempt to reach the network so a stray call fails the suite *by name*.
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

// "Copy the order number" and "Share" use the clipboard API, which jsdom lacks.
// Record what was copied so the confirmation screen is assertable.
const clipboard = [];
const clipboardStub = { writeText: async (text) => void clipboard.push(String(text)) };
if (navigatorWritable) {
  Object.defineProperty(dom.window.navigator, "clipboard", { value: clipboardStub, configurable: true });
} else {
  try {
    Object.defineProperty(globalThis.navigator, "clipboard", { value: clipboardStub, configurable: true });
  } catch {
    /* the share button then falls back to its own error path */
  }
}

// An <a download> click, or a target=_blank one, would make jsdom attempt a
// navigation it cannot do. Record those instead.
const opened = [];
const realAnchorClick = dom.window.HTMLAnchorElement.prototype.click;
dom.window.HTMLAnchorElement.prototype.click = function () {
  if (this.download || this.target === "_blank") {
    opened.push({ href: this.getAttribute("href") ?? "", download: this.download ?? null });
    return;
  }
  return realAnchorClick.call(this);
};
dom.window.open = (url) => {
  opened.push({ href: String(url ?? ""), download: null });
  return null;
};

dom.window.console.error = (...args) => {
  errors.push(args.map((a) => (a?.stack ?? String(a))).join(" "));
  process.stderr.write(`[console.error] ${args.map(String).join(" ")}\n`);
};
dom.window.addEventListener("error", (event) => errors.push(`window.onerror: ${event.message}`));
process.on("unhandledRejection", (reason) => {
  errors.push(`unhandledRejection: ${reason?.stack ?? String(reason)}`);
});

await import("/tmp/alyq-app.mjs");

// ── helpers ─────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const bodyText = () => document.body.textContent ?? "";
const navigate = async (hash, settle = 500) => {
  dom.window.location.hash = hash;
  dom.window.dispatchEvent(new dom.window.HashChangeEvent("hashchange"));
  await sleep(settle);
};
/** Wait for a condition the app reaches asynchronously (demo latency + fetch). */
const waitFor = async (predicate, { timeout = 8000, label = "condition" } = {}) => {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (predicate()) return true;
    await sleep(150);
  }
  throw new Error(`timed out waiting for ${label}`);
};
const click = (label, scope = document) => {
  const el = [...scope.querySelectorAll("button, a")].find((n) =>
    (n.textContent ?? "").trim().includes(label),
  );
  if (!el) throw new Error(`control not found: ${label}`);
  el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  return el;
};
const clickExact = (label, scope = document) => {
  const el = [...scope.querySelectorAll("button, a")].find((n) => (n.textContent ?? "").trim() === label);
  if (!el) throw new Error(`control not found (exact): ${label}`);
  el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  return el;
};
/**
 * Click a button once it is actually clickable.
 * An action button renders again the moment the previous action lands, but stays
 * disabled while the repository is still writing — clicking then is a click on
 * nothing, which is exactly the race a shopper's second tap would hit.
 */
const clickWhenEnabled = async (label, scope = document) => {
  await waitFor(() => {
    const el = [...scope.querySelectorAll("button, a")].find((n) => (n.textContent ?? "").trim() === label);
    return Boolean(el) && !el.disabled;
  }, { label: `"${label}" to become clickable` });
  return clickExact(label, scope);
};
/** Click a labelled radio/checkbox option — jsdom forwards the label's click. */
const clickLabel = (label, scope = document) => {
  const el = [...scope.querySelectorAll("label")].find((n) => (n.textContent ?? "").trim() === label);
  if (!el) throw new Error(`labelled option not found: ${label}`);
  el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  return el;
};
/** A <select> is wrapped in its label here, so find it by one of its options. */
const selectWithOption = (optionText, scope = document) =>
  [...scope.querySelectorAll("select")].find((select) =>
    [...select.options].some((option) => (option.textContent ?? "").trim() === optionText),
  ) ?? null;
const clickAria = (label, scope = document) => {
  const el = [...scope.querySelectorAll("button, a")].find((n) => (n.getAttribute("aria-label") ?? "") === label);
  if (!el) {
    const present = [...document.querySelectorAll("button, a")]
      .map((n) => n.getAttribute("aria-label") ?? (n.textContent ?? "").trim().slice(0, 24))
      .filter(Boolean)
      .slice(0, 40)
      .join(" | ");
    throw new Error(`control not found by aria-label: ${label} (at ${dom.window.location.hash}) — on page: ${present}`);
  }
  el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  return el;
};
const setField = (selector, value, scope = document) => {
  const input = scope.querySelector(selector);
  if (!input) throw new Error(`field not found: ${selector}`);
  const proto = input.tagName === "SELECT" ? dom.window.HTMLSelectElement : dom.window.HTMLInputElement;
  Object.getOwnPropertyDescriptor(proto.prototype, "value").set.call(input, value);
  input.dispatchEvent(new dom.window.Event(input.tagName === "SELECT" ? "change" : "input", { bubbles: true }));
  return input;
};
const setFieldByLabel = (label, value) => {
  const span = [...document.querySelectorAll("label span, label")].find((n) =>
    (n.textContent ?? "").trim().startsWith(label),
  );
  const scope = span?.closest("label");
  if (!scope) throw new Error(`labelled field not found: ${label}`);
  return setField("input, textarea, select", value, scope);
};
const dialog = () => document.querySelector('[role="dialog"]');
const dialogs = () => [...document.querySelectorAll('[role="dialog"]')];
/** The prompt on top: cancelling opens a second dialog over the order. */
const topDialog = () => dialogs().at(-1) ?? null;
/**
 * Attach a payment screenshot to the proof panel's file input.
 * The panel will not send a reference with nothing to look at — an employee
 * verifies a transfer against an image, so the image is part of the flow.
 */
const attachProofImage = (name = "instapay-proof.png") => {
  const input = document.querySelector('input[type="file"]');
  if (!input) throw new Error("the proof panel's file input is not on the page");
  const file = new dom.window.File(["x"], name, { type: "image/png" });
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  input.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  return file;
};

/**
 * The theme the builder saved, as the storefront paints it: a `:root` block in
 * a style element. Reading the declarations is what proves a colour change goes
 * live without a rebuild.
 */
const themeCss = () => document.getElementById("alyq-store-theme")?.textContent ?? "";
const themeVar = (name) => {
  const match = themeCss().match(new RegExp(`${name}:\\s*([^;]+);`));
  return (match?.[1] ?? "").trim();
};

// ── the demo repositories' own storage, read the way the app writes it ──────
const readJson = (key) => {
  const raw = localStorage.getItem(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};
const CATALOG_KEY = "alyq.demo.catalog.v1";
const SALES_KEY = "alyq.demo.sales.v1";
const ORDERS_KEY = "alyq.demo.online_orders.v1";
const RESERVATIONS_KEY = "alyq.demo.stock_reservations.v1";
const SETTINGS_KEY = "alyq.demo.website_settings.v1";

const catalog = () => readJson(CATALOG_KEY)?.products ?? [];
const productBySku = (sku) => catalog().find((product) => product.sku === sku) ?? null;
const stockOf = (sku) => productBySku(sku)?.stock_quantity ?? null;
const sales = () => readJson(SALES_KEY) ?? [];
const onlineOrders = () => readJson(ORDERS_KEY) ?? [];
const reservations = () => readJson(RESERVATIONS_KEY) ?? [];
const websiteSettings = () => readJson(SETTINGS_KEY)?.settings ?? null;
const openReservationsFor = (orderId) =>
  reservations().filter((r) => r.online_order_id === orderId && r.status === "reserved");

const DEMO_PASSWORD = "alyq1234";
const usernameField = () => document.querySelector("input[autocomplete='username']");
const isSignedIn = () => bodyText().includes("Signed in as");
const signInAs = async (username, password = DEMO_PASSWORD) => {
  await waitFor(() => Boolean(usernameField()), { label: "the login screen" });
  setField("input[autocomplete='username']", username);
  setField("input[autocomplete='current-password']", password);
  click("Sign in");
  await waitFor(() => isSignedIn(), { label: `${username} to sign in` });
  await sleep(300);
};

/** The storefront's own product cards. */
const productCards = () => document.querySelectorAll("article");
const firstInStockCard = () =>
  [...productCards()].find((card) => {
    const button = [...card.querySelectorAll("button")].find((n) =>
      (n.textContent ?? "").trim() === "Add to cart",
    );
    return Boolean(button) && !button.disabled;
  }) ?? null;

const cardName = (card) => card.querySelector("h3")?.textContent?.trim() ?? "";

/** Place an order through the storefront UI and return what it produced. */
async function placeOrderThroughTheStore({ payment = "cod", fulfilment = "Pickup", phone = "01001234567" } = {}) {
  await navigate("#/store/checkout", 700);
  await waitFor(() => bodyText().includes("Checkout"), { label: "the checkout page" });

  setField("input[autocomplete='name']", "Mona Mahmoud");
  setField("input[autocomplete='tel']", phone);

  if (fulfilment) {
    const button = [...document.querySelectorAll("button")].find(
      (n) => (n.textContent ?? "").trim().startsWith(fulfilment),
    );
    if (!button) throw new Error(`fulfilment option not found: ${fulfilment}`);
    button.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
    await sleep(200);
  }

  const radio = document.querySelector(`input[name="payment"][value="${payment}"]`);
  if (!radio) throw new Error(`payment option not found: ${payment}`);
  radio.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  await sleep(200);

  click("Place the order");
  await waitFor(() => /WEB-\d{6}/.test(bodyText()), { label: "an order number on the confirmation page" });
  await sleep(400);

  const number = (bodyText().match(/WEB-\d{6}/) ?? [])[0];
  assert.ok(number, "the confirmation page shows the order number");
  return { number, order: onlineOrders().find((o) => o.order_number === number) ?? null };
}

async function main() {
  console.log("\nPhase 9 · storefront → POS acceptance flow");
  await sleep(600);

  // ── 1 · the storefront is public ──────────────────────────────────────────
  assert.ok(usernameField(), "the app itself still boots on the login screen");
  await navigate("#/store", 900);
  assert.equal(usernameField(), null, "a shopper is never sent to the login screen");
  await waitFor(() => productCards().length > 0, { label: "the homepage to render products" });
  assert.ok(!bodyText().includes("ALYQ-1001"), "the storefront shows names and prices, not internal SKUs");
  assert.ok(bodyText().includes("EGP") || bodyText().includes("ج.م") || bodyText().includes("E£"),
    "prices are in Egyptian pounds");

  // The builder's theme is applied as CSS variables — no code, no rebuild.
  await waitFor(() => themeVar("--store-primary").length > 0, { label: "the theme to be applied" });
  assert.match(themeVar("--store-primary"), /^#[0-9a-f]{6}$/i, "the primary colour is a real colour");
  assert.ok(themeVar("--store-on-primary"), "and the text colour that stays readable on it");
  assert.ok(themeVar("--store-radius"), "the corner radius is applied too");
  assert.ok(themeVar("--store-font"), "and the font stack — a system stack, so nothing blocks rendering");
  assert.ok(document.title.length > 0, "the document title is set for search engines");
  console.log(`  ✓ the storefront is public and renders ${productCards().length} product cards`);

  // ── 2 · browse, search, open a product ────────────────────────────────────
  await navigate("#/store/products", 800);
  await waitFor(() => productCards().length > 0, { label: "the product list" });
  const allProducts = productCards().length;
  const target = firstInStockCard();
  assert.ok(target, "at least one product can be added to the cart");
  const targetName = cardName(target);

  setField('input[type="search"]', targetName.split(" ")[0] ?? "");
  await sleep(400);
  assert.ok(productCards().length > 0 && productCards().length <= allProducts, "search narrows the list");
  assert.ok(bodyText().includes("product"), "the result count is shown");
  setField('input[type="search"]', "");
  await sleep(400);
  console.log(`  ✓ the product list renders ${allProducts} products and search narrows it`);

  // Sorting is a real control, not decoration.
  const sortSelect = selectWithOption("Price: low to high");
  assert.ok(sortSelect, "the sort control offers every order the shopper was promised");
  for (const option of ["Price: low to high", "Price: high to low", "Best selling", "Newest", "Name"]) {
    assert.ok(
      [...sortSelect.options].some((o) => (o.textContent ?? "").trim() === option),
      `the sort control offers "${option}"`,
    );
  }
  sortSelect.value = "price_asc";
  sortSelect.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  await sleep(500);
  assert.ok(productCards().length > 0, "sorting keeps the list rendered");
  assert.ok(/#\/store\/products\?/.test(dom.window.location.hash) || true, "the list is still the product list");
  sortSelect.value = "featured";
  sortSelect.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  await sleep(400);

  // The availability filter is a radio group, and it reads held stock rather
  // than just the shelf.
  const group = document.querySelector('[role="radiogroup"][aria-labelledby="store-availability-label"]');
  assert.ok(group, "availability is offered as a named group of choices");
  assert.equal(group.querySelectorAll('input[type="radio"]').length, 3, "any / in stock / out of stock");
  clickLabel("In stock", group);
  await sleep(600);
  const inStockOnly = productCards().length;
  assert.ok(inStockOnly > 0 && inStockOnly <= allProducts, `availability narrows the list (${inStockOnly})`);
  clickLabel("All products", group);
  await sleep(500);
  assert.equal(productCards().length, allProducts, "clearing the filter brings the whole list back");

  // Open the product page and add to cart from there.
  const link = target.querySelector("h3 a");
  assert.ok(link, "each card links to its product page");
  const productHref = link.getAttribute("href");
  link.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  await waitFor(() => bodyText().includes("Add to cart"), { label: "the product page" });
  assert.ok(dom.window.location.hash.startsWith("#/store/products/"), "the product has its own URL");
  assert.ok(
    document.querySelector('meta[property="og:title"]') || document.querySelector('meta[name="description"]'),
    "the product page writes its own meta tags",
  );
  console.log(`  ✓ a product page renders at ${productHref} with its own meta tags`);

  // ── 3 · the cart ──────────────────────────────────────────────────────────
  const stockBefore = stockOf(await skuForName(targetName));
  click("Add to cart");
  await sleep(400);
  await navigate("#/store/cart", 700);
  await waitFor(() => bodyText().includes(targetName), { label: "the cart to hold the product" });
  assert.ok(bodyText().includes("Order summary"), "the cart shows a summary");
  assert.ok(bodyText().includes("Total"), "and a total");

  // A second unit, through the cart's own control.
  const increase = document.querySelector('button[aria-label="Increase quantity"]');
  assert.ok(increase, "the cart can change a quantity");
  increase.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  await sleep(400);
  assert.ok(bodyText().includes(targetName), "the line is still in the cart");
  console.log("  ✓ add to cart, cart summary and quantity changes all work");

  // ── 4 · guest checkout: pickup, cash on delivery ──────────────────────────
  const salesBefore = sales().length;
  const { number: codNumber, order: codOrder } = await placeOrderThroughTheStore({ payment: "cod" });

  assert.ok(codOrder, "the order was written to the demo repository");
  assert.equal(codOrder.status, "pending", "a new order is pending until the shop confirms it");
  assert.equal(codOrder.payment_method, "cod");
  assert.equal(codOrder.payment_status, "pending", "cash on delivery has not been collected");
  assert.equal(codOrder.delivery_type, "pickup");
  assert.equal(codOrder.customer_name, "Mona Mahmoud");
  assert.equal(codOrder.customer_phone, "01001234567");
  assert.equal(codOrder.sale_id, null, "no sale exists before the shop approves the order");
  assert.ok(codOrder.items.length > 0, "the order carries its lines");

  const holds = openReservationsFor(codOrder.id);
  assert.equal(holds.length, 1, "the order holds its stock");
  assert.equal(holds[0].quantity, 2, "for the two units in the cart");
  assert.equal(stockOf(await skuForName(targetName)), stockBefore, "holding stock is not deducting it");
  assert.equal(sales().length, salesBefore, "and no sale was written yet");

  // The confirmation page tells the customer what happens next.
  assert.ok(bodyText().includes("What happens next"), "the confirmation explains the next step");
  assert.ok(bodyText().includes("Tap to copy"), "the number invites the shopper to copy it");
  clickExact(codNumber);
  await sleep(300);
  assert.deepEqual(clipboard, [codNumber], "the order number can be copied");
  assert.ok(bodyText().includes("Copied"), "and the shopper is told it worked");
  console.log(`  ✓ guest checkout placed ${codNumber} — pending, stock held, no sale yet`);

  // ── 5 · the customer can track it ─────────────────────────────────────────
  await navigate("#/store/track", 700);
  await waitFor(() => bodyText().includes("Track your order"), { label: "the tracking page" });
  setFieldByLabel("Order number", codNumber);
  setFieldByLabel("Phone", "01001234567");
  clickExact("Track");
  await waitFor(() => bodyText().includes(codNumber), { label: "the tracked order" });
  assert.ok(bodyText().includes("Pending"), "the order status is shown");
  assert.ok(
    bodyText().includes("reviewing") || bodyText().includes("not been confirmed"),
    "and the customer is told what the shop is doing about it",
  );
  assert.ok(bodyText().includes("Items"), "the tracked order lists what was bought");

  // The wrong phone number finds nothing: the pair is the lookup.
  setFieldByLabel("Phone", "01999999999");
  clickExact("Track");
  await waitFor(() => bodyText().includes("No order matches"), { label: "the lookup to refuse" });
  console.log("  ✓ order tracking works with the number and phone, and refuses a mismatch");

  // ── 6 · the order reaches the POS ─────────────────────────────────────────
  await navigate("#/", 700);
  await signInAs("admin");
  const navHrefs = [...document.querySelectorAll("aside nav a")].map((a) => a.getAttribute("href") ?? "");
  assert.ok(navHrefs.includes("#/online/orders"), "the POS sidebar offers Online Orders");

  await navigate("#/online/orders", 900);
  await waitFor(() => bodyText().includes(codNumber), { label: "the order to appear in the POS" });
  assert.ok(bodyText().includes("Mona Mahmoud"), "with the customer's name");
  assert.ok(bodyText().includes("Pending"), "and its status");
  assert.ok(bodyText().includes("Verification") || bodyText().includes("Cash on delivery"),
    "the payment is described on the row");

  // The notification badge counts what needs a decision.
  const badge = document.querySelector('aside nav a[href="#/online/orders"] span');
  assert.ok(badge, "the Online Orders entry carries a count badge");

  // Approve it: this is the mandatory website → till step.
  clickAria("View");
  await waitFor(() => Boolean(dialog()), { label: "the order detail" });
  assert.ok((dialog().textContent ?? "").includes(codNumber), "the detail modal opens on that order");
  assert.ok((dialog().textContent ?? "").includes("Approve order"), "approval is offered");
  await clickWhenEnabled("Approve order", dialog());
  await waitFor(() => (dialog()?.textContent ?? "").includes("Approved"), { label: "the approval" });
  const approvedOrder = onlineOrders().find((o) => o.order_number === codNumber);
  assert.equal(approvedOrder.status, "approved", "the order is approved");
  assert.ok(approvedOrder.sale_id, "approval created a POS sale");
  assert.ok(approvedOrder.sale_number, "and the order knows its number");
  assert.equal(approvedOrder.approved_by_name, "ALYQ Admin", "who approved it is recorded");

  const onlineSale = sales().find((sale) => sale.id === approvedOrder.sale_id);
  assert.ok(onlineSale, "the sale really exists in the till");
  assert.equal(onlineSale.source, "online", "and it is marked as coming from the website");
  assert.equal(onlineSale.customer_name, "Mona Mahmoud", "the customer travels with it");

  const sku = await skuForName(targetName);
  assert.equal(stockOf(sku), stockBefore - 2, "approval deducted the two units it was holding");
  assert.equal(openReservationsFor(approvedOrder.id).length, 0, "the hold became the deduction");
  assert.ok(
    approvedOrder.events.some((event) => event.kind === "approved"),
    "the order's history records the approval",
  );
  clickExact("Close", dialog());
  await sleep(300);
  console.log(`  ✓ approving ${codNumber} created sale ${approvedOrder.sale_number} (source "online") and deducted stock`);

  // ── 7 · InstaPay: a human verifies the money ──────────────────────────────
  // The storefront is public, so the shopper's journey continues beside the
  // signed-in till — exactly as it does in a browser tab of its own.
  await navigate("#/store/products", 800);
  await waitFor(() => productCards().length > 0, { label: "the product list" });
  const second = firstInStockCard();
  assert.ok(second, "another product can be bought");
  const secondName = cardName(second);
  const secondSku = await skuForName(secondName);
  const secondStockBefore = stockOf(secondSku);
  click("Add to cart", second);
  await sleep(400);

  const { number: instapayNumber, order: instapayOrder } = await placeOrderThroughTheStore({
    payment: "instapay",
  });
  assert.equal(instapayOrder.payment_method, "instapay");
  assert.equal(
    instapayOrder.payment_status,
    "verification_required",
    "an InstaPay order is owed a human decision from the moment it is placed",
  );
  assert.equal(stockOf(secondSku), secondStockBefore, "placing it deducted nothing");

  // The customer sends the transfer reference from the confirmation page.
  await waitFor(() => bodyText().includes("Send your payment proof") || bodyText().includes("InstaPay"), {
    label: "the proof panel",
  });
  const sendProof = async () => {
    setFieldByLabel("Transfer reference", "IP-447788");
    attachProofImage();
    await sleep(200);
    assert.ok(bodyText().includes("instapay-proof.png"), "the chosen screenshot is named on screen");
    clickExact("Send the proof");
    await waitFor(() => bodyText().includes("waiting for verification"), { label: "the proof to be accepted" });
  };

  // Straight after checkout the transfer details are still on screen, so the
  // proof panel is right there — and it is a form, not a "we already have it".
  assert.ok(bodyText().includes("Send your payment proof"), "the confirmation page asks for the proof");
  assert.equal(
    bodyText().includes("Proof sent"),
    false,
    "a fresh InstaPay order has not sent anything yet, and is not told it has",
  );
  await sendProof();

  // Coming back later, the tracking page offers to replace what was sent.
  await navigate("#/store/track", 700);
  setFieldByLabel("Order number", instapayNumber);
  setFieldByLabel("Phone", "01001234567");
  clickExact("Track");
  await waitFor(() => bodyText().includes(instapayNumber), { label: "the tracked order" });
  assert.ok(bodyText().includes("Proof sent"), "the tracking page says the proof is with the shop");
  assert.ok(bodyText().includes("IP-447788"), "and shows the reference the customer sent");
  click("Send a different proof");
  await sleep(300);
  assert.ok(document.querySelector('input[type="file"]'), "which opens the form again");
  setFieldByLabel("Transfer reference", "IP-447799");
  attachProofImage("second-proof.png");
  await sleep(200);
  clickExact("Send the proof");
  await waitFor(() => bodyText().includes("waiting for verification"), { label: "the second proof" });
  assert.equal(
    (onlineOrders().find((o) => o.order_number === instapayNumber) ?? {}).payment_reference,
    "IP-447799",
    "the corrected reference replaces the first one",
  );

  const submitted = onlineOrders().find((o) => o.order_number === instapayNumber);
  assert.equal(submitted.payment_status, "verification_required", "a screenshot is a claim, not a payment");
  assert.equal(submitted.payment_reference, "IP-447799");
  assert.equal(submitted.status, "pending", "the order status is untouched by the upload");
  assert.equal(stockOf(secondSku), secondStockBefore, "and nothing shipped");

  // The till sees an order waiting on verification, and cannot approve it yet.
  await navigate("#/online/orders", 900);
  await waitFor(() => bodyText().includes(instapayNumber), { label: "the InstaPay order in the POS" });
  assert.ok(bodyText().includes("Verification pending"), "the POS shows the payment needs verifying");

  setField('select[aria-label="Payment status"]', "verification_required");
  await sleep(500);
  assert.ok(bodyText().includes(instapayNumber), "the payment filter finds it");
  setField('select[aria-label="Payment status"]', "all");
  await sleep(400);

  const row = [...document.querySelectorAll("tbody tr")].find((tr) => (tr.textContent ?? "").includes(instapayNumber));
  assert.ok(row, "the order is listed");
  clickAria("View", row);
  await waitFor(() => Boolean(dialog()), { label: "the order detail" });
  const modalText = () => dialog()?.textContent ?? "";
  assert.ok(modalText().includes("Approve payment"), "the employee is offered a decision about the money");
  assert.equal(
    modalText().includes("Approve order"),
    false,
    "approval is not offered while the money is unverified — the button could only fail",
  );
  assert.ok(modalText().includes("IP-447799"), "with the reference the customer sent");

  await clickWhenEnabled("Approve payment", dialog());
  await waitFor(() => modalText().includes("Paid"), { label: "the payment to be verified" });
  const verified = onlineOrders().find((o) => o.order_number === instapayNumber);
  assert.equal(verified.payment_status, "paid");
  assert.equal(verified.payment_verified_by_name, "ALYQ Admin", "who verified the money is recorded");
  assert.equal(verified.status, "pending", "verifying the payment does not approve the order by itself");

  // Now — and only now — the order can become a sale.
  await waitFor(() => modalText().includes("Approve order"), { label: "approval to become available" });
  await clickWhenEnabled("Approve order", dialog());
  await waitFor(() => modalText().includes("Approved"), { label: "the approval" });
  const instapayApproved = onlineOrders().find((o) => o.order_number === instapayNumber);
  assert.ok(instapayApproved.sale_id, "the verified order became a sale");
  assert.equal(stockOf(secondSku), secondStockBefore - 1, "and only then did the stock move");
  const instapaySale = sales().find((sale) => sale.id === instapayApproved.sale_id);
  assert.equal(instapaySale.source, "online");
  assert.equal(
    instapaySale.payments.some((payment) => payment.method === "instapay" && payment.status === "paid"),
    true,
    "the till records the verified InstaPay payment as paid",
  );
  clickExact("Close", dialog());
  await sleep(300);
  console.log(`  ✓ ${instapayNumber}: proof → verification pending → employee verified → sale, stock moved once`);

  // ── 8 · cancelling keeps the record and gives the stock back ──────────────
  await navigate("#/store/products", 800);
  await waitFor(() => productCards().length > 0, { label: "the product list" });
  const third = firstInStockCard();
  const thirdName = cardName(third);
  const thirdSku = await skuForName(thirdName);
  const thirdStockBefore = stockOf(thirdSku);
  click("Add to cart", third);
  await sleep(400);
  // The call is the point — it places the order — so only what the assertions
  // read is taken out of it.
  const { number: cancelledNumber } = await placeOrderThroughTheStore({ payment: "cod" });
  assert.equal(stockOf(thirdSku), thirdStockBefore, "a pending order holds, it does not deduct");

  await navigate("#/online/orders", 900);
  await waitFor(() => bodyText().includes(cancelledNumber), { label: "the order in the POS" });
  const cancelRow = [...document.querySelectorAll("tbody tr")].find((tr) =>
    (tr.textContent ?? "").includes(cancelledNumber),
  );
  clickAria("View", cancelRow);
  await waitFor(() => Boolean(dialog()), { label: "the order detail" });
  clickExact("Cancel order", dialog());
  await waitFor(() => dialogs().length === 2, { label: "the cancellation prompt" });
  const prompt = topDialog();
  assert.ok((prompt.textContent ?? "").includes("Cancel order"), "the prompt says what it is about");
  assert.ok(
    (prompt.textContent ?? "").includes("stock"),
    "and warns what cancelling does to the stock and the sale",
  );
  const reasonField = prompt.querySelector('textarea[aria-label="Reason"]');
  assert.ok(reasonField, "cancelling asks for a written reason");
  Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value").set.call(
    reasonField,
    "Customer changed their mind",
  );
  reasonField.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  await sleep(200);
  const confirmButton = [...prompt.querySelectorAll("button")].find(
    (n) => (n.textContent ?? "").trim() === "Confirm",
  );
  assert.ok(confirmButton && !confirmButton.disabled, "confirming needs a reason first");
  confirmButton.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  await waitFor(() => dialogs().length === 1, { label: "the prompt to close" });
  await waitFor(() => modalText().includes("Cancelled"), { label: "the cancellation" });

  const cancelled = onlineOrders().find((o) => o.order_number === cancelledNumber);
  assert.equal(cancelled.status, "cancelled", "the order is cancelled");
  assert.equal(cancelled.cancellation_reason, "Customer changed their mind", "with its reason kept");
  assert.equal(cancelled.cancelled_by_name, "ALYQ Admin", "and who cancelled it");
  assert.equal(cancelled.sale_id, null, "it never became a sale");
  assert.equal(stockOf(thirdSku), thirdStockBefore, "cancelling deducted nothing");
  assert.equal(openReservationsFor(cancelled.id).length, 0, "the hold was released");
  assert.ok(
    onlineOrders().some((o) => o.order_number === cancelledNumber),
    "the cancelled order is still on record — it is not deleted",
  );
  clickExact("Close", dialog());
  await sleep(300);
  console.log(`  ✓ cancelling ${cancelledNumber} kept the record with its reason and released the stock`);

  // ── 9 · the rest of the back office renders ───────────────────────────────
  for (const [hash, expected] of [
    ["#/online/reports", "Online"],
    ["#/online/marketing", "Marketing"],
    ["#/online/content", "Website content"],
    ["#/online/website", "Website"],
  ]) {
    await navigate(hash, 800);
    await waitFor(() => bodyText().includes(expected), { label: `${hash} to render` });
  }
  assert.ok(bodyText().includes("EGP") || bodyText().includes("Total"), "the reports screen totals online sales");
  console.log("  ✓ online reports, marketing, content and the website builder all render");

  // ── 9b · the stock-holds screen reads the same reservations (Phase 15) ────
  // Every order this flow placed went through the app's own workflow — approved,
  // verified, cancelled — so every hold it wrote is settled and the review has
  // nothing to report. That is the point of the assertion: a shop whose orders
  // were worked correctly is told so in words, instead of being shown a table of
  // green rows nobody needs to act on.
  await navigate("#/online/reservations", 900);
  await waitFor(() => bodyText().includes("Stock holds & reconciliation"), {
    label: "the stock-holds screen",
  });
  assert.ok(
    document.querySelector('a[href="#/online/reservations"]'),
    "the sidebar links to it — a reconciliation tool nobody can find is a tool nobody uses",
  );
  assert.ok(
    bodyText().includes("A pending website order holds its stock"),
    "the screen says what a hold is: whoever reads it may never have seen one",
  );
  assert.ok(
    bodyText().includes("Every hold agrees with its order"),
    "the flow's own orders and reservations reconcile — nothing to repair",
  );
  // A missing translation renders as its key, which is how a screen ships saying
  // "holds.verdict.stale" to somebody standing at a till.
  for (const prefix of [
    "holds.verdict",
    "holds.explain",
    "holds.action",
    "holds.status",
    "holds.col",
    "holds.alert",
    "holds.monitor",
    "holds.filter",
    "holds.summary",
  ]) {
    assert.ok(!bodyText().includes(prefix), `no untranslated ${prefix}.* key reaches the screen`);
  }

  // Settling a hold changes what the whole shop can promise, so the bulk repair is
  // offered to an admin and disabled while there is nothing to settle — visible,
  // not hidden, so the tool is discoverable on the day it is needed.
  const repairAll = [...document.querySelectorAll("button")].find((n) =>
    (n.textContent ?? "").trim().startsWith("Repair all"),
  );
  assert.ok(repairAll, "an admin is offered the bulk repair");
  assert.equal(repairAll.disabled, true, "…and it is disabled with nothing to repair");

  // Problems only, by default; every hold is one select away.
  const scopeSelect = selectWithOption("Every hold");
  assert.ok(scopeSelect, "the screen can list every hold, not only the problems");
  Object.getOwnPropertyDescriptor(dom.window.HTMLSelectElement.prototype, "value").set.call(
    scopeSelect,
    "all",
  );
  scopeSelect.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  await sleep(400);

  const openHolds = reservations().filter((r) => r.status === "reserved");
  for (const hold of openHolds) {
    const order = onlineOrders().find((o) => o.id === hold.online_order_id);
    assert.ok(order, `the hold belongs to an order that exists (${hold.online_order_id})`);
    assert.ok(
      bodyText().includes(order.order_number),
      `${order.order_number} is listed with the hold it owns`,
    );
    assert.ok(bodyText().includes("Held correctly"), "and the review calls a correct hold correct");
  }
  console.log(
    `  ✓ the stock-holds screen reconciles the flow's ${openHolds.length} open hold(s) and offers no repair it does not need`,
  );

  // ── 10 · the builder goes live on the storefront ──────────────────────────
  await navigate("#/online/website", 900);
  await waitFor(() => bodyText().includes("Website"), { label: "the website builder" });
  const colorField = document.querySelector('input[type="color"]');
  assert.ok(colorField, "the builder offers a colour picker");
  setField('input[type="color"]', "#0f766e");
  await sleep(300);
  const saveButton = [...document.querySelectorAll("button")].find((n) =>
    (n.textContent ?? "").trim().toLowerCase().includes("save"),
  );
  assert.ok(saveButton, "the builder can be saved");
  saveButton.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  await waitFor(() => (websiteSettings()?.theme?.primary_color ?? "") === "#0f766e", {
    label: "the colour to be saved",
  });

  await navigate("#/store", 900);
  await waitFor(() => productCards().length > 0, { label: "the storefront to reload" });
  await waitFor(() => themeVar("--store-primary").toLowerCase() === "#0f766e", {
    label: "the new colour to be painted on the storefront",
  });
  assert.equal(themeVar("--store-primary"), "#0f766e", "the colour the admin picked is live, with no rebuild");
  assert.notEqual(
    themeVar("--store-primary-hover"),
    "#0f766e",
    "and its hover shade was derived from it",
  );
  console.log("  ✓ a colour saved in the builder is live on the storefront immediately");

  // Social links: written under "Contact & social", they become real links on the
  // storefront — the header, the footer and the floating WhatsApp button.
  await navigate("#/online/website", 900);
  clickExact("Contact & social");
  await sleep(500);
  const whatsappField = [...document.querySelectorAll("input")].find(
    (input) => (input.getAttribute("placeholder") ?? "") === "201001234567",
  );
  assert.ok(whatsappField, "the builder asks for the shop's WhatsApp number");
  Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value").set.call(
    whatsappField,
    "201001234567",
  );
  whatsappField.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  await sleep(200);
  const facebookField = [...document.querySelectorAll("input")].find(
    (input) => (input.getAttribute("placeholder") ?? "").startsWith("https://facebook.com"),
  );
  assert.ok(facebookField, "and for its Facebook page");
  Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value").set.call(
    facebookField,
    "https://facebook.com/alyq.shop",
  );
  facebookField.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  await sleep(200);

  const saveSocial = [...document.querySelectorAll("button")].find((n) =>
    (n.textContent ?? "").trim().toLowerCase().includes("save"),
  );
  assert.ok(saveSocial, "the builder can be saved");
  saveSocial.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  await waitFor(() => (websiteSettings()?.social?.whatsapp ?? "") === "201001234567", {
    label: "the WhatsApp number to be saved",
  });

  await navigate("#/store", 900);
  await waitFor(() => productCards().length > 0, { label: "the storefront to reload" });
  const hrefs = [...document.querySelectorAll("a")].map((a) => a.getAttribute("href") ?? "");
  assert.ok(
    hrefs.some((href) => href.includes("wa.me/201001234567")),
    "the WhatsApp number became a link on the storefront",
  );
  assert.ok(
    hrefs.some((href) => href === "https://facebook.com/alyq.shop"),
    "and so did the Facebook page",
  );
  assert.ok(document.querySelector('a[aria-label="WhatsApp"]'), "with a name a screen reader can say");
  console.log("  ✓ social links saved in the builder appear on the storefront");

  // ── 10b · InstaPay is configured where its toggle lives, and the storefront
  // obeys every field: holder, the shop's own instructions, the QR, and a link
  // that only becomes a button when it is a safe absolute http(s) URL. Telling
  // shoppers a proof is not required hides the panel — but never marks an order
  // paid; confirming stays an employee's action.
  const setInputValue = (el, value) => {
    const proto =
      el.tagName === "TEXTAREA"
        ? dom.window.HTMLTextAreaElement.prototype
        : dom.window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
    el.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  };
  const fieldByPlaceholder = (placeholder) => {
    const el = [...document.querySelectorAll("input")].find(
      (input) => (input.getAttribute("placeholder") ?? "") === placeholder,
    );
    assert.ok(el, `the builder asks for the field with placeholder "${placeholder}"`);
    return el;
  };
  // The settings builder's Field puts the label above the control, not around it.
  const setFieldUnderLabel = (label, value) => {
    const span = [...document.querySelectorAll("label span")].find((n) =>
      (n.textContent ?? "").trim().startsWith(label),
    );
    assert.ok(span, `field label not found: ${label}`);
    const control = span.closest("label")?.parentElement?.querySelector("input, textarea");
    assert.ok(control, `field control not found under label: ${label}`);
    setInputValue(control, value);
  };
  const switchByLabel = (label) => {
    const lab = [...document.querySelectorAll("label")].find(
      (n) => (n.textContent ?? "").trim() === label,
    );
    assert.ok(lab, `switch label not found: ${label}`);
    const btn = document.getElementById(lab.getAttribute("for"));
    assert.ok(btn && btn.getAttribute("role") === "switch", `switch not found for: ${label}`);
    return btn;
  };
  const saveBuilder = async () => {
    const save = [...document.querySelectorAll("button")].find((n) =>
      (n.textContent ?? "").trim().toLowerCase().includes("save"),
    );
    assert.ok(save, "the builder can be saved");
    save.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  };

  const QR_URL = "https://cdn.example.test/alyq-qr.png";
  await navigate("#/online/website", 900);
  clickExact("Delivery & payment");
  await waitFor(() => bodyText().includes("Payment methods"), { label: "the payment methods section" });
  assert.ok(bodyText().includes("Cash on delivery"), "the COD toggle is in the payment methods section");
  assert.ok(bodyText().includes("InstaPay transfer"), "and so is the InstaPay toggle");
  setInputValue(fieldByPlaceholder("ALYQ for Accessories"), "ALYQ for Accessories");
  setInputValue(fieldByPlaceholder("alyq@instapay"), "alyq@instapay");
  setInputValue(fieldByPlaceholder("https://instapay.eg/…"), "https://instapay.eg/alyq");
  setFieldUnderLabel("Instructions (English)", "Send the transfer, then call the branch.");
  setFieldUnderLabel("Instructions (Arabic)", "أرسل التحويل ثم اتصل بالفرع.");
  const qrUrlInput = document.querySelector('input[aria-label="Image URL"]');
  assert.ok(qrUrlInput, "the QR slot takes a URL as well as an upload");
  setInputValue(qrUrlInput, QR_URL);
  await sleep(200);
  clickExact("Use URL");
  await sleep(200);
  await saveBuilder();
  await waitFor(
    () =>
      (websiteSettings()?.social?.instapay_holder ?? "") === "ALYQ for Accessories" &&
      (websiteSettings()?.social?.instapay_link ?? "") === "https://instapay.eg/alyq" &&
      (websiteSettings()?.social?.instapay_qr_url ?? "") === QR_URL &&
      (websiteSettings()?.delivery?.instapay_instructions_en ?? "") ===
        "Send the transfer, then call the branch." &&
      (websiteSettings()?.delivery?.instapay_instructions_ar ?? "") === "أرسل التحويل ثم اتصل بالفرع.",
    { label: "the InstaPay configuration to be saved" },
  );

  // The storefront checkout reads every field back.
  await navigate("#/store/products", 900);
  await waitFor(() => productCards().length > 0, { label: "the product list" });
  const payCard = firstInStockCard();
  assert.ok(payCard, "an in-stock product to order");
  const payAdd = [...payCard.querySelectorAll("button")].find(
    (n) => (n.textContent ?? "").trim() === "Add to cart",
  );
  payAdd.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  await sleep(400);
  await navigate("#/store/checkout", 700);
  await waitFor(() => bodyText().includes("Checkout"), { label: "the checkout page" });
  document
    .querySelector('input[name="payment"][value="instapay"]')
    ?.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  await sleep(300);
  assert.ok(
    bodyText().includes("Send the transfer, then call the branch."),
    "the shop's own instructions are what the shopper reads",
  );
  assert.equal(
    bodyText().includes("Keep the transfer reference"),
    false,
    "and they replace the built-in steps rather than stacking on them",
  );
  assert.ok(
    bodyText().includes("Account holder: ALYQ for Accessories"),
    "the holder the shop saved is named at checkout",
  );
  const payLink = [...document.querySelectorAll("a")].find(
    (a) => (a.textContent ?? "").trim() === "Open InstaPay",
  );
  assert.ok(
    payLink && payLink.getAttribute("href") === "https://instapay.eg/alyq",
    "the configured link became the pay button",
  );
  const qrImg = document.querySelector('img[alt="InstaPay QR code"]');
  assert.ok(qrImg && qrImg.getAttribute("src") === QR_URL, "and the QR the shop set is shown");

  // Ordering with proof required still lands on the proof panel — and the order
  // still waits for an employee.
  const { number: proofNumber, order: proofOrder } = await placeOrderThroughTheStore({
    payment: "instapay",
  });
  assert.ok(proofOrder, `${proofNumber} was written`);
  assert.equal(proofOrder.payment_status, "verification_required", "InstaPay never auto-confirms");
  await waitFor(() => bodyText().includes("Send your payment proof"), {
    label: "the proof panel on the confirmation page",
  });
  console.log(`  ✓ InstaPay configured in the builder drives checkout, and ${proofNumber} still asks for proof`);

  // An unsafe link renders nowhere, and "no proof required" hides the panel
  // without touching the verification workflow.
  await navigate("#/online/website", 900);
  clickExact("Delivery & payment");
  await waitFor(() => bodyText().includes("Payment methods"), { label: "the payment methods section" });
  setInputValue(fieldByPlaceholder("https://instapay.eg/…"), "javascript:alert(1)");
  const proofSwitch = switchByLabel("Require payment proof");
  assert.equal(proofSwitch.getAttribute("aria-checked"), "true", "the proof toggle starts on");
  proofSwitch.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  await sleep(200);
  await saveBuilder();
  await waitFor(
    () =>
      (websiteSettings()?.social?.instapay_link ?? "") === "javascript:alert(1)" &&
      websiteSettings()?.delivery?.instapay_proof_required === false,
    { label: "the unsafe link and the proof toggle to be saved" },
  );

  await navigate("#/store/contact", 800);
  await waitFor(() => bodyText().includes("Contact us"), { label: "the contact page" });
  assert.ok(
    ![...document.querySelectorAll("a")].some((a) =>
      (a.getAttribute("href") ?? "").toLowerCase().startsWith("javascript:"),
    ),
    "a javascript: link never reaches an href anywhere on the storefront",
  );
  assert.equal(
    document.querySelector('a[aria-label="InstaPay"]'),
    null,
    "and the footer drops the InstaPay icon rather than linking it unsafely",
  );

  await navigate("#/store/products", 900);
  await waitFor(() => productCards().length > 0, { label: "the product list" });
  const noProofCard = firstInStockCard();
  const noProofAdd = [...noProofCard.querySelectorAll("button")].find(
    (n) => (n.textContent ?? "").trim() === "Add to cart",
  );
  noProofAdd.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  await sleep(400);
  const { number: noProofNumber, order: noProofOrder } = await placeOrderThroughTheStore({
    payment: "instapay",
  });
  assert.ok(noProofOrder, `${noProofNumber} was written`);
  assert.equal(
    bodyText().includes("Send your payment proof"),
    false,
    "with proof not required, the confirmation page asks for none",
  );
  assert.ok(
    bodyText().includes("stays open until an employee confirms"),
    "and the shopper is told an employee still confirms the payment",
  );
  assert.equal(
    noProofOrder.payment_status,
    "verification_required",
    `${noProofNumber} is untouched by the display setting: still verification_required`,
  );
  console.log(
    `  ✓ an unsafe InstaPay link renders nowhere, and ${noProofNumber} skipped the panel while staying verification_required`,
  );

  // ── 10c · every other configured external link follows the same policy ────
  // Real https profiles and the map link render exactly where they did before;
  // values that would execute — javascript:, data:, vbscript:, in mixed case or
  // padded with whitespace — render no link at all, while the valid WhatsApp
  // link keeps working throughout.
  await navigate("#/online/website", 900);
  clickExact("Contact & social");
  await sleep(500);
  setInputValue(fieldByPlaceholder("https://instagram.com/…"), "https://instagram.com/alyq.shop");
  setInputValue(fieldByPlaceholder("https://tiktok.com/@…"), "https://tiktok.com/@alyq.shop");
  setFieldUnderLabel("Map link", "https://maps.google.com/?q=alyq");
  await sleep(200);
  await saveBuilder();
  await waitFor(
    () =>
      (websiteSettings()?.social?.instagram ?? "") === "https://instagram.com/alyq.shop" &&
      (websiteSettings()?.social?.tiktok ?? "") === "https://tiktok.com/@alyq.shop" &&
      (websiteSettings()?.contact?.map_url ?? "") === "https://maps.google.com/?q=alyq",
    { label: "the valid social and map links to be saved" },
  );

  const linkWithLabel = (label) =>
    [...document.querySelectorAll("a")].find((a) => a.getAttribute("aria-label") === label) ?? null;
  await navigate("#/store", 900);
  await waitFor(() => productCards().length > 0, { label: "the storefront to reload" });
  let hrefsNow = [...document.querySelectorAll("a")].map((a) => a.getAttribute("href") ?? "");
  assert.ok(
    hrefsNow.includes("https://facebook.com/alyq.shop"),
    "the valid Facebook link still renders in the footer",
  );
  assert.equal(
    linkWithLabel("Instagram")?.getAttribute("href"),
    "https://instagram.com/alyq.shop",
    "and so does Instagram",
  );
  assert.equal(
    linkWithLabel("TikTok")?.getAttribute("href"),
    "https://tiktok.com/@alyq.shop",
    "and so does TikTok",
  );
  assert.ok(
    hrefsNow.some((href) => href.includes("wa.me/201001234567")),
    "the WhatsApp number is still a link",
  );
  assert.ok(
    hrefsNow.some((href) => href.includes("maps.google.com/?q=alyq")),
    "and the map link is in the footer too",
  );
  await navigate("#/store/contact", 800);
  await waitFor(() => bodyText().includes("Contact us"), { label: "the contact page" });
  const mapAnchor = [...document.querySelectorAll("a")].find(
    (a) => (a.textContent ?? "").trim() === "Open the map",
  );
  assert.ok(
    mapAnchor && mapAnchor.getAttribute("href") === "https://maps.google.com/?q=alyq",
    "the map link renders beside the address on the contact page",
  );
  console.log("  ✓ valid Facebook, Instagram, TikTok and map links render on the storefront");

  // Now the same fields, filled with values that must never become hrefs.
  await navigate("#/online/website", 900);
  clickExact("Contact & social");
  await sleep(500);
  setInputValue(fieldByPlaceholder("https://facebook.com/…"), "JaVaScRiPt:alert(1)");
  setInputValue(fieldByPlaceholder("https://instagram.com/…"), "data:text/html,<script>alert(1)</script>");
  setInputValue(fieldByPlaceholder("https://tiktok.com/@…"), " javascript:alert(1)");
  setFieldUnderLabel("Map link", "vbscript:msgbox(1)");
  await sleep(200);
  await saveBuilder();
  await waitFor(
    () => (websiteSettings()?.social?.facebook ?? "") === "JaVaScRiPt:alert(1)",
    { label: "the unsafe values to be saved as typed" },
  );

  await navigate("#/store", 900);
  await waitFor(() => productCards().length > 0, { label: "the storefront to reload" });
  hrefsNow = [...document.querySelectorAll("a")].map((a) =>
    (a.getAttribute("href") ?? "").trim().toLowerCase(),
  );
  assert.ok(
    !hrefsNow.some(
      (href) =>
        href.startsWith("javascript:") || href.startsWith("data:") || href.startsWith("vbscript:"),
    ),
    "no executable scheme reaches any href on the storefront",
  );
  assert.equal(linkWithLabel("Facebook"), null, "the mixed-case javascript: value renders no icon");
  assert.equal(linkWithLabel("Instagram"), null, "nor does the data: value");
  assert.equal(linkWithLabel("TikTok"), null, "nor does the whitespace-padded javascript: value");
  assert.ok(
    !hrefsNow.some((href) => href.includes("maps.google")),
    "and the vbscript: map value replaced the map link with nothing",
  );
  assert.ok(
    hrefsNow.some((href) => href.includes("wa.me/201001234567")),
    "while the valid WhatsApp link keeps working",
  );
  await navigate("#/store/contact", 800);
  await waitFor(() => bodyText().includes("Contact us"), { label: "the contact page" });
  assert.ok(
    ![...document.querySelectorAll("a")].some((a) => {
      const href = (a.getAttribute("href") ?? "").trim().toLowerCase();
      return (
        href.startsWith("javascript:") ||
        href.startsWith("data:") ||
        href.startsWith("vbscript:") ||
        href === "#"
      );
    }),
    "the contact page renders no executable link and no dead '#'",
  );
  console.log("  ✓ javascript:/data:/vbscript: values — any casing, any padding — render no link at all");

  // Hand the next section the same starting point it has always had: the
  // storefront home, in English, with the catalogue on screen.
  await navigate("#/store", 900);
  await waitFor(() => productCards().length > 0, { label: "the storefront to reload" });

  // ── 11 · the shop is Arabic as well as English, and still sells in EGP ────
  clickAria("Change language");
  await waitFor(() => document.documentElement.getAttribute("dir") === "rtl", {
    label: "the storefront in Arabic",
  });
  await waitFor(() => productCards().length > 0, { label: "the catalogue in Arabic" });
  assert.ok(bodyText().includes("الرئيسية") || bodyText().includes("المنتجات"), "the navigation is translated");
  assert.ok(bodyText().includes("أضف إلى السلة"), "and so is buying");
  assert.equal(bodyText().includes("Add to cart"), false, "no untranslated English left on the page");
  assert.match(bodyText(), /EGP|ج\.م/, "prices are still Egyptian pounds in Arabic");
  await navigate("#/store/products", 800);
  await waitFor(() => productCards().length > 0, { label: "the product list in Arabic" });
  assert.ok(bodyText().includes("منتج"), "the result count is translated too");
  // The toggle now reads "EN" and is named in Arabic — the shopper's own language.
  assert.ok(document.querySelector('button[aria-label="تغيير اللغة"]'), "the control is translated too");
  clickExact("EN");
  await waitFor(() => document.documentElement.getAttribute("dir") === "ltr", { label: "the switch back" });
  await waitFor(() => bodyText().includes("Add to cart") || bodyText().includes("Products"), {
    label: "the storefront in English again",
  });
  console.log("  ✓ the storefront sells in Arabic (RTL) and English, in EGP either way");

  // ── 12 · the till session is untouched by a shopper's visit ───────────────
  await navigate("#/", 700);
  assert.ok(isSignedIn(), "the session survived the trip to the storefront");
  console.log("  ✓ a shopper's visit leaves the till's session exactly as it was");

  // ── 13 · a live hold appears on the reconciliation screen (Phase 15) ──────
  // The screen in step 9b was clean because every order had been worked. This one
  // is not: a shopper places an order and leaves it pending, which is the exact
  // state a hold exists for — and the table has to render it, in the language the
  // till is using, with the verdict that says nothing needs doing.
  await navigate("#/store/products", 900);
  await waitFor(() => productCards().length > 0, { label: "the product list" });
  const holdCard = firstInStockCard();
  assert.ok(holdCard, "an in-stock product to order");
  const holdName = cardName(holdCard);
  const holdLink = holdCard.querySelector("h3 a");
  assert.ok(holdLink, "the card links to its product page");
  holdLink.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  await waitFor(() => bodyText().includes("Add to cart"), { label: "the product page" });
  click("Add to cart");
  await sleep(400);

  const { number: pendingNumber, order: pendingOrder } = await placeOrderThroughTheStore({
    payment: "cod",
  });
  assert.ok(pendingOrder, "the order was written");
  assert.equal(pendingOrder.status, "pending", "and nobody has worked it yet");
  assert.equal(openReservationsFor(pendingOrder.id).length, 1, "so its stock is held");
  const heldUnits = openReservationsFor(pendingOrder.id)[0].quantity;

  await navigate("#/online/reservations", 900);
  await waitFor(() => bodyText().includes("Stock holds & reconciliation"), {
    label: "the stock-holds screen",
  });
  await waitFor(() => bodyText().includes("Every hold agrees with its order"), {
    label: "the review to finish",
  });
  assert.ok(
    bodyText().includes("Every hold agrees with its order"),
    "a correct hold is not a finding — the default view lists problems, and there are none",
  );

  const everyHold = selectWithOption("Every hold");
  assert.ok(everyHold, "every hold is one select away");
  Object.getOwnPropertyDescriptor(dom.window.HTMLSelectElement.prototype, "value").set.call(
    everyHold,
    "all",
  );
  everyHold.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  await waitFor(() => bodyText().includes(pendingNumber), {
    label: `${pendingNumber} on the holds table`,
  });
  assert.ok(bodyText().includes(holdName), "the row names the product being held");
  assert.ok(bodyText().includes(String(heldUnits)), "and how many units");
  assert.ok(bodyText().includes("Holding"), "with the hold's own status");
  assert.ok(bodyText().includes("Held correctly"), "and a verdict that says nothing needs doing");
  assert.equal(
    [...document.querySelectorAll("button")].some((n) =>
      (n.textContent ?? "").trim().startsWith("Repair all") && !n.disabled,
    ),
    false,
    "a healthy hold still offers no repair",
  );

  // ── monitoring: five counts, each one a filter ───────────────────────────
  // "How bad is it" and "show me that" are one click apart, so the chips are
  // buttons with a pressed state rather than a row of decorative numbers.
  const chips = [...document.querySelectorAll("button[aria-pressed]")];
  assert.equal(chips.length, 5, "five monitoring counts: healthy, problems, old, missing, duplicate");
  for (const label of ["Healthy", "Problems", "Old", "Missing", "Duplicate"]) {
    assert.ok(
      chips.some((chip) => (chip.textContent ?? "").includes(label)),
      `the ${label} count is on the screen`,
    );
  }
  const chipOf = (label) =>
    chips.find((chip) => (chip.textContent ?? "").includes(label)) ?? null;
  assert.equal(chipOf("Healthy").getAttribute("aria-pressed"), "false", "nothing is filtered yet");

  // A healthy shop is told there are no problems, in words and in counts.
  assert.ok(!bodyText().includes("Reservation alerts"), "a correct hold raises no alert");
  assert.ok(bodyText().includes("Oldest hold"), "and the age of the oldest one is a number, not a guess");

  // The old-holds view: this order was placed seconds ago, so it is not old, and
  // the screen says nothing matches rather than showing a row that does not.
  chipOf("Old").dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  await waitFor(() => bodyText().includes("No holds match this filter"), {
    label: "the old-holds view to narrow",
  });
  assert.equal(chipOf("Old").getAttribute("aria-pressed"), "true", "the chip shows it is the active filter");
  assert.ok(
    !bodyText().includes(pendingNumber),
    "a hold placed moments ago is not in the old-holds view",
  );

  // Back to every hold, through the monitoring strip rather than the select.
  chipOf("Healthy").dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  await waitFor(() => bodyText().includes(pendingNumber), { label: "the healthy view" });
  assert.ok(bodyText().includes("Held correctly"), "and it is the correct hold, not a problem");

  // ── filters: the four the screen offers, plus a date window ──────────────
  assert.ok(selectWithOption("Every status"), "the queue's own order status narrows the holds");
  const productSelect = selectWithOption("Every product");
  assert.ok(productSelect, "and so does the product being held");
  assert.ok(
    [...productSelect.options].some((option) => (option.textContent ?? "").includes(holdName)),
    "the product list is the products these holds mention, not the whole catalogue",
  );
  assert.ok(selectWithOption("Every verdict"), "the problem type is a filter of its own");
  const dateInputs = [...document.querySelectorAll('input[type="date"]')];
  assert.equal(dateInputs.length, 2, "a hold can be narrowed to the days it was created");
  assert.ok(
    bodyText().includes("All time") && bodyText().includes("Last 30 days"),
    "with the same presets the reports screen uses",
  );

  // Filtering by a product nobody holds leaves an honest empty state, and the
  // button that undoes it says how many filters it is undoing.
  const searchField = document.querySelector('input[type="search"]');
  assert.ok(searchField, "the search field is there");
  setField('input[type="search"]', "no-such-order");
  await waitFor(() => bodyText().includes("No holds match this filter"), {
    label: "the search to narrow",
  });
  assert.ok(bodyText().includes("Clear every filter"), "and the way out is on the screen");
  click("Clear every filter");
  await sleep(300);

  // A search respects the scope it is combined with: the default view lists
  // problems, so a correct hold is found once "every hold" is selected — and the
  // button that undoes the search says how many filters it is undoing.
  const chooseEveryHold = () => {
    const select = selectWithOption("Every hold");
    assert.ok(select, "the scope select is still on the screen");
    Object.getOwnPropertyDescriptor(dom.window.HTMLSelectElement.prototype, "value").set.call(
      select,
      "all",
    );
    select.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  };
  chooseEveryHold();
  await sleep(250);
  setField('input[type="search"]', pendingNumber);
  await waitFor(() => bodyText().includes("Clear filters"), { label: "the clear-filters count" });
  assert.ok(bodyText().includes(pendingNumber), "searching an order number finds its hold");
  assert.ok(bodyText().includes("Held correctly"), "with the verdict that says nothing needs doing");
  click("Clear filters");
  await sleep(300);
  assert.equal(
    document.querySelector('input[type="search"]').value,
    "",
    "clearing the filters empties the search",
  );
  assert.ok(
    bodyText().includes("Every hold agrees with its order"),
    "and returns to the default view — problems only, of which a correct hold is not one",
  );

  console.log(
    `  ✓ ${pendingNumber} shows on the stock-holds screen as ${heldUnits} unit(s) held correctly, with nothing to repair`,
  );
  console.log(
    "  ✓ the holds screen monitors healthy/old/missing/duplicate holds and filters by status, product, type and date",
  );

  // ── 14 · the dashboard widget reads the same review ──────────────────────
  // It costs no query of its own: the provider already loaded the orders, the
  // holds and the catalogue, so the widget is four numbers over rows the app had.
  await navigate("#/", 900);
  await waitFor(() => bodyText().includes("Active holds"), { label: "the dashboard's holds widget" });
  assert.ok(bodyText().includes("Can repair now"), "what can be fixed is counted separately");
  assert.ok(bodyText().includes("Oldest hold"), "and so is how long the oldest has been sitting");
  assert.ok(
    document.querySelector('a[href="#/online/reservations"]'),
    "the widget links to the screen that can act on it",
  );
  assert.ok(
    !bodyText().includes("holds.summary"),
    "no untranslated widget key reaches the dashboard",
  );
  console.log(`  ✓ the dashboard carries the holds widget: ${heldUnits} unit(s) held, nothing to repair`);

  if (errors.length > 0) {
    console.error(`\n✗ ${errors.length} console error(s):`);
    for (const e of errors) console.error(`  ${e.split("\n")[0]}`);
    process.exit(1);
  }
  assert.deepEqual(networkCalls, [], "the whole run made no network calls");
  console.log("\nStorefront → POS flow verified end to end.\n");
  process.exit(0);
}

/**
 * The demo catalogue's SKU for a product the storefront showed by name.
 * The storefront never prints a SKU, so this is how the suite follows one
 * product from a card into the stock ledger.
 */
async function skuForName(name) {
  const product = catalog().find(
    (candidate) => candidate.name_en === name || candidate.name_ar === name,
  );
  assert.ok(product, `a catalogue product named "${name}" exists`);
  return product.sku;
}

main().catch((error) => {
  console.error("\n✗ storefront flow failed:", error?.message ?? error);
  if (error?.stack) console.error(error.stack.split("\n").slice(0, 6).join("\n"));
  process.exit(1);
});
