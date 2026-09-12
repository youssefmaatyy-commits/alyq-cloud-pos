/**
 * Purchases & suppliers export.
 *
 * **There is no supplier entity in this system.** The schema has 20 tables and
 * none of them is `suppliers`; no module, type or screen owns supplier master
 * data, and nothing records a supplier invoice or an accounts-payable balance.
 * The word "supplier" appears in the app exactly twice: as the stock-movement
 * reason `supplier_return`, and as placeholder text in the expense form.
 *
 * Rather than invent a table (which would mean a migration, RLS policies, a new
 * module and a capability — a change to existing functionality, not an export),
 * this builder projects the supplier-*adjacent* data that does exist:
 *
 *   - stock movements whose reason is `purchase` or `supplier_return` — the
 *     goods that came in from, or went back to, a supplier;
 *   - expenses — the only place a supplier name is ever typed, as free text in
 *     `name` / `notes` ("Receipt number, supplier, justification…").
 *
 * Every derived figure is labelled in the sheet notes. In particular the
 * "net activity" column is **not** an accounts-payable balance: the app never
 * records what a supplier invoiced, so what is owed cannot be known from it.
 * Goods values are estimated at the product's *current* purchase price, because
 * a movement does not snapshot the price it was bought at.
 */
import {
  buildSheets,
  toDate,
  withinDateRange,
  type BuiltSheet,
  type ExportSheet,
  type PickBilingual,
  type Translate,
} from "@/lib/export";
import { signedDelta, type StockMovement } from "@/modules/inventory/types";
import type { Product } from "@/modules/products/types";
import type { Expense } from "@/modules/expenses/types";
import type { DateRange } from "./financialExport";

/** Reasons that mean "this movement involved a supplier". */
const SUPPLIER_REASONS = new Set(["purchase", "supplier_return"]);

/** One row of the detail sheet — a movement or an expense, unified. */
export interface SupplierActivityRow {
  /** Which source the row came from — the discriminator, never inferred. */
  kind: "movement" | "expense";
  at: string;
  /** Localised origin: stock movement or expense. */
  source: string;
  reference: string;
  /** Best available supplier name; empty when the data does not carry one. */
  supplier: string;
  productName: string;
  sku: string;
  /** Signed: positive = received, negative = returned. */
  quantity: number;
  unitCost: number | null;
  /** Estimated goods value, or the recorded expense amount. */
  amount: number;
  paymentMethod: string;
  user: string;
  notes: string;
}

export interface SuppliersExportInput {
  movements: readonly StockMovement[];
  expenses: readonly Expense[];
  products: readonly Product[];
  range: DateRange;
  t: Translate;
  pick: PickBilingual;
}

const money = (value: number) => Math.round(value * 100) / 100;

/** Unify supplier-relevant movements and expenses into one comparable row set. */
export function buildSupplierActivity(input: SuppliersExportInput): SupplierActivityRow[] {
  const { movements, expenses, products, range, t, pick } = input;
  const costById = new Map(products.map((p) => [p.id, p]));
  const rows: SupplierActivityRow[] = [];

  for (const movement of movements) {
    if (!SUPPLIER_REASONS.has(movement.reason)) continue;
    if (!withinDateRange(movement.created_at, range.from, range.to)) continue;

    const product = costById.get(movement.product_id);
    const unitCost = product ? product.cost_price : null;
    const quantity = signedDelta(movement.type, movement.delta);

    rows.push({
      kind: "movement",
      at: movement.created_at,
      source: t("export.source.movement"),
      reference: t(`inventory.reason.${movement.reason}` as never),
      supplier: "",
      productName: product ? pick(product.name_ar, product.name_en) : "",
      sku: product?.sku ?? "",
      quantity,
      unitCost,
      amount: unitCost === null ? 0 : money(quantity * unitCost),
      paymentMethod: "",
      user: movement.user_name,
      notes: movement.notes ?? "",
    });
  }

  for (const expense of expenses) {
    if (!withinDateRange(expense.spent_at, range.from, range.to)) continue;
    rows.push({
      kind: "expense",
      at: expense.spent_at,
      source: t("export.source.expense"),
      reference: expense.expense_number,
      // The expense's free-text name is the only supplier label the app holds.
      supplier: expense.name,
      productName: "",
      sku: "",
      quantity: 0,
      unitCost: null,
      amount: money(expense.amount),
      paymentMethod: t(`pos.payment.${expense.payment_method}` as never),
      user: expense.user_name,
      notes: expense.notes ?? "",
    });
  }

  return rows.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}

/** Per-supplier roll-up. Keyed by the free-text name expenses carry. */
export interface SupplierSummaryRow {
  supplier: string;
  purchaseCount: number;
  returnCount: number;
  goodsValue: number;
  returnedValue: number;
  expenseCount: number;
  expenseTotal: number;
  /** goodsValue − returnedValue − expenseTotal. See the module note. */
  netActivity: number;
  lastActivityAt: string | null;
}

export function summarizeSuppliers(
  rows: readonly SupplierActivityRow[],
  unknownLabel: string,
): SupplierSummaryRow[] {
  const byName = new Map<string, SupplierSummaryRow>();

  for (const row of rows) {
    const key = row.supplier.trim() || unknownLabel;
    const entry =
      byName.get(key) ??
      ({
        supplier: key,
        purchaseCount: 0,
        returnCount: 0,
        goodsValue: 0,
        returnedValue: 0,
        expenseCount: 0,
        expenseTotal: 0,
        netActivity: 0,
        lastActivityAt: null,
      } satisfies SupplierSummaryRow);

    if (row.kind === "expense") {
      entry.expenseCount += 1;
      entry.expenseTotal = money(entry.expenseTotal + row.amount);
    } else if (row.quantity >= 0) {
      entry.purchaseCount += 1;
      entry.goodsValue = money(entry.goodsValue + row.amount);
    } else {
      entry.returnCount += 1;
      entry.returnedValue = money(entry.returnedValue + Math.abs(row.amount));
    }

    if (!entry.lastActivityAt || row.at > entry.lastActivityAt) entry.lastActivityAt = row.at;
    byName.set(key, entry);
  }

  return [...byName.values()]
    .map((entry) => ({
      ...entry,
      netActivity: money(entry.goodsValue - entry.returnedValue - entry.expenseTotal),
    }))
    .sort((a, b) => b.goodsValue + b.expenseTotal - (a.goodsValue + a.expenseTotal));
}

export function buildSuppliersSheets(input: SuppliersExportInput): BuiltSheet[] {
  const { t } = input;
  const activity = buildSupplierActivity(input);
  const suppliers = summarizeSuppliers(activity, t("export.supplier.unknown"));

  const detail: ExportSheet<SupplierActivityRow> = {
    name: t("export.sheet.supplierActivity"),
    rows: activity,
    columns: [
      { header: t("export.col.dateTime"), value: (r) => toDate(r.at), kind: "datetime" },
      { header: t("export.col.source"), value: (r) => r.source, width: 18 },
      { header: t("export.col.reference"), value: (r) => r.reference, width: 18 },
      { header: t("export.col.supplier"), value: (r) => r.supplier, width: 28 },
      { header: t("export.col.product"), value: (r) => r.productName, width: 30 },
      { header: t("export.col.sku"), value: (r) => r.sku, width: 16 },
      { header: t("export.col.quantity"), value: (r) => (r.quantity === 0 ? null : r.quantity), kind: "number" },
      { header: t("export.col.unitCost"), value: (r) => r.unitCost, kind: "money" },
      { header: t("export.col.amount"), value: (r) => r.amount, kind: "money" },
      { header: t("export.col.paymentMethod"), value: (r) => r.paymentMethod, width: 16 },
      { header: t("export.col.user"), value: (r) => r.user, width: 20 },
      { header: t("export.col.notes"), value: (r) => r.notes, width: 34 },
    ],
    totals: [
      t("export.totalRow"),
      "",
      "",
      "",
      "",
      "",
      activity.reduce((acc, r) => acc + r.quantity, 0),
      null,
      money(activity.reduce((acc, r) => acc + r.amount, 0)),
      "",
      "",
      "",
    ],
    notes: [t("export.note.suppliers"), t("export.note.supplierGoodsValue")],
  };

  const rollup: ExportSheet<SupplierSummaryRow> = {
    name: t("export.sheet.suppliers"),
    rows: suppliers,
    columns: [
      { header: t("export.col.supplier"), value: (r) => r.supplier, width: 30 },
      { header: t("export.col.purchases"), value: (r) => r.purchaseCount, kind: "number", width: 12 },
      { header: t("export.col.supplierReturns"), value: (r) => r.returnCount, kind: "number", width: 14 },
      { header: t("export.col.goodsValue"), value: (r) => r.goodsValue, kind: "money", width: 18 },
      { header: t("export.col.returnedValue"), value: (r) => r.returnedValue, kind: "money", width: 18 },
      { header: t("export.col.expenses"), value: (r) => r.expenseTotal, kind: "money" },
      { header: t("export.col.netActivity"), value: (r) => r.netActivity, kind: "money", width: 18 },
      { header: t("export.col.lastActivity"), value: (r) => toDate(r.lastActivityAt), kind: "datetime" },
    ],
    notes: [t("export.note.suppliers"), t("export.note.netActivity")],
  };

  return buildSheets([detail, rollup]);
}
