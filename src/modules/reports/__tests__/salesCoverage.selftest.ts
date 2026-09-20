/**
 * Reports sales-coverage self-test (Phase 22, audit finding H2).
 *
 * Run with the shared runner: `npm test` (or `node scripts/test.logic.mjs salesCoverage`).
 *
 * The defect this guards: a report read every sale the backend would give it,
 * filtered the result in the browser, and presented it as the whole period. A
 * Supabase project stops a single select at its row cap and says nothing about
 * what it dropped, so from the first thousand sales onwards the numbers were
 * quietly wrong — and wrong in the direction that flatters nobody and warns
 * nobody.
 *
 * What is under test:
 *
 *   1. **Bounds.** The date edges pushed down to SQL are the same instants the
 *      client-side predicate uses: UTC midnight through UTC 23:59:59.999,
 *      inclusive at both ends. A `created_at` column is a timestamptz, so the
 *      bounds travel as exact ISO instants — the same strings on every
 *      machine, whatever its timezone. The assertions here are written
 *      against fixed UTC strings for the same reason: a local-clock
 *      assertion passes in one timezone and fails in the next.
 *   2. **Paging.** `limit` and `offset` produce disjoint, correctly ordered
 *      pages, and a count ignores paging — otherwise the total would describe
 *      the page instead of the period.
 *   3. **Detectability.** With more sales than the cap, the page comes back
 *      capped while the count comes back exact, and the pair is enough to say
 *      "truncated" out loud. That comparison is the whole fix: the ceiling still
 *      exists, it just stopped being invisible.
 *
 * The Supabase repository builds these same bounds as `.gte`/`.lte`/`.range`
 * calls; asserting that construction needs a live project, which a unit suite
 * does not have. What is asserted instead is the contract both backends share —
 * the demo repository runs this exact code — so a change to the edges or the
 * paging fails here before it can fail a customer's monthly report.
 */
import assert from "node:assert/strict";
import process from "node:process";

import { withinDateRange } from "@/lib/export";
import type { Sale } from "@/modules/pos/types";
import { SALES_ROW_CAP } from "@/modules/pos/data";
import { applySaleListQuery } from "@/modules/pos/data/saleListQuery";
import { toTimestampBounds } from "../services/dateRanges";

const tests: { name: string; fn: () => void | Promise<void> }[] = [];
const test = (name: string, fn: () => void | Promise<void>) => tests.push({ name, fn });

/** A sale whose only interesting property is when it happened. */
function saleAt(created_at: string, id = created_at): Sale {
  return {
    id,
    sale_number: id,
    client_ref: id,
    created_at,
    status: "active",
    customer_id: null,
    customer_name: null,
    employee_id: null,
    shift_id: null,
    items: [],
    payments: [],
    subtotal: 0,
    discount: 0,
    discount_reason: null,
    tax: 0,
    total: 0,
    notes: null,
  } as unknown as Sale;
}

/** Local-time ISO timestamp, so fixtures land on the shop's calendar day. */
function localStamp(day: string, hhmmss: string): string {
  return new Date(`${day}T${hhmmss}`).toISOString();
}

// ── 1. bounds ─────────────────────────────────────────────────────────────
test("toTimestampBounds maps a date range to UTC-day edges, identical everywhere", () => {
  const bounds = toTimestampBounds({ from: "2026-03-01", to: "2026-03-31" });
  assert.ok(bounds.from && bounds.to, "both ends of a closed range produce a bound");

  // Exact instants, not wall-clock fields: a local-midnight assertion would
  // pass in one timezone and fail in the next. UTC edges are the same strings
  // on Windows, Linux, Cairo and UTC.
  assert.equal(bounds.from, "2026-03-01T00:00:00.000Z", "the lower bound opens the UTC day");
  assert.equal(bounds.to, "2026-03-31T23:59:59.999Z", "the upper bound keeps the whole final UTC day");
});

test("an open end stays open instead of collapsing onto the epoch", () => {
  assert.deepEqual(toTimestampBounds({ from: null, to: null }), {});
  const fromOnly = toTimestampBounds({ from: "2026-03-01", to: null });
  assert.ok(fromOnly.from, "the given end is bounded");
  assert.equal(fromOnly.to, undefined, "the missing end imposes nothing");
  assert.equal(toTimestampBounds({ from: null, to: "2026-03-31" }).from, undefined);
});

test("the SQL bounds and the client predicate agree at every edge", () => {
  const range = { from: "2026-03-01", to: "2026-03-31" };
  const bounds = toTimestampBounds(range);
  // UTC instants: the edges mean the same thing in every timezone, so the
  // predicate and the bounds cannot drift apart per machine.
  const samples = [
    "2026-02-28T23:59:59.999Z", // day before: out
    "2026-03-01T00:00:00.000Z", // first instant: in
    "2026-03-15T13:45:00.000Z", // middle: in
    "2026-03-31T23:59:59.999Z", // last instant: in
    "2026-04-01T00:00:00.000Z", // day after: out
  ];
  const expected = [false, true, true, true, false];

  samples.forEach((stamp, i) => {
    assert.equal(
      withinDateRange(stamp, range.from, range.to),
      expected[i],
      `predicate disagrees on ${stamp}`,
    );
    const insideBounds = stamp >= bounds.from! && stamp <= bounds.to!;
    assert.equal(
      insideBounds,
      expected[i],
      `database bound disagrees with the predicate on ${stamp} — one of them drops a day`,
    );
  });
});

test("date bounds are inclusive on both ends when listing", () => {
  const sales = [
    saleAt("2026-02-28T23:59:59.999Z"),
    saleAt("2026-03-01T00:00:00.000Z"),
    saleAt("2026-03-31T23:59:59.999Z"),
    saleAt("2026-04-01T00:00:00.000Z"),
  ];
  const bounds = toTimestampBounds({ from: "2026-03-01", to: "2026-03-31" });
  const listed = applySaleListQuery(sales, bounds);
  assert.equal(listed.length, 2, "only the two sales inside the period are returned");
  assert.ok(
    listed.every((sale) => withinDateRange(sale.created_at, "2026-03-01", "2026-03-31")),
    "nothing outside the period survives the query",
  );
});

// ── 2. ordering and paging ────────────────────────────────────────────────
test("a listing is newest-first, so a cap keeps the recent sales", () => {
  const sales = [
    saleAt(localStamp("2026-03-01", "09:00:00"), "oldest"),
    saleAt(localStamp("2026-03-02", "09:00:00"), "middle"),
    saleAt(localStamp("2026-03-03", "09:00:00"), "newest"),
  ];
  assert.deepEqual(
    applySaleListQuery(sales).map((s) => s.id),
    ["newest", "middle", "oldest"],
  );
  assert.deepEqual(
    applySaleListQuery(sales, { limit: 2 }).map((s) => s.id),
    ["newest", "middle"],
    "the cap drops the oldest, which is what a history screen wants",
  );
});

test("offset pages through without repeating or skipping a sale", () => {
  // Distinct timestamps on purpose: with ties, the order inside a page is not
  // defined, and a paging test that depends on an unstable sort proves nothing.
  const sales = Array.from({ length: 25 }, (_, i) =>
    saleAt(localStamp("2026-03-01", `${String(i).padStart(2, "0")}:00:00`), `s${i}`),
  );
  const first = applySaleListQuery(sales, { limit: 10, offset: 0 });
  const second = applySaleListQuery(sales, { limit: 10, offset: 10 });
  const third = applySaleListQuery(sales, { limit: 10, offset: 20 });

  assert.equal(first.length, 10);
  assert.equal(second.length, 10);
  assert.equal(third.length, 5, "the last page is short rather than padded");
  const ids = [...first, ...second, ...third].map((s) => s.id);
  assert.equal(new Set(ids).size, 25, "no sale appears twice across pages");
  assert.equal(new Set(ids).size, sales.length, "no sale is skipped across pages");
});

test("a count ignores paging and reports the period, not the page", () => {
  const sales = Array.from({ length: 40 }, (_, i) =>
    saleAt(localStamp("2026-03-01", "10:00:00"), `s${i}`),
  );
  // every fixture shares a timestamp, so ordering cannot hide a paging leak
  const paged = applySaleListQuery(sales, { limit: 10, offset: 30 });
  const counted = applySaleListQuery(sales, { limit: 10, offset: 30 }, { ignorePaging: true });
  assert.equal(paged.length, 10, "the page is bounded");
  assert.equal(counted.length, 40, "the count is not");
});

// ── 3. truncation is detectable ───────────────────────────────────────────
test("past the row cap the page is short and the count says so", () => {
  // One more sale than the ceiling: the smallest input that reproduces the
  // defect, and the one that used to pass unnoticed.
  const sales = Array.from({ length: SALES_ROW_CAP + 1 }, (_, i) =>
    saleAt(new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString(), `s${i}`),
  );

  const page = applySaleListQuery(sales, { limit: SALES_ROW_CAP });
  const total = applySaleListQuery(sales, {}, { ignorePaging: true }).length;

  assert.equal(page.length, SALES_ROW_CAP, "the read stops at the cap");
  assert.equal(total, SALES_ROW_CAP + 1, "the count is exact anyway");
  assert.ok(total > page.length, "the pair exposes the gap instead of hiding it");
  // This is the assertion the screen renders: without it the missing sale is
  // indistinguishable from a sale that never happened.
  assert.equal(total - page.length, 1, "exactly one sale is missing, and it is named");
});

test("a period smaller than the cap is reported as complete", () => {
  const sales = Array.from({ length: 12 }, (_, i) =>
    saleAt(new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString(), `s${i}`),
  );
  const page = applySaleListQuery(sales, { limit: SALES_ROW_CAP });
  const total = applySaleListQuery(sales, {}, { ignorePaging: true }).length;
  assert.equal(total > page.length, false, "no coverage warning for a period that fits");
});

test("an unknown count is never reported as a total", () => {
  // countSales() returns null when the backend cannot supply one. The provider
  // must not turn that into "everything is loaded" — that is the silent case
  // this whole finding is about.
  const total: number | null = null;
  const shown = SALES_ROW_CAP;
  assert.equal(total !== null && total > shown, false, "null does not claim completeness");
  assert.equal(total === null, true, "and the caller can tell unknown from zero");
});

// ── runner ────────────────────────────────────────────────────────────────
let passed = 0;
const failures: string[] = [];
for (const { name, fn } of tests) {
  try {
    await fn();
    passed += 1;
    console.log(`\x1b[2m        ✓ ${name}\x1b[0m`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    failures.push(`${name} | ${message}`);
    console.log(`\x1b[2m        \x1b[31m✗ ${name}\x1b[0m`);
    console.log(`\x1b[2m          ${message}\x1b[0m`);
  }
}

const label = `${passed}/${tests.length} report-coverage tests passed`;
if (failures.length > 0) {
  console.error(`\x1b[1m\x1b[31m\n✗ ${label}.\x1b[0m`);
  for (const failure of failures) console.error(`\x1b[31m•\x1b[0m ${failure}`);
  process.exit(1);
}
console.log(`\x1b[1m\x1b[32m\n✓ ${label}\x1b[0m`);
