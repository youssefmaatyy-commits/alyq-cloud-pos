/**
 * Expense report — the same spending the Expenses screen shows, by category,
 * by employee and by day, over a window.
 *
 * Requirement 4's reporting half. The totals are `summarizeExpenses` (the page's
 * own tiles read the same function), the breakdowns are `buildExpenseReport`, and
 * the export is `buildExpenseAnalyticsSheets` over the same rows — one
 * arithmetic, three renderings.
 */
import { useMemo } from "react";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { Card, ExportButton, ReceiptIcon, StatTile, WalletIcon } from "@/components/ui";
import { buildExpenseReport } from "../../services/expenseAnalytics";
import { buildExpenseAnalyticsSheets } from "../../services/analyticsExport";
import { ReportSection, ReportTable, type ReportColumn } from "../ReportTable";
import type { ReportTabProps } from "./types";

export function ExpenseReportTab({ expenses, range }: ReportTabProps) {
  const { t, money, num } = useI18n();
  const report = useMemo(() => buildExpenseReport(expenses, range), [expenses, range]);

  const breakdownColumns = (
    labelKey: Parameters<typeof t>[0],
    labelOf: (row: (typeof report.byCategory)[number]) => string,
  ): ReportColumn<(typeof report.byCategory)[number]>[] => [
    { key: "label", label: t(labelKey), render: (row) => labelOf(row) },
    { key: "count", label: t("export.col.count"), align: "end", render: (row) => num(row.count) },
    { key: "total", label: t("export.col.total"), align: "end", render: (row) => money(row.total) },
    { key: "cash", label: t("export.col.cash"), align: "end", render: (row) => money(row.cash) },
    { key: "instapay", label: t("export.col.instapay"), align: "end", render: (row) => money(row.instapay) },
    { key: "visa", label: t("export.col.card"), align: "end", render: (row) => money(row.visa) },
    { key: "avg", label: t("export.col.avg"), align: "end", render: (row) => money(row.avg) },
    { key: "share", label: t("export.col.share"), align: "end", render: (row) => `${num(row.share, 1)}%` },
  ];

  const dayColumns: ReportColumn<(typeof report.byDay)[number]>[] = [
    { key: "date", label: t("export.col.date"), render: (row) => row.date },
    { key: "count", label: t("export.col.count"), align: "end", render: (row) => num(row.count) },
    { key: "total", label: t("export.col.total"), align: "end", render: (row) => money(row.total) },
    { key: "largest", label: t("export.col.largest"), align: "end", render: (row) => money(row.largest) },
    { key: "name", label: t("export.col.description"), render: (row) => row.largestName },
  ];

  const totalsRow = [
    t("export.totalRow"),
    num(report.totals.count),
    money(report.totals.total),
    money(report.totals.cash),
    money(report.totals.instapay),
    money(report.totals.visa),
    null,
    null,
  ];

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          label={t("reports.expenses")}
          value={money(report.totals.total)}
          tone="warning"
          icon={<WalletIcon />}
          hint={`${num(report.totals.count)} ${t("export.col.count").toLowerCase()}`}
        />
        <StatTile
          label={t("export.col.avgPerDay")}
          value={money(report.avgPerActiveDay)}
          tone="info"
          hint={`${num(report.activeDays)} ${t("export.col.activeDays").toLowerCase()}`}
        />
        <StatTile
          label={t("export.metric.cash")}
          value={money(report.totals.cash)}
          tone="success"
          icon={<ReceiptIcon />}
          hint={`${money(report.totals.instapay)} ${t("export.metric.instapay")} · ${money(
            report.totals.visa,
          )} ${t("export.metric.card")}`}
        />
        <StatTile
          label={t("export.col.largest")}
          value={money(report.largest?.amount ?? 0)}
          tone="neutral"
          hint={report.largest?.name ?? "—"}
        />
      </div>

      <Card className="space-y-4">
        <ReportSection
          title={t("reports.adv.expensesByCategory")}
          hint={t("export.note.expenseDay")}
          aside={
            <ExportButton
              name="expense-report"
              authority="report"
              size="sm"
              count={report.totals.count}
              build={() => buildExpenseAnalyticsSheets({ expenses, range, t })}
            />
          }
        >
          <ReportTable
            columns={breakdownColumns("export.col.category", (row) =>
              t(`expenses.category.${row.key}` as never),
            )}
            rows={report.byCategory}
            rowKey={(row) => row.key}
            dense
            emptyLabel={t("reports.adv.empty")}
            emptyHint={t("reports.adv.emptyHint")}
            totals={totalsRow}
          />
        </ReportSection>

        <ReportSection title={t("reports.adv.expensesByEmployee")} hint={t("reports.adv.byEmployeeHint")}>
          <ReportTable
            columns={breakdownColumns("export.col.employee", (row) => row.label)}
            rows={report.byEmployee}
            rowKey={(row) => row.key}
            dense
            emptyLabel={t("reports.adv.empty")}
            emptyHint={t("reports.adv.emptyHint")}
            totals={totalsRow}
          />
        </ReportSection>

        <ReportSection title={t("reports.adv.expensesByBranch")}>
          <ReportTable
            columns={breakdownColumns("export.col.branch", (row) =>
              row.key === "__none__" ? t("export.row.none") : row.label,
            )}
            rows={report.byBranch}
            rowKey={(row) => row.key}
            dense
            emptyLabel={t("reports.adv.empty")}
            emptyHint={t("reports.adv.emptyHint")}
            totals={totalsRow}
          />
        </ReportSection>

        <ReportSection title={t("export.sheet.byDay")} hint={t("reports.adv.byDayHint")}>
          <ReportTable
            columns={dayColumns}
            rows={[...report.byDay].reverse().slice(0, 20)}
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
