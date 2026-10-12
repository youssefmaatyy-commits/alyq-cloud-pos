#!/usr/bin/env node
/**
 * Proves the fail-closed release gate with real builds.
 *
 *   node scripts/production-guard.check.mjs [--require-clean]
 *
 * Eight cases, each a genuine `vite build` into a throwaway directory, so the
 * policy is proved by the compiler that ships rather than by a unit test that
 * *describes* it:
 *
 *   1. **no `VITE_APP_MODE`, no credentials** → MUST fail (`APP_MODE_MISSING`)
 *      and write no artifact. This is the regression the release train exists
 *      for: an environment variable that never reached the build used to produce
 *      a *demo* artifact, which looks like a working shop and writes to
 *      `localStorage`.
 *   2. **no `VITE_APP_MODE`, valid credentials** → MUST fail (`APP_MODE_MISSING`).
 *      Production is not inferred from credentials either.
 *   3. **unknown `VITE_APP_MODE` (`staging`), valid credentials** → MUST fail
 *      (`APP_MODE_UNKNOWN`): a misspelt mode is not a mode.
 *   4. `VITE_APP_MODE=production`, no credentials → MUST fail
 *      (`SUPABASE_UNCONFIGURED`).
 *   5. `VITE_APP_MODE=production`, half a configuration → MUST fail
 *      (`SUPABASE_INCOMPLETE`).
 *   6. `VITE_APP_MODE=production`, complete configuration → MUST succeed, and
 *      `release.json` must say `production` with `mode_requested: "production"`.
 *   7. `VITE_APP_MODE=demo` (no credentials) → MUST succeed and be labelled
 *      `demo`: the evaluation bundle is a deliberate artifact, not an accident.
 *   8. `VITE_APP_MODE=demo` **with credentials present** → MUST succeed, report
 *      `SUPABASE_CREDENTIALS_IGNORED`, resolve to *no* Supabase client, and the
 *      shipped bundle must boot without a single network request (the release
 *      probe drives the empty-catalogue walk with those same credentials in the
 *      environment).
 *
 * The anon key used here is a syntactically valid JWT with `role: "anon"` and no
 * real project behind it: this script builds, it never connects.
 *
 * `--require-clean` additionally asserts that case 6's manifest records a clean
 * worktree. CI passes it from a committed checkout; locally the tree is usually
 * dirty, and that is reported rather than failed.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "alyq-guard-"));

/**
 * The policy module, bundled the way the application is.
 *
 * `src/lib/appMode.ts` imports its neighbours with the `@/…`-less relative form
 * the bundler resolves (`./release`), which Node's own type stripping cannot —
 * so the gate loads the *same* implementation through esbuild rather than
 * re-stating the policy in this checker.
 */
async function loadPolicy() {
  const esbuild = await import("esbuild");
  const outfile = path.join(tempRoot, "appMode.policy.mjs");
  await esbuild.build({
    entryPoints: [path.join(ROOT, "src", "lib", "appMode.ts")],
    outfile,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node20",
    logLevel: "silent",
    define: { "import.meta.env": "{}" },
  });
  return import(pathToFileURL(outfile).href);
}

const { issueCodes, resolveAppMode } = await loadPolicy();

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
const FAKE_PROJECT_URL = "https://guard-check.supabase.co";

/**
 * Run a real `vite build`.
 *
 * `VITE_APP_MODE`, `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` are blanked
 * before `env` is applied, and blanked means *unset* to the build: Vite's
 * `loadEnv` merges `process.env` over any `.env` file, so these cases are
 * deterministic even on a developer machine that has a populated `.env`.
 */
function build(outDir, env = {}) {
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
    manifestPath,
    manifest: fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, "utf8")) : null,
  };
}

/**
 * Case 8's runtime half: the shipped bundle, built with credentials present in
 * demo mode, must walk the empty catalogue without a single network request.
 */
function probeDemoWithCredentials(manifestPath) {
  const result = spawnSync(
    process.execPath,
    [path.join(ROOT, "scripts", "release.probe.mjs"), "--demo", "--manifest", manifestPath],
    {
      cwd: ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        VITE_APP_MODE: "demo",
        VITE_SUPABASE_URL: FAKE_PROJECT_URL,
        VITE_SUPABASE_ANON_KEY: FAKE_ANON_JWT,
      },
    },
  );
  return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

const failures = [];
const check = (ok, label) => {
  console.log(ok ? c.green(`✓ ${label}`) : c.red(`✗ ${label}`));
  if (!ok) failures.push(label);
};

console.log(c.bold("\nProduction fail-closed gate — eight real builds\n"));

/* 1 · an undeclared mode must fail, whatever the credentials say */
const undeclared = build(path.relative(ROOT, path.join(tempRoot, "undeclared")));
check(undeclared.status !== 0, "a build that did not declare VITE_APP_MODE is refused");
check(/APP_MODE_MISSING|APP_MODE_UNKNOWN/.test(undeclared.output), "the refusal names the missing mode declaration");
check(undeclared.manifest === null, "the undeclared build wrote no release manifest (so no demo artifact exists)");
if (undeclared.status === 0) console.log(c.dim(undeclared.output.slice(0, 400)));

/* 2 · …and credentials must not stand in for a declaration */
const undeclaredCreds = build(path.relative(ROOT, path.join(tempRoot, "undeclared-creds")), {
  VITE_SUPABASE_URL: FAKE_PROJECT_URL,
  VITE_SUPABASE_ANON_KEY: FAKE_ANON_JWT,
});
check(undeclaredCreds.status !== 0, "an undeclared mode with a valid-looking credential pair is refused");
check(/APP_MODE_MISSING/.test(undeclaredCreds.output), "and the refusal is the missing declaration, not a credential complaint");
check(undeclaredCreds.manifest === null, "and it wrote no artifact either (production is not inferred from credentials)");
const inferredLive = resolveAppMode({ supabaseUrl: FAKE_PROJECT_URL, supabaseAnonKey: FAKE_ANON_JWT });
check(
  inferredLive.mode === "unset" && inferredLive.source === "unset" && inferredLive.runnable === false && inferredLive.supabase.configured === false,
  "the policy resolves that same pair to unset/not-runnable with no Supabase client",
);
if (undeclaredCreds.status === 0) console.log(c.dim(undeclaredCreds.output.slice(0, 400)));

/* 3 · a misspelt mode is not a mode */
const unknownMode = build(path.relative(ROOT, path.join(tempRoot, "unknown-mode")), {
  VITE_APP_MODE: "staging",
  VITE_SUPABASE_URL: FAKE_PROJECT_URL,
  VITE_SUPABASE_ANON_KEY: FAKE_ANON_JWT,
});
check(unknownMode.status !== 0, 'an unknown VITE_APP_MODE ("staging") is refused');
check(/APP_MODE_UNKNOWN/.test(unknownMode.output), "and the refusal names the unrecognised value");
check(unknownMode.manifest === null, "and no artifact is written for it");
if (unknownMode.status === 0) console.log(c.dim(unknownMode.output.slice(0, 400)));

/* 4 · production without configuration must fail */
const noConfig = build(path.relative(ROOT, path.join(tempRoot, "noconfig")), { VITE_APP_MODE: "production" });
check(noConfig.status !== 0, "a production build with no Supabase configuration is refused");
check(/SUPABASE_UNCONFIGURED|VITE_SUPABASE_URL/.test(noConfig.output), "the refusal names the missing configuration");
check(noConfig.manifest === null, "the refused build wrote no release manifest");
if (noConfig.status === 0) console.log(c.dim(noConfig.output.slice(0, 400)));

/* 5 · half a configuration is a typo, never a demo build */
const halfConfig = build(path.relative(ROOT, path.join(tempRoot, "halfconfig")), {
  VITE_APP_MODE: "production",
  VITE_SUPABASE_URL: FAKE_PROJECT_URL,
});
check(halfConfig.status !== 0, "a production build with only half a Supabase configuration is refused");
check(/SUPABASE_INCOMPLETE/.test(halfConfig.output), "and the refusal names the half-set pair");
check(halfConfig.manifest === null, "and it writes no artifact");
if (halfConfig.status === 0) console.log(c.dim(halfConfig.output.slice(0, 400)));

/* 6 · production with a complete configuration must succeed */
const configured = build(path.relative(ROOT, path.join(tempRoot, "configured")), {
  VITE_APP_MODE: "production",
  VITE_SUPABASE_URL: FAKE_PROJECT_URL,
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

/* 7 · the evaluation build stays available and is labelled as such */
const demo = build(path.relative(ROOT, path.join(tempRoot, "demo")), { VITE_APP_MODE: "demo" });
check(demo.status === 0, "an explicit demo build succeeds");
check(demo.manifest?.mode === "demo", "its release manifest says demo");

/* 8 · demo with credentials: ignored, and proved at run time */
const demoCreds = build(path.relative(ROOT, path.join(tempRoot, "demo-creds")), {
  VITE_APP_MODE: "demo",
  VITE_SUPABASE_URL: FAKE_PROJECT_URL,
  VITE_SUPABASE_ANON_KEY: FAKE_ANON_JWT,
});
check(demoCreds.status === 0, "an explicit demo build with credentials present still succeeds");
check(demoCreds.manifest?.mode === "demo", "and stays labelled demo, never production");
const ignored = resolveAppMode({ appMode: "demo", supabaseUrl: FAKE_PROJECT_URL, supabaseAnonKey: FAKE_ANON_JWT });
check(
  ignored.runnable === true && ignored.supabase.configured === false &&
    ignored.supabase.projectUrl === "" && ignored.supabase.anonKey === "",
  "the credentials are dropped by the policy, so no Supabase client can be constructed",
);
check(
  issueCodes(ignored).includes("SUPABASE_CREDENTIALS_IGNORED") &&
    !ignored.issues.some((issue) => issue.severity === "fatal"),
  "and the build reports SUPABASE_CREDENTIALS_IGNORED instead of failing",
);
check(
  (demoCreds.manifest?.configuration_issues ?? []).includes("SUPABASE_CREDENTIALS_IGNORED"),
  "the written release manifest records that the credentials were ignored",
);
const walk = probeDemoWithCredentials(demoCreds.manifestPath ?? path.join(ROOT, "dist", "release.json"));
check(
  walk.status === 0 && /probe\.no_network\s+—/.test(stripVTControlCharacters(walk.output)),
  "and the shipped bundle walks the empty catalogue with zero network requests (no client, no project)",
);
if (walk.status !== 0) console.log(c.dim(walk.output.slice(-1200)));

fs.rmSync(tempRoot, { recursive: true, force: true });

console.log(
  failures.length === 0
    ? c.bold(c.green("\n✓ the production configuration gate holds in both directions\n"))
    : c.bold(c.red(`\n✗ ${failures.length} check(s) failed\n`)),
);
process.exit(failures.length === 0 ? 0 : 1);
