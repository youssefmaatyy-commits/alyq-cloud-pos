/**
 * Pure version-manifest logic shared by the Vite plugin, the CLI generator
 * and the regression checker (scripts/version-manifest.check.mjs).
 *
 * No filesystem, git or network access here — every input arrives as an
 * argument, so the checker can unit-test the SHA-resolution rules that used
 * to produce a stale manifest.
 *
 * Historical defect this module exists to prevent:
 * the generator used to (a) ignore VERCEL_GIT_COMMIT_SHA, falling back to
 * `git rev-parse HEAD` inside the Vercel build container — which resolved
 * to a long-obsolete commit (f5bd0dc, PR #20) on the live site — and
 * (b) write the generated manifest into the tracked public/ tree, whose
 * committed SHA could therefore never equal the merge commit that ended up
 * deployed. Both failure modes are now structurally impossible: build SHA
 * resolution prefers the CI/Vercel environment, and generated files are
 * written only to the build output (dist/), never to tracked sources.
 */

export const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/i;

/** Placeholder stored in the tracked public/ copies. Never a real SHA. */
export const SOURCE_MANIFEST_SHA = "development";

/** Environment variables that carry the build commit, in priority order. */
export const BUILD_SHA_ENV_VARS = [
  "ALYQ_BUILD_SHA",
  "GITHUB_SHA",
  "VERCEL_GIT_COMMIT_SHA",
  "VITE_BUILD_SHA",
];

/** Known historical releases. Must stay in step with src/lib/version/channels.ts. */
export const RELEASE_HISTORY = Object.freeze([
  { version: "6.0.0", releasedAt: "2026-10-21T00:00:00Z", gitSha: "540e36817b7ea8876489d35ec13e9895890291c7" },
  { version: "6.1.0", releasedAt: "2026-10-23T00:00:00Z", gitSha: "9ac222261603c1d444874e089636c9819010c43d" },
]);

const releaseNotesByVersion = {
  "6.1.0": {
    en: "Bug fixes and performance improvements. Printer 58/80mm presets preserved.",
    ar: "إصلاحات وتحسينات في الأداء. إعدادات الطابعة 58/80 مم محفوظة.",
  },
};

/**
 * Resolve the commit SHA a build should stamp into its manifest.
 * CI/Vercel-provided values win over a local `git rev-parse HEAD`, which
 * inside hosted build containers may describe a shallow/foreign checkout.
 */
export function resolveBuildSha(env = {}, gitHead = "") {
  for (const name of BUILD_SHA_ENV_VARS) {
    const value = typeof env[name] === "string" ? env[name].trim() : "";
    if (value) return value.slice(0, 40);
  }
  const head = typeof gitHead === "string" ? gitHead.trim() : "";
  return head ? head.slice(0, 40) : SOURCE_MANIFEST_SHA;
}

export function versionToBuildNumber(version) {
  const parts = String(version).split(".").map(Number);
  return (parts[0] || 0) * 10000 + (parts[1] || 0) * 100 + (parts[2] || 0);
}

export function buildVersionManifest({ version, gitSha, releasedAt }) {
  const sha = String(gitSha || SOURCE_MANIFEST_SHA);
  return {
    schemaVersion: 1,
    appName: "ALYQ POS",
    current: {
      version,
      buildNumber: versionToBuildNumber(version),
      minSupportedVersion: "6.0.0",
      gitSha: sha,
      gitShaShort: sha.slice(0, 7),
      releasedAt,
      releaseNotes: releaseNotesByVersion[version] ?? {
        en: `ALYQ POS ${version}`,
        ar: `أليق ${version}`,
      },
      channels: {
        web: { url: "https://alyq-store.vercel.app", available: true },
        windows: {
          url: `https://github.com/youssefmaatyy-commits/alyq-cloud-pos/releases/download/v${version}/ALYQ-POS-Setup-${version}-x64.exe`,
          sha256: null,
          sizeBytes: null,
          available: true,
          note: "Manual download; no silent install. Check SHA-256 before installing. / Manual download required; verify checksum.",
        },
        android: {
          url: `https://github.com/youssefmaatyy-commits/alyq-cloud-pos/releases/download/v${version}/ALYQ-POS-${version}.apk`,
          sha256: null,
          sizeBytes: null,
          available: false,
          reason: "APK channel pending signing key setup; use PWA on Android until APK is signed and published.",
        },
      },
      backend: {
        requiredMigration: "0099_notification_reliability_and_dispatch.sql",
        requiredMigrationCount: 99,
        minCompatibleMigration: "0091_health_and_factory_reset_repair.sql",
        minCompatibleMigrationCount: 91,
      },
    },
    history: RELEASE_HISTORY.map((entry) => ({ ...entry })),
  };
}
