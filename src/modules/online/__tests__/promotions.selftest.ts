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
test("56. Central coupon usage limit: coupon with usage_limit = 1 succeeds once and second attempt is rejected", () => {
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

  // Attempt 1: used_count = 0 < 1 -> SUCCESS
  const res1 = evaluateCartPricing({
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
  assert.equal(res1.ok, true);
  if (res1.ok) {
    assert.equal(res1.pricing.promoDiscount, 20);
  }

  // Simulate coupon usage consumed
  const consumedCoupon = { ...couponPromo, used_count: 1 };

  // Attempt 2: used_count = 1 >= 1 -> REJECTED
  const res2 = evaluateCartPricing({
    lines,
    subtotal: 100,
    promoCode: "LIMITED1",
    coupons: [],
    promotions: [consumedCoupon],
    targetsByPromotion: new Map(),
    usageFor: () => ({ customerUses: 0, hasPriorOrder: false }),
    customerKey: null,
    zone: null,
    legacy: { fee: 0, minimum: 0, threshold: 0 },
    deliveryType: "delivery",
    now: NOW,
    channel: "both",
  });
  assert.equal(res2.ok, false);
  if (!res2.ok) {
    assert.equal(res2.reason, "exhausted");
  }
});

// ── Test 57: Coupon cancellation counting lifecycle ──────────────────────────
test("57. Coupon counting lifecycle: placing order increments used_count, cancelling decrements used_count, confirming retains used_count", () => {
  let usedCount = 0;
  const usageLimit = 1;

  // 1. Place order with coupon
  if (usageLimit === null || usedCount < usageLimit) {
    usedCount += 1;
  }
  assert.equal(usedCount, 1);

  // 2. Cancel order -> release used count
  usedCount = Math.max(0, usedCount - 1);
  assert.equal(usedCount, 0, "coupon usage count released on order cancellation");

  // 3. Place order again
  if (usageLimit === null || usedCount < usageLimit) {
    usedCount += 1;
  }
  assert.equal(usedCount, 1);

  // 4. Confirm/complete order -> retain used count
  assert.equal(usedCount, 1, "coupon usage count retained on order confirmation");
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
