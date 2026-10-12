/**
 * Application-mode policy self-test.
 *
 * `src/lib/appMode.ts` is the single place that decides whether a build runs in
 * production or demo, and the single place that validates the Supabase
 * configuration production requires. These tests pin the policy that makes
 * "production fails closed" true:
 *
 *   · an explicit `production` build with a missing, half, malformed, insecure
 *     or dangerous configuration is FATAL — no demo fallback, no silent start;
 *   · an explicit `demo` build ignores credentials on purpose and says so;
 *   · an unset or misspelled mode is FATAL — there is no inference left, in
 *     either direction, because inferring from the credentials is what let a
 *     missing environment variable ship a demo artifact that looked live.
 */
import assert from "node:assert/strict";

import { isDeclaredAppMode, resolveAppMode } from "../appMode";

let passed = 0;
const check = (label: string, fn: () => void) => {
  fn();
  passed += 1;
  console.log(`  ✓ ${label}`);
};

/* A syntactically valid anon JWT: header.payload.signature with role=anon. */
const jwk = (payload: Record<string, unknown>) =>
  [`eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9`, Buffer.from(JSON.stringify(payload)).toString("base64url"), "signature"].join(".");
const ANON_JWT = jwk({ iss: "supabase", role: "anon", exp: 2_000_000_000 });
const SERVICE_JWT = jwk({ iss: "supabase", role: "service_role", exp: 2_000_000_000 });
const PROJECT_URL = "https://project-under-test.supabase.co";

const codes = (result: ReturnType<typeof resolveAppMode>) => result.issues.map((issue) => issue.code);
const fatals = (result: ReturnType<typeof resolveAppMode>) =>
  result.issues.filter((issue) => issue.severity === "fatal").map((issue) => issue.code);

/* ── production: fail closed ─────────────────────────────────────────────── */

check("production with no Supabase configuration is fatal and never runnable", () => {
  const result = resolveAppMode({ appMode: "production" });
  assert.equal(result.mode, "production");
  assert.equal(result.source, "explicit");
  assert.equal(result.runnable, false);
  assert.equal(result.supabase.configured, false);
  assert.ok(fatals(result).includes("SUPABASE_UNCONFIGURED"));
});

check("production with only the URL is fatal (half a configuration is a typo)", () => {
  const result = resolveAppMode({ appMode: "production", supabaseUrl: PROJECT_URL });
  assert.equal(result.runnable, false);
  assert.ok(fatals(result).includes("SUPABASE_INCOMPLETE"));
});

check("production with only the anon key is fatal", () => {
  const result = resolveAppMode({ appMode: "production", supabaseAnonKey: ANON_JWT });
  assert.equal(result.runnable, false);
  assert.ok(fatals(result).includes("SUPABASE_INCOMPLETE"));
});

check("production with a complete, valid configuration runs and exposes the project URL", () => {
  const result = resolveAppMode({ appMode: "production", supabaseUrl: PROJECT_URL, supabaseAnonKey: ANON_JWT });
  assert.equal(result.runnable, true);
  assert.equal(result.supabase.configured, true);
  assert.equal(result.supabase.projectUrl, PROJECT_URL);
  assert.equal(result.supabase.anonKey, ANON_JWT);
  assert.deepEqual(fatals(result), []);
});

check("plain http to a remote host is refused (credentials and sales must be encrypted)", () => {
  const result = resolveAppMode({
    appMode: "production",
    supabaseUrl: "http://project-under-test.supabase.co",
    supabaseAnonKey: ANON_JWT,
  });
  assert.equal(result.runnable, false);
  assert.ok(fatals(result).includes("SUPABASE_URL_INSECURE"));
});

check("plain http to localhost is allowed (local Supabase during development)", () => {
  const result = resolveAppMode({
    appMode: "production",
    supabaseUrl: "http://127.0.0.1:54321",
    supabaseAnonKey: ANON_JWT,
  });
  assert.equal(result.runnable, true);
  assert.equal(result.supabase.configured, true);
});

check("a service_role JWT in VITE_SUPABASE_ANON_KEY is fatal, never a warning", () => {
  const result = resolveAppMode({ appMode: "production", supabaseUrl: PROJECT_URL, supabaseAnonKey: SERVICE_JWT });
  assert.equal(result.runnable, false);
  assert.ok(fatals(result).includes("ANON_KEY_LOOKS_SECRET"));
});

check("a Supabase secret key (sb_secret_…) is fatal", () => {
  const result = resolveAppMode({
    appMode: "production",
    supabaseUrl: PROJECT_URL,
    supabaseAnonKey: "sb_secret_0123456789abcdefghijklmnopqrstuv",
  });
  assert.equal(result.runnable, false);
  assert.ok(fatals(result).includes("ANON_KEY_LOOKS_SECRET"));
});

check("a truncated or mis-pasted key is fatal rather than silently unusable", () => {
  const result = resolveAppMode({ appMode: "production", supabaseUrl: PROJECT_URL, supabaseAnonKey: "not-a-key" });
  assert.equal(result.runnable, false);
  assert.ok(fatals(result).includes("ANON_KEY_INVALID"));
});

check("a non-URL project value is fatal", () => {
  const result = resolveAppMode({ appMode: "production", supabaseUrl: "project.supabase.co", supabaseAnonKey: ANON_JWT });
  assert.equal(result.runnable, false);
  assert.ok(fatals(result).includes("SUPABASE_URL_INVALID"));
});

check("a REST-suffixed project URL is normalised to the project root and reported", () => {
  const result = resolveAppMode({
    appMode: "production",
    supabaseUrl: `${PROJECT_URL}/rest/v1/`,
    supabaseAnonKey: ANON_JWT,
  });
  assert.equal(result.runnable, true);
  assert.equal(result.supabase.projectUrl, PROJECT_URL);
  assert.ok(codes(result).includes("SUPABASE_URL_LEGACY_REST"));
});

check("Supabase's current publishable key shape is accepted", () => {
  const result = resolveAppMode({
    appMode: "production",
    supabaseUrl: PROJECT_URL,
    supabaseAnonKey: "sb_publishable_abcdefghijklmnopqrstuv",
  });
  assert.equal(result.runnable, true);
  assert.equal(result.supabase.configured, true);
});

check("an unset VITE_APP_MODE is fatal even with a complete, valid configuration", () => {
  // The old behaviour inferred `production` here and merely warned. A warning is
  // invisible in a pipeline, and the same defect with the credentials removed
  // inferred *demo* — a working-looking till on localStorage.
  const result = resolveAppMode({ supabaseUrl: PROJECT_URL, supabaseAnonKey: ANON_JWT });
  assert.equal(result.mode, "unset");
  assert.equal(result.source, "unset");
  assert.equal(result.runnable, false);
  assert.equal(result.supabase.configured, false, "an undeclared build never gets a live client");
  assert.deepEqual(fatals(result), ["APP_MODE_MISSING"]);
});

check("VITE_DEMO_SEED left on in a production build is reported", () => {
  const result = resolveAppMode({
    appMode: "production",
    supabaseUrl: PROJECT_URL,
    supabaseAnonKey: ANON_JWT,
    demoSeed: "on",
  });
  assert.ok(codes(result).includes("DEMO_SEED_NOT_DISABLED"));
  assert.equal(result.runnable, true);
});

/* ── demo: deliberate, and never touching a project ──────────────────────── */

check("explicit demo mode ignores complete credentials and stays demo", () => {
  const result = resolveAppMode({ appMode: "demo", supabaseUrl: PROJECT_URL, supabaseAnonKey: ANON_JWT });
  assert.equal(result.mode, "demo");
  assert.equal(result.runnable, true);
  assert.equal(result.supabase.configured, false, "demo mode must not expose a live client");
  assert.equal(result.supabase.anonKey, "");
  assert.ok(codes(result).includes("SUPABASE_CREDENTIALS_IGNORED"));
});

check("explicit demo mode with no configuration is clean", () => {
  const result = resolveAppMode({ appMode: "demo" });
  assert.equal(result.mode, "demo");
  assert.equal(result.runnable, true);
  assert.deepEqual(result.issues, []);
});

check("demo mode never inherits a malformed pair as fatal (nothing can use it)", () => {
  const result = resolveAppMode({ appMode: "demo", supabaseUrl: PROJECT_URL });
  assert.equal(result.runnable, true);
  assert.deepEqual(fatals(result), []);
});

check("a build with nothing set at all is refused — it must never become a demo artifact", () => {
  const result = resolveAppMode({});
  assert.equal(result.mode, "unset");
  assert.equal(result.source, "unset");
  assert.equal(result.runnable, false);
  assert.equal(result.supabase.configured, false);
  assert.deepEqual(fatals(result), ["APP_MODE_MISSING"]);
  assert.match(result.issues[0].message, /no inference from the credentials/);
});

check("an empty VITE_APP_MODE is the same defect as a missing one", () => {
  const result = resolveAppMode({ appMode: "   ", supabaseUrl: PROJECT_URL, supabaseAnonKey: ANON_JWT });
  assert.equal(result.mode, "unset");
  assert.equal(result.runnable, false);
  assert.deepEqual(fatals(result), ["APP_MODE_MISSING"]);
});

check("demo is reachable only by asking for it by name", () => {
  assert.equal(resolveAppMode({ appMode: "demo" }).mode, "demo");
  assert.equal(resolveAppMode({ appMode: "DEMO" }).mode, "demo");
  for (const nothing of [{}, { appMode: "" }, { supabaseUrl: "", supabaseAnonKey: "" }]) {
    assert.notEqual(resolveAppMode(nothing).mode, "demo", JSON.stringify(nothing));
  }
});

check("isDeclaredAppMode is the single list of buildable modes", () => {
  assert.equal(isDeclaredAppMode("production"), true);
  assert.equal(isDeclaredAppMode(" Demo "), true);
  assert.equal(isDeclaredAppMode(""), false);
  assert.equal(isDeclaredAppMode(undefined), false);
  assert.equal(isDeclaredAppMode("staging"), false);
});

/* ── typos ───────────────────────────────────────────────────────────────── */

check("an unknown mode value is refused; it is never treated as demo or production", () => {
  const result = resolveAppMode({ appMode: "prod", supabaseUrl: PROJECT_URL, supabaseAnonKey: ANON_JWT });
  assert.equal(result.mode, "unset");
  assert.equal(result.runnable, false);
  assert.deepEqual(fatals(result), ["APP_MODE_UNKNOWN"]);
  assert.equal(result.supabase.configured, false);
});

check("mode matching is case-insensitive and trims whitespace", () => {
  const result = resolveAppMode({ appMode: "  PRODUCTION ", supabaseUrl: PROJECT_URL, supabaseAnonKey: ANON_JWT });
  assert.equal(result.mode, "production");
  assert.equal(result.runnable, true);
  assert.deepEqual(fatals(result), []);
});

console.log(`\n${passed}/${passed} application-mode policy tests passed`);
