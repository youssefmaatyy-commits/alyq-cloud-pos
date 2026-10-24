/**
 * Release channel definitions — how each platform discovers its update.
 *
 * All channels are served from the same origin / GitHub Releases and declare
 * explicit availability so the UI never shows a ghost download link.
 */

export const CHANNEL_URLS = {
  /** Same-origin version manifest served by Vercel (no-store for index + version.json) */
  versionManifest: "/version.json",
  /** Same-origin desktop channel (generated at build / release) */
  desktopChannel: "/releases/latest.json",
  /** Android channel shares the same file */
  androidChannel: "/releases/latest.json",
  /** Canonical GitHub Releases page (fallback when same-origin channels unavailable) */
  githubReleases: "https://github.com/youssefmaatyy-commits/alyq-cloud-pos/releases/latest",
  /** GitHub Releases API for automated checks */
  githubReleasesApi: "https://api.github.com/repos/youssefmaatyy-commits/alyq-cloud-pos/releases/latest",
} as const;

// Known historical releases for the update UI and offline display.
export const RELEASE_HISTORY: Array<{ version: string; releasedAt: string; gitSha: string }> = [
  { version: "6.0.0", releasedAt: "2026-10-21T00:00:00Z", gitSha: "540e36817b7ea8876489d35ec13e9895890291c7" },
  { version: "6.1.0", releasedAt: "2026-10-23T00:00:00Z", gitSha: "9ac222261603c1d444874e089636c9819010c43d" },
];

// Minimum versions that remain supported (older clients show upgrade notice).
export const MIN_SUPPORTED_VERSIONS = {
  web: "6.0.0",
  windows: "6.0.0",
  android: "6.1.0",
} as const;
