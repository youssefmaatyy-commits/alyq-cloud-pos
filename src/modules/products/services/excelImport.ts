/**
 * Product import from CSV (Excel/Google Sheets export).
 *
 * Foundation layer: parses a CSV file, maps columns to product fields, and
 * validates each row. The caller (UI) handles the actual creation via the
 * catalog repository. No external dependencies — the CSV parser handles
 * quoted fields, embedded commas, newlines and escaped quotes per RFC 4180.
 *
 * Pure functions, fully unit-testable without React or Supabase.
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
  | "product_type"
  | "category_name";

/** Map from CSV header text (lowercased, trimmed) → product field. */
export type ColumnMap = Record<string, ImportableField>;

/** Default header aliases — covers English, Arabic and common variants. */
const HEADER_ALIASES: Record<ImportableField, string[]> = {
  sku: ["sku", "code", "كود", "رمز"],
  barcode: ["barcode", "باركود", "الباركود"],
  name_ar: ["name_ar", "name ar", "namear", "الاسم", "اسم عربي", "name arabic"],
  name_en: ["name_en", "name en", "nameen", "name", "اسم انجليزي", "name english", "product"],
  description_ar: ["description_ar", "description ar", "الوصف", "وصف عربي"],
  description_en: ["description_en", "description en", "description", "وصف انجليزي"],
  selling_price: ["selling_price", "price", "السعر", "سعر البيع", "selling price"],
  cost_price: ["cost_price", "cost", "التكلفة", "سعر التكلفة", "cost price"],
  tax_rate: ["tax_rate", "tax", "الضريبة", "نسبة الضريبة", "tax rate", "vat"],
  stock_quantity: ["stock_quantity", "stock", "qty", "quantity", "الكمية", "المخزون", "stock quantity"],
  low_stock_level: ["low_stock_level", "low stock", "low_stock", "الحد الأدنى", "حد المخزون"],
  product_type: ["product_type", "type", "النوع", "نوع المنتج"],
  category_name: ["category", "category_name", "التصنيف", "الفئة"],
};

/** Build a column map from a header row by matching against known aliases. */
export function buildColumnMap(headers: string[]): ColumnMap {
  const map: ColumnMap = {};
  for (let i = 0; i < headers.length; i++) {
    const header = headers[i].trim().toLowerCase();
    if (!header) continue;
    for (const [field, aliases] of Object.entries(HEADER_ALIASES) as [ImportableField, string[]][]) {
      if (aliases.includes(header) && !Object.values(map).includes(field)) {
        map[String(i)] = field;
        break;
      }
    }
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

function parseNumber(raw: string): number {
  if (!raw.trim()) return NaN;
  const cleaned = raw.replace(/[^\d.,-]/g, "").replace(/,/g, ".");
  const normalized =
    cleaned.indexOf(".") !== cleaned.lastIndexOf(".")
      ? cleaned.replace(/\./g, "").replace(",", ".") // European: 1.234,56
      : cleaned;
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
  const typeRaw = getField("product_type");
  const categoryName = getField("category_name") || undefined;

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
      stock_tracking_enabled: stockQuantity > 0 || !!stockRaw,
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
 * Parse a CSV file into validated product rows.
 *
 * Usage:
 *   const text = await file.text();
 *   const result = importProductsFromCsv(text);
 *   // result.validRows → ready for createProduct()
 *   // result.invalidRows → show to user for correction
 */
export function importProductsFromCsv(csvText: string): ImportResult {
  const globalErrors: string[] = [];
  const rows = parseCsv(csvText);

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
 * Import products from a File object (Excel or CSV).
 */
export async function importProductsFromFile(file: File): Promise<ImportResult> {
  const text = await file.text();
  return importProductsFromCsv(text);
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
