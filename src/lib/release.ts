/**
 * Release identity — who built what, from which commit, in which mode.
 *
 * A deployed POS has to be able to answer "which build is this?" without a
 * terminal: support, the release probe and the go-live checklist all need the
 * same three facts (version, commit, build time) plus the mode the bundle was
 * compiled for. The values are inlined by Vite at build time
 * (`vite.config.ts` → `define`), so the browser never has to guess and nothing
 * is fetched from the network.
 *
 * Everything here is public and non-sensitive: the version from `package.json`,
 * the commit SHA, an ISO build timestamp and the resolved app mode. No
 * credential, URL or path is embedded.
 */

export interface ReleaseIdentity {
  /** Semantic application version (`package.json` `version`). */
  version: string;
  /** Full commit SHA the artifact was built from, or `unknown` outside Git. */
  sha: string;
  /** First 12 characters of `sha`, for compact display. */
  shortSha: string;
  /** ISO-8601 UTC build timestamp, or null when the build did not stamp one. */
  builtAt: string | null;
  /** `production` | `demo` | `unknown` when the bundle is older than this file. */
  mode: string;
  /** Populated by the build (`-dirty` when the worktree had uncommitted work). */
  dirty: boolean;
}

const env = (import.meta.env ?? {}) as Record<string, string | undefined>;

const version = (env.VITE_APP_VERSION ?? "").trim() || "0.0.0";
const sha = (env.VITE_BUILD_SHA ?? "").trim() || "unknown";
const builtAt = (env.VITE_BUILD_TIME ?? "").trim() || null;
const mode = (env.VITE_APP_MODE ?? "").trim().toLowerCase() || "unknown";
const dirty = /-dirty$/i.test(sha) || (env.VITE_BUILD_DIRTY ?? "").trim() === "true";

export const RELEASE: ReleaseIdentity = Object.freeze({
  version,
  sha,
  shortSha: sha === "unknown" ? "unknown" : sha.replace(/-dirty$/i, "").slice(0, 12),
  builtAt,
  mode,
  dirty,
});

/**
 * True when the bundle carries real release metadata. `npm run dev` and the
 * jsdom suites build without a SHA, and that is fine — the release probe is
 * what refuses to accept it for a published artifact.
 */
export const RELEASE_IS_STAMPED =
  RELEASE.version !== "0.0.0" && RELEASE.sha !== "unknown" && RELEASE.builtAt !== null;

/** One line, safe to log, copy into a bug report or print on a receipt. */
export function releaseLine(identity: ReleaseIdentity = RELEASE): string {
  const parts = [`v${identity.version}`];
  if (identity.sha !== "unknown") parts.push(identity.shortSha + (identity.dirty ? "+dirty" : ""));
  if (identity.builtAt) parts.push(identity.builtAt);
  if (identity.mode !== "unknown") parts.push(identity.mode);
  return parts.join(" · ");
}

/**
 * The JSON document a release publishes next to the app
 * (`dist/release.json`, produced by `vite.config.ts`). Kept here so the writer
 * and the reader agree on the shape.
 */
export function releaseManifest(identity: ReleaseIdentity = RELEASE): Record<string, string | boolean> {
  return {
    version: identity.version,
    sha: identity.sha,
    built_at: identity.builtAt ?? "",
    mode: identity.mode,
    dirty: identity.dirty,
  };
}
