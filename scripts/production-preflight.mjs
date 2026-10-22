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
const webManifest = JSON.parse(read("public/mobile.webmanifest"));
const serviceWorker = read("public/alyq-sw.js");
const pushWorker = read("supabase/functions/alyq-push/index.ts");

const status = git("status", "--porcelain");
check(allowDirty || status === "", allowDirty ? "dirty-tree check explicitly bypassed for development validation" : "Git worktree is clean");
const supportedReleaseVersions = new Set(["6.0.0", "6.1.0-preview.1"]);
check(
  supportedReleaseVersions.has(pkg.version) && lock.packages?.[""]?.version === pkg.version,
  `package and lockfile versions agree at supported release ${pkg.version}`,
);
check(pkg.build?.publish === null && pkg.build?.asar === true, "Desktop publishing is disabled and ASAR is enabled");
check(pkg.build?.appId === "eg.alyq.pos", "Desktop app ID is eg.alyq.pos");
check(/appId:\s*["']eg\.alyq\.management["']/.test(cap), "Mobile app ID is eg.alyq.management");
check(/webDir:\s*["']dist["']/.test(cap), "Capacitor packages the production dist directory");

const migrationDir = path.join(root, "supabase", "migrations");
const migrations = fs.readdirSync(migrationDir).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort();
const contiguous = migrations.length > 0
  && migrations.every((name, index) => Number(name.slice(0, 4)) === index + 1);
const latestMigration = migrations.at(-1) ?? null;
const latestNumber = latestMigration ? Number(latestMigration.slice(0, 4)) : 0;
const shippedCount = operations.match(/SHIPPED_MIGRATION_COUNT\s*=\s*(\d+)/)?.[1];
const shippedLatest = operations.match(/SHIPPED_LATEST_MIGRATION\s*=\s*["']([^"']+)["']/)?.[1];
check(
  contiguous && latestNumber === migrations.length,
  `migrations are contiguous 0001–${String(latestNumber).padStart(4, "0")} (${migrations.length} files)`,
);
check(
  Number(shippedCount) === migrations.length && shippedLatest === latestMigration,
  `application schema constants match ${latestMigration ?? "the migration manifest"}`,
);

const resetRepairName = "0093_factory_reset_notification_cleanup_repair.sql";
const resetRepair = migrations.includes(resetRepairName)
  ? read(path.join("supabase", "migrations", resetRepairName))
  : "";
const repairDeletes = resetRepair.match(/\bdelete\s+from\b[\s\S]*?;/gi) ?? [];
check(
  repairDeletes.length > 0
    && repairDeletes.every((statement) => /\bwhere\b/i.test(statement))
    && repairDeletes.every((statement) => !/\bwhere\s+(?:\(\s*)?true\b/i.test(statement)),
  "0093 Factory Reset DELETEs are explicitly qualified without WHERE TRUE",
);
const cleanupOrder = [
  "notification_delivery_attempts",
  "notification_push_deliveries",
  "user_notification_inbox",
  "notification_outbox",
].map((table) => resetRepair.search(new RegExp(
  `delete\\s+from\\s+public\\.${table}\\s+where\\s+id\\s+is\\s+not\\s+null`,
  "i",
)));
check(
  cleanupOrder.every((index) => index >= 0)
    && cleanupOrder.every((index, position) => position === 0 || index > cleanupOrder[position - 1]),
  "0093 notification facts delete child-first through non-null primary-key domains",
);
check(
  /'migration','0093_factory_reset_notification_cleanup_repair\.sql'/i.test(resetRepair)
    && /'migration_count',93\b/i.test(resetRepair),
  "0093 database health contract reports its migration count and filename",
);

const requiredEnv = ["VITE_SUPABASE_URL", "VITE_SUPABASE_ANON_KEY", "WEB_PUSH_VAPID_PUBLIC_KEY", "VITE_CURRENCY", "VITE_STOREFRONT_URL", "VITE_DEMO_SEED", "VITE_APP_VERSION", "VITE_BUILD_SHA"];
check(requiredEnv.every((name) => env.includes(name)), "all client-safe production variable names are documented");
check(
  webManifest.name && webManifest.short_name && (webManifest.start_url === "/#/dashboard" || webManifest.start_url === "/#/mobile")
    && webManifest.display === "standalone" && webManifest.scope === "/"
    && Array.isArray(webManifest.icons)
    && ["192x192", "512x512"].every((size) => webManifest.icons.some((icon) => icon.sizes === size)),
  "PWA manifest is Home Screen installable with standalone ALYQ identity and required icons",
);
check(
  /notificationclick/.test(serviceWorker) && /notification_id/.test(serviceWorker)
    && !/route_key|entity_id|customer|payment|token/i.test(serviceWorker),
  "service worker displays privacy-safe Web Push and carries only opaque notification identity",
);
check(
  /env\("WEB_PUSH_VAPID_PRIVATE_KEY"\)/.test(pushWorker)
    && /env\("WEB_PUSH_SUBJECT"\)/.test(pushWorker)
    && !/VITE_WEB_PUSH_VAPID_PRIVATE_KEY|VITE_WEB_PUSH_SUBJECT/.test(env),
  "Web Push private VAPID configuration remains server-only",
);
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
check(!/(?:SUPABASE_SERVICE_ROLE_KEY|service[_-]?role[_-]?key)\s*[:=]\s*["'](?!test-only-)[A-Za-z0-9._-]{20,}/i.test(artifactText), "no assigned service-role credential is present in shipped source");

const trackedKeys = git("ls-files").split("\n").filter((name) => /\.(?:pem|p12|pfx|jks|keystore|mobileprovision)$/i.test(name));
check(trackedKeys.length === 0, "no signing/private-key artifact is tracked");
check(lock.packages?.["node_modules/brace-expansion"]?.version === "5.0.12", "brace-expansion security patch is locked at 5.0.12");

for (const message of passes) console.log(`✓ ${message}`);
for (const message of failures) console.error(`✗ ${message}`);
console.log(`\nProduction pre-flight: ${passes.length} passed, ${failures.length} failed`);
if (allowDirty) console.log("Note: --allow-dirty was used; rerun without it from the committed release SHA.");
process.exitCode = failures.length ? 1 : 0;
