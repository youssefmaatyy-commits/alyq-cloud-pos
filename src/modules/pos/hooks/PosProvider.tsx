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
import {
  compareVariants,
  variantPrice,
  type ProductVariant,
} from "@/modules/products/variants";
import { AppError } from "@/modules/products/data/repository";
import { getDemoRepository } from "@/modules/products/data/demoRepository";
import { getSupabaseRepository } from "@/modules/products/data/supabaseRepository";
import { isSupabaseConfigured, getSupabaseClient } from "@/lib/supabase/client";
import { useRealtimeWatch } from "@/lib/supabase/useRealtimeWatch";
import { useInventory } from "@/modules/inventory/hooks/InventoryProvider";
import { canCompleteSale, canApplyDiscount } from "../permissions";
import { SALES_ROW_CAP, getSalesRepository, type SalesRepository } from "../data";
// Money moves through the service, not the repository: `completeSale` asserts
// `sell` (and `apply_discount` when the input carries one) before anything is
// written, which the provider's own `canSell` flag cannot do for a caller that
// never looked at it.
import { completeSale as completeSaleGuarded } from "../services/saleService";
import { isApprovalRequired, type ApprovalRequirement } from "@/modules/approvals";
import { cartTotals, validateDiscount, type CartTotals as Totals } from "../services/posMath";
import {
  lineKey,
  type CartDiscount,
  type CartLine,
  type CompleteSaleInput,
  type Sale as SaleModel,
  type SalePaymentInput,
} from "../types";
import type { Customer } from "@/modules/customers/types";
import { EMPTY_DISCOUNT, newClientRef } from "../types";

export interface PosContextValue {
  mode: "supabase" | "demo";
  repository: SalesRepository;
  // catalog snapshot (re-used from products module load)
  products: Product[];
  /**
   * Every combination of every product, in display order. The grid reads it to
   * decide whether a product needs a colour/size picked before it can be added,
   * and to draw how much of each combination is on the shelf.
   */
  variants: ProductVariant[];
  loading: boolean;
  error: AppError | null;
  // cart
  lines: CartLine[];
  totals: Totals;
  discount: CartDiscount;
  isEmpty: boolean;
  selectedCustomer: Customer | null;
  setSelectedCustomer: (customer: Customer | null) => void;
  /**
   * Add one unit of a product, or of an exact combination.
   *
   * Returns false — and adds nothing — when the product sells by variant and no
   * combination was named: the register never picks one for the cashier, because
   * the wrong silent choice is a customer walking out with the wrong ring and a
   * shelf count that is wrong in two places.
   */
  addLine: (product: Product, variant?: ProductVariant | null) => boolean;
  /** Scan/type a code. Resolves a variant's own code first, then a plain product. */
  addBySku: (skuOrBarcode: string) => boolean;
  /** Variants of one product, active first, in numeric size order. */
  variantsOf: (productId: string) => ProductVariant[];
  increase: (key: string) => void;
  decrease: (key: string) => void;
  removeLine: (key: string) => void;
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
   * Exact number of sales matching the last refresh's date bounds, or null when
   * the backend could not supply one. Never read null as "all of them".
   */
  salesTotal: number | null;
  /**
   * True when salesTotal is known and larger than the window actually fetched:
   * what is on screen is the most recent slice, not the whole history. Screens
   * are expected to say so rather than present the slice as complete.
   */
  salesTruncated: boolean;
  /**
   * Re-read the sales list. `silent` is for a background refresh — a sale written
   * at another till, arriving over the channel — which must not flash a spinner
   * over a screen somebody is reading. `from`/`to` bound the read to a date
   * range so a report can ask for the period it is actually rendering instead
   * of whatever the last refresh happened to load.
   */
  refreshSales: (options?: { silent?: boolean; from?: string; to?: string }) => Promise<void>;
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
  const [variants, setVariants] = useState<ProductVariant[]>([]);
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
  const [salesTotal, setSalesTotal] = useState<number | null>(null);
  const [salesTruncated, setSalesTruncated] = useState(false);
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
    const [list, combinations] = await Promise.all([
      repo.listProducts(),
      repo.listVariants(),
    ]);
    setProducts(list);
    setVariants([...combinations].sort(compareVariants));
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
    async (options: { silent?: boolean; from?: string; to?: string } = {}) => {
      if (!options.silent) setSalesLoading(true);
      try {
        // Window and total are fetched together. The window is what the screen
        // shows; the total is what exists. Only the pair can distinguish "that
        // is all of it" from "that is the most recent thousand".
        const [list, total] = await Promise.all([
          repository.listSales({
            from: options.from,
            to: options.to,
            limit: SALES_ROW_CAP,
          }),
          repository.countSales({ from: options.from, to: options.to }),
        ]);
        setSales(list);
        setSalesTotal(total);
        setSalesTruncated(total !== null && total > list.length);
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

  /** The combinations a product sells as, in size order. */
  const variantsOf = useCallback(
    (productId: string) => variants.filter((v) => v.product_id === productId),
    [variants],
  );

  /**
   * Add one unit. The line's identity is product + variant, so two combinations
   * of one product are two lines — they never merge, and neither inherits the
   * other's stock.
   */
  const addLine = useCallback(
    (product: Product, variant: ProductVariant | null = null) => {
      if (!product.active || !product.stock_tracking_enabled) return false;

      const active = variants.filter((v) => v.product_id === product.id && v.active);
      // A variant product needs the exact combination named. Falling back to the
      // product (or to its first variant) would be the silent mistake this whole
      // feature exists to prevent.
      if (product.variants_enabled && active.length > 0) {
        if (!variant) return false;
        if (!variant.active || variant.product_id !== product.id) return false;
      }

      const maxQty = variant ? variant.stock_quantity : product.stock_quantity;
      if (maxQty <= 0) return false;

      const line: CartLine = {
        product_id: product.id,
        variant_id: variant?.id ?? null,
        variant_sku: variant?.sku ?? null,
        color_ar: variant?.color_ar ?? null,
        color_en: variant?.color_en ?? null,
        size: variant?.size ?? null,
        size_label: variant?.size_label ?? null,
        sku: variant?.sku ?? product.sku,
        name_ar: product.name_ar,
        name_en: product.name_en,
        barcode: variant?.barcode ?? product.barcode,
        unit_price: variant ? variantPrice(variant, product) : product.selling_price,
        max_qty: maxQty,
        qty: 1,
        image_url: variant?.image_url ?? product.image_url,
      };

      let added = false;
      setLines((prev) => {
        const key = lineKey(line);
        const existing = prev.find((l) => lineKey(l) === key);
        if (existing) {
          if (existing.qty + 1 > existing.max_qty) return prev;
          added = true;
          return prev.map((l) => (lineKey(l) === key ? { ...l, qty: l.qty + 1 } : l));
        }
        added = true;
        return [...prev, line];
      });
      return added;
    },
    [variants],
  );

  /**
   * Scan-to-add. A variant's own SKU/barcode resolves to that exact combination;
   * a product code resolves only for a product that does not sell by variant.
   * A variant product returns false, so the grid opens the picker instead of
   * charging a shelf nobody chose.
   */
  const addBySku = useCallback(
    (skuOrBarcode: string) => {
      const code = skuOrBarcode.trim().toUpperCase();
      if (!code) return false;

      const variant = variants.find(
        (v) => v.sku.toUpperCase() === code || (v.barcode ?? "").toUpperCase() === code,
      );
      if (variant) {
        if (!variant.active) return false;
        const owner = products.find((p) => p.id === variant.product_id);
        if (!owner) return false;
        return addLine(owner, variant);
      }

      const product = products.find(
        (p) => p.sku.toUpperCase() === code || (p.barcode ?? "").toUpperCase() === code,
      );
      if (!product) return false;
      const active = variants.filter((v) => v.product_id === product.id && v.active);
      if (product.variants_enabled && active.length > 0) return false;
      return addLine(product);
    },
    [products, variants, addLine],
  );

  const increase = useCallback((key: string) => {
    setLines((prev) =>
      prev.map((l) => (lineKey(l) === key && l.qty + 1 <= l.max_qty ? { ...l, qty: l.qty + 1 } : l)),
    );
  }, []);

  const decrease = useCallback((key: string) => {
    setLines((prev) =>
      prev.map((l) => (lineKey(l) === key ? { ...l, qty: l.qty - 1 } : l)).filter((l) => l.qty > 0),
    );
  }, []);

  const removeLine = useCallback((key: string) => {
    setLines((prev) => prev.filter((l) => lineKey(l) !== key));
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
          // The exact combination travels with the line; the server re-reads the
          // price and the shelf anyway and refuses a line that names none.
          lines: lines.map((l) => ({
            product_id: l.product_id,
            qty: l.qty,
            variant_id: l.variant_id,
          })),
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
      variants,
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
      variantsOf,
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
      salesTotal,
      salesTruncated,
      refreshSales,
      canSell,
      canDiscount,
      reloadCatalog: loadCatalog,
    }),
    [
      mode,
      repository,
      products,
      variants,
      loading,
      error,
      lines,
      totals,
      discount,
      isEmpty,
      selectedCustomer,
      addLine,
      addBySku,
      variantsOf,
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
      salesTotal,
      salesTruncated,
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
