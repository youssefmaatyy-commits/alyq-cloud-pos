/**
 * Backup, recovery & data-safety self-test (Phase 18, headless).
 *
 * Run with:
 *   npx esbuild src/modules/backup/__tests__/logic.selftest.ts \
 *     --bundle --format=esm --platform=node --outfile=/tmp/alyq-backup.mjs && node /tmp/alyq-backup.mjs
 *
 * What is pinned here, and why each of these specifically:
 *
 *   · **the contract.** A document that does not say what it is, what version it
 *     is, or which mode made it cannot be refused politely — so the envelope, the
 *     file name and every refusal code are asserted by name.
 *   · **parity with migration 0029.** The table list, the restore exclusions, the
 *     capability grants and the audit vocabulary exist on both sides of the wire.
 *     Either side moving alone is the defect this catches: a table added to the
 *     schema and forgotten here would be silently missing from every snapshot.
 *   · **the permission split.** A manager may protect the installation and may not
 *     replace it or carry it out. That is the whole design of the phase in one
 *     test, and it is asserted through the service — the layer that actually
 *     refuses — rather than through the role matrix alone.
 *   · **the restore round trip.** Data is seeded, snapshotted, damaged, restored,
 *     and compared. A restore that "succeeds" without bringing the row back is
 *     the failure mode nobody would notice until they needed it.
 *   · **the refusals change nothing.** A wrong confirmation word, two sources at
 *     once, no source, and a document from the other mode are each refused *and*
 *     leave the stores as they were — the offline equivalent of the transaction
 *     the database gives for free.
 *   · **the health check finds what was broken**, with the severity and the code
 *     the report promises, and says what it examined when it finds nothing.
 *   · **every finding has words** in English and Arabic, so a report never renders
 *     a key to an operator.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { ar, en } from "@/lib/i18n/dictionary";
import {
  CAPABILITIES,
  ROLE_CAPABILITIES,
  capabilitiesOf,
  type AppRole,
} from "@/lib/permissions/roles";
import {
  CAPABILITY_GROUPS,
  CAPABILITY_ACTIONS,
  capabilityHintKey,
  capabilityLabelKey,
  groupOfCapability,
} from "@/lib/permissions/catalog";
import { capabilityForPath } from "@/lib/permissions/routes";
import { SENSITIVE_ACTIONS } from "@/lib/permissions/actions";
import { createSession, signOut } from "@/lib/auth/services/authService";
import {
  primeCacheFromStorage,
  resetSessionCache,
  writeStoredSession,
} from "@/lib/auth/services/sessionStore";
import { DEMO_USERS } from "@/lib/auth/demoUsers";
import { AUDIT_ACTIONS, AUDIT_ENTITIES } from "@/modules/audit/types";
import { AppError } from "@/modules/products/data/repository";
import { buildDemoCategories, buildDemoProducts } from "@/modules/products/data/demoSeed";

import { DemoBackupRepository, getBackupMode, resetBackupRepositories } from "../data";
import {
  BACKUP_FORMAT,
  BACKUP_SCHEMA_VERSION,
  DEFAULT_BACKUP_SETTINGS,
  type BackupDocument,
  type BackupManifest,
  type BackupPayload,
} from "../types";
import {
  DEMO_RESTORE_EXCLUDED,
  DEMO_STORES,
  EXCLUDED_STORES,
  LIVE_RESTORE_EXCLUDED,
  LIVE_RESTORE_TABLES,
  LIVE_TABLES,
  LIVE_TABLES_DELETE_ORDER,
  backupFileName,
  buildDocument,
  describeDocument,
  parseBackupDocument,
  requiredKeys,
  serializeDocument,
  validateBackupDocument,
} from "../schema";
import {
  PERIOD_MS,
  backupStatus,
  formatBytes,
  isDue,
  nextDueAt,
  normalizeSettings,
  pruneCandidates,
} from "../services/schedule";
import { examinedCounts, healthModelFromDocument, runHealthChecks } from "../services/health";
import {
  RESTORE_CONFIRMATION,
  assertCanChangeBackupSchedule,
  assertCanCreateBackup,
  assertCanExportBackup,
  assertCanRestoreBackup,
  assertCanRunHealthCheck,
  assertCanViewBackups,
  automaticBackupIfDue,
  createBackup,
  describeBackupError,
  downloadBackup,
  healthReportFor,
  loadBackups,
  loadBackupSettings,
  loadStatus,
  restoreBackup,
  runHealthCheck,
  saveBackupSettings,
} from "../services/backupService";
import { assertCanRunEmergencyExport, exportEmergencyWorkbook } from "../services/emergencyExport";

type TestCase = { name: string; fn: () => void | Promise<void> };
const tests: TestCase[] = [];
const test = (name: string, fn: () => void | Promise<void>) => tests.push({ name, fn });

// ── harness ──────────────────────────────────────────────────────────────────

/**
 * Storage for a headless run.
 *
 * `window` is stubbed as well as `globalThis.localStorage`, because the offline
 * repository writes through `safeStorage`, which reads `window.localStorage`.
 * Without it every write would be dropped silently and these tests would pass
 * while asserting nothing.
 */
function installStorageStub(): Map<string, string> {
  const map = new Map<string, string>();
  const storage = {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
  };
  Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true });
  Object.defineProperty(globalThis, "sessionStorage", { value: storage, configurable: true });
  Object.defineProperty(globalThis, "window", {
    value: {
      localStorage: storage,
      sessionStorage: storage,
      addEventListener() {},
      removeEventListener() {},
      location: { reload() {} },
    },
    configurable: true,
    writable: true,
  });
  return map;
}

/**
 * The half of a browser `triggerDownload` needs, so a download can be asserted
 * rather than skipped. Nothing is written to disk: the anchor is a plain object
 * and the object URL is captured.
 */
const downloads: { filename: string; size: number }[] = [];
function installDownloadStub(): void {
  let pending = 0;
  const urlStatics = URL as unknown as {
    createObjectURL: (blob: Blob) => string;
    revokeObjectURL: (url: string) => void;
  };
  urlStatics.createObjectURL = (blob: Blob) => {
    pending = blob.size;
    return "blob:stub";
  };
  urlStatics.revokeObjectURL = () => {};
  const anchor = {
    href: "",
    download: "",
    rel: "",
    click() {
      downloads.push({ filename: this.download, size: pending });
    },
    remove() {},
  };
  (globalThis as { document?: unknown }).document = {
    createElement: () => anchor,
    body: { appendChild() {}, removeChild() {} },
  };
}

let store = new Map<string, string>();

function resetAll(actor: AppRole | null = "admin"): void {
  store = installStorageStub();
  installDownloadStub();
  downloads.length = 0;
  resetSessionCache();
  resetBackupRepositories();
  if (actor) signInAs(actor);
  else signOut();
}

function signInAs(role: AppRole): void {
  const record = DEMO_USERS.find((user) => user.role === role);
  assert.ok(record, `a demo account exists for ${role}`);
  writeStoredSession(createSession({ ...record, capabilities: capabilitiesOf(role) }, false), "local");
  resetSessionCache();
  primeCacheFromStorage();
}

/** Read what the offline repository wrote, without going through it. */
function readStore<T>(key: string): T | null {
  const raw = store.get(key);
  return raw ? (JSON.parse(raw) as T) : null;
}

function writeStore(key: string, value: unknown): void {
  store.set(key, JSON.stringify(value));
}

async function refusal(fn: () => unknown | Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (error) {
    return error instanceof AppError ? error.code : `not-an-AppError:${String(error)}`;
  }
}

function refusalSync(fn: () => void): string | null {
  try {
    fn();
    return null;
  } catch (error) {
    return error instanceof AppError ? error.code : `not-an-AppError:${String(error)}`;
  }
}

/**
 * The persisted trail.
 *
 * Read from storage rather than through `getDemoAuditRepository()`, whose
 * in-memory cache outlives a fresh storage stub — asserting on it would let one
 * test's entries answer for another's.
 */
async function auditActions(): Promise<string[]> {
  const entries = readStore<{ action: string }[]>("alyq.demo.audit_log.v1") ?? [];
  return entries.map((entry) => entry.action);
}

/** Repo root, found by walking up from cwd so the runner's location is irrelevant. */
function repoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 6; i += 1) {
    if (fs.existsSync(path.join(dir, "supabase/migrations"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("could not locate the repository root from " + process.cwd());
}

const migration = fs.readFileSync(
  path.join(repoRoot(), "supabase/migrations/0029_backup_and_recovery.sql"),
  "utf8",
);

// ── fixtures ─────────────────────────────────────────────────────────────────

const ACTOR = { id: "u-admin", name: "Amina Admin" };
const NOW = new Date("2026-09-12T09:00:00.000Z");

function demoPayload(): BackupPayload {
  // Every allowlisted store is present. An absent key is how a document says "I
  // was not given this table", and validation refuses it as incomplete — which is
  // right for a real snapshot and wrong for a fixture that simply has no returns
  // yet. `null` is the honest value for a store that was empty on the day.
  const stores: Record<string, unknown> = Object.fromEntries(
    DEMO_STORES.map((key) => [key, null]),
  );
  Object.assign(stores, {
      "alyq.demo.catalog.v1": {
        categories: [{ id: "cat-1", name_ar: "مشروبات", name_en: "Beverages" }],
        products: [
          {
            id: "p-1",
            sku: "WTR-1",
            name_ar: "ماء",
            name_en: "Water",
            category_id: "cat-1",
            selling_price: 10,
            cost_price: 5,
            stock_quantity: 40,
          },
        ],
      },
      "alyq.demo.customers.v1": [{ id: "c-1", name: "Hoda", phone: "01000000001" }],
      "alyq.demo.sales.v1": [
        {
          id: "s-1",
          invoice_number: "INV-0001",
          created_at: NOW.toISOString(),
          customer_id: "c-1",
          total: 20,
          status: "completed",
          items: [
            { id: "si-1", sale_id: "s-1", product_id: "p-1", quantity: 2, unit_price: 10, total: 20 },
          ],
          payments: [{ id: "pay-1", sale_id: "s-1", method: "cash", amount: 20 }],
        },
      ],
      "alyq.identity.staff.v1": [
        { id: "u-admin", username: "admin", name: "Amina Admin", role: "admin", active: true },
      ],
  });
  return { stores };
}

function demoDocument(overrides: Partial<Parameters<typeof buildDocument>[0]> = {}): BackupDocument {
  return buildDocument({
    mode: "demo",
    kind: "manual",
    note: "before the July price change",
    payload: demoPayload(),
    actor: ACTOR,
    now: NOW,
    ...overrides,
  });
}

function liveDocument(): BackupDocument {
  const tables: Record<string, unknown[]> = {};
  for (const table of LIVE_TABLES) tables[table] = [];
  tables.products = [{ id: "p-1", sku: "WTR-1", stock_quantity: 40 }];
  tables.profiles = [{ id: "u-admin", role: "admin", active: true }];
  return buildDocument({
    mode: "supabase",
    kind: "manual",
    note: null,
    payload: { tables },
    actor: ACTOR,
    now: NOW,
    checksum: "server-side-md5",
  });
}

function manifest(overrides: Partial<BackupManifest> = {}): BackupManifest {
  return {
    id: "bk-1",
    kind: "manual",
    note: null,
    mode: "demo",
    schema_version: BACKUP_SCHEMA_VERSION,
    created_at: NOW.toISOString(),
    created_by: ACTOR.id,
    created_by_name: ACTOR.name,
    size_bytes: 1024,
    row_count: 10,
    table_count: 30,
    checksum: "abc123",
    source_revision: null,
    ...overrides,
  };
}

/** Seed the offline stores with a small but real shop. */
function seedShop(): void {
  writeStore("alyq.demo.catalog.v1", {
    categories: buildDemoCategories(),
    products: buildDemoProducts(),
  });
  writeStore("alyq.demo.customers.v1", [
    { id: "c-1", name: "Hoda", phone: "01000000001", address: null, notes: null },
  ]);
  writeStore("alyq.demo.sales.v1", [
    {
      id: "s-1",
      invoice_number: "INV-0001",
      created_at: NOW.toISOString(),
      customer_id: "c-1",
      customer_name: "Hoda",
      subtotal: 20,
      discount: 0,
      total: 20,
      status: "completed",
      items: [
        {
          id: "si-1",
          sale_id: "s-1",
          product_id: "p-1",
          name_ar: "ماء",
          name_en: "Water",
          quantity: 2,
          unit_price: 10,
          total: 20,
        },
      ],
      payments: [{ id: "pay-1", sale_id: "s-1", method: "cash", amount: 20 }],
    },
  ]);
}

console.log("\nPhase 18 · backup, recovery & data safety");

// ── 1. the contract ─────────────────────────────────────────────────────────
test("the envelope says what it is, and its checksum moves with the payload", () => {
  const document = demoDocument();

  assert.equal(document.format, BACKUP_FORMAT);
  assert.equal(document.schema_version, BACKUP_SCHEMA_VERSION);
  assert.equal(document.mode, "demo");
  assert.equal(document.kind, "manual");
  assert.equal(document.note, "before the July price change");
  assert.equal(document.created_at, NOW.toISOString());
  assert.deepEqual(document.created_by, ACTOR);
  assert.equal(document.row_count, 5, "two catalog rows, a customer, a sale, a user");
  for (const key of DEMO_STORES) {
    assert.ok(key in document.counts, `${key} is accounted for`);
  }
  assert.equal(document.counts["alyq.demo.catalog.v1"], 2, "a category and a product");
  assert.equal(document.counts["alyq.demo.sales.v1"], 1);
  assert.equal(
    document.counts["alyq.demo.returns.v1"],
    0,
    "a store that held nothing is counted as empty, not missing",
  );
  assert.ok(document.size_bytes > 0, "the size is the payload's, not the envelope's");
  assert.match(document.checksum, /^[0-9a-f]{8}$/, "offline documents carry the FNV-1a hash");

  // The checksum is over the payload and nothing else: a different note is the
  // same data, and a different row is not.
  const renamed = demoDocument({ note: "a different label" });
  assert.equal(renamed.checksum, document.checksum, "a note is metadata, not data");
  const payload = demoPayload();
  (payload.stores!["alyq.demo.customers.v1"] as unknown[]).push({ id: "c-2" });
  const changed = demoDocument({ payload });
  assert.notEqual(changed.checksum, document.checksum, "one more customer is a different file");
});

test("the file name says what the file is", () => {
  const name = backupFileName(demoDocument());
  assert.match(name, /\.json$/, "a backup is a json document");
  assert.ok(name.includes("demo"), "the mode is in the name");
  assert.ok(name.includes("manual"), "the kind is in the name");
  assert.ok(name.includes("2026-09-12"), "the date is in the name");

  const live = backupFileName(liveDocument());
  assert.ok(live.includes("supabase") && !live.includes("demo"), "a live file is named as live");
  assert.notEqual(live, name);
});

test("a document survives serialization and comes back equal", () => {
  const document = demoDocument();
  const parsed = parseBackupDocument(serializeDocument(document));
  assert.equal(parsed.ok, true, `a good document parses (${parsed.ok ? "" : parsed.message})`);
  if (parsed.ok) {
    assert.deepEqual(parsed.document, document);
    assert.equal(parsed.document.checksum, document.checksum);
  }
  assert.ok(describeDocument(document).length > 0, "a document can be described in one line");
});

test("validation refuses, by name, everything an operator must not restore", () => {
  const good = demoDocument();

  assert.equal(parseBackupDocument("not json at all").ok, false);
  const notJson = parseBackupDocument("{");
  assert.equal(notJson.ok, false);
  if (!notJson.ok) assert.equal(notJson.code, "unparseable");

  const notObject = parseBackupDocument("[1,2,3]");
  assert.equal(notObject.ok, false, "an array parses but is not a backup");
  if (!notObject.ok) assert.equal(notObject.code, "bad_format");

  const wrongFormat = validateBackupDocument({ ...good, format: "someone-elses-backup" }, { mode: "demo" });
  assert.equal(wrongFormat.ok, false);
  if (!wrongFormat.ok) assert.equal(wrongFormat.code, "bad_format");

  const wrongVersion = validateBackupDocument({ ...good, schema_version: 99 }, { mode: "demo" });
  assert.equal(wrongVersion.ok, false);
  if (!wrongVersion.ok) assert.equal(wrongVersion.code, "bad_version");

  // The mode check is the one that stops an offline file being poured into a live
  // database, which would delete every table and fill none of them.
  const wrongMode = validateBackupDocument(good, { mode: "supabase" });
  assert.equal(wrongMode.ok, false);
  if (!wrongMode.ok) assert.equal(wrongMode.code, "mode_mismatch");

  const payload = demoPayload();
  delete payload.stores!["alyq.demo.sales.v1"];
  const incomplete = validateBackupDocument({ ...good, payload }, { mode: "demo" });
  assert.equal(incomplete.ok, false);
  if (!incomplete.ok) assert.equal(incomplete.code, "incomplete");

  const emptied = validateBackupDocument(
    buildDocument({
      mode: "demo",
      kind: "manual",
      note: null,
      payload: { stores: Object.fromEntries(requiredKeys("demo").map((key) => [key, []])) },
      actor: ACTOR,
      now: NOW,
    }),
    { mode: "demo" },
  );
  assert.equal(emptied.ok, false, "a document holding no rows at all is refused");
  if (!emptied.ok) assert.equal(emptied.code, "empty");

  const tampered = validateBackupDocument({ ...good, checksum: "00000000" }, { mode: "demo" });
  assert.equal(tampered.ok, false);
  if (!tampered.ok) assert.equal(tampered.code, "checksum_mismatch");

  // A live document's hash is the database's own md5, which no browser can
  // recompute. So the structure is checked here — every table present, the right
  // mode, the right version — and the hash is verified inside the restore
  // transaction by migration 0029, before anything is deleted.
  const live = liveDocument();
  assert.equal(
    validateBackupDocument(live, { mode: "supabase" }).ok,
    true,
    "a live document is structurally validated in the browser",
  );
  assert.equal(validateBackupDocument(live, { mode: "supabase", ignoreChecksum: true }).ok, true);
  const liveShort = validateBackupDocument({ ...live, payload: { tables: {} } }, { mode: "supabase" });
  assert.equal(liveShort.ok, false, "a live document missing its tables is refused here too");
  if (!liveShort.ok) assert.equal(liveShort.code, "incomplete");
});

test("the offline allowlist is the business, and the session is not in it", () => {
  for (const excluded of EXCLUDED_STORES) {
    assert.ok(!DEMO_STORES.includes(excluded), `${excluded} is never backed up`);
  }
  // A snapshot without these is not a snapshot of the shop.
  for (const required of [
    "alyq.demo.catalog.v1",
    "alyq.demo.sales.v1",
    "alyq.demo.customers.v1",
    "alyq.demo.stock_movements.v1",
    "alyq.demo.audit_log.v1",
    "alyq.identity.staff.v1",
    "alyq.identity.custom_roles.v1",
  ]) {
    assert.ok(DEMO_STORES.includes(required), `${required} is carried`);
  }
  // Whoever is signed in on this browser is a property of the browser, not of the
  // installation: restoring a snapshot must not sign anybody in or out.
  assert.ok(EXCLUDED_STORES.includes("alyq.auth.session.v1"));
  assert.ok(EXCLUDED_STORES.includes("alyq.lang"));
  assert.equal(new Set(DEMO_STORES).size, DEMO_STORES.length, "no store is listed twice");
});

// ── 2. parity with migration 0029 ───────────────────────────────────────────
test("the live table list agrees with the migration that reads it", () => {
  assert.equal(new Set(LIVE_TABLES).size, LIVE_TABLES.length, "no table is listed twice");
  assert.deepEqual(LIVE_TABLES_DELETE_ORDER, [...LIVE_TABLES].reverse(), "deletes run in reverse");

  const orderMatch = migration.match(/create or replace function public\.backup_table_order\(\)[\s\S]*?select array\[([\s\S]*?)\];/);
  assert.ok(orderMatch, "migration 0029 defines backup_table_order()");
  const sqlTables = [...orderMatch[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  assert.deepEqual(sqlTables, [...LIVE_TABLES], "the SQL array is this list, in this order");

  const excludeMatch = migration.match(/where t <> all \(array\[([^\]]*)\]\)/);
  assert.ok(excludeMatch, "migration 0029 states which tables a restore leaves alone");
  const sqlExcluded = [...excludeMatch[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  assert.deepEqual(sqlExcluded.slice().sort(), [...LIVE_RESTORE_EXCLUDED].sort());
  assert.deepEqual(
    LIVE_RESTORE_TABLES,
    LIVE_TABLES.filter((table) => !LIVE_RESTORE_EXCLUDED.includes(table)),
    "the restore list is the snapshot list minus the exclusions",
  );
  // The audit log is append-only by trigger, so a restore may carry it but may
  // not replace it; the vocabulary tables belong to the migrations.
  for (const excluded of ["audit_log", "role_capabilities", "audit_actions", "role_aliases"]) {
    assert.ok(LIVE_RESTORE_EXCLUDED.includes(excluded), `${excluded} is never rewritten by a restore`);
    assert.ok(LIVE_TABLES.includes(excluded), `${excluded} is still in the snapshot`);
  }
});

test("the migration grants what the matrix grants, and names what the app can emit", () => {
  const granted = new Map<string, string[]>();
  for (const [, role, capability] of migration.matchAll(
    /\(\s*'(admin|manager|cashier|inventory_clerk|viewer)',\s*'([a-z_]+)'\s*\)/g,
  )) {
    granted.set(role, [...(granted.get(role) ?? []), capability]);
  }

  const phase18 = ["view_backups", "create_backup", "restore_backup", "export_backup", "run_health_check"];
  for (const capability of phase18) {
    assert.ok((CAPABILITIES as readonly string[]).includes(capability), `${capability} is a capability`);
    for (const role of Object.keys(ROLE_CAPABILITIES) as AppRole[]) {
      const inMatrix = capabilitiesOf(role).includes(capability as never);
      const inSql = (granted.get(role) ?? []).includes(capability);
      assert.equal(inSql, inMatrix, `${role}/${capability}: the migration and the matrix agree`);
    }
  }

  // The shape of the split, stated where it can fail: a manager protects the
  // installation and does not replace it or carry it out.
  assert.deepEqual(
    phase18.filter((capability) => capabilitiesOf("manager").includes(capability as never)).sort(),
    ["create_backup", "run_health_check", "view_backups"],
  );
  assert.equal(capabilitiesOf("cashier").filter((c) => phase18.includes(c)).length, 0);
  assert.equal(capabilitiesOf("viewer").filter((c) => phase18.includes(c)).length, 0);
  assert.equal(capabilitiesOf("inventory_clerk").filter((c) => phase18.includes(c)).length, 0);

  const verbs = [
    "backup.created",
    "backup.downloaded",
    "backup.settings_changed",
    "restore.started",
    "restore.completed",
    "restore.failed",
    "health.check_run",
  ];
  for (const action of verbs) {
    assert.ok((AUDIT_ACTIONS as readonly string[]).includes(action), `${action} is in the app's vocabulary`);
    assert.ok(
      new RegExp(`\\('${action.replace(".", "\\.")}',\\s*'backup'\\)`).test(migration),
      `${action} is seeded by the migration`,
    );
  }
  assert.ok((AUDIT_ENTITIES as readonly string[]).includes("backup"), "a backup is a record type");
});

test("the five capabilities are grantable, labelled and grouped", () => {
  const phase18 = ["view_backups", "create_backup", "restore_backup", "export_backup", "run_health_check"];
  for (const capability of phase18) {
    assert.equal(groupOfCapability(capability as never)?.key, "data_safety", `${capability} is in one group`);
    assert.ok(CAPABILITY_ACTIONS[capability as never], `${capability} has a verb`);
    const label = capabilityLabelKey(capability as never);
    const hint = capabilityHintKey(capability as never);
    const denied = `permissions.denied.${capability}`;
    for (const key of [label, hint, denied]) {
      assert.ok(en[key as keyof typeof en], `en labels ${key}`);
      assert.ok(ar[key as keyof typeof ar], `ar labels ${key}`);
    }
  }
  const group = CAPABILITY_GROUPS.find((entry) => entry.key === "data_safety");
  assert.ok(group, "the picker has a data-safety section");
  assert.deepEqual([...(group?.capabilities ?? [])].sort(), phase18.slice().sort());
  assert.ok(en["permissions.group.data_safety"] && ar["permissions.group.data_safety"]);

  // Every capability is in exactly one group — the check that catches a
  // capability added to roles.ts and forgotten in the catalogue, where it would
  // be ungrantable from the Permission Builder and silently so.
  const grouped = CAPABILITY_GROUPS.flatMap((entry) => entry.capabilities as readonly string[]);
  assert.equal(new Set(grouped).size, grouped.length, "no capability is in two groups");
  assert.deepEqual(grouped.slice().sort(), [...CAPABILITIES].slice().sort(), "the groups partition the matrix");
});

test("the panel is a gated route, and the acts are registered", () => {
  assert.equal(capabilityForPath("/settings/backup"), "view_backups");

  const keys = ["backup.view", "backup.create", "backup.restore", "backup.export", "backup.health_check", "backup.schedule", "backup.emergency_export"];
  for (const key of keys) {
    const action = SENSITIVE_ACTIONS.find((entry) => entry.key === key);
    assert.ok(action, `${key} is in the sensitive-action register`);
    const source = fs.readFileSync(path.join(repoRoot(), action!.file), "utf8");
    assert.ok(
      new RegExp(`export function ${action!.guard}\\b`).test(source),
      `${key}: ${action!.file} exports ${action!.guard}()`,
    );
    assert.ok(
      new RegExp(`assertSensitiveAction\\("${key}"\\)`).test(source),
      `${key}: ${action!.guard}() really asserts that key`,
    );
  }
});

// ── 3. the schedule ─────────────────────────────────────────────────────────
test("the schedule knows when a snapshot is due", () => {
  const daily = normalizeSettings({ frequency: "daily", retention_days: 30, retention_count: 14 });

  assert.equal(nextDueAt({ ...daily, frequency: "off" }, NOW), null, "off never comes due");
  // Nothing has run yet, so one is due now: a fresh installation should not have
  // to wait a day to be protected.
  const first = nextDueAt({ ...daily, last_automatic_at: null }, NOW);
  assert.ok(first && first.getTime() <= NOW.getTime(), "the first snapshot is due immediately");

  const justRan = nextDueAt({ ...daily, last_automatic_at: NOW.toISOString() }, NOW);
  assert.equal(justRan?.getTime(), NOW.getTime() + PERIOD_MS.daily, "daily means one day later");

  const weekly = normalizeSettings({ ...daily, frequency: "weekly" });
  assert.equal(
    nextDueAt({ ...weekly, last_automatic_at: NOW.toISOString() }, NOW)?.getTime(),
    NOW.getTime() + PERIOD_MS.weekly,
    "weekly means seven days later",
  );

  assert.equal(isDue({ ...daily, last_automatic_at: NOW.toISOString() }, NOW), false);
  assert.equal(
    isDue({ ...daily, last_automatic_at: new Date(NOW.getTime() - PERIOD_MS.daily - 1000).toISOString() }, NOW),
    true,
  );
});

test("settings are clamped rather than believed", () => {
  assert.equal(normalizeSettings(null).frequency, DEFAULT_BACKUP_SETTINGS.frequency);
  assert.equal(normalizeSettings({ frequency: "hourly" }).frequency, "daily", "an unknown frequency is the default");
  assert.equal(normalizeSettings({ frequency: "off" }).frequency, "off", "off is a choice, not a mistake");
  assert.equal(normalizeSettings({ retention_days: 0 }).retention_days, DEFAULT_BACKUP_SETTINGS.retention_days);
  assert.equal(normalizeSettings({ retention_days: -5 }).retention_days, DEFAULT_BACKUP_SETTINGS.retention_days);
  assert.equal(normalizeSettings({ retention_days: 99999 }).retention_days, 3650, "ten years is the ceiling");
  assert.equal(normalizeSettings({ retention_count: 0 }).retention_count, DEFAULT_BACKUP_SETTINGS.retention_count);
  assert.equal(normalizeSettings({ retention_count: 4000 }).retention_count, 500);
  assert.equal(normalizeSettings({ retention_days: "12" }).retention_days, 12, "a form sends strings");
  assert.equal(normalizeSettings({ last_automatic_at: 42 }).last_automatic_at, null);
});

test("retention keeps the newest snapshot and the way back", () => {
  const settings = normalizeSettings({ frequency: "daily", retention_days: 7, retention_count: 2 });
  const day = 24 * 60 * 60 * 1000;
  const at = (daysAgo: number) => new Date(NOW.getTime() - daysAgo * day).toISOString();

  const snapshots = [
    manifest({ id: "auto-new", kind: "automatic", created_at: at(0) }),
    manifest({ id: "auto-1", kind: "automatic", created_at: at(1) }),
    manifest({ id: "auto-2", kind: "automatic", created_at: at(2) }),
    manifest({ id: "auto-old", kind: "automatic", created_at: at(30) }),
    manifest({ id: "manual", kind: "manual", created_at: at(400) }),
    manifest({ id: "pre", kind: "pre_restore", created_at: at(3) }),
  ];

  const doomed = pruneCandidates(snapshots, settings, NOW).map((entry) => entry.id);
  assert.ok(!doomed.includes("auto-new"), "the newest automatic snapshot is never pruned");
  assert.ok(!doomed.includes("auto-1"), "nor the second newest, which the count keeps");
  assert.ok(!doomed.includes("manual"), "a snapshot somebody asked for by hand is theirs");
  assert.ok(!doomed.includes("pre"), "the rollback point survives while it is recent");
  assert.ok(doomed.includes("auto-2"), "the third newest goes: the count is two");
  assert.ok(doomed.includes("auto-old"), "and so does one outside the window");

  // One snapshot is never pruned: an installation with a single way back is not
  // an installation with one too many.
  assert.deepEqual(pruneCandidates([snapshots[0]], settings, NOW), []);
  // A pre_restore snapshot outside the window is worthless — the restore it
  // protected is a month old — so it goes.
  const stale = pruneCandidates(
    [manifest({ id: "auto-new", kind: "automatic", created_at: at(0) }), manifest({ id: "pre", kind: "pre_restore", created_at: at(40) })],
    settings,
    NOW,
  ).map((entry) => entry.id);
  assert.deepEqual(stale, ["pre"]);
});

test("the status answers the monitoring question", () => {
  const settings = normalizeSettings({ frequency: "daily", retention_days: 30, retention_count: 14 });
  const day = 24 * 60 * 60 * 1000;

  const never = backupStatus({ settings, manifests: [], lastRestore: null, now: NOW });
  assert.equal(never.status, "never");
  assert.equal(never.backup_count, 0);
  assert.equal(never.total_size_bytes, 0);

  const off = backupStatus({ settings: { ...settings, frequency: "off" }, manifests: [manifest()], lastRestore: null, now: NOW });
  assert.equal(off.status, "disabled", "a full disk of snapshots is not protection if the schedule is off");

  const fresh = backupStatus({
    settings,
    manifests: [manifest({ kind: "automatic", created_at: new Date(NOW.getTime() - 2 * 60 * 60 * 1000).toISOString() })],
    lastRestore: { at: new Date(NOW.getTime() - day).toISOString(), by: ACTOR.name },
    now: NOW,
  });
  assert.equal(fresh.status, "protected");
  assert.equal(fresh.last_automatic_at, fresh.last_backup?.created_at);
  assert.equal(fresh.last_restore?.by, ACTOR.name);
  assert.ok(fresh.next_automatic_due_at, "the panel can say when the next one falls due");

  const late = backupStatus({
    settings,
    manifests: [manifest({ kind: "automatic", created_at: new Date(NOW.getTime() - 9 * day).toISOString() })],
    lastRestore: null,
    now: NOW,
  });
  assert.equal(late.status, "overdue", "nine days on a daily policy is overdue, not merely due");

  assert.equal(formatBytes(0), "0 B");
  assert.ok(formatBytes(2048).includes("2"), "sizes are readable");
});

// ── 4. the service, through the seat that calls it ──────────────────────────
test("taking a snapshot writes metadata and an audit entry", async () => {
  resetAll("admin");
  seedShop();
  assert.equal(getBackupMode(), "demo", "a headless run has no Supabase project");

  const created = await createBackup("manual", "before the July price change");
  assert.equal(created.kind, "manual");
  assert.equal(created.note, "before the July price change");
  assert.equal(created.mode, "demo");
  assert.ok(created.row_count > 0, "the snapshot counts what it carried");
  assert.ok(created.size_bytes > 0);
  assert.ok(created.id.length > 0);

  const listed = await loadBackups();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, created.id);

  const stored = readStore<{ manifests: { id: string }[]; documents: Record<string, unknown> }>(
    "alyq.backup.v1",
  );
  assert.ok(stored, "the offline repository persisted a store");
  assert.equal(stored!.manifests.length, 1, "one manifest");
  assert.ok(stored!.documents[created.id], "and the document behind it");

  const status = await loadStatus();
  assert.equal(status.backup_count, 1);
  assert.equal(status.last_backup?.id, created.id);
  assert.equal(status.last_restore, null, "nothing has been restored yet");

  const actions = await auditActions();
  assert.ok(actions.includes("backup.created"), "taking a snapshot is recorded");

  // The settings are readable and sane on a fresh installation.
  const read = await loadBackupSettings();
  assert.equal(read.frequency, DEFAULT_BACKUP_SETTINGS.frequency);

  // Changing the policy is audited with the before and after, because a shorter
  // window is a decision about how much work the shop is prepared to lose.
  await saveBackupSettings({ frequency: "weekly", retention_days: 60, retention_count: 8 });
  const changed = await loadBackupSettings();
  assert.equal(changed.frequency, "weekly");
  assert.equal(changed.retention_days, 60);
  assert.ok((await auditActions()).includes("backup.settings_changed"));
});

test("a seat without a capability is refused before anything is written", async () => {
  resetAll("cashier");
  seedShop();

  assert.equal(await refusal(() => loadBackups()), "FORBIDDEN");
  assert.equal(await refusal(() => loadStatus()), "FORBIDDEN");
  assert.equal(await refusal(() => createBackup()), "FORBIDDEN");
  assert.equal(await refusal(() => downloadBackup("bk-1")), "FORBIDDEN");
  assert.equal(await refusal(() => runHealthCheck()), "FORBIDDEN");
  assert.equal(await refusal(() => saveBackupSettings({ frequency: "off" })), "FORBIDDEN");
  assert.equal(
    await refusal(() => restoreBackup({ id: "bk-1", confirmation: RESTORE_CONFIRMATION })),
    "FORBIDDEN",
  );

  // The refusals are the guards, and the guards are the register.
  assert.equal(refusalSync(() => assertCanViewBackups()), "FORBIDDEN");
  assert.equal(refusalSync(() => assertCanCreateBackup()), "FORBIDDEN");
  assert.equal(refusalSync(() => assertCanRestoreBackup()), "FORBIDDEN");
  assert.equal(refusalSync(() => assertCanExportBackup()), "FORBIDDEN");
  assert.equal(refusalSync(() => assertCanRunHealthCheck()), "FORBIDDEN");
  assert.equal(refusalSync(() => assertCanChangeBackupSchedule()), "FORBIDDEN");

  assert.equal(readStore("alyq.backup.v1"), null, "nothing was written by a refused call");
  assert.equal((await auditActions()).filter((action) => action.startsWith("backup.")).length, 0);

  resetAll(null);
  assert.equal(await refusal(() => loadBackups()), "FORBIDDEN", "a signed-out caller is refused too");
});

test("a manager may protect the installation, but not replace it or carry it out", async () => {
  resetAll("manager");
  seedShop();

  // The panel is open and a snapshot may be taken: protecting the shop is the
  // manager's job.
  assert.equal(refusalSync(() => assertCanViewBackups()), null);
  assert.equal(refusalSync(() => assertCanRunHealthCheck()), null);
  const created = await createBackup("manual", "manager snapshot");
  assert.ok(created.id);
  assert.ok((await loadBackups()).length === 1);

  // Replacing the data and leaving with a copy are the owner's.
  assert.equal(await refusal(() => downloadBackup(created.id)), "FORBIDDEN");
  assert.equal(
    await refusal(() => restoreBackup({ id: created.id, confirmation: RESTORE_CONFIRMATION })),
    "FORBIDDEN",
  );
  assert.equal(refusalSync(() => assertCanChangeBackupSchedule()), "FORBIDDEN");

  // A health check offline reads this browser's own stores, so run_health_check
  // is the whole of the authority it needs — and a manager holds it.
  const report = await runHealthCheck();
  assert.equal(report.mode, "demo");
  assert.ok((await auditActions()).includes("health.check_run"));
  assert.ok(!(await auditActions()).includes("backup.downloaded"), "nothing was downloaded");
});

test("a restore brings the data back and leaves the way back behind", async () => {
  resetAll("admin");
  seedShop();

  const snapshot = await createBackup("manual", "known good");
  const before = readStore<{ products: { id: string; selling_price: number }[] }>("alyq.demo.catalog.v1");
  assert.ok(before && before.products.length > 0);
  const firstPrice = before!.products[0].selling_price;

  // Damage the shop: a price overwritten by a bad import, and a customer deleted.
  before!.products[0].selling_price = 1;
  writeStore("alyq.demo.catalog.v1", before);
  writeStore("alyq.demo.customers.v1", []);

  const outcome = await restoreBackup({ id: snapshot.id, confirmation: RESTORE_CONFIRMATION });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.mode, "demo");
  assert.ok(outcome.row_count > 0, "the outcome says how much came back");
  assert.ok(outcome.pre_restore_backup_id, "the restore kept a way back");

  const after = readStore<{ products: { selling_price: number }[] }>("alyq.demo.catalog.v1");
  assert.equal(after!.products[0].selling_price, firstPrice, "the overwritten price is back");
  const customers = readStore<unknown[]>("alyq.demo.customers.v1");
  assert.equal(customers!.length, 1, "the deleted customer is back");

  // The rollback is not a promise, it is a row: the pre-restore snapshot holds the
  // damaged state, so restoring it undoes the restore.
  const listed = await loadBackups();
  const preRestore = listed.find((entry) => entry.id === outcome.pre_restore_backup_id);
  assert.ok(preRestore, "the pre-restore snapshot is listed");
  assert.equal(preRestore!.kind, "pre_restore");

  const status = await loadStatus();
  assert.ok(status.last_restore, "the panel can say when the last restore happened");

  const actions = await auditActions();
  assert.ok(actions.includes("restore.started"), "the trail starts before the deletion");
  assert.ok(actions.includes("restore.completed"), "and ends when the outcome is known");
  assert.ok(!actions.includes("restore.failed"));
});

test("a restore refuses a wrong word, two sources, no source and the other mode — changing nothing", async () => {
  resetAll("admin");
  seedShop();
  const snapshot = await createBackup("manual", "known good");

  const catalog = readStore<unknown>("alyq.demo.catalog.v1");
  const customers = readStore<unknown>("alyq.demo.customers.v1");

  // The word is checked in the service, not only in the dialog: a dialog is
  // client-side and a restore is not.
  const wrongWord = await refusal(() => restoreBackup({ id: snapshot.id, confirmation: "yes" }));
  assert.equal(wrongWord, "VALIDATION");
  const lowercase = await restoreBackup({ id: snapshot.id, confirmation: "  restore  " });
  assert.equal(lowercase.ok, true, "the word is trimmed and case-folded, not typed twice");

  // Exactly one source: a stored snapshot or an uploaded file, never both and
  // never neither.
  assert.equal(
    await refusal(() =>
      restoreBackup({ id: snapshot.id, fileText: serializeDocument(demoDocument()), confirmation: RESTORE_CONFIRMATION }),
    ),
    "VALIDATION",
  );
  assert.equal(await refusal(() => restoreBackup({ confirmation: RESTORE_CONFIRMATION })), "VALIDATION");

  // A document from the other mode would delete every store and fill none.
  const live = serializeDocument(liveDocument());
  const otherMode = await refusal(() =>
    restoreBackup({ fileText: live, confirmation: RESTORE_CONFIRMATION }),
  );
  assert.equal(otherMode, "VALIDATION");

  // …and a file that is not a document at all.
  assert.equal(
    await refusal(() => restoreBackup({ fileText: "[]", confirmation: RESTORE_CONFIRMATION })),
    "VALIDATION",
  );

  // Every refusal left the shop exactly as it was.
  assert.deepEqual(readStore("alyq.demo.catalog.v1"), catalog, "the catalog did not move");
  assert.deepEqual(readStore("alyq.demo.customers.v1"), customers, "nor the customer book");
  assert.ok((await auditActions()).includes("restore.failed"), "a refused restore is still a restore somebody asked for");
});

test("restoring an uploaded file works, and says where it came from", async () => {
  resetAll("admin");
  seedShop();

  const document = demoDocument();
  writeStore("alyq.demo.customers.v1", []);

  const outcome = await restoreBackup({
    fileText: serializeDocument(document),
    confirmation: RESTORE_CONFIRMATION,
  });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.origin, "uploaded");
  const customers = readStore<unknown[]>("alyq.demo.customers.v1");
  assert.equal(customers!.length, 1, "the uploaded document's customer is back");
});

test("a restore rewrites the shop and leaves the trail alone", async () => {
  resetAll("admin");
  seedShop();
  // A trail that is *not* in the snapshot: written after it was taken, which is
  // exactly the case a restore must not erase.
  writeStore("alyq.demo.audit_log.v1", [
    { id: "a-live", action: "shift.opened", created_at: NOW.toISOString() },
  ]);

  // Straight at the repository, because the audit repository caches its entries
  // in memory and would paper over a replacement within one process.
  const document = demoDocument();
  assert.equal(document.payload.stores?.["alyq.demo.audit_log.v1"], null, "the fixture carries no trail");
  await new DemoBackupRepository(() => NOW).restoreFromDocument(document);

  const trail = readStore<{ id: string }[]>("alyq.demo.audit_log.v1");
  assert.ok(trail, "the trail is still there");
  assert.equal(trail![0].id, "a-live", "a restore appends to the evidence, it never replaces it");

  const catalog = readStore<{ products: unknown[] }>("alyq.demo.catalog.v1");
  assert.equal(catalog!.products.length, 1, "while the shop itself was rewritten");
  assert.deepEqual([...DEMO_RESTORE_EXCLUDED], ["alyq.demo.audit_log.v1"]);
});

test("downloading a snapshot hands over a file, and records it", async () => {
  resetAll("admin");
  seedShop();
  const snapshot = await createBackup("manual", "for the owner's laptop");

  const result = await downloadBackup(snapshot.id);
  assert.equal(downloads.length, 1, "one file reached the browser");
  assert.equal(downloads[0].filename, result.filename);
  assert.ok(downloads[0].size > 0);
  assert.equal(result.document.checksum, snapshot.checksum);

  const parsed = parseBackupDocument(serializeDocument(result.document));
  assert.equal(parsed.ok, true, "what was downloaded is what was stored");

  assert.ok((await auditActions()).includes("backup.downloaded"), "leaving with a copy is recorded");
  assert.equal(await refusal(() => downloadBackup("bk-does-not-exist")), "NOT_FOUND");
});

test("the schedule takes a snapshot when one is due, and not before", async () => {
  resetAll("admin");
  seedShop();

  // A real clock, not the fixture's: the offline repository stamps snapshots with
  // its own `new Date()`, and a fictional "now" would make the next due time
  // disagree with the row it just wrote.
  const clock = new Date();

  // Daily by default, and nothing has run yet, so one is due immediately: a shop
  // should not have to wait a day to be protected.
  const first = await automaticBackupIfDue(clock);
  assert.ok(first, "the first snapshot is taken");
  assert.equal(first!.kind, "automatic");

  const again = await automaticBackupIfDue(new Date(clock.getTime() + 60 * 60 * 1000));
  assert.equal(again, null, "an hour later it is not due again");

  const nextDay = await automaticBackupIfDue(new Date(clock.getTime() + PERIOD_MS.daily + 60 * 1000));
  assert.ok(nextDay, "a day later it is");
  assert.equal((await loadBackups()).filter((entry) => entry.kind === "automatic").length, 2);

  // With the schedule off, nothing is taken — and nothing throws, because this
  // runs on the way into a screen and must never block it.
  await saveBackupSettings({ frequency: "off" });
  assert.equal(await automaticBackupIfDue(new Date(clock.getTime() + 40 * PERIOD_MS.daily)), null);
});

// ── 5. data integrity ───────────────────────────────────────────────────────
test("the health check finds broken relationships and says how bad they are", () => {
  const tables: Record<string, unknown[]> = {};
  for (const table of LIVE_TABLES) tables[table] = [];
  tables.products = [
    { id: "p-ok", sku: "OK-1", stock_quantity: 10 },
    { id: "p-neg", sku: "NEG-1", stock_quantity: -4 },
  ];
  tables.stock_movements = [
    { id: "m-1", product_id: "p-ok", quantity_before: 0, quantity_after: 10 },
    { id: "m-2", product_id: "p-gone", quantity_before: 0, quantity_after: 3 },
  ];
  tables.sales = [
    { id: "s-empty", customer_id: null, total: 0, status: "completed" },
    { id: "s-ok", customer_id: "c-gone", total: 20, status: "completed" },
  ];
  tables.sale_items = [{ id: "si-1", sale_id: "s-ok", quantity: 2, unit_price: 10 }];
  tables.sale_payments = [
    { id: "pay-1", sale_id: "s-ok", amount: 20 },
    { id: "pay-2", sale_id: "s-gone", amount: 5 },
    { id: "pay-3", sale_id: "s-ok", amount: -3 },
  ];
  tables.customers = [];
  tables.profiles = [
    { id: "u-1", role: "wizard", active: true },
    { id: "u-2", role: "cashier", active: true, custom_role_id: "cr-gone" },
    { id: "u-3", role: "manager", active: true, extra_capabilities: ["fly"], denied_capabilities: ["fly"] },
  ];
  tables.custom_roles = [{ id: "cr-1", active: true, capabilities: ["not_a_capability"] }];
  tables.audit_log = [
    { id: "a-1", action: "shift.opened", entity: "shift", entity_id: "", user_id: "", created_at: NOW.toISOString() },
    { id: "a-2", action: "something.invented", entity: "shift", entity_id: "x", user_id: "u-1", created_at: NOW.toISOString() },
  ];

  const document = buildDocument({
    mode: "supabase",
    kind: "manual",
    note: null,
    payload: { tables },
    actor: ACTOR,
    now: NOW,
    checksum: "irrelevant",
  });
  const report = healthReportFor(document, NOW);

  const codes = new Map(report.issues.map((issue) => [issue.code, issue]));
  for (const expected of [
    "negative_stock",
    "movement_orphan",
    "sale_without_items",
    "sale_customer_orphan",
    "payment_orphan",
    "payment_invalid_amount",
    "user_invalid_role",
    "user_orphan_custom_role",
    "role_unknown_capability",
    "user_unknown_exception",
    "user_contradictory_exception",
    "no_active_admin",
    "audit_missing_fields",
    "audit_unknown_action",
  ]) {
    assert.ok(codes.has(expected), `${expected} is reported`);
  }

  assert.equal(codes.get("negative_stock")!.severity, "critical");
  assert.equal(codes.get("negative_stock")!.area, "inventory");
  assert.equal(codes.get("negative_stock")!.count, 1);
  assert.deepEqual(codes.get("negative_stock")!.samples, ["NEG-1"], "a finding points at something, not just a number");
  assert.equal(codes.get("no_active_admin")!.severity, "critical", "nobody able to recover is the loudest finding there is");
  assert.equal(codes.get("audit_unknown_action")!.severity, "info", "a retired label is news, not damage");
  assert.equal(report.ok, false);
  assert.equal(report.worst, "critical");

  // Every finding carries the two keys the panel renders, so a report is never a
  // code on a screen.
  for (const issue of report.issues) {
    assert.equal(issue.messageKey, `backup.health.${issue.code}.message`);
    assert.equal(issue.recommendationKey, `backup.health.${issue.code}.recommendation`);
    assert.ok(en[issue.messageKey as keyof typeof en], `en has ${issue.messageKey}`);
    assert.ok(ar[issue.messageKey as keyof typeof ar], `ar has ${issue.messageKey}`);
  }

  // The scope is printed next to the verdict.
  const examined = examinedCounts(healthModelFromDocument(document));
  assert.equal(examined.products, 2);
  assert.equal(examined.audit_log, 2);
  assert.equal(examined.payments, 3);
});

test("a clean installation reports clean", () => {
  const tables: Record<string, unknown[]> = {};
  for (const table of LIVE_TABLES) tables[table] = [];
  tables.products = [{ id: "p-1", sku: "OK-1", stock_quantity: 10 }];
  tables.stock_movements = [{ id: "m-1", product_id: "p-1", quantity_before: 0, quantity_after: 10 }];
  tables.sales = [{ id: "s-1", customer_id: null, total: 10, status: "completed" }];
  tables.sale_items = [{ id: "si-1", sale_id: "s-1", quantity: 1, unit_price: 10 }];
  tables.sale_payments = [{ id: "pay-1", sale_id: "s-1", amount: 10 }];
  tables.profiles = [{ id: "u-1", role: "admin", active: true }];
  tables.audit_log = [
    { id: "a-1", action: "shift.opened", entity: "shift", entity_id: "sh-1", user_id: "u-1", created_at: NOW.toISOString() },
  ];

  const report = healthReportFor(
    buildDocument({
      mode: "supabase",
      kind: "manual",
      note: null,
      payload: { tables },
      actor: ACTOR,
      now: NOW,
      checksum: "irrelevant",
    }),
    NOW,
  );

  assert.deepEqual(
    report.issues.map((issue) => issue.code),
    [],
    `a clean shop reports nothing (${report.issues.map((issue) => issue.code).join(", ")})`,
  );
  assert.equal(report.ok, true);
  assert.equal(report.worst, null);
  assert.equal(report.mode, "supabase");

  // The same checks over the offline shape, which nests a sale's lines and
  // payments inside the sale rather than in their own tables.
  const offline = healthReportFor(demoDocument(), NOW);
  assert.deepEqual(offline.issues.map((issue) => issue.code), []);
  assert.equal(offline.mode, "demo");
  assert.equal(offline.examined.sales, 1);
  assert.equal(offline.examined.sale_items, 1, "a nested line is lifted out and counted");

  // And the checks are pure: the same document, twice, is the same report.
  assert.deepEqual(runHealthChecks(healthModelFromDocument(demoDocument())), []);
});

test("every health code the checks can emit has words in both languages", () => {
  const source = fs.readFileSync(
    path.join(repoRoot(), "src/modules/backup/services/health.ts"),
    "utf8",
  );
  const codes = new Set<string>();
  for (const match of source.matchAll(/issue\(\s*\n?\s*"([a-z_]+)"/g)) codes.add(match[1]);
  assert.ok(codes.size >= 25, `the checks emit their codes (${codes.size} found)`);

  for (const code of codes) {
    for (const suffix of ["message", "recommendation"]) {
      const key = `backup.health.${code}.${suffix}`;
      assert.ok(en[key as keyof typeof en], `en has ${key}`);
      assert.ok(ar[key as keyof typeof ar], `ar has ${key}`);
    }
  }
  // And the areas and severities the report groups by.
  for (const area of ["inventory", "sales", "financial", "online", "identity", "audit"]) {
    assert.ok(en[`backup.health.area.${area}` as keyof typeof en], `en names the ${area} area`);
    assert.ok(ar[`backup.health.area.${area}` as keyof typeof ar], `ar names the ${area} area`);
  }
  for (const severity of ["critical", "warning", "info"]) {
    assert.ok(en[`backup.health.severity.${severity}` as keyof typeof en]);
    assert.ok(ar[`backup.health.severity.${severity}` as keyof typeof ar]);
  }
});

// ── 6. the emergency export ─────────────────────────────────────────────────
test("the emergency export is gated by the capability the export feature already uses", () => {
  // Every seat in this app already holds `export_data`: the Reports and Export
  // screens hand a cashier their sales and a viewer their catalogue. The emergency
  // workbook carries exactly that — business data, and no identity or audit rows —
  // so it is gated by the same capability and is no wider than the feature it
  // reuses. A *backup file* is narrower company: it holds users and the trail, and
  // that is what `export_backup` is for.
  for (const role of ["admin", "manager", "cashier", "inventory_clerk", "viewer"] as AppRole[]) {
    resetAll(role);
    assert.equal(refusalSync(() => assertCanRunEmergencyExport()), null, `${role} may export business data`);
  }
  resetAll(null);
  assert.equal(refusalSync(() => assertCanRunEmergencyExport()), "FORBIDDEN", "a signed-out caller may not");
});

test("the emergency export uses the existing builders", async () => {
  resetAll("admin");
  seedShop();

  const outcome = await exportEmergencyWorkbook({
    t: ((key: string) => key) as never,
    pick: (arabic: string | null | undefined, english: string | null | undefined) =>
      english ?? arabic ?? "",
    lang: "en",
  });
  assert.ok(outcome.result.sheets.length > 0, "the workbook has sheets");
  assert.equal(downloads.length, 1, "one file reached the browser");
  assert.match(downloads[0].filename, /\.xlsx$/);
  assert.ok(Array.isArray(outcome.skipped), "a refused or empty section is reported, not fatal");

  // No audit entry and no new capability: it is an export, and the app already
  // has exactly one door for those.
  assert.equal((await auditActions()).filter((action) => action.startsWith("backup.")).length, 0);
});

// ── 7. errors an operator can read ──────────────────────────────────────────
test("every dialect of refusal becomes one dictionary key", () => {
  assert.equal(describeBackupError(new AppError("VALIDATION", "backup.error.incomplete")).key, "backup.error.incomplete");
  assert.equal(describeBackupError(new AppError("FORBIDDEN", "backup.health.needsExport")).key, "backup.health.needsExport");
  // The database appends the tables it missed; the key still has to come out.
  assert.equal(
    describeBackupError(new Error("backup.error.incomplete: products, sales")).key,
    "backup.error.incomplete",
  );
  assert.equal(describeBackupError(new AppError("DB", "BACKUP_STORAGE_FULL")).key, "backup.error.storage_full");
  assert.equal(describeBackupError(new AppError("NOT_FOUND", "No such backup: bk-1")).key, "backup.error.not_found");
  assert.equal(describeBackupError(new AppError("FORBIDDEN", "Only an admin may restore")).key, "backup.error.forbidden");
  assert.equal(describeBackupError(new Error("something else entirely")).key, "backup.error.failed");
  assert.equal(describeBackupError("not even an error").key, "backup.error.failed");

  for (const key of [
    "backup.error.incomplete",
    "backup.error.storage_full",
    "backup.error.not_found",
    "backup.error.forbidden",
    "backup.error.failed",
    "backup.error.confirmation",
    "backup.error.no_source",
    "backup.error.mode_mismatch",
    "backup.error.checksum_mismatch",
    "backup.error.emergency_empty",
    "backup.health.needsExport",
  ]) {
    assert.ok(en[key as keyof typeof en], `en has ${key}`);
    assert.ok(ar[key as keyof typeof ar], `ar has ${key}`);
  }
});

// ── runner ───────────────────────────────────────────────────────────────────

(async () => {
  let failed = 0;
  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`  ✓ ${name}`);
    } catch (error) {
      failed += 1;
      console.error(`  ✗ ${name}`);
      console.error(`    ${(error as Error).message}`);
    }
  }
  console.log("");
  if (failed > 0) {
    console.error(`${failed}/${tests.length} Phase 18 backup tests FAILED.`);
    process.exit(1);
  }
  console.log(`${tests.length}/${tests.length} Phase 18 backup & recovery tests passed.`);
})();
