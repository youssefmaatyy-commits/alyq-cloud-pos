/**
 * Website accounts — sign in, profile, saved addresses, wishlist, order history.
 *
 * Accounts live in the browser profile rather than in Supabase Auth, because the
 * POS trusts any session from that realm and a shopper's session would look like
 * a staff one (see `data/localAccounts.ts`). What that means for this provider:
 *
 *   - order *history* is not a local list. It is fetched with `lookupOrder`,
 *     which the database gates on the order number plus the phone the order was
 *     placed with, so a shopper can only ever see orders they can prove are
 *     theirs. The local record only remembers which numbers to ask about.
 *   - addresses and the wishlist are per browser. They are conveniences, not
 *     records: the address an order actually used is snapshotted on the order.
 *   - saved addresses and the wishlist need an account. A guest can still check
 *     out — the checkout form takes an address inline — but there is nowhere to
 *     keep a guest's favourites that would survive them, and inventing a place
 *     would mislead them about it.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { getOnlineOrdersRepository, getStoreAccountsRepository } from "../data";
import { toOnlineError } from "../data/repository";
import type { OnlineErrorCode, StoreCustomerPatch } from "../data/repository";
import type { CustomerAddress, OnlineOrder, StoreCustomer } from "../types";
import { normalizeAddresses } from "../data/demoRepository";
import { readGuestWishlist, toggleGuestWishlist } from "../services/shopperMemory";

export interface StoreAccountContextValue {
  customer: StoreCustomer | null;
  loading: boolean;
  busy: boolean;
  /** An `OnlineErrorCode`, so the UI can translate it rather than echo English. */
  error: OnlineErrorCode | null;
  clearError: () => void;

  register: (input: {
    name: string;
    phone: string;
    email?: string | null;
    password: string;
  }) => Promise<StoreCustomer | null>;
  login: (input: { identifier: string; password: string }) => Promise<StoreCustomer | null>;
  logout: () => Promise<void>;
  updateProfile: (patch: StoreCustomerPatch) => Promise<boolean>;

  addresses: CustomerAddress[];
  addAddress: (address: CustomerAddress) => Promise<boolean>;
  updateAddress: (address: CustomerAddress) => Promise<boolean>;
  removeAddress: (id: string) => Promise<boolean>;
  setDefaultAddress: (id: string) => Promise<boolean>;

  wishlist: string[];
  inWishlist: (productId: string) => boolean;
  toggleWishlist: (productId: string) => Promise<boolean>;

  history: OnlineOrder[];
  historyLoading: boolean;
  refreshHistory: () => Promise<void>;

  /** The order a guest (or a signed-in shopper) is currently tracking. */
  tracked: OnlineOrder | null;
  track: (orderNumber: string, phone: string) => Promise<OnlineOrder | null>;
  clearTracked: () => void;
  /** Reorder: the product ids and quantities of a past order. */
  reorderLines: (order: OnlineOrder) => { product_id: string; quantity: number }[];
}

const StoreAccountContext = createContext<StoreAccountContextValue | null>(null);

export function useStoreAccount(): StoreAccountContextValue {
  const context = useContext(StoreAccountContext);
  if (!context) {
    throw new Error("useStoreAccount must be used inside <StoreAccountProvider>");
  }
  return context;
}

export function StoreAccountProvider({ children }: { children: ReactNode }) {
  const accounts = useMemo(() => getStoreAccountsRepository(), []);
  const orders = useMemo(() => getOnlineOrdersRepository(), []);

  const [customer, setCustomer] = useState<StoreCustomer | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<OnlineErrorCode | null>(null);
  const [history, setHistory] = useState<OnlineOrder[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [tracked, setTracked] = useState<OnlineOrder | null>(null);
  const [guestWishlist, setGuestWishlist] = useState<string[]>([]);

  useEffect(() => { setGuestWishlist(readGuestWishlist()); }, []);

  // Restore a session on first paint, so a returning shopper is not signed out
  // by a reload in the middle of a checkout.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const current = await accounts.current();
        if (!cancelled) setCustomer(current);
      } catch {
        if (!cancelled) setCustomer(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [accounts]);

  const refreshHistory = useCallback(async () => {
    if (!customer) {
      setHistory([]);
      return;
    }
    setHistoryLoading(true);
    try {
      const list = await orders.listMyOrders(customer.id);
      setHistory(list);
    } catch {
      // History is a convenience; a failed lookup should not blank the page.
      setHistory([]);
    } finally {
      setHistoryLoading(false);
    }
  }, [customer, orders]);

  useEffect(() => {
    void refreshHistory();
  }, [refreshHistory]);

  const fail = useCallback((caught: unknown): null => {
    setError(toOnlineError(caught).code);
    return null;
  }, []);

  const register = useCallback<StoreAccountContextValue["register"]>(
    async (input) => {
      setBusy(true);
      setError(null);
      try {
        const created = await accounts.register(input);
        setCustomer(created);
        return created;
      } catch (caught) {
        return fail(caught);
      } finally {
        setBusy(false);
      }
    },
    [accounts, fail],
  );

  const login = useCallback<StoreAccountContextValue["login"]>(
    async (input) => {
      setBusy(true);
      setError(null);
      try {
        const signedIn = await accounts.login(input);
        setCustomer(signedIn);
        return signedIn;
      } catch (caught) {
        return fail(caught);
      } finally {
        setBusy(false);
      }
    },
    [accounts, fail],
  );

  const logout = useCallback(async () => {
    setBusy(true);
    try {
      await accounts.logout();
      setCustomer(null);
      setHistory([]);
    } finally {
      setBusy(false);
    }
  }, [accounts]);

  const updateProfile = useCallback(
    async (patch: StoreCustomerPatch) => {
      if (!customer) {
        setError("not_signed_in");
        return false;
      }
      setBusy(true);
      setError(null);
      try {
        const updated = await accounts.update(customer.id, patch);
        setCustomer(updated);
        return true;
      } catch (caught) {
        fail(caught);
        return false;
      } finally {
        setBusy(false);
      }
    },
    [accounts, customer, fail],
  );

  const addresses = useMemo(
    () => normalizeAddresses(customer?.addresses ?? []),
    [customer?.addresses],
  );

  const persistAddresses = useCallback(
    async (next: CustomerAddress[]) => {
      return updateProfile({ addresses: normalizeAddresses(next) });
    },
    [updateProfile],
  );

  const addAddress = useCallback(
    (address: CustomerAddress) => persistAddresses([...addresses, address]),
    [addresses, persistAddresses],
  );

  const updateAddress = useCallback(
    (address: CustomerAddress) =>
      persistAddresses(
        addresses.map((existing) => (existing.id === address.id ? address : existing)),
      ),
    [addresses, persistAddresses],
  );

  const removeAddress = useCallback(
    (id: string) => persistAddresses(addresses.filter((address) => address.id !== id)),
    [addresses, persistAddresses],
  );

  const setDefaultAddress = useCallback(
    (id: string) =>
      persistAddresses(
        addresses.map((address) => ({ ...address, is_default: address.id === id })),
      ),
    [addresses, persistAddresses],
  );

  const wishlist = useMemo(() => customer?.wishlist ?? guestWishlist, [customer?.wishlist, guestWishlist]);

  const inWishlist = useCallback(
    (productId: string) => wishlist.includes(productId),
    [wishlist],
  );

  const toggleWishlist = useCallback(
    async (productId: string) => {
      if (!customer) {
        setGuestWishlist(toggleGuestWishlist(productId));
        return true;
      }
      const next = wishlist.includes(productId)
        ? wishlist.filter((id) => id !== productId)
        : [...wishlist, productId];
      return updateProfile({ wishlist: next });
    },
    [customer, updateProfile, wishlist],
  );

  const track = useCallback(
    async (orderNumber: string, phone: string) => {
      setBusy(true);
      setError(null);
      try {
        const order = await orders.lookupOrder(orderNumber, phone);
        setTracked(order);
        // Tracking an order you just placed is a good moment to remember it: a
        // shopper who signs in later still finds it in their history.
        if (customer) {
          await accounts.rememberOrder(customer.id, order.order_number, order.customer_phone);
          await refreshHistory();
        }
        return order;
      } catch (caught) {
        setTracked(null);
        return fail(caught);
      } finally {
        setBusy(false);
      }
    },
    [accounts, customer, fail, orders, refreshHistory],
  );

  const clearTracked = useCallback(() => setTracked(null), []);

  const reorderLines = useCallback(
    (order: OnlineOrder) =>
      order.items.map((item) => ({
        product_id: item.product_id,
        quantity: item.quantity,
      })),
    [],
  );

  const value = useMemo<StoreAccountContextValue>(
    () => ({
      customer,
      loading,
      busy,
      error,
      clearError: () => setError(null),
      register,
      login,
      logout,
      updateProfile,
      addresses,
      addAddress,
      updateAddress,
      removeAddress,
      setDefaultAddress,
      wishlist,
      inWishlist,
      toggleWishlist,
      history,
      historyLoading,
      refreshHistory,
      tracked,
      track,
      clearTracked,
      reorderLines,
    }),
    [
      customer,
      loading,
      busy,
      error,
      register,
      login,
      logout,
      updateProfile,
      addresses,
      addAddress,
      updateAddress,
      removeAddress,
      setDefaultAddress,
      wishlist,
      inWishlist,
      toggleWishlist,
      history,
      historyLoading,
      refreshHistory,
      tracked,
      track,
      clearTracked,
      reorderLines,
    ],
  );

  return (
    <StoreAccountContext.Provider value={value}>{children}</StoreAccountContext.Provider>
  );
}
