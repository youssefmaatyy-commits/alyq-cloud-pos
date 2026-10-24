#!/usr/bin/env node
/**
 * Generate public/version.json + public/releases/latest.json from package.json + git SHA.
 * Runs as a Vite buildStart hook so every deployment carries a current,
 * cache-safe channel file that the PWA update poller and desktop panel can read.
 *
 * No network access. Never writes outside dist/ and public/.
 */
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const version = pkg.version;

let gitSha = process.env.GITHUB_SHA || process.env.VITE_BUILD_SHA || process.env.ALYQ_BUILD_SHA || "";
try {
  if (!gitSha) gitSha = execSync("git rev-parse HEAD", { cwd: root, encoding: "utf8" }).trim();
} catch { gitSha = "development"; }
const shortSha = gitSha.slice(0, 7);
const fullSha = gitSha.slice(0, 40);

// Release notes are intentionally minimal here — the GitHub Release body is canonical.
// The manifest carries short bilingual notes for the in-app banner.
const releaseNotesByVersion = {
  "6.1.0": {
    en: "Bug fixes and performance improvements. Printer 58/80mm presets preserved.",
    ar: "إصلاحات وتحسينات في الأداء. إعدادات الطابعة 58/80 مم محفوظة.",
  },
};

const manifest = {
  schemaVersion: 1,
  appName: "ALYQ POS",
  current: {
    version,
    buildNumber: versionToBuildNumber(version),
    minSupportedVersion: "6.0.0",
    gitSha: fullSha,
    gitShaShort: shortSha,
    releasedAt: new Date().toISOString(),
    releaseNotes: releaseNotesByVersion[version] ?? { en: `ALYQ POS ${version}`, ar: `أليق ${version}` },
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
  history: [
    { version: "6.0.0", releasedAt: "2026-10-21T00:00:00Z", gitSha: "540e36817b7ea8876489d35ec13e9895890291c7" },
    { version: "6.1.0", releasedAt: "2026-10-23T00:00:00Z", gitSha: "9ac222261603c1d444874e089636c9819010c43d" },
  ],
};

function versionToBuildNumber(v) {
  const parts = v.split(".").map(Number);
  return (parts[0] || 0) * 10000 + (parts[1] || 0) * 100 + (parts[2] || 0);
}

export function alyqVersionManifestPlugin() {
  return {
    name: "alyq-version-manifest",
    buildStart() {
      // Write to public/ so it is copied into dist/ by Vite
      const outDir = path.join(root, "public", "releases");
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(path.join(root, "public", "version.json"), JSON.stringify(manifest, null, 2) + "\n");
      fs.writeFileSync(path.join(outDir, "latest.json"), JSON.stringify(manifest, null, 2) + "\n");
      console.log(`[alyq-version-manifest] ${version} (${shortSha}) → public/version.json + public/releases/latest.json`);
    },
  };
}

// Allow direct invocation: node scripts/generate-version-manifest.mjs
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const outDir = path.join(root, "public", "releases");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(root, "public", "version.json"), JSON.stringify(manifest, null, 2) + "\n");
  fs.writeFileSync(path.join(outDir, "latest.json"), JSON.stringify(manifest, null, 2) + "\n");
  console.log(`[alyq-version-manifest] ${version} (${shortSha}) → public/version.json + public/releases/latest.json`);
}
