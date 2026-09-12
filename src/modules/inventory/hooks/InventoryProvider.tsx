import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { AppError } from "@/modules/products/data/repository";
import { stockStatus, type Product, type StockStatus } from "@/modules/products/types";
import { getInventoryMode, getInventoryRepository } from "../data";
import type { InventoryRepository } from "../data/repository";
import {
  adjustStock as adjustStockService,
  loadInventory,
  type InventoryAdjustmentResult,
} from "../services/inventoryService";
import { getCurrentUser, canAdjustStock, type InventoryUser } from "../permissions";
import { useAuth } from "@/lib/auth";
import { useRealtimeWatch } from "@/lib/supabase/useRealtimeWatch";
import type { StockMovement, StockMovementType, StockReason } from "../types";

export interface InventoryContextValue {
  mode: "supabase" | "demo";
  repository: InventoryRepository;
  products: Product[];
  movements: StockMovement[];
  loading: boolean;
  error: AppError | null;
  refresh: (options?: { silent?: boolean }) => Promise<void>;
  adjustStock: (args: {
    productId: string;
    type: StockMovementType;
    reason: StockReason;
    quantity: number;
    notes: string | null;
  }) => Promise<InventoryAdjustmentResult>;
  /** Convenience selectors. */
  productById: (id: string) => Product | undefined;
  movementsForProduct: (id: string) => StockMovement[];
  /**
   * Permission helpers. `user` is the signed-in user from the auth session
   * (Authentication phase) and changes only on sign-in / sign-out.
   */
  user: InventoryUser;
  canAdjust: boolean;
  /** Read-only derived status. */
  statusOf: (id: string) => StockStatus;
}

const InventoryContext = createContext<InventoryContextValue | null>(null);

/** Loads the inventory once and exposes validated mutations to the pages. */
export function InventoryProvider({ children }: { children: ReactNode }) {
  const [products, setProducts] = useState<Product[]>([]);
  const [movements, setMovements] = useState<StockMovement[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<AppError | null>(null);
  const { user: authUser } = useAuth();
  const user = useMemo<InventoryUser>(() => getCurrentUser(), [authUser]);

  const repository = useMemo(() => getInventoryRepository(), []);
  const mode = useMemo(() => getInventoryMode(), []);

  /**
   * Re-read.
   *
   * `silent` is what a realtime event asks for: the data is replaced without the
   * spinner, so a change made in another tab updates the numbers instead of
   * flashing a loading screen over somebody who is reading it.
   */
  const refresh = useCallback(async (options?: { silent?: boolean }) => {
    if (options?.silent !== true) setLoading(true);
    setError(null);
    try {
      const snapshot = await loadInventory();
      setProducts(snapshot.products);
      setMovements(snapshot.movements);
    } catch (err) {
      setError(err as AppError);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Phase 16: stock is the one number two tills disagree about fastest. A sale,
  // an adjustment or a repaired website hold (Phase 15) re-reads this provider,
  // so availability and the low-stock list follow the shelf rather than the last
  // time somebody opened the page.
  useRealtimeWatch(["products", "stock_movements"], () => refresh({ silent: true }));

  const adjustStock = useCallback(
    async (args: {
      productId: string;
      type: StockMovementType;
      reason: StockReason;
      quantity: number;
      notes: string | null;
    }) => {
      if (!canAdjustStock(user)) {
        throw Object.assign(new Error("FORBIDDEN"), { code: "FORBIDDEN" });
      }
      const result = await adjustStockService(args);
      // Optimistic: keep the local lists consistent without waiting for `refresh`.
      setProducts((prev) =>
        prev.map((p) => (p.id === result.product.id ? result.product : p)),
      );
      setMovements((prev) => [result.movement, ...prev]);
      return result;
    },
    [user],
  );

  const productById = useCallback(
    (id: string) => products.find((p) => p.id === id),
    [products],
  );

  const movementsForProduct = useCallback(
    (id: string) => movements.filter((m) => m.product_id === id),
    [movements],
  );

  const statusOf = useCallback(
    (id: string) => {
      const product = products.find((p) => p.id === id);
      if (!product) return "none" as StockStatus;
      return stockStatus(product);
    },
    [products],
  );

  const value = useMemo<InventoryContextValue>(
    () => ({
      mode,
      repository,
      products,
      movements,
      loading,
      error,
      refresh,
      adjustStock,
      productById,
      movementsForProduct,
      user,
      canAdjust: canAdjustStock(user),
      statusOf,
    }),
    [mode, repository, products, movements, loading, error, refresh, adjustStock, productById, movementsForProduct, user, statusOf],
  );

  return <InventoryContext.Provider value={value}>{children}</InventoryContext.Provider>;
}

export function useInventory(): InventoryContextValue {
  const ctx = useContext(InventoryContext);
  if (!ctx) throw new Error("useInventory must be used inside <InventoryProvider>");
  return ctx;
}
