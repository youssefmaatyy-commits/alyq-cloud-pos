/**
 * Operations Center (Phase 56).
 *
 * The claims under test:
 *   · notifications are stable, capability-filtered, and not invented
 *   · an in-flight Supabase probe is not "connected"
 *   · health and usage do not guess size, quota, or applied migrations
 *   · cleanup previews without writing, refuses protected and backup rows,
 *     and deletes only after the exact phrase and a fresh eligibility check
 *   · the shipped migration vocabulary matches the audit actions
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { AppError } from "@/modules/products/data/repository";
import { AUDIT_ACTIONS } from "@/modules/audit/types";
import { ar, en } from "@/lib/i18n/dictionary";
import { buildOperationalNotifications } from "../services/notifications";
import { collectMediaReferences, findOrphans, mergeSeenReferences, normalizeMediaKey } from "../services/mediaAudit";
import { applyCleanupPlan, buildCleanupPlan, isPastRetention, retentionCandidates } from "../services/cleanup";
import { buildHealthReport } from "../services/health";
import { buildUsageReport, sumRegisteredBytes } from "../services/usage";
import { commitCleanup } from "../services/operationsService";
import {
  CLEANUP_PHRASE,
  RETENTION_PHRASE,
  SHIPPED_LATEST_MIGRATION,
  SHIPPED_MIGRATION_COUNT,
  type MediaReference,
  type RegisteredFile,
} from "../types";

const tests: { name: string; fn: () => void | Promise<void> }[] = [];
function test(name: string, fn: () => void | Promise<void>) {
  tests.push({ name, fn });
}

const NOW = "2026-09-23T12:00:00.000Z";
const ALL = new Set([
  "view_inventory",
  "manage_online_orders",
  "process_return",
  "approve_shift_adjustment",
  "manage_website",
  "view_backups",
  "manage_settings",
  "run_health_check",
]);

function file(partial: Omit<Partial<RegisteredFile>, "kind"> & { id: string; path: string; kind: string }): RegisteredFile {
  return { bytes: 10, createdAt: "2026-01-01T00:00:00.000Z", ...partial } as RegisteredFile;
}

test("notification ids are stable and a second build does not append", () => {
  const snapshot = {
    stock: [{ id: "p1", quantity: 0, lowLevel: 2, tracked: true, active: true, updatedAt: NOW, label: "SKU-1" }],
    orders: [{ id: "o1", number: "ON-1", status: "pending", createdAt: NOW }],
    returns: [],
    shifts: [],
    promotions: [],
    stocktakes: [],
    backupStatus: null,
    backupAt: null,
    storageUsedBytes: null,
    storageWarningBytes: null,
    supabase: "ok" as const,
  };
  const first = buildOperationalNotifications(snapshot, ALL, NOW);
  const second = buildOperationalNotifications(snapshot, ALL, NOW);
  assert.deepEqual(first.map((row) => row.id), second.map((row) => row.id));
  assert.equal(first.filter((row) => row.kind === "out_of_stock").length, 1);
  assert.equal(first.filter((row) => row.kind === "online_order").length, 1);
});

test("a viewer only receives rows for capabilities they hold", () => {
  const rows = buildOperationalNotifications(
    {
      stock: [{ id: "p1", quantity: 1, lowLevel: 2, tracked: true, active: true, updatedAt: NOW, label: "SKU-1" }],
      orders: [{ id: "o1", number: "ON-1", status: "pending", createdAt: NOW }],
      returns: [{ id: "r1", number: "RT-1", refundStatus: "pending", createdAt: NOW }],
      shifts: [{ id: "s1", number: "SH-1", status: "closed", difference: 12, adjustmentApprovedAt: null, closedAt: NOW }],
      promotions: [{ id: "pr1", name: "Weekend", enabled: true, endsAt: "2026-09-25T00:00:00.000Z" }],
      stocktakes: [{ id: "st1", status: "counting", createdAt: NOW }],
      backupStatus: "overdue",
      backupAt: NOW,
      storageUsedBytes: 20,
      storageWarningBytes: 10,
      supabase: "unavailable",
    },
    new Set(["view_inventory"]),
    NOW,
  );
  assert.deepEqual(
    rows.map((row) => row.kind).sort(),
    ["low_stock", "stocktake_open"],
  );
});

test("warnings stay quiet when the fact is not actually a warning", () => {
  const rows = buildOperationalNotifications(
    {
      stock: [{ id: "p1", quantity: 9, lowLevel: 2, tracked: true, active: true, updatedAt: NOW, label: "SKU-1" }],
      orders: [{ id: "o1", number: "ON-1", status: "approved", createdAt: NOW }],
      returns: [{ id: "r1", number: "RT-1", refundStatus: "completed", createdAt: NOW }],
      shifts: [{ id: "s1", number: "SH-1", status: "closed", difference: 0, adjustmentApprovedAt: null, closedAt: NOW }],
      promotions: [{ id: "pr1", name: "Later", enabled: true, endsAt: "2026-12-01T00:00:00.000Z" }],
      stocktakes: [{ id: "st1", status: "finalized", createdAt: NOW }],
      backupStatus: "due",
      backupAt: NOW,
      storageUsedBytes: 5,
      storageWarningBytes: null,
      supabase: "pending",
    },
    ALL,
    NOW,
  );
  assert.deepEqual(rows, []);
});

test("an in-flight probe is not reported as connected", () => {
  const report = buildHealthReport({
    supabaseConfigured: true,
    supabaseReachable: null,
    backupStatus: null,
    backupCount: null,
    appliedMigrationCount: null,
    recentErrors: [],
    storageListing: "unavailable",
  });
  const supabase = report.find((fact) => fact.key === "supabase");
  assert.equal(supabase?.state, "unavailable");
  assert.notEqual(supabase?.detail, "Connected");
  const database = report.find((fact) => fact.key === "database");
  assert.equal(database?.state, "unavailable");
  assert.equal(database?.detail, "credentials");
  const migrations = report.find((fact) => fact.key === "migrations");
  assert.equal(migrations?.detail, `${SHIPPED_MIGRATION_COUNT} · ${SHIPPED_LATEST_MIGRATION}`);
});

test("usage does not invent database size or fill missing backup counts", () => {
  const report = buildUsageReport({
    products: 1,
    variants: 2,
    customers: 3,
    sales: 4,
    onlineOrders: 5,
    returns: 6,
    referencedImages: 7,
    backupFiles: null,
    orphanFiles: 0,
    registeredBytes: null,
  });
  assert.equal(report.databaseBytes, null);
  assert.equal(report.counts.backupFiles, null);
  assert.equal(sumRegisteredBytes([{ bytes: null }, { bytes: Number.NaN }]), null);
  assert.equal(sumRegisteredBytes([{ bytes: 4 }, { bytes: null }]), 4);
});

test("orphan matching requires every known location, and data urls are not files", () => {
  const references = collectMediaReferences({
    products: [{ id: "p1", image_url: "https://cdn.example/product-images/a.jpg", images: ["https://cdn.example/product-images/b.jpg?size=1"] }],
    variants: [{ id: "v1", image_url: "data:image/png;base64,AAAA" }],
    websiteUrls: [{ ownerId: "site", url: "https://cdn.example/brand/logo.png" }],
    backupIds: [{ id: "bak-1" }],
  });
  assert.equal(references.some((ref) => ref.url.startsWith("data:")), false);
  const files = [
    file({ id: "a", path: "https://cdn.example/product-images/a.jpg", kind: "product_image" }),
    file({ id: "gone", path: "https://cdn.example/product-images/gone.jpg", kind: "product_image" }),
    file({ id: "bak-1", path: "bak-1", kind: "backup_artifact" }),
  ];
  assert.deepEqual(findOrphans(files, references).map((row) => row.id), ["gone"]);
  const merged = mergeSeenReferences(files, references, NOW);
  assert.equal(merged.filter((row) => row.kind === "backup_artifact").length, 1);
  assert.equal(merged.some((row) => row.path.includes("logo.png")), true);
  assert.equal(mergeSeenReferences(merged, references, "2026-09-24T00:00:00.000Z").length, merged.length);
  assert.equal(normalizeMediaKey("https://cdn.example/product-images/b.jpg?size=1"), "https://cdn.example/product-images/b.jpg");
});

test("preview does not write, and protected or backup rows are refused", () => {
  const files = [
    file({ id: "sale", path: "sales/1", kind: "sale" }),
    file({ id: "bak", path: "backups/1", kind: "backup_artifact" }),
    file({ id: "keep", path: "https://cdn.example/keep.jpg", kind: "product_image" }),
    file({ id: "drop", path: "https://cdn.example/drop.jpg", kind: "product_image" }),
  ];
  const references: MediaReference[] = [{ location: "product", ownerId: "p", url: "https://cdn.example/keep.jpg" }];
  const before = JSON.stringify(files);
  const plan = buildCleanupPlan(files, references, ["sale", "bak", "keep", "drop", "missing"], NOW);
  assert.equal(JSON.stringify(files), before);
  assert.deepEqual(plan.items.map((item) => item.id), ["drop"]);
  assert.deepEqual(
    plan.refused.map((item) => item.reason).sort(),
    ["not_eligible", "protected", "referenced", "unknown"].sort(),
  );
  assert.match(plan.protectedNote, /backup snapshots/i);
});

test("confirm re-checks, requires the exact phrase, and leaves business rows", () => {
  const files = [
    file({ id: "drop", path: "https://cdn.example/drop.jpg", kind: "product_image" }),
    file({ id: "sale-row", path: "sales/9", kind: "sale" as RegisteredFile["kind"] }),
    file({ id: "young", path: "tmp/new", kind: "temporary", createdAt: NOW }),
  ];
  const plan = buildCleanupPlan(files, [], ["drop", "sale-row", "young"], NOW, 30);
  assert.throws(() => applyCleanupPlan(files, [], plan, "delete selected files", "cleanup", NOW), /CLEANUP_PHRASE_MISMATCH/);
  const applied = applyCleanupPlan(files, [], plan, CLEANUP_PHRASE, "cleanup", NOW);
  assert.deepEqual(applied.deleted.map((item) => item.id), ["drop"]);
  assert.deepEqual(applied.files.map((item) => item.id).sort(), ["sale-row", "young"]);
  assert.equal(isPastRetention(NOW, NOW, 30), false);
  assert.equal(isPastRetention("2026-01-01T00:00:00.000Z", NOW, 30), true);
});

test("retention offers only aged orphans and never backup artifacts", () => {
  const files = [
    file({ id: "old-temp", path: "tmp/old", kind: "temporary", createdAt: "2026-01-01T00:00:00.000Z" }),
    file({ id: "new-temp", path: "tmp/new", kind: "temporary", createdAt: NOW }),
    file({ id: "orphan", path: "https://cdn.example/old.jpg", kind: "website_media", createdAt: NOW }),
    file({ id: "bak", path: "backups/1", kind: "backup_artifact", createdAt: "2026-01-01T00:00:00.000Z" }),
    file({ id: "live", path: "https://cdn.example/live.jpg", kind: "product_image" }),
  ];
  const references: MediaReference[] = [{ location: "product", ownerId: "p", url: "https://cdn.example/live.jpg" }];
  const offered = retentionCandidates(files, references, NOW, 30).map((item) => item.id).sort();
  assert.deepEqual(offered, ["old-temp", "orphan"]);
  assert.throws(() => applyCleanupPlan(files, references, { items: [], refused: [], protectedNote: "" }, CLEANUP_PHRASE, "retention", NOW), /CLEANUP_PHRASE_MISMATCH/);
  const applied = applyCleanupPlan(
    files,
    references,
    { items: retentionCandidates(files, references, NOW, 30), refused: [], protectedNote: "" },
    RETENTION_PHRASE,
    "retention",
    NOW,
  );
  assert.deepEqual(applied.files.map((item) => item.id).sort(), ["bak", "live", "new-temp"]);
});

test("cleanup without manage_settings changes nothing", async () => {
  const files = [file({ id: "drop", path: "https://cdn.example/drop.jpg", kind: "product_image" })];
  const plan = buildCleanupPlan(files, [], ["drop"], NOW);
  await assert.rejects(
    () => commitCleanup({ files, references: [], plan, phrase: CLEANUP_PHRASE, mode: "cleanup", nowIso: NOW }),
    (error: unknown) => error instanceof AppError && error.code === "FORBIDDEN",
  );
  assert.equal(files.length, 1);
});

test("the cleanup vocabulary is shipped, labelled, and not a copy", () => {
  for (const action of ["operations.cleanup_executed", "operations.retention_applied"] as const) {
    assert.ok(AUDIT_ACTIONS.includes(action));
    const key = `audit.action.${action}` as keyof typeof en;
    assert.ok(en[key] && ar[key] && en[key] !== ar[key]);
  }
  const root = path.resolve(process.cwd());
  const sql = fs.readFileSync(path.join(root, "supabase/migrations/0057_operations_cleanup_audit.sql"), "utf8");
  assert.match(sql, /operations\.cleanup_executed/);
  assert.match(sql, /operations\.retention_applied/);
  assert.equal(SHIPPED_LATEST_MIGRATION, "0075_authoritative_inventory_adjustments.sql");
  assert.equal(SHIPPED_MIGRATION_COUNT, 75);
  const names = fs.readdirSync(path.join(root, "supabase/migrations")).filter((name) => name.endsWith(".sql"));
  assert.equal(names.length, SHIPPED_MIGRATION_COUNT);
});

let failed = 0;
for (const { name, fn } of tests) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`  ✗ ${name}`);
    console.error(error);
  }
}
if (failed > 0) {
  console.error(`${failed} operations tests failed`);
  process.exit(1);
}
console.log(`${tests.length}/${tests.length} operations tests passed`);
