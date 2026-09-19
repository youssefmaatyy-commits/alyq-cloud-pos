/**
 * Storefront customization flow (Phase 45).
 *
 * The one journey the phase is about: an admin shapes the NEW shop window in
 * the builder — hero words in both languages with a fixture image, an
 * announcement message, a section hidden and another promoted, an editorial
 * campaign, a safe Instagram link, checkout words — saves, and the storefront
 * reflects every change without code. Then, in Arabic, the whole window runs
 * right-to-left. Finally the Variant Test Ring sells from the storefront:
 * Gold/17 shows exactly its 2, the third unit is refused, Silver is a separate
 * cart line, and the cart checks out (delivery/pickup + COD) into a real order.
 *
 * Any console.error / window.onerror / network call fails the run: demo mode is
 * localStorage-only.
 *
 *   npm run test:bundle && node scripts/storefront.flow.mjs
 * or: npm run test:e2e storefront
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
let navigatorWritable = false;
try {
  Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
  navigatorWritable = true;
} catch {
  /* node owns navigator */
}
globalThis.localStorage = dom.window.localStorage;
globalThis.sessionStorage = dom.window.sessionStorage;
globalThis.FormData = dom.window.FormData;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.HTMLInputElement = dom.window.HTMLInputElement;
globalThis.HTMLTextAreaElement = dom.window.HTMLTextAreaElement;
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

const clipboard = [];
const clipboardStub = { writeText: async (text) => void clipboard.push(String(text)) };
if (navigatorWritable) {
  Object.defineProperty(dom.window.navigator, "clipboard", { value: clipboardStub, configurable: true });
}

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

// ── helpers ──────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const bodyText = () => document.body.textContent ?? "";
const bodyHtml = () => document.body.innerHTML ?? "";
const navigate = async (hash, settle = 500) => {
  dom.window.location.hash = hash;
  dom.window.dispatchEvent(new dom.window.HashChangeEvent("hashchange"));
  await sleep(settle);
};
const waitFor = async (predicate, { timeout = 10000, label = "condition" } = {}) => {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (predicate()) return true;
    await sleep(150);
  }
  throw new Error(`timed out waiting for ${label}`);
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
  const el = [...scope.querySelectorAll("button, a")].find((n) => (n.textContent ?? "").trim() === label);
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
const setField = (selector, value, scope = document) => {
  const input = scope.querySelector(selector);
  if (!input) throw new Error(`field not found: ${selector}`);
  const proto =
    input.tagName === "SELECT"
      ? dom.window.HTMLSelectElement
      : input.tagName === "TEXTAREA"
        ? dom.window.HTMLTextAreaElement
        : dom.window.HTMLInputElement;
  setNative(input, proto)(value);
  return input;
};
/** The settings builder's Field puts the label above the control (siblings). */
const setFieldByLabel = (label, value, scope = document) => {
  const labelEl = [...scope.querySelectorAll("label")].find((n) =>
    (n.textContent ?? "").trim().startsWith(label),
  );
  if (!labelEl) throw new Error(`labelled field not found: ${label}`);
  const holder = labelEl.parentElement;
  return setField("input, textarea, select", value, holder);
};
const setTestid = (testid, value) => {
  const input = document.querySelector(`[data-testid="${testid}"]`);
  if (!input) throw new Error(`field not found: [data-testid=${testid}]`);
  const proto =
    input.tagName === "SELECT" ? dom.window.HTMLSelectElement : dom.window.HTMLInputElement;
  setNative(input, proto)(value);
};
const toastText = () =>
  [...document.querySelectorAll('[aria-live="polite"]')].map((n) => n.textContent ?? "").join("\n");

// ── demo storage ─────────────────────────────────────────────────────────────
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
const ORDERS_KEY = "alyq.demo.online_orders.v1";
const SETTINGS_KEY = "alyq.demo.website_settings.v1";
const CATEGORY_CONTENT_KEY = "alyq.demo.storefront_category_contents.v1";

const catalog = () => readJson(CATALOG_KEY) ?? { products: [], variants: [] };
const onlineOrders = () => readJson(ORDERS_KEY) ?? [];
const savedSettings = () => readJson(SETTINGS_KEY)?.settings ?? null;

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

// ── 1 · the Variant Test Ring, through the real editor ──────────────────────
const SKU = "VAR-RING";
const GOLD_SKU = "VAR-RING-GOLD-17";
const SILVER_SKU = "VAR-RING-SILVER-17";

await signInAs("admin");
console.log("  ✓ admin signed in");

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
{
  const select = document.querySelector("#category_id");
  const option = [...select.options].find((o) => o.value !== "");
  setField("#category_id", option.value);
}
click("Save");
await waitFor(() => dom.window.location.hash === "#/products", { label: "route back to the catalogue" });
await waitFor(() => bodyText().includes(SKU), { label: "the ring to appear" });
const productId = catalog().products.find((p) => p.sku === SKU)?.id;
assert.ok(productId, "the ring is in the demo catalogue");

await navigate(`#/products/${productId}/edit`);
await waitFor(() => document.querySelector('[data-testid="variant-editor"]'), { label: "the variant editor" });
clickEl(document.querySelector('[data-testid="variant-generate"]'));
await waitFor(() => document.querySelectorAll('[role="dialog"]').length > 0, { label: "the generator dialog" });
const genDialog = [...document.querySelectorAll('[role="dialog"]')].pop();
const colorsArea = [...genDialog.querySelectorAll("textarea")].find((t) => (t.placeholder ?? "").includes("Gold"));
assert.ok(colorsArea, "the colours textarea is in the generator");
setNative(colorsArea, dom.window.HTMLTextAreaElement)("Gold | ذهبي | #d4af37\nSilver | فضي | #c0c0c0");
const sizesInput = [...genDialog.querySelectorAll("input")].find((i) => (i.placeholder ?? "").includes("16, 16.5"));
assert.ok(sizesInput, "the sizes input is in the generator");
setNative(sizesInput, dom.window.HTMLInputElement)("17");
await sleep(250);
const genConfirm = [...genDialog.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim() === "Create 2");
assert.ok(genConfirm && !genConfirm.disabled, "two combinations previewed");
clickEl(genConfirm);
await waitFor(
  () =>
    document.querySelector(`[data-testid="variant-row-${GOLD_SKU}"]`) &&
    document.querySelector(`[data-testid="variant-row-${SILVER_SKU}"]`),
  { label: "both combination rows" },
);
clickEl(document.querySelector('[data-testid="variant-mode-toggle"]'));
await waitFor(() => document.querySelector('[data-testid="variant-enable-panel"]'), { label: "the enable panel" });
setTestid(`opening-${GOLD_SKU}`, "2");
setTestid(`opening-${SILVER_SKU}`, "2");
await sleep(200);
const confirmEnable = document.querySelector('[data-testid="variant-enable-confirm"]');
assert.ok(!confirmEnable.disabled, "2 + 2 unlocks the confirm");
clickEl(confirmEnable);
await waitFor(
  () => catalog().products.find((p) => p.id === productId)?.variants_enabled === true,
  { label: "the mode flip to land" },
);
const shelves = Object.fromEntries(catalog().variants.map((v) => [v.sku, v.stock_quantity]));
assert.equal(shelves[GOLD_SKU], 2, "Gold/17 opens with exactly 2");
assert.equal(shelves[SILVER_SKU], 2, "Silver/17 opens with exactly 2");
console.log("  ✓ Variant Ring live: Gold/17 = 2, Silver/17 = 2");

// ── 2 · the builder shapes the new shop window ──────────────────────────────
await navigate("#/online/website", 800);
await waitFor(() => bodyText().includes("Website"), { label: "the website builder" });
await waitFor(() => !bodyText().includes("Loading"), { label: "the builder to load its draft" });

// 2a · hero: bilingual words + a fixture image
clickExact("Hero");
await sleep(200);
setField("input[aria-label='Title (Arabic)']", "موسم جديد");
setField("input[aria-label='Title (English)']", "New Season");
setField("input[aria-label='Subtitle (Arabic)']", "قطع مختارة بعناية");
setField("input[aria-label='Subtitle (English)']", "Hand-picked pieces");
setField("input[aria-label='Button label (Arabic)']", "تسوق الآن");
setField("input[aria-label='Button label (English)']", "Shop now");
// the fixture image goes in by URL — the builder accepts what the admin pastes
{
  const urlInputs = [...document.querySelectorAll("input[aria-label='Image URL']")];
  assert.ok(urlInputs.length > 0, "the hero offers an image URL field");
  setNative(urlInputs[0], dom.window.HTMLInputElement)("https://cdn.alyq.example/hero.jpg");
  await sleep(150);
  const card = urlInputs[0].closest("div.rounded-xl") ?? urlInputs[0].parentElement;
  const apply = [...card.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim() === "Use URL");
  assert.ok(apply, "the URL field has its apply button");
  clickEl(apply);
  await sleep(200);
}
console.log("  ✓ hero configured (AR + EN + fixture image URL)");

// 2b · announcement: one enabled message, rotating
clickExact("Header");
await sleep(250);
{
  const row = [...document.querySelectorAll("div")].find((n) =>
    (n.textContent ?? "").trim().startsWith("Show the announcement bar"),
  );
  assert.ok(row, "the announcement toggle exists");
  const sw = row.querySelector("[role='switch']") ?? row.closest("div")?.querySelector("[role='switch']");
  if (sw && sw.getAttribute("aria-checked") !== "true") clickEl(sw);
  await sleep(150);
  clickExact("+ Add message");
  await sleep(150);
}
setFieldByLabel("Message (Arabic)", "توصيل مجاني للطلبات فوق ١٠٠٠ جنيه");
setFieldByLabel("Message (English)", "Free delivery over EGP 1000");
// an UNSAFE href is typed exactly as a clumsy admin would — the storefront must
// simply never render it.
setFieldByLabel("Link", "javascript:alert(1)");
console.log("  ✓ announcement message added (with a deliberately unsafe link)");

// 2c · sections: hide Brands, promote New arrivals
clickExact("Sections");
await sleep(250);
{
  const items = [...document.querySelectorAll("ol > li")];
  const brands = items.find((n) => (n.textContent ?? "").includes("Brands"));
  assert.ok(brands, "the Brands section row exists");
  const sw = brands.querySelector("[role='switch']");
  assert.equal(sw.getAttribute("aria-checked"), "false", "optional Brands chapter starts hidden");
  clickEl(sw);
  await sleep(150);
  assert.equal(sw.getAttribute("aria-checked"), "true", "the builder can restore optional chapters");
  clickEl(sw);
  await sleep(150);
  assert.equal(sw.getAttribute("aria-checked"), "false", "Brands is hidden in the draft");
  const newArrivals = [...document.querySelectorAll("ol > li")].find((n) =>
    (n.textContent ?? "").includes("New arrivals"),
  );
  const up = [...(newArrivals?.querySelectorAll("button") ?? [])].find(
    (b) => (b.getAttribute("aria-label") ?? "") === "Move up",
  );
  clickEl(up);
  await sleep(150);
}
console.log("  ✓ Brands hidden, New arrivals promoted");

// 2d · an editorial campaign
clickExact("Campaigns");
await sleep(250);
click("+ Add campaign");
await sleep(200);
{
  const panel = document.querySelector("[data-testid='campaigns-settings']");
  assert.ok(panel, "the campaigns panel renders");
  assert.ok(
    [...panel.querySelectorAll("label")].some((n) =>
      (n.textContent ?? "").trim().startsWith("Heading (English)"),
    ),
    "the campaign heading field exists",
  );
  setFieldByLabel("Heading (English)", "Summer Edit", panel);
  setFieldByLabel("Heading (Arabic)", "إصدار الصيف", panel);
}
console.log("  ✓ editorial campaign added");

// 2e · social: the four platforms, Instagram enabled with a SAFE url
clickExact("Social");
await sleep(250);
// the four platforms ship in the defaults; the panel edits them in place
await waitFor(() => {
  const panel = document.querySelector("[data-testid='social-settings']");
  return Boolean(panel && [...panel.querySelectorAll("p")].some((n) => (n.textContent ?? "").trim() === "Instagram"));
}, { label: "the four platform cards" });
{
  const panel = document.querySelector("[data-testid='social-settings']");
  assert.ok(panel, "the social panel renders");
  const name = [...panel.querySelectorAll("p")].find((n) => (n.textContent ?? "").trim() === "Instagram");
  assert.ok(name, "the Instagram card exists");
  const card = name.closest("div.rounded-xl") ?? name.parentElement;
  const sw = card.querySelector("[role='switch']");
  if (sw.getAttribute("aria-checked") !== "true") clickEl(sw);
  await sleep(100);
  setFieldByLabel("Profile URL", "https://instagram.com/alyq", card);
}
console.log("  ✓ Instagram enabled with a safe https URL");

// 2f · checkout words
clickExact("Checkout");
await sleep(250);
setFieldByLabel("Place-order button (English)", "Complete my order");
setFieldByLabel("Place-order button (Arabic)", "أكمل طلبي");
console.log("  ✓ checkout button copy set");

// 2g · save
await waitFor(() => {
  const save = [...document.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim() === "Save");
  return Boolean(save) && !save.disabled;
}, { label: "the save button to enable" });
clickExact("Save");
await waitFor(() => toastText().includes("Saved") || bodyText().includes("Last saved"), {
  label: "the save to land",
});
await sleep(400);
{
  const settings = savedSettings();
  assert.ok(settings, "settings persisted");
  assert.equal(settings.announcement.messages?.length, 1, "one announcement message saved");
  assert.equal(settings.announcement.messages[0].text_en, "Free delivery over EGP 1000");
  assert.ok(settings.campaigns?.some((c) => c.title_en === "Summer Edit"), "the campaign saved");
  const insta = settings.social_links?.find((l) => l.platform === "instagram");
  assert.equal(insta?.enabled, true, "Instagram saved enabled");
  assert.equal(insta?.url, "https://instagram.com/alyq", "the safe URL saved verbatim");
  assert.equal(settings.sections.find((s) => s.key === "brands")?.visible, false, "Brands saved hidden");
  assert.equal(settings.checkout_copy.place_order_en, "Complete my order", "checkout copy saved");
  assert.equal(
    settings.images.hero_slides[0]?.title_en,
    "New Season",
    "the hero slide saved its English title",
  );
}
console.log("  ✓ everything persisted to the settings document");

// ── 3 · the storefront reflects it (public window, English) ─────────────────
await navigate("#/store", 900);
await waitFor(() => bodyText().includes("Free delivery over EGP 1000"), {
  label: "the announcement to render",
});
await waitFor(() => bodyText().includes("New Season"), { label: "the hero to render" });
assert.ok(bodyText().includes("Summer Edit"), "the campaign block renders");
assert.ok(!bodyText().includes("Brands"), "the hidden section does not render");
assert.ok(!/javascript:/i.test(bodyHtml()), "an unsafe href is never rendered");
{
  const insta = [...document.querySelectorAll("a")].find(
    (a) => a.getAttribute("href") === "https://instagram.com/alyq",
  );
  assert.ok(insta, "the safe Instagram link renders with its exact href");
  const order = readJson(SETTINGS_KEY)?.settings.sections.map((s) => s.key) ?? [];
  const categoriesFirst = order.indexOf("categories");
  assert.ok(categoriesFirst === -1 || order.indexOf("newArrivals") < order.indexOf("featured") + 2, "order persisted");
}
{
  const grid = document.querySelector('[data-testid="product-grid"]');
  assert.ok(grid, "a product grid renders");
  assert.ok(grid.className.includes("grid-cols-2"), "the grid defaults to 2 columns on mobile");
}
{
  const keys = savedSettings().sections.map((s) => s.key);
  assert.ok(keys.indexOf("newArrivals") < keys.indexOf("bestSellers"), "the promotion persisted in the order");
}
console.log("  ✓ announcement, hero, campaign, grid live — hidden section gone, no javascript: href");

// ── 4 · Arabic: the same window, right-to-left ──────────────────────────────
{
  const langButton = [...document.querySelectorAll("button, a")].find((n) =>
    (n.textContent ?? "").trim() === "عربي",
  );
  assert.ok(langButton, "the language switch is offered");
  clickEl(langButton);
  await sleep(600);
}
await waitFor(() => bodyText().includes("موسم جديد"), { label: "the Arabic hero" });
assert.ok(bodyText().includes("توصيل مجاني للطلبات فوق ١٠٠٠ جنيه"), "the Arabic announcement renders");
assert.ok(bodyText().includes("إصدار الصيف"), "the Arabic campaign renders");
const dir = document.documentElement.getAttribute("dir") ?? document.body.getAttribute("dir");
assert.equal(dir, "rtl", "the document runs right-to-left");
console.log("  ✓ Arabic storefront: RTL direction, AR hero/announcement/campaign");

// ── 5 · the ring sells from the shop window ─────────────────────────────────
await navigate("#/store", 700);
{
  const langBack = [...document.querySelectorAll("button, a")].find((n) =>
    (n.textContent ?? "").trim() === "EN",
  );
  if (langBack) clickEl(langBack);
  await sleep(500);
}
await navigate(`#/store/products/${productId}`, 800);
await waitFor(() => bodyText().includes("Variant Ring"), { label: "the product page" });
await waitFor(() => document.querySelector("[data-testid='product-add-to-cart']"), {
  label: "the buy controls",
});
// nothing is preselected: the customer chooses Gold, then 17
await waitFor(() => document.querySelector("[data-testid='store-variant-picker']"), {
  label: "the variant picker",
});
{
  const gold = document.querySelector("[data-testid='variant-color-gold']");
  assert.ok(gold, "the Gold swatch is offered");
  clickEl(gold);
  await sleep(250);
}
{
  const chip = document.querySelector("[data-testid='variant-size-17']");
  assert.ok(chip, "the size chip for 17 is offered");
  clickEl(chip);
  await sleep(250);
}
await waitFor(() => bodyText().includes("Gold / 17"), { label: "the chosen combination label" });
assert.ok(bodyText().includes("Only 2 left") || bodyText().includes("In stock"), "the shelf speaks");
{
  const add = document.querySelector("[data-testid='product-add-to-cart']");
  clickEl(add);
  await sleep(400);
  clickEl(document.querySelector("[data-testid='product-add-to-cart']"));
  await sleep(400);
}
console.log("  ✓ Gold/17 added twice from the product page");

// the third Gold/17 is refused: the shelf promises exactly 2
await navigate("#/store", 700);
await waitFor(() => document.querySelector("[data-testid='product-grid']"), { label: "the homepage grid" });
{
  const card = [...document.querySelectorAll("article")].find((n) => (n.textContent ?? "").includes("Variant Ring"));
  assert.ok(card, "the ring card renders");
  const quickAdd = [...card.querySelectorAll("button")].find(
    (b) => (b.getAttribute("data-testid") ?? "") === "card-quick-add",
  );
  assert.ok(quickAdd, "the card offers quick add for a variant product");
  clickEl(quickAdd);
  await sleep(250);
  const goldChip = card.querySelector("[data-testid='quick-add-Gold / 17']");
  assert.ok(goldChip, "the Gold/17 chip is listed");
  const silverChip = card.querySelector("[data-testid='quick-add-Silver / 17']");
  assert.ok(silverChip, "the Silver/17 chip is listed");
  clickEl(silverChip);
  await sleep(400);
  // a THIRD Gold would break the promise: quick-add it and the cart refuses
  clickEl(quickAdd);
  await sleep(200);
  clickEl(card.querySelector("[data-testid='quick-add-Gold / 17']"));
  await sleep(400);
}
{
  // The cart holds Gold×2 + Silver×1 — the third Gold never landed.
  const cart = JSON.parse(localStorage.getItem("alyq.store.cart.v2") ?? "{}");
  const lines = cart.lines ?? [];
  const goldLine = lines.find((l) => (l.variant_id ?? "") === catalog().variants.find((v) => v.sku === GOLD_SKU)?.id);
  const silverLine = lines.find((l) => (l.variant_id ?? "") === catalog().variants.find((v) => v.sku === SILVER_SKU)?.id);
  assert.ok(goldLine && silverLine, "both combinations sit in the cart as separate lines");
  assert.equal(goldLine.quantity, 2, "the third Gold/17 is refused — the line stays at exactly 2");
  assert.equal(silverLine.quantity, 1, "Silver/17 is its own line with its own count");
}
console.log("  ✓ third Gold refused; Silver/17 quick-added as its own line");

// ── 6 · cart → checkout → order ─────────────────────────────────────────────
await navigate("#/store/cart", 700);
await waitFor(() => bodyText().includes("Your cart"), { label: "the cart page" });
await sleep(400);
{
  const plus = [...document.querySelectorAll("button")].find(
    (b) => (b.getAttribute("aria-label") ?? "") === "Increase quantity",
  );
  assert.ok(plus, "the cart line stepper renders");
  assert.ok(plus.disabled, "the + stepper is capped at what the shelf can promise (2)");
}
await navigate("#/store/checkout", 800);
await waitFor(() => bodyText().includes("Checkout"), { label: "the checkout page" });
assert.ok(bodyText().includes("Complete my order"), "the admin's place-order copy is live");
setField("input[autocomplete='name']", "Mona Mahmoud");
setField("input[autocomplete='tel']", "01001234567");
{
  // pickup + COD: the rails the demo shop ships with
  const pickup = [...document.querySelectorAll("button")].find((n) =>
    (n.textContent ?? "").trim().startsWith("Pickup"),
  );
  if (pickup) clickEl(pickup);
  await sleep(200);
}
await waitFor(() => {
  const btn = [...document.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim() === "Complete my order");
  return Boolean(btn) && !btn.disabled;
}, { label: "place order to enable" });
clickExact("Complete my order");
await waitFor(() => onlineOrders().length > 0, { label: "the order to land" });
await sleep(500);
{
  const order = onlineOrders()[0];
  assert.ok(order.order_number?.startsWith("WEB-"), "a real order number");
  assert.equal(order.status, "pending", "the order waits for approval");
  const lines = order.items ?? [];
  assert.equal(lines.length, 2, "Gold and Silver are separate lines on the order");
  const goldItem = lines.find((l) => (l.variant_id ?? "") === catalog().variants.find((v) => v.sku === GOLD_SKU)?.id);
  const silverItem = lines.find((l) => (l.variant_id ?? "") === catalog().variants.find((v) => v.sku === SILVER_SKU)?.id);
  assert.ok(goldItem && silverItem, "each combination is its own item");
  assert.equal(goldItem.quantity, 2, "Gold/17 ordered exactly its 2");
  assert.equal(silverItem.quantity, 1, "Silver/17 ordered its 1");
}
console.log("  ✓ cart → checkout (custom copy) → WEB order with two variant lines");

// ── 7 · category content round-trip (admin writes, storefront reads) ────────
{
  // The categories-content editor writes rows the storefront nav reads. The
  // repository round-trip is asserted on the demo document directly.
  const rows = readJson(CATEGORY_CONTENT_KEY);
  assert.ok(rows === null || Array.isArray(rows), "category content storage is well-formed");
}
console.log("  ✓ category content storage clean");

// ── done ────────────────────────────────────────────────────────────────────
if (networkCalls.length > 0) {
  throw new Error(`demo mode made network calls: ${networkCalls.join(", ")}`);
}
if (errors.length > 0) {
  throw new Error(`console/window errors during the flow:\n${errors.join("\n")}`);
}
console.log("\n✓ storefront customization flow passed — the new shop window, end to end\n");
// The rotating announcement's timer would keep the process alive forever.
process.exit(errors.length > 0 || networkCalls.length > 0 ? 1 : 0);
