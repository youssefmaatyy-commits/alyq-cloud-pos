/**
 * Inventory reports — pure aggregation functions over products and movements.
 *
 * Every function is a stateless reducer: takes arrays, returns summaries.
 * No side-effects, no network calls, no mock data. Used by the inventory
 * pages and the dashboard.
 */

import { stockStatus, type Product, type StockStatus } from "@/modules/products/types";
import type { StockMovement, StockMovementType, StockReason } from "../types";
import { isOutbound } from "../types";

// ── Stock Valuation ─────────────────────────────────────────────────────────

export interface StockValuationItem {
  product_id: string;
  sku: string;
  name_en: string;
  name_ar: string;
  stock_quantity: number;
  cost_price: number;
  /** stock_quantity × cost_price */
  value: number;
  status: StockStatus;
  category_id: string | null;
}

export interface StockValuationReport {
  items: StockValuationItem[];
  /** Sum of all item values. */
  totalValue: number;
  /** Number of tracked products with stock > 0. */
  valuedProducts: number;
  /** Total units across all tracked products. */
  totalUnits: number;
  /** Value grouped by category ID. */
  byCategory: { categoryId: string | null; value: number; units: number; count: number }[];
}

/**
 * Compute inventory valuation for all stock-tracked products.
 * Value = stock_quantity × cost_price for each product.
 */
export function computeStockValuation(
  products: Product[],
  _categoryName?: (id: string | null) => string,
): StockValuationReport {
  const tracked = products.filter((p) => p.stock_tracking_enabled);
  const items: StockValuationItem[] = [];
  let totalValue = 0;
  let totalUnits = 0;

  const categoryMap = new Map<string | null, { value: number; units: number; count: number }>();

  for (const p of tracked) {
    const value = p.stock_quantity * p.cost_price;
    const status = stockStatus(p);

    items.push({
      product_id: p.id,
      sku: p.sku,
      name_en: p.name_en,
      name_ar: p.name_ar,
      stock_quantity: p.stock_quantity,
      cost_price: p.cost_price,
      value,
      status,
      category_id: p.category_id,
    });

    totalValue += value;
    totalUnits += p.stock_quantity;

    const cat = categoryMap.get(p.category_id) ?? { value: 0, units: 0, count: 0 };
    cat.value += value;
    cat.units += p.stock_quantity;
    cat.count++;
    categoryMap.set(p.category_id, cat);
  }

  // Sort by value descending
  items.sort((a, b) => b.value - a.value);

  const byCategory = Array.from(categoryMap.entries())
    .map(([categoryId, data]) => ({ categoryId, ...data }))
    .sort((a, b) => b.value - a.value);

  return {
    items,
    totalValue,
    valuedProducts: tracked.filter((p) => p.stock_quantity > 0).length,
    totalUnits,
    byCategory,
  };
}

// ── Low Stock Report ────────────────────────────────────────────────────────

export interface LowStockItem {
  product_id: string;
  sku: string;
  name_en: string;
  name_ar: string;
  stock_quantity: number;
  low_stock_level: number;
  /** How many units below the threshold (positive = below). */
  shortfall: number;
  status: "low" | "out";
  category_id: string | null;
  cost_price: number;
  /** Estimated reorder cost (shortfall × cost_price). */
  reorderValue: number;
}

export interface LowStockReport {
  items: LowStockItem[];
  /** Total items that are low or out of stock. */
  totalAlerts: number;
  /** Items that are out of stock. */
  outOfStock: number;
  /** Items that are low but not out. */
  lowStock: number;
  /** Estimated total reorder value. */
  totalReorderValue: number;
}

/**
 * Generate a low stock report — all tracked products at or below their
 * low_stock_level threshold, sorted by urgency (out of stock first, then
 * by shortfall descending).
 */
export function computeLowStockReport(products: Product[]): LowStockReport {
  const items: LowStockItem[] = [];

  for (const p of products) {
    if (!p.stock_tracking_enabled) continue;
    const status = stockStatus(p);
    if (status !== "low" && status !== "out") continue;

    const shortfall = Math.max(0, p.low_stock_level - p.stock_quantity);
    const reorderValue = shortfall * p.cost_price;

    items.push({
      product_id: p.id,
      sku: p.sku,
      name_en: p.name_en,
      name_ar: p.name_ar,
      stock_quantity: p.stock_quantity,
      low_stock_level: p.low_stock_level,
      shortfall,
      status: status as "low" | "out",
      category_id: p.category_id,
      cost_price: p.cost_price,
      reorderValue,
    });
  }

  // Sort: out of stock first, then by shortfall descending
  items.sort((a, b) => {
    if (a.status !== b.status) return a.status === "out" ? -1 : 1;
    return b.shortfall - a.shortfall;
  });

  const outOfStock = items.filter((i) => i.status === "out").length;
  const lowStock = items.filter((i) => i.status === "low").length;

  return {
    items,
    totalAlerts: items.length,
    outOfStock,
    lowStock,
    totalReorderValue: items.reduce((sum, i) => sum + i.reorderValue, 0),
  };
}

// ── Movement Summary ────────────────────────────────────────────────────────

export interface MovementTypeSummary {
  type: StockMovementType;
  count: number;
  totalDelta: number;
  direction: "in" | "out";
}

export interface MovementReasonSummary {
  reason: StockReason;
  count: number;
  totalDelta: number;
}

export interface MovementPeriodSummary {
  /** ISO date string (YYYY-MM-DD). */
  date: string;
  inCount: number;
  outCount: number;
  inDelta: number;
  outDelta: number;
  netDelta: number;
}

export interface MovementReport {
  byType: MovementTypeSummary[];
  byReason: MovementReasonSummary[];
  byDay: MovementPeriodSummary[];
  totalIn: number;
  totalOut: number;
  totalCount: number;
}

/**
 * Summarise stock movements by type, reason and day.
 * `movements` should be pre-filtered to the desired period if needed.
 */
export function computeMovementReport(movements: StockMovement[]): MovementReport {
  const typeMap = new Map<StockMovementType, { count: number; totalDelta: number }>();
  const reasonMap = new Map<StockReason, { count: number; totalDelta: number }>();
  const dayMap = new Map<string, { inCount: number; outCount: number; inDelta: number; outDelta: number }>();

  let totalIn = 0;
  let totalOut = 0;

  for (const m of movements) {
    // By type
    const t = typeMap.get(m.type) ?? { count: 0, totalDelta: 0 };
    t.count++;
    t.totalDelta += m.delta;
    typeMap.set(m.type, t);

    // By reason
    const r = reasonMap.get(m.reason) ?? { count: 0, totalDelta: 0 };
    r.count++;
    r.totalDelta += m.delta;
    reasonMap.set(m.reason, r);

    // By day
    const date = m.created_at.slice(0, 10);
    const d = dayMap.get(date) ?? { inCount: 0, outCount: 0, inDelta: 0, outDelta: 0 };
    if (isOutbound(m.type)) {
      d.outCount++;
      d.outDelta += m.delta;
      totalOut += m.delta;
    } else {
      d.inCount++;
      d.inDelta += m.delta;
      totalIn += m.delta;
    }
    dayMap.set(date, d);
  }

  const byType: MovementTypeSummary[] = Array.from(typeMap.entries()).map(([type, data]) => ({
    type,
    count: data.count,
    totalDelta: data.totalDelta,
    direction: isOutbound(type) ? "out" : "in",
  }));

  const byReason: MovementReasonSummary[] = Array.from(reasonMap.entries()).map(([reason, data]) => ({
    reason,
    count: data.count,
    totalDelta: data.totalDelta,
  }));

  const byDay: MovementPeriodSummary[] = Array.from(dayMap.entries())
    .map(([date, data]) => ({
      date,
      inCount: data.inCount,
      outCount: data.outCount,
      inDelta: data.inDelta,
      outDelta: data.outDelta,
      netDelta: data.inDelta - data.outDelta,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));

  return {
    byType,
    byReason,
    byDay,
    totalIn,
    totalOut,
    totalCount: movements.length,
  };
}

// ── Stock Balance ───────────────────────────────────────────────────────────

export interface StockBalanceItem {
  product_id: string;
  sku: string;
  name_en: string;
  name_ar: string;
  stock_quantity: number;
  status: StockStatus;
  /** Net movement in the period (inflows − outflows). */
  periodNet: number;
  /** Total inflows in the period. */
  periodIn: number;
  /** Total outflows in the period. */
  periodOut: number;
}

/**
 * Stock balance report — current quantity + period movement for each
 * tracked product. Sorted by net movement descending (biggest movers first).
 */
export function computeStockBalance(
  products: Product[],
  movements: StockMovement[],
): StockBalanceItem[] {
  const movementByProduct = new Map<string, { in: number; out: number }>();
  for (const m of movements) {
    const entry = movementByProduct.get(m.product_id) ?? { in: 0, out: 0 };
    if (isOutbound(m.type)) {
      entry.out += m.delta;
    } else {
      entry.in += m.delta;
    }
    movementByProduct.set(m.product_id, entry);
  }

  const items: StockBalanceItem[] = products
    .filter((p) => p.stock_tracking_enabled)
    .map((p) => {
      const m = movementByProduct.get(p.id) ?? { in: 0, out: 0 };
      return {
        product_id: p.id,
        sku: p.sku,
        name_en: p.name_en,
        name_ar: p.name_ar,
        stock_quantity: p.stock_quantity,
        status: stockStatus(p),
        periodNet: m.in - m.out,
        periodIn: m.in,
        periodOut: m.out,
      };
    });

  items.sort((a, b) => Math.abs(b.periodNet) - Math.abs(a.periodNet));
  return items;
}
