/**
 * Profitability self-test (Phase 53).
 *
 * Run with the shared runner: `npm test` (or
 * `node scripts/test.logic.mjs profitability`).
 *
 * Locks the historical-cost report to the acceptance fixtures:
 *
 *   1. Gross 1000 − auto 100 − manual 50 = Net 850, COGS 500, profit 350,
 *      margin ≈ 41.18%. Sale-time unit_cost is used, not today's catalogue.
 *   2. A partial refund reduces realized net/units/COGS once — never twice.
 *   3. Gold/17 and Silver/17 stay independent.
 *   4. Best sellers rank by units (A 10/5000 above B 4/6000) then by net
 *      (reverse). Featured is not consulted.
 *   5. Slow movers are stock>0 with no lookback sales — not low/out of stock.
 *   6. Voided sales and missing snapshots (null ≠ 0) do not invent profit.
 */
import assert from "node:assert/strict";
import process from "node:process";

import type { Sale, SaleItem } from "@/modules/pos/types";
import type { Product } from "@/modules/products/types";
import type { ProductVariant } from "@/modules/products/variants";
import type { ReturnItem, SalesReturn } from "@/modules/returns/types";
import {
  buildProfitability,
  historicalUnitCost,
  rankBestSellers,
} from "../services/profitability";

const NOW = new Date("2026-09-23T12:00:00.000Z");
const RANGE = { from: "2026-08-01", to: "2026-09-23" };

function product(over: Partial<Product> = {}): Product {
  return {
    id: "p1",
    sku: "P-1",
    barcode: null,
    name_ar: "خاتم",
    name_en: "Ring",
    description_ar: null,
    description_en: null,
    category_id: null,
    product_type: "physical",
    selling_price: 1000,
    cost_price: 999,
    tax_rate: 0,
    stock_tracking_enabled: true,
    stock_quantity: 0,
    low_stock_level: 1,
    variants_enabled: false,
    show_on_website: true,
    is_featured: false,
    active: true,
    image_url: null,
    images: [],
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...over,
  };
}

function variant(id: string, over: Partial<ProductVariant> = {}): ProductVariant {
  return {
    id,
    product_id: "p-ring",
    sku: id,
    color_en: id.includes("gold") ? "Gold" : "Silver",
    color_ar: id.includes("gold") ? "ذهبي" : "فضي",
    size: 17,
    size_label: null,
    cost_override: null,
    price_override: null,
    stock_quantity: 0,
    low_stock_level: 1,
    active: true,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...over,
  } as ProductVariant;
}

let lineSeq = 0;
function line(over: Partial<SaleItem> & Pick<SaleItem, "product_id" | "quantity" | "line_total">): SaleItem {
  lineSeq += 1;
  return {
    id: over.id ?? `si-${lineSeq}`,
    sale_id: over.sale_id ?? "s1",
    product_id: over.product_id,
    variant_id: over.variant_id ?? null,
    variant_color_ar: over.variant_color_ar ?? null,
    variant_color_en: over.variant_color_en ?? null,
    variant_size: over.variant_size ?? null,
    variant_size_label: over.variant_size_label ?? null,
    name_ar: over.name_ar ?? "صنف",
    name_en: over.name_en ?? "Item",
    sku: over.sku ?? over.product_id,
    barcode: null,
    unit_price: over.unit_price ?? 0,
    quantity: over.quantity,
    gross_total: over.gross_total,
    line_total: over.line_total,
    discount_amount: over.discount_amount ?? 0,
    automatic_discount_amount: over.automatic_discount_amount ?? 0,
    unit_cost: over.unit_cost,
  } as SaleItem;
}

function sale(over: Partial<Sale> & Pick<Sale, "id" | "items">): Sale {
  return {
    id: over.id,
    sale_number: over.sale_number ?? over.id,
    client_ref: over.id,
    status: over.status ?? "completed",
    subtotal: over.subtotal ?? over.items.reduce((sum, item) => sum + item.line_total, 0),
    discount_type: "none",
    discount_value: 0,
    discount_amount: over.discount_amount ?? 0,
    total: over.total ?? over.items.reduce((sum, item) => sum + item.line_total, 0) - (over.discount_amount ?? 0),
    user_id: "u1",
    user_name: "Cashier",
    items: over.items,
    payments: [],
    created_at: over.created_at ?? "2026-09-01T10:00:00Z",
    voided_at: null,
    void_reason: null,
    payment_method: "cash",
    payment_status: "paid",
    amount_received: null,
    change: null,
    paid_at: null,
    paid_by: null,
    paid_by_name: null,
    source: over.source ?? "pos",
  } as Sale;
}

function returned(
  over: Partial<ReturnItem> & Pick<ReturnItem, "product_id" | "quantity" | "line_total" | "sale_item_id">,
): ReturnItem {
  return {
    id: over.id ?? `ri-${over.sale_item_id}`,
    return_id: over.return_id ?? "r1",
    sale_item_id: over.sale_item_id,
    product_id: over.product_id,
    variant_id: over.variant_id ?? null,
    variant_color_ar: null,
    variant_color_en: null,
    variant_size: null,
    variant_size_label: null,
    name_ar: "صنف",
    name_en: "Item",
    sku: over.product_id,
    barcode: null,
    unit_price: over.unit_price ?? 0,
    quantity: over.quantity,
    line_total: over.line_total,
  };
}

assert.equal(historicalUnitCost({ unit_cost: null }), null, "a missing snapshot is unknown, not free");
assert.equal(historicalUnitCost({ unit_cost: 12.5 }), 12.5);

// ── 1. Gross 1000 − auto 100 − manual 50 = Net 850, COGS 500, profit 350 ──
const kpiSale = sale({
  id: "s-kpi",
  total: 850,
  discount_amount: 0,
  items: [
    line({
      id: "si-kpi",
      sale_id: "s-kpi",
      product_id: "p-kpi",
      sku: "KPI",
      name_en: "KPI ring",
      unit_price: 900,
      quantity: 1,
      gross_total: 900,
      automatic_discount_amount: 100,
      discount_amount: 50,
      line_total: 850,
      unit_cost: 500,
    }),
  ],
});

const kpi = buildProfitability({
  sales: [
    kpiSale,
    sale({
      id: "s-void",
      status: "voided",
      items: [
        line({
          product_id: "p-kpi",
          quantity: 99,
          line_total: 99_000,
          unit_cost: 1,
        }),
      ],
    }),
  ],
  products: [product({ id: "p-kpi", sku: "KPI", cost_price: 999 })],
  range: RANGE,
  now: NOW,
});

assert.equal(kpi.kpis.grossSales, 1000, "list = gross_total + automatic");
assert.equal(kpi.kpis.automaticDiscounts, 100);
assert.equal(kpi.kpis.manualItemDiscounts, 50);
assert.equal(kpi.kpis.totalDiscounts, 150);
assert.equal(kpi.kpis.netSales, 850);
assert.equal(kpi.kpis.cogs, 500, "sale-time cost, not today's 999");
assert.equal(kpi.kpis.grossProfit, 350);
assert.equal(kpi.kpis.grossMargin, 41.18);
assert.equal(kpi.kpis.cogsAuthoritative, true);
assert.equal(kpi.kpis.invoices, 1, "the voided invoice is not an invoice");

// ── 2. partial refund reduces realized net once ───────────────────────────
const twoUnit = sale({
  id: "s-two",
  total: 850,
  items: [
    line({
      id: "si-two",
      sale_id: "s-two",
      product_id: "p-kpi",
      sku: "KPI",
      quantity: 2,
      unit_price: 500,
      gross_total: 900,
      automatic_discount_amount: 100,
      discount_amount: 50,
      line_total: 850,
      unit_cost: 250,
    }),
  ],
});
const refunded = buildProfitability({
  sales: [twoUnit],
  products: [product({ id: "p-kpi", sku: "KPI" })],
  returns: [
    {
      id: "r1",
      return_number: "RET-1",
      sale_id: "s-two",
      sale_number: "s-two",
      customer_id: null,
      customer_name: null,
      reason: "partial",
      refund_amount: 425,
      refund_method: "cash",
      refund_status: "completed",
      user_id: "u1",
      user_name: "Cashier",
      created_at: "2026-09-02T10:00:00Z",
      items: [
        returned({
          sale_item_id: "si-two",
          product_id: "p-kpi",
          quantity: 1,
          line_total: 425,
        }),
      ],
    } as SalesReturn,
  ],
  range: RANGE,
  now: NOW,
});
assert.equal(refunded.kpis.netSales, 425, "850 − 425 refunded, once");
assert.equal(refunded.kpis.refundsAmount, 425);
assert.equal(refunded.kpis.unitsSold, 1);
assert.equal(refunded.kpis.cogs, 250, "only the returned unit's frozen cost comes off");
assert.equal(refunded.kpis.grossProfit, 175);

// ── 3. Gold/17 and Silver/17 never collapse ───────────────────────────────
const gold = "v-gold-17";
const silver = "v-silver-17";
const ring = product({
  id: "p-ring",
  sku: "RING",
  variants_enabled: true,
  is_featured: true,
});
const variantSales = [
  sale({
    id: "s-gold",
    items: [
      line({
        sale_id: "s-gold",
        product_id: "p-ring",
        variant_id: gold,
        variant_color_en: "Gold",
        variant_color_ar: "ذهبي",
        variant_size: 17,
        sku: "RING-GOLD-17",
        quantity: 5,
        unit_price: 200,
        line_total: 1000,
        unit_cost: 80,
      }),
    ],
  }),
  sale({
    id: "s-silver",
    items: [
      line({
        sale_id: "s-silver",
        product_id: "p-ring",
        variant_id: silver,
        variant_color_en: "Silver",
        variant_color_ar: "فضي",
        variant_size: 17,
        sku: "RING-SILVER-17",
        quantity: 2,
        unit_price: 200,
        line_total: 400,
        unit_cost: 80,
      }),
    ],
  }),
];
const split = buildProfitability({
  sales: variantSales,
  products: [ring],
  variants: [variant(gold, { sku: "RING-GOLD-17" }), variant(silver, { sku: "RING-SILVER-17" })],
  range: RANGE,
  now: NOW,
});
const goldRow = split.variants.find((row) => row.variantId === gold);
const silverRow = split.variants.find((row) => row.variantId === silver);
assert.ok(goldRow && silverRow, "each combination is its own row");
assert.equal(goldRow.units, 5);
assert.equal(silverRow.units, 2);
assert.equal(goldRow.net, 1000);
assert.equal(silverRow.net, 400);

// ── 4. ranking: units then net — never Featured ───────────────────────────
const rankedUnits = rankBestSellers(
  [
    { id: "A", units: 10, net: 5000, profit: 1 },
    { id: "B", units: 4, net: 6000, profit: 9 },
  ],
  "units",
);
assert.deepEqual(
  rankedUnits.map((row) => row.id),
  ["A", "B"],
  "ten units at 5000 outrank four units at 6000",
);
const rankedNet = rankBestSellers(
  [
    { id: "A", units: 10, net: 5000, profit: 1 },
    { id: "B", units: 4, net: 6000, profit: 9 },
  ],
  "net",
);
assert.deepEqual(
  rankedNet.map((row) => row.id),
  ["B", "A"],
  "net-sales rank is the reverse",
);

const movers = buildProfitability({
  sales: [
    sale({
      id: "s-a",
      items: [
        line({
          product_id: "p-a",
          sku: "A",
          name_en: "A",
          quantity: 10,
          unit_price: 500,
          line_total: 5000,
          unit_cost: 100,
        }),
      ],
    }),
    sale({
      id: "s-b",
      items: [
        line({
          product_id: "p-b",
          sku: "B",
          name_en: "B",
          quantity: 4,
          unit_price: 1500,
          line_total: 6000,
          unit_cost: 100,
        }),
      ],
    }),
  ],
  products: [
    product({ id: "p-a", sku: "A", name_en: "A", is_featured: false }),
    product({ id: "p-b", sku: "B", name_en: "B", is_featured: true }),
  ],
  range: RANGE,
  now: NOW,
  rankBy: "units",
});
assert.deepEqual(
  movers.bestSellers.map((row) => row.productId),
  ["p-a", "p-b"],
  "featured B does not jump the units ranking",
);

// ── 5. slow movers: stock on hand, no lookback sales ──────────────────────
const slowNow = new Date("2026-09-23T12:00:00");
const slow = buildProfitability({
  sales: [
    sale({
      id: "s-recent",
      created_at: "2026-09-20T10:00:00Z",
      items: [
        line({
          product_id: "p-ring",
          variant_id: "v-fast",
          variant_color_en: "Rose",
          variant_size: 17,
          sku: "RING-ROSE-17",
          quantity: 1,
          line_total: 200,
          unit_cost: 80,
        }),
      ],
    }),
  ],
  products: [product({ id: "p-ring", sku: "RING", variants_enabled: true, stock_quantity: 99 })],
  variants: [
    variant("v-slow", {
      sku: "RING-SLOW-17",
      color_en: "Gold",
      stock_quantity: 12,
    }),
    variant("v-fast", {
      sku: "RING-ROSE-17",
      color_en: "Rose",
      stock_quantity: 8,
    }),
    variant("v-empty", {
      sku: "RING-EMPTY-17",
      color_en: "Black",
      stock_quantity: 0,
    }),
  ],
  range: RANGE,
  lookbackDays: 90,
  now: slowNow,
});
assert.ok(
  slow.slowMovers.some((row) => row.variantId === "v-slow" && row.stock === 12),
  "Variant A with stock 12 and no 90-day sales is a slow mover",
);
assert.ok(
  !slow.slowMovers.some((row) => row.variantId === "v-fast"),
  "a combination with recent sales is not a slow mover",
);
assert.ok(
  !slow.slowMovers.some((row) => row.variantId === "v-empty"),
  "out of stock is not mixed into slow movers",
);

// ── 6. unknown snapshot is incomplete COGS, never free ────────────────────
const unknown = buildProfitability({
  sales: [
    sale({
      id: "s-old",
      items: [
        line({
          product_id: "p-kpi",
          quantity: 2,
          line_total: 400,
          unit_cost: null,
        }),
      ],
    }),
  ],
  products: [product({ id: "p-kpi", cost_price: 50 })],
  range: RANGE,
  now: NOW,
});
assert.equal(unknown.kpis.cogs, 0);
assert.equal(unknown.kpis.cogsUnknownUnits, 2);
assert.equal(unknown.kpis.cogsAuthoritative, false);

console.log("profitability.selftest.ts → all profitability tests passed");
process.exit(0);
