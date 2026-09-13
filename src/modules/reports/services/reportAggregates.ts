/**
 * Report aggregates read from PostgreSQL, instead of recomputed in the browser.
 * ═══════════════════════════════════════════════════════════════════════════
 * The reports screen used to answer "what did we take this month?" by fetching
 * invoices and summing them in the browser. Two things follow from that, and
 * neither is a rounding complaint:
 *
 *   1. `SALES_ROW_CAP` limits the read to the most recent 1,000 invoices, so on
 *      any real book the totals were computed from a SLICE. The screen said so —
 *      Phase 22 made the truncation visible rather than silent — but a visible
 *      wrong number is still a wrong number, and the differential suite in
 *      `scripts/reports.aggregates.mjs` measures the gap on a 2,500-invoice
 *      dataset at 1,439 invoices and 1,140,251.80 EGP.
 *   2. Every open of the screen moved the whole period into browser memory to
 *      add it up, then threw it away.
 *
 * Migration 0032 adds five RPCs that do the SUM/COUNT/GROUP BY where the rows
 * already are. This module is the only place that calls them.
 *
 * What is deliberately NOT in the database: percentages, averages and margins.
 * The RPCs return additive parts — counts, units, sums of money — and every
 * derived figure is computed here with the app's own `share()` and
 * `roundMoney()`. Two definitions of "margin" is how a report starts
 * disagreeing with itself, and the day that happens nobody can say which number
 * is the real one.
 *
 * Also not in the database: what a day is. `dayKeyOf` buckets by the BROWSER's
 * local calendar day, so the caller's IANA zone name travels with the request.
 * A name and not a UTC offset — Egypt observes daylight saving, so a window
 * spanning April or October contains two offsets, and one number would move
 * every late-evening invoice of the other season into the wrong day.
 *
 * Every function returns a RESULT, never throws and never returns a partial
 * number. When the database cannot answer — demo mode, a project whose
 * migrations predate 0032, a caller without `view_reports` — the result says so
 * and the caller falls back to the builders it already has. Falling back is not
 * a privilege escalation: it computes over rows the caller was already allowed
 * to read, and RLS gates the RPCs through the same `public.can()` the rows are
 * gated by.
 */
import { getSupabaseClient } from "@/lib/supabase/client";
import { roundMoney } from "@/modules/expenses/validation";
import type { PaymentMethod } from "@/modules/pos/types";
import { toTimestampBounds } from "./dateRanges";
import type { DateRange, FinancialTotals } from "./financialExport";
import {
  share,
  type EmployeeSalesRow,
  type PaymentMethodSalesRow,
  type ProductPerformanceRow,
  type StockValueTotals,
  type TrendPoint,
} from "./salesAnalytics";
import type { ExpenseBreakdownRow, ExpenseDayRow } from "./expenseAnalytics";

// ── the result every caller gets ────────────────────────────────────────────
/**
 * Either the aggregate or the reason there isn't one.
 *
 * A report that cannot reach the database must still render — with the numbers
 * the browser can compute and, where the screen has room, the reason. Throwing
 * here would turn a missing migration into an empty screen.
 */
export type AggregateResult<T> = { ok: true; value: T } | { ok: false; reason: string };

/** The zone name to send with a day-bucketed request. */
export function clientTimeZone(): string {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return zone && zone.length > 0 ? zone : "UTC";
  } catch {
    return "UTC";
  }
}

// ── jsonb → the app's own types ─────────────────────────────────────────────
// Postgres numerics reach the browser as JSON numbers, but a numeric that
// travelled through `jsonb_build_object` is not type-guaranteed the way a column
// read is, and a driver is free to hand back a string. Coercing once, here,
// means no report tile ever renders "NaN" because of a transport detail.
type Json = Record<string, unknown>;
const n = (v: unknown): number => {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  if (typeof v === "string" && v.trim() !== "") {
    const parsed = Number(v);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
};
const str = (v: unknown): string => (typeof v === "string" ? v : v === null || v === undefined ? "" : String(v));
const bool = (v: unknown): boolean => v === true || v === "t" || v === "true";
const list = (v: unknown): Json[] => (Array.isArray(v) ? (v.filter((x) => x && typeof x === "object") as Json[]) : []);
const record = (v: unknown): Json | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : null;

/** The window as the database wants it: absolute instants, or no bound. */
function boundsOf(range: DateRange): { p_from: string | null; p_to: string | null } {
  const bounds = toTimestampBounds(range);
  return { p_from: bounds.from ?? null, p_to: bounds.to ?? null };
}

/** The Supabase client, or null when there is no database to talk to. */
function safeClient(): ReturnType<typeof getSupabaseClient> | null {
  try {
    return getSupabaseClient();
  } catch {
    return null;
  }
}

const NO_DATABASE = "no database connection";

/** Call an RPC that answers with one jsonb OBJECT. */
async function callRpc<T>(
  fn: string,
  params: Record<string, unknown>,
  map: (raw: Json) => T,
): Promise<AggregateResult<T>> {
  const client = safeClient();
  if (!client || typeof client.rpc !== "function") return { ok: false, reason: NO_DATABASE };

  const { data, error } = await client.rpc(fn, params);
  if (error) return { ok: false, reason: error.message || fn };
  const raw = record(data);
  if (!raw) return { ok: false, reason: `${fn} returned nothing` };
  try {
    return { ok: true, value: map(raw) };
  } catch (cause) {
    return { ok: false, reason: `${fn}: ${(cause as Error).message}` };
  }
}

/**
 * Call an RPC that answers with a jsonb ARRAY of rows.
 *
 * Only `reports_product_performance` does — it mirrors a function that returns
 * a list, not a summary — so it gets its own path rather than forcing the row
 * array through an object wrapper the database never promised.
 */
async function callRpcRows<T>(
  fn: string,
  params: Record<string, unknown>,
  map: (rows: Json[]) => T,
): Promise<AggregateResult<T>> {
  const client = safeClient();
  if (!client || typeof client.rpc !== "function") return { ok: false, reason: NO_DATABASE };

  const { data, error } = await client.rpc(fn, params);
  if (error) return { ok: false, reason: error.message || fn };
  const rows = list(data);
  if (!Array.isArray(data)) return { ok: false, reason: `${fn} returned nothing` };
  try {
    return { ok: true, value: map(rows) };
  } catch (cause) {
    return { ok: false, reason: `${fn}: ${(cause as Error).message}` };
  }
}

// ── 1. financial totals ─────────────────────────────────────────────────────
/**
 * The headline numbers of the financial report, over EVERY invoice in the
 * window rather than the most recent thousand.
 *
 * The shape is `FinancialTotals` itself — the same object
 * `computeFinancialTotals` returns — so a screen cannot tell the two apart and
 * cannot render one field from each.
 */
export async function fetchFinancialSummary(range: DateRange): Promise<AggregateResult<FinancialTotals>> {
  return callRpc("reports_financial_summary", boundsOf(range), (raw) => ({
    invoiceCount: n(raw.invoiceCount),
    revenue: n(raw.revenue),
    cogs: n(raw.cogs),
    grossProfit: n(raw.grossProfit),
    expenses: n(raw.expenses),
    netProfit: n(raw.netProfit),
    cash: n(raw.cash),
    card: n(raw.card),
    instapay: n(raw.instapay),
    unsettled: n(raw.unsettled),
    voidedCount: n(raw.voidedCount),
    voidedTotal: n(raw.voidedTotal),
    returnsCount: n(raw.returnsCount),
    returnsTotal: n(raw.returnsTotal),
    refundsCount: n(raw.refundsCount),
    refundsPaid: n(raw.refundsPaid),
    refundsPending: n(raw.refundsPending),
    unitCount: n(raw.unitCount),
  }));
}

// ── 2. the sales report ─────────────────────────────────────────────────────
export interface SalesSummaryTotals {
  invoices: number;
  revenue: number;
  discounts: number;
  units: number;
  voidedCount: number;
}

export interface SalesSummary {
  totals: SalesSummaryTotals;
  byMethod: PaymentMethodSalesRow[];
  byEmployee: EmployeeSalesRow[];
  byDay: TrendPoint[];
}

/**
 * Totals, payment mix, per employee and per day, in one call.
 *
 * The percentages are added here: `share` is the same function the browser-side
 * builders use, so a row read from the database and a row computed in the
 * browser carry the same share for the same money.
 */
export async function fetchSalesSummary(range: DateRange): Promise<AggregateResult<SalesSummary>> {
  return callRpc(
    "reports_sales_summary",
    { ...boundsOf(range), p_timezone: clientTimeZone() },
    (raw) => {
      const totals: SalesSummaryTotals = {
        invoices: n(raw.invoices),
        revenue: n(raw.revenue),
        discounts: n(raw.discounts),
        units: n(raw.units),
        voidedCount: n(raw.voidedCount),
      };

      const methods = list(raw.byMethod);
      // salesByPaymentMethod's denominator is the money APPLIED to invoices,
      // which sums to more than the invoice total when a payment was tendered
      // with change. Summing the rows keeps that column adding to 100%.
      const applied = roundMoney(methods.reduce((acc, m) => acc + n(m.amount), 0));
      const byMethod: PaymentMethodSalesRow[] = methods.map((m) => ({
        method: str(m.method) as PaymentMethod,
        invoices: n(m.invoices),
        amount: n(m.amount),
        paid: n(m.paid),
        pending: n(m.pending),
        share: share(n(m.amount), applied),
      }));

      const byEmployee: EmployeeSalesRow[] = list(raw.byEmployee).map((e) => {
        const revenue = n(e.revenue);
        const invoices = n(e.invoices);
        return {
          userId: str(e.userId),
          userName: str(e.userName),
          invoices,
          units: n(e.units),
          revenue,
          discounts: n(e.discounts),
          avgInvoice: invoices > 0 ? roundMoney(revenue / invoices) : 0,
          share: share(revenue, totals.revenue),
        };
      });

      const byDay: TrendPoint[] = list(raw.byDay).map((d) => ({
        date: str(d.date),
        invoices: n(d.invoices),
        units: n(d.units),
        revenue: n(d.revenue),
        discounts: n(d.discounts),
      }));

      return { totals, byMethod, byEmployee, byDay };
    },
  );
}

// ── 3. product performance ──────────────────────────────────────────────────
/**
 * One row per catalogue product, sold or not — `productPerformance`'s own
 * contract, which is why the RPC left-joins the shelf rather than the sales.
 *
 * Profit and margin are derived here from the returned revenue and cost, with
 * the same `share()` the browser path uses.
 */
export async function fetchProductPerformance(
  range: DateRange,
): Promise<AggregateResult<ProductPerformanceRow[]>> {
  return callRpcRows("reports_product_performance", boundsOf(range), (rows) =>
    rows.map((r) => {
      const revenue = n(r.revenue);
      const cost = n(r.cost);
      const profit = roundMoney(revenue - cost);
      return {
        productId: str(r.productId),
        sku: str(r.sku),
        nameEn: str(r.nameEn),
        nameAr: str(r.nameAr),
        sold: bool(r.sold),
        invoices: n(r.invoices),
        units: n(r.units),
        revenue,
        sellingPrice: n(r.sellingPrice),
        cost,
        profit,
        margin: share(profit, revenue),
        stock: n(r.stock),
        stockValue: n(r.stockValue),
      } satisfies ProductPerformanceRow;
    }),
  );
}

// ── 4. the shelf, valued ────────────────────────────────────────────────────
/** A snapshot of now — `stockValueTotals` has no window, and neither does this. */
export async function fetchInventorySummary(): Promise<AggregateResult<StockValueTotals>> {
  return callRpc("reports_inventory_summary", {}, (raw) => ({
    products: n(raw.products),
    tracked: n(raw.tracked),
    units: n(raw.units),
    atCost: n(raw.atCost),
    atRetail: n(raw.atRetail),
    potentialMargin: n(raw.potentialMargin),
    lowStock: n(raw.lowStock),
    outOfStock: n(raw.outOfStock),
  }));
}

// ── 5. expenses ─────────────────────────────────────────────────────────────
/** The headline expense of the window: its identity, not the whole expense book. */
export interface LargestExpense {
  id: string;
  expenseNumber: string;
  name: string;
  amount: number;
  category: string;
  method: string;
  spentAt: string;
}

export interface ExpenseAggregate {
  count: number;
  total: number;
  cash: number;
  instapay: number;
  visa: number;
  activeDays: number;
  /** Total ÷ active days: what a working day costs the shop. */
  avgPerActiveDay: number;
  byCategory: ExpenseBreakdownRow[];
  byMethod: ExpenseBreakdownRow[];
  byEmployee: ExpenseBreakdownRow[];
  byBranch: ExpenseBreakdownRow[];
  byDay: ExpenseDayRow[];
  largest: LargestExpense | null;
}

/**
 * The expense report's aggregates, filtered on `spent_at` as the screen filters.
 *
 * `share` and `avg` are derived per row from the returned count and total, and
 * `avgPerActiveDay` from the returned total and active days — the same three
 * divisions `buildExpenseReport` performs.
 */
export async function fetchExpenseSummary(range: DateRange): Promise<AggregateResult<ExpenseAggregate>> {
  return callRpc(
    "reports_expense_summary",
    { ...boundsOf(range), p_timezone: clientTimeZone() },
    (raw) => {
      const total = n(raw.total);
      const activeDays = n(raw.activeDays);

      const breakdown = (value: unknown): ExpenseBreakdownRow[] =>
        list(value).map((r) => {
          const rowTotal = n(r.total);
          const count = n(r.count);
          return {
            key: str(r.key),
            label: str(r.label),
            count,
            total: rowTotal,
            cash: n(r.cash),
            instapay: n(r.instapay),
            visa: n(r.visa),
            share: share(rowTotal, total),
            avg: count > 0 ? roundMoney(rowTotal / count) : 0,
          };
        });

      const largestRaw = record(raw.largest);
      return {
        count: n(raw.count),
        total,
        cash: n(raw.cash),
        instapay: n(raw.instapay),
        visa: n(raw.visa),
        activeDays,
        avgPerActiveDay: activeDays > 0 ? roundMoney(total / activeDays) : 0,
        byCategory: breakdown(raw.byCategory),
        byMethod: breakdown(raw.byMethod),
        byEmployee: breakdown(raw.byEmployee),
        byBranch: breakdown(raw.byBranch),
        byDay: list(raw.byDay).map((d) => ({
          date: str(d.date),
          count: n(d.count),
          total: n(d.total),
          largest: n(d.largest),
          largestName: str(d.largestName),
        })),
        largest: largestRaw
          ? {
              id: str(largestRaw.id),
              expenseNumber: str(largestRaw.expenseNumber),
              name: str(largestRaw.name),
              amount: n(largestRaw.amount),
              category: str(largestRaw.category),
              method: str(largestRaw.method),
              spentAt: str(largestRaw.spentAt),
            }
          : null,
      };
    },
  );
}
