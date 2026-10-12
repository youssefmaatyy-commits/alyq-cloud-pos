/**
 * The release probe's pure logic.
 *
 * `scripts/release.probe.mjs` is the executable half; everything that can be
 * decided without a DOM or a socket lives here, so the release rules are
 * unit-testable (`src/lib/qa/__tests__/releaseProbe.selftest.ts`) and the probe
 * itself stays a thin driver.
 *
 * Two hard rules the probe exists to enforce:
 *
 *   1. **A published artifact is self-describing.** `release.json` must name the
 *      version, the commit, the build time and the mode, and a *production*
 *      deployment must say `production` with an explicitly requested mode —
 *      never a bundle that guessed, and never a demo bundle wearing a release
 *      number.
 *   2. **The probe never mutates anything.** Every check is a read: an HTTP GET,
 *      or a boot of the shipped bundle against a deliberately EMPTY catalogue
 *      in a scratch browser profile. An empty catalogue is the honest release
 *      smoke test — it proves the shop and the register survive having no data
 *      without creating a product, placing an order, or touching a customer.
 */

export type ProbeLevel = "pass" | "warn" | "fail";

export interface ProbeFinding {
  level: ProbeLevel;
  /** Stable id, e.g. `release.sha`, so CI logs can be grepped. */
  code: string;
  message: string;
}

export interface ReleaseManifest {
  version?: unknown;
  sha?: unknown;
  built_at?: unknown;
  dirty?: unknown;
  mode?: unknown;
  mode_source?: unknown;
  mode_requested?: unknown;
  currency?: unknown;
  schema_migration?: unknown;
  configuration_issues?: unknown;
}

export interface ReleaseExpectations {
  /** Exact version the release was cut at. */
  version?: string;
  /** Full commit SHA or a unique prefix (≥ 7 characters). */
  sha?: string;
  /** Mode the deployment claims. Defaults to `production`. */
  mode?: string;
  /** Require `mode_requested` to be set (a release build must be explicit). */
  requireExplicitMode?: boolean;
  /** Require `dirty` to be false (a release is built from a clean checkout). */
  requireClean?: boolean;
}

/** HTTP methods the probe is allowed to use. Everything else is a defect. */
export const PROBE_SAFE_METHODS = ["GET", "HEAD"] as const;

export function isMutatingMethod(method: string): boolean {
  const normalised = method.trim().toUpperCase();
  return !PROBE_SAFE_METHODS.includes(normalised as (typeof PROBE_SAFE_METHODS)[number]);
}

/**
 * The complete request plan for a remote probe. Building it here — instead of
 * calling `fetch` ad hoc — is what makes "the probe never mutates anything" a
 * property of the code rather than a promise in a comment.
 */
export function remoteProbePlan(origin: string): { url: string; method: "GET"; expect: { status: number; contentType?: RegExp } }[] {
  const base = origin.replace(/\/+$/, "");
  return [
    { url: `${base}/release.json`, method: "GET", expect: { status: 200, contentType: /json/ } },
    { url: `${base}/`, method: "GET", expect: { status: 200, contentType: /html/ } },
  ];
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** True for a commit SHA, or a `-dirty` suffix on one. */
export function isCommitSha(value: string): boolean {
  return /^[0-9a-f]{7,64}(-dirty)?$/i.test(value);
}

/**
 * Validate the release manifest. Findings are ordered: identity first, then the
 * mode claim, then cleanliness.
 */
export function inspectReleaseManifest(
  manifest: ReleaseManifest | null | undefined,
  expectations: ReleaseExpectations = {},
): ProbeFinding[] {
  const findings: ProbeFinding[] = [];
  const mode = expectations.mode ?? "production";

  if (!manifest || typeof manifest !== "object") {
    return [{ level: "fail", code: "release.missing", message: "release.json is missing or not an object" }];
  }

  const version = asString(manifest.version);
  const sha = asString(manifest.sha);
  const builtAt = asString(manifest.built_at);
  const declaredMode = asString(manifest.mode);
  const modeSource = asString(manifest.mode_source);
  const modeRequested = asString(manifest.mode_requested);

  findings.push(
    version && version !== "0.0.0"
      ? { level: "pass", code: "release.version", message: `version ${version}` }
      : { level: "fail", code: "release.version", message: "release.json carries no usable version" },
  );

  if (isCommitSha(sha)) {
    if (expectations.sha) {
      const expected = expectations.sha.replace(/-dirty$/, "");
      const actual = sha.replace(/-dirty$/, "");
      const matches = actual === expected || (expected.length >= 7 && actual.startsWith(expected));
      findings.push(matches
        ? { level: "pass", code: "release.sha", message: `commit ${sha} matches the expected release SHA` }
        : { level: "fail", code: "release.sha", message: `commit ${sha} is not the expected release commit ${expectations.sha}` });
    } else {
      findings.push({ level: "pass", code: "release.sha", message: `commit ${sha}` });
    }
  } else {
    findings.push({
      level: "fail",
      code: "release.sha",
      message: "release.json carries no commit SHA — the artifact cannot be traced back to a commit",
    });
  }

  const parsedBuiltAt = builtAt ? Date.parse(builtAt) : Number.NaN;
  findings.push(
    builtAt && !Number.isNaN(parsedBuiltAt)
      ? { level: "pass", code: "release.built_at", message: `built ${builtAt}` }
      : { level: "fail", code: "release.built_at", message: "release.json has no parseable built_at timestamp" },
  );

  findings.push(
    declaredMode === mode
      ? { level: "pass", code: "release.mode", message: `mode ${declaredMode}` }
      : {
          level: "fail",
          code: "release.mode",
          message: `expected mode ${mode}, found ${declaredMode || "(none)"} — a demo bundle must never be published as a release`,
        },
  );

  if (expectations.requireExplicitMode !== false) {
    findings.push(
      modeRequested
        ? { level: "pass", code: "release.mode_requested", message: `mode requested explicitly as ${modeRequested}` }
        : {
            level: "fail",
            code: "release.mode_requested",
            message:
              "release.json records no requested mode: this artifact was not built by a pipeline that declared what it is (a release build cannot infer its mode any more)",
          },
    );
  }

  if (expectations.requireClean !== false) {
    findings.push(
      manifest.dirty === false || manifest.dirty === "false"
        ? { level: "pass", code: "release.clean", message: "built from a clean worktree" }
        : {
            level: "fail",
            code: "release.clean",
            message: "release.json reports a dirty worktree — the artifact does not correspond to a commit",
          },
    );
  }

  findings.push(
    modeSource === "explicit"
      ? { level: "pass", code: "release.mode_source", message: "the artifact declares its mode explicitly" }
      : {
          level: expectations.requireExplicitMode === false ? "warn" : "fail",
          code: "release.mode_source",
          message: modeSource
            ? `mode source is "${modeSource}"; a shipped artifact must name VITE_APP_MODE explicitly`
            : "release.json does not record where its mode came from",
        },
  );

  const issues = Array.isArray(manifest.configuration_issues) ? manifest.configuration_issues : [];
  const fatalCodes = issues.filter((code) => /UNCONFIGURED|INVALID|INSECURE|LOOKS_SECRET|INCOMPLETE|UNKNOWN/.test(String(code)));
  if (fatalCodes.length > 0) {
    findings.push({
      level: "fail",
      code: "release.configuration",
      message: `release.json records blocking configuration issues: ${fatalCodes.join(", ")}`,
    });
  }

  return findings;
}

/* ── the empty-catalogue browser scene ───────────────────────────────────── */

/** Demo-storage keys that hold business facts the probe must not create. */
export const BUSINESS_STORAGE_PREFIXES = [
  "alyq.demo.sales.v1",
  "alyq.demo.sale_counter.v1",
  "alyq.demo.online_orders.v1",
  "alyq.demo.online_order_items.v1",
  "alyq.demo.customers.v1",
  "alyq.demo.store_customers.v1",
  "alyq.demo.returns.v1",
  "alyq.demo.refunds.v1",
  "alyq.demo.shifts.v1",
  "alyq.demo.expenses.v1",
  "alyq.demo.stock_movements.v1",
  "alyq.demo.stock_reservations.v1",
  "alyq.demo.audit_log.v1",
  "alyq.demo.approval_requests.v1",
  "alyq.store.cart.v2",
  "alyq.store.wishlist.v1",
  "alyq.store.recent.v1",
];

/**
 * Keys that legitimately change during a read-only walk of a fresh profile:
 * the catalogue/website documents are *seeded* on first boot by the demo
 * repository (that is the app constructing its own empty dataset, not the probe
 * writing business data), and the session key belongs to the probe's own
 * sign-in.
 */
export const PROBE_MUTABLE_ALLOWLIST = [
  // Documents the demo repository seeds on first boot.
  "alyq.demo.catalog.v1",
  "alyq.demo.website_settings.v1",
  "alyq.demo.storefront_category_contents.v1",
  "alyq.demo.product_contents.v1",
  "alyq.demo.store_session.v1",
  "alyq.demo.online_seeded.v1",
  "alyq.demo.delivery_zones.v1",
  "alyq.demo.promotions.v1",
  "alyq.demo.coupons.v1",
  "alyq.demo.campaigns.v1",
  "alyq.demo.promotion_targets.v1",
  "alyq.demo.promo_code_usages.v1",
  "alyq.demo.approval_rules.v1",
  "alyq.demo.store_faqs.v1",
  "alyq.demo.store_reviews.v1",
  "alyq.demo.branding.v1",
  // Runtime state: the probe's own sign-in, the shell's presentation choices,
  // the locale, the staff directory cache and the offline backup registry.
  // None of these is a business fact — a sale, an order, a return, a customer,
  // a shift, stock or the audit trail — which is what `isBusinessKey` guards.
  "alyq.auth.session.v1",
  "alyq.auth.recovery.used.v1",
  "alyq.auth.signal.v1",
  "alyq.identity.staff.v1",
  "alyq.identity.custom_roles.v1",
  "alyq.admin.sidebar.collapsed.v1",
  "alyq.lang",
  "alyq.backup.v1",
  "alyq.mobile.installation.v1",
  // The public settings document the storefront resolves on first boot: the
  // day-zero contact block, currency and theme, derived from the empty
  // installation. It is presentation, not a business fact.
  "alyq.storefront.public_settings.v2",
];

/**
 * Business-shaped keys whose *empty* form is still a browser artefact.
 *
 * Two of them are written simply by looking at the app, and neither carries a
 * business fact when it does:
 *
 *   - `alyq.store.cart.v2` is an empty basket — the shop keeps one document per
 *     visitor, and `lines: []` is nobody's order;
 *   - `alyq.demo.audit_log.v1` receives the probe's *own* `session.login` row.
 *     A session event is the probe's footprint, not a sale, a return or a stock
 *     movement.
 *
 * The rule is deliberately value-aware: the moment either document holds a real
 * row — a cart line, or an audit event that is not a session event — the diff
 * fails. A blanket allowlist would have blinded the probe to exactly the writes
 * it exists to catch.
 */
export const PROBE_EMPTY_CONTAINER_RULES: Record<string, (value: string | null) => boolean> = {
  "alyq.store.cart.v2": (value) => {
    if (value === null) return true; // an absent basket is an empty basket
    try {
      const parsed = JSON.parse(value) as { lines?: unknown };
      return Array.isArray(parsed?.lines) && parsed.lines.length === 0;
    } catch {
      return false;
    }
  },
  "alyq.demo.audit_log.v1": (value) => {
    if (value === null) return false; // deleting the trail is never "empty"
    try {
      const parsed = JSON.parse(value) as unknown;
      if (!Array.isArray(parsed)) return false;
      return parsed.every((row) => {
        const entity = typeof row === "object" && row !== null ? String((row as { entity?: unknown }).entity ?? "") : "";
        const action = typeof row === "object" && row !== null ? String((row as { action?: unknown }).action ?? "") : "";
        return entity === "session" || action.startsWith("session.");
      });
    } catch {
      return false;
    }
  },
};

/**
 * True when a key changed only into a value that carries no business fact —
 * either an explicitly empty container, or a document the allowlist covers.
 */
export function isProbeEmptyContainer(key: string, value: string | null | undefined): boolean {
  const rule = PROBE_EMPTY_CONTAINER_RULES[key];
  return rule ? rule(value ?? null) : false;
}

/** True when a storage key holds a business fact (a sale, an order, a return…). */
export function isBusinessKey(key: string): boolean {
  return BUSINESS_STORAGE_PREFIXES.some((prefix) => key === prefix || key.startsWith(`${prefix}.`));
}

/** True when a key is allowed to appear or change during the probe's walk. */
export function isProbeMutableKey(key: string): boolean {
  return PROBE_MUTABLE_ALLOWLIST.some((prefix) => key === prefix || key.startsWith(`${prefix}.`));
}

export interface StorageSnapshot {
  [key: string]: string;
}

export interface StorageDiff {
  created: string[];
  changed: string[];
  removed: string[];
}

/** Structural diff of two storage snapshots (keys plus values). */
export function diffStorage(before: StorageSnapshot, after: StorageSnapshot): StorageDiff {
  const created: string[] = [];
  const changed: string[] = [];
  const removed: string[] = [];
  for (const key of Object.keys(after)) {
    if (!(key in before)) created.push(key);
    else if (before[key] !== after[key]) changed.push(key);
  }
  for (const key of Object.keys(before)) {
    if (!(key in after)) removed.push(key);
  }
  return { created: created.sort(), changed: changed.sort(), removed: removed.sort() };
}

/**
 * Turn a storage diff into findings. A business key that appeared, changed or
 * disappeared during a read-only probe is a hard failure: the probe's whole
 * claim is that it observes without writing — unless the value it changed into
 * is provably empty (see `PROBE_EMPTY_CONTAINER_RULES`), which is why the
 * probe passes the *after* snapshot in when it has one.
 */
export function inspectStorageDiff(diff: StorageDiff, after?: StorageSnapshot): ProbeFinding[] {
  const findings: ProbeFinding[] = [];
  const touched = [...diff.created, ...diff.changed, ...diff.removed];
  const business = touched.filter((key) => {
    if (!isBusinessKey(key) || isProbeMutableKey(key)) return false;
    // Without the after-snapshot the probe cannot prove a value is empty, so it
    // stays strict. With one, a key that is absent counts as `null` — a removed
    // basket is still an empty basket, a removed audit trail is not.
    if (!after) return true;
    const present = Object.prototype.hasOwnProperty.call(after, key);
    return !isProbeEmptyContainer(key, present ? after[key] : null);
  });
  findings.push(business.length === 0
    ? { level: "pass", code: "probe.no_business_writes", message: "no sale, order, return, customer, shift or stock record was created or changed" }
    : {
        level: "fail",
        code: "probe.no_business_writes",
        message: `the probe wrote business data: ${business.join(", ")}`,
      });

  const unexpected = touched.filter((key) => !isProbeMutableKey(key) && !isBusinessKey(key));
  if (unexpected.length > 0) {
    findings.push({
      level: "warn",
      code: "probe.unexpected_storage",
      message: `storage keys changed outside the known seeding set: ${unexpected.join(", ")}`,
    });
  }
  return findings;
}

/** Network findings: any request during a demo-mode probe is a defect. */
export function inspectNetworkCalls(calls: readonly string[]): ProbeFinding[] {
  return calls.length === 0
    ? [{ level: "pass", code: "probe.no_network", message: "zero network requests during the local probe" }]
    : [{
        level: "fail",
        code: "probe.no_network",
        message: `the probe reached the network: ${calls.slice(0, 5).join(", ")}`,
      }];
}

/** Console findings: the app must be silent on an empty catalogue. */
export function inspectConsoleErrors(errors: readonly string[]): ProbeFinding[] {
  return errors.length === 0
    ? [{ level: "pass", code: "probe.no_console_errors", message: "no console errors on an empty catalogue" }]
    : [{
        level: "fail",
        code: "probe.no_console_errors",
        message: `console errors on an empty catalogue: ${errors.slice(0, 3).join(" | ")}`,
      }];
}

export function summarise(findings: readonly ProbeFinding[]): { failed: number; warned: number; passed: number; ok: boolean } {
  const failed = findings.filter((finding) => finding.level === "fail").length;
  const warned = findings.filter((finding) => finding.level === "warn").length;
  const passed = findings.filter((finding) => finding.level === "pass").length;
  return { failed, warned, passed, ok: failed === 0 };
}
