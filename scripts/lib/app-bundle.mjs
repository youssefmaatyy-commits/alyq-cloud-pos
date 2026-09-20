#!/usr/bin/env node
/**
 * The one place that knows how to turn `src/main.tsx` into a bundle the jsdom
 * suites can import.
 *
 * Both runners used to carry their own copy of the esbuild options, which is
 * how they drifted: `test.e2e.mjs` grew image loaders and `test.logic.mjs` did
 * not (and neither matched the recipe documented in the suite headers, which
 * still fails on `.png`). Everything shared now lives here —
 *
 *   testDefine()   the `import.meta.env` inline the app reads at module scope
 *   testPlugins()  the asset mock (`scripts/lib/asset-mock.plugin.mjs`)
 *   testLoaders()  `.css` → empty; Tailwind's output is not needed to exercise
 *                  behaviour, and jsdom cannot parse `@import`/`@theme` anyway
 *   buildAppBundle()  bundle `src/main.tsx` → outfile
 *
 * Also runnable, so the suite headers can point at a command that works:
 *
 *   node scripts/lib/app-bundle.mjs              # → os.tmpdir()/alyq-app.mjs
 *   node scripts/lib/app-bundle.mjs out.mjs      # → out.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { assetMockPlugin } from "./asset-mock.plugin.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");

/**
 * Where the suites import the app bundle from: the OS temp directory, joined
 * with `path.join` — never a hardcoded `/tmp/...` path, which does not exist
 * on Windows (Node resolves it against the current drive and esbuild writes
 * nowhere the suites can read back). `os.tmpdir()` is correct on every
 * platform the suites run on.
 */
export const DEFAULT_BUNDLE = path.join(os.tmpdir(), "alyq-app.mjs");

/**
 * A `file:` URL for the bundle, for dynamic `import()`. A bare filesystem
 * path is not a valid import specifier on Windows (backslashes), and a
 * `?query` suffix is how the auth/backup suites boot the app once per
 * scenario without sharing a module graph.
 */
export function bundleFileUrl(outfile = DEFAULT_BUNDLE, query) {
  const href = pathToFileURL(outfile).href;
  return query ? `${href}?${query}` : href;
}

/**
 * `import.meta.env` does not exist under Node ESM, but the app reads it at
 * module scope (currency formatting, the Supabase client), so it is inlined the
 * same way the documented `--define:import.meta.env=…` recipe does.
 *
 * The Supabase pair is passed through when present, so the same suites can run
 * against a real project (the CI `live` job). Absent → the app takes its demo
 * path, which is what the jsdom suites expect.
 */
export const testDefine = () => ({
  "import.meta.env": JSON.stringify({
    VITE_CURRENCY: process.env.VITE_CURRENCY ?? "EGP",
    ...(process.env.VITE_SUPABASE_URL ? { VITE_SUPABASE_URL: process.env.VITE_SUPABASE_URL } : {}),
    ...(process.env.VITE_SUPABASE_ANON_KEY
      ? { VITE_SUPABASE_ANON_KEY: process.env.VITE_SUPABASE_ANON_KEY }
      : {}),
    MODE: "test",
    DEV: false,
    PROD: true,
    SSR: false,
  }),
});

/** Image and font assets are mocked to stable URL strings by the plugin. */
export const testPlugins = () => [assetMockPlugin()];

export const testLoaders = () => ({ ".css": "empty" });

/**
 * `xlsx` is CommonJS and calls `require("stream")` from inside its factory.
 * esbuild turns that into a shim which *throws* ("Dynamic require of \"stream\"
 * is not supported") the first time the library is touched, so every Excel path
 * — the product import template and the report exports — blew up under the
 * suites even though the shipped browser bundle resolves those requires at build
 * time and works fine.
 *
 * esbuild's shim delegates to a real `require` when one is in scope, so the
 * banner supplies Node's. Test-config only: no application code is involved.
 */
export const testBanner = () => ({
  js: [
    'import { createRequire as __alyqCreateRequire } from "node:module";',
    "const require = __alyqCreateRequire(import.meta.url);",
  ].join("\n"),
});

/** Shared esbuild options for every test bundle in this repo. */
export const testBuildOptions = (overrides = {}) => ({
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  define: testDefine(),
  banner: testBanner(),
  plugins: testPlugins(),
  loader: testLoaders(),
  logLevel: "silent",
  ...overrides,
});

/**
 * Bundle the real application for the jsdom suites.
 *
 * @param {object} [options]
 * @param {string} [options.outfile] defaults to `os.tmpdir()/alyq-app.mjs`
 * @param {string} [options.entryPoint] defaults to `src/main.tsx`
 * @returns {Promise<{ outfile: string, bytes: number }>}
 */
export async function buildAppBundle({ outfile = DEFAULT_BUNDLE, entryPoint } = {}) {
  const esbuild = await import("esbuild"); // surfaced as "run npm install" by callers
  const entry = entryPoint ?? path.join(ROOT, "src", "main.tsx");

  fs.mkdirSync(path.dirname(outfile), { recursive: true });
  await esbuild.build(testBuildOptions({ entryPoints: [entry], outfile }));

  return { outfile, bytes: fs.statSync(outfile).size };
}

// ── CLI ───────────────────────────────────────────────────────────────────
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const outfile = process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_BUNDLE;
  try {
    const { bytes } = await buildAppBundle({ outfile });
    console.log(`${outfile} (${(bytes / 1024).toFixed(0)} kB)`);
  } catch (error) {
    for (const e of error?.errors ?? []) console.error(`  ${e.text}`);
    console.error(error?.errors ? "✗ bundling failed" : String(error));
    process.exit(1);
  }
}
