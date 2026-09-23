/**
 * Variant performance self-test (Phase 43).
 *
 * Run with the shared runner: `npm test` (or
 * `node scripts/test.logic.mjs variantPerformance`).
 *
 * `reports_variant_performance` (0043) is the authority on per-combination
 * performance, and `computeVariantPerformance` is the same arithmetic over rows
 * the browser already holds — the demo-mode and pre-0043 fallback. The fallback
 * is what this suite locks to hand-worked fixtures, because two implementations
 * of one report that are never compared against fixed numbers will drift:
 *
 *   1. **Grouping.** Sold lines group by `variant_id`; a product-level line
 *      (`variant_id = null`) belongs to the product report and counts nowhere
 *      here, and a line naming a deleted combination counts nowhere at all.
 *   2. **Exclusion.** Voided sales and rejected refunds count for nothing —
 *      the same rule the financial report and the product report apply.
 *   3. **Cost.** Units × (variant cost_override ?? product cost_price), and
 *      stock value off that same unit cost — the RPC's coalesce, restated.
 *   4. **Stock.** The combination's own shelf; 0 for an untracked product.
 *   5. **Order.** Revenue descending, then SKU — the RPC's own ORDER BY.
 */
import assert from "node:assert/strict";
import process from "node:process";

import type { Sale, SaleItem } from "@/modules/pos/types";
import type { SalesReturn, ReturnItem } from "@/modules/returns/types";
import type { Product } from "@/modules/products/types";
import type { ProductVariant } from "@/modules/products/variants";
import { computeVariantPerformance } from "../services/variantPerformance";

const PRODUCT_ID = "p1";
const GOLD = "v-gold";
const SILVER = "v-silver";

function product(over: Partial<Product> = {}): Product {
  return {
    id: PRODUCT_ID,
    sku: "P-1",
    name_ar: "خاتم",
    name_en: "Ring",
    cost_price: 100,
    selling_price: 200,
    stock_tracking_enabled: true,
    ...over,
  } as Product;
}

function variant(
  id: string,
  sku: string,
  over: Partial<ProductVariant> = {},
): ProductVariant {
  return {
    id,
    product_id: PRODUCT_ID,
    sku,
    color_en: id === GOLD ? "Gold" : "Silver",
    color_ar: id === GOLD ? "ذهبي" : "فضي",
    size: 17,
    size_label: null,
    cost_override: null,
    price_override: null,
    stock_quantity: 2,
    low_stock_level: 1,
    active: true,
    ...over,
  } as ProductVariant;
}

let lineSeq = 0;
function soldLine(
  saleId: string,
  variantId: string | null,
  quantity: number,
  lineTotal: number,
): SaleItem {
  lineSeq += 1;
  return {
    id: `si-${lineSeq}`,
    sale_id: saleId,
    product_id: PRODUCT_ID,
    variant_id: variantId,
    variant_color_ar: variantId === GOLD ? "ذهبي" : variantId === SILVER ? "فضي" : null,
    variant_color_en: variantId === GOLD ? "Gold" : variantId === SILVER ? "Silver" : null,
    variant_size: 17,
    variant_size_label: null,
    name_ar: "خاتم",
    name_en: "Ring",
    sku: variantId === GOLD ? "P-1-GOLD-17" : variantId === SILVER ? "P-1-SILVER-17" : "P-1",
    barcode: null,
    unit_price: 200,
    quantity,
    line_total: lineTotal,
  } as SaleItem;
}

function sale(id: string, status: Sale["status"], items: SaleItem[]): Sale {
  return {
    id,
    status,
    created_at: "2026-08-01T10:00:00Z",
    total: items.reduce((sum, item) => sum + item.line_total, 0),
    items,
  } as Sale;
}

function returnRow(
  id: string,
  refundStatus: "pending" | "completed" | "rejected",
  items: ReturnItem[],
): SalesReturn {
  return {
    id,
    refund_status: refundStatus,
    items,
    created_at: "2026-08-02T10:00:00Z",
  } as SalesReturn;
}

function returnedLine(returnId: string, variantId: string, quantity: number, lineTotal: number): ReturnItem {
  return {
    ...soldLine(returnId, variantId, quantity, lineTotal),
    return_id: returnId,
  } as unknown as ReturnItem;
}

const sales = [
  sale("s1", "completed", [soldLine("s1", GOLD, 2, 400)]),
  // voided: counts nowhere
  sale("s2", "voided", [soldLine("s2", SILVER, 1, 250)]),
  sale("s3", "completed", [soldLine("s3", SILVER, 1, 250)]),
  // product-level line: the product report's business, not this one's
  sale("s4", "completed", [soldLine("s4", null, 5, 1000)]),
  // a line naming a deleted combination counts nowhere at all
  sale("s5", "completed", [soldLine("s5", "v-deleted", 1, 200)]),
];

const returns = [
  returnRow("r1", "completed", [returnedLine("r1", SILVER, 1, 250)]),
  // rejected refund: counts nowhere
  returnRow("r2", "rejected", [returnedLine("r2", GOLD, 2, 400)]),
];

const rows = computeVariantPerformance({
  sales,
  returns,
  variants: [variant(GOLD, "P-1-GOLD-17"), variant(SILVER, "P-1-SILVER-17", { cost_override: 120 })],
  products: [product()],
});

// ── 1. one row per surviving combination ──────────────────────────────────
assert.equal(rows.length, 2, "one row per combination, sold or not");

const gold = rows.find((row) => row.variantId === GOLD);
const silver = rows.find((row) => row.variantId === SILVER);
assert.ok(gold && silver, "both shelves are reported");

// ── 2. the Gold shelf: sold twice, never returned ─────────────────────────
assert.equal(gold.invoices, 1, "a second line on one invoice would be a second invoice");
assert.equal(gold.units, 2);
assert.equal(gold.revenue, 400);
assert.equal(gold.cost, 200, "units × the product's cost when no override exists");
assert.equal(gold.returnedUnits, 0, "a rejected refund counts for nothing");
assert.equal(gold.returnedAmount, 0);
assert.equal(gold.stock, 2);
assert.equal(gold.stockValue, 200, "stock × the same unit cost the report costs with");
assert.equal(gold.active, true);
assert.equal(gold.productSku, "P-1");
assert.equal(gold.sku, "P-1-GOLD-17");

// ── 3. the Silver shelf: the cost override wins, the return is counted ────
assert.equal(silver.invoices, 1, "the voided invoice is not an invoice");
assert.equal(silver.units, 1);
assert.equal(silver.revenue, 250);
assert.equal(silver.cost, 120, "units × the variant's own cost override");
assert.equal(silver.returnedUnits, 1);
assert.equal(silver.returnedAmount, 250);
assert.equal(silver.stock, 2);
assert.equal(silver.stockValue, 240);

// ── 4. order: revenue descending, then SKU ────────────────────────────────
assert.deepEqual(
  rows.map((row) => row.variantId),
  [GOLD, SILVER],
  "the higher revenue reads first, exactly like the RPC's ORDER BY",
);

// ── 5. an untracked product reports no stock ──────────────────────────────
const untracked = computeVariantPerformance({
  sales: [],
  returns: [],
  variants: [variant(GOLD, "P-1-GOLD-17", { stock_quantity: 7 })],
  products: [product({ stock_tracking_enabled: false })],
});
assert.equal(untracked[0].stock, 0, "an untracked product has no promiseable shelf");
assert.equal(untracked[0].stockValue, 0);

// ── 6. a variant without its product cannot be reported ───────────────────
const orphaned = computeVariantPerformance({
  sales: [sale("s1", "completed", [soldLine("s1", GOLD, 2, 400)])],
  returns: [],
  variants: [variant(GOLD, "P-1-GOLD-17")],
  products: [],
});
assert.equal(orphaned.length, 0, "no product, no row — and its lines name no survivor");

console.log("variantPerformance.selftest.ts → all variant-performance tests passed");
process.exit(0);
