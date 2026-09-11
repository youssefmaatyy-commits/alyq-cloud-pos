/**
 * Excel Import Logic Tests
 * Tests CSV parsing, column mapping, validation, and category resolution.
 */

import {
  parseCsv,
  buildColumnMap,
  importProductsFromCsv,
  resolveCategoryIds,
  TEMPLATE_COLUMNS,
} from "../services/excelImport";

// ── Test Runner ─────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string) {
  if (condition) {
    passed++;
  } else {
    failed++;
    console.error(`❌ FAIL: ${message}`);
  }
}

function assertEqual<T>(actual: T, expected: T, message: string) {
  if (actual === expected) {
    passed++;
  } else {
    failed++;
    console.error(`❌ FAIL: ${message}`);
    console.error(`   Expected: ${expected}`);
    console.error(`   Actual:   ${actual}`);
  }
}

// ── CSV Parser Tests ────────────────────────────────────────────────────────

console.log("Testing CSV Parser...");

// Test 1: Basic CSV parsing
const csv1 = `SKU,Name,Price\nTEST-001,Product 1,100\nTEST-002,Product 2,200`;
const rows1 = parseCsv(csv1);
assertEqual(rows1.length, 3, "CSV should have 3 rows (header + 2 data)");
assertEqual(rows1[0][0], "SKU", "First header should be SKU");
assertEqual(rows1[1][0], "TEST-001", "First data row SKU");

// Test 2: CSV with quotes
const csv2 = `SKU,Name,Price\n"TEST-001","Product, with comma",100`;
const rows2 = parseCsv(csv2);
assertEqual(rows2[1][1], "Product, with comma", "Quoted field with comma");

// Test 3: CSV with BOM (Excel UTF-8)
const csv3 = `\uFEFFSKU,Name\nTEST-001,Product`;
const rows3 = parseCsv(csv3);
assertEqual(rows3[0][0], "SKU", "BOM should be stripped");

// Test 4: Empty CSV
const csv4 = ``;
const rows4 = parseCsv(csv4);
assertEqual(rows4.length, 0, "Empty CSV should return empty array");

// ── Column Mapping Tests ────────────────────────────────────────────────────

console.log("Testing Column Mapping...");

// Test 5: English headers
const headers5 = ["SKU", "Barcode", "Name (English)", "Price", "Stock"];
const map5 = buildColumnMap(headers5);
assert(map5["0"] === "sku", "SKU column mapped");
assert(map5["1"] === "barcode", "Barcode column mapped");
assert(map5["2"] === "name_en", "English name column mapped");
assert(map5["3"] === "selling_price", "Price column mapped");
assert(map5["4"] === "stock_quantity", "Stock column mapped");

// Test 6: Arabic headers
const headers6 = ["كود", "باركود", "الاسم (عربي)", "السعر", "الكمية"];
const map6 = buildColumnMap(headers6);
assert(map6["0"] === "sku", "Arabic SKU column mapped");
assert(map6["1"] === "barcode", "Arabic barcode column mapped");
assert(map6["2"] === "name_ar", "Arabic name column mapped");
assert(map6["3"] === "selling_price", "Arabic price column mapped");
assert(map6["4"] === "stock_quantity", "Arabic stock column mapped");

// Test 7: Mixed bilingual headers (template format)
const headers7 = TEMPLATE_COLUMNS.map((col) => `${col.ar} / ${col.en}`);
const map7 = buildColumnMap(headers7);
assert(Object.keys(map7).length > 0, "Template headers should map to fields");

// ── Import Validation Tests ─────────────────────────────────────────────────

console.log("Testing Import Validation...");

// Test 8: Valid CSV import
const csv8 = `SKU,Name (English),Price,Stock\nTEST-001,Product 1,100,50\nTEST-002,Product 2,200,30`;
const result8 = importProductsFromCsv(csv8);
assertEqual(result8.totalRows, 2, "Should have 2 total rows");
assertEqual(result8.validRows.length, 2, "Both rows should be valid");
assertEqual(result8.invalidRows.length, 0, "No invalid rows");
assertEqual(result8.validRows[0].data._sku, "TEST-001", "First product SKU");
assertEqual(result8.validRows[0].data.selling_price, 100, "First product price");
assertEqual(result8.validRows[0].data.stock_quantity, 50, "First product stock");

// Test 9: CSV with missing SKU (should fail validation)
const csv9 = `SKU,Name (English),Price\n,Product 1,100`;
const result9 = importProductsFromCsv(csv9);
assertEqual(result9.validRows.length, 0, "Row without SKU should be invalid");
assertEqual(result9.invalidRows.length, 1, "Should have 1 invalid row");
assert(
  result9.invalidRows[0].errors.some((e) => e.code === "required" && e.field === "sku"),
  "Should have SKU required error"
);

// Test 10: CSV with duplicate SKUs
const csv10 = `SKU,Name (English),Price\nTEST-001,Product 1,100\nTEST-001,Product 2,200`;
const result10 = importProductsFromCsv(csv10);
assertEqual(result10.validRows.length, 1, "Only first duplicate should be valid");
assertEqual(result10.invalidRows.length, 1, "Second duplicate should be invalid");
assert(
  result10.invalidRows[0].errors.some((e) => e.code === "duplicateSku"),
  "Should have duplicate SKU error"
);

// Test 11: CSV with negative price
const csv11 = `SKU,Name (English),Price\nTEST-001,Product 1,-100`;
const result11 = importProductsFromCsv(csv11);
assertEqual(result11.validRows.length, 0, "Negative price should be invalid");
assert(
  result11.invalidRows[0].errors.some((e) => e.code === "nonnegative"),
  "Should have nonnegative error"
);

// Test 12: CSV with invalid SKU format
const csv12 = `SKU,Name (English),Price\nINVALID SKU!,Product 1,100`;
const result12 = importProductsFromCsv(csv12);
assertEqual(result12.validRows.length, 0, "Invalid SKU format should be invalid");
assert(
  result12.invalidRows[0].errors.some((e) => e.code === "skuFormat"),
  "Should have SKU format error"
);

// Test 13: CSV with European number format
const csv13 = `SKU,Name (English),Price\nTEST-001,Product 1,"1.234,56"`;
const result13 = importProductsFromCsv(csv13);
assertEqual(result13.validRows.length, 1, "European format should be valid");
assertEqual(result13.validRows[0].data.selling_price, 1234.56, "European number parsed correctly");

// ── Category Resolution Tests ───────────────────────────────────────────────

console.log("Testing Category Resolution...");

// Test 14: Resolve category by name
const csv14 = `SKU,Name (English),Category\nTEST-001,Product 1,Electronics`;
const result14 = importProductsFromCsv(csv14);
const categories14 = [
  { id: "cat-1", name_ar: "إلكترونيات", name_en: "Electronics" },
  { id: "cat-2", name_ar: "ملابس", name_en: "Clothing" },
];
const resolved14 = resolveCategoryIds(result14.validRows, categories14, null);
assertEqual(resolved14[0].data.category_id, "cat-1", "Category resolved by English name");

// Test 15: Resolve category by Arabic name
const csv15 = `SKU,Name (English),Category\nTEST-001,Product 1,ملابس`;
const result15 = importProductsFromCsv(csv15);
const resolved15 = resolveCategoryIds(result15.validRows, categories14, null);
assertEqual(resolved15[0].data.category_id, "cat-2", "Category resolved by Arabic name");

// Test 16: Use default category when not found
const csv16 = `SKU,Name (English),Category\nTEST-001,Product 1,Unknown`;
const result16 = importProductsFromCsv(csv16);
const resolved16 = resolveCategoryIds(result16.validRows, categories14, "default-cat");
assertEqual(resolved16[0].data.category_id, "default-cat", "Default category used when not found");

// Test 17: No category column
const csv17 = `SKU,Name (English),Price\nTEST-001,Product 1,100`;
const result17 = importProductsFromCsv(csv17);
const resolved17 = resolveCategoryIds(result17.validRows, categories14, "default-cat");
assertEqual(resolved17[0].data.category_id, "default-cat", "Default category used when no category column");

// ── Template Columns Test ───────────────────────────────────────────────────

console.log("Testing Template Columns...");

// Test 18: Template columns structure
assert(TEMPLATE_COLUMNS.length > 0, "Template should have columns");
assert(
  TEMPLATE_COLUMNS.every((col) => col.en && col.ar && col.example),
  "All template columns should have en, ar, and example"
);

// Test 19: Required columns present
const requiredFields = [
  { field: "sku", keywords: ["sku", "كود"] },
  { field: "name_en", keywords: ["name", "english", "إنجليزي"] },
  { field: "selling_price", keywords: ["price", "sale", "البيع"] },
];
const templateHeaders = TEMPLATE_COLUMNS.map((col) => `${col.en} ${col.ar}`.toLowerCase());
requiredFields.forEach(({ field, keywords }) => {
  assert(
    templateHeaders.some((th) => keywords.some((kw) => th.includes(kw))),
    `Template should include ${field}`
  );
});

// ── Summary ─────────────────────────────────────────────────────────────────

console.log("\n" + "=".repeat(60));
console.log(`Excel Import Tests: ${passed} passed, ${failed} failed`);
console.log("=".repeat(60));

if (failed > 0) {
  process.exit(1);
} else {
  console.log("✅ All Excel import tests passed!");
}
