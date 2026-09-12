/**
 * Customers export — the customer book plus each customer's purchase history.
 *
 * Two sheets:
 *   **Customers**        one row per customer — name, phone, address, balance
 *                        and lifetime purchase statistics.
 *   **Purchase history** one row per invoice a customer appears on, so the
 *                        history behind the summary columns is auditable.
 *
 * Two derived figures, both documented in the sheet notes because the schema
 * has no column for either:
 *
 *   - **Balance** — the unpaid portion of that customer's `pending` invoices
 *     (InstaPay awaiting confirmation). The app has no customer credit
 *     accounts, so there is no other meaning of "owed" to export.
 *   - **Total spent / purchases** — counted over non-voided invoices only; a
 *     void is a reversal, not a purchase.
 *
 * Pure: no `xlsx`, no DOM, no repository.
 */
import {
  buildSheets,
  toDate,
  type BuiltSheet,
  type ExportSheet,
  type Translate,
} from "@/lib/export";
import { paymentTotals, remainingOf } from "@/modules/pos/services/salesExport";
import type { Sale } from "@/modules/pos/types";
import type { Customer } from "../types";

export interface CustomerPurchaseStats {
  /** Non-voided invoices. */
  count: number;
  /** Sum of non-voided invoice totals. */
  totalSpent: number;
  /** Unpaid portion of pending invoices. */
  outstanding: number;
  /** ISO timestamp of the most recent non-voided invoice, if any. */
  lastPurchaseAt: string | null;
}

const EMPTY_STATS = (): CustomerPurchaseStats => ({
  count: 0,
  totalSpent: 0,
  outstanding: 0,
  lastPurchaseAt: null,
});

/** Aggregate every sale onto its customer, in one pass. */
export function customerPurchaseStats(sales: readonly Sale[]): Map<string, CustomerPurchaseStats> {
  const map = new Map<string, CustomerPurchaseStats>();

  for (const sale of sales) {
    if (!sale.customer_id) continue;
    const stats = map.get(sale.customer_id) ?? EMPTY_STATS();

    if (sale.status !== "voided") {
      stats.count += 1;
      stats.totalSpent = Math.round((stats.totalSpent + sale.total) * 100) / 100;
      if (!stats.lastPurchaseAt || sale.created_at > stats.lastPurchaseAt) {
        stats.lastPurchaseAt = sale.created_at;
      }
    }

    // Money owed: only unsettled payments on invoices that still stand.
    if (sale.status !== "voided") {
      const owed = remainingOf(sale);
      if (owed > 0) stats.outstanding = Math.round((stats.outstanding + owed) * 100) / 100;
    }

    map.set(sale.customer_id, stats);
  }

  return map;
}

export interface CustomersExportInput {
  /** Customers to export — already searched/filtered by the caller. */
  customers: readonly Customer[];
  /** Every sale, unfiltered: history is a property of the customer, not the view. */
  sales: readonly Sale[];
  t: Translate;
}

export function buildCustomersSheets({ customers, sales, t }: CustomersExportInput): BuiltSheet[] {
  const stats = customerPurchaseStats(sales);
  const statsFor = (id: string) => stats.get(id) ?? EMPTY_STATS();

  const list: ExportSheet<Customer> = {
    name: t("export.sheet.customers"),
    rows: customers,
    columns: [
      { header: t("export.col.name"), value: (c) => c.name, width: 30 },
      { header: t("export.col.phone"), value: (c) => c.phone, width: 18 },
      { header: t("export.col.address"), value: (c) => c.address ?? "", width: 34 },
      { header: t("export.col.balance"), value: (c) => statsFor(c.id).outstanding, kind: "money" },
      { header: t("export.col.purchases"), value: (c) => statsFor(c.id).count, kind: "number", width: 12 },
      { header: t("export.col.totalSpent"), value: (c) => statsFor(c.id).totalSpent, kind: "money" },
      {
        header: t("export.col.lastPurchase"),
        value: (c) => toDate(statsFor(c.id).lastPurchaseAt),
        kind: "datetime",
      },
      { header: t("export.col.notes"), value: (c) => c.notes ?? "", width: 30 },
      { header: t("export.col.createdAt"), value: (c) => toDate(c.created_at), kind: "datetime" },
    ],
    totals: [
      t("export.totalRow"),
      "",
      "",
      Math.round(customers.reduce((acc, c) => acc + statsFor(c.id).outstanding, 0) * 100) / 100,
      customers.reduce((acc, c) => acc + statsFor(c.id).count, 0),
      Math.round(customers.reduce((acc, c) => acc + statsFor(c.id).totalSpent, 0) * 100) / 100,
      null,
      "",
      null,
    ],
    notes: [
      t("export.note.balance"),
      t("export.note.totalsExcludeVoided"),
      `${t("export.col.name")}: ${customers.length}`,
    ],
  };

  // Purchase history — customer-linked invoices only, newest first.
  const linked = sales
    .filter((sale) => sale.customer_id)
    .slice()
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));

  const history: ExportSheet<Sale> = {
    name: t("export.sheet.purchaseHistory"),
    rows: linked,
    columns: [
      { header: t("export.col.name"), value: (s) => s.customer_name ?? "", width: 30 },
      { header: t("export.col.customerPhone"), value: (s) => s.customer_phone ?? "", width: 18 },
      { header: t("export.col.invoiceNumber"), value: (s) => s.sale_number, width: 16 },
      { header: t("export.col.dateTime"), value: (s) => toDate(s.created_at), kind: "datetime" },
      { header: t("export.col.status"), value: (s) => t(`pos.status.${s.status}` as never), width: 12 },
      { header: t("export.col.itemsCount"), value: (s) => s.items.length, kind: "number", width: 10 },
      { header: t("export.col.total"), value: (s) => s.total, kind: "money" },
      { header: t("export.col.paid"), value: (s) => paymentTotals(s).paid, kind: "money" },
      { header: t("export.col.balance"), value: (s) => remainingOf(s), kind: "money" },
      {
        header: t("export.col.paymentMethod"),
        value: (s) => (s.payment_method ? t(`pos.payment.${s.payment_method}` as never) : ""),
        width: 16,
      },
    ],
    notes: [`${t("export.col.invoiceNumber")}: ${linked.length}`],
  };

  return buildSheets([list, history]);
}
