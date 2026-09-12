#!/usr/bin/env node
/**
 * Logic test runner — bundles and runs every `*.selftest.ts` in the project.
 *
 *   node scripts/test.logic.mjs              # every suite
 *   node scripts/test.logic.mjs roles pos    # only suites whose path matches
 *
 * The suites are plain TypeScript with `node:assert`, each printing its own
 * `n/n passed` line and exiting non-zero on the first failure. This runner adds
 * discovery, the shared bundle settings (the `@/*` alias comes from
 * tsconfig.json, `import.meta.env` is defined because the app reads it at module
 * scope) and a summary. Exit code 1 if any suite fails.
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { testBuildOptions } from "./lib/app-bundle.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "src");
const FILTERS = process.argv.slice(2).filter((a) => !a.startsWith("-"));

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
};

let esbuild;
try {
  esbuild = await import("esbuild");
} catch {
  console.error(c.red("✗ esbuild is not installed. Run `npm install` first."));
  process.exit(1);
}

// ── discovery ─────────────────────────────────────────────────────────────
function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith(".selftest.ts")) out.push(full);
  }
  return out;
}

const suites = walk(SRC)
  .filter((file) => FILTERS.length === 0 || FILTERS.some((f) => file.includes(f)))
  .sort();

if (suites.length === 0) {
  console.error(c.red(`✗ no *.selftest.ts suites matched ${FILTERS.join(", ") || "(all)"}`));
  process.exit(1);
}

// ── shared bundle settings ────────────────────────────────────────────────
// `import.meta.env` (read at module scope by the app), the `.css` loader and the
// asset mock all come from `scripts/lib/app-bundle.mjs`, the same module the E2E
// runner builds with. `src/modules/pos/__tests__/logic.selftest.ts` imports
// `receipt.ts`, which imports `@/assets/alyq-logo.png` — without the mock this
// bundle fails with "No loader is configured for .png files", and with a
// `dataurl` loader `RECEIPT_LOGO_SRC` would stop being the public URL the
// receipts document (`/alyq-logo.png`).

const OUT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "alyq-logic-"));

// ── run ───────────────────────────────────────────────────────────────────
console.log(c.bold(`\nALYQ logic suites · ${suites.length} file(s)\n`));

const results = [];

for (const suite of suites) {
  const rel = path.relative(ROOT, suite);
  const outfile = path.join(OUT_DIR, `${path.basename(suite, ".ts")}.mjs`);
  process.stdout.write(`  ${c.dim("bundling")} ${rel}\n`);

  try {
    // Every setting comes from `scripts/lib/app-bundle.mjs` — this runner used
    // to repeat them inline, which is how it drifted from the shared recipe.
    await esbuild.build(testBuildOptions({ entryPoints: [suite], outfile }));
  } catch (error) {
    console.log(`  ${c.red("✗")} ${rel} ${c.dim("failed to bundle")}`);
    results.push({ rel, ok: false, detail: (error.errors ?? []).map((e) => e.text).join("; ") || String(error) });
    continue;
  }

  const run = spawnSync(process.execPath, [outfile], { encoding: "utf8", cwd: ROOT });
  const combined = `${run.stdout ?? ""}${run.stderr ?? ""}`;
  // Suites word their summary differently ("12/12 role-model tests passed",
  // "All 36 logic tests passed"), so accept either shape.
  const tally =
    combined.match(/(\d+)\/(\d+) [^\n]*passed/) ?? combined.match(/All (\d+) [^\n]*passed/);

  if (run.status === 0) {
    console.log(`  ${c.green("✓")} ${rel}${tally ? c.dim(`  →  ${tally[0]}`) : ""}`);
    results.push({ rel, ok: true, tally: tally?.[0] ?? "" });
  } else {
    console.log(`  ${c.red("✗")} ${rel} ${c.dim(`exited ${run.status}`)}`);
    const lines = combined.split("\n").filter((l) => l.trim());
    const tail = lines.slice(-12);
    for (const line of tail) console.log(c.dim(`      ${line}`));
    results.push({ rel, ok: false, detail: lines.slice(-3).join(" | ") });
  }
}

fs.rmSync(OUT_DIR, { recursive: true, force: true });

// ── summary ───────────────────────────────────────────────────────────────
const failed = results.filter((r) => !r.ok);
const tallies = results.filter((r) => r.ok && r.tally);

if (failed.length === 0) {
  console.log(c.bold(c.green(`\n✓ ${results.length}/${results.length} suites passed`)));
  for (const r of tallies) console.log(c.dim(`   ${r.rel} → ${r.tally}`));
  console.log();
  process.exit(0);
}

console.log(c.bold(c.red(`\n✗ ${failed.length}/${results.length} suites failed\n`)));
for (const r of failed) {
  console.log(`${c.red("•")} ${r.rel}`);
  if (r.detail) console.log(c.dim(`    ${r.detail}`));
}
console.log();
process.exit(1);
