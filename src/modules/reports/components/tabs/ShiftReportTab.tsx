/**
 * Shift report — the drawer, by shift, by day and by the person who ran it.
 *
 * Requirement 5's reporting half: opening balance, closing balance, expected
 * cash, actual cash and the difference, grouped three ways. Nothing here
 * recomputes a drawer: `buildShiftReport` reads `summaryFor` — the provider's own
 * summary, live for an open drawer and frozen once it closes — so this report and
 * the Shifts screen are reading the same numbers, not two opinions about them.
 */
import { useMemo } from "react";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { Badge, Card, ClockIcon, ExportButton, StatTile, WalletIcon } from "@/components/ui";
import {
  buildShiftReport,
  cashDifferenceRows,
  cashDifferenceSummary,
  dailyShiftReport,
  employeeShiftPerformance,
} from "../../services/shiftAnalytics";
import { buildShiftAnalyticsSheets } from "../../services/analyticsExport";
import { ReportSection, ReportTable, type ReportColumn } from "../ReportTable";
import type { ReportTabProps } from "./types";

export function ShiftReportTab({ shifts, summaryFor, range }: ReportTabProps) {
  const { t, money, num, date } = useI18n();

  const report = useMemo(() => buildShiftReport({ shifts, summaryFor, range }), [shifts, summaryFor, range]);
  const gaps = useMemo(() => cashDifferenceRows(report.rows), [report.rows]);
  const gapSummary = useMemo(() => cashDifferenceSummary(report.rows), [report.rows]);
  const daily = useMemo(() => dailyShiftReport(report.rows), [report.rows]);
  const people = useMemo(() => employeeShiftPerformance(report.rows), [report.rows]);

  /** A difference painted the way the shift screen paints it. */
  const difference = (value: number | null) => {
    if (value === null) return <span className="text-slate-400">—</span>;
    if (value === 0) return <Badge tone="success">{t("shifts.balanced")}</Badge>;
    return (
      <Badge tone={Math.abs(value) <= 5 ? "warning" : "danger"}>
        {value > 0 ? `${t("shifts.over")} ` : `${t("shifts.short")} `}
        {money(Math.abs(value))}
      </Badge>
    );
  };

  const shiftColumns: ReportColumn<(typeof report.rows)[number]>[] = [
    { key: "number", label: t("export.col.shiftNumber"), render: (row) => row.shiftNumber },
    {
      key: "status",
      label: t("shifts.status"),
      render: (row) => t(row.status === "open" ? "shifts.statusOpen" : "shifts.statusClosed"),
    },
    { key: "user", label: t("shifts.cashier"), render: (row) => row.userName },
    { key: "opened", label: t("shifts.openingAt"), render: (row) => date(row.openedAt) },
    { key: "duration", label: t("export.col.duration"), align: "end", render: (row) => row.duration },
    { key: "opening", label: t("shifts.openingBalance"), align: "end", render: (row) => money(row.openingCash) },
    { key: "invoices", label: t("export.col.invoices"), align: "end", render: (row) => num(row.invoices) },
    { key: "sales", label: t("shifts.salesTotal"), align: "end", render: (row) => money(row.salesTotal) },
    { key: "expenses", label: t("shifts.expensesTotal"), align: "end", render: (row) => money(row.expensesTotal) },
    { key: "expected", label: t("shifts.expectedCash"), align: "end", render: (row) => money(row.expectedCash) },
    {
      key: "actual",
      label: t("shifts.actualCash"),
      align: "end",
      render: (row) => (row.actualCash === null ? <span className="text-slate-400">—</span> : money(row.actualCash)),
    },
    { key: "difference", label: t("shifts.difference"), align: "end", render: (row) => difference(row.difference) },
  ];

  const gapColumns: ReportColumn<(typeof gaps)[number]>[] = [
    { key: "number", label: t("export.col.shiftNumber"), render: (row) => row.shiftNumber },
    { key: "date", label: t("export.col.date"), render: (row) => date(row.openedAt) },
    { key: "user", label: t("shifts.cashier"), render: (row) => row.userName },
    { key: "branch", label: t("shifts.branch"), render: (row) => row.branch },
    { key: "expected", label: t("shifts.expectedCash"), align: "end", render: (row) => money(row.expectedCash) },
    { key: "actual", label: t("shifts.actualCash"), align: "end", render: (row) => money(row.actualCash ?? 0) },
    { key: "difference", label: t("shifts.difference"), align: "end", render: (row) => difference(row.difference) },
    {
      key: "notes",
      label: t("export.col.notes"),
      render: (row) =>
        row.notes?.trim() ? (
          row.notes
        ) : (
          <span className="font-semibold text-rose-600">{t("export.note.unexplained")}</span>
        ),
    },
  ];

  const dailyColumns: ReportColumn<(typeof daily)[number]>[] = [
    { key: "date", label: t("export.col.date"), render: (row) => row.date },
    { key: "shifts", label: t("export.col.shifts"), align: "end", render: (row) => num(row.shifts) },
    { key: "invoices", label: t("export.col.invoices"), align: "end", render: (row) => num(row.invoices) },
    { key: "sales", label: t("shifts.salesTotal"), align: "end", render: (row) => money(row.salesTotal) },
    { key: "opening", label: t("shifts.openingBalance"), align: "end", render: (row) => money(row.openingCash) },
    { key: "expenses", label: t("shifts.expensesTotal"), align: "end", render: (row) => money(row.expensesTotal) },
    { key: "expected", label: t("shifts.expectedCash"), align: "end", render: (row) => money(row.expectedCash) },
    {
      key: "actual",
      label: t("shifts.actualCash"),
      align: "end",
      render: (row) => (row.actualCash === null ? <span className="text-slate-400">—</span> : money(row.actualCash)),
    },
    { key: "difference", label: t("shifts.difference"), align: "end", render: (row) => difference(row.difference) },
  ];

  const peopleColumns: ReportColumn<(typeof people)[number]>[] = [
    { key: "user", label: t("export.col.employee"), render: (row) => row.userName },
    { key: "shifts", label: t("export.col.shifts"), align: "end", render: (row) => num(row.shifts) },
    { key: "invoices", label: t("export.col.invoices"), align: "end", render: (row) => num(row.invoices) },
    { key: "sales", label: t("shifts.salesTotal"), align: "end", render: (row) => money(row.salesTotal) },
    { key: "avg", label: t("export.col.avgInvoice"), align: "end", render: (row) => money(row.avgInvoice) },
    { key: "share", label: t("export.col.share"), align: "end", render: (row) => `${num(row.share, 1)}%` },
    { key: "expenses", label: t("shifts.expensesTotal"), align: "end", render: (row) => money(row.expensesTotal) },
    { key: "difference", label: t("shifts.difference"), align: "end", render: (row) => difference(row.difference) },
    {
      key: "exact",
      label: t("export.col.exactCount"),
      align: "end",
      render: (row) => `${num(row.exact)} / ${num(row.discrepancies + row.exact)}`,
    },
  ];

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          label={t("shifts.closedShifts")}
          value={num(report.totals.closed)}
          tone="primary"
          icon={<ClockIcon />}
          hint={`${num(report.totals.open)} ${t("shifts.statusOpen").toLowerCase()}`}
        />
        <StatTile
          label={t("shifts.salesTotal")}
          value={money(report.totals.salesTotal)}
          tone="info"
          icon={<WalletIcon />}
          hint={`${num(report.totals.invoices)} ${t("export.col.invoices").toLowerCase()}`}
        />
        <StatTile
          label={t("shifts.expectedCash")}
          value={money(report.totals.expectedCash)}
          tone="neutral"
          hint={`${money(report.totals.actualCash)} ${t("shifts.actualCash").toLowerCase()}`}
        />
        <StatTile
          label={t("shifts.netDifference")}
          value={money(report.totals.difference)}
          tone={report.totals.difference === 0 ? "success" : report.totals.difference > 0 ? "warning" : "danger"}
          hint={`${num(gapSummary.discrepancies)} ${t("export.col.discrepancies").toLowerCase()} · ${num(
            gapSummary.discrepancyRate,
            1,
          )}%`}
        />
      </div>

      <Card className="space-y-4">
        <ReportSection
          title={t("reports.adv.dailyShifts")}
          hint={t("export.note.differencesCounted")}
          aside={
            <ExportButton
              name="shift-report"
              authority="report"
              size="sm"
              count={report.rows.length}
              build={() => buildShiftAnalyticsSheets({ shifts, summaryFor, range, t })}
            />
          }
        >
          <ReportTable
            columns={dailyColumns}
            rows={daily.slice(0, 20)}
            rowKey={(row) => row.date}
            dense
            emptyLabel={t("reports.adv.empty")}
            emptyHint={t("reports.adv.emptyHint")}
          />
        </ReportSection>

        <ReportSection
          title={t("reports.adv.cashDifferences")}
          hint={t("export.note.differenceSign")}
        >
          <ReportTable
            columns={gapColumns}
            rows={gaps}
            rowKey={(row) => row.shiftId}
            dense
            emptyLabel={t("reports.adv.noDifferences")}
            emptyHint={t("reports.adv.noDifferencesHint", { count: gapSummary.counted })}
            totals={[
              t("export.totalRow"),
              null,
              null,
              null,
              null,
              null,
              money(gapSummary.net),
              `${num(gapSummary.unexplained)} ${t("export.note.unexplained")}`,
            ]}
          />
        </ReportSection>

        <ReportSection title={t("reports.adv.employeePerformance")} hint={t("reports.adv.shiftByEmployeeHint")}>
          <ReportTable
            columns={peopleColumns}
            rows={people}
            rowKey={(row) => row.userId}
            dense
            emptyLabel={t("reports.adv.empty")}
            emptyHint={t("reports.adv.emptyHint")}
          />
        </ReportSection>

        <ReportSection title={t("export.sheet.shifts")} hint={t("shifts.windowHint")}>
          <ReportTable
            columns={shiftColumns}
            rows={report.rows}
            rowKey={(row) => row.shiftId}
            dense
            emptyLabel={t("reports.adv.empty")}
            emptyHint={t("reports.adv.emptyHint")}
            totals={[
              t("export.totalRow"),
              null,
              null,
              null,
              null,
              money(report.totals.openingCash),
              num(report.totals.invoices),
              money(report.totals.salesTotal),
              money(report.totals.expensesTotal),
              money(report.totals.expectedCash),
              money(report.totals.actualCash),
              difference(report.totals.difference),
            ]}
          />
        </ReportSection>
      </Card>
    </div>
  );
}
