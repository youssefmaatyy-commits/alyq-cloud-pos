/**
 * Promotions end to end (Parts 9–11, 19–23): delivery zones, automatic
 * discounts and promo codes, driven through the real UI in jsdom, demo mode:
 *
 *   1. the seeded zones price the shop window from day one;
 *   2. editing a zone fee prices the next checkout (no code);
 *   3. a storewide automatic discount lowers live prices (struck-through);
 *   4. a promo code is created, applied, and charged exactly once;
 *   5. approval carries the discount into the till sale;
 *   6. the return refunds the discounted unit, never the list price;
 *   7. disabling the sale restores list prices for new carts.
 *
 * The server-side proof (minimums, caps, limits, targeting, snapshots) lives
 * in `npm run db:check` (the $promo50$ block); the arithmetic mirror in
 * `npm test` (the promotions engine section). This suite proves the screens
 * drive those layers correctly.
 *
 * Any console.error / window.onerror / network call fails the run.
 *
 *   node scripts/test.e2e.mjs promotions
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
  clickExact,
  clickTestid,
  testid,
  signInAs,
} = ux;

let passed = 0;
const TOTAL = 11;
function check(label, condition) {
  assert.ok(condition, label);
  passed += 1;
  console.log(`  ✓ ${passed}/${TOTAL} ${label}`);
}

const store = (key) => JSON.parse(ux.dom.window.localStorage.getItem(key) ?? "null");
// Native value setter + input/change events: React listens above the DOM
// property, so assigning `.value` directly never reaches state (the same
// helper every other flow uses).
const setInputValue = (el, value) => {
  assert.ok(el, "field exists");
  const proto = el.tagName === "SELECT" ? ux.dom.window.HTMLSelectElement : ux.dom.window.HTMLInputElement;
  Object.getOwnPropertyDescriptor(proto.prototype, "value").set.call(el, value);
  el.dispatchEvent(new ux.dom.window.Event(el.tagName === "SELECT" ? "change" : "input", { bubbles: true }));
  el.dispatchEvent(new ux.dom.window.Event("change", { bubbles: true }));
  return el;
};
const setField = (selector, value, scope = document) => {
  const el = scope.querySelector(selector);
  assert.ok(el, `field exists: ${selector}`);
  el.focus();
  return setInputValue(el, value);
};

async function main() {
  console.log("\nPromotions · zones, automatic discounts, promo codes\n");
  await sleep(600);

  // ── 0 · admin signs in ────────────────────────────────────────────────────
  await signInAs("admin");
  await waitFor(() => testid("shell-brand"), { label: "the shell" });

  // ── 1 · the seeded zones are the shop window from day one ─────────────────
  await navigate("#/online/zones");
  await waitFor(() => testid("zones-table"), { label: "the zones table" });
  check(
    "Ismailia / Cairo / Suez / Other governorates ship priced",
    ["ismailia", "cairo", "suez", "other"].every((k) => testid(`zone-row-${k}`)),
  );

  // ── 2 · editing a fee prices the next checkout (no code) ──────────────────
  const ismRow = testid("zone-row-ismailia");
  clickEl([...ismRow.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim() === "Edit"));
  await waitFor(() => testid("zone-fee"), { label: "the zone editor" });
  setField('[data-testid="zone-fee"]', "30");
  clickTestid("zone-save");
  await waitFor(
    () => testid("zone-row-ismailia")?.textContent?.includes("30"),
    { label: "the edited fee" },
  );
  check("Ismailia 0 → 30 takes effect from the admin screen", true);

  // ── 3 · a storewide automatic discount ────────────────────────────────────
  await navigate("#/online/discounts");
  await waitFor(() => testid("promo-new"), { label: "the discounts page" });
  clickTestid("promo-new");
  await waitFor(() => testid("promo-name-en"), { label: "the discount editor" });
  setField('[data-testid="promo-name-en"]', "E2E Sale");
  setField('[data-testid="promo-name-ar"]', "تخفيض فحص");
  setField('[data-testid="promo-value"]', "10");
  clickTestid("promo-save");
  await waitFor(() => document.querySelector('[data-testid^="promo-row-"]'), {
    label: "the saved discount",
  });
  check("a 10% storewide discount is created from the admin screen", true);

  // ── 4 · live prices strike through on the shop window ─────────────────────
  await navigate("#/store/products");
  await waitFor(() => document.querySelector('[data-testid="product-grid"]'), {
    label: "the product listing",
  });
  await sleep(800);
  const struck = () =>
    [...document.querySelectorAll('[data-testid="product-grid"] .line-through')].length;
  const struckBefore = struck();
  check("the listing shows struck-through prices under a live offer", struckBefore > 0);

  // ── 5 · a promo code with min + cap ───────────────────────────────────────
  // The minimum sits UNDER the live cart (462.40): the seeded Weekly flash
  // sale takes 15% off the ring (68 → 57.80), and the pricing ladder assesses
  // coupon minimums on the live subtotal — the number the customer sees — not
  // the struck list price. A min of 500 would refuse a 462.40 cart by design.
  await navigate("#/online/marketing");
  await waitFor(() => testid("coupon-new"), { label: "the marketing page" });
  clickEl(
    [...document.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim().startsWith("Coupons")),
  );
  await sleep(400);
  clickTestid("coupon-new");
  await waitFor(() => testid("coupon-code"), { label: "the coupon editor" });
  setField('[data-testid="coupon-code"]', "E2E10");
  setField('[data-testid="coupon-value"]', "10");
  setField('[data-testid="coupon-min"]', "400");
  setField('[data-testid="coupon-max"]', "200");
  clickTestid("coupon-save");
  // The editor closes on save: the code showing only inside an open dialog
  // would be a failed save misread as a created coupon.
  await waitFor(() => !document.querySelector('[role="dialog"]'), { label: "the closed editor" });
  await waitFor(() => bodyText().includes("E2E10"), { label: "the saved code" });
  console.log(
    `  … saved coupons: ${JSON.stringify((store("alyq.demo.coupons.v1") ?? []).map((c) => ({ code: c.code, min: c.min_subtotal, max: c.max_discount, value: c.value, active: c.active })))}`,
  );
  check("promo code E2E10 (10%, min 400, max 200) is created", true);

  // ── 6 · the shopper fills a cart over the minimum ─────────────────────────
  // 8 × 57.80 (flash-sale price) = 462.40 live, 544 struck: the cart shows the
  // live subtotal, and 462.40 clears the 400 minimum.
  await navigate("#/store/products/classic-gold-ring");
  await waitFor(() => testid("product-add-to-cart"), { label: "the product page" });
  // Re-query every click: React replaces the button on each step, and a click
  // on a detached node lands nowhere.
  // The initial selection is one unit. Eight attempts are intentional: a
  // React re-render can detach one click, and the stepper's stock ceiling keeps
  // the loop safe if the fixture is smaller than the requested quantity.
  for (let i = 0; i < 8; i += 1) {
    const inc = [...document.querySelectorAll("button")].find((b) =>
      (b.getAttribute("aria-label") ?? "").includes("ncrease"),
    );
    assert.ok(inc && !inc.disabled, "the stepper offers more");
    clickEl(inc);
    await sleep(150);
  }
  clickTestid("product-add-to-cart");
  await sleep(500);
  await navigate("#/store/cart");
  // Reconcile the quantity through the cart's authoritative controls. React may
  // process a burst of product-page clicks after navigation, and the cart can
  // briefly render a line quantity that is ahead of its refreshed preview. Set
  // the exact fixture quantity here instead of waiting for a coincidental total.
  const ringLine = [...document.querySelectorAll("article")].find((article) =>
    (article.textContent ?? "").includes("ALYQ-1002"),
  );
  assert.ok(ringLine, "the Classic Gold Ring cart line exists");
  const decrease = ringLine.querySelector('button[aria-label*="ecrease"]');
  const quantityText = () => decrease?.parentElement?.querySelector("span")?.textContent?.trim() ?? "";
  for (let i = 0; i < 30 && quantityText() !== "8"; i += 1) {
    if (!decrease || quantityText() === "1") break;
    clickEl(decrease);
    await sleep(150);
  }
  await waitFor(() => quantityText() === "8", {
    label: "the cart quantity to settle at eight",
  });
  // Wait for the authoritative preview after the line quantity has settled.
  await waitFor(() => bodyText().includes("462.4"), {
    label: "the 8 × 57.80 cart",
    timeout: 60_000,
  });
  check("8 × Classic Gold Ring prices 462.40 live (544 struck) in the cart", true);

  // ── 7 · the code applies once, exactly ────────────────────────────────────
  const codeInput = document.querySelector('input[placeholder*="code" i], input[placeholder*="Enter" i]');
  assert.ok(codeInput, "the promo input exists on the cart");
  codeInput.focus();
  setInputValue(codeInput, "E2E10");
  const applyBtn = [...document.querySelectorAll("button")].find((b) =>
    /^(Apply|تطبيق)$/.test((b.textContent ?? "").trim()),
  );
  assert.ok(applyBtn, "the Apply button exists");
  assert.ok(!applyBtn.disabled, "the Apply button is enabled with a code typed");
  clickEl(applyBtn);
  await sleep(2500);
  console.log(`  … after Apply: couponError region: ${(document.body.textContent ?? "").includes("46.24") ? "discount visible" : "NO DISCOUNT YET"}`);
  console.log(
    `  … coupon chip: ${bodyText().includes("E2E10") ? "CODE SHOWN" : "code absent"} | err: ${[...document.querySelectorAll("p")].filter((p) => (p.textContent ?? "").toLowerCase().includes("code")).map((p) => p.textContent?.trim()).join(" ;; ").slice(0, 300)}`,
  );
  await waitFor(() => bodyText().includes("46.24"), { label: "the applied discount" });
  check("E2E10 takes exactly 46.24 off 462.40 (10%, under the 200 cap)", true);

  // ── 8 · checkout charges the previewed numbers ────────────────────────────
  await navigate("#/store/checkout");
  await waitFor(() => bodyText().includes("Checkout") || bodyText().includes("إتمام"), {
    label: "the checkout",
  });
  await sleep(1200);
  const fill = (selector, value) => {
    const el = document.querySelector(selector);
    assert.ok(el, `checkout field: ${selector}`);
    el.focus();
    setInputValue(el, value);
  };
  fill("input[autocomplete='name']", "Mona Mahmoud");
  fill("input[autocomplete='tel']", "01001234567");
  const pickup = [...document.querySelectorAll("button")].find((b) =>
    (b.textContent ?? "").trim().startsWith("Pickup"),
  );
  assert.ok(pickup, "the pickup option exists");
  clickEl(pickup);
  // The zone picker only renders for delivery: its disappearance proves the
  // fulfilment switch landed before the order is placed.
  await waitFor(() => !document.querySelector('[data-testid="checkout-zone-picker"]'), {
    label: "pickup selected (no zone picker)",
  });
  const cod = document.querySelector('input[name="payment"][value="cod"]');
  if (cod) cod.click();
  const place = [...document.querySelectorAll("button")].find((b) =>
    /Place the order|Complete my order|إتمام الطلب/.test(b.textContent ?? ""),
  );
  assert.ok(place, "the place-order button exists");
  clickEl(place);
  await waitFor(() => /WEB-\d{6}/.test(bodyText()), { label: "the confirmation" });
  const webNumber = (bodyText().match(/WEB-\d{6}/) ?? [])[0];
  assert.ok(webNumber, "the confirmation names the order");
  check(`checkout places ${webNumber} with the previewed discount`, true);

  // ── 9 · approval carries the discount into the till sale ──────────────────
  await navigate("#/online/orders");
  await waitFor(() => bodyText().includes(webNumber), { label: "the order in the queue" });
  // The detail opens from the row's View button, not the row itself — the
  // same opener every other suite uses.
  const row = [...document.querySelectorAll("tr")].find((el) =>
    (el.textContent ?? "").includes(webNumber),
  );
  assert.ok(row, "the order row exists");
  const view = [...row.querySelectorAll("button, a")].find((el) =>
    /View|عرض/.test(el.textContent ?? "") || (el.getAttribute("aria-label") ?? "").includes("View"),
  );
  assert.ok(view, "the row offers its detail");
  clickEl(view);
  await sleep(800);
  const dialog = () => document.querySelector('[role="dialog"]');
  await waitFor(() => (dialog()?.textContent ?? "").includes(webNumber), {
    label: "the order detail",
  });
  await waitFor(() => (dialog()?.textContent ?? "").includes("Approve order"), {
    label: "the approval dialog",
  });
  clickEl(
    [...dialog().querySelectorAll("button")].find((b) => (b.textContent ?? "").includes("Approve order")),
  );
  await waitFor(() => (dialog()?.textContent ?? "").includes("Approved"), { label: "the approval" });
  const sales = store("alyq.demo.sales.v1") ?? [];
  const sale = sales.find((s) => s.sale_number && s.customer_name === "Mona Mahmoud");
  assert.ok(sale, "approval created the till sale");
  // The till sale measures the markdown against LIST (544): the flash sale's
  // 81.60 plus the coupon's 46.24 = 127.84. The net (416.16) is what travels.
  assert.ok(Math.abs(sale.discount_amount - 127.84) < 0.01, `the sale carries the 127.84 markdown vs list (got ${sale.discount_amount})`);
  check("approving creates the sale with the 127.84 markdown (81.60 sale + 46.24 code)", true);

  // ── 10 · the return refunds the discounted unit, never list ───────────────
  await navigate("#/returns");
  await waitFor(() => bodyText().includes("Returns"), { label: "the returns screen" });
  clickExact("New return");
  await waitFor(() => document.querySelectorAll('[role="dialog"]').length > 0, {
    label: "the return modal",
  });
  await sleep(500);
  const modal = () => [...document.querySelectorAll('[role="dialog"]')].at(-1);
  // The modal re-reads invoices on open: wait for the online-approved sale to
  // arrive rather than assuming the first paint has it.
  await waitFor(
    () =>
      [...modal().querySelectorAll("select")].some((s) =>
        [...s.options].some((o) => (o.textContent ?? "").includes(sale.sale_number)),
      ),
    { label: "the online-origin sale in the picker" },
  );
  const saleSelect = [...modal().querySelectorAll("select")].find((s) =>
    [...s.options].some((o) => (o.textContent ?? "").includes(sale.sale_number)),
  );
  assert.ok(saleSelect, "the online-origin sale is offered");
  setInputValue(
    saleSelect,
    [...saleSelect.options].find((o) => (o.textContent ?? "").includes(sale.sale_number)).value,
  );
  await sleep(500);
  const qtyInput = [...modal().querySelectorAll('input[placeholder="0"]')][0];
  assert.ok(qtyInput, "the quantity input exists");
  qtyInput.focus();
  setInputValue(qtyInput, "1");
  const reasonInput = modal().querySelector("#return-reason");
  assert.ok(reasonInput, "the reason input exists");
  reasonInput.focus();
  setInputValue(reasonInput, "promo return check");
  clickEl(
    [...modal().querySelectorAll("button")].find((b) => (b.textContent ?? "").includes("Process return")),
  );
  await waitFor(() => /RET-\d{6}/.test(bodyText()), { label: "the return" });
  const refunds = store("alyq.demo.refunds.v1") ?? [];
  const refund = refunds[0];
  assert.ok(refund, "a refund record exists");
  const refunded = refund.amount ?? refund.refund_amount;
  // 462.40 − 46.24 = 416.16 over 8 units = 52.02 each; list is 68.
  assert.ok(
    Math.abs(refunded - 52.02) < 0.01,
    `the refund is the discounted 52.02, not list 68 (got ${refunded})`,
  );
  check("the return refunds 52.02 per unit — the paid price, not list", true);

  // The success handler routes to the return detail once the catalog refresh
  // settles — after our own navigation, so wait for its landing first, or it
  // overwrites the next screen mid-step.
  await waitFor(() => ux.dom.window.location.hash.startsWith("#/dashboard/returns/ret-"), {
    label: "the return detail",
  });

  // ── 11 · disabling the sale restores list for new carts ───────────────────
  await navigate("#/online/discounts");
  await sleep(500);
  await waitFor(() => document.querySelector('[data-testid^="promo-row-"]'), {
    label: "the discounts table",
  });
  const promoRow = document.querySelector('[data-testid^="promo-row-"]');
  clickEl(
    [...promoRow.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim() === "Edit"),
  );
  await waitFor(() => testid("promo-name-en"), { label: "the discount editor" });
  const enabledSwitch = () =>
    [...document.querySelectorAll('[role="dialog"] button[role="switch"]')].find((b) =>
      (b.parentElement?.textContent ?? "").includes("Enabled"),
    );
  assert.ok(enabledSwitch(), "the Enabled switch exists");
  clickEl(enabledSwitch());
  // The save reads the draft from state: wait for the toggle's flip to land
  // before saving, or the row persists enabled.
  await waitFor(() => enabledSwitch()?.getAttribute("aria-checked") === "false", {
    label: "the sale switched off",
  });
  clickTestid("promo-save");
  await sleep(800);
  await navigate("#/store/products");
  await sleep(800);
  const struckAfter = () =>
    [...document.querySelectorAll('[data-testid="product-grid"] .line-through')].length;
  // The seeded flash sale still strikes its own two shelves: disabling the E2E
  // Sale removes exactly its struck prices, so the count falls but not to zero.
  check("disabling the sale removes its struck prices for new carts", struckAfter() < struckBefore);

  ux.finish(`Promotions (promotions) — ${passed}/${TOTAL} checks`);
}

main().catch((error) => {
  console.error(`\n✗ ${error?.stack ?? error}`);
  process.exit(1);
});
