/**
 * Calendar-day contract — the regression guard for the timezone day-shift bugs.
 *
 * History: range filtering (`withinDateRange`), day bucketing (`dayKeyOf`) and
 * SQL bounds (`toTimestampBounds`) used to build their day edges with
 * `new Date("2026-03-10T00:00:00")`, which parses as *local* midnight. The same
 * range then matched different rows on machines in different timezones (an
 * evening UTC instant is already the next local day in Cairo), and three
 * suites failed outside UTC. The contract since is: a `yyyy-mm-dd` day is a
 * UTC day, everywhere.
 *
 * These tests pin the helpers themselves with exact UTC instants, so they hold
 * on Windows, Linux, Cairo and UTC alike. Behavioural coverage (inclusive
 * ranges, quiet-day fills) lives in the export and reports suites.
 *
 * Run with the shared runner: `npm test` (or `node scripts/test.logic.mjs calendarDays`).
 */
import assert from "node:assert/strict";

import {
  addUtcDays,
  dayEndUtcMs,
  dayRangeToTimestampBounds,
  dayStartUtcMs,
  isCalendarDay,
  parseCalendarDay,
  utcDayKeyOfIso,
  utcDayKeyOfMs,
} from "../calendarDays";

type TestCase = { name: string; fn: () => void };
const tests: TestCase[] = [];
const test = (name: string, fn: () => void) => tests.push({ name, fn });

// ── parsing ────────────────────────────────────────────────────────────────
test("parseCalendarDay accepts real days and rejects everything else", () => {
  assert.deepEqual(parseCalendarDay("2026-03-10"), { year: 2026, month: 3, day: 10 });
  for (const bad of [
    null,
    undefined,
    "",
    "2026-3-10",
    "2026-03-1",
    "10-03-2026",
    "2026/03/10",
    "2026-13-01",
    "2026-00-10",
    "2026-02-30",
    "2026-04-31",
    "2023-02-29",
    "not-a-date",
    "2026-03-10T00:00:00",
  ]) {
    assert.equal(parseCalendarDay(bad), null, `${JSON.stringify(bad)} must not parse as a day`);
  }
  // Leap day is real when the year is a leap year.
  assert.deepEqual(parseCalendarDay("2024-02-29"), { year: 2024, month: 2, day: 29 });
  assert.equal(isCalendarDay("2026-03-10"), true);
  assert.equal(isCalendarDay("2026-02-30"), false);
});

// ── edges ──────────────────────────────────────────────────────────────────
test("day edges are the exact UTC instants, not wall-clock fields", () => {
  assert.equal(new Date(dayStartUtcMs("2026-03-10")!).toISOString(), "2026-03-10T00:00:00.000Z");
  assert.equal(new Date(dayEndUtcMs("2026-03-10")!).toISOString(), "2026-03-10T23:59:59.999Z");
  assert.equal(dayStartUtcMs("2026-02-30"), null, "an impossible day has no edge");
  assert.equal(dayEndUtcMs(null), null, "a missing bound stays missing, never the epoch");
});

// ── bucketing ──────────────────────────────────────────────────────────────
test("utcDayKeyOfIso buckets by the UTC day in every timezone", () => {
  assert.equal(utcDayKeyOfIso("2026-03-10T22:00:00.000Z"), "2026-03-10");
  assert.equal(utcDayKeyOfIso("2026-03-04T23:30:00.000Z"), "2026-03-04");
  assert.equal(utcDayKeyOfIso("2026-03-01T00:00:00.000Z"), "2026-03-01");
  assert.equal(utcDayKeyOfIso("not-a-date"), "");
  assert.equal(utcDayKeyOfIso(null), "");
  assert.equal(utcDayKeyOfMs(Date.UTC(2026, 2, 10, 22, 0, 0)), "2026-03-10");
});

// ── arithmetic ─────────────────────────────────────────────────────────────
test("addUtcDays steps whole UTC days across months and DST changes", () => {
  assert.equal(addUtcDays("2026-03-01", 4), "2026-03-05");
  assert.equal(addUtcDays("2026-01-31", 1), "2026-02-01", "month boundary");
  assert.equal(addUtcDays("2026-03-05", -4), "2026-03-01", "backwards");
  // Cairo springs forward inside this window (last Friday of April): a naive
  // local-midnight + 24h step would land off-midnight; UTC arithmetic cannot.
  assert.equal(addUtcDays("2026-04-23", 2), "2026-04-25");
  assert.equal(addUtcDays("2026-02-30", 1), null);
  assert.equal(addUtcDays("2026-03-01", 1.5), null, "fractional offsets are refused");
});

// ── bounds ─────────────────────────────────────────────────────────────────
test("dayRangeToTimestampBounds is deterministic and keeps open ends open", () => {
  assert.deepEqual(dayRangeToTimestampBounds({ from: "2026-03-01", to: "2026-03-31" }), {
    from: "2026-03-01T00:00:00.000Z",
    to: "2026-03-31T23:59:59.999Z",
  });
  assert.deepEqual(dayRangeToTimestampBounds({ from: null, to: null }), {});
  assert.deepEqual(dayRangeToTimestampBounds({ from: "2026-03-01", to: null }), {
    from: "2026-03-01T00:00:00.000Z",
  });
  assert.deepEqual(dayRangeToTimestampBounds({ from: "garbage", to: "2026-03-31" }), {
    to: "2026-03-31T23:59:59.999Z",
  });
});

// ── run ────────────────────────────────────────────────────────────────────
let failed = 0;
for (const { name, fn } of tests) {
  try {
    await fn();
    console.log(`  ok    ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL  ${name}`);
    console.log(`        ${err instanceof Error ? err.message : String(err)}`);
  }
}

if (failed > 0) {
  console.log(`\n✗ ${failed}/${tests.length} calendar-day tests failed`);
  process.exit(1);
}
console.log(`\nAll ${tests.length} calendar-day tests passed`);
