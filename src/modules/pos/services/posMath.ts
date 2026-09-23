import type { CartDiscount, CartLine, DiscountType } from "../types";

/** Pure POS arithmetic. The completion service repeats these rules from fresh catalogue data. */
export const MAX_DISCOUNT_PERCENT = 100;

export function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function lineTotal(unitPrice: number, qty: number): number {
  return round2(unitPrice * qty);
}

export function discountAmount(base: number, type: DiscountType, value: number): number {
  if (!Number.isFinite(base) || base <= 0) return 0;
  if (type === "percent") return round2((Math.min(MAX_DISCOUNT_PERCENT, Math.max(0, value || 0)) / 100) * base);
  if (type === "fixed") return round2(Math.min(base, Math.max(0, value || 0)));
  return 0;
}

export function validateDiscount(type: DiscountType, value: number): "invalid" | "tooHigh" | null {
  if (type === "none") return null;
  if (!Number.isFinite(value) || value < 0) return "invalid";
  if (type === "percent" && value > MAX_DISCOUNT_PERCENT) return "tooHigh";
  return null;
}

export function cartSubtotal(lines: Pick<CartLine, "unit_price" | "qty">[]): number {
  return round2(lines.reduce((sum, line) => sum + line.unit_price * line.qty, 0));
}

export interface LineTotals {
  gross: number;
  discount: number;
  net: number;
}

export function lineTotals(line: Pick<CartLine, "unit_price" | "qty"> & { item_discount?: CartDiscount }): LineTotals {
  const gross = lineTotal(line.unit_price, line.qty);
  const itemDiscount = line.item_discount ?? { type: "none", value: 0 };
  const discount = discountAmount(gross, itemDiscount.type, itemDiscount.value);
  return { gross, discount, net: Math.max(0, round2(gross - discount)) };
}

export interface CartTotals {
  /** Gross/list-price subtotal, before any manual discounts. */
  subtotal: number;
  itemDiscountAmount: number;
  invoiceDiscountAmount: number;
  /** Backward-compatible alias for total manual discount. */
  discountAmount: number;
  total: number;
}

export function cartTotals(lines: (Pick<CartLine, "unit_price" | "qty"> & { item_discount?: CartDiscount })[], invoiceDiscount: CartDiscount): CartTotals {
  const subtotal = round2(lines.reduce((sum, line) => sum + lineTotals(line).gross, 0));
  const itemDiscountAmount = round2(lines.reduce((sum, line) => sum + lineTotals(line).discount, 0));
  const afterItems = Math.max(0, round2(subtotal - itemDiscountAmount));
  const invoiceDiscountAmount = discountAmount(afterItems, invoiceDiscount.type, invoiceDiscount.value);
  const total = Math.max(0, round2(afterItems - invoiceDiscountAmount));
  return {
    subtotal,
    itemDiscountAmount,
    invoiceDiscountAmount,
    discountAmount: round2(itemDiscountAmount + invoiceDiscountAmount),
    total,
  };
}

export function cashChange(total: number, amountReceived: number): number {
  return round2(amountReceived - total);
}

export function sumPayments(payments: { amount: number }[]): number {
  return round2(payments.reduce((sum, p) => sum + p.amount, 0));
}

export function paymentsRemaining(total: number, payments: { amount: number }[]): number {
  return round2(total - sumPayments(payments));
}

export interface SmartPayment {
  cashApplied: number;
  cashTendered: number;
  instapay: number;
  visa: number;
  paid: number;
  remaining: number;
  change: number;
}

export function smartPaymentCalc(total: number, cashTendered: number, instapay: number, visa = 0): SmartPayment {
  const t = round2(Math.max(0, total));
  const cash = round2(Math.max(0, cashTendered));
  const insta = round2(Math.max(0, instapay));
  const visaAmt = round2(Math.min(Math.max(0, visa), t));
  const afterVisa = round2(t - visaAmt);
  const cashApplied = round2(Math.max(0, Math.min(cash, afterVisa - insta)));
  const instaApplied = round2(Math.min(insta, afterVisa - cashApplied));
  const paid = round2(cashApplied + instaApplied + visaAmt);
  return { cashApplied, cashTendered: cash, instapay: instaApplied, visa: visaAmt, paid, remaining: round2(t - paid), change: round2(cash - cashApplied) };
}

export function autoBalanceOther(total: number, entered: number): number {
  return round2(Math.max(0, total - round2(entered)));
}
