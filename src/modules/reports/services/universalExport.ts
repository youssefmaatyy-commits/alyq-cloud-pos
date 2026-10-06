/**
 * Universal Data Export Engine.
 *
 * Provides comprehensive, full-database export builders across all 8 business domains:
 *   1. Sales & Money
 *   2. Inventory
 *   3. Catalog
 *   4. Customers
 *   5. Online Orders
 *   6. Shifts & Cash
 *   7. Operations & Audit
 *   8. Admin
 *
 * Plus the Multi-Sheet "Full Business Export" workbook.
 * All amounts are numeric with real Excel formatting, dates stay Date objects,
 * formula injection is neutralized, and RTL Arabic views are supported.
 */
import {
  buildSheets,
  toDate,
  withinDateRange,
  type BuiltSheet,
  type ExportColumn,
  type ExportSheet,
  type PickBilingual,
  type Translate,
} from "@/lib/export";
import { canAct } from "@/lib/permissions/enforce";
import type { Sale, SaleItem, SalePayment } from "@/modules/pos/types";
import type { Product, Category } from "@/modules/products/types";
import type { ProductVariant } from "@/modules/products/variants";
import type { Customer } from "@/modules/customers/types";
import type { SalesReturn, RefundRecord } from "@/modules/returns/types";
import type { Expense } from "@/modules/expenses/types";
import type { Shift, ShiftSummary } from "@/modules/shifts/types";
import type { StockMovement } from "@/modules/inventory/types";
import type { OnlineOrder } from "@/modules/online/types";
import type { AuditLogEntry } from "@/modules/audit/types";
import type { ManagedUser } from "@/modules/settings/types";
import type { CustomRole } from "@/lib/permissions/customRoles";
import type { BranchAccess } from "@/lib/branch/BranchProvider";
import { sizeLabelOf } from "@/modules/products/variants";
import { categoryNameIndex } from "@/modules/products/services/categoryTree";

export interface UniversalExportFilter {
  from?: string | null;
  to?: string | null;
  branchId?: string | null;
  staffId?: string | null;
  status?: string | null;
}

export interface UniversalExportContext {
  t: Translate;
  pick: PickBilingual;
  filter?: UniversalExportFilter;
  maySeeCost?: boolean;
}

export interface FullBusinessData {
  sales: readonly Sale[];
  products: readonly Product[];
  variants: readonly ProductVariant[];
  categories: readonly Category[];
  customers: readonly Customer[];
  returnsList: readonly SalesReturn[];
  refundsList: readonly RefundRecord[];
  expenses: readonly Expense[];
  shifts: readonly Shift[];
  shiftSummaryFor?: (shift: Shift) => ShiftSummary | null;
  movements: readonly StockMovement[];
  onlineOrders?: readonly OnlineOrder[];
  auditLogs?: readonly AuditLogEntry[];
  profiles?: readonly ManagedUser[];
  branches?: readonly BranchAccess[];
  customRoles?: readonly CustomRole[];
}

function yesNo(t: Translate, value: boolean): string {
  return value ? t("export.yes") : t("export.no");
}

// ══════════════════════════════════════════════════════════════════════════════
// 1. Sales & Money
// ══════════════════════════════════════════════════════════════════════════════

export function buildUniversalSalesSheets(
  sales: readonly Sale[],
  returnsList: readonly SalesReturn[],
  refundsList: readonly RefundRecord[],
  ctx: UniversalExportContext,
): BuiltSheet[] {
  const { t, filter, maySeeCost } = ctx;
  const seesCost = maySeeCost ?? canAct("view_cost");

  // Filter sales
  const filteredSales = sales.filter((s) => {
    if (!withinDateRange(s.created_at, filter?.from ?? null, filter?.to ?? null)) return false;
    if (filter?.branchId && s.branch_id && s.branch_id !== filter.branchId) return false;
    if (filter?.staffId && s.user_id && s.user_id !== filter.staffId) return false;
    if (filter?.status && s.status !== filter.status) return false;
    return true;
  });

  // Sheet 1: Invoices
  const invoicesSheet: ExportSheet<Sale> = {
    name: t("export.sheet.invoices"),
    rows: filteredSales,
    columns: [
      { header: t("export.col.invoiceNumber"), value: (s) => s.sale_number, width: 18 },
      { header: "Client Ref", value: (s) => s.client_ref || "", width: 20 },
      { header: t("export.col.date"), value: (s) => toDate(s.created_at), kind: "datetime" },
      { header: t("export.col.cashier"), value: (s) => s.user_name || "—", width: 18 },
      { header: t("export.col.customer"), value: (s) => s.customer_name || "—", width: 22 },
      { header: t("export.col.phone"), value: (s) => s.customer_phone || "", width: 16 },
      { header: t("export.col.subtotal"), value: (s) => s.subtotal, kind: "money" },
      { header: t("export.col.discount"), value: (s) => s.discount_amount ?? 0, kind: "money" },
      { header: t("export.col.total"), value: (s) => s.total, kind: "money" },
      { header: t("export.col.paid"), value: (s) => s.amount_received ?? s.total, kind: "money" },
      { header: t("export.col.remaining"), value: (s) => s.change ?? 0, kind: "money" },
      { header: t("export.col.status"), value: (s) => s.status, width: 14 },
    ],
    totals: [
      t("export.col.subtotal"),
      "",
      "",
      "",
      "",
      "",
      filteredSales.reduce((sum, s) => sum + s.subtotal, 0),
      filteredSales.reduce((sum, s) => sum + (s.discount_amount ?? 0), 0),
      filteredSales.reduce((sum, s) => sum + s.total, 0),
      filteredSales.reduce((sum, s) => sum + (s.amount_received ?? s.total), 0),
      filteredSales.reduce((sum, s) => sum + (s.change ?? 0), 0),
      "",
    ],
  };

  // Sheet 2: Sale Items
  const allItems: { item: SaleItem; sale: Sale }[] = [];
  for (const sale of filteredSales) {
    for (const item of sale.items || []) {
      allItems.push({ item, sale });
    }
  }

  const itemsSheet: ExportSheet<{ item: SaleItem; sale: Sale }> = {
    name: "Sale Items",
    rows: allItems,
    columns: [
      { header: t("export.col.invoiceNumber"), value: ({ sale }) => sale.sale_number, width: 18 },
      { header: t("export.col.date"), value: ({ sale }) => toDate(sale.created_at), kind: "datetime" },
      { header: t("export.col.product"), value: ({ item }) => ctx.pick(item.name_ar, item.name_en), width: 28 },
      { header: t("export.col.sku"), value: ({ item }) => item.sku, width: 16 },
      { header: t("export.col.barcode"), value: ({ item }) => item.barcode || "", width: 16 },
      { header: t("export.col.variantColour"), value: ({ item }) => ctx.pick(item.variant_color_ar, item.variant_color_en) || "—", width: 14 },
      { header: t("export.col.variantSize"), value: ({ item }) => item.variant_size_label || (item.variant_size !== null ? String(item.variant_size) : "—"), width: 10 },
      { header: t("export.col.unitPrice"), value: ({ item }) => item.unit_price, kind: "money" },
      { header: t("export.col.quantity"), value: ({ item }) => item.quantity, kind: "number" },
      { header: t("export.col.discount"), value: ({ item }) => item.discount_amount ?? 0, kind: "money" },
      { header: t("export.col.lineTotal"), value: ({ item }) => item.line_total, kind: "money" },
      ...(seesCost
        ? ([
            { header: t("export.col.costPrice"), value: ({ item }) => item.unit_cost ?? 0, kind: "money" },
            { header: t("export.col.margin"), value: ({ item }) => (item.unit_cost ? ((item.unit_price - item.unit_cost) / item.unit_price) * 100 : 0), kind: "percent" },
          ] as ExportColumn<{ item: SaleItem; sale: Sale }>[])
        : []),
    ],
  };

  // Sheet 3: Payments & Tenders
  const allPayments: { payment: SalePayment; sale: Sale }[] = [];
  for (const sale of filteredSales) {
    for (const payment of sale.payments || []) {
      allPayments.push({ payment, sale });
    }
  }

  const paymentsSheet: ExportSheet<{ payment: SalePayment; sale: Sale }> = {
    name: t("export.sheet.payments"),
    rows: allPayments,
    columns: [
      { header: t("export.col.invoiceNumber"), value: ({ sale }) => sale.sale_number, width: 18 },
      { header: t("export.col.date"), value: ({ payment, sale }) => toDate(payment.paid_at || sale.created_at), kind: "datetime" },
      { header: t("export.col.paymentMethod"), value: ({ payment }) => payment.method, width: 16 },
      { header: t("export.col.amount"), value: ({ payment }) => payment.amount, kind: "money" },
      { header: t("export.col.status"), value: ({ payment }) => payment.status, width: 14 },
    ],
    totals: [
      t("export.col.subtotal"),
      "",
      "",
      allPayments.reduce((sum, p) => sum + p.payment.amount, 0),
      "",
    ],
  };

  // Sheet 4: Returns & Refunds
  const filteredReturns = returnsList.filter((r) =>
    withinDateRange(r.created_at, filter?.from ?? null, filter?.to ?? null),
  );
  const filteredRefunds = refundsList.filter((r) =>
    withinDateRange(r.created_at, filter?.from ?? null, filter?.to ?? null),
  );

  const returnsSheet: ExportSheet<SalesReturn> = {
    name: t("export.sheet.returns"),
    rows: filteredReturns,
    columns: [
      { header: t("export.col.returnNumber"), value: (r) => r.return_number, width: 18 },
      { header: t("export.col.invoiceNumber"), value: (r) => r.sale_number || "", width: 18 },
      { header: t("export.col.date"), value: (r) => toDate(r.created_at), kind: "datetime" },
      { header: t("export.col.total"), value: (r) => r.refund_amount ?? 0, kind: "money" },
      { header: t("export.col.reason"), value: (r) => r.reason || "—", width: 20 },
      { header: t("export.col.status"), value: (r) => r.refund_status, width: 14 },
    ],
  };

  const refundsSheet: ExportSheet<RefundRecord> = {
    name: t("export.sheet.refunds"),
    rows: filteredRefunds,
    columns: [
      { header: t("export.col.refundNumber"), value: (r) => r.refund_number, width: 18 },
      { header: t("export.col.invoiceNumber"), value: (r) => r.sale_number || "", width: 18 },
      { header: t("export.col.date"), value: (r) => toDate(r.created_at), kind: "datetime" },
      { header: t("export.col.amount"), value: (r) => r.amount, kind: "money" },
      { header: t("export.col.paymentMethod"), value: (r) => r.payment_method, width: 16 },
      { header: t("export.col.status"), value: (r) => r.status, width: 14 },
    ],
  };

  return buildSheets([invoicesSheet, itemsSheet, paymentsSheet, returnsSheet, refundsSheet]);
}

// ══════════════════════════════════════════════════════════════════════════════
// 2. Inventory
// ══════════════════════════════════════════════════════════════════════════════

export function buildUniversalInventorySheets(
  products: readonly Product[],
  variants: readonly ProductVariant[],
  movements: readonly StockMovement[],
  categories: readonly Category[],
  ctx: UniversalExportContext,
): BuiltSheet[] {
  const { t, pick, filter, maySeeCost } = ctx;
  const seesCost = maySeeCost ?? canAct("view_cost");
  const catMap = categoryNameIndex([...categories], pick);

  // Sheet 1: Stock Balances
  const stockSheet: ExportSheet<Product> = {
    name: t("export.sheet.inventory"),
    rows: products.filter((p) => p.stock_tracking_enabled),
    columns: [
      { header: t("export.col.sku"), value: (p) => p.sku, width: 16 },
      { header: t("export.col.barcode"), value: (p) => p.barcode || "", width: 18 },
      { header: t("export.col.name"), value: (p) => pick(p.name_ar, p.name_en), width: 28 },
      { header: t("export.col.category"), value: (p) => (p.category_id ? catMap.get(p.category_id) ?? "—" : "—"), width: 18 },
      { header: t("export.col.currentQty"), value: (p) => p.stock_quantity, kind: "number" },
      { header: t("export.col.lowStockLevel"), value: (p) => p.low_stock_level, kind: "number" },
      ...(seesCost
        ? ([
            { header: t("export.col.costPrice"), value: (p) => p.cost_price ?? 0, kind: "money" },
            { header: "Total Value at Cost", value: (p) => (p.cost_price ?? 0) * p.stock_quantity, kind: "money" },
          ] as ExportColumn<Product>[])
        : []),
      { header: t("export.col.sellingPrice"), value: (p) => p.selling_price, kind: "money" },
      { header: "Total Value at Retail", value: (p) => p.selling_price * p.stock_quantity, kind: "money" },
    ],
  };

  // Sheet 2: Variant Stock Balances
  const variantStockSheet: ExportSheet<ProductVariant> = {
    name: "Variant Stock",
    rows: variants,
    columns: [
      { header: "Variant ID", value: (v) => v.id, width: 34 },
      { header: t("export.col.variantSku"), value: (v) => v.sku, width: 18 },
      { header: t("export.col.barcode"), value: (v) => v.barcode || "", width: 18 },
      { header: t("export.col.variantColour"), value: (v) => pick(v.color_ar, v.color_en) || "—", width: 14 },
      { header: t("export.col.variantSize"), value: (v) => sizeLabelOf(v.size, v.size_label), width: 12 },
      { header: t("export.col.currentQty"), value: (v) => v.stock_quantity, kind: "number" },
      { header: t("export.col.lowStockLevel"), value: (v) => v.low_stock_level, kind: "number" },
      ...(seesCost
        ? ([{ header: t("export.col.costPrice"), value: (v) => v.cost_override ?? 0, kind: "money" }] as ExportColumn<ProductVariant>[])
        : []),
      { header: t("export.col.sellingPrice"), value: (v) => v.price_override ?? 0, kind: "money" },
    ],
  };

  // Sheet 2: Stock Movements (Ledger)
  const filteredMovements = movements.filter((m) =>
    withinDateRange(m.created_at, filter?.from ?? null, filter?.to ?? null),
  );

  const movementsSheet: ExportSheet<StockMovement> = {
    name: "Stock Ledger",
    rows: filteredMovements,
    columns: [
      { header: "Movement ID", value: (m) => m.id, width: 34 },
      { header: t("export.col.date"), value: (m) => toDate(m.created_at), kind: "datetime" },
      { header: t("export.col.type"), value: (m) => m.type, width: 16 },
      { header: t("export.col.reason"), value: (m) => m.reason, width: 16 },
      { header: "Change", value: (m) => m.delta, kind: "number" },
      { header: "Qty Before", value: (m) => m.quantity_before, kind: "number" },
      { header: "Qty After", value: (m) => m.quantity_after, kind: "number" },
      { header: t("export.col.cashier"), value: (m) => m.user_name || "—", width: 18 },
      { header: t("export.col.notes"), value: (m) => m.notes || "", width: 24 },
    ],
  };

  return buildSheets([stockSheet, variantStockSheet, movementsSheet]);
}

// ══════════════════════════════════════════════════════════════════════════════
// 3. Catalog
// ══════════════════════════════════════════════════════════════════════════════

export function buildUniversalCatalogSheets(
  products: readonly Product[],
  variants: readonly ProductVariant[],
  categories: readonly Category[],
  ctx: UniversalExportContext,
): BuiltSheet[] {
  const { t, pick, maySeeCost } = ctx;
  const seesCost = maySeeCost ?? canAct("view_cost");
  const catMap = categoryNameIndex([...categories], pick);

  // Products Sheet
  const productsSheet: ExportSheet<Product> = {
    name: t("export.sheet.products"),
    rows: products,
    columns: [
      { header: "Product ID", value: (p) => p.id, width: 34 },
      { header: t("export.col.sku"), value: (p) => p.sku, width: 16 },
      { header: t("export.col.barcode"), value: (p) => p.barcode || "", width: 18 },
      { header: t("export.col.nameAr"), value: (p) => p.name_ar, width: 24 },
      { header: t("export.col.nameEn"), value: (p) => p.name_en, width: 24 },
      { header: t("export.col.category"), value: (p) => (p.category_id ? catMap.get(p.category_id) ?? "—" : "—"), width: 18 },
      { header: t("export.col.productType"), value: (p) => p.product_type, width: 14 },
      ...(seesCost
        ? ([{ header: t("export.col.costPrice"), value: (p) => p.cost_price ?? 0, kind: "money" }] as ExportColumn<Product>[])
        : []),
      { header: t("export.col.sellingPrice"), value: (p) => p.selling_price, kind: "money" },
      { header: t("export.col.taxRate"), value: (p) => p.tax_rate ?? 0, kind: "percent" },
      { header: t("export.col.stockTracking"), value: (p) => yesNo(t, p.stock_tracking_enabled), width: 14 },
      { header: t("export.col.active"), value: (p) => yesNo(t, p.active), width: 10 },
      { header: t("export.col.createdAt"), value: (p) => toDate(p.created_at), kind: "datetime" },
    ],
  };

  // Variants Sheet
  const variantsSheet: ExportSheet<ProductVariant> = {
    name: t("export.sheet.variants"),
    rows: variants,
    columns: [
      { header: "Variant ID", value: (v) => v.id, width: 34 },
      { header: "Product ID", value: (v) => v.product_id, width: 34 },
      { header: t("export.col.variantSku"), value: (v) => v.sku, width: 18 },
      { header: t("export.col.barcode"), value: (v) => v.barcode || "", width: 18 },
      { header: t("export.col.variantColour"), value: (v) => pick(v.color_ar, v.color_en) || "—", width: 14 },
      { header: t("export.col.variantSize"), value: (v) => sizeLabelOf(v.size, v.size_label), width: 12 },
      ...(seesCost
        ? ([{ header: t("export.col.costPrice"), value: (v) => v.cost_override ?? 0, kind: "money" }] as ExportColumn<ProductVariant>[])
        : []),
      { header: t("export.col.sellingPrice"), value: (v) => v.price_override ?? 0, kind: "money" },
      { header: t("export.col.active"), value: (v) => yesNo(t, v.active), width: 10 },
    ],
  };

  // Categories Sheet
  const categoriesSheet: ExportSheet<Category> = {
    name: "Categories",
    rows: categories,
    columns: [
      { header: "Category ID", value: (c) => c.id, width: 34 },
      { header: t("export.col.nameAr"), value: (c) => c.name_ar, width: 22 },
      { header: t("export.col.nameEn"), value: (c) => c.name_en, width: 22 },
      { header: "Parent Category", value: (c) => (c.parent_id ? catMap.get(c.parent_id) ?? "—" : "Root"), width: 18 },
      { header: "Sort Order", value: (c) => c.sort_order ?? 0, kind: "number" },
      { header: t("export.col.active"), value: (c) => yesNo(t, c.active), width: 10 },
    ],
  };

  return buildSheets([productsSheet, variantsSheet, categoriesSheet]);
}

// ══════════════════════════════════════════════════════════════════════════════
// 4. Customers
// ══════════════════════════════════════════════════════════════════════════════

export function buildUniversalCustomersSheets(
  customers: readonly Customer[],
  sales: readonly Sale[],
  ctx: UniversalExportContext,
): BuiltSheet[] {
  const { t } = ctx;

  const salesByCustomer = new Map<string, Sale[]>();
  for (const s of sales) {
    if (s.customer_id) {
      const list = salesByCustomer.get(s.customer_id) ?? [];
      list.push(s);
      salesByCustomer.set(s.customer_id, list);
    }
  }

  const customersSheet: ExportSheet<Customer> = {
    name: t("export.sheet.customers"),
    rows: customers,
    columns: [
      { header: "Customer ID", value: (c) => c.id, width: 34 },
      { header: t("export.col.name"), value: (c) => c.name, width: 24 },
      { header: t("export.col.phone"), value: (c) => c.phone, width: 16 },
      { header: "Email", value: (c) => c.email || "", width: 24 },
      { header: "Address", value: (c) => c.address || "", width: 28 },
      { header: "Total Orders", value: (c) => salesByCustomer.get(c.id)?.length ?? 0, kind: "number" },
      {
        header: "Total Spent",
        value: (c) => salesByCustomer.get(c.id)?.reduce((sum, s) => sum + s.total, 0) ?? 0,
        kind: "money",
      },
      { header: "Notes", value: (c) => c.notes || "", width: 24 },
      { header: t("export.col.createdAt"), value: (c) => toDate(c.created_at), kind: "datetime" },
    ],
  };

  return buildSheets([customersSheet]);
}

// ══════════════════════════════════════════════════════════════════════════════
// 5. Online Orders
// ══════════════════════════════════════════════════════════════════════════════

export function buildUniversalOnlineOrdersSheets(
  orders: readonly OnlineOrder[] = [],
  ctx: UniversalExportContext,
): BuiltSheet[] {
  const { t, filter } = ctx;

  const filteredOrders = orders.filter((o) =>
    withinDateRange(o.created_at, filter?.from ?? null, filter?.to ?? null),
  );

  const ordersSheet: ExportSheet<OnlineOrder> = {
    name: "Online Orders",
    rows: filteredOrders,
    columns: [
      { header: "Order #", value: (o) => o.order_number, width: 18 },
      { header: t("export.col.date"), value: (o) => toDate(o.created_at), kind: "datetime" },
      { header: "Customer Name", value: (o) => o.customer_name, width: 22 },
      { header: "Phone", value: (o) => o.customer_phone, width: 16 },
      { header: "Zone / City", value: (o) => o.delivery_zone_name_en || o.delivery_zone_name_ar || o.address?.city || "—", width: 18 },
      { header: t("export.col.subtotal"), value: (o) => o.subtotal, kind: "money" },
      { header: "Delivery Fee", value: (o) => o.delivery_fee, kind: "money" },
      { header: t("export.col.discount"), value: (o) => o.discount_amount ?? 0, kind: "money" },
      { header: t("export.col.total"), value: (o) => o.total, kind: "money" },
      { header: "Payment Method", value: (o) => o.payment_method, width: 16 },
      { header: "Payment Status", value: (o) => o.payment_status, width: 14 },
      { header: "Fulfillment Status", value: (o) => o.status, width: 16 },
    ],
  };

  return buildSheets([ordersSheet]);
}

// ══════════════════════════════════════════════════════════════════════════════
// 6. Shifts & Cash
// ══════════════════════════════════════════════════════════════════════════════

export function buildUniversalShiftsSheets(
  shifts: readonly Shift[],
  expenses: readonly Expense[],
  ctx: UniversalExportContext,
): BuiltSheet[] {
  const { t, filter } = ctx;

  const filteredShifts = shifts.filter((s) =>
    withinDateRange(s.opening_at, filter?.from ?? null, filter?.to ?? null),
  );
  const filteredExpenses = expenses.filter((e) =>
    withinDateRange(e.spent_at, filter?.from ?? null, filter?.to ?? null),
  );

  const shiftsSheet: ExportSheet<Shift> = {
    name: t("export.sheet.shifts"),
    rows: filteredShifts,
    columns: [
      { header: "Shift ID", value: (s) => s.id, width: 34 },
      { header: t("export.col.cashier"), value: (s) => s.opened_by_name, width: 18 },
      { header: "Opened At", value: (s) => toDate(s.opening_at), kind: "datetime" },
      { header: "Closed At", value: (s) => toDate(s.closed_at), kind: "datetime" },
      { header: "Opening Cash", value: (s) => s.opening_cash ?? 0, kind: "money" },
      { header: "Expected Cash", value: (s) => s.summary?.expected_cash ?? 0, kind: "money" },
      { header: "Actual Cash", value: (s) => s.closing_cash ?? s.summary?.actual_cash ?? 0, kind: "money" },
      { header: "Over / Short", value: (s) => s.summary?.difference ?? 0, kind: "money" },
      { header: t("export.col.status"), value: (s) => s.status, width: 14 },
    ],
  };

  const expensesSheet: ExportSheet<Expense> = {
    name: t("export.sheet.expenses"),
    rows: filteredExpenses,
    columns: [
      { header: "Expense ID", value: (e) => e.id, width: 34 },
      { header: t("export.col.date"), value: (e) => toDate(e.spent_at), kind: "datetime" },
      { header: "Name / Category", value: (e) => e.name || e.category, width: 22 },
      { header: t("export.col.amount"), value: (e) => e.amount, kind: "money" },
      { header: "Recorded By", value: (e) => e.user_name || "—", width: 18 },
      { header: "Notes", value: (e) => e.notes || "", width: 24 },
    ],
  };

  return buildSheets([shiftsSheet, expensesSheet]);
}

// ══════════════════════════════════════════════════════════════════════════════
// 7. Operations & Audit
// ══════════════════════════════════════════════════════════════════════════════

function sanitizeAuditDetails(details: unknown): string {
  if (!details || typeof details !== "object") return "";
  const sanitized = { ...(details as Record<string, unknown>) };
  for (const key of Object.keys(sanitized)) {
    if (/password|token|secret|pin|jwt|hash/i.test(key)) {
      delete sanitized[key];
    }
  }
  return JSON.stringify(sanitized);
}

export function buildUniversalAuditSheets(
  auditLogs: readonly AuditLogEntry[] = [],
  ctx: UniversalExportContext,
): BuiltSheet[] {
  const { filter } = ctx;

  const filteredLogs = auditLogs.filter((a) =>
    withinDateRange(a.created_at, filter?.from ?? null, filter?.to ?? null),
  );

  const auditSheet: ExportSheet<AuditLogEntry> = {
    name: "Audit Trail",
    rows: filteredLogs,
    columns: [
      { header: "Timestamp", value: (a) => toDate(a.created_at), kind: "datetime" },
      { header: "Action", value: (a) => a.action, width: 22 },
      { header: "Entity", value: (a) => a.entity, width: 16 },
      { header: "Entity ID", value: (a) => a.entity_id || "", width: 24 },
      { header: "Entity Label", value: (a) => a.entity_label || "", width: 22 },
      { header: "User", value: (a) => a.user_name || "System", width: 18 },
      { header: "Details", value: (a) => sanitizeAuditDetails(a.details), width: 40 },
    ],
  };

  return buildSheets([auditSheet]);
}

// ══════════════════════════════════════════════════════════════════════════════
// 8. Admin & Setup
// ══════════════════════════════════════════════════════════════════════════════

export function buildUniversalAdminSheets(
  profiles: readonly ManagedUser[] = [],
  branches: readonly BranchAccess[] = [],
  customRoles: readonly CustomRole[] = [],
  ctx: UniversalExportContext,
): BuiltSheet[] {
  const { t } = ctx;

  const profilesSheet: ExportSheet<ManagedUser> = {
    name: "Staff & Users",
    rows: profiles,
    columns: [
      { header: "User ID", value: (p) => p.id, width: 34 },
      { header: "Name", value: (p) => p.name || "", width: 22 },
      { header: "Username", value: (p) => p.username || "", width: 20 },
      { header: "Email", value: (p) => p.email || "", width: 24 },
      { header: "Role", value: (p) => p.role, width: 16 },
      { header: t("export.col.active"), value: (p) => yesNo(t, p.active), width: 10 },
      { header: t("export.col.createdAt"), value: (p) => toDate(p.created_at), kind: "datetime" },
    ],
  };

  const branchesSheet: ExportSheet<BranchAccess> = {
    name: "Branches",
    rows: branches,
    columns: [
      { header: "Branch ID", value: (b) => b.id, width: 34 },
      { header: "Name (EN)", value: (b) => b.name_en, width: 22 },
      { header: "Name (AR)", value: (b) => b.name_ar, width: 22 },
      { header: "Code", value: (b) => b.code || "", width: 14 },
      { header: t("export.col.active"), value: (b) => yesNo(t, b.active), width: 10 },
    ],
  };

  const rolesSheet: ExportSheet<CustomRole> = {
    name: "Custom Roles",
    rows: customRoles,
    columns: [
      { header: "Role ID", value: (r) => r.id, width: 34 },
      { header: "Role Key", value: (r) => r.key, width: 20 },
      { header: "Name (EN)", value: (r) => r.name_en, width: 20 },
      { header: "Name (AR)", value: (r) => r.name_ar, width: 20 },
      { header: "Base Role", value: (r) => r.base_role, width: 16 },
      { header: "Capabilities Granted", value: (r) => r.capabilities.join(", "), width: 45 },
    ],
  };

  return buildSheets([profilesSheet, branchesSheet, rolesSheet]);
}

// ══════════════════════════════════════════════════════════════════════════════
// FULL BUSINESS EXPORT (Multi-Sheet Unified Workbook)
// ══════════════════════════════════════════════════════════════════════════════

export function buildFullBusinessExportWorkbook(
  data: FullBusinessData,
  ctx: UniversalExportContext,
): BuiltSheet[] {
  const salesSheets = buildUniversalSalesSheets(
    data.sales,
    data.returnsList,
    data.refundsList,
    ctx,
  );
  const inventorySheets = buildUniversalInventorySheets(
    data.products,
    data.variants,
    data.movements,
    data.categories,
    ctx,
  );
  const catalogSheets = buildUniversalCatalogSheets(
    data.products,
    data.variants,
    data.categories,
    ctx,
  );
  const customerSheets = buildUniversalCustomersSheets(data.customers, data.sales, ctx);
  const shiftSheets = buildUniversalShiftsSheets(data.shifts, data.expenses, ctx);

  const onlineSheets =
    data.onlineOrders && data.onlineOrders.length > 0
      ? buildUniversalOnlineOrdersSheets(data.onlineOrders, ctx)
      : [];

  const auditSheets =
    data.auditLogs && data.auditLogs.length > 0
      ? buildUniversalAuditSheets(data.auditLogs, ctx)
      : [];

  const adminSheets =
    (data.profiles && data.profiles.length > 0) ||
    (data.branches && data.branches.length > 0)
      ? buildUniversalAdminSheets(data.profiles ?? [], data.branches ?? [], data.customRoles ?? [], ctx)
      : [];

  // Combine all sheets into one comprehensive workbook
  return [
    ...salesSheets,
    ...inventorySheets,
    ...catalogSheets,
    ...customerSheets,
    ...shiftSheets,
    ...onlineSheets,
    ...auditSheets,
    ...adminSheets,
  ];
}
