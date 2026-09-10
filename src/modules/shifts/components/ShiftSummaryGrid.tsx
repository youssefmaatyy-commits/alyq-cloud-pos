import { useI18n } from "@/lib/i18n/I18nProvider";
import { Badge } from "@/components/ui";
import type { ShiftSummary } from "../types";
import { differenceTone } from "../services/shiftCalculations";

interface Row {
  key: string;
  labelKey: string;
  value: number;
  hintKey?: string;
}

/**
 * The shift Z-report grid: every money bucket the shift accumulated, grouped
 * the way a cashier reads it (drawer first, then non-cash, then adjustments).
 */
export function ShiftSummaryGrid({ summary, compact }: { summary: ShiftSummary; compact?: boolean }) {
  const { t, money, num } = useI18n();

  const salesRows: Row[] = [
    { key: "sales", labelKey: "shifts.salesTotal", value: summary.sales_total, hintKey: "shifts.salesCountHint" },
    { key: "cash", labelKey: "shifts.cashSales", value: summary.cash_sales },
    { key: "instapay", labelKey: "shifts.instapaySales", value: summary.instapay_sales },
  ];

  const outRows: Row[] = [
    { key: "returns", labelKey: "shifts.returnsTotal", value: summary.returns_total, hintKey: "shifts.returnsCountHint" },
    { key: "refunds", labelKey: "shifts.refundsTotal", value: summary.refunds_total, hintKey: "shifts.refundsCountHint" },
    { key: "cashRefunds", labelKey: "shifts.cashRefunds", value: summary.cash_refunds },
    { key: "expenses", labelKey: "shifts.expensesTotal", value: summary.expenses_total, hintKey: "shifts.expensesCountHint" },
    { key: "cashExpenses", labelKey: "shifts.cashExpenses", value: summary.cash_expenses },
  ];

  const counts: Record<string, number> = {
    "shifts.salesCountHint": summary.sales_count,
    "shifts.returnsCountHint": summary.returns_count,
    "shifts.refundsCountHint": summary.refunds_count,
    "shifts.expensesCountHint": summary.expenses_count,
  };

  function renderRows(rows: Row[]) {
    return rows.map((row) => (
      <div
        key={row.key}
        className="flex items-center justify-between gap-2 border-b border-slate-50 py-1.5 last:border-0"
      >
        <span className="text-xs font-medium text-slate-600">
          {t(row.labelKey as Parameters<typeof t>[0])}
          {row.hintKey ? (
            <span className="ms-1 text-[11px] text-slate-400">
              ({num(counts[row.hintKey] ?? 0)})
            </span>
          ) : null}
        </span>
        <span className="text-xs font-bold tabular-nums text-slate-900" dir="ltr">
          {money(row.value)}
        </span>
      </div>
    ));
  }

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div className="rounded-xl border border-slate-200 p-3">
          <p className="mb-1 text-[11px] font-bold uppercase tracking-wide text-slate-500">
            {t("shifts.groupSales")}
          </p>
          {renderRows(salesRows)}
        </div>
        <div className="rounded-xl border border-slate-200 p-3">
          <p className="mb-1 text-[11px] font-bold uppercase tracking-wide text-slate-500">
            {t("shifts.groupOutflow")}
          </p>
          {renderRows(outRows)}
        </div>
        <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
          <p className="mb-1 text-[11px] font-bold uppercase tracking-wide text-slate-500">
            {t("shifts.groupDrawer")}
          </p>
          <div className="flex items-center justify-between gap-2 py-1.5">
            <span className="text-xs font-medium text-slate-600">{t("shifts.expectedCash")}</span>
            <span className="text-sm font-extrabold tabular-nums text-slate-900" dir="ltr">
              {money(summary.expected_cash)}
            </span>
          </div>
          <div className="flex items-center justify-between gap-2 py-1.5">
            <span className="text-xs font-medium text-slate-600">{t("shifts.actualCash")}</span>
            <span className="text-sm font-extrabold tabular-nums text-slate-900" dir="ltr">
              {summary.actual_cash === null ? "—" : money(summary.actual_cash)}
            </span>
          </div>
          <div className="flex items-center justify-between gap-2 border-t border-slate-200 pt-2">
            <span className="text-xs font-bold text-slate-700">{t("shifts.difference")}</span>
            <Badge tone={differenceTone(summary.difference)}>
              {summary.difference === null
                ? "—"
                : `${money(summary.difference)} · ${
                    summary.difference === 0
                      ? t("shifts.balanced")
                      : summary.difference > 0
                        ? t("shifts.over")
                        : t("shifts.short")
                  }`}
            </Badge>
          </div>
        </div>
      </div>

      {!compact && (summary.mixed_count > 0 || summary.instapay_pending > 0 || summary.voided_count > 0) ? (
        <div className="flex flex-wrap gap-3 text-[11px] text-slate-600">
          {summary.mixed_count > 0 ? (
            <span className="rounded-lg bg-slate-100 px-2 py-1">
              {t("shifts.mixedPayments")}: {num(summary.mixed_count)} · {money(summary.mixed_total)}
            </span>
          ) : null}
          {summary.instapay_pending > 0 ? (
            <span className="rounded-lg bg-amber-50 px-2 py-1 text-amber-800">
              {t("shifts.pendingInstapay")}: {money(summary.instapay_pending)}
            </span>
          ) : null}
          {summary.voided_count > 0 ? (
            <span className="rounded-lg bg-rose-50 px-2 py-1 text-rose-800">
              {t("shifts.voidedSales")}: {num(summary.voided_count)} · {money(summary.voided_total)}
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
