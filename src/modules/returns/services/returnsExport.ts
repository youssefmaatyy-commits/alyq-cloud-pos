/**
 * Returns & refunds export — the Returns screen's own file.
 *
 * The Returns and Refunds sheets are the *same definitions* the financial report
 * writes (`returnsSheetOf` / `refundsSheetOf` in the reports module), so a
 * standalone export and the report can never disagree about a column, a label or
 * a total. On top of those two this adds the line-level detail the report leaves
 * out: one row per returned item, with the product, quantity and line total.
 *
 * Rows are whatever the screen is showing — the search box applies, so an
 * operator filtering to one invoice exports that invoice's returns only.
 */
import {
  buildSheets,
  toDate,
  type BuiltSheet,
  type ExportSheet,
  type PickBilingual,
  type Translate,
} from "@/lib/export";
import {
  refundsSheetOf,
  returnsSheetOf,
} from "@/modules/reports/services/financialExport";

import type { RefundRecord, ReturnItem, SalesReturn } from "../types";

export interface ReturnsExportInput {
  /** Already filtered by the screen. */
  returnsList: readonly SalesReturn[];
  /** Already filtered by the screen. */
  refundsList: readonly RefundRecord[];
  t: Translate;
  pick: PickBilingual;
}

/** A returned line, kept next to the return it belongs to. */
interface ReturnedItemRow {
  ret: SalesReturn;
  item: ReturnItem;
}

const money = (value: number) => Math.round(value * 100) / 100;

/** Returns + refunds + the items behind them, in that order. */
export function buildReturnsSheets(input: ReturnsExportInput): BuiltSheet[] {
  const { t, pick, returnsList, refundsList } = input;

  const itemRows: ReturnedItemRow[] = returnsList.flatMap((ret) =>
    ret.items.map((item) => ({ ret, item })),
  );

  const items: ExportSheet<ReturnedItemRow> = {
    name: t("export.sheet.returnedItems"),
    rows: itemRows,
    columns: [
      { header: t("export.col.returnNumber"), value: (r) => r.ret.return_number, width: 16 },
      {
        header: t("export.col.dateTime"),
        value: (r) => toDate(r.ret.created_at),
        kind: "datetime",
      },
      { header: t("export.col.invoiceNumber"), value: (r) => r.ret.sale_number, width: 16 },
      { header: t("export.col.customer"), value: (r) => r.ret.customer_name ?? "", width: 24 },
      {
        header: t("export.col.product"),
        value: (r) => pick(r.item.name_ar, r.item.name_en),
        width: 30,
      },
      { header: t("export.col.sku"), value: (r) => r.item.sku, width: 16 },
      { header: t("export.col.barcode"), value: (r) => r.item.barcode ?? "", width: 18 },
      { header: t("export.col.quantity"), value: (r) => r.item.quantity, kind: "number", width: 10 },
      { header: t("export.col.unitPrice"), value: (r) => r.item.unit_price, kind: "money" },
      { header: t("export.col.lineTotal"), value: (r) => r.item.line_total, kind: "money" },
      { header: t("export.col.reason"), value: (r) => r.ret.reason, width: 28 },
      {
        header: t("export.col.refundStatus"),
        value: (r) => t(`pos.status.${r.ret.refund_status}` as never),
        width: 14,
      },
    ],
    totals: [
      t("export.totalRow"),
      null,
      "",
      "",
      "",
      "",
      "",
      itemRows.reduce((acc, r) => acc + r.item.quantity, 0),
      null,
      money(itemRows.reduce((acc, r) => acc + r.item.line_total, 0)),
      "",
      "",
    ],
    notes: [t("export.note.returnedItems"), `${t("export.col.lineTotal")}: ${itemRows.length}`],
  };

  return buildSheets([returnsSheetOf(returnsList, t), refundsSheetOf(refundsList, t), items]);
}
