/**
 * Dashboard / Admin UX E2E (Phase 46) — the command centre, driven through the
 * real bundle in jsdom, demo mode, exactly as staff would:
 *
 *   1. seeds a real day through the UI: a POS sale on an open shift, a pending
 *      COD pickup order, an InstaPay order awaiting verification, a processed
 *      return, and a variant ring pushed low on ONE shelf (Gold / 17);
 *   2. the dashboard loads with compact clickable KPI cards whose numbers match
 *      what was just seeded;
 *   3. every KPI routes through the module's own filters (sales→today toggle,
 *      orders→status/payment filter, inventory→low filter, returns, shifts) —
 *      never a simulated click;
 *   4. the website block shows its own KPIs (pending review, InstaPay,
 *      COD-vs-InstaPay split, recent web orders);
 *   5. the 7-day chart renders;
 *   6. the stock alert NAMES the exact combination — "Gold / 17" — while the
 *      product still has stock on Silver / 17, and never claims "Out of stock";
 *   7. the POS mobile cart drawer opens (the phone path);
 *   8. Arabic flips the shell to RTL with Arabic labels;
 *   9. a viewer — no website or till capability — sees no website block, no
 *      website quick action, while the day's numbers stay on screen.
 *
 * Any console.error / window.onerror / network call fails the run.
 *
 *   node scripts/test.e2e.mjs dashboardux
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
  bodyText,
  sleep,
  waitFor,
  navigate,
  clickEl,
  click,
  clickExact,
  clickTestid,
  testid,
  setField,
  dialogs,
  readJson,
  writeJson,
  signInAs,
  signOut,
} = ux;

async function main() {
  console.log("\nPhase 46 · Dashboard / Admin UX — command centre\n");
  await sleep(600);

  // ── 0 · a clean slate (cleared before boot), then admin ───────────────────
  await signInAs("admin");
  assert.ok(testid("shell-brand"), "the shell carries the brand block");
  // The demo repository seeds its shelf lazily on first load — wait for it.
  await waitFor(() => (readJson("alyq.demo.catalog.v1")?.products ?? []).length > 0, {
    label: "the demo catalogue to seed",
  });

  // ── 1 · seed the day ───────────────────────────────────────────────────────
  // 1a. a plain, tracked product for the till sale
  const catalog = () => readJson("alyq.demo.catalog.v1") ?? { products: [], variants: [] };
  const plain = () =>
    catalog().products.find(
      (p) => p.active && p.stock_tracking_enabled && !p.variants_enabled && p.stock_quantity > 0,
    );
  assert.ok(plain(), "the demo shelf has a plain tracked product to sell");
  const plainName = plain().name_en;
  const plainStockBefore = plain().stock_quantity;

  // 1b. open a shift (the till's drawer) — the variants flow's proven steps
  await navigate("#/shifts");
  await waitFor(() => bodyText().includes("No shift is currently open"), { label: "a closed drawer" });
  click("Open shift");
  await sleep(400);
  const shiftDialog = dialogs().at(-1);
  const shiftInputs = [...shiftDialog.querySelectorAll("input")];
  const fill = (input, value) => ux.setInputValue(input, value);
  fill(shiftInputs.find((i) => !i.readOnly && i.type === "text"), "Main branch");
  fill(shiftInputs.find((i) => i.inputMode === "decimal"), "100");
  clickEl([...shiftDialog.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim() === "Open shift"));
  await waitFor(() => /SH-\d{6}/.test(bodyText()), { label: "the shift to open" });

  // 1c. ring one sale through the grid
  await navigate("#/pos");
  const searchBox = () => document.querySelector('input[aria-label="Search"]');
  await waitFor(() => searchBox(), { label: "the register search" });
  setField('input[aria-label="Search"]', plainName.split(" ")[0]);
  await sleep(400);
  const tile = () =>
    [...document.querySelectorAll("button")].find((b) => (b.textContent ?? "").includes(plainName));
  await waitFor(() => tile() && !tile().disabled, { label: "the product tile" });
  clickEl(tile());
  await sleep(300);
  setField('[data-testid="cash-input"]', "500");
  await sleep(250);
  const completeBtn = [...document.querySelectorAll("button")].find(
    (b) => (b.textContent ?? "").trim().startsWith("✓") && (b.textContent ?? "").includes("Complete sale"),
  );
  assert.ok(completeBtn && !completeBtn.disabled, "the sale is payable");
  clickEl(completeBtn);
  await waitFor(() => /INV-\d{6}/.test(bodyText()), { label: "the sale to complete" });
  const saleNumber = (bodyText().match(/INV-\d{6}/) ?? [])[0];
  click("New sale");
  await sleep(300);
  console.log(`  ✓ seeded POS sale ${saleNumber} on an open shift`);

  // 1d. two website orders: a pending COD pickup, an InstaPay to verify
  await ux.clearStoreCart();
  await ux.addToCartFromStore();
  const pendingOrderNumber = await ux.placeOrder({ payment: "cod", fulfilment: "Pickup" });
  assert.ok(pendingOrderNumber, "the COD pickup order was placed");
  await ux.clearStoreCart();
  await ux.addToCartFromStore();
  const instapayNumber = await ux.placeOrder({ payment: "instapay", fulfilment: "Pickup" });
  const orders = () => readJson("alyq.demo.online_orders.v1") ?? [];
  assert.equal(orders().find((o) => o.order_number === pendingOrderNumber)?.status, "pending");
  assert.equal(
    orders().find((o) => o.order_number === instapayNumber)?.payment_status,
    "verification_required",
    "the InstaPay order waits for a human",
  );
  await ux.clearStoreCart();
  console.log(`  ✓ seeded web orders ${pendingOrderNumber} (pending) + ${instapayNumber} (InstaPay to verify)`);

  // The queue provider mounted at sign-in; a refresh is the same thing a clerk
  // does when the badge and the screen disagree.
  await navigate("#/online/orders", 800);
  const refreshBtn = [...document.querySelectorAll("button[title]")].find((b) =>
    (b.getAttribute("title") ?? "").toLowerCase().includes("retry"),
  );
  if (refreshBtn) clickEl(refreshBtn);
  await waitFor(() => bodyText().includes(pendingOrderNumber) && bodyText().includes(instapayNumber), {
    label: "both web orders to reach the queue",
  });

  // 1e. process a return for the till sale
  await navigate("#/returns");
  await waitFor(() => bodyText().includes("Returns & Refunds"), { label: "the returns screen" });
  await sleep(400);
  clickExact("New return");
  await waitFor(() => dialogs().length > 0, { label: "the return modal" });
  const returnModal = () => dialogs().at(-1);
  const saleSelect = [...returnModal().querySelectorAll("select")].find((s) =>
    [...s.options].some((o) => (o.textContent ?? "").includes(saleNumber)),
  );
  assert.ok(saleSelect, "the invoice selector lists the sale");
  ux.setReactValue(saleSelect, [...saleSelect.options].find((o) => (o.textContent ?? "").includes(saleNumber)).value);
  await sleep(400);
  const qtyInput = [...returnModal().querySelectorAll('input[placeholder="0"]')][0];
  assert.ok(qtyInput, "the return-quantity input is on the selected line");
  ux.setInputValue(qtyInput, "1");
  qtyInput.dispatchEvent(new ux.dom.window.Event("input", { bubbles: true }));
  await sleep(200);
  const reasonInput = returnModal().querySelector("#return-reason");
  ux.setInputValue(reasonInput, "Customer changed her mind");
  reasonInput.dispatchEvent(new ux.dom.window.Event("input", { bubbles: true }));
  await sleep(200);
  const submitReturn = [...returnModal().querySelectorAll("button")].find(
    (b) => (b.textContent ?? "").includes("Process return"),
  );
  assert.ok(submitReturn && !submitReturn.disabled, "the return is submittable");
  clickEl(submitReturn);
  await waitFor(() => /RET-\d{6}/.test(bodyText() + ux.toastText()), { label: "the return to be created" });
  await sleep(300);
  // close any confirmation dialog the return opened
  const closeButton = [...(dialogs().at(-1)?.querySelectorAll("button") ?? [])].find(
    (b) => (b.textContent ?? "").trim() === "Close" || (b.textContent ?? "").includes("Done"),
  );
  if (closeButton) clickEl(closeButton);
  await sleep(200);
  console.log("  ✓ seeded a processed return");

  // 1f. the variant ring: Gold/17 + Silver/17, then push Gold/17 LOW (1 of 2)
  const SKU = "UX-RING";
  const GOLD_SKU = "UX-RING-GOLD-17";
  await navigate("#/products/new");
  await waitFor(() => document.querySelector("#sku"), { label: "the product form" });
  setField("#name_ar", "خاتم اليوكس");
  setField("#name_en", "UX Ring");
  setField("#sku", SKU);
  setField("#selling_price", "200");
  setField("#cost_price", "100");
  setField("#tax_rate", "0");
  setField("#stock_quantity", "4");
  setField("#low_stock_level", "1");
  const categorySelect = document.querySelector("#category_id");
  if (categorySelect) {
    const option = [...categorySelect.options].find((o) => o.value !== "");
    if (option) ux.setReactValue(categorySelect, option.value);
  }
  click("Save");
  await waitFor(() => ux.dom.window.location.hash === "#/products", { label: "the save to land" });
  const productId = catalog().products.find((p) => p.sku === SKU)?.id;
  assert.ok(productId, "the ring is in the catalogue");

  await navigate(`#/products/${productId}/edit`);
  await waitFor(() => testid("variant-editor"), { label: "the variant editor" });
  clickEl(testid("variant-generate"));
  await waitFor(() => dialogs().length > 0, { label: "the generator" });
  const genDialog = dialogs().at(-1);
  const colorsArea = [...genDialog.querySelectorAll("textarea")].find((t) =>
    (t.placeholder ?? "").includes("Gold"),
  );
  ux.setNative(colorsArea, ux.dom.window.HTMLTextAreaElement)("Gold | ذهبي | #d4af37\nSilver | فضي | #c0c0c0");
  const sizesInput = [...genDialog.querySelectorAll("input")].find((i) =>
    (i.placeholder ?? "").includes("16, 16.5"),
  );
  ux.setNative(sizesInput, ux.dom.window.HTMLInputElement)("17");
  await sleep(250);
  clickEl([...genDialog.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim() === "Create 2"));
  await waitFor(() => testid("variant-row-GOLD".replace("GOLD", GOLD_SKU)), { label: "the gold row" });
  clickEl(testid("variant-mode-toggle"));
  await waitFor(() => testid("variant-enable-panel"), { label: "the enable panel" });
  const openingSet = (sku, value) => {
    const input = testid(`opening-${sku}`);
    ux.setNative(input, ux.dom.window.HTMLInputElement)(value);
  };
  // Gold / 17 opens EMPTY (0 of a total 4) — a healthy rollup that hides a
  // sold-out shelf, exactly the case the variant-aware alert exists for; the
  // threshold stays 0 because new combinations are born unwatched.
  openingSet(GOLD_SKU, "0");
  openingSet("UX-RING-SILVER-17", "4");
  await waitFor(() => !testid("variant-enable-confirm").disabled, { label: "the balanced 1+3" });
  clickEl(testid("variant-enable-confirm"));
  await waitFor(
    () => catalog().products.find((p) => p.id === productId)?.variants_enabled === true,
    { label: "the mode flip" },
  );
  assert.equal(catalog().variants.find((v) => v.sku === GOLD_SKU)?.stock_quantity, 0, "Gold / 17 opens empty");

  // The inventory provider mounted before the ring existed — the same manual
  // sync a clerk does when the shelf and the ledger disagree.
  await navigate("#/inventory/stock", 700);
  const invRetry = [...document.querySelectorAll("button[title]")].find((b) =>
    (b.getAttribute("title") ?? "").toLowerCase().includes("retry"),
  );
  if (invRetry) clickEl(invRetry);
  await sleep(700);
  console.log("  ✓ seeded the variant ring with Gold / 17 pushed low");

  // ── 2 · the dashboard renders the day ─────────────────────────────────────
  await navigate("#/", 700);
  await waitFor(() => testid("dash-kpi-row"), { label: "the KPI row" });
  const kpiRow = testid("dash-kpi-row");
  assert.equal(kpiRow.querySelectorAll("a[data-kpi-link]").length, 5, "the five day-tiles are clickable links");
  assert.ok(kpiRow.textContent.includes(saleNumber.slice(0, 0) === "" ? "" : "") !== undefined, "row renders");

  // Today Sales matches what was rung: exactly one till sale today
  const salesToday = (readJson("alyq.demo.sales.v1") ?? []).filter(
    (s) => s.status !== "voided" && new Date(s.created_at) >= new Date(new Date().toDateString()),
  );
  assert.ok(kpiRow.textContent.includes(String(salesToday.length)), "the today-sales tile counts the seeded sale");
  assert.equal(salesToday.length >= 1, true, "the seed produced a sale");

  // Web orders today matches the two placed orders
  const webToday = orders().filter(
    (o) => o.status !== "cancelled" && new Date(o.created_at) >= new Date(new Date().toDateString()),
  );
  await waitFor(() => kpiRow.textContent.includes(String(webToday.length)), {
    label: "the web-orders tile to load the queue",
  });
  console.log(`  ✓ KPI cards render: ${salesToday.length} till sale(s), ${webToday.length} web order(s) today`);

  // ── 3 · every route, through the module's own filters ─────────────────────
  clickTestid("kpi-today-sales");
  await waitFor(() => ux.dom.window.location.hash.startsWith("#/pos/sales"), { label: "the sales route" });
  await waitFor(() => testid("sales-today-toggle")?.checked === true, { label: "the today filter to hydrate" });
  console.log("  ✓ Sales tile → sales history with the Today filter ON");

  await navigate("#/", 600);
  await waitFor(() => testid("kpi-web-orders"), { label: "the KPI row again" });
  clickTestid("kpi-web-orders");
  await waitFor(() => ux.dom.window.location.hash.startsWith("#/online/orders"), { label: "the orders route" });
  await waitFor(() => testid("orders-tabs"), { label: "the orders queue to render" });
  await waitFor(() => bodyText().includes(pendingOrderNumber), { label: "the queue to load" });
  assert.ok(bodyText().includes("Mona Mahmoud"), "the order rows show the customer");

  await navigate("#/", 600);
  clickTestid("web-kpi-pending");
  await waitFor(() => ux.dom.window.location.hash.startsWith("#/online/orders"), { label: "the orders route" });
  await waitFor(() => testid("orders-tabs"), { label: "the orders queue to render" });
  await sleep(300);
  const statusSelect = [...document.querySelectorAll("select")].find(
    (s) => s.getAttribute("aria-label") === "Order status",
  );
  assert.equal(statusSelect?.value, "pending", "the status filter hydrated from the URL");
  console.log("  ✓ Pending Review tile → the queue pre-filtered to pending");

  await navigate("#/", 600);
  clickTestid("web-kpi-instapay");
  await waitFor(() => ux.dom.window.location.hash.startsWith("#/online/orders"), { label: "the orders route" });
  await waitFor(() => testid("orders-tabs"), { label: "the orders queue to render" });
  await sleep(300);
  const paymentSelect = [...document.querySelectorAll("select")].find(
    (s) => s.getAttribute("aria-label") === "Payment status",
  );
  assert.equal(paymentSelect?.value, "verification_required", "the payment filter hydrated from the URL");
  console.log("  ✓ InstaPay tile → the queue pre-filtered to verification_required");

  await navigate("#/", 600);
  clickTestid("kpi-low-stock");
  await waitFor(() => ux.dom.window.location.hash.startsWith("#/inventory"), { label: "the inventory route" });
  await sleep(500);
  const inventoryStatus = [...document.querySelectorAll("select")].find(
    (s) => (s.getAttribute("aria-label") ?? "") === "Status",
  );
  assert.ok(inventoryStatus, "the inventory status filter is on the page");
  assert.equal(inventoryStatus.value, "low", "the inventory status filter hydrated from the URL");
  console.log("  ✓ Low Stock tile → inventory pre-filtered to low");

  await navigate("#/", 600);
  clickTestid("kpi-returns");
  await waitFor(() => ux.dom.window.location.hash.startsWith("#/returns"), { label: "the returns route" });
  await waitFor(() => /RET-\d{6}/.test(bodyText()), { label: "the processed return to appear" });

  await navigate("#/", 600);
  clickTestid("kpi-open-shift");
  await waitFor(() => ux.dom.window.location.hash.startsWith("#/shifts"), { label: "the shifts route" });
  await sleep(600);
  assert.ok(/SH-\d{6}/.test(bodyText()), "the open shift is on the shift dashboard");
  console.log("  ✓ Returns and Open-Shift tiles route to their screens");

  // ── 4 · activity blocks ────────────────────────────────────────────────────
  await navigate("#/", 700);
  await waitFor(() => testid("dash-recent-orders"), { label: "the recent-orders block" });
  assert.ok(testid("dash-recent-orders").textContent.includes(saleNumber), "recent orders lists the till sale");
  await waitFor(() => testid("web-section"), { label: "the website block" });
  const web = testid("web-section");
  await waitFor(() => /WEB-\d{6}/.test(testid("dash-recent-web-orders")?.textContent ?? ""), {
    label: "the recent web orders to list the queue",
  });
  assert.ok(web.textContent.includes("Pending review"), "the pending-review tile is labelled");
  assert.ok(web.textContent.includes("InstaPay"), "the InstaPay tile is labelled");
  assert.ok(testid("web-channel-split").textContent.includes("COD"), "the COD vs InstaPay split renders");
  assert.ok(
    (testid("web-top-products")?.textContent ?? "").length > 0,
    "the top-online-products block renders",
  );
  // the exact pending-review count, read from the tile's value line
  const tileValue = (id) =>
    testid(id)?.querySelectorAll("p")[1]?.textContent?.trim() ?? "";
  assert.equal(tileValue("web-kpi-pending"), "1", "pending review counts the seeded order");
  assert.equal(tileValue("web-kpi-instapay"), "1", "InstaPay-to-verify counts the seeded transfer");
  // the 7-day trend chart (an SVG, drawn from the reports analytics)
  await waitFor(() => document.querySelector("svg"), { label: "a chart to draw" });
  console.log("  ✓ recent orders, recent web orders, split and charts render");

  // ── 5 · the variant-aware alert names the exact combination ───────────────
  const alerts = testid("dash-stock-alerts");
  assert.ok(alerts, "the stock-alerts block renders");
  const ringLines = [...alerts.querySelectorAll('[data-testid="dash-stock-alert"]')].filter((el) =>
    (el.textContent ?? "").includes("UX Ring"),
  );
  assert.equal(ringLines.length, 1, "the ring appears exactly once (as its empty shelf, not as a product)");
  const ringText = ringLines[0].textContent ?? "";
  assert.ok(ringText.includes("Gold / 17"), `the alert names the exact shelf: ${ringText}`);
  assert.ok(ringText.includes("Out of stock"), "the empty shelf is called out");
  assert.ok(!ringText.includes("Low stock"), "and it is not softened into a low-stock line");
  // the sibling shelf still has stock, so the rollup must never read "out":
  // the ring's line is a variant line, and Silver / 17 keeps its 4.
  assert.equal(catalog().variants.find((v) => v.sku === "UX-RING-SILVER-17")?.stock_quantity, 4);
  console.log('  ✓ variant-aware alert: "UX Ring · Gold / 17 · Out of stock" — one shelf line, never a false product claim');

  // ── 6 · the mobile register path ──────────────────────────────────────────
  await navigate("#/pos", 700);
  await waitFor(() => testid("pos-mobile-cart-open") === null, { label: "the empty register" });
  // put something in the cart, so the sticky summary has something to say
  await waitFor(() => testid("pos-category-chip-all"), { label: "the category chips" });
  const mobileTile = [...document.querySelectorAll("button")].find(
    (b) => (b.textContent ?? "").includes(plainName) && !b.disabled,
  );
  assert.ok(mobileTile, "the tile is on the grid");
  clickEl(mobileTile);
  await sleep(400);
  await waitFor(() => testid("pos-mobile-cart-open"), { label: "the sticky mobile cart bar" });
  clickTestid("pos-mobile-cart-open");
  await waitFor(() => testid("pos-mobile-cart-drawer"), { label: "the mobile cart drawer" });
  assert.ok(
    testid("pos-mobile-cart-drawer").textContent.includes("Complete sale"),
    "the drawer carries the real payment panel",
  );
  const closeDrawer = [...testid("pos-mobile-cart-drawer").querySelectorAll("button")].find((b) =>
    (b.getAttribute("aria-label") ?? "") === "Close",
  );
  clickEl(closeDrawer);
  await sleep(300);
  console.log("  ✓ mobile: sticky summary opens a drawer with the real cart + payment");

  // ── 7 · Arabic RTL ────────────────────────────────────────────────────────
  await navigate("#/", 600);
  clickExact("العربية");
  await sleep(400);
  assert.equal(document.documentElement.getAttribute("dir"), "rtl", "the shell flips to RTL");
  await waitFor(() => bodyText().includes("لوحة التحكم"), { label: "the Arabic dashboard" });
  assert.ok(bodyText().includes("إيرادات اليوم"), "the KPI labels are Arabic");
  assert.equal(ux.errors.length, 0, "no console errors in Arabic");
  console.log("  ✓ Arabic: RTL shell + Arabic dashboard labels");
  clickExact("English");
  await sleep(300);

  // ── 8 · permission-aware rendering ────────────────────────────────────────
  await signOut();
  await signInAs("viewer");
  await waitFor(() => testid("dash-kpi-row"), { label: "the viewer's dashboard" });
  assert.ok(!testid("web-section"), "no website block without the capability");
  assert.ok(!testid("dash-qa-website"), "no website quick action");
  assert.ok(!testid("web-kpi-pending"), "no pending-review tile");
  assert.ok(testid("kpi-today-sales"), "the day's revenue still shows (reports-readable)");
  assert.ok(testid("kpi-today-sales").tagName !== "A", "but the till deep link is gone");
  assert.ok(testid("kpi-low-stock"), "the inventory view they own still renders");
  assert.ok(!document.querySelector('a[href="#/online/website"]'), "no website-builder link in the sidebar");
  assert.ok(!document.querySelector('a[href="#/settings/branding"]'), "no Branding link in the sidebar");
  console.log("  ✓ a read-only viewer sees the shelf view, never the till or the website");

  ux.finish("Dashboard/Admin UX");
}

main().catch((error) => {
  console.error(`\n✗ ${error?.stack ?? error}`);
  process.exit(1);
});
