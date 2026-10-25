#!/usr/bin/env node
/**
 * Generate version.json + releases/latest.json from package.json + build SHA.
 *
 * Runs as a Vite plugin so every deployment carries a manifest stamped with
 * the commit actually being built, and from the CLI
 * (`node scripts/generate-version-manifest.mjs`) to stamp dist/ manually.
 *
 * Generated files are written ONLY to the build output directory (dist/).
 * They are never written into the tracked public/ tree: a committed SHA can
 * never equal the merge commit that ends up deployed, which is exactly how
 * the manifest used to lag one (or more) commits behind. The tracked
 * public/ copies carry the non-SHA placeholder "development" and exist only
 * so the dev server can serve the routes; scripts/version-manifest.check.mjs
 * fails CI if a real SHA ever lands in them again.
 *
 * No network access. Never writes outside dist/.
 */
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  buildVersionManifest,
  resolveBuildSha,
} from "./lib/version-manifest.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

function currentGitHead() {
  try {
    return execSync("git rev-parse HEAD", { cwd: root, encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

export function currentVersionManifest() {
  const gitSha = resolveBuildSha(process.env, currentGitHead());
  return buildVersionManifest({
    version: pkg.version,
    gitSha,
    releasedAt: new Date().toISOString(),
  });
}

function writeManifestFiles(outDir, manifest) {
  fs.mkdirSync(path.join(outDir, "releases"), { recursive: true });
  const body = JSON.stringify(manifest, null, 2) + "\n";
  fs.writeFileSync(path.join(outDir, "version.json"), body);
  fs.writeFileSync(path.join(outDir, "releases", "latest.json"), body);
}

export function alyqVersionManifestPlugin() {
  let outDir = path.join(root, "dist");
  return {
    name: "alyq-version-manifest",
    configResolved(config) {
      outDir = path.resolve(config.root, config.build.outDir);
    },
    // closeBundle runs after Vite has written the bundle AND copied public/
    // into the output, so the generated manifest always wins over the
    // tracked placeholder copies.
    closeBundle() {
      const manifest = currentVersionManifest();
      writeManifestFiles(outDir, manifest);
      console.log(
        `[alyq-version-manifest] ${manifest.current.version} (${manifest.current.gitShaShort}) → ${path.relative(root, outDir)}/version.json + releases/latest.json`,
      );
    },
  };
}

// Allow direct invocation: node scripts/generate-version-manifest.mjs
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const manifest = currentVersionManifest();
  const outDir = path.join(root, "dist");
  writeManifestFiles(outDir, manifest);
  console.log(
    `[alyq-version-manifest] ${manifest.current.version} (${manifest.current.gitShaShort}) → dist/version.json + dist/releases/latest.json`,
  );
}
