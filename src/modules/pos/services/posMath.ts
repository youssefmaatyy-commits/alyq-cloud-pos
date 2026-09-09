import type { CartDiscount, CartLine } from "../types";

/**
 * Pure POS arithmetic — the ONLY place cart money math lives.
 *
 * Every value is rounded to 2 decimals. The completion service re-runs the
 * same functions on fresh server-side data, so a tampered frontend total can
 * never be persisted.
 */

export const MAX_DISCOUNT_PERCENT = 100;

export function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function lineTotal(unitPrice: number, qty: number): number {
  return round2(unitPrice * qty);
}

export function cartSubtotal(lines: Pick<CartLine, "unit_price" | "qty">[]): number {
  return round2(lines.reduce((sum, line) => sum + line.unit_price * line.qty, 0));
}

/** Clamp a discount into a valid, non-negative amount. */
export function discountAmount(
  subtotal: number,
  type: CartDiscount["type"],
  value: number,
): number {
  if (type === "percent") {
    const pct = Math.min(MAX_DISCOUNT_PERCENT, Math.max(0, value || 0));
    return round2((pct / 100) * subtotal);
  }
  if (type === "fixed") {
    return round2(Math.min(subtotal, Math.max(0, value || 0)));
  }
  return 0;
}

export interface CartTotals {
  subtotal: number;
  discountAmount: number;
  total: number;
}

export function cartTotals(
  lines: Pick<CartLine, "unit_price" | "qty">[],
  discount: CartDiscount,
): CartTotals {
  const subtotal = cartSubtotal(lines);
  const discounted = discountAmount(subtotal, discount.type, discount.value);
  return {
    subtotal,
    discountAmount: discounted,
    total: round2(subtotal - discounted),
  };
}

/** Validate the discount pair. Returns an i18n key or null. */
export function validateDiscount(
  type: CartDiscount["type"],
  value: number,
): "invalid" | "tooHigh" | null {
  if (type === "none") return null;
  if (!Number.isFinite(value) || value < 0) return "invalid";
  if (type === "percent" && value > MAX_DISCOUNT_PERCENT) return "tooHigh";
  return null;
}

/** Cash change — negative means the amount tendered is insufficient. */
export function cashChange(total: number, amountReceived: number): number {
  return round2(amountReceived - total);
}

/** Sum of payment amounts (used to validate split payments against the total). */
export function sumPayments(payments: { amount: number }[]): number {
  return round2(payments.reduce((sum, p) => sum + p.amount, 0));
}

/** How much of the sale total is still uncovered by the given payments. */
export function paymentsRemaining(total: number, payments: { amount: number }[]): number {
  return round2(total - sumPayments(payments));
}

/**
 * Smart split-payment calculation.
 *
 * Given the sale total, the cash tendered and the InstaPay amount, it derives
 * the authoritative distribution:
 *   - cash is applied first (capped by total minus InstaPay)
 *   - InstaPay is clamped so the total is never exceeded
 *   - `change` is the cash over its applied portion (cash-only overpayment)
 *   - `remaining` is what's still unpaid and must be zero before completing
 *
 * Pure + rounding-safe, so the same numbers drive the live UI and the tests.
 */
export interface SmartPayment {
  cashApplied: number;
  cashTendered: number;
  instapay: number;
  paid: number;
  remaining: number;
  change: number;
}

export function smartPaymentCalc(
  total: number,
  cashTendered: number,
  instapay: number,
): SmartPayment {
  const t = round2(Math.max(0, total));
  const cash = round2(Math.max(0, cashTendered));
  const insta = round2(Math.max(0, instapay));

  const cashApplied = round2(Math.max(0, Math.min(cash, t - insta)));
  const instaApplied = round2(Math.min(insta, t - cashApplied));
  const paid = round2(cashApplied + instaApplied);
  const remaining = round2(t - paid);
  const change = round2(cash - cashApplied);

  return {
    cashApplied,
    cashTendered: cash,
    instapay: instaApplied,
    paid,
    remaining,
    change,
  };
}

/**
 * Auto-balance: given the total and the amount entered in one method, return
 * what the *other* method should be so the two sum exactly to the total.
 * A negative result (entered exceeds total) collapses to 0.
 */
export function autoBalanceOther(total: number, entered: number): number {
  return round2(Math.max(0, total - round2(entered)));
}
