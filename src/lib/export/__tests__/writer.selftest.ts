/**
 * Excel writer self-test (headless, Node).
 *
 * Companion to `logic.selftest.ts`: that suite covers the pure builders — what
 * goes *into* a sheet. This one covers `downloadWorkbook`, the effectful half
 * that serialises the file and hands it to the browser.
 *
 * It exists because two silent defects lived in the writer and no builder test
 * could see either:
 *
 *   1. the totals row was styled but never written into the sheet data, so it
 *      was missing from every export;
 *   2. the footnotes were poked into cells past the sheet's declared `!ref`,
 *      and `XLSX.write` drops everything outside that range — so the notes that
 *      explain the derived columns never reached the file at all.
 *
 * Both look fine in a `BuiltSheet` and are obvious to a reader, so this suite
 * downloads a workbook, reads the bytes back with `xlsx` and asserts what a
 * spreadsheet program would actually see: rows, formats, ranges, tab names.
 *
 * Two harness notes:
 *   - `xlsx` is CommonJS and needs a real `require` — see `testBanner()` in
 *     `scripts/lib/app-bundle.mjs`. Without it the library throws on first use.
 *   - the DOM stub below is the *entire* browser surface `triggerDownload`
 *     touches: one anchor, one Blob, one object URL.
 */
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";

import * as XLSX from "xlsx";

import {
  buildSheets,
  downloadWorkbook,
  moneyFormat,
  toDate,
  type BuiltSheet,
  type ExportSheet,
} from "../excelExport";

// ── minimal DOM: only what triggerDownload uses ─────────────────────────────
interface Downloaded {
  filename: string;
  rel: string;
  blob: Blob;
  removedFromPage: boolean;
}

const downloads: Downloaded[] = [];
let pendingBlob: Blob | null = null;
let appended = 0;

const realCreateObjectURL = URL.createObjectURL.bind(URL);
const urlStatics = URL as unknown as {
  createObjectURL: (blob: Blob) => string;
  revokeObjectURL: (url: string) => void;
};
urlStatics.createObjectURL = (blob: Blob) => {
  pendingBlob = blob;
  return realCreateObjectURL(blob);
};
urlStatics.revokeObjectURL = () => {};

const anchor = {
  href: "",
  download: "",
  rel: "",
  click() {
    assert.ok(pendingBlob, "the anchor is clicked with a Blob behind its object URL");
    downloads.push({
      filename: this.download,
      rel: this.rel,
      blob: pendingBlob,
      removedFromPage: false,
    });
  },
};

const globals = globalThis as { document?: unknown };
globals.document = {
  createElement: () => anchor,
  body: {
    appendChild: () => {
      appended += 1;
    },
    removeChild: () => {
      const last = downloads[downloads.length - 1];
      if (last) last.removedFromPage = true;
    },
  },
};

// ── fixture ─────────────────────────────────────────────────────────────────
interface Row {
  item: string;
  when: string | null;
  price: number;
  qty: number;
  share: number;
}

const ROWS: readonly Row[] = [
  { item: "Classic Gold Ring", when: "2026-09-11T09:30:00.000Z", price: 68.5, qty: 2, share: 12.345 },
  { item: "Cold Brew", when: null, price: 0, qty: 1, share: 0 },
];

/** Every cell kind the writer formats, plus totals and footnotes. */
function fixtureSheet(name = "Sales: 2026", rows: readonly Row[] = ROWS): ExportSheet<Row> {
  return {
    name, // the colon is illegal in a tab name — sanitisation is asserted below
    rows,
    columns: [
      { header: "Item", value: (r) => r.item, width: 24 },
      { header: "When", value: (r) => toDate(r.when), kind: "datetime" },
      { header: "Price", value: (r) => r.price, kind: "money" },
      { header: "Qty", value: (r) => r.qty, kind: "number" },
      { header: "Share", value: (r) => r.share, kind: "percent" },
    ],
    totals: ["Total", "", 68.5, 3, null],
    notes: ["Totals exclude voided invoices.", "Balance is the unpaid part of pending invoices."],
  };
}

interface Written {
  filename: string;
  bytes: Buffer;
  blobType: string;
  rel: string;
  removedFromPage: boolean;
  wb: XLSX.WorkBook;
  result: Awaited<ReturnType<typeof downloadWorkbook>>;
}

async function write(sheets: BuiltSheet[], document?: {
  name?: string;
  currency?: string;
  lang?: "en" | "ar";
}): Promise<Written> {
  const before = downloads.length;
  const result = await downloadWorkbook({
    name: document?.name ?? "unit-test",
    sheets,
    ...(document?.currency ? { currency: document.currency } : {}),
    ...(document?.lang ? { lang: document.lang } : {}),
  });
  assert.equal(downloads.length, before + 1, "exactly one file was handed to the browser");

  const file = downloads[downloads.length - 1];
  const bytes = Buffer.from(await file.blob.arrayBuffer());
  const wb = XLSX.read(bytes, { type: "buffer", cellDates: true, cellNF: true, cellStyles: true });
  return {
    filename: file.filename,
    bytes,
    blobType: file.blob.type,
    rel: file.rel,
    removedFromPage: file.removedFromPage,
    wb,
    result,
  };
}

/** The sheet as a plain grid — what Excel shows, blank cells included. */
function grid(wb: XLSX.WorkBook, name: string): unknown[][] {
  return XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[name], { header: 1, raw: true, defval: "" });
}

/** Last 1-based row the sheet declares; cells outside it are never written. */
function declaredLastRow(ws: XLSX.WorkSheet): number {
  const ref = ws["!ref"];
  assert.ok(ref, "the sheet declares a range");
  return Number.parseInt(ref.split(":")[1].replace(/[A-Za-z]/g, ""), 10);
}

function cell(wb: XLSX.WorkBook, sheet: string, ref: string): XLSX.CellObject {
  const found = wb.Sheets[sheet][ref];
  assert.ok(found, `cell ${sheet}!${ref} exists`);
  return found;
}

const rtlOf = (wb: XLSX.WorkBook): boolean | undefined =>
  (wb as unknown as { Workbook?: { Views?: { RTL?: boolean }[] } }).Workbook?.Views?.[0]?.RTL;

// ── tests ───────────────────────────────────────────────────────────────────
const tests: { name: string; fn: () => void | Promise<void> }[] = [
  {
    name: "hands the browser a real .xlsx download and cleans up after itself",
    async fn() {
      const { filename, blobType, rel, removedFromPage, bytes, result } = await write(
        buildSheets([fixtureSheet()]),
      );
      assert.match(filename, /^alyq-unit-test-\d{4}-\d{2}-\d{2}-\d{4}\.xlsx$/);
      assert.equal(
        blobType,
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "the Blob is typed as a spreadsheet",
      );
      assert.equal(rel, "noopener");
      assert.ok(bytes.byteLength > 4000, `the file has content (${bytes.byteLength} bytes)`);
      assert.equal(appended, downloads.length, "every anchor was appended");
      assert.ok(removedFromPage, "the anchor was removed again");
      assert.equal(result.totalRows, ROWS.length, "row counts exclude the totals row and footnotes");
    },
  },
  {
    name: "sanitises tab names Excel would reject",
    async fn() {
      const { wb } = await write(buildSheets([fixtureSheet("Sales: 2026")]));
      assert.deepEqual(wb.SheetNames, ["Sales 2026"]);
    },
  },
  {
    name: "writes the totals row into the sheet (regression: it used to be styled only)",
    async fn() {
      const { wb } = await write(buildSheets([fixtureSheet()]));
      const rows = grid(wb, "Sales 2026");
      // header + 2 data rows + totals
      assert.equal(rows.length >= 4, true, "the totals row survives the round trip");
      assert.deepEqual(rows[3].slice(0, 4), ["Total", "", 68.5, 3]);
      assert.ok(declaredLastRow(wb.Sheets["Sales 2026"]) >= 4, "the totals row is inside !ref");
    },
  },
  {
    name: "keeps the footnotes inside the sheet range (regression: they were dropped)",
    async fn() {
      const { wb } = await write(buildSheets([fixtureSheet()]));
      const rows = grid(wb, "Sales 2026");
      const text = rows.map((row) => String(row[0] ?? "")).join("\n");
      assert.ok(text.includes("Totals exclude voided invoices."), "the first footnote is in the file");
      assert.ok(text.includes("Balance is the unpaid part"), "the second footnote is in the file");
      // blank separator, then the notes — so they never mix into the data
      assert.deepEqual(rows[4], ["", "", "", "", ""], "a blank row separates data from footnotes");
      assert.equal(rows[5][0], "Totals exclude voided invoices.");
      assert.equal(rows[6][0], "Balance is the unpaid part of pending invoices.");
      assert.ok(declaredLastRow(wb.Sheets["Sales 2026"]) >= 7, "the footnotes are inside !ref");
    },
  },
  {
    name: "leaves the autofilter over the header and data only",
    async fn() {
      const { wb } = await write(buildSheets([fixtureSheet()]));
      assert.equal(wb.Sheets["Sales 2026"]["!autofilter"]?.ref, "A1:E3");
    },
  },
  {
    name: "keeps money numeric and formats it in EGP",
    async fn() {
      const { wb } = await write(buildSheets([fixtureSheet()]));
      const price = cell(wb, "Sales 2026", "C2");
      assert.equal(price.t, "n", "money stays a number so Excel can sum it");
      assert.equal(price.v, 68.5);
      assert.equal(price.z, moneyFormat(), "the EGP format is applied");
      assert.equal(price.z, '#,##0.00 "EGP"');
      assert.equal(cell(wb, "Sales 2026", "C4").z, moneyFormat(), "the totals money cell is formatted too");
    },
  },
  {
    name: "honours a currency override",
    async fn() {
      const { wb } = await write(buildSheets([fixtureSheet()]), { currency: "USD" });
      assert.equal(cell(wb, "Sales 2026", "C2").z, '#,##0.00 "USD"');
    },
  },
  {
    name: "writes real Excel dates and leaves a missing one blank",
    async fn() {
      const { wb } = await write(buildSheets([fixtureSheet()]));
      const when = cell(wb, "Sales 2026", "B2");
      assert.ok(when.v instanceof Date, "the date cell holds a Date, not text");
      assert.equal(when.z, "yyyy-mm-dd hh:mm");
      assert.equal(grid(wb, "Sales 2026")[2][1], "", "a null date becomes an empty cell");
    },
  },
  {
    name: "rounds percentages to match their format",
    async fn() {
      const { wb } = await write(buildSheets([fixtureSheet()]));
      const share = cell(wb, "Sales 2026", "E2");
      assert.equal(share.v, 12.3, "12.345 is stored to one decimal");
      assert.equal(share.z, '0.0"%"');
    },
  },
  {
    name: "writes the column widths",
    async fn() {
      const { wb } = await write(buildSheets([fixtureSheet()]));
      assert.equal(wb.Sheets["Sales 2026"]["!cols"]?.[0].wch, 24);
    },
  },
  {
    name: "flips the workbook to right-to-left for Arabic only",
    async fn() {
      const arabic = await write(buildSheets([fixtureSheet()]), { lang: "ar" });
      assert.equal(rtlOf(arabic.wb), true, "an Arabic export opens in RTL view");
      const english = await write(buildSheets([fixtureSheet()]), { lang: "en" });
      assert.notEqual(rtlOf(english.wb), true, "an English export stays LTR");
    },
  },
  {
    name: "de-duplicates tab names in the written file",
    async fn() {
      const { wb } = await write(buildSheets([fixtureSheet("Sales"), fixtureSheet("sales")]));
      assert.deepEqual(wb.SheetNames, ["Sales", "sales (2)"]);
    },
  },
  {
    name: "writes every sheet of a multi-sheet workbook with its own totals",
    async fn() {
      const { wb, result } = await write(
        buildSheets([fixtureSheet("Invoices"), fixtureSheet("Items", ROWS.slice(0, 1))]),
      );
      assert.deepEqual(wb.SheetNames, ["Invoices", "Items"]);
      assert.deepEqual(result.sheets, [
        { name: "Invoices", rows: 2 },
        { name: "Items", rows: 1 },
      ]);
      assert.equal(grid(wb, "Items")[2][0], "Total", "the second sheet keeps its own totals row");
    },
  },
  {
    name: "a sheet with no rows still writes its header and no autofilter",
    async fn() {
      const { wb, result } = await write(buildSheets([fixtureSheet("Empty", [])]));
      const rows = grid(wb, "Empty");
      assert.deepEqual(rows[0], ["Item", "When", "Price", "Qty", "Share"], "the header is written");
      assert.equal(wb.Sheets["Empty"]["!autofilter"], undefined, "nothing to filter");
      assert.equal(result.totalRows, 0, "an empty sheet reports zero rows");
      assert.equal(rows.some((row) => String(row[0] ?? "").startsWith("Totals exclude")), true,
        "the caveat still explains the empty result");
    },
  },
];

async function run() {
  let passed = 0;
  let failed = 0;
  for (const { name, fn } of tests) {
    try {
      await fn();
      passed++;
      console.log(`  ✓ ${name}`);
    } catch (err) {
      failed++;
      console.error(`  ✗ ${name}`);
      console.error(`    ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  console.log(`\n${passed}/${passed + failed} Excel writer tests passed`);
  if (failed > 0) process.exit(1);
}

run();
