/**
 * Product import from Excel (.xlsx/.xls) or CSV (Excel/Google Sheets export).
 *
 * Foundation layer: reads the file, maps columns to product fields, and
 * validates each row. The caller (UI) handles the actual creation via the
 * catalog repository.
 *
 * Two layers, deliberately separate:
 *   - format handling (`importProductsFromFile`, `readWorkbookRows`, `parseCsv`)
 *     turns any accepted file into `string[][]`;
 *   - the pipeline (`importProductsFromRows`) applies one set of validation
 *     rules and messages, so a workbook and a CSV behave identically.
 *
 * The CSV parser has no dependencies and handles quoted fields, embedded
 * commas, newlines and escaped quotes per RFC 4180. `xlsx` is imported lazily,
 * only when a workbook is actually opened. Everything except the file reading is
 * pure and unit-testable without React or Supabase.
 */

import {
  MAX_BARCODE_LENGTH,
  MAX_NAME_LENGTH,
  MAX_SKU_LENGTH,
  SKU_PATTERN,
} from "../constants";
import type { NewProduct, ProductType } from "../types";
import { PRODUCT_TYPES } from "../types";

// ── CSV Parser ──────────────────────────────────────────────────────────────

/**
 * Parse a CSV string into an array of row arrays.
 * Handles: quoted fields, embedded commas, embedded newlines, doubled quotes.
 * BOM is stripped from the start (Excel UTF-8 exports include it).
 */
export function parseCsv(text: string): string[][] {
  // Strip UTF-8 BOM (Excel adds this)
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;

  while (i < input.length) {
    const ch = input[i];

    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < input.length && input[i + 1] === '"') {
          // Escaped quote
          field += '"';
          i += 2;
          continue;
        }
        // End of quoted field
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }

    // Not in quotes
    if (ch === '"') {
      inQuotes = true;
      i++;
      continue;
    }

    if (ch === ",") {
      row.push(field);
      field = "";
      i++;
      continue;
    }

    if (ch === "\r") {
      // Handle \r\n and bare \r
      row.push(field);
      field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
      i++;
      if (i < input.length && input[i] === "\n") i++;
      continue;
    }

    if (ch === "\n") {
      row.push(field);
      field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
      i++;
      continue;
    }

    field += ch;
    i++;
  }

  // Last field/row (file without trailing newline)
  if (field !== "" || row.length > 0) {
    row.push(field);
    if (row.length > 1 || row[0] !== "") rows.push(row);
  }

  return rows;
}

// ── Column Mapping ──────────────────────────────────────────────────────────

/** Recognised product fields that can be mapped from a CSV column. */
export type ImportableField =
  | "sku"
  | "barcode"
  | "name_ar"
  | "name_en"
  | "description_ar"
  | "description_en"
  | "selling_price"
  | "cost_price"
  | "tax_rate"
  | "stock_quantity"
  | "low_stock_level"
  | "stock_tracking_enabled"
  | "product_type"
  | "category_name";

/** Map from CSV header text (lowercased, trimmed) → product field. */
export type ColumnMap = Record<string, ImportableField>;

/** Default header aliases — covers English, Arabic and common variants. */
const HEADER_ALIASES: Record<ImportableField, string[]> = {
  sku: ["sku", "code", "product sku", "كود", "رمز", "رمز المنتج", "رمز المنتج / sku"],
  barcode: ["barcode", "باركود", "الباركود", "الباركود / barcode"],
  // The template writes plain "Product Name (Arabic)"; shops that translate the
  // header row write the Arabic forms. Both have to map, or every row fails with
  // "at least one name is required" no matter how good the data is.
  name_ar: ["name_ar", "name ar", "namear", "الاسم", "اسم عربي", "الاسم (عربي)", "الاسم العربي", "name arabic", "name (arabic)", "product name arabic", "product name (arabic)", "اسم المنتج (عربي)", "اسم المنتج عربي", "اسم المنتج (عربي) / product name (arabic)"],
  name_en: ["name_en", "name en", "nameen", "name", "اسم انجليزي", "name english", "name (english)", "product", "product name english", "product name (english)", "الاسم الإنجليزي", "الاسم (إنجليزي)", "اسم المنتج (إنجليزي)", "اسم المنتج انجليزي", "اسم المنتج (إنجليزي) / product name (english)"],
  description_ar: ["description_ar", "description ar", "الوصف", "وصف عربي"],
  description_en: ["description_en", "description en", "description", "وصف انجليزي"],
  selling_price: ["selling_price", "price", "السعر", "سعر البيع", "selling price", "سعر البيع / selling price"],
  cost_price: ["cost_price", "cost", "التكلفة", "سعر التكلفة", "cost price", "سعر التكلفة / cost price"],
  tax_rate: ["tax_rate", "tax", "الضريبة", "نسبة الضريبة", "tax rate", "vat"],
  stock_quantity: ["stock_quantity", "stock", "qty", "quantity", "الكمية", "المخزون", "stock quantity", "الكمية بالمخزون / stock quantity"],
  low_stock_level: ["low_stock_level", "low stock", "low_stock", "الحد الأدنى", "حد المخزون"],
  // The shipped template advertises this column, so the importer has to read it
  // — otherwise "false" in the file was silently ignored and tracking stayed on.
  stock_tracking_enabled: [
    "stock_tracking_enabled",
    "stock tracking enabled",
    "stock tracking",
    "track stock",
    "tracking",
    "تتبع المخزون",
    "تتبع المخزون / stock tracking enabled",
  ],
  product_type: ["product_type", "type", "النوع", "نوع المنتج"],
  category_name: ["category", "category_name", "التصنيف", "الفئة", "الفئة / category"],
};

/**
 * Header text reduced to letters and digits, so spacing and punctuation cannot
 * break a match: "Product Name (Arabic)", "product name  arabic" and
 * "Product-Name-Arabic" all collapse to the same key.
 */
function normalizeHeader(header: string): string {
  return header.trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

/** Alias → field, keyed on the normalised form (built once). */
const NORMALIZED_ALIASES: Map<string, ImportableField> = new Map(
  (Object.entries(HEADER_ALIASES) as [ImportableField, string[]][]).flatMap(([field, aliases]) =>
    aliases.map((alias) => [normalizeHeader(alias), field] as [string, ImportableField]),
  ),
);

/**
 * Build a column map from a header row by matching against known aliases.
 *
 * Exact matches win first (so "Name" keeps mapping to `name_en` exactly as
 * before); anything left over gets a second chance with punctuation and spacing
 * ignored. A field is only ever bound to one column — the first that claims it.
 */
export function buildColumnMap(headers: string[]): ColumnMap {
  const map: ColumnMap = {};
  const taken = () => Object.values(map);

  for (let i = 0; i < headers.length; i++) {
    const header = headers[i].trim().toLowerCase();
    if (!header) continue;
    for (const [field, aliases] of Object.entries(HEADER_ALIASES) as [ImportableField, string[]][]) {
      if (aliases.includes(header) && !taken().includes(field)) {
        map[String(i)] = field;
        break;
      }
    }
  }

  for (let i = 0; i < headers.length; i++) {
    if (map[String(i)]) continue;
    const field = NORMALIZED_ALIASES.get(normalizeHeader(headers[i]));
    if (field && !taken().includes(field)) map[String(i)] = field;
  }

  return map;
}

// ── Row Parsing ─────────────────────────────────────────────────────────────

export interface ImportRowError {
  row: number;
  field: ImportableField | "_row";
  code:
    | "required"
    | "skuFormat"
    | "tooLong"
    | "nonnegative"
    | "taxRange"
    | "invalidType"
    | "invalidFlag"
    | "templateExample"
    | "duplicateSku"
    | "duplicateBarcode";
  message: string;
}

export interface ImportRowResult {
  row: number;
  data: Partial<NewProduct> & { _categoryName?: string; _sku: string; _barcode: string | null };
  errors: ImportRowError[];
  valid: boolean;
}

/**
 * Eastern Arabic numerals and separators, normalised to ASCII — an Arabic Excel
 * sheet may well contain ٦٨٫٥ instead of 68.5.
 */
function normalizeDigits(raw: string): string {
  return raw
    .replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[\u06f0-\u06f9]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/\u066b/g, ".") // Arabic decimal separator
    .replace(/\u066c/g, ","); // Arabic thousands separator
}

function parseNumber(raw: string): number {
  if (!raw.trim()) return NaN;
  const cleaned = normalizeDigits(raw).replace(/[^\d.,-]/g, "");
  // No digits at all means the cell holds text ("twelve", "free"). Reporting
  // that as 0 would quietly import a free product instead of flagging the row.
  if (!/\d/.test(cleaned)) return NaN;
  
  // Detect European format: 1.234,56 (dots as thousands, comma as decimal)
  // Check if there's a comma followed by exactly 2 digits at the end
  const hasEuropeanFormat = /,\d{2}$/.test(cleaned) && cleaned.includes(".");
  
  let normalized: string;
  if (hasEuropeanFormat) {
    // European: remove dots (thousands), replace comma with dot (decimal)
    normalized = cleaned.replace(/\./g, "").replace(",", ".");
  } else {
    // US/Standard: remove commas (thousands), keep dots (decimal)
    normalized = cleaned.replace(/,/g, "");
  }
  
  const value = Number(normalized);
  return Number.isFinite(value) ? value : NaN;
}

function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function normalizeType(raw: string): ProductType | null {
  const lower = raw.trim().toLowerCase();
  if (!lower) return "physical"; // default
  if (PRODUCT_TYPES.includes(lower as ProductType)) return lower as ProductType;
  // Common aliases
  if (lower === "good" || lower === "goods" || lower === "physical") return "physical";
  if (lower === "service" || lower === "خدمة") return "service";
  if (lower === "manufactured" || lower === "مصنع") return "manufactured";
  return null;
}

/** Yes/no in the spellings Excel users actually type; `null` = blank/unknown. */
function parseFlag(raw: string): boolean | null {
  const value = raw.trim().toLowerCase();
  if (!value) return null;
  if (["true", "yes", "y", "1", "نعم", "صحيح", "مفعل", "متاح"].includes(value)) return true;
  if (["false", "no", "n", "0", "لا", "غير صحيح", "معطل", "غير مفعل"].includes(value)) return false;
  return null;
}

/**
 * The example row the downloaded template ships with.
 *
 * It is a convenience in the file and a hazard on import: a shop that fills in
 * its own rows but leaves the example behind would silently create a product
 * called "Example Product". Such a row is rejected with an explanation instead.
 */
export const TEMPLATE_EXAMPLE = {
  sku: "SKU-001",
  name_en: "Example Product",
  name_ar: "منتج مثال",
} as const;

function isTemplateExample(sku: string, nameAr: string, nameEn: string): boolean {
  if (sku.trim().toUpperCase() !== TEMPLATE_EXAMPLE.sku) return false;
  return (
    nameEn.trim().toLowerCase() === TEMPLATE_EXAMPLE.name_en.toLowerCase() ||
    nameAr.trim() === TEMPLATE_EXAMPLE.name_ar
  );
}

/**
 * Parse a single CSV data row into a partial product.
 * `rowIndex` is 1-based (row 1 = first data row after the header).
 */
function parseRow(
  cells: string[],
  columnMap: ColumnMap,
  rowIndex: number,
): ImportRowResult {
  const errors: ImportRowError[] = [];
  const getField = (field: ImportableField): string => {
    const colIndex = Object.entries(columnMap).find(([, f]) => f === field)?.[0];
    if (colIndex === undefined) return "";
    return (cells[Number(colIndex)] ?? "").trim();
  };

  const sku = getField("sku");
  const barcode = getField("barcode") || null;
  const nameAr = getField("name_ar");
  const nameEn = getField("name_en");
  const descriptionAr = getField("description_ar") || null;
  const descriptionEn = getField("description_en") || null;
  const sellingPriceRaw = getField("selling_price");
  const costPriceRaw = getField("cost_price");
  const taxRateRaw = getField("tax_rate");
  const stockRaw = getField("stock_quantity");
  const lowStockRaw = getField("low_stock_level");
  const trackingRaw = getField("stock_tracking_enabled");
  const typeRaw = getField("product_type");
  const categoryName = getField("category_name") || undefined;

  // The template's example row is rejected rather than imported as a product.
  if (isTemplateExample(sku, nameAr, nameEn)) {
    return {
      row: rowIndex,
      data: { _sku: sku, _barcode: barcode, _categoryName: categoryName, sku, barcode },
      errors: [
        {
          row: rowIndex,
          field: "_row",
          code: "templateExample",
          message: `This is the template's example row (${TEMPLATE_EXAMPLE.sku} — ${TEMPLATE_EXAMPLE.name_en}). Replace it with your own product or delete the row.`,
        },
      ],
      valid: false,
    };
  }

  // Validate SKU
  if (!sku) {
    errors.push({ row: rowIndex, field: "sku", code: "required", message: "SKU is required" });
  } else if (sku.length > MAX_SKU_LENGTH) {
    errors.push({ row: rowIndex, field: "sku", code: "tooLong", message: `SKU exceeds ${MAX_SKU_LENGTH} characters` });
  } else if (!SKU_PATTERN.test(sku)) {
    errors.push({ row: rowIndex, field: "sku", code: "skuFormat", message: "SKU contains invalid characters" });
  }

  // Validate barcode
  if (barcode && barcode.length > MAX_BARCODE_LENGTH) {
    errors.push({ row: rowIndex, field: "barcode", code: "tooLong", message: `Barcode exceeds ${MAX_BARCODE_LENGTH} characters` });
  }

  // Validate names
  if (!nameAr && !nameEn) {
    errors.push({ row: rowIndex, field: "name_en", code: "required", message: "At least one name (Arabic or English) is required" });
  }
  if (nameAr && nameAr.length > MAX_NAME_LENGTH) {
    errors.push({ row: rowIndex, field: "name_ar", code: "tooLong", message: `Arabic name exceeds ${MAX_NAME_LENGTH} characters` });
  }
  if (nameEn && nameEn.length > MAX_NAME_LENGTH) {
    errors.push({ row: rowIndex, field: "name_en", code: "tooLong", message: `English name exceeds ${MAX_NAME_LENGTH} characters` });
  }

  // Validate prices
  const sellingPrice = sellingPriceRaw ? parseNumber(sellingPriceRaw) : 0;
  if (sellingPriceRaw && Number.isNaN(sellingPrice)) {
    errors.push({ row: rowIndex, field: "selling_price", code: "nonnegative", message: "Invalid selling price" });
  } else if (sellingPrice < 0) {
    errors.push({ row: rowIndex, field: "selling_price", code: "nonnegative", message: "Selling price cannot be negative" });
  }

  const costPrice = costPriceRaw ? parseNumber(costPriceRaw) : 0;
  if (costPriceRaw && Number.isNaN(costPrice)) {
    errors.push({ row: rowIndex, field: "cost_price", code: "nonnegative", message: "Invalid cost price" });
  } else if (costPrice < 0) {
    errors.push({ row: rowIndex, field: "cost_price", code: "nonnegative", message: "Cost price cannot be negative" });
  }

  // Validate tax
  const taxRate = taxRateRaw ? parseNumber(taxRateRaw) : 0;
  if (taxRateRaw && Number.isNaN(taxRate)) {
    errors.push({ row: rowIndex, field: "tax_rate", code: "taxRange", message: "Invalid tax rate" });
  } else if (taxRate < 0 || taxRate > 100) {
    errors.push({ row: rowIndex, field: "tax_rate", code: "taxRange", message: "Tax rate must be 0–100" });
  }

  // Validate stock
  const stockQuantity = stockRaw ? Math.round(parseNumber(stockRaw)) : 0;
  if (stockRaw && Number.isNaN(parseNumber(stockRaw))) {
    errors.push({ row: rowIndex, field: "stock_quantity", code: "nonnegative", message: "Invalid stock quantity" });
  } else if (stockQuantity < 0) {
    errors.push({ row: rowIndex, field: "stock_quantity", code: "nonnegative", message: "Stock cannot be negative" });
  }

  const lowStockLevel = lowStockRaw ? Math.round(parseNumber(lowStockRaw)) : 5;
  if (lowStockRaw && Number.isNaN(parseNumber(lowStockRaw))) {
    errors.push({ row: rowIndex, field: "low_stock_level", code: "nonnegative", message: "Invalid low stock level" });
  } else if (lowStockLevel < 0) {
    errors.push({ row: rowIndex, field: "low_stock_level", code: "nonnegative", message: "Low stock level cannot be negative" });
  }

  // Validate the stock-tracking flag
  const stockTracking = parseFlag(trackingRaw);
  if (trackingRaw && stockTracking === null) {
    errors.push({
      row: rowIndex,
      field: "stock_tracking_enabled",
      code: "invalidFlag",
      message: `Unknown stock-tracking value: "${trackingRaw}" (use true or false)`,
    });
  }

  // Validate type
  const productType = typeRaw ? normalizeType(typeRaw) : "physical";
  if (typeRaw && productType === null) {
    errors.push({ row: rowIndex, field: "product_type", code: "invalidType", message: `Unknown product type: "${typeRaw}"` });
  }

  return {
    row: rowIndex,
    data: {
      _sku: sku,
      _barcode: barcode,
      _categoryName: categoryName,
      sku,
      barcode,
      name_ar: nameAr || nameEn || "",
      name_en: nameEn || nameAr || "",
      description_ar: descriptionAr,
      description_en: descriptionEn,
      selling_price: Number.isNaN(sellingPrice) ? 0 : round2(sellingPrice),
      cost_price: Number.isNaN(costPrice) ? 0 : round2(costPrice),
      tax_rate: Number.isNaN(taxRate) ? 0 : round2(taxRate),
      stock_tracking_enabled: stockTracking ?? (stockQuantity > 0 || !!stockRaw),
      stock_quantity: Math.max(0, stockQuantity),
      low_stock_level: Math.max(0, lowStockLevel),
      product_type: productType ?? "physical",
      show_on_website: true,
      is_featured: false,
      active: true,
      image_url: null,
      images: [],
    },
    errors,
    valid: errors.length === 0,
  };
}

// ── Full Import Pipeline ────────────────────────────────────────────────────

export interface ImportResult {
  /** Total data rows (excluding header). */
  totalRows: number;
  /** Rows that passed validation. */
  validRows: ImportRowResult[];
  /** Rows with validation errors. */
  invalidRows: ImportRowResult[];
  /** Column mapping that was used. */
  columnMap: ColumnMap;
  /** Detected headers. */
  headers: string[];
  /** Errors not tied to a specific row (e.g. empty file). */
  globalErrors: string[];
}

/**
 * Parse CSV text into validated product rows.
 *
 * Usage:
 *   const result = importProductsFromCsv(await file.text());
 *   // result.validRows → ready for createProduct()
 *   // result.invalidRows → show to user for correction
 */
export function importProductsFromCsv(csvText: string): ImportResult {
  return importProductsFromRows(parseCsv(csvText));
}

/**
 * Validate rows that are already split into cells.
 *
 * This is the whole import pipeline minus the file-format handling, so a CSV
 * export and a real Excel workbook are validated identically — one set of rules,
 * one set of messages, whichever way the file arrived.
 */
export function importProductsFromRows(rows: string[][]): ImportResult {
  const globalErrors: string[] = [];

  if (rows.length === 0) {
    return {
      totalRows: 0,
      validRows: [],
      invalidRows: [],
      columnMap: {},
      headers: [],
      globalErrors: ["The file is empty."],
    };
  }

  const headers = rows[0];
  const columnMap = buildColumnMap(headers);

  // Check that at least SKU or name can be mapped
  const mappedFields = Object.values(columnMap);
  if (!mappedFields.includes("sku") && !mappedFields.includes("name_en") && !mappedFields.includes("name_ar")) {
    globalErrors.push(
      "Could not detect SKU or product name columns. Expected headers like: SKU, Name, Price, Cost, Stock.",
    );
  }

  const dataRows = rows.slice(1);
  const validRows: ImportRowResult[] = [];
  const invalidRows: ImportRowResult[] = [];

  // Track duplicates within the file
  const seenSkus = new Map<string, number>();
  const seenBarcodes = new Map<string, number>();

  for (let i = 0; i < dataRows.length; i++) {
    const result = parseRow(dataRows[i], columnMap, i + 1);

    // Skip completely empty rows
    if (dataRows[i].every((cell) => !cell.trim())) continue;

    // Check duplicate SKUs within the file
    const sku = result.data._sku.toLowerCase();
    if (sku) {
      const prev = seenSkus.get(sku);
      if (prev !== undefined) {
        result.errors.push({
          row: result.row,
          field: "sku",
          code: "duplicateSku",
          message: `Duplicate SKU (also in row ${prev})`,
        });
        result.valid = false;
      } else {
        seenSkus.set(sku, result.row);
      }
    }

    // Check duplicate barcodes within the file
    const barcode = result.data._barcode;
    if (barcode) {
      const prev = seenBarcodes.get(barcode);
      if (prev !== undefined) {
        result.errors.push({
          row: result.row,
          field: "barcode",
          code: "duplicateBarcode",
          message: `Duplicate barcode (also in row ${prev})`,
        });
        result.valid = false;
      } else {
        seenBarcodes.set(barcode, result.row);
      }
    }

    if (result.valid) {
      validRows.push(result);
    } else {
      invalidRows.push(result);
    }
  }

  return {
    totalRows: dataRows.filter((r) => r.some((c) => c.trim())).length,
    validRows,
    invalidRows,
    columnMap,
    headers,
    globalErrors,
  };
}

/**
 * Resolve category names to IDs. Call after import to link products to
 * existing categories by name match (case-insensitive, bilingual).
 */
export function resolveCategoryIds(
  rows: ImportRowResult[],
  categories: { id: string; name_ar: string; name_en: string }[],
  defaultCategoryId: string | null,
): ImportRowResult[] {
  const byName = new Map<string, string>();
  for (const cat of categories) {
    byName.set(cat.name_ar.trim().toLowerCase(), cat.id);
    byName.set(cat.name_en.trim().toLowerCase(), cat.id);
  }

  return rows.map((row) => {
    const name = row.data._categoryName?.trim().toLowerCase();
    const categoryId = name ? byName.get(name) ?? defaultCategoryId : defaultCategoryId;
    return {
      ...row,
      data: { ...row.data, category_id: categoryId },
    };
  });
}

/**
 * Template column definitions for Excel import/export.
 * Each column has Arabic and English names for bilingual support.
 */
export const TEMPLATE_COLUMNS = [
  { ar: "اسم المنتج (عربي)", en: "Product Name (Arabic)", field: "name_ar", example: "منتج مثال" },
  { ar: "اسم المنتج (إنجليزي)", en: "Product Name (English)", field: "name_en", example: "Example Product" },
  { ar: "رمز المنتج", en: "SKU", field: "sku", example: "SKU-001" },
  { ar: "الباركود", en: "Barcode", field: "barcode", example: "1234567890123" },
  { ar: "الفئة", en: "Category", field: "category", example: "Electronics" },
  { ar: "سعر التكلفة", en: "Cost Price", field: "cost_price", example: "50.00" },
  { ar: "سعر البيع", en: "Selling Price", field: "selling_price", example: "100.00" },
  { ar: "الكمية بالمخزون", en: "Stock Quantity", field: "stock_quantity", example: "10" },
  { ar: "تتبع المخزون", en: "Stock Tracking Enabled", field: "stock_tracking_enabled", example: "true" },
  { ar: "الوحدة", en: "Unit", field: "unit", example: "piece" },
] as const;

/**
 * Import products from a File object — a real Excel workbook (.xlsx/.xls) or a
 * CSV/TSV text export.
 *
 * The format is decided by the file's *bytes*, not its name: `.xlsx` is a ZIP
 * container and `.xls` an OLE2 stream, and both were previously read with
 * `file.text()` and fed to the CSV parser, which turned the binary into garbage
 * and reported "could not detect SKU or product name columns". That made the
 * shipped `.xlsx` template impossible to upload — the one flow the button
 * advertises. A CSV that happens to be named `.xlsx` still imports, because it
 * has neither magic number.
 */
export async function importProductsFromFile(file: File): Promise<ImportResult> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (looksLikeWorkbook(bytes)) {
    return importProductsFromRows(await readWorkbookRows(bytes));
  }
  // Plain text: `parseCsv` strips the BOM Excel writes on UTF-8 exports.
  return importProductsFromCsv(new TextDecoder("utf-8").decode(bytes));
}

/** ZIP (`PK\x03\x04`) → .xlsx, OLE2 (`\xD0\xCF\x11\xE0…`) → .xls. */
const ZIP_MAGIC: readonly number[] = [0x50, 0x4b, 0x03, 0x04];
const OLE2_MAGIC: readonly number[] = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

export function looksLikeWorkbook(bytes: Uint8Array): boolean {
  const startsWith = (magic: readonly number[]) =>
    bytes.length >= magic.length && magic.every((byte, index) => bytes[index] === byte);
  return startsWith(ZIP_MAGIC) || startsWith(OLE2_MAGIC);
}

/**
 * One Excel cell as the text the validation pipeline expects.
 *
 * Numbers are stringified without float artefacts (`0.1 + 0.2` → `"0.3"`) and
 * without scientific notation, so a 13-digit barcode stays a 13-digit barcode.
 */
function cellToText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? "" : value.toISOString();
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return "";
    return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(6)));
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value).trim();
}

/**
 * Read a workbook into rows of text, choosing the sheet that actually holds
 * products — a shop's file may open with a cover or instructions tab.
 */
export async function readWorkbookRows(data: Uint8Array): Promise<string[][]> {
  // Same dynamic import the template generator uses: `xlsx` is ~900 kB and must
  // not land in the startup bundle.
  const XLSX = await import("xlsx");
  const workbook = XLSX.read(data, { type: "array", cellDates: true });

  const sheets = workbook.SheetNames.map((name) => ({
    name,
    rows: XLSX.utils
      .sheet_to_json<unknown[]>(workbook.Sheets[name], {
        header: 1,
        raw: true,
        defval: "",
        blankrows: false,
      })
      .map((row) => row.map(cellToText)),
  })).filter((sheet) => sheet.rows.length > 0);

  if (sheets.length === 0) return [];
  const products = sheets.find((sheet) => Object.keys(buildColumnMap(sheet.rows[0])).length > 0);
  return (products ?? sheets[0]).rows;
}

/**
 * Generate an Excel template for product import.
 * Returns a buffer containing the Excel file data.
 */
export async function generateExcelTemplate(): Promise<ArrayBuffer> {
  // Dynamic import to avoid loading xlsx in the main bundle
  const XLSX = await import("xlsx");
  
  const templateData = [
    [
      "Product Name (Arabic)",
      "Product Name (English)",
      "SKU",
      "Barcode",
      "Category",
      "Cost Price",
      "Selling Price",
      "Stock Quantity",
      "Stock Tracking Enabled",
      "Unit",
    ],
    [
      "منتج مثال",
      "Example Product",
      "SKU-001",
      "1234567890123",
      "Electronics",
      "50.00",
      "100.00",
      "10",
      "true",
      "piece",
    ],
  ];

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(templateData);
  
  // Set column widths
  ws["!cols"] = [
    { wch: 25 }, // Product Name (Arabic)
    { wch: 25 }, // Product Name (English)
    { wch: 15 }, // SKU
    { wch: 20 }, // Barcode
    { wch: 20 }, // Category
    { wch: 12 }, // Cost Price
    { wch: 12 }, // Selling Price
    { wch: 15 }, // Stock Quantity
    { wch: 20 }, // Stock Tracking Enabled
    { wch: 15 }, // Unit
  ];

  XLSX.utils.book_append_sheet(wb, ws, "Products Template");
  
  // Write to buffer
  const buffer = XLSX.write(wb, { type: "array", bookType: "xlsx" });
  return buffer;
}
