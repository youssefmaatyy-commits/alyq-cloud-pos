import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type {
  CreateReturnInput,
  RefundDecision,
  RefundRecord,
  SalesReturn,
  SettleRefundResult,
} from "../types";
import { getReturnMode, getReturnRepository } from "../data";
import type { ReturnRepository } from "../data/repository";
import {
  loadRefunds,
  loadReturns,
  processReturn,
  settleRefund as settleRefundRequest,
  type ProcessReturnResult,
} from "../services/returnService";
import { AppError } from "@/modules/products/data/repository";

export interface ReturnContextValue {
  mode: "supabase" | "demo";
  repository: ReturnRepository;
  returnsList: SalesReturn[];
  refundsList: RefundRecord[];
  loading: boolean;
  error: AppError | null;
  refresh: () => Promise<void>;
  /**
   * Record a return. `approvalRequest` is set when the refund crossed an
   * approval limit (Phase 12): the return still exists and the stock is still
   * right, but the refund opened `pending` and the money waits on a decision.
   */
  createReturn: (input: CreateReturnInput) => Promise<ProcessReturnResult>;
  /**
   * Complete or reject a pending refund. Throws FORBIDDEN when the acting user
   * lacks `approve_refund`, so callers show the message rather than guessing.
   */
  settleRefund: (
    refundId: string,
    decision: RefundDecision,
    reason: string | null,
  ) => Promise<SettleRefundResult>;
  getReturnsForSale: (saleId: string) => SalesReturn[];
  getRefundsForSale: (saleId: string) => RefundRecord[];
  returnById: (id: string | null | undefined) => SalesReturn | undefined;
  refundById: (id: string | null | undefined) => RefundRecord | undefined;
  /** Refunds still waiting on an approver — the dashboard and list both read it. */
  pendingRefunds: RefundRecord[];
}

const ReturnContext = createContext<ReturnContextValue | null>(null);

export function ReturnProvider({ children }: { children: ReactNode }) {
  const [returnsList, setReturnsList] = useState<SalesReturn[]>([]);
  const [refundsList, setRefundsList] = useState<RefundRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<AppError | null>(null);

  const repository = useMemo(() => getReturnRepository(), []);
  const mode = useMemo(() => getReturnMode(), []);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [rets, refs] = await Promise.all([loadReturns(), loadRefunds()]);
      setReturnsList(rets);
      setRefundsList(refs);
    } catch (err) {
      setError(err instanceof AppError ? err : new AppError("DB", String(err)));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const createReturn = useCallback(
    async (input: CreateReturnInput) => {
      const result = await processReturn(input);
      await refresh();
      return result;
    },
    [refresh],
  );

  const settleRefund = useCallback(
    async (refundId: string, decision: RefundDecision, reason: string | null) => {
      const outcome = await settleRefundRequest(refundId, decision, reason);
      await refresh();
      return outcome;
    },
    [refresh],
  );

  const getReturnsForSale = useCallback(
    (saleId: string) => returnsList.filter((r) => r.sale_id === saleId),
    [returnsList],
  );

  const getRefundsForSale = useCallback(
    (saleId: string) => refundsList.filter((r) => r.sale_id === saleId),
    [refundsList],
  );

  const returnById = useCallback(
    (id: string | null | undefined) => (id ? returnsList.find((r) => r.id === id) : undefined),
    [returnsList],
  );

  const refundById = useCallback(
    (id: string | null | undefined) => (id ? refundsList.find((r) => r.id === id) : undefined),
    [refundsList],
  );

  const pendingRefunds = useMemo(
    () => refundsList.filter((r) => r.status === "pending"),
    [refundsList],
  );

  const value = useMemo<ReturnContextValue>(
    () => ({
      mode,
      repository,
      returnsList,
      refundsList,
      loading,
      error,
      refresh,
      createReturn,
      settleRefund,
      getReturnsForSale,
      getRefundsForSale,
      returnById,
      refundById,
      pendingRefunds,
    }),
    [
      mode,
      repository,
      returnsList,
      refundsList,
      loading,
      error,
      refresh,
      createReturn,
      settleRefund,
      getReturnsForSale,
      getRefundsForSale,
      returnById,
      refundById,
      pendingRefunds,
    ],
  );

  return <ReturnContext.Provider value={value}>{children}</ReturnContext.Provider>;
}

export function useReturns(): ReturnContextValue {
  const ctx = useContext(ReturnContext);
  if (!ctx) throw new Error("useReturns must be used inside <ReturnProvider>");
  return ctx;
}
