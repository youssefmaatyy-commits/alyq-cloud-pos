/**
 * Customer CRM arithmetic (Phase 55).
 *
 * The customer book (`customers`) stays the only identity. Sales stay on
 * `sale.customer_id` when that id is a real customer. An online sale whose id
 * was not a customer row (live mode drops unknown ids) is *shown* against the
 * one customer whose phone is the same — a display link, never a write, and
 * never a fuzzy-name merge. Two customers that share a phone are reported, not
 * merged, and an unlinked sale is not guessed onto either of them.
 *
 * Realized purchases are `status === "completed"` only. Voided sales, pending
 * invoices and orders that never became a sale are not purchases. Refunds
 * reduce net value once, and only when the refund is `completed` — a rejected
 * or still-pending refund is history, not money returned.
 *
 * AOV is the average completed invoice total (what was charged, after
 * discounts, from the sale snapshot) **before** refunds. Net customer value is
 * that paid total minus completed refund amounts — the refunded amount, never
 * the original list price.
 *
 *   paid 1000 + 1500 + 2500 = 5000
 *   count 3
 *   AOV 1666.67
 *   refund 500
 *   net 4500
 *
 * List roll-ups read sale headers only (status, total, source, customer, date).
 * Line items are read only when a profile asks for favourites or item history.
 */
import { identityPhone } from "@/lib/phone";
import { variantLabelOf } from "@/modules/online/services/variantLabel";
import type { Sale, SaleItem, SaleSource, SaleStatus } from "@/modules/pos/types";
import type { SalesReturn } from "@/modules/returns/types";
import type { Customer } from "../types";

export const CRM_RULES = {
  /** Average of completed invoice totals. Refunds are not folded into AOV. */
  aovBasis: "completed_invoice_total_before_refunds",
  /** Paid purchase total minus completed refund amounts, once each. */
  netBasis: "completed_paid_minus_completed_refunds",
  /** Account opened within this many days, and not yet a repeat buyer. */
  newWindowDays: 30,
  /** No completed purchase in this many days (or never, and older than this). */
  inactiveDays: 90,
  /** Net customer value at or above this (EGP) is High value. Fixed, not scored. */
  highValueNet: 5000,
} as const;

export type CrmSegment = "new" | "returning" | "high_value" | "inactive";

export type CrmSortKey = "book" | "spend" | "orders" | "recent" | "inactive";

export interface CustomerKpis {
  /** Sum of completed invoice totals (snapshot `sale.total`). */
  paidTotal: number;
  purchaseCount: number;
  /** `paidTotal / purchaseCount`, before refunds. 0 when there are no purchases. */
  aov: number;
  /** Sum of completed refund amounts. Rejected and pending do not count. */
  refundTotal: number;
  /** `paidTotal − refundTotal`. */
  netValue: number;
  lastPurchaseAt: string | null;
  posPaid: number;
  posCount: number;
  onlinePaid: number;
  onlineCount: number;
}

export interface PurchaseHistoryRow {
  saleId: string;
  saleNumber: string;
  orderNumber: string | null;
  at: string;
  channel: SaleSource;
  gross: number;
  discounts: number;
  netPaid: number;
  status: SaleStatus;
  /** False for voided and pending — shown, not counted in KPIs. */
  counted: boolean;
  items: PurchaseHistoryItem[];
}

export interface PurchaseHistoryItem {
  nameAr: string;
  nameEn: string;
  variantLabel: string;
  quantity: number;
  lineTotal: number;
}

export interface ReturnHistoryRow {
  returnId: string;
  returnNumber: string;
  at: string;
  saleId: string;
  saleNumber: string;
  refundAmount: number;
  status: SalesReturn["refund_status"];
  /** True only for a completed refund — the only status that reduces net value. */
  counted: boolean;
  items: PurchaseHistoryItem[];
}

export interface FavoriteProduct {
  key: string;
  productId: string;
  nameAr: string;
  nameEn: string;
  variantLabel: string;
  units: number;
  /** Distinct completed invoices that included this product/variant. */
  frequency: number;
  netSpend: number;
  categoryId: string | null;
}

export interface FavoriteCategory {
  categoryId: string;
  nameAr: string;
  nameEn: string;
  units: number;
  netSpend: number;
}

export interface CrmProductRef {
  id: string;
  category_id: string | null;
  name_ar: string;
  name_en: string;
}

export interface CrmCategoryRef {
  id: string;
  name_ar: string;
  name_en: string;
}

export interface CustomerDirectoryRow {
  customer: Customer;
  kpis: CustomerKpis;
  segments: CrmSegment[];
}

const EMPTY_KPIS = (): CustomerKpis => ({
  paidTotal: 0,
  purchaseCount: 0,
  aov: 0,
  refundTotal: 0,
  netValue: 0,
  lastPurchaseAt: null,
  posPaid: 0,
  posCount: 0,
  onlinePaid: 0,
  onlineCount: 0,
});

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

function addMoney(left: number, right: number): number {
  return roundMoney(left + right);
}

export function saleChannel(sale: Pick<Sale, "source">): SaleSource {
  return sale.source === "online" ? "online" : "pos";
}

/** Invoice discounts from the sale snapshot. Never the live catalogue. */
export function saleDiscountTotal(sale: Pick<Sale, "discount_amount" | "item_discount_amount" | "automatic_discount_amount" | "total_discount_amount">): number {
  if (typeof sale.total_discount_amount === "number" && Number.isFinite(sale.total_discount_amount)) {
    return roundMoney(Math.max(sale.total_discount_amount, 0));
  }
  return roundMoney(
    Math.max(sale.discount_amount ?? 0, 0) +
      Math.max(sale.item_discount_amount ?? 0, 0) +
      Math.max(sale.automatic_discount_amount ?? 0, 0),
  );
}

export function saleGrossAmount(sale: Pick<Sale, "subtotal" | "total" | "discount_amount" | "item_discount_amount" | "automatic_discount_amount" | "total_discount_amount">): number {
  if (typeof sale.subtotal === "number" && sale.subtotal > 0) return roundMoney(sale.subtotal);
  return roundMoney(sale.total + saleDiscountTotal(sale));
}

function isCountedPurchase(sale: Pick<Sale, "status">): boolean {
  return sale.status === "completed";
}

export interface SaleAttribution {
  /** Customer id → sales shown on that profile. A sale is in at most one list. */
  byCustomer: Map<string, Sale[]>;
  /** Walk-ins, and unlinked sales whose phone matches more than one customer. */
  unattributed: Sale[];
  /**
   * Customers whose phones collapse to the same identity. Reported, never merged.
   * Groups of one are omitted. Empty phones are not a group.
   */
  duplicateGroups: Customer[][];
}

export function duplicateCustomerGroups(customers: readonly Customer[]): Customer[][] {
  const groups = new Map<string, Customer[]>();
  for (const customer of customers) {
    const key = identityPhone(customer.phone);
    if (!key) continue;
    const list = groups.get(key) ?? [];
    list.push(customer);
    groups.set(key, list);
  }
  return [...groups.values()].filter((group) => group.length > 1);
}

/**
 * Attribute sales for display.
 *
 * 1. `customer_id` that exists in the book wins. The sale is not moved because
 *    the snapshot phone looks like someone else.
 * 2. Otherwise, if exactly one customer shares the snapshot phone, the sale is
 *    shown on that profile. Nothing is written back.
 * 3. Zero or many phone matches → unattributed. Duplicates are listed, not merged.
 */
export function attributeSales(customers: readonly Customer[], sales: readonly Sale[]): SaleAttribution {
  const byId = new Map(customers.map((customer) => [customer.id, customer]));
  const byPhone = new Map<string, Customer[]>();
  for (const customer of customers) {
    const key = identityPhone(customer.phone);
    if (!key) continue;
    const list = byPhone.get(key) ?? [];
    list.push(customer);
    byPhone.set(key, list);
  }

  const byCustomer = new Map<string, Sale[]>();
  const unattributed: Sale[] = [];

  for (const sale of sales) {
    const linked = sale.customer_id ? byId.get(sale.customer_id) : undefined;
    if (linked) {
      const list = byCustomer.get(linked.id) ?? [];
      list.push(sale);
      byCustomer.set(linked.id, list);
      continue;
    }
    const key = identityPhone(sale.customer_phone);
    const matches = key ? byPhone.get(key) ?? [] : [];
    if (matches.length === 1) {
      const owner = matches[0];
      const list = byCustomer.get(owner.id) ?? [];
      list.push(sale);
      byCustomer.set(owner.id, list);
      continue;
    }
    unattributed.push(sale);
  }

  return { byCustomer, unattributed, duplicateGroups: duplicateCustomerGroups(customers) };
}

/**
 * Returns follow the customer id when it is in the book. Otherwise they follow
 * the sale they were filed against, if that sale was attributed. A return is
 * never attached twice.
 */
export function attributeReturns(
  customers: readonly Customer[],
  returnsList: readonly SalesReturn[],
  salesByCustomer: ReadonlyMap<string, readonly Sale[]>,
): Map<string, SalesReturn[]> {
  const ids = new Set(customers.map((customer) => customer.id));
  const saleOwner = new Map<string, string>();
  for (const [customerId, sales] of salesByCustomer) {
    for (const sale of sales) saleOwner.set(sale.id, customerId);
  }

  const byCustomer = new Map<string, SalesReturn[]>();
  const seen = new Set<string>();
  for (const entry of returnsList) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    const owner =
      (entry.customer_id && ids.has(entry.customer_id) ? entry.customer_id : null) ??
      saleOwner.get(entry.sale_id) ??
      null;
    if (!owner) continue;
    const list = byCustomer.get(owner) ?? [];
    list.push(entry);
    byCustomer.set(owner, list);
  }
  return byCustomer;
}

export function customerKpis(sales: readonly Sale[], returnsList: readonly SalesReturn[]): CustomerKpis {
  const kpis = EMPTY_KPIS();
  for (const sale of sales) {
    if (!isCountedPurchase(sale)) continue;
    kpis.paidTotal = addMoney(kpis.paidTotal, sale.total);
    kpis.purchaseCount += 1;
    if (!kpis.lastPurchaseAt || sale.created_at > kpis.lastPurchaseAt) {
      kpis.lastPurchaseAt = sale.created_at;
    }
    if (saleChannel(sale) === "online") {
      kpis.onlinePaid = addMoney(kpis.onlinePaid, sale.total);
      kpis.onlineCount += 1;
    } else {
      kpis.posPaid = addMoney(kpis.posPaid, sale.total);
      kpis.posCount += 1;
    }
  }
  const seenRefunds = new Set<string>();
  for (const entry of returnsList) {
    if (entry.refund_status !== "completed") continue;
    if (seenRefunds.has(entry.id)) continue;
    seenRefunds.add(entry.id);
    kpis.refundTotal = addMoney(kpis.refundTotal, entry.refund_amount);
  }
  kpis.aov = kpis.purchaseCount === 0 ? 0 : roundMoney(kpis.paidTotal / kpis.purchaseCount);
  kpis.netValue = roundMoney(kpis.paidTotal - kpis.refundTotal);
  return kpis;
}

function daysBetween(laterIso: string, earlierIso: string): number {
  const later = new Date(laterIso).getTime();
  const earlier = new Date(earlierIso).getTime();
  if (!Number.isFinite(later) || !Number.isFinite(earlier)) return 0;
  return (later - earlier) / 86_400_000;
}

/**
 * Factual labels from {@link CRM_RULES}. A customer may carry more than one
 * (Returning + High value, or High value + Inactive). New and Returning are
 * mutually exclusive. There is no score.
 */
export function customerSegments(
  customer: Pick<Customer, "created_at">,
  kpis: CustomerKpis,
  nowIso: string = new Date().toISOString(),
): CrmSegment[] {
  const labels: CrmSegment[] = [];
  const ageDays = daysBetween(nowIso, customer.created_at);
  if (kpis.purchaseCount >= 2) labels.push("returning");
  else if (ageDays <= CRM_RULES.newWindowDays) labels.push("new");

  if (kpis.netValue >= CRM_RULES.highValueNet) labels.push("high_value");

  const quietAnchor = kpis.lastPurchaseAt ?? customer.created_at;
  const quietDays = daysBetween(nowIso, quietAnchor);
  if (quietDays > CRM_RULES.inactiveDays) labels.push("inactive");
  return labels;
}

/** Dictionary key for a segment. `high_value` is not a legal translation key. */
export function segmentLabelKey(
  segment: CrmSegment,
): "customers.segment.new" | "customers.segment.returning" | "customers.segment.highValue" | "customers.segment.inactive" {
  switch (segment) {
    case "high_value":
      return "customers.segment.highValue";
    case "returning":
      return "customers.segment.returning";
    case "inactive":
      return "customers.segment.inactive";
    default:
      return "customers.segment.new";
  }
}

function historyItem(item: SaleItem, lang: "ar" | "en"): PurchaseHistoryItem {
  return {
    nameAr: item.name_ar,
    nameEn: item.name_en,
    variantLabel: variantLabelOf(
      {
        color_ar: item.variant_color_ar,
        color_en: item.variant_color_en,
        size: item.variant_size,
        size_label: item.variant_size_label,
      },
      lang,
    ),
    quantity: item.quantity,
    lineTotal: item.line_total,
  };
}

function returnHistoryItem(item: SalesReturn["items"][number], lang: "ar" | "en"): PurchaseHistoryItem {
  return {
    nameAr: item.name_ar,
    nameEn: item.name_en,
    variantLabel: variantLabelOf(
      {
        color_ar: item.variant_color_ar,
        color_en: item.variant_color_en,
        size: item.variant_size,
        size_label: item.variant_size_label,
      },
      lang,
    ),
    quantity: item.quantity,
    lineTotal: item.line_total,
  };
}

export function purchaseHistory(
  sales: readonly Sale[],
  orderNumberBySaleId: ReadonlyMap<string, string> = new Map(),
  lang: "ar" | "en" = "en",
): PurchaseHistoryRow[] {
  return sales
    .slice()
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
    .map((sale) => ({
      saleId: sale.id,
      saleNumber: sale.sale_number,
      orderNumber: orderNumberBySaleId.get(sale.id) ?? null,
      at: sale.created_at,
      channel: saleChannel(sale),
      gross: saleGrossAmount(sale),
      discounts: saleDiscountTotal(sale),
      netPaid: roundMoney(sale.total),
      status: sale.status,
      counted: isCountedPurchase(sale),
      items: sale.items.map((item) => historyItem(item, lang)),
    }));
}

export function returnHistory(returnsList: readonly SalesReturn[], lang: "ar" | "en" = "en"): ReturnHistoryRow[] {
  const seen = new Set<string>();
  return returnsList
    .filter((entry) => {
      if (seen.has(entry.id)) return false;
      seen.add(entry.id);
      return true;
    })
    .slice()
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
    .map((entry) => ({
      returnId: entry.id,
      returnNumber: entry.return_number,
      at: entry.created_at,
      saleId: entry.sale_id,
      saleNumber: entry.sale_number,
      refundAmount: roundMoney(entry.refund_amount),
      status: entry.refund_status,
      counted: entry.refund_status === "completed",
      items: entry.items.map((item) => returnHistoryItem(item, lang)),
    }));
}

function variantGroupKey(item: SaleItem): string {
  if (item.variant_id) return `v:${item.variant_id}`;
  const snap = [item.variant_color_en, item.variant_color_ar, item.variant_size, item.variant_size_label]
    .filter((part) => part !== null && part !== undefined && String(part) !== "")
    .join("|");
  return snap ? `snap:${item.product_id}:${snap}` : `p:${item.product_id}`;
}

/**
 * Most purchased products, from completed sale lines only.
 *
 * Rank is units, then net spend (line snapshot totals), then name. Gold/17 and
 * Silver/17 stay separate. Category comes from the catalogue id on the product
 * that was sold — not from a wishlist, and not invented when the product is gone.
 */
export function favoriteProducts(
  sales: readonly Sale[],
  products: readonly CrmProductRef[],
  lang: "ar" | "en" = "en",
): FavoriteProduct[] {
  const catalog = new Map(products.map((product) => [product.id, product]));
  const groups = new Map<string, FavoriteProduct & { saleIds: Set<string> }>();

  for (const sale of sales) {
    if (!isCountedPurchase(sale)) continue;
    for (const item of sale.items) {
      const key = variantGroupKey(item);
      const existing = groups.get(key);
      const product = catalog.get(item.product_id);
      if (!existing) {
        groups.set(key, {
          key,
          productId: item.product_id,
          nameAr: item.name_ar,
          nameEn: item.name_en,
          variantLabel: variantLabelOf(
            {
              color_ar: item.variant_color_ar,
              color_en: item.variant_color_en,
              size: item.variant_size,
              size_label: item.variant_size_label,
            },
            lang,
          ),
          units: item.quantity,
          frequency: 0,
          netSpend: roundMoney(item.line_total),
          categoryId: product?.category_id ?? null,
          saleIds: new Set([sale.id]),
        });
        continue;
      }
      existing.units += item.quantity;
      existing.netSpend = addMoney(existing.netSpend, item.line_total);
      existing.saleIds.add(sale.id);
      if (existing.categoryId === null && product?.category_id) existing.categoryId = product.category_id;
    }
  }

  return [...groups.values()]
    .map(({ saleIds, ...row }) => ({ ...row, frequency: saleIds.size }))
    .sort((a, b) => b.units - a.units || b.netSpend - a.netSpend || a.nameEn.localeCompare(b.nameEn));
}

export function favoriteCategories(
  favorites: readonly FavoriteProduct[],
  categories: readonly CrmCategoryRef[],
): FavoriteCategory[] {
  const names = new Map(categories.map((category) => [category.id, category]));
  const groups = new Map<string, FavoriteCategory>();
  for (const row of favorites) {
    const id = row.categoryId ?? "";
    const known = id ? names.get(id) : undefined;
    const key = known ? known.id : "__uncategorized__";
    const existing = groups.get(key) ?? {
      categoryId: key,
      nameAr: known?.name_ar ?? "",
      nameEn: known?.name_en ?? "",
      units: 0,
      netSpend: 0,
    };
    existing.units += row.units;
    existing.netSpend = addMoney(existing.netSpend, row.netSpend);
    groups.set(key, existing);
  }
  return [...groups.values()].sort((a, b) => b.units - a.units || b.netSpend - a.netSpend || a.nameEn.localeCompare(b.nameEn));
}

/** Header-only directory. Does not read `sale.items`. */
export function buildCustomerDirectory(
  customers: readonly Customer[],
  sales: readonly Sale[],
  returnsList: readonly SalesReturn[],
  nowIso?: string,
): { rows: CustomerDirectoryRow[]; attribution: SaleAttribution } {
  const attribution = attributeSales(customers, sales);
  const returnsByCustomer = attributeReturns(customers, returnsList, attribution.byCustomer);
  const rows = customers.map((customer) => {
    const ownSales = attribution.byCustomer.get(customer.id) ?? [];
    const ownReturns = returnsByCustomer.get(customer.id) ?? [];
    const kpis = customerKpis(ownSales, ownReturns);
    return { customer, kpis, segments: customerSegments(customer, kpis, nowIso) };
  });
  return { rows, attribution };
}

export function profileForCustomer(
  customer: Customer,
  sales: readonly Sale[],
  returnsList: readonly SalesReturn[],
  nowIso?: string,
): { sales: Sale[]; returnsList: SalesReturn[]; kpis: CustomerKpis; segments: CrmSegment[] } {
  const { attribution } = buildCustomerDirectory([customer], sales, returnsList, nowIso);
  // Directory built from one customer would phone-match every unlinked sale.
  // Re-attribute against the full book is the caller's job. This helper is for
  // a customer already sliced out of a full attribution.
  const ownSales = attribution.byCustomer.get(customer.id) ?? [];
  const ownReturns = attributeReturns([customer], returnsList, attribution.byCustomer).get(customer.id) ?? [];
  const kpis = customerKpis(ownSales, ownReturns);
  return { sales: ownSales, returnsList: ownReturns, kpis, segments: customerSegments(customer, kpis, nowIso) };
}

function digitRun(value: string): string {
  return value.replace(/\D/g, "");
}

/**
 * Name, phone or email. Case-insensitive. A phone query matches with or
 * without spaces, dashes and a leading country code, via {@link identityPhone}
 * when both sides have one, otherwise via digit substring.
 */
export function customerMatchesQuery(customer: Pick<Customer, "name" | "phone" | "email">, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  const terms = needle.split(/\s+/).filter(Boolean);
  const name = customer.name.toLowerCase();
  const email = (customer.email ?? "").toLowerCase();
  const phone = customer.phone.toLowerCase();
  const phoneDigits = digitRun(customer.phone);
  const phoneIdentity = identityPhone(customer.phone);
  return terms.every((term) => {
    if (name.includes(term) || email.includes(term) || phone.includes(term)) return true;
    const termDigits = digitRun(term);
    if (termDigits.length >= 3 && phoneDigits.includes(termDigits)) return true;
    const termIdentity = identityPhone(term);
    return Boolean(termIdentity && phoneIdentity && phoneIdentity.includes(termIdentity));
  });
}

export function sortDirectory(rows: readonly CustomerDirectoryRow[], sort: CrmSortKey): CustomerDirectoryRow[] {
  const copy = rows.slice();
  // Book order is the repository order (newest customer first). The list must
  // not reshuffle until staff pick a sort — callers click the first row.
  if (sort === "book") return copy;
  const byName = (a: CustomerDirectoryRow, b: CustomerDirectoryRow) => a.customer.name.localeCompare(b.customer.name);
  if (sort === "spend") {
    copy.sort((a, b) => b.kpis.paidTotal - a.kpis.paidTotal || b.kpis.purchaseCount - a.kpis.purchaseCount || byName(a, b));
  } else if (sort === "orders") {
    copy.sort((a, b) => b.kpis.purchaseCount - a.kpis.purchaseCount || b.kpis.paidTotal - a.kpis.paidTotal || byName(a, b));
  } else if (sort === "recent") {
    copy.sort((a, b) => {
      const aAt = a.kpis.lastPurchaseAt;
      const bAt = b.kpis.lastPurchaseAt;
      if (aAt && bAt && aAt !== bAt) return aAt < bAt ? 1 : -1;
      if (aAt && !bAt) return -1;
      if (!aAt && bAt) return 1;
      return byName(a, b);
    });
  } else {
    copy.sort((a, b) => {
      const aAt = a.kpis.lastPurchaseAt ?? a.customer.created_at;
      const bAt = b.kpis.lastPurchaseAt ?? b.customer.created_at;
      if (aAt !== bAt) return aAt < bAt ? -1 : 1;
      return byName(a, b);
    });
  }
  return copy;
}

/**
 * Online orders a customer may be updated about. Match is the sale already
 * attributed to them, or the same phone — never the name. Duplicate phones
 * therefore see the same orders; the duplicate report says so, and nothing is merged.
 */
export function ordersMatchingCustomer<T extends { sale_id: string | null; customer_phone: string; created_at: string }>(
  customer: Pick<Customer, "phone">,
  orders: readonly T[],
  attributedSaleIds: ReadonlySet<string>,
): T[] {
  const phone = identityPhone(customer.phone);
  return orders
    .filter((order) => {
      if (order.sale_id && attributedSaleIds.has(order.sale_id)) return true;
      return Boolean(phone) && identityPhone(order.customer_phone) === phone;
    })
    .slice()
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
}

export function queryDirectory(
  rows: readonly CustomerDirectoryRow[],
  query: string,
  sort: CrmSortKey,
): CustomerDirectoryRow[] {
  const matched = rows.filter((row) => customerMatchesQuery(row.customer, query));
  return sortDirectory(matched, sort);
}
