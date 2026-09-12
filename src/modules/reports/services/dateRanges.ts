/**
 * Date windows — the one place a span of days is turned into a range.
 *
 * These helpers used to live inside `DateRangePicker.tsx`, which was fine while
 * only the reports screen needed them. The dashboard (Phase 14) reads the same
 * windows — "this month so far", "the last fourteen days" — and a pure query
 * module must not import a React component to get them: that drags the whole UI
 * graph (and its asset imports) into every headless test that touches the query
 * layer. So the date maths lives here, the picker renders it, and both screens
 * agree on what "this month" means because there is only one definition.
 *
 * Values are `yyyy-mm-dd` strings — what `<input type="date">` speaks — and an
 * empty string / `null` means "unbounded on that side".
 */
import type { DateRange } from "./financialExport";

export interface DateRangeValue {
  from: string;
  to: string;
}

export const EMPTY_DATE_RANGE: DateRangeValue = { from: "", to: "" };

/** Picker value → the inclusive range the builders accept. */
export function toExportRange(value: DateRangeValue): DateRange {
  return { from: value.from || null, to: value.to || null };
}

const pad = (n: number) => String(n).padStart(2, "0");

/** Local-time `yyyy-mm-dd`, so "today" means the shop's today, not UTC's. */
export function isoDate(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export type RangePreset = "allTime" | "today" | "thisMonth" | "last30";

/** The calendar span a preset covers, in local time. */
export function presetRange(preset: RangePreset, now: Date = new Date()): DateRangeValue {
  switch (preset) {
    case "today":
      return { from: isoDate(now), to: isoDate(now) };
    case "thisMonth":
      return { from: isoDate(new Date(now.getFullYear(), now.getMonth(), 1)), to: isoDate(now) };
    case "last30": {
      const from = new Date(now);
      from.setDate(from.getDate() - 29); // 30 days inclusive of today
      return { from: isoDate(from), to: isoDate(now) };
    }
    case "allTime":
    default:
      return EMPTY_DATE_RANGE;
  }
}

/**
 * The last `days` calendar days, today included, as an inclusive export range.
 *
 * Written with local-time date arithmetic rather than `now − days × 86400000` so
 * a window that crosses a month or a daylight-saving change still lands on whole
 * days. `presetRange("last30")` is this with `days = 30`; kept separate because
 * charts want a configurable span (14 days on the dashboard) and the preset
 * vocabulary is what the picker's buttons offer.
 */
export function lastDaysRange(
  now: Date = new Date(),
  days = 30,
): DateRange {
  const span = Math.max(1, Math.floor(days));
  const from = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (span - 1));
  return { from: isoDate(from), to: isoDate(now) };
}

/** The calendar month to date, as an inclusive export range. */
export function monthToDateRange(now: Date = new Date()): DateRange {
  return toExportRange(presetRange("thisMonth", now));
}
