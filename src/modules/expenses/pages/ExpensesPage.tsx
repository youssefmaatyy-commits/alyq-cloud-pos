import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { PageHeader } from "@/components/layout/AppShell";
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  ExportButton,
  LoadingBlock,
  PlusIcon,
  SearchIcon,
  SelectInput,
  StatTile,
  TextInput,
  useToast,
} from "@/components/ui";
import { useExpenses } from "../hooks/ExpenseProvider";
import { queryExpenses, summarizeExpenses } from "../services/expenseService";
import { ExpenseFormModal } from "../components/ExpenseFormModal";
import { buildExpensesSheets } from "../services/expensesExport";
import { useShifts } from "@/modules/shifts/hooks/ShiftProvider";
// The reports' picker, reused rather than reimplemented: it speaks the same
// `yyyy-mm-dd` window `queryExpenses` now filters on, presets included.
import { DateRangePicker } from "@/modules/reports/components/DateRangePicker";
import { canAddExpense, canDeleteExpense, canEditExpense } from "@/modules/shifts/permissions";
import {
  EMPTY_EXPENSE_FILTERS,
  EXPENSE_CATEGORIES,
  EXPENSE_PAYMENT_METHODS,
  type Expense,
  type ExpenseFiltersValue,
} from "../types";

export function ExpensesPage() {
  const { t, date, num, money } = useI18n();
  const toast = useToast();
  const { expenses, loading, error, refresh, removeExpense } = useExpenses();
  const { openShift } = useShifts();

  const [filters, setFilters] = useState<ExpenseFiltersValue>(EMPTY_EXPENSE_FILTERS);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Expense | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Expense | null>(null);
  const [deleting, setDeleting] = useState(false);

  const filtered = useMemo(() => queryExpenses(expenses, filters), [expenses, filters]);
  const summary = useMemo(() => summarizeExpenses(filtered), [filtered]);
  const shiftTotal = useMemo(() => {
    if (!openShift) return null;
    return expenses
      .filter((e) => e.shift_id === openShift.id)
      .reduce((sum, e) => sum + e.amount, 0);
  }, [expenses, openShift]);

  const canAdd = canAddExpense();
  const canEdit = canEditExpense();
  const canDelete = canDeleteExpense();

  async function confirmDelete() {
    if (!pendingDelete) return;
    setDeleting(true);
    try {
      await removeExpense(pendingDelete.id);
      toast.success(`${t("expenses.deletedToast")} · ${pendingDelete.expense_number}`);
      setPendingDelete(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div>
      <PageHeader
        title={t("expenses.title")}
        subtitle={t("expenses.subtitle")}
        actions={
          <>
            {/* Exports `filtered` — search, category and method filters applied. */}
            <ExportButton
              name="expenses"
              count={filtered.length}
              build={() => buildExpensesSheets({ expenses: filtered, t })}
            />
            <Button variant="secondary" onClick={() => void refresh()} title={t("common.retry")}>
              ⟳
            </Button>
            <Button
              onClick={() => {
                setEditing(null);
                setFormOpen(true);
              }}
              disabled={!canAdd}
            >
              <PlusIcon />
              {t("expenses.add")}
            </Button>
          </>
        }
      />

      <div className="mb-4 grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        <StatTile
          label={t("expenses.count")}
          value={num(summary.count)}
          tone="primary"
          hint={
            openShift
              ? `${t("expenses.currentShift")}: ${money(shiftTotal ?? 0)}`
              : t("expenses.noOpenShiftHint")
          }
        />
        <StatTile label={t("expenses.total")} value={money(summary.total)} tone="warning" />
        <StatTile label={t("expenses.cash")} value={money(summary.cash)} tone="success" />
        <StatTile label={t("expenses.instapay")} value={money(summary.instapay)} tone="info" />
      </div>

      <Card className="mb-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <div className="w-full sm:max-w-md">
            <TextInput
              value={filters.search}
              leading={<SearchIcon />}
              onChange={(e) => setFilters((f) => ({ ...f, search: e.target.value }))}
              placeholder={t("expenses.searchPlaceholder")}
              aria-label={t("common.search")}
              type="search"
            />
          </div>
          <div className="w-full sm:w-48">
            <SelectInput
              value={filters.category}
              aria-label={t("expenses.category")}
              onChange={(e) =>
                setFilters((f) => ({ ...f, category: e.target.value as ExpenseFiltersValue["category"] }))
              }
            >
              <option value="all">{t("expenses.allCategories")}</option>
              {EXPENSE_CATEGORIES.map((category) => (
                <option key={category} value={category}>
                  {t(`expenses.category.${category}` as Parameters<typeof t>[0])}
                </option>
              ))}
            </SelectInput>
          </div>
          <div className="w-full sm:w-48">
            <SelectInput
              value={filters.method}
              aria-label={t("expenses.method")}
              onChange={(e) =>
                setFilters((f) => ({ ...f, method: e.target.value as ExpenseFiltersValue["method"] }))
              }
            >
              <option value="all">{t("expenses.allMethods")}</option>
              {EXPENSE_PAYMENT_METHODS.map((method) => (
                <option key={method} value={method}>
                  {t(`pos.payment.${method}` as Parameters<typeof t>[0])}
                </option>
              ))}
            </SelectInput>
          </div>
        </div>

        {/* Date window (Phase 14, requirement 3). It feeds `filtered`, so the
            tiles, the table and the export button all read the same span. */}
        <div className="mt-3 border-t border-slate-100 pt-3">
          <DateRangePicker
            value={{ from: filters.from, to: filters.to }}
            onChange={(next) => setFilters((f) => ({ ...f, from: next.from, to: next.to }))}
          />
        </div>

        <p className="mt-3 text-xs font-medium text-slate-600">
          <Link
            to="/reports/advanced"
            className="font-semibold text-indigo-600 hover:text-indigo-700"
          >
            {t("expenses.advancedLink")} →
          </Link>{" "}
          {t("expenses.advancedHint")}
        </p>
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
      ) : filtered.length === 0 ? (
        <Card>
          <EmptyState
            icon="🧾"
            title={t("expenses.empty")}
            description={t("expenses.emptyHint")}
            action={
              <Button
                onClick={() => {
                  setEditing(null);
                  setFormOpen(true);
                }}
              >
                <PlusIcon />
                {t("expenses.add")}
              </Button>
            }
          />
        </Card>
      ) : (
        <div className="alyq-card overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-start text-[11px] font-bold uppercase tracking-wider text-slate-600">
                <th className="px-4 py-3 text-start font-semibold">{t("expenses.expenseNumber")}</th>
                <th className="px-3 py-3 text-start font-semibold">{t("expenses.name")}</th>
                <th className="px-3 py-3 text-start font-semibold">{t("expenses.category")}</th>
                <th className="px-3 py-3 text-end font-semibold">{t("expenses.amount")}</th>
                <th className="px-3 py-3 text-start font-semibold">{t("expenses.method")}</th>
                <th className="px-3 py-3 text-start font-semibold">{t("expenses.date")}</th>
                <th className="px-3 py-3 text-start font-semibold">{t("expenses.user")}</th>
                <th className="px-3 py-3 text-start font-semibold">{t("expenses.shift")}</th>
                <th className="px-4 py-3 text-end font-semibold">{t("common.actions")}</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((expense) => (
                <tr key={expense.id} className="border-b border-slate-50 last:border-0 hover:bg-slate-50/60">
                  <td className="px-4 py-3 font-mono text-xs font-bold text-amber-700">
                    {expense.expense_number}
                  </td>
                  <td className="px-3 py-3 text-xs text-slate-800">
                    <span className="font-semibold">{expense.name}</span>
                    {expense.notes ? (
                      <p className="mt-0.5 max-w-xs truncate text-[11px] text-slate-500">{expense.notes}</p>
                    ) : null}
                    {expense.attachment_url ? (
                      <a
                        href={expense.attachment_url}
                        target="_blank"
                        rel="noreferrer"
                        className="text-[11px] font-bold text-indigo-700 hover:underline"
                      >
                        {t("expenses.attachment")}
                        {expense.attachment_name ? ` · ${expense.attachment_name}` : ""}
                      </a>
                    ) : null}
                  </td>
                  <td className="px-3 py-3 text-xs">
                    <Badge tone="neutral">
                      {t(`expenses.category.${expense.category}` as Parameters<typeof t>[0])}
                    </Badge>
                  </td>
                  <td className="px-3 py-3 text-end text-sm font-bold tabular-nums text-slate-900" dir="ltr">
                    {money(expense.amount)}
                  </td>
                  <td className="px-3 py-3 text-xs">
                    <Badge tone={expense.payment_method === "cash" ? "success" : "info"}>
                      {t(`pos.payment.${expense.payment_method}` as Parameters<typeof t>[0])}
                    </Badge>
                  </td>
                  <td className="px-3 py-3 text-xs text-slate-500" dir="ltr">
                    {date(expense.spent_at)}
                  </td>
                  <td className="px-3 py-3 text-xs text-slate-600">
                    {expense.user_name}
                    <p className="text-[11px] text-slate-400">{expense.branch ?? "—"}</p>
                  </td>
                  <td className="px-3 py-3 text-xs">
                    {expense.shift_id ? (
                      <span className="font-mono text-[11px] text-slate-600">
                        {expense.shift_id === openShift?.id
                          ? t("expenses.currentShiftTag")
                          : expense.shift_id.slice(0, 10)}
                      </span>
                    ) : (
                      <span className="text-slate-400">{t("expenses.noShift")}</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={!canEdit}
                        onClick={() => {
                          setEditing(expense);
                          setFormOpen(true);
                        }}
                      >
                        {t("common.edit")}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={!canDelete}
                        className="text-rose-600 hover:bg-rose-50"
                        onClick={() => setPendingDelete(expense)}
                      >
                        {t("common.delete")}
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <ExpenseFormModal
        open={formOpen}
        expense={editing}
        onClose={() => {
          setFormOpen(false);
          setEditing(null);
        }}
      />

      <ConfirmDialog
        open={Boolean(pendingDelete)}
        title={t("expenses.deleteConfirm")}
        body={t("expenses.deleteConfirmHint")}
        confirmLabel={t("common.delete")}
        cancelLabel={t("common.cancel")}
        tone="danger"
        onConfirm={() => void confirmDelete()}
        onCancel={() => setPendingDelete(null)}
        loading={deleting}
      />
    </div>
  );
}
