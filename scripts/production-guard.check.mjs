#!/usr/bin/env node
/**
 * Proves the production fail-closed gate with real builds.
 *
 *   node scripts/production-guard.check.mjs
 *
 * Three cases, each a genuine `vite build` into a throwaway directory:
 *
 *   1. `VITE_APP_MODE=production` with NO Supabase configuration → the build
 *      MUST fail, and the failure must name the configuration problem. If this
 *      case ever succeeds, a release pipeline with a missing environment
 *      variable would ship a till that writes to `localStorage`.
 *   2. `VITE_APP_MODE=production` with a complete, valid-looking configuration →
 *      the build MUST succeed and `release.json` must say `production` with
 *      `mode_requested: "production"` and `dirty: false`.
 *   3. `VITE_APP_MODE=demo` with no configuration → the build MUST succeed and
 *      `release.json` must say `demo`, because the evaluation bundle is a
 *      deliberate artifact, not an accident.
 *
 * The anon key used in case 2 is a syntactically valid JWT with `role: "anon"`
 * and no real project behind it: this script builds, it never connects.
 *
 * `--require-clean` additionally asserts that the manifest records a clean
 * worktree. CI passes it from a committed checkout; locally the tree is usually
 * dirty, and that is reported rather than failed.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
};

const requireClean = process.argv.includes("--require-clean");

if (fs.existsSync(path.join(ROOT, ".env"))) {
  console.log(c.yellow("! .env exists in the repository root; Vite loads it during these builds"));
}

const FAKE_ANON_JWT = [
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
  Buffer.from(JSON.stringify({ iss: "supabase", role: "anon", ref: "guardcheck", exp: 2_000_000_000 })).toString("base64url"),
  "guard-check-signature",
].join(".");

function build(outDir, env) {
  const result = spawnSync(
    process.execPath,
    [path.join(ROOT, "node_modules", "vite", "bin", "vite.js"), "build", "--outDir", outDir, "--emptyOutDir", "--logLevel", "warn"],
    {
      cwd: ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        VITE_SUPABASE_URL: "",
        VITE_SUPABASE_ANON_KEY: "",
        VITE_APP_MODE: "",
        ...env,
      },
    },
  );
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  const manifestPath = path.join(ROOT, outDir, "release.json");
  return {
    status: result.status,
    output,
    manifest: fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, "utf8")) : null,
  };
}

const failures = [];
const check = (ok, label) => {
  console.log(ok ? c.green(`✓ ${label}`) : c.red(`✗ ${label}`));
  if (!ok) failures.push(label);
};

console.log(c.bold("\nProduction fail-closed gate — three real builds\n"));

/* 1 · production without configuration must fail */
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "alyq-guard-"));
const dir1 = path.relative(ROOT, path.join(tempRoot, "noconfig"));
const noConfig = build(dir1, { VITE_APP_MODE: "production" });
check(noConfig.status !== 0, "a production build with no Supabase configuration is refused");
check(/SUPABASE_UNCONFIGURED|VITE_SUPABASE_URL/.test(noConfig.output), "the refusal names the missing configuration");
check(noConfig.manifest === null, "the refused build wrote no release manifest");
if (noConfig.status === 0) console.log(c.dim(noConfig.output.slice(0, 400)));

/* 2 · production with a complete configuration must succeed */
const dir2 = path.relative(ROOT, path.join(tempRoot, "configured"));
const configured = build(dir2, {
  VITE_APP_MODE: "production",
  VITE_SUPABASE_URL: "https://guard-check.supabase.co",
  VITE_SUPABASE_ANON_KEY: FAKE_ANON_JWT,
});
check(configured.status === 0, "a production build with a complete configuration succeeds");
check(configured.manifest?.mode === "production", "its release manifest says production");
check(configured.manifest?.mode_requested === "production", "and records that the mode was requested explicitly");
if (requireClean) {
  check(configured.manifest?.dirty === false, "and records a clean worktree (--require-clean)");
} else if (configured.manifest?.dirty === true) {
  console.log(c.yellow("! the worktree is dirty, so the manifest says dirty: true (CI passes --require-clean)"));
}
check(typeof configured.manifest?.sha === "string" && configured.manifest.sha.length >= 7, "and a real commit SHA");
if (configured.status !== 0) console.log(c.dim(configured.output.slice(0, 800)));

/* 3 · the evaluation build stays available and is labelled as such */
const dir3 = path.relative(ROOT, path.join(tempRoot, "demo"));
const demo = build(dir3, { VITE_APP_MODE: "demo" });
check(demo.status === 0, "an explicit demo build succeeds");
check(demo.manifest?.mode === "demo", "its release manifest says demo");

fs.rmSync(tempRoot, { recursive: true, force: true });

console.log(
  failures.length === 0
    ? c.bold(c.green("\n✓ the production configuration gate holds in both directions\n"))
    : c.bold(c.red(`\n✗ ${failures.length} check(s) failed\n`)),
);
process.exit(failures.length === 0 ? 0 : 1);
