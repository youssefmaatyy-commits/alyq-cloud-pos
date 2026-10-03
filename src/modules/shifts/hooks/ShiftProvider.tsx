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
import { useInventory } from "@/modules/inventory/hooks/InventoryProvider";
import { usePos } from "@/modules/pos/hooks/PosProvider";
import { useReturns } from "@/modules/returns/hooks/ReturnProvider";
import { useExpenses } from "@/modules/expenses/hooks/ExpenseProvider";
import type { Expense } from "@/modules/expenses/types";
import { recordAudit } from "@/modules/audit";
import { getShiftRepository } from "../data";
import type { ShiftRepository } from "../data/repository";
import {
  approveShiftAdjustment,
  closeShift as closeShiftRequest,
  loadShifts,
  openShift as openShiftRequest,
  queryShifts,
} from "../services/shiftService";
import { computeShiftSummary, padShiftSummary } from "../services/shiftCalculations";
import type {
  CloseShiftInput,
  NewShift,
  Shift,
  ShiftFiltersValue,
  ShiftSummary,
} from "../types";
import {
  canAddExpense,
  canApproveAdjustment,
  canCloseShift,
  canOpenShift,
  canViewAllShifts,
} from "../permissions";

export interface ShiftContextValue {
  mode: "supabase" | "demo";
  repository: ShiftRepository;
  shifts: Shift[];
  /** The shift currently in progress, if any. */
  openShift: Shift | null;
  loading: boolean;
  error: AppError | null;
  refresh: () => Promise<void>;

  /** Live summary for any shift (open shifts recompute on every data change). */
  summaryFor: (shift: Shift | null | undefined) => ShiftSummary | null;
  /** Live summary of the open shift (null when no shift is open). */
  currentSummary: ShiftSummary | null;
  /** Expenses that belong to a given shift. */
  expensesFor: (shift: Shift | null | undefined) => Expense[];

  openShiftAction: (input: Omit<NewShift, "opened_by" | "opened_by_name">) => Promise<Shift>;
  closeShiftAction: (shift: Shift, input: Omit<CloseShiftInput, "summary">) => Promise<Shift>;
  approveAdjustment: (shift: Shift) => Promise<Shift>;
  filterShifts: (filters: ShiftFiltersValue) => Shift[];

  canOpen: boolean;
  canClose: boolean;
  canAddExpense: boolean;
  canViewAll: boolean;
  canApprove: boolean;
}

const ShiftContext = createContext<ShiftContextValue | null>(null);

export function ShiftProvider({ children }: { children: ReactNode }) {
  const { sales, refreshSales } = usePos();
  const { returnsList, refundsList, refresh: refreshReturns } = useReturns();
  const { expenses, refresh: refreshExpenses } = useExpenses();
  const { user } = useInventory();

  const [shifts, setShifts] = useState<Shift[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<AppError | null>(null);

  const repositoryRef = useRef<ShiftRepository | null>(null);
  const repository = useMemo(() => {
    if (!repositoryRef.current) repositoryRef.current = getShiftRepository();
    return repositoryRef.current;
  }, []);
  const mode = repository.kind;

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setShifts(await loadShifts());
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

  /** Pull every source the shift math depends on. */
  const refreshAll = useCallback(async () => {
    await Promise.all([refresh(), refreshSales(), refreshReturns(), refreshExpenses()]);
  }, [refresh, refreshSales, refreshReturns, refreshExpenses]);

  const sources = useMemo(
    () => ({ sales, returns: returnsList, refunds: refundsList, expenses }),
    [sales, returnsList, refundsList, expenses],
  );

  const summaryFor = useCallback(
    (shift: Shift | null | undefined): ShiftSummary | null => {
      if (!shift) return null;
      // A closed shift shows its frozen snapshot; an open one is recomputed
      // live from the sales/returns/refunds/expenses currently loaded.
      if (shift.status === "closed" && shift.summary) return padShiftSummary(shift.summary);
      return computeShiftSummary(shift, sources);
    },
    [sources],
  );

  const openShift = useMemo(() => shifts.find((s) => s.status === "open") ?? null, [shifts]);
  const currentSummary = useMemo(() => summaryFor(openShift), [summaryFor, openShift]);

  const expensesFor = useCallback(
    (shift: Shift | null | undefined) => {
      if (!shift) return [];
      if (shift.status === "closed" && shift.summary) {
        return expenses.filter((e) => e.shift_id === shift.id);
      }
      return expenses.filter((e) => {
        if (e.shift_id) return e.shift_id === shift.id;
        const t = new Date(e.spent_at).getTime();
        const start = new Date(shift.opening_at).getTime();
        const end = shift.closed_at ? new Date(shift.closed_at).getTime() : Number.POSITIVE_INFINITY;
        return t >= start && t < end;
      });
    },
    [expenses],
  );

  const openShiftAction = useCallback(
    async (input: Omit<NewShift, "opened_by" | "opened_by_name">) => {
      const user = getCurrentUser();
      const created = await openShiftRequest({
        ...input,
        opened_by: user.id,
        opened_by_name: user.name,
      });
      setShifts((prev) => [created, ...prev]);
      void recordAudit({
        action: "shift.opened",
        entity: "shift",
        entity_id: created.id,
        entity_label: created.shift_number,
        details: {
          branch: created.branch,
          register: created.register,
          opening_cash: created.opening_cash,
        },
        user_id: user.id,
        user_name: user.name,
      });
      return created;
    },
    [],
  );

  const closeShiftAction = useCallback(
    async (shift: Shift, input: Omit<CloseShiftInput, "summary">) => {
      const live = computeShiftSummary(shift, sources);
      const closed = await closeShiftRequest(shift.id, { ...input, summary: live });
      setShifts((prev) => prev.map((s) => (s.id === closed.id ? closed : s)));
      const user = getCurrentUser();
      // Live mode audits inside close_shift_authoritative() in the same locked
      // transaction as the frozen snapshot. Demo mode keeps its local trail.
      if (mode === "demo") void recordAudit({
        action: "shift.closed",
        entity: "shift",
        entity_id: closed.id,
        entity_label: closed.shift_number,
        details: {
          opening_cash: closed.opening_cash,
          cash_sales: live.cash_sales,
          cash_refunds: live.cash_refunds,
          cash_expenses: live.cash_expenses,
          expected_cash: live.expected_cash,
          actual_cash: closed.closing_cash,
          difference: closed.summary?.difference ?? 0,
          sales_total: live.sales_total,
          expenses_total: live.expenses_total,
        },
        user_id: user.id,
        user_name: user.name,
      });
      return closed;
    },
    [sources, mode],
  );

  const approveAdjustment = useCallback(async (shift: Shift) => {
    const user = getCurrentUser();
    const updated = await approveShiftAdjustment(shift.id, user.id, user.name);
    setShifts((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
    void recordAudit({
      action: "shift.adjustment.approved",
      entity: "shift",
      entity_id: updated.id,
      entity_label: updated.shift_number,
      details: {
        difference: updated.summary?.difference ?? 0,
        notes: updated.notes ?? "",
      },
      user_id: user.id,
      user_name: user.name,
    });
    return updated;
  }, []);

  const filterShifts = useCallback(
    (filters: ShiftFiltersValue) => queryShifts(shifts, filters),
    [shifts],
  );

  const value = useMemo<ShiftContextValue>(
    () => ({
      mode,
      repository,
      shifts,
      openShift,
      loading,
      error,
      refresh: refreshAll,
      summaryFor,
      currentSummary,
      expensesFor,
      openShiftAction,
      closeShiftAction,
      approveAdjustment,
      filterShifts,
      canOpen: canOpenShift(user),
      canClose: canCloseShift(user),
      canAddExpense: canAddExpense(user),
      canViewAll: canViewAllShifts(user),
      canApprove: canApproveAdjustment(user),
    }),
    [
      mode,
      repository,
      shifts,
      openShift,
      loading,
      error,
      refreshAll,
      summaryFor,
      currentSummary,
      expensesFor,
      openShiftAction,
      closeShiftAction,
      approveAdjustment,
      filterShifts,
      user,
    ],
  );

  return <ShiftContext.Provider value={value}>{children}</ShiftContext.Provider>;
}

export function useShifts(): ShiftContextValue {
  const ctx = useContext(ShiftContext);
  if (!ctx) throw new Error("useShifts must be used inside <ShiftProvider>");
  return ctx;
}
