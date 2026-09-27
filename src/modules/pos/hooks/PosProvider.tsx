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
import {
  assertCanCompleteSale,
  completeSale as completeSaleGuarded,
  discountPercentOf,
} from "../services/saleService";
import {
  assertWithinApprovalLimit,
  cachedApprovalRules,
  evaluateDiscountRule,
  isApprovalRequired,
  type ApprovalRequirement,
} from "@/modules/approvals";
import { cartTotals, validateDiscount, type CartTotals as Totals } from "../services/posMath";
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
import { promotionUnitPrice } from "@/modules/online/services/pricing";
import type { Promotion, PromotionTarget } from "@/modules/online/types";
import {
  getConnectivityStatus,
  reportNetworkResult,
  subscribeConnectivity,
  type ConnectivityStatus,
} from "../offline/connectivity";
import { cacheCatalogSnapshot, planOfflineInventory, readCachedCatalog } from "../offline/catalogCache";
import {
  enqueueOfflineSale,
  getLastSyncedAt,
  getOfflineSaleDisplay,
  getOfflineSalesForDisplay,
  getSyncSummary,
  processOutbox,
  retrySyncNow,
  type SyncSummary,
} from "../offline/outbox";

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
  setLineDiscount: (key: string, discount: CartDiscount) => void;
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
  // ── offline-first (src/modules/pos/offline/) ──────────────────────────────
  /** Shared connectivity state; known-offline cash completion takes the local path immediately. */
  connectivity: "online" | "offline";
  /** True while the catalog on screen is the last-known IndexedDB copy, not a live read (stock shown is NOT real-time). */
  workingFromCache: boolean;
  /** When the cached catalog snapshot currently in use was last refreshed live, if ever. */
  catalogCachedAt: string | null;
  /** Counts of the local sync queue: never-yet-tried, failed-but-queued, and stock-conflict-flagged. */
  syncPendingCount: number;
  syncErrorCount: number;
  syncConflictCount: number;
  /** True while a sync pass is actively running. */
  syncing: boolean;
  /** When a queued sale last reached the server successfully, if ever. */
  lastSyncedAt: string | null;
  /** Manual "Retry sync" — attempts every queued sale now, ignoring backoff. */
  retrySync: () => Promise<void>;
  /**
   * `sales` with any still-queued/failed offline sales prepended, so the
   * history and detail screens can render an offline sale before the server
   * has ever seen it. A sale drops out of this list (and appears only in
   * `sales`, from the server) the moment it syncs — never shown twice.
   */
  visibleSales: SaleModel[];
}

const PosContext = createContext<PosContextValue | null>(null);

/** Loads the catalog once (same store as the products module) and owns the cart. */
export function PosProvider({ children }: { children: ReactNode }) {
  const [products, setProducts] = useState<Product[]>([]);
  const [variants, setVariants] = useState<ProductVariant[]>([]);
  const [promotions, setPromotions] = useState<Promotion[]>([]);
  const [promotionTargets, setPromotionTargets] = useState<PromotionTarget[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<AppError | null>(null);
  const [lines, setLines] = useState<CartLine[]>([]);
  // React may defer/replay a state updater. A scanner and a picker must know
  // *synchronously* whether their exact line was added, even for two scans in
  // the same event batch. All cart mutations go through this ref; customer is
  // separate sale state and is never coupled to a cart-line transition.
  const linesRef = useRef<CartLine[]>([]);
  const updateLines = useCallback((change: (current: CartLine[]) => CartLine[]) => {
    const next = change(linesRef.current);
    linesRef.current = next;
    setLines(next);
  }, []);
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

  // ── offline-first (see src/modules/pos/offline/) ─────────────────────────
  // Connectivity is shared with auth and the shell. A known-offline cash sale
  // commits locally without touching HTTP; an apparently-online sale still
  // tries the server and falls back only on a genuine NETWORK failure.
  const [connectivity, setConnectivity] = useState<ConnectivityStatus>(() => getConnectivityStatus());
  const [syncSummary, setSyncSummary] = useState<SyncSummary>({
    pendingCount: 0, errorCount: 0, conflictCount: 0, syncing: false,
  });
  const [offlineSales, setOfflineSales] = useState<SaleModel[]>([]);
  const [workingFromCache, setWorkingFromCache] = useState(false);
  const [catalogCachedAt, setCatalogCachedAt] = useState<string | null>(null);
  const [lastSyncedAt, setLastSyncedAt] = useState<string | null>(null);
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

  // Offline sales only mean anything against a live backend — demo mode has
  // no network path at all, so every one of its sales already "syncs"
  // instantly (it IS the local store).
  const offlineCapable = mode === "supabase";

  const refreshOfflineState = useCallback(async () => {
    if (!offlineCapable) return;
    const [display, summary, syncedAt] = await Promise.all([
      getOfflineSalesForDisplay(),
      getSyncSummary(),
      getLastSyncedAt(),
    ]);
    setOfflineSales(display);
    setSyncSummary(summary);
    setLastSyncedAt(syncedAt);
  }, [offlineCapable]);

  useEffect(() => {
    void refreshOfflineState();
  }, [refreshOfflineState]);

  // Connectivity: the browser's online/offline events set the resting state;
  // every real Supabase call (catalog load, sale completion, the sync pass
  // below) corrects it immediately via `reportNetworkResult`, since
  // `navigator.onLine` alone is known to be unreliable (see offline/connectivity.ts).
  useEffect(() => {
    return subscribeConnectivity(setConnectivity);
  }, []);

  // Catalog load — extracted so the POS page can refresh after catalog
  // changes (e.g. a demo reset, an inventory adjustment or a new product).
  const loadCatalog = useCallback(async () => {
    const usingSupabase = isSupabaseConfigured && !!getSupabaseClient();
    const repo = usingSupabase ? getSupabaseRepository() : getDemoRepository();
    try {
      const [list, combinations, website] = await Promise.all([
        repo.listProducts(),
        repo.listVariants(),
        getWebsiteRepository().getSnapshot().catch(() => null),
      ]);
      reportNetworkResult("success");
      setProducts(list);
      setVariants([...combinations].sort(compareVariants));
      setPromotions(website?.promotions ?? []);
      setPromotionTargets(website?.promotionTargets ?? []);
      setWorkingFromCache(false);
      // Refresh the offline "last known" copy on every successful live load —
      // this is the ONLY writer of the cache; nothing offline ever invents or
      // edits a product/variant.
      if (usingSupabase) void cacheCatalogSnapshot(list, combinations).catch(() => {});
      return list;
    } catch (err) {
      const appErr = err instanceof AppError ? err : new AppError("DB", String(err));
      if (usingSupabase && appErr.code === "NETWORK") {
        reportNetworkResult("network-error");
        const cached = await readCachedCatalog();
        if (cached.products.length > 0) {
          setProducts(cached.products);
          setVariants([...cached.variants].sort(compareVariants));
          setWorkingFromCache(true);
          setCatalogCachedAt(cached.cachedAt);
          // Promotions are not cached (Phase 3 scope: products/variants only —
          // see offline/catalogCache.ts) — an offline cart simply has none,
          // which is strictly conservative (never overcharges, never applies
          // a promotion the server can no longer confirm).
          setPromotions([]);
          setPromotionTargets([]);
          return cached.products;
        }
      }
      throw appErr;
    }
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

  // ── offline sync engine ───────────────────────────────────────────────────
  // `runSync` is the one place a queued sale is actually replayed. It reuses
  // `completeSaleGuarded` (`saleService.completeSale`, imported above) — the
  // exact same permission/approval gate and RPC call an online sale takes —
  // so nothing about sync bypasses business rules; only the queue's own
  // dispatch (network detection, retry ordering, backoff) is new.
  const runSync = useCallback(
    async (options: { force?: boolean } = {}) => {
      if (!offlineCapable) return;
      const before = await getSyncSummary();
      if (before.pendingCount + before.errorCount + before.conflictCount === 0) return;
      setSyncSummary((prev) => ({ ...prev, syncing: true }));
      try {
        if (options.force) await retrySyncNow(completeSaleGuarded);
        else await processOutbox(completeSaleGuarded);

        // Never let a catalogue read race ahead of queued mutations. If any
        // sale is still pending/error/conflict, keep the optimistic local stock
        // visible. Once the outbox is empty every sale has committed server-side,
        // so the authoritative refresh must now contain those deductions.
        const after = await getSyncSummary();
        if (after.pendingCount + after.errorCount + after.conflictCount === 0) {
          await loadCatalog();
        }
        await refreshSales({ silent: true });
      } finally {
        await refreshOfflineState();
      }
    },
    [offlineCapable, loadCatalog, refreshOfflineState, refreshSales],
  );

  // Sync triggers: connectivity flips to online, and a bounded periodic timer
  // while the app is open and something is actually queued. No Background
  // Sync API dependency (browser support varies) and no unbounded/aggressive
  // retry loop — the interval is long, and each per-entry retry itself backs
  // off (see offline/outbox.ts).
  useEffect(() => {
    if (!offlineCapable) return;
    if (connectivity === "online") void runSync();
  }, [offlineCapable, connectivity, runSync]);

  useEffect(() => {
    if (!offlineCapable) return;
    const interval = window.setInterval(() => {
      if (getConnectivityStatus() === "online") void runSync();
    }, 20_000);
    return () => window.clearInterval(interval);
  }, [offlineCapable, runSync]);

  /** The manual "Retry sync" button — attempts everything queued right now. */
  const retrySync = useCallback(async () => {
    await runSync({ force: true });
  }, [runSync]);

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
      const effective = promotionUnitPrice(
        current.id,
        variant?.id ?? null,
        current.category_id ?? null,
        officialUnit,
        promotions,
        posPromotionTargets,
        new Date(),
        "pos",
      );
      const line: CartLine = {
        product_id: current.id,
        variant_id: variant?.id ?? null,
        variant_sku: variant?.sku ?? null,
        color_ar: variant?.color_ar ?? null,
        color_en: variant?.color_en ?? null,
        size: variant?.size ?? null,
        size_label: variant?.size_label ?? null,
        sku: variant?.sku ?? current.sku,
        name_ar: current.name_ar,
        name_en: current.name_en,
        barcode: variant?.barcode ?? current.barcode,
        unit_price: effective.unit,
        max_qty: maxQty,
        qty: 1,
        image_url: variant?.image_url ?? current.image_url,
        item_discount: { ...EMPTY_DISCOUNT },
      };

      const result = addCartLine(linesRef.current, line);
      if (!result.added) return false;
      updateLines(() => result.lines);
      return true;
    },
    [products, variants, promotions, posPromotionTargets, updateLines],
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
      if (product.variants_enabled) return false;
      return addLine(product);
    },
    [products, variants, addLine],
  );

  const increase = useCallback((key: string) => {
    updateLines((prev) => changeCartQuantity(prev, key, 1));
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
    // Clearing merchandise is not an explicit request to clear the customer.
  }, [updateLines]);

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
            discount_type: l.item_discount?.type ?? "none",
            discount_value: l.item_discount?.value ?? 0,
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
      const cashOnly = payments.length > 0 && payments.every((p) => p.method === "cash");

      const queueOfflineCashSale = async (): Promise<SaleModel> => {
        if (!cashOnly) {
          throw new AppError(
            "VALIDATION",
            "No connection — only cash sales can be completed offline. InstaPay/card payments need the server to verify them.",
          );
        }

        // The direct offline path may not call the repository, but it still runs
        // the same local permission and cached approval-rule gates before money
        // is accepted. Server/RLS checks run again when this exact input syncs.
        assertCanCompleteSale(input);
        assertWithinApprovalLimit(
          evaluateDiscountRule(cachedApprovalRules(), discountPercentOf(input)),
        );

        const inventory = planOfflineInventory(
          products,
          variants,
          input.lines,
          catalogCachedAt,
        );
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
            sku: line.sku,
            unit_price: line.unit_price,
          })),
          { subtotal: totals.subtotal, discount_amount: totals.discountAmount, total: totals.total },
          inventory.writes,
        );
        const displaySale = await getOfflineSaleDisplay(record.id);
        if (!displaySale) throw new AppError("DB", "Offline sale was saved but could not be reloaded");

        // Persistence succeeded: reflect the exact same stock plan in React,
        // then clear the cart and show the receipt. No HTTP/auth/RPC awaited.
        setProducts(inventory.products);
        setVariants([...inventory.variants].sort(compareVariants));
        await refreshOfflineState();
        setCompletedSale(displaySale);
        updateLines(() => []);
        setDiscountValue(EMPTY_DISCOUNT);
        return displaySale;
      };

      try {
        // The five-minute bug was here: even after the browser had already told
        // us it was offline, every sale entered Supabase and waited for fetch/
        // auth retry timeouts before the catch queued it. A known-offline cash
        // sale now takes the local transaction immediately.
        if (offlineCapable && connectivity === "offline") {
          return await queueOfflineCashSale();
        }

        const sale = await completeSaleGuarded(input);
        reportNetworkResult("success");
        await loadCatalog();
        setCompletedSale(sale);
        updateLines(() => []);
        setDiscountValue(EMPTY_DISCOUNT);
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
        const appErr = err instanceof AppError ? err : null;
        if (offlineCapable && appErr?.code === "NETWORK") {
          reportNetworkResult("network-error");
          return await queueOfflineCashSale();
        }
        throw err;
      } finally {
        setCompleting(false);
      }
    },
    [
      canSell,
      completing,
      lines,
      discount,
      refreshSales,
      loadCatalog,
      selectedCustomer,
      user,
      updateLines,
      offlineCapable,
      connectivity,
      products,
      variants,
      catalogCachedAt,
      totals,
      refreshOfflineState,
    ],
  );

  const dismissCompleted = useCallback(() => setCompletedSale(null), []);

  const dismissApprovalAsk = useCallback(() => setApprovalAsk(null), []);

  const visibleSales = useMemo(() => [...offlineSales, ...sales], [offlineSales, sales]);

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
      setLineDiscount,
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
      connectivity,
      workingFromCache,
      catalogCachedAt,
      syncPendingCount: syncSummary.pendingCount,
      syncErrorCount: syncSummary.errorCount,
      syncConflictCount: syncSummary.conflictCount,
      syncing: syncSummary.syncing,
      lastSyncedAt,
      retrySync,
      visibleSales,
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
      setLineDiscount,
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
      connectivity,
      workingFromCache,
      catalogCachedAt,
      syncSummary,
      lastSyncedAt,
      retrySync,
      visibleSales,
    ],
  );

  return <PosContext.Provider value={value}>{children}</PosContext.Provider>;
}

export function usePos(): PosContextValue {
  const ctx = useContext(PosContext);
  if (!ctx) throw new Error("usePos must be used inside <PosProvider>");
  return ctx;
}
