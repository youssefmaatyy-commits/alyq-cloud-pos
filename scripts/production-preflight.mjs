#!/usr/bin/env node
/**
 * Local, read-only production pre-flight. It never opens a network or database
 * connection and never writes repository files. Run from a clean frozen SHA;
 * --allow-dirty exists only so the script itself can be validated before commit.
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const allowDirty = process.argv.includes("--allow-dirty");
const failures = [];
const passes = [];
const check = (ok, message) => (ok ? passes : failures).push(message);
const read = (name) => fs.readFileSync(path.join(root, name), "utf8");
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();

const pkg = JSON.parse(read("package.json"));
const lock = JSON.parse(read("package-lock.json"));
const cap = read("capacitor.config.ts");
const env = read(".env.example");
const operations = read("src/modules/operations/types.ts");

const status = git("status", "--porcelain");
check(allowDirty || status === "", allowDirty ? "dirty-tree check explicitly bypassed for development validation" : "Git worktree is clean");
check(pkg.version === "6.0.0" && lock.packages?.[""]?.version === pkg.version, "package and lockfile versions agree at 6.0.0");
check(pkg.build?.publish === null && pkg.build?.asar === true, "Desktop publishing is disabled and ASAR is enabled");
check(pkg.build?.appId === "eg.alyq.pos", "Desktop app ID is eg.alyq.pos");
check(/appId:\s*["']eg\.alyq\.management["']/.test(cap), "Mobile app ID is eg.alyq.management");
check(/webDir:\s*["']dist["']/.test(cap), "Capacitor packages the production dist directory");

const migrationDir = path.join(root, "supabase", "migrations");
const migrations = fs.readdirSync(migrationDir).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort();
const contiguous = migrations.every((name, index) => Number(name.slice(0, 4)) === index + 1);
check(migrations.length === 83 && contiguous && migrations.at(-1) === "0083_mobile_installations_and_push.sql", "migrations are contiguous 0001–0083");
check(/SHIPPED_MIGRATION_COUNT\s*=\s*83/.test(operations) && /0083_mobile_installations_and_push\.sql/.test(operations), "application schema constants match migration 0083");

const requiredEnv = ["VITE_SUPABASE_URL", "VITE_SUPABASE_ANON_KEY", "VITE_CURRENCY", "VITE_STOREFRONT_URL", "VITE_DEMO_SEED", "VITE_APP_VERSION", "VITE_BUILD_SHA"];
check(requiredEnv.every((name) => env.includes(name)), "all client-safe production variable names are documented");
check(!/^VITE_SUPABASE_URL=http:\/\/(localhost|127\.0\.0\.1)/m.test(env), "environment template has no active localhost backend");
check(!/^VITE_SUPABASE_ANON_KEY=\S+/m.test(env), "environment template contains no anon-key value");
check(!/VITE_[A-Z0-9_]*(SERVICE|SECRET|PASSWORD|PRIVATE)/.test(env), "no server secret is exposed through a VITE variable");

const requiredDocs = [
  "production-architecture.md", "production-environment.md", "supabase-production-checklist.md",
  "backup-restore.md", "release-builds.md", "hardware-acceptance.md", "staging-smoke-test.md",
  "go-live-runbook.md", "rollback-runbook.md", "go-no-go-checklist.md", "migration-plan.md",
  "security-review.md", "operations-readiness.md",
];
check(requiredDocs.every((name) => fs.existsSync(path.join(root, "docs", "production", name))), "production runbook set is complete");

const qaFixturePrefix = "ALYQ-" + "QA-"; // split so this guard does not match itself
const qaHits = git("grep", "-l", qaFixturePrefix, "--", ".").split("\n").filter(Boolean);
check(qaHits.length > 0 && qaHits.every((name) => name.startsWith("supabase/tests/")), "ALYQ-QA fixtures are isolated to explicit database tests");
check(!read("scripts/migrations.check.mjs").includes("FINAL_STORE_QA_FILE") || read("scripts/migrations.check.mjs").includes("runScenarios"), "Final Store QA is gated by explicit scenario execution");

const scanRoots = ["src", "desktop", "android", "ios", "public", "capacitor.config.ts"];
const files = [];
for (const entry of scanRoots) {
  const absolute = path.join(root, entry);
  if (!fs.existsSync(absolute)) continue;
  const walk = (target) => {
    const stat = fs.lstatSync(target);
    if (stat.isDirectory()) for (const child of fs.readdirSync(target)) walk(path.join(target, child));
    else if (stat.isFile() && stat.size < 8_000_000) files.push(target);
  };
  walk(absolute);
}
const artifactText = files.map((file) => {
  try { return fs.readFileSync(file, "utf8"); } catch { return ""; }
}).join("\n");
check(!/eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/.test(artifactText), "no JWT-like credential is present in shipped source");
check(!/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(artifactText), "no private signing key is present in shipped source");
check(!/(?:SUPABASE_SERVICE_ROLE_KEY|service[_-]?role[_-]?key)\s*[:=]\s*["'][A-Za-z0-9._-]{20,}/i.test(artifactText), "no assigned service-role credential is present in shipped source");

const trackedKeys = git("ls-files").split("\n").filter((name) => /\.(?:pem|p12|pfx|jks|keystore|mobileprovision)$/i.test(name));
check(trackedKeys.length === 0, "no signing/private-key artifact is tracked");
check(lock.packages?.["node_modules/brace-expansion"]?.version === "5.0.12", "brace-expansion security patch is locked at 5.0.12");

for (const message of passes) console.log(`✓ ${message}`);
for (const message of failures) console.error(`✗ ${message}`);
console.log(`\nProduction pre-flight: ${passes.length} passed, ${failures.length} failed`);
if (allowDirty) console.log("Note: --allow-dirty was used; rerun without it from the committed release SHA.");
process.exitCode = failures.length ? 1 : 0;
