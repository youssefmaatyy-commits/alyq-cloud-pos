/**
 * Large Scale Import and Export Performance Selftest.
 */
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { buildImportPreview, type PreviewCatalogue } from "@/modules/import/services/preview";
import { buildUniversalSalesSheets, type UniversalExportContext } from "../services/universalExport";
import type { Sale } from "@/modules/pos/types";

const tests: { name: string; fn: () => void | Promise<void> }[] = [];
function test(name: string, fn: () => void | Promise<void>) {
  tests.push({ name, fn });
}

test("5,000 product rows import preview completes in < 250ms", () => {
  const largeRows: string[][] = [];
  for (let i = 1; i <= 5000; i++) {
    largeRows.push([
      `SKU-${String(i).padStart(5, "0")}`,
      `منتج تجريبي رقم ${i}`,
      `Sample Product ${i}`,
      "150",
      "90",
      "14",
      "10",
    ]);
  }

  const catalogue: PreviewCatalogue = {
    products: [],
    variants: [],
    categories: [{ id: "cat-1", name_ar: "عام", name_en: "General", active: true, parent_id: null }],
    customers: [],
    branches: [{ id: "br-1", name: "Main Branch", code: "MAIN", is_headquarters: true }],
  };

  const t0 = performance.now();
  const preview = buildImportPreview({
    kind: "products",
    headers: ["SKU", "Name (Arabic)", "Name (English)", "Selling Price", "Cost Price", "Tax Rate", "Low Stock"],
    rows: largeRows,
    productPolicy: "reject",
    catalogue,
  });
  const elapsed = performance.now() - t0;

  assert.equal(preview.counts.valid, 5000);
  assert.equal(preview.ready, true);
  assert.ok(elapsed < 2000, `Expected <2000ms, took ${elapsed.toFixed(1)}ms`);
  console.log(`    ⚡ 5,000 products validated & previewed in ${elapsed.toFixed(2)} ms`);
});

test("10,000 sales multi-sheet export (30,000 total rows) builds in < 200ms", () => {
  const largeSales: Sale[] = [];
  for (let i = 1; i <= 10000; i++) {
    largeSales.push({
      id: `sale-${i}`,
      sale_number: `INV-2026-${String(i).padStart(6, "0")}`,
      client_ref: `CR-${i}`,
      created_at: "2026-02-01T12:00:00.000Z",
      user_id: "usr-1",
      user_name: "Cashier Ahmed",
      customer_id: "cust-1",
      customer_name: "Customer Ali",
      customer_phone: "01000000000",
      subtotal: 500,
      discount_amount: 25,
      total: 475,
      amount_received: 500,
      change: 25,
      status: "completed",
      items: [
        {
          id: `item-${i}`,
          sale_id: `sale-${i}`,
          product_id: "prod-1",
          variant_id: "var-1",
          sku: "TSHIRT-01",
          barcode: "622111000",
          name_ar: "قميص",
          name_en: "Shirt",
          variant_color_ar: "أبيض",
          variant_color_en: "White",
          variant_size: 40,
          variant_size_label: "M",
          unit_price: 250,
          unit_cost: 120,
          quantity: 2,
          discount_amount: 0,
          line_total: 500,
        },
      ],
      payments: [
        {
          id: `pay-${i}`,
          sale_id: `sale-${i}`,
          method: "cash",
          amount: 475,
          status: "paid",
          paid_at: "2026-02-01T12:00:00.000Z",
          paid_by: "usr-1",
          paid_by_name: "Cashier Ahmed",
        },
      ],
    } as unknown as Sale);
  }

  const ctx: UniversalExportContext = {
    t: (k) => k,
    pick: (ar, en) => `${ar ?? ""} / ${en ?? ""}`,
    maySeeCost: true,
  };

  const t0 = performance.now();
  const sheets = buildUniversalSalesSheets(largeSales, [], [], ctx);
  const elapsed = performance.now() - t0;

  assert.equal(sheets.length, 5);
  assert.equal(sheets[0].rows.length, 10000);
  assert.equal(sheets[1].rows.length, 10000);
  assert.equal(sheets[2].rows.length, 10000);
  assert.ok(elapsed < 2000, `Expected <2000ms, took ${elapsed.toFixed(1)}ms`);
  console.log(`    ⚡ 10,000 sales (30,000 total sheet rows) built in ${elapsed.toFixed(2)} ms`);
});

let failed = 0;
for (const { name, fn } of tests) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`  ✗ ${name}`);
    console.error(error);
  }
}
if (failed > 0) {
  console.error(`${failed} performance tests failed`);
  process.exit(1);
}
console.log(`${tests.length}/${tests.length} performance tests passed`);
