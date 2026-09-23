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
  EyeIcon,
  LoadingBlock,
  Modal,
  SearchIcon,
  SelectInput,
  StatTile,
  TextInput,
} from "@/components/ui";
import { useShifts } from "../hooks/ShiftProvider";
import { ShiftSummaryGrid } from "../components/ShiftSummaryGrid";
import { differenceTone } from "../services/shiftCalculations";
import { shiftDuration } from "../services/shiftService";
import { EMPTY_SHIFT_FILTERS, type Shift, type ShiftFiltersValue } from "../types";
// The shift *report* — daily shifts, cash differences and per-employee
// performance — is built by the reports analytics, so this screen exports the
// same workbook the advanced reports screen does rather than growing a second
// builder next to it (Phase 14, requirement 4).
import { buildShiftAnalyticsSheets } from "@/modules/reports/services/analyticsExport";
import { OPEN_DATE_RANGE } from "@/modules/reports/services/financialExport";
import { buildShiftDetailSheets } from "../services/eodExport";

export function ShiftHistoryPage() {
  const { t, date, num, money } = useI18n();
  const { filterShifts, summaryFor, expensesFor, loading, error, refresh, canApprove, approveAdjustment } =
    useShifts();

  const [filters, setFilters] = useState<ShiftFiltersValue>(EMPTY_SHIFT_FILTERS);
  const [selected, setSelected] = useState<Shift | null>(null);
  const [approving, setApproving] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const listedShifts = useMemo(() => filterShifts(filters), [filterShifts, filters]);
  const closedShifts = useMemo(
    () => listedShifts.filter((s) => s.status === "closed"),
    [listedShifts],
  );

  const totals = useMemo(() => {
    let difference = 0;
    let sales = 0;
    let expenses = 0;
    let expected = 0;
    for (const shift of closedShifts) {
      const summary = shift.summary ?? summaryFor(shift);
      if (!summary) continue;
      difference += summary.difference ?? 0;
      sales += summary.sales_total;
      expenses += summary.expenses_total;
      expected += summary.expected_cash;
    }
    return { difference, sales, expenses, expected };
  }, [closedShifts, summaryFor]);

  const selectedSummary = selected ? summaryFor(selected) : null;
  const selectedExpenses = selected ? expensesFor(selected) : [];

  async function approve() {
    if (!selected) return;
    setApproving(true);
    setActionError(null);
    try {
      const updated = await approveAdjustment(selected);
      setSelected(updated);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setApproving(false);
    }
  }

  return (
    <div>
      <PageHeader
        title={t("shifts.historyTitle")}
        subtitle={t("shifts.historySubtitle")}
        actions={
          <>
            {/* What the screen lists, as a report: counted drawers only, so the
                cash columns are the ones the tiles above total. `authority="report"`
                asks for `export_reports`, which ExportButton asserts on click. */}
            <ExportButton
              name="shift-report"
              authority="report"
              count={listedShifts.length}
              build={() =>
                buildShiftAnalyticsSheets({
                  shifts: listedShifts,
                  summaryFor,
                  range: OPEN_DATE_RANGE,
                  t,
                })
              }
            />
            <Button variant="secondary" onClick={() => void refresh()} title={t("common.refresh")}>
              ⟳
            </Button>
          </>
        }
      />

      <div className="mb-4 grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        <StatTile label={t("shifts.closedShifts")} value={String(closedShifts.length)} tone="primary" />
        <StatTile label={t("shifts.salesTotal")} value={money(totals.sales)} tone="info" />
        <StatTile label={t("shifts.expensesTotal")} value={money(totals.expenses)} tone="warning" />
        <StatTile
          label={t("shifts.netDifference")}
          value={money(totals.difference)}
          tone={differenceTone(totals.difference)}
          hint={t("shifts.netDifferenceHint")}
        />
      </div>

      <p className="mb-4 text-xs font-medium text-slate-600">
        <Link to="/shifts/eod" className="font-semibold text-[#b08d57] hover:text-[#8c6b3a]">
          {t("shifts.eodLink")} →
        </Link>{" "}
        {t("shifts.eodSubtitle")}
        <span className="mx-2 text-slate-300">·</span>
        <Link to="/reports/advanced" className="font-semibold text-indigo-600 hover:text-indigo-700">
          {t("shifts.advancedLink")} →
        </Link>{" "}
        {t("shifts.advancedHint")}
      </p>

      <Card className="mb-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <div className="w-full sm:max-w-md">
            <TextInput
              value={filters.search}
              leading={<SearchIcon />}
              onChange={(e) => setFilters((f) => ({ ...f, search: e.target.value }))}
              placeholder={t("shifts.searchPlaceholder")}
              aria-label={t("common.search")}
              type="search"
            />
          </div>
          <div className="w-full sm:w-48">
            <SelectInput
              value={filters.status}
              aria-label={t("shifts.status")}
              onChange={(e) =>
                setFilters((f) => ({ ...f, status: e.target.value as ShiftFiltersValue["status"] }))
              }
            >
              <option value="all">{t("shifts.allStatuses")}</option>
              <option value="closed">{t("shifts.statusClosed")}</option>
              <option value="open">{t("shifts.statusOpen")}</option>
            </SelectInput>
          </div>
        </div>
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
      ) : listedShifts.length === 0 ? (
        <Card>
          <EmptyState icon="🕒" title={t("shifts.emptyAll")} description={t("shifts.emptyAllHint")} />
        </Card>
      ) : (
        <div className="alyq-card overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-start text-[11px] font-bold uppercase tracking-wider text-slate-600">
                <th className="px-4 py-3 text-start font-semibold">{t("shifts.shiftNumber")}</th>
                <th className="px-3 py-3 text-start font-semibold">{t("shifts.cashier")}</th>
                <th className="px-3 py-3 text-start font-semibold">{t("shifts.openedBy")} / {t("shifts.closedBy")}</th>
                <th className="px-3 py-3 text-end font-semibold">{t("shifts.openingBalance")}</th>
                <th className="px-3 py-3 text-end font-semibold">{t("shifts.salesTotal")}</th>
                <th className="px-3 py-3 text-end font-semibold">{t("shifts.expensesTotal")}</th>
                <th className="px-3 py-3 text-end font-semibold">{t("shifts.expectedCash")}</th>
                <th className="px-3 py-3 text-end font-semibold">{t("shifts.actualCash")}</th>
                <th className="px-3 py-3 text-center font-semibold">{t("shifts.difference")}</th>
                <th className="px-4 py-3 text-end font-semibold">{t("common.actions")}</th>
              </tr>
            </thead>
            <tbody>
              {listedShifts.map((shift) => {
                const summary = shift.summary ?? summaryFor(shift);
                return (
                  <tr key={shift.id} className="border-b border-slate-50 last:border-0 hover:bg-slate-50/60">
                    <td className="px-4 py-3">
                      <span className="font-mono text-xs font-bold text-indigo-700">{shift.shift_number}</span>
                      <p className="text-[11px] text-slate-500">{shift.branch} · {shift.register}</p>
                      <Badge tone={shift.status === "open" ? "warning" : "neutral"}>
                        {shift.status === "open" ? t("shifts.statusOpen") : t("shifts.statusClosed")}
                      </Badge>
                    </td>
                    <td className="px-3 py-3 text-xs text-slate-700">{shift.opened_by_name}</td>
                    <td className="px-3 py-3 text-[11px] text-slate-500" dir="ltr">
                      <div>{date(shift.opening_at)}</div>
                      <div>{shift.closed_at ? date(shift.closed_at) : "—"}</div>
                      <div className="text-slate-400">{shiftDuration(shift.opening_at, shift.closed_at)}</div>
                    </td>
                    <td className="px-3 py-3 text-end text-xs tabular-nums" dir="ltr">
                      {money(shift.opening_cash)}
                    </td>
                    <td className="px-3 py-3 text-end text-xs tabular-nums" dir="ltr">
                      {money(summary?.sales_total ?? 0)}
                    </td>
                    <td className="px-3 py-3 text-end text-xs tabular-nums" dir="ltr">
                      {money(summary?.expenses_total ?? 0)}
                    </td>
                    <td className="px-3 py-3 text-end text-xs font-bold tabular-nums" dir="ltr">
                      {money(summary?.expected_cash ?? 0)}
                    </td>
                    <td className="px-3 py-3 text-end text-xs font-bold tabular-nums" dir="ltr">
                      {shift.closing_cash === null ? "—" : money(shift.closing_cash)}
                    </td>
                    <td className="px-3 py-3 text-center">
                      <Badge tone={differenceTone(summary?.difference ?? null)}>
                        {shift.status === "open" || summary?.difference === null || summary?.difference === undefined
                          ? t("shifts.pendingOpen")
                          : `${num(summary.difference, 2)} · ${
                              summary.difference === 0
                                ? t("shifts.balanced")
                                : summary.difference > 0
                                  ? t("shifts.over")
                                  : t("shifts.short")
                            }`}
                      </Badge>
                      {shift.adjustment_approved_at ? (
                        <p className="mt-1 text-[10px] font-bold text-emerald-700">
                          {t("shifts.approvedTag")}
                        </p>
                      ) : null}
                    </td>
                    <td className="px-4 py-3 text-end">
                      <button
                        type="button"
                        onClick={() => setSelected(shift)}
                        className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-slate-600 hover:bg-slate-100"
                        title={t("shifts.viewDetails")}
                      >
                        <EyeIcon />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <Modal
        open={Boolean(selected)}
        onClose={() => setSelected(null)}
        size="lg"
        title={
          selected ? `${t("shifts.shiftDetails")} · ${selected.shift_number}` : t("shifts.shiftDetails")
        }
        footer={
          <>
            {selected && canApprove && !selected.adjustment_approved_at && selected.summary?.difference ? (
              <Button onClick={() => void approve()} disabled={approving}>
                {approving ? t("common.saving") : t("shifts.approveAdjustment")}
              </Button>
            ) : null}
            {selected && selectedSummary ? (
              <ExportButton
                name={`shift-${selected.shift_number}`}
                authority="report"
                count={1}
                build={() =>
                  buildShiftDetailSheets({
                    shift: selected,
                    summary: selectedSummary,
                    expenses: selectedExpenses,
                    t,
                  })
                }
              />
            ) : null}
            <Button variant="secondary" onClick={() => setSelected(null)}>
              {t("common.close")}
            </Button>
          </>
        }
      >
        {selected && selectedSummary ? (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <div className="rounded-xl bg-slate-50 px-3 py-2">
                <p className="text-[11px] font-bold text-slate-600">{t("shifts.branch")}</p>
                <p className="text-xs font-bold text-slate-900">{selected.branch}</p>
              </div>
              <div className="rounded-xl bg-slate-50 px-3 py-2">
                <p className="text-[11px] font-bold text-slate-600">{t("shifts.register")}</p>
                <p className="text-xs font-bold text-slate-900">{selected.register}</p>
              </div>
              <div className="rounded-xl bg-slate-50 px-3 py-2">
                <p className="text-[11px] font-bold text-slate-600">{t("shifts.openedBy")}</p>
                <p className="text-xs font-bold text-slate-900">{selected.opened_by_name}</p>
                <p className="text-[11px] text-slate-500" dir="ltr">{date(selected.opening_at)}</p>
              </div>
              <div className="rounded-xl bg-slate-50 px-3 py-2">
                <p className="text-[11px] font-bold text-slate-600">{t("shifts.closedBy")}</p>
                <p className="text-xs font-bold text-slate-900">{selected.closed_by_name ?? "—"}</p>
                <p className="text-[11px] text-slate-500" dir="ltr">
                  {selected.closed_at ? date(selected.closed_at) : "—"}
                </p>
              </div>
            </div>

            <p className="text-[11px] text-slate-500">
              {t("shifts.duration")}: {shiftDuration(selected.opening_at, selected.closed_at)} ·{" "}
              {t("shifts.frozenNotice")}
            </p>

            <ShiftSummaryGrid summary={selectedSummary} />

            {selected.notes ? (
              <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2">
                <p className="text-[11px] font-bold text-amber-800">{t("shifts.notes")}</p>
                <p className="text-xs text-amber-900">{selected.notes}</p>
              </div>
            ) : null}

            <div>
              <p className="mb-2 text-xs font-bold text-slate-700">
                {t("shifts.expensesInShift")} ({num(selectedExpenses.length)})
              </p>
              {selectedExpenses.length === 0 ? (
                <p className="text-xs text-slate-500">{t("shifts.noExpensesYet")}</p>
              ) : (
                <div className="overflow-x-auto rounded-xl border border-slate-200">
                  <table className="w-full border-collapse text-xs">
                    <thead>
                      <tr className="bg-slate-50 text-[11px] font-bold uppercase tracking-wide text-slate-600">
                        <th className="px-3 py-2 text-start font-semibold">{t("expenses.expenseNumber")}</th>
                        <th className="px-3 py-2 text-start font-semibold">{t("expenses.name")}</th>
                        <th className="px-3 py-2 text-start font-semibold">{t("expenses.category")}</th>
                        <th className="px-3 py-2 text-start font-semibold">{t("expenses.method")}</th>
                        <th className="px-3 py-2 text-end font-semibold">{t("expenses.amount")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {selectedExpenses.map((expense) => (
                        <tr key={expense.id} className="border-t border-slate-100">
                          <td className="px-3 py-2 font-mono font-bold text-amber-700">
                            {expense.expense_number}
                          </td>
                          <td className="px-3 py-2 text-slate-800">{expense.name}</td>
                          <td className="px-3 py-2">
                            {t(`expenses.category.${expense.category}` as Parameters<typeof t>[0])}
                          </td>
                          <td className="px-3 py-2">
                            {t(`pos.payment.${expense.payment_method}` as Parameters<typeof t>[0])}
                          </td>
                          <td className="px-3 py-2 text-end font-bold tabular-nums" dir="ltr">
                            {money(expense.amount)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {selected.adjustment_approved_at ? (
              <Badge tone="success">
                {t("shifts.approvedTag")} · {selected.adjustment_approved_by_name} ·{" "}
                {date(selected.adjustment_approved_at)}
              </Badge>
            ) : selected.summary?.difference ? (
              <Badge tone="warning">{t("shifts.pendingApproval")}</Badge>
            ) : null}

            {actionError ? (
              <p className="rounded-xl bg-rose-50 px-3 py-2 text-xs text-rose-700">{actionError}</p>
            ) : null}
          </div>
        ) : null}
      </Modal>
    </div>
  );
}
