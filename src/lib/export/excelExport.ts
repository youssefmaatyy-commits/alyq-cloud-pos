/**
 * Excel export plumbing shared by every module.
 *
 * Two layers, deliberately split:
 *
 *   1. **pure** — `buildSheet` turns a typed `ExportSheet<T>` (columns + rows +
 *      a value selector per column) into a `BuiltSheet`: plain arrays, no
 *      dependency on `xlsx`, no DOM. Every export in the app is asserted
 *      against this shape in `*.selftest.ts`.
 *   2. **effectful** — `downloadWorkbook` takes the built sheets, dynamically
 *      imports `xlsx`, applies number formats and writes the file to the
 *      browser. The dynamic import matters: `xlsx` is ~900 kB and must not land
 *      in the startup bundle (the import feature already does exactly this in
 *      `src/modules/products/services/excelImport.ts`).
 *
 * Design rules the whole feature follows:
 *
 *   - **Money stays numeric.** Amounts are written as numbers carrying an
 *     Excel number format (`#,##0.00 "EGP"`), never as pre-formatted strings,
 *     so accountants can sum/pivot them. EGP formatting is preserved visually.
 *   - **Dates stay dates.** Real Excel date cells (`yyyy-mm-dd hh:mm`), so
 *     filtering and sorting work.
 *   - **Headers follow the app language.** Callers pass `t`, exactly like the
 *     receipt builders receive a strings object; the sheet contents are
 *     bilingual-safe because the *data* keeps both `name_ar` and `name_en`.
 *   - **Exports never write.** Read-only over data the providers already hold;
 *     no repository, no migration, no new capability, no audit entry.
 */
import type { I18nContextValue } from "@/lib/i18n/I18nProvider";

/** The dictionary translate function, typed identically to `useI18n().t`. */
export type Translate = I18nContextValue["t"];

/** The bilingual field picker, typed identically to `useI18n().pick`. */
export type PickBilingual = I18nContextValue["pick"];

/** How a column's cells are written and formatted. */
export type ExportCellKind = "text" | "number" | "money" | "date" | "datetime" | "percent";

export type ExportCellValue = string | number | boolean | Date | null | undefined;

export interface ExportColumn<T> {
  /** Header text, already translated by the caller. */
  header: string;
  /**
   * Selector for one cell. `null`/`undefined` render as an empty cell.
   *
   * Declared with method syntax on purpose: that gives the parameter bivariant
   * checking, so a workbook can mix `ExportSheet<Sale>` with
   * `ExportSheet<Expense>` in one `ExportSheet<unknown>[]`. With property-style
   * `value:` the strict contravariance check rejects that.
   */
  value(row: T): ExportCellValue;
  kind?: ExportCellKind;
  /** Character width. Defaults per kind when omitted. */
  width?: number;
}

export interface ExportSheet<T> {
  /** Worksheet tab name — sanitized and de-duplicated by `buildSheet`. */
  name: string;
  columns: ExportColumn<T>[];
  rows: readonly T[];
  /**
   * Optional totals row written immediately under the data, outside the
   * autofilter range. `cell.s` is set for style-aware writers; the community
   * SheetJS build ignores it, so the row reads as a total by its label.
   */
  totals?: readonly ExportCellValue[];
  /** Optional footnotes written after a blank row (derived-column caveats). */
  notes?: readonly string[];
}

/** A sheet reduced to plain data — the unit every test asserts on. */
export interface BuiltSheet {
  name: string;
  header: string[];
  rows: ExportCellValue[][];
  kinds: ExportCellKind[];
  widths: number[];
  totals: ExportCellValue[] | null;
  notes: string[];
  /** Count of data rows, so callers can report "N rows exported". */
  rowCount: number;
}

export interface ExportDocument {
  /** Base file name, no extension — a timestamp is appended. */
  name: string;
  sheets: BuiltSheet[];
  /** Written into every money cell's number format. */
  currency?: string;
  /** `ar` flips the workbook to right-to-left sheet views. */
  lang?: "en" | "ar";
}

export interface ExportResult {
  filename: string;
  sheets: { name: string; rows: number }[];
  totalRows: number;
}

/** Excel forbids these in tab names and caps them at 31 characters. */
const INVALID_SHEET_CHARS = /[[\]:*?/\\]/g;
const SHEET_NAME_MAX = 31;

const DEFAULT_WIDTH: Record<ExportCellKind, number> = {
  text: 22,
  number: 12,
  money: 16,
  date: 14,
  datetime: 20,
  percent: 10,
};

/** Number format per kind. `{{CUR}}` is replaced with the currency code. */
const NUMBER_FORMAT: Record<ExportCellKind, string | null> = {
  text: null,
  number: "#,##0.##",
  money: '#,##0.00 "{{CUR}}"',
  date: "yyyy-mm-dd",
  datetime: "yyyy-mm-dd hh:mm",
  percent: '0.0"%"',
};

/** The currency every money column is formatted with (defaults to EGP). */
export function exportCurrency(): string {
  const raw = (import.meta.env.VITE_CURRENCY || "EGP") as string;
  return raw.trim().toUpperCase() || "EGP";
}

/** Excel number format for a money cell in the given currency. */
export function moneyFormat(currency: string = exportCurrency()): string {
  return (NUMBER_FORMAT.money as string).replace("{{CUR}}", currency);
}

/** The number format for a column kind, or `null` when Excel's default is right. */
export function formatFor(kind: ExportCellKind, currency: string = exportCurrency()): string | null {
  const format = NUMBER_FORMAT[kind];
  return format ? format.replace("{{CUR}}", currency) : null;
}

/** A tab name Excel will accept: no `[]:*?/\`, at most 31 characters. */
export function sanitizeSheetName(name: string): string {
  const cleaned = name.replace(INVALID_SHEET_CHARS, " ").replace(/\s+/g, " ").trim();
  if (cleaned === "") return "Sheet";
  return cleaned.slice(0, SHEET_NAME_MAX).trim() || "Sheet";
}

/** Make tab names unique — Excel rejects duplicates outright. */
export function uniqueSheetNames(names: readonly string[]): string[] {
  const used = new Map<string, number>();
  return names.map((raw) => {
    const base = sanitizeSheetName(raw);
    const seen = used.get(base.toLowerCase()) ?? 0;
    used.set(base.toLowerCase(), seen + 1);
    if (seen === 0) return base;
    const suffix = ` (${seen + 1})`;
    return `${base.slice(0, SHEET_NAME_MAX - suffix.length)}${suffix}`;
  });
}

/**
 * Reduce a typed sheet to plain data.
 *
 * Pure and side-effect free: no `xlsx`, no DOM, no clock. This is the function
 * the selftests exercise, so a broken export is caught without a browser.
 */
export function buildSheet<T>(sheet: ExportSheet<T>): BuiltSheet {
  const kinds = sheet.columns.map((column) => column.kind ?? "text");
  const widths = sheet.columns.map((column, index) => column.width ?? DEFAULT_WIDTH[kinds[index]]);

  const rows = sheet.rows.map((row) =>
    sheet.columns.map((column) => normalizeCell(column.value(row), column.kind ?? "text")),
  );

  return {
    name: sheet.name,
    header: sheet.columns.map((column) => column.header),
    rows,
    kinds,
    widths,
    totals: sheet.totals ? [...sheet.totals] : null,
    notes: sheet.notes ? [...sheet.notes] : [],
    rowCount: rows.length,
  };
}

/**
 * Build several sheets and give them Excel-legal, unique tab names.
 *
 * Accepts a heterogeneous array — the financial workbook mixes sales, expenses,
 * refunds and shifts — which is why `ExportColumn.value` uses method syntax.
 */
export function buildSheets(sheets: readonly ExportSheet<unknown>[]): BuiltSheet[] {
  const built = sheets.map((sheet) => buildSheet(sheet));
  const names = uniqueSheetNames(built.map((sheet) => sheet.name));
  return built.map((sheet, index) => ({ ...sheet, name: names[index] }));
}

/** Booleans become Yes/No-free plain values; dates stay Date objects. */
function normalizeCell(value: ExportCellValue, kind: ExportCellKind): ExportCellValue {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? "" : value;
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (typeof value === "number") return Number.isFinite(value) ? roundFor(kind, value) : "";
  return value;
}

/** Money is stored to 2 decimals, percentages to 1 — matching their formats. */
function roundFor(kind: ExportCellKind, value: number): number {
  if (kind === "money") return Math.round(value * 100) / 100;
  if (kind === "percent") return Math.round(value * 10) / 10;
  return value;
}

/** `alyq-sales-2026-09-12-1430.xlsx` — sortable, collision-resistant. */
export function exportFileName(base: string, when: Date = new Date()): string {
  const slug = base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}-${pad(
    when.getHours(),
  )}${pad(when.getMinutes())}`;
  return `alyq-${slug || "export"}-${stamp}.xlsx`;
}

/** True when a string looks like an ISO timestamp the app stores. */
export function toDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** Inclusive date-range test over an ISO timestamp, used by the reports. */
export function withinDateRange(
  value: string | null | undefined,
  from: string | null,
  to: string | null,
): boolean {
  if (!from && !to) return true;
  const date = toDate(value);
  if (!date) return false;
  const time = date.getTime();
  if (from) {
    const start = new Date(`${from}T00:00:00`);
    if (!Number.isNaN(start.getTime()) && time < start.getTime()) return false;
  }
  if (to) {
    // `to` is a calendar day, so it includes everything up to its midnight end.
    const end = new Date(`${to}T23:59:59.999`);
    if (!Number.isNaN(end.getTime()) && time > end.getTime()) return false;
  }
  return true;
}

/**
 * Write the workbook and hand it to the browser as a download.
 *
 * The only effectful step in the feature; everything upstream is pure.
 */
export async function downloadWorkbook(document: ExportDocument): Promise<ExportResult> {
  const XLSX = await import("xlsx");
  const currency = document.currency ?? exportCurrency();

  const wb = XLSX.utils.book_new();
  if (document.lang === "ar") {
    // SheetJS reads this to open the workbook in right-to-left view.
    (wb as unknown as { Workbook?: { Views?: { RTL?: boolean }[] } }).Workbook = {
      Views: [{ RTL: true }],
    };
  }

  const summary: { name: string; rows: number }[] = [];

  for (const sheet of document.sheets) {
    // The totals row has to be part of the sheet data, not just styled: writing
    // it separately left `ws[ref]` undefined and the row silently missing.
    //
    // The footnotes belong in the array for the same reason, one level deeper:
    // `XLSX.write` only serialises cells inside the declared `!ref`, so cells
    // poked in past the end of the data are dropped without a word. Building the
    // whole grid first keeps every row inside the range — blank separator
    // included — while the autofilter below still stops at the last data row.
    const aoa: ExportCellValue[][] = [
      sheet.header,
      ...sheet.rows,
      ...(sheet.totals ? [[...sheet.totals]] : []),
    ];
    if (sheet.notes.length > 0) {
      aoa.push([]);
      for (const note of sheet.notes) aoa.push([note]);
    }
    const ws = XLSX.utils.aoa_to_sheet(aoa, { cellDates: true });

    const headerRowIndex = 0;
    const firstDataRow = 1;
    const lastDataRow = sheet.rows.length; // inclusive, 0-based
    const totalsRowIndex = sheet.totals ? lastDataRow + 1 : null;

    // Per-column number formats (money/date/percent) — the cells already hold
    // real numbers and Dates, so Excel can still compute over them.
    for (let c = 0; c < sheet.kinds.length; c += 1) {
      const format = formatFor(sheet.kinds[c], currency);
      if (!format) continue;
      for (let r = firstDataRow; r <= (totalsRowIndex ?? lastDataRow); r += 1) {
        const ref = XLSX.utils.encode_cell({ r, c });
        const cell = ws[ref];
        if (cell && (cell.t === "n" || cell.t === "d")) cell.z = format;
      }
    }

    if (sheet.totals && totalsRowIndex !== null) {
      for (let c = 0; c < sheet.totals.length; c += 1) {
        const ref = XLSX.utils.encode_cell({ r: totalsRowIndex, c });
        const cell = ws[ref];
        if (cell) cell.s = { font: { bold: true } };
      }
    }

    ws["!cols"] = sheet.widths.map((wch) => ({ wch }));
    if (sheet.rows.length > 0) {
      const lastCol = XLSX.utils.encode_col(Math.max(0, sheet.header.length - 1));
      ws["!autofilter"] = { ref: `A${headerRowIndex + 1}:${lastCol}${lastDataRow + 1}` };
    }

    XLSX.utils.book_append_sheet(wb, ws, sheet.name);
    summary.push({ name: sheet.name, rows: sheet.rowCount });
  }

  const filename = exportFileName(document.name);
  const buffer = XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
  triggerDownload(buffer, filename);

  return {
    filename,
    sheets: summary,
    totalRows: summary.reduce((sum, s) => sum + s.rows, 0),
  };
}

/** Blob → object URL → click, mirroring the existing template download. */
function triggerDownload(buffer: ArrayBuffer, filename: string): void {
  const blob = new Blob([buffer], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
