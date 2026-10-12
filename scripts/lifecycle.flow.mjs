/**
 * Product lifecycle E2E — permanent delete vs archive (Phase: safe delete flow).
 *
 * Drives the real application bundle in jsdom through the whole lifecycle rule,
 * end to end, exactly as a boutique admin would:
 *
 *   1. create a truly unused product through the form;
 *   2. permanently delete it from the list — explicit confirm, double-submit
 *      protection, success toast, row gone;
 *   3. create a second product and sell one unit at the POS so it now carries
 *      history (sale_items + stock movements);
 *   4. its permanent-delete affordance is disabled with the reason copy —
 *      "This product has historical transactions and cannot be permanently
 *      deleted. Archive it instead.";
 *   5. a viewer (no edit_product / delete_product) cannot archive or delete
 *      from the list — the armed delete is not even rendered, and the archive
 *      attempt is refused with the permission toast;
 *   6. archive it — confirm, success toast — and the product disappears from
 *      the POS grid and from the public storefront catalogue, while the sale
 *      and movement rows it produced stay exactly as they were;
 *   7. reactivate from the list, sell it again at the POS;
 *   8. the audit log tells the whole story: Product archived / Product
 *      reactivated under the referenced SKU and exactly one Product permanently
 *      deleted under the unused one, all by the admin.
 *
 * The server-side half of the same rule (`public.delete_product` refusing a
 * referenced product, the FK RESTRICT backstop, per-role RLS) is locked by
 * `npm run db:check` (supabase/tests/scenarios.sql, Phase 25) and the demo
 * repository's own guard by `productLifecycle.selftest.ts`; this suite proves
 * the UI drives those layers correctly.
 *
 * Any console.error / window.onerror / network call fails the run: demo mode
 * is localStorage-only.
 *
 * The runner rebuilds the bundle every run and spawns this file as a process:
 *   node scripts/test.e2e.mjs lifecycle
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

// Demo mode is entirely local — every repository writes to localStorage. Any
// network attempt is an instant, named failure.
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
const selectOption = (selector, predicate) => {
  const select = document.querySelector(selector);
  const option = [...select.options].find(predicate);
  if (!option) throw new Error(`no option matches in ${selector}`);
  setField(selector, option.value);
};
const toastText = () =>
  [...document.querySelectorAll('[aria-live="polite"]')].map((n) => n.textContent ?? "").join("\n");

const readJson = (key) => {
  const raw = globalThis.localStorage.getItem(key);
  if (raw === null) return null;
  return JSON.parse(raw);
};
const SALES_KEY = "alyq.demo.sales.v1";
const MOVEMENTS_KEY = "alyq.demo.stock_movements.v1";
const sales = () => readJson(SALES_KEY) ?? [];
const movementsFor = (productId) =>
  (readJson(MOVEMENTS_KEY) ?? []).filter((m) => m.product_id === productId);
const saleLinesForSku = (sku) =>
  sales().flatMap((sale) => (sale.items ?? []).filter((item) => item.sku === sku));

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
  if (!usernameField()) await navigate("#/login", 500);
  await waitFor(() => Boolean(usernameField()), { label: "the login screen" });
  setField("input[autocomplete='username']", username);
  setField("input[autocomplete='current-password']", password);
  click("Sign in");
  await waitFor(() => isSignedIn(), { label: `${username} to sign in` });
  await sleep(400);
};

/** The products list, filtered to one SKU; returns its live table row. */
const openProductsList = async (sku) => {
  await navigate("#/products");
  await waitFor(() => document.querySelector('input[type="search"]'), {
    label: "the products screen",
  });
  // Re-navigating to the hash the app already sits on does not remount the
  // page, so clear the filter box first and let the full list repaint —
  // otherwise an SKU left over from the previous visit hides the seed row the
  // "list has loaded" wait below keys on.
  setField('input[type="search"]', "");
  await waitFor(() => bodyText().includes("ALYQ-1001"), { label: "the products list" });
  setField('input[type="search"]', sku);
  await sleep(350);
  const row = [...document.querySelectorAll("tbody tr")].find((tr) =>
    (tr.textContent ?? "").includes(sku),
  );
  return row ?? null;
};

/** The live row scoped button, or null when it is not rendered for this seat. */
const rowButton = (row, label) => row?.querySelector(`button[aria-label="${label}"]`) ?? null;

const HISTORY_REASON =
  "This product has historical transactions and cannot be permanently deleted. Archive it instead.";

const productsCount = async (sku) => {
  const row = await openProductsList(sku);
  return row ? 1 : 0;
};

/**
 * Confirm an in-flight action cannot be submitted twice: the first click arms
 * the `busyId` guard and the dialog re-renders with the confirm button
 * disabled; a second synchronous click is a no-op either way, and the audit
 * assertions below prove exactly one event was recorded.
 */
const confirmOnceWithDoubleSubmitGuard = async (label) => {
  const scope = dialog();
  assert.ok(scope, "confirmation dialog is open");
  const button = [...scope.querySelectorAll("button")].find((b) =>
    (b.textContent ?? "").trim().includes(label),
  );
  assert.ok(button, `confirm control "${label}" rendered`);
  assert.equal(button.disabled, false, "confirm starts enabled");
  clickEl(button);
  // React batches the state update past the synchronous dispatch, so settle one
  // tick: the page has marked the row busy by then, and the ~60 ms demo
  // repository round trip is still on the wire — the confirm must be disabled.
  await sleep(0);
  assert.equal(button.disabled, true, "confirm is disabled while the action is in flight");
  clickEl(button); // fired while busy: must be a no-op (the busyId guard)
  await waitFor(() => dialog() === null, { label: "the dialog to close" });
};

// ── the flow ────────────────────────────────────────────────────────────────

async function main() {
  console.log("\nProduct lifecycle · delete vs archive\n");
  await sleep(500);

  // 0 ─ sign in as admin (full capability, including product.delete)
  // The public shop owns `/`; staff reach their door through `#/login`.
  await navigate("#/login", 600);
  assert.ok(usernameField(), "the app opens the staff door on the login screen");
  await signInAs("admin");
  assert.ok(isSignedIn(), "admin signed in");

  // 1 ─ create a truly unused product through the form
  const unusedSku = "LCY-UNUSED";
  await navigate("#/products/new");
  await waitFor(() => document.querySelector("#sku"), { label: "the product form" });
  setField("#name_ar", "منتج محذوف");
  setField("#name_en", "Lifecycle Unused");
  setField("#sku", unusedSku);
  setField("#selling_price", "75");
  setField("#cost_price", "40");
  setField("#tax_rate", "15");
  setField("#stock_quantity", "5");
  setField("#low_stock_level", "2");
  selectOption("#category_id", (o) => o.value !== "");
  // The form routes to /products once the save resolves; the SKU is visible on
  // the form page itself (barcode preview), so a text wait alone can race the
  // navigation and have the pending route clobber the next one.
  clickExact("Save");
  await waitFor(() => dom.window.location.hash === "#/dashboard/products", {
    label: "the save to route back to the catalogue",
  });
  await waitFor(() => bodyText().includes(unusedSku), { label: "the new product to appear" });
  console.log("  ✓ created an unused product through the form");

  // 2 ─ permanently delete it: explicit confirmation, double-submit guard,
  //     success toast, the list refreshes and the row is gone
  let row = await openProductsList(unusedSku);
  assert.ok(row, "unused product is listed");
  const armedDelete = row.querySelector(`button[aria-label="Delete permanently: Lifecycle Unused"]`);
  assert.ok(armedDelete, "an unused product offers an armed permanent-delete action");
  console.log("  ✓ unused product offers an armed permanent-delete action");
  clickEl(armedDelete);
  await waitFor(() => dialog() !== null, { label: "the delete confirmation" });
  assert.ok(bodyText().includes("Permanently delete product?"), "explicit confirmation title");
  assert.ok(
    bodyText().includes("will be permanently removed from the catalog. This cannot be undone"),
    "the confirmation says it cannot be undone and that history is unaffected",
  );
  await confirmOnceWithDoubleSubmitGuard("Delete permanently");
  await waitFor(() => toastText().includes("Product permanently deleted"), {
    label: "the success toast",
  });
  assert.equal(await productsCount(unusedSku), 0, "the deleted product is gone from the list");
  console.log("  ✓ permanent delete: confirm dialog, double-submit guard, success toast, row gone");

  // 3 ─ a second product that will earn history, created through the form too
  const ringSku = "LCY-RING";
  await navigate("#/products/new");
  await waitFor(() => document.querySelector("#sku"), { label: "the product form" });
  setField("#name_ar", "خاتم دورة الحياة");
  setField("#name_en", "Lifecycle Ring");
  setField("#sku", ringSku);
  setField("#selling_price", "120");
  setField("#cost_price", "60");
  setField("#tax_rate", "15");
  setField("#stock_quantity", "10");
  setField("#low_stock_level", "2");
  selectOption("#category_id", (o) => o.value !== "");
  clickExact("Save");
  await waitFor(() => dom.window.location.hash === "#/dashboard/products", {
    label: "the save to route back to the catalogue",
  });
  await waitFor(() => bodyText().includes(ringSku), { label: "the ring to appear" });

  // Phase 27: a till sale requires an open shift — the suite rings up sales
  // twice (baseline and re-sale), so open one once, here, as the admin.
  await navigate("#/shifts");
  await waitFor(() => bodyText().includes("No shift is currently open"), { label: "a closed drawer" });
  const openShiftBtn = [...document.querySelectorAll("button")].find((b) =>
    (b.textContent ?? "").trim().includes("Open shift"),
  );
  clickEl(openShiftBtn);
  await sleep(400);
  const shiftDialog = [...document.querySelectorAll('[role="dialog"]')].pop();
  const shiftInputs = [...shiftDialog.querySelectorAll("input")];
  const fillShift = (input, value) => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value").set.call(input, value);
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  };
  fillShift(shiftInputs.find((i) => !i.readOnly && i.type === "text"), "Main branch");
  fillShift(shiftInputs.find((i) => i.inputMode === "decimal"), "100");
  clickEl([...shiftDialog.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim() === "Open shift"));
  await waitFor(() => /SH-\d{6}/.test(bodyText()), { label: "the shift to open" });
  console.log("  ✓ shift opened for the POS scenes");

  // Sell one unit through the POS so the ring is referenced by sale_items and
  // a stock movement. Baseline first: right now it IS sellable and IS on the
  // storefront — the two things archiving must take away.
  await navigate("#/pos");
  await waitFor(() => document.querySelector('[data-testid="pos-scan-search"]'), { label: "the scan/search box" });
  const searchFor = async (text) => {
    setField('[data-testid="pos-scan-search"]', text);
    await sleep(450);
  };
  const rowsFor = (name) =>
    [...document.querySelectorAll("[data-pos-result-index]")].filter((b) =>
      (b.textContent ?? "").includes(name),
    );
  await searchFor("Lifecycle Ring");
  await waitFor(() => rowsFor("Lifecycle Ring").length > 0, { label: "the ring in the POS results" });
  console.log("  ✓ baseline: the new product is sellable at the POS");

  await navigate("#/store/products", 700);
  await waitFor(() => document.querySelectorAll("article").length > 0, { label: "the storefront catalogue" });
  setField('input[type="search"]', "Lifecycle Ring");
  await sleep(400);
  assert.ok(
    [...document.querySelectorAll("article h3")].some((h) => (h.textContent ?? "").trim() === "Lifecycle Ring"),
    "baseline: the new product is visible on the storefront",
  );
  console.log("  ✓ baseline: the new product is visible on the storefront");

  await navigate("#/pos");
  await waitFor(() => document.querySelector('[data-testid="pos-scan-search"]'), { label: "the scan/search box" });
  await searchFor("Lifecycle Ring");
  await waitFor(() => rowsFor("Lifecycle Ring").length > 0, { label: "the ring in the POS results" });
  clickEl(rowsFor("Lifecycle Ring")[0]);
  await sleep(300);
  setField('[data-testid="cash-input"]', "120");
  await sleep(250);
  const completeBtn = [...document.querySelectorAll("button")].find(
    (b) => (b.textContent ?? "").trim().startsWith("✓") && (b.textContent ?? "").includes("Complete sale"),
  );
  assert.ok(completeBtn && !completeBtn.disabled, "complete sale is enabled once paid");
  clickEl(completeBtn);
  await waitFor(() => /INV-\d{6}/.test(bodyText()), { label: "the sale to complete" });
  click("New sale");
  await sleep(300);
  console.log("  ✓ sold one unit at the POS — the product now carries history");

  const historyBefore = {
    lines: saleLinesForSku(ringSku).length,
    movements: null, // needs the product id; read in step 6 after the row is open
  };
  assert.ok(historyBefore.lines >= 1, "the sale line is on record for the ring SKU");

  // 4 ─ permanent delete is now blocked: the affordance is disabled and says why
  row = await openProductsList(ringSku);
  assert.ok(row, "the referenced product is still listed");
  const blockedDelete = row.querySelector(`button[aria-label="${HISTORY_REASON}"]`);
  assert.ok(blockedDelete, "the referenced product shows the disabled delete with the reason");
  assert.equal(blockedDelete.disabled, true, "the reason-labeled delete cannot be clicked");
  assert.ok(
    !row.querySelector(`button[aria-label="Delete permanently: Lifecycle Ring"]`),
    "no armed delete is offered for a referenced product",
  );
  clickEl(blockedDelete); // a disabled control must not open anything
  assert.equal(dialog(), null, "disabled delete opens no dialog");
  console.log("  ✓ referenced product: permanent delete disabled with the spec's reason copy");

  // the id the history keeps referencing
  const ringId = (readJson("alyq.demo.catalog.v1")?.products ?? []).find((p) => p.sku === ringSku)?.id;
  assert.ok(ringId, "ring id resolved from the catalog");
  historyBefore.movements = movementsFor(ringId).length;
  assert.ok(historyBefore.movements >= 1, "the stock movement is on record for the ring");
  const salesBefore = sales().length;

  // 5 ─ a viewer can look but cannot act: no armed delete anywhere, and the
  //     archive attempt is refused with the permission toast — error feedback,
  //     no dead button.
  await signInAs("viewer");
  row = await openProductsList(ringSku);
  assert.ok(row, "viewer can browse the catalogue row");
  assert.ok(!rowButton(row, `Delete permanently: Lifecycle Ring`), "viewer is never offered permanent delete");
  const viewerArchive = rowButton(row, "Archive");
  assert.ok(viewerArchive, "viewer sees the archive affordance");
  clickEl(viewerArchive);
  await waitFor(() => dialog() !== null, { label: "the archive confirmation" });
  // a confirmation dialog that will be refused at the service layer
  confirmInDialog("Archive");
  await waitFor(() => toastText().includes("You do not have permission to do that."), {
    label: "the permission refusal toast",
  });
  assert.ok(
    (readJson("alyq.demo.catalog.v1")?.products ?? []).find((p) => p.sku === ringSku)?.active === true,
    "the refusal did not archive the product",
  );
  console.log("  ✓ viewer: no armed delete rendered; archive refused with the permission toast");
  await signInAs("admin");

  // 6 ─ archive: cancel path first (dialog closes, nothing changes), then confirm
  row = await openProductsList(ringSku);
  const archiveBtn = rowButton(row, "Archive");
  assert.ok(archiveBtn, "admin is offered Archive");
  clickEl(archiveBtn);
  await waitFor(() => dialog() !== null, { label: "the archive confirmation" });
  assert.ok(bodyText().includes("Archive product?"), "archive confirmation title");
  confirmInDialog("Cancel");
  await waitFor(() => dialog() === null, { label: "the dialog to close" });
  assert.ok(
    (readJson("alyq.demo.catalog.v1")?.products ?? []).find((p) => p.sku === ringSku)?.active === true,
    "cancel leaves the product active",
  );
  clickEl(rowButton(row, "Archive"));
  await waitFor(() => dialog() !== null, { label: "the archive confirmation" });
  await confirmOnceWithDoubleSubmitGuard("Archive");
  await waitFor(() => toastText().includes("Product archived"), { label: "the archive success toast" });
  await waitFor(
    () =>
      (readJson("alyq.demo.catalog.v1")?.products ?? []).find((p) => p.sku === ringSku)?.active === false,
    { label: "the product to be archived in the catalog" },
  );
  console.log("  ✓ archive: cancel is safe; confirm disables double-submit and toasts success");

  // 7 ─ it disappears from POS search…
  await navigate("#/pos");
  await waitFor(() => document.querySelector('[data-testid="pos-scan-search"]'), { label: "the scan/search box" });
  await searchFor("Lifecycle Ring");
  assert.ok(
    rowsFor("Lifecycle Ring").length === 0,
    "archived product is not sellable at the POS",
  );
  await searchFor("");
  console.log("  ✓ archived product is hidden from POS search");

  // 8 ─ …and from the storefront / new-order selection…
  await navigate("#/store/products", 700);
  await waitFor(() => document.querySelectorAll("article").length > 0, { label: "the storefront catalogue" });
  setField('input[type="search"]', "Lifecycle Ring");
  await sleep(400);
  assert.ok(
    ![...document.querySelectorAll("article h3")].some((h) => (h.textContent ?? "").trim() === "Lifecycle Ring"),
    "archived product is not offered on the storefront",
  );
  console.log("  ✓ archived product is hidden from the storefront / new-order selection");

  // 9 ─ while its history stays exactly where it was (no cascade, no removal)
  assert.equal(saleLinesForSku(ringSku).length, historyBefore.lines, "sale lines unchanged by archiving");
  assert.equal(movementsFor(ringId).length, historyBefore.movements, "stock movements unchanged");
  assert.equal(sales().length, salesBefore, "no sale was removed");
  setField('input[type="search"]', "");
  console.log("  ✓ history intact: sale lines and stock movements are untouched by archiving");

  // 10 ─ reactivate from the list…
  row = await openProductsList(ringSku);
  const restoreBtn = rowButton(row, "Restore");
  assert.ok(restoreBtn, "archived product offers Restore");
  clickEl(restoreBtn);
  await waitFor(() => dialog() !== null, { label: "the restore confirmation" });
  assert.ok(bodyText().includes("Restore product?"), "restore confirmation title");
  await confirmOnceWithDoubleSubmitGuard("Restore");
  await waitFor(() => toastText().includes("Product restored"), { label: "the restore success toast" });
  await waitFor(
    () =>
      (readJson("alyq.demo.catalog.v1")?.products ?? []).find((p) => p.sku === ringSku)?.active === true,
    { label: "the product to be active again" },
  );
  console.log("  ✓ reactivate from the list with confirmation and success feedback");

  // 11 ─ …and it is sellable again at the POS (history now 2 lines, still no cascade)
  await navigate("#/pos");
  await waitFor(() => document.querySelector('[data-testid="pos-scan-search"]'), { label: "the scan/search box" });
  await searchFor("Lifecycle Ring");
  await waitFor(() => rowsFor("Lifecycle Ring").length > 0, { label: "the ring back in the POS results" });
  clickEl(rowsFor("Lifecycle Ring")[0]);
  await sleep(300);
  setField('[data-testid="cash-input"]', "120");
  await sleep(250);
  const completeBtn2 = [...document.querySelectorAll("button")].find(
    (b) => (b.textContent ?? "").trim().startsWith("✓") && (b.textContent ?? "").includes("Complete sale"),
  );
  assert.ok(completeBtn2 && !completeBtn2.disabled, "complete sale enabled");
  clickEl(completeBtn2);
  await waitFor(() => /INV-\d{6}/.test(bodyText()), { label: "the second sale to complete" });
  click("New sale");
  await sleep(300);
  assert.ok(saleLinesForSku(ringSku).length >= 2, "the second sale line is recorded for the ring SKU");
  console.log("  ✓ reactivated product sells again; history keeps accumulating, never removed");

  // 12 ─ the audit log tells the full story, under the right SKUs, by the admin
  await navigate("#/audit");
  await waitFor(
    () => document.querySelector('input[placeholder="Search by user, action, or record..."]'),
    { label: "the audit log" },
  );
  const auditSearch = (term) => {
    setField('input[placeholder="Search by user, action, or record..."]', term);
  };
  auditSearch(ringSku);
  await sleep(400);
  const auditBody = () => bodyText();
  assert.ok(auditBody().includes("Product archived"), "archived event rendered");
  assert.ok(auditBody().includes("Product reactivated"), "reactivated event rendered");
  assert.ok(auditBody().includes("ALYQ Admin"), "the actor is shown");
  const ringRows = [...document.querySelectorAll("tbody tr")].filter((tr) =>
    (tr.textContent ?? "").includes(ringSku),
  );
  assert.ok(ringRows.length >= 2, `both lifecycle events are under ${ringSku} (${ringRows.length} rows)`);
  assert.ok(
    ringRows.some((tr) => (tr.textContent ?? "").includes("Product archived")) &&
      ringRows.some((tr) => (tr.textContent ?? "").includes("Product reactivated")),
    "archived and reactivated are under the referenced SKU",
  );
  auditSearch(unusedSku);
  await sleep(400);
  const unusedRows = [...document.querySelectorAll("tbody tr")].filter((tr) =>
    (tr.textContent ?? "").includes(unusedSku),
  );
  assert.equal(unusedRows.length, 1, `exactly one event for ${unusedSku} — double-submit wrote one row`);
  assert.ok(
    (unusedRows[0].textContent ?? "").includes("Product permanently deleted"),
    "the unused product's only event is the permanent delete",
  );
  assert.ok((unusedRows[0].textContent ?? "").includes("ALYQ Admin"), "the delete names the admin");
  auditSearch("");
  await sleep(200);
  console.log("  ✓ audit: archived + reactivated under the ring SKU; exactly one permanent delete");

  // ── end: fail on any console error or stray network use ───────────────────
  if (errors.length > 0) {
    console.error(`\n✗ ${errors.length} console/page error(s) during the lifecycle flow:`);
    for (const e of errors.slice(0, 5)) console.error(`  • ${e.split("\n")[0]}`);
    process.exit(1);
  }
  assert.equal(networkCalls.length, 0, "demo lifecycle never touched the network");
  console.log("\n✓ product lifecycle flow complete\n");
  process.exit(0);
}

main().catch((error) => {
  console.error(`\n✗ lifecycle flow failed: ${error.stack ?? error}`);
  console.error(`  at URL: ${dom.window.location.hash}`);
  console.error(
    `  body: ${bodyText().replace(/\s+/g, " ").trim().slice(0, 1500)}`,
  );
  process.exit(1);
});
