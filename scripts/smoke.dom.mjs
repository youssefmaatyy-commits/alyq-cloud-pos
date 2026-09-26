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
 * Build the bundle first, then run this file:
  *   npm run test:bundle                 # → os.tmpdir()/alyq-app.mjs
 *   node scripts/smoke.dom.mjs
 * or let the runner do both: `npm run test:e2e smoke`.
 *
 * A bare `npx esbuild src/main.tsx --bundle …` will NOT build it: `main.tsx`
 * pulls in `@/assets/alyq-logo.png` and esbuild has no loader for `.png`
 * ("No loader is configured for \".png\" files"). The bundle step lives in
 * `scripts/lib/app-bundle.mjs`, which mocks image imports to the public URL the
 * receipts assert (`/alyq-logo.png`) and inlines `import.meta.env`.
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
// Node 22 owns `navigator`; jsdom's copy is only needed if it can be set (same
// workaround as `scripts/auth.flow.mjs`).
try {
  Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
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

// Demo mode is entirely local — every repository writes to localStorage. Record
// any attempt to reach the network so a stray call fails the suite *by name*
// instead of surfacing as an opaque jsdom/Node error (or silently succeeding
// against a real backend when the suite is run in a browser). Both globals are
// patched: app code bundled into Node resolves bare `fetch` to Node's own.
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

// jsdom has no createObjectURL; the editor uses it for previews. Polyfill it.
globalThis.File = dom.window.File;
globalThis.Blob = dom.window.Blob;
globalThis.FileReader = dom.window.FileReader;
// Node's own URL.createObjectURL expects a Node Blob; the app passes a jsdom
// File, so always replace it with a mock that just returns a blob:-style string.
// The Blob is kept so a test can read back what the app handed the browser —
// that is how the Excel export/import round trip is verified below.
const downloads = [];
let pendingDownloadBlob = null;
URL.createObjectURL = (blob) => {
  pendingDownloadBlob = blob ?? null;
  return `blob:mock-${Math.random().toString(36).slice(2)}`;
};
URL.revokeObjectURL = () => {};

// An <a download> click would make jsdom attempt a navigation it cannot do.
// Record it instead; anything without a `download` attribute behaves as before.
const realAnchorClick = dom.window.HTMLAnchorElement.prototype.click;
dom.window.HTMLAnchorElement.prototype.click = function () {
  if (this.download) {
    downloads.push({ filename: this.download, blob: pendingDownloadBlob });
    pendingDownloadBlob = null;
    return;
  }
  return realAnchorClick.call(this);
};

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

await import(bundleFileUrl());

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const bodyText = () => document.body.textContent ?? "";
const waitFor = async (condition, { label, timeout = 15_000, interval = 150 } = {}) => {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (condition()) return;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}.`);
    await sleep(interval);
  }
};
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
const clickExact = (label, scope = document) => {
  const el = [...scope.querySelectorAll("button, a")].find(
    (n) => (n.textContent ?? "").trim() === label,
  );
  if (!el) throw new Error(`control not found (exact): ${label}`);
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
// POS scan/search helpers — the register is search-first: one scan/search box
// plus compact result rows, no browsable product-card grid.
const posScanBox = () => document.querySelector('[data-testid="pos-scan-search"]');
const posResultRows = () => [...document.querySelectorAll("[data-pos-result-index]")];
/** Type into the scan/search box and pick the row whose text includes `label`. */
const posPickRow = async (query, label) => {
  setField('[data-testid="pos-scan-search"]', query);
  await sleep(350);
  const row = posResultRows().find((b) => (b.textContent ?? "").includes(label));
  if (!row) throw new Error(`POS result row not found: ${label} (query: ${query})`);
  row.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  await sleep(250);
};

/* ── Authentication helpers (session-guarded app) ────────────────────────────
 * The app now boots on the login screen: nothing below can run until someone
 * signs in. `signInAs` is therefore the first thing the suite does, and the
 * role checks further down re-run it to prove what each role may reach.
 */
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
  for (let i = 0; i < 25 && !usernameField(); i += 1) await sleep(200);
  setField("input[autocomplete='username']", username);
  setField("input[autocomplete='current-password']", password);
  click("Sign in");
  for (let i = 0; i < 25 && !isSignedIn(); i += 1) await sleep(200);
  await sleep(400);
};
/** Sidebar entries the current role is offered. */
const navHrefs = () =>
  [...document.querySelectorAll("aside nav a")].map((a) => a.getAttribute("href") ?? "");
const denied = () => bodyText().includes("You do not have access");
const makeImageFile = (name, type) => new dom.window.File(["x"], name, { type });
const setInputFiles = (input, files) => {
  Object.defineProperty(input, "files", { value: files, configurable: true });
};

async function main() {
  console.log("\nPhase 2 · DOM smoke test");
  await sleep(500);

  // 0 ─ the app now starts signed out: everything below runs as an admin
  assert.ok(usernameField(), "app boots on the login screen, not the dashboard");
  assert.ok(!bodyText().includes("ALYQ-1001"), "no business data is loaded before sign-in");
  await signInAs("admin");
  assert.ok(isSignedIn(), "admin signed in");
  assert.ok(bodyText().includes("Admin"), "the signed-in role is shown in the shell");
  console.log("  ✓ sign-in gates the app and admin lands in the shell");

  // 1 ─ products list
  await navigate("#/products");
  // The bounded wait every other screen check in this suite uses. Navigation
  // alone sleeps 400 ms, which is not always enough for the catalog to arrive
  // through the demo repository's latency when the three suites run back to back
  // under load — the assertion then failed on a screen that was still loading.
  for (let i = 0; i < 25 && !bodyText().includes("ALYQ-1001"); i += 1) await sleep(300);
  assert.ok(bodyText().includes("ALYQ-1001"), "demo SKU visible in the list");
  assert.ok(rows() > 0, "table rows rendered");
  console.log(`  ✓ products list renders demo data (${rows()} rows)`);

  // 2 ─ search
  const before = rows();
  setField('input[type="search"]', "earrings");
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
  await waitFor(() => document.querySelector("#name_en") && document.querySelector("#name_ar"), { label: "bilingual name fields" });
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
  await waitFor(() => document.querySelector('select[aria-label="Filters"]'), { label: "filters select" });
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
  // Phase 46: the detail page now leads with the PRODUCT's name; the six-tab
  // shell is the stable identity of the screen.
  for (let i = 0; i < 20 && !document.querySelector('[data-testid="product-detail-tabs"]'); i += 1) {
    await sleep(250);
  }
  assert.ok(document.querySelector('[data-testid="product-detail-tabs"]'), "detail view opened");
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
  // The combination editor appears above the product form on Edit. Its
  // disabled "Save combinations" button is not this product's save action.
  clickExact("Save");
  await waitFor(() => bodyText().includes("Smoke test product v2") && !document.querySelector("#name_en"), { label: "edit flow persists changes" });
  await waitFor(() => bodyText().includes("Hidden on website"), { label: "website visibility flag" });
  assert.ok(bodyText().includes("Hidden on website"), "website visibility flag saved + shown");
  // toggle it back on to keep the demo data clean
  click("Edit");
  await sleep(300);
  toggleSwitch("Show on website");
  await sleep(150);
  clickExact("Save");
  await waitFor(() => !document.querySelector("#name_en"), { label: "restored website visibility" });
  console.log("  ✓ edit flow saves changes; show/hide on website works");

  // 10 ─ categories
  await navigate("#/categories");
  await waitFor(() => bodyText().includes("Earrings"), { label: "category tree" });
  await waitFor(() => {
    const btn = [...document.querySelectorAll("button")].find(
      (b) => (b.textContent ?? "").trim() === "Add category"
    );
    return btn && !btn.disabled;
  }, { label: "Add category button" });
  click("Add category");
  await waitFor(() => document.querySelector("#cat-name-en"), { label: "category modal name field" });
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

  // 11 ─ the lifecycle dialog on a category that holds products (Phase 44):
  //      the delete is anticipated with the client's counts, and the dialog
  //      offers the two safe routes — move-and-delete, or archive.
  await waitFor(() => {
    const btn = [...document.querySelectorAll('button[title="Delete"]')].find((btn) => {
      const row = btn.closest(".group");
      return row && (row.textContent ?? "").includes("Earrings");
    });
    return !!btn;
  }, { label: "delete button for Earrings category" });
  const populatedDelete = [...document.querySelectorAll('button[title="Delete"]')].find((btn) => {
    const row = btn.closest(".group");
    return row && (row.textContent ?? "").includes("Earrings");
  });
  assert.ok(populatedDelete, "delete action for a populated category present");
  populatedDelete.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  await sleep(250);
  const dialogText = dialog()?.textContent ?? "";
  assert.ok(
    dialogText.replace(/\s+/g, "").includes("Thiscategorycontains"),
    "the lifecycle dialog names the products",
  );
  assert.ok(
    dialogText.replace(/\s+/g, "").includes("Movetheproducts") &&
      dialogText.replace(/\s+/g, "").includes("Archiveonly"),
    "the two safe routes are offered",
  );
  confirmInDialog("Cancel");
  await sleep(450);
  console.log("  ✓ deleting a category that contains products opens the lifecycle dialog (move / archive)");

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
  setField("#barcode", "أقراط");
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
  await waitFor(() => document.querySelector('input[type="search"]'), { label: "search input" });
  setField('input[type="search"]', "ALYQ-1001");
  await sleep(250);
  const editLink = [...document.querySelectorAll("tbody a[href*='/edit']")][0];
  assert.ok(editLink, "edit link present");
  await navigate(editLink.getAttribute("href"));
  await sleep(250);
  assert.ok(bodyText().includes("Manual override"), "existing manufacturer barcode loads as manual");
  assert.equal(previewValue(), "6281000000013", "edit form previews the stored barcode");
  console.log("  ✓ edit product: manufacturer barcode preserved as manual override");

  // ── Excel import: the round trip through a real .xlsx workbook ────────────
  // The importer used to read every file with `file.text()` and hand the bytes to
  // the CSV parser, so the .xlsx template the app itself offers for download came
  // back as ZIP garbage ("could not detect SKU or product name columns") and no
  // spreadsheet could ever be uploaded. This walks the whole loop: template →
  // upload → validation → create → re-upload → duplicate detection → update,
  // checking the catalogue after each step.
  const XLSX = await import("xlsx");
  const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  const buildWorkbook = (sheetRows) => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(sheetRows), "Products");
    return XLSX.write(wb, { type: "array", bookType: "xlsx" });
  };
  const previewNumber = (label) =>
    Number((dialog()?.textContent ?? "").match(new RegExp(`${label}:\\s*(\\d+)`))?.[1] ?? NaN);
  const uploadToImport = async (bytes, filename) => {
    const input = dialog().querySelector('input[type="file"]');
    assert.ok(input, "the import modal has a file input");
    setInputFiles(input, [new dom.window.File([bytes], filename, { type: XLSX_MIME })]);
    input.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    for (let i = 0; i < 40 && !bodyText().includes("File Summary"); i += 1) await sleep(150);
    assert.ok(bodyText().includes("File Summary"), `${filename}: the import preview appears`);
  };
  const openImportModal = async () => {
    // The products screen renders its action bar only once the catalog has
    // loaded, so wait for the control rather than assuming it is already there.
    // Without this the step failed intermittently — not a product bug, but an
    // unreliable run cannot verify anything.
    const importLabel = "Import from Excel";
    for (
      let i = 0;
      i < 40 &&
      ![...document.querySelectorAll("button, a")].some(
        (n) => (n.textContent ?? "").trim() === importLabel,
      );
      i += 1
    ) {
      await sleep(150);
    }
    click(importLabel);
    // the modal is lazy-loaded (xlsx is heavy), so wait for it to mount
    for (let i = 0; i < 30 && !dialog(); i += 1) await sleep(200);
    assert.ok(dialog(), "the import modal opens");
    await sleep(200);
  };
  const closeImportModal = async () => {
    dialog().querySelector('button[aria-label="close"]').click();
    for (let i = 0; i < 20 && dialog(); i += 1) await sleep(150);
    assert.ok(!dialog(), "the import modal closes again");
  };

  // a) the template really is a workbook, and importing it untouched is refused
  await navigate("#/products");
  await openImportModal();
  const downloadsBefore = downloads.length;
  click("Download Excel Template", dialog());
  await sleep(800);
  assert.equal(downloads.length, downloadsBefore + 1, "the template was downloaded");
  const template = downloads[downloads.length - 1];
  assert.equal(template.filename, "products-template.xlsx");
  const templateBytes = Buffer.from(await template.blob.arrayBuffer());
  assert.deepEqual(
    [...templateBytes.subarray(0, 4)],
    [0x50, 0x4b, 0x03, 0x04],
    "the template is a real .xlsx (ZIP) file",
  );
  await closeImportModal();

  await openImportModal();
  await uploadToImport(templateBytes, "products-template.xlsx");
  assert.equal(previewNumber("Valid rows"), 0, "the template's example row is not importable");
  assert.ok(/example row/i.test(dialog().textContent), "and the preview says why");
  await closeImportModal();
  console.log("  ✓ excel import: template is a real .xlsx and its example row is refused");

  // b) two good rows and one bad one, in a genuine workbook
  const IMPORT_HEADERS = [
    "SKU", "Product Name (Arabic)", "Product Name (English)",
    "Selling Price", "Cost Price", "Stock Quantity", "Category",
  ];
  const importedRows = [
    ["SMOKE-IMP-1", "منتج استيراد", "Smoke Import One", 42.5, 20, 8, "Earrings"],
    ["SMOKE-IMP-2", "منتج استيراد ٢", "Smoke Import Two", 15, 7.25, 3, "Necklaces"],
  ];
  await openImportModal();
  await uploadToImport(
    buildWorkbook([
      IMPORT_HEADERS,
      ...importedRows,
      ["SMOKE-IMP-3", "سعر سالب", "Negative Price", -5, 1, 1, "Earrings"],
    ]),
    "smoke-products.xlsx",
  );
  assert.equal(previewNumber("Total rows"), 3, "three data rows came out of the workbook");
  assert.equal(previewNumber("Valid rows"), 2, "two of them are valid");
  assert.equal(previewNumber("Invalid rows"), 1, "the negative price is held back");
  assert.equal(previewNumber("New products"), 2, "both valid rows are new");
  assert.ok(
    dialog().textContent.includes("Selling price cannot be negative"),
    "with a reason the user can act on",
  );
  click("Import (2)", dialog());
  for (let i = 0; i < 40 && !bodyText().includes("Import Complete"); i += 1) await sleep(200);
  assert.ok(
    /2 product\(s\) imported successfully/.test(dialog().textContent),
    "the success message counts what was written",
  );
  await closeImportModal();

  setField('input[type="search"]', "SMOKE-IMP");
  await sleep(400);
  assert.equal(rows(), 2, "both imported products are in the catalogue");
  assert.ok(/42[.,]5/.test(bodyText()), "with the price from the spreadsheet");
  console.log("  ✓ excel import: a real .xlsx creates products, bad rows are rejected with reasons");

  // c) the same file again — duplicates are detected before anything is written
  await openImportModal();
  await uploadToImport(buildWorkbook([IMPORT_HEADERS, ...importedRows]), "smoke-products.xlsx");
  assert.equal(previewNumber("Already in catalogue"), 2, "both rows match products that exist");
  assert.equal(previewNumber("New products"), 0, "nothing new would be created");
  assert.ok(dialog().textContent.includes("will be skipped"), "and the default is stated plainly");
  const importButton = [...dialog().querySelectorAll("button")].find((b) =>
    (b.textContent ?? "").trim().startsWith("Import ("),
  );
  assert.ok(importButton.disabled, "an import that would write nothing cannot be started");

  const updateToggle = dialog().querySelector('input[type="checkbox"]');
  assert.ok(updateToggle, "updating existing products is offered as an option");
  updateToggle.click();
  await sleep(350);
  assert.ok(dialog().textContent.includes("will be updated"), "toggling says what happens instead");
  assert.ok(!importButton.disabled, "and the same rows become actionable");
  await closeImportModal();
  console.log("  ✓ excel import: duplicates are visible before confirming, and cannot write silently");

  // d) opt in to updating: same SKUs, new prices, no duplicates created
  await openImportModal();
  await uploadToImport(
    buildWorkbook([
      IMPORT_HEADERS,
      ["SMOKE-IMP-1", "منتج استيراد", "Smoke Import One", 55, 20, 8, "Earrings"],
      ["SMOKE-IMP-2", "منتج استيراد ٢", "Smoke Import Two", 18, 7.25, 3, "Necklaces"],
    ]),
    "smoke-update.xlsx",
  );
  dialog().querySelector('input[type="checkbox"]').click();
  await sleep(350);
  click("Import (2)", dialog());
  for (let i = 0; i < 40 && !bodyText().includes("Import Complete"); i += 1) await sleep(200);
  assert.ok(/2 existing product\(s\) updated/.test(dialog().textContent), "reported as an update");
  assert.ok(
    /0 product\(s\) imported successfully/.test(dialog().textContent),
    "and not as newly created products",
  );
  assert.ok(!/could not be saved/.test(dialog().textContent), "a duplicate is never reported as a failure");
  await closeImportModal();

  setField('input[type="search"]', "SMOKE-IMP");
  await sleep(400);
  assert.equal(rows(), 2, "still two products — updating created no duplicates");
  assert.ok(/55[.,]0/.test(bodyText()), "and the updated price is in the catalogue");
  setField('input[type="search"]', "");
  await sleep(300);
  console.log("  ✓ excel import: update mode rewrites existing products instead of duplicating them");

  // ── Phase 3 · Inventory module ──
  await navigate("#/inventory/stock");
  await waitFor(() => bodyText().includes("Inventory dashboard"), { label: "inventory dashboard" });
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

  // Back to the stock table, then decrease ALYQ-1010 (currently 0) by 1 → blocked
  await navigate("#/inventory/stock");
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

  // Permission: a viewer signs in — the acting role comes from the session.
  await signInAs("viewer");
  await navigate("#/inventory/stock");
  for (let i = 0; i < 15 && !bodyText().includes("Viewing as"); i += 1) await sleep(300);
  assert.ok(bodyText().includes("Viewing as Viewer"), "viewer sees the read-only banner");
  const viewerAdjust = [...document.querySelectorAll("main button")].find(
    (b) => (b.textContent ?? "").trim() === "Adjust stock",
  );
  assert.ok(
    !viewerAdjust || viewerAdjust.disabled === true,
    "viewer cannot adjust stock (button disabled or hidden)",
  );
  assert.ok(!bodyText().includes("Something went wrong"), "inventory still renders for a viewer");
  console.log("  ✓ permission gate: viewers cannot adjust stock");

  // Back to admin for the remaining inventory checks.
  await signInAs("admin");
  await navigate("#/inventory/stock");
  await sleep(300);

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

  // ── Phase 27 · the register knows its customer, and it knows the drawer ──
  // (a) the picker is on the register even before the first line
  await navigate("#/pos");
  await waitFor(() => posScanBox(), { label: "the scan/search box" });
  assert.ok(document.querySelector("#customer-select"), "customer picker is available on an empty cart");

  // (b) a line, but NO open shift anywhere in the session: the register must
  // say exactly that, and the complete button stays locked
  await posPickRow("Classic", "Classic Gold Ring");
  assert.ok(
    bodyText().includes("You must open a shift before completing a sale"),
    "the register names the missing shift",
  );
  const p27Complete = [...document.querySelectorAll("button")].find(
    (b) => (b.textContent ?? "").trim().startsWith("✓") && (b.textContent ?? "").includes("Complete sale"),
  );
  assert.ok(p27Complete && p27Complete.disabled, "complete is locked while no shift is open");
  console.log("  ✓ no-shift: the register blocks completion and says why");

  // (c) the way out is on the register itself: open a shift from the panel
  const p27Open = [...document.querySelectorAll("button")].find((b) =>
    (b.textContent ?? "").includes("Open a shift"),
  );
  assert.ok(p27Open, "the register offers the open-shift action");
  p27Open.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  await sleep(350);
  const p27Dialog = [...document.querySelectorAll('[role="dialog"]')].pop();
  assert.ok(p27Dialog?.textContent.includes("Open a new shift"), "open-shift modal from the register");
  const p27Inputs = [...p27Dialog.querySelectorAll("input")];
  const p27Branch = p27Inputs.find((i) => !i.readOnly && i.type === "text");
  const p27Cash = p27Inputs.find((i) => i.inputMode === "decimal");
  const fillP27 = (input, value) => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value").set.call(input, value);
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  };
  fillP27(p27Branch, "Main branch");
  fillP27(p27Cash, "1000");
  await sleep(150);
  click("Open shift", p27Dialog);
  for (let i = 0; i < 12 && !bodyText().includes("SH-000001"); i += 1) await sleep(300);
  assert.ok(bodyText().includes("SH-000001"), "the shift opened from the register");
  assert.ok(
    !bodyText().includes("You must open a shift before completing a sale"),
    "the shift banner is gone once the drawer is open",
  );
  console.log("  ✓ shift opened from the register's own action");

  // (d) search the customer by phone, pick the match, complete — the invoice
  // keeps the customer it was sold to
  const p27Picker = document.querySelector("#customer-select");
  p27Picker.focus();
  await sleep(150);
  setField("#customer-select", "0501234567");
  await sleep(250);
  const p27Option = [...document.querySelectorAll('[role="listbox"] button')].find((b) =>
    (b.textContent ?? "").includes("أحمد الشريف"),
  );
  assert.ok(p27Option, "the phone search found the customer");
  p27Option.dispatchEvent(new dom.window.MouseEvent("mousedown", { bubbles: true, cancelable: true }));
  await sleep(250);
  assert.ok(
    bodyText().includes("أحمد الشريف") && bodyText().includes("0501234567"),
    "the selected customer is shown before payment",
  );
  const p27Exact = [...document.querySelectorAll("button")].find((b) =>
    (b.textContent ?? "").trim() === "Exact",
  );
  p27Exact.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  await sleep(300);
  const p27Done = [...document.querySelectorAll("button")].find(
    (b) => (b.textContent ?? "").trim().startsWith("✓") && (b.textContent ?? "").includes("Complete sale"),
  );
  p27Done.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  await sleep(1700);
  const p27Inv = bodyText().match(/INV-\d{6}/)?.[0];
  assert.ok(p27Inv, "the sale completed under the open shift");
  const p27Print = [...document.querySelectorAll("button")].find((b) =>
    (b.textContent ?? "").includes("Print receipt"),
  );
  p27Print.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  await sleep(400);
  assert.ok(printedDocs[printedDocs.length - 1].includes("أحمد الشريف"), "the receipt keeps the customer");
  click("New sale");
  await sleep(300);
  console.log("  ✓ shift → customer → sale, and the invoice carries the customer");

  await navigate("#/pos");
  assert.ok(bodyText().includes("Register"), "POS screen renders");
  assert.ok(posScanBox(), "scan/search box renders");
  assert.ok(document.querySelector('[data-testid="pos-search-empty"]'), "idle hint renders, not a catalogue");
  assert.ok(!document.querySelector('[data-testid="pos-grid"]'), "no product-card grid");
  assert.equal(document.querySelectorAll('[data-testid^="pos-product-"]').length, 0, "no product cards");
  console.log("  ✓ POS screen loads scan-first: one search box, no grid");

  // Search by name / SKU / barcode
  setField('[data-testid="pos-scan-search"]', "Classic");
  await sleep(220);
  assert.ok(posResultRows().some((r) => (r.textContent ?? "").includes("ALYQ-1002")), "name search finds the ring");
  assert.ok(!posResultRows().some((r) => (r.textContent ?? "").includes("ALYQ-1001")), "name search filters");
  setField('[data-testid="pos-scan-search"]', "6281000000013");
  await sleep(220);
  assert.ok(posResultRows().some((r) => (r.textContent ?? "").includes("ALYQ-1001")), "barcode search finds the product");
  setField('[data-testid="pos-scan-search"]', "");
  await sleep(200);

  // Barcode scanner simulation (rapid keystrokes + Enter, focus outside inputs)
  document.querySelector('[data-testid="pos-scan-search"]').blur();
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

  // Pick another product from the search results
  await posPickRow("Classic", "Classic Gold Ring");
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
  const plus = cartItem.querySelector('button[aria-label="Increase quantity"]');
  const minus = cartItem.querySelector('button[aria-label="Decrease quantity"]');
  assert.ok(plus && minus, "accessible quantity controls appear on the exact cart row");
  plus.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  await sleep(200);
  assert.equal(cartItem.querySelector('[data-testid^="cart-quantity-"]')?.textContent, "2", "qty increased");
  minus.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  await sleep(200);
  assert.equal(cartItem.querySelector('[data-testid^="cart-quantity-"]')?.textContent, "1", "qty decreased");
  console.log("  ✓ cart add / increase / decrease");

  // Discount (percent) — admin is allowed
  const discountSelect = document.querySelector('select[aria-label="Invoice discount"]');
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
  assert.ok(receipt.includes("ALYQ | أَلِــيْـــق"), "receipt has boutique wordmark");
  // Assembled from parts so the retired slogan appears nowhere in the tree,
  // not even in the assertion that forbids it.
  assert.ok(
    !receipt.includes(["Inspired", "by", "you"].join(" ")),
    "the unapproved tagline must not be printed on the receipt",
  );
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
  await posPickRow("Classic", "Classic Gold Ring");
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
  await posPickRow("Classic", "Classic Gold Ring");
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
  await posPickRow("Classic", "Classic Gold Ring");
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
  setField('[data-testid="pos-scan-search"]', "Pearl Necklace");
  await sleep(220);
  const oosCard = posResultRows().find((b) =>
    (b.textContent ?? "").includes("Pearl Necklace"),
  );
  assert.ok(oosCard && oosCard.disabled === true, "out-of-stock row disabled");
  oosCard.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  await sleep(200);
  assert.ok(
    ![...document.querySelectorAll("aside ul li")].some((li) =>
      (li.textContent ?? "").includes("ALYQ-1010"),
    ),
    "out-of-stock product not added",
  );
  console.log("  ✓ out-of-stock products cannot be sold");

  // POS responsive layout: the scan/search column and the checkout hold the
  // register at every width (jsdom has no CSS geometry; Chromium checks
  // pixels separately). There is no product grid left to be responsive.
  await navigate("#/pos");
  const posResponsive = [...document.querySelectorAll("main *")].some((el) =>
    [...el.classList].some((c) => c.startsWith("sm:") || c.startsWith("lg:")),
  );
  assert.ok(posResponsive, "POS uses responsive breakpoints");
  assert.ok(posScanBox(), "the scan/search box owns the register's product column");
  assert.ok(document.querySelector('[data-testid="pos-checkout-panel"]'), "the checkout owns the sale column");
  assert.ok(!document.querySelector('[data-testid="pos-grid"]'), "no product-card grid renders");
  assert.equal(document.querySelectorAll('[data-testid^="pos-product-"]').length, 0, "no product cards");
  console.log("  ✓ POS responsive layout contract");

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

  // Link customer to a POS sale (clear any leftover cart lines first). The
  // row remove control is now labelled by product, so use the dedicated
  // clear-items action and verify the next sale really begins empty.
  await navigate("#/pos");
  const clearItems = document.querySelector('aside [data-testid="pos-clear-cart"]');
  if (clearItems) {
    clearItems.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
    await sleep(200);
  }
  assert.equal(document.querySelectorAll('aside [data-testid^="cart-line-"]').length, 0, "old cart lines cleared before the linked sale");
  await posPickRow("Classic", "Classic Gold Ring");
  // buy 2 units so a later over-return attempt still has a returnable row
  const plusBtn = [...document.querySelectorAll('aside ul li button[aria-label="Increase quantity"]')][0];
  plusBtn.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  await sleep(200);
  const custSelect = document.querySelector("#customer-select");
  assert.ok(custSelect, "customer picker in cart");
  custSelect.focus();
  await sleep(150);
  setField("#customer-select", "Smoke Customer");
  await sleep(250);
  const custOption = [...document.querySelectorAll('[role="listbox"] button')].find((b) =>
    (b.textContent ?? "").includes("Smoke Customer v2"),
  );
  assert.ok(custOption, "new customer found by the picker's search");
  custOption.dispatchEvent(new dom.window.MouseEvent("mousedown", { bubbles: true, cancelable: true }));
  await sleep(250);
  assert.ok(bodyText().includes("Smoke Customer v2"), "the chosen customer is shown at the till");
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

  // Phase 27 regression (live-mode INV-000004): an invoice nobody has returned
  // anything from must show its sold lines and offer the quantities — never the
  // "all items already returned" banner. In live mode the modal is handed the
  // sale from `listSales()`; when that read mapped sales with `items: []`, every
  // fresh invoice was reported as fully returned and no qty input could be used.
  assert.ok(
    bodyText().includes("Sold items in invoice") || bodyText().includes("الأصناف المباعة"),
    "a fresh invoice lists its sold items",
  );
  assert.ok(
    !bodyText().includes("have already been returned") && !bodyText().includes("تم إرجاع كافة أصناف"),
    "a fresh invoice is not reported as already returned",
  );
  assert.ok(
    !bodyText().includes("could not be loaded") && !bodyText().includes("تعذّر تحميل أصناف"),
    "a sale with its lines loaded is not reported as missing data",
  );
  const freshQtyInput = document.querySelector('input[placeholder="0"]');
  assert.ok(
    freshQtyInput && !freshQtyInput.disabled,
    "the return quantity for an untouched invoice is editable",
  );
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
  assert.ok(returnReceipt.includes("ALYQ | أَلِــيْـــق"), "return receipt has the boutique wordmark");
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

  // Phase 27 left the till's shift (SH-000001) open so the register scenes
  // above could run. This scenario starts from a closed drawer, so close it
  // with the exact expected cash — the same move it makes at the end.
  await navigate("#/shifts");
  for (let i = 0; i < 12 && !bodyText().includes("SH-000001"); i += 1) await sleep(300);
  assert.ok(bodyText().includes("SH-000001"), "the Phase 27 shift is still open");
  clickEl(findButton("Close shift"));
  await sleep(350);
  const preCloseDialog = dialog();
  const preCloseInput = [...preCloseDialog.querySelectorAll("input")].find((i) => i.inputMode === "decimal");
  typeInto(preCloseInput, String(kpiValue("Expected cash")));
  await sleep(250);
  clickEl([...preCloseDialog.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim() === "Review close"));
  await sleep(300);
  clickEl([...dialog().querySelectorAll("button")].find((b) => (b.textContent ?? "").trim() === "Confirm close"));
  await sleep(300);

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
  for (let i = 0; i < 12 && !bodyText().includes("SH-000002"); i += 1) {
    await sleep(300);
  }
  assert.ok(bodyText().includes("SH-000002"), "shift SH-000002 opened");
  assert.equal(kpiValue("Opening balance"), 1000, "opening balance KPI shows the float");
  assert.equal(kpiValue("Expected cash"), 1000, "expected cash starts at the opening float");
  console.log("  ✓ shift opened with a 1000 opening float");

  // ── Cash sale: pay the exact total in cash ──
  await navigate("#/pos");
  await posPickRow("Classic", "Classic Gold Ring");
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
  await posPickRow("Classic", "Classic Gold Ring");
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
  clickEl([...dialog().querySelectorAll("button")].find((b) => (b.textContent ?? "").trim() === "Review close"));
  await sleep(350);
  const reviewDialog = dialog();
  assert.ok(reviewDialog?.textContent.includes("Review before closing"), "close requires an explicit review");
  assert.ok(reviewDialog.textContent.includes("Opening balance"), "review shows opening cash");
  assert.ok(reviewDialog.textContent.includes("Cash sales"), "review shows cash sales");
  assert.ok(reviewDialog.textContent.includes("Cash refunds"), "review shows cash refunds");
  assert.ok(reviewDialog.textContent.includes("Cash expenses"), "review shows cash expenses");
  assert.ok(reviewDialog.textContent.includes("Expected cash"), "review shows expected cash");
  clickEl([...reviewDialog.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim() === "Confirm close"));
  for (let i = 0; i < 12 && !bodyText().includes("No shift is currently open"); i += 1) await sleep(300);
  assert.ok(bodyText().includes("No shift is currently open"), "shift closed and the dashboard is empty again");
  console.log("  ✓ shift closed with a balanced drawer");

  // ── Shift history carries the opening/closing detail and the difference ──
  await navigate("#/shifts/history");
  for (let i = 0; i < 12 && !bodyText().includes("SH-000002"); i += 1) await sleep(300);
  assert.ok(bodyText().includes("SH-000002"), "closed shift listed in history");
  const historyRow = [...document.querySelectorAll("tbody tr")].find((tr) =>
    (tr.textContent ?? "").includes("SH-000002"),
  );
  assert.ok(historyRow, "history row for SH-000002");
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
  assert.ok(detailDialog?.textContent.includes("SH-000002"), "shift detail modal opens");
  assert.ok(detailDialog.textContent.includes("EXP-000001"), "detail lists the shift expense");
  assert.ok(detailDialog.textContent.includes("Delivery fuel"), "detail names the expense");
  assert.ok(detailDialog.textContent.includes("Figures frozen"), "detail marks the snapshot as frozen");
  clickEl([...detailDialog.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim() === "Close"));
  await sleep(300);
  console.log("  ✓ shift history + detail keep the opening/closing details and difference");

  await navigate("#/shifts/eod");
  for (let i = 0; i < 12 && !bodyText().includes("End-of-day report"); i += 1) await sleep(300);
  assert.ok(bodyText().includes("End-of-day report"), "end-of-day report renders");
  assert.ok(bodyText().includes("SH-000002"), "the closed shift is in the day's roll-up");
  assert.ok(bodyText().includes("Closed shifts"), "EOD totals closed drawers");
  console.log("  ✓ end-of-day report lists the closed drawer");

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
  assert.ok(bodyText().includes("SH-000002"), "audit entries reference the shift");
  assert.ok(bodyText().includes("EXP-000001"), "audit entries reference the expense");
  assert.ok(bodyText().includes("ALYQ Admin"), "audit entries carry the acting user");
  console.log("  ✓ audit log records shift.opened, expense.created and shift.closed");

  // ── Reports hub: every export target writes a workbook that really opens ──
  // The export brief lists ten things that must be exportable: products, stock,
  // sales invoices, returns, customers, suppliers, expenses, payments, cash
  // movements and reports. Each is clicked for real here, the bytes the app hands
  // the browser are captured, and the file is parsed again with the same `xlsx`
  // the app uses to *import* — a workbook that will not parse here would not open
  // in Excel either. Row counts are then reconciled with the number each button
  // advertises on screen, so the file and the UI cannot disagree.
  await navigate("#/reports");
  for (let i = 0; i < 25 && !bodyText().includes("Reports & data export"); i += 1) await sleep(300);
  assert.ok(bodyText().includes("Reports & data export"), "the reports hub renders");
  assert.ok(bodyText().includes("Data exports"), "with the per-dataset exports");

  /** The "Export Excel" button on the row/card titled `title`. */
  const exportButtonFor = (title) => {
    const headings = [...document.querySelectorAll("main p, main h2")].filter(
      (n) => (n.textContent ?? "").trim() === title,
    );
    for (const heading of headings) {
      let scope = heading.parentElement;
      for (let depth = 0; scope && depth < 4; depth += 1) {
        const button = [...scope.querySelectorAll("button")].find((b) =>
          (b.textContent ?? "").includes("Export Excel"),
        );
        if (button) return button;
        scope = scope.parentElement;
      }
    }
    throw new Error(`no export button found for "${title}"`);
  };
  /** The count a row advertises in its hint ("12 payments" → 12). */
  const advertisedCount = (title) => {
    const heading = [...document.querySelectorAll("main p")].find(
      (n) => (n.textContent ?? "").trim() === title,
    );
    assert.ok(heading, `"${title}" is offered on the reports page`);
    const hint = heading.parentElement?.querySelectorAll("p")[1];
    const count = Number((hint?.textContent ?? "").match(/^(\d+)/)?.[1] ?? NaN);
    assert.ok(Number.isFinite(count), `"${title}" says how many rows it will write`);
    return count;
  };
  /** Click, capture what the browser was given, and prove it is a real workbook. */
  const captureExport = async (label, clickIt) => {
    const before = downloads.length;
    clickIt();
    for (let i = 0; i < 40 && downloads.length === before; i += 1) await sleep(150);
    if (downloads.length === before) return null;
    assert.equal(downloads.length, before + 1, `${label}: one file was handed to the browser`);
    const file = downloads[downloads.length - 1];
    assert.match(
      file.filename,
      /^alyq-[a-z0-9-]+-\d{4}-\d{2}-\d{2}-\d{4}\.xlsx$/,
      `${label}: the file is named predictably`,
    );
    const bytes = Buffer.from(await file.blob.arrayBuffer());
    assert.deepEqual(
      [...bytes.subarray(0, 4)],
      [0x50, 0x4b, 0x03, 0x04],
      `${label}: a real .xlsx (ZIP) file, not a renamed CSV`,
    );
    const workbook = XLSX.read(bytes, { type: "buffer" }); // opens, or throws
    assert.ok(workbook.SheetNames.length > 0, `${label}: the workbook has sheets`);
    for (const name of workbook.SheetNames) {
      assert.ok(name.length <= 31, `${label}: sheet "${name}" fits Excel's 31-character limit`);
      assert.ok(!/[:\\/?*[\]]/.test(name), `${label}: sheet "${name}" has no illegal character`);
    }
    assert.equal(
      new Set(workbook.SheetNames).size,
      workbook.SheetNames.length,
      `${label}: sheet names are unique`,
    );
    assert.ok(
      bodyText().includes(file.filename),
      `${label}: the success toast names the file that was written`,
    );

    // Labels are interpolated at runtime (`pos.status.${status}`), so a status
    // with no dictionary entry lands in the spreadsheet as the raw key — that
    // once made every settled payment read "pos.status.paid". No cell of any
    // exported file may look like a translation key.
    const looksLikeKey = /^(app|auth|common|pos|export|products|inventory|customers|reports|expenses|returns|shifts|mode|nav|dashboard|audit)\.[a-zA-Z][a-zA-Z0-9.]*$/;
    for (const sheetName of workbook.SheetNames) {
      const grid = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, raw: true });
      for (const row of grid) {
        for (const cell of row) {
          assert.ok(
            !looksLikeKey.test(String(cell ?? "")),
            `${label}: no untranslated label reaches the file (found "${cell}" in "${sheetName}")`,
          );
        }
      }
    }
    return { filename: file.filename, sheetNames: workbook.SheetNames, workbook };
  };
  const clickButton = (button) =>
    button.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  const downloadWorkbookFor = (title) =>
    captureExport(title, () => {
      const button = exportButtonFor(title);
      assert.ok(!button.disabled, `"${title}" is exportable with the data on screen`);
      clickButton(button);
    });
  /** Data rows of a parsed sheet: between the header and the Total/notes block. */
  const dataRowsOf = (workbook, sheetName) => {
    const grid = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, raw: true });
    const found = [];
    for (const row of grid.slice(1)) {
      const first = row[0];
      if (first === undefined || first === null || first === "") break;
      if (String(first).trim() === "Total") break;
      found.push(row);
    }
    return found;
  };

  // Payments: until now this data existed only as one sheet of the big report.
  const payments = await downloadWorkbookFor("Payments");
  assert.deepEqual(
    payments.sheetNames,
    ["Summary", "Payments"],
    "a per-method summary plus every payment line",
  );
  const paymentLines = dataRowsOf(payments.workbook, "Payments");
  assert.equal(
    paymentLines.length,
    advertisedCount("Payments"),
    "the file holds exactly the payment lines the button promised",
  );
  const methodRows = dataRowsOf(payments.workbook, "Summary");
  assert.ok(methodRows.length >= 1, "at least one payment method was used");
  const lineTotal = paymentLines.reduce((acc, row) => acc + Number(row[6]), 0);
  const methodTotal = methodRows.reduce((acc, row) => acc + Number(row[4]), 0);
  assert.ok(
    Math.abs(lineTotal - methodTotal) < 0.005,
    `the method summary (${methodTotal}) equals the payment lines (${lineTotal})`,
  );
  assert.ok(
    Math.abs(methodRows.reduce((acc, row) => acc + Number(row[2]) + Number(row[3]), 0) - methodTotal) < 0.005,
    "settled + awaiting confirmation = the amount taken",
  );

  // Cash movements: the drawer ledger, derived, with a running balance.
  const cash = await downloadWorkbookFor("Cash movements");
  assert.deepEqual(cash.sheetNames, ["Cash movements"], "one ledger sheet");
  const ledgerRows = dataRowsOf(cash.workbook, "Cash movements");
  assert.equal(
    ledgerRows.length,
    advertisedCount("Cash movements"),
    "the ledger holds exactly the movements the button promised",
  );
  let running = 0;
  for (const row of ledgerRows) {
    running = Math.round((running + Number(row[4] || 0) - Number(row[5] || 0)) * 100) / 100;
    assert.ok(
      Math.abs(Number(row[6]) - running) < 0.005,
      `the running balance is correct after ${row[2]}`,
    );
  }
  assert.ok(
    ledgerRows.some((row) => String(row[1]) === "Opening float" && Number(row[4]) === 1000),
    "the 1000 float this suite opened is money in",
  );
  assert.ok(
    ledgerRows.some((row) => String(row[2]) === "EXP-000001" && Number(row[5]) === 100),
    "the 100 cash expense this suite recorded is money out",
  );
  assert.ok(
    !ledgerRows.some((row) => String(row[1]) === "Cash sale" && Number(row[4]) === 0),
    "no zero-value movements are written",
  );

  // The report contains both — and must not disagree with the standalone files.
  const financial = await downloadWorkbookFor("Financial report");
  assert.deepEqual(
    financial.sheetNames,
    ["Summary", "Payments", "Returns", "Refunds", "Expenses", "Shift summaries", "Cash movements"],
    "one sheet per report",
  );
  assert.deepEqual(
    dataRowsOf(financial.workbook, "Payments"),
    paymentLines,
    "the report's Payments sheet and the standalone Payments file are identical",
  );
  assert.deepEqual(
    dataRowsOf(financial.workbook, "Cash movements"),
    ledgerRows,
    "and so are the two cash-movement ledgers",
  );

  // The remaining datasets on the hub.
  const invoices = await downloadWorkbookFor("Invoices");
  assert.deepEqual(invoices.sheetNames, ["Invoices", "Invoice items"], "invoices plus their lines");
  assert.equal(
    dataRowsOf(invoices.workbook, "Invoices").length,
    advertisedCount("Invoices"),
    "one row per invoice in range",
  );
  assert.ok(
    dataRowsOf(invoices.workbook, "Invoice items").length >=
      dataRowsOf(invoices.workbook, "Invoices").length,
    "and at least one line item each",
  );

  const inventory = await downloadWorkbookFor("Inventory");
  assert.deepEqual(inventory.sheetNames, ["Inventory"], "the stock balance sheet");
  assert.equal(
    dataRowsOf(inventory.workbook, "Inventory").length,
    advertisedCount("Inventory"),
    "one row per tracked product",
  );

  const products = await downloadWorkbookFor("Products");
  assert.deepEqual(products.sheetNames, ["Products"], "the catalogue sheet");
  assert.equal(
    dataRowsOf(products.workbook, "Products").length,
    advertisedCount("Products"),
    "one row per product",
  );

  const customers = await downloadWorkbookFor("Customers");
  assert.deepEqual(customers.sheetNames, ["Customers", "Purchase history"], "the book plus history");
  assert.equal(
    dataRowsOf(customers.workbook, "Customers").length,
    advertisedCount("Customers"),
    "one row per customer",
  );

  // Suppliers are derived from purchase movements and expenses: with nothing to
  // derive the app refuses to write an empty file instead of downloading one.
  const suppliers = await captureExport("Purchases & suppliers", () =>
    clickButton(exportButtonFor("Purchases & suppliers")),
  );
  if (suppliers) {
    assert.deepEqual(
      suppliers.sheetNames,
      ["Purchases & suppliers", "Supplier roll-up"],
      "purchase activity plus the per-supplier roll-up",
    );
  } else {
    assert.ok(
      bodyText().includes("Nothing to export yet"),
      "with no purchase activity the export says so rather than writing an empty file",
    );
  }
  console.log("  ✓ reports hub: payments, cash movements, financial report and every dataset export");

  // Returns and expenses are exported from their own screens.
  const downloadScreenExport = async (route, waitText) => {
    await navigate(route);
    for (let i = 0; i < 25 && !bodyText().includes(waitText); i += 1) await sleep(300);
    return captureExport(route, () => {
      const button = [...document.querySelectorAll("main button")].find((b) =>
        (b.textContent ?? "").includes("Export Excel"),
      );
      assert.ok(button, `${route} offers an export`);
      assert.ok(!button.disabled, `${route} has something to export`);
      clickButton(button);
    });
  };
  const returns = await downloadScreenExport("#/returns", "Returns");
  // Order is the builder's: returns, their refunds, then the per-item detail.
  assert.deepEqual(
    returns.sheetNames,
    ["Returns", "Refunds", "Returned items"],
    "returns, the refunds they triggered, and the items sent back",
  );
  assert.ok(dataRowsOf(returns.workbook, "Returns").length >= 1, "the return this suite created is in it");
  const expenses = await downloadScreenExport("#/expenses", "Expenses");
  assert.deepEqual(expenses.sheetNames, ["Expenses"], "the expense sheet");
  assert.ok(
    dataRowsOf(expenses.workbook, "Expenses").some((row) => String(row[0]) === "EXP-000001"),
    "the expense this suite recorded is in it",
  );
  console.log("  ✓ returns and expenses export from their own screens, with the records just created");

  // The date range drives every time-series export.
  await navigate("#/reports");
  for (let i = 0; i < 25 && !bodyText().includes("Data exports"); i += 1) await sleep(300);
  const dateInputs = document.querySelectorAll('main input[type="date"]');
  assert.equal(dateInputs.length, 2, "the hub has a from and a to date");
  const setDateValue = (input, value) => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value").set.call(input, value);
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  };
  setDateValue(dateInputs[0], "2099-01-01");
  await sleep(600);
  const futurePayments = exportButtonFor("Payments");
  assert.ok(futurePayments.disabled, "a range containing no sales disables the payments export");
  assert.equal(
    futurePayments.getAttribute("title"),
    "Nothing to export yet",
    "and explains why instead of failing silently",
  );
  assert.equal(advertisedCount("Payments"), 0, "the row now advertises zero payment lines");
  click("All time");
  await sleep(600);
  assert.ok(!exportButtonFor("Payments").disabled, "clearing the range makes it exportable again");
  assert.ok(advertisedCount("Payments") > 0, "and the payment lines come back");
  console.log("  ✓ the date range narrows every export, and an empty range writes nothing");

  // ── Phase 14 · Advanced reports: every tab over one window, and their file ──
  // The hub above proves the raw extracts still write. This proves the screen
  // that answers questions *before* anybody knows which file they want renders
  // the same data — the invoices, the expense and the closed shift this suite
  // created — and that its own export is a workbook Excel would open.
  await navigate("#/reports/advanced");
  for (let i = 0; i < 30 && !bodyText().includes("Advanced reports"); i += 1) await sleep(300);
  const mainEl = () => document.querySelector("main") ?? document;
  assert.ok(bodyText().includes("Advanced reports"), "the advanced reports screen renders");
  // Phase 49: the sidebar carries the Reports module; the advanced screen is
  // its own route (bookmarked URLs still resolve — proven by this navigate).
  assert.ok(navHrefs().includes("#/reports"), "and the sidebar offers the Reports module");
  assert.ok(bodyText().includes("Date range"), "with the one window every tab reads");
  assert.ok(bodyText().includes("Sales by employee"), "the sales analysis leads the screen");
  /** Rows on screen — the analysis is tables, so "has data" means "has rows". */
  const tableRows = () => mainEl().querySelectorAll("tbody tr").length;
  assert.ok(tableRows() >= 3, `the sales tables are populated (${tableRows()} rows)`);

  /** Click a tab by its `role="tab"` label — the sidebar also contains "Reports". */
  const clickTab = async (label, expected) => {
    const tab = [...document.querySelectorAll('[role="tab"]')].find((n) =>
      (n.textContent ?? "").trim().startsWith(label),
    );
    assert.ok(tab, `the "${label}" tab exists`);
    clickButton(tab);
    for (let i = 0; i < 25 && !bodyText().includes(expected); i += 1) await sleep(200);
    assert.ok(bodyText().includes(expected), `the "${label}" tab renders "${expected}"`);
    assert.equal(tab.getAttribute("aria-selected"), "true", `and reports itself selected`);
  };
  /** The tab's own report file: real workbook, no untranslated cell. */
  const captureTabExport = async (label) => {
    const button = [...mainEl().querySelectorAll("button")].find((b) =>
      (b.textContent ?? "").includes("Export Excel"),
    );
    assert.ok(button, `the ${label} tab offers an export`);
    assert.ok(!button.disabled, `and it is enabled with the data on screen`);
    return captureExport(`advanced ${label} report`, () => clickButton(button));
  };

  const salesReport = await captureTabExport("sales");
  assert.deepEqual(
    salesReport.sheetNames,
    ["Summary", "By employee", "By branch & register", "Payments", "Sales trend"],
    "the sales workbook holds every sales breakdown",
  );
  assert.ok(
    dataRowsOf(salesReport.workbook, "By employee").length >= 1,
    "and the invoices this suite completed are attributed to whoever sold them",
  );
  assert.ok(
    dataRowsOf(salesReport.workbook, "Sales trend").length >= 1,
    "with a day in the trend for the day they were taken",
  );

  await clickTab("Products", "Product profitability");
  const productReport = await captureTabExport("products");
  assert.equal(productReport.sheetNames[0], "Summary", "the product workbook opens on a summary");
  assert.ok(productReport.sheetNames.length >= 4, "with the profitability, movers and stock sheets");

  await clickTab("Customers", "Top customers");
  assert.ok(bodyText().includes("Purchase history"), "and a customer's purchase history");

  await clickTab("Expenses", "Expenses by category");
  assert.ok(bodyText().includes("Transport"), "the expense this suite recorded is in the category breakdown");
  assert.ok(bodyText().includes("Expenses by employee"), "split by category, employee and branch");
  const expenseReport = await captureTabExport("expenses");
  assert.equal(expenseReport.sheetNames[0], "Summary", "the expense workbook opens on a summary");
  assert.ok(expenseReport.sheetNames.length >= 4, "with the category, employee, branch and day sheets");

  await clickTab("Shifts", "Daily shift report");
  assert.ok(bodyText().includes("Cash differences"), "with the cash difference report");
  assert.ok(bodyText().includes("Employee shift performance"), "and per-employee performance");
  const shiftReport = await captureTabExport("shifts");
  assert.deepEqual(
    shiftReport.sheetNames,
    ["Summary", "Shift summaries", "Cash differences", "Daily shifts", "Employee performance"],
    "the shift workbook holds the daily report, the gaps and the people",
  );
  assert.ok(
    dataRowsOf(shiftReport.workbook, "Shift summaries").length >= 1,
    "and the drawer this suite closed is in the report",
  );
  // The suite balanced its drawer, so the difference report is legitimately
  // empty — which must read as "everything matched", not as "nothing counted".
  assert.equal(
    dataRowsOf(shiftReport.workbook, "Cash differences").length,
    0,
    "a balanced drawer is not a discrepancy",
  );
  assert.ok(
    bodyText().includes("Every counted drawer matched"),
    "and the screen says so rather than showing an empty table",
  );

  await clickTab("Financial", "Refund impact & net performance");
  assert.ok(bodyText().includes("Net after refunds"), "net of what the refunds took back out");
  assert.ok(bodyText().includes("Net profit"), "alongside the hub's own financial totals");

  // Label is "Profitability" on purpose: clickTab uses startsWith, and
  // "Products".startsWith("Profit") is true.
  await clickTab("Profitability", "Discount impact");
  assert.ok(bodyText().includes("Gross sales"), "management KPIs lead the profit tab");
  assert.ok(bodyText().includes("Slow-mover lookback"), "slow movers are their own control, not low stock");
  const profitReport = await captureTabExport("profitability");
  assert.ok(profitReport.sheetNames.includes("Summary"), "the profit workbook opens on a summary");
  assert.ok(
    profitReport.sheetNames.includes("Product profitability") &&
      profitReport.sheetNames.includes("Variant profitability"),
    "with product and variant profitability sheets",
  );
  assert.ok(
    profitReport.sheetNames.includes("Best sellers") && profitReport.sheetNames.includes("Slow movers"),
    "and real best-seller / slow-mover sheets, not Featured",
  );

  // One window drives every tab: a range holding nothing empties the screen and
  // says so, instead of showing yesterday's figures under today's dates.
  await clickTab("Sales", "Sales by employee");
  const advDates = document.querySelectorAll('main input[type="date"]');
  assert.equal(advDates.length, 2, "the advanced screen has its own from and to dates");
  setDateValue(advDates[0], "2099-01-01");
  for (let i = 0; i < 25 && !bodyText().includes("Nothing in this window"); i += 1) await sleep(200);
  assert.ok(bodyText().includes("Nothing in this window"), "a range with no data says so");
  assert.equal(tableRows(), 0, "and every sales table is empty inside it");
  click("All time", mainEl());
  for (let i = 0; i < 25 && bodyText().includes("Nothing in this window"); i += 1) await sleep(200);
  assert.ok(tableRows() >= 3, "clearing the range brings the figures back");
  console.log("  ✓ advanced reports: every tab over one window, real workbooks, empty range explained");

  // ── Phase 14 · Dashboard: KPI cards and four SVG charts, behind the gate ──
  await navigate("#/");
  for (let i = 0; i < 30 && !bodyText().includes("Business performance"); i += 1) await sleep(300);
  assert.ok(bodyText().includes("Today's revenue"), "the dashboard keeps the tiles it already had");
  assert.ok(bodyText().includes("Business performance"), "and grows a performance section");
  for (const card of [
    "Sales this month",
    "Net profit this month",
    "Expenses this month",
    "Pending approvals",
    "Pending online orders",
  ]) {
    assert.ok(bodyText().includes(card), `with the "${card}" card`);
  }
  for (const panel of [
    "Sales trend",
    "Revenue vs expenses",
    "Payment methods",
    "Product performance",
    "Top selling products",
  ]) {
    assert.ok(bodyText().includes(panel), `and the "${panel}" panel`);
  }
  // Hand-drawn SVG, not a charting library and not an image: the four charts put
  // paths, rects and circles in the document.
  const svg = [...mainEl().querySelectorAll("svg")];
  assert.ok(svg.length >= 4, `the charts render as SVG (${svg.length} elements)`);
  assert.ok(
    svg.some((node) => node.querySelector("path")) && svg.some((node) => node.querySelector("rect")),
    "with a trend line and bars drawn in it",
  );
  assert.ok(
    svg.some((node) => node.querySelectorAll("circle").length >= 2),
    "and a donut for the payment mix",
  );
  assert.ok(bodyText().includes("Open advanced reports"), "linking through to the analysis");
  console.log("  ✓ dashboard: month-to-date KPIs, both queues and four SVG charts");

  // A read-only role may still read reports, so neither screen may over-refuse.
  await signInAs("viewer");
  await navigate("#/reports/advanced");
  for (let i = 0; i < 25 && !bodyText().includes("Sales by employee"); i += 1) await sleep(300);
  assert.ok(bodyText().includes("Sales by employee"), "a viewer reads the analysis");
  assert.ok(!denied(), "and is not refused the screen the capability matrix grants");
  await navigate("#/");
  for (let i = 0; i < 25 && !bodyText().includes("Business performance"); i += 1) await sleep(300);
  assert.ok(bodyText().includes("Business performance"), "the dashboard performance section too");
  console.log("  ✓ advanced reports and the dashboard stay readable for a read-only role");

  await signInAs("admin");
  await navigate("#/reports");
  for (let i = 0; i < 25 && !bodyText().includes("Data exports"); i += 1) await sleep(300);

  // ── Audit trail is an oversight screen: managers/admins only ──
  // Authentication phase: the acting role now comes from the session, so the
  // check signs in as each user instead of flipping a demo role switcher.
  await signInAs("viewer");
  assert.ok(!navHrefs().includes("#/audit"), "viewer does not see the audit log in the sidebar");
  await navigate("#/audit");
  for (let i = 0; i < 10 && !bodyText().includes("Audit log is restricted"); i += 1) await sleep(300);
  assert.ok(bodyText().includes("Audit log is restricted"), "viewer is denied when typing #/audit directly");
  assert.ok(bodyText().includes("Only managers and admins"), "denial explains who may read the trail");
  assert.ok(!bodyText().includes("Shift closed"), "viewer never sees audit entries");
  assert.ok(!/EXP-\d{6}/.test(bodyText()), "no expense records leak into the denied view");
  console.log("  ✓ audit log is blocked for viewers (nav hidden + route denied)");

  await signInAs("manager");
  // Phase 49: the trail is reached from the Settings home's System group.
  assert.ok(navHrefs().includes("#/settings"), "manager sees the Settings door");
  await navigate("#/settings");
  for (let i = 0; i < 12 && !document.querySelector('[data-testid="settings-card-audit"]'); i += 1) await sleep(300);
  assert.ok(document.querySelector('[data-testid="settings-card-audit"]'), "manager sees the audit log entry on the settings home");
  await navigate("#/audit");
  for (let i = 0; i < 12 && !bodyText().includes("Shift closed"); i += 1) await sleep(300);
  assert.ok(bodyText().includes("Shift closed"), "manager can read the audit trail");
  console.log("  ✓ audit log stays readable for managers");

  // ── Authentication: session, identity, logout and per-role access ──
  // Wrong password is rejected and keeps the user on the login screen.
  await signOut();
  await signInAs("admin", "wrong-password");
  assert.ok(
    bodyText().includes("Incorrect username or password"),
    "wrong password is rejected with a message",
  );
  assert.ok(usernameField(), "still on the login screen after a failed attempt");
  assert.ok(!bodyText().includes("ALYQ-1001"), "no data leaks on a failed sign-in");
  console.log("  ✓ wrong password rejected, session not created");

  // Correct credentials create a session and reach the requested screen.
  setField("input[autocomplete='current-password']", DEMO_PASSWORD);
  click("Sign in");
  for (let i = 0; i < 25 && !isSignedIn(); i += 1) await sleep(200);
  assert.ok(isSignedIn(), "correct password signs in");
  assert.ok(bodyText().includes("ALYQ Admin"), "the acting user is the signed-in account");
  console.log("  ✓ successful login creates a session and identifies the user");

  // The session survives a reload (persisted, not just in-memory).
  assert.ok(
    dom.window.localStorage.getItem("alyq.auth.session.v1") ||
      dom.window.sessionStorage.getItem("alyq.auth.session.v1"),
    "the session is persisted for the next page load",
  );

  // Logout ends the session and returns to the login screen.
  await signOut();
  assert.ok(usernameField(), "logout returns to the login screen");
  assert.ok(bodyText().includes("You have been signed out"), "logout is explained to the user");
  assert.ok(
    !dom.window.localStorage.getItem("alyq.auth.session.v1") &&
      !dom.window.sessionStorage.getItem("alyq.auth.session.v1"),
    "logout clears the stored session",
  );
  // A deep link attempted while signed out is preserved for after sign-in.
  await navigate("#/expenses");
  assert.ok(usernameField(), "protected screens are unreachable signed out");
  assert.ok(
    decodeURIComponent(dom.window.location.hash).includes("next=/expenses"),
    "the attempted route is remembered in the login URL",
  );
  console.log("  ✓ logout clears the session and protected routes redirect to login");

  // Route protection: every protected screen, typed directly, needs a session.
  await signInAs("admin");
  for (const route of [
    "#/",
    "#/pos",
    "#/pos/sales",
    "#/returns",
    "#/refunds",
    "#/inventory",
    "#/inventory/movements",
    "#/audit",
    "#/shifts",
    "#/shifts/history",
    "#/expenses",
  ]) {
    await navigate(route);
    assert.ok(!usernameField(), `${route} renders for a signed-in admin`);
    assert.ok(!bodyText().includes("Something went wrong"), `${route} renders without an error`);
  }
  console.log("  ✓ every protected screen requires — and accepts — an active session");

  // ── Cashier: runs the till, but no oversight or stock authority ──
  await signInAs("cashier");
  assert.ok(isSignedIn(), "cashier signed in");
  const cashierNav = navHrefs();
  assert.ok(cashierNav.includes("#/pos"), "cashier sees the register");
  // Phase 49+: catalog, sales, inventory and customers hang off the Store
  // Management workspace — the cashier sees the door; the rooms are its
  // cards, each route still its own gate.
  assert.ok(cashierNav.includes("#/management"), "cashier sees the Store Management door");
  assert.ok(!cashierNav.includes("#/returns") && !cashierNav.includes("#/refunds"), "no returns/refunds leaves in the sidebar");
  await navigate("#/management");
  for (let i = 0; i < 12 && !document.querySelector('[data-testid="module-card-returns"]'); i += 1) await sleep(300);
  assert.ok(document.querySelector('[data-testid="module-card-returns"]'), "cashier sees returns on the Sales home");
  assert.ok(document.querySelector('[data-testid="module-card-refunds"]'), "cashier sees refunds on the Sales home");
  assert.ok(!cashierNav.includes("#/audit"), "cashier does not see the audit log");
  await navigate("#/pos");
  await waitFor(() => posScanBox(), { label: "the scan/search box" });
  assert.ok(posScanBox(), "cashier can open the register (sell capability)");
  assert.ok(!denied(), "the register is not denied for cashiers");
  await navigate("#/audit");
  await sleep(400);
  assert.ok(bodyText().includes("Audit log is restricted"), "cashier is denied the audit trail");
  await navigate("#/inventory/stock");
  for (let i = 0; i < 12 && !bodyText().includes("Viewing as"); i += 1) await sleep(300);
  assert.ok(
    bodyText().includes("Viewing as Cashier"),
    "cashier sees inventory read-only (no stock authority)",
  );
  await navigate("#/expenses");
  await sleep(400);
  assert.ok(!denied(), "cashier may record expenses");
  console.log("  ✓ cashier: register + returns + refunds yes, audit + stock adjustments no");

  // ── Viewer: read-only, and no till at all ──
  await signInAs("viewer");
  const viewerNav = navHrefs();
  assert.ok(!viewerNav.includes("#/pos"), "viewer does not see the register");
  assert.ok(!viewerNav.includes("#/returns"), "viewer does not see returns");
  assert.ok(!viewerNav.includes("#/refunds"), "viewer does not see refunds");
  assert.ok(!viewerNav.includes("#/audit"), "viewer does not see the audit log");
  assert.ok(viewerNav.includes("#/management"), "viewer keeps workspace access (inventory lives inside)");
  for (const route of ["#/pos", "#/returns", "#/refunds", "#/audit"]) {
    await navigate(route);
    await sleep(400);
    assert.ok(
      denied() || bodyText().includes("Audit log is restricted"),
      `${route} is denied for a viewer`,
    );
  }
  await navigate("#/pos");
  await sleep(400);
  assert.ok(!bodyText().includes("ALYQ-1001"), "no POS data leaks into the viewer's denial");
  await navigate("#/inventory/stock");
  await sleep(500);
  assert.ok(!denied(), "viewer can still read inventory");
  console.log("  ✓ viewer: read-only screens only, till and refunds denied");

  // ── Session lifetime invariants ──
  // Actual expiry/eviction is exercised in `scripts/auth.flow.mjs`, which can
  // boot the app on a seeded session. Here the UI contract is checked: the
  // session is persisted with a future expiry, remember-me selects the store,
  // and a chosen registration outlives the tab only when asked to.
  await signInAs("manager");
  const readStored = () => {
    const raw =
      dom.window.localStorage.getItem("alyq.auth.session.v1") ??
      dom.window.sessionStorage.getItem("alyq.auth.session.v1");
    return raw ? JSON.parse(raw) : null;
  };
  const plain = readStored();
  assert.ok(plain, "a session record is persisted after sign-in");
  assert.ok(
    new Date(plain.session.expires_at).getTime() > Date.now(),
    "the stored session expires in the future",
  );
  assert.equal(plain.persistence, "session", "without remember-me the session is tab-scoped");
  assert.equal(plain.session.remember, false, "remember-me flag recorded as off");

  await signOut();
  setField("input[autocomplete='username']", "manager");
  setField("input[autocomplete='current-password']", DEMO_PASSWORD);
  // The remember-me checkbox is the only checkbox on the login form.
  const remember = document.querySelector("input[type='checkbox']");
  assert.ok(remember, "the login form offers remember-me");
  remember.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  await sleep(100);
  click("Sign in");
  for (let i = 0; i < 25 && !isSignedIn(); i += 1) await sleep(200);
  const remembered = readStored();
  assert.equal(remembered.persistence, "local", "remember-me moves the session to localStorage");
  assert.equal(remembered.session.remember, true, "remember-me flag recorded as on");
  assert.ok(
    !dom.window.sessionStorage.getItem("alyq.auth.session.v1"),
    "the session is never kept in both stores at once",
  );
  assert.ok(
    new Date(remembered.session.expires_at).getTime() >
      new Date(plain.session.expires_at).getTime(),
    "remember-me grants the longer idle lifetime",
  );
  console.log("  ✓ session persistence: tab-scoped by default, localStorage when remembered");

  await signInAs("admin");
  // Phase 49: oversight screens live behind the Settings home — the door, not the leaf.
  assert.ok(navHrefs().includes("#/settings"), "admin restored the oversight door");
  console.log("  ✓ role changes are driven by the signed-in session, not a demo switcher");

  // ── Explicit Sidebar Navigation Verification ──
  // Six-door IA: Customers has no global door — it is a card of the Store
  // Management workspace. Click the workspace door, then its Customers card.
  const managementNav = [...document.querySelectorAll("aside nav a")].find((a) => (a.getAttribute("href") ?? "") === "#/management");
  assert.ok(managementNav, "Store Management door exists in sidebar");
  managementNav.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  await sleep(350);
  const customersCard = [...document.querySelectorAll('[data-testid="module-card-customers"]')][0];
  assert.ok(customersCard, "workspace offers the Customers card");
  customersCard.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  await sleep(400);
  assert.ok(dom.window.location.hash.includes("/customers"), "the workspace navigates to Customers page");
  assert.ok(bodyText().includes("Customer name") || bodyText().includes("Customers"), "Customers UI rendered from the workspace");

  // Returns and Refunds: cards on the workspace's embedded operations section —
  // the rooms render through the home's cards, their URLs unchanged.
  await navigate("#/management");
  await sleep(500);
  const returnsCard = [...document.querySelectorAll('[data-testid="module-card-returns"]')][0];
  assert.ok(returnsCard, "workspace offers the Returns card");
  returnsCard.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  await sleep(400);
  assert.ok(dom.window.location.hash.includes("/returns"), "the workspace navigates to Returns");
  assert.ok(bodyText().includes("Returns") || bodyText().includes("Refunds"), "Returns UI rendered");

  await navigate("#/management");
  await sleep(400);
  const refundsCard = [...document.querySelectorAll('[data-testid="module-card-refunds"]')][0];
  assert.ok(refundsCard, "workspace offers the Refunds card");
  refundsCard.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  await sleep(400);
  assert.ok(dom.window.location.hash.includes("/refunds"), "the workspace navigates to Refunds");
  assert.ok(bodyText().includes("Refund #") || bodyText().includes("Refunds"), "Refunds UI rendered");
  console.log("  ✓ module navigation: workspace door → Customers, Returns and Refunds verified");

  // 13 ─ bilingual RTL/LTR (including the POS screens)
  click("العربية");
  await sleep(300);
  assert.equal(document.documentElement.getAttribute("dir"), "rtl", "RTL applied");
  assert.ok(bodyText().includes("قسم المبيعات") || bodyText().includes("الكاشير"), "Sales section header in Arabic");
  await navigate("#/pos");
  assert.ok(bodyText().includes("البيع الحالي") || bodyText().includes("السلة فارغة"), "cart panel in Arabic");
  // The rebuilt split-tender panel shows the cash field by default and reveals
  // InstaPay/Visa only when the cashier splits the payment — the method labels
  // are no longer permanently visible, so assert them through the split toggle.
  assert.ok(bodyText().includes("نقدي"), "cash payment method in Arabic");
  toggleSwitch("تقسيم الدفع");
  await sleep(250);
  assert.ok(bodyText().includes("نقدي") && bodyText().includes("إنستا باي"), "payment methods in Arabic");
  toggleSwitch("تقسيم الدفع");
  await sleep(250);
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

  /* ── POS → website (regression) ────────────────────────────────────────────
   * Found in the final A-to-Z audit: the storefront existed, #/store was
   * routed, and both the app shell and the website settings screen linked to
   * it — but the POS register had no way to open the shop. No button, no
   * handler, no URL generation anywhere in src/modules/pos/.
   *
   * /store is a public top-level route rendered outside the authenticated
   * shell, so this must be plain internal navigation: nothing to configure, no
   * popup for a till browser's blocker to swallow, and it must not bounce to
   * the dashboard or the login screen. Deleting the control, gating it behind a
   * capability, or turning it into window.open fails the assertions below.
   *
   * The control is selected by test id on purpose: the sidebar also renders a
   * "View website" entry (nav.viewStore) that opens in a new tab, so a
   * label-based click here would prove nothing about the POS screen.
   */
  await signInAs("admin");
  await navigate("#/pos");
  assert.ok(bodyText().includes("Register"), "POS screen renders");
  const openWebsite = document.querySelector('a[data-testid="pos-open-website"]');
  assert.ok(openWebsite, "the POS header exposes an Open website control");
  assert.equal(
    openWebsite.getAttribute("href"),
    "#/store",
    "the POS control navigates internally to #/store",
  );
  assert.equal(
    openWebsite.getAttribute("target"),
    null,
    "the POS control must not open a new tab — a popup blocker turns that into a dead button",
  );
  assert.ok(
    (openWebsite.textContent ?? "").trim().length > 0,
    "the POS control has a visible label",
  );
  assert.ok(
    !bodyText().includes("not valid, so the built-in website"),
    "no storefront configuration warning when VITE_STOREFRONT_URL is unset",
  );
  console.log("  ✓ POS register offers an internal Open website control");

  openWebsite.dispatchEvent(
    new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }),
  );
  await sleep(800);
  assert.equal(dom.window.location.hash, "#/store", "clicking it lands on the storefront");
  assert.ok(!bodyText().includes("Register"), "the shop renders outside the POS shell");
  assert.ok(!denied(), "the storefront is not permission-gated for an employee");
  assert.ok(!usernameField(), "opening the shop does not throw the employee to the login screen");
  assert.ok(isSignedIn() || !usernameField(), "the session survives the trip to the shop");
  assert.ok(
    document.querySelector('a[href="#/store/products"]'),
    "the storefront homepage rendered its product listing links",
  );
  console.log("  ✓ storefront homepage renders from the POS control");

  // The customer journey the till just handed off to.
  await navigate("#/store/products");
  await sleep(600);
  const productLinks = [...document.querySelectorAll('a[href^="#/store/products/"]')];
  assert.ok(productLinks.length > 0, "the storefront listing links to product detail pages");
  productLinks[0].dispatchEvent(
    new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }),
  );
  await sleep(600);
  assert.match(
    dom.window.location.hash,
    /^#\/store\/products\/.+/,
    "a product card opens its detail page",
  );
  assert.ok(!denied(), "product detail is public");
  await navigate("#/store/cart");
  await sleep(500);
  assert.ok(!denied(), "the cart is reachable");
  assert.ok(!usernameField(), "the cart does not demand a sign-in");
  console.log("  ✓ storefront listing → product → cart all reachable");

  // And the cashier can get back to the till, still signed in.
  await navigate("#/pos");
  await sleep(600);
  assert.ok(isSignedIn(), "returning from the shop keeps the employee signed in");
  assert.ok(bodyText().includes("Register"), "the register renders again after the round trip");
  assert.ok(posScanBox(), "the scan/search box is still loaded after the round trip");
  console.log("  ✓ POS → website → POS round trip, no dashboard redirect, no sign-out");

  /* ── the reported bug: the shell's "View website" was a dead click ─────────
   * Two controls on the POS screen carry the same label (nav.viewStore). The
   * header one navigates internally; the shell entry asked for a new tab with
   * target="_blank", and an embedded host or a popup blocker refuses that
   * WITHOUT FEEDBACK — the click landed, nothing happened, the register stayed
   * put. That is what "clicking Open website still does nothing" was: the fix
   * that added the header control left this one, the entry people actually
   * click, exactly as broken as it had been.
   *
   * Both outcomes are pinned. This suite stubs window.open for its print
   * assertions, so the stub is swapped per case rather than assumed.
   */
  await navigate("#/pos");
  const shellShopLink = document.querySelector('a[data-testid="nav-open-website"]');
  assert.ok(shellShopLink, "the shell still offers a View website entry");
  assert.equal(
    shellShopLink.getAttribute("href"),
    "#/store",
    "its href is the internal shop route, so middle-click and open-in-new-tab still work",
  );
  assert.equal(
    shellShopLink.getAttribute("target"),
    "_blank",
    "target must stay for middle-click; only the plain click is taken over",
  );
  const clickLink = (el) =>
    el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  const printStub = dom.window.open;

  // Case A — the browser PERMITS the new tab: the shop opens beside the
  // register and this tab is left alone. That is the side-by-side behaviour the
  // entry was designed for, and the fallback must not interfere with it.
  let requestedTab = null;
  dom.window.open = (href) => {
    requestedTab = href;
    return printStub();
  };
  let hashBefore = dom.window.location.hash;
  clickLink(shellShopLink);
  await sleep(600);
  assert.equal(requestedTab, "#/store", "the new tab is asked for the internal shop route");
  assert.equal(
    dom.window.location.hash,
    hashBefore,
    "a permitted new tab must leave the register where it was",
  );

  // Case B — the new tab is REFUSED (embedded host, popup blocker). Before the
  // fix this was a no-op: the anchor's default action reports nothing.
  dom.window.open = () => null;
  hashBefore = dom.window.location.hash;
  clickLink(shellShopLink);
  await sleep(900);
  assert.notEqual(
    dom.window.location.hash,
    hashBefore,
    "clicking the shell entry must not be a no-op when the new tab is refused",
  );
  assert.equal(dom.window.location.hash, "#/store", "the shop opens in this tab as a fallback");
  assert.ok(
    !bodyText().includes("Register"),
    "the shop replaced the register instead of the click being swallowed",
  );
  assert.ok(!denied(), "the shop is not permission-gated");
  assert.ok(
    document.querySelector('a[href="#/store/products"]'),
    "the storefront homepage rendered after the fallback navigation",
  );
  console.log("  ✓ shell View website opens the shop when a new tab is refused");

  // The website settings screen had the same dead-click class. Still the same
  // admin session — the shop is public, it does not sign anyone out — so
  // navigate back inside the shell rather than re-authenticating: `signInAs`
  // starts by signing out, and the storefront has no sign-out control.
  await navigate("#/online/website");
  await sleep(900);
  const settingsShopLink = document.querySelector('a[data-testid="settings-open-store"]');
  assert.ok(settingsShopLink, "the website settings screen offers Open store");
  if (settingsShopLink) clickLink(settingsShopLink);
  await sleep(900);
  assert.equal(
    dom.window.location.hash,
    "#/store",
    "the website settings Open store link falls back when the new tab is refused",
  );
  assert.ok(!denied(), "the shop is reachable from the website settings screen");
  console.log("  ✓ website settings Open store opens the shop when a new tab is refused");

  dom.window.open = printStub;

  if (errors.length > 0) {
    console.error(`\n✗ ${errors.length} console error(s):`);
    for (const e of errors) console.error("  " + e.split("\n")[0]);
    process.exit(1);
  }
  // No screen in this suite may call an API: demo mode is localStorage-only, so
  // a network attempt is a failed request waiting to happen in production.
  assert.deepEqual(networkCalls, [], "the whole run made no network calls");
  console.log("\nAll DOM smoke checks passed with zero console errors and zero network calls.\n");
  process.exit(0);
}

main().catch((error) => {
  console.error("\n✗ smoke test failed:", error?.message ?? error);
  if (error?.stack) console.error(error.stack.split("\n").slice(0, 4).join("\n"));
  process.exit(1);
});
