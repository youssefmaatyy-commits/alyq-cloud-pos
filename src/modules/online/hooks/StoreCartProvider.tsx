/**
 * The storefront cart, its coupon, and checkout.
 *
 * The cart is a list of `{product_id, quantity}` and nothing else. Prices are
 * looked up from the catalogue on every render, which is what keeps a tab that
 * was open overnight from checking out at yesterday's price — and it matches what
 * the server does, so the number on the confirmation screen is the number the
 * order was written with, not a stale copy of it.
 *
 * The cart survives a reload (localStorage), and lines whose product has gone off
 * the website are dropped on load rather than failing at checkout.
 *
 * Coupons are checked against the server, not against a local copy: in live mode
 * the code list is staff-only, so the cart asks `check_storefront_coupon` about
 * the one code the customer typed. The answer is advisory — `place_online_order`
 * recomputes the discount from the catalogue — and the cart re-asks whenever the
 * contents change, so a code that stops applying says so instead of quietly
 * vanishing from the total.
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
import type { Product } from "@/modules/products/types";
import { getOnlineOrdersRepository } from "../data";
import {
  describeThrown,
  toOnlineError,
  type OnlineError,
  type PlaceOrderResult,
} from "../data/repository";
import type {
  CustomerAddress,
  DeliveryType,
  OnlineOrder,
  OnlinePaymentMethod,
  PlaceOrderInput,
  ProductContent,
} from "../types";
import { newOrderClientRef } from "../types";
import {
  campaignFor,
  deliveryFeeFor,
  freeDeliveryProgress,
  normalizeCouponCode,
  round2,
  unitPriceOf,
  type CartTotals,
} from "../services/pricing";
import { availableToPromise, findOversell, type OversellLine } from "../services/availability";
import type { CouponCheckReason } from "../data/repository";
import { useStorefront } from "./StorefrontProvider";
import { useStoreAccount } from "./StoreAccountProvider";

const CART_KEY = "alyq.store.cart.v2";

export interface CartLine {
  product_id: string;
  quantity: number;
  added_at: string;
}

/** A cart line resolved against the catalogue — what the cart screen renders. */
export interface CartEntry {
  product: Product;
  content: ProductContent | null;
  quantity: number;
  /** Unit price after any live campaign. */
  price: number;
  listPrice: number;
  lineTotal: number;
  /** Units that may still be promised; null when stock is not tracked. */
  available: number | null;
  inStock: boolean;
}

export interface CheckoutInput {
  customer_name: string;
  customer_phone: string;
  customer_email?: string | null;
  address: CustomerAddress | null;
  notes?: string | null;
}

interface StoredCart {
  lines: CartLine[];
  couponCode: string | null;
  deliveryType: DeliveryType;
  paymentMethod: OnlinePaymentMethod;
}

function readStoredCart(): StoredCart {
  const fallback: StoredCart = {
    lines: [],
    couponCode: null,
    deliveryType: "delivery",
    paymentMethod: "cod",
  };
  try {
    const raw = window.localStorage.getItem(CART_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<StoredCart>;
    return {
      lines: Array.isArray(parsed.lines)
        ? parsed.lines
            .filter(
              (line): line is CartLine =>
                Boolean(line) &&
                typeof line.product_id === "string" &&
                Number.isFinite(Number(line.quantity)),
            )
            .map((line) => ({
              product_id: line.product_id,
              quantity: Math.max(1, Math.trunc(Number(line.quantity)) || 1),
              added_at: typeof line.added_at === "string" ? line.added_at : new Date().toISOString(),
            }))
        : [],
      couponCode: typeof parsed.couponCode === "string" ? parsed.couponCode : null,
      deliveryType: parsed.deliveryType === "pickup" ? "pickup" : "delivery",
      paymentMethod: parsed.paymentMethod === "instapay" ? "instapay" : "cod",
    };
  } catch {
    return fallback;
  }
}

export interface StoreCartContextValue {
  lines: CartLine[];
  entries: CartEntry[];
  unitCount: number;
  isEmpty: boolean;

  add: (product: Product, quantity?: number) => boolean;
  setQuantity: (productId: string, quantity: number) => void;
  increase: (productId: string) => void;
  decrease: (productId: string) => void;
  remove: (productId: string) => void;
  clear: () => void;
  /** Add every line of a past order again — "reorder". */
  addMany: (lines: { product_id: string; quantity: number }[]) => number;

  totals: CartTotals;
  /** Lines the cart cannot actually fulfil right now. */
  problems: OversellLine[];

  couponCode: string | null;
  couponInput: string;
  setCouponInput: (value: string) => void;
  couponError: CouponCheckReason | null;
  couponDiscount: number;
  applyingCoupon: boolean;
  applyCoupon: (code?: string) => Promise<boolean>;
  clearCoupon: () => void;

  deliveryType: DeliveryType;
  setDeliveryType: (value: DeliveryType) => void;
  paymentMethod: OnlinePaymentMethod;
  setPaymentMethod: (value: OnlinePaymentMethod) => void;
  freeDelivery: { eligible: boolean; remaining: number; threshold: number } | null;

  placing: boolean;
  checkoutError: OnlineError | null;
  clearCheckoutError: () => void;
  checkout: (input: CheckoutInput) => Promise<OnlineOrder | null>;
  /** The order just placed — the confirmation screen reads it. */
  lastOrder: OnlineOrder | null;
  /** True when the submission was a retry that returned an existing order. */
  lastWasDuplicate: boolean;
  dismissLastOrder: () => void;
}

const StoreCartContext = createContext<StoreCartContextValue | null>(null);

export function useStoreCart(): StoreCartContextValue {
  const context = useContext(StoreCartContext);
  if (!context) {
    throw new Error("useStoreCart must be used inside <StoreCartProvider>");
  }
  return context;
}

export function StoreCartProvider({ children }: { children: ReactNode }) {
  const { products, campaigns, catalogContext, settings, checkCoupon: verifyCode } =
    useStorefront();
  const { customer } = useStoreAccount();
  const orders = useMemo(() => getOnlineOrdersRepository(), []);

  const [stored] = useState<StoredCart>(() =>
    typeof window === "undefined"
      ? { lines: [], couponCode: null, deliveryType: "delivery" as const, paymentMethod: "cod" as const }
      : readStoredCart(),
  );

  const [lines, setLines] = useState<CartLine[]>(stored.lines);
  const [couponCode, setCouponCode] = useState<string | null>(stored.couponCode);
  const [couponInput, setCouponInput] = useState("");
  const [couponError, setCouponError] = useState<CouponCheckReason | null>(null);
  const [couponDiscount, setCouponDiscount] = useState(0);
  const [applyingCoupon, setApplyingCoupon] = useState(false);
  const [deliveryType, setDeliveryType] = useState<DeliveryType>(stored.deliveryType);
  const [paymentMethod, setPaymentMethod] = useState<OnlinePaymentMethod>(stored.paymentMethod);
  const [placing, setPlacing] = useState(false);
  const [checkoutError, setCheckoutError] = useState<OnlineError | null>(null);
  const [lastOrder, setLastOrder] = useState<OnlineOrder | null>(null);
  const [lastWasDuplicate, setLastWasDuplicate] = useState(false);

  const productsById = useMemo(() => new Map(products.map((product) => [product.id, product])), [
    products,
  ]);

  // Drop lines whose product has gone off the website: a cart that cannot be
  // checked out is worse than a cart with one item missing, and the customer is
  // told on the cart screen rather than at the last step.
  const pruned = useRef(false);
  useEffect(() => {
    if (pruned.current || products.length === 0) return;
    pruned.current = true;
    setLines((current) =>
      current.filter((line) => {
        const product = productsById.get(line.product_id);
        return product ? product.active && product.show_on_website : false;
      }),
    );
  }, [products.length, productsById]);

  // Persist.
  useEffect(() => {
    try {
      window.localStorage.setItem(
        CART_KEY,
        JSON.stringify({ lines, couponCode, deliveryType, paymentMethod } satisfies StoredCart),
      );
    } catch {
      /* private mode: the cart simply will not survive a reload */
    }
  }, [lines, couponCode, deliveryType, paymentMethod]);

  const entries = useMemo<CartEntry[]>(() => {
    const now = new Date();
    return lines.flatMap((line) => {
      const product = productsById.get(line.product_id);
      if (!product) return [];
      const campaign = campaignFor(product.id, campaigns, now);
      const price = unitPriceOf(product.selling_price, campaign);
      const available = availableToPromise(
        product,
        catalogContext.reserved.get(product.id) ?? 0,
      );
      return [
        {
          product,
          content: catalogContext.contents.get(product.id) ?? null,
          quantity: line.quantity,
          price,
          listPrice: Math.max(product.selling_price, 0),
          lineTotal: round2(price * line.quantity),
          available,
          inStock: available === null || available > 0,
        },
      ];
    });
  }, [campaigns, catalogContext.contents, catalogContext.reserved, lines, productsById]);

  const subtotal = useMemo(
    () => round2(entries.reduce((sum, entry) => sum + entry.lineTotal, 0)),
    [entries],
  );

  const discount = Math.min(Math.max(round2(couponDiscount), 0), subtotal);
  const deliveryFee = deliveryFeeFor(settings.delivery, deliveryType, round2(subtotal - discount));
  const totals = useMemo<CartTotals>(
    () => ({
      lines: entries.map((entry) => ({
        product_id: entry.product.id,
        quantity: entry.quantity,
        list_price: entry.listPrice,
        unit_price: entry.price,
        line_total: entry.lineTotal,
        campaign_id: null,
      })),
      subtotal,
      discount_code: discount > 0 ? couponCode : null,
      discount_amount: discount,
      delivery_fee: deliveryFee,
      total: round2(subtotal - discount + deliveryFee),
      unit_count: entries.reduce((sum, entry) => sum + entry.quantity, 0),
    }),
    [couponCode, deliveryFee, discount, entries, subtotal],
  );

  const freeDelivery = useMemo(
    () => freeDeliveryProgress(settings.delivery, round2(subtotal - discount)),
    [discount, settings.delivery, subtotal],
  );

  const problems = useMemo(
    () =>
      findOversell(
        lines.map((line) => ({ product_id: line.product_id, quantity: line.quantity })),
        products,
        catalogContext.reserved,
      ),
    [catalogContext.reserved, lines, products],
  );

  const unitCount = totals.unit_count;
  const isEmpty = entries.length === 0;

  // ── cart operations ───────────────────────────────────────────────────────

  const add = useCallback(
    (product: Product, quantity = 1): boolean => {
      const wanted = Math.max(1, Math.trunc(quantity) || 1);
      let added = false;
      setLines((current) => {
        const existing = current.find((line) => line.product_id === product.id);
        const nextQuantity = (existing?.quantity ?? 0) + wanted;
        // Do not add more than can be promised; the button says why.
        const available = availableToPromise(
          product,
          catalogContext.reserved.get(product.id) ?? 0,
        );
        if (available !== null && nextQuantity > available) return current;
        added = true;
        if (existing) {
          return current.map((line) =>
            line.product_id === product.id
              ? { ...line, quantity: nextQuantity, added_at: new Date().toISOString() }
              : line,
          );
        }
        return [
          ...current,
          {
            product_id: product.id,
            quantity: wanted,
            added_at: new Date().toISOString(),
          },
        ];
      });
      return added;
    },
    [catalogContext.reserved],
  );

  const setQuantity = useCallback(
    (productId: string, quantity: number) => {
      const wanted = Math.max(0, Math.trunc(quantity) || 0);
      setLines((current) => {
        if (wanted === 0) return current.filter((line) => line.product_id !== productId);
        const product = productsById.get(productId);
        if (product) {
          const available = availableToPromise(
            product,
            catalogContext.reserved.get(productId) ?? 0,
          );
          if (available !== null && wanted > available) return current;
        }
        return current.map((line) =>
          line.product_id === productId ? { ...line, quantity: wanted } : line,
        );
      });
    },
    [catalogContext.reserved, productsById],
  );

  const increase = useCallback(
    (productId: string) => {
      const line = lines.find((candidate) => candidate.product_id === productId);
      setQuantity(productId, (line?.quantity ?? 0) + 1);
    },
    [lines, setQuantity],
  );

  const decrease = useCallback(
    (productId: string) => {
      const line = lines.find((candidate) => candidate.product_id === productId);
      setQuantity(productId, (line?.quantity ?? 0) - 1);
    },
    [lines, setQuantity],
  );

  const remove = useCallback((productId: string) => {
    setLines((current) => current.filter((line) => line.product_id !== productId));
  }, []);

  const clear = useCallback(() => {
    setLines([]);
    setCouponCode(null);
    setCouponDiscount(0);
    setCouponError(null);
  }, []);

  const addMany = useCallback(
    (requested: { product_id: string; quantity: number }[]): number => {
      let count = 0;
      for (const line of requested) {
        const product = productsById.get(line.product_id);
        if (!product || !product.active || !product.show_on_website) continue;
        if (add(product, line.quantity)) count += 1;
      }
      return count;
    },
    [add, productsById],
  );

  // ── coupons ───────────────────────────────────────────────────────────────

  /**
   * Ask the authoritative side about one code, and apply the answer.
   *
   * The cart sends its own subtotal and product/category ids; the reply is
   * advisory, because checkout recomputes everything from the catalogue. Keeping
   * the check server-side is what stops a visitor reading the code list.
   */
  const verifyCoupon = useCallback(
    async (rawCode: string, currentSubtotal: number, currentEntries: CartEntry[]) => {
      const code = normalizeCouponCode(rawCode);
      if (!code) return { valid: false as const, reason: "not_found" as CouponCheckReason };
      const result = await verifyCode({
        code,
        subtotal: round2(currentSubtotal),
        productIds: currentEntries.map((entry) => entry.product.id),
        categoryIds: currentEntries.map((entry) => entry.product.category_id ?? ""),
      });
      if (result.valid) {
        setCouponCode(result.code);
        setCouponDiscount(result.discount);
        setCouponError(null);
      } else {
        setCouponCode(null);
        setCouponDiscount(0);
        setCouponError(result.reason);
      }
      return result;
    },
    [verifyCode],
  );

  const applyCoupon = useCallback(
    async (code?: string): Promise<boolean> => {
      const raw = normalizeCouponCode(code ?? couponInput);
      if (!raw) {
        setCouponError("not_found");
        return false;
      }
      if (isEmpty) {
        setCouponError("not_applicable");
        return false;
      }
      setApplyingCoupon(true);
      setCouponError(null);
      try {
        const result = await verifyCoupon(raw, subtotal, entries);
        if (result.valid) setCouponInput(result.code);
        return result.valid;
      } catch (caught) {
        // An unreachable check is not a rejected code: say nothing about the
        // code itself and let the customer try again.
        setCheckoutError(toOnlineError(caught));
        return false;
      } finally {
        setApplyingCoupon(false);
      }
    },
    [couponInput, entries, isEmpty, subtotal, verifyCoupon],
  );

  const clearCoupon = useCallback(() => {
    setCouponCode(null);
    setCouponDiscount(0);
    setCouponError(null);
    setCouponInput("");
  }, []);

  // Re-check an applied code whenever the cart changes: a code with a minimum
  // subtotal stops applying when the customer removes an item, and the total has
  // to say so rather than quietly keeping the discount.
  const recheck = useRef<Promise<unknown> | null>(null);
  useEffect(() => {
    if (!couponCode || subtotal <= 0) return;
    const timer = window.setTimeout(() => {
      recheck.current = verifyCoupon(couponCode, subtotal, entries).catch(() => null);
    }, 350);
    return () => window.clearTimeout(timer);
  }, [couponCode, entries, subtotal, verifyCoupon]);

  // ── checkout ──────────────────────────────────────────────────────────────

  const checkout = useCallback(
    async (input: CheckoutInput): Promise<OnlineOrder | null> => {
      setCheckoutError(null);
      if (entries.length === 0) {
        setCheckoutError(
          toOnlineError(new Error("Empty cart")),
        );
        return null;
      }
      setPlacing(true);
      try {
        const payload: PlaceOrderInput = {
          // One key per attempt, held for the duration: a double tap reuses it
          // and the server returns the order that already exists.
          client_ref: clientRefRef.current ?? newOrderClientRef(),
          customer_name: input.customer_name,
          customer_phone: input.customer_phone,
          customer_email: input.customer_email ?? null,
          store_customer_id: customer?.id ?? null,
          delivery_type: deliveryType,
          address: deliveryType === "delivery" ? input.address : null,
          lines: lines.map((line) => ({
            product_id: line.product_id,
            qty: line.quantity,
          })),
          coupon_code: couponCode,
          payment_method: paymentMethod,
          notes: input.notes ?? null,
        };
        clientRefRef.current = payload.client_ref;

        const result: PlaceOrderResult = await orders.placeOrder(payload);
        setLastOrder(result.order);
        setLastWasDuplicate(result.duplicate);
        clientRefRef.current = null;
        clear();
        setLines([]);
        if (customer) {
          await orders
            .listMyOrders(customer.id)
            .then(() => undefined)
            .catch(() => undefined);
        }
        return result.order;
      } catch (caught) {
        const normalized = toOnlineError(caught);
        setCheckoutError(normalized);
        // The customer only ever sees the friendly `store.error.<code>` text.
        // What an operator needs to act on — the code, the server's own wording,
        // details and hint — goes to the console (and from there to logs), never
        // to the storefront. Read field by field, so a Supabase error (a plain
        // object, not an `Error`) is reported as itself and never as
        // `[object Object]`. No SQL, no keys, no tokens, no stack.
        const described = describeThrown(caught);
        console.error("[storefront] order placement failed", {
          code: normalized.code,
          message: described.message,
          details: described.details ?? normalized.detail,
          hint: described.hint,
        });
        // A failed submission keeps its key only while the same cart is being
        // retried; once the customer changes the cart, it is a new attempt.
        return null;
      } finally {
        setPlacing(false);
      }
    },
    [clear, couponCode, customer, deliveryType, entries.length, lines, orders, paymentMethod],
  );

  const clientRefRef = useRef<string | null>(null);

  // Changing the cart invalidates the idempotency key: the next submission is a
  // different order, and reusing the key would return the previous one.
  useEffect(() => {
    clientRefRef.current = null;
  }, [lines, couponCode, deliveryType, paymentMethod]);

  const value = useMemo<StoreCartContextValue>(
    () => ({
      lines,
      entries,
      unitCount,
      isEmpty,
      add,
      setQuantity,
      increase,
      decrease,
      remove,
      clear,
      addMany,
      totals,
      problems,
      couponCode,
      couponInput,
      setCouponInput,
      couponError,
      couponDiscount: discount,
      applyingCoupon,
      applyCoupon,
      clearCoupon,
      deliveryType,
      setDeliveryType,
      paymentMethod,
      setPaymentMethod,
      freeDelivery,
      placing,
      checkoutError,
      clearCheckoutError: () => setCheckoutError(null),
      checkout,
      lastOrder,
      lastWasDuplicate,
      dismissLastOrder: () => {
        setLastOrder(null);
        setLastWasDuplicate(false);
      },
    }),
    [
      add,
      addMany,
      applyingCoupon,
      applyCoupon,
      checkout,
      clear,
      couponCode,
      couponError,
      couponInput,
      decrease,
      deliveryType,
      discount,
      entries,
      freeDelivery,
      increase,
      isEmpty,
      lastOrder,
      lastWasDuplicate,
      lines,
      paymentMethod,
      placing,
      problems,
      remove,
      setQuantity,
      totals,
      unitCount,
      checkoutError,
    ],
  );

  return <StoreCartContext.Provider value={value}>{children}</StoreCartContext.Provider>;
}
