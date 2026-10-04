/**
 * The storefront cart, its coupon, and checkout.
 *
 * The cart is a list of `{product_id, variant_id, quantity}` and nothing else.
 * Prices are looked up from the catalogue on every render, which is what keeps a
 * tab that was open overnight from checking out at yesterday's price — and it
 * matches what the server does, so the number on the confirmation screen is the
 * number the order was written with, not a stale copy of it.
 *
 * Phase 43: the exact combination is part of a line's IDENTITY — Gold / 17 and
 * Silver / 17 are two lines of one product that never merge, because merging
 * them would let the customer be promised a unit of a combination that does not
 * exist. A line's price and its availability are the combination's own: an
 * override prices that size and nothing else, and the holds shadow it, not the
 * product rollup.
 *
 * The cart survives a reload (localStorage), and lines whose product has gone
 * off the website — or whose combination no longer exists — are dropped on load
 * rather than failing at checkout.
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
import { getOnlineOrdersRepository, getStoreAccountsRepository } from "../data";
import {
  describeThrown,
  toOnlineError,
  type OnlineError,
  type PlaceOrderResult,
  type PricingPreview,
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
  reconcileAutomaticAndCoupon,
  round2,
  selectAutomaticPromotion,
  variantUnitPriceOf,
  type CartTotals,
  type PromotionCartLine,
  type StoreVariant,
} from "../services/pricing";
import {
  availableToPromise,
  findOversell,
  reservedOf,
  variantAvailableToPromise,
  type OversellLine,
} from "../services/availability";
import { variantLabelOf } from "../services/variantLabel";
import type { CouponCheckReason } from "../data/repository";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { useStorefront } from "./StorefrontProvider";
import { useStoreAccount } from "./StoreAccountProvider";

const CART_KEY = "alyq.store.cart.v2";

export interface CartLine {
  product_id: string;
  /**
   * Phase 43: the exact combination this line is, when the product sells by
   * variant. Null for a product sold as a whole — never for a line the shopper
   * was asked to choose a colour or a size for.
   */
  variant_id: string | null;
  quantity: number;
  added_at: string;
}

/** The identity of a cart line: product + exact combination. */
export function storeLineKey(productId: string, variantId: string | null): string {
  return `${productId}::${variantId ?? ""}`;
}

/**
 * "Gold / 17" for a cart line, from the combination as published — the same
 * wording the order will carry after checkout. Re-exported so screens reach it
 * beside the cart types they already import.
 */
export { variantLabelOf };

/** A cart line resolved against the catalogue — what the cart screen renders. */
export interface CartEntry {
  product: Product;
  /** The exact combination, when the line names one. */
  variant: StoreVariant | null;
  /** "Gold / 17" in the reader's language; null on a product-level line. */
  variantLabel: string | null;
  content: ProductContent | null;
  quantity: number;
  /** Unit price after any live campaign (or the combination's own override). */
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
  deliveryZoneId: string | null;
}

function readStoredCart(): StoredCart {
  const fallback: StoredCart = {
    lines: [],
    couponCode: null,
    deliveryType: "delivery",
    paymentMethod: "cod",
    deliveryZoneId: null,
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
              // A cart saved before variants carries no combination; that is a
              // product-level line, exactly as it always was.
              variant_id: typeof line.variant_id === "string" ? line.variant_id : null,
              quantity: Math.max(1, Math.trunc(Number(line.quantity)) || 1),
              added_at: typeof line.added_at === "string" ? line.added_at : new Date().toISOString(),
            }))
        : [],
      couponCode: typeof parsed.couponCode === "string" ? parsed.couponCode : null,
      deliveryType: parsed.deliveryType === "pickup" ? "pickup" : "delivery",
      paymentMethod: parsed.paymentMethod === "instapay" ? "instapay" : "cod",
      deliveryZoneId: typeof parsed.deliveryZoneId === "string" ? parsed.deliveryZoneId : null,
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
  /** Saved lines removed after the published catalogue loads. Presentation
   * only: the shared cart remains the one source of truth. */
  prunedCount: number;
  acknowledgePruned: () => void;

  /**
   * Add one line. A product that sells by variant REFUSES without an exact
   * combination — the storefront never picks a colour or a size silently, for
   * the same reason the register does not.
   */
  add: (product: Product, quantity?: number, variant?: StoreVariant | null) => boolean;
  /** Increments once per successful add (including quantity increases placed
   * through `setQuantity` by a caller that confirms the increase itself, e.g.
   * the PDP). Presentation-only — nothing about the cart depends on it; it
   * exists purely so success feedback (a toast, a bag-icon pulse) can react
   * to "a line was really added" without re-deriving that from cart state. */
  addPulse: number;
  notifyAdded: () => void;
  setQuantity: (productId: string, variantId: string | null, quantity: number) => void;
  increase: (productId: string, variantId: string | null) => void;
  decrease: (productId: string, variantId: string | null) => void;
  remove: (productId: string, variantId: string | null) => void;
  clear: () => void;
  /** Add every line of a past order again — "reorder". */
  addMany: (lines: { product_id: string; variant_id?: string | null; quantity: number }[]) => number;

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
  /** Changing fulfilment clears an unconfirmed delivery quote. */
  setDeliveryType: (value: DeliveryType) => void;
  paymentMethod: OnlinePaymentMethod;
  setPaymentMethod: (value: OnlinePaymentMethod) => void;
  freeDelivery: { eligible: boolean; remaining: number; threshold: number } | null;
  /**
   * The delivery zone the customer chose (or null for pickup / legacy shops).
   * The server prices from the row; no fee ever travels from the browser.
   */
  deliveryZoneId: string | null;
  /** Choosing another zone deliberately invalidates the old delivery quote. */
  setDeliveryZoneId: (value: string | null) => void;
  /**
   * Checkout passes the address only after city, area and street are known.
   * The cart intentionally stores no address: a reload must not retain a fee
   * that was calculated for an address the new checkout form has not restored.
   */
  setDeliveryLocation: (address: (Pick<CustomerAddress, "city" | "area" | "street"> & {
    customer_name: string;
    customer_phone: string;
    zone_ready: boolean;
  }) | null) => void;
  /** A delivery fee/total is final only after checkout supplied a usable location. */
  deliveryQuoteReady: boolean;
  /**
   * The advisory checkout breakdown — automatic promotion, code, fee, total —
   * refreshed as the cart changes. Null while loading or when the check is
   * unreachable; screens fall back to the local totals, and placement
   * recomputes authoritatively either way.
   */
  preview: PricingPreview | null;
  previewLoading: boolean;

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
  const { lang } = useI18n();
  const {
    products,
    variants: publishedVariants,
    campaigns,
    promotions,
    promotionTargets,
    catalogContext,
    settings,
    loading: catalogueLoading,
    error: catalogueError,
    checkCoupon: verifyCode,
    previewPricing,
  } = useStorefront();
  const { customer } = useStoreAccount();
  const orders = useMemo(() => getOnlineOrdersRepository(), []);
  const accounts = useMemo(() => getStoreAccountsRepository(), []);

  const [stored] = useState<StoredCart>(() =>
    typeof window === "undefined"
      ? { lines: [], couponCode: null, deliveryType: "delivery" as const, paymentMethod: "cod" as const, deliveryZoneId: null }
      : readStoredCart(),
  );

  const [lines, setLines] = useState<CartLine[]>(stored.lines);
  // A counter, not a boolean: every successful add bumps it once, so a
  // listener (the header's bag icon, a toast) can react to each individual
  // success — including two in a row — with a plain `useEffect` dependency,
  // without owning any of the actual cart/stock logic itself.
  const [addPulse, setAddPulse] = useState(0);
  const [prunedCount, setPrunedCount] = useState(0);
  const [couponCode, setCouponCode] = useState<string | null>(stored.couponCode);
  const [couponInput, setCouponInput] = useState("");
  const [couponError, setCouponError] = useState<CouponCheckReason | null>(null);
  const [couponDiscount, setCouponDiscount] = useState(0);
  // Whether the applied coupon is itself marked stackable — false (the safe
  // default) until a check says otherwise, so an unknown coupon never
  // silently combines with the automatic promotion.
  const [couponStackable, setCouponStackable] = useState(false);
  const [applyingCoupon, setApplyingCoupon] = useState(false);
  const [deliveryType, setDeliveryTypeState] = useState<DeliveryType>(stored.deliveryType);
  const [paymentMethod, setPaymentMethod] = useState<OnlinePaymentMethod>(stored.paymentMethod);
  const [deliveryZoneId, setDeliveryZoneIdState] = useState<string | null>(stored.deliveryZoneId);
  // Address text belongs to checkout's form, never to a shared/local cart. This
  // small readiness snapshot only gates whether a delivery fee may be shown.
  // Starting empty on every mount prevents a restored cart from displaying a
  // stale fee before its required delivery details have been supplied again.
  const [deliveryLocation, setDeliveryLocationState] = useState<Pick<CustomerAddress, "city" | "area" | "street"> | null>(null);
  const [placing, setPlacing] = useState(false);
  const [checkoutError, setCheckoutError] = useState<OnlineError | null>(null);
  const [lastOrder, setLastOrder] = useState<OnlineOrder | null>(null);
  const [lastWasDuplicate, setLastWasDuplicate] = useState(false);
  const [preview, setPreview] = useState<PricingPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  const setDeliveryLocation = useCallback((address: (Pick<CustomerAddress, "city" | "area" | "street"> & {
    customer_name: string;
    customer_phone: string;
    zone_ready: boolean;
  }) | null) => {
    if (!address || !address.customer_name.trim() || !address.customer_phone.trim() || !address.city.trim() ||
      !address.area.trim() || !address.street.trim() || !address.zone_ready) {
      setDeliveryLocationState(null);
      return;
    }
    setDeliveryLocationState({ city: address.city.trim(), area: address.area.trim(), street: address.street.trim() });
  }, []);

  const setDeliveryType = useCallback((value: DeliveryType) => {
    setDeliveryTypeState(value);
    // Pickup never carries a delivery quote, and moving back to delivery must
    // wait for checkout to provide location details again.
    setDeliveryLocationState(null);
    if (value === "pickup") setDeliveryZoneIdState(null);
  }, []);

  const setDeliveryZoneId = useCallback((value: string | null) => {
    // A fee belongs to a zone AND an address. Keep neither quote when the zone
    // changes; the checkout effect will publish the current address again only
    // when this new selection is valid.
    setDeliveryZoneIdState(value);
    setDeliveryLocationState(null);
  }, []);

  const deliveryQuoteReady = deliveryType === "pickup" || deliveryLocation !== null;

  const productsById = useMemo(() => new Map(products.map((product) => [product.id, product])), [
    products,
  ]);
  const variantsById = useMemo(
    () => new Map(publishedVariants.map((variant) => [variant.id, variant])),
    [publishedVariants],
  );

  // Drop saved lines only AFTER a successful catalogue load (an empty/error
  // response while loading must never wipe a shopper's cart). Keep a count for
  // the V2 notice, not a second storage reader or a separate cart model.
  const pruned = useRef(false);
  useEffect(() => {
    if (pruned.current || catalogueLoading || catalogueError) return;
    pruned.current = true;
    const valid = (line: CartLine) => {
      const product = productsById.get(line.product_id);
      if (!product || !product.active || !product.show_on_website) return false;
      if (line.variant_id) {
        const variant = variantsById.get(line.variant_id);
        return Boolean(product.variants_enabled && variant?.active && variant.product_id === product.id);
      }
      return !product.variants_enabled;
    };
    const removed = lines.filter((line) => !valid(line)).length;
    if (removed) {
      setPrunedCount(removed);
      setLines((current) => current.filter(valid));
    }
  }, [catalogueLoading, catalogueError, lines, productsById, variantsById]);

  // Persist.
  useEffect(() => {
    try {
      window.localStorage.setItem(
        CART_KEY,
        JSON.stringify({ lines, couponCode, deliveryType, paymentMethod, deliveryZoneId } satisfies StoredCart),
      );
    } catch {
      /* private mode: the cart simply will not survive a reload */
    }
  }, [lines, couponCode, deliveryType, paymentMethod, deliveryZoneId]);

  const entries = useMemo<CartEntry[]>(() => {
    const now = new Date();
    return lines.flatMap((line) => {
      const product = productsById.get(line.product_id);
      if (!product) return [];
      const variant = line.variant_id ? variantsById.get(line.variant_id) ?? null : null;
      // A line whose combination vanished between renders (refresh race) shows
      // as nothing rather than as the product at the wrong price.
      if (line.variant_id && !variant) return [];

      const campaign = campaignFor(product.id, campaigns, now);
      // Campaign (and a variant's own override) only. An automatic promotion
      // is a CART-level discount, reconciled once against any coupon below —
      // never baked into a line's own price, or a coupon typed afterwards
      // would be computed off an already-discounted subtotal and the two
      // would silently stack (Bug: promotion + coupon stacking).
      const price = variant
        ? variantUnitPriceOf(variant, product.selling_price, campaign)
        : variantUnitPriceOf({ price_override: null }, product.selling_price, campaign);
      const available = variant
        ? product.stock_tracking_enabled
          ? variantAvailableToPromise(
              variant,
              catalogContext.reservedVariant?.get(variant.id) ?? 0,
            )
          : null
        : availableToPromise(product, reservedOf(catalogContext.reserved, product.id));
      return [
        {
          product,
          variant,
          variantLabel: variant ? variantLabelOf(variant, lang) : null,
          content: catalogContext.contents.get(product.id) ?? null,
          quantity: line.quantity,
          price,
          listPrice: Math.max(variant?.price_override ?? product.selling_price, 0),
          lineTotal: round2(price * line.quantity),
          available,
          inStock: available === null || available > 0,
        },
      ];
    });
  }, [campaigns, catalogContext.contents, catalogContext.reserved, catalogContext.reservedVariant, lang, lines, productsById, variantsById]);

  const subtotal = useMemo(
    () => round2(entries.reduce((sum, entry) => sum + entry.lineTotal, 0)),
    [entries],
  );

  // The one automatic (codeless) promotion the cart itself would apply —
  // evaluated once against the whole cart, the same way `evaluateCartPricing`
  // and the SQL core do, instead of per line. Promotions and their targets are
  // already public, client-side catalogue data (unlike coupon codes), so this
  // is safe to compute locally without waiting on the advisory preview.
  const promotionTargetsByPromotion = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const target of promotionTargets ?? []) {
      const set = map.get(target.promotion_id) ?? new Set<string>();
      set.add(`${target.target_kind}:${target.target_id}`);
      map.set(target.promotion_id, set);
    }
    return map;
  }, [promotionTargets]);

  const pricingLines = useMemo<PromotionCartLine[]>(
    () =>
      entries.map((entry) => ({
        product_id: entry.product.id,
        category_id: entry.product.category_id ?? null,
        variant_id: entry.variant?.id ?? null,
        qty: entry.quantity,
        unit_price: entry.price,
        line_total: entry.lineTotal,
      })),
    [entries],
  );

  const autoSelection = useMemo(
    () =>
      selectAutomaticPromotion(
        promotions ?? [],
        promotionTargetsByPromotion,
        pricingLines,
        subtotal,
        new Date(),
        "storefront",
      ),
    [promotions, promotionTargetsByPromotion, pricingLines, subtotal],
  );

  // Reconcile the automatic promotion against the (server-verified) coupon
  // discount with the non-stacking rule: both apply only when both are marked
  // stackable, otherwise the coupon always wins and the automatic promotion is
  // switched off. This is what stops the Cart page from ever showing an
  // automatic discount AND a coupon discount both taken off the same subtotal.
  const reconciled = useMemo(
    () =>
      reconcileAutomaticAndCoupon(
        Math.min(Math.max(round2(autoSelection?.discount ?? 0), 0), subtotal),
        autoSelection?.promotion.stackable ?? false,
        couponCode ? Math.min(Math.max(round2(couponDiscount), 0), subtotal) : 0,
        couponCode ? couponStackable : false,
      ),
    [autoSelection, couponCode, couponDiscount, couponStackable, subtotal],
  );
  const autoDiscount = reconciled.autoDiscount;
  const discount = reconciled.couponDiscount;
  const autoPromotionId = autoDiscount > 0 ? (autoSelection?.promotion.id ?? null) : null;
  const autoPromotionName =
    autoDiscount > 0
      ? autoSelection?.promotion.name_en || autoSelection?.promotion.name_ar || null
      : null;

  // A cart has no address/zone form. Showing the legacy/global fee here made a
  // number look final before checkout knew where the order was going. The
  // provisional cart total therefore contains goods only until checkout has
  // supplied a complete delivery location; placement still recalculates the
  // actual fee server-side from the configured zone/rules.
  const deliveryFee = deliveryQuoteReady
    ? deliveryFeeFor(
        settings.delivery,
        deliveryType,
        round2(subtotal - autoDiscount - discount),
      )
    : 0;
  const totals = useMemo<CartTotals>(
    () => ({
      lines: entries.map((entry) => ({
        product_id: entry.product.id,
        variant_id: entry.variant?.id ?? null,
        quantity: entry.quantity,
        list_price: entry.listPrice,
        unit_price: entry.price,
        line_total: entry.lineTotal,
        campaign_id: null,
      })),
      subtotal,
      discount_code: discount > 0 ? couponCode : null,
      discount_amount: discount,
      auto_discount: autoDiscount,
      auto_promotion_id: autoPromotionId,
      auto_promotion_name: autoPromotionName,
      delivery_fee: deliveryFee,
      total: round2(subtotal - autoDiscount - discount + deliveryFee),
      unit_count: entries.reduce((sum, entry) => sum + entry.quantity, 0),
    }),
    [
      autoDiscount,
      autoPromotionId,
      autoPromotionName,
      couponCode,
      deliveryFee,
      discount,
      entries,
      subtotal,
    ],
  );

  const freeDelivery = useMemo(
    () => freeDeliveryProgress(settings.delivery, round2(subtotal - autoDiscount - discount)),
    [autoDiscount, discount, settings.delivery, subtotal],
  );

  const problems = useMemo(
    () =>
      findOversell(
        lines,
        products,
        catalogContext.reserved,
        publishedVariants,
        catalogContext.reservedVariant ?? new Map(),
      ),
    [catalogContext.reserved, catalogContext.reservedVariant, lines, products, publishedVariants],
  );

  const unitCount = totals.unit_count;
  const isEmpty = entries.length === 0;

  // ── cart operations ───────────────────────────────────────────────────────

  // Exposed so the one caller that adds via `setQuantity` instead of `add`
  // (the PDP, increasing a line that is already in the cart) can report the
  // same "a line really was added to" event `add()` reports below — without
  // `setQuantity` itself needing to know about pulses, toasts or icons.
  const notifyAdded = useCallback(() => setAddPulse((count) => count + 1), []);

  const add = useCallback(
    (product: Product, quantity = 1, variant: StoreVariant | null = null): boolean => {
      const wanted = Math.max(1, Math.trunc(quantity) || 1);
      // A variant product is never added as a whole: the combination IS the
      // thing being sold, and a line without one could not be checked out.
      if (product.variants_enabled && !variant) return false;
      if (variant && variant.product_id !== product.id) return false;
      let added = false;
      setLines((current) => {
        const key = storeLineKey(product.id, variant?.id ?? null);
        const existing = current.find(
          (line) => storeLineKey(line.product_id, line.variant_id) === key,
        );
        const nextQuantity = (existing?.quantity ?? 0) + wanted;
        // Do not add more than can be promised; the button says why.
        const available = variant
          ? product.stock_tracking_enabled
            ? variantAvailableToPromise(
                variant,
                catalogContext.reservedVariant?.get(variant.id) ?? 0,
              )
            : null
          : availableToPromise(product, reservedOf(catalogContext.reserved, product.id));
        if (available !== null && nextQuantity > available) return current;
        added = true;
        if (existing) {
          return current.map((line) =>
            storeLineKey(line.product_id, line.variant_id) === key
              ? { ...line, quantity: nextQuantity, added_at: new Date().toISOString() }
              : line,
          );
        }
        return [
          ...current,
          {
            product_id: product.id,
            variant_id: variant?.id ?? null,
            quantity: wanted,
            added_at: new Date().toISOString(),
          },
        ];
      });
      if (added) notifyAdded();
      return added;
    },
    [catalogContext.reserved, catalogContext.reservedVariant, notifyAdded],
  );

  const setQuantity = useCallback(
    (productId: string, variantId: string | null, quantity: number) => {
      const wanted = Math.max(0, Math.trunc(quantity) || 0);
      setLines((current) => {
        const key = storeLineKey(productId, variantId);
        if (wanted === 0) {
          return current.filter((line) => storeLineKey(line.product_id, line.variant_id) !== key);
        }
        const product = productsById.get(productId);
        const variant = variantId ? variantsById.get(variantId) : undefined;
        if (product) {
          const available = variant
            ? product.stock_tracking_enabled
              ? variantAvailableToPromise(
                  variant,
                  catalogContext.reservedVariant?.get(variant.id) ?? 0,
                )
              : availableToPromise(product, reservedOf(catalogContext.reserved, productId))
            : availableToPromise(product, reservedOf(catalogContext.reserved, productId));
          if (available !== null && wanted > available) return current;
        }
        return current.map((line) =>
          storeLineKey(line.product_id, line.variant_id) === key ? { ...line, quantity: wanted } : line,
        );
      });
    },
    [catalogContext.reserved, catalogContext.reservedVariant, productsById, variantsById],
  );

  const increase = useCallback(
    (productId: string, variantId: string | null) => {
      const line = lines.find(
        (candidate) => storeLineKey(candidate.product_id, candidate.variant_id) === storeLineKey(productId, variantId),
      );
      setQuantity(productId, variantId, (line?.quantity ?? 0) + 1);
    },
    [lines, setQuantity],
  );

  const decrease = useCallback(
    (productId: string, variantId: string | null) => {
      const line = lines.find(
        (candidate) => storeLineKey(candidate.product_id, candidate.variant_id) === storeLineKey(productId, variantId),
      );
      setQuantity(productId, variantId, (line?.quantity ?? 0) - 1);
    },
    [lines, setQuantity],
  );

  const remove = useCallback((productId: string, variantId: string | null) => {
    const key = storeLineKey(productId, variantId);
    setLines((current) =>
      current.filter((line) => storeLineKey(line.product_id, line.variant_id) !== key),
    );
  }, []);

  const clear = useCallback(() => {
    setLines([]);
    setCouponCode(null);
    setCouponDiscount(0);
    setCouponError(null);
    setPrunedCount(0);
  }, []);

  const addMany = useCallback(
    (requested: { product_id: string; variant_id?: string | null; quantity: number }[]): number => {
      let count = 0;
      for (const line of requested) {
        const product = productsById.get(line.product_id);
        if (!product || !product.active || !product.show_on_website) continue;
        const variant = line.variant_id ? variantsById.get(line.variant_id) ?? null : null;
        if (line.variant_id && !variant) continue;
        if (product.variants_enabled && !variant) continue;
        if (add(product, line.quantity, variant)) count += 1;
      }
      return count;
    },
    [add, productsById, variantsById],
  );

  // ── coupons ───────────────────────────────────────────────────────────────

  /**
   * Ask the pricing authority about one code and apply the answer. The complete
   * cart identity (including variant and quantity) travels with this advisory
   * check, so Admin's central coupon promotions and legacy coupons follow the
   * same eligibility path as checkout.
   */
  const verifyCoupon = useCallback(
    async (rawCode: string, currentEntries: CartEntry[]) => {
      const code = normalizeCouponCode(rawCode);
      if (!code) return { valid: false as const, reason: "not_found" as CouponCheckReason };
      const result = await verifyCode({
        code,
        lines: currentEntries.map((entry) => ({
          product_id: entry.product.id,
          variant_id: entry.variant?.id ?? null,
          qty: entry.quantity,
        })),
        customerKey: customer?.id ?? null,
      });
      if (result.valid) {
        setCouponCode(result.code);
        setCouponDiscount(result.discount);
        setCouponStackable(result.stackable ?? false);
        setCouponError(null);
      } else {
        setCouponCode(null);
        setCouponDiscount(0);
        setCouponStackable(false);
        setCouponError(result.reason);
      }
      return result;
    },
    [customer?.id, verifyCode],
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
        const result = await verifyCoupon(raw, entries);
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
    [couponInput, entries, isEmpty, verifyCoupon],
  );

  const clearCoupon = useCallback(() => {
    setCouponCode(null);
    setCouponDiscount(0);
    setCouponStackable(false);
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
      recheck.current = verifyCoupon(couponCode, entries).catch(() => null);
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
            // The exact combination travels with the line; the server re-reads
            // the price and the shelf anyway and refuses a line that names none.
            variant_id: line.variant_id,
          })),
          coupon_code: couponCode,
          delivery_zone_id: deliveryType === "delivery" ? deliveryZoneId : null,
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
          // A live shopper is browser-local, not a privileged server identity.
          // Remember only the reference+phone in the EXISTING account store;
          // listMyOrders re-looks it up through the private tracking RPC.
          await accounts.rememberOrder(customer.id, result.order.order_number, result.order.customer_phone)
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
    [accounts, clear, couponCode, customer, deliveryType, deliveryZoneId, entries.length, lines, orders, paymentMethod],
  );

  const clientRefRef = useRef<string | null>(null);

  // Changing the cart invalidates the idempotency key: the next submission is a
  // different order, and reusing the key would return the previous one.
  useEffect(() => {
    clientRefRef.current = null;
  }, [lines, couponCode, deliveryLocation, deliveryType, paymentMethod, deliveryZoneId]);

  // Advisory pricing refresh: the full breakdown (automatic promotion, code,
  // zone fee) recomputed as the cart changes. Debounced like the coupon
  // re-check; a failure clears the preview and screens fall back to the local
  // totals, because placement recomputes authoritatively either way.
  const previewTimer = useRef<number | null>(null);
  useEffect(() => {
    if (previewTimer.current !== null) window.clearTimeout(previewTimer.current);
    if (isEmpty) {
      setPreview(null);
      setPreviewLoading(false);
      return;
    }
    setPreviewLoading(true);
    previewTimer.current = window.setTimeout(() => {
      void previewPricing({
        lines: lines.map((line) => ({
          product_id: line.product_id,
          qty: line.quantity,
          variant_id: line.variant_id,
        })),
        couponCode,
        // Before a complete location is supplied, request a goods-only
        // advisory breakdown. This avoids rendering a legacy/global delivery
        // amount as a final quote; once ready, the authoritative preview gets
        // the selected zone and returns the configured fee.
        deliveryZoneId: deliveryQuoteReady && deliveryType === "delivery" ? deliveryZoneId : null,
        customerKey: customer?.id ?? null,
        deliveryType: deliveryQuoteReady ? deliveryType : "pickup",
      })
        .then((result) => setPreview(result))
        .catch(() => setPreview(null))
        .finally(() => setPreviewLoading(false));
    }, 350);
    return () => {
      if (previewTimer.current !== null) window.clearTimeout(previewTimer.current);
    };
  }, [couponCode, customer?.id, deliveryQuoteReady, deliveryType, deliveryZoneId, isEmpty, lines, previewPricing]);

  const value = useMemo<StoreCartContextValue>(
    () => ({
      lines,
      entries,
      unitCount,
      isEmpty,
      prunedCount,
      acknowledgePruned: () => setPrunedCount(0),
      add,
      addPulse,
      notifyAdded,
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
      deliveryZoneId,
      setDeliveryZoneId,
      setDeliveryLocation,
      deliveryQuoteReady,
      preview,
      previewLoading,
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
      addPulse,
      notifyAdded,
      applyingCoupon,
      applyCoupon,
      checkout,
      clear,
      clearCoupon,
      couponCode,
      couponError,
      couponInput,
      decrease,
      deliveryQuoteReady,
      deliveryType,
      deliveryZoneId,
      setDeliveryLocation,
      setDeliveryZoneId,
      setDeliveryType,
      preview,
      previewLoading,
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
      prunedCount,
      remove,
      setQuantity,
      totals,
      unitCount,
      checkoutError,
    ],
  );

  return <StoreCartContext.Provider value={value}>{children}</StoreCartContext.Provider>;
}
