import assert from "node:assert/strict";
import test from "node:test";
import { clearHeldCartsForTests, holdCart, listHeldCarts, removeHeldCart } from "../heldCarts";
import { resetOfflineDbForTests } from "../db";
import type { CartLine } from "../../types";

function line(variant_id: string): CartLine {
  return {
    product_id: "ring", variant_id, variant_sku: `SKU-${variant_id}`,
    color_ar: "ذهبي", color_en: "Gold", size: 17, size_label: null,
    sku: `SKU-${variant_id}`, name_ar: "خاتم", name_en: "Ring", barcode: null,
    base_price: 100, unit_price: 90, automatic_promotion_id: "auto-1",
    automatic_promotion_name: "Sale", automatic_discount_amount: 10,
    max_qty: 2, qty: 1, image_url: null, item_discount: { type: "fixed", value: 3 },
  };
}

test("held cart survives repository reads and keeps customer, exact variant and discount snapshot", async () => {
  resetOfflineDbForTests();
  await clearHeldCartsForTests();
  const held = await holdCart({
    held_by_id: "cashier", held_by_name: "Cashier", store: "Main", shift_id: "shift-1",
    customer: { id: "customer-1", name: "Aya", phone: "0100", email: null, address: null, notes: null, created_at: "2026-01-01", updated_at: "2026-01-01" },
    lines: [line("gold-17"), line("silver-17")],
    invoice_discount: { type: "percent", value: 5 }, coupon_code: "SAVE10", notes: "Call first",
  });
  const loaded = await listHeldCarts();
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].id, held.id);
  assert.deepEqual(loaded[0].lines.map((entry) => entry.variant_id), ["gold-17", "silver-17"]);
  assert.equal(loaded[0].customer?.id, "customer-1");
  assert.equal(loaded[0].coupon_code, "SAVE10");
  assert.equal(loaded[0].lines[0].item_discount?.value, 3);
  await removeHeldCart(held.id);
  assert.equal((await listHeldCarts()).length, 0);
});
