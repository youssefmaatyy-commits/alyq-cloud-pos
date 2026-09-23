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
  LoadingBlock,
  PlusIcon,
  SectionTitle,
  StatTile,
} from "@/components/ui";
import { useShifts } from "../hooks/ShiftProvider";
import { OpenShiftModal } from "../components/OpenShiftModal";
import { CloseShiftModal } from "../components/CloseShiftModal";
import { ShiftSummaryGrid } from "../components/ShiftSummaryGrid";
import { shiftWindowOf } from "../services/shiftCalculations";
import { shiftDuration } from "../services/shiftService";
import { canAddExpense } from "../permissions";

/** Link styled like a secondary button (Button is a <button>, not an <a>). */
const GHOST_LINK =
  "inline-flex h-10 shrink-0 items-center justify-center rounded-xl px-4 text-sm text-slate-700 transition-colors hover:bg-slate-100";

export function ShiftDashboardPage() {
  const { t, date, num, money } = useI18n();
  const { openShift, currentSummary, loading, error, refresh, expensesFor, canOpen, canClose } = useShifts();

  const [openModal, setOpenModal] = useState(false);
  const [closeModal, setCloseModal] = useState(false);

  const shiftExpenses = useMemo(() => expensesFor(openShift), [expensesFor, openShift]);
  const recentExpenses = useMemo(
    () => [...shiftExpenses].sort((a, b) => b.spent_at.localeCompare(a.spent_at)).slice(0, 5),
    [shiftExpenses],
  );

  if (error) {
    return (
      <div>
        <PageHeader title={t("shifts.dashboardTitle")} subtitle={t("shifts.dashboardSubtitle")} />
        <ErrorState
          title={t("common.error")}
          message={error.message}
          retryLabel={t("common.retry")}
          onRetry={() => void refresh()}
        />
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title={t("shifts.dashboardTitle")}
        subtitle={t("shifts.dashboardSubtitle")}
        actions={
          <>
            <Button variant="secondary" onClick={() => void refresh()} title={t("common.refresh")}>
              ⟳
            </Button>
            <Link to="/shifts/eod" className={GHOST_LINK}>
              {t("shifts.eodLink")}
            </Link>
            <Link to="/shifts/history" className={GHOST_LINK}>
              {t("shifts.historyTitle")}
            </Link>
            {openShift && canClose ? (
              <Button onClick={() => setCloseModal(true)}>{t("shifts.close")}</Button>
            ) : null}
            {!openShift && canOpen ? (
              <Button onClick={() => setOpenModal(true)}>
                <PlusIcon />
                {t("shifts.open")}
              </Button>
            ) : null}
          </>
        }
      />

      {loading ? (
        <div className="alyq-card">
          <LoadingBlock label={t("common.loading")} />
        </div>
      ) : !openShift || !currentSummary ? (
        <Card>
          <EmptyState
            icon="🧾"
            title={t("shifts.noOpenShift")}
            description={t("shifts.noOpenShiftHint")}
            action={
              canOpen ? (
                <Button onClick={() => setOpenModal(true)}>
                  <PlusIcon />
                  {t("shifts.open")}
                </Button>
              ) : undefined
            }
          />
        </Card>
      ) : (
        <>
          {/* Live KPIs — current shift */}
          <div className="mb-4 grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-5">
            <StatTile
              label={t("shifts.cashier")}
              value={openShift.opened_by_name}
              hint={`${openShift.branch} · ${openShift.register}`}
              tone="primary"
            />
            <StatTile
              label={t("shifts.openingBalance")}
              value={money(openShift.opening_cash)}
              hint={`${t("shifts.openingAt")}: ${date(openShift.opening_at)}`}
            />
            <StatTile
              label={t("shifts.currentSales")}
              value={money(currentSummary.sales_total)}
              hint={`${num(currentSummary.sales_count)} · ${t("shifts.cashSales")} ${money(currentSummary.cash_sales)}`}
              tone="info"
            />
            <StatTile
              label={t("shifts.currentExpenses")}
              value={money(currentSummary.expenses_total)}
              hint={`${num(currentSummary.expenses_count)} · ${t("shifts.cashExpenses")} ${money(currentSummary.cash_expenses)}`}
              tone="warning"
            />
            <StatTile
              label={t("shifts.expectedCash")}
              value={money(currentSummary.expected_cash)}
              hint={t("shifts.expectedCashHint")}
              tone="success"
            />
          </div>

          <div className="mb-4 flex flex-wrap items-center gap-2">
            <Badge tone="success">{t("shifts.statusOpen")}</Badge>
            <span className="font-mono text-xs font-bold text-indigo-700">{openShift.shift_number}</span>
            <span className="text-xs text-slate-500">
              {t("shifts.duration")}: {shiftDuration(openShift.opening_at, null)}
            </span>
            <span className="text-xs text-slate-500">{t("shifts.liveNotice")}</span>
          </div>

          <Card className="mb-4">
            <SectionTitle
              aside={
                canAddExpense() ? (
                  <Link to="/expenses" className={GHOST_LINK}>
                    {t("expenses.add")}
                  </Link>
                ) : undefined
              }
            >
              {t("shifts.summary")}
            </SectionTitle>
            <ShiftSummaryGrid summary={currentSummary} />
          </Card>

          <Card>
            <SectionTitle
              aside={
                <Link to="/expenses" className="text-xs font-bold text-indigo-700 hover:underline">
                  {t("expenses.title")}
                </Link>
              }
            >
              {t("shifts.expensesInShift")}
            </SectionTitle>
            {recentExpenses.length === 0 ? (
              <p className="py-3 text-xs text-slate-500">{t("shifts.noExpensesYet")}</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-sm">
                  <thead>
                    <tr className="border-b border-slate-200 text-start text-[11px] font-bold uppercase tracking-wider text-slate-600">
                      <th className="py-2 text-start font-semibold">{t("expenses.expenseNumber")}</th>
                      <th className="py-2 text-start font-semibold">{t("expenses.name")}</th>
                      <th className="py-2 text-start font-semibold">{t("expenses.category")}</th>
                      <th className="py-2 text-start font-semibold">{t("expenses.method")}</th>
                      <th className="py-2 text-end font-semibold">{t("expenses.amount")}</th>
                      <th className="py-2 text-start font-semibold">{t("expenses.date")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recentExpenses.map((expense) => (
                      <tr key={expense.id} className="border-b border-slate-50 last:border-0">
                        <td className="py-2 font-mono text-xs font-bold text-amber-700">
                          {expense.expense_number}
                        </td>
                        <td className="py-2 text-xs text-slate-800">{expense.name}</td>
                        <td className="py-2 text-xs">
                          <Badge tone="neutral">
                            {t(`expenses.category.${expense.category}` as Parameters<typeof t>[0])}
                          </Badge>
                        </td>
                        <td className="py-2 text-xs">
                          <Badge tone={expense.payment_method === "cash" ? "success" : "info"}>
                            {t(`pos.payment.${expense.payment_method}` as Parameters<typeof t>[0])}
                          </Badge>
                        </td>
                        <td className="py-2 text-end text-xs font-bold tabular-nums" dir="ltr">
                          {money(expense.amount)}
                        </td>
                        <td className="py-2 text-xs text-slate-500" dir="ltr">
                          {date(expense.spent_at)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <p className="mt-3 text-[11px] text-slate-400">
            {t("shifts.windowHint", {
              start: date(shiftWindowOf(openShift).start),
            })}
          </p>
        </>
      )}

      <OpenShiftModal open={openModal} onClose={() => setOpenModal(false)} />
      <CloseShiftModal shift={openShift} open={closeModal} onClose={() => setCloseModal(false)} />
    </div>
  );
}
