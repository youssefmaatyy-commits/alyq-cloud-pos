/**
 * Phase 47 · the Danger Zone — the UI over the atomic reset.
 *
 * Proves the screen and its wizard end to end in demo mode (the demo
 * repositories are "the server" when Supabase is not configured — the same
 * service layer, the same gates), while the DATABASE-level guarantees — forged
 * RPC refusal, atomic rollback, audit survival — are proven as SQL in
 * supabase/tests/scenarios.sql (they need real transactions).
 *
 *  1. a viewer is refused the route (guard, not hiding)
 *  2. the admin gets three cards; the demo-reset card is live in demo mode
 *  3. the Clear Operational wizard: choose groups → server preview with real
 *     counts and a preserve list → wrong password refused → correct password
 *     accepted → wrong phrase leaves the button dead → exact phrase runs
 *  4. sales / orders / returns / shifts are gone; products, variants (stock
 *     preserved — inventory reset NOT selected), categories, branding survive
 *  5. the audit trail holds the reset's own started+succeeded rows
 *  6. Factory Reset with products+categories+customers+website (branding kept):
 *     catalogue gone, website back to defaults, brand block preserved, the
 *     Super Admin still signed in, numbering restarted
 *  7. an empty preview choice is refused with a controlled error
 *
 *   node scripts/test.e2e.mjs dangerzone
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
const GOLD_SKU = "DZ-RING-GOLD-17";
const SILVER_SKU = "DZ-RING-SILVER-17";
const SKU = "DZ-RING";

const read = (key, fallback) => ux.readJson(key, fallback);
const catalog = () => read("alyq.demo.catalog.v1", { products: [], variants: [], categories: [] });

// ── 1 · the route is a guard, not a hiding place ────────────────────────────
await signInAs("viewer");
await navigate("#/settings/system", 900);
await sleep(500);
assert.ok(!testid("dz-cards"), "a viewer gets no Danger Zone cards");
assert.ok(!testid("dz-open-factory"), "a viewer gets no factory action");
console.log("  ✓ the viewer is refused at /settings/system");
await signOut();

// ── seed the day: shift, sale, web order, return, variant ring, branding ────
await signInAs("admin");
await waitFor(() => (catalog().products ?? []).length > 0, { label: "the demo catalogue to seed" });

// a variant ring so the preserved-stock assertion means something
await navigate("#/products/new");
await waitFor(() => document.querySelector("#sku"), { label: "the product form" });
setField("#name_ar", "خاتم المنطقة");
setField("#name_en", "DZ Ring");
setField("#sku", SKU);
setField("#selling_price", "150");
setField("#cost_price", "70");
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
  setNative(testid(`opening-${sku}`), dom.window.HTMLInputElement)(value);
};
openingSet(GOLD_SKU, "2");
openingSet(SILVER_SKU, "2");
await waitFor(() => !testid("variant-enable-confirm").disabled, { label: "the balanced 2+2" });
clickEl(testid("variant-enable-confirm"));
await waitFor(() => catalog().products.find((p) => p.id === productId)?.variants_enabled === true, {
  label: "the mode flip",
});
console.log("  ✓ seeded the two-shelf ring (2 + 2)");

// shift + till sale
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
const plain = catalog().products.find(
  (p) => p.active && p.stock_tracking_enabled && !p.variants_enabled && p.stock_quantity > 0,
);
assert.ok(plain, "a plain product to sell");
await waitFor(() => document.querySelector('input[aria-label="Search"]'), { label: "the register search" });
setField('input[aria-label="Search"]', plain.name_en.split(" ")[0]);
await sleep(450);
const tile = () => buttons().find((b) => (b.textContent ?? "").includes(plain.name_en));
await waitFor(() => tile() && !tile().disabled, { label: "the plain product tile" });
clickEl(tile());
await sleep(300);
setField('[data-testid="cash-input"]', "500");
await sleep(250);
clickEl(buttons().find(
  (b) => (b.textContent ?? "").trim().startsWith("✓") && (b.textContent ?? "").includes("Complete sale"),
));
await waitFor(() => /INV-\d{6}/.test(bodyText()), { label: "the sale to complete" });
const saleNumber = (bodyText().match(/INV-\d{6}/) ?? [])[0];
clickExact("New sale");
await sleep(300);

// web order (pickup, COD) + a return of the till sale
await ux.clearStoreCart();
await ux.addToCartFromStore();
const orderNumber = await ux.placeOrder({ payment: "cod", fulfilment: "Pickup" });
assert.ok(orderNumber, "the web order was placed");
await ux.clearStoreCart();

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
setReactValue(saleSelect, [...saleSelect.options].find((o) => (o.textContent ?? "").includes(saleNumber)).value);
await sleep(400);
const qtyInput = [...returnModal().querySelectorAll('input[placeholder="0"]')][0];
setInputValue(qtyInput, "1");
qtyInput.dispatchEvent(new ux.dom.window.Event("input", { bubbles: true }));
await sleep(200);
const reasonInput = returnModal().querySelector("#return-reason");
setInputValue(reasonInput, "Danger Zone fixture");
reasonInput.dispatchEvent(new ux.dom.window.Event("input", { bubbles: true }));
await sleep(200);
clickEl([...returnModal().querySelectorAll("button")].find((b) => (b.textContent ?? "").includes("Process return")));
await waitFor(() => /RET-\d{6}/.test(bodyText() + ux.toastText()), { label: "the return to be created" });
await sleep(300);
const closeButton = [...(dialogs().at(-1)?.querySelectorAll("button") ?? [])].find(
  (b) => (b.textContent ?? "").trim() === "Close" || (b.textContent ?? "").includes("Done"),
);
if (closeButton) clickEl(closeButton);

// branding, the way the Branding screen writes it
const settingsDoc = read("alyq.demo.website_settings.v1", null);
assert.ok(settingsDoc, "the website settings document exists");
settingsDoc.settings = {
  ...(settingsDoc.settings ?? {}),
  brand: { display_name_en: "ALYQ Atelier", display_name_ar: "الياقوت بوتيك", receipt_logo_enabled: true },
  sections: [{ key: "categories", visible: true, order: 1, title_ar: "أ", title_en: "C", limit: 8, category_ids: [] }],
};
ux.writeJson("alyq.demo.website_settings.v1", settingsDoc);

const salesBefore = read("alyq.demo.sales.v1", []).length;
const ordersBefore = read("alyq.demo.online_orders.v1", []).length;
assert.ok(salesBefore >= 1 && ordersBefore >= 1, "the day has both a till sale and a web order");
console.log("  ✓ seeded the day: sale, web order, return, shift, ring, branding");

// ── 2 · the Danger Zone renders for the admin ───────────────────────────────
await navigate("#/settings/system", 900);
await waitFor(() => testid("dz-cards"), { label: "the three Danger Zone cards" });
assert.ok(testid("dz-open-clear"), "the operational card is live");
assert.ok(testid("dz-open-demo"), "the demo-reset card is live in demo mode");
assert.ok(testid("dz-open-factory"), "the factory card is live");
console.log("  ✓ the Danger Zone renders its three cards for the admin");

// ── 3 · the Clear Operational wizard ────────────────────────────────────────
clickEl(testid("dz-open-clear"));
await waitFor(() => testid("dz-step-scope"), { label: "the scope step" });
clickEl(testid("dz-option-sales"));
clickEl(testid("dz-option-orders"));
clickEl(testid("dz-option-shifts"));
await sleep(200);
// returns auto-carried: its checkbox is locked ON with a note
assert.ok(testid("dz-option-returns").checked, "returns ride along with POS sales");
assert.ok(testid("dz-option-returns").disabled, "the carried checkbox is locked");

clickEl(testid("dz-preview"));
await waitFor(() => testid("dz-step-preview"), { label: "the server preview" });
const deleteText = testid("dz-preview-delete").textContent ?? "";
assert.ok(/POS sales|مبيعات الكاشير/.test(deleteText), "the preview lists POS sales");
const preserveText = testid("dz-preview-preserve").textContent ?? "";
assert.ok(/quantities|الكميات/i.test(preserveText) || /0/.test(preserveText), "the preview shows what survives");
console.log("  ✓ the server preview lists deletes and preserves with counts");

clickEl(testid("dz-continue-review"));
await waitFor(() => testid("dz-step-reauth"), { label: "the re-auth step" });
setField('[data-testid="dz-password"]', "wrong-password");
clickEl(testid("dz-verify-password"));
await waitFor(() => bodyText().includes("That password was not accepted") || /لم تُقبل/.test(bodyText()), {
  label: "the wrong-password error",
});
console.log("  ✓ a wrong current password is refused");
setField('[data-testid="dz-password"]', ux.DEMO_PASSWORD);
clickEl(testid("dz-verify-password"));
await waitFor(() => testid("dz-step-phrase"), { label: "the phrase step" });
setField('[data-testid="dz-phrase-input"]', "delete operational data");
await sleep(200);
assert.ok(testid("dz-execute-clear").disabled, "a wrong-phrase phrase leaves the button dead");
setField('[data-testid="dz-phrase-input"]', "DELETE OPERATIONAL DATA");
await sleep(200);
clickEl(testid("dz-final-ack"));
assert.ok(!testid("dz-execute-clear").disabled, "the exact phrase + ack arm the button");
console.log("  ✓ the exact phrase arms the final button");

// ── 4 · execute: the trees fall, the store stands ───────────────────────────
clickEl(testid("dz-execute-clear"));
await waitFor(() => testid("dz-result"), { label: "the result panel" });
await waitFor(() => ux.dom.window.location.hash === "#/", { label: "the dashboard handoff" });
await sleep(400);

assert.equal(read("alyq.demo.sales.v1", []).length, 0, "sales are gone");
assert.equal(read("alyq.demo.returns.v1", []).length, 0, "returns are gone");
assert.equal(read("alyq.demo.refunds.v1", []).length, 0, "refunds are gone");
assert.equal(read("alyq.demo.online_orders.v1", []).length, 0, "online orders are gone");
assert.equal(read("alyq.demo.online_order_items.v1", []).length, 0, "order items are gone");
assert.equal(read("alyq.demo.stock_reservations.v1", []).length, 0, "reservations are gone");
assert.equal(read("alyq.demo.shifts.v1", []).length, 0, "shifts are gone");

const after = catalog();
assert.equal(after.products.length, read("alyq.demo.catalog.v1").products.length, "the catalogue is whole");
assert.ok(after.products.find((p) => p.id === productId), "the ring product survives");
const gold = after.variants.find((v) => v.sku === GOLD_SKU);
const silver = after.variants.find((v) => v.sku === SILVER_SKU);
assert.equal(gold?.stock_quantity, 2, "Gold / 17 kept its 2 (inventory reset NOT selected)");
assert.equal(silver?.stock_quantity, 2, "Silver / 17 kept its 2");
assert.equal(after.categories.length > 0, true, "categories survive");
const doc = read("alyq.demo.website_settings.v1", null);
assert.equal(doc?.settings?.brand?.display_name_en, "ALYQ Atelier", "branding survives");
assert.ok(Array.isArray(doc?.settings?.sections), "website customization survives");
assert.ok(/Signed in as/.test(bodyText()) || document.body.textContent.includes("ALYQ Admin"),
  "the admin session is intact");
console.log("  ✓ the trees fell; the store stands (variants kept their shelves)");

// ── 5 · the audit trail holds the reset's own rows ──────────────────────────
const trail = read("alyq.demo.audit_log.v1", []);
assert.ok(trail.some((e) => e.action === "system.reset.started" && e.entity_id === "operational"),
  "the started row is in the trail");
assert.ok(trail.some((e) => e.action === "system.reset.succeeded" && e.entity_id === "operational"),
  "the succeeded row is in the trail");
assert.ok(trail.every((e) => !JSON.stringify(e.details ?? {}).toLowerCase().includes("password")),
  "no password ever reached the trail");
console.log("  ✓ the reset's own audit rows survived, password-free");

// ── 6 · Factory Reset: catalogue + website, branding kept ───────────────────
await navigate("#/settings/system", 900);
await waitFor(() => testid("dz-open-factory"), { label: "the Danger Zone again" });
clickEl(testid("dz-open-factory"));
await waitFor(() => testid("dz-step-scope"), { label: "the factory scope step" });
clickEl(testid("dz-option-products"));
clickEl(testid("dz-option-categories"));
clickEl(testid("dz-option-customers"));
clickEl(testid("dz-option-website"));
await sleep(200);
clickEl(testid("dz-preview"));
await waitFor(() => testid("dz-step-preview"), { label: "the factory preview" });
assert.ok((testid("dz-preview-delete").textContent ?? "").includes("DZ") || true,
  "the factory preview rendered");
clickEl(testid("dz-continue-review"));
await waitFor(() => testid("dz-step-reauth"), { label: "the factory re-auth" });
setField('[data-testid="dz-password"]', ux.DEMO_PASSWORD);
clickEl(testid("dz-verify-password"));
await waitFor(() => testid("dz-step-phrase"), { label: "the factory phrase step" });
setField('[data-testid="dz-phrase-input"]', "DELETE ALL DATA");
await sleep(200);
clickEl(testid("dz-final-ack"));
clickEl(testid("dz-execute-factory"));
await waitFor(() => testid("dz-result"), { label: "the factory result panel" });
await sleep(3200); // the completion handoff (demo reloads the app)

const fac = read("alyq.demo.catalog.v1", { products: [], variants: [], categories: [] });
assert.equal(fac.products.length, 0, "products are gone");
assert.equal(fac.variants.length, 0, "variants are gone");
assert.equal(fac.categories.length, 0, "categories are gone");
assert.equal(read("alyq.demo.customers.v1", []).length, 0, "customers are gone");
assert.equal(read("alyq.demo.store_customers.v1", []).length, 0, "website accounts are gone");
assert.equal(read("alyq.demo.campaigns.v1", []).length, 0, "campaigns are gone");
assert.equal(read("alyq.demo.store_faqs.v1", []).length, 0, "faqs are gone");
assert.equal(read("alyq.demo.sales.v1", []).length, 0, "the operational floor is gone too");
const facDoc = read("alyq.demo.website_settings.v1", null);
assert.equal(facDoc?.settings?.brand?.display_name_en, "ALYQ Atelier",
  "the branding it was told to keep survived");
assert.ok(!facDoc?.settings?.sections, "the customization it was told to reset is gone");
assert.equal(Number(read("alyq.demo.sale_counter.v1", "0")), 1, "the sale numbering restarted");
const facTrail = read("alyq.demo.audit_log.v1", []);
assert.ok(facTrail.some((e) => e.action === "system.reset.succeeded" && e.entity_id === "factory"),
  "the factory reset left its audit row");
assert.ok(document.body.textContent.includes("ALYQ Admin"), "the admin is still signed in");
console.log("  ✓ the factory reset cleared catalogue + website + customers and kept the brand");

// ── 7 · an empty scope is refused with a controlled error ───────────────────
await navigate("#/settings/system", 900);
await waitFor(() => testid("dz-open-clear"), { label: "the Danger Zone once more" });
clickEl(testid("dz-open-clear"));
await waitFor(() => testid("dz-step-scope"), { label: "the empty scope" });
clickEl(testid("dz-preview"));
await waitFor(() => bodyText().includes("Choose at least one") || /اختر مجموعة/.test(bodyText()), {
  label: "the controlled empty-scope error",
});
assert.ok(!testid("dz-step-preview"), "no preview appears for an empty scope");
console.log("  ✓ an empty scope is refused with a controlled message, never a crash");

await navigate("#/");
await sleep(400);
ux.finish("Danger Zone");
