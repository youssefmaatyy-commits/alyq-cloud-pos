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
