import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { PageHeader } from "@/components/layout/AppShell";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  ExportButton,
  LoadingBlock,
  StatTile,
} from "@/components/ui";
import { DateRangePicker } from "@/modules/reports/components/DateRangePicker";
import { presetRange, toExportRange, type DateRangeValue, type RangePreset } from "@/modules/reports/services/dateRanges";
import { useShifts } from "../hooks/ShiftProvider";
import { differenceTone } from "../services/shiftCalculations";
import { buildEndOfDay } from "../services/endOfDay";
import { buildEndOfDaySheets } from "../services/eodExport";
import { shiftDuration } from "../services/shiftService";

export function EndOfDayPage() {
  const { t, date, num, money } = useI18n();
  const { shifts, summaryFor, loading, error, refresh } = useShifts();
  const [rangeValue, setRangeValue] = useState<DateRangeValue>(() => presetRange("today"));
  const [preset, setPreset] = useState<RangePreset | null>("today");

  const range = useMemo(() => toExportRange(rangeValue), [rangeValue]);
  const report = useMemo(
    () => buildEndOfDay({ shifts, summaryFor, range }),
    [shifts, summaryFor, range],
  );
  const totals = report.totals;
  const empty = report.closed.length === 0 && report.pending.length === 0;

  return (
    <div>
      <PageHeader
        title={t("shifts.eodTitle")}
        subtitle={t("shifts.eodSubtitle")}
        actions={
          <>
            <ExportButton
              name="end-of-day"
              authority="report"
              count={report.closed.length + report.pending.length}
              build={() => buildEndOfDaySheets({ report, range, t })}
            />
            <Button variant="secondary" onClick={() => void refresh()} title={t("common.refresh")}>
              ⟳
            </Button>
            <Link
              to="/shifts/history"
              className="inline-flex h-10 items-center justify-center rounded-xl px-4 text-sm text-slate-700 hover:bg-slate-100"
            >
              {t("shifts.historyTitle")}
            </Link>
          </>
        }
      />

      <Card className="mb-4">
        <DateRangePicker
          value={rangeValue}
          onChange={setRangeValue}
          activePreset={preset}
          onPreset={setPreset}
        />
      </Card>

      {error ? (
        <ErrorState
          title={t("common.error")}
          message={error.message}
          retryLabel={t("common.retry")}
          onRetry={() => void refresh()}
        />
      ) : loading ? (
        <div className="alyq-card">
          <LoadingBlock label={t("common.loading")} />
        </div>
      ) : (
        <>
          {report.pending.length > 0 ? (
            <p className="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
              {t("shifts.pendingBanner", { count: report.pending.length })}
            </p>
          ) : null}

          <div className="mb-4 grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
            <StatTile label={t("shifts.closedCount")} value={String(totals.closed_shifts)} tone="primary" />
            <StatTile label={t("shifts.grossSales")} value={money(totals.gross_sales)} tone="info" />
            <StatTile label={t("shifts.discounts")} value={money(totals.discounts_total)} />
            <StatTile label={t("shifts.netSales")} value={money(totals.net_sales)} tone="info" />
            <StatTile label={t("shifts.cashSales")} value={money(totals.cash_sales)} tone="success" />
            <StatTile label={t("shifts.instapaySales")} value={money(totals.instapay_sales)} />
            <StatTile label={t("shifts.returnsTotal")} value={money(totals.returns_total)} tone="warning" />
            <StatTile label={t("shifts.expensesTotal")} value={money(totals.expenses_total)} tone="warning" />
            <StatTile label={t("shifts.expectedCash")} value={money(totals.expected_cash)} hint={t("shifts.expectedCashHint")} />
            <StatTile
              label={t("shifts.actualCash")}
              value={totals.closed_shifts === 0 ? "—" : money(totals.actual_cash)}
            />
            <StatTile
              label={t("shifts.difference")}
              value={totals.closed_shifts === 0 ? "—" : money(totals.difference)}
              tone={differenceTone(totals.closed_shifts === 0 ? null : totals.difference)}
              hint={t("export.note.eodDifferences")}
            />
            <StatTile label={t("shifts.openCount")} value={String(totals.open_shifts)} tone="warning" />
          </div>

          {empty ? (
            <Card>
              <EmptyState icon="🕒" title={t("shifts.eodEmpty")} description={t("shifts.eodEmptyHint")} />
            </Card>
          ) : (
            <div className="space-y-4">
              {report.closed.length > 0 ? (
                <div className="alyq-card overflow-x-auto">
                  <table className="w-full border-collapse text-sm">
                    <thead>
                      <tr className="border-b border-[#e7ded1] bg-[#faf7f2] text-start text-[11px] font-bold uppercase tracking-wider text-[#1c1917]">
                        <th className="px-4 py-3 text-start font-semibold">{t("shifts.shiftNumber")}</th>
                        <th className="px-3 py-3 text-start font-semibold">{t("shifts.cashier")}</th>
                        <th className="px-3 py-3 text-end font-semibold">{t("shifts.grossSales")}</th>
                        <th className="px-3 py-3 text-end font-semibold">{t("shifts.discounts")}</th>
                        <th className="px-3 py-3 text-end font-semibold">{t("shifts.netSales")}</th>
                        <th className="px-3 py-3 text-end font-semibold">{t("shifts.cashSales")}</th>
                        <th className="px-3 py-3 text-end font-semibold">{t("shifts.instapaySales")}</th>
                        <th className="px-3 py-3 text-end font-semibold">{t("shifts.expectedCash")}</th>
                        <th className="px-3 py-3 text-end font-semibold">{t("shifts.actualCash")}</th>
                        <th className="px-3 py-3 text-center font-semibold">{t("shifts.difference")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {report.closed.map(({ shift, summary }) => (
                        <tr key={shift.id} className="border-b border-slate-50 last:border-0">
                          <td className="px-4 py-3">
                            <span className="font-mono text-xs font-bold text-[#b08d57]">{shift.shift_number}</span>
                            <p className="text-[11px] text-slate-500">
                              {shift.branch} · {shift.register}
                            </p>
                            <p className="text-[11px] text-slate-400" dir="ltr">
                              {date(shift.opening_at)} · {shiftDuration(shift.opening_at, shift.closed_at)}
                            </p>
                          </td>
                          <td className="px-3 py-3 text-xs text-slate-700">{shift.opened_by_name}</td>
                          <td className="px-3 py-3 text-end text-xs tabular-nums" dir="ltr">
                            {money(summary?.gross_sales ?? summary?.sales_total ?? 0)}
                          </td>
                          <td className="px-3 py-3 text-end text-xs tabular-nums" dir="ltr">
                            {money(summary?.discounts_total ?? 0)}
                          </td>
                          <td className="px-3 py-3 text-end text-xs tabular-nums" dir="ltr">
                            {money(summary?.net_sales ?? summary?.sales_total ?? 0)}
                          </td>
                          <td className="px-3 py-3 text-end text-xs tabular-nums" dir="ltr">
                            {money(summary?.cash_sales ?? 0)}
                          </td>
                          <td className="px-3 py-3 text-end text-xs tabular-nums" dir="ltr">
                            {money(summary?.instapay_sales ?? 0)}
                          </td>
                          <td className="px-3 py-3 text-end text-xs font-bold tabular-nums" dir="ltr">
                            {money(summary?.expected_cash ?? 0)}
                          </td>
                          <td className="px-3 py-3 text-end text-xs font-bold tabular-nums" dir="ltr">
                            {summary?.actual_cash === null || summary?.actual_cash === undefined
                              ? "—"
                              : money(summary.actual_cash)}
                          </td>
                          <td className="px-3 py-3 text-center">
                            <Badge tone={differenceTone(summary?.difference ?? null)}>
                              {summary?.difference === null || summary?.difference === undefined
                                ? "—"
                                : `${num(summary.difference, 2)} · ${
                                    summary.difference === 0
                                      ? t("shifts.balanced")
                                      : summary.difference > 0
                                        ? t("shifts.over")
                                        : t("shifts.short")
                                  }`}
                            </Badge>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : null}

              {report.pending.length > 0 ? (
                <Card>
                  <p className="mb-3 text-xs font-bold uppercase tracking-wide text-amber-800">
                    {t("shifts.pendingOpen")}
                  </p>
                  <p className="mb-3 text-xs text-amber-900">{t("shifts.pendingOpenHint")}</p>
                  <div className="overflow-x-auto">
                    <table className="w-full border-collapse text-sm">
                      <thead>
                        <tr className="border-b border-amber-100 text-start text-[11px] font-bold uppercase tracking-wider text-slate-600">
                          <th className="py-2 text-start font-semibold">{t("shifts.shiftNumber")}</th>
                          <th className="py-2 text-start font-semibold">{t("shifts.cashier")}</th>
                          <th className="py-2 text-end font-semibold">{t("shifts.netSales")}</th>
                          <th className="py-2 text-end font-semibold">{t("shifts.expectedCash")}</th>
                          <th className="py-2 text-end font-semibold">{t("shifts.actualCash")}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {report.pending.map(({ shift, summary }) => (
                          <tr key={shift.id} className="border-b border-slate-50 last:border-0">
                            <td className="py-2">
                              <span className="font-mono text-xs font-bold text-amber-800">{shift.shift_number}</span>
                              <Badge tone="warning">{t("shifts.statusOpen")}</Badge>
                            </td>
                            <td className="py-2 text-xs">{shift.opened_by_name}</td>
                            <td className="py-2 text-end text-xs tabular-nums" dir="ltr">
                              {money(summary?.net_sales ?? summary?.sales_total ?? 0)}
                            </td>
                            <td className="py-2 text-end text-xs tabular-nums" dir="ltr">
                              {money(summary?.expected_cash ?? shift.opening_cash)}
                            </td>
                            <td className="py-2 text-end text-xs text-slate-400">—</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </Card>
              ) : null}
            </div>
          )}
        </>
      )}
    </div>
  );
}
