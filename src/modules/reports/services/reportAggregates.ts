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
 * already are. This module calls the financial one, which is the aggregate a
 * screen renders as a headline number.
 *
 * The other four (`reports_sales_summary`, `reports_product_performance`,
 * `reports_inventory_summary`, `reports_expense_summary`) are in the database,
 * gated by the same `public.can('view_reports')` and covered by the role
 * scenarios and the differential suite, but they have no TypeScript client and
 * deliberately do not gain one here. Their would-be consumers are the advanced
 * report tabs, whose contract is raw rows on purpose — `ReportTabProps` says why
 * — and `stockValueTotals` reads the whole catalogue, which no row cap limits,
 * so a round trip would add latency without changing a number. Phase 22.1 shipped
 * these four wrappers ahead of a caller; the Phase 23 audit removed them rather
 * than leave mapping code that nothing executes and no test covers.
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
import { toTimestampBounds } from "./dateRanges";
import type { DateRange, FinancialTotals } from "./financialExport";

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
