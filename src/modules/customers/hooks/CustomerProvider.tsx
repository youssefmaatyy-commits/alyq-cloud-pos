import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { Customer } from "../types";
import { getCustomerMode, getCustomerRepository } from "../data";
import type { CustomerRepository } from "../data/repository";
import {
  deleteCustomer as deleteCustomerService,
  loadCustomers,
  saveCustomer as saveCustomerService,
} from "../services/customerService";
import type { CustomerFormValues } from "../validation";
import { AppError } from "@/modules/products/data/repository";

export interface CustomerContextValue {
  mode: "supabase" | "demo";
  repository: CustomerRepository;
  customers: Customer[];
  loading: boolean;
  error: AppError | null;
  refresh: () => Promise<void>;
  saveCustomer: (
    values: CustomerFormValues,
    currentId?: string,
  ) => Promise<{ customer: Customer; isNew: boolean }>;
  deleteCustomer: (id: string) => Promise<void>;
  customerById: (id: string | null | undefined) => Customer | undefined;
}

const CustomerContext = createContext<CustomerContextValue | null>(null);

export function CustomerProvider({ children }: { children: ReactNode }) {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<AppError | null>(null);

  const repository = useMemo(() => getCustomerRepository(), []);
  const mode = useMemo(() => getCustomerMode(), []);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await loadCustomers();
      setCustomers(list);
    } catch (err) {
      setError(err instanceof AppError ? err : new AppError("DB", String(err)));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const saveCustomer = useCallback(
    async (values: CustomerFormValues, currentId?: string) => {
      const result = await saveCustomerService(values, customers, currentId);
      await refresh();
      return result;
    },
    [customers, refresh],
  );

  const deleteCustomer = useCallback(
    async (id: string) => {
      await deleteCustomerService(id);
      await refresh();
    },
    [refresh],
  );

  const customerById = useCallback(
    (id: string | null | undefined) => (id ? customers.find((c) => c.id === id) : undefined),
    [customers],
  );

  const value = useMemo<CustomerContextValue>(
    () => ({
      mode,
      repository,
      customers,
      loading,
      error,
      refresh,
      saveCustomer,
      deleteCustomer,
      customerById,
    }),
    [mode, repository, customers, loading, error, refresh, saveCustomer, deleteCustomer, customerById],
  );

  return <CustomerContext.Provider value={value}>{children}</CustomerContext.Provider>;
}

export function useCustomers(): CustomerContextValue {
  const ctx = useContext(CustomerContext);
  if (!ctx) throw new Error("useCustomers must be used inside <CustomerProvider>");
  return ctx;
}
