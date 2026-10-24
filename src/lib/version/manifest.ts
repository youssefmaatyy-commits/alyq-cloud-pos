/**
 * Unified version manifest for ALYQ POS — single source of truth across all platforms.
 *
 * The manifest is generated at build time from package.json + git SHA and served as
 * /version.json (web/PWA) and /releases/latest.json (desktop/mobile channels).
 * Consumers never invent a version; they read the channel that matches their platform.
 */

export interface PlatformReleaseInfo {
  /** SemVer versionName (e.g. "6.1.0") */
  version: string;
  /** Numeric build number (versionCode / CFBundleVersion) */
  buildNumber: number;
  /** Minimum SemVer required to upgrade without data migration */
  minSupportedVersion: string;
  /** Short git SHA of the tagged commit */
  gitSha: string;
  /** ISO date of the release */
  releasedAt: string;
  /** Human-readable release notes (EN/AR) */
  releaseNotes: { en: string; ar: string };
  /** Channel availability per platform */
  channels: {
    web: { url: string; available: true } | { available: false; reason: string };
    windows: { url: string; sha256: string; sizeBytes: number; available: true } | { available: false; reason: string };
    android: { url: string; sha256: string; sizeBytes: number; available: true } | { available: false; reason: string };
  };
  /** Backend schema compatibility */
  backend: {
    /** Exact migration file that this release ships against */
    requiredMigration: string;
    requiredMigrationCount: number;
    /** Minimum migration that remains compatible (older servers still serve the app) */
    minCompatibleMigration: string;
    minCompatibleMigrationCount: number;
  };
}

export interface VersionManifest {
  schemaVersion: 1;
  appName: "ALYQ POS";
  current: PlatformReleaseInfo;
  history: Array<{ version: string; releasedAt: string; gitSha: string }>;
}

/**
 * Parse a release channel JSON (version.json or releases/latest.json) into typed manifest.
 * Returns null when the payload is not a valid version manifest — never throws for callers.
 */
export function parseManifest(raw: unknown): VersionManifest | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (r.schemaVersion !== 1) return null;
  if (typeof r.current !== "object" || !r.current) return null;
  const c = r.current as Record<string, unknown>;
  if (typeof c.version !== "string" || typeof c.gitSha !== "string") return null;
  if (typeof c.releasedAt !== "string" || typeof c.requiredMigration !== "string") {
    // tolerate both top-level and current.backend shapes for backwards compat probe
    const b = c.backend as Record<string, unknown> | undefined;
    if (!b || typeof b.requiredMigration !== "string") return null;
  }
  return raw as VersionManifest;
}

/**
 * Check if a manifest version is newer than the running app.
 * Returns: 1 = manifest newer, 0 = equal, -1 = manifest older, null = incomparable.
 */
export function manifestIsNewer(manifest: VersionManifest, runningVersion: string): number | null {
  const { compareVersions } = require_version_compare();
  return compareVersions(manifest.current.version, runningVersion);
}

function require_version_compare(): { compareVersions: (a: string, b: string) => number | null } {
  // Lazy so tests without releaseCheck installed still import manifest types.
  // In production this delegates to the canonical SemVer comparator.
  const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;
  function parse(v: string) {
    const m = SEMVER.exec(v.trim().replace(/^v/i, ""));
    if (!m) return null;
    return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] ? m[4].split(".") : null as string[] | null };
  }
  function compareVersions(a: string, b: string): number | null {
    const x = parse(a); const y = parse(b);
    if (!x || !y) return null;
    for (const k of ["major", "minor", "patch"] as const) { if (x[k] !== y[k]) return x[k] > y[k] ? 1 : -1; }
    if (x.pre === null || y.pre === null) return x.pre === y.pre ? 0 : x.pre === null ? 1 : -1;
    const len = Math.max(x.pre.length, y.pre.length);
    for (let i = 0; i < len; i++) {
      const xv = x.pre[i]; const yv = y.pre[i];
      if (xv === undefined || yv === undefined) return xv === yv ? 0 : xv === undefined ? -1 : 1;
      if (xv === yv) continue;
      const xn = /^\d+$/.test(xv); const yn = /^\d+$/.test(yv);
      if (xn && yn) return Number(xv) > Number(yv) ? 1 : -1;
      if (xn !== yn) return xn ? -1 : 1;
      return xv > yv ? 1 : -1;
    }
    return 0;
  }
  return { compareVersions };
}
