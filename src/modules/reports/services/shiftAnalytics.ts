/**
 * Shift analytics — the drawer, counted three ways.
 *
 * Requirement 5 asks for a daily shift report, a cash-difference report and an
 * employee performance report, over opening balance, closing balance, expected
 * cash, actual cash and the difference between them. Every one of those five
 * numbers already exists: `computeShiftSummary` produces them for a shift (and
 * `ShiftProvider.summaryFor` keeps them live for an open drawer, frozen once it
 * closes). This file does not recalculate a single one of them. It reads the
 * summary, lays the shifts out as rows, and groups those rows — by day, by the
 * sign of their difference, and by the person who opened the drawer.
 *
 * That division is the whole reason this is a separate file from the shift
 * module's own calculations: a report that recomputed expected cash would be a
 * second opinion about money, and the two would eventually disagree. Here, if
 * the shift screen says a drawer was 12 EGP short, every report says 12 EGP
 * short, because they are all reading the same function.
 */
import { roundMoney } from "@/modules/expenses/validation";
import { withinDateRange } from "@/lib/export";
import type { Shift, ShiftSummary } from "@/modules/shifts/types";
import { shiftDuration } from "@/modules/shifts/services/shiftService";
import {
  cashDifference,
  differenceTone,
  type DifferenceTone,
} from "@/modules/shifts/services/shiftCalculations";
import { dayKeyOf } from "./salesAnalytics";
import type { DateRange } from "./financialExport";

export { cashDifference, differenceTone };

/** How a shift is handed over: `summaryFor` from the provider, live or frozen. */
export type ShiftSummarizer = (shift: Shift) => ShiftSummary | null;

export interface ShiftReportRow {
  shiftId: string;
  shiftNumber: string;
  branch: string;
  register: string;
  status: Shift["status"];
  /** Who opened the drawer — the performance report groups on this person. */
  userId: string;
  userName: string;
  openedAt: string;
  closedAt: string | null;
  duration: string;
  openingCash: number;
  invoices: number;
  salesTotal: number;
  cashSales: number;
  cashRefunds: number;
  expensesCount: number;
  expensesTotal: number;
  cashExpenses: number;
  expectedCash: number;
  /** Null while the drawer is open — nobody has counted it yet. */
  actualCash: number | null;
  difference: number | null;
  /** The same verdict the shift screen paints: over, short, exact, or unknown. */
  tone: DifferenceTone;
  notes: string | null;
}

export interface ShiftReportTotals {
  shifts: number;
  closed: number;
  open: number;
  openingCash: number;
  invoices: number;
  salesTotal: number;
  expensesTotal: number;
  expectedCash: number;
  /** Sum of the counted drawers (closed shifts only). */
  actualCash: number;
  /** Sum of the differences — the net position of every drawer in the window. */
  difference: number;
  over: number;
  short: number;
  /** Drawers that counted exactly right, which is the figure worth raising. */
  exact: number;
}

export interface ShiftReport {
  range: DateRange;
  rows: ShiftReportRow[];
  totals: ShiftReportTotals;
}

/**
 * The shifts a report is about.
 *
 * Ranged on `opening_at`: a shift that opened on Monday and closed after
 * midnight is Monday's shift, which is how the shop talks about it and how the
 * daily report has to group it if the two are to agree.
 */
export function shiftsInRange(shifts: readonly Shift[], range: DateRange): Shift[] {
  return shifts.filter((shift) => withinDateRange(shift.opening_at, range.from, range.to));
}

/** One shift as a report row, reading its summary rather than recomputing it. */
export function shiftReportRow(shift: Shift, summaryFor: ShiftSummarizer): ShiftReportRow {
  const summary = summaryFor(shift);
  const expected = summary?.expected_cash ?? shift.opening_cash;
  const actual = summary?.actual_cash ?? null;
  const difference = summary?.difference ?? (actual === null ? null : cashDifference(actual, expected));

  return {
    shiftId: shift.id,
    shiftNumber: shift.shift_number,
    branch: shift.branch,
    register: shift.register,
    status: shift.status,
    userId: shift.opened_by || "unknown",
    userName: shift.opened_by_name || "—",
    openedAt: shift.opening_at,
    closedAt: shift.closed_at,
    duration: shiftDuration(shift.opening_at, shift.closed_at),
    openingCash: shift.opening_cash,
    invoices: summary?.sales_count ?? 0,
    salesTotal: roundMoney(summary?.sales_total ?? 0),
    cashSales: roundMoney(summary?.cash_sales ?? 0),
    cashRefunds: roundMoney(summary?.cash_refunds ?? 0),
    expensesCount: summary?.expenses_count ?? 0,
    expensesTotal: roundMoney(summary?.expenses_total ?? 0),
    cashExpenses: roundMoney(summary?.cash_expenses ?? 0),
    expectedCash: roundMoney(expected),
    actualCash: actual === null ? null : roundMoney(actual),
    difference: difference === null ? null : roundMoney(difference),
    tone: differenceTone(difference),
    notes: shift.notes,
  };
}

function totalsOf(rows: readonly ShiftReportRow[]): ShiftReportTotals {
  const closed = rows.filter((row) => row.status === "closed");
  const counted = closed.filter((row) => row.actualCash !== null);

  const sum = (pick: (row: ShiftReportRow) => number) =>
    roundMoney(rows.reduce((acc, row) => acc + pick(row), 0));
  const sumCounted = (pick: (row: ShiftReportRow) => number) =>
    roundMoney(counted.reduce((acc, row) => acc + pick(row), 0));

  return {
    shifts: rows.length,
    closed: closed.length,
    open: rows.length - closed.length,
    openingCash: sum((row) => row.openingCash),
    invoices: rows.reduce((acc, row) => acc + row.invoices, 0),
    salesTotal: sum((row) => row.salesTotal),
    expensesTotal: sum((row) => row.expensesTotal),
    expectedCash: sumCounted((row) => row.expectedCash),
    actualCash: sumCounted((row) => row.actualCash ?? 0),
    difference: sumCounted((row) => row.difference ?? 0),
    over: roundMoney(
      counted.reduce((acc, row) => acc + Math.max(0, row.difference ?? 0), 0),
    ),
    short: roundMoney(
      counted.reduce((acc, row) => acc + Math.min(0, row.difference ?? 0), 0),
    ),
    exact: counted.filter((row) => (row.difference ?? 0) === 0).length,
  };
}

/** The whole shift report for a window, newest drawer first. */
export function buildShiftReport(input: {
  shifts: readonly Shift[];
  summaryFor: ShiftSummarizer;
  range: DateRange;
}): ShiftReport {
  const rows = shiftsInRange(input.shifts, input.range)
    .map((shift) => shiftReportRow(shift, input.summaryFor))
    .sort((a, b) => b.openedAt.localeCompare(a.openedAt));

  return { range: input.range, rows, totals: totalsOf(rows) };
}

// ── cash differences ───────────────────────────────────────────────────────
/**
 * The drawers that disagreed with themselves.
 *
 * Only counted shifts can disagree, so an open drawer is not in this list — and
 * a drawer that counted exactly right is not either, unless the caller asks for
 * the whole picture. Sorted by the size of the gap, biggest first, because that
 * is the order somebody investigates in.
 */
export function cashDifferenceRows(
  rows: readonly ShiftReportRow[],
  options: { onlyDiscrepancies?: boolean } = {},
): ShiftReportRow[] {
  const counted = rows.filter((row) => row.actualCash !== null && row.difference !== null);
  const { onlyDiscrepancies = true } = options;
  return counted
    .filter((row) => !onlyDiscrepancies || (row.difference ?? 0) !== 0)
    .sort((a, b) => Math.abs(b.difference ?? 0) - Math.abs(a.difference ?? 0));
}

export interface CashDifferenceSummary {
  counted: number;
  discrepancies: number;
  /** Percent of counted drawers that did not match — the rate worth watching. */
  discrepancyRate: number;
  exact: number;
  over: number;
  short: number;
  net: number;
  largestOver: ShiftReportRow | null;
  largestShort: ShiftReportRow | null;
  /** Discrepancies the closer wrote something about. An unexplained gap is the finding. */
  unexplained: number;
}

/** What the gaps add up to, and which two drawers to ask about first. */
export function cashDifferenceSummary(rows: readonly ShiftReportRow[]): CashDifferenceSummary {
  const counted = rows.filter((row) => row.difference !== null);
  const gaps = counted.filter((row) => (row.difference ?? 0) !== 0);
  const over = gaps.filter((row) => (row.difference ?? 0) > 0);
  const short = gaps.filter((row) => (row.difference ?? 0) < 0);
  const biggest = (list: readonly ShiftReportRow[]) =>
    list.reduce<ShiftReportRow | null>(
      (best, row) => (!best || Math.abs(row.difference ?? 0) > Math.abs(best.difference ?? 0) ? row : best),
      null,
    );

  return {
    counted: counted.length,
    discrepancies: gaps.length,
    discrepancyRate: counted.length > 0 ? roundMoney((gaps.length / counted.length) * 100) : 0,
    exact: counted.length - gaps.length,
    over: roundMoney(over.reduce((acc, row) => acc + (row.difference ?? 0), 0)),
    short: roundMoney(short.reduce((acc, row) => acc + (row.difference ?? 0), 0)),
    net: roundMoney(counted.reduce((acc, row) => acc + (row.difference ?? 0), 0)),
    largestOver: biggest(over),
    largestShort: biggest(short),
    unexplained: gaps.filter((row) => !(row.notes ?? "").trim()).length,
  };
}

// ── daily report ───────────────────────────────────────────────────────────
export interface DailyShiftRow {
  date: string;
  shifts: number;
  invoices: number;
  salesTotal: number;
  openingCash: number;
  expensesTotal: number;
  expectedCash: number;
  actualCash: number | null;
  difference: number | null;
}

/**
 * One line per working day.
 *
 * Expected and actual are summed over the drawers *counted* that day, and left
 * null when none were — a day whose shift is still open has no actual cash yet,
 * and printing 0 there would read as "the drawer was empty".
 */
export function dailyShiftReport(rows: readonly ShiftReportRow[]): DailyShiftRow[] {
  const days = new Map<string, DailyShiftRow & { counted: number }>();

  for (const row of rows) {
    const key = dayKeyOf(row.openedAt);
    if (!key) continue;
    const day =
      days.get(key) ??
      ({
        date: key,
        shifts: 0,
        invoices: 0,
        salesTotal: 0,
        openingCash: 0,
        expensesTotal: 0,
        expectedCash: 0,
        actualCash: null,
        difference: null,
        counted: 0,
      } satisfies DailyShiftRow & { counted: number });

    day.shifts += 1;
    day.invoices += row.invoices;
    day.salesTotal = roundMoney(day.salesTotal + row.salesTotal);
    day.openingCash = roundMoney(day.openingCash + row.openingCash);
    day.expensesTotal = roundMoney(day.expensesTotal + row.expensesTotal);
    if (row.actualCash !== null && row.difference !== null) {
      day.counted += 1;
      day.expectedCash = roundMoney(day.expectedCash + row.expectedCash);
      day.actualCash = roundMoney((day.actualCash ?? 0) + row.actualCash);
      day.difference = roundMoney((day.difference ?? 0) + row.difference);
    }
    days.set(key, day);
  }

  return [...days.values()]
    .sort((a, b) => b.date.localeCompare(a.date))
    .map(({ counted: _counted, ...day }) => day);
}

// ── employee performance ───────────────────────────────────────────────────
export interface EmployeeShiftRow {
  userId: string;
  userName: string;
  shifts: number;
  closed: number;
  invoices: number;
  salesTotal: number;
  avgInvoice: number;
  /** Percent of the window's sales taken by this person's drawers. */
  share: number;
  expensesTotal: number;
  expectedCash: number;
  actualCash: number | null;
  difference: number | null;
  discrepancies: number;
  exact: number;
}

/**
 * Who ran which drawer, and how it counted.
 *
 * Grouped on whoever *opened* the shift, because that is the person the drawer
 * was handed to; a different closer is recorded on the shift, not invented here.
 * Expected/actual/difference are summed over that person's counted drawers only
 * — an open shift contributes its sales but no cash verdict, and a null stays
 * null rather than becoming a zero that reads as "counted and correct".
 */
export function employeeShiftPerformance(rows: readonly ShiftReportRow[]): EmployeeShiftRow[] {
  const people = new Map<string, EmployeeShiftRow & { counted: number }>();
  const whole = roundMoney(rows.reduce((acc, row) => acc + row.salesTotal, 0));

  for (const row of rows) {
    const person =
      people.get(row.userId) ??
      ({
        userId: row.userId,
        userName: row.userName,
        shifts: 0,
        closed: 0,
        invoices: 0,
        salesTotal: 0,
        avgInvoice: 0,
        share: 0,
        expensesTotal: 0,
        expectedCash: 0,
        actualCash: null,
        difference: null,
        discrepancies: 0,
        exact: 0,
        counted: 0,
      } satisfies EmployeeShiftRow & { counted: number });

    person.shifts += 1;
    if (row.status === "closed") person.closed += 1;
    person.invoices += row.invoices;
    person.salesTotal = roundMoney(person.salesTotal + row.salesTotal);
    person.expensesTotal = roundMoney(person.expensesTotal + row.expensesTotal);
    if (row.actualCash !== null && row.difference !== null) {
      person.counted += 1;
      person.expectedCash = roundMoney(person.expectedCash + row.expectedCash);
      person.actualCash = roundMoney((person.actualCash ?? 0) + row.actualCash);
      person.difference = roundMoney((person.difference ?? 0) + row.difference);
      if (row.difference === 0) person.exact += 1;
      else person.discrepancies += 1;
    }
    people.set(row.userId, person);
  }

  return [...people.values()]
    .map(({ counted: _counted, ...person }) => ({
      ...person,
      avgInvoice: person.invoices > 0 ? roundMoney(person.salesTotal / person.invoices) : 0,
      share: whole > 0 ? roundMoney((person.salesTotal / whole) * 100) : 0,
    }))
    .sort((a, b) => b.salesTotal - a.salesTotal || b.shifts - a.shifts);
}
