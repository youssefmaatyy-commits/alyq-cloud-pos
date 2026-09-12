/**
 * Dashboard query self-test (headless, Node).
 *
 * Covers every pure function in dashboardQuery.ts: sales KPIs, catalog KPIs,
 * returns KPIs, expenses KPIs, recent-sales ordering, and the composite
 * snapshot builder. No React, no network, no mock data — just reducers over
 * domain records.
 */
import assert from "node:assert/strict";
import {
  computeSalesKpis,
  computeCatalogKpis,
  computeReturnsKpis,
  computeExpensesKpis,
  recentSales,
  buildDashboardSnapshot,
} from "../dashboardQuery";
import type { Sale } from "@/modules/pos/types";
import type { Product } from "@/modules/products/types";
import type { SalesReturn, RefundRecord } from "@/modules/returns/types";
import type { Expense } from "@/modules/expenses/types";

type TestCase = { name: string; fn: () => void | Promise<void> };
const tests: TestCase[] = [];
function test(name: string, fn: () => void | Promise<void>) {
  tests.push({ name, fn });
}

// ── Fixtures ────────────────────────────────────────────────────────────────

/**
 * A timestamp that is inside today at *any* hour the suite happens to run.
 *
 * Anchored to noon rather than to `now` on purpose. Subtracting hours from the
 * current time rolled fixtures into yesterday between 00:00 and 03:00, which
 * made "expenses: today vs total" fail depending on the clock instead of the
 * code — and clamping only the rolled values broke the ordering the
 * `recentSales` tests rely on, because a clamped 00:57 is *newer* than a real
 * 01:00. A fixed anchor keeps every fixture on the same day and monotonic:
 * a larger `hoursAgo` is always older.
 *
 * `isToday()` in the code under test is `>= startOfToday()`, so a timestamp
 * later today still counts as today.
 */
function todayISO(hoursAgo = 0): string {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setHours(d.getHours() - hoursAgo);
  return d.toISOString();
}

/** Yesterday at noon, for the same reason — never a rolling 24 hours ago. */
function yesterdayISO(): string {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  d.setHours(12, 0, 0, 0);
  return d.toISOString();
}

function sale(partial: Partial<Sale> & { id: string; total: number }): Sale {
  return {
    sale_number: `INV-${partial.id}`,
    client_ref: `ref-${partial.id}`,
    status: "completed",
    subtotal: partial.total,
    discount_type: "none",
    discount_value: 0,
    discount_amount: 0,
    user_id: "u1",
    user_name: "Cashier",
    items: [],
    payments: [],
    created_at: todayISO(1),
    voided_at: null,
    void_reason: null,
    payment_method: "cash",
    payment_status: "paid",
    amount_received: partial.total,
    change: 0,
    paid_at: todayISO(1),
    paid_by: "u1",
    paid_by_name: "Cashier",
    ...partial,
  } as Sale;
}

function product(partial: Partial<Product> & { id: string }): Product {
  return {
    sku: `SKU-${partial.id}`,
    name_ar: "منتج",
    name_en: "Product",
    description_ar: null,
    description_en: null,
    category_id: null,
    product_type: "good",
    selling_price: 100,
    cost_price: 50,
    tax_rate: 0,
    barcode: null,
    stock_tracking_enabled: true,
    stock_quantity: 10,
    low_stock_level: 3,
    show_on_website: true,
    is_featured: false,
    active: true,
    images: [],
    created_at: todayISO(),
    updated_at: todayISO(),
    ...partial,
  } as Product;
}

function salesReturn(partial: Partial<SalesReturn> & { id: string; refund_amount: number }): SalesReturn {
  return {
    return_number: `RET-${partial.id}`,
    sale_id: "s1",
    sale_number: "INV-1",
    customer_id: null,
    customer_name: null,
    reason: "test",
    refund_method: "cash",
    refund_status: "completed",
    user_id: "u1",
    user_name: "Cashier",
    items: [],
    created_at: todayISO(1),
    ...partial,
  } as SalesReturn;
}

function refund(partial: Partial<RefundRecord> & { id: string; amount: number }): RefundRecord {
  return {
    refund_number: `REF-${partial.id}`,
    sale_id: "s1",
    sale_number: "INV-1",
    return_id: null,
    payment_method: "cash",
    status: "completed",
    reason: null,
    user_id: "u1",
    user_name: "Cashier",
    created_at: todayISO(1),
    ...partial,
  } as RefundRecord;
}

function expense(partial: Partial<Expense> & { id: string; amount: number }): Expense {
  return {
    expense_number: `EXP-${partial.id}`,
    name: "Transport",
    category: "transport",
    payment_method: "cash",
    spent_at: todayISO(1),
    notes: null,
    attachment_url: null,
    attachment_name: null,
    branch: null,
    shift_id: null,
    user_id: "u1",
    user_name: "Cashier",
    created_at: todayISO(1),
    updated_at: todayISO(1),
    ...partial,
  } as Expense;
}

// ── Sales KPIs ──────────────────────────────────────────────────────────────

test("sales: empty list yields zeroes", () => {
  const kpis = computeSalesKpis([]);
  assert.equal(kpis.todayRevenue, 0);
  assert.equal(kpis.todayCount, 0);
  assert.equal(kpis.totalRevenue, 0);
  assert.equal(kpis.totalCount, 0);
  assert.equal(kpis.pendingCount, 0);
  assert.equal(kpis.pendingTotal, 0);
});

test("sales: completed sales today counted in both today and total", () => {
  const sales = [
    sale({ id: "1", total: 100, created_at: todayISO(2) }),
    sale({ id: "2", total: 250, created_at: todayISO(1) }),
  ];
  const kpis = computeSalesKpis(sales);
  assert.equal(kpis.todayRevenue, 350);
  assert.equal(kpis.todayCount, 2);
  assert.equal(kpis.totalRevenue, 350);
  assert.equal(kpis.totalCount, 2);
});

test("sales: yesterday's sale excluded from today but included in total", () => {
  const sales = [
    sale({ id: "1", total: 100, created_at: todayISO(1) }),
    sale({ id: "2", total: 200, created_at: yesterdayISO() }),
  ];
  const kpis = computeSalesKpis(sales);
  assert.equal(kpis.todayRevenue, 100);
  assert.equal(kpis.todayCount, 1);
  assert.equal(kpis.totalRevenue, 300);
  assert.equal(kpis.totalCount, 2);
});

test("sales: voided sales excluded from revenue and counts", () => {
  const sales = [
    sale({ id: "1", total: 100 }),
    sale({ id: "2", total: 500, status: "voided" }),
  ];
  const kpis = computeSalesKpis(sales);
  assert.equal(kpis.totalRevenue, 100);
  assert.equal(kpis.totalCount, 1);
});

test("sales: pending InstaPay sales tracked separately", () => {
  const sales = [
    sale({ id: "1", total: 100 }),
    sale({ id: "2", total: 200, status: "pending" }),
    sale({ id: "3", total: 50, status: "pending" }),
  ];
  const kpis = computeSalesKpis(sales);
  assert.equal(kpis.totalRevenue, 100);
  assert.equal(kpis.pendingCount, 2);
  assert.equal(kpis.pendingTotal, 250);
});

// ── Catalog KPIs ────────────────────────────────────────────────────────────

test("catalog: empty products yields zeroes", () => {
  const kpis = computeCatalogKpis([]);
  assert.equal(kpis.total, 0);
  assert.equal(kpis.active, 0);
  assert.equal(kpis.lowStock, 0);
  assert.equal(kpis.outOfStock, 0);
  assert.equal(kpis.inventoryValue, 0);
});

test("catalog: active/inactive counts", () => {
  const products = [
    product({ id: "1", active: true }),
    product({ id: "2", active: true }),
    product({ id: "3", active: false }),
  ];
  const kpis = computeCatalogKpis(products);
  assert.equal(kpis.total, 3);
  assert.equal(kpis.active, 2);
});

test("catalog: low stock detected", () => {
  const products = [
    product({ id: "1", stock_quantity: 2, low_stock_level: 5 }), // low
    product({ id: "2", stock_quantity: 10, low_stock_level: 3 }), // in
  ];
  const kpis = computeCatalogKpis(products);
  assert.equal(kpis.lowStock, 1);
});

test("catalog: out of stock detected", () => {
  const products = [
    product({ id: "1", stock_quantity: 0 }), // out
    product({ id: "2", stock_quantity: 5 }), // in
  ];
  const kpis = computeCatalogKpis(products);
  assert.equal(kpis.outOfStock, 1);
});

test("catalog: untracked products excluded from stock counts", () => {
  const products = [
    product({ id: "1", stock_tracking_enabled: false, stock_quantity: 0 }),
  ];
  const kpis = computeCatalogKpis(products);
  assert.equal(kpis.outOfStock, 0);
  assert.equal(kpis.lowStock, 0);
});

test("catalog: inventory value sums stock × cost_price for tracked products", () => {
  const products = [
    product({ id: "1", stock_quantity: 10, cost_price: 50 }),
    product({ id: "2", stock_quantity: 5, cost_price: 20 }),
    product({ id: "3", stock_quantity: 0, cost_price: 100 }), // zero stock → 0
    product({ id: "4", stock_tracking_enabled: false, stock_quantity: 10, cost_price: 30 }), // untracked → 0
  ];
  const kpis = computeCatalogKpis(products);
  assert.equal(kpis.inventoryValue, 10 * 50 + 5 * 20);
});

// ── Returns KPIs ────────────────────────────────────────────────────────────

test("returns: empty yields zeroes", () => {
  const kpis = computeReturnsKpis([], []);
  assert.equal(kpis.todayCount, 0);
  assert.equal(kpis.totalCount, 0);
  assert.equal(kpis.totalRefunded, 0);
  assert.equal(kpis.pendingRefunds, 0);
});

test("returns: today and total counts", () => {
  const returns = [
    salesReturn({ id: "1", refund_amount: 50, created_at: todayISO(1) }),
    salesReturn({ id: "2", refund_amount: 100, created_at: yesterdayISO() }),
  ];
  const kpis = computeReturnsKpis(returns, []);
  assert.equal(kpis.todayCount, 1);
  assert.equal(kpis.todayTotal, 50);
  assert.equal(kpis.totalCount, 2);
  assert.equal(kpis.totalRefunded, 150);
});

test("returns: pending refunds counted", () => {
  const refunds = [
    refund({ id: "1", amount: 100, status: "pending" }),
    refund({ id: "2", amount: 200, status: "completed" }),
    refund({ id: "3", amount: 50, status: "pending" }),
  ];
  const kpis = computeReturnsKpis([], refunds);
  assert.equal(kpis.pendingRefunds, 2);
});

// ── Expenses KPIs ───────────────────────────────────────────────────────────

test("expenses: empty yields zeroes", () => {
  const kpis = computeExpensesKpis([]);
  assert.equal(kpis.todayTotal, 0);
  assert.equal(kpis.todayCount, 0);
  assert.equal(kpis.totalAmount, 0);
});

test("expenses: today vs total", () => {
  const expenses = [
    expense({ id: "1", amount: 30, spent_at: todayISO(1) }),
    expense({ id: "2", amount: 70, spent_at: yesterdayISO() }),
  ];
  const kpis = computeExpensesKpis(expenses);
  assert.equal(kpis.todayTotal, 30);
  assert.equal(kpis.todayCount, 1);
  assert.equal(kpis.totalAmount, 100);
});

// ── Recent sales ────────────────────────────────────────────────────────────

test("recentSales: returns newest first, limited", () => {
  const sales = [
    sale({ id: "1", total: 100, created_at: todayISO(3) }),
    sale({ id: "2", total: 200, created_at: todayISO(1) }),
    sale({ id: "3", total: 300, created_at: todayISO(2) }),
  ];
  const result = recentSales(sales, 2);
  assert.equal(result.length, 2);
  assert.equal(result[0].id, "2"); // newest
  assert.equal(result[1].id, "3");
});

test("recentSales: voided sales excluded", () => {
  const sales = [
    sale({ id: "1", total: 100, status: "voided" }),
    sale({ id: "2", total: 200 }),
  ];
  const result = recentSales(sales, 5);
  assert.equal(result.length, 1);
  assert.equal(result[0].id, "2");
});

test("recentSales: items_count derived from items array", () => {
  const sales = [
    sale({
      id: "1",
      total: 100,
      items: [
        { id: "i1", sale_id: "1", product_id: "p1", name_ar: "", name_en: "", sku: "", barcode: null, unit_price: 50, quantity: 1, line_total: 50 },
        { id: "i2", sale_id: "1", product_id: "p2", name_ar: "", name_en: "", sku: "", barcode: null, unit_price: 50, quantity: 1, line_total: 50 },
      ],
    }),
  ];
  const result = recentSales(sales, 5);
  assert.equal(result[0].items_count, 2);
});

// ── Composite snapshot ──────────────────────────────────────────────────────

test("buildDashboardSnapshot: combines all KPIs", () => {
  const snap = buildDashboardSnapshot({
    sales: [sale({ id: "1", total: 100 })],
    products: [product({ id: "1" })],
    returns: [],
    refunds: [],
    expenses: [expense({ id: "1", amount: 20 })],
    customers: [{ id: "c1" }] as any,
    openShift: null,
    shiftSummary: null,
  });

  assert.equal(snap.sales.totalRevenue, 100);
  assert.equal(snap.catalog.total, 1);
  assert.equal(snap.returns.totalCount, 0);
  assert.equal(snap.expenses.totalAmount, 20);
  assert.equal(snap.customerCount, 1);
  assert.equal(snap.recentSales.length, 1);
  assert.equal(snap.openShift, null);
});

// ── Runner ──────────────────────────────────────────────────────────────────

async function run() {
  let passed = 0;
  let failed = 0;
  for (const { name, fn } of tests) {
    try {
      await fn();
      passed++;
      console.log(`  ✓ ${name}`);
    } catch (err) {
      failed++;
      console.error(`  ✗ ${name}`);
      console.error(`    ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  console.log(`\n${passed}/${passed + failed} passed`);
  if (failed > 0) process.exit(1);
}

run();
