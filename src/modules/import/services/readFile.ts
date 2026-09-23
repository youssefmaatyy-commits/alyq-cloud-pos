/**
 * Turn a CSV or workbook into a table, using the same size and row limits as
 * the existing product importer. The first sheet only — a second sheet is not
 * silently chosen because its headers look like products.
 */
import { AppError } from "@/modules/products/data/repository";
import {
  IMPORT_LIMITS,
  assertImportableFile,
  looksLikeWorkbook,
  parseCsv,
} from "@/modules/products/services/excelImport";

export async function readImportTable(file: File): Promise<{ headers: string[]; rows: string[][]; sheetCount: number }> {
  assertImportableFile(file);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const table = looksLikeWorkbook(bytes) ? await readFirstSheet(bytes) : readText(bytes);
  if (table.rows.some((row) => row.length > IMPORT_LIMITS.maxColumns)) {
    throw new AppError("IMPORT_FILE_UNSUPPORTED", `a row has more than ${IMPORT_LIMITS.maxColumns} columns`);
  }
  return table;
}

function readText(bytes: Uint8Array): { headers: string[]; rows: string[][]; sheetCount: number } {
  if (bytes.subarray(0, 8192).includes(0)) {
    throw new AppError("IMPORT_FILE_UNSUPPORTED", "the file is binary but not an Excel workbook");
  }
  const parsed = parseCsv(new TextDecoder("utf-8").decode(bytes));
  if (parsed.length > IMPORT_LIMITS.maxRows) {
    throw new AppError("IMPORT_TOO_MANY_ROWS", `${parsed.length} rows; the limit is ${IMPORT_LIMITS.maxRows}`);
  }
  return { headers: parsed[0] ?? [], rows: parsed.slice(1), sheetCount: 1 };
}

async function readFirstSheet(bytes: Uint8Array): Promise<{ headers: string[]; rows: string[][]; sheetCount: number }> {
  const XLSX = await import("xlsx");
  const workbook = XLSX.read(bytes, { type: "array", cellDates: true, sheetRows: IMPORT_LIMITS.maxRows + 1 });
  const sheets = workbook.SheetNames.map((name) =>
    XLSX.utils
      .sheet_to_json<unknown[]>(workbook.Sheets[name], { header: 1, raw: true, defval: "", blankrows: false })
      .map((row) => row.slice(0, IMPORT_LIMITS.maxColumns).map(cellToText)),
  ).filter((rows) => rows.length > 0);
  if (sheets.length === 0) return { headers: [], rows: [], sheetCount: 0 };
  const rows = sheets[0];
  if (rows.length > IMPORT_LIMITS.maxRows) {
    throw new AppError("IMPORT_TOO_MANY_ROWS", `${rows.length} rows; the limit is ${IMPORT_LIMITS.maxRows}`);
  }
  return { headers: rows[0] ?? [], rows: rows.slice(1), sheetCount: sheets.length };
}

function cellToText(value: unknown): string {
  if (value == null) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value);
}
