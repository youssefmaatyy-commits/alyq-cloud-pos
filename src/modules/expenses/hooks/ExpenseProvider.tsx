import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { AppError } from "@/modules/products/data/repository";
import { getCurrentUser } from "@/modules/inventory/permissions";
import { recordAudit } from "@/modules/audit";
import { getExpenseRepository } from "../data";
import type { ExpenseRepository } from "../data/repository";
import { createExpense, deleteExpense, loadExpenses, updateExpense } from "../services/expenseService";
import type { Expense, ExpensePatch, NewExpense } from "../types";

export interface ExpenseContextValue {
  mode: "supabase" | "demo";
  repository: ExpenseRepository;
  expenses: Expense[];
  loading: boolean;
  error: AppError | null;
  refresh: () => Promise<void>;
  /** Create an expense and audit it. */
  addExpense: (input: Omit<NewExpense, "user_id" | "user_name">) => Promise<Expense>;
  editExpense: (id: string, patch: ExpensePatch) => Promise<Expense>;
  removeExpense: (id: string) => Promise<void>;
  expenseById: (id: string | null | undefined) => Expense | undefined;
}

const ExpenseContext = createContext<ExpenseContextValue | null>(null);

export function ExpenseProvider({ children }: { children: ReactNode }) {
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<AppError | null>(null);
  const repositoryRef = useRef<ExpenseRepository | null>(null);
  const repository = useMemo(() => {
    if (!repositoryRef.current) repositoryRef.current = getExpenseRepository();
    return repositoryRef.current;
  }, []);
  const mode = repository.kind;

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setExpenses(await loadExpenses());
      setError(null);
    } catch (err) {
      setError(err instanceof AppError ? err : new AppError("DB", String(err)));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Mirror of the list so callbacks can read a row without being re-created.
  const expensesRef = useRef<Expense[]>([]);
  useEffect(() => {
    expensesRef.current = expenses;
  }, [expenses]);

  const addExpense = useCallback(
    async (input: Omit<NewExpense, "user_id" | "user_name">) => {
      const user = getCurrentUser();
      const created = await createExpense({ ...input, user_id: user.id, user_name: user.name });
      setExpenses((prev) => [created, ...prev]);
      void recordAudit({
        action: "expense.created",
        entity: "expense",
        entity_id: created.id,
        entity_label: created.expense_number,
        details: {
          name: created.name,
          category: created.category,
          amount: created.amount,
          method: created.payment_method,
        },
        user_id: user.id,
        user_name: user.name,
      });
      return created;
    },
    [],
  );

  const editExpense = useCallback(async (id: string, patch: ExpensePatch) => {
    const updated = await updateExpense(id, patch);
    setExpenses((prev) => prev.map((e) => (e.id === id ? updated : e)));
    const user = getCurrentUser();
    void recordAudit({
      action: "expense.updated",
      entity: "expense",
      entity_id: updated.id,
      entity_label: updated.expense_number,
      details: {
        name: updated.name,
        amount: updated.amount,
        changes: Object.keys(patch).join(","),
      },
      user_id: user.id,
      user_name: user.name,
    });
    return updated;
  }, []);

  const removeExpense = useCallback(async (id: string) => {
    const snapshot = expensesRef.current.find((e) => e.id === id);
    await deleteExpense(id);
    setExpenses((prev) => prev.filter((e) => e.id !== id));
    const user = getCurrentUser();
    void recordAudit({
      action: "expense.deleted",
      entity: "expense",
      entity_id: id,
      entity_label: snapshot?.expense_number ?? id,
      details: { name: snapshot?.name ?? "", amount: snapshot?.amount ?? 0 },
      user_id: user.id,
      user_name: user.name,
    });
  }, []);

  const expenseById = useCallback(
    (id: string | null | undefined) => (id ? expenses.find((e) => e.id === id) : undefined),
    [expenses],
  );

  const value = useMemo<ExpenseContextValue>(
    () => ({
      mode,
      repository,
      expenses,
      loading,
      error,
      refresh,
      addExpense,
      editExpense,
      removeExpense,
      expenseById,
    }),
    [mode, repository, expenses, loading, error, refresh, addExpense, editExpense, removeExpense, expenseById],
  );

  return <ExpenseContext.Provider value={value}>{children}</ExpenseContext.Provider>;
}

export function useExpenses(): ExpenseContextValue {
  const ctx = useContext(ExpenseContext);
  if (!ctx) throw new Error("useExpenses must be used inside <ExpenseProvider>");
  return ctx;
}
