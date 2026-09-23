/**
 * Calendar-day helpers — the one definition of what a `yyyy-mm-dd` day means.
 *
 * The contract, decided once so every caller agrees:
 *
 *   · A day string is a **UTC calendar day**. `2026-03-10` is the instant range
 *     `2026-03-10T00:00:00.000Z` through `2026-03-10T23:59:59.999Z`, on every
 *     machine — Windows or Linux, Cairo or UTC.
 *   · Filtering (`withinDateRange`), bucketing (`dayKeyOf`) and SQL bounds
 *     (`toTimestampBounds`) all read these edges, so a report, a trend chart
 *     and a database query can never disagree about which day a timestamp
 *     belongs to.
 *
 * Why UTC and not the operator's wall clock: the old code built its edges with
 * `new Date("2026-03-10T00:00:00")`, which parses as *local* midnight. An
 * evening UTC instant (`2026-03-10T22:00:00Z`) is already the next local day in
 * Cairo, so the same range included a different set of rows depending on the
 * machine's timezone — the shop's "today" silently moved with the laptop. UTC
 * edges are identical everywhere; the trade-off (a sale in the small hours of
 * local time attributes to the previous UTC day) is uniform and documented,
 * instead of varying per device.
 *
 * Day strings are validated strictly (`YYYY-MM-DD` with real month/day ranges):
 * an invalid bound is treated as absent by the callers, exactly as a `NaN`
 * edge was before — never as the epoch, never as an exception.
 */

const DAY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

export interface CalendarDayParts {
  year: number;
  month: number;
  day: number;
}

/** Strict `yyyy-mm-dd` parse. Returns `null` for anything that is not a real day. */
export function parseCalendarDay(day: string | null | undefined): CalendarDayParts | null {
  if (typeof day !== "string") return null;
  const match = DAY_PATTERN.exec(day.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const dayOfMonth = Number(match[3]);
  if (month < 1 || month > 12 || dayOfMonth < 1 || dayOfMonth > 31) return null;
  // The Date.UTC round-trip rejects impossible dates (30 February, 31 April…).
  const probe = new Date(Date.UTC(year, month - 1, dayOfMonth));
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== dayOfMonth
  ) {
    return null;
  }
  return { year, month, day: dayOfMonth };
}

/** True for a real `yyyy-mm-dd` day, false for anything else. */
export function isCalendarDay(day: string | null | undefined): boolean {
  return parseCalendarDay(day) !== null;
}

const pad = (n: number): string => String(n).padStart(2, "0");

/** First millisecond of a UTC day, or `null` for an invalid day string. */
export function dayStartUtcMs(day: string | null | undefined): number | null {
  const parts = parseCalendarDay(day);
  if (!parts) return null;
  return Date.UTC(parts.year, parts.month - 1, parts.day, 0, 0, 0, 0);
}

/** Last millisecond of a UTC day (`23:59:59.999Z`), or `null` for an invalid day. */
export function dayEndUtcMs(day: string | null | undefined): number | null {
  const parts = parseCalendarDay(day);
  if (!parts) return null;
  return Date.UTC(parts.year, parts.month - 1, parts.day, 23, 59, 59, 999);
}

/** `yyyy-mm-dd` key of an epoch millisecond, in UTC. */
export function utcDayKeyOfMs(time: number): string {
  const date = new Date(time);
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

/**
 * `yyyy-mm-dd` key of an ISO timestamp, in UTC — the bucket a timestamp falls
 * in for trends and day roll-ups. Returns `""` for an unparseable value.
 */
export function utcDayKeyOfIso(iso: string | null | undefined): string {
  if (!iso) return "";
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return "";
  return utcDayKeyOfMs(time);
}

/**
 * Add whole UTC days to a day string (`addUtcDays("2026-03-01", 4)` →
 * `"2026-03-05"`). Month, year and DST transitions are handled by UTC
 * arithmetic, which has no daylight-saving shifts. Returns `null` for an
 * invalid day or a non-integer offset.
 */
export function addUtcDays(day: string | null | undefined, offset: number): string | null {
  const start = dayStartUtcMs(day);
  if (start === null || !Number.isInteger(offset)) return null;
  return utcDayKeyOfMs(start + offset * 86_400_000);
}

/**
 * Inclusive UTC bounds for a `{ from, to }` day range, as ISO instants.
 *
 * An invalid or missing end stays absent rather than becoming the epoch; an
 * inverted range (`to` before `from`) is returned as-is and the callers treat
 * it as matching nothing, exactly like the local-edge version did.
 */
export function dayRangeToTimestampBounds(range: {
  from: string | null;
  to: string | null;
}): { from?: string; to?: string } {
  const bounds: { from?: string; to?: string } = {};
  const start = dayStartUtcMs(range.from);
  if (start !== null) bounds.from = new Date(start).toISOString();
  const end = dayEndUtcMs(range.to);
  if (end !== null) bounds.to = new Date(end).toISOString();
  return bounds;
}
