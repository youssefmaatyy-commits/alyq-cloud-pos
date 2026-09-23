/**
 * Profit, margin, best sellers and slow movers — historical cost, not today's.
 *
 * Phase 53. The product-performance table still costs sold units at the
 * catalogue's current purchase price (the financial report's convention). This
 * module is the other answer: COGS is `sale_items.unit_cost` frozen at sale
 * time. A missing snapshot is unknown, never free. Discounts are four buckets
 * that never double-count. Returns reduce realized units/net/COGS with the
 * refunded amounts. Variants stay independent (Gold/17 is not Silver/17).
 *
 * Percentages stay here (`share`), not in SQL. RPCs (0055) return additive
 * sums; the screen prefers them in live mode the way the financial tab does.
 */
import { roundMoney } from "@/modules/expenses/validation";
import { withinDateRange } from "@/lib/export";
import { addUtcDays, dayStartUtcMs, utcDayKeyOfIso } from "@/lib/dates/calendarDays";
import type { Sale, SaleItem, SaleSource } from "@/modules/pos/types";
import type { Product } from "@/modules/products/types";
import { snapshotLabel, variantCost, type ProductVariant } from "@/modules/products/variants";
import type { SalesReturn } from "@/modules/returns/types";
import type { OnlineOrder } from "@/modules/online/types";
import { revenueSales, type DateRange } from "./financialExport";
import { share } from "./salesAnalytics";
import { lastDaysRange } from "./dateRanges";

export type ReportChannel = "all" | "pos" | "online";
export type SlowLookbackDays = 30 | 60 | 90;
export type BestSellerRank = "units" | "net";

export interface ProfitabilityKpis {
  invoices: number;
  unitsSold: number;
  grossSales: number;
  automaticDiscounts: number;
  promoCodeDiscounts: number;
  manualItemDiscounts: number;
  manualInvoiceDiscounts: number;
  totalDiscounts: number;
  discountShareOfGross: number;
  netSales: number;
  refundsAmount: number;
  refundedUnits: number;
  cogs: number;
  cogsUnknownUnits: number;
  cogsAuthoritative: boolean;
  grossProfit: number;
  grossMargin: number;
  aov: number;
  deliveryFeesCollected: number;
  shippingDiscount: number;
}

export interface DiscountImpactRow {
  key: "automatic" | "promo" | "manualItem" | "manualInvoice";
  amount: number;
  shareOfGross: number;
}

export interface ProductProfitRow {
  productId: string;
  sku: string;
  nameEn: string;
  nameAr: string;
  invoices: number;
  units: number;
  gross: number;
  discounts: number;
  net: number;
  cogs: number;
  cogsUnknownUnits: number;
  profit: number;
  margin: number;
}

export interface VariantProfitRow extends ProductProfitRow {
  variantId: string;
  colorEn: string | null;
  colorAr: string | null;
  size: number | null;
  sizeLabel: string | null;
  labelEn: string;
  labelAr: string;
}

export interface SlowMoverRow {
  productId: string;
  variantId: string | null;
  sku: string;
  nameEn: string;
  nameAr: string;
  labelEn: string;
  labelAr: string;
  stock: number;
  stockValue: number;
  units: number;
  lastSaleAt: string | null;
  daysSince: number | null;
}

export interface ProfitabilityTrendPoint {
  date: string;
  invoices: number;
  units: number;
  netSales: number;
  grossProfit: number;
  discounts: number;
}

export interface ProfitabilityReport {
  range: DateRange;
  channel: ReportChannel;
  kpis: ProfitabilityKpis;
  discounts: DiscountImpactRow[];
  products: ProductProfitRow[];
  variants: VariantProfitRow[];
  bestSellers: VariantProfitRow[];
  slowMovers: SlowMoverRow[];
  trend: ProfitabilityTrendPoint[];
}

function money(n: number): number {
  return roundMoney(n);
}

export function historicalUnitCost(item: Pick<SaleItem, "unit_cost">): number | null {
  if (item.unit_cost == null) return null;
  const n = Number(item.unit_cost);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** List amount before automatic + manual discounts. */
export function lineListAmount(item: SaleItem): number {
  const auto = Number(item.automatic_discount_amount ?? 0);
  if (item.gross_total != null && Number.isFinite(Number(item.gross_total))) {
    return money(Number(item.gross_total) + auto);
  }
  return money(Number(item.unit_price) * item.quantity + auto);
}

function matchesChannel(sale: Sale, channel: ReportChannel): boolean {
  if (channel === "all") return true;
  const source: SaleSource = sale.source ?? "pos";
  return source === channel;
}

function salesFor(sales: readonly Sale[], range: DateRange, channel: ReportChannel): Sale[] {
  return revenueSales(sales).filter(
    (sale) => matchesChannel(sale, channel) && withinDateRange(sale.created_at, range.from, range.to),
  );
}

function returnsFor(
  returnsList: readonly SalesReturn[],
  range: DateRange,
  liveSaleIds: ReadonlySet<string> | null,
): SalesReturn[] {
  return returnsList.filter((record) => {
    if (record.refund_status === "rejected") return false;
    if (!withinDateRange(record.created_at, range.from, range.to)) return false;
    if (liveSaleIds && !liveSaleIds.has(record.sale_id)) return false;
    return true;
  });
}

function realizedOrders(orders: readonly OnlineOrder[], saleIds: ReadonlySet<string>): OnlineOrder[] {
  return orders.filter(
    (order) =>
      order.sale_id != null &&
      saleIds.has(order.sale_id) &&
      order.status !== "cancelled",
  );
}

function promoDiscountOf(order: OnlineOrder): number {
  const snap = order.price_snapshot;
  if (snap && Number.isFinite(Number(snap.promo_discount))) return money(Number(snap.promo_discount));
  if (order.discount_code) return money(Number(order.discount_amount ?? 0));
  return 0;
}

function shippingDiscountOf(order: OnlineOrder): number {
  const snap = order.price_snapshot;
  if (snap && Number.isFinite(Number(snap.shipping_discount))) return money(Number(snap.shipping_discount));
  return 0;
}

function allocate(amount: number, weights: number[]): number[] {
  const total = weights.reduce((acc, w) => acc + w, 0);
  if (!(amount > 0) || !(total > 0)) return weights.map(() => 0);
  const raw = weights.map((w) => (w / total) * amount);
  const rounded = raw.map((n) => money(n));
  const drift = money(amount - rounded.reduce((acc, n) => acc + n, 0));
  if (drift !== 0 && rounded.length > 0) {
    let max = 0;
    for (let i = 1; i < weights.length; i += 1) if (weights[i] > weights[max]) max = i;
    rounded[max] = money(rounded[max] + drift);
  }
  return rounded;
}

interface LineAcc {
  productId: string;
  variantId: string | null;
  sku: string;
  nameEn: string;
  nameAr: string;
  colorEn: string | null;
  colorAr: string | null;
  size: number | null;
  sizeLabel: string | null;
  invoices: Set<string>;
  units: number;
  gross: number;
  discounts: number;
  net: number;
  cogs: number;
  cogsUnknownUnits: number;
}

function emptyLine(
  item: Pick<
    SaleItem,
    | "product_id"
    | "variant_id"
    | "sku"
    | "name_en"
    | "name_ar"
    | "variant_color_en"
    | "variant_color_ar"
    | "variant_size"
    | "variant_size_label"
  >,
): LineAcc {
  return {
    productId: item.product_id,
    variantId: item.variant_id ?? null,
    sku: item.sku,
    nameEn: item.name_en,
    nameAr: item.name_ar,
    colorEn: item.variant_color_en ?? null,
    colorAr: item.variant_color_ar ?? null,
    size: item.variant_size ?? null,
    sizeLabel: item.variant_size_label ?? null,
    invoices: new Set(),
    units: 0,
    gross: 0,
    discounts: 0,
    net: 0,
    cogs: 0,
    cogsUnknownUnits: 0,
  };
}

function variantKey(productId: string, variantId: string | null): string {
  return `${productId}::${variantId ?? ""}`;
}

function finishProduct(acc: LineAcc): ProductProfitRow {
  const profit = money(acc.net - acc.cogs);
  return {
    productId: acc.productId,
    sku: acc.sku,
    nameEn: acc.nameEn,
    nameAr: acc.nameAr,
    invoices: acc.invoices.size,
    units: acc.units,
    gross: money(acc.gross),
    discounts: money(acc.discounts),
    net: money(acc.net),
    cogs: money(acc.cogs),
    cogsUnknownUnits: acc.cogsUnknownUnits,
    profit,
    margin: share(profit, acc.net),
  };
}

function finishVariant(acc: LineAcc): VariantProfitRow {
  const base = finishProduct(acc);
  const snap = {
    color_en: acc.colorEn,
    color_ar: acc.colorAr,
    size: acc.size,
    size_label: acc.sizeLabel,
  };
  return {
    ...base,
    variantId: acc.variantId ?? "",
    colorEn: acc.colorEn,
    colorAr: acc.colorAr,
    size: acc.size,
    sizeLabel: acc.sizeLabel,
    labelEn: snapshotLabel(snap, "en") || base.sku,
    labelAr: snapshotLabel(snap, "ar") || base.sku,
  };
}

export function rankBestSellers<T extends { units: number; net: number; profit: number }>(
  rows: readonly T[],
  by: BestSellerRank = "units",
  limit = 20,
): T[] {
  const live = rows.filter((row) => row.units > 0);
  const sorted =
    by === "net"
      ? [...live].sort((a, b) => b.net - a.net || b.units - a.units)
      : [...live].sort((a, b) => b.units - a.units || b.net - a.net);
  return sorted.slice(0, limit);
}

function daysBetweenUtc(fromIso: string, toIso: string): number | null {
  const from = dayStartUtcMs(utcDayKeyOfIso(fromIso));
  const to = dayStartUtcMs(utcDayKeyOfIso(toIso));
  if (from == null || to == null) return null;
  return Math.max(0, Math.round((to - from) / 86_400_000));
}

export function buildProfitability(input: {
  sales: readonly Sale[];
  products: readonly Product[];
  variants?: readonly ProductVariant[];
  returns?: readonly SalesReturn[];
  orders?: readonly OnlineOrder[];
  range: DateRange;
  channel?: ReportChannel;
  lookbackDays?: SlowLookbackDays;
  now?: Date;
  rankBy?: BestSellerRank;
}): ProfitabilityReport {
  const channel = input.channel ?? "all";
  const lookbackDays = input.lookbackDays ?? 90;
  const now = input.now ?? new Date();
  const live = salesFor(input.sales, input.range, channel);
  const liveIds = new Set(live.map((sale) => sale.id));
  const returns = returnsFor(input.returns ?? [], input.range, null);
  const orders = realizedOrders(input.orders ?? [], liveIds);

  const invoices = live.length;
  let unitsSold = 0;
  let grossSales = 0;
  let automaticDiscounts = 0;
  let manualItemDiscounts = 0;
  let manualInvoiceDiscounts = 0;
  let netSales = 0;
  let cogs = 0;
  let cogsUnknownUnits = 0;

  const byProduct = new Map<string, LineAcc>();
  const byVariant = new Map<string, LineAcc>();
  const put = (map: Map<string, LineAcc>, key: string, item: SaleItem): LineAcc => {
    let row = map.get(key);
    if (!row) {
      row = emptyLine(item);
      map.set(key, row);
    }
    return row;
  };

  for (const sale of live) {
    netSales = money(netSales + sale.total);
    manualInvoiceDiscounts = money(manualInvoiceDiscounts + (sale.discount_amount || 0));
    const weights = sale.items.map((item) => Math.max(0, item.line_total));
    const invoiceShare = allocate(sale.discount_amount || 0, weights);

    sale.items.forEach((item, index) => {
      const list = lineListAmount(item);
      const auto = money(Number(item.automatic_discount_amount ?? 0));
      const itemDisc = money(Number(item.discount_amount ?? 0));
      const invoice = invoiceShare[index] ?? 0;
      const net = money(item.line_total - invoice);
      const cost = historicalUnitCost(item);
      const lineCogs = cost == null ? 0 : money(cost * item.quantity);
      const unknown = cost == null ? item.quantity : 0;

      unitsSold += item.quantity;
      grossSales = money(grossSales + list);
      automaticDiscounts = money(automaticDiscounts + auto);
      manualItemDiscounts = money(manualItemDiscounts + itemDisc);
      cogs = money(cogs + lineCogs);
      cogsUnknownUnits += unknown;

      const product = put(byProduct, item.product_id, item);
      product.invoices.add(sale.id);
      product.units += item.quantity;
      product.gross = money(product.gross + list);
      product.discounts = money(product.discounts + auto + itemDisc + invoice);
      product.net = money(product.net + net);
      product.cogs = money(product.cogs + lineCogs);
      product.cogsUnknownUnits += unknown;

      const vKey = variantKey(item.product_id, item.variant_id ?? null);
      const variant = put(byVariant, vKey, item);
      variant.invoices.add(sale.id);
      variant.units += item.quantity;
      variant.gross = money(variant.gross + list);
      variant.discounts = money(variant.discounts + auto + itemDisc + invoice);
      variant.net = money(variant.net + net);
      variant.cogs = money(variant.cogs + lineCogs);
      variant.cogsUnknownUnits += unknown;
    });
  }

  let refundsAmount = 0;
  let refundedUnits = 0;
  for (const record of returns) {
    refundsAmount = money(refundsAmount + record.refund_amount);
    const weights = record.items.map((item) => Math.max(0, item.line_total));
    const refundShare = allocate(record.refund_amount, weights);
    const originalSale = input.sales.find((sale) => sale.id === record.sale_id);
    record.items.forEach((item, index) => {
      refundedUnits += item.quantity;
      const refund = refundShare[index] ?? money(item.line_total);
      const original = originalSale?.items.find((line) => line.id === item.sale_item_id);
      const cost = original ? historicalUnitCost(original) : null;
      const returnedCogs = cost == null ? 0 : money(cost * item.quantity);
      const unknown = cost == null ? item.quantity : 0;

      unitsSold -= item.quantity;
      netSales = money(netSales - refund);
      cogs = money(cogs - returnedCogs);
      if (unknown) cogsUnknownUnits = Math.max(0, cogsUnknownUnits - unknown);

      const product = byProduct.get(item.product_id);
      if (product) {
        product.units -= item.quantity;
        product.net = money(product.net - refund);
        product.cogs = money(product.cogs - returnedCogs);
        if (unknown) product.cogsUnknownUnits = Math.max(0, product.cogsUnknownUnits - unknown);
      }
      const vKey = variantKey(item.product_id, item.variant_id ?? null);
      const variant = byVariant.get(vKey);
      if (variant) {
        variant.units -= item.quantity;
        variant.net = money(variant.net - refund);
        variant.cogs = money(variant.cogs - returnedCogs);
        if (unknown) variant.cogsUnknownUnits = Math.max(0, variant.cogsUnknownUnits - unknown);
      }
    });
  }

  const promoCodeDiscounts = money(orders.reduce((acc, order) => acc + promoDiscountOf(order), 0));
  const deliveryFeesCollected = money(orders.reduce((acc, order) => acc + Number(order.delivery_fee ?? 0), 0));
  const shippingDiscount = money(orders.reduce((acc, order) => acc + shippingDiscountOf(order), 0));

  const totalDiscounts = money(
    automaticDiscounts + promoCodeDiscounts + manualItemDiscounts + manualInvoiceDiscounts,
  );
  const grossProfit = money(netSales - cogs);
  const kpis: ProfitabilityKpis = {
    invoices,
    unitsSold,
    grossSales,
    automaticDiscounts,
    promoCodeDiscounts,
    manualItemDiscounts,
    manualInvoiceDiscounts,
    totalDiscounts,
    discountShareOfGross: share(totalDiscounts, grossSales),
    netSales,
    refundsAmount,
    refundedUnits,
    cogs: money(cogs),
    cogsUnknownUnits,
    cogsAuthoritative: cogsUnknownUnits <= 0,
    grossProfit,
    grossMargin: share(grossProfit, netSales),
    aov: invoices > 0 ? money(netSales / invoices) : 0,
    deliveryFeesCollected,
    shippingDiscount,
  };

  const discounts: DiscountImpactRow[] = [
    { key: "automatic", amount: automaticDiscounts, shareOfGross: share(automaticDiscounts, grossSales) },
    { key: "promo", amount: promoCodeDiscounts, shareOfGross: share(promoCodeDiscounts, grossSales) },
    { key: "manualItem", amount: manualItemDiscounts, shareOfGross: share(manualItemDiscounts, grossSales) },
    { key: "manualInvoice", amount: manualInvoiceDiscounts, shareOfGross: share(manualInvoiceDiscounts, grossSales) },
  ];

  const products = [...byProduct.values()]
    .map(finishProduct)
    .sort((a, b) => b.net - a.net || b.units - a.units);
  const variants = [...byVariant.values()]
    .filter((row) => row.variantId)
    .map(finishVariant)
    .sort((a, b) => b.net - a.net || b.units - a.units);

  const rankSource = variants.length > 0 ? variants : products.map((row) => ({
    ...row,
    variantId: "",
    colorEn: null,
    colorAr: null,
    size: null,
    sizeLabel: null,
    labelEn: row.nameEn,
    labelAr: row.nameAr,
  }));
  const bestSellers = rankBestSellers(rankSource, input.rankBy ?? "units");

  const lookback = lastDaysRange(now, lookbackDays);
  const slowMovers = slowMoversOf({
    sales: input.sales,
    products: input.products,
    variants: input.variants ?? [],
    returns: input.returns ?? [],
    channel,
    lookback,
    now,
  });

  const trend = profitabilityTrend(live, returns, input.range);

  return {
    range: input.range,
    channel,
    kpis,
    discounts,
    products,
    variants,
    bestSellers,
    slowMovers,
    trend,
  };
}

function profitabilityTrend(
  sales: readonly Sale[],
  returns: readonly SalesReturn[],
  range: DateRange,
): ProfitabilityTrendPoint[] {
  const days = new Map<string, ProfitabilityTrendPoint>();
  const put = (key: string): ProfitabilityTrendPoint => {
    let point = days.get(key);
    if (!point) {
      point = { date: key, invoices: 0, units: 0, netSales: 0, grossProfit: 0, discounts: 0 };
      days.set(key, point);
    }
    return point;
  };

  for (const sale of sales) {
    const key = utcDayKeyOfIso(sale.created_at);
    if (!key) continue;
    const point = put(key);
    point.invoices += 1;
    let units = 0;
    let cogs = 0;
    let lineDiscounts = 0;
    for (const item of sale.items) {
      units += item.quantity;
      const cost = historicalUnitCost(item);
      if (cost != null) cogs += cost * item.quantity;
      lineDiscounts += Number(item.automatic_discount_amount ?? 0) + Number(item.discount_amount ?? 0);
    }
    point.units += units;
    point.netSales = money(point.netSales + sale.total);
    point.discounts = money(point.discounts + lineDiscounts + (sale.discount_amount || 0));
    point.grossProfit = money(point.grossProfit + sale.total - cogs);
  }

  for (const record of returns) {
    const key = utcDayKeyOfIso(record.created_at);
    if (!key) continue;
    const point = put(key);
    point.netSales = money(point.netSales - record.refund_amount);
    point.grossProfit = money(point.grossProfit - record.refund_amount);
    point.units -= record.items.reduce((acc, item) => acc + item.quantity, 0);
  }

  if (range.from && range.to) {
    const fromMs = dayStartUtcMs(range.from);
    const toMs = dayStartUtcMs(range.to);
    const MAX_DAYS = 400;
    if (fromMs !== null && toMs !== null && toMs >= fromMs) {
      const span = Math.round((toMs - fromMs) / 86_400_000) + 1;
      if (span <= MAX_DAYS) {
        for (let index = 0; index < span; index += 1) {
          const key = addUtcDays(range.from, index);
          if (key) put(key);
        }
      }
    }
  }

  return [...days.values()].sort((a, b) => a.date.localeCompare(b.date));
}

function slowMoversOf(input: {
  sales: readonly Sale[];
  products: readonly Product[];
  variants: readonly ProductVariant[];
  returns: readonly SalesReturn[];
  channel: ReportChannel;
  lookback: DateRange;
  now: Date;
}): SlowMoverRow[] {
  const live = salesFor(input.sales, input.lookback, input.channel);
  const units = new Map<string, number>();
  const lastSale = new Map<string, string>();

  const bumpLast = (key: string, at: string) => {
    const prev = lastSale.get(key);
    if (!prev || at > prev) lastSale.set(key, at);
  };

  for (const sale of revenueSales(input.sales).filter((s) => matchesChannel(s, input.channel))) {
    for (const item of sale.items) bumpLast(variantKey(item.product_id, item.variant_id ?? null), sale.created_at);
  }
  for (const sale of live) {
    for (const item of sale.items) {
      const key = variantKey(item.product_id, item.variant_id ?? null);
      units.set(key, (units.get(key) ?? 0) + item.quantity);
    }
  }
  for (const record of returnsFor(input.returns, input.lookback, null)) {
    for (const item of record.items) {
      const key = variantKey(item.product_id, item.variant_id ?? null);
      units.set(key, (units.get(key) ?? 0) - item.quantity);
    }
  }

  const asOf = input.now.toISOString();
  const rows: SlowMoverRow[] = [];
  const variantsByProduct = new Map<string, ProductVariant[]>();
  for (const variant of input.variants) {
    const list = variantsByProduct.get(variant.product_id);
    if (list) list.push(variant);
    else variantsByProduct.set(variant.product_id, [variant]);
  }

  for (const product of input.products) {
    if (!product.active || !product.stock_tracking_enabled) continue;
    const own = variantsByProduct.get(product.id) ?? [];
    if (product.variants_enabled && own.length > 0) {
      for (const variant of own) {
        if (!variant.active || variant.stock_quantity <= 0) continue;
        const key = variantKey(product.id, variant.id);
        const moved = units.get(key) ?? 0;
        if (moved > 0) continue;
        const last = lastSale.get(key) ?? null;
        const cost = variantCost(variant, product);
        const snap = {
          color_en: variant.color_en,
          color_ar: variant.color_ar,
          size: variant.size,
          size_label: variant.size_label,
        };
        rows.push({
          productId: product.id,
          variantId: variant.id,
          sku: variant.sku,
          nameEn: product.name_en,
          nameAr: product.name_ar,
          labelEn: snapshotLabel(snap, "en") || variant.sku,
          labelAr: snapshotLabel(snap, "ar") || variant.sku,
          stock: variant.stock_quantity,
          stockValue: money(variant.stock_quantity * cost),
          units: Math.max(0, moved),
          lastSaleAt: last,
          daysSince: last ? daysBetweenUtc(last, asOf) : null,
        });
      }
      continue;
    }
    if (product.stock_quantity <= 0) continue;
    const key = variantKey(product.id, null);
    const moved = units.get(key) ?? 0;
    if (moved > 0) continue;
    const last = lastSale.get(key) ?? null;
    rows.push({
      productId: product.id,
      variantId: null,
      sku: product.sku,
      nameEn: product.name_en,
      nameAr: product.name_ar,
      labelEn: product.name_en,
      labelAr: product.name_ar,
      stock: product.stock_quantity,
      stockValue: money(product.stock_quantity * Number(product.cost_price ?? 0)),
      units: Math.max(0, moved),
      lastSaleAt: last,
      daysSince: last ? daysBetweenUtc(last, asOf) : null,
    });
  }

  return rows.sort((a, b) => b.stockValue - a.stockValue || a.sku.localeCompare(b.sku));
}
