#!/usr/bin/env node
/**
 * Regression checker for the version-manifest SHA defect.
 *
 * Fails (exit 1) when any of these regress:
 *  1. SHA resolution — CI/Vercel env (incl. VERCEL_GIT_COMMIT_SHA) must win
 *     over `git rev-parse HEAD`, which resolved to an obsolete commit
 *     (f5bd0dc, PR #20) on the live Vercel deployment.
 *  2. Tracked public/version.json + public/releases/latest.json must carry
 *     the "development" placeholder, never a real commit SHA — a committed
 *     SHA can never equal the merge commit that gets deployed.
 *  3. dist/version.json + dist/releases/latest.json (with --require-dist)
 *     must be identical, match package.json, and be stamped with the exact
 *     build commit (env-provided, or the local git HEAD as a fallback).
 *  4. Release identity — desktop/Android app IDs, the desktop config
 *     filename + userData location, the NSIS data-preservation policy and
 *     the Android version must not drift from package.json, so an upgrade
 *     never loses printer settings, register binding or app data.
 *
 *   node scripts/version-manifest.check.mjs                # 1, 2, 4 (+3 if dist/ exists)
 *   node scripts/version-manifest.check.mjs --require-dist # also fail when dist/ is missing
 *   node scripts/version-manifest.check.mjs --expect <sha> # pin the expected dist SHA
 */
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  COMMIT_SHA_PATTERN,
  RELEASE_HISTORY,
  SOURCE_MANIFEST_SHA,
  buildVersionManifest,
  resolveBuildSha,
  versionToBuildNumber,
} from "./lib/version-manifest.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const requireDist = args.includes("--require-dist");
const expectIndex = args.indexOf("--expect");
const expectedShaArg = expectIndex >= 0 ? args[expectIndex + 1] : null;

const failures = [];
const notes = [];
function check(label, condition, detail = "") {
  if (condition) notes.push(`  ✓ ${label}`);
  else failures.push(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
}
function readJson(rel) {
  return JSON.parse(fs.readFileSync(path.join(root, rel), "utf8"));
}
function readText(rel) {
  return fs.readFileSync(path.join(root, rel), "utf8");
}
function gitHead() {
  try {
    return execSync("git rev-parse HEAD", { cwd: root, encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

// ── 1. SHA-resolution unit checks ────────────────────────────────────────
console.log("SHA resolution");
check(
  "VERCEL_GIT_COMMIT_SHA wins over git HEAD (the live-site defect)",
  resolveBuildSha({ VERCEL_GIT_COMMIT_SHA: "a".repeat(40) }, "b".repeat(40)) === "a".repeat(40),
);
check(
  "GITHUB_SHA wins over git HEAD",
  resolveBuildSha({ GITHUB_SHA: "c".repeat(40) }, "b".repeat(40)) === "c".repeat(40),
);
check(
  "ALYQ_BUILD_SHA wins over every other source",
  resolveBuildSha(
    { ALYQ_BUILD_SHA: "d".repeat(40), GITHUB_SHA: "c".repeat(40), VERCEL_GIT_COMMIT_SHA: "a".repeat(40) },
    "b".repeat(40),
  ) === "d".repeat(40),
);
check(
  "git HEAD is the fallback when no env SHA is set",
  resolveBuildSha({}, "e".repeat(40)) === "e".repeat(40),
);
check(
  "no env and no git yields the development placeholder, not an empty SHA",
  resolveBuildSha({}, "") === SOURCE_MANIFEST_SHA,
);

// ── manifest builder checks ──────────────────────────────────────────────
console.log("Manifest builder");
const pkg = readJson("package.json");
const built = buildVersionManifest({
  version: pkg.version,
  gitSha: "f".repeat(40),
  releasedAt: "2026-01-01T00:00:00.000Z",
});
check("buildNumber derives from package.json version", built.current.buildNumber === versionToBuildNumber(pkg.version));
check("gitShaShort is the 7-char prefix", built.current.gitShaShort === "fffffff");
check("history matches the canonical RELEASE_HISTORY", JSON.stringify(built.history) === JSON.stringify(RELEASE_HISTORY));

// ── 2. Tracked source manifests must stay placeholder ────────────────────
console.log("Tracked source manifests (public/)");
const sourceVersion = readJson("public/version.json");
const sourceLatest = readJson("public/releases/latest.json");
check("public/version.json deep-equals public/releases/latest.json",
  JSON.stringify(sourceVersion) === JSON.stringify(sourceLatest));
check("tracked version matches package.json", sourceVersion.current?.version === pkg.version);
check(
  "tracked gitSha is the placeholder, never a real (inevitably stale) commit SHA",
  sourceVersion.current?.gitSha === SOURCE_MANIFEST_SHA && !COMMIT_SHA_PATTERN.test(sourceVersion.current?.gitSha ?? ""),
  `found "${sourceVersion.current?.gitSha}" — generated SHAs belong in dist/ only`,
);
check("tracked history matches RELEASE_HISTORY",
  JSON.stringify(sourceVersion.history) === JSON.stringify(RELEASE_HISTORY));

// ── 3. Built manifests ───────────────────────────────────────────────────
console.log("Built manifests (dist/)");
const distVersionPath = path.join(root, "dist", "version.json");
const distLatestPath = path.join(root, "dist", "releases", "latest.json");
if (!fs.existsSync(distVersionPath) || !fs.existsSync(distLatestPath)) {
  if (requireDist) failures.push("  ✗ dist/version.json + dist/releases/latest.json must exist (run `npm run build` first)");
  else notes.push("  · dist/ not built — built-manifest checks skipped (use --require-dist in CI)");
} else {
  const distVersion = readJson("dist/version.json");
  const distLatest = readJson("dist/releases/latest.json");
  check("dist/version.json deep-equals dist/releases/latest.json",
    JSON.stringify(distVersion) === JSON.stringify(distLatest));
  check("dist schemaVersion is 1", distVersion.schemaVersion === 1);
  check("dist version matches package.json", distVersion.current?.version === pkg.version);
  check("dist carries backend compatibility info", Boolean(distVersion.current?.backend));
  const distSha = distVersion.current?.gitSha ?? "";
  check("dist gitShaShort is the gitSha prefix", distVersion.current?.gitShaShort === distSha.slice(0, 7));

  const envSha = resolveBuildSha(process.env, "");
  const expectedSha = expectedShaArg || (envSha !== SOURCE_MANIFEST_SHA ? envSha : gitHead());
  if (expectedSha && COMMIT_SHA_PATTERN.test(expectedSha)) {
    check(
      "dist gitSha is exactly the build commit (not a lagging/foreign SHA)",
      distSha === expectedSha,
      `expected ${expectedSha}, found ${distSha}`,
    );
  } else {
    check("dist gitSha is a full commit SHA or the development placeholder",
      COMMIT_SHA_PATTERN.test(distSha) || distSha === SOURCE_MANIFEST_SHA,
      `found "${distSha}"`);
  }

  // The tracked placeholders must survive the build untouched: generation
  // writes to dist/ only, so a build never dirties the source tree.
  const afterBuild = readJson("public/version.json");
  check("building did not rewrite the tracked public/ manifests",
    afterBuild.current?.gitSha === SOURCE_MANIFEST_SHA);
}

// ── 4. Release identity (upgrade data-preservation) ──────────────────────
console.log("Release identity");
check("desktop appId is eg.alyq.pos", pkg.build?.appId === "eg.alyq.pos", `found ${pkg.build?.appId}`);
check("desktop productName is ALYQ POS", pkg.build?.productName === "ALYQ POS");
check("NSIS never deletes app data on uninstall", pkg.build?.nsis?.deleteAppDataOnUninstall === false);

const desktopMain = readText("desktop/main.mjs");
check("desktop config filename is desktop-config.v1.json",
  desktopMain.includes('CONFIG_FILE = "desktop-config.v1.json"'));
check("desktop config lives under the existing userData folder",
  desktopMain.includes('path.join(app.getPath("userData"), CONFIG_FILE)'));

const androidGradle = readText("android/app/build.gradle");
check("Android applicationId is eg.alyq.management",
  androidGradle.includes('applicationId "eg.alyq.management"'));
check("Android namespace is eg.alyq.management",
  androidGradle.includes('namespace = "eg.alyq.management"'));
check("Android versionName tracks package.json version",
  androidGradle.includes(`"${pkg.version}"`), `expected "${pkg.version}" in android/app/build.gradle`);

const capacitorConfig = readText("capacitor.config.ts");
check("Capacitor appId is eg.alyq.management", capacitorConfig.includes('appId: "eg.alyq.management"'));
check("Capacitor appName is ALYQ POS", capacitorConfig.includes('appName: "ALYQ POS"'));

// ── result ───────────────────────────────────────────────────────────────
console.log(notes.join("\n"));
if (failures.length > 0) {
  console.error(`\nversion-manifest check FAILED (${failures.length}):`);
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log("\nversion-manifest check OK");
