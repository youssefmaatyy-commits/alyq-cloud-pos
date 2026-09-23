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
import { canAct } from "@/lib/permissions/enforce";

export interface CustomerContextValue {
  mode: "supabase" | "demo";
  repository: CustomerRepository;
  customers: Customer[];
  loading: boolean;
  error: AppError | null;
  /**
   * Phase 17: whether this seat may read the book at all. Consumers use it to
   * decline quietly rather than to render an error — the till's customer picker
   * disappears for a role without `view_customers`, and a sale simply proceeds
   * without one. The service still asserts the capability on every call; this
   * flag only saves the UI from asking for something it will be refused.
   */
  canView: boolean;
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
  // Read at render time so an identity change (a role swap, an exception saved
  // in another tab) is picked up when the provider next renders.
  const canView = canAct("view_customers");

  const refresh = useCallback(async () => {
    // Do not even ask when the answer is no: an empty list is the honest state
    // for a seat that may not read the book, and a permission error rendered as
    // a data failure would send somebody looking for a database problem.
    if (!canAct("view_customers")) {
      setCustomers([]);
      setError(null);
      setLoading(false);
      return;
    }
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
  }, [refresh, canView]);

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
      canView,
      refresh,
      saveCustomer,
      deleteCustomer,
      customerById,
    }),
    [mode, repository, customers, loading, error, canView, refresh, saveCustomer, deleteCustomer, customerById],
  );

  return <CustomerContext.Provider value={value}>{children}</CustomerContext.Provider>;
}

export function useCustomers(): CustomerContextValue {
  const ctx = useContext(CustomerContext);
  if (!ctx) throw new Error("useCustomers must be used inside <CustomerProvider>");
  return ctx;
}
