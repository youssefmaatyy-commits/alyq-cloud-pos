#!/usr/bin/env node
/**
 * `npm run dev:demo` / `npm run dev:production` — start the dev server with the
 * application mode named on the command line.
 *
 * The mode is required and there is no inference: `npm run dev` with no `.env`
 * and no `VITE_APP_MODE` renders the configuration screen, because a build (or a
 * dev server) that does not say what it is must not guess. That is correct for
 * releases and inconvenient for a first run, so this launcher names the mode
 * explicitly instead of reintroducing a default somewhere the release pipeline
 * cannot see.
 *
 *   node scripts/dev.mode.mjs demo                    # → VITE_APP_MODE=demo
 *   node scripts/dev.mode.mjs production -- --port 5174
 *
 * Anything after `--` is forwarded to `vite`.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ALLOWED = ["production", "demo"];

const argv = process.argv.slice(2);
const separator = argv.indexOf("--");
const forwarded = separator >= 0 ? argv.slice(separator + 1) : [];
const requested = (separator >= 0 ? argv.slice(0, separator) : argv)[0]?.trim().toLowerCase() ?? "";

if (!ALLOWED.includes(requested)) {
  console.error(
    `✗ usage: node scripts/dev.mode.mjs <${ALLOWED.join("|")}> [-- <vite args>]\n` +
      `  received: ${requested ? `"${requested}"` : "(nothing)"}`,
  );
  process.exit(2);
}

const vite = path.join(ROOT, "node_modules", "vite", "bin", "vite.js");
console.log(`▶ vite dev · VITE_APP_MODE=${requested}${forwarded.length ? ` · ${forwarded.join(" ")}` : ""}`);

const child = spawn(process.execPath, [vite, ...forwarded], {
  cwd: ROOT,
  stdio: "inherit",
  env: {
    ...process.env,
    // The declared mode wins over an .env file for this process, so `dev:demo`
    // means demo even on a machine whose .env says production.
    VITE_APP_MODE: requested,
  },
});
child.once("exit", (code, signal) => process.exit(signal ? 1 : code ?? 0));
