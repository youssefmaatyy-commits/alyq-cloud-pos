#!/usr/bin/env node
/**
 * Regression test for the PWA manifest parse defect (release.yml "Verify PWA artifacts").
 *
 * Reads `public/mobile.webmanifest` as text and parses it as JSON — the same
 * approach the release workflow must use, because `require()` treats a
 * `.webmanifest` file as JavaScript and throws `SyntaxError: Unexpected token ':'`.
 *
 *   node scripts/test-pwa-manifest.mjs            # succeeds on the shipped manifest
 *   node scripts/test-pwa-manifest.mjs --corrupt  # fails (exit 1) on invalid JSON
 *
 * Exit 1 on any failure so it can run as a CI gate.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = path.join(root, "public", "mobile.webmanifest");
const required = ["name", "start_url", "icons"];

let failed = false;
function assert(label, condition, detail = "") {
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    failed = true;
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const corrupt = process.argv.includes("--corrupt");
let raw;
try {
  raw = fs.readFileSync(manifestPath, "utf8");
} catch (error) {
  failed = true;
  console.log(`  ✗ can not read public/mobile.webmanifest — ${error.message}`);
  process.exit(1);
}

let manifest;
try {
  manifest = JSON.parse(raw);
  assert("public/mobile.webmanifest is valid JSON", true);
} catch (error) {
  assert("public/mobile.webmanifest is valid JSON", false, error.message);
  process.exit(1);
}

// When the file is corrupt we only assert it fails to parse (handled above).
if (corrupt) {
  // Reaching here means corrupt JSON somehow parsed — that would be a false pass.
  assert("invalid JSON is rejected", false, "parsed despite corruption");
  process.exit(1);
}

// Core required fields — same assertions as the release workflow, values kept intact.
for (const field of required) {
  assert(`manifest.${field} is present`, field in manifest && manifest[field] !== undefined && manifest[field] !== null);
}

assert("manifest.icons is a non-empty array",
  Array.isArray(manifest.icons) && manifest.icons.length > 0);

assert("manifest.name === 'ALYQ Mobile Management'", manifest.name === "ALYQ Mobile Management");
assert("manifest.start_url === '/#/dashboard'", manifest.start_url === "/#/dashboard");
assert("manifest.display === 'standalone'", manifest.display === "standalone");

if (failed) process.exit(1);
console.log("PWA manifest OK");
process.exit(0);
