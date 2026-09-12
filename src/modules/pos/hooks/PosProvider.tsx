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
import type { Product } from "@/modules/products/types";
import { AppError } from "@/modules/products/data/repository";
import { getDemoRepository } from "@/modules/products/data/demoRepository";
import { getSupabaseRepository } from "@/modules/products/data/supabaseRepository";
import { isSupabaseConfigured, getSupabaseClient } from "@/lib/supabase/client";
import { useRealtimeWatch } from "@/lib/supabase/useRealtimeWatch";
import { useInventory } from "@/modules/inventory/hooks/InventoryProvider";
import { canCompleteSale, canApplyDiscount } from "../permissions";
import { getSalesRepository, type SalesRepository } from "../data";
// Money moves through the service, not the repository: `completeSale` asserts
// `sell` (and `apply_discount` when the input carries one) before anything is
// written, which the provider's own `canSell` flag cannot do for a caller that
// never looked at it.
import { completeSale as completeSaleGuarded } from "../services/saleService";
import { isApprovalRequired, type ApprovalRequirement } from "@/modules/approvals";
import { cartTotals, validateDiscount, type CartTotals as Totals } from "../services/posMath";
import type {
  CartDiscount,
  CartLine,
  CompleteSaleInput,
  Sale as SaleModel,
  SalePaymentInput,
} from "../types";
import type { Customer } from "@/modules/customers/types";
import { EMPTY_DISCOUNT, newClientRef } from "../types";

export interface PosContextValue {
  mode: "supabase" | "demo";
  repository: SalesRepository;
  // catalog snapshot (re-used from products module load)
  products: Product[];
  loading: boolean;
  error: AppError | null;
  // cart
  lines: CartLine[];
  totals: Totals;
  discount: CartDiscount;
  isEmpty: boolean;
  selectedCustomer: Customer | null;
  setSelectedCustomer: (customer: Customer | null) => void;
  addLine: (product: Product) => void;
  addBySku: (skuOrBarcode: string) => boolean;
  increase: (productId: string) => void;
  decrease: (productId: string) => void;
  removeLine: (productId: string) => void;
  setDiscount: (discount: CartDiscount) => void;
  clearCart: () => void;
  // completion
  completing: boolean;
  completedSale: SaleModel | null;
  /**
   * Completes the sale, or returns `null` when the discount crossed an approval
   * limit and the draft was offered to the register as a request instead
   * (Phase 12). `approvalAsk` then carries the rule that fired and the exact
   * draft an approver will replay.
   */
  completeSale: (payments: SalePaymentInput[]) => Promise<SaleModel | null>;
  dismissCompleted: () => void;
  approvalAsk: { requirement: ApprovalRequirement; input: CompleteSaleInput } | null;
  dismissApprovalAsk: () => void;
  // history
  sales: SaleModel[];
  salesLoading: boolean;
  /**
   * Re-read the sales list. `silent` is for a background refresh — a sale written
   * at another till, arriving over the channel — which must not flash a spinner
   * over a screen somebody is reading.
   */
  refreshSales: (options?: { silent?: boolean }) => Promise<void>;
  // permissions
  canSell: boolean;
  canDiscount: boolean;
  /** Re-fetch the catalog (after a reset / stock change elsewhere). */
  reloadCatalog: () => Promise<unknown>;
}

const PosContext = createContext<PosContextValue | null>(null);

/** Loads the catalog once (same store as the products module) and owns the cart. */
export function PosProvider({ children }: { children: ReactNode }) {
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<AppError | null>(null);
  const [lines, setLines] = useState<CartLine[]>([]);
  const [discount, setDiscountValue] = useState<CartDiscount>(EMPTY_DISCOUNT);
  const [selectedCustomer, setSelectedCustomer] = useState<Customer | null>(null);
  const [completing, setCompleting] = useState(false);
  const [completedSale, setCompletedSale] = useState<SaleModel | null>(null);
  // Set when the discount cap refused a sale (Phase 12): the rule that fired and
  // the draft the register may send for approval.
  const [approvalAsk, setApprovalAsk] = useState<{
    requirement: ApprovalRequirement;
    input: CompleteSaleInput;
  } | null>(null);
  const [sales, setSales] = useState<SaleModel[]>([]);
  const [salesLoading, setSalesLoading] = useState(true);
  const repositoryRef = useRef<SalesRepository | null>(null);
  const repository = useMemo(() => {
    if (!repositoryRef.current) repositoryRef.current = getSalesRepository();
    return repositoryRef.current;
  }, []);
  const mode = repository.kind;

  // Use the live user from the inventory module so role changes (the
  // inventory role switcher, future auth) take effect on the till immediately.
  const { user } = useInventory();
  const canSell = canCompleteSale(user);
  const canDiscount = canApplyDiscount(user);

  // Catalog load — extracted so the POS page can refresh after catalog
  // changes (e.g. a demo reset, an inventory adjustment or a new product).
  const loadCatalog = useCallback(async () => {
    const repo =
      isSupabaseConfigured && getSupabaseClient()
        ? getSupabaseRepository()
        : getDemoRepository();
    const list = await repo.listProducts();
    setProducts(list);
    return list;
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await loadCatalog();
      } catch (err) {
        if (!cancelled) setError(err instanceof AppError ? err : new AppError("DB", String(err)));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loadCatalog]);

  const refreshSales = useCallback(
    async (options: { silent?: boolean } = {}) => {
      if (!options.silent) setSalesLoading(true);
      try {
        const list = await repository.listSales();
        setSales(list);
      } catch (err) {
        // history failure should not block the till
        setError(err instanceof AppError ? err : new AppError("DB", String(err)));
      } finally {
        if (!options.silent) setSalesLoading(false);
      }
    },
    [repository],
  );

  useEffect(() => {
    void refreshSales();
  }, [refreshSales]);

  // A sale written anywhere — the next till, a website order completed into a
  // sale, an InstaPay confirmation, a refund filed against one — moves this list
  // and the dashboard's revenue tiles. Watching, not parsing: the listener
  // re-reads through the same repository it always used, so realtime stays an
  // optimisation, demo mode is untouched (the bus reports `unavailable` with no
  // credentials), and a missed event costs freshness rather than correctness.
  useRealtimeWatch(["sales"], () => refreshSales({ silent: true }));

  // ── cart operations ─────────────────────────────────────────────────────

  const addLine = useCallback(
    (product: Product) => {
      if (!product.stock_tracking_enabled || product.stock_quantity <= 0) return;
      setLines((prev) => {
        const existing = prev.find((l) => l.product_id === product.id);
        if (existing) {
          if (existing.qty + 1 > existing.max_qty) return prev;
          return prev.map((l) => (l.product_id === product.id ? { ...l, qty: l.qty + 1 } : l));
        }
        const line: CartLine = {
          product_id: product.id,
          sku: product.sku,
          name_ar: product.name_ar,
          name_en: product.name_en,
          barcode: product.barcode,
          unit_price: product.selling_price,
          max_qty: product.stock_quantity,
          qty: 1,
          image_url: product.image_url,
        };
        return [...prev, line];
      });
    },
    [],
  );

  const addBySku = useCallback(
    (skuOrBarcode: string) => {
      const code = skuOrBarcode.trim().toUpperCase();
      if (!code) return false;
      const product = products.find(
        (p) => p.sku.toUpperCase() === code || (p.barcode ?? "").toUpperCase() === code,
      );
      if (!product) return false;
      addLine(product);
      return true;
    },
    [products, addLine],
  );

  const increase = useCallback((productId: string) => {
    setLines((prev) =>
      prev.map((l) =>
        l.product_id === productId && l.qty + 1 <= l.max_qty ? { ...l, qty: l.qty + 1 } : l,
      ),
    );
  }, []);

  const decrease = useCallback((productId: string) => {
    setLines((prev) =>
      prev
        .map((l) => (l.product_id === productId ? { ...l, qty: l.qty - 1 } : l))
        .filter((l) => l.qty > 0),
    );
  }, []);

  const removeLine = useCallback((productId: string) => {
    setLines((prev) => prev.filter((l) => l.product_id !== productId));
  }, []);

  const setDiscount = useCallback(
    (next: CartDiscount) => {
      if (!canDiscount) return;
      if (validateDiscount(next.type, next.value)) return;
      setDiscountValue(next);
    },
    [canDiscount],
  );

  const clearCart = useCallback(() => {
    setLines([]);
    setDiscountValue(EMPTY_DISCOUNT);
    setSelectedCustomer(null);
  }, []);

  const totals = useMemo(() => cartTotals(lines, discount), [lines, discount]);
  const isEmpty = lines.length === 0;

  // ── completion ──────────────────────────────────────────────────────────

  const completeSale = useCallback(
    async (payments: SalePaymentInput[]) => {
      if (!canSell) throw new AppError("FORBIDDEN", "You cannot complete sales");
      if (completing) throw new AppError("VALIDATION", "A sale is already being processed");
      if (lines.length === 0) throw new AppError("VALIDATION", "Cart is empty");

      setCompleting(true);
      // Built outside the try so the catch can offer the very draft that was
      // refused: an approval replays it byte for byte, `client_ref` included,
      // which is what stops an approved sale from being written twice.
      const input: CompleteSaleInput = {
          client_ref: newClientRef(),
          lines: lines.map((l) => ({ product_id: l.product_id, qty: l.qty })),
          discount_type: discount.type,
          discount_value: discount.value,
          payments,
          customer_id: selectedCustomer?.id ?? null,
          customer_name: selectedCustomer?.name ?? null,
          customer_phone: selectedCustomer?.phone ?? null,
          user_id: user.id,
          user_name: user.name,
      };
      try {
        const sale = await completeSaleGuarded(input);
        await loadCatalog();
        setCompletedSale(sale);
        setLines([]);
        setDiscountValue(EMPTY_DISCOUNT);
        setSelectedCustomer(null);
        void refreshSales();
        return sale;
      } catch (err) {
        // Over the discount cap: nothing was written, and the cart stays exactly
        // as it is so the cashier can either send it for approval or lower the
        // discount and sell now. The draft carried here is what an approval
        // replays, `client_ref` included — so approving cannot double-sell.
        if (isApprovalRequired(err)) {
          setApprovalAsk({ requirement: err.approvalRequired, input });
          return null;
        }
        throw err;
      } finally {
        setCompleting(false);
      }
    },
    [canSell, completing, lines, discount, repository, refreshSales, loadCatalog, selectedCustomer, user],
  );

  const dismissCompleted = useCallback(() => setCompletedSale(null), []);

  const dismissApprovalAsk = useCallback(() => setApprovalAsk(null), []);

  const value = useMemo<PosContextValue>(
    () => ({
      mode,
      repository,
      products,
      loading,
      error,
      lines,
      totals,
      discount,
      isEmpty,
      selectedCustomer,
      setSelectedCustomer,
      addLine,
      addBySku,
      increase,
      decrease,
      removeLine,
      setDiscount,
      clearCart,
      completing,
      completedSale,
      completeSale,
      dismissCompleted,
      approvalAsk,
      dismissApprovalAsk,
      sales,
      salesLoading,
      refreshSales,
      canSell,
      canDiscount,
      reloadCatalog: loadCatalog,
    }),
    [
      mode,
      repository,
      products,
      loading,
      error,
      lines,
      totals,
      discount,
      isEmpty,
      selectedCustomer,
      addLine,
      addBySku,
      increase,
      decrease,
      removeLine,
      setDiscount,
      clearCart,
      completing,
      completedSale,
      completeSale,
      dismissCompleted,
      approvalAsk,
      dismissApprovalAsk,
      sales,
      salesLoading,
      refreshSales,
      canSell,
      canDiscount,
      loadCatalog,
    ],
  );

  return <PosContext.Provider value={value}>{children}</PosContext.Provider>;
}

export function usePos(): PosContextValue {
  const ctx = useContext(PosContext);
  if (!ctx) throw new Error("usePos must be used inside <PosProvider>");
  return ctx;
}
