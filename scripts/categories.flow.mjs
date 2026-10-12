/**
 * Category Lifecycle E2E (Phase 44) — the acceptance example, driven through
 * the real bundle in jsdom, demo mode, exactly as an admin would:
 *
 *   1. "Temporary Empty" hard-deletes with a plain confirm;
 *   2. deleting "Rings Old" (3 products) opens the lifecycle dialog instead —
 *      "This category contains 3 products" — and nothing is deleted;
 *   3. archiving "Rings Old" succeeds: its 3 products stay active, and the
 *      category leaves the product-form picker, the POS filter and the Active
 *      tab (it is findable under Archived);
 *   4. reactivating returns it everywhere;
 *   5. the move-and-delete: all 3 products land in "Rings New", "Rings Old"
 *      is gone, stock untouched;
 *   6. the archived "Hidden Rings" is never offered as a move destination,
 *      and a product shelved there keeps selling while the shelf is hidden;
 *   7. the forged assignment (createProduct straight against the store) is
 *      refused server-side — the demo store refuses it exactly as migration
 *      0044's trigger does in live mode.
 *
 * The database half of the same rules (locked rows, structured refusals, the
 * audit vocabulary, RLS) is locked by `npm run db:check`
 * (supabase/tests/scenarios.sql, Phase 44 block); the store-level refusals by
 * the categoryLifecycle selftest.
 *
 *   node scripts/test.e2e.mjs categories
 */
import { JSDOM } from "jsdom";
import assert from "node:assert/strict";
import { bundleFileUrl } from "./lib/app-bundle.mjs";

const dom = new JSDOM('<!doctype html><html lang="en"><body><div id="root"></div></body></html>', {
  url: "http://localhost/#/login",
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
/** JSX spans concatenate without literal spaces — squeeze before matching. */
const squeezed = () => (document.body.textContent ?? "").replace(/\s+/g, "");

async function waitFor(condition, { label, timeout = 15_000, interval = 150 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (condition()) return;
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${label}. Body: ${squeezed().slice(400, 1400)}`);
    }
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

/** The provider flips `loading` (and unmounts the tree) after every mutation —
 * never sample row state mid-refresh. */
const settled = () => !squeezed().includes("Loading");
/** The newest toast only — the live region keeps old ones around. */
const lastToast = () => {
  const nodes = [...document.querySelectorAll('[aria-live="polite"]')];
  return (nodes.at(-1)?.textContent ?? "").replace(/\s+/g, " ");
};

const readJson = (key) => {
  const raw = globalThis.localStorage.getItem(key);
  if (raw === null) return null;
  return JSON.parse(raw);
};
const catalogState = () => readJson("alyq.demo.catalog.v1");

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
  if (!usernameField()) {
    await navigate("#/login");
  }
  await waitFor(() => Boolean(usernameField()), { label: "the login screen" });
  setField("input[autocomplete='username']", username);
  setField("input[autocomplete='current-password']", password);
  click("Sign in");
  await waitFor(() => isSignedIn(), { label: `${username} to sign in` });
  await sleep(400);
};

/** A category's row in the tree: the <li> whose heading names it. */
const treeRow = (nameEn) =>
  [...document.querySelectorAll("li")].find((li) => {
    const heading = li.querySelector("p");
    return heading && (heading.textContent ?? "").replace(/\s+/g, "").includes(nameEn.replace(/\s+/g, ""));
  });

/** Click a row action by its accessible label (Delete / Deactivate / Activate). */
const rowAction = (nameEn, label) => {
  const li = treeRow(nameEn);
  if (!li) {
    const headings = [...document.querySelectorAll("li p")]
      .map((p) => (p.textContent ?? "").replace(/\s+/g, ""))
      .filter(Boolean)
      .slice(0, 24)
      .join(" · ");
    throw new Error(
      `category row not found: ${nameEn}. Rows: ${headings}. Body: ${(document.body.textContent ?? "")
        .replace(/\s+/g, "")
        .slice(430, 1200)}`,
    );
  }
  const btn = [...li.querySelectorAll("button")].find(
    (b) => (b.getAttribute("aria-label") ?? b.title ?? "").trim() === label,
  );
  if (!btn) throw new Error(`action ${label} not found on ${nameEn}`);
  clickEl(btn);
  return btn;
};

async function createCategory(nameAr, nameEn) {
  await navigate("#/categories", 500);
  const add = [...document.querySelectorAll("button")].find((b) =>
    (b.textContent ?? "").includes("Add category"),
  );
  assert.ok(add, "the Add category control exists");
  clickEl(add);
  await waitFor(() => Boolean(document.querySelector("#cat-name-en")), {
    label: "the add-category form",
  });
  setField("#cat-name-ar", nameAr);
  setField("#cat-name-en", nameEn);
  clickExact("Save");
  // The modal closes on success; if it is still open after a grace period,
  // surface why (validation, duplicate, …).
  for (let i = 0; i < 20 && document.querySelector("#cat-name-en"); i += 1) await sleep(200);
  if (document.querySelector("#cat-name-en")) {
    throw new Error(`the category form did not close for ${nameEn}: ${squeezed().slice(0, 600)}`);
  }
  await waitFor(() => squeezed().includes(nameEn.replace(/\s+/g, "")), {
    label: `${nameEn} in the tree`,
  });
}

const selectOptions = (select) => [...select.options].map((o) => o.textContent ?? "").join("|");

// ── the flow ────────────────────────────────────────────────────────────────

async function main() {
  console.log("\nCategory Lifecycle · safe delete, move, archive\n");
  await sleep(500);

  // 0 ─ admin
  await signInAs("admin");
  assert.ok(isSignedIn(), "admin signed in");

  // 1 ─ the four shelves
  await createCategory("فارغة مؤقتة", "Temporary Empty");
  await createCategory("خوواتم قديمة", "Rings Old");
  await createCategory("خوواتم جديدة", "Rings New");
  await createCategory("خوواتم مخفية", "Hidden Rings");

  // 2 ─ three products on Rings Old, one on Hidden Rings
  const makeProduct = async (sku, name, stock, categoryLabel) => {
    await navigate("#/products/new");
    await waitFor(() => document.querySelector("#sku"), { label: "the product form" });
    setField("#name_ar", name);
    setField("#name_en", name);
    setField("#sku", sku);
    setField("#selling_price", "120");
    setField("#cost_price", "50");
    setField("#tax_rate", "0");
    setField("#stock_quantity", String(stock));
    // The picker is fed by the catalog provider, which re-reads the shelves when
    // the form mounts; on a fast machine the list is still the placeholder for a
    // moment. Wait for the shelf to be offered rather than racing the render —
    // and re-query, because React replaces the select node when options arrive.
    await waitFor(
      () =>
        [...(document.querySelector("#category_id")?.options ?? [])].some((o) =>
          (o.textContent ?? "").includes(categoryLabel),
        ),
      { label: `${categoryLabel} to be offered in the product form` },
    );
    const catSelect = document.querySelector("#category_id");
    const option = [...catSelect.options].find((o) => (o.textContent ?? "").includes(categoryLabel));
    assert.ok(
      option,
      `${categoryLabel} is offered in the product form (options: ${[...catSelect.options]
        .map((o) => (o.textContent ?? "").trim())
        .join(" / ")})`,
    );
    setField("#category_id", option.value);
    clickExact("Save");
    await waitFor(() => !dom.window.location.hash.includes("/new") && dom.window.location.hash.includes("/products"), {
      label: "the save to route back",
    });
    await waitFor(() => squeezed().includes(sku), { label: `${sku} to appear` });
  };
  await makeProduct("CAT-A", "Old Ring A", 4, "Rings Old");
  await makeProduct("CAT-B", "Old Ring B", 6, "Rings Old");
  await makeProduct("CAT-C", "Old Ring C", 8, "Rings Old");
  await makeProduct("CAT-H", "Hidden Piece", 5, "Hidden Rings");
  console.log("  ✓ the four shelves and their products exist");

  // 3 ─ the empty category deletes with a plain confirm
  await navigate("#/categories", 500);
  rowAction("Temporary Empty", "Delete");
  await waitFor(() => squeezed().includes("Deletecategory?"), {
    label: "the plain delete confirm",
  });
  const confirmDialog = [...document.querySelectorAll("button")].find(
    (b) => (b.textContent ?? "").trim() === "Delete" && b.closest('[role="dialog"], .fixed'),
  );
  assert.ok(confirmDialog, "the confirm dialog offers Delete");
  clickEl(confirmDialog);
  await waitFor(() => !treeRow("Temporary Empty") && settled(), {
    label: "Temporary Empty to disappear (and the tree to settle)",
  });
  console.log("  ✓ the empty category hard-deletes");

  // 4 ─ deleting Rings Old opens the lifecycle dialog and deletes NOTHING
  rowAction("Rings Old", "Delete");
  await waitFor(() => squeezed().includes("Thiscategorycontains3products"), {
    label: "the lifecycle dialog naming the 3 products",
  });
  assert.ok(squeezed().includes("Movetheproducts"), "the move option is offered");
  assert.ok(squeezed().includes("Archiveonly"), "the archive option is offered");
  // closing without choosing leaves everything in place
  click("Cancel");
  await waitFor(() => !treeRow("Rings Old") || Boolean(treeRow("Rings Old")), { label: "the modal to close" });
  assert.ok(treeRow("Rings Old"), "Rings Old survives a cancelled lifecycle dialog");
  assert.equal(
    (catalogState().products ?? []).filter((p) => p.category_id?.endsWith("") && p.name_en?.startsWith("Old Ring")).length,
    3,
    "the three rings are untouched",
  );
  console.log("  ✓ the 3-product delete is blocked with the structured count");

  // 5 ─ archive Rings Old from the same dialog
  rowAction("Rings Old", "Delete");
  await waitFor(() => squeezed().includes("Thiscategorycontains3products"), {
    label: "the lifecycle dialog again",
  });
  const archiveRadio = [...document.querySelectorAll('input[name="category-lifecycle"]')][1];
  assert.ok(archiveRadio, "the archive radio exists");
  clickEl(archiveRadio);
  await waitFor(
    () => [...document.querySelectorAll("button")].some((b) => (b.textContent ?? "").includes("Archive category")),
    { label: "the archive confirm button" },
  );
  click("Archive category");
  // The toast fires only after the provider's post-mutation refresh — so a
  // seen toast implies settled data; the Loading check is belt and braces.
  await waitFor(() => lastToast().includes("Category deactivated"), {
    label: "the archive toast",
  });
  await waitFor(settled, { label: "the tree to settle after the archive" });
  await sleep(300);
  // the Active tab hides it; the Archived tab names it (re-queried every time:
  // refresh rebuilds the strip and stale element references click nothing)
  const tabByLabel = (needle) =>
    [...document.querySelectorAll('[role="tab"]')].find((b) =>
      (b.textContent ?? "").replace(/\s+/g, "").includes(needle),
    );
  const activeTab = tabByLabel("Active");
  const archivedTab = tabByLabel("Archived");
  assert.ok(activeTab && archivedTab, "the Active/Archived tabs exist");
  clickEl(activeTab);
  await sleep(400);
  assert.ok(!treeRow("Rings Old"), "the archived category leaves the Active tab");
  {
    const archivedTab2 = tabByLabel("Archived");
    assert.ok(archivedTab2, "the Archived tab is still there");
    clickEl(archivedTab2);
  }
  await sleep(500);
  assert.ok(treeRow("Rings Old"), "the archived category is found under Archived");
  console.log("  ✓ archive succeeds; the shelf leaves the working tree but stays findable");

  // 6 ─ its products are untouched and still sellable; the pickers hide it
  const state = catalogState();
  const oldProducts = (state.products ?? []).filter((p) =>
    ["Old Ring A", "Old Ring B", "Old Ring C"].includes(p.name_en),
  );
  assert.equal(oldProducts.length, 3, "all three rings remain");
  assert.ok(oldProducts.every((p) => p.active), "the rings were NOT auto-archived");
  assert.deepEqual(
    oldProducts.map((p) => p.stock_quantity).sort((a, b) => a - b),
    [4, 6, 8],
    "stock untouched by the archive",
  );

  await navigate("#/products/new");
  await waitFor(() => document.querySelector("#category_id"), { label: "the product form" });
  assert.ok(
    ![...document.querySelector("#category_id").options].some((o) =>
      (o.textContent ?? "").includes("Rings Old"),
    ),
    "the archived category is out of the product-form picker",
  );
  assert.ok(
    [...document.querySelector("#category_id").options].some((o) =>
      (o.textContent ?? "").includes("Rings New"),
    ),
    "active categories stay in the picker",
  );

  // The register is scan/search-first: no category chips, no browsable grid.
  // Archiving a shelf must not strand its products — they stay searchable.
  const posRows = () => [...document.querySelectorAll("[data-pos-result-index]")];
  await navigate("#/pos", 600);
  await waitFor(() => document.querySelector('[data-testid="pos-scan-search"]'), { label: "the scan/search box" });
  assert.equal(
    document.querySelectorAll('[data-testid^="pos-category-chip-"]').length,
    0,
    "the register offers no category chips",
  );
  setField('[data-testid="pos-scan-search"]', "CAT-A");
  await waitFor(
    () => posRows().some((r) => (r.textContent ?? "").includes("Old Ring A")),
    { label: "the archived shelf's product in results" },
  );
  assert.equal(
    document.querySelectorAll('[data-testid^="pos-category-chip-"]').length,
    0,
    "archiving a shelf adds no filter to the register",
  );
  console.log("  ✓ products still sellable; archived shelves leave the picker, not the search");

  // 6.5 ─ archive Hidden Rings NOW: the move scene must meet it archived, the
  //       way the task states it — an archived shelf is no destination.
  await navigate("#/categories", 500);
  rowAction("Hidden Rings", "Deactivate");
  await waitFor(() => squeezed().includes("willbehiddenfromnewproducts"), {
    label: "the deactivate confirm",
  });
  click("Deactivate");
  await waitFor(() => lastToast().includes("Category deactivated"), { label: "the archive toast" });
  await waitFor(settled, { label: "the tree to settle" });
  await sleep(300);
  console.log("  ✓ Hidden Rings archived ahead of the move");

  // 7 ─ reactivate: everything returns
  await navigate("#/categories", 500);
  {
    const archivedTab2 = tabByLabel("Archived");
    assert.ok(archivedTab2, "the Archived tab is there for the reactivation");
    clickEl(archivedTab2);
  }
  await sleep(500);
  rowAction("Rings Old", "Activate");
  await waitFor(() => squeezed().includes("willbecomeselectablefornewproductsagain"), {
    label: "the activate confirm",
  });
  click("Activate");
  await waitFor(() => lastToast().includes("Category activated"), { label: "the restore toast" });
  await waitFor(settled, { label: "the tree to settle after the restore" });
  await sleep(300);
  {
    const activeTab2 = tabByLabel("Active");
    assert.ok(activeTab2, "the Active tab is still there");
    clickEl(activeTab2);
  }
  await sleep(500);
  assert.ok(treeRow("Rings Old"), "the reactivated category is back under Active");
  await navigate("#/products/new");
  await waitFor(() => document.querySelector("#category_id"), { label: "the product form" });
  assert.ok(
    [...document.querySelector("#category_id").options].some((o) =>
      (o.textContent ?? "").includes("Rings Old"),
    ),
    "the reactivated category is selectable again",
  );
  console.log("  ✓ reactivation restores the shelf");

  // 8 ─ the move: 3 products to Rings New, Rings Old deleted, one operation
  await navigate("#/categories", 500);
  rowAction("Rings Old", "Delete");
  await waitFor(() => squeezed().includes("Thiscategorycontains3products"), {
    label: "the lifecycle dialog for the move",
  });
  // the destination select: the lifecycle modal's only select — active
  // categories only, never the source, never the archived Hidden Rings
  const targetSelect = [...document.querySelectorAll("select")].at(-1);
  assert.ok(targetSelect, "the move-target select exists");
  const targetOptions = selectOptions(targetSelect);
  assert.ok(targetOptions.includes("Rings New"), "Rings New is a destination");
  assert.ok(!targetOptions.includes("Hidden Rings"), "the ARCHIVED shelf is not a destination");
  assert.ok(!targetOptions.includes("Rings Old"), "the source is not its own destination");
  const newOption = [...targetSelect.options].find((o) => (o.textContent ?? "").includes("Rings New"));
  assert.ok(newOption, "Rings New is selectable");
  setNative(targetSelect, dom.window.HTMLSelectElement)(newOption.value);
  await waitFor(
    () => [...document.querySelectorAll("button")].some((b) => (b.textContent ?? "").includes("Move & delete")),
    { label: "the move confirm to enable" },
  );
  click("Move & delete");
  await waitFor(() => squeezed().includes("Moved3product"), { label: "the moved-3 toast" });
  await waitFor(settled, { label: "the tree to settle after the move" });
  await sleep(300);
  assert.ok(!treeRow("Rings Old"), "Rings Old is gone");
  const ringsNewRow = treeRow("Rings New");
  assert.ok(ringsNewRow, "Rings New remains");
  const afterMove = catalogState();
  const moved = (afterMove.products ?? []).filter((p) =>
    ["Old Ring A", "Old Ring B", "Old Ring C"].includes(p.name_en),
  );
  assert.equal(moved.length, 3, "all three rings survive the move");
  assert.ok(moved.every((p) => p.category_id === newOption.value), "every ring now names Rings New");
  assert.deepEqual(
    moved.map((p) => p.stock_quantity).sort((a, b) => a - b),
    [4, 6, 8],
    "stock byte-identical through the move",
  );
  assert.ok((afterMove.categories ?? []).some((c) => c.name_en === "Rings New"), "the target exists");
  assert.ok(!(afterMove.categories ?? []).some((c) => c.name_en === "Rings Old"), "the source is deleted");
  console.log("  ✓ the move: 3 products land on Rings New, the source is deleted, stock intact");

  // 9 ─ the archived shelf and its product (Hidden Rings was archived in 6.5)
  const hidden = (catalogState().categories ?? []).find((c) => c.name_en === "Hidden Rings");
  assert.ok(hidden && hidden.active === false, "Hidden Rings is archived");
  // the shelf is hidden, but its product keeps selling
  const hiddenState = catalogState();
  const hiddenPiece = (hiddenState.products ?? []).find((p) => p.name_en === "Hidden Piece");
  assert.ok(hiddenPiece?.active, "the Hidden Piece was NOT auto-archived");
  await navigate("#/pos", 600);
  await waitFor(() => document.querySelector('[data-testid="pos-scan-search"]'), { label: "the scan/search box" });
  setField('[data-testid="pos-scan-search"]', "CAT-H");
  await waitFor(
    () =>
      [...document.querySelectorAll("[data-pos-result-index]")].some((r) =>
        (r.textContent ?? "").includes("Hidden Piece"),
      ),
    { label: "the register to offer the hidden shelf's product" },
  );
  console.log("  ✓ the archived shelf hides; its product keeps selling");

  // the store-level refusal (what a forged request meets in demo mode, and
  // what the 0044 trigger meets in live mode) is proven by the unit suite;
  // here we prove the UI never offers the door: the picker hides Hidden Rings
  await navigate("#/products/new");
  await waitFor(() => document.querySelector("#category_id"), { label: "the product form" });
  assert.ok(
    ![...document.querySelector("#category_id").options].some((o) =>
      (o.textContent ?? "").includes("Hidden Rings"),
    ),
    "the archived Hidden Rings is not offered to new products",
  );

  assert.equal(networkCalls.length, 0, `no network in demo mode: ${networkCalls[0] ?? ""}`);
  assert.deepEqual(errors, [], "no console errors across the lifecycle");
  console.log("\nCategory Lifecycle passed — 9/9 scenes\n");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(`\n✗ ${error?.stack ?? error}`);
    process.exit(1);
  });
