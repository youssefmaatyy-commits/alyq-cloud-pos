/**
 * Sale returnability — what the returns modal is allowed to say (no DOM, no DB).
 *
 * Run with:
 *   npx esbuild src/modules/returns/__tests__/returnability.selftest.ts \
 *     --bundle --format=esm --platform=node --outfile=/tmp/alyq-returnability.mjs && node /tmp/alyq-returnability.mjs
 *
 * The modal's three states come from one function, so the rules can be tested
 * here rather than by driving a browser:
 *
 *   · a fresh sale is RETURN-ABLE — never "fully returned",
 *   · a sale whose lines did not load is "unavailable" — a missing-data state,
 *     and emphatically NOT a completed return (the INV-000004 false banner),
 *   · a fully returned sale is the only thing allowed to say "already returned",
 *   · partial/completed returns hold their quantity, and a REJECTED return holds
 *     none — the parity migration 0041 restored, which must not regress.
 *
 * The modal itself is pinned by the wiring test at the end: it must render the
 * "already returned" banner only when the state is not "unavailable".
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { saleReturnability } from "../services/saleReturnability";
import type { Sale, SaleItem } from "@/modules/pos/types";
import type { ReturnItem, SalesReturn } from "../types";

type TestCase = { name: string; fn: () => void };
const tests: TestCase[] = [];
const test = (name: string, fn: () => void) => tests.push({ name, fn });

// ── fixtures ─────────────────────────────────────────────────────────────────
const line = (id: string, quantity: number, unitPrice = 350): SaleItem => ({
  id,
  sale_id: "sale-1",
  product_id: `prod-${id}`,
  variant_id: null,
  variant_color_ar: null,
  variant_color_en: null,
  variant_size: null,
  variant_size_label: null,
  name_ar: "خاتم",
  name_en: "Classic Gold Ring",
  sku: `SKU-${id}`,
  barcode: null,
  unit_price: unitPrice,
  quantity,
  line_total: unitPrice * quantity,
});

const sale = (items: SaleItem[]): Sale => ({
  id: "sale-1",
  sale_number: "INV-000004",
  client_ref: "ref-1",
  status: "completed",
  subtotal: 700,
  discount_type: "none",
  discount_value: 0,
  discount_amount: 0,
  total: 700,
  user_id: "u-cashier",
  user_name: "Karim Cashier",
  items,
  payments: [],
  customer_id: "cust-1",
  customer_name: "أحمد الشريف",
  customer_phone: "0501234567",
  created_at: "2026-09-16T09:00:00.000Z",
  voided_at: null,
  void_reason: null,
  payment_method: "cash",
  payment_status: "paid",
  amount_received: 700,
  change: 0,
  paid_at: "2026-09-16T09:00:00.000Z",
  paid_by: "u-cashier",
  paid_by_name: "Karim Cashier",
  source: "pos",
  shift_id: "shift-1",
});

const returned = (
  id: string,
  refundStatus: SalesReturn["refund_status"],
  lines: Array<{ sale_item_id: string; quantity: number }>,
): SalesReturn => ({
  id: `ret-${id}`,
  return_number: `RET-00000${id}`,
  sale_id: "sale-1",
  sale_number: "INV-000004",
  customer_id: "cust-1",
  customer_name: "أحمد الشريف",
  reason: "Damaged on the way out",
  refund_amount: 350,
  refund_method: "cash",
  refund_status: refundStatus,
  user_id: "u-cashier",
  user_name: "Karim Cashier",
  items: lines.map(
    (l, index): ReturnItem => ({ variant_id: null, variant_color_ar: null, variant_color_en: null, variant_size: null, variant_size_label: null,
      id: `ret-${id}-item-${index}`,
      return_id: `ret-${id}`,
      sale_item_id: l.sale_item_id,
      product_id: `prod-${l.sale_item_id}`,
      name_ar: "خاتم",
      name_en: "Classic Gold Ring",
      sku: `SKU-${l.sale_item_id}`,
      barcode: null,
      unit_price: 350,
      quantity: l.quantity,
      line_total: 350 * l.quantity,
    }),
  ),
  created_at: "2026-09-16T11:00:00.000Z",
});

const FRESH = sale([line("line-1", 1), line("line-2", 2, 175)]);

// ── the state machine ────────────────────────────────────────────────────────
test("a fresh invoice is returnable, not 'already returned'", () => {
  const result = saleReturnability(FRESH, []);

  assert.equal(result.state, "returnable", "a brand-new sale offers a return");
  assert.equal(result.returnableMap.get("line-1"), 1, "line 1 keeps its full quantity");
  assert.equal(result.returnableMap.get("line-2"), 2, "line 2 keeps its full quantity");
});

test("REGRESSION: a sale whose lines never loaded is 'unavailable', never 'fully-returned'", () => {
  // This is exactly what `listSales()` used to hand the modal: `items: []` for a
  // sale whose rows existed. The modal showed "تم إرجاع كافة أصناف هذه الفاتورة
  // مسبقًا" — an accusation of a completed return, on a fresh invoice.
  const itemless = sale([]);
  const result = saleReturnability(itemless, []);

  assert.equal(result.state, "unavailable", "missing lines are reported as missing data");
  assert.notEqual(result.state, "fully-returned", "missing lines must never read as a completed return");
  assert.equal(result.returnableMap.size, 0, "nothing is offered while the lines are unknown");
});

test("only a genuinely exhausted sale says 'fully-returned'", () => {
  const exhausted = saleReturnability(FRESH, [
    returned("1", "completed", [
      { sale_item_id: "line-1", quantity: 1 },
      { sale_item_id: "line-2", quantity: 2 },
    ]),
  ]);

  assert.equal(exhausted.state, "fully-returned", "every unit has come back");
  assert.equal(exhausted.returnableMap.get("line-1"), 0, "line 1 is exhausted");
  assert.equal(exhausted.returnableMap.get("line-2"), 0, "line 2 is exhausted");
});

test("a partial return leaves the rest returnable, per line", () => {
  const result = saleReturnability(FRESH, [
    returned("1", "completed", [{ sale_item_id: "line-2", quantity: 1 }]),
  ]);

  assert.equal(result.state, "returnable", "one unit back, two still out");
  assert.equal(result.returnableMap.get("line-1"), 1, "the untouched line is untouched");
  assert.equal(result.returnableMap.get("line-2"), 1, "the returned line drops by exactly what came back");
});

test("a pending return holds its quantity but the rest stays returnable", () => {
  const result = saleReturnability(FRESH, [
    returned("1", "pending", [{ sale_item_id: "line-1", quantity: 1 }]),
  ]);

  assert.equal(result.state, "returnable", "a pending refund does not block the other line");
  assert.equal(result.returnableMap.get("line-1"), 0, "goods already back cannot be returned twice");
  assert.equal(result.returnableMap.get("line-2"), 2, "the other line is unaffected");
});

test("0041 parity: a REJECTED return releases its quantity for a fresh attempt", () => {
  const result = saleReturnability(FRESH, [
    returned("1", "rejected", [{ sale_item_id: "line-1", quantity: 1 }]),
  ]);

  assert.equal(result.state, "returnable", "a rejected refund returns nothing, so nothing is held");
  assert.equal(result.returnableMap.get("line-1"), 1, "the line is fully returnable again");
});

test("0041 parity: a rejected full return does not lock the invoice", () => {
  const result = saleReturnability(FRESH, [
    returned("1", "rejected", [
      { sale_item_id: "line-1", quantity: 1 },
      { sale_item_id: "line-2", quantity: 2 },
    ]),
  ]);

  assert.equal(result.state, "returnable", "a rejected return must never read as fully returned");
  assert.equal(result.returnableMap.get("line-1"), 1, "line 1 released");
  assert.equal(result.returnableMap.get("line-2"), 2, "line 2 released");
});

test("a completed return plus a rejected one releases only the rejected quantity", () => {
  const result = saleReturnability(FRESH, [
    returned("1", "completed", [{ sale_item_id: "line-2", quantity: 1 }]),
    returned("2", "rejected", [{ sale_item_id: "line-2", quantity: 1 }]),
  ]);

  assert.equal(result.returnableMap.get("line-2"), 1, "1 of 2 came back for good; the rejected unit is free");
  assert.equal(result.state, "returnable", "the invoice still has something to return");
});

test("returns belonging to another sale are ignored", () => {
  const foreign = { ...returned("9", "completed", [{ sale_item_id: "line-1", quantity: 1 }]), sale_id: "sale-99" };
  const result = saleReturnability(FRESH, [foreign]);

  assert.equal(result.state, "returnable", "another sale's return does not touch this one");
  assert.equal(result.returnableMap.get("line-1"), 1, "this line is untouched");
});

test("more returned than sold cannot drive a line negative", () => {
  const result = saleReturnability(FRESH, [
    returned("1", "completed", [{ sale_item_id: "line-1", quantity: 5 }]),
  ]);

  assert.equal(result.returnableMap.get("line-1"), 0, "clamped at zero, never negative");
});

// ── the modal's wiring ───────────────────────────────────────────────────────
test("the modal renders 'already returned' only when the state is not 'unavailable'", () => {
  const file = path.join(process.cwd(), "src/modules/returns/components/ReturnFormModal.tsx");
  const body = fs.readFileSync(file, "utf8");

  assert.match(body, /saleReturnability\(/, "the modal asks the shared rule, not its own copy");
  assert.match(body, /state === "unavailable"/, "the missing-data state is read from that rule");
  assert.match(
    body,
    /itemsUnavailable\s*\?\s*\(/,
    "the missing-data case is separated in the render before the banner",
  );

  // The banner must sit in the itemless branch, not beside it: 'allReturned'
  // may only be reached when there ARE lines.
  const withoutBranch = body.slice(body.indexOf('state === "unavailable"'), body.indexOf('t("returns.allReturned")'));
  assert.ok(
    withoutBranch.length > 0 && withoutBranch.includes("itemsUnavailable ?"),
    "the allReturned banner is behind the itemsUnavailable branch",
  );
});

test("submitting fails closed when the lines are missing", () => {
  const file = path.join(process.cwd(), "src/modules/returns/components/ReturnFormModal.tsx");
  const body = fs.readFileSync(file, "utf8");

  assert.match(
    body,
    /if \(itemsUnavailable\) \{\s*\n\s*toast\.error\(t\("returns\.itemsUnavailable"\)\);\s*\n\s*return;/,
    "handleSubmit refuses before validation can mislabel the case as 'no items selected'",
  );
});

// ── runner ───────────────────────────────────────────────────────────────────
let failures = 0;
for (const { name, fn } of tests) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`  ✗ ${name}`);
    console.error(`      ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
  }
}

if (failures > 0) {
  console.error(`\n✗ sale returnability: ${failures} failure(s)\n`);
  process.exit(1);
}
console.log(`\n✓ sale returnability: ${tests.length} test(s) passed\n`);
