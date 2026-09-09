import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { CreateReturnInput, RefundRecord, SalesReturn } from "../types";
import { getReturnMode, getReturnRepository } from "../data";
import type { ReturnRepository } from "../data/repository";
import {
  loadRefunds,
  loadReturns,
  processReturn,
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
  createReturn: (
    input: CreateReturnInput,
  ) => Promise<{ returnRecord: SalesReturn; refundRecord: RefundRecord }>;
  getReturnsForSale: (saleId: string) => SalesReturn[];
  getRefundsForSale: (saleId: string) => RefundRecord[];
  returnById: (id: string | null | undefined) => SalesReturn | undefined;
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
      getReturnsForSale,
      getRefundsForSale,
      returnById,
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
      getReturnsForSale,
      getRefundsForSale,
      returnById,
    ],
  );

  return <ReturnContext.Provider value={value}>{children}</ReturnContext.Provider>;
}

export function useReturns(): ReturnContextValue {
  const ctx = useContext(ReturnContext);
  if (!ctx) throw new Error("useReturns must be used inside <ReturnProvider>");
  return ctx;
}
