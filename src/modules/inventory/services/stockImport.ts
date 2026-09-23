/**
 * Opening stock import from CSV.
 *
 * Parses a spreadsheet export (SKU + quantity columns) into a list of
 * stock adjustments ready for the inventory service. Used for initial
 * stock loading, warehouse counts, and periodic reconciliation.
 *
 * Pure functions — no I/O, no React, no Supabase.
 */

import { parseCsv, type ColumnMap } from "@/modules/products/services/excelImport";

// ── Types ───────────────────────────────────────────────────────────────────

export interface StockImportRow {
  /** 1-based row number in the CSV (header is row 0). */
  row: number;
  sku: string;
  barcode: string | null;
  quantity: number;
  /** Optional warehouse / location tag (stored in movement notes). */
  warehouse: string | null;
  notes: string | null;
}

export interface StockImportError {
  row: number;
  code: "missing_sku" | "invalid_quantity" | "negative_quantity" | "duplicate_sku";
  message: string;
  raw?: Record<string, string>;
}

export interface StockImportResult {
  totalRows: number;
  validRows: StockImportRow[];
  invalidRows: StockImportError[];
  headers: string[];
  columnMap: ColumnMap;
  globalErrors: string[];
}

// ── Stock-specific column aliases ───────────────────────────────────────────

const STOCK_HEADER_ALIASES: Record<string, string[]> = {
  sku: ["sku", "code", "كود", "رمز"],
  barcode: ["barcode", "باركود", "الباركود"],
  quantity: [
    "quantity", "qty", "stock", "count", "opening stock", "opening qty",
    "الكمية", "المخزون", "مخزون افتتاحي", "الكمية الافتتاحية",
  ],
  warehouse: [
    "warehouse", "location", "branch", "store",
    "المستودع", "الموقع", "الفرع", "المخزن",
  ],
  notes: ["notes", "note", "remarks", "ملاحظات"],
};

function buildStockColumnMap(headers: string[]): ColumnMap {
  const map: ColumnMap = {};
  for (let i = 0; i < headers.length; i++) {
    const header = headers[i].trim().toLowerCase();
    if (!header) continue;
    for (const [field, aliases] of Object.entries(STOCK_HEADER_ALIASES)) {
      if (aliases.includes(header) && !Object.values(map).includes(field as any)) {
        map[String(i)] = field as any;
        break;
      }
    }
  }
  return map;
}

// ── Parsing ─────────────────────────────────────────────────────────────────

function parseNumber(raw: string): number {
  if (!raw.trim()) return NaN;
  const cleaned = raw.replace(/[^\d.,-]/g, "").replace(/,/g, ".");
  const normalized =
    cleaned.indexOf(".") !== cleaned.lastIndexOf(".")
      ? cleaned.replace(/\./g, "").replace(",", ".")
      : cleaned;
  const value = Number(normalized);
  return Number.isFinite(value) ? value : NaN;
}

function parseStockRow(
  cells: string[],
  columnMap: ColumnMap,
  rowIndex: number,
): { data: StockImportRow | null; error: StockImportError | null } {
  const getField = (field: string): string => {
    const colIndex = Object.entries(columnMap).find(([, f]) => f === field)?.[0];
    if (colIndex === undefined) return "";
    return (cells[Number(colIndex)] ?? "").trim();
  };

  const sku = getField("sku");
  const barcode = getField("barcode") || null;
  const qtyRaw = getField("quantity");
  const warehouse = getField("warehouse") || null;
  const notes = getField("notes") || null;

  if (!sku) {
    return {
      data: null,
      error: { row: rowIndex, code: "missing_sku", message: "SKU is required" },
    };
  }

  if (!qtyRaw) {
    return {
      data: null,
      error: {
        row: rowIndex,
        code: "invalid_quantity",
        message: "Quantity is required",
        raw: { sku },
      },
    };
  }

  const quantity = parseNumber(qtyRaw);
  if (Number.isNaN(quantity)) {
    return {
      data: null,
      error: {
        row: rowIndex,
        code: "invalid_quantity",
        message: `Invalid quantity: "${qtyRaw}"`,
        raw: { sku },
      },
    };
  }

  if (quantity < 0) {
    return {
      data: null,
      error: {
        row: rowIndex,
        code: "negative_quantity",
        message: "Quantity cannot be negative",
        raw: { sku },
      },
    };
  }

  return {
    data: {
      row: rowIndex,
      sku,
      barcode,
      quantity: Math.round(quantity),
      warehouse,
      notes,
    },
    error: null,
  };
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Parse a CSV file into validated stock import rows.
 *
 * Expected columns (auto-detected):
 *   SKU | Quantity
 *
 * Optional columns:
 *   Barcode | Warehouse | Notes
 *
 * Usage:
 *   const text = await file.text();
 *   const result = importOpeningStock(text);
 *   // result.validRows → ready for adjustStock() with type "adjustment_in", reason "recount"
 */
export function importOpeningStock(csvText: string): StockImportResult {
  const globalErrors: string[] = [];
  const rows = parseCsv(csvText);

  if (rows.length === 0) {
    return {
      totalRows: 0,
      validRows: [],
      invalidRows: [],
      headers: [],
      columnMap: {},
      globalErrors: ["The file is empty."],
    };
  }

  const headers = rows[0];
  const columnMap = buildStockColumnMap(headers);

  // Check that at least SKU and quantity can be mapped
  const mappedFields = Object.values(columnMap);
  if (!mappedFields.includes("sku" as any)) {
    globalErrors.push("Could not detect a SKU column. Expected header: SKU, Code, or كود.");
  }
  if (!mappedFields.includes("quantity" as any)) {
    globalErrors.push(
      "Could not detect a Quantity column. Expected header: Quantity, Qty, Stock, or الكمية.",
    );
  }

  const dataRows = rows.slice(1);
  const validRows: StockImportRow[] = [];
  const invalidRows: StockImportError[] = [];
  const seenSkus = new Map<string, number>();

  for (let i = 0; i < dataRows.length; i++) {
    // Skip completely empty rows
    if (dataRows[i].every((cell) => !cell.trim())) continue;

    const { data, error } = parseStockRow(dataRows[i], columnMap, i + 1);

    if (error) {
      invalidRows.push(error);
      continue;
    }

    if (data) {
      // Check duplicate SKUs
      const skuLower = data.sku.toLowerCase();
      const prev = seenSkus.get(skuLower);
      if (prev !== undefined) {
        invalidRows.push({
          row: data.row,
          code: "duplicate_sku",
          message: `Duplicate SKU "${data.sku}" (also in row ${prev})`,
        });
        continue;
      }
      seenSkus.set(skuLower, data.row);
      validRows.push(data);
    }
  }

  return {
    totalRows: dataRows.filter((r) => r.some((c) => c.trim())).length,
    validRows,
    invalidRows,
    headers,
    columnMap,
    globalErrors,
  };
}

/**
 * Match imported stock rows to existing products by SKU.
 * Returns matched rows (ready for adjustStock) and unmatched SKUs.
 */
export function matchStockToProducts(
  rows: StockImportRow[],
  products: { sku: string; id: string; stock_quantity: number; stock_tracking_enabled: boolean }[],
): {
  matched: { row: StockImportRow; productId: string; currentStock: number; delta: number }[];
  unmatched: StockImportRow[];
  skippedUntracked: StockImportRow[];
} {
  const bySku = new Map<string, (typeof products)[0]>();
  for (const p of products) {
    bySku.set(p.sku.trim().toLowerCase(), p);
  }

  const matched: { row: StockImportRow; productId: string; currentStock: number; delta: number }[] = [];
  const unmatched: StockImportRow[] = [];
  const skippedUntracked: StockImportRow[] = [];

  for (const row of rows) {
    const product = bySku.get(row.sku.trim().toLowerCase());
    if (!product) {
      unmatched.push(row);
      continue;
    }
    if (!product.stock_tracking_enabled) {
      skippedUntracked.push(row);
      continue;
    }
    const delta = row.quantity - product.stock_quantity;
    matched.push({
      row,
      productId: product.id,
      currentStock: product.stock_quantity,
      delta,
    });
  }

  return { matched, unmatched, skippedUntracked };
}
