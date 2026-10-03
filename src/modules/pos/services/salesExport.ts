/**
 * Sales export — invoices and their line items.
 *
 * Two sheets, because the requested fields live at two different grains:
 *
 *   **Invoices**       one row per sale — number, date/time, customer,
 *                      discount, payment method, total and the
 *                      cash / card / InstaPay breakdown.
 *   **Invoice items**  one row per line — product, quantity, unit price,
 *                      line total, keyed by invoice number so the two sheets
 *                      pivot against each other.
 *
 * Money columns are real numbers carrying an EGP number format, so the file
 * opens ready to sum. Voided invoices are exported and labelled (they are part
 * of the audit trail) but are excluded from the totals row — summing them would
 * overstate revenue.
 *
 * Pure: no `xlsx`, no DOM, no repository. The caller passes whatever it is
 * showing, so `SalesHistoryPage`'s search/status/method filters are honoured.
 */
import {
  buildSheets,
  toDate,
  type BuiltSheet,
  type ExportSheet,
  type PickBilingual,
  type Translate,
} from "@/lib/export";
import type { PaymentMethod, Sale, SaleItem } from "../types";

/** Per-method money for one sale, plus what is actually settled. */
export interface SalePaymentTotals extends Record<PaymentMethod, number> {
  /** Sum of payments whose status is `paid`. */
  paid: number;
  /** Sum of payments still awaiting confirmation. */
  pending: number;
}

const ZERO_TOTALS = (): SalePaymentTotals => ({
  cash: 0,
  visa: 0,
  instapay: 0,
  // Website orders an employee approved: the money is collected on delivery, so
  // it belongs in its own column rather than being counted as till cash.
  cod: 0,
  paid: 0,
  pending: 0,
});

/**
 * Split a sale's money across payment methods.
 *
 * `sale.payments` is authoritative (it carries split payments). Legacy rows
 * without a payments array fall back to the convenience `payment_method` +
 * `total` pair so old data still exports sensibly.
 */
export function paymentTotals(sale: Sale): SalePaymentTotals {
  const totals = ZERO_TOTALS();

  if (sale.payments.length === 0) {
    const method: PaymentMethod = sale.payment_method ?? "cash";
    totals[method] += sale.total;
    if (sale.payment_status === "paid") totals.paid += sale.total;
    else totals.pending += sale.total;
    return totals;
  }

  for (const payment of sale.payments) {
    totals[payment.method] += payment.amount;
    if (payment.status === "paid") totals.paid += payment.amount;
    else totals.pending += payment.amount;
  }
  return totals;
}

/** Quantity across every line of a sale. */
export function totalQuantity(sale: Sale): number {
  return sale.items.reduce((sum, item) => sum + item.quantity, 0);
}

/** Money still owed on a sale (0 once every payment is settled). */
export function remainingOf(sale: Sale): number {
  return Math.round((sale.total - paymentTotals(sale).paid) * 100) / 100;
}

export interface SalesExportInput {
  /** The sales to export — already filtered/searched by the caller. */
  sales: readonly Sale[];
  t: Translate;
  pick: PickBilingual;
}

/** One invoice row plus its pre-computed payment split. */
interface InvoiceRow {
  sale: Sale;
  payments: SalePaymentTotals;
}

/** One line item, flattened with its parent invoice's identity. */
interface ItemRow {
  sale: Sale;
  item: SaleItem;
}

export function buildSalesSheets({ sales, t, pick }: SalesExportInput): BuiltSheet[] {
  const invoiceRows: InvoiceRow[] = sales.map((sale) => ({ sale, payments: paymentTotals(sale) }));

  const itemRows: ItemRow[] = [];
  for (const sale of sales) {
    for (const item of sale.items) itemRows.push({ sale, item });
  }

  // Totals ignore voided invoices: a void is a reversal, not revenue.
  const live = invoiceRows.filter((row) => row.sale.status !== "voided");
  const sum = (select: (row: InvoiceRow) => number) =>
    Math.round(live.reduce((acc, row) => acc + select(row), 0) * 100) / 100;

  const statusLabel = (sale: Sale) => t(`pos.status.${sale.status}` as never);
  const discountLabel = (sale: Sale) => t(`pos.discountType.${sale.discount_type}` as never);
  const methodLabel = (method: PaymentMethod | null | undefined) =>
    method ? t(`pos.payment.${method}` as never) : "";

  const invoices: ExportSheet<InvoiceRow> = {
    name: t("export.sheet.invoices"),
    rows: invoiceRows,
    columns: [
      { header: t("export.col.invoiceNumber"), value: (r) => r.sale.sale_number, width: 16 },
      { header: t("export.col.dateTime"), value: (r) => toDate(r.sale.created_at), kind: "datetime" },
      { header: t("export.col.status"), value: (r) => statusLabel(r.sale), width: 12 },
      { header: t("export.col.customer"), value: (r) => r.sale.customer_name ?? "", width: 24 },
      { header: t("export.col.customerPhone"), value: (r) => r.sale.customer_phone ?? "", width: 16 },
      { header: t("export.col.cashier"), value: (r) => r.sale.user_name, width: 20 },
      { header: t("export.col.itemsCount"), value: (r) => r.sale.items.length, kind: "number", width: 10 },
      { header: t("export.col.quantity"), value: (r) => totalQuantity(r.sale), kind: "number", width: 12 },
      { header: t("export.col.subtotal"), value: (r) => r.sale.subtotal, kind: "money" },
      { header: t("export.col.discountType"), value: (r) => discountLabel(r.sale), width: 16 },
      { header: t("export.col.discountValue"), value: (r) => r.sale.discount_value, kind: "number", width: 14 },
      { header: t("export.col.discount"), value: (r) => r.sale.discount_amount, kind: "money" },
      { header: t("export.col.total"), value: (r) => r.sale.total, kind: "money" },
      { header: t("export.col.paymentMethod"), value: (r) => methodLabel(r.sale.payment_method), width: 16 },
      { header: t("export.col.cash"), value: (r) => r.payments.cash, kind: "money" },
      { header: t("export.col.card"), value: (r) => r.payments.visa, kind: "money" },
      { header: t("export.col.instapay"), value: (r) => r.payments.instapay, kind: "money" },
      { header: t("export.col.cod"), value: (r) => r.payments.cod, kind: "money" },
      { header: t("export.col.paid"), value: (r) => r.payments.paid, kind: "money" },
      { header: t("export.col.remaining"), value: (r) => r.payments.pending, kind: "money" },
      {
        header: t("export.col.paymentStatus"),
        value: (r) => t(`pos.status.${r.sale.payment_status}` as never),
        width: 14,
      },
      { header: t("export.col.voidReason"), value: (r) => r.sale.void_reason ?? "", width: 24 },
    ],
    totals: [
      t("export.totalRow"),
      null,
      "",
      "",
      "",
      "",
      null,
      sum((r) => totalQuantity(r.sale)),
      sum((r) => r.sale.subtotal),
      "",
      null,
      sum((r) => r.sale.discount_amount),
      sum((r) => r.sale.total),
      "",
      sum((r) => r.payments.cash),
      sum((r) => r.payments.visa),
      sum((r) => r.payments.instapay),
      sum((r) => r.payments.cod),
      sum((r) => r.payments.paid),
      sum((r) => r.payments.pending),
      "",
      "",
    ],
    notes: [
      t("export.note.totalsExcludeVoided"),
      t("export.note.paymentSplit"),
      `${t("export.col.invoiceNumber")}: ${invoiceRows.length}`,
    ],
  };

  const items: ExportSheet<ItemRow> = {
    name: t("export.sheet.invoiceItems"),
    rows: itemRows,
    columns: [
      { header: t("export.col.invoiceNumber"), value: (r) => r.sale.sale_number, width: 16 },
      { header: t("export.col.dateTime"), value: (r) => toDate(r.sale.created_at), kind: "datetime" },
      { header: t("export.col.status"), value: (r) => statusLabel(r.sale), width: 12 },
      { header: t("export.col.customer"), value: (r) => r.sale.customer_name ?? "", width: 24 },
      { header: t("export.col.product"), value: (r) => pick(r.item.name_ar, r.item.name_en), width: 30 },
      { header: t("export.col.nameAr"), value: (r) => r.item.name_ar, width: 28 },
      { header: t("export.col.nameEn"), value: (r) => r.item.name_en, width: 28 },
      { header: t("export.col.sku"), value: (r) => r.item.sku, width: 16 },
      { header: t("export.col.barcode"), value: (r) => r.item.barcode ?? "", width: 18 },
      { header: t("export.col.quantity"), value: (r) => r.item.quantity, kind: "number" },
      { header: t("export.col.unitPrice"), value: (r) => r.item.unit_price, kind: "money" },
      { header: t("export.col.lineTotal"), value: (r) => r.item.line_total, kind: "money" },
    ],
    totals: [
      t("export.totalRow"),
      null,
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      itemRows
        .filter((r) => r.sale.status !== "voided")
        .reduce((acc, r) => acc + r.item.quantity, 0),
      null,
      Math.round(
        itemRows
          .filter((r) => r.sale.status !== "voided")
          .reduce((acc, r) => acc + r.item.line_total, 0) * 100,
      ) / 100,
    ],
    notes: [t("export.note.totalsExcludeVoided"), `${t("export.col.lineTotal")}: ${itemRows.length}`],
  };

  return buildSheets([invoices, items]);
}

/**
 * Export exactly the authoritative, server-paginated rows visible in the
 * Invoice/Return Center. This summary deliberately does not pretend that the
 * provider's recent-sales cache contains every old invoice or line item.
 */
export function buildTransactionCenterSheets({
  rows,
  t,
}: {
  rows: readonly import("./transactionCenter").TransactionCenterRow[];
  t: Translate;
}): BuiltSheet[] {
  type Row = import("./transactionCenter").TransactionCenterRow;
  type LinkRow = { sale: Row; kind: "return" | "refund"; reference: string; status: string; amount: number; created_at: string };
  const live = rows.filter((row) => row.status !== "voided");
  const sum = (select: (row: Row) => number) => Math.round(live.reduce((total, row) => total + select(row), 0) * 100) / 100;
  const summary: ExportSheet<Row> = {
    name: t("export.sheet.invoices"),
    rows,
    columns: [
      { header: t("export.col.invoiceNumber"), value: (row) => row.sale_number, width: 18 },
      { header: t("pos.clientReference"), value: (row) => row.client_ref, width: 26 },
      { header: t("export.col.dateTime"), value: (row) => toDate(row.created_at), kind: "datetime" },
      { header: t("export.col.status"), value: (row) => t(`pos.status.${row.status}` as never), width: 14 },
      { header: t("export.col.paymentStatus"), value: (row) => t(`pos.status.${row.payment_status}` as never), width: 16 },
      { header: t("export.col.customer"), value: (row) => row.customer_name ?? "", width: 24 },
      { header: t("export.col.customerPhone"), value: (row) => row.customer_phone ?? "", width: 16 },
      { header: t("export.col.cashier"), value: (row) => row.cashier_name, width: 20 },
      { header: t("export.col.quantity"), value: (row) => row.item_count, kind: "number" },
      { header: t("export.col.paymentMethod"), value: (row) => row.payment_methods.map((method) => t(`pos.payment.${method}` as never)).join(" + "), width: 20 },
      { header: t("export.col.subtotal"), value: (row) => row.subtotal, kind: "money" },
      { header: t("export.col.discount"), value: (row) => row.discount_amount, kind: "money" },
      { header: t("export.col.total"), value: (row) => row.total, kind: "money" },
      { header: t("pos.refundCompletedTotal"), value: (row) => row.completed_refund_total, kind: "money" },
      { header: t("pos.refundPendingTotal"), value: (row) => row.pending_refund_total, kind: "money" },
    ],
    totals: [t("export.totalRow"), "", null, "", "", "", "", "", sum((row) => row.item_count), "", sum((row) => row.subtotal), sum((row) => row.discount_amount), sum((row) => row.total), sum((row) => row.completed_refund_total), sum((row) => row.pending_refund_total)],
    notes: [t("export.note.totalsExcludeVoided"), t("pos.serverSearchNotice")],
  };
  const links: LinkRow[] = rows.flatMap((sale) => [
    ...sale.returns.map((item) => ({ sale, kind: "return" as const, reference: item.reference, status: item.status, amount: item.amount, created_at: item.created_at })),
    ...sale.refunds.map((item) => ({ sale, kind: "refund" as const, reference: item.reference, status: item.status, amount: item.amount, created_at: item.created_at })),
  ]);
  const linkage: ExportSheet<LinkRow> = {
    name: t("returns.title"),
    rows: links,
    columns: [
      { header: t("export.col.invoiceNumber"), value: (row) => row.sale.sale_number, width: 18 },
      { header: t("export.col.type"), value: (row) => row.kind === "return" ? t("returns.title") : t("refunds.title"), width: 16 },
      { header: t("export.col.reference"), value: (row) => row.reference, width: 18 },
      { header: t("export.col.dateTime"), value: (row) => toDate(row.created_at), kind: "datetime" },
      { header: t("export.col.status"), value: (row) => t(`returns.status.${row.status}` as never), width: 16 },
      { header: t("returns.refundAmount"), value: (row) => row.amount, kind: "money" },
    ],
  };
  return buildSheets([summary, linkage]);
}
