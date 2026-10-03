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
import type { ProductVariant } from "@/modules/products/variants";
import { compareVariants } from "@/modules/products/variants";
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
  /** Phase 43: every combination, display order — the breakdown rows. */
  variants: ProductVariant[];
  variantsByProduct: Map<string, ProductVariant[]>;
  loading: boolean;
  error: AppError | null;
  refresh: (options?: { silent?: boolean }) => Promise<void>;
  adjustStock: (args: {
    productId: string;
    /** The exact combination being corrected, when the product sells by variant. */
    variantId?: string | null;
    type: StockMovementType;
    reason: StockReason;
    quantity: number;
    notes: string | null;
    clientRef?: string;
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
  const [variants, setVariants] = useState<ProductVariant[]>([]);
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
      setVariants(snapshot.variants);
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
      variantId?: string | null;
      type: StockMovementType;
      reason: StockReason;
      quantity: number;
      notes: string | null;
      clientRef?: string;
    }) => {
      if (!canAdjustStock(user)) {
        throw Object.assign(new Error("FORBIDDEN"), { code: "FORBIDDEN" });
      }
      const result = await adjustStockService(args);
      // Optimistic: keep the local lists consistent without waiting for `refresh`.
      setProducts((prev) =>
        prev.map((p) => (p.id === result.product.id ? result.product : p)),
      );
      if (result.variant) {
        // The combination's own row moves too, so the breakdown is current.
        setVariants((prev) =>
          prev.map((v) => (v.id === result.variant!.id ? result.variant! : v)),
        );
      }
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

  const variantsByProduct = useMemo(() => {
    const grouped = new Map<string, ProductVariant[]>();
    for (const variant of variants) {
      const list = grouped.get(variant.product_id);
      if (list) list.push(variant);
      else grouped.set(variant.product_id, [variant]);
    }
    // Display order at the point of grouping, so every consumer renders the
    // same sequence: colour, then NUMERIC size.
    for (const list of grouped.values()) list.sort(compareVariants);
    return grouped;
  }, [variants]);

  const value = useMemo<InventoryContextValue>(
    () => ({
      mode,
      repository,
      products,
      movements,
      variants,
      variantsByProduct,
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
    [mode, repository, products, movements, variants, variantsByProduct, loading, error, refresh, adjustStock, productById, movementsForProduct, user, statusOf],
  );

  return <InventoryContext.Provider value={value}>{children}</InventoryContext.Provider>;
}

export function useInventory(): InventoryContextValue {
  const ctx = useContext(InventoryContext);
  if (!ctx) throw new Error("useInventory must be used inside <InventoryProvider>");
  return ctx;
}
