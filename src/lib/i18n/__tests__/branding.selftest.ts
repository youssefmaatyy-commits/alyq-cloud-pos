/**
 * Brand wordmark invariants.
 * Run with:
 *   npx esbuild src/lib/i18n/__tests__/branding.selftest.ts \
 *     --bundle --format=esm --platform=node --outfile=/tmp/alyq-brand.mjs && node /tmp/alyq-brand.mjs
 *
 * The official name is `ALYQ` in Latin script and أَلِــيْـــق in Arabic. Three
 * wrong Arabic spellings reached the tree before this suite existed — one with
 * the wrong initial letter entirely, one a transliteration ending in kaf, and
 * one with the right letters but none of the wordmark's marks — and each was
 * invisible in review, because they are read as the same word at a glance.
 *
 * So the strings here are built from codepoints rather than typed. That is not
 * decoration: written as literal Arabic the difference between the official
 * wordmark and the near-miss is five combining and elongation marks that no
 * reviewer will spot, and a grep for a forbidden spelling would match the very
 * file that forbids it. Naming the marks makes the contract reviewable and keeps
 * the wrong spellings out of the source tree altogether.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { ar, en } from "@/lib/i18n/dictionary";
import { resolveSettings } from "@/modules/online/services/settingsDefaults";

type TestCase = { name: string; fn: () => void };
const tests: TestCase[] = [];
const test = (name: string, fn: () => void) => tests.push({ name, fn });

/** Repo root, found by walking up from cwd so the runner's location is irrelevant. */
function repoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 6; i += 1) {
    if (fs.existsSync(path.join(dir, "src/lib/i18n/dictionary.ts"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("could not locate the repository root from " + process.cwd());
}
const ROOT = repoRoot();

// ── the wordmark, spelled by codepoint ──────────────────────────────────────
const cp = (...codes: number[]): string => String.fromCodePoint(...codes);

const ALEF_HAMZA = 0x0623; // أ  the initial, hamza above
const AIN = 0x0639; //        ع  a different letter entirely
const LAM = 0x0644; //        ل
const YEH = 0x064a; //        ي
const QAF = 0x0642; //        ق
const KAF = 0x0643; //        ك
const FATHA = 0x064e; //     َ  vowel on the alef
const KASRA = 0x0650; //     ِ  vowel on the lam
const SUKUN = 0x0652; //     ْ  no vowel on the yeh
const TATWEEL = 0x0640; //    ـ  the elongation the wordmark is drawn with

/** The official Arabic wordmark: أَلِــيْـــق */
const BRAND_AR = cp(
  ALEF_HAMZA, FATHA, LAM, KASRA, TATWEEL, TATWEEL, YEH, SUKUN, TATWEEL, TATWEEL, TATWEEL, QAF,
);
/** The official Latin wordmark. Always upper case, always these four letters. */
const BRAND_EN = "ALYQ";

/**
 * Spellings that have shipped by mistake and must not ship again. Each is
 * described, because "this one is wrong" is not actionable at 2am.
 *
 * The Latin ones are assembled from the letters of the real wordmark rather than
 * typed out. Typed, they appear literally in this file and the scan below flags
 * the suite that forbids them; excluding this file from the scan would work but
 * would leave the one place a misspelling could hide. Building them from parts
 * keeps the whole tree scanned, this file included.
 */
const [B1, B2, B3, B4] = [...BRAND_EN]; // A, L, Y, Q
const lc = (letter: string): string => letter.toLowerCase();

const FORBIDDEN: ReadonlyArray<readonly [string, string]> = [
  [cp(AIN, LAM, YEH, QAF), "Arabic with the wrong initial letter (ain, not alef with hamza)"],
  [cp(ALEF_HAMZA, LAM, YEH, KAF), "Arabic transliteration ending in kaf"],
  [cp(ALEF_HAMZA, FATHA, LAM, KASRA, YEH, QAF), "Arabic with the right letters but none of the wordmark's marks"],
  [[B1, B2, "I", B4].join(""), "Latin transliteration spelled with an I"],
  [[B1, lc(B2), lc(B3), lc(B4)].join(""), "Latin in mixed case"],
  [[B1, lc(B2), lc(B3), B4].join(""), "Latin in mixed case"],
  [[B1, B2, lc(B3), lc(B4)].join(""), "Latin in mixed case"],
];

/** Every text file that can reach a screen, a receipt or a search result. */
function scannedFiles(): string[] {
  const roots = ["src", "scripts", "supabase", "docs"];
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "__pycache__") continue;
        walk(full);
      } else if (/\.(ts|tsx|mjs|js|sql|md|html)$/.test(entry.name)) {
        out.push(full);
      }
    }
  };
  for (const root of roots) {
    const full = path.join(ROOT, root);
    if (fs.existsSync(full)) walk(full);
  }
  for (const file of ["index.html", "README.md", ".env.example"]) {
    const full = path.join(ROOT, file);
    if (fs.existsSync(full)) out.push(full);
  }
  return out;
}
const read = (relative: string): string => fs.readFileSync(path.join(ROOT, relative), "utf8");

// ── the two dictionaries ────────────────────────────────────────────────────
test("the Arabic app name is the official wordmark", () => {
  // This is the sidebar, the dashboard, the login screen and the POS header.
  assert.equal(ar["app.name"], `${BRAND_AR} كلاود POS`);
});

test("the English app name is the official wordmark", () => {
  assert.equal(en["app.name"], `${BRAND_EN} Cloud POS`);
});

test("both languages carry an app name", () => {
  // Parity is asserted elsewhere; here it matters because a one-sided brand
  // means half the users see a fallback key instead of a name.
  assert.ok(typeof en["app.name"] === "string" && en["app.name"].length > 0);
  assert.ok(typeof ar["app.name"] === "string" && ar["app.name"].length > 0);
});

test("the receipt wordmark is bilingual and uses the official Arabic form", () => {
  // Printed on every receipt and every return, in both directions.
  const expected = `${BRAND_EN} | ${BRAND_AR}`;
  assert.equal(en["receipt.businessName"], expected);
  assert.equal(ar["receipt.businessName"], expected);
});

// ── the storefront ──────────────────────────────────────────────────────────
test("a fresh installation names the shop with the official wordmark", () => {
  // `store_name_ar` is what the storefront header, footer, homepage, product
  // pages, contact page and seo.ts document title all render.
  for (const stored of [{}, null, undefined]) {
    const settings = resolveSettings(stored);
    assert.equal(
      settings.contact.store_name_ar,
      `متجر ${BRAND_AR}`,
      `resolveSettings(${JSON.stringify(stored) ?? String(stored)})`,
    );
    assert.equal(settings.contact.store_name_en, `${BRAND_EN} Store`);
  }
});

test("the shop name stays configurable — the brand is a default, not a hardcode", () => {
  // A merchant who names their shop must win. Pinning the brand must never turn
  // into overwriting what an admin typed.
  const settings = resolveSettings({ contact: { store_name_ar: "متجر القاهرة" } });
  assert.equal(settings.contact.store_name_ar, "متجر القاهرة");
  // And a partial override leaves the other language on the official default.
  assert.equal(settings.contact.store_name_en, `${BRAND_EN} Store`);
});

test("the storefront surfaces actually read the name that was corrected", () => {
  // Structural: a corrected default that nothing renders is not a fix.
  for (const file of [
    "src/modules/online/components/storefront/StoreLayout.tsx",
    "src/modules/online/pages/StoreHomePage.tsx",
    "src/modules/online/pages/StoreContactPage.tsx",
    "src/modules/online/pages/StoreProductPage.tsx",
    "src/modules/online/pages/StoreProductsPage.tsx",
    "src/modules/online/services/seo.ts",
  ]) {
    assert.ok(
      read(file).includes("store_name_ar"),
      `${file} no longer reads store_name_ar — the Arabic name would not reach it`,
    );
  }
});

test("the static document title and meta description carry the Latin brand", () => {
  // index.html is what a crawler and a browser tab see before React runs.
  const html = read("index.html");
  assert.ok(html.includes(`<title>${BRAND_EN} Cloud POS`), "index.html title lost the brand");
  assert.ok(
    html.includes(`content="${BRAND_EN} Cloud POS`),
    "index.html meta description lost the brand",
  );
});

// ── nothing wrong anywhere ──────────────────────────────────────────────────
test("no misspelling of the brand survives in the tree", () => {
  const hits: string[] = [];
  for (const file of scannedFiles()) {
    const text = read(path.relative(ROOT, file));
    for (const [spelling, why] of FORBIDDEN) {
      // Case-sensitive on purpose: ~300 lowercase `alyq` identifiers (CSS
      // classes, storage keys, the edge function, migration names) are correct
      // and must not be flagged as branding.
      let at = text.indexOf(spelling);
      while (at !== -1) {
        const line = text.slice(0, at).split("\n").length;
        hits.push(`${path.relative(ROOT, file)}:${line} ${JSON.stringify(spelling)} — ${why}`);
        at = text.indexOf(spelling, at + spelling.length);
      }
    }
  }
  assert.deepEqual(hits, [], "brand misspellings found");
});

test("the official Arabic wordmark is really in the dictionaries", () => {
  // Positive control for the scan above: if this suite ever passed because the
  // wordmark had been deleted rather than corrected, this fails.
  const dict = read("src/lib/i18n/dictionary.ts");
  assert.ok(dict.includes(BRAND_AR), "the official Arabic wordmark is missing from the dictionary");
  assert.ok(
    read("src/modules/online/services/settingsDefaults.ts").includes(BRAND_AR),
    "the official Arabic wordmark is missing from the storefront defaults",
  );
});

// ── runner ───────────────────────────────────────────────────────────────────
let failed = 0;
for (const { name, fn } of tests) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`  ✗ ${name}`);
    console.error(`    ${(error as Error).message}`);
  }
}
console.log("");
if (failed > 0) {
  console.error(`${failed}/${tests.length} brand wordmark tests FAILED.`);
  process.exit(1);
}
console.log(`${tests.length}/${tests.length} brand wordmark invariants hold (AR ${BRAND_AR} · EN ${BRAND_EN}).`);
