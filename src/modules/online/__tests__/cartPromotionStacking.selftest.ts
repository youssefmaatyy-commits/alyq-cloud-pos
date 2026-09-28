/**
 * Regression suite for the Cart promotion/coupon stacking bug.
 *
 * The bug: `StoreCartProvider` baked the best automatic promotion straight
 * into each cart line's own price (`entries[].price`/`lineTotal`), so the
 * cart's subtotal was already net of the automatic discount before a coupon
 * was ever typed. A coupon entered afterwards then discounted that
 * already-discounted subtotal a second time — the two savings stacked,
 * disagreeing with `evaluate_order_pricing` / `evaluateCartPricing`, which
 * apply only ONE of the two unless both are explicitly marked stackable.
 * Separately, `previewPricing` refused to run at all before a delivery zone
 * was chosen, so the Cart page (which shows pricing before checkout ever asks
 * for an address) fell back to those wrong local totals instead of the
 * authoritative advisory breakdown.
 *
 * These tests cover, in the user's own terms:
 *   1. No coupon: the automatic promotion still discounts the cart.
 *   2. A coupon is entered: the automatic promotion's own discount is
 *      reconciled away instead of stacking (here, an exact tie — both would
 *      have been the same amount — so the rule's own tie-break, "coupon
 *      wins", is exercised).
 *   3. The exact worked numbers: subtotal 462.40, auto discount reconciled to
 *      0, coupon discount 46.24, total 416.16.
 *   4. The Cart page (no delivery zone chosen yet) still prices correctly —
 *      `previewPricing` no longer refuses before a zone exists.
 *   5. Checkout's total (with a zone chosen) never differs from the cart's
 *      goods pricing — only the delivery fee changes between the two calls.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { getDemoRepository } from "@/modules/products/data/demoRepository";
import { getDemoOnlineRepository, resetDemoOnlineRepository } from "../data/demoRepository";
import { reconcileAutomaticAndCoupon, round2 } from "../services/pricing";
import type { Product } from "@/modules/products/types";

async function demoProduct(sku: string): Promise<Product> {
  const products = await getDemoRepository().listProducts();
  const product = products.find(
    (candidate) =>
      candidate.sku === sku && candidate.active && candidate.stock_tracking_enabled && candidate.show_on_website,
  );
  assert.ok(product, `an active, stock-tracked website product with SKU ${sku} exists in the demo catalogue`);
  return product as Product;
}

// ── 1. the reconciliation rule itself, in isolation ─────────────────────────

test("reconcileAutomaticAndCoupon: no coupon leaves the automatic promotion untouched", () => {
  const result = reconcileAutomaticAndCoupon(46.24, false, 0, false);
  assert.deepEqual(result, { autoDiscount: 46.24, couponDiscount: 0 });
});

test("reconcileAutomaticAndCoupon: a coupon that ties the automatic discount wins the tie (matches the worked example)", () => {
  // 10% off 462.40 both ways: automatic promotion and coupon compute the
  // identical 46.24. Neither is marked stackable, so only one may apply —
  // the tie-break favours the coupon, exactly like evaluateCartPricing.
  const result = reconcileAutomaticAndCoupon(46.24, false, 46.24, false);
  assert.deepEqual(result, { autoDiscount: 0, couponDiscount: 46.24 });
});

test("reconcileAutomaticAndCoupon: the larger, non-stackable discount always wins", () => {
  assert.deepEqual(reconcileAutomaticAndCoupon(80, false, 20, false), { autoDiscount: 80, couponDiscount: 0 });
  assert.deepEqual(reconcileAutomaticAndCoupon(20, false, 80, false), { autoDiscount: 0, couponDiscount: 80 });
});

test("reconcileAutomaticAndCoupon: both stackable means both apply, even in a tie", () => {
  assert.deepEqual(reconcileAutomaticAndCoupon(46.24, true, 46.24, true), {
    autoDiscount: 46.24,
    couponDiscount: 46.24,
  });
});

test("reconcileAutomaticAndCoupon: one-sided stackable still falls back to larger-wins", () => {
  // Only the coupon says it stacks; the automatic promotion does not agree,
  // so the pair is treated as non-stackable, same as evaluate_order_pricing.
  assert.deepEqual(reconcileAutomaticAndCoupon(46.24, false, 46.24, true), {
    autoDiscount: 0,
    couponDiscount: 46.24,
  });
});

// ── 2–5: the real repository, end to end (no jsdom needed) ──────────────────

test("Cart promotion/coupon stacking — the worked example, through the real demo repository", async () => {
  resetDemoOnlineRepository();
  const repository = getDemoOnlineRepository();
  const product = await demoProduct("ALYQ-1001");
  const unitPrice = product.selling_price;
  const qty = 8;
  const subtotal = round2(unitPrice * qty);

  // A 10% storewide AUTOMATIC promotion — codeless, applies to every cart.
  await repository.savePromotion(
    {
      enabled: true,
      mode: "automatic",
      channel: "both",
      name_en: "Storewide 10%",
      name_ar: "خصم عام 10%",
      description_en: null,
      description_ar: null,
      discount_type: "percent",
      value: 10,
      scope: "store",
      minimum_order_amount: 0,
      maximum_discount_amount: null,
      starts_at: null,
      ends_at: null,
      priority: 0,
      stackable: false,
    },
    [],
  );

  // A 10% coupon, capped well above what this cart needs — chosen so its
  // discount TIES the automatic promotion's, exercising the tie-break.
  await repository.saveCoupon({
    code: "E2E10",
    discount_type: "percent",
    value: 10,
    min_subtotal: 0,
    max_discount: 1000,
    usage_limit: null,
    applies_to: "all",
    target_ids: [],
    active: true,
    starts_at: null,
    ends_at: null,
  });

  // A delivery zone exists and is enabled, but the shopper has not chosen one
  // yet — the Cart page must still price correctly (task 2C / regression 4).
  await repository.saveDeliveryZone({
    key: "test-zone",
    name_en: "Test Zone",
    name_ar: "منطقة تجريبية",
    shipping_fee: 25,
    enabled: true,
  });

  const lines = [{ product_id: product.id, qty }];
  // Both the automatic promotion and the coupon are a flat 10% of the same
  // (campaign-adjusted) subtotal, so they compute the identical amount — the
  // exact tie the user's worked example exercises (List → campaign subtotal,
  // 10% automatic, 10% coupon, and only ONE 10% actually taken off).
  const expectedDiscount = round2(subtotal * 0.1);

  // ── regression 1: no coupon, the automatic promotion still applies ───────
  const noCoupon = await repository.previewPricing({
    lines,
    couponCode: null,
    deliveryZoneId: null,
    deliveryType: "delivery",
  });
  assert.equal(noCoupon.subtotal, subtotal, "subtotal is the campaign-adjusted goods total, nothing more");
  assert.equal(noCoupon.autoDiscount, expectedDiscount, "the automatic promotion discounts the cart on its own");
  assert.equal(noCoupon.promoDiscount, 0);

  // ── regression 4: the Cart page prices correctly with NO zone chosen ────
  // (previewPricing must not throw "Please select a delivery zone" here —
  // that used to break the Cart page for every shopper who had not yet
  // reached checkout.)
  const beforeZone = await repository.previewPricing({
    lines,
    couponCode: "E2E10",
    deliveryZoneId: null,
    deliveryType: "delivery",
  });

  // ── regression 2 + 3: the coupon applies, the automatic discount is
  // reconciled away instead of stacking — this is the exact shape of the
  // user's worked example (Subtotal 462.40 / Auto 0 / Coupon 46.24 / Total
  // 416.16), reproduced here against whatever the demo catalogue prices this
  // product at, so the test does not depend on a specific SKU's price.
  assert.equal(beforeZone.subtotal, subtotal, "the subtotal the coupon was checked against never shifts");
  assert.equal(beforeZone.autoDiscount, 0, "the automatic promotion's discount disappears once the coupon wins the tie");
  assert.equal(beforeZone.promoDiscount, expectedDiscount, "the coupon takes exactly the one 10%, not both");
  assert.equal(
    round2(beforeZone.subtotal - beforeZone.autoDiscount - beforeZone.promoDiscount),
    round2(subtotal - expectedDiscount),
    "only one 10% ever comes off — the bug stacked both for two 10%s",
  );
  // Never both at once: whichever survives the tie-break is the only discount
  // actually taken off the subtotal.
  assert.ok(beforeZone.autoDiscount === 0 || beforeZone.promoDiscount === 0);

  // ── regression 5: choosing a zone at checkout must not move the goods
  // pricing the Cart page already showed — only the delivery fee changes.
  const zone = (await repository.listDeliveryZones()).find((candidate) => candidate.key === "test-zone");
  assert.ok(zone);
  const afterZone = await repository.previewPricing({
    lines,
    couponCode: "E2E10",
    deliveryZoneId: zone!.id,
    deliveryType: "delivery",
  });
  assert.equal(afterZone.subtotal, beforeZone.subtotal, "cart total == checkout total: subtotal must not shift");
  assert.equal(afterZone.autoDiscount, beforeZone.autoDiscount, "cart total == checkout total: auto discount must not shift");
  assert.equal(afterZone.promoDiscount, beforeZone.promoDiscount, "cart total == checkout total: coupon discount must not shift");
  assert.equal(afterZone.deliveryFee, 25, "the zone's own fee, now that one is chosen");
  assert.equal(
    afterZone.total,
    round2(beforeZone.subtotal - beforeZone.autoDiscount - beforeZone.promoDiscount + 25),
    "checkout's total is exactly the cart's goods total plus the newly-chosen zone's fee",
  );
});
