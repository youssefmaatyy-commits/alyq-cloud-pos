import { OrderReadConsistency } from "../services/orderReadConsistency";
/**
 * Online orders — the POS side.
 *
 * One provider owns the queue so the screen, the sidebar badge and the order
 * drawer all read the same state: a filter change, an approval and a poll are
 * three views of one list rather than three lists that can disagree about
 * whether an order is still pending.
 *
 * Every mutation goes through `resolveOrder`, which is the single funnel into
 * `resolve_online_order` (live) or the demo repository's equivalent. The screen
 * therefore cannot approve an order without the reservation being converted and
 * the sale being created, and cannot cancel one without the reason being
 * recorded — those side effects belong to the transition, not to the button.
 */
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
import { canActAs } from "@/lib/permissions/enforce";
import { useAuth } from "@/lib/auth";
import { getCurrentUser } from "@/modules/inventory/permissions";
import type { Product } from "@/modules/products/types";
import { getCatalogRepository } from "@/modules/products/data";
import { useRealtimeWatch } from "@/lib/supabase/useRealtimeWatch";
import { getSalesRepository } from "@/modules/pos/data";
import type { Sale } from "@/modules/pos/types";
import { getOnlineMode, getOnlineOrdersRepository } from "../data";
import {
  EMPTY_ORDER_FILTER,
  OnlineError,
  isEmptyOrderFilter,
  toOnlineError,
} from "../data/repository";
import type { OnlineOrderFilter, OnlineMode, OrderCounts } from "../data/repository";
import { EMPTY_ORDER_COUNTS } from "../data/repository";
import type { OnlineOrder, OrderAction, StockReservation } from "../types";
import { availableActions } from "../services/orderWorkflow";
import { reservedByProduct } from "../services/availability";
import {
  reservationAlerts,
  reservationAlertSignature,
  reviewReservations,
  type ReservationAlert,
  type ReservationReview,
} from "../services/reservationRepair";
import { useOnlineNotificationState } from "./OnlineNotificationsProvider";

export interface OnlineOrdersContextValue {
  mode: OnlineMode;
  orders: OnlineOrder[];
  loading: boolean;
  error: OnlineError | null;
  filter: OnlineOrderFilter;
  setFilter: (patch: Partial<OnlineOrderFilter>) => void;
  resetFilter: () => void;
  counts: OrderCounts;
  reservations: StockReservation[];
  /** Product id → units currently held by pending orders. */
  reservedByProduct: Map<string, number>;
  refresh: (options?: { silent?: boolean }) => Promise<void>;

  /** The order open in the detail drawer, with its items and timeline. */
  selected: OnlineOrder | null;
  select: (id: string | null) => Promise<void>;

  /** Which action is running, so exactly one button shows a spinner. */
  busyAction: { orderId: string; action: OrderAction } | null;
  actionError: OnlineError | null;
  clearActionError: () => void;

  perform: (orderId: string, action: OrderAction, reason?: string | null) => Promise<OnlineOrder | null>;
  actionsFor: (order: OnlineOrder) => OrderAction[];

  canManage: boolean;
  canVoidSale: boolean;
  canVerifyPayment: boolean;

  /** The sale an approved order created — the link into the register. */
  saleFor: (order: OnlineOrder) => Sale | null;
  sales: Sale[];
  /** Catalogue, so the drawer can show what is in stock beside what is held. */
  products: Product[];

  /**
   * The stock-hold review of everything this provider already loaded (Phase 15).
   * Computed here rather than on the holds screen so the queue, the sidebar badge,
   * the dashboard widget and that screen all read one review — and so no screen
   * has to fetch the same three lists again to get it.
   */
  holdReview: ReservationReview;
  /** What that review means as alerts, most urgent kind first. */
  holdAlerts: ReservationAlert[];
}

const OnlineOrdersContext = createContext<OnlineOrdersContextValue | null>(null);

export function useOnlineOrders(): OnlineOrdersContextValue {
  const context = useContext(OnlineOrdersContext);
  if (!context) {
    throw new Error("useOnlineOrders must be used inside <OnlineOrdersProvider>");
  }
  return context;
}

export function OnlineOrdersProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const mode = getOnlineMode();
  const repository = useMemo(() => getOnlineOrdersRepository(), []);
  const salesRepository = useMemo(() => getSalesRepository(), []);

  const [orders, setOrders] = useState<OnlineOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<OnlineError | null>(null);
  const [filter, setFilterState] = useState<OnlineOrderFilter>(EMPTY_ORDER_FILTER);
  const [counts, setCounts] = useState<OrderCounts>(EMPTY_ORDER_COUNTS);
  const [reservations, setReservations] = useState<StockReservation[]>([]);
  const [selected, setSelected] = useState<OnlineOrder | null>(null);
  const [busyAction, setBusyAction] = useState<OnlineOrdersContextValue["busyAction"]>(null);
  const [actionError, setActionError] = useState<OnlineError | null>(null);
  const [sales, setSales] = useState<Sale[]>([]);
  const [products, setProducts] = useState<Product[]>([]);

  const mounted = useRef(true);
  // Read responses are snapshots, not authority over later writes/selections.
  // A fast payment action can finish before the drawer's initial getOrder read,
  // and a previous filter load can arrive after the clerk has changed filters.
  const reads = useRef(new OrderReadConsistency());
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const canManage = canActAs(user, "manage_online_orders");
  // Unwinding an approved order voids its sale and restores the stock, so it
  // needs the same authority as voiding at the till.
  const canVoidSale = canActAs(user, "void_sale");
  const canVerifyPayment = canActAs(user, "confirm_payment");

  const actor = useMemo(() => getCurrentUser(), [user]);

  const load = useCallback(
    async (currentFilter: OnlineOrderFilter, options?: { silent?: boolean }) => {
      const ticket = reads.current.beginLoad();
      if (!canManage) {
        setOrders([]);
        setCounts(EMPTY_ORDER_COUNTS);
        setLoading(false);
        return;
      }
      // A realtime event asks for a silent read: replace the data, keep the
      // screen readable instead of flashing a spinner over it.
      if (options?.silent !== true) setLoading(true);
      try {
        const [list, totals, holds, saleList, catalog] = await Promise.all([
          repository.listOrders(currentFilter),
          repository.counts(),
          repository.listReservations(),
          salesRepository.listSales(),
          getCatalogRepository().listProducts(),
        ]);
        if (!mounted.current || !reads.current.canApplyLoad(ticket)) return;
        setOrders(list);
        setCounts(totals);
        setReservations(holds);
        setSales(saleList);
        setProducts(catalog);
        setError(null);
        // Keep the drawer honest: an order that has moved on shows its new state.
        if (reads.current.canApplyLoadSelection(ticket)) setSelected((previous) =>
          previous ? list.find((order) => order.id === previous.id) ?? null : null,
        );
      } catch (caught) {
        if (mounted.current && reads.current.canApplyLoad(ticket)) setError(toOnlineError(caught));
      } finally {
        if (mounted.current && reads.current.isLatestLoad(ticket)) setLoading(false);
      }
    },
    [canManage, repository, salesRepository],
  );

  useEffect(() => {
    void load(filter);
  }, [filter, load]);

  // Phase 16: the queue, its timeline and its holds arrive over the shared
  // channel, so two staff working the same order see each other's decisions
  // without reloading — and a hold settled on the stock-holds screen (Phase 15)
  // changes the availability this provider hands out. Gated on the same
  // capability as the read: subscribing to rows RLS will hide is noise, not
  // security, and in demo mode the bus does nothing at all.
  useRealtimeWatch(
    ["online_orders", "order_events", "stock_reservations"],
    () => refresh({ silent: true }),
    { enabled: canManage },
  );

  const setFilter = useCallback((patch: Partial<OnlineOrderFilter>) => {
    setFilterState((current) => ({ ...current, ...patch }));
  }, []);

  const resetFilter = useCallback(() => setFilterState(EMPTY_ORDER_FILTER), []);

  const refresh = useCallback(async (options?: { silent?: boolean }) => {
    await load(filter, options);
  }, [filter, load]);

  const select = useCallback(
    async (id: string | null) => {
      const ticket = reads.current.beginSelection();
      if (!id) {
        setSelected(null);
        return;
      }
      // The list already carries items and events; re-reading gets the freshest
      // timeline, which matters once two staff are working the same queue.
      const fromList = orders.find((order) => order.id === id) ?? null;
      setSelected(fromList);
      try {
        const fresh = await repository.getOrder(id);
        if (mounted.current && reads.current.canApplySelection(ticket)) setSelected(fresh);
      } catch {
        // The list copy is good enough to look at; the failure is not worth an
        // error banner on a read.
      }
    },
    [orders, repository],
  );

  const perform = useCallback(
    async (
      orderId: string,
      action: OrderAction,
      reason?: string | null,
    ): Promise<OnlineOrder | null> => {
      reads.current.recordMutation();
      setActionError(null);
      setBusyAction({ orderId, action });
      try {
        const updated = await repository.resolveOrder(orderId, {
          action,
          reason: reason ?? null,
          user_id: actor.id,
          user_name: actor.name,
        });
        reads.current.recordMutation();
        if (!mounted.current) return updated;

        // Update in place so the row does not flash while the list re-reads.
        setOrders((previous) =>
          previous.map((order) => (order.id === updated.id ? updated : order)),
        );
        setSelected((previous) => (previous?.id === updated.id ? updated : previous));
        // Stock and money moved: re-read the numbers the rest of the app shows.
        const [holds, saleList, totals] = await Promise.all([
          repository.listReservations(),
          salesRepository.listSales(),
          repository.counts(),
        ]);
        if (mounted.current) {
          setReservations(holds);
          setSales(saleList);
          setCounts(totals);
        }
        return updated;
      } catch (caught) {
        const normalized = toOnlineError(caught);
        if (mounted.current) setActionError(normalized);
        return null;
      } finally {
        if (mounted.current) setBusyAction(null);
      }
    },
    [actor.id, actor.name, repository, salesRepository],
  );

  const actionsFor = useCallback(
    (order: OnlineOrder): OrderAction[] =>
      availableActions(order, { canVoidSale, canConfirmPayment: canVerifyPayment }),
    [canVoidSale, canVerifyPayment],
  );

  const saleFor = useCallback(
    (order: OnlineOrder): Sale | null =>
      order.sale_id ? sales.find((sale) => sale.id === order.sale_id) ?? null : null,
    [sales],
  );

  const reserved = useMemo(() => reservedByProduct(reservations), [reservations]);

  // A filtered queue is a partial view: a hold whose order is merely out of view
  // is not an orphan, so the review is told and sets those rows aside instead of
  // reporting them.
  const ordersComplete = isEmptyOrderFilter(filter);
  const holdReview = useMemo(
    () => reviewReservations({ reservations, orders, products, ordersComplete }),
    [reservations, orders, products, ordersComplete],
  );
  const holdAlerts = useMemo(() => reservationAlerts(holdReview), [holdReview]);

  // Publish the alerts to the notification state above the shell, so the sidebar
  // badge and the banner on this screen are the same number. The signature is the
  // guard: the provider re-renders for many reasons, and reporting on each of
  // them would bounce between two providers forever.
  const { reportHoldAlerts } = useOnlineNotificationState();
  const alertSignature = reservationAlertSignature(holdAlerts);
  const alertsRef = useRef(holdAlerts);
  alertsRef.current = holdAlerts;
  useEffect(() => {
    reportHoldAlerts(alertsRef.current);
  }, [alertSignature, reportHoldAlerts]);

  const value = useMemo<OnlineOrdersContextValue>(
    () => ({
      mode,
      orders,
      loading,
      error,
      filter,
      setFilter,
      resetFilter,
      counts,
      reservations,
      reservedByProduct: reserved,
      refresh,
      selected,
      select,
      busyAction,
      actionError,
      clearActionError: () => setActionError(null),
      perform,
      actionsFor,
      canManage,
      canVoidSale,
      canVerifyPayment,
      saleFor,
      sales,
      products,
      holdReview,
      holdAlerts,
    }),
    [
      mode,
      orders,
      loading,
      error,
      filter,
      setFilter,
      resetFilter,
      counts,
      reservations,
      reserved,
      refresh,
      selected,
      select,
      busyAction,
      actionError,
      perform,
      actionsFor,
      canManage,
      canVoidSale,
      canVerifyPayment,
      saleFor,
      sales,
      products,
      holdReview,
      holdAlerts,
    ],
  );

  return (
    <OnlineOrdersContext.Provider value={value}>{children}</OnlineOrdersContext.Provider>
  );
}
