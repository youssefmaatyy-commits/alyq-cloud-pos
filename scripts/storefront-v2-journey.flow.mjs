#!/usr/bin/env node
/** Phase 3 real app-bundle journey in jsdom, rerun on canonical Phase 4A
 * routes: one V2 shell from an exact shelf through COD/InstaPay and private
 * tracking, browser-local account, address, wishlist and exact reorder.
 * Logic/CSS geometry are additionally covered by selftests and Chromium. */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { transform } from "esbuild";
import { createUxHarness } from "./lib/ux-harness.mjs";

const source = await readFile(fileURLToPath(new URL("../src/modules/products/data/demoSeed.ts", import.meta.url)), "utf8");
const code = await transform(source, { loader: "ts", format: "esm" });
const { buildDemoProducts, buildDemoCategories } = await import(`data:text/javascript;base64,${Buffer.from(code.code).toString("base64")}`);
const products = buildDemoProducts();
const ring = products.find((item) => item.sku === "ALYQ-1002");
ring.variants_enabled = true; ring.stock_quantity = 4; ring.low_stock_level = 1;
const UUID = { gold17: "4fb4125a-0f26-461e-8a94-31e365342101", gold18: "4fb4125a-0f26-461e-8a94-31e365342102",
  silverXS: "4fb4125a-0f26-461e-8a94-31e365342103" };
const variant = (id, color, size, sizeLabel, stock) => ({ id, product_id: ring.id,
  sku: `V2-P3-${color}-${sizeLabel || size}`, barcode: null, color_key: color,
  color_ar: color === "gold" ? "ذهبي" : "فضي", color_en: color === "gold" ? "Gold" : "Silver",
  color_hex: color === "gold" ? "#cba556" : "#ccc", size, size_label: sizeLabel,
  image_url: null, price_override: null, cost_override: null, stock_quantity: stock, low_stock_level: 1,
  active: true, sort_order: 1, created_at: ring.created_at, updated_at: ring.updated_at });
const variants = [variant(UUID.gold17, "gold", 17, null, 3), variant(UUID.gold18, "gold", 18, null, 0),
  variant(UUID.silverXS, "silver", null, "XS", 1)];
// Issue #3 (follow-up): the shipped demo only ever seeds 4 zones, so nothing
// exercised the checkout zone list's scroll pane with the 8-12+ governorates
// a real shop can configure — including this test, which used to assert
// `.length === 4` unconditionally. Pre-seeding the storage key before the app
// boots (rather than mutating it mid-test) is what the demo repository's own
// "seed only if missing" rule expects, and it lets the very same journey
// below select "Cairo" and read its real fee exactly as it always has.
const zoneAt = ring.created_at;
const zone = (key, nameEn, nameAr, fee, sort) => ({
  id: `dz-${key}`, key, name_en: nameEn, name_ar: nameAr, governorate_key: key,
  shipping_fee: fee, minimum_order_amount: 0, free_shipping_threshold: null,
  estimated_delivery_text_en: "1–2 business days", estimated_delivery_text_ar: "١–٢ يوم عمل",
  show_estimated_delivery: true, enabled: true, sort_order: sort, created_at: zoneAt, updated_at: zoneAt,
});
const zones = [
  zone("ismailia", "Ismailia", "الإسماعيلية", 0, 10),
  zone("cairo", "Cairo", "القاهرة", 70, 20),
  zone("suez", "Suez", "السويس", 50, 30),
  zone("alexandria", "Alexandria", "الإسكندرية", 60, 40),
  zone("giza", "Giza", "الجيزة", 65, 50),
  zone("luxor", "Luxor", "الأقصر", 90, 60),
  zone("aswan", "Aswan", "أسوان", 95, 70),
  zone("sohag", "Sohag", "سوهاج", 85, 80),
  zone("minya", "Minya", "المنيا", 80, 90),
  zone("beni-suef", "Beni Suef", "بني سويف", 75, 95),
  zone("fayoum", "Fayoum", "الفيوم", 78, 98),
  zone("other", "Other governorates", "باقي المحافظات", 80, 100),
];
const ux = await createUxHarness({ beforeImport: ({ localStorage }) => {
  localStorage.setItem("alyq.lang", "en");
  localStorage.setItem("alyq.demo.catalog.v1", JSON.stringify({ seed_revision: 3, categories: buildDemoCategories(),
    products, variants }));
  localStorage.setItem("alyq.demo.delivery_zones.v1", JSON.stringify(zones));
} });
const { dom, document, assert, waitFor, navigate, clickEl, setField, readJson, sleep, finish } = {
  ...ux, document: ux.dom.window.document,
};
const cart = () => readJson("alyq.store.cart.v2")?.lines ?? [];
const orders = () => readJson("alyq.demo.online_orders.v1") ?? [];
const testid = (name) => document.querySelector(`[data-testid="${name}"]`);
const button = (scope, name) => [...scope.querySelectorAll("button")].find((node) =>
  (node.textContent ?? "").trim().startsWith(name));
const check = (label, value) => { assert.ok(value, label); console.log(`  ✓ ${label}`); };
const selectOption = (scope, query) => {
  const element = scope.querySelector(query); assert.ok(element, `option ${query}`);
  clickEl(element);
};
const selectPickup = async () => {
  const choice = button(testid("v2-checkout").querySelector(".v2-choice-grid"), "Pickup");
  assert.ok(choice, "pickup choice exists"); clickEl(choice); await sleep(90);
};

await navigate("#/store/cart", 800);
await waitFor(() => Boolean(testid("v2-cart")), { label: "the V2 cart" });
check("an empty canonical V2 bag offers a real browse link", Boolean(document.querySelector('.v2-journey-empty a[href="#/store/products"]')));
await navigate("#/store/products?color=gold&size=18&availability=out_of_stock", 400);
await waitFor(() => Boolean(testid(`v2-card-${ring.id}`)), { label: "out-of-stock exact gold 18 filter" });
check("the catalogue filters a published sold-out variant but does not offer quick add", testid(`v2-quick-add-${ring.id}`).disabled);
await navigate("#/store/products?color=silver&size_label=XS", 400);
await waitFor(() => Boolean(testid(`v2-card-${ring.id}`)), { label: "published XS label filter" });
check("letter-size and colour are URL-backed and yield the exact shelf", testid(`v2-quick-add-${ring.id}`)?.disabled === false);

await navigate(`#/store/products/${ring.id}`, 350);
selectOption(document, '[data-testid="v2-color-gold"]');
await sleep(30);
selectOption(document, '[data-testid="v2-size-17"]');
await sleep(30);
selectOption(document, '[data-testid="v2-pdp-add"]');
await waitFor(() => cart().some((line) => line.variant_id === UUID.gold17), { label: "exact Gold 17 cart line" });
await navigate("#/store/cart", 350);
check("bag displays the exact variant UUID, SKU, quantity and advisory breakdown",
  testid("v2-cart-line")?.getAttribute("data-variant-id") === UUID.gold17 &&
  testid("v2-cart-variant")?.textContent.includes("17") && Boolean(testid("v2-cart-totals")));
selectOption(document, '[aria-label="Increase quantity"]');
await waitFor(() => cart().find((line) => line.variant_id === UUID.gold17)?.quantity === 2, { label: "exact line increased" });
selectOption(document, '[aria-label="Decrease quantity"]');
await waitFor(() => cart().find((line) => line.variant_id === UUID.gold17)?.quantity === 1, { label: "exact line decreased" });

await navigate("#/store/checkout", 350);
check("checkout uses the same V2 shell and no legacy store layout", Boolean(testid("v2-checkout")) && !testid("store-layout"));
await selectPickup();
selectOption(document, '[data-testid="v2-place-order"]');
await waitFor(() => Boolean(document.querySelector('.v2-field-error')), { label: "missing contact validation" });
check("empty name and phone cannot place an order", orders().length === 0);
setField('.v2-checkout-form input[autocomplete="name"]', "Mona Mahmoud");
setField('.v2-checkout-form input[autocomplete="tel"]', "01012345678");
await sleep(70);
// A synchronous second click is ignored before React's disabled state can update.
selectOption(document, '[data-testid="v2-place-order"]');
selectOption(document, '[data-testid="v2-place-order"]');
await waitFor(() => Boolean(testid("v2-order-number")) && Boolean(testid("v2-order-details")),
  { label: "settled COD receipt and authoritative itemized details" });
const cod = orders()[0];
check("COD/pickup placed exactly once through the existing order repository",
  orders().length === 1 && cod?.payment_method === "cod" && cod?.delivery_type === "pickup" &&
  cod.items.some((item) => item.variant_id === UUID.gold17));
check("confirmation displays server order number and never claims payment verification",
  testid("v2-order-number")?.textContent === cod.order_number &&
  !testid("v2-payment-proof") && !document.body.textContent.includes("Payment confirmed"));
check("short-lived session receipt contains only a reference+phone pair",
  JSON.parse(dom.window.sessionStorage.getItem("alyq.v2.confirmation.session")).order === cod.order_number &&
  !dom.window.sessionStorage.getItem("alyq.v2.confirmation.session").includes("items"));

await navigate("#/store/track", 300);
const trackForm = () => document.querySelector(".v2-track-form");
setField('input[autocomplete="off"]', cod.order_number, trackForm());
setField('input[autocomplete="tel"]', "01999999999", trackForm());
clickEl(testid("v2-track-submit"));
await waitFor(() => Boolean(testid("v2-track-error")), { label: "private tracking refusal" });
check("order number by itself and a wrong phone reveal no order", !testid("v2-tracked-order") && !testid("v2-order-details"));
setField('input[autocomplete="tel"]', cod.customer_phone, trackForm());
clickEl(testid("v2-track-submit"));
await waitFor(() => Boolean(testid("v2-tracked-order")), { label: "private tracking success" });
check("reference + correct phone show real order status and timeline", testid("v2-tracked-order")?.textContent.includes(cod.order_number) &&
  Boolean(testid("v2-order-variant")) && Boolean(document.querySelector('.v2-order-timeline')));
check("tracking URL exposes reference but not phone", dom.window.location.hash.includes(cod.order_number) &&
  !dom.window.location.hash.includes(cod.customer_phone));

await navigate("#/store/account", 300);
selectOption(document, '.v2-account-tabs button[aria-pressed="false"]');
await waitFor(() => Boolean(document.querySelector('.v2-account-form input[autocomplete="name"]')),
  { label: "registration form" });
setField('.v2-account-form input[autocomplete="name"]', "Mona Mahmoud");
setField('.v2-account-form input[autocomplete="tel"]', cod.customer_phone);
setField('.v2-account-form input[autocomplete="email"]', "mona@example.test");
setField('.v2-account-form input[autocomplete="new-password"]', "sample-pass-123");
clickEl(button(document.querySelector('.v2-account-auth'), "Create account"));
await waitFor(() => Boolean(document.querySelector('.v2-account-nav')), { label: "browser-local account" });
check("local shopper account offers profile, saved addresses, wishlist and private history",
  document.querySelectorAll('.v2-account-nav button').length === 4 &&
  document.body.textContent.includes("stay in this browser"));
const tab = async (name) => { clickEl(button(document.querySelector('.v2-account-nav'), name)); await sleep(110); };
await tab("Addresses");
clickEl(button(testid("v2-account"), "Add address"));
await sleep(90);
const addressForm = document.querySelector('.v2-account-content .v2-account-form');
for (const [label, value] of [["Label", "Home"], ["City", "Cairo"], ["Area", "Maadi"], ["Street", "19 Street"]]) {
  const field = [...addressForm.querySelectorAll("label")].find((node) => node.textContent.trim().startsWith(label));
  assert.ok(field, `${label} field`); setField("input", value, field);
}
clickEl(button(addressForm, "Save"));
await waitFor(() => Boolean(document.querySelector('.v2-address-card strong')), { label: "saved address" });
check("an address saves in the shared account provider", document.querySelector('.v2-address-card')?.textContent.includes("Maadi"));
await navigate(`#/store/products/${ring.id}`, 300);
clickEl(document.querySelector('.v2-pdp-wishlist'));
await sleep(170);
await navigate("#/store/account?tab=wishlist", 300);
check("wishlist shows the V2 card for an exact published product", Boolean(testid(`v2-card-${ring.id}`)));
// Tracking a guest order while signed in remembers its reference in this browser.
await navigate("#/store/track", 300);
setField('input[autocomplete="off"]', cod.order_number, trackForm());
setField('input[autocomplete="tel"]', cod.customer_phone, trackForm());
clickEl(testid("v2-track-submit"));
await waitFor(() => Boolean(testid("v2-tracked-order")), { label: "claim guest history via private lookup" });
await navigate("#/store/account?tab=orders", 350);
await waitFor(() => Boolean(testid("v2-history-order")) &&
  document.querySelector('.v2-account-content button.v2-text-link')?.disabled === false,
{ label: "settled private order history" });
check("guest order is remembered only after a correct private lookup", testid("v2-history-order")?.textContent.includes(cod.order_number));
clickEl(button(testid("v2-history-order"), "Order again"));
await waitFor(() => Boolean(testid("v2-cart")), { label: "exact-variant reorder bag" });
check("reorder adds Gold 17 UUID, not the same-size silver or sold-out Gold 18",
  cart().length === 1 && cart()[0].variant_id === UUID.gold17);

await navigate("#/store/checkout", 400);
await selectPickup();
clickEl(button(testid("v2-checkout"), "InstaPay"));
await sleep(60);
check("configured InstaPay option explains employee verification before order placement",
  document.body.textContent.includes("employee confirms the payment"));
clickEl(testid("v2-place-order"));
await waitFor(() => orders().length === 2 && Boolean(testid("v2-order-number")) &&
  Boolean(testid("v2-order-details")), { label: "settled InstaPay receipt" });
const insta = orders().at(-1);
check("InstaPay shares the authoritative order path, never marks payment paid",
  insta?.payment_method === "instapay" && insta?.payment_status === "verification_required" &&
  Boolean(testid("v2-payment-proof")));
const proof = testid("v2-payment-proof");
setField('input[autocomplete="off"]', "P3-TRANSFER-421", proof);
const upload = proof.querySelector('input[type="file"]');
const file = new dom.window.File(["proof-image"], "transfer.png", { type: "image/png" });
Object.defineProperty(upload, "files", { value: [file], configurable: true });
upload.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
await waitFor(() => proof.textContent.includes("transfer.png"), { label: "proof image selected" });
clickEl(button(proof, "Send the proof"));
await waitFor(() => Boolean(orders().at(-1)?.payment_submitted_at), { label: "proof submission through existing repository" });
check("uploading proof leaves payment awaiting human verification",
  orders().at(-1).payment_status === "verification_required" &&
  orders().at(-1).payment_reference === "P3-TRANSFER-421" && Boolean(orders().at(-1).payment_proof_url));
await navigate("#/store/account?tab=orders", 400);
await waitFor(() => document.querySelectorAll('[data-testid="v2-history-order"]').length === 2 &&
  document.querySelector('.v2-account-content button.v2-text-link')?.disabled === false,
{ label: "settled account order history after signed-in placement" });
check("signed-in order reference is saved in existing local account and read privately",
  document.body.textContent.includes(insta.order_number));

// A third path exercises real delivery-zone pricing + the existing promotion
// precheck and proves the final order snapshots differ from a browser estimate.
await navigate("#/store/products/prd-2001", 320);
clickEl(testid("v2-pdp-add"));
await waitFor(() => cart().some((line) => line.product_id === "prd-2001"), { label: "plain catalogue line" });
await navigate("#/store/cart", 320);
const coupon = testid("v2-coupon");
setField('input[autocomplete="off"]', "WELCOME10", coupon);
clickEl(button(coupon, "Apply"));
await waitFor(() => coupon.textContent.includes("WELCOME10") && coupon.textContent.includes("Coupon applied"),
  { label: "advisory coupon eligibility" });
check("coupon precheck stays explicitly advisory on V2", coupon.textContent.includes("previews"));
await navigate("#/store/checkout", 350);
clickEl(button(testid("v2-checkout").querySelector(".v2-choice-grid"), "Delivery"));
await sleep(90);
clickEl(button(testid("v2-checkout"), "Cash on delivery"));
await sleep(50);
// Issue #1 (8th follow-up round): the zone picker is now a closed-by-default
// dropdown, not an always-visible card list — opening/reading/selecting a
// zone goes through the trigger button and its popup listbox instead of a
// radio-per-row fieldset.
const zoneTrigger = testid("v2-zone-select-trigger");
assert.ok(zoneTrigger, "zone dropdown trigger exists");
check("zone dropdown starts closed and shows the placeholder, not an always-visible list",
  zoneTrigger.getAttribute("aria-expanded") === "false" && !testid("v2-zone-select-popup"));
clickEl(zoneTrigger);
await sleep(30);
const zonePopup = testid("v2-zone-select-popup");
assert.ok(zonePopup, "zone dropdown popup opens on click");
check("opening the dropdown flips aria-expanded and renders a listbox popup", zoneTrigger.getAttribute("aria-expanded") === "true" &&
  zonePopup.getAttribute("role") === "listbox");
const cairo = [...zonePopup.querySelectorAll('[role="option"]')].find((row) => row.textContent.includes("Cairo"));
assert.ok(cairo, "published delivery zone exists in the dropdown popup");
// The final user change is the zone, after payment/fulfilment have settled.
// Checkout must read that live zone instead of a stale callback closure.
clickEl(cairo);
await sleep(30);
const cairoZone = readJson("alyq.demo.delivery_zones.v1").find((zone) => zone.key === "cairo");
check("selecting a zone option closes the dropdown popup",
  zoneTrigger.getAttribute("aria-expanded") === "false" && !testid("v2-zone-select-popup"));
await waitFor(() => {
  const totals = testid("v2-cart-totals");
  const zoneRow = [...(totals?.querySelectorAll(".v2-totals > div") ?? [])]
    .find((row) => row.querySelector("dt")?.textContent.trim() === "Cairo");
  return totals && !totals.querySelector('[role="status"]') &&
    zoneRow?.querySelector("dd")?.textContent.includes(cairoZone.shipping_fee.toFixed(2)) &&
    totals.textContent.includes("WELCOME10");
}, { label: "settled Cairo shipping and WELCOME10 advisory estimate" });
const estimatedTotal = Number(testid("v2-cart-totals").querySelector(".v2-totals-grand dd")
  .textContent.replace(/[^0-9.]/g, ""));
check("delivery form uses saved browser-local address and selected configured zone reflected in the closed trigger",
  document.querySelector('.v2-checkout-form input[autocomplete="address-level2"]')?.value === "Cairo" &&
  testid("v2-zone-select-value").textContent.includes("Cairo"));
// Re-open to confirm the previously-selected row is marked (checkmark contract)
// and every configured zone still renders as an option — none truncated or
// virtualized away, however many a shop configures (12 here, well past the
// 8-12+ the manual report asked to be exercised).
clickEl(zoneTrigger);
await sleep(30);
const reopenedPopup = testid("v2-zone-select-popup");
const options = [...reopenedPopup.querySelectorAll('[role="option"]')];
check(`all ${zones.length} zone rows render as options inside the popup`, options.length === zones.length);
const selectedOption = options.find((row) => row.textContent.includes("Cairo"));
check("the previously-selected zone option is marked selected (checkmark contract)",
  selectedOption?.getAttribute("aria-selected") === "true" && selectedOption?.getAttribute("data-selected") === "true" &&
  options.filter((row) => row.getAttribute("aria-selected") === "true").length === 1);
clickEl(zoneTrigger);
await sleep(30);
check("dropdown toggles closed when the trigger is clicked again", !testid("v2-zone-select-popup"));

// Issue #1 (8th follow-up round): the popup is a bounded, independently
// scrollable pane — position:absolute so opening it never changes page
// height/flow — so a shop with many governorates never pushes "Place order"
// far down the page. jsdom does not run real CSS layout (no pixel heights),
// so this proves the DOM/CSS contract the visual test
// (scripts/rendered-v2-zone-scroll.flow.mjs) exercises with real pixels.
const css = await readFile(
  fileURLToPath(new URL("../src/modules/online/v2/storefront-v2.css", import.meta.url)), "utf8");
const zoneSelectRule = /\.store-v2 \.v2-zone-select \{([^}]*)\}/.exec(css)?.[1] ?? "";
check("the dropdown wrapper is a positioning context, not a page-flow-expanding box",
  /position:\s*relative\b/.test(zoneSelectRule));
const zonePopupRule = /\.store-v2 \.v2-zone-select-popup \{([^}]*)\}/.exec(css)?.[1] ?? "";
check("the popup floats over the page (absolute) and bounds/scrolls itself, never scrolling the page",
  /position:\s*absolute\b/.test(zonePopupRule) &&
  /max-height:\s*min\(\s*46vh\s*,\s*340px\s*\)/.test(zonePopupRule) &&
  /overflow-y:\s*auto\b/.test(zonePopupRule) &&
  !/overflow-y:\s*scroll\b/.test(zonePopupRule) &&
  /overscroll-behavior:\s*contain\b/.test(zonePopupRule));
// Same defensive properties the old scroll pane relied on: `min-height: 0`
// (classic flex/grid item refusing to shrink below its own unconstrained
// content size, which can defeat `max-height`), `touch-action: pan-y`
// (vertical touch scrolling as an explicit contract), `overflow-x: hidden`
// (no horizontal scrollbar however long a name/ETA string gets).
check("the popup cannot be starved by grid/flex auto-sizing, scrolls by touch, and never grows sideways",
  /min-height:\s*0\b/.test(zonePopupRule) &&
  /touch-action:\s*pan-y\b/.test(zonePopupRule) &&
  /overflow-x:\s*hidden\b/.test(zonePopupRule));

// Issue B (2nd follow-up, carried forward): a 12-zone shop is MATHEMATICALLY
// GUARANTEED to overflow the popup at any viewport, while a 3-zone shop is
// guaranteed to fit — i.e. the pane's max-height really is doing its job,
// not merely present as an unused declaration. jsdom cannot report a real
// `scrollHeight`/`clientHeight` (see scripts/rendered-v2-zone-scroll.flow.mjs
// for the pixel-accurate proof in real Chromium).
const zoneOptionRule = /\.store-v2 \.v2-zone-option \{([^}]*)\}/.exec(css)?.[1] ?? "";
const rowMinHeight = Number(/min-height:\s*(\d+)px/.exec(zoneOptionRule)?.[1] ?? NaN);
const rowGap = Number(/\.v2-zone-select-popup[^{]*\{[^}]*\bgap:\s*(\d+)px/.exec(css)?.[1] ?? NaN);
// `min(46vh, 340px)`: 340px is the hard ceiling this pane can EVER reach on
// any viewport, however tall — so if N rows exceed 340px on the row-height
// floor alone (before real text wrapping, which only adds height), the pane
// overflows and must scroll everywhere, full stop.
const paneCeilingPx = Number(/max-height:\s*min\(\s*46vh\s*,\s*(\d+)px\s*\)/.exec(zonePopupRule)?.[1] ?? NaN);
// The narrowest phone this storefront supports realistically still clears
// ~640px of viewport height even with browser chrome; the mobile override
// is 42vh, so this is the smallest the pane can ever be in practice.
const smallestRealisticPaneFloorPx = 0.42 * 640;
const contentHeight = (rows) => rows * rowMinHeight + (rows - 1) * rowGap;
check("12 real zone rows mathematically must overflow the pane's own hard ceiling at any viewport size",
  Number.isFinite(rowMinHeight) && Number.isFinite(rowGap) && Number.isFinite(paneCeilingPx) &&
  contentHeight(12) > paneCeilingPx);
check("3 real zone rows mathematically fit even the smallest realistic pane height — no scrollbar is correct, not a bug",
  contentHeight(3) <= smallestRealisticPaneFloorPx);

clickEl(testid("v2-place-order"));
await waitFor(() => orders().length === 3 && Boolean(testid("v2-order-number")) &&
  Boolean(testid("v2-order-details")), { label: "settled delivery/COD receipt" });
const delivered = orders().at(-1);
check("settled advisory estimate matches the authoritative demo order snapshot",
  Number.isFinite(estimatedTotal) && estimatedTotal === delivered.total &&
  testid("v2-order-details").textContent.includes("WELCOME10"));
check("delivery and WELCOME10 are server-repriced and snapshotted once",
  delivered.delivery_type === "delivery" && delivered.delivery_zone_id === cairoZone.id &&
  delivered.discount_code === "WELCOME10" && delivered.payment_method === "cod" &&
  delivered.total === delivered.subtotal - delivered.discount_amount + delivered.delivery_fee);

await navigate("#/store/about", 200);
check("About reads configured shop content under the V2 shell", Boolean(testid("v2-about")) &&
  !testid("store-about"));
await navigate("#/store/contact", 200);
check("Contact shows configured details, no fictional web inbox", Boolean(testid("v2-contact")) &&
  document.querySelector('.v2-contact-list')?.textContent.includes("Phone"));
await navigate("#/store/a-route-that-does-not-exist", 220);
check("unknown public shop URL returns safely to the canonical homepage", dom.window.location.hash === "#/store" &&
  Boolean(testid("v2-home")));
await navigate("#/store/cart", 320);
check("the canonical bag stays inside the same V2 shell and shared cart provider", Boolean(testid("store-v2")) &&
  Boolean(testid("v2-cart")) && Boolean(document.querySelector('a[href="#/store/products"]')));
console.log("\nV2 Phase 3 DOM customer journey passed.");
finish("V2 Phase 3 full shopping/identity/order journey");
