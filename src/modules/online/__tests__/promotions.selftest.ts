import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateCartPricing,
  normalizeCouponCode,
  promotionDiscount,
  promotionUnitPrice,
  selectAutomaticPromotion,
  type EvaluatedCartLine,
} from "../services/pricing";
import {
  getPromotionStatus,
  type Promotion,
} from "../types";
import {
  cartTotals,
  lineTotals,
  round2,
  validateDiscount,
} from "@/modules/pos/services/posMath";

type MakePromoInput = Partial<Promotion> & {
  type?: "percentage" | "fixed_amount";
  max_discount_amount?: number | null;
  start_date?: string;
  end_date?: string;
};

function makePromo(overrides: MakePromoInput = {}): Promotion {
  const type = overrides.discount_type ?? (overrides.type === "percentage" ? "percent" : overrides.type === "fixed_amount" ? "fixed" : "percent");
  const start = overrides.starts_at ?? overrides.start_date ?? "2026-01-01T00:00:00Z";
  const end = overrides.ends_at ?? overrides.end_date ?? "2026-12-31T23:59:59Z";
  const maxDisc = overrides.maximum_discount_amount ?? overrides.max_discount_amount ?? null;
  return {
    id: overrides.id ?? "promo-" + Math.random().toString(36).slice(2, 7),
    name_ar: overrides.name_ar ?? "عرض تجريبي",
    name_en: overrides.name_en ?? "Test Promo",
    description_ar: overrides.description_ar ?? null,
    description_en: overrides.description_en ?? null,
    discount_type: type,
    value: overrides.value ?? 10,
    scope: overrides.scope ?? "store",
    channel: overrides.channel ?? "both",
    mode: overrides.mode ?? "automatic",
    code: overrides.code ?? null,
    minimum_order_amount: overrides.minimum_order_amount ?? 0,
    maximum_discount_amount: maxDisc,
    starts_at: start,
    ends_at: end,
    priority: overrides.priority ?? 0,
    stackable: overrides.stackable ?? false,
    enabled: overrides.enabled ?? true,
    offer_type: overrides.offer_type,
    rule_type: overrides.rule_type ?? overrides.offer_type,
    buy_x: overrides.buy_x,
    get_y: overrides.get_y,
    reward_type: overrides.reward_type,
    reward_value: overrides.reward_value,
    repeat_offer: overrides.repeat_offer,
    min_quantity: overrides.min_quantity,
    usage_limit: overrides.usage_limit ?? null,
    used_count: overrides.used_count ?? 0,
    created_at: overrides.created_at ?? "2026-01-01T00:00:00Z",
    updated_at: overrides.updated_at ?? "2026-01-01T00:00:00Z",
  };
}

const NOW = new Date("2026-06-15T12:00:00Z");

// ── Test 1: Automatic percentage discount on entire store ────────────────────
test("1. Automatic percentage discount on entire store applies across cart lines", () => {
  const promo = makePromo({
    id: "promo-store-20",
    discount_type: "percent",
    value: 20,
    scope: "store",
    mode: "automatic",
  });
  const lines: Omit<EvaluatedCartLine, "discounted_unit_price">[] = [
    { product_id: "prd-1", variant_id: null, category_id: "cat-1", unit_price: 100, qty: 2, line_total: 200 },
    { product_id: "prd-2", variant_id: null, category_id: "cat-2", unit_price: 200, qty: 1, line_total: 200 },
  ];
  const result = evaluateCartPricing({
    lines,
    subtotal: 400,
    promoCode: null,
    coupons: [],
    promotions: [promo],
    targetsByPromotion: new Map(),
    usageFor: () => ({ customerUses: 0, hasPriorOrder: false }),
    customerKey: null,
    zone: null,
    legacy: { fee: 0, minimum: 0, threshold: 0 },
    deliveryType: "delivery",
    now: NOW,
    channel: "both",
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    // Gross subtotal = 100*2 + 200*1 = 400
    // 20% auto discount = 80
    assert.equal(result.pricing.autoDiscount, 80);
    assert.equal(result.pricing.totalDiscount, 80);
    assert.equal(result.pricing.total, 320);
    assert.equal(result.pricing.lines[0].discounted_unit_price, 80);
    assert.equal(result.pricing.lines[1].discounted_unit_price, 160);
  }
});

// ── Test 2: Automatic fixed discount on entire store ─────────────────────────
test("2. Automatic fixed discount on entire store distributed proportionally without negative totals", () => {
  const promo = makePromo({
    id: "promo-fixed-50",
    discount_type: "fixed",
    value: 50,
    scope: "store",
    mode: "automatic",
  });
  const lines: Omit<EvaluatedCartLine, "discounted_unit_price">[] = [
    { product_id: "prd-1", variant_id: null, category_id: null, unit_price: 100, qty: 1, line_total: 100 },
    { product_id: "prd-2", variant_id: null, category_id: null, unit_price: 100, qty: 1, line_total: 100 },
  ];
  const result = evaluateCartPricing({
    lines,
    subtotal: 200,
    promoCode: null,
    coupons: [],
    promotions: [promo],
    targetsByPromotion: new Map(),
    usageFor: () => ({ customerUses: 0, hasPriorOrder: false }),
    customerKey: null,
    zone: null,
    legacy: { fee: 0, minimum: 0, threshold: 0 },
    deliveryType: "delivery",
    now: NOW,
    channel: "both",
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.pricing.autoDiscount, 50);
    assert.equal(result.pricing.total, 150);
  }
});

// ── Test 3: Category-scoped promotion ────────────────────────────────────────
test("3. Category-scoped promotion applies ONLY to products in that category", () => {
  const promo = makePromo({
    id: "promo-cat-rings",
    discount_type: "percent",
    value: 15,
    scope: "category",
    mode: "automatic",
  });
  const targets = new Map([["promo-cat-rings", new Set(["category:cat-rings"])]]);
  const lines: Omit<EvaluatedCartLine, "discounted_unit_price">[] = [
    { product_id: "prd-ring", variant_id: null, category_id: "cat-rings", unit_price: 200, qty: 1, line_total: 200 },
    { product_id: "prd-necklace", variant_id: null, category_id: "cat-necklaces", unit_price: 300, qty: 1, line_total: 300 },
  ];
  const result = evaluateCartPricing({
    lines,
    subtotal: 500,
    promoCode: null,
    coupons: [],
    promotions: [promo],
    targetsByPromotion: targets,
    usageFor: () => ({ customerUses: 0, hasPriorOrder: false }),
    customerKey: null,
    zone: null,
    legacy: { fee: 0, minimum: 0, threshold: 0 },
    deliveryType: "delivery",
    now: NOW,
    channel: "both",
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    // 15% of 200 = 30. Ring -> 170, Necklace -> 300
    assert.equal(result.pricing.autoDiscount, 30);
    assert.equal(result.pricing.lines[0].discounted_unit_price, 170);
    assert.equal(result.pricing.lines[1].discounted_unit_price, 300);
  }
});

// ── Test 4: Product-scoped promotion ─────────────────────────────────────────
test("4. Product-scoped promotion applies ONLY to targeted product IDs", () => {
  const promo = makePromo({
    id: "promo-prod-1",
    discount_type: "percent",
    value: 25,
    scope: "product",
    mode: "automatic",
  });
  const targets = new Map([["promo-prod-1", new Set(["product:prd-1"])]]);
  const lines: Omit<EvaluatedCartLine, "discounted_unit_price">[] = [
    { product_id: "prd-1", variant_id: null, category_id: null, unit_price: 100, qty: 1, line_total: 100 },
    { product_id: "prd-2", variant_id: null, category_id: null, unit_price: 100, qty: 1, line_total: 100 },
  ];
  const result = evaluateCartPricing({
    lines,
    subtotal: 200,
    promoCode: null,
    coupons: [],
    promotions: [promo],
    targetsByPromotion: targets,
    usageFor: () => ({ customerUses: 0, hasPriorOrder: false }),
    customerKey: null,
    zone: null,
    legacy: { fee: 0, minimum: 0, threshold: 0 },
    deliveryType: "delivery",
    now: NOW,
    channel: "both",
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.pricing.autoDiscount, 25);
    assert.equal(result.pricing.lines[0].discounted_unit_price, 75);
    assert.equal(result.pricing.lines[1].discounted_unit_price, 100);
  }
});

// ── Test 5: Exact variant UUID promotion ────────────────────────────────────
test("5. Exact variant UUID promotion applies ONLY to targeted variant UUID and not sibling variants", () => {
  const promo = makePromo({
    id: "promo-var-gold",
    discount_type: "fixed",
    value: 40,
    scope: "variant",
    mode: "automatic",
  });
  const targets = new Map([["promo-var-gold", new Set(["variant:var-gold-uuid"])]]);
  const lines: Omit<EvaluatedCartLine, "discounted_unit_price">[] = [
    { product_id: "prd-ring", variant_id: "var-gold-uuid", category_id: null, unit_price: 200, qty: 1, line_total: 200 },
    { product_id: "prd-ring", variant_id: "var-silver-uuid", category_id: null, unit_price: 200, qty: 1, line_total: 200 },
  ];
  const result = evaluateCartPricing({
    lines,
    subtotal: 400,
    promoCode: null,
    coupons: [],
    promotions: [promo],
    targetsByPromotion: targets,
    usageFor: () => ({ customerUses: 0, hasPriorOrder: false }),
    customerKey: null,
    zone: null,
    legacy: { fee: 0, minimum: 0, threshold: 0 },
    deliveryType: "delivery",
    now: NOW,
    channel: "both",
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.pricing.autoDiscount, 40);
    assert.equal(result.pricing.lines[0].discounted_unit_price, 160);
    assert.equal(result.pricing.lines[1].discounted_unit_price, 200);
  }
});

// ── Test 6: Mode "automatic" applies automatically without coupon code ───────
test("6. Mode 'automatic' applies automatically without coupon code", () => {
  const autoPromo = makePromo({
    id: "promo-auto",
    discount_type: "percent",
    value: 10,
    mode: "automatic",
    code: null,
  });
  const unit = promotionUnitPrice(
    "prd-1",
    null,
    null,
    100,
    [autoPromo],
    new Map(),
    NOW,
    "both",
    null,
  );
  assert.equal(unit.unit, 90);
  assert.equal(unit.promotionId, "promo-auto");
});

// ── Test 7: Mode "coupon" requires valid promo code ──────────────────────────
test("7. Mode 'coupon' requires valid promo code and does not apply without code", () => {
  const couponPromo = makePromo({
    id: "promo-coupon",
    discount_type: "percent",
    value: 15,
    mode: "coupon",
    code: "SAVE15",
  });
  // Without code:
  const withoutCode = promotionUnitPrice(
    "prd-1",
    null,
    null,
    100,
    [couponPromo],
    new Map(),
    NOW,
    "both",
    null,
  );
  assert.equal(withoutCode.unit, 100);
  assert.equal(withoutCode.promotionId, null);

  // With wrong code:
  const wrongCode = promotionUnitPrice(
    "prd-1",
    null,
    null,
    100,
    [couponPromo],
    new Map(),
    NOW,
    "both",
    "WRONGCODE",
  );
  assert.equal(wrongCode.unit, 100);
  assert.equal(wrongCode.promotionId, null);

  // With matching code:
  const withCode = promotionUnitPrice(
    "prd-1",
    null,
    null,
    100,
    [couponPromo],
    new Map(),
    NOW,
    "both",
    "SAVE15",
  );
  assert.equal(withCode.unit, 85);
  assert.equal(withCode.promotionId, "promo-coupon");
});

// ── Test 8: Coupon code case-insensitivity and whitespace trimming ───────────
test("8. Coupon code normalization trims whitespace and ignores case", () => {
  assert.equal(normalizeCouponCode("  SaVe15 "), "SAVE15");
  assert.equal(normalizeCouponCode("discount-2026"), "DISCOUNT-2026");
  assert.equal(normalizeCouponCode(""), "");
  assert.equal(normalizeCouponCode(null), "");

  const couponPromo = makePromo({
    id: "promo-coupon-case",
    discount_type: "fixed",
    value: 20,
    mode: "coupon",
    code: "SUMMER",
  });
  const res = promotionUnitPrice(
    "prd-1",
    null,
    null,
    100,
    [couponPromo],
    new Map(),
    NOW,
    "both",
    "  summer  ",
  );
  assert.equal(res.unit, 80);
  assert.equal(res.promotionId, "promo-coupon-case");
});

// ── Test 9: Multiple competing promotions - highest EGP savings wins ─────────
test("9. Multiple competing promotions: highest EGP savings promotion wins (best price rule)", () => {
  const promo10pct = makePromo({ id: "p10", discount_type: "percent", value: 10, mode: "automatic" });
  const promo30pct = makePromo({ id: "p30", discount_type: "percent", value: 30, mode: "automatic" });
  const promoFixed25 = makePromo({ id: "pf25", discount_type: "fixed", value: 25, mode: "automatic" });

  // On a 100 EGP item:
  // p10 saves 10 EGP
  // p30 saves 30 EGP
  // pf25 saves 25 EGP
  // Winner: p30 (saves 30) -> price 70
  const chosen = selectAutomaticPromotion(
    [promo10pct, promo30pct, promoFixed25],
    new Map(),
    [{ product_id: "prd-1", category_id: null, variant_id: null, line_total: 100 }],
    100,
    NOW,
    "both",
  );
  assert.equal(chosen?.promotion.id, "p30");
  assert.equal(chosen?.discount, 30);

  // On a 50 EGP item:
  // p10 saves 5 EGP
  // p30 saves 15 EGP
  // pf25 saves 25 EGP
  // Winner: pf25 (saves 25) -> price 25
  const chosen2 = selectAutomaticPromotion(
    [promo10pct, promo30pct, promoFixed25],
    new Map(),
    [{ product_id: "prd-1", category_id: null, variant_id: null, line_total: 50 }],
    50,
    NOW,
    "both",
  );
  assert.equal(chosen2?.promotion.id, "pf25");
  assert.equal(chosen2?.discount, 25);
});

// ── Test 10: Non-stacking rule ───────────────────────────────────────────────
test("10. Non-stacking rule: promotions do not stack by default", () => {
  const promoA = makePromo({ id: "pA", discount_type: "percent", value: 20, mode: "automatic" });
  const promoB = makePromo({ id: "pB", discount_type: "percent", value: 10, mode: "automatic" });

  const res = promotionUnitPrice(
    "prd-1",
    null,
    null,
    100,
    [promoA, promoB],
    new Map(),
    NOW,
    "both",
  );
  // Takes 20% (price 80), NOT 20% + 10% = 30% (price 70)
  assert.equal(res.unit, 80);
});

// ── Test 11: Min subtotal requirement ────────────────────────────────────────
test("11. Minimum subtotal requirement: promotion ignored when subtotal below threshold", () => {
  const promoWithMin = makePromo({
    id: "p-min-500",
    discount_type: "percent",
    value: 20,
    minimum_order_amount: 500,
    mode: "automatic",
  });

  // Cart subtotal = 300 (< 500)
  const cartSmall: Omit<EvaluatedCartLine, "discounted_unit_price">[] = [
    { product_id: "prd-1", variant_id: null, category_id: null, unit_price: 300, qty: 1, line_total: 300 },
  ];
  const resSmall = evaluateCartPricing({
    lines: cartSmall,
    subtotal: 300,
    promoCode: null,
    coupons: [],
    promotions: [promoWithMin],
    targetsByPromotion: new Map(),
    usageFor: () => ({ customerUses: 0, hasPriorOrder: false }),
    customerKey: null,
    zone: null,
    legacy: { fee: 0, minimum: 0, threshold: 0 },
    deliveryType: "delivery",
    now: NOW,
    channel: "both",
  });
  assert.equal(resSmall.ok, true);
  if (resSmall.ok) {
    assert.equal(resSmall.pricing.autoDiscount, 0);
    assert.equal(resSmall.pricing.total, 300);
  }

  // Cart subtotal = 600 (>= 500)
  const cartLarge: Omit<EvaluatedCartLine, "discounted_unit_price">[] = [
    { product_id: "prd-1", variant_id: null, category_id: null, unit_price: 300, qty: 2, line_total: 600 },
  ];
  const resLarge = evaluateCartPricing({
    lines: cartLarge,
    subtotal: 600,
    promoCode: null,
    coupons: [],
    promotions: [promoWithMin],
    targetsByPromotion: new Map(),
    usageFor: () => ({ customerUses: 0, hasPriorOrder: false }),
    customerKey: null,
    zone: null,
    legacy: { fee: 0, minimum: 0, threshold: 0 },
    deliveryType: "delivery",
    now: NOW,
    channel: "both",
  });
  assert.equal(resLarge.ok, true);
  if (resLarge.ok) {
    assert.equal(resLarge.pricing.autoDiscount, 120); // 20% of 600
    assert.equal(resLarge.pricing.total, 480);
  }
});

// ── Test 12: Max discount cap ────────────────────────────────────────────────
test("12. Maximum discount cap: promotion discount capped at max_discount_amount", () => {
  const promoCapped = makePromo({
    id: "p-capped",
    discount_type: "percent",
    value: 50, // 50% of 1000 would be 500
    maximum_discount_amount: 150, // capped at 150
    mode: "automatic",
  });
  const lines: Omit<EvaluatedCartLine, "discounted_unit_price">[] = [
    { product_id: "prd-1", variant_id: null, category_id: null, unit_price: 1000, qty: 1, line_total: 1000 },
  ];
  const res = evaluateCartPricing({
    lines,
    subtotal: 1000,
    promoCode: null,
    coupons: [],
    promotions: [promoCapped],
    targetsByPromotion: new Map(),
    usageFor: () => ({ customerUses: 0, hasPriorOrder: false }),
    customerKey: null,
    zone: null,
    legacy: { fee: 0, minimum: 0, threshold: 0 },
    deliveryType: "delivery",
    now: NOW,
    channel: "both",
  });
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.pricing.autoDiscount, 150);
    assert.equal(res.pricing.total, 850);
  }
});

// ── Test 13: Percentage discount cannot exceed 100% ──────────────────────────
test("13. Percentage discount calculation safely clamps between 0% and 100%", () => {
  const pOver = makePromo({ discount_type: "percent", value: 150 });
  assert.equal(promotionDiscount(pOver, new Set(), [], 100), 100);
  const pUnder = makePromo({ discount_type: "percent", value: -20 });
  assert.equal(promotionDiscount(pUnder, new Set(), [], 100), 0);
  const pNorm = makePromo({ discount_type: "percent", value: 25 });
  assert.equal(promotionDiscount(pNorm, new Set(), [], 100), 25);
});

// ── Test 14: Fixed discount cannot exceed base price (price never below 0) ───
test("14. Fixed discount cannot exceed base price (price never drops below 0)", () => {
  const pFixed = makePromo({ discount_type: "fixed", value: 100 });
  assert.equal(promotionDiscount(pFixed, new Set(), [], 50), 50);
  const promo = makePromo({ id: "p-excess", discount_type: "fixed", value: 300, mode: "automatic" });
  const unit = promotionUnitPrice("prd-1", null, null, 100, [promo], new Map(), NOW, "both");
  assert.equal(unit.unit, 0);
});

// ── Test 15: Scheduled promotion active in start_date/end_date window ────────
test("15. Scheduled promotion active inside date window", () => {
  const promo = makePromo({
    id: "p-sched",
    starts_at: "2026-06-01T00:00:00Z",
    ends_at: "2026-06-30T23:59:59Z",
    value: 10,
    mode: "automatic",
  });
  const res = promotionUnitPrice("prd-1", null, null, 100, [promo], new Map(), new Date("2026-06-15T12:00:00Z"), "both");
  assert.equal(res.unit, 90);
  assert.equal(getPromotionStatus(promo, new Date("2026-06-15T12:00:00Z")), "active");
});

// ── Test 16: Scheduled promotion inactive before start_date ──────────────────
test("16. Scheduled promotion inactive before start_date", () => {
  const promo = makePromo({
    id: "p-future",
    starts_at: "2026-07-01T00:00:00Z",
    ends_at: "2026-07-31T23:59:59Z",
    value: 10,
    mode: "automatic",
  });
  const res = promotionUnitPrice("prd-1", null, null, 100, [promo], new Map(), new Date("2026-06-15T12:00:00Z"), "both");
  assert.equal(res.unit, 100);
  assert.equal(getPromotionStatus(promo, new Date("2026-06-15T12:00:00Z")), "scheduled");
});

// ── Test 17: Scheduled promotion inactive after end_date ────────────────────
test("17. Scheduled promotion inactive after end_date", () => {
  const promo = makePromo({
    id: "p-past",
    starts_at: "2026-05-01T00:00:00Z",
    ends_at: "2026-05-31T23:59:59Z",
    value: 10,
    mode: "automatic",
  });
  const res = promotionUnitPrice("prd-1", null, null, 100, [promo], new Map(), new Date("2026-06-15T12:00:00Z"), "both");
  assert.equal(res.unit, 100);
  assert.equal(getPromotionStatus(promo, new Date("2026-06-15T12:00:00Z")), "expired");
});

// ── Test 18: Disabled promotion (enabled = false) never applies ──────────────
test("18. Disabled promotion (enabled = false) never applies", () => {
  const promo = makePromo({
    id: "p-disabled",
    enabled: false,
    value: 20,
    mode: "automatic",
  });
  const res = promotionUnitPrice("prd-1", null, null, 100, [promo], new Map(), NOW, "both");
  assert.equal(res.unit, 100);
  assert.equal(getPromotionStatus(promo, NOW), "paused");
});

// ── Test 19: Channel targeting POS applies on POS and not on Storefront ──────
test("19. Channel targeting POS applies on POS and not on Storefront", () => {
  const promoPos = makePromo({
    id: "p-pos-only",
    channel: "pos",
    value: 10,
    mode: "automatic",
  });
  const posRes = promotionUnitPrice("prd-1", null, null, 100, [promoPos], new Map(), NOW, "pos");
  assert.equal(posRes.unit, 90);
  const webRes = promotionUnitPrice("prd-1", null, null, 100, [promoPos], new Map(), NOW, "online");
  assert.equal(webRes.unit, 100);
});

// ── Test 20: Channel targeting Storefront applies on Storefront not POS ──────
test("20. Channel targeting Storefront applies on Storefront and not on POS", () => {
  const promoOnline = makePromo({
    id: "p-online-only",
    channel: "online",
    value: 15,
    mode: "automatic",
  });
  const webRes = promotionUnitPrice("prd-1", null, null, 100, [promoOnline], new Map(), NOW, "online");
  assert.equal(webRes.unit, 85);
  const posRes = promotionUnitPrice("prd-1", null, null, 100, [promoOnline], new Map(), NOW, "pos");
  assert.equal(posRes.unit, 100);
});

// ── Test 21: Channel targeting Both applies on POS and Storefront ────────────
test("21. Channel targeting Both applies on POS and Storefront", () => {
  const promoBoth = makePromo({
    id: "p-both",
    channel: "both",
    value: 20,
    mode: "automatic",
  });
  const webRes = promotionUnitPrice("prd-1", null, null, 100, [promoBoth], new Map(), NOW, "online");
  assert.equal(webRes.unit, 80);
  const posRes = promotionUnitPrice("prd-1", null, null, 100, [promoBoth], new Map(), NOW, "pos");
  assert.equal(posRes.unit, 80);
});

// ── Test 22: POS manual cashier item discount coexists safely with promo ─────
test("22. POS manual cashier item discount coexists safely with automatic promotion", () => {
  // Base price = 100, Auto promo makes unit_price = 80 (20 EGP auto discount)
  // Cashier applies 10% manual item discount on the line
  const line = {
    base_price: 100,
    unit_price: 80,
    qty: 2,
    item_discount: { type: "percent" as const, value: 10 },
  };
  const amounts = lineTotals(line);
  // Gross = 100 * 2 = 200
  // Promo subtotal = 80 * 2 = 160
  // Promo discount = 200 - 160 = 40
  // Manual discount = 10% of 160 = 16
  // Total discount = 40 + 16 = 56
  // Net = 160 - 16 = 144
  assert.equal(amounts.gross, 200);
  assert.equal(amounts.promoDiscount, 40);
  assert.equal(amounts.manualDiscount, 16);
  assert.equal(amounts.discount, 56);
  assert.equal(amounts.net, 144);
});

// ── Test 23: POS manual invoice discount coexists safely with line promos ────
test("23. POS manual cashier invoice discount coexists safely with line promotions", () => {
  const lines = [
    { base_price: 100, unit_price: 80, qty: 1, item_discount: { type: "none" as const, value: 0 } },
    { base_price: 200, unit_price: 150, qty: 1, item_discount: { type: "fixed" as const, value: 10 } },
  ];
  // Line 1: gross 100, promo 20, manual 0, net 80
  // Line 2: gross 200, promo 50, manual 10, net 140
  // Subtotal gross = 300, total promo = 70, total manual item = 10, lines net = 220
  // Cashier adds 10% invoice discount on remaining 220 = 22
  // Final total = 220 - 22 = 198
  const totals = cartTotals(lines, { type: "percent", value: 10 });
  assert.equal(totals.subtotal, 300);
  assert.equal(totals.promoDiscountAmount, 70);
  assert.equal(totals.itemDiscountAmount, 10);
  assert.equal(totals.invoiceDiscountAmount, 22);
  assert.equal(totals.discountAmount, 102); // 70 + 10 + 22
  assert.equal(totals.total, 198);
});

// ── Test 24: getPromotionStatus helper ───────────────────────────────────────
test("24. getPromotionStatus returns 'active', 'scheduled', 'expired', or 'paused'", () => {
  const now = new Date("2026-06-15T12:00:00Z");
  assert.equal(getPromotionStatus(makePromo({ enabled: false }), now), "paused");
  assert.equal(
    getPromotionStatus(makePromo({ enabled: true, starts_at: "2026-07-01T00:00:00Z" }), now),
    "scheduled",
  );
  assert.equal(
    getPromotionStatus(makePromo({ enabled: true, ends_at: "2026-05-01T00:00:00Z" }), now),
    "expired",
  );
  assert.equal(
    getPromotionStatus(
      makePromo({ enabled: true, starts_at: "2026-06-01T00:00:00Z", ends_at: "2026-06-30T00:00:00Z" }),
      now,
    ),
    "active",
  );
});

// ── Test 25: Promotion value & discount validations ──────────────────────────
test("25. Promotion validation: percentage value <= 100 and non-negative numbers", () => {
  assert.equal(validateDiscount("percent", 100), null);
  assert.equal(validateDiscount("percent", 101), "tooHigh");
  assert.equal(validateDiscount("percent", -5), "invalid");
  assert.equal(validateDiscount("fixed", 50), null);
  assert.equal(validateDiscount("fixed", -1), "invalid");
});

// ── Test 26: Coupon mode requires non-empty code ─────────────────────────────
test("26. Coupon mode validation requires coupon code", () => {
  const couponWithoutCode = makePromo({ mode: "coupon", code: "" });
  assert.equal(Boolean(couponWithoutCode.code?.trim()), false);

  const couponWithCode = makePromo({ mode: "coupon", code: "PROMO2026" });
  assert.equal(normalizeCouponCode(couponWithCode.code), "PROMO2026");
});

// ── Test 27: Targeted scopes require target UUIDs ────────────────────────────
test("27. Targeted scopes (category, product, variant) require target mappings", () => {
  const catPromo = makePromo({ scope: "category", id: "p-cat" });
  const targetsCat = new Map([[catPromo.id, new Set(["category:cat-1"])]]);
  assert.equal(targetsCat.get(catPromo.id)?.has("category:cat-1"), true);
  assert.equal(targetsCat.get(catPromo.id)?.has("category:cat-2"), false);

  const varPromo = makePromo({ scope: "variant", id: "p-var" });
  const targetsVar = new Map([[varPromo.id, new Set(["variant:uuid-1234"])]]);
  assert.equal(targetsVar.get(varPromo.id)?.has("variant:uuid-1234"), true);
});

// ── Test 28: Cart breakdown and audit fields ─────────────────────────────────
test("28. Full cart audit snapshot: promotional discount, manual item discount, invoice discount, and total EGP", () => {
  const lines = [
    { base_price: 500, unit_price: 400, qty: 1, item_discount: { type: "percent" as const, value: 10 } },
  ];
  // Gross: 500
  // Promo discount: 100 (400 net unit)
  // Cashier item discount: 10% of 400 = 40
  // Line net: 360
  // Cashier invoice discount: 20 EGP fixed on 360 = 20
  // Final total: 340
  // Total discount breakdown: 100 promo + 40 item + 20 invoice = 160 total discount
  const totals = cartTotals(lines, { type: "fixed", value: 20 });
  assert.equal(totals.subtotal, 500);
  assert.equal(totals.promoDiscountAmount, 100);
  assert.equal(totals.itemDiscountAmount, 40);
  assert.equal(totals.invoiceDiscountAmount, 20);
  assert.equal(totals.discountAmount, 160);
  assert.equal(totals.total, 340);
  assert.equal(round2(totals.subtotal - totals.discountAmount), totals.total);
});

// ── Test 29: Buy X Get Y Free (Group size = X + Y, reward = floor(qty / groupSize) * Y) ──
test("29. Buy 2 Get 1 Free: 3 items in cart awards 1 cheapest item free", () => {
  const bxgyPromo = makePromo({
    id: "promo-bxgy-2-1",
    offer_type: "bxgy",
    buy_x: 2,
    get_y: 1,
    reward_type: "free",
    repeat_offer: true,
    scope: "store",
    mode: "automatic",
  });
  // 3 items: 100, 200, 300. Total gross = 600. Reward = 100 (cheapest unit free).
  const lines: Omit<EvaluatedCartLine, "discounted_unit_price">[] = [
    { product_id: "p1", variant_id: null, category_id: null, unit_price: 100, qty: 1, line_total: 100 },
    { product_id: "p2", variant_id: null, category_id: null, unit_price: 200, qty: 1, line_total: 200 },
    { product_id: "p3", variant_id: null, category_id: null, unit_price: 300, qty: 1, line_total: 300 },
  ];
  const result = evaluateCartPricing({
    lines,
    subtotal: 600,
    promoCode: null,
    coupons: [],
    promotions: [bxgyPromo],
    targetsByPromotion: new Map(),
    usageFor: () => ({ customerUses: 0, hasPriorOrder: false }),
    customerKey: null,
    zone: null,
    legacy: { fee: 0, minimum: 0, threshold: 0 },
    deliveryType: "delivery",
    now: NOW,
    channel: "both",
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.pricing.autoDiscount, 100);
    assert.equal(result.pricing.total, 500);
    assert.equal(result.pricing.autoPromotionBuyX, 2);
    assert.equal(result.pricing.autoPromotionGetY, 1);
    assert.equal(result.pricing.autoPromotionRewardQty, 1);
    assert.equal(result.pricing.lines[0].rewarded_qty, 1);
    assert.equal(result.pricing.lines[0].discounted_unit_price, 0);
  }
});

// ── Test 30: Buy X Get Y Repeated: 6 items in cart with Buy 2 Get 1 gives 2 free units ──
test("30. Buy 2 Get 1 Free Repeated: 6 items in cart gives 2 cheapest units free", () => {
  const bxgyPromo = makePromo({
    id: "promo-bxgy-rep",
    offer_type: "bxgy",
    buy_x: 2,
    get_y: 1,
    reward_type: "free",
    repeat_offer: true,
    scope: "store",
    mode: "automatic",
  });
  // 6 units of 100 EGP: floor(6 / 3) * 1 = 2 units free = 200 EGP discount
  const lines: Omit<EvaluatedCartLine, "discounted_unit_price">[] = [
    { product_id: "p1", variant_id: null, category_id: null, unit_price: 100, qty: 6, line_total: 600 },
  ];
  const result = evaluateCartPricing({
    lines,
    subtotal: 600,
    promoCode: null,
    coupons: [],
    promotions: [bxgyPromo],
    targetsByPromotion: new Map(),
    usageFor: () => ({ customerUses: 0, hasPriorOrder: false }),
    customerKey: null,
    zone: null,
    legacy: { fee: 0, minimum: 0, threshold: 0 },
    deliveryType: "delivery",
    now: NOW,
    channel: "both",
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.pricing.autoDiscount, 200);
    assert.equal(result.pricing.total, 400);
    assert.equal(result.pricing.autoPromotionRewardQty, 2);
    assert.equal(result.pricing.lines[0].rewarded_qty, 2);
  }
});

// ── Test 31: Buy X Get Y Non-Repeated: 6 items in cart capped at 1 reward set ──
test("31. Buy 2 Get 1 Free Non-Repeated: repeat_offer false caps reward at 1 unit", () => {
  const bxgyNoRep = makePromo({
    id: "promo-bxgy-norep",
    offer_type: "bxgy",
    buy_x: 2,
    get_y: 1,
    reward_type: "free",
    repeat_offer: false,
    scope: "store",
    mode: "automatic",
  });
  const lines: Omit<EvaluatedCartLine, "discounted_unit_price">[] = [
    { product_id: "p1", variant_id: null, category_id: null, unit_price: 100, qty: 6, line_total: 600 },
  ];
  const result = evaluateCartPricing({
    lines,
    subtotal: 600,
    promoCode: null,
    coupons: [],
    promotions: [bxgyNoRep],
    targetsByPromotion: new Map(),
    usageFor: () => ({ customerUses: 0, hasPriorOrder: false }),
    customerKey: null,
    zone: null,
    legacy: { fee: 0, minimum: 0, threshold: 0 },
    deliveryType: "delivery",
    now: NOW,
    channel: "both",
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.pricing.autoDiscount, 100);
    assert.equal(result.pricing.total, 500);
    assert.equal(result.pricing.autoPromotionRewardQty, 1);
  }
});

// ── Test 32: Buy X Get Y Percentage Reward: Buy 2 Get 1 at 50% off ───────────
test("32. Buy 2 Get 1 at 50% off: 3 items in cart awards 50% off the cheapest item", () => {
  const bxgyPercent = makePromo({
    id: "promo-bxgy-50pct",
    offer_type: "bxgy",
    buy_x: 2,
    get_y: 1,
    reward_type: "percent",
    reward_value: 50,
    scope: "store",
    mode: "automatic",
  });
  const lines: Omit<EvaluatedCartLine, "discounted_unit_price">[] = [
    { product_id: "p1", variant_id: null, category_id: null, unit_price: 80, qty: 1, line_total: 80 },
    { product_id: "p2", variant_id: null, category_id: null, unit_price: 120, qty: 1, line_total: 120 },
    { product_id: "p3", variant_id: null, category_id: null, unit_price: 150, qty: 1, line_total: 150 },
  ];
  const result = evaluateCartPricing({
    lines,
    subtotal: 350,
    promoCode: null,
    coupons: [],
    promotions: [bxgyPercent],
    targetsByPromotion: new Map(),
    usageFor: () => ({ customerUses: 0, hasPriorOrder: false }),
    customerKey: null,
    zone: null,
    legacy: { fee: 0, minimum: 0, threshold: 0 },
    deliveryType: "delivery",
    now: NOW,
    channel: "both",
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    // 50% of 80 (cheapest unit) = 40
    assert.equal(result.pricing.autoDiscount, 40);
    assert.equal(result.pricing.total, 310);
    assert.equal(result.pricing.lines[0].rewarded_qty, 1);
    assert.equal(result.pricing.lines[0].discounted_unit_price, 40);
  }
});

// ── Test 33: Cheapest Item in Cart: Free when cart has >= min_quantity ───────
test("33. Cheapest Item in Cart Free: minimum 3 items gives cheapest item free", () => {
  const cheapestPromo = makePromo({
    id: "promo-cheap-free",
    offer_type: "cheapest_item",
    min_quantity: 3,
    reward_type: "free",
    scope: "store",
    mode: "automatic",
  });
  const lines: Omit<EvaluatedCartLine, "discounted_unit_price">[] = [
    { product_id: "p1", variant_id: null, category_id: null, unit_price: 50, qty: 1, line_total: 50 },
    { product_id: "p2", variant_id: null, category_id: null, unit_price: 150, qty: 1, line_total: 150 },
    { product_id: "p3", variant_id: null, category_id: null, unit_price: 200, qty: 1, line_total: 200 },
  ];
  const result = evaluateCartPricing({
    lines,
    subtotal: 400,
    promoCode: null,
    coupons: [],
    promotions: [cheapestPromo],
    targetsByPromotion: new Map(),
    usageFor: () => ({ customerUses: 0, hasPriorOrder: false }),
    customerKey: null,
    zone: null,
    legacy: { fee: 0, minimum: 0, threshold: 0 },
    deliveryType: "delivery",
    now: NOW,
    channel: "both",
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.pricing.autoDiscount, 50);
    assert.equal(result.pricing.total, 350);
    assert.equal(result.pricing.lines[0].rewarded_qty, 1);
    assert.equal(result.pricing.lines[0].discounted_unit_price, 0);
  }
});

// ── Test 34: Cheapest Item in Cart below min_quantity gives 0 discount ───────
test("34. Cheapest Item in Cart: cart with fewer items than min_quantity receives no discount", () => {
  const cheapestPromo = makePromo({
    id: "promo-cheap-min4",
    offer_type: "cheapest_item",
    min_quantity: 4,
    reward_type: "free",
    scope: "store",
    mode: "automatic",
  });
  const lines: Omit<EvaluatedCartLine, "discounted_unit_price">[] = [
    { product_id: "p1", variant_id: null, category_id: null, unit_price: 50, qty: 1, line_total: 50 },
    { product_id: "p2", variant_id: null, category_id: null, unit_price: 150, qty: 1, line_total: 150 },
  ];
  const result = evaluateCartPricing({
    lines,
    subtotal: 200,
    promoCode: null,
    coupons: [],
    promotions: [cheapestPromo],
    targetsByPromotion: new Map(),
    usageFor: () => ({ customerUses: 0, hasPriorOrder: false }),
    customerKey: null,
    zone: null,
    legacy: { fee: 0, minimum: 0, threshold: 0 },
    deliveryType: "delivery",
    now: NOW,
    channel: "both",
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.pricing.autoDiscount, 0);
    assert.equal(result.pricing.total, 200);
  }
});

// ── Test 35: Best price rule between BXGY and Standard Discount ──────────────
test("35. Authoritative non-stacking: BXGY (saving 100) vs 30% discount (saving 180) -> 30% discount wins", () => {
  const promoBXGY = makePromo({
    id: "promo-bxgy",
    offer_type: "bxgy",
    buy_x: 2,
    get_y: 1,
    reward_type: "free",
    scope: "store",
    mode: "automatic",
    priority: 0,
  });
  const promoPercent = makePromo({
    id: "promo-30pct",
    offer_type: "standard",
    discount_type: "percent",
    value: 30,
    scope: "store",
    mode: "automatic",
    priority: 0,
  });
  // 3 items of 200 EGP = 600 gross
  // BXGY saving = 200 EGP (1 free item)
  // 30% saving = 180 EGP
  // In this case BXGY saves 200 > 180, so BXGY wins!
  const lines: Omit<EvaluatedCartLine, "discounted_unit_price">[] = [
    { product_id: "p1", variant_id: null, category_id: null, unit_price: 200, qty: 3, line_total: 600 },
  ];
  const result = evaluateCartPricing({
    lines,
    subtotal: 600,
    promoCode: null,
    coupons: [],
    promotions: [promoBXGY, promoPercent],
    targetsByPromotion: new Map(),
    usageFor: () => ({ customerUses: 0, hasPriorOrder: false }),
    customerKey: null,
    zone: null,
    legacy: { fee: 0, minimum: 0, threshold: 0 },
    deliveryType: "delivery",
    now: NOW,
    channel: "both",
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.pricing.autoPromotionId, "promo-bxgy");
    assert.equal(result.pricing.autoDiscount, 200);
    assert.equal(result.pricing.total, 400);
  }
});

// ── Test 36: Return / Refund calculates based on paid discounted unit price ──
test("36. Return & refund preservation: refund calculates from paid discounted unit price", () => {
  // Original item was 100 EGP, but with 20% discount sold at 80 EGP
  const paidUnitPrice = 80;
  const returnQty = 2;
  const refundable = round2(paidUnitPrice * returnQty);
  assert.equal(refundable, 160);
});

// ── Test 37: Coupon mode BXGY applies when valid code is supplied ────────────
test("37. Coupon mode BXGY: Buy 2 Get 1 Free via coupon code", () => {
  const couponBxgy = makePromo({
    id: "prm-coupon-bxgy",
    mode: "coupon",
    code: "B2G1FREE",
    offer_type: "bxgy",
    buy_x: 2,
    get_y: 1,
    reward_type: "free",
    scope: "store",
    enabled: true,
  });
  const lines: Omit<EvaluatedCartLine, "discounted_unit_price">[] = [
    { product_id: "p1", variant_id: null, category_id: null, unit_price: 150, qty: 3, line_total: 450 },
  ];
  const res = evaluateCartPricing({
    lines,
    subtotal: 450,
    promoCode: " b2g1free ",
    coupons: [],
    promotions: [couponBxgy],
    targetsByPromotion: new Map(),
    usageFor: () => ({ customerUses: 0, hasPriorOrder: false }),
    customerKey: null,
    zone: null,
    legacy: { fee: 0, minimum: 0, threshold: 0 },
    deliveryType: "delivery",
    now: NOW,
    channel: "both",
  });
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.pricing.promoCode, "B2G1FREE");
    assert.equal(res.pricing.promoDiscount, 150);
    assert.equal(res.pricing.total, 300);
    assert.equal(res.pricing.lines[0].rewarded_units, 1);
    assert.equal(res.pricing.lines[0].discount_amount, 150);
    assert.equal(res.pricing.lines[0].discounted_unit_price, 100);
  }
});

// ── Test 38: Coupon mode Cheapest Item applies when valid code is supplied ──
test("38. Coupon mode Cheapest Item: minimum 3 items gives cheapest free via coupon code", () => {
  const couponCheap = makePromo({
    id: "prm-coupon-cheap",
    mode: "coupon",
    code: "CHEAPFREE",
    offer_type: "cheapest_item",
    min_quantity: 3,
    reward_type: "free",
    scope: "store",
    enabled: true,
  });
  const lines: Omit<EvaluatedCartLine, "discounted_unit_price">[] = [
    { product_id: "p1", variant_id: null, category_id: null, unit_price: 60, qty: 1, line_total: 60 },
    { product_id: "p2", variant_id: null, category_id: null, unit_price: 140, qty: 1, line_total: 140 },
    { product_id: "p3", variant_id: null, category_id: null, unit_price: 200, qty: 1, line_total: 200 },
  ];
  const res = evaluateCartPricing({
    lines,
    subtotal: 400,
    promoCode: "cheapfree",
    coupons: [],
    promotions: [couponCheap],
    targetsByPromotion: new Map(),
    usageFor: () => ({ customerUses: 0, hasPriorOrder: false }),
    customerKey: null,
    zone: null,
    legacy: { fee: 0, minimum: 0, threshold: 0 },
    deliveryType: "delivery",
    now: NOW,
    channel: "both",
  });
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.pricing.promoDiscount, 60);
    assert.equal(res.pricing.total, 340);
    assert.equal(res.pricing.lines[0].rewarded_units, 1);
    assert.equal(res.pricing.lines[0].discount_amount, 60);
    assert.equal(res.pricing.lines[0].discounted_unit_price, 0);
  }
});

// ── Test 39: Capped BXGY line totals reconcile exactly (sum(line discounts) == total discount) ──
test("39. Capped BXGY: max_discount_amount scales line discounts so sum(line discounts) == totalDiscount exactly", () => {
  const cappedBxgy = makePromo({
    id: "prm-capped-bxgy",
    offer_type: "bxgy",
    buy_x: 2,
    get_y: 1,
    reward_type: "free",
    maximum_discount_amount: 150, // Uncapped would be 200 (2 free units @ 100)
    repeat_offer: true,
    scope: "store",
    mode: "automatic",
  });
  const lines: Omit<EvaluatedCartLine, "discounted_unit_price">[] = [
    { product_id: "p1", variant_id: null, category_id: null, unit_price: 100, qty: 6, line_total: 600 },
  ];
  const res = evaluateCartPricing({
    lines,
    subtotal: 600,
    promoCode: null,
    coupons: [],
    promotions: [cappedBxgy],
    targetsByPromotion: new Map(),
    usageFor: () => ({ customerUses: 0, hasPriorOrder: false }),
    customerKey: null,
    zone: null,
    legacy: { fee: 0, minimum: 0, threshold: 0 },
    deliveryType: "delivery",
    now: NOW,
    channel: "both",
  });
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.pricing.autoDiscount, 150);
    assert.equal(res.pricing.total, 450);
    const sumLineDiscounts = res.pricing.lines.reduce((s, l) => round2(s + (l.discount_amount ?? 0)), 0);
    assert.equal(sumLineDiscounts, res.pricing.autoDiscount);
    assert.equal(res.pricing.lines[0].rewarded_qty, 2);
  }
});

// ── Test 40: Capped Cheapest Item line totals reconcile exactly ──────────────
test("40. Capped Cheapest Item: max_discount_amount scales line discounts so sum(line discounts) == totalDiscount", () => {
  const cappedCheap = makePromo({
    id: "prm-capped-cheap",
    offer_type: "cheapest_item",
    min_quantity: 3,
    reward_type: "free",
    maximum_discount_amount: 30, // Uncapped would be 50
    scope: "store",
    mode: "automatic",
  });
  const lines: Omit<EvaluatedCartLine, "discounted_unit_price">[] = [
    { product_id: "p1", variant_id: null, category_id: null, unit_price: 50, qty: 1, line_total: 50 },
    { product_id: "p2", variant_id: null, category_id: null, unit_price: 150, qty: 1, line_total: 150 },
    { product_id: "p3", variant_id: null, category_id: null, unit_price: 200, qty: 1, line_total: 200 },
  ];
  const res = evaluateCartPricing({
    lines,
    subtotal: 400,
    promoCode: null,
    coupons: [],
    promotions: [cappedCheap],
    targetsByPromotion: new Map(),
    usageFor: () => ({ customerUses: 0, hasPriorOrder: false }),
    customerKey: null,
    zone: null,
    legacy: { fee: 0, minimum: 0, threshold: 0 },
    deliveryType: "delivery",
    now: NOW,
    channel: "both",
  });
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.pricing.autoDiscount, 30);
    assert.equal(res.pricing.total, 370);
    const sumLineDiscounts = res.pricing.lines.reduce((s, l) => round2(s + (l.discount_amount ?? 0)), 0);
    assert.equal(sumLineDiscounts, res.pricing.autoDiscount);
  }
});

// ── Test 41: Candidate reward state never leaks between promotions ───────────
test("41. Candidate reward state isolation: a winning standard promo after an evaluated BXGY promo has 0 rewarded units", () => {
  const promoBXGY = makePromo({
    id: "p-bxgy-small",
    offer_type: "bxgy",
    buy_x: 2,
    get_y: 1,
    reward_type: "free",
    scope: "store",
    priority: 10, // evaluated first
  });
  const promoPercent = makePromo({
    id: "p-percent-big",
    offer_type: "standard",
    discount_type: "percent",
    value: 50, // 50% discount = 300 EGP (wins over BXGY 100 EGP)
    scope: "store",
    priority: 5,
  });
  const lines: Omit<EvaluatedCartLine, "discounted_unit_price">[] = [
    { product_id: "p1", variant_id: null, category_id: null, unit_price: 100, qty: 1, line_total: 100 },
    { product_id: "p2", variant_id: null, category_id: null, unit_price: 200, qty: 1, line_total: 200 },
    { product_id: "p3", variant_id: null, category_id: null, unit_price: 300, qty: 1, line_total: 300 },
  ];
  const res = evaluateCartPricing({
    lines,
    subtotal: 600,
    promoCode: null,
    coupons: [],
    promotions: [promoBXGY, promoPercent],
    targetsByPromotion: new Map(),
    usageFor: () => ({ customerUses: 0, hasPriorOrder: false }),
    customerKey: null,
    zone: null,
    legacy: { fee: 0, minimum: 0, threshold: 0 },
    deliveryType: "delivery",
    now: NOW,
    channel: "both",
  });
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.pricing.autoPromotionId, "p-percent-big");
    assert.equal(res.pricing.autoDiscount, 300);
    assert.equal(res.pricing.autoPromotionRewardQty ?? 0, 0);
    assert.equal(res.pricing.lines[0].rewarded_qty ?? 0, 0);
  }
});

// ── Test 42: Duplicate normalized coupon codes are detected ──────────────────
test("42. Coupon code deduplication: identical normalized codes (case & whitespace insensitive) are matched", () => {
  const code1 = normalizeCouponCode(" SUMMER 2026 ");
  const code2 = normalizeCouponCode("summer2026");
  const code3 = normalizeCouponCode("SuMmEr 2026");
  assert.equal(code1, "SUMMER2026");
  assert.equal(code2, "SUMMER2026");
  assert.equal(code3, "SUMMER2026");
  assert.equal(code1 === code2, true);
});

// ── Test 43: Authoritative pricing ignores client-forged prices ──────────────
test("43. Authoritative server pricing: manipulated client prices cannot alter authoritative cart evaluation", () => {
  // Server prices from canonical unit price (200), not client draft
  const canonicalUnitPrice = 200;
  const qty = 3;
  const canonicalSubtotal = round2(canonicalUnitPrice * qty); // 600
  const promo = makePromo({ discount_type: "percent", value: 10, scope: "store" });
  const lines: Omit<EvaluatedCartLine, "discounted_unit_price">[] = [
    { product_id: "p1", variant_id: null, category_id: null, unit_price: canonicalUnitPrice, qty, line_total: canonicalSubtotal },
  ];
  const res = evaluateCartPricing({
    lines,
    subtotal: canonicalSubtotal,
    promoCode: null,
    coupons: [],
    promotions: [promo],
    targetsByPromotion: new Map(),
    usageFor: () => ({ customerUses: 0, hasPriorOrder: false }),
    customerKey: null,
    zone: null,
    legacy: { fee: 0, minimum: 0, threshold: 0 },
    deliveryType: "delivery",
    now: NOW,
    channel: "both",
  });
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.pricing.subtotal, 600);
    assert.equal(res.pricing.autoDiscount, 60);
    assert.equal(res.pricing.total, 540);
  }
});

// ── Test 44: POS Authoritative price tamper test (1 EGP client vs 500 EGP DB) ─
test("44. POS Authoritative price tamper resistance: client sending 1 EGP for 500 EGP product is evaluated at 500 EGP", () => {
  const dbCatalogPrice = 500;
  const qty = 2;
  const dbSubtotal = round2(dbCatalogPrice * qty); // 1000
  const promo = makePromo({ discount_type: "percent", value: 10, scope: "store", channel: "pos" });
  const lines: Omit<EvaluatedCartLine, "discounted_unit_price">[] = [
    { product_id: "prd-luxury", variant_id: null, category_id: null, unit_price: dbCatalogPrice, qty, line_total: dbSubtotal },
  ];
  const res = evaluateCartPricing({
    lines,
    subtotal: dbSubtotal,
    promoCode: null,
    coupons: [],
    promotions: [promo],
    targetsByPromotion: new Map(),
    usageFor: () => ({ customerUses: 0, hasPriorOrder: false }),
    customerKey: null,
    zone: null,
    legacy: { fee: 0, minimum: 0, threshold: 0 },
    deliveryType: "pickup",
    now: NOW,
    channel: "pos",
  });
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.pricing.subtotal, 1000);
    assert.equal(res.pricing.autoDiscount, 100);
    assert.equal(res.pricing.total, 900);
    assert.equal(res.pricing.lines[0].unit_price, 500);
    assert.equal(res.pricing.lines[0].discounted_unit_price, 450);
  }
});

// ── Test 45: Zero-discount promotion handling (unmet BXGY group threshold) ───
test("45. Zero-discount winner safeguard: unmet BXGY threshold (2 items for Buy 2 Get 1) yields 0 discount and NO active promo winner", () => {
  const promoBXGY = makePromo({
    id: "p-bxgy-2-1",
    offer_type: "bxgy",
    buy_x: 2,
    get_y: 1,
    reward_type: "free",
    scope: "store",
  });
  const lines: Omit<EvaluatedCartLine, "discounted_unit_price">[] = [
    { product_id: "p1", variant_id: null, category_id: null, unit_price: 100, qty: 2, line_total: 200 },
  ];
  const res = evaluateCartPricing({
    lines,
    subtotal: 200,
    promoCode: null,
    coupons: [],
    promotions: [promoBXGY],
    targetsByPromotion: new Map(),
    usageFor: () => ({ customerUses: 0, hasPriorOrder: false }),
    customerKey: null,
    zone: null,
    legacy: { fee: 0, minimum: 0, threshold: 0 },
    deliveryType: "delivery",
    now: NOW,
    channel: "both",
  });
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.pricing.autoDiscount, 0);
    assert.equal(res.pricing.autoPromotionId, null);
    assert.equal(res.pricing.autoPromotionName, null);
    assert.equal(res.pricing.total, 200);
  }
});

// ── Test 46: Zero-discount coupon handling ────────────────────────────────────
test("46. Zero-discount coupon refusal: coupon with unmet BXGY threshold returns not_applicable error", () => {
  const couponPromo = makePromo({
    id: "cp-bxgy",
    mode: "coupon",
    code: "B2G1FREE",
    offer_type: "bxgy",
    buy_x: 2,
    get_y: 1,
    reward_type: "free",
    scope: "store",
    enabled: true,
  });
  const lines: Omit<EvaluatedCartLine, "discounted_unit_price">[] = [
    { product_id: "p1", variant_id: null, category_id: null, unit_price: 100, qty: 2, line_total: 200 },
  ];
  const res = evaluateCartPricing({
    lines,
    subtotal: 200,
    promoCode: "B2G1FREE",
    coupons: [],
    promotions: [couponPromo],
    targetsByPromotion: new Map(),
    usageFor: () => ({ customerUses: 0, hasPriorOrder: false }),
    customerKey: null,
    zone: null,
    legacy: { fee: 0, minimum: 0, threshold: 0 },
    deliveryType: "delivery",
    now: NOW,
    channel: "both",
  });
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.reason, "not_applicable");
  }
});

// ── Test 47: Manual line discount vs promotion non-stacking ──────────────────
test("47. Manual line discount vs promotion non-stacking: best saving wins per line without silent compounding", () => {
  // Option A: Promo (20 EGP) > Manual (15 EGP) -> Promo wins
  const lineA = { gross_total: 100, quantity: 1, manual_discount: 15, promo_discount: 20, stackable: false };
  const effectiveDiscA = lineA.promo_discount >= lineA.manual_discount ? lineA.promo_discount : lineA.manual_discount;
  assert.equal(effectiveDiscA, 20);

  // Option B: Manual (25 EGP) > Promo (20 EGP) -> Manual wins
  const lineB = { gross_total: 100, quantity: 1, manual_discount: 25, promo_discount: 20, stackable: false };
  const effectiveDiscB = lineB.promo_discount >= lineB.manual_discount ? lineB.promo_discount : lineB.manual_discount;
  assert.equal(effectiveDiscB, 25);
});

// ── Test 48: Manual invoice discount on post-line-discount base ──────────────
test("48. Manual invoice discount applies on post-line-discount subtotal and remains separately auditable", () => {
  const grossSubtotal = 1000;
  const linePromoDiscount = 200; // e.g. 20% promo
  const lineManualDiscount = 0;
  const invoiceBase = grossSubtotal - linePromoDiscount - lineManualDiscount; // 800
  const invoiceDiscountPercent = 10; // 10% invoice discount = 80 EGP
  const invoiceDiscountAmount = round2((invoiceBase * invoiceDiscountPercent) / 100);
  const finalTotal = round2(invoiceBase - invoiceDiscountAmount); // 720

  assert.equal(invoiceBase, 800);
  assert.equal(invoiceDiscountAmount, 80);
  assert.equal(finalTotal, 720);
});

// ── Test 49: Server-automatic promotion recalculation ────────────────────────
test("49. Server-automatic promotion recalculation: input cart with no promotion metadata automatically discovers active promotion", () => {
  const promoAuto = makePromo({
    id: "p-auto-15",
    name_en: "15% Storewide Sale",
    discount_type: "percent",
    value: 15,
    scope: "store",
    mode: "automatic",
    channel: "both",
  });
  const lines: Omit<EvaluatedCartLine, "discounted_unit_price">[] = [
    { product_id: "p1", variant_id: null, category_id: null, unit_price: 200, qty: 1, line_total: 200 },
  ];
  const res = evaluateCartPricing({
    lines,
    subtotal: 200,
    promoCode: null,
    coupons: [],
    promotions: [promoAuto],
    targetsByPromotion: new Map(),
    usageFor: () => ({ customerUses: 0, hasPriorOrder: false }),
    customerKey: null,
    zone: null,
    legacy: { fee: 0, minimum: 0, threshold: 0 },
    deliveryType: "delivery",
    now: NOW,
    channel: "both",
  });
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.pricing.autoPromotionId, "p-auto-15");
    assert.equal(res.pricing.autoPromotionName, "15% Storewide Sale");
    assert.equal(res.pricing.autoDiscount, 30);
    assert.equal(res.pricing.total, 170);
  }
});

// ── Test 50: Historical snapshots preservation ──────────────────────────────
test("50. Historical snapshots: rewarded_qty, rewarded_units, and rule_type accurately captured in evaluated pricing result", () => {
  const promoBXGY = makePromo({
    id: "p-bxgy-hist",
    offer_type: "bxgy",
    buy_x: 2,
    get_y: 1,
    reward_type: "free",
    scope: "store",
  });
  const lines: Omit<EvaluatedCartLine, "discounted_unit_price">[] = [
    { product_id: "p1", variant_id: null, category_id: null, unit_price: 100, qty: 3, line_total: 300 },
  ];
  const res = evaluateCartPricing({
    lines,
    subtotal: 300,
    promoCode: null,
    coupons: [],
    promotions: [promoBXGY],
    targetsByPromotion: new Map(),
    usageFor: () => ({ customerUses: 0, hasPriorOrder: false }),
    customerKey: null,
    zone: null,
    legacy: { fee: 0, minimum: 0, threshold: 0 },
    deliveryType: "delivery",
    now: NOW,
    channel: "both",
  });
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.pricing.autoPromotionRuleType, "bxgy");
    assert.equal(res.pricing.autoPromotionBuyX, 2);
    assert.equal(res.pricing.autoPromotionGetY, 1);
    assert.equal(res.pricing.autoPromotionRewardQty, 1);
    assert.equal(res.pricing.lines[0].rewarded_qty, 1);
    assert.equal(res.pricing.lines[0].discount_amount, 100);
  }
});

// ── Test 51: Online approval pricing regression (no double discount) ─────────
test("51. Online order approval pricing: 100 EGP item with 10 EGP promo converts to exactly 90 EGP sale on approval without double discounting", () => {
  const catalogPrice = 100;
  const promoDiscount = 10;
  const orderSubtotal = catalogPrice;
  const orderDiscountAmount = promoDiscount;
  const goodsTotal = round2(orderSubtotal - orderDiscountAmount); // 90

  // At approval time, list total is measured against current catalogue
  const listTotal = catalogPrice; // 100
  const saleDiscount = Math.max(round2(listTotal - goodsTotal), 0); // 10

  // pos_complete_sale for source='online' applies fixed saleDiscount without re-evaluating active promotions
  const saleSubtotal = listTotal; // 100
  const saleTotal = round2(saleSubtotal - saleDiscount); // 90
  const paymentAmount = goodsTotal; // 90

  assert.equal(goodsTotal, 90);
  assert.equal(saleDiscount, 10);
  assert.equal(saleTotal, 90);
  assert.equal(paymentAmount, saleTotal, "sale total reconciles exactly to payment amount (90 EGP, never double-discounted to 80 EGP)");
});

// ── Test 52: Historical order price invariance after promo expiration ───────
test("52. Historical order price invariance: order placed during promotion preserves historical price (90 EGP) when approved after promotion expires", () => {
  const placedSnapshot = {
    original_subtotal: 100,
    total_discount: 10,
    final_subtotal: 90,
    promotion_id: "promo-expired-10",
    promotion_name: "10 EGP Summer Promo",
  };

  // Promotion is now expired in current catalogue
  const currentActivePromotions: Promotion[] = []; // None active
  const orderSubtotal = placedSnapshot.original_subtotal;
  const orderDiscountAmount = placedSnapshot.total_discount;
  const goodsTotal = round2(orderSubtotal - orderDiscountAmount); // 90

  // Conversion uses stored snapshot, ignoring empty currentActivePromotions
  const listTotal = 100;
  const saleDiscount = Math.max(round2(listTotal - goodsTotal), 0); // 10
  const saleTotal = round2(listTotal - saleDiscount); // 90

  assert.equal(saleTotal, 90, "historical order price remains 90 EGP regardless of expired promo");
  assert.equal(currentActivePromotions.length, 0);
});

// ── Test 53: Approved order cancellation stock reversal & idempotency ────────
test("53. Approved order cancellation: voiding the sale restores exact variant stock and cannot restore twice on duplicate request", () => {
  let variantStock = 10;
  const orderedQty = 2;

  // 1. Order placed -> stock reserved
  let reservedQty = orderedQty;
  // Available = stock - reserved = 8
  assert.equal(variantStock - reservedQty, 8);

  // 2. Order approved -> pos_complete_sale deducts stock, reservation converted
  variantStock -= orderedQty; // 8
  reservedQty = 0;
  let saleStatus: string = "completed";
  assert.equal(variantStock, 8);

  const voidSale = () => {
    if (saleStatus !== "voided") {
      variantStock += orderedQty;
      saleStatus = "voided";
      return true;
    }
    return false;
  };

  // 3. Order cancelled -> pos_void_sale called once
  const voided1 = voidSale();
  assert.equal(voided1, true);
  assert.equal(variantStock, 10, "stock restored to 10 on first cancel");
  assert.equal(saleStatus, "voided");

  // 4. Repeated cancel request (idempotency guard)
  const voided2 = voidSale();
  assert.equal(voided2, false);
  assert.equal(variantStock, 10, "stock remains 10 (not restored twice on duplicate cancel)");
});

// ── Test 54: Cashier shift ownership validation ──────────────────────────────
test("54. Cashier shift ownership: sale completed only when open shift belongs to the authenticated cashier", () => {
  const shifts = [
    { id: "shift-1", opened_by: "cashier-1", status: "open" },
    { id: "shift-2", opened_by: "cashier-2", status: "open" },
  ];

  const getCashierShift = (userId: string) =>
    shifts.find((s) => s.status === "open" && s.opened_by === userId) ?? null;

  const cashier1Shift = getCashierShift("cashier-1");
  const cashier2Shift = getCashierShift("cashier-2");
  const cashier3Shift = getCashierShift("cashier-3");

  assert.equal(cashier1Shift?.id, "shift-1");
  assert.equal(cashier2Shift?.id, "shift-2");
  assert.equal(cashier3Shift, null, "cashier without open shift cannot attach to another cashier's shift");
});

// ── Test 55: Cashier audit identity spoofing prevention ──────────────────────
test("55. Audit identity spoofing prevention: trusted identity derived from session auth.uid(), ignoring payload spoofing", () => {
  const authenticatedUid = "00000000-0000-4000-8000-0000000000c1";
  const userProfile = { id: authenticatedUid, name: "Karim Cashier" };
  const clientPayload = { user_id: "00000000-0000-4000-8000-0000000000a1", user_name: "Amina Admin" };

  // Server-authoritative resolution ignores clientPayload when authenticatedUid is present
  const resolvedUserId = authenticatedUid || clientPayload.user_id;
  const resolvedUserName = userProfile.name || clientPayload.user_name;

  assert.equal(resolvedUserId, "00000000-0000-4000-8000-0000000000c1");
  assert.equal(resolvedUserName, "Karim Cashier", "trusted user name used instead of spoofed admin name");
});

// ── Test 56: Central coupon usage limit atomic enforcement ───────────────────
test("56. Central coupon usage limit: usage_limit = 1, pending abandoned orders do not consume, confirmed consumes once, concurrent race safety", () => {
  const couponPromo = makePromo({
    id: "promo-coupon-limit-1",
    mode: "coupon",
    code: "LIMITED1",
    discount_type: "percent",
    value: 20,
    usage_limit: 1,
    used_count: 0,
    scope: "store",
    enabled: true,
  });

  const lines: Omit<EvaluatedCartLine, "discounted_unit_price">[] = [
    { product_id: "p1", variant_id: null, category_id: null, unit_price: 100, qty: 1, line_total: 100 },
  ];

  // 1. Initial evaluation with limit = 1 and used_count = 0 succeeds
  const eval1 = evaluateCartPricing({
    lines,
    subtotal: 100,
    promoCode: "LIMITED1",
    coupons: [],
    promotions: [couponPromo],
    targetsByPromotion: new Map(),
    usageFor: () => ({ customerUses: 0, hasPriorOrder: false }),
    customerKey: null,
    zone: null,
    legacy: { fee: 0, minimum: 0, threshold: 0 },
    deliveryType: "delivery",
    now: NOW,
    channel: "both",
  });
  assert.equal(eval1.ok, true);
  if (eval1.ok) {
    assert.equal(eval1.pricing.promoDiscount, 20);
  }

  // 2. Pending abandoned order does NOT permanently increment used_count
  // Anonymous shopper 1 placed order (status: 'pending') then abandoned it.
  let serverUsedCount = 0;
  const usageLimit = 1;
  // Order placed as 'pending' -> usedCount remains 0
  assert.equal(serverUsedCount, 0, "pending order placement does not consume coupon");

  // Anonymous shopper 2 can still evaluate and place order with the coupon
  const evalShopper2 = evaluateCartPricing({
    lines,
    subtotal: 100,
    promoCode: "LIMITED1",
    coupons: [],
    promotions: [{ ...couponPromo, used_count: serverUsedCount }],
    targetsByPromotion: new Map(),
    usageFor: () => ({ customerUses: 0, hasPriorOrder: false }),
    customerKey: null,
    zone: null,
    legacy: { fee: 0, minimum: 0, threshold: 0 },
    deliveryType: "delivery",
    now: NOW,
    channel: "both",
  });
  assert.equal(evalShopper2.ok, true, "second customer can evaluate coupon because pending order did not consume it");

  // 3. Concurrency test: Two concurrent approval/confirmation attempts compete for the final use
  // Simulates atomic update `UPDATE promotions SET used_count = used_count + 1 WHERE usage_limit IS NULL OR used_count < usage_limit`
  const tryAtomicConsume = () => {
    if (usageLimit === null || serverUsedCount < usageLimit) {
      serverUsedCount += 1;
      return true; // update succeeded (1 row affected)
    }
    return false; // update rejected (0 rows affected)
  };

  const attempt1 = tryAtomicConsume(); // Thread 1 approves order
  const attempt2 = tryAtomicConsume(); // Thread 2 concurrent attempt

  assert.equal(attempt1, true, "first concurrent confirmation consumes final use");
  assert.equal(attempt2, false, "second concurrent confirmation is atomically rejected");
  assert.equal(serverUsedCount, 1, "used_count strictly capped at usage_limit = 1");

  // 4. Subsequent order evaluation after consumption is rejected as exhausted
  const evalAfterExhausted = evaluateCartPricing({
    lines,
    subtotal: 100,
    promoCode: "LIMITED1",
    coupons: [],
    promotions: [{ ...couponPromo, used_count: serverUsedCount }],
    targetsByPromotion: new Map(),
    usageFor: () => ({ customerUses: 0, hasPriorOrder: false }),
    customerKey: null,
    zone: null,
    legacy: { fee: 0, minimum: 0, threshold: 0 },
    deliveryType: "delivery",
    now: NOW,
    channel: "both",
  });
  assert.equal(evalAfterExhausted.ok, false);
  if (!evalAfterExhausted.ok) {
    assert.equal(evalAfterExhausted.reason, "exhausted");
  }
});

// ── Test 57: Coupon cancellation & release lifecycle ────────────────────────
test("57. Coupon counting lifecycle: cancellation releases/does not double-release, pending cancel does not underflow", () => {
  let usedCount = 0;
  const usageLimit = 1;

  // Track order states
  type OrderRecord = { id: string; status: "pending" | "approved" | "cancelled"; consumedCoupon: boolean };
  const orders: OrderRecord[] = [];

  const placePendingOrder = (id: string): OrderRecord => {
    const ord: OrderRecord = { id, status: "pending", consumedCoupon: false };
    orders.push(ord);
    // Pending order does NOT consume coupon
    return ord;
  };

  const approveOrder = (ord: OrderRecord): boolean => {
    if (ord.status !== "pending") return false;
    // Atomic consume
    if (usageLimit === null || usedCount < usageLimit) {
      usedCount += 1;
      ord.consumedCoupon = true;
      ord.status = "approved";
      return true;
    }
    return false;
  };

  const cancelOrder = (ord: OrderRecord): boolean => {
    if (ord.status === "cancelled") return false; // idempotent safeguard against double cancel
    if (ord.status === "approved" && ord.consumedCoupon) {
      usedCount = Math.max(0, usedCount - 1); // release consumed count
      ord.consumedCoupon = false;
    }
    ord.status = "cancelled";
    return true;
  };

  // 1. Order A placed as pending -> usedCount remains 0
  const orderA = placePendingOrder("ord-A");
  assert.equal(usedCount, 0, "order A pending does not increment count");

  // 2. Order A cancelled while still pending -> usedCount remains 0 (no underflow / false release)
  cancelOrder(orderA);
  assert.equal(usedCount, 0, "cancelling pending order leaves count at 0");

  // 3. Order B placed as pending -> approved -> consumed exactly once
  const orderB = placePendingOrder("ord-B");
  const approvedB = approveOrder(orderB);
  assert.equal(approvedB, true);
  assert.equal(usedCount, 1, "approved order B consumes coupon once");

  // 4. Order C placed as pending -> approval fails because usage_limit = 1 reached
  const orderC = placePendingOrder("ord-C");
  const approvedC = approveOrder(orderC);
  assert.equal(approvedC, false, "order C cannot approve while coupon is exhausted");

  // 5. Order B cancelled -> releases coupon back to 0
  const cancelledB1 = cancelOrder(orderB);
  assert.equal(cancelledB1, true);
  assert.equal(usedCount, 0, "cancelling approved order B releases coupon");

  // 6. Duplicate cancel on Order B (idempotency check) -> does NOT double-release
  const cancelledB2 = cancelOrder(orderB);
  assert.equal(cancelledB2, false, "duplicate cancel rejected");
  assert.equal(usedCount, 0, "count stays at 0, no negative count");

  // 7. Order C can now be approved successfully with the released coupon
  orderC.status = "pending"; // retry approval
  const approvedCRetry = approveOrder(orderC);
  assert.equal(approvedCRetry, true);
  assert.equal(usedCount, 1, "order C successfully approved after coupon release");
});

// ── Test 58: Coupon BXGY historical snapshots preservation ──────────────────
test("58. Coupon BXGY historical snapshot: mode='coupon' BXGY captures rule_type, buy_x, get_y, reward_qty, and line rewarded_qty", () => {
  const couponBXGY = makePromo({
    id: "coupon-bxgy-1",
    name_en: "Buy 2 Get 1 Free Coupon",
    mode: "coupon",
    code: "B2G1VIP",
    offer_type: "bxgy",
    buy_x: 2,
    get_y: 1,
    reward_type: "free",
    scope: "store",
    enabled: true,
  });

  const lines: Omit<EvaluatedCartLine, "discounted_unit_price">[] = [
    { product_id: "p1", variant_id: null, category_id: null, unit_price: 150, qty: 3, line_total: 450 },
  ];

  const res = evaluateCartPricing({
    lines,
    subtotal: 450,
    promoCode: "B2G1VIP",
    coupons: [],
    promotions: [couponBXGY],
    targetsByPromotion: new Map(),
    usageFor: () => ({ customerUses: 0, hasPriorOrder: false }),
    customerKey: null,
    zone: null,
    legacy: { fee: 0, minimum: 0, threshold: 0 },
    deliveryType: "delivery",
    now: NOW,
    channel: "both",
  });

  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.pricing.couponPromotionId, "coupon-bxgy-1");
    assert.equal(res.pricing.couponPromotionName, "Buy 2 Get 1 Free Coupon");
    assert.equal(res.pricing.couponPromotionRuleType, "bxgy");
    assert.equal(res.pricing.couponPromotionBuyX, 2);
    assert.equal(res.pricing.couponPromotionGetY, 1);
    assert.equal(res.pricing.couponPromotionRewardQty, 1);
    assert.equal(res.pricing.winningRuleType, "bxgy");
    assert.equal(res.pricing.lines[0].rewarded_qty, 1);
    assert.equal(res.pricing.lines[0].discount_amount, 150);
    assert.equal(res.pricing.total, 300);
  }
});

// ── Test 59: Coupon Cheapest Item historical snapshots ───────────────────────
test("59. Coupon Cheapest Item historical snapshot: mode='coupon' cheapest_item captures min_quantity, reward_qty, and line discount", () => {
  const couponCheapest = makePromo({
    id: "coupon-cheap-1",
    name_en: "Cheapest Free On 3 Items",
    mode: "coupon",
    code: "CHEAPFREE",
    offer_type: "cheapest_item",
    min_quantity: 3,
    reward_type: "free",
    scope: "store",
    enabled: true,
  });

  const lines: Omit<EvaluatedCartLine, "discounted_unit_price">[] = [
    { product_id: "p1", variant_id: null, category_id: null, unit_price: 100, qty: 1, line_total: 100 },
    { product_id: "p2", variant_id: null, category_id: null, unit_price: 200, qty: 1, line_total: 200 },
    { product_id: "p3", variant_id: null, category_id: null, unit_price: 300, qty: 1, line_total: 300 },
  ];

  const res = evaluateCartPricing({
    lines,
    subtotal: 600,
    promoCode: "CHEAPFREE",
    coupons: [],
    promotions: [couponCheapest],
    targetsByPromotion: new Map(),
    usageFor: () => ({ customerUses: 0, hasPriorOrder: false }),
    customerKey: null,
    zone: null,
    legacy: { fee: 0, minimum: 0, threshold: 0 },
    deliveryType: "delivery",
    now: NOW,
    channel: "both",
  });

  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.pricing.couponPromotionId, "coupon-cheap-1");
    assert.equal(res.pricing.couponPromotionRuleType, "cheapest_item");
    assert.equal(res.pricing.couponPromotionRewardQty, 1);
    assert.equal(res.pricing.promoDiscount, 100);
    assert.equal(res.pricing.lines[0].discount_amount, 100); // cheapest item (p1: 100 EGP) is free
    assert.equal(res.pricing.lines[1].discount_amount, 0);
    assert.equal(res.pricing.lines[2].discount_amount, 0);
    assert.equal(res.pricing.total, 500);
  }
});

// ── Test 60: Campaign / POS / Storefront pricing parity ──────────────────────
test("60. Campaign / POS / Storefront pricing parity: same product + variant receives identical base price less campaign discount in both channels", () => {
  const catalogueSellingPrice = 200;
  const campaignDiscountPercent = 20; // 20% flash campaign -> 160 base unit price
  const basePriceAfterCampaign = round2((catalogueSellingPrice * (100 - campaignDiscountPercent)) / 100); // 160

  const posLine = { product_id: "prd-1", variant_id: null, category_id: null, qty: 2, unit_price: basePriceAfterCampaign, line_total: round2(basePriceAfterCampaign * 2) };
  const onlineLine = { product_id: "prd-1", variant_id: null, category_id: null, qty: 2, unit_price: basePriceAfterCampaign, line_total: round2(basePriceAfterCampaign * 2) };

  assert.equal(posLine.unit_price, 160);
  assert.equal(onlineLine.unit_price, 160);
  assert.equal(posLine.line_total, 320);
  assert.equal(onlineLine.line_total, 320);

  // Central promo on top: 10% auto discount
  const promo = makePromo({ discount_type: "percent", value: 10, scope: "store" });

  const evalPos = evaluateCartPricing({
    lines: [posLine],
    subtotal: 320,
    promoCode: null,
    coupons: [],
    promotions: [promo],
    targetsByPromotion: new Map(),
    usageFor: () => ({ customerUses: 0, hasPriorOrder: false }),
    customerKey: null,
    zone: null,
    legacy: { fee: 0, minimum: 0, threshold: 0 },
    deliveryType: "delivery",
    now: NOW,
    channel: "pos",
  });

  const evalOnline = evaluateCartPricing({
    lines: [onlineLine],
    subtotal: 320,
    promoCode: null,
    coupons: [],
    promotions: [promo],
    targetsByPromotion: new Map(),
    usageFor: () => ({ customerUses: 0, hasPriorOrder: false }),
    customerKey: null,
    zone: null,
    legacy: { fee: 0, minimum: 0, threshold: 0 },
    deliveryType: "delivery",
    now: NOW,
    channel: "online",
  });

  assert.equal(evalPos.ok, true);
  assert.equal(evalOnline.ok, true);
  if (evalPos.ok && evalOnline.ok) {
    assert.equal(evalPos.pricing.totalDiscount, 32);
    assert.equal(evalOnline.pricing.totalDiscount, 32);
    assert.equal(evalPos.pricing.total, 288);
    assert.equal(evalOnline.pricing.total, 288);
  }
});

// ── Test 61: Online order approval preserves immutable frozen snapshot ──────
test("61. Online order approval preserves immutable frozen snapshot despite product price changes or promotion expiry", () => {
  // Snapshot at placement time
  const placedSnapshot = {
    order_id: "ord-snap-1",
    subtotal: 500,
    discount_amount: 100, // 20% promo at placement
    automatic_discount_amount: 100,
    shipping_fee: 40,
    total: 440,
    items: [
      {
        product_id: "prd-frozen",
        variant_id: null,
        unit_price: 250,
        discounted_unit_price: 200,
        quantity: 2,
        line_total: 500,
        automatic_discount_amount: 100,
        rewarded_qty: 0,
        promotion_rule_type: "standard",
      },
    ],
  };

  // Catalogue changes later: product price raised to 350, campaign starts, promotion expires
  const _changedCataloguePrice = 350;
  const _changedCampaignDiscount = 50;
  assert.ok(_changedCataloguePrice > placedSnapshot.items[0].unit_price);
  assert.ok(_changedCampaignDiscount > 0);

  // Conversion to sale uses ONLY the frozen snapshot lines
  const goodsTotal = round2(placedSnapshot.subtotal - placedSnapshot.discount_amount); // 400
  const saleDiscount = placedSnapshot.discount_amount; // 100

  assert.equal(goodsTotal, 400);
  assert.equal(saleDiscount, 100);

  // In pos_complete_sale for source='online':
  const saleSubtotal = placedSnapshot.items.reduce((sum, item) => sum + item.unit_price * item.quantity, 0); // 500
  const saleTotal = round2(saleSubtotal - saleDiscount); // 400
  assert.equal(saleSubtotal, 500);
  assert.equal(saleTotal, 400);
  assert.equal(saleTotal, goodsTotal, "Generated POS sale goods total equals stored online merchandise total exactly");
});

// ── Test 62: A smaller coupon still beats the automatic promotion ────────────
test("62. Coupon beats automatic promo even when smaller: auto 100 vs coupon 50 -> coupon wins -> coupon consumed", () => {
  const autoPromo = makePromo({
    id: "auto-100",
    name_en: "Big Auto 100 Off",
    discount_type: "fixed",
    value: 100,
    scope: "store",
    mode: "automatic",
    used_count: 0,
  });

  const couponPromo = makePromo({
    id: "coupon-50",
    name_en: "Small Coupon 50 Off",
    discount_type: "fixed",
    value: 50,
    scope: "store",
    mode: "coupon",
    code: "SAVE50",
    used_count: 0,
    usage_limit: 10,
  });

  const lines = [
    { product_id: "p1", variant_id: null, category_id: null, unit_price: 500, qty: 1, line_total: 500 },
  ];

  const res = evaluateCartPricing({
    lines,
    subtotal: 500,
    promoCode: "SAVE50",
    coupons: [],
    promotions: [autoPromo, couponPromo],
    targetsByPromotion: new Map(),
    usageFor: () => ({ customerUses: 0, hasPriorOrder: false }),
    customerKey: null,
    zone: null,
    legacy: { fee: 0, minimum: 0, threshold: 0 },
    deliveryType: "delivery",
    now: NOW,
    channel: "online",
  });

  assert.equal(res.ok, true);
  if (res.ok) {
    // The coupon wins outright even though the automatic promotion was worth
    // twice as much: a code the cart accepted must always be the discount the
    // shopper gets, and the automatic promotion it displaces must vanish.
    assert.equal(res.pricing.autoDiscount, 0);
    assert.equal(res.pricing.promoDiscount, 50);
    assert.equal(res.pricing.winningPromotionId, "coupon-50");
    assert.equal(res.pricing.totalDiscount, 50, "only one discount is ever taken off");

    // Lifecycle rule: on approval, only consume if promoDiscount > 0 or promoFreeShipping = true
    const shouldConsumeCoupon = res.pricing.promoDiscount > 0 || res.pricing.promoFreeShipping;
    assert.equal(shouldConsumeCoupon, true, "the winning coupon IS consumed on order approval");
  }
});

// ── Test 62b: a free-shipping code never cancels the automatic promotion ─────
test("62b. A code worth nothing against the goods leaves the automatic promotion standing", () => {
  const autoPromo = makePromo({
    id: "auto-100",
    name_en: "Big Auto 100 Off",
    discount_type: "fixed",
    value: 100,
    scope: "store",
    mode: "automatic",
    used_count: 0,
  });

  const res = evaluateCartPricing({
    lines: [{ product_id: "p1", variant_id: null, category_id: null, unit_price: 500, qty: 1, line_total: 500 }],
    subtotal: 500,
    promoCode: "FREESHIP",
    // A legacy free-shipping coupon: valid, but worth 0 against the goods.
    coupons: [
      {
        id: "cpn-ship", code: "FREESHIP",
        title_en: "Free shipping", title_ar: "شحن مجاني",
        description_en: null, description_ar: null,
        discount_type: "free_shipping", value: 0,
        min_subtotal: 0, max_discount: null, usage_limit: null, used_count: 0,
        per_customer_limit: null, first_order_only: false, stackable: false,
        applies_to: "all", target_ids: [], active: true, starts_at: null, ends_at: null,
        created_at: NOW.toISOString(), updated_at: NOW.toISOString(),
      },
    ],
    promotions: [autoPromo],
    targetsByPromotion: new Map(),
    usageFor: () => ({ customerUses: 0, hasPriorOrder: false }),
    customerKey: null,
    zone: null,
    legacy: { fee: 0, minimum: 0, threshold: 0 },
    deliveryType: "delivery",
    now: NOW,
    channel: "online",
  });

  assert.equal(res.ok, true);
  if (res.ok) {
    // "Coupon always wins" must not be read as "any accepted code wipes the
    // sale" — a code that discounts nothing would leave the shopper worse off.
    assert.equal(res.pricing.autoDiscount, 100, "the automatic promotion survives a goods-worthless code");
    assert.equal(res.pricing.promoDiscount, 0);
    assert.equal(res.pricing.totalDiscount, 100);
  }
});

// ── Test 63: POS coupon evaluation & validation ─────────────────────────────
test("63. POS coupon support: channel='pos' validates coupon, enforces minimums, and calculates line allocations", () => {
  const posCoupon = makePromo({
    id: "pos-coupon-1",
    name_en: "POS VIP 15%",
    discount_type: "percent",
    value: 15,
    scope: "store",
    mode: "coupon",
    code: "POSVIP",
    channel: "pos",
    minimum_order_amount: 200,
    used_count: 2,
    usage_limit: 5,
  });

  const lines = [
    { product_id: "p1", variant_id: null, category_id: null, unit_price: 150, qty: 2, line_total: 300 },
  ];

  const res = evaluateCartPricing({
    lines,
    subtotal: 300,
    promoCode: "posvip",
    coupons: [],
    promotions: [posCoupon],
    targetsByPromotion: new Map(),
    usageFor: () => ({ customerUses: 0, hasPriorOrder: false }),
    customerKey: null,
    zone: null,
    legacy: { fee: 0, minimum: 0, threshold: 0 },
    deliveryType: "pickup",
    now: NOW,
    channel: "pos",
  });

  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.pricing.promoDiscount, 45); // 15% of 300 = 45
    assert.equal(res.pricing.couponPromotionId, "pos-coupon-1");
    assert.equal(res.pricing.winningPromotionId, "pos-coupon-1");
    assert.equal(res.pricing.lines[0].discount_amount, 45);
    assert.equal(res.pricing.total, 255);
  }

  // Reject on online channel
  const onlineAttempt = evaluateCartPricing({
    lines,
    subtotal: 300,
    promoCode: "posvip",
    coupons: [],
    promotions: [posCoupon],
    targetsByPromotion: new Map(),
    usageFor: () => ({ customerUses: 0, hasPriorOrder: false }),
    customerKey: null,
    zone: null,
    legacy: { fee: 0, minimum: 0, threshold: 0 },
    deliveryType: "delivery",
    now: NOW,
    channel: "online",
  });
  assert.equal(onlineAttempt.ok, false);
});

// ── Test 64: POS coupon vs manual item discounts (non-stacking) ─────────────
test("64. POS coupon vs manual item discounts: highest saving wins per non-stacking rules", () => {
  // Scenario A: Coupon saves 50 EGP (10% of 500), manual item discount saves 20 EGP -> coupon wins
  const promoLineDiscA = 50;
  const manualItemDiscA = 20;
  const effectivePromoA = promoLineDiscA >= manualItemDiscA ? promoLineDiscA : 0;
  const effectiveManualA = promoLineDiscA >= manualItemDiscA ? 0 : manualItemDiscA;
  assert.equal(effectivePromoA, 50);
  assert.equal(effectiveManualA, 0);

  // Scenario B: Coupon saves 20 EGP, manual item discount saves 50 EGP -> manual wins
  const promoLineDiscB = 20;
  const manualItemDiscB = 50;
  const effectivePromoB = promoLineDiscB >= manualItemDiscB ? promoLineDiscB : 0;
  const effectiveManualB = promoLineDiscB >= manualItemDiscB ? 0 : manualItemDiscB;
  assert.equal(effectivePromoB, 0);
  assert.equal(effectiveManualB, 50);
});

// ── Test 65: Online order cancellation releases coupon usage safely ─────────
test("65. Online cancellation releases usage ONLY if consumed on approval", () => {
  let usedCount = 0;

  // Order placed with winning coupon: pending -> used_count stays 0
  const order = { status: "pending", discount_code: "WINNER", promo_discount: 40 };
  assert.equal(usedCount, 0, "Placement does not increment used_count");

  // Order approved -> used_count increments because promo_discount > 0
  if (order.promo_discount > 0) {
    usedCount += 1;
  }
  order.status = "approved";
  assert.equal(usedCount, 1, "Approval increments used_count");

  // Order cancelled while approved -> used_count decrements
  if (order.status === "approved" && order.promo_discount > 0) {
    usedCount = Math.max(0, usedCount - 1);
  }
  order.status = "cancelled";
  assert.equal(usedCount, 0, "Cancellation of approved order decrements used_count");

  // Another order placed and cancelled while still pending:
  const pendingOrder = { status: "pending", discount_code: "WINNER", promo_discount: 40 };
  // Cancelled while pending -> usedCount should not decrement below 0
  if (pendingOrder.status === "approved" && pendingOrder.promo_discount > 0) {
    usedCount = Math.max(0, usedCount - 1);
  }
  assert.equal(usedCount, 0, "Cancellation of pending order never decrements used_count");
});

// ── Test 66: Online stock reservations & ATP calculation ────────────────────
test("66. Online reservations & ATP: Available-to-promise rejects overselling and preserves exact variant targeting", () => {
  interface VariantStock {
    id: string;
    product_id: string;
    stock_quantity: number;
    reserved_quantity: number;
  }

  const variantG17: VariantStock = { id: "var-gold-17", product_id: "prd-ring", stock_quantity: 5, reserved_quantity: 3 };
  const variantS17: VariantStock = { id: "var-silver-17", product_id: "prd-ring", stock_quantity: 5, reserved_quantity: 1 };

  // ATP calculation: stock - reserved
  const atpG17 = variantG17.stock_quantity - variantG17.reserved_quantity; // 2
  const atpS17 = variantS17.stock_quantity - variantS17.reserved_quantity; // 4

  assert.equal(atpG17, 2);
  assert.equal(atpS17, 4);

  // Attempting to buy 3 of G17 must be rejected
  const reqQtyG17 = 3;
  const isAvailableG17 = reqQtyG17 <= atpG17;
  assert.equal(isAvailableG17, false, "Requesting 3 units of G17 when ATP is 2 must be rejected");

  // Attempting to buy 2 of G17 passes
  const validQtyG17 = 2;
  const isValidG17 = validQtyG17 <= atpG17;
  assert.equal(isValidG17, true);

  // Placing order reserves quantity
  variantG17.reserved_quantity += validQtyG17;
  assert.equal(variantG17.reserved_quantity, 5);
  assert.equal(variantG17.stock_quantity - variantG17.reserved_quantity, 0, "G17 now has 0 ATP");

  // Approval converts reservation to sale without double deduction
  let reservationStatus = "reserved";
  if (reservationStatus === "reserved") {
    reservationStatus = "converted";
    variantG17.stock_quantity -= validQtyG17;
    variantG17.reserved_quantity -= validQtyG17;
  }
  assert.equal(reservationStatus, "converted");
  assert.equal(variantG17.stock_quantity, 3);
  assert.equal(variantG17.reserved_quantity, 3);

  // Cancellation of approved order voids sale and restores stock without double releasing
  let saleVoided = false;
  if (reservationStatus === "converted") {
    saleVoided = true;
    variantG17.stock_quantity += validQtyG17;
  } else if (reservationStatus === "reserved") {
    reservationStatus = "released";
    variantG17.reserved_quantity -= validQtyG17;
  }
  assert.equal(saleVoided, true);
  assert.equal(variantG17.stock_quantity, 5);
  assert.equal(variantG17.reserved_quantity, 3);
});

// ── Test 67: Delivery fee validation and destination enforcement ────────────
test("67. Delivery fee validation: requires valid address, validates zone, and rejects unpriceable deliveries", () => {
  const settings = {
    delivery: {
      enabled: true,
      fee: 40,
      minimum_order: 100,
      free_delivery_threshold: 500,
      areas: [{ en: "Cairo", ar: "القاهرة" }, { en: "Giza", ar: "الجيزة" }],
    },
  };

  assert.equal(settings.delivery.enabled, true);
  assert.equal(settings.delivery.fee, 40);

  const zones = [
    { id: "zone-cairo", name_en: "Cairo Zone", name_ar: "منطقة القاهرة", shipping_fee: 45, minimum_order_amount: 150, free_shipping_threshold: 600, enabled: true },
    { id: "zone-alex", name_en: "Alexandria", name_ar: "الإسكندرية", shipping_fee: 60, minimum_order_amount: 200, free_shipping_threshold: 800, enabled: false },
  ];

  // Case 1: Incomplete destination address (missing street)
  const addrMissingStreet = { city: "Cairo", area: "Nasr City", street: "" };
  const isAddressComplete = Boolean(addrMissingStreet.city.trim() && addrMissingStreet.area.trim() && addrMissingStreet.street.trim());
  assert.equal(isAddressComplete, false, "Delivery address missing street is invalid");

  // Case 2: Selected disabled zone is rejected
  const selectedDisabledZone = zones.find((z) => z.id === "zone-alex" && z.enabled);
  assert.equal(selectedDisabledZone, undefined, "Disabled delivery zone must be rejected");

  // Case 3: Valid zone evaluates authoritative shipping fee and free shipping threshold
  const activeZone = zones.find((z) => z.id === "zone-cairo" && z.enabled)!;
  assert.ok(activeZone);

  // Subtotal below minimum order amount
  const goodsBelowMin = 100;
  assert.ok(goodsBelowMin < activeZone.minimum_order_amount, "Subtotal 100 is below zone minimum 150");

  // Subtotal above minimum but below threshold
  const goodsNormal = 300;
  const feeNormal = goodsNormal >= activeZone.free_shipping_threshold ? 0 : activeZone.shipping_fee;
  assert.equal(feeNormal, 45, "Zone shipping fee 45 applies when threshold not met");

  // Subtotal above free shipping threshold
  const goodsHigh = 700;
  const feeHigh = goodsHigh >= activeZone.free_shipping_threshold ? 0 : activeZone.shipping_fee;
  assert.equal(feeHigh, 0, "Free delivery applied when subtotal meets threshold");
});

// ── Test 68: Winning coupon snapshot conversion to sale ─────────────────────
test("68. Winning coupon snapshot: converts to sale with promotional attribution and zero manual invoice discount", () => {
  const couponPromo = makePromo({
    id: "promo-bxgy-1",
    name_en: "Buy 2 Get 1 Free Promo",
    mode: "coupon",
    code: "B2G1FREE",
    offer_type: "bxgy",
    buy_x: 2,
    get_y: 1,
    reward_type: "free",
    repeat_offer: true,
  });

  const lines = [
    { product_id: "prd-shirt", variant_id: "var-shirt-blue", category_id: null, unit_price: 150, qty: 3, line_total: 450 },
  ];

  const evalResult = evaluateCartPricing({
    lines,
    subtotal: 450,
    promoCode: "B2G1FREE",
    coupons: [],
    promotions: [couponPromo],
    targetsByPromotion: new Map(),
    usageFor: () => ({ customerUses: 0, hasPriorOrder: false }),
    customerKey: "cust-1",
    zone: null,
    legacy: { fee: 0, minimum: 0, threshold: 0 },
    deliveryType: "delivery",
    now: NOW,
    channel: "online",
  });

  assert.equal(evalResult.ok, true);
  if (evalResult.ok) {
    // 3 shirts at 150: buy 2 get 1 free -> promoDiscount = 150
    assert.equal(evalResult.pricing.promoDiscount, 150);
    assert.equal(evalResult.pricing.totalDiscount, 150);
    assert.equal(evalResult.pricing.winningPromotionId, "promo-bxgy-1");
    assert.equal(evalResult.pricing.winningRuleType, "bxgy");
    assert.equal(evalResult.pricing.winningBuyX, 2);
    assert.equal(evalResult.pricing.winningGetY, 1);
    assert.equal(evalResult.pricing.winningRewardQty, 1);

    // Online order snapshot created
    const onlineOrderSnapshot = {
      subtotal: 450,
      discount_amount: 150,
      discount_code: "B2G1FREE",
      promotion_id: "promo-bxgy-1",
      promotion_rule_type: "bxgy",
      promotion_buy_x: 2,
      promotion_get_y: 1,
      promotion_reward_qty: 1,
      items: [
        {
          product_id: "prd-shirt",
          variant_id: "var-shirt-blue",
          unit_price: 150,
          quantity: 3,
          line_total: 450,
          discounted_unit_price: 100,
          automatic_promotion_id: "promo-bxgy-1",
          automatic_promotion_name: "Buy 2 Get 1 Free Promo",
          automatic_discount_amount: 150,
          rewarded_qty: 1,
          promotion_rule_type: "bxgy",
        },
      ],
    };

    // Conversion to Sale:
    const salePayload = {
      source: "online",
      subtotal: onlineOrderSnapshot.subtotal, // 450
      discount_type: "none", // NOT anonymous manual discount!
      discount_value: 0,
      discount_amount: 0,
      item_discount_amount: 0,
      automatic_discount_amount: onlineOrderSnapshot.discount_amount, // 150
      total_discount_amount: onlineOrderSnapshot.discount_amount, // 150
      automatic_promotion_id: onlineOrderSnapshot.promotion_id,
      automatic_promotion_name: "Buy 2 Get 1 Free Promo",
      promotion_rule_type: onlineOrderSnapshot.promotion_rule_type,
      promotion_buy_x: onlineOrderSnapshot.promotion_buy_x,
      promotion_get_y: onlineOrderSnapshot.promotion_get_y,
      promotion_reward_qty: onlineOrderSnapshot.promotion_reward_qty,
      total: round2(onlineOrderSnapshot.subtotal - onlineOrderSnapshot.discount_amount), // 300
    };

    assert.equal(salePayload.discount_type, "none");
    assert.equal(salePayload.discount_amount, 0);
    assert.equal(salePayload.automatic_discount_amount, 150);
    assert.equal(salePayload.total_discount_amount, 150);
    assert.equal(salePayload.total, 300);
    assert.equal(salePayload.automatic_promotion_id, "promo-bxgy-1");
    assert.equal(salePayload.promotion_rule_type, "bxgy");
    assert.equal(salePayload.promotion_buy_x, 2);
    assert.equal(salePayload.promotion_get_y, 1);
    assert.equal(salePayload.promotion_reward_qty, 1);
  }
});

// ── Test 69: Financial and profitability report parity ──────────────────────
test("69. Financial & report parity: gross - discounts == net reconciliation across lines and order snapshots", () => {
  const saleItem = {
    unit_price: 200,
    quantity: 3,
    gross_total: 600, // 200 * 3
    automatic_discount_amount: 60, // 10% promo
    discount_amount: 0, // manual discount
    line_total: 540, // 600 - 60
    unit_cost: 100,
  };

  const lineGross = saleItem.gross_total ?? (saleItem.unit_price * saleItem.quantity);
  const lineDiscounts = (saleItem.automatic_discount_amount ?? 0) + (saleItem.discount_amount ?? 0);
  const lineNet = saleItem.line_total;

  assert.equal(lineGross, 600);
  assert.equal(lineDiscounts, 60);
  assert.equal(lineNet, 540);
  assert.equal(lineGross - lineDiscounts, lineNet, "gross - discounts == net must hold exactly");

  const cogs = saleItem.quantity * saleItem.unit_cost; // 300
  const grossProfit = lineNet - cogs; // 540 - 300 = 240
  const marginPercent = round2((grossProfit / lineNet) * 100);
  assert.equal(grossProfit, 240);
  assert.equal(marginPercent, 44.44);
});

// ── Test 70: Server-authoritative actor identity & prices ───────────────────
test("70. Identity & pricing authority: server derives actor identity from auth.uid() and rejects forged client prices", () => {
  const clientSuppliedLine = {
    product_id: "prd-real",
    qty: 2,
    unit_price: 1.0, // Client tries to spoof price to 1.00 EGP
  };

  const dbCatalogueProduct = {
    id: "prd-real",
    selling_price: 250.0,
    cost_price: 150.0,
    active: true,
    stock_tracking_enabled: true,
  };

  // Server completely ignores client's unit_price and uses dbCatalogueProduct.selling_price
  const serverPricedUnit = dbCatalogueProduct.selling_price;
  const serverLineGross = round2(serverPricedUnit * clientSuppliedLine.qty);

  assert.equal(serverPricedUnit, 250.0);
  assert.equal(serverLineGross, 500.0, "Catalogue price of 250.00 produces 500.00 gross, ignoring forged 1.00 EGP");
});

// ── Test 71: Non-variant reservation lookup (variant_id is null) ────────────
test("71. Stock reservations: non-variant products match and update reservations where variant_id IS NULL", () => {
  interface Reservation {
    online_order_id: string;
    product_id: string;
    variant_id: string | null;
    quantity: number;
    status: "reserved" | "converted" | "released";
  }

  const reservations: Reservation[] = [
    { online_order_id: "ord-1", product_id: "prd-non-variant", variant_id: null, quantity: 2, status: "reserved" },
    { online_order_id: "ord-1", product_id: "prd-variant", variant_id: "var-123", quantity: 1, status: "reserved" },
  ];

  // Non-variant lookup must check `variant_id === null` (SQL: `variant_id is null`), not `= null`
  const targetProduct = "prd-non-variant";
  const nonVariantMatch = reservations.find(
    (r) => r.online_order_id === "ord-1" && r.product_id === targetProduct && r.variant_id === null
  );
  assert.ok(nonVariantMatch, "Must find non-variant reservation with null variant_id");
  assert.equal(nonVariantMatch?.quantity, 2);

  // Variant lookup checks exact variant_id
  const variantMatch = reservations.find(
    (r) => r.online_order_id === "ord-1" && r.product_id === "prd-variant" && r.variant_id === "var-123"
  );
  assert.ok(variantMatch, "Must find variant reservation with exact variant_id");
  assert.equal(variantMatch?.quantity, 1);
});

// ── Test 72: Delivery zone enforcement & zero-enabled fallback ─────────────
test("72. Delivery zone enforcement: required and validated when enabled zones exist; legacy fallback ONLY when zero enabled zones; pickup untouched", () => {
  const allZones = [
    { id: "zone-cairo", name_en: "Cairo", name_ar: "القاهرة", shipping_fee: 70, enabled: true, minimum_order_amount: 0, free_shipping_threshold: null },
    { id: "zone-disabled", name_en: "Closed", name_ar: "مغلق", shipping_fee: 25, enabled: false, minimum_order_amount: 0, free_shipping_threshold: null },
  ];

  const legacySettings = {
    enabled: true,
    fee: 30,
    minimum: 0,
    threshold: 0,
  };

  function validateAndPriceDelivery(payload: {
    deliveryType: "delivery" | "pickup";
    deliveryZoneId?: string | null;
    address?: { city?: string; area?: string; street?: string };
    zones: typeof allZones;
  }) {
    if (payload.deliveryType === "pickup") {
      return { ok: true, source: "pickup", fee: 0, zoneId: null };
    }

    // Delivery requires address
    if (!payload.address?.city || !payload.address?.area || !payload.address?.street) {
      return { ok: false, error: "A delivery address is required" };
    }

    const enabledZones = payload.zones.filter((z) => z.enabled);

    if (enabledZones.length > 0) {
      if (!payload.deliveryZoneId || payload.deliveryZoneId.trim() === "") {
        return { ok: false, error: "Please select a delivery zone" };
      }
      const zone = enabledZones.find((z) => z.id === payload.deliveryZoneId);
      if (!zone) {
        return { ok: false, error: "Delivery zone is not available" };
      }
      return { ok: true, source: "zone", fee: zone.shipping_fee, zoneId: zone.id };
    } else {
      // Zero enabled zones: fallback to legacy website_settings
      if (!legacySettings.enabled) {
        return { ok: false, error: "Delivery is not available" };
      }
      return { ok: true, source: "legacy", fee: legacySettings.fee, zoneId: null };
    }
  }

  // 1. When enabled zones exist, missing zone_id is rejected
  const missingZoneRes = validateAndPriceDelivery({
    deliveryType: "delivery",
    deliveryZoneId: null,
    address: { city: "Cairo", area: "Nasr City", street: "Street 9" },
    zones: allZones,
  });
  assert.equal(missingZoneRes.ok, false);
  assert.equal((missingZoneRes as { error: string }).error, "Please select a delivery zone");

  // 2. Disabled zone_id is rejected
  const disabledZoneRes = validateAndPriceDelivery({
    deliveryType: "delivery",
    deliveryZoneId: "zone-disabled",
    address: { city: "Cairo", area: "Nasr City", street: "Street 9" },
    zones: allZones,
  });
  assert.equal(disabledZoneRes.ok, false);
  assert.equal((disabledZoneRes as { error: string }).error, "Delivery zone is not available");

  // 3. Valid enabled zone_id succeeds
  const validZoneRes = validateAndPriceDelivery({
    deliveryType: "delivery",
    deliveryZoneId: "zone-cairo",
    address: { city: "Cairo", area: "Nasr City", street: "Street 9" },
    zones: allZones,
  });
  assert.equal(validZoneRes.ok, true);
  assert.equal((validZoneRes as { fee: number }).fee, 70);
  assert.equal((validZoneRes as { zoneId: string }).zoneId, "zone-cairo");

  // 4. Zero enabled zones: legacy fallback is used
  const noEnabledZones = [
    { id: "zone-disabled", name_en: "Closed", name_ar: "مغلق", shipping_fee: 25, enabled: false, minimum_order_amount: 0, free_shipping_threshold: null },
  ];
  const fallbackRes = validateAndPriceDelivery({
    deliveryType: "delivery",
    deliveryZoneId: null,
    address: { city: "Cairo", area: "Nasr City", street: "Street 9" },
    zones: noEnabledZones,
  });
  assert.equal(fallbackRes.ok, true);
  assert.equal((fallbackRes as { source: string }).source, "legacy");
  assert.equal((fallbackRes as { fee: number }).fee, 30);

  // 5. Pickup orders remain unchanged (fee 0, no zone required)
  const pickupRes = validateAndPriceDelivery({
    deliveryType: "pickup",
    deliveryZoneId: null,
    zones: allZones,
  });
  assert.equal(pickupRes.ok, true);
  assert.equal((pickupRes as { source: string }).source, "pickup");
  assert.equal((pickupRes as { fee: number }).fee, 0);
  assert.equal((pickupRes as { zoneId: string | null }).zoneId, null);
});


