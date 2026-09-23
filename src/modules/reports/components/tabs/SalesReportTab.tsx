/**
 * Sales report — who sold, where, how it was paid for, and how it ran by day.
 *
 * Requirement 7's sales half. Every figure is `buildSalesAnalytics`, the same
 * call the export makes, so the table on screen and the sheet in the file are
 * two renderings of one computation.
 */
import { useMemo } from "react";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { Card, ExportButton, ReceiptIcon, ReportIcon, StatTile, WalletIcon } from "@/components/ui";
import { buildSalesAnalytics, UNATTRIBUTED_REGISTER } from "../../services/salesAnalytics";
import { buildSalesAnalyticsSheets } from "../../services/analyticsExport";
import { ReportSection, ReportTable, type ReportColumn } from "../ReportTable";
import type { ReportTabProps } from "./types";

/** How many days of the trend the screen shows; the export holds all of them. */
const TREND_ROWS = 14;

export function SalesReportTab({ sales, shifts, range }: ReportTabProps) {
  const { t, money, num } = useI18n();
  const analytics = useMemo(() => buildSalesAnalytics({ sales, shifts, range }), [sales, shifts, range]);

  const employeeColumns: ReportColumn<(typeof analytics.byEmployee)[number]>[] = [
    { key: "name", label: t("export.col.employee"), render: (row) => row.userName },
    { key: "invoices", label: t("export.col.invoices"), align: "end", render: (row) => num(row.invoices) },
    { key: "units", label: t("export.col.unitsSold"), align: "end", render: (row) => num(row.units) },
    { key: "revenue", label: t("export.col.revenue"), align: "end", render: (row) => money(row.revenue) },
    { key: "discounts", label: t("export.col.discountsGiven"), align: "end", render: (row) => money(row.discounts) },
    { key: "avg", label: t("export.col.avgInvoice"), align: "end", render: (row) => money(row.avgInvoice) },
    { key: "share", label: t("export.col.share"), align: "end", render: (row) => `${num(row.share, 1)}%` },
  ];

  const registerColumns: ReportColumn<(typeof analytics.byRegister)[number]>[] = [
    {
      key: "branch",
      label: t("export.col.branch"),
      render: (row) => (row.key === UNATTRIBUTED_REGISTER ? t("export.row.unattributed") : row.branch),
    },
    {
      key: "register",
      label: t("export.col.register"),
      render: (row) => (row.key === UNATTRIBUTED_REGISTER ? "—" : row.register),
    },
    { key: "shifts", label: t("export.col.shifts"), align: "end", render: (row) => num(row.shifts) },
    { key: "invoices", label: t("export.col.invoices"), align: "end", render: (row) => num(row.invoices) },
    { key: "revenue", label: t("export.col.revenue"), align: "end", render: (row) => money(row.revenue) },
    { key: "share", label: t("export.col.share"), align: "end", render: (row) => `${num(row.share, 1)}%` },
  ];

  const methodColumns: ReportColumn<(typeof analytics.byPaymentMethod)[number]>[] = [
    { key: "method", label: t("export.col.paymentMethod"), render: (row) => t(`pos.payment.${row.method}` as never) },
    { key: "invoices", label: t("export.col.invoices"), align: "end", render: (row) => num(row.invoices) },
    { key: "amount", label: t("export.col.amount"), align: "end", render: (row) => money(row.amount) },
    { key: "paid", label: t("export.col.paid"), align: "end", render: (row) => money(row.paid) },
    { key: "pending", label: t("export.col.pending"), align: "end", render: (row) => money(row.pending) },
    { key: "share", label: t("export.col.share"), align: "end", render: (row) => `${num(row.share, 1)}%` },
  ];

  const trendColumns: ReportColumn<(typeof analytics.trend)[number]>[] = [
    { key: "date", label: t("export.col.date"), render: (row) => row.date },
    { key: "invoices", label: t("export.col.invoices"), align: "end", render: (row) => num(row.invoices) },
    { key: "units", label: t("export.col.unitsSold"), align: "end", render: (row) => num(row.units) },
    { key: "revenue", label: t("export.col.revenue"), align: "end", render: (row) => money(row.revenue) },
    { key: "discounts", label: t("export.col.discountsGiven"), align: "end", render: (row) => money(row.discounts) },
  ];

  const trendRows = analytics.trend.slice(-TREND_ROWS).reverse();

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          label={t("export.metric.revenue")}
          value={money(analytics.revenue)}
          tone="success"
          icon={<WalletIcon />}
          hint={`${num(analytics.invoices)} ${t("export.col.invoices").toLowerCase()}`}
        />
        <StatTile
          label={t("export.col.avgInvoice")}
          value={money(analytics.avgInvoice)}
          tone="primary"
          icon={<ReceiptIcon />}
          hint={`${num(analytics.units)} ${t("export.col.unitsSold").toLowerCase()}`}
        />
        <StatTile
          label={t("export.col.discountsGiven")}
          value={money(analytics.discounts)}
          tone="warning"
          icon={<ReportIcon />}
        />
        <StatTile
          label={t("export.col.employee")}
          value={num(analytics.byEmployee.length)}
          tone="info"
          hint={`${analytics.byRegister.filter((row) => row.key !== UNATTRIBUTED_REGISTER).length} ${t(
            "export.col.register",
          ).toLowerCase()}`}
        />
      </div>

      <Card className="space-y-4">
        <ReportSection
          title={t("reports.adv.salesByEmployee")}
          hint={t("reports.adv.salesByEmployeeHint")}
          aside={
            <ExportButton
              name="sales-report"
              authority="report"
              size="sm"
              count={analytics.invoices}
              build={() => buildSalesAnalyticsSheets({ sales, shifts, range, t })}
            />
          }
        >
          <ReportTable
            columns={employeeColumns}
            rows={analytics.byEmployee}
            rowKey={(row) => row.userId}
            emptyLabel={t("reports.adv.empty")}
            emptyHint={t("reports.adv.emptyHint")}
            totals={[
              t("export.totalRow"),
              num(analytics.invoices),
              num(analytics.units),
              money(analytics.revenue),
              money(analytics.discounts),
              money(analytics.avgInvoice),
              null,
            ]}
          />
        </ReportSection>

        <ReportSection title={t("reports.adv.salesByRegister")} hint={t("export.note.branchAttribution")}>
          <ReportTable
            columns={registerColumns}
            rows={analytics.byRegister}
            rowKey={(row) => row.key}
            emptyLabel={t("reports.adv.empty")}
            emptyHint={t("reports.adv.emptyHint")}
            footerNote={
              analytics.byRegister.some((row) => row.key === UNATTRIBUTED_REGISTER)
                ? t("export.note.unattributedSales")
                : undefined
            }
          />
        </ReportSection>

        <ReportSection title={t("reports.adv.salesByPayment")} hint={t("export.note.paymentSplit")}>
          <ReportTable
            columns={methodColumns}
            rows={analytics.byPaymentMethod}
            rowKey={(row) => row.method}
            emptyLabel={t("reports.adv.empty")}
            emptyHint={t("reports.adv.emptyHint")}
          />
        </ReportSection>

        <ReportSection
          title={t("reports.adv.salesTrend")}
          hint={t("reports.adv.trendHint", { count: TREND_ROWS })}
        >
          <ReportTable
            columns={trendColumns}
            rows={trendRows}
            rowKey={(row) => row.date}
            dense
            emptyLabel={t("reports.adv.empty")}
            emptyHint={t("reports.adv.emptyHint")}
          />
        </ReportSection>
      </Card>
    </div>
  );
}
