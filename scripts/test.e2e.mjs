#!/usr/bin/env node
/**
 * End-to-end runner — builds the real application bundle once and drives it in
 * jsdom through both DOM suites.
 *
 *   node scripts/test.e2e.mjs               # both suites
 *   node scripts/test.e2e.mjs smoke         # only scripts/smoke.dom.mjs
 *   node scripts/test.e2e.mjs auth          # only scripts/auth.flow.mjs
 *
 * Both suites import the bundle from `/tmp/alyq-app.mjs`, so the build step here
 * is what the header comments of those files describe by hand. Exit code 1 if a
 * suite fails. Exits 2 without a bundle when esbuild is unavailable.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { DEFAULT_BUNDLE, buildAppBundle } from "./lib/app-bundle.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BUNDLE = DEFAULT_BUNDLE;
const FILTERS = process.argv.slice(2).filter((a) => !a.startsWith("-"));

const SUITES = [
  { id: "smoke", file: "scripts/smoke.dom.mjs", title: "DOM smoke (products, inventory, POS, returns, shifts)" },
  { id: "auth", file: "scripts/auth.flow.mjs", title: "Authentication acceptance flow" },
];

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
};

try {
  await import("esbuild");
} catch {
  console.error(c.red("✗ esbuild is not installed. Run `npm install` first."));
  process.exit(2);
}

const selected = SUITES.filter((s) => FILTERS.length === 0 || FILTERS.includes(s.id));
if (selected.length === 0) {
  console.error(c.red(`✗ no suite matched ${FILTERS.join(", ")} (try: smoke, auth)`));
  process.exit(1);
}

// ── build ─────────────────────────────────────────────────────────────────
// `scripts/lib/app-bundle.mjs` owns the esbuild options so this runner and the
// logic runner cannot drift apart again:
//   - `import.meta.env` is inlined — the app reads it at module scope.
//   - `.css` is empty — Tailwind's entry is not needed to exercise behaviour.
//   - image imports (`@/assets/alyq-logo.png`) are mocked to the public URL the
//     receipts document and assert. Plain esbuild has no `.png` loader, so
//     without the plugin the build dies before any suite runs; `dataurl` builds
//     but replaces `/alyq-logo.png` with base64, which the receipt assertions
//     in `scripts/smoke.dom.mjs` can never match.
// The bundle is rebuilt every run so the suites can never test stale code.
console.log(c.bold("\nBuilding application bundle…"));
let bytes;
try {
  ({ bytes } = await buildAppBundle({ outfile: BUNDLE }));
} catch (error) {
  console.error(c.red("✗ bundling failed"));
  for (const e of error?.errors ?? []) console.error(c.dim(`  ${e.text}`));
  if (!error?.errors) console.error(c.dim(`  ${String(error)}`));
  process.exit(1);
}
console.log(c.dim(`  ${BUNDLE} (${(bytes / 1024).toFixed(0)} kB)\n`));

// ── run ───────────────────────────────────────────────────────────────────
const results = [];

for (const suite of selected) {
  console.log(c.bold(`▶ ${suite.title}`));
  const run = spawnSync(process.execPath, [path.join(ROOT, suite.file)], {
    stdio: "inherit",
    cwd: ROOT,
  });
  const ok = run.status === 0;
  results.push({ ...suite, ok });
  console.log(ok ? c.green(`  ✓ ${suite.id} passed\n`) : c.red(`  ✗ ${suite.id} exited ${run.status}\n`));
}

const failed = results.filter((r) => !r.ok);
if (failed.length === 0) {
  console.log(c.bold(c.green(`✓ ${results.length}/${results.length} E2E suites passed\n`)));
  process.exit(0);
}

console.log(c.bold(c.red(`✗ ${failed.length}/${results.length} E2E suites failed\n`)));
for (const f of failed) console.log(`${c.red("•")} ${f.id} — ${f.title}`);
console.log();
process.exit(1);
