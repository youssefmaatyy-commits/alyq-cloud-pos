/**
 * Cost, COGS, profit and margin leave a workbook only when the caller says so.
 *
 * Builders default to showing those columns — the same numbers the tests pin —
 * and the screen passes `maySeeCost: canAct("view_cost")`. Dropping a column
 * drops the total at the same index. `excelExport` writes totals by position,
 * so filtering the header and leaving the total would print a cost under a
 * quantity heading.
 */
import type { BuiltSheet, Translate } from "@/lib/export/excelExport";

const HIDDEN_KEYS = [
  "export.metric.cogs",
  "export.metric.grossProfit",
  "export.metric.netProfit",
  "export.col.profit",
  "export.col.margin",
  "export.col.unitCost",
  "export.col.costPrice",
  "export.col.stockValue",
  "export.col.tiedUp",
  "export.col.potentialMargin",
  "export.note.lossMakers",
] as const;

const HIDDEN_NOTES = ["export.note.profit", "export.note.costIsCurrent", "export.note.stockValue"] as const;

export function withoutSensitiveMoney(sheets: readonly BuiltSheet[], t: Translate): BuiltSheet[] {
  const hidden = new Set<string>(HIDDEN_KEYS.map((key) => t(key)));
  const hiddenNotes = new Set<string>(HIDDEN_NOTES.map((key) => t(key)));
  const stockSheet = t("export.sheet.stockValue");
  const metricHeader = t("export.col.metric");

  return sheets
    .filter((sheet) => sheet.name !== stockSheet)
    .map((sheet) => {
      const dropColumn = sheet.header.map((header) => hidden.has(header));
      const notes = sheet.notes.filter((note) => !hiddenNotes.has(note));
      if (!dropColumn.some(Boolean)) {
        const rows =
          sheet.header[0] === metricHeader
            ? sheet.rows.filter((row) => !hidden.has(String(row[0] ?? "")))
            : sheet.rows;
        return { ...sheet, rows, notes, rowCount: rows.length };
      }
      const keep = (index: number) => !dropColumn[index];
      const totals = sheet.totals
        ? sheet.header.map((_, index) => sheet.totals?.[index] ?? null).filter((_, index) => keep(index))
        : null;
      return {
        ...sheet,
        header: sheet.header.filter((_, index) => keep(index)),
        kinds: sheet.kinds.filter((_, index) => keep(index)),
        widths: sheet.widths.filter((_, index) => keep(index)),
        rows: sheet.rows.map((row) => row.filter((_, index) => keep(index))),
        totals,
        notes,
      };
    });
}
