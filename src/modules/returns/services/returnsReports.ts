/**
 * Returns & Customer reports — pure aggregation functions.
 *
 * Every function is a stateless reducer over sales, returns, refunds and
 * customer data. No side-effects, no network, no mock data.
 */

import type { Sale } from "@/modules/pos/types";
import type { Customer } from "@/modules/customers/types";
import type { SalesReturn, RefundRecord } from "../types";

// ── Customer Analytics ──────────────────────────────────────────────────────

export interface CustomerPurchaseSummary {
  customer_id: string;
  name: string;
  phone: string;
  totalPurchases: number;
  totalSpent: number;
  totalReturned: number;
  netSpent: number;
  averageOrderValue: number;
  lastPurchaseAt: string | null;
}

export interface CustomerAnalyticsReport {
  customers: CustomerPurchaseSummary[];
  /** Total revenue from all customers. */
  totalRevenue: number;
  /** Total refunded across all customers. */
  totalRefunded: number;
  /** Number of customers with at least one purchase. */
  activeCustomers: number;
  /** Top N customers by net spending. */
  topCustomers: CustomerPurchaseSummary[];
}

/**
 * Compute per-customer purchase analytics from sales and returns data.
 * Customers with zero purchases are excluded from the output.
 */
export function computeCustomerAnalytics(
  customers: Customer[],
  sales: Sale[],
  returns: SalesReturn[],
  topN: number = 10,
): CustomerAnalyticsReport {
  const salesByCustomer = new Map<string, Sale[]>();
  for (const sale of sales) {
    if (!sale.customer_id || sale.status === "voided") continue;
    const list = salesByCustomer.get(sale.customer_id) ?? [];
    list.push(sale);
    salesByCustomer.set(sale.customer_id, list);
  }

  const returnsByCustomer = new Map<string, number>();
  for (const ret of returns) {
    if (!ret.customer_id) continue;
    const prev = returnsByCustomer.get(ret.customer_id) ?? 0;
    returnsByCustomer.set(ret.customer_id, prev + ret.refund_amount);
  }

  let totalRevenue = 0;
  let totalRefunded = 0;

  const summaries: CustomerPurchaseSummary[] = [];

  for (const customer of customers) {
    const customerSales = salesByCustomer.get(customer.id);
    if (!customerSales || customerSales.length === 0) continue;

    let totalSpent = 0;
    let lastPurchaseAt: string | null = null;

    for (const sale of customerSales) {
      totalSpent += sale.total;
      if (!lastPurchaseAt || sale.created_at > lastPurchaseAt) {
        lastPurchaseAt = sale.created_at;
      }
    }

    const totalReturned = returnsByCustomer.get(customer.id) ?? 0;
    const netSpent = totalSpent - totalReturned;

    totalRevenue += totalSpent;
    totalRefunded += totalReturned;

    summaries.push({
      customer_id: customer.id,
      name: customer.name,
      phone: customer.phone,
      totalPurchases: customerSales.length,
      totalSpent,
      totalReturned,
      netSpent,
      averageOrderValue: customerSales.length > 0 ? totalSpent / customerSales.length : 0,
      lastPurchaseAt,
    });
  }

  // Sort by net spending descending
  summaries.sort((a, b) => b.netSpent - a.netSpent);

  return {
    customers: summaries,
    totalRevenue,
    totalRefunded,
    activeCustomers: summaries.length,
    topCustomers: summaries.slice(0, topN),
  };
}

// ── Returns Analytics ───────────────────────────────────────────────────────

export interface ProductReturnSummary {
  product_id: string;
  name_en: string;
  name_ar: string;
  sku: string;
  totalReturned: number;
  totalRefundAmount: number;
  returnCount: number;
}

export interface RefundMethodSummary {
  method: "cash" | "visa" | "instapay";
  count: number;
  totalAmount: number;
  completedAmount: number;
  pendingAmount: number;
}

export interface ReturnPeriodSummary {
  date: string;
  returnCount: number;
  refundAmount: number;
}

export interface ReturnsAnalyticsReport {
  /** Total number of returns. */
  totalReturns: number;
  /** Total refund amount across all returns. */
  totalRefundAmount: number;
  /** Refund totals by payment method. */
  byMethod: RefundMethodSummary[];
  /** Most-returned products (top N). */
  topReturnedProducts: ProductReturnSummary[];
  /** Returns per day (sorted chronologically). */
  byDay: ReturnPeriodSummary[];
  /** Returns with pending refund status. */
  pendingRefunds: number;
  /** Average refund amount. */
  averageRefund: number;
}

/**
 * Compute returns analytics from returns and refund records.
 */
export function computeReturnsAnalytics(
  returns: SalesReturn[],
  refunds: RefundRecord[],
  topN: number = 10,
): ReturnsAnalyticsReport {
  // Product returns aggregation
  const productMap = new Map<string, ProductReturnSummary>();
  for (const ret of returns) {
    for (const item of ret.items) {
      const prev = productMap.get(item.product_id);
      if (prev) {
        prev.totalReturned += item.quantity;
        prev.totalRefundAmount += item.line_total;
        prev.returnCount++;
      } else {
        productMap.set(item.product_id, {
          product_id: item.product_id,
          name_en: item.name_en,
          name_ar: item.name_ar,
          sku: item.sku,
          totalReturned: item.quantity,
          totalRefundAmount: item.line_total,
          returnCount: 1,
        });
      }
    }
  }

  const topReturnedProducts = Array.from(productMap.values())
    .sort((a, b) => b.totalReturned - a.totalReturned)
    .slice(0, topN);

  // Refund method aggregation
  const methodMap = new Map<string, RefundMethodSummary>();
  for (const ref of refunds) {
    const prev = methodMap.get(ref.payment_method) ?? {
      method: ref.payment_method,
      count: 0,
      totalAmount: 0,
      completedAmount: 0,
      pendingAmount: 0,
    };
    prev.count++;
    prev.totalAmount += ref.amount;
    if (ref.status === "completed") {
      prev.completedAmount += ref.amount;
    } else {
      prev.pendingAmount += ref.amount;
    }
    methodMap.set(ref.payment_method, prev);
  }

  const byMethod = Array.from(methodMap.values());

  // Daily aggregation
  const dayMap = new Map<string, ReturnPeriodSummary>();
  for (const ret of returns) {
    const date = ret.created_at.slice(0, 10);
    const prev = dayMap.get(date) ?? { date, returnCount: 0, refundAmount: 0 };
    prev.returnCount++;
    prev.refundAmount += ret.refund_amount;
    dayMap.set(date, prev);
  }

  const byDay = Array.from(dayMap.values()).sort((a, b) => a.date.localeCompare(b.date));

  // Summary stats
  const totalReturns = returns.length;
  const totalRefundAmount = returns.reduce((sum, r) => sum + r.refund_amount, 0);
  const pendingRefunds = refunds.filter((r) => r.status === "pending").length;
  const averageRefund = totalReturns > 0 ? totalRefundAmount / totalReturns : 0;

  return {
    totalReturns,
    totalRefundAmount,
    byMethod,
    topReturnedProducts,
    byDay,
    pendingRefunds,
    averageRefund,
  };
}
