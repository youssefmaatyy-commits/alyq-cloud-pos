/**
 * Customer report — who buys, how much, how often, and what they still owe.
 *
 * Requirement 7's customer half. The per-customer numbers come from
 * `customerPurchaseStats` through `topCustomers`, which is the same roll-up the
 * customer book and its export already use; "purchase history" is one customer's
 * invoices, and the export takes a customer id so a manager can hand somebody
 * their own statement without exporting the whole book.
 */
import { useMemo, useState } from "react";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { Card, ExportButton, SelectInput, StatTile, UsersIcon } from "@/components/ui";
import {
  customerPurchaseHistory,
  customerSpendingSummary,
  salesInRange,
  topCustomers,
} from "../../services/salesAnalytics";
import { buildCustomerAnalyticsSheets } from "../../services/analyticsExport";
import { ReportSection, ReportTable, type ReportColumn } from "../ReportTable";
import type { ReportTabProps } from "./types";

const TOP_LIMIT = 15;

export function CustomerReportTab({ sales, customers, range }: ReportTabProps) {
  const { t, money, num, date } = useI18n();
  const [historyFor, setHistoryFor] = useState<string>("");

  // Ranged once, here: the screen and the export then answer about the same
  // window, which is the whole point of a date filter on a report.
  const ranged = useMemo(() => salesInRange(sales, range), [sales, range]);
  const ranked = useMemo(() => topCustomers(customers, ranged, TOP_LIMIT), [customers, ranged]);
  const spending = useMemo(() => customerSpendingSummary(customers, ranged), [customers, ranged]);
  const history = useMemo(
    () => (historyFor ? customerPurchaseHistory(ranged, historyFor).slice(0, 20) : []),
    [ranged, historyFor],
  );

  const customerColumns: ReportColumn<(typeof ranked)[number]>[] = [
    { key: "name", label: t("export.col.customer"), render: (row) => row.name },
    { key: "phone", label: t("export.col.phone"), render: (row) => row.phone },
    { key: "invoices", label: t("export.col.invoices"), align: "end", render: (row) => num(row.invoices) },
    { key: "spend", label: t("export.col.totalSpent"), align: "end", render: (row) => money(row.spend) },
    { key: "avg", label: t("export.col.avgInvoice"), align: "end", render: (row) => money(row.avgInvoice) },
    {
      key: "outstanding",
      label: t("export.col.outstanding"),
      align: "end",
      render: (row) => (row.outstanding > 0 ? <span className="font-bold text-amber-600">{money(row.outstanding)}</span> : money(0)),
    },
    { key: "last", label: t("export.col.lastPurchase"), align: "end", render: (row) => date(row.lastPurchaseAt) },
    { key: "share", label: t("export.col.share"), align: "end", render: (row) => `${num(row.share, 1)}%` },
  ];

  const historyColumns: ReportColumn<(typeof history)[number]>[] = [
    { key: "number", label: t("export.col.invoiceNumber"), render: (row) => row.saleNumber },
    { key: "at", label: t("export.col.dateTime"), render: (row) => date(row.at) },
    { key: "status", label: t("export.col.status"), render: (row) => t(`pos.status.${row.status}` as never) },
    { key: "items", label: t("export.col.itemsCount"), align: "end", render: (row) => num(row.items) },
    { key: "total", label: t("export.col.total"), align: "end", render: (row) => money(row.total) },
    { key: "paid", label: t("export.col.paid"), align: "end", render: (row) => money(row.paid) },
    { key: "owed", label: t("export.col.remaining"), align: "end", render: (row) => money(row.owed) },
  ];

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          label={t("export.col.buying")}
          value={num(spending.buying)}
          tone="primary"
          icon={<UsersIcon />}
          hint={`${num(spending.customers)} ${t("export.sheet.customers").toLowerCase()}`}
        />
        <StatTile
          label={t("export.col.avgSpend")}
          value={money(spending.avgSpend)}
          tone="info"
          hint={`${money(spending.avgInvoice)} / ${t("export.col.invoiceNumber").toLowerCase()}`}
        />
        <StatTile
          label={t("export.col.repeatCustomers")}
          value={num(spending.repeat)}
          tone="success"
          hint={`${num(spending.oneTime)} ${t("export.col.oneTimeCustomers").toLowerCase()}`}
        />
        <StatTile
          label={t("export.col.outstanding")}
          value={money(spending.outstanding)}
          tone={spending.outstanding > 0 ? "warning" : "neutral"}
          hint={`${num(spending.topCustomerShare, 1)}% ${t("export.col.topCustomerShare").toLowerCase()}`}
        />
      </div>

      <Card className="space-y-4">
        <ReportSection
          title={t("export.sheet.topCustomers")}
          hint={t("export.note.walkInSales")}
          aside={
            <ExportButton
              name="customer-report"
              authority="report"
              size="sm"
              count={ranked.length}
              build={() => buildCustomerAnalyticsSheets({ customers, sales, range, t })}
            />
          }
        >
          <ReportTable
            columns={customerColumns}
            rows={ranked}
            rowKey={(row) => row.customerId}
            dense
            emptyLabel={t("reports.adv.empty")}
            emptyHint={t("reports.adv.emptyHint")}
            footerNote={`${t("reports.adv.walkInRevenue")}: ${money(spending.unattributedRevenue)} (${num(
              100 - spending.attributedShare,
              1,
            )}%)`}
          />
        </ReportSection>

        <ReportSection
          title={t("export.sheet.purchaseHistory")}
          hint={t("reports.adv.historyHint")}
          aside={
            <div className="w-full sm:w-56">
              <SelectInput
                value={historyFor}
                onChange={(e) => setHistoryFor(e.target.value)}
                aria-label={t("export.col.customer")}
              >
                <option value="">{t("reports.adv.pickCustomer")}</option>
                {ranked.map((row) => (
                  <option key={row.customerId} value={row.customerId}>
                    {row.name}
                  </option>
                ))}
              </SelectInput>
            </div>
          }
        >
          {historyFor ? (
            <>
              <ReportTable
                columns={historyColumns}
                rows={history}
                rowKey={(row) => row.saleId}
                dense
                emptyLabel={t("reports.adv.empty")}
                emptyHint={t("reports.adv.emptyHint")}
              />
              <div className="flex justify-end">
                {/* One customer's own invoices — a statement, not the book. */}
                <ExportButton
                  name="customer-history"
                  authority="report"
                  size="sm"
                  count={history.length}
                  build={() =>
                    buildCustomerAnalyticsSheets({ customers, sales, range, t, customerId: historyFor })
                  }
                />
              </div>
            </>
          ) : (
            <p className="rounded-2xl border border-dashed border-slate-200 bg-slate-50/60 px-4 py-6 text-center text-xs font-medium text-slate-500">
              {t("reports.adv.pickCustomerHint")}
            </p>
          )}
        </ReportSection>
      </Card>
    </div>
  );
}
