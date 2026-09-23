/**
 * Phase 55 — customer CRM arithmetic.
 *
 * AOV is the average completed invoice total before refunds.
 * Net customer value subtracts completed refund amounts once, never list price.
 * Phone match is display-only. Duplicate phones are reported, not merged.
 */
import assert from "node:assert/strict";
import process from "node:process";

import type { Customer } from "../types";
import type { Sale, SaleItem } from "@/modules/pos/types";
import type { SalesReturn } from "@/modules/returns/types";
import {
  CRM_RULES,
  attributeSales,
  buildCustomerDirectory,
  customerKpis,
  customerMatchesQuery,
  customerSegments,
  favoriteCategories,
  favoriteProducts,
  queryDirectory,
} from "../services/crm";

type TestCase = { name: string; fn: () => void | Promise<void> };
const tests: TestCase[] = [];
function test(name: string, fn: () => void | Promise<void>) {
  tests.push({ name, fn });
}

const NOW = "2026-09-23T12:00:00.000Z";

function customer(partial: Partial<Customer> & { id: string }): Customer {
  return {
    name: "Ahmed",
    phone: "01001234567",
    email: null,
    address: null,
    notes: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...partial,
  };
}

function item(partial: Partial<SaleItem> & { id: string; sale_id: string; product_id: string }): SaleItem {
  return {
    name_ar: partial.product_id,
    name_en: partial.product_id,
    sku: partial.product_id,
    barcode: null,
    variant_id: null,
    variant_color_ar: null,
    variant_color_en: null,
    variant_size: null,
    variant_size_label: null,
    unit_price: 100,
    quantity: 1,
    line_total: 100,
    ...partial,
  };
}

function sale(partial: Partial<Sale> & { id: string; total: number }): Sale {
  return {
    sale_number: `INV-${partial.id}`,
    client_ref: `ref-${partial.id}`,
    status: "completed",
    subtotal: partial.subtotal ?? partial.total,
    discount_type: "none",
    discount_value: 0,
    discount_amount: 0,
    user_id: "u1",
    user_name: "Cashier",
    items: partial.items ?? [],
    payments: [],
    customer_id: "ahmed",
    customer_name: "Ahmed",
    customer_phone: "01001234567",
    created_at: "2026-06-01T10:00:00.000Z",
    voided_at: null,
    void_reason: null,
    payment_method: "cash",
    payment_status: "paid",
    amount_received: partial.total,
    change: 0,
    paid_at: null,
    paid_by: null,
    paid_by_name: null,
    source: "pos",
    ...partial,
  };
}

function ret(partial: Partial<SalesReturn> & { id: string; refund_amount: number }): SalesReturn {
  return {
    return_number: `RET-${partial.id}`,
    sale_id: "s1",
    sale_number: "INV-s1",
    customer_id: "ahmed",
    customer_name: "Ahmed",
    reason: "changed mind",
    refund_method: "cash",
    refund_status: "completed",
    user_id: "u1",
    user_name: "Cashier",
    items: [],
    created_at: "2026-06-02T10:00:00.000Z",
    ...partial,
  };
}

test("Ahmed: paid 5000, count 3, AOV 1666.67 before the refund, net 4500", () => {
  const sales = [
    sale({ id: "s1", total: 1000, created_at: "2026-06-01T10:00:00.000Z" }),
    sale({ id: "s2", total: 1500, created_at: "2026-06-02T10:00:00.000Z" }),
    sale({ id: "s3", total: 2500, created_at: "2026-06-03T10:00:00.000Z" }),
    sale({ id: "void", total: 999, status: "voided" }),
    sale({ id: "pending", total: 400, status: "pending" }),
  ];
  const kpis = customerKpis(sales, [ret({ id: "r1", refund_amount: 500 })]);
  assert.equal(kpis.paidTotal, 5000);
  assert.equal(kpis.purchaseCount, 3);
  assert.equal(kpis.aov, 1666.67, "AOV is paid / count, before refunds");
  assert.equal(kpis.refundTotal, 500);
  assert.equal(kpis.netValue, 4500);
  assert.equal(kpis.lastPurchaseAt, "2026-06-03T10:00:00.000Z");
  assert.equal(CRM_RULES.aovBasis, "completed_invoice_total_before_refunds");
});

test("a refund uses the refunded amount, not the original list price", () => {
  const kpis = customerKpis(
    [sale({ id: "s1", total: 5000, subtotal: 5800, discount_amount: 800, total_discount_amount: 800 })],
    [ret({ id: "r1", refund_amount: 700 })],
  );
  assert.equal(kpis.paidTotal, 5000);
  assert.equal(kpis.refundTotal, 700);
  assert.equal(kpis.netValue, 4300);
});

test("rejected and pending refunds do not reduce net value, and a refund is not counted twice", () => {
  const completed = ret({ id: "r1", refund_amount: 500 });
  const kpis = customerKpis(
    [sale({ id: "s1", total: 5000 })],
    [completed, completed, ret({ id: "r2", refund_amount: 900, refund_status: "rejected" }), ret({ id: "r3", refund_amount: 200, refund_status: "pending" })],
  );
  assert.equal(kpis.refundTotal, 500);
  assert.equal(kpis.netValue, 4500);
});

test("POS and online totals do not double-count the same sale", () => {
  const kpis = customerKpis(
    [
      sale({ id: "pos", total: 1000, source: "pos" }),
      sale({ id: "web", total: 2500, source: "online" }),
    ],
    [],
  );
  assert.equal(kpis.posPaid, 1000);
  assert.equal(kpis.posCount, 1);
  assert.equal(kpis.onlinePaid, 2500);
  assert.equal(kpis.onlineCount, 1);
  assert.equal(kpis.paidTotal, 3500);
  assert.equal(kpis.posPaid + kpis.onlinePaid, kpis.paidTotal);
});

test("an online sale with no customer id is shown on the one matching phone, and the record is not rewritten", () => {
  const book = [customer({ id: "ahmed", phone: "01001234567" })];
  const before = book[0].phone;
  const online = sale({
    id: "web",
    total: 800,
    source: "online",
    customer_id: null,
    customer_phone: "+20 100 123 4567",
  });
  const attribution = attributeSales(book, [online]);
  assert.equal(attribution.byCustomer.get("ahmed")?.length, 1);
  assert.equal(attribution.unattributed.length, 0);
  assert.equal(book[0].phone, before, "stored phone is not rewritten");
  assert.equal(online.customer_id, null, "the sale link is not written");
});

test("duplicate phones are reported and an unlinked sale is not guessed onto either", () => {
  const book = [
    customer({ id: "a", name: "Ahmed One", phone: "01001111111" }),
    customer({ id: "b", name: "Ahmed Two", phone: "+20 100 111 1111" }),
  ];
  const snapshot = book.map((entry) => ({ ...entry }));
  const attribution = attributeSales(book, [
    sale({ id: "loose", total: 50, customer_id: null, customer_phone: "01001111111" }),
    sale({ id: "linked", total: 70, customer_id: "a", customer_phone: "01001111111" }),
  ]);
  assert.equal(attribution.duplicateGroups.length, 1);
  assert.equal(attribution.duplicateGroups[0].length, 2);
  assert.equal(attribution.unattributed.length, 1);
  assert.equal(attribution.unattributed[0].id, "loose");
  assert.equal(attribution.byCustomer.get("a")?.length, 1);
  assert.equal(attribution.byCustomer.get("b"), undefined);
  assert.deepEqual(book, snapshot, "no destructive merge");
});

test("a sale already linked by id is not moved because the phone looks like someone else", () => {
  const book = [
    customer({ id: "a", phone: "01001111111" }),
    customer({ id: "b", phone: "01002222222" }),
  ];
  const attribution = attributeSales(book, [
    sale({ id: "s1", total: 10, customer_id: "a", customer_phone: "01002222222" }),
  ]);
  assert.equal(attribution.byCustomer.get("a")?.[0].id, "s1");
  assert.equal(attribution.byCustomer.get("b"), undefined);
});

test("list roll-ups do not depend on line items", () => {
  const book = [customer({ id: "ahmed" })];
  const withItems = sale({
    id: "s1",
    total: 1000,
    items: [item({ id: "i1", sale_id: "s1", product_id: "p", quantity: 5, line_total: 1000 })],
  });
  const headersOnly = sale({ id: "s1", total: 1000, items: [] });
  const a = buildCustomerDirectory(book, [withItems], []).rows[0].kpis;
  const b = buildCustomerDirectory(book, [headersOnly], []).rows[0].kpis;
  assert.deepEqual(a, b);
});

test("Product A ranks first by units, and the category comes from the purchased product", () => {
  const sales = [
    sale({
      id: "s1",
      total: 800,
      items: [
        item({ id: "a", sale_id: "s1", product_id: "A", quantity: 5, line_total: 500, name_en: "Product A", name_ar: "منتج أ" }),
        item({ id: "b", sale_id: "s1", product_id: "B", quantity: 2, line_total: 200, name_en: "Product B", name_ar: "منتج ب" }),
        item({ id: "c", sale_id: "s1", product_id: "C", quantity: 1, line_total: 100, name_en: "Product C", name_ar: "منتج ج" }),
      ],
    }),
  ];
  const ranked = favoriteProducts(sales, [
    { id: "A", category_id: "rings", name_ar: "منتج أ", name_en: "Product A" },
    { id: "B", category_id: "rings", name_ar: "منتج ب", name_en: "Product B" },
    { id: "C", category_id: "bags", name_ar: "منتج ج", name_en: "Product C" },
  ]);
  assert.equal(ranked[0].productId, "A");
  assert.equal(ranked[0].units, 5);
  assert.deepEqual(ranked.map((row) => row.units), [5, 2, 1]);
  const categories = favoriteCategories(ranked, [
    { id: "rings", name_ar: "خواتم", name_en: "Rings" },
    { id: "bags", name_ar: "حقائب", name_en: "Bags" },
  ]);
  assert.equal(categories[0].categoryId, "rings");
  assert.equal(categories[0].units, 7);
  assert.equal(categories[0].nameEn, "Rings");
});

test("Gold/17 and Silver/17 do not collapse", () => {
  const sales = [
    sale({
      id: "s1",
      total: 300,
      items: [
        item({
          id: "g",
          sale_id: "s1",
          product_id: "ring",
          variant_id: "gold-17",
          variant_color_en: "Gold",
          variant_size: 17,
          quantity: 2,
          line_total: 200,
        }),
        item({
          id: "s",
          sale_id: "s1",
          product_id: "ring",
          variant_id: "silver-17",
          variant_color_en: "Silver",
          variant_size: 17,
          quantity: 1,
          line_total: 100,
        }),
      ],
    }),
  ];
  const ranked = favoriteProducts(sales, [{ id: "ring", category_id: "rings", name_ar: "خاتم", name_en: "Ring" }]);
  assert.equal(ranked.length, 2);
  assert.equal(ranked[0].variantLabel, "Gold / 17");
  assert.equal(ranked[1].variantLabel, "Silver / 17");
});

test("search matches name, phone and email without caring about case or phone spacing", () => {
  const rows = buildCustomerDirectory(
    [
      customer({ id: "ahmed", name: "Ahmed Al-Sharif", phone: "01001234567", email: "Ahmed@Example.com" }),
      customer({ id: "sara", name: "Sara", phone: "01009998887", email: "sara@alyq.example" }),
    ],
    [],
    [],
    NOW,
  ).rows;
  assert.equal(queryDirectory(rows, "AHMED", "spend")[0].customer.id, "ahmed");
  assert.equal(queryDirectory(rows, "0100 123 4567", "spend")[0].customer.id, "ahmed");
  assert.equal(queryDirectory(rows, "ahmed@example.com", "spend")[0].customer.id, "ahmed");
  assert.equal(queryDirectory(rows, "nobody", "spend").length, 0);
  assert.equal(customerMatchesQuery(rows[1].customer, "SARA@alyq"), true);
});

test("segments are documented thresholds, not a score", () => {
  const fresh = customer({ id: "n", created_at: "2026-09-10T00:00:00.000Z" });
  const quiet = customer({ id: "q", created_at: "2025-01-01T00:00:00.000Z" });
  const kpis = customerKpis(
    [sale({ id: "s1", total: 3000 }), sale({ id: "s2", total: 3000, created_at: "2026-01-01T00:00:00.000Z" })],
    [],
  );
  assert.ok(customerSegments(fresh, customerKpis([], []), NOW).includes("new"));
  assert.ok(customerSegments(quiet, kpis, NOW).includes("returning"));
  assert.ok(customerSegments(quiet, kpis, NOW).includes("high_value"));
  assert.equal(CRM_RULES.highValueNet, 5000);
  assert.equal(CRM_RULES.inactiveDays, 90);
  assert.equal(CRM_RULES.newWindowDays, 30);
  const inactive = customerKpis([sale({ id: "old", total: 100, created_at: "2026-01-01T00:00:00.000Z" })], []);
  assert.ok(customerSegments(quiet, inactive, NOW).includes("inactive"));
});

let passed = 0;
for (const entry of tests) {
  try {
    await entry.fn();
    passed += 1;
    console.log(`  ✓ ${entry.name}`);
  } catch (err) {
    console.error(`  ✗ ${entry.name}`);
    console.error(err);
    process.exit(1);
  }
}
console.log(`\n${passed}/${tests.length} Phase 55 CRM tests passed`);
