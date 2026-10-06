/**
 * Master Excel Import Center E2E Flow.
 *
 * Drives the real app bundle in jsdom:
 *   1. Sign in as admin.
 *   2. Navigate to #/products (Products Catalog page).
 *   3. Click the visible "Import from Excel" button and verify navigation to #/dashboard/products/import.
 *   4. Verify Blank Catalog Template, Current Catalog Export, and Stock Adjustment Template downloads.
 *   5. Verify 26-column schema, reference lists, and assert regression absence of legacy "Products Template".
 *   6. Verify cashier / unauthorized role permission gating.
 *
 *   node scripts/test.e2e.mjs import
 */
import { createUxHarness } from "./lib/ux-harness.mjs";
import * as XLSX from "xlsx";

const ux = await createUxHarness({
  beforeImport: ({ localStorage: ls }) => {
    for (const key of Object.keys(ls)) {
      if (key.startsWith("alyq.demo.") || key.startsWith("alyq.store.")) ls.removeItem(key);
    }
  },
});

const {
  assert,
  bodyText,
  click,
  downloads,
  sleep,
  waitFor,
  navigate,
  signInAs,
  signOut,
} = ux;

console.log("\nMaster Excel Import Center E2E Flow\n");
await sleep(600);

// 1. Sign in as admin
await signInAs("admin");
await waitFor(() => (document.querySelector("aside")?.textContent ?? "").includes("Dashboard"), {
  label: "the admin sidebar",
});
console.log("  ✓ Admin signed in");

// 2. Navigate to Products Catalogue page
await navigate("/products");
await waitFor(() => bodyText().includes("Products") || bodyText().includes("المنتجات"), {
  label: "Products page",
});
assert.ok(
  [...document.querySelectorAll("button, a")].some((el) => (el.textContent ?? "").includes("Import")),
  "Import button must be visible on Products page",
);
console.log("  ✓ Products page mounted with visible Import button");

// 3. Click the visible Import button from Products page -> must route to /dashboard/products/import
click("Import");
await waitFor(() => bodyText().includes("Master Import Center") || bodyText().includes("مركز الاستيراد المتقدم"), {
  label: "Master Import Center after clicking Products import button",
});
assert.ok(
  document.location.hash.includes("/dashboard/products/import"),
  `Route must be /dashboard/products/import (actual: ${document.location.hash})`,
);
console.log("  ✓ Clicking Import button on Products page navigates directly to Master Import Center");

// 4. Test Template Downloads from Master Import Center
const downloadsBefore = downloads.length;

// A) Blank Catalog Template
click("Blank Catalog Template");
await sleep(600);
assert.equal(downloads.length, downloadsBefore + 1, "Blank catalog template download triggered");
const blankTemplate = downloads[downloads.length - 1];
assert.equal(blankTemplate.filename, "alyq-blank-catalog-template.xlsx", "Filename must be alyq-blank-catalog-template.xlsx");

const blankBytes = Buffer.from(await blankTemplate.blob.arrayBuffer());
assert.deepEqual(
  [...blankBytes.subarray(0, 4)],
  [0x50, 0x4b, 0x03, 0x04],
  "Blank template is a valid zip/xlsx archive",
);

const blankWb = XLSX.read(blankBytes, { type: "buffer" });
assert.ok(
  !blankWb.SheetNames.includes("Products Template"),
  "REGRESSION GUARD: Must NOT generate legacy 10-column 'Products Template' sheet",
);
assert.ok(
  blankWb.SheetNames.includes("Catalog Template"),
  "Must contain modern 'Catalog Template' sheet",
);
assert.ok(
  blankWb.SheetNames.includes("Reference Values"),
  "Must contain 'Reference Values' sheet for reference lookups",
);

const catalogSheet = blankWb.Sheets["Catalog Template"];
const catalogRows = XLSX.utils.sheet_to_json(catalogSheet, { header: 1 });
const headers = catalogRows[0];
assert.equal(headers.length, 26, `Catalog template must contain exactly 26 columns (actual: ${headers.length})`);
assert.equal(headers[0], "Product Name (Arabic) / اسم المنتج (عربي)");
assert.equal(headers[1], "Product Name (English) / اسم المنتج (إنجليزي)");
assert.equal(headers[2], "Product SKU / رمز المنتج");
assert.equal(headers[3], "Barcode / الباركود");
assert.equal(headers[4], "Category / الفئة");
assert.equal(headers[6], "Selling Price / سعر البيع");
assert.equal(headers[7], "Cost Price / سعر التكلفة");
assert.equal(headers[14], "Variant SKU / رمز المتغير");
assert.equal(headers[21], "Branch / الفرع");
assert.equal(headers[22], "Stock Action / العملية");
assert.equal(headers[23], "Quantity / الكمية");

// Check Reference Values sheet
const refSheet = blankWb.Sheets["Reference Values"];
const refRows = XLSX.utils.sheet_to_json(refSheet, { header: 1 });
const refHeaders = refRows[0];
assert.ok(refHeaders.includes("Stock Actions"), "Reference Values sheet must list Stock Actions");
const stockActionColIdx = refHeaders.indexOf("Stock Actions");
const stockActionVals = refRows.slice(1).map((r) => r[stockActionColIdx]).filter(Boolean);
assert.ok(stockActionVals.includes("SET_STOCK"), "Must include SET_STOCK action");
assert.ok(stockActionVals.includes("ADD_STOCK"), "Must include ADD_STOCK action");
assert.ok(stockActionVals.includes("SUBTRACT_STOCK"), "Must include SUBTRACT_STOCK action");
assert.ok(stockActionVals.includes("NO_STOCK_CHANGE"), "Must include NO_STOCK_CHANGE action");

console.log("  ✓ Blank Catalog Template generated with 26-column schema, reference lists, and no legacy layout");

// B) Current Catalog Export
click("Current Catalog Export");
await sleep(600);
assert.equal(downloads.length, downloadsBefore + 2, "Current catalog export download triggered");
const exportTemplate = downloads[downloads.length - 1];
assert.equal(exportTemplate.filename, "alyq-current-catalog-export.xlsx");
const exportBytes = Buffer.from(await exportTemplate.blob.arrayBuffer());
const exportWb = XLSX.read(exportBytes, { type: "buffer" });
assert.ok(exportWb.SheetNames.includes("Current Catalog"), "Current Catalog sheet must exist");
console.log("  ✓ Current Catalog Export generated successfully");

// C) Stock Adjustment Template
click("Stock Adjustment Template");
await sleep(600);
assert.equal(downloads.length, downloadsBefore + 3, "Stock adjustment template download triggered");
const stockTemplate = downloads[downloads.length - 1];
assert.equal(stockTemplate.filename, "alyq-stock-adjustment-template.xlsx");
const stockBytes = Buffer.from(await stockTemplate.blob.arrayBuffer());
const stockWb = XLSX.read(stockBytes, { type: "buffer" });
assert.ok(stockWb.SheetNames.includes("Stock Adjustments"), "Stock Adjustments sheet must exist");
console.log("  ✓ Stock Adjustment Template generated successfully");

// 5. Verify permissions: Viewer (who lacks import_data) is gated
await signOut();
await signInAs("viewer");
await navigate("/dashboard/products/import");
await sleep(300);
const viewerText = bodyText();
assert.ok(
  viewerText.includes("access") || viewerText.includes("cannot open") || viewerText.includes("صلاحية") || viewerText.includes("You do not have permission") || viewerText.includes("ليس لديك صلاحية"),
  "Viewer must not have access to Import Center",
);
console.log("  ✓ Viewer permission gate verified (access denied)");

console.log("\n✓ Master Excel Import Center E2E flow passed\n");
process.exit(0);
