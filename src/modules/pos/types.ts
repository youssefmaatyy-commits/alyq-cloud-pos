/**
 * POS + Sales module — domain types (Phase 4).
 *
 * Reuses:
 *   - `Product`           (catalog)        for stock + pricing
 *   - `StockMovement`     (inventory)      for sale-driven stock deductions
 *   - `getCurrentUser`    (inventory)      for the acting cashier
 *
 * A sale is an immutable financial record. The only legal mutation after
 * completion is a *void*, which is itself recorded (status change + a
 * reversing stock movement).
 */

/**
 * How a sale is paid.
 *
 * `cod` (cash on delivery) exists only for sales an approved website order
 * created — the till has no button for it, because a cashier standing in front
 * of a customer is not delivering anything. It is in this list because it is in
 * the database enum (migration 0017) and because a sale paid that way has to be
 * readable everywhere sales are listed and exported.
 */
export const PAYMENT_METHODS = ["cash", "instapay", "visa", "cod"] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

/**
 * Where a sale came from.
 *
 * `pos` is the till; `online` is an approved website order. The column exists so
 * the register can answer "how much of today's takings was the website?" without
 * a second system of record, and so an online sale is recognisable in the sales
 * list rather than looking like a mystery transaction. Optional and defaulting to
 * `pos`, so every existing call site keeps working unchanged.
 */
export const SALE_SOURCES = ["pos", "online"] as const;
export type SaleSource = (typeof SALE_SOURCES)[number];

/** `completed` = paid & stock deducted · `pending` = InstaPay awaiting confirmation · `voided` = reversed. */
export type SaleStatus = "completed" | "pending" | "voided";
export type PaymentStatus = "paid" | "pending";
export type DiscountType = "none" | "percent" | "fixed";

export interface SaleItem {
  id: string;
  sale_id: string;
  product_id: string;
  /**
   * Phase 43: the exact combination sold. Null on every legacy line and on a
   * product sold as a whole.
   */
  variant_id: string | null;
  /** Frozen colour and size — an archived or renamed variant still reads here. */
  variant_color_ar: string | null;
  variant_color_en: string | null;
  variant_size: number | null;
  variant_size_label: string | null;
  /** Snapshot of the product name at sale time (historical, not a live join). */
  name_ar: string;
  name_en: string;
  sku: string;
  barcode: string | null;
  unit_price: number;
  quantity: number;
  /** Gross line total before manual item discount. */
  gross_total?: number;
  line_total: number;
  /** Exact refund ceiling persisted by the live database after migration 0065. */
  refundable_total?: number | null;
  discount_type?: DiscountType;
  discount_value?: number;
  discount_amount?: number;
  automatic_promotion_id?: string | null;
  automatic_promotion_name?: string | null;
  automatic_discount_amount?: number;
  rewarded_qty?: number;
  promotion_rule_type?: string | null;
  /**
   * Cost per unit frozen at sale time (Phase 53). Null on rows written before
   * the snapshot existed — unknown, never treated as free.
   */
  unit_cost?: number | null;
}

/**
 * One payment applied to a sale. A sale may have several payments (split
 * payment), e.g. Cash 300 + InstaPay 200 against a 500 total.
 *
 * `amount` is the portion applied to the sale; the sum of all payments'
 * `amount` must equal the sale total. Cash payments are always `paid`; an
 * InstaPay payment starts `pending` and is confirmed via `confirmPayment`.
 */
export interface SalePayment {
  id: string;
  sale_id: string;
  method: PaymentMethod;
  amount: number;
  status: PaymentStatus;
  /** InstaPay only — when this payment was confirmed. */
  paid_at: string | null;
  paid_by: string | null;
  paid_by_name: string | null;
}

/** Payment as supplied by the cashier before completion. */
export interface SalePaymentInput {
  method: PaymentMethod;
  amount: number;
  status: PaymentStatus;
  /** Cash only — amount actually tendered; defaults to `amount` (exact change). */
  tendered?: number;
}

export interface Sale {
  id: string;
  /** Human-readable sequential number, e.g. INV-000001. */
  sale_number: string;
  /** Client-generated idempotency key (prevents double submission). */
  client_ref: string;
  status: SaleStatus;
  subtotal: number;
  discount_type: DiscountType;
  discount_value: number;
  /** Invoice-level discount (legacy fields remain invoice discount fields). */
  discount_amount: number;
  /** Manual item discounts, kept separate from invoice discounts. */
  item_discount_amount?: number;
  total_discount_amount?: number;
  automatic_discount_amount?: number;
  automatic_promotion_id?: string | null;
  automatic_promotion_name?: string | null;
  promotion_rule_type?: string | null;
  promotion_buy_x?: number | null;
  promotion_get_y?: number | null;
  promotion_reward_qty?: number | null;
  promotion_rewarded_units?: any;
  total: number;
  user_id: string;
  user_name: string;
  items: SaleItem[];
  /** All payments applied to this sale (authoritative — split payment). */
  payments: SalePayment[];
  customer_id?: string | null;
  customer_name?: string | null;
  customer_phone?: string | null;
  created_at: string;
  voided_at: string | null;
  void_reason: string | null;
  /** Legacy convenience — the first payment's method (single-payment == it). */
  payment_method: PaymentMethod;
  /** Legacy convenience — `paid` only when every payment is paid. */
  payment_status: PaymentStatus;
  /** Legacy convenience — total cash tendered (sum of cash `tendered`). */
  amount_received: number | null;
  /** Legacy convenience — cash tendered minus cash applied. */
  change: number | null;
  /** Legacy convenience — when the (last) InstaPay payment was confirmed. */
  paid_at: string | null;
  paid_by: string | null;
  paid_by_name: string | null;
  /** Originating branch frozen on the invoice and used by return tenancy. */
  branch_id?: string | null;
  /** `pos` unless an approved online order created it. */
  source?: SaleSource;
  /**
   * The open shift a till sale was completed under (migration 0040).
   * `null` for online-channel sales and for rows before the column existed.
   */
  shift_id?: string | null;
  /** Cashier note frozen with the transaction; never recomputed on reprint. */
  notes?: string | null;
  /** Client-only sync state for a cash sale accepted while the till was offline. */
  offline_sync_status?: "pending" | "syncing" | "synced" | "error";
  offline_last_error?: string | null;
  offline_last_error_kind?: "network" | "conflict" | "rejected" | null;
}

/** Payload the cart sends to complete a sale. */
export interface CompleteSaleInput {
  client_ref: string;
  /**
   * Only product ids + quantities come from the client. Prices, names and
   * totals are re-read/recalculated on the authoritative side.
   */
  lines: {
    product_id: string;
    qty: number;
    variant_id?: string | null;
    /** Discount intent only; authoritative service recalculates the amount. */
    discount_type?: DiscountType;
    discount_value?: number;
  }[];
  discount_type: DiscountType;
  discount_value: number;
  coupon_code?: string | null;
  promo_code?: string | null;
  /** One or more payments whose amounts sum exactly to the sale total. */
  payments: SalePaymentInput[];
  customer_id?: string | null;
  customer_name?: string | null;
  customer_phone?: string | null;
  /** Optional cashier note, trimmed and capped server-side. */
  notes?: string | null;
  user_id: string;
  user_name: string;
  /** Omitted by the till; set to `online` when an order approval creates it. */
  source?: SaleSource;
}

export interface VoidSaleInput {
  user_id: string;
  user_name: string;
  reason: string | null;
}

/** Marks a pending InstaPay sale as paid. Totals/items/stock are untouched. */
export interface ConfirmPaymentInput {
  user_id: string;
  user_name: string;
}

/** A line in the active cart (UI state only — never persisted as-is). */
export interface CartLine {
  product_id: string;
  /**
   * Phase 43: the exact combination this line is, when the product sells by
   * variant. THIS is part of the line's identity — two combinations of one
   * product are two lines that never merge, because merging them would charge
   * one shelf for stock that came off another.
   *
   * Null for a product sold as a whole, and on a legacy line.
   */
  variant_id: string | null;
  /** The combination's own code, frozen onto the line at add time. */
  variant_sku: string | null;
  /** Frozen colour/size, so a rename cannot rewrite a line already in the cart. */
  color_ar: string | null;
  color_en: string | null;
  size: number | null;
  size_label: string | null;
  sku: string;
  name_ar: string;
  name_en: string;
  barcode: string | null;
  /** List / catalogue price before promotion. */
  base_price?: number;
  /** Price after central automatic promotion (or catalogue price if none). */
  unit_price: number;
  automatic_promotion_id?: string | null;
  automatic_promotion_name?: string | null;
  automatic_discount_amount?: number;
  rewarded_qty?: number;
  promotion_rule_type?: string | null;
  promotion_label?: string | null;
  /** Maximum sellable quantity right now — the VARIANT's shelf when there is one. */
  max_qty: number;
  qty: number;
  image_url: string | null;
  item_discount?: CartDiscount;
}

/**
 * The identity of a cart line: product + exact combination.
 *
 * Used for lookups, for React keys and for the "already in the cart" badge, so
 * Gold/17 and Silver/17 are separate lines everywhere and neither can be
 * increased by clicking the other.
 */
export function lineKey(line: Pick<CartLine, "product_id" | "variant_id">): string {
  return `${line.product_id}::${line.variant_id ?? ""}`;
}

export interface CartDiscount {
  type: DiscountType;
  value: number;
}

export const EMPTY_DISCOUNT: CartDiscount = { type: "none", value: 0 };

export function newClientRef(): string {
  const rand =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2) + Date.now().toString(36);
  return `pos-${rand}`;
}
