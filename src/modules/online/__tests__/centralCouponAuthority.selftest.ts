import assert from "node:assert/strict";
import test from "node:test";
import { getDemoRepository } from "@/modules/products/data/demoRepository";
import { DemoOnlineRepository, resetDemoOnlineRepository } from "../data/demoRepository";

async function publishedProduct() {
  const products = await getDemoRepository().listProducts();
  const product = products.find((candidate) => candidate.active && candidate.show_on_website && candidate.stock_tracking_enabled);
  assert.ok(product, "a published, stock-tracked demo product is required");
  return product;
}

test("Admin central coupon mode is immediately authoritative in demo, with lifecycle and target reasons", async () => {
  // The production stale-tab path is localStorage + BroadcastChannel. Logic
  // suites run in Node, so provide the browser storage that two repository
  // instances would naturally share.
  const values = new Map<string, string>();
  (globalThis as unknown as { window: { localStorage: Storage } }).window = {
    localStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); },
      clear: () => { values.clear(); },
      key: () => null,
      get length() { return values.size; },
    },
  } as unknown as { localStorage: Storage };
  resetDemoOnlineRepository();
  const adminTab = new DemoOnlineRepository();
  const shopperTab = new DemoOnlineRepository();
  const product = await publishedProduct();
  const products = await getDemoRepository().listProducts();
  const other = products.find((candidate) => candidate.id !== product.id && candidate.active && candidate.show_on_website);
  assert.ok(other, "a second published product is required for the target refusal");
  const lines = [{ product_id: product.id, qty: 2 }];

  // Both names intentionally exist: the shopper's locale must not change code
  // lookup. This is a normal Admin promotion, not a FAM-specific branch.
  const promotion = await adminTab.savePromotion(
    {
      enabled: true,
      mode: "coupon",
      code: "FAM",
      channel: "both",
      name_en: "Family saving",
      name_ar: "خصم العائلة",
      description_en: "English lifecycle",
      description_ar: "دورة حياة عربية",
      discount_type: "percent",
      value: 20,
      scope: "product",
      minimum_order_amount: 0,
      maximum_discount_amount: null,
      starts_at: null,
      ends_at: null,
      priority: 1,
      stackable: false,
    },
    [{ target_kind: "product", target_id: product.id }],
  );

  // A distinct repository instance models a storefront tab with a stale
  // singleton. `checkCoupon` refreshes marketing sources and uses its pricing
  // evaluator, so the new Admin coupon works without an app restart.
  const accepted = await shopperTab.checkCoupon({ code: " f a m ", lines });
  assert.equal(accepted.valid, true, JSON.stringify(accepted));
  if (accepted.valid) {
    assert.equal(accepted.code, "FAM");
    assert.equal(accepted.discountType, "percent");
    assert.ok(accepted.discount > 0, "the pricing engine supplies the campaign-aware amount");
  }

  const wrongTarget = await shopperTab.checkCoupon({
    code: "FAM",
    lines: [{ product_id: other.id, qty: 1 }],
  });
  assert.deepEqual(wrongTarget, { valid: false, reason: "not_applicable" });

  await adminTab.savePromotion(
    { ...promotion, enabled: false },
    [{ target_kind: "product", target_id: product.id }],
  );
  assert.deepEqual(await shopperTab.checkCoupon({ code: "FAM", lines }), { valid: false, reason: "invalid" });

  await adminTab.savePromotion(
    { ...promotion, enabled: true, starts_at: new Date(Date.now() + 86_400_000).toISOString() },
    [{ target_kind: "product", target_id: product.id }],
  );
  assert.deepEqual(await shopperTab.checkCoupon({ code: "FAM", lines }), { valid: false, reason: "not_started" });

  await adminTab.savePromotion(
    {
      ...promotion,
      enabled: true,
      starts_at: null,
      ends_at: new Date(Date.now() - 86_400_000).toISOString(),
    },
    [{ target_kind: "product", target_id: product.id }],
  );
  assert.deepEqual(await shopperTab.checkCoupon({ code: "FAM", lines }), { valid: false, reason: "expired" });
});
