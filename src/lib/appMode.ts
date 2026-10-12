/**
 * The one place that decides which mode the application runs in, and the one
 * place that validates the Supabase configuration that production requires.
 *
 * Until now the mode was *inferred*: any build with no `VITE_SUPABASE_URL` /
 * `VITE_SUPABASE_ANON_KEY` silently fell back to the demo dataset. That is a
 * comfortable development default and an unacceptable release default — a typo
 * in the anon key, or an environment variable that never reached the build,
 * produced a working-looking till that wrote to `localStorage` while the
 * operator believed it was writing to Postgres. There was no way for the app to
 * tell the difference, and no way for a reviewer to see the intent in the
 * build.
 *
 * `VITE_APP_MODE` makes the intent explicit and reviewable, and it is
 * **required**: there is no inference left to fall back on.
 *
 *   production  Live Supabase only. Missing, malformed or dangerous
 *               configuration is FATAL: the app renders a configuration-error
 *               screen and never mounts the business application, so demo data
 *               can never masquerade as live data. `vite build` refuses to
 *               produce such a bundle at all (see `vite.config.ts`).
 *   demo        The in-browser dataset, deliberately and visibly. Supabase
 *               credentials are ignored even when present, so an evaluation
 *               build can never touch a real project.
 *   (unset)     FATAL, in both directions. The previous release inferred the
 *               mode from the credentials — no credentials meant "demo" — and
 *               that is precisely the failure this module exists to prevent: a
 *               release pipeline with a variable that never arrived produced a
 *               *demo* artifact that looked like a live shop. A build that does
 *               not say what it is must not exist, so `vite build` fails and a
 *               bundle that exists anyway renders the configuration screen.
 *
 * Deployment consequence: every existing deployment must set
 * `VITE_APP_MODE=production` before it is rebuilt. A redeploy that forgets it
 * now fails the build instead of silently shipping the local dataset; see
 * `docs/production/production-environment.md`.
 *
 * Nothing here is secret: the anon key is a browser-shipped public credential
 * and the checks below are about *configuration safety*, not authentication.
 */
import { RELEASE } from "./release";

/**
 * `production` and `demo` are the two buildable modes. `unset` exists so that a
 * build which declared nothing is described honestly — as a defect — instead of
 * being dressed up as one of the two real answers.
 */
export type AppMode = "production" | "demo" | "unset";

/** Where the resolved mode came from — printed in diagnostics and the probe. */
export type AppModeSource =
  | "explicit" // VITE_APP_MODE was set by the operator
  | "unset"; // VITE_APP_MODE was missing: a build that must not ship

export type ConfigField =
  | "VITE_APP_MODE"
  | "VITE_SUPABASE_URL"
  | "VITE_SUPABASE_ANON_KEY"
  | "VITE_DEMO_SEED";

export interface ConfigurationIssue {
  /** Stable machine-readable id (used by tests, CI and the probe). */
  code:
    | "APP_MODE_MISSING"
    | "APP_MODE_UNKNOWN"
    | "SUPABASE_UNCONFIGURED"
    | "SUPABASE_INCOMPLETE"
    | "SUPABASE_URL_INVALID"
    | "SUPABASE_URL_INSECURE"
    | "SUPABASE_URL_LEGACY_REST"
    | "ANON_KEY_INVALID"
    | "ANON_KEY_LOOKS_SECRET"
    | "SUPABASE_CREDENTIALS_IGNORED"
    | "DEMO_SEED_NOT_DISABLED";
  field: ConfigField;
  /** `fatal` blocks startup / fails a production build; `warning` is reported. */
  severity: "fatal" | "warning";
  /** Operator-facing sentence. Never contains a credential value. */
  message: string;
}

export interface SupabaseConfiguration {
  /** Project base URL handed to supabase-js (REST-suffixed input normalised). */
  projectUrl: string;
  anonKey: string;
  configured: boolean;
}

export interface ResolvedAppMode {
  mode: AppMode;
  source: AppModeSource;
  /** True only when the app is allowed to mount the business application. */
  runnable: boolean;
  issues: ConfigurationIssue[];
  supabase: SupabaseConfiguration;
}

export const APP_MODE_VALUES: readonly AppMode[] = ["production", "demo"];

/* ── Supabase URL ────────────────────────────────────────────────────────── */

/**
 * Supabase's JavaScript client expects a project URL, not one of its API URLs.
 * Some existing deployments supplied the PostgREST endpoint here
 * (`https://<project>.supabase.co/rest/v1`). Accept the existing configuration
 * while always handing the SDK the project base URL it requires.
 */
export function toSupabaseProjectUrl(configuredUrl: string): string {
  const trimmed = configuredUrl.trim();
  if (!trimmed) return "";

  try {
    const url = new URL(trimmed);
    const path = url.pathname.replace(/\/+$/, "").toLowerCase();
    if (path === "/rest/v1") {
      url.pathname = "/";
      url.search = "";
      url.hash = "";
      return url.href.replace(/\/$/, "");
    }
  } catch {
    // Keep invalid input intact; validation below reports it.
  }

  return trimmed;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/** True for the hosts where plain `http://` is acceptable (local Supabase). */
export function isLoopbackSupabaseHost(projectUrl: string): boolean {
  try {
    const host = new URL(projectUrl).hostname.toLowerCase();
    return LOOPBACK_HOSTS.has(host);
  } catch {
    return false;
  }
}

/** Returns the field-level problems with a configured project URL. */
export function inspectSupabaseUrl(configuredUrl: string): ConfigurationIssue[] {
  const raw = configuredUrl.trim();
  if (!raw) {
    return [{
      code: "SUPABASE_UNCONFIGURED",
      field: "VITE_SUPABASE_URL",
      severity: "fatal",
      message: "VITE_SUPABASE_URL is empty: this build has no backend to talk to.",
    }];
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return [{
      code: "SUPABASE_URL_INVALID",
      field: "VITE_SUPABASE_URL",
      severity: "fatal",
      message: "VITE_SUPABASE_URL is not an absolute URL.",
    }];
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return [{
      code: "SUPABASE_URL_INVALID",
      field: "VITE_SUPABASE_URL",
      severity: "fatal",
      message: `VITE_SUPABASE_URL must be http(s), not ${parsed.protocol.replace(":", "")}.`,
    }];
  }

  const projectUrl = toSupabaseProjectUrl(raw);
  if (parsed.protocol === "http:" && !isLoopbackSupabaseHost(projectUrl)) {
    return [{
      code: "SUPABASE_URL_INSECURE",
      field: "VITE_SUPABASE_URL",
      severity: "fatal",
      message:
        "VITE_SUPABASE_URL uses plain http for a non-local host: credentials and sales would travel unencrypted.",
    }];
  }

  if (/\/rest\/v1\/?$/i.test(parsed.pathname)) {
    return [{
      code: "SUPABASE_URL_LEGACY_REST",
      field: "VITE_SUPABASE_URL",
      severity: "warning",
      message:
        "VITE_SUPABASE_URL points at the REST endpoint; it is normalised to the project URL, but the project URL is what should be configured.",
    }];
  }

  return [];
}

/* ── anon key ────────────────────────────────────────────────────────────── */

function decodeBase64Url(value: string): string {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const withPadding = padded.padEnd(Math.ceil(padded.length / 4) * 4, "=");
  // `atob` exists in browsers, in jsdom and in Node ≥16. The fallback keeps the
  // module usable in a bare Node context (the release probe imports it).
  if (typeof globalThis.atob === "function") return globalThis.atob(withPadding);
  /* istanbul ignore next -- Node always has atob in the supported runtimes. */
  return Buffer.from(withPadding, "base64").toString("binary");
}

function decodeJwtPayload(key: string): Record<string, unknown> | null {
  const parts = key.split(".");
  if (parts.length !== 3) return null;
  try {
    const json = decodeBase64Url(parts[1]);
    const payload = JSON.parse(json);
    return payload && typeof payload === "object" ? (payload as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * The anon key is public *by design* but the service-role key is not, and
 * pasting the wrong one into a `VITE_*` variable is the classic way to ship a
 * full-database key to every browser. This is the last line that can catch it:
 * a `service_role` JWT claim or one of Supabase's new `sb_secret_` keys is a
 * fatal configuration error, never a warning.
 */
export function inspectSupabaseAnonKey(anonKey: string): ConfigurationIssue[] {
  const key = anonKey.trim();
  if (!key) {
    return [{
      code: "SUPABASE_UNCONFIGURED",
      field: "VITE_SUPABASE_ANON_KEY",
      severity: "fatal",
      message: "VITE_SUPABASE_ANON_KEY is empty: this build has no backend credential.",
    }];
  }

  if (/^sb_secret_/i.test(key)) {
    return [{
      code: "ANON_KEY_LOOKS_SECRET",
      field: "VITE_SUPABASE_ANON_KEY",
      severity: "fatal",
      message:
        "VITE_SUPABASE_ANON_KEY holds a Supabase secret key (sb_secret_…). Secret keys bypass row-level security and must never enter a browser build.",
    }];
  }

  if (/service[_-]?role/i.test(key)) {
    return [{
      code: "ANON_KEY_LOOKS_SECRET",
      field: "VITE_SUPABASE_ANON_KEY",
      severity: "fatal",
      message:
        "VITE_SUPABASE_ANON_KEY names the service_role role. That key bypasses row-level security and must never enter a browser build.",
    }];
  }

  const payload = decodeJwtPayload(key);
  if (payload) {
    const role = typeof payload.role === "string" ? payload.role : "";
    if (role === "service_role") {
      return [{
        code: "ANON_KEY_LOOKS_SECRET",
        field: "VITE_SUPABASE_ANON_KEY",
        severity: "fatal",
        message:
          "VITE_SUPABASE_ANON_KEY carries a service_role JWT claim. Replace it with the project's anon (publishable) key.",
      }];
    }
    if (role && role !== "anon") {
      return [{
        code: "ANON_KEY_INVALID",
        field: "VITE_SUPABASE_ANON_KEY",
        severity: "fatal",
        message: `VITE_SUPABASE_ANON_KEY belongs to the "${role}" role; only the anon (publishable) key is safe here.`,
      }];
    }
    return [];
  }

  // Supabase's current publishable keys and legacy anon JWTs are the two
  // shapes accepted here; anything else is treated as a malformed paste.
  if (/^sb_publishable_[\w.-]{10,}$/i.test(key)) return [];

  return [{
    code: "ANON_KEY_INVALID",
    field: "VITE_SUPABASE_ANON_KEY",
    severity: "fatal",
    message:
      "VITE_SUPABASE_ANON_KEY is neither a Supabase publishable key nor a JWT; check for a truncated or mis-pasted value.",
  }];
}

/* ── resolution ──────────────────────────────────────────────────────────── */

export interface AppModeInputs {
  /** Raw `VITE_APP_MODE` value, or undefined when the operator did not set it. */
  appMode?: string;
  supabaseUrl?: string;
  supabaseAnonKey?: string;
  /** Raw `VITE_DEMO_SEED` value, or undefined. */
  demoSeed?: string;
}

/**
 * Resolve the mode and every configuration problem in one pass. Pure: the app,
 * the tests and the release probe all call this with explicit inputs, so there
 * is exactly one implementation of the policy.
 */
export function resolveAppMode(inputs: AppModeInputs = {}): ResolvedAppMode {
  const issues: ConfigurationIssue[] = [];
  const rawMode = (inputs.appMode ?? "").trim().toLowerCase();
  const url = (inputs.supabaseUrl ?? "").trim();
  const key = (inputs.supabaseAnonKey ?? "").trim();
  const demoSeed = (inputs.demoSeed ?? "").trim().toLowerCase();

  // ── the mode is a declaration, not a guess ────────────────────────────────
  // Every build states which artifact it is. Anything else — missing, empty,
  // misspelt — stops here, because the alternative is a release that cannot be
  // told apart from an evaluation copy.
  const known = (APP_MODE_VALUES as readonly string[]).includes(rawMode);
  const mode: AppMode = known ? (rawMode as AppMode) : "unset";
  const source: AppModeSource = known ? "explicit" : "unset";

  if (!known) {
    issues.push({
      code: rawMode ? "APP_MODE_UNKNOWN" : "APP_MODE_MISSING",
      field: "VITE_APP_MODE",
      severity: "fatal",
      message: rawMode
        ? `VITE_APP_MODE is "${rawMode}"; expected exactly one of ${APP_MODE_VALUES.join(" | ")}.`
        : "VITE_APP_MODE is not set. Every build must declare VITE_APP_MODE=production or VITE_APP_MODE=demo; there is no inference from the credentials, because a missing environment variable used to produce a demo artifact that looked live.",
    });
    return {
      mode,
      source,
      runnable: false,
      issues,
      supabase: { projectUrl: "", anonKey: "", configured: false },
    };
  }

  const credentialsPresent = url.length > 0 || key.length > 0;
  const credentialIssues = [...inspectSupabaseUrl(url), ...inspectSupabaseAnonKey(key)];

  // A missing pair is "unconfigured". A *partial* or malformed pair is always
  // fatal: that is the silent-typo case.
  // (An empty issue list means the configuration is COMPLETE and valid, so
  // `unconfigured` must require at least one finding.)
  const unconfigured = credentialIssues.length > 0
    && credentialIssues.every((issue) => issue.code === "SUPABASE_UNCONFIGURED");
  const partial = credentialsPresent && unconfigured;
  // "Malformed" means at least one *fatal* credential finding. A lone warning
  // (a legacy /rest/v1 URL, say) must not hide the usable configuration.
  const malformed = credentialsPresent && !unconfigured
    && credentialIssues.some((issue) => issue.severity === "fatal");

  if (mode === "production") {
    if (!credentialsPresent) {
      issues.push({
        code: "SUPABASE_UNCONFIGURED",
        field: "VITE_SUPABASE_URL",
        severity: "fatal",
        message:
          "Production mode requires VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY at build time; refusing to fall back to demo data.",
      });
    } else if (partial) {
      issues.push({
        code: "SUPABASE_INCOMPLETE",
        field: key.length ? "VITE_SUPABASE_URL" : "VITE_SUPABASE_ANON_KEY",
        severity: "fatal",
        message:
          "Production mode has only half a Supabase configuration. Set both VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY, or neither.",
      });
    } else if (malformed) {
      issues.push(...credentialIssues.filter((issue) => issue.severity === "fatal"));
    } else {
      issues.push(...credentialIssues);
    }
    if (demoSeed && demoSeed !== "off") {
      issues.push({
        code: "DEMO_SEED_NOT_DISABLED",
        field: "VITE_DEMO_SEED",
        severity: "warning",
        message: `VITE_DEMO_SEED is "${demoSeed}" in a production build; set it to "off".`,
      });
    }
  } else {
    // Explicit demo: the credentials, if any, are ignored — the app never
    // constructs a Supabase client in this mode. A malformed pair is therefore
    // reported, not fatal: nothing can use it. `describeAppMode()` keeps the
    // finding visible in diagnostics.
    if (credentialsPresent) {
      issues.push(...credentialIssues.map((issue) => ({ ...issue, severity: "warning" as const })));
    }
    if (credentialsPresent && !unconfigured && !malformed) {
      issues.push({
        code: "SUPABASE_CREDENTIALS_IGNORED",
        field: "VITE_APP_MODE",
        severity: "warning",
        message:
          "VITE_APP_MODE=demo: the configured Supabase credentials are ignored and the app runs on the local demo dataset.",
      });
    }
  }

  const fatal = issues.some((issue) => issue.severity === "fatal");
  const configured = mode === "production" && !fatal;

  return {
    mode,
    source,
    runnable: !fatal,
    issues,
    supabase: {
      projectUrl: configured ? toSupabaseProjectUrl(url) : "",
      anonKey: configured ? key : "",
      configured,
    },
  };
}

/**
 * True when a raw `VITE_APP_MODE` value names a buildable mode. Callers that
 * accept the value from a file or a flag (the dev launcher, the guard) use this
 * instead of re-listing the two strings.
 */
export function isDeclaredAppMode(raw: string | undefined | null): boolean {
  return (APP_MODE_VALUES as readonly string[]).includes((raw ?? "").trim().toLowerCase());
}

/** The app's own resolution, from the build-time environment. */
const env = (import.meta.env ?? {}) as Record<string, string | undefined>;

export const RESOLVED_APP_MODE: ResolvedAppMode = resolveAppMode({
  appMode: env.VITE_APP_MODE,
  supabaseUrl: env.VITE_SUPABASE_URL,
  supabaseAnonKey: env.VITE_SUPABASE_ANON_KEY,
  demoSeed: env.VITE_DEMO_SEED,
});

export const APP_MODE: AppMode = RESOLVED_APP_MODE.mode;
export const APP_MODE_SOURCE: AppModeSource = RESOLVED_APP_MODE.source;
export const CONFIGURATION_ISSUES: readonly ConfigurationIssue[] = RESOLVED_APP_MODE.issues;
export const FATAL_CONFIGURATION_ISSUES: readonly ConfigurationIssue[] =
  RESOLVED_APP_MODE.issues.filter((issue) => issue.severity === "fatal");

/** True when the app must show the configuration-error screen instead. */
export const STARTUP_BLOCKED = !RESOLVED_APP_MODE.runnable;

/** True when the app is allowed to use Supabase credentials at all. */
export const LIVE_BACKEND_AVAILABLE = RESOLVED_APP_MODE.supabase.configured;

/** Compact, credential-free description for diagnostics and the release probe. */
export function describeAppMode(resolved: ResolvedAppMode = RESOLVED_APP_MODE): string {
  return [
    `mode=${resolved.mode}`,
    `source=${resolved.source}`,
    `version=${RELEASE.version}`,
    `sha=${RELEASE.sha}`,
    `issues=${resolved.issues.length}`,
  ].join(" · ");
}

/** Issue codes only — safe to log, safe to send to a support channel. */
export function issueCodes(resolved: ResolvedAppMode = RESOLVED_APP_MODE): string[] {
  return resolved.issues.map((issue) => issue.code);
}
