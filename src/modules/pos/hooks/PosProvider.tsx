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
import type { Category, Product } from "@/modules/products/types";
import {
  compareVariants,
  modelNameOf,
  variantGalleryOf,
  variantPrice,
  type ProductVariant,
} from "@/modules/products/variants";
import { AppError } from "@/modules/products/data/repository";
import { getDemoRepository } from "@/modules/products/data/demoRepository";
import { getSupabaseRepository } from "@/modules/products/data/supabaseRepository";
import { isSupabaseConfigured, getSupabaseClient } from "@/lib/supabase/client";
import { useRealtimeWatch } from "@/lib/supabase/useRealtimeWatch";
import { useBranch } from "@/lib/branch";
import { useAuth } from "@/lib/auth";
import { useInventory } from "@/modules/inventory/hooks/InventoryProvider";
import { canCompleteSale, canApplyDiscount } from "../permissions";
import { SALES_ROW_CAP, getSalesRepository, type SalesRepository } from "../data";
// Money moves through the service, not the repository: `completeSale` asserts
// `sell` (and `apply_discount` when the input carries one) before anything is
// written, which the provider's own `canSell` flag cannot do for a caller that
// never looked at it.
import { completeSale as completeSaleGuarded } from "../services/saleService";
import { isApprovalRequired, type ApprovalRequirement } from "@/modules/approvals";
import { cartTotals, round2, validateDiscount, type CartTotals as Totals } from "../services/posMath";
import { addCartLine, changeCartQuantity, discountCartLine, removeCartLine } from "../services/cartOperations";
import {
  type CartDiscount,
  type CartLine,
  type CompleteSaleInput,
  type Sale as SaleModel,
  type SalePaymentInput,
} from "../types";
import type { Customer } from "@/modules/customers/types";
import { EMPTY_DISCOUNT, newClientRef } from "../types";
import { getWebsiteRepository } from "@/modules/online/data";
import { evaluateCartPricing, normalizeCouponCode, selectAutomaticPromotion, type PromotionCartLine } from "@/modules/online/services/pricing";
import type { Promotion, PromotionTarget } from "@/modules/online/types";
import { holdCart as persistHeldCart, listHeldCarts, removeHeldCart, type HeldCartRecord } from "../offline/heldCarts";
import { cacheCatalogSnapshot, planOfflineInventory, readCachedCatalog } from "../offline/catalogCache";
import {
  getConnectivitySnapshot,
  getConnectivityStatus,
  reportNetworkResult,
  reportQueueHealth,
  reportSessionUsability,
  subscribeConnectivity,
  subscribeConnectivitySnapshot,
  type ApplicationConnectivityState,
  type ConnectivitySnapshot,
  type ConnectivityStatus,
} from "../offline/connectivity";
import { enqueueOfflineSale, getLastSyncedAt, getOfflineSaleDisplay, getSyncSummary, processOutbox } from "../offline/outbox";
import { probeSystemBackend } from "@/modules/system/services/healthService";
import { useRegister } from "@/modules/registers";
import { getRegisterSaleEvidence } from "@/modules/registers/services/registerService";
import { resolveExactScannedVariant } from "../services/scanner";

export interface PosContextValue {
  mode: "supabase" | "demo";
  repository: SalesRepository;
  /** Last-known transport decision used by the supported offline cash boundary. */
  connectivity: ConnectivityStatus;
  connectivityState: ApplicationConnectivityState;
  connectivitySnapshot: ConnectivitySnapshot;
  workingFromCache: boolean;
  cachedCatalogAt: string | null;
  syncPendingCount: number;
  syncErrorCount: number;
  syncDeferredCount: number;
  syncConflictCount: number;
  lastSuccessfulSyncAt: string | null;
  retrySync: () => Promise<void>;
  retrySyncItem: (clientRef: string) => Promise<void>;
  refreshSyncState: () => Promise<void>;
  // catalog snapshot (re-used from products module load)
  products: Product[];
  /** Product categories come from the existing catalogue repository. */
  categories: Category[];
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
  /** Cashier note stored with the held cart and authoritative sale. */
  saleNote: string;
  setSaleNote: (value: string) => void;
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
  setQuantity: (key: string, quantity: number) => void;
  decrease: (key: string) => void;
  removeLine: (key: string) => void;
  setLineDiscount: (key: string, discount: CartDiscount) => void;
  setDiscount: (discount: CartDiscount) => void;
  clearCart: () => void;
  /** Explicit coupon state: no code is priced until the cashier applies it. */
  couponInput: string;
  appliedCouponCode: string | null;
  couponDiscountAmount: number;
  couponError: string | null;
  applyingCoupon: boolean;
  setCouponInput: (value: string) => void;
  applyCoupon: (rawCode?: string) => Promise<boolean>;
  removeCoupon: () => void;
  /** Durable local suspended-sale drafts. Holding a sale never reserves stock. */
  heldCarts: HeldCartRecord[];
  holdCurrentCart: (notes?: string | null) => Promise<HeldCartRecord | null>;
  restoreHeldCart: (id: string) => Promise<boolean>;
  cancelHeldCart: (id: string) => Promise<void>;
  // completion
  completing: boolean;
  completedSale: SaleModel | null;
  /**
   * Completes the sale, or returns `null` when the discount crossed an approval
   * limit and the draft was offered to the register as a request instead
   * (Phase 12). `approvalAsk` then carries the rule that fired and the exact
   * draft an approver will replay.
   */
  completeSale: (
    payments: SalePaymentInput[],
    options?: { shiftId?: string | null; shiftNumber?: string | null },
  ) => Promise<SaleModel | null>;
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
  const [categories, setCategories] = useState<Category[]>([]);
  const [variants, setVariants] = useState<ProductVariant[]>([]);
  const [promotions, setPromotions] = useState<Promotion[]>([]);
  const [promotionTargets, setPromotionTargets] = useState<PromotionTarget[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<AppError | null>(null);
  const [connectivity, setConnectivity] = useState<ConnectivityStatus>(() => getConnectivityStatus());
  const [connectivitySnapshot, setConnectivitySnapshot] = useState<ConnectivitySnapshot>(() => getConnectivitySnapshot());
  const [workingFromCache, setWorkingFromCache] = useState(false);
  const [cachedCatalogAt, setCachedCatalogAt] = useState<string | null>(null);
  const [syncPendingCount, setSyncPendingCount] = useState(0);
  const [syncErrorCount, setSyncErrorCount] = useState(0);
  const [syncDeferredCount, setSyncDeferredCount] = useState(0);
  const [syncConflictCount, setSyncConflictCount] = useState(0);
  const [lastSuccessfulSyncAt, setLastSuccessfulSyncAt] = useState<string | null>(null);
  const [lines, setLines] = useState<CartLine[]>([]);
  // React may defer/replay a state updater. A scanner and a picker must know
  // *synchronously* whether their exact line was added, even for two scans in
  // the same event batch. All cart mutations go through this ref; customer is
  // separate sale state and is never coupled to a cart-line transition.
  const linesRef = useRef<CartLine[]>([]);
  const [discount, setDiscountValue] = useState<CartDiscount>(EMPTY_DISCOUNT);
  const [couponInput, setCouponInput] = useState("");
  const [appliedCouponCode, setAppliedCouponCode] = useState<string | null>(null);
  const [couponDiscountAmount, setCouponDiscountAmount] = useState(0);
  /** Server/demo pricing's combined automatic + coupon goods discount. */
  const [couponPromotionTotal, setCouponPromotionTotal] = useState<number | null>(null);
  /** Exact server preview total (including manual/invoice rules) when online. */
  const [couponPreviewTotal, setCouponPreviewTotal] = useState<number | null>(null);
  const [couponError, setCouponError] = useState<string | null>(null);
  const [applyingCoupon, setApplyingCoupon] = useState(false);
  const [selectedCustomer, setSelectedCustomer] = useState<Customer | null>(null);
  const [saleNote, setSaleNoteValue] = useState("");
  const setSaleNote = useCallback((value: string) => setSaleNoteValue(value.slice(0, 500)), []);
  const couponCartKey = useMemo(
    // A server preview also depends on manual item and invoice discounts: they
    // participate in the promotion-stacking contract. Any edit therefore
    // invalidates the prior preview and requires an explicit re-apply before
    // payment, just like changing a product, quantity or customer does.
    () => JSON.stringify({
      customer: selectedCustomer?.id ?? null,
      lines: lines.map((line) => [
        line.product_id,
        line.variant_id,
        line.qty,
        line.item_discount?.type ?? "none",
        line.item_discount?.value ?? 0,
      ]),
      invoiceDiscount: [discount.type, discount.value],
    }),
    [discount.type, discount.value, lines, selectedCustomer?.id],
  );
  const appliedCouponCartKeyRef = useRef<string | null>(null);
  const [heldCarts, setHeldCarts] = useState<HeldCartRecord[]>([]);
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
  const branchContext = useBranch();
  const currentBranch = branchContext.current;
  const activeBranchId = currentBranch?.id ?? null;
  const { refresh: refreshBranches } = branchContext;
  const { refreshIdentity, status: authStatus } = useAuth();

  // Use the live user from the inventory module so role changes (the
  // inventory role switcher, future auth) take effect on the till immediately.
  const { user } = useInventory();
  const registerContext = useRegister();
  const registerAllowsSale =
    registerContext.state.kind === "web" || registerContext.state.kind === "desktop-ready";
  const canSell = canCompleteSale(user) && !registerContext.loading && registerAllowsSale;
  const canDiscount = canApplyDiscount(user);

  // Catalog load — extracted so the POS page can refresh after catalog
  // changes (e.g. a demo reset, an inventory adjustment or a new product).
  const loadCatalog = useCallback(async () => {
    const repo =
      isSupabaseConfigured && getSupabaseClient()
        ? getSupabaseRepository()
        : getDemoRepository();
    try {
      const [list, categoryList, combinations, website] = await Promise.all([
        repo.listProducts(),
        repo.listCategories(),
        repo.listVariants(),
        getWebsiteRepository().getSnapshot().catch(() => null),
      ]);
      setProducts(list);
      setCategories(categoryList);
      setVariants([...combinations].sort(compareVariants));
      setPromotions(website?.promotions ?? []);
      setPromotionTargets(website?.promotionTargets ?? []);
      setWorkingFromCache(false);
      setCachedCatalogAt(new Date().toISOString());
      reportNetworkResult("success");
      // Cache only the exact catalog the POS actually used; no invented variants
      // or prices can leak into an offline checkout.
      void cacheCatalogSnapshot(list, combinations, activeBranchId).catch(() => undefined);
      return list;
    } catch (caught) {
      const problem = caught instanceof AppError ? caught : new AppError("DB", String(caught));
      if (problem.code !== "NETWORK") throw problem;
      reportNetworkResult("network-error");
      const cached = await readCachedCatalog(activeBranchId);
      if (cached.products.length === 0) throw problem;
      setProducts(cached.products);
      // Category labels are not in the offline snapshot. Keep browse-all
      // available instead of pretending a stale category list is authoritative.
      setCategories([]);
      setVariants([...cached.variants].sort(compareVariants));
      setWorkingFromCache(true);
      setCachedCatalogAt(cached.cachedAt);
      return cached.products;
    }
  }, [activeBranchId]);

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

  // Suspended drafts are local cashier work, not server sales. Load them once;
  // no draft affects stock, price authority or the sales ledger until payment.
  useEffect(() => {
    void listHeldCarts(activeBranchId).then(setHeldCarts).catch(() => setHeldCarts([]));
  }, [activeBranchId]);

  const refreshSyncSummary = useCallback(async () => {
    const [summary, lastSync] = await Promise.all([getSyncSummary(activeBranchId, user?.id), getLastSyncedAt()]);
    setSyncPendingCount(summary.pendingCount);
    setSyncErrorCount(summary.failedCount);
    setSyncDeferredCount(summary.deferredCount);
    setSyncConflictCount(summary.conflictCount);
    setLastSuccessfulSyncAt(lastSync);
    reportQueueHealth({
      pending: summary.pendingCount,
      failed: summary.failedCount,
      deferred: summary.deferredCount,
      conflicts: summary.conflictCount,
    });
  }, [activeBranchId, user?.id]);

  useEffect(() => {
    reportSessionUsability(authStatus === "authenticated" ? "usable" : authStatus === "anonymous" ? "expired" : "unknown");
  }, [authStatus]);

  useEffect(() => {
    void refreshSyncSummary();
    const unsubscribeTransport = subscribeConnectivity((next) => setConnectivity(next));
    const unsubscribeSnapshot = subscribeConnectivitySnapshot(setConnectivitySnapshot);
    return () => {
      unsubscribeTransport();
      unsubscribeSnapshot();
    };
  }, [refreshSyncSummary]);

  const synchronizeAfterCheck = useCallback(async (manual: boolean, clientRef?: string) => {
    if (typeof navigator !== "undefined" && navigator.onLine === false) return;
    const probe = await probeSystemBackend();
    reportNetworkResult(probe.reachable ? "success" : "network-error");
    if (!probe.reachable || probe.authenticated === false) {
      await refreshSyncSummary();
      return;
    }
    // Recovery refreshes authority before replay. Revoked membership/capability
    // therefore wins over any cached permission the offline tab once held.
    if (mode === "supabase") {
      const usable = await refreshIdentity();
      if (!usable) {
        reportSessionUsability("expired");
        return;
      }
      await refreshBranches();
    }
    await processOutbox((input) => completeSaleGuarded(input), {
      // An explicit button may bypass transient-network backoff. Automatic
      // recovery cannot bypass the five-attempt cap and never retries a
      // conflict, permission/schema refusal, or rejected business rule.
      retryNetwork: manual,
      recovery: !manual,
      clientRef,
      branchId: activeBranchId,
      userId: user?.id,
    });
    await refreshSyncSummary();
    await loadCatalog().catch(() => undefined);
  }, [activeBranchId, loadCatalog, mode, refreshBranches, refreshIdentity, refreshSyncSummary, user?.id]);

  const retrySync = useCallback(() => synchronizeAfterCheck(true), [synchronizeAfterCheck]);
  const retrySyncItem = useCallback((clientRef: string) => synchronizeAfterCheck(true, clientRef), [synchronizeAfterCheck]);

  useEffect(() => {
    if (connectivity !== "online") return;
    void synchronizeAfterCheck(false);
  }, [connectivity, synchronizeAfterCheck]);

  // A failed Supabase request can happen while the browser still reports a
  // working network. One bounded recovery probe avoids requiring a reload and
  // avoids a reconnect storm; real requests remain the primary signal.
  useEffect(() => {
    if (connectivity !== "offline" || (typeof navigator !== "undefined" && navigator.onLine === false)) return;
    const timer = window.setInterval(() => { void synchronizeAfterCheck(false); }, 30_000);
    return () => window.clearInterval(timer);
  }, [connectivity, synchronizeAfterCheck]);

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
  const posPromotionTargets = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const target of promotionTargets) {
      const ids = map.get(target.promotion_id) ?? new Set<string>();
      ids.add(`${target.target_kind}:${target.target_id}`);
      map.set(target.promotion_id, ids);
    }
    return map;
  }, [promotionTargets]);

  const recalculatePosLines = useCallback(
    (currentLines: CartLine[]): CartLine[] => {
      if (currentLines.length === 0) return [];
      const subtotal = round2(
        currentLines.reduce((sum, l) => sum + (l.base_price ?? l.unit_price) * l.qty, 0),
      );
      const pricingLines: PromotionCartLine[] = currentLines.map((l) => {
        const prod = products.find((p) => p.id === l.product_id);
        const base = l.base_price ?? l.unit_price;
        return {
          product_id: l.product_id,
          category_id: prod?.category_id ?? null,
          variant_id: l.variant_id,
          qty: l.qty,
          unit_price: base,
          line_total: round2(base * l.qty),
        };
      });

      const auto = selectAutomaticPromotion(
        promotions,
        posPromotionTargets,
        pricingLines,
        subtotal,
        new Date(),
        "pos",
      );

      return currentLines.map((l, index) => {
        const base = l.base_price ?? l.unit_price;
        const lineTotalGross = round2(base * l.qty);
        if (auto && auto.discount > 0) {
          const lineDisc = auto.evaluation
            ? (auto.evaluation.lineDiscounts[index] ?? 0)
            : round2((auto.discount * lineTotalGross) / subtotal);
          const rewardedQty = auto.evaluation?.lineRewardedQty?.[index] ?? 0;
          const discountedUnit = round2(Math.max(lineTotalGross - lineDisc, 0) / Math.max(l.qty, 1));
          return {
            ...l,
            base_price: base,
            unit_price: discountedUnit,
            automatic_promotion_id: auto.promotion.id,
            automatic_promotion_name: auto.promotion.name_en || auto.promotion.name_ar,
            automatic_discount_amount: lineDisc,
            rewarded_qty: rewardedQty,
            promotion_rule_type: auto.promotion.offer_type ?? auto.promotion.rule_type ?? "standard",
          };
        }
        return {
          ...l,
          base_price: base,
          unit_price: base,
          automatic_promotion_id: null,
          automatic_promotion_name: null,
          automatic_discount_amount: 0,
          rewarded_qty: 0,
          promotion_rule_type: null,
        };
      });
    },
    [products, promotions, posPromotionTargets],
  );

  const updateLines = useCallback(
    (change: (current: CartLine[]) => CartLine[]) => {
      const rawNext = change(linesRef.current);
      const next = recalculatePosLines(rawNext);
      linesRef.current = next;
      setLines(next);
    },
    [recalculatePosLines],
  );

  useEffect(() => {
    if (linesRef.current.length > 0) {
      updateLines((prev) => [...prev]);
    }
  }, [promotions, posPromotionTargets, updateLines]);

  const addLine = useCallback(
    (product: Product, choice: ProductVariant | null = null) => {
      const current = products.find((entry) => entry.id === product.id);
      if (!current?.active || !current.stock_tracking_enabled) return false;

      // Resolve the ID against the current catalog, not a stale picker object.
      // An enabled product with zero *active* shelves still cannot be sold as a
      // plain product (and an archived or forged combination cannot be sold).
      const variant = choice ? variants.find((entry) => entry.id === choice.id) ?? null : null;
      if (current.variants_enabled) {
        if (!variant?.active || variant.product_id !== current.id) return false;
      } else if (choice) {
        return false;
      }

      const maxQty = variant ? variant.stock_quantity : current.stock_quantity;
      if (maxQty <= 0) return false;

      const officialUnit = variant ? variantPrice(variant, current) : current.selling_price;
      const line: CartLine = {
        product_id: current.id,
        variant_id: variant?.id ?? null,
        variant_sku: variant?.sku ?? null,
        color_ar: variant?.color_ar ?? null,
        color_en: variant?.color_en ?? null,
        size: variant?.size ?? null,
        size_label: variant?.size_label ?? null,
        display_name_ar: variant?.display_name_ar ?? null,
        display_name_en: variant?.display_name_en ?? null,
        sku: variant?.sku ?? current.sku,
        name_ar: current.name_ar,
        name_en: current.name_en,
        barcode: variant?.barcode ?? current.barcode,
        base_price: round2(officialUnit),
        unit_price: round2(officialUnit),
        automatic_promotion_id: null,
        automatic_promotion_name: null,
        automatic_discount_amount: 0,
        max_qty: maxQty,
        qty: 1,
        image_url: (variant ? variantGalleryOf(variant)[0] ?? variant.image_url : null) ?? current.image_url,
        item_discount: { ...EMPTY_DISCOUNT },
      };

      const result = addCartLine(linesRef.current, line);
      if (!result.added) return false;
      updateLines(() => result.lines);
      return true;
    },
    [products, variants, updateLines],
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

      const variant = resolveExactScannedVariant(code, variants);
      if (variant) {
        if (!variant.active) return false;
        const owner = products.find((p) => p.id === variant.product_id);
        if (!owner || !owner.variants_enabled) return false;
        return addLine(owner, variant);
      }

      const compact = code.replace(/-/g, "");
      const product =
        products.find(
          (p) => p.sku.toUpperCase() === code || (p.barcode ?? "").toUpperCase() === code,
        ) ??
        (compact
          ? products.find(
              (p) =>
                p.sku.toUpperCase().replace(/-/g, "") === compact ||
                (p.barcode ?? "").toUpperCase().replace(/-/g, "") === compact,
            )
          : undefined);
      if (!product) return false;
      if (product.variants_enabled) return false;
      return addLine(product);
    },
    [products, variants, addLine],
  );

  const increase = useCallback((key: string) => {
    updateLines((prev) => changeCartQuantity(prev, key, 1));
  }, [updateLines]);

  const setQuantity = useCallback((key: string, quantity: number) => {
    if (!Number.isFinite(quantity)) return;
    updateLines((prev) => prev.flatMap((line) => {
      if (`${line.product_id}::${line.variant_id ?? ""}` !== key) return [line];
      const next = Math.max(0, Math.min(line.max_qty, Math.trunc(quantity)));
      return next > 0 ? [{ ...line, qty: next }] : [];
    }));
  }, [updateLines]);

  const decrease = useCallback((key: string) => {
    updateLines((prev) => changeCartQuantity(prev, key, -1));
  }, [updateLines]);

  const removeLine = useCallback((key: string) => {
    updateLines((prev) => removeCartLine(prev, key));
  }, [updateLines]);

  const setLineDiscount = useCallback(
    (key: string, next: CartDiscount) => {
      if (!canDiscount || validateDiscount(next.type, next.value)) return;
      updateLines((prev) => discountCartLine(prev, key, next));
    },
    [canDiscount, updateLines],
  );

  const setDiscount = useCallback(
    (next: CartDiscount) => {
      if (!canDiscount) return;
      if (validateDiscount(next.type, next.value)) return;
      setDiscountValue(next);
    },
    [canDiscount],
  );

  const clearCart = useCallback(() => {
    updateLines(() => []);
    setDiscountValue(EMPTY_DISCOUNT);
    setAppliedCouponCode(null);
    setCouponDiscountAmount(0);
    setCouponPromotionTotal(null);
    setCouponPreviewTotal(null);
    appliedCouponCartKeyRef.current = null;
    setCouponError(null);
    setSaleNoteValue("");
    // Clearing merchandise is not an explicit request to clear the customer.
  }, [updateLines]);

  useEffect(() => {
    // A preview is tied to exact products, variants, quantities and customer.
    // Editing any of them deliberately requires a fresh explicit apply.
    if (!appliedCouponCartKeyRef.current || appliedCouponCartKeyRef.current === couponCartKey) return;
    appliedCouponCartKeyRef.current = null;
    setAppliedCouponCode(null);
    setCouponDiscountAmount(0);
    setCouponPromotionTotal(null);
    setCouponPreviewTotal(null);
    setCouponError("Cart changed — apply the coupon again before payment.");
  }, [couponCartKey]);

  const removeCoupon = useCallback(() => {
    setAppliedCouponCode(null);
    setCouponDiscountAmount(0);
    setCouponPromotionTotal(null);
    setCouponPreviewTotal(null);
    appliedCouponCartKeyRef.current = null;
    setCouponError(null);
  }, []);

  const applyCoupon = useCallback(async (rawCode?: string): Promise<boolean> => {
    const code = normalizeCouponCode(rawCode ?? couponInput);
    if (!code) {
      setCouponError("Coupon code is required");
      return false;
    }
    if (linesRef.current.length === 0) {
      setCouponError("Add an item before applying a coupon");
      return false;
    }
    setApplyingCoupon(true);
    setCouponError(null);
    try {
      let couponDiscount = 0;
      let promotionTotal = 0;
      let previewTotal: number | null = null;
      if (mode === "supabase") {
        const client = getSupabaseClient();
        if (!client) throw new AppError("NETWORK", "Pricing service is unavailable");
        const { data, error: rpcError } = await client.rpc("preview_pos_coupon_pricing", {
          p_code: code,
          p_lines: linesRef.current.map((line) => ({
            product_id: line.product_id, variant_id: line.variant_id, qty: line.qty,
            discount_type: line.item_discount?.type ?? "none", discount_value: line.item_discount?.value ?? 0,
          })),
          p_customer_key: selectedCustomer?.phone ?? null,
          p_invoice_discount_type: discount.type,
          p_invoice_discount_value: discount.value,
        });
        if (rpcError) throw new AppError("DB", rpcError.message);
        const preview = data as { valid?: boolean; code?: string; coupon_discount?: number | string; total_discount?: number | string; promotion_discount?: number | string; total?: number | string; message?: string; reason?: string } | null;
        if (!preview?.valid) {
          setCouponError(preview?.message ?? `Coupon ${code} cannot be used for this sale (${preview?.reason ?? "invalid"}).`);
          return false;
        }
        couponDiscount = Number(preview.coupon_discount ?? 0);
        promotionTotal = Number(preview.promotion_discount ?? preview.total_discount ?? couponDiscount);
        previewTotal = Number(preview.total ?? 0);
      } else {
        const preview = evaluateCartPricing({
          lines: linesRef.current.map((line) => ({
            product_id: line.product_id, variant_id: line.variant_id, category_id: products.find((product) => product.id === line.product_id)?.category_id ?? null,
            qty: line.qty, unit_price: line.base_price ?? line.unit_price,
            line_total: round2((line.base_price ?? line.unit_price) * line.qty),
          })),
          subtotal: linesRef.current.reduce((sum, line) => sum + (line.base_price ?? line.unit_price) * line.qty, 0),
          promoCode: code,
          coupons: [], promotions,
          targetsByPromotion: posPromotionTargets,
          usageFor: () => ({ customerUses: 0, hasPriorOrder: false }),
          customerKey: selectedCustomer?.phone ?? null,
          zone: null, legacy: { fee: 0, minimum: 0, threshold: 0 }, deliveryType: "pickup", channel: "pos",
        });
        if (!preview.ok) {
          setCouponError(preview.message);
          return false;
        }
        couponDiscount = preview.pricing.promoDiscount;
        promotionTotal = preview.pricing.autoDiscount + preview.pricing.promoDiscount;
      }
      if (!Number.isFinite(couponDiscount) || couponDiscount <= 0) {
        setCouponError(`Coupon ${code} does not discount this sale.`);
        return false;
      }
      setCouponInput(code);
      setAppliedCouponCode(code);
      setCouponDiscountAmount(round2(couponDiscount));
      setCouponPromotionTotal(round2(Math.max(promotionTotal, 0)));
      setCouponPreviewTotal(previewTotal != null && Number.isFinite(previewTotal) ? round2(Math.max(previewTotal, 0)) : null);
      appliedCouponCartKeyRef.current = couponCartKey;
      return true;
    } catch (caught) {
      const message = caught instanceof AppError ? caught.message : "Coupon pricing could not be checked.";
      setCouponError(message);
      return false;
    } finally {
      setApplyingCoupon(false);
    }
  }, [couponCartKey, couponInput, discount, mode, products, promotions, posPromotionTargets, selectedCustomer]);

  const holdCurrentCart = useCallback(async (notes: string | null = null): Promise<HeldCartRecord | null> => {
    if (!canSell || linesRef.current.length === 0) return null;
    const held = await persistHeldCart({
      held_by_id: user.id,
      held_by_name: user.name,
      // The BranchProvider is server-resolved; this snapshot prevents a held
      // Branch A cart from silently becoming Branch B work after a switch.
      branch_id: activeBranchId,
      store: currentBranch?.name_en ?? null,
      shift_id: null,
      customer: selectedCustomer,
      lines: linesRef.current,
      invoice_discount: discount,
      coupon_code: appliedCouponCode,
      notes: (notes ?? saleNote).trim() || null,
    });
    setHeldCarts((current) => [held, ...current]);
    updateLines(() => []);
    setDiscountValue(EMPTY_DISCOUNT);
    removeCoupon();
    setSelectedCustomer(null);
    setSaleNoteValue("");
    return held;
  }, [activeBranchId, appliedCouponCode, canSell, currentBranch?.name_en, discount, removeCoupon, saleNote, selectedCustomer, updateLines, user]);

  const restoreHeldCart = useCallback(async (id: string): Promise<boolean> => {
    if (linesRef.current.length > 0) return false;
    const held = heldCarts.find((entry) => entry.id === id);
    if (!held) return false;
    if (held.branch_id && held.branch_id !== activeBranchId) return false;
    // A hold is not a reservation. Re-read every exact shelf before making it
    // the active cart; payment still repeats authoritative server pricing/stock
    // checks, including coupons and promotions.
    for (const line of held.lines) {
      const product = products.find((entry) => entry.id === line.product_id);
      if (!product?.active || !product.stock_tracking_enabled) return false;
      if (product.variants_enabled) {
        const variant = variants.find((entry) => entry.id === line.variant_id && entry.product_id === product.id);
        if (!variant?.active || variant.stock_quantity < line.qty) return false;
      } else if (line.variant_id || product.stock_quantity < line.qty) {
        return false;
      }
    }
    // Recalculate from today's local catalogue/promotion snapshot. This removes
    // stale display prices before the server has its final say at payment.
    updateLines(() => held.lines.map((line) => ({ ...line })));
    setDiscountValue(held.invoice_discount);
    setSelectedCustomer(held.customer);
    setSaleNoteValue(held.notes ?? "");
    setCouponInput(held.coupon_code ?? "");
    setAppliedCouponCode(null);
    setCouponDiscountAmount(0);
    setCouponPromotionTotal(null);
    setCouponPreviewTotal(null);
    appliedCouponCartKeyRef.current = null;
    setCouponError(held.coupon_code ? "Held sale restored — apply its coupon again to revalidate live pricing." : null);
    await removeHeldCart(id);
    setHeldCarts((current) => current.filter((entry) => entry.id !== id));
    return true;
  }, [activeBranchId, heldCarts, products, updateLines, variants]);

  const cancelHeldCart = useCallback(async (id: string): Promise<void> => {
    if (!canSell) throw new AppError("FORBIDDEN", "You cannot cancel held sales");
    await removeHeldCart(id);
    setHeldCarts((current) => current.filter((entry) => entry.id !== id));
  }, [canSell]);

  const totals = useMemo(() => {
    const base = cartTotals(lines, discount);
    // The coupon figure is only populated by the demo evaluator or the
    // server-backed POS preview. pos_complete_sale recalculates this under a
    // transaction, so this is a payment preview, never financial authority.
    const coupon = Math.min(Math.max(round2(couponDiscountAmount), 0), base.subtotal);
    const serverPromo = couponPromotionTotal == null
      ? base.promoDiscountAmount
      : Math.min(Math.max(round2(couponPromotionTotal), 0), base.subtotal);
    const promotionDelta = round2(serverPromo - base.promoDiscountAmount);
    const derivedTotal = round2(Math.max(base.total - promotionDelta, 0));
    const total = couponPreviewTotal != null ? couponPreviewTotal : derivedTotal;
    return {
      ...base,
      promoDiscountAmount: serverPromo,
      couponDiscountAmount: coupon,
      // When live preview includes manual/invoice rules, show the server's
      // complete total and matching aggregate discount. Line breakdown remains
      // advisory; completion locks and stores the same authority again.
      discountAmount: couponPreviewTotal != null ? round2(Math.max(base.subtotal - total, 0)) : round2(base.discountAmount + promotionDelta),
      total,
    };
  }, [lines, discount, couponDiscountAmount, couponPromotionTotal, couponPreviewTotal]);
  const isEmpty = lines.length === 0;

  // ── completion ──────────────────────────────────────────────────────────

  const completeSale = useCallback(
    async (
      payments: SalePaymentInput[],
      options?: { shiftId?: string | null; shiftNumber?: string | null },
    ) => {
      if (!canSell) throw new AppError("FORBIDDEN", "You cannot complete sales");
      if (completing) throw new AppError("VALIDATION", "A sale is already being processed");
      if (lines.length === 0) throw new AppError("VALIDATION", "Cart is empty");

      // The desktop binding is checked before the draft is frozen. These ids are
      // retained in IndexedDB as original evidence; Postgres still derives
      // authority from the installation credential, never from these fields.
      const registerEvidence = await getRegisterSaleEvidence(activeBranchId);
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
            discount_type: l.item_discount?.type ?? "none",
            discount_value: l.item_discount?.value ?? 0,
          })),
          discount_type: discount.type,
        discount_value: discount.value,
        coupon_code: appliedCouponCode,
        promo_code: appliedCouponCode,
        payments,
          customer_id: selectedCustomer?.id ?? null,
          customer_name: selectedCustomer?.name ?? null,
          customer_phone: selectedCustomer?.phone ?? null,
          notes: saleNote.trim() || null,
          user_id: user.id,
          user_name: user.name,
          shift_id: options?.shiftId ?? null,
          register_id: registerEvidence?.register_id ?? null,
          installation_id: registerEvidence?.installation_id ?? null,
          register_name: registerEvidence?.register_name ?? null,
      };
      const queueOfflineCashSale = async (): Promise<SaleModel> => {
        if (payments.length !== 1 || payments[0]?.method !== "cash") {
          throw new AppError("NETWORK", "Only cash sales can be captured while offline", "payment");
        }
        if (appliedCouponCode) {
          throw new AppError("VALIDATION", "Coupons require an online price check and cannot be used offline", "coupon");
        }
        if (input.discount_type !== "none" || input.lines.some((line) => (line.discount_type ?? "none") !== "none" && Number(line.discount_value) > 0)) {
          throw new AppError("VALIDATION", "Manager-approved and manual discounts require an internet connection", "discount");
        }
        if (lines.some((line) => Boolean(line.automatic_promotion_id) || (line.base_price != null && round2(line.base_price) !== round2(line.unit_price)))) {
          throw new AppError("VALIDATION", "Promotion pricing requires an internet connection", "payment");
        }
        // Last-known inventory is a local safety check only. The queued payload
        // is replayed unchanged and the server re-checks exact shelf, price,
        // shift and permissions before it becomes a financial sale.
        if (!activeBranchId) {
          throw new AppError("VALIDATION", "An active branch is required for offline stock", "branch");
        }
        const inventory = planOfflineInventory(products, variants, input.lines, null, activeBranchId);
        const record = await enqueueOfflineSale(
          input,
          lines.map((line) => ({
            product_id: line.product_id,
            variant_id: line.variant_id,
            qty: line.qty,
            discount_type: line.item_discount?.type ?? "none",
            discount_value: line.item_discount?.value ?? 0,
            name_en: line.name_en,
            name_ar: line.name_ar,
            sku: line.variant_sku ?? line.sku,
            barcode: line.barcode,
            color_ar: line.color_ar,
            color_en: line.color_en,
            size_value: line.size_label ?? (line.size == null ? null : String(line.size)),
            variant_display_name: modelNameOf(line),
            unit_price: line.unit_price,
          })),
          {
            subtotal: totals.subtotal,
            discount_amount: totals.discountAmount,
            total: totals.total,
            branch_id: activeBranchId,
            branch_name: currentBranch?.name_en ?? null,
            shift_id: options?.shiftId ?? null,
            shift_number: options?.shiftNumber ?? null,
          },
          inventory.writes,
        );
        const display = await getOfflineSaleDisplay(record.id);
        if (!display) throw new AppError("DB", "Offline sale was not saved");
        setProducts(inventory.products);
        setVariants(inventory.variants);
        setCompletedSale(display);
        updateLines(() => []);
        setDiscountValue(EMPTY_DISCOUNT);
        setSaleNoteValue("");
        removeCoupon();
        await refreshSyncSummary();
        return display;
      };

      try {
        if (getConnectivityStatus() === "offline") return await queueOfflineCashSale();
        const sale = await completeSaleGuarded(input);
        reportNetworkResult("success");
        await loadCatalog();
        setCompletedSale(sale);
        updateLines(() => []);
        setDiscountValue(EMPTY_DISCOUNT);
        setSaleNoteValue("");
        removeCoupon();
        void refreshSales();
        return sale;
      } catch (err) {
        const network = err instanceof AppError && err.code === "NETWORK";
        if (network) {
          reportNetworkResult("network-error");
          return await queueOfflineCashSale();
        }
        reportNetworkResult("other-error");
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
    [activeBranchId, currentBranch, appliedCouponCode, canSell, completing, lines, discount, products, variants, totals, refreshSales, refreshSyncSummary, loadCatalog, removeCoupon, saleNote, selectedCustomer, user, updateLines],
  );

  const dismissCompleted = useCallback(() => setCompletedSale(null), []);

  const dismissApprovalAsk = useCallback(() => setApprovalAsk(null), []);

  const value = useMemo<PosContextValue>(
    () => ({
      mode,
      repository,
      connectivity,
      connectivityState: connectivitySnapshot.state,
      connectivitySnapshot,
      workingFromCache,
      cachedCatalogAt,
      syncPendingCount,
      syncErrorCount,
      syncDeferredCount,
      syncConflictCount,
      lastSuccessfulSyncAt,
      retrySync,
      retrySyncItem,
      refreshSyncState: refreshSyncSummary,
      products,
      categories,
      variants,
      loading,
      error,
      lines,
      totals,
      discount,
      isEmpty,
      selectedCustomer,
      saleNote,
      setSaleNote,
      setSelectedCustomer,
      addLine,
      addBySku,
      variantsOf,
      increase,
      setQuantity,
      decrease,
      removeLine,
      setLineDiscount,
      setDiscount,
      clearCart,
      couponInput,
      appliedCouponCode,
      couponDiscountAmount,
      couponError,
      applyingCoupon,
      setCouponInput,
      applyCoupon,
      removeCoupon,
      heldCarts,
      holdCurrentCart,
      restoreHeldCart,
      cancelHeldCart,
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
      connectivity,
      connectivitySnapshot,
      workingFromCache,
      cachedCatalogAt,
      syncPendingCount,
      syncErrorCount,
      syncDeferredCount,
      syncConflictCount,
      lastSuccessfulSyncAt,
      retrySync,
      retrySyncItem,
      refreshSyncSummary,
      products,
      categories,
      variants,
      loading,
      error,
      lines,
      totals,
      discount,
      isEmpty,
      selectedCustomer,
      saleNote,
      setSaleNote,
      addLine,
      addBySku,
      variantsOf,
      increase,
      setQuantity,
      decrease,
      removeLine,
      setLineDiscount,
      setDiscount,
      clearCart,
      couponInput,
      appliedCouponCode,
      couponDiscountAmount,
      couponError,
      applyingCoupon,
      applyCoupon,
      removeCoupon,
      heldCarts,
      holdCurrentCart,
      restoreHeldCart,
      cancelHeldCart,
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
