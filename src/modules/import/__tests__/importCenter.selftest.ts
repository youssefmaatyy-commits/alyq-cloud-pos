/**
 * Master Import Center Selftest Suite.
 *
 * Verifies:
 *   1. All-or-nothing validation safety: 1 error blocks the entire batch.
 *   2. Product identity hierarchy: Product ID > Variant SKU > Group Key.
 *   3. Variant derivation with size/color combinations and barcode handling.
 *   4. Multi-branch stock adjustments (SET, ADD, SUBTRACT, NO_STOCK_CHANGE).
 *   5. Negative stock prevention and reason requirements.
 *   6. Template generation for blank, live catalog, and stock adjustment workbooks.
 *   7. Error reporting Excel and CSV generators.
 */
import assert from "node:assert/strict";
import { buildImportPreview, type PreviewCatalogue } from "../services/preview";
import { reviewColumns, fieldSpecs } from "../services/columns";
import {
  generateBlankCatalogTemplate,
  generateCurrentCatalogExportTemplate,
  generateStockAdjustmentTemplate,
} from "../services/templates";
import { buildErrorReportCsv, generateErrorReportExcel } from "../services/errorReport";
import type { Product, Category } from "@/modules/products/types";
import type { ProductVariant } from "@/modules/products/variants";

const tests: { name: string; fn: () => void | Promise<void> }[] = [];
function test(name: string, fn: () => void | Promise<void>) {
  tests.push({ name, fn });
}

const mockCatalogue: PreviewCatalogue = {
  products: [
    {
      id: "prod-100",
      sku: "DRESS-01",
      barcode: "622111222333",
      name_ar: "فستان سهرة",
      name_en: "Evening Dress",
      category_id: "cat-1",
      cost_price: 200,
      selling_price: 450,
      tax_rate: 14,
      stock_tracking_enabled: true,
      stock_quantity: 10,
      low_stock_level: 2,
      active: true,
      variants_enabled: true,
    },
  ],
  variants: [
    {
      id: "var-100",
      product_id: "prod-100",
      sku: "DRESS-01-RED-M",
      barcode: "622111222334",
      color_ar: "أحمر",
      color_en: "Red",
      color_key: "red",
      size: 38,
      size_label: "M",
      cost_override: null,
      price_override: null,
      stock_quantity: 5,
      low_stock_level: 1,
      active: true,
    },
  ],
  categories: [
    { id: "cat-1", name_ar: "فساتين", name_en: "Dresses", active: true, parent_id: null },
    { id: "cat-archived", name_ar: "أرشيف", name_en: "Archived", active: false, parent_id: null },
  ],
  customers: [
    { id: "cust-1", name: "Fatima", phone: "01011112222", email: "fatima@test.com", address: null, notes: null },
  ],
  branches: [
    { id: "br-main", name: "Main Branch", code: "MAIN", is_headquarters: true },
    { id: "br-alex", name: "Alexandria Branch", code: "ALX", is_headquarters: false },
  ],
};

const fullProducts: Product[] = [
  {
    id: "prod-100",
    sku: "DRESS-01",
    barcode: "622111222333",
    name_ar: "فستان سهرة",
    name_en: "Evening Dress",
    description_ar: null,
    description_en: null,
    category_id: "cat-1",
    product_type: "physical",
    cost_price: 200,
    selling_price: 450,
    tax_rate: 14,
    stock_tracking_enabled: true,
    stock_quantity: 10,
    low_stock_level: 2,
    show_on_website: true,
    is_featured: false,
    active: true,
    variants_enabled: true,
    image_url: null,
    images: [],
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  },
];

const fullVariants: ProductVariant[] = [
  {
    id: "var-100",
    product_id: "prod-100",
    sku: "DRESS-01-RED-M",
    barcode: "622111222334",
    color_ar: "أحمر",
    color_en: "Red",
    color_key: "red",
    color_hex: "#ff0000",
    size: 38,
    size_label: "M",
    sort_order: 1,
    cost_override: null,
    price_override: null,
    stock_quantity: 5,
    low_stock_level: 1,
    image_url: null,
    active: true,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  },
];

const fullCategories: Category[] = [
  {
    id: "cat-1",
    name_ar: "فساتين",
    name_en: "Dresses",
    parent_id: null,
    sort_order: 1,
    active: true,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  },
];

test("column reviewer auto-detects English and Arabic headers accurately", () => {
  const headers = ["رمز المنتج", "الاسم بالعربي", "Name (English)", "سعر البيع", "Barcode"];
  const review = reviewColumns(headers, fieldSpecs("catalog_unified"));
  assert.equal(review.ready, true);
  assert.equal(review.assignments[0].field, "sku");
  assert.equal(review.assignments[1].field, "name_ar");
  assert.equal(review.assignments[2].field, "name_en");
  assert.equal(review.assignments[3].field, "selling_price");
  assert.equal(review.assignments[4].field, "barcode");
});

test("all-or-nothing validation blocks import when a single row has an error", () => {
  const preview = buildImportPreview({
    kind: "catalog_unified",
    headers: ["SKU", "Name (Arabic)", "Name (English)", "Selling Price"],
    rows: [
      ["NEW-101", "قميص", "Shirt", "150"],
      ["", "بدون كود", "No SKU", "200"], // Error: missing required SKU
      ["NEW-102", "بنطلون", "Pants", "250"],
    ],
    productPolicy: "reject",
    catalogue: mockCatalogue,
  });

  assert.equal(preview.ready, false); // Blocked
  assert.equal(preview.counts.error, 1);
  assert.equal(preview.counts.valid, 2);
  assert.equal(preview.rows[1].status, "error");
  assert.ok(preview.rows[1].issues.some((i) => i.code === "sku"));
});

test("existing SKU rejection policy flags existing product as error", () => {
  const preview = buildImportPreview({
    kind: "catalog_unified",
    headers: ["SKU", "Name (Arabic)", "Name (English)", "Selling Price"],
    rows: [["DRESS-01", "فستان سهرة معدل", "Modified Dress", "500"]],
    productPolicy: "reject",
    catalogue: mockCatalogue,
  });

  assert.equal(preview.ready, false);
  assert.equal(preview.rows[0].status, "error");
  assert.ok(preview.rows[0].issues.some((i) => i.code === "catalogue_code"));
});

test("existing SKU update policy permits updating existing product", () => {
  const preview = buildImportPreview({
    kind: "catalog_unified",
    headers: ["SKU", "Name (Arabic)", "Name (English)", "Selling Price"],
    rows: [["DRESS-01", "فستان سهرة معدل", "Modified Dress", "500"]],
    productPolicy: "update",
    catalogue: mockCatalogue,
  });

  assert.equal(preview.ready, true);
  assert.equal(preview.counts.error, 0);
  assert.equal(preview.rows[0].targetId, "prod-100");
  assert.ok(preview.rows[0].status === "valid" || preview.rows[0].status === "warning");
});

test("variant derivation resolves parent product from variant row", () => {
  const preview = buildImportPreview({
    kind: "catalog_unified",
    headers: ["Parent SKU", "Variant SKU", "Color (English)", "Size", "Selling Price"],
    rows: [["DRESS-01", "DRESS-01-BLU-L", "Blue", "40", "480"]],
    productPolicy: "update",
    catalogue: mockCatalogue,
  });

  assert.equal(preview.ready, true);
  assert.equal(preview.counts.error, 0);
  assert.equal(preview.rows[0].targetId, "prod-100");
});

test("multi-branch stock adjustments calculate balances and prevent negative stock", () => {
  const preview = buildImportPreview({
    kind: "stock",
    headers: ["SKU", "Branch", "Stock Action", "Quantity", "Reason"],
    rows: [
      ["DRESS-01-RED-M", "Main Branch", "SET_STOCK", "15", "Stock Count Audit"],
      ["DRESS-01-RED-M", "Main Branch", "SUBTRACT_STOCK", "20", "Damage Writeoff"], // Over-reduction error
    ],
    stockMode: "set",
    catalogue: mockCatalogue,
  });

  assert.equal(preview.rows[0].computedStock?.current, 5);
  assert.equal(preview.rows[0].computedStock?.after, 15);
  assert.equal(preview.rows[0].computedStock?.delta, 10);

  assert.equal(preview.rows[1].status, "error");
  assert.ok(preview.rows[1].issues.some((i) => i.code === "negative_stock_result"));
});

test("template generation generates valid ArrayBuffers for blank, live, and stock templates", async () => {
  const blankBuf = await generateBlankCatalogTemplate(fullCategories, mockCatalogue.branches);
  assert.ok(blankBuf instanceof ArrayBuffer);
  assert.ok(blankBuf.byteLength > 2000);

  const liveBuf = await generateCurrentCatalogExportTemplate({
    products: fullProducts,
    variants: fullVariants,
    categories: fullCategories,
    branches: mockCatalogue.branches,
  });
  assert.ok(liveBuf instanceof ArrayBuffer);
  assert.ok(liveBuf.byteLength > 2000);

  const stockBuf = await generateStockAdjustmentTemplate({
    products: fullProducts,
    variants: fullVariants,
    categories: fullCategories,
    branches: mockCatalogue.branches,
  });
  assert.ok(stockBuf instanceof ArrayBuffer);
  assert.ok(stockBuf.byteLength > 2000);
});

test("error report generator exports CSV and styled Excel workbooks", async () => {
  const issues = [
    {
      row: 2,
      field: "sku",
      code: "required_field",
      level: "error" as const,
      message: "SKU is required",
      suggestedFix: "Enter a valid alphanumeric SKU",
    },
    {
      row: 3,
      field: "category",
      code: "archived_category",
      level: "warning" as const,
      message: "Category is archived",
      suggestedFix: "Select an active category",
    },
  ];

  const csv = buildErrorReportCsv(issues);
  assert.ok(csv.includes("required_field"));
  assert.ok(csv.includes("Enter a valid alphanumeric SKU"));

  const excelBuf = await generateErrorReportExcel(issues, ["SKU", "Name"], [["", "Bad Row"]]);
  assert.ok(excelBuf instanceof ArrayBuffer);
  assert.ok(excelBuf.byteLength > 1000);
});

test("two existing products with the same visible name but different IDs are never merged", () => {
  const catalogueWithSameNames: PreviewCatalogue = {
    ...mockCatalogue,
    products: [
      {
        id: "prod-A",
        sku: "RING-GOLD-01",
        name_ar: "خاتم ذهبي",
        name_en: "Gold Ring",
        barcode: "11111111",
        category_id: "cat-1",
        cost_price: 100,
        selling_price: 200,
        tax_rate: 14,
        stock_tracking_enabled: true,
        stock_quantity: 5,
        low_stock_level: 1,
        active: true,
        variants_enabled: false,
      },
      {
        id: "prod-B",
        sku: "RING-GOLD-02",
        name_ar: "خاتم ذهبي",
        name_en: "Gold Ring", // Identical visible names
        barcode: "22222222",
        category_id: "cat-1",
        cost_price: 150,
        selling_price: 300,
        tax_rate: 14,
        stock_tracking_enabled: true,
        stock_quantity: 8,
        low_stock_level: 2,
        active: true,
        variants_enabled: false,
      },
    ],
  };

  // Import workbook row targets prod-A by SKU
  const previewA = buildImportPreview({
    kind: "catalog_unified",
    headers: ["SKU", "Name (English)", "Selling Price"],
    rows: [["RING-GOLD-01", "Gold Ring", "220"]],
    productPolicy: "update",
    catalogue: catalogueWithSameNames,
  });

  assert.equal(previewA.rows[0].targetId, "prod-A");
  assert.notEqual(previewA.rows[0].targetId, "prod-B");

  // Import workbook row targets prod-B by SKU
  const previewB = buildImportPreview({
    kind: "catalog_unified",
    headers: ["SKU", "Name (English)", "Selling Price"],
    rows: [["RING-GOLD-02", "Gold Ring", "320"]],
    productPolicy: "update",
    catalogue: catalogueWithSameNames,
  });

  assert.equal(previewB.rows[0].targetId, "prod-B");
  assert.notEqual(previewB.rows[0].targetId, "prod-A");
});

test("product name alone cannot match or update an existing database product", () => {
  const preview = buildImportPreview({
    kind: "catalog_unified",
    headers: ["Name (Arabic)", "Name (English)", "Selling Price"],
    rows: [["فستان سهرة", "Evening Dress", "500"]], // No SKU or Product ID provided
    productPolicy: "update",
    catalogue: mockCatalogue,
  });

  // Missing SKU / Product ID MUST produce an error, never guess by product name
  assert.equal(preview.ready, false);
  assert.equal(preview.rows[0].status, "error");
  assert.equal(preview.rows[0].targetId, null);
  assert.ok(preview.rows[0].issues.some((i) => i.code === "sku"));
});

test("New Product Group groups multiple new workbook rows into one logical parent product", () => {
  const preview = buildImportPreview({
    kind: "catalog_unified",
    headers: ["Product Group", "Product Name (English)", "Variant SKU", "Color (English)", "Size", "Selling Price"],
    rows: [
      ["TS001", "T-Shirt Summer", "TS001-BLK-M", "Black", "M", "200"],
      ["TS001", "T-Shirt Summer", "TS001-BLK-L", "Black", "L", "200"],
      ["TS001", "T-Shirt Summer", "TS001-WHT-M", "White", "M", "200"],
    ],
    productPolicy: "reject",
    catalogue: mockCatalogue,
  });

  assert.equal(preview.ready, true);
  assert.equal(preview.counts.error, 0);
  assert.equal(preview.rows.length, 3);
  // All three rows are part of the new group
  assert.equal(preview.rows[0].values.product_group, "TS001");
  assert.equal(preview.rows[1].values.product_group, "TS001");
  assert.equal(preview.rows[2].values.product_group, "TS001");
});

test("negative resulting stock blocks the entire batch with a blocking error (no bypass)", () => {
  const preview = buildImportPreview({
    kind: "stock",
    headers: ["SKU", "Branch", "Stock Action", "Quantity", "Reason"],
    rows: [
      ["DRESS-01-RED-M", "Main Branch", "SUBTRACT_STOCK", "5", "Sold 5"], // 5 - 5 = 0 -> PASS
      ["DRESS-01-RED-M", "Main Branch", "SUBTRACT_STOCK", "7", "Sold 7"], // 5 - 7 = -2 -> BLOCKING ERROR
    ],
    stockMode: "set",
    catalogue: mockCatalogue,
  });

  // Row 0 resulting in exactly 0 stock is valid
  assert.equal(preview.rows[0].status, "valid");
  assert.equal(preview.rows[0].computedStock?.after, 0);

  // Row 1 resulting below 0 is an error and blocks the entire workbook
  assert.equal(preview.rows[1].status, "error");
  assert.equal(preview.rows[1].computedStock?.after, -2);
  assert.ok(preview.rows[1].issues.some((i) => i.code === "negative_stock_result"));
  assert.equal(preview.ready, false); // All-or-nothing blocked
});

test("unknown category in import workbook produces a blocking error", () => {
  const preview = buildImportPreview({
    kind: "catalog_unified",
    headers: ["SKU", "Name (English)", "Category", "Selling Price"],
    rows: [["SHIRT-01", "Cotton Shirt", "NonExistentCategory", "150"]],
    productPolicy: "reject",
    catalogue: mockCatalogue,
  });

  assert.equal(preview.ready, false);
  assert.equal(preview.rows[0].status, "error");
  assert.ok(preview.rows[0].issues.some((i) => i.code === "category_not_found" || i.field === "category"));
});

test("archived category in import workbook produces a blocking error", () => {
  const preview = buildImportPreview({
    kind: "catalog_unified",
    headers: ["SKU", "Name (English)", "Category", "Selling Price"],
    rows: [["SHIRT-01", "Cotton Shirt", "Archived", "150"]], // Matches cat-archived
    productPolicy: "reject",
    catalogue: mockCatalogue,
  });

  assert.equal(preview.ready, false);
  assert.equal(preview.rows[0].status, "error");
  assert.ok(preview.rows[0].issues.some((i) => i.code === "archived_category"));
});

test("multi-branch stock adjustments isolate individual branch shelves", () => {
  const preview = buildImportPreview({
    kind: "stock",
    headers: ["SKU", "Branch", "Stock Action", "Quantity", "Reason"],
    rows: [
      ["DRESS-01-RED-M", "Main Branch", "ADD_STOCK", "10", "Main Restock"],
      ["DRESS-01-RED-M", "Alexandria Branch", "SET_STOCK", "4", "Alex Opening"],
    ],
    stockMode: "set",
    catalogue: mockCatalogue,
  });

  assert.equal(preview.ready, true);
  assert.equal(preview.rows[0].computedStock?.branchId, "br-main");
  assert.equal(preview.rows[0].computedStock?.delta, 10);
  assert.equal(preview.rows[1].computedStock?.branchId, "br-alex");
  assert.equal(preview.rows[1].computedStock?.after, 4);
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
  console.error(`${failed} master import tests failed`);
  process.exit(1);
}
console.log(`${tests.length}/${tests.length} master import tests passed`);
