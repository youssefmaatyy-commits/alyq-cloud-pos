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
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BUNDLE = "/tmp/alyq-app.mjs";
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

let esbuild;
try {
  esbuild = await import("esbuild");
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
// `--loader:.css=empty` because Tailwind's entry is not needed to exercise
// behaviour, and `import.meta.env` because the app reads it at module scope.
// The bundle is rebuilt every run so the suites can never test stale code.
console.log(c.bold("\nBuilding application bundle…"));
try {
  await esbuild.build({
    entryPoints: [path.join(ROOT, "src", "main.tsx")],
    outfile: BUNDLE,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node20",
    define: {
      "import.meta.env": JSON.stringify({
        VITE_CURRENCY: process.env.VITE_CURRENCY ?? "EGP",
      // Passed through when present, so the same suites can run against a real
        // project (the CI `live` job). Absent → the app takes its demo path.
        ...(process.env.VITE_SUPABASE_URL ? { VITE_SUPABASE_URL: process.env.VITE_SUPABASE_URL } : {}),
        ...(process.env.VITE_SUPABASE_ANON_KEY
          ? { VITE_SUPABASE_ANON_KEY: process.env.VITE_SUPABASE_ANON_KEY }
          : {}),
        MODE: "test",
        DEV: false,
        PROD: true,
        SSR: false,
      }),
    },
    loader: { ".css": "empty" },
    logLevel: "silent",
  });
} catch (error) {
  console.error(c.red("✗ bundling failed"));
  for (const e of error.errors ?? []) console.error(c.dim(`  ${e.text}`));
  process.exit(1);
}

const bytes = fs.statSync(BUNDLE).size;
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
