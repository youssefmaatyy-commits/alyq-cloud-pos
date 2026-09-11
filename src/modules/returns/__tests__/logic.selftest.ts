/**
 * Phase 7 logic self-test (headless).
 * Run with:  npx esbuild src/modules/returns/__tests__/logic.selftest.ts \
 *              --bundle --format=esm --platform=node --outfile=/tmp/alyq-phase7.mjs && node /tmp/alyq-phase7.mjs
 *
 * Covers customer validation, return validation, refund caps and the demo
 * repository flows: return creation, stock increase, movement records,
 * duplicate/over-return prevention and over-refund prevention.
 */
import assert from "node:assert/strict";
import {
  EMPTY_CUSTOMER_FORM,
  validateCustomerDraft,
} from "@/modules/customers/validation";
import { getDemoReturnRepository } from "../data/demoRepository";
import { getDemoCustomerRepository } from "@/modules/customers/data/demoRepository";
import { getDemoSalesRepository } from "@/modules/pos/data/demoRepository";
import { getDemoRepository } from "@/modules/products/data/demoRepository";
import { getDemoInventoryRepository } from "@/modules/inventory/data/demoRepository";
import type { Sale } from "@/modules/pos/types";

type TestCase = { name: string; fn: () => void | Promise<void> };
const tests: TestCase[] = [];
function test(name: string, fn: () => void | Promise<void>) {
  tests.push({ name, fn });
}

console.log("\nPhase 7 · customers validation");

test("customer requires name and valid phone", () => {
  const empty = validateCustomerDraft({ ...EMPTY_CUSTOMER_FORM }, []);
  assert.equal(empty.errors.name, "nameRequired");
  assert.equal(empty.errors.phone, "phoneRequired");
  assert.equal(empty.data, null);
});

test("customer rejects bad phone and duplicate phone", () => {
  const bad = validateCustomerDraft(
    { ...EMPTY_CUSTOMER_FORM, name: "A", phone: "abc!!" },
    [],
  );
  assert.equal(bad.errors.phone, "phoneInvalid");

  const existing = [
    {
      id: "c1",
      name: "X",
      phone: "0501111111",
      address: null,
      notes: null,
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    },
  ];
  const dup = validateCustomerDraft(
    { ...EMPTY_CUSTOMER_FORM, name: "Y", phone: "0501111111" },
    existing,
  );
  assert.equal(dup.errors.phone, "phoneTaken");

  const self = validateCustomerDraft(
    { ...EMPTY_CUSTOMER_FORM, name: "X", phone: "0501111111" },
    existing,
    "c1",
  );
  assert.equal(self.errors.phone, undefined);
  assert.ok(self.data);
});

console.log("\nPhase 7 · returns validation + demo flows");

const returnsRepo = getDemoReturnRepository();
const customersRepo = getDemoCustomerRepository();
const salesRepo = getDemoSalesRepository();
const catalog = getDemoRepository();
const inventory = getDemoInventoryRepository();

async function bySku(sku: string) {
  const list = await catalog.listProducts();
  const found = list.find((p) => p.sku === sku);
  if (!found) throw new Error(`seed product missing: ${sku}`);
  return found;
}

let saleForReturns!: Sale;

test("add + edit customer, then link customer to a sale", async () => {
  const created = await customersRepo.createCustomer({
    name: "Phase7 Tester",
    phone: "0599000111",
    address: "Riyadh",
    notes: "selftest",
  });
  assert.ok(created.id);
  const updated = await customersRepo.updateCustomer(created.id, {
    address: "Jeddah",
  });
  assert.equal(updated.address, "Jeddah");

  const coffee = await bySku("ALYQ-1002"); // price 68, high stock
  const sale = await salesRepo.completeSale({
    client_ref: `p7-sale-${Date.now()}`,
    lines: [{ product_id: coffee.id, qty: 2 }],
    discount_type: "none",
    discount_value: 0,
    payments: [{ method: "cash", amount: 136, status: "paid", tendered: 136 }],
    customer_id: created.id,
    customer_name: created.name,
    customer_phone: created.phone,
    user_id: "u1",
    user_name: "Tester",
  });
  assert.equal(sale.customer_id, created.id);
  assert.equal(sale.customer_name, "Phase7 Tester");
  saleForReturns = sale;

  const history = (await salesRepo.listSales()).filter((s) => s.customer_id === created.id);
  assert.ok(history.some((s) => s.id === sale.id), "purchase history contains the sale");
});

test("partial return restores stock and records movement + refund", async () => {
  const sale = saleForReturns;
  const line = sale.items[0];
  const stockBefore = (await catalog.listProducts()).find((p) => p.id === line.product_id)!
    .stock_quantity;
  const moveBefore = (await inventory.listMovementsForProduct(line.product_id)).length;

  const { returnRecord, refundRecord } = await returnsRepo.createReturn({
    sale_id: sale.id,
    reason: "Damaged item",
    refund_method: "cash",
    items: [{ sale_item_id: line.id, product_id: line.product_id, quantity: 1 }],
    user_id: "u1",
    user_name: "Tester",
  });

  assert.ok(/^RET-\d{6}$/.test(returnRecord.return_number));
  assert.equal(returnRecord.items.length, 1);
  assert.equal(returnRecord.items[0].quantity, 1);
  assert.equal(returnRecord.items[0].sku, line.sku, "original SKU preserved");
  assert.equal(returnRecord.items[0].unit_price, line.unit_price, "original price preserved");
  assert.equal(returnRecord.refund_amount, line.unit_price);
  assert.ok(/^REF-\d{6}$/.test(refundRecord.refund_number));
  assert.equal(refundRecord.amount, line.unit_price);
  assert.equal(refundRecord.payment_method, "cash");

  const stockAfter = (await catalog.listProducts()).find((p) => p.id === line.product_id)!
    .stock_quantity;
  assert.equal(stockAfter, stockBefore + 1, "stock increased by returned qty");

  const movements = await inventory.listMovementsForProduct(line.product_id);
  const retMove = movements.find((m) => m.notes?.includes(returnRecord.return_number));
  assert.ok(retMove, "stock movement references the return number");
  assert.equal(retMove?.type, "adjustment_in");
  assert.equal(retMove?.reason, "customer_return");
  assert.equal(retMove?.quantity_before, stockBefore);
  assert.equal(retMove?.quantity_after, stockBefore + 1);
  assert.equal(movements.length, moveBefore + 1, "exactly one movement added");
});

test("over-return and duplicate full return are blocked", async () => {
  const sale = saleForReturns;
  const line = sale.items[0]; // sold 2, returned 1 → 1 remaining

  await assert.rejects(
    returnsRepo.createReturn({
      sale_id: sale.id,
      reason: "Too many",
      refund_method: "cash",
      items: [{ sale_item_id: line.id, product_id: line.product_id, quantity: 2 }],
      user_id: "u1",
      user_name: "Tester",
    }),
    /exceed/i,
  );

  // return the last remaining unit
  await returnsRepo.createReturn({
    sale_id: sale.id,
    reason: "Rest of it",
    refund_method: "visa",
    items: [{ sale_item_id: line.id, product_id: line.product_id, quantity: 1 }],
    user_id: "u1",
    user_name: "Tester",
  });

  // now nothing remains — must be blocked, not duplicated
  await assert.rejects(
    returnsRepo.createReturn({
      sale_id: sale.id,
      reason: "Again",
      refund_method: "cash",
      items: [{ sale_item_id: line.id, product_id: line.product_id, quantity: 1 }],
      user_id: "u1",
      user_name: "Tester",
    }),
    /exceed|select|remaining/i,
  );
});

test("refund total can never exceed the sale total", async () => {
  const sale = saleForReturns; // total 136, already refunded 136 across 2 returns
  const refunds = await returnsRepo.getRefundsForSale(sale.id);
  const refunded = refunds.reduce((s, r) => s + r.amount, 0);
  assert.equal(refunded, sale.total, "fully refunded");

  const allRefunds = await returnsRepo.listRefunds();
  const saleRefunds = allRefunds.filter((r) => r.sale_id === sale.id);
  const sum = saleRefunds.reduce((s, r) => s + r.amount, 0);
  assert.ok(sum <= sale.total + 1e-9, "cumulative refunds within sale total");

  // visa refund method is accepted
  const visaMethods = saleRefunds.map((r) => r.payment_method);
  assert.ok(visaMethods.includes("visa"), "visa refund recorded");
});

test("original sale is never modified by returns", async () => {
  const sale = saleForReturns;
  const fresh = await salesRepo.getSale(sale.id);
  assert.equal(fresh.items[0].quantity, 2, "sold quantity untouched");
  assert.equal(fresh.total, 136, "sale total untouched");
});

test("getRemainingReturnableQuantities + getTotalRefundedForSale", async () => {
  const { getRemainingReturnableQuantities: rem, getTotalRefundedForSale: tot } =
    await import("../validation");
  const sale = await salesRepo.getSale(saleForReturns.id);
  const allReturns = await returnsRepo.listReturns();
  const allRefunds = await returnsRepo.listRefunds();
  const map = rem(sale, allReturns);
  assert.equal(map.get(sale.items[0].id), 0, "nothing left to return");
  assert.equal(tot(sale, allRefunds), sale.total, "fully refunded");
});

test("search original sale invoices by invoice number, customer name, phone, date range", async () => {
  const { normalizeText } = await import("@/modules/products/services/productQuery");
  const allSales = await salesRepo.listSales();
  assert.ok(allSales.length >= 1, "at least one sale exists for search testing");

  const targetSale = saleForReturns; // INV-..., customer: "Phase7 Tester", phone: "0599000111"

  // 1. Search by Invoice number
  const byInvoice = allSales.filter((s) => {
    const hay = normalizeText(`${s.sale_number} ${s.customer_name ?? ""} ${s.customer_phone ?? ""}`);
    return hay.includes(normalizeText(targetSale.sale_number));
  });
  assert.ok(byInvoice.length > 0, "invoice number search finds sale");
  assert.ok(byInvoice.some((s) => s.id === targetSale.id), "target sale in invoice search results");

  // 2. Search by Customer name
  const byName = allSales.filter((s) => {
    const hay = normalizeText(`${s.sale_number} ${s.customer_name ?? ""} ${s.customer_phone ?? ""}`);
    return hay.includes(normalizeText("Phase7 Tester"));
  });
  assert.ok(byName.length > 0, "customer name search finds sale");
  assert.equal(byName[0].customer_name, "Phase7 Tester");

  // 3. Search by Customer phone
  const byPhone = allSales.filter((s) => {
    const hay = normalizeText(`${s.sale_number} ${s.customer_name ?? ""} ${s.customer_phone ?? ""}`);
    return hay.includes(normalizeText("0599000111"));
  });
  assert.ok(byPhone.length > 0, "customer phone search finds sale");
  assert.equal(byPhone[0].id, targetSale.id);

  // 4. Date range filter
  const today = new Date();
  const fromTime = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const toTime = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 23, 59, 59, 999).getTime();

  const byDate = allSales.filter((s) => {
    const t = new Date(s.created_at).getTime();
    return t >= fromTime && t <= toTime;
  });
  assert.ok(byDate.some((s) => s.id === targetSale.id), "sale falls in date range");

  // Out of range (future date) yields zero
  const futureFrom = new Date(today.getFullYear() + 1, 0, 1).getTime();
  const byFutureDate = allSales.filter((s) => {
    const t = new Date(s.created_at).getTime();
    return t >= futureFrom;
  });
  assert.equal(byFutureDate.length, 0, "future date filter correctly returns no sales");
});

// ── Returns & Customer reports ─────────────────────────────────────────────

console.log("\nPhase 7 · returns & customer reports");

await (async () => {
  const { computeCustomerAnalytics, computeReturnsAnalytics } = await import(
    "../services/returnsReports"
  );
  type Customer = { id: string; name: string; phone: string; address: string | null; notes: string | null; created_at: string; updated_at: string };

  function cust(id: string, name: string): Customer {
    return { id, name, phone: "0100000000", address: null, notes: null, created_at: "2026-01-01", updated_at: "2026-01-01" };
  }

  function mkSale(id: string, customerId: string | null, total: number, status: "completed" | "voided" = "completed"): Sale {
    return {
      id, sale_number: `INV-${id}`, client_ref: `ref-${id}`, status,
      subtotal: total, discount_type: "none", discount_value: 0, discount_amount: 0, total,
      user_id: "u1", user_name: "Cashier", items: [], payments: [],
      customer_id: customerId, created_at: "2026-09-10T12:00:00Z",
      voided_at: null, void_reason: null, payment_method: "cash", payment_status: "paid",
      amount_received: total, change: 0, paid_at: "2026-09-10", paid_by: "u1", paid_by_name: "Cashier",
    } as Sale;
  }

  test("customer analytics: empty data", () => {
    const report = computeCustomerAnalytics([], [], []);
    assert.equal(report.activeCustomers, 0);
    assert.equal(report.totalRevenue, 0);
  });

  test("customer analytics: computes per-customer totals", () => {
    const customers = [cust("c1", "Alice"), cust("c2", "Bob")];
    const sales = [
      mkSale("s1", "c1", 100),
      mkSale("s2", "c1", 200),
      mkSale("s3", "c2", 50),
    ];
    const report = computeCustomerAnalytics(customers, sales, []);
    assert.equal(report.activeCustomers, 2);
    assert.equal(report.totalRevenue, 350);
    const alice = report.customers.find((c) => c.customer_id === "c1")!;
    assert.equal(alice.totalSpent, 300);
    assert.equal(alice.totalPurchases, 2);
    assert.equal(alice.averageOrderValue, 150);
  });

  test("customer analytics: voided sales excluded", () => {
    const customers = [cust("c1", "Alice")];
    const sales = [mkSale("s1", "c1", 100), mkSale("s2", "c1", 500, "voided")];
    const report = computeCustomerAnalytics(customers, sales, []);
    const alice = report.customers[0];
    assert.equal(alice.totalSpent, 100);
    assert.equal(alice.totalPurchases, 1);
  });

  test("customer analytics: returns deducted from net", () => {
    const customers = [cust("c1", "Alice")];
    const sales = [mkSale("s1", "c1", 100)];
    const returns = [{
      id: "r1", return_number: "RET-1", sale_id: "s1", sale_number: "INV-s1",
      customer_id: "c1", customer_name: "Alice", reason: "test",
      refund_amount: 30, refund_method: "cash", refund_status: "completed",
      user_id: "u1", user_name: "Cashier", items: [], created_at: "2026-09-10",
    }];
    const report = computeCustomerAnalytics(customers, sales, returns as any);
    assert.equal(report.customers[0].netSpent, 70);
    assert.equal(report.totalRefunded, 30);
  });

  test("customer analytics: top N customers", () => {
    const customers = [cust("c1", "A"), cust("c2", "B"), cust("c3", "C")];
    const sales = [mkSale("s1", "c1", 100), mkSale("s2", "c2", 300), mkSale("s3", "c3", 200)];
    const report = computeCustomerAnalytics(customers, sales, [], 2);
    assert.equal(report.topCustomers.length, 2);
    assert.equal(report.topCustomers[0].name, "B"); // highest spender
  });

  test("returns analytics: empty data", () => {
    const report = computeReturnsAnalytics([], []);
    assert.equal(report.totalReturns, 0);
    assert.equal(report.totalRefundAmount, 0);
  });

  test("returns analytics: aggregates by method", () => {
    const refunds = [
      { id: "r1", refund_number: "REF-1", sale_id: "s1", sale_number: "INV-1", return_id: null, amount: 50, payment_method: "cash", status: "completed", reason: null, user_id: "u1", user_name: "Cashier", created_at: "2026-09-10" },
      { id: "r2", refund_number: "REF-2", sale_id: "s2", sale_number: "INV-2", return_id: null, amount: 30, payment_method: "visa", status: "pending", reason: null, user_id: "u1", user_name: "Cashier", created_at: "2026-09-10" },
    ];
    const report = computeReturnsAnalytics([], refunds as any);
    const cash = report.byMethod.find((m) => m.method === "cash")!;
    assert.equal(cash.completedAmount, 50);
    const visa = report.byMethod.find((m) => m.method === "visa")!;
    assert.equal(visa.pendingAmount, 30);
    assert.equal(report.pendingRefunds, 1);
  });

  test("returns analytics: most returned products", () => {
    const returns = [{
      id: "r1", return_number: "RET-1", sale_id: "s1", sale_number: "INV-1",
      customer_id: null, customer_name: null, reason: "test",
      refund_amount: 100, refund_method: "cash", refund_status: "completed",
      user_id: "u1", user_name: "Cashier",
      items: [
        { id: "i1", return_id: "r1", sale_item_id: "si1", product_id: "p1", name_ar: "", name_en: "Coffee", sku: "C-1", barcode: null, unit_price: 10, quantity: 3, line_total: 30 },
        { id: "i2", return_id: "r1", sale_item_id: "si2", product_id: "p2", name_ar: "", name_en: "Tea", sku: "T-1", barcode: null, unit_price: 5, quantity: 1, line_total: 5 },
      ],
      created_at: "2026-09-10T12:00:00Z",
    }];
    const report = computeReturnsAnalytics(returns as any, []);
    assert.equal(report.topReturnedProducts[0].name_en, "Coffee");
    assert.equal(report.topReturnedProducts[0].totalReturned, 3);
  });
})();

// runner — sequential so each test sees a consistent in-memory catalog
let passed = 0;
async function main(): Promise<void> {
  for (const { name, fn } of tests) {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  }
  console.log(`\n${passed}/${tests.length} Phase 7 tests passed.\n`);
}

await main();
