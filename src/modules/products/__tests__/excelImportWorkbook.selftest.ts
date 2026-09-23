/**
 * Excel/CSV *file* import self-test (headless, Node).
 *
 * Companion to `excelImport.selftest.ts`, which covers the CSV text pipeline.
 * This suite covers the layer that decides **how a file is read**, plus the
 * semantics a shop actually hits when it uploads a spreadsheet:
 *
 *   - the round trip through the shipped `.xlsx` template. This was broken: the
 *     importer read every file with `file.text()` and handed the bytes to the
 *     CSV parser, so a real workbook parsed as ZIP garbage and reported "could
 *     not detect SKU or product name columns" — the template the app itself
 *     offers for download could never be uploaded;
 *   - format detection by content, not by file name (a CSV named `.xlsx` still
 *     works, an `.xls` binary does too);
 *   - required columns, invalid values, duplicates inside the file;
 *   - the template's example row, which must be rejected rather than imported
 *     as a product called "Example Product";
 *   - `stock_tracking_enabled`, a column the template advertises.
 *
 * Needs a real `require` for `xlsx`'s CommonJS factory — see `testBanner()` in
 * `scripts/lib/app-bundle.mjs`.
 */
import assert from "node:assert/strict";

import * as XLSX from "xlsx";

import {
  buildColumnMap,
  generateExcelTemplate,
  IMPORT_LIMITS,
  importProductsFromCsv,
  importProductsFromFile,
  importProductsFromRows,
  looksLikeWorkbook,
  readWorkbookRows,
  TEMPLATE_COLUMNS,
  TEMPLATE_EXAMPLE,
  type ImportResult,
} from "../services/excelImport";
import { AppError, type AppErrorCode } from "../data/repository";

// ── helpers ─────────────────────────────────────────────────────────────────
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

function fileFrom(bytes: ArrayBuffer | Uint8Array, name: string, type: string): File {
  return new File([bytes as BlobPart], name, { type });
}

/** Build a real workbook from a grid, the way Excel would save it. */
function workbookBytes(rows: unknown[][], bookType: "xlsx" | "biff8" = "xlsx"): ArrayBuffer {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), "Products");
  return XLSX.write(wb, { type: "array", bookType }) as ArrayBuffer;
}

async function importGrid(rows: unknown[][], name = "stock.xlsx"): Promise<ImportResult> {
  const bytes = workbookBytes(rows);
  return importProductsFromFile(fileFrom(bytes, name, XLSX_MIME));
}

const codes = (result: ImportResult, row: number) =>
  result.invalidRows
    .find((r) => r.row === row)
    ?.errors.map((e) => e.code)
    .sort() ?? [];

const HEADERS = [
  "SKU",
  "Product Name (Arabic)",
  "Product Name (English)",
  "Selling Price",
  "Cost Price",
  "Stock Quantity",
  "Category",
];

const GOOD_ROWS: unknown[][] = [
  ["ALYQ-9001", "أقراط ذهبية", "Ethiopian Earrings", 68.5, 40, 25, "Earrings"],
  ["ALYQ-9002", "شاي أخضر", "Green Tea", 30, 18.75, 12, "Tea"],
];


/**
 * Assert that a file is refused, and refused for the stated reason.
 *
 * The reason matters as much as the refusal: every one of these files would
 * "fail" anyway if it were handed to the parser — as a wall of mojibake, a
 * tab that runs out of memory, or an import that quietly stops at row 10,000
 * and reports itself complete. A coded refusal is the difference between a
 * limit and a crash.
 */
async function expectRefusal(file: File, code: AppErrorCode, what: string): Promise<void> {
  try {
    await importProductsFromFile(file);
  } catch (error) {
    assert.ok(error instanceof AppError, `${what}: threw something that is not an AppError`);
    assert.equal(error.code, code, `${what}: refused for the wrong reason`);
    return;
  }
  assert.fail(`${what}: the file was accepted`);
}

/** A CSV of `dataRows` rows under the real header, as text bytes. */
function csvBytes(dataRows: number): Uint8Array {
  const lines = [HEADERS.join(",")];
  for (let i = 0; i < dataRows; i += 1) {
    lines.push(`ALYQ-${String(100000 + i).slice(-6)},Limit row ${i + 1},5.5`);
  }
  return new TextEncoder().encode(lines.join("\n"));
}

// ── tests ───────────────────────────────────────────────────────────────────
const tests: { name: string; fn: () => void | Promise<void> }[] = [
  {
    name: "reads a real .xlsx workbook (regression: it used to parse ZIP bytes as CSV)",
    async fn() {
      const result = await importGrid([HEADERS, ...GOOD_ROWS]);
      assert.deepEqual(result.globalErrors, []);
      assert.equal(result.validRows.length, 2, "both products are valid");
      assert.equal(result.invalidRows.length, 0);
      const first = result.validRows[0].data;
      assert.equal(first.sku, "ALYQ-9001");
      assert.equal(first.name_ar, "أقراط ذهبية", "Arabic survives the round trip");
      assert.equal(first.name_en, "Ethiopian Earrings");
      assert.equal(first.selling_price, 68.5, "a numeric cell becomes the right price");
      assert.equal(first.cost_price, 40);
      assert.equal(first.stock_quantity, 25);
      assert.equal(first._categoryName, "Earrings");
    },
  },
  {
    name: "the shipped template round-trips and its example row is rejected, not imported",
    async fn() {
      const template = await generateExcelTemplate();
      assert.ok(looksLikeWorkbook(new Uint8Array(template)), "the template is a real workbook");
      const result = await importProductsFromFile(
        fileFrom(template, "products-template.xlsx", XLSX_MIME),
      );
      assert.deepEqual(result.globalErrors, [], "the template's headers are recognised");
      assert.ok(Object.keys(result.columnMap).length >= 8, "the template columns map");
      assert.equal(result.validRows.length, 0, "the example row must not become a product");
      assert.equal(result.invalidRows.length, 1);
      assert.deepEqual(codes(result, 1), ["templateExample"]);
      assert.match(result.invalidRows[0].errors[0].message, /example row/i);
      assert.equal(TEMPLATE_EXAMPLE.sku, "SKU-001");
    },
  },
  {
    name: "a real SKU that merely looks like the example still imports",
    async fn() {
      const result = await importGrid([
        ["SKU", "Name", "Price"],
        ["SKU-001", "My own product", 10],
      ]);
      assert.equal(result.validRows.length, 1, "only the template's own example is rejected");
    },
  },
  {
    name: "reads a legacy .xls (BIFF8) workbook",
    async fn() {
      const bytes = workbookBytes([HEADERS, ...GOOD_ROWS], "biff8");
      assert.ok(looksLikeWorkbook(new Uint8Array(bytes)), ".xls has the OLE2 magic number");
      const result = await importProductsFromFile(fileFrom(bytes, "stock.xls", "application/vnd.ms-excel"));
      assert.equal(result.validRows.length, 2, "the old binary format imports too");
      assert.equal(result.validRows[0].data.sku, "ALYQ-9001");
    },
  },
  {
    name: "detects the format by content, so a CSV named .xlsx still imports",
    async fn() {
      const csv = new TextEncoder().encode("SKU,Name,Price\nALYQ-9001,Ethiopian Earrings,68.5");
      assert.equal(looksLikeWorkbook(csv), false, "text is not a workbook");
      const result = await importProductsFromFile(fileFrom(csv, "stock.xlsx", "text/csv"));
      assert.equal(result.validRows.length, 1);
      assert.equal(result.validRows[0].data.selling_price, 68.5);
    },
  },
  {
    name: "still imports CSV and strips the BOM Excel writes",
    async fn() {
      const csv = "\uFEFFSKU,Name,Price,Stock\nALYQ-9001,Ethiopian Earrings,68.5,25\n";
      const result = await importProductsFromFile(
        fileFrom(new TextEncoder().encode(csv), "stock.csv", "text/csv"),
      );
      assert.deepEqual(result.globalErrors, []);
      assert.equal(result.validRows.length, 1);
      assert.equal(result.validRows[0].data.sku, "ALYQ-9001", "no BOM left on the first header");
    },
  },
  {
    name: "workbook and CSV agree row for row",
    async fn() {
      const fromWorkbook = await importGrid([HEADERS, ...GOOD_ROWS]);
      const fromCsv = importProductsFromCsv(
        "SKU,Product Name (Arabic),Product Name (English),Selling Price,Cost Price,Stock Quantity,Category\n" +
          "ALYQ-9001,أقراط ذهبية,Ethiopian Earrings,68.5,40,25,Earrings\n" +
          "ALYQ-9002,شاي أخضر,Green Tea,30,18.75,12,Tea\n",
      );
      assert.deepEqual(
        fromWorkbook.validRows.map((r) => r.data),
        fromCsv.validRows.map((r) => r.data),
        "one pipeline, one set of rules",
      );
    },
  },
  {
    name: "reports missing required columns instead of importing blanks",
    async fn() {
      const result = await importGrid([
        ["Title", "Amount"],
        ["Something", 10],
      ]);
      assert.equal(result.validRows.length, 0);
      assert.equal(result.globalErrors.length, 1);
      assert.match(result.globalErrors[0], /Could not detect SKU or product name columns/);
    },
  },
  {
    name: "rejects a row with no SKU and a row with no name at all",
    async fn() {
      const result = await importGrid([
        ["SKU", "Name", "Price"],
        ["", "No SKU product", 10],
        ["ALYQ-9003", "", 10],
      ]);
      assert.equal(result.validRows.length, 0);
      assert.deepEqual(codes(result, 1), ["required"]);
      assert.deepEqual(codes(result, 2), ["required"]);
      assert.match(result.invalidRows[1].errors[0].message, /Arabic or English/);
    },
  },
  {
    name: "rejects bad numbers: negative price, tax over 100, non-numeric stock",
    async fn() {
      const result = await importGrid([
        ["SKU", "Name", "Selling Price", "Cost Price", "Tax", "Stock"],
        ["ALYQ-9101", "Negative price", -5, 1, 0, 1],
        ["ALYQ-9102", "Bad tax", 10, 1, 150, 1],
        ["ALYQ-9103", "Text stock", 10, 1, 0, "twelve"],
        ["ALYQ-9104", "Text price", "free", 1, 0, 1],
      ]);
      assert.equal(result.validRows.length, 0, "every malformed row is held back");
      assert.deepEqual(codes(result, 1), ["nonnegative"]);
      assert.deepEqual(codes(result, 2), ["taxRange"]);
      assert.deepEqual(codes(result, 3), ["nonnegative"]);
      assert.deepEqual(codes(result, 4), ["nonnegative"]);
    },
  },
  {
    name: "rejects an over-long SKU, an invalid SKU and an unknown product type",
    async fn() {
      const result = await importGrid([
        ["SKU", "Name", "Type"],
        ["A".repeat(41), "Too long", "physical"],
        ["bad*sku", "Bad characters", "physical"],
        ["ALYQ-9201", "Unknown type", "digital"],
      ]);
      assert.deepEqual(codes(result, 1), ["tooLong"]);
      assert.deepEqual(codes(result, 2), ["skuFormat"]);
      assert.deepEqual(codes(result, 3), ["invalidType"]);
      assert.match(result.invalidRows[2].errors[0].message, /digital/);
    },
  },
  {
    name: "flags duplicate SKUs and barcodes inside the same file",
    async fn() {
      const result = await importGrid([
        ["SKU", "Name", "Price", "Barcode"],
        ["ALYQ-9301", "First", 10, "6281000009301"],
        ["alyq-9301", "Same SKU different case", 12, "6281000009302"],
        ["ALYQ-9303", "Same barcode", 14, "6281000009301"],
      ]);
      assert.equal(result.validRows.length, 1, "only the first occurrence is imported");
      assert.deepEqual(codes(result, 2), ["duplicateSku"]);
      assert.match(result.invalidRows[0].errors[0].message, /also in row 1/);
      assert.deepEqual(codes(result, 3), ["duplicateBarcode"]);
    },
  },
  {
    name: "ignores blank rows without counting them as errors",
    async fn() {
      const result = await importGrid([
        ["SKU", "Name", "Price"],
        ["ALYQ-9401", "Real product", 10],
        ["", "", ""],
        ["ALYQ-9402", "Another product", 20],
      ]);
      assert.equal(result.totalRows, 2, "blank rows are not data rows");
      assert.equal(result.validRows.length, 2);
      assert.equal(result.invalidRows.length, 0);
    },
  },
  {
    name: "reads the stock-tracking column the template advertises",
    async fn() {
      const result = await importGrid([
        ["SKU", "Name", "Price", "Stock Quantity", "Stock Tracking Enabled"],
        ["ALYQ-9501", "Tracking off", 10, 5, "false"],
        ["ALYQ-9502", "Tracking on", 10, 5, "TRUE"],
        ["ALYQ-9503", "Arabic yes", 10, 5, "نعم"],
        ["ALYQ-9504", "Not specified", 10, 5, ""],
      ]);
      assert.equal(result.validRows.length, 4);
      const byS = (sku: string) => result.validRows.find((r) => r.data.sku === sku)?.data;
      assert.equal(byS("ALYQ-9501")?.stock_tracking_enabled, false, "an explicit false is honoured");
      assert.equal(byS("ALYQ-9502")?.stock_tracking_enabled, true);
      assert.equal(byS("ALYQ-9503")?.stock_tracking_enabled, true, "Arabic نعم means yes");
      assert.equal(byS("ALYQ-9504")?.stock_tracking_enabled, true, "absent falls back to the stock quantity");
    },
  },
  {
    name: "rejects a stock-tracking value that is not a yes or no",
    async fn() {
      const result = await importGrid([
        ["SKU", "Name", "Stock Tracking Enabled"],
        ["ALYQ-9601", "Nonsense flag", "maybe"],
      ]);
      assert.deepEqual(codes(result, 1), ["invalidFlag"]);
      assert.match(result.invalidRows[0].errors[0].message, /maybe/);
    },
  },
  {
    name: "maps Arabic headers",
    async fn() {
      const result = await importGrid([
        ["رمز المنتج", "الاسم", "سعر البيع", "سعر التكلفة", "الكمية بالمخزون", "الفئة"],
        ["ALYQ-9701", "أقراط", 68.5, 40, 25, "مشروبات"],
      ]);
      assert.deepEqual(result.globalErrors, []);
      assert.equal(result.validRows.length, 1);
      const data = result.validRows[0].data;
      assert.equal(data.sku, "ALYQ-9701");
      assert.equal(data.name_ar, "أقراط");
      assert.equal(data.selling_price, 68.5);
      assert.equal(data._categoryName, "مشروبات");
    },
  },
  {
    name: "finds the products sheet behind a cover sheet",
    async fn() {
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(
        wb,
        XLSX.utils.aoa_to_sheet([["ACME Wholesale"], ["Prices valid until further notice"]]),
        "Read me",
      );
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([HEADERS, ...GOOD_ROWS]), "Catalogue");
      const bytes = XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
      const result = await importProductsFromFile(fileFrom(bytes, "catalogue.xlsx", XLSX_MIME));
      assert.equal(result.validRows.length, 2, "the cover sheet is skipped");
      assert.equal(result.validRows[0].data.sku, "ALYQ-9001");
    },
  },
  {
    name: "keeps a 13-digit barcode and float artefacts intact",
    async fn() {
      const rows = await readWorkbookRows(
        new Uint8Array(workbookBytes([["Barcode", "Price"], [6281000000013, 0.1 + 0.2]])),
      );
      assert.equal(rows[1][0], "6281000000013", "no scientific notation");
      assert.equal(rows[1][1], "0.3", "no 0.30000000000000004");
    },
  },
  {
    name: "reads Eastern Arabic numerals and separators",
    async fn() {
      const result = await importProductsFromFile(
        fileFrom(
          new TextEncoder().encode("SKU,Name,Price,Stock\nALYQ-9901,أقراط,٦٨٫٥,٢٥\n"),
          "arabic.csv",
          "text/csv",
        ),
      );
      assert.equal(result.validRows.length, 1, "٦٨٫٥ is a price, not text");
      assert.equal(result.validRows[0].data.selling_price, 68.5);
      assert.equal(result.validRows[0].data.stock_quantity, 25);
    },
  },
  {
    name: "text in a numeric column is an error, not a silent zero",
    async fn() {
      const result = await importGrid([
        ["SKU", "Name", "Price", "Stock"],
        ["ALYQ-9902", "Free text price", "free", 5],
        ["ALYQ-9903", "Text stock", 10, "twelve"],
      ]);
      assert.equal(result.validRows.length, 0, "neither row may import at price/stock 0");
      assert.deepEqual(codes(result, 1), ["nonnegative"]);
      assert.deepEqual(codes(result, 2), ["nonnegative"]);
    },
  },
  {
    name: "an empty workbook is reported, not silently accepted",
    async fn() {
      const result = await importGrid([[]]);
      assert.equal(result.totalRows, 0);
      assert.equal(result.validRows.length, 0);
      assert.deepEqual(result.globalErrors, ["The file is empty."]);
    },
  },
  {
    name: "every template column the schema supports is importable",
    async fn() {
      const headers = TEMPLATE_COLUMNS.map((column) => column.en);
      const map = Object.values(buildColumnMap(headers));
      for (const field of [
        "name_ar",
        "name_en",
        "sku",
        "barcode",
        "category_name",
        "cost_price",
        "selling_price",
        "stock_quantity",
        "stock_tracking_enabled",
      ]) {
        assert.ok(map.includes(field as never), `the template's ${field} column is recognised`);
      }
      // "Unit" is the one template column with no product field behind it — the
      // schema has no unit, which is also why the exports leave it blank.
      assert.equal(map.length, headers.length - 1, "only Unit is unmapped");
    },
  },
  {
    name: "importProductsFromRows is the shared pipeline",
    fn() {
      const result = importProductsFromRows([
        ["SKU", "Name", "Price"],
        ["ALYQ-9801", "Direct rows", "12.5"],
      ]);
      assert.equal(result.validRows.length, 1);
      assert.equal(result.validRows[0].data.selling_price, 12.5, "a text price still parses");
    },
  },
  // ── the limits (migration 0030's companion: what a file may cost) ────────
  {
    name: "a file over the size limit is refused before it is read",
    async fn() {
      // The refusal has to come first: `file.arrayBuffer()` on a 2 GB upload is
      // the failure this prevents, so the test allocates one byte over the cap
      // and asserts nothing was parsed.
      const oversize = new Uint8Array(IMPORT_LIMITS.maxBytes + 1);
      await expectRefusal(
        fileFrom(oversize, "huge.xlsx", XLSX_MIME),
        "IMPORT_FILE_TOO_LARGE",
        "an oversized workbook",
      );
    },
  },
  {
    name: "an empty file is refused rather than parsed as an empty sheet",
    async fn() {
      await expectRefusal(
        fileFrom(new Uint8Array(0), "empty.csv", "text/csv"),
        "IMPORT_FILE_UNSUPPORTED",
        "an empty file",
      );
    },
  },
  {
    name: "a binary that is not a workbook is refused, not fed to the CSV parser",
    async fn() {
      // PNG magic, then a NUL: not a ZIP and not an OLE2 stream, so the format
      // sniffing falls through to "text" unless something stops it. What it used
      // to produce was mojibake and "could not detect SKU or product name
      // columns" — a true sentence about the wrong problem.
      const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
      await expectRefusal(
        fileFrom(png, "photo.xlsx", XLSX_MIME),
        "IMPORT_FILE_UNSUPPORTED",
        "a renamed image",
      );
      assert.equal(looksLikeWorkbook(png), false, "a PNG is not a workbook");
    },
  },
  {
    name: "a CSV over the row cap is refused instead of silently truncated",
    async fn() {
      await expectRefusal(
        fileFrom(csvBytes(IMPORT_LIMITS.maxRows + 1), "too-many.csv", "text/csv"),
        "IMPORT_TOO_MANY_ROWS",
        "a CSV with one row too many",
      );
    },
  },
  {
    name: "a CSV exactly at the row cap imports every row",
    async fn() {
      // The other side of the same boundary: the cap must not be off by one and
      // refuse a file it is allowed to take. `totalRows` counts data rows, so a
      // file at the cap is one header plus maxRows - 1 products.
      const result = await importProductsFromFile(
        fileFrom(csvBytes(IMPORT_LIMITS.maxRows - 1), "at-the-cap.csv", "text/csv"),
      );
      assert.equal(
        result.totalRows,
        IMPORT_LIMITS.maxRows - 1,
        "a file at the cap kept every row",
      );
      assert.equal(
        result.validRows.length + result.invalidRows.length,
        result.totalRows,
        "every row was accounted for, so nothing was dropped on the way",
      );
    },
  },
  {
    name: "a workbook over the row cap is stopped inside the reader",
    async fn() {
      // `sheetRows` is what makes this cheap: the reader is told to stop one row
      // past the cap, so an .xlsx that decompresses to a million rows is refused
      // having parsed 10,001 of them rather than after building the array.
      const rows: unknown[][] = [HEADERS];
      for (let i = 0; i <= IMPORT_LIMITS.maxRows; i += 1) {
        rows.push([`ALYQ-${String(200000 + i).slice(-6)}`, `Bomb row ${i + 1}`, "5.5"]);
      }
      await expectRefusal(
        fileFrom(workbookBytes(rows), "bomb.xlsx", XLSX_MIME),
        "IMPORT_TOO_MANY_ROWS",
        "a workbook with one row too many",
      );
    },
  },
];

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
  console.log(`\n${passed}/${passed + failed} Excel file-import tests passed`);
  if (failed > 0) process.exit(1);
}

run();
