/**
 * Inventory logic self-test (headless, Node).
 *
 * Covers inventory reports (valuation, low stock, movement summary, stock
 * balance) and opening stock CSV import. Pure functions only — no React,
 * no network, no database.
 */
import assert from "node:assert/strict";
import {
  computeStockValuation,
  computeLowStockReport,
  computeMovementReport,
  computeStockBalance,
} from "../services/inventoryReports";
import {
  importOpeningStock,
  matchStockToProducts,
} from "../services/stockImport";
import type { Product } from "@/modules/products/types";
import type { StockMovement } from "../types";

type TestCase = { name: string; fn: () => void | Promise<void> };
const tests: TestCase[] = [];
function test(name: string, fn: () => void | Promise<void>) {
  tests.push({ name, fn });
}

// ── Fixtures ────────────────────────────────────────────────────────────────

function product(partial: Partial<Product> & { id: string }): Product {
  return {
    sku: `SKU-${partial.id}`,
    name_ar: "منتج",
    name_en: "Product",
    description_ar: null,
    description_en: null,
    category_id: null,
    product_type: "physical",
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
    image_url: null,
    images: [],
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...partial,
  } as Product;
}

function movement(partial: Partial<StockMovement> & { id: string; product_id: string }): StockMovement {
  return {
    delta: 5,
    quantity_before: 10,
    quantity_after: 15,
    type: "adjustment_in",
    reason: "recount",
    notes: null,
    user_id: "u1",
    user_name: "Admin",
    created_at: "2026-09-10T12:00:00Z",
    ...partial,
  } as StockMovement;
}

// ── Stock Valuation ─────────────────────────────────────────────────────────

test("valuation: empty products yields zero", () => {
  const report = computeStockValuation([]);
  assert.equal(report.totalValue, 0);
  assert.equal(report.totalUnits, 0);
  assert.equal(report.valuedProducts, 0);
});

test("valuation: computes stock × cost_price", () => {
  const products = [
    product({ id: "1", stock_quantity: 10, cost_price: 50 }),
    product({ id: "2", stock_quantity: 5, cost_price: 20 }),
  ];
  const report = computeStockValuation(products);
  assert.equal(report.totalValue, 10 * 50 + 5 * 20);
  assert.equal(report.totalUnits, 15);
  assert.equal(report.valuedProducts, 2);
});

test("valuation: untracked products excluded", () => {
  const products = [
    product({ id: "1", stock_tracking_enabled: false, stock_quantity: 100, cost_price: 50 }),
  ];
  const report = computeStockValuation(products);
  assert.equal(report.totalValue, 0);
  assert.equal(report.items.length, 0);
});

test("valuation: zero stock not counted as valued", () => {
  const products = [
    product({ id: "1", stock_quantity: 0, cost_price: 50 }),
    product({ id: "2", stock_quantity: 3, cost_price: 10 }),
  ];
  const report = computeStockValuation(products);
  assert.equal(report.valuedProducts, 1);
  assert.equal(report.totalValue, 30);
});

test("valuation: grouped by category", () => {
  const products = [
    product({ id: "1", category_id: "cat-1", stock_quantity: 10, cost_price: 50 }),
    product({ id: "2", category_id: "cat-1", stock_quantity: 5, cost_price: 20 }),
    product({ id: "3", category_id: "cat-2", stock_quantity: 3, cost_price: 100 }),
  ];
  const report = computeStockValuation(products);
  assert.equal(report.byCategory.length, 2);
  const cat1 = report.byCategory.find((c) => c.categoryId === "cat-1")!;
  assert.equal(cat1.value, 600);
  assert.equal(cat1.count, 2);
});

// ── Low Stock Report ────────────────────────────────────────────────────────

test("lowStock: empty products yields empty report", () => {
  const report = computeLowStockReport([]);
  assert.equal(report.totalAlerts, 0);
});

test("lowStock: detects low and out of stock", () => {
  const products = [
    product({ id: "1", stock_quantity: 2, low_stock_level: 5 }), // low
    product({ id: "2", stock_quantity: 0, low_stock_level: 3 }), // out
    product({ id: "3", stock_quantity: 10, low_stock_level: 3 }), // ok
  ];
  const report = computeLowStockReport(products);
  assert.equal(report.totalAlerts, 2);
  assert.equal(report.outOfStock, 1);
  assert.equal(report.lowStock, 1);
  // Out of stock should be first
  assert.equal(report.items[0].status, "out");
});

test("lowStock: shortfall and reorder value", () => {
  const products = [
    product({ id: "1", stock_quantity: 2, low_stock_level: 10, cost_price: 25 }),
  ];
  const report = computeLowStockReport(products);
  assert.equal(report.items[0].shortfall, 8);
  assert.equal(report.items[0].reorderValue, 8 * 25);
  assert.equal(report.totalReorderValue, 200);
});

test("lowStock: untracked products excluded", () => {
  const products = [
    product({ id: "1", stock_tracking_enabled: false, stock_quantity: 0, low_stock_level: 5 }),
  ];
  const report = computeLowStockReport(products);
  assert.equal(report.totalAlerts, 0);
});

// ── Movement Report ─────────────────────────────────────────────────────────

test("movement: empty yields zero totals", () => {
  const report = computeMovementReport([]);
  assert.equal(report.totalCount, 0);
  assert.equal(report.totalIn, 0);
  assert.equal(report.totalOut, 0);
});

test("movement: aggregates by type", () => {
  const movements = [
    movement({ id: "1", product_id: "p1", type: "adjustment_in", delta: 10 }),
    movement({ id: "2", product_id: "p1", type: "adjustment_in", delta: 5 }),
    movement({ id: "3", product_id: "p1", type: "adjustment_out", delta: 3 }),
  ];
  const report = computeMovementReport(movements);
  assert.equal(report.totalCount, 3);
  assert.equal(report.totalIn, 15);
  assert.equal(report.totalOut, 3);
  const inType = report.byType.find((t) => t.type === "adjustment_in")!;
  assert.equal(inType.count, 2);
  assert.equal(inType.totalDelta, 15);
});

test("movement: aggregates by day", () => {
  const movements = [
    movement({ id: "1", product_id: "p1", created_at: "2026-09-10T10:00:00Z", delta: 5 }),
    movement({ id: "2", product_id: "p1", created_at: "2026-09-10T14:00:00Z", delta: 3 }),
    movement({ id: "3", product_id: "p1", created_at: "2026-09-11T09:00:00Z", delta: 7 }),
  ];
  const report = computeMovementReport(movements);
  assert.equal(report.byDay.length, 2);
  assert.equal(report.byDay[0].date, "2026-09-10");
  assert.equal(report.byDay[0].inCount, 2);
});

// ── Stock Balance ───────────────────────────────────────────────────────────

test("stockBalance: shows current + period movement", () => {
  const products = [
    product({ id: "p1", sku: "A", stock_quantity: 20 }),
    product({ id: "p2", sku: "B", stock_quantity: 5 }),
  ];
  const movements = [
    movement({ id: "1", product_id: "p1", type: "adjustment_in", delta: 10 }),
    movement({ id: "2", product_id: "p1", type: "adjustment_out", delta: 3 }),
  ];
  const balance = computeStockBalance(products, movements);
  const p1 = balance.find((b) => b.product_id === "p1")!;
  assert.equal(p1.stock_quantity, 20);
  assert.equal(p1.periodIn, 10);
  assert.equal(p1.periodOut, 3);
  assert.equal(p1.periodNet, 7);
});

test("stockBalance: untracked excluded", () => {
  const products = [
    product({ id: "p1", stock_tracking_enabled: false }),
  ];
  const balance = computeStockBalance(products, []);
  assert.equal(balance.length, 0);
});

// ── Opening Stock Import ────────────────────────────────────────────────────

test("stockImport: basic CSV parsing", () => {
  const csv = "SKU,Quantity\nALYQ-001,50\nALYQ-002,30";
  const result = importOpeningStock(csv);
  assert.equal(result.totalRows, 2);
  assert.equal(result.validRows.length, 2);
  assert.equal(result.invalidRows.length, 0);
  assert.equal(result.validRows[0].sku, "ALYQ-001");
  assert.equal(result.validRows[0].quantity, 50);
});

test("stockImport: Arabic headers", () => {
  const csv = "كود,الكمية\nALYQ-001,50";
  const result = importOpeningStock(csv);
  assert.equal(result.validRows.length, 1);
  assert.equal(result.validRows[0].sku, "ALYQ-001");
});

test("stockImport: warehouse column detected", () => {
  const csv = "SKU,Quantity,Warehouse\nALYQ-001,50,Main Branch";
  const result = importOpeningStock(csv);
  assert.equal(result.validRows[0].warehouse, "Main Branch");
});

test("stockImport: missing SKU flagged", () => {
  const csv = "SKU,Quantity\n,50";
  const result = importOpeningStock(csv);
  assert.equal(result.invalidRows.length, 1);
  assert.equal(result.invalidRows[0].code, "missing_sku");
});

test("stockImport: negative quantity rejected", () => {
  const csv = "SKU,Quantity\nALYQ-001,-5";
  const result = importOpeningStock(csv);
  assert.equal(result.invalidRows.length, 1);
  assert.equal(result.invalidRows[0].code, "negative_quantity");
});

test("stockImport: duplicate SKU within file", () => {
  const csv = "SKU,Quantity\nDUP-1,10\nDUP-1,20";
  const result = importOpeningStock(csv);
  assert.equal(result.validRows.length, 1);
  assert.equal(result.invalidRows.length, 1);
  assert.equal(result.invalidRows[0].code, "duplicate_sku");
});

test("stockImport: empty file", () => {
  const result = importOpeningStock("");
  assert.equal(result.totalRows, 0);
  assert.ok(result.globalErrors.length > 0);
});

test("matchStockToProducts: matches by SKU", () => {
  const rows = importOpeningStock("SKU,Quantity\nA-1,50\nB-2,30").validRows;
  const products = [
    { sku: "A-1", id: "p1", stock_quantity: 10, stock_tracking_enabled: true },
    { sku: "B-2", id: "p2", stock_quantity: 20, stock_tracking_enabled: true },
  ];
  const { matched, unmatched } = matchStockToProducts(rows, products);
  assert.equal(matched.length, 2);
  assert.equal(unmatched.length, 0);
  assert.equal(matched[0].delta, 40); // 50 - 10
  assert.equal(matched[1].delta, 10); // 30 - 20
});

test("matchStockToProducts: unmatched SKU reported", () => {
  const rows = importOpeningStock("SKU,Quantity\nX-999,10").validRows;
  const { matched, unmatched } = matchStockToProducts(rows, []);
  assert.equal(matched.length, 0);
  assert.equal(unmatched.length, 1);
});

test("matchStockToProducts: untracked products skipped", () => {
  const rows = importOpeningStock("SKU,Quantity\nA-1,50").validRows;
  const products = [
    { sku: "A-1", id: "p1", stock_quantity: 10, stock_tracking_enabled: false },
  ];
  const { matched, skippedUntracked } = matchStockToProducts(rows, products);
  assert.equal(matched.length, 0);
  assert.equal(skippedUntracked.length, 1);
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
