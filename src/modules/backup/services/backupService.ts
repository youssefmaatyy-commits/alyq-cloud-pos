/**
 * Backup service — every recovery action, gated and recorded.
 *
 * Same shape as the other services in this app, and for the same reason: the
 * screen hides a button as a courtesy, this function refuses the call, and in
 * live mode the `security definer` function behind it refuses it a third time. A
 * restore is the most destructive act the installation can perform, so the layer
 * that decides is not the one that can be edited in a browser console.
 *
 * What runs here, in order, for a restore:
 *
 *   1. `restore_backup` — the capability. Not `manage_settings`, not admin-ness
 *      inferred from a role name: the capability, so a custom role can be given
 *      it and a shipped admin can have it taken away.
 *   2. the typed confirmation phrase, compared here rather than only in the
 *      dialog, so a forged call still has to know the word;
 *   3. the document, validated against the contract in `schema.ts` — format,
 *      version, mode, completeness, and (offline) the checksum;
 *   4. `restore.started` in the audit log, *before* anything is written, because
 *      an audit entry recorded afterwards does not exist if the restore kills the
 *      session that would have written it;
 *   5. the repository, which snapshots the current state as `pre_restore` and
 *      then replaces the data — in live mode inside one transaction;
 *   6. `restore.completed` or `restore.failed`, with the row count and the id of
 *      the snapshot that is now the way back.
 *
 * Nothing here rebuilds an audit trail, a permission model or an export engine:
 * the audit entries go through `recordAudit`, the capabilities through
 * `assertCapability`, and the emergency workbook through the builders the reports
 * and module screens already use.
 */
import { recordAudit } from "@/modules/audit/services/auditService";
import { loadAuditLog } from "@/modules/audit/services/auditService";
import { actingUser, canAct } from "@/lib/permissions/enforce";
import { assertSensitiveAction } from "@/lib/permissions/actions";
import { AppError } from "@/modules/products/data/repository";
import { getBackupMode, getBackupRepository } from "../data";
import {
  backupFileName,
  parseBackupDocument,
  serializeDocument,
  validateBackupDocument,
} from "../schema";
import { backupStatus, isDue, normalizeSettings } from "./schedule";
import { examinedCounts, healthModelFromDocument, runHealthChecks } from "./health";
import type {
  BackupDocument,
  BackupKind,
  BackupManifest,
  BackupSettings,
  BackupStatusSummary,
  HealthReport,
  RestoreOutcome,
} from "../types";

/**
 * The word an admin has to type before a restore runs.
 *
 * A second click is not a confirmation, it is the same click twice. Typing a word
 * is slow enough that somebody who got here by accident stops, and specific
 * enough that the dialog can say what is about to happen.
 */
export const RESTORE_CONFIRMATION = "RESTORE";

export function getMode(): "demo" | "supabase" {
  return getBackupMode();
}

// ── capability guards ────────────────────────────────────────────────────────
// Every one of these is an entry in `src/lib/permissions/actions.ts`, which is
// what makes them more than decoration: the enforcement suite reads that register,
// asserts each guard is really called from this file, then signs in as a seat that
// lacks the capability and asserts the refusal. Nothing below calls
// `assertCapability` directly, so an act that is not in the register cannot be
// gated here, and a gate here cannot drift from the register.
//
// In live mode these are the *first* of two refusals. Migration 0029 re-checks
// `public.can()` inside every function that touches a snapshot, because the act
// that deletes the installation's data has to be refused where the deletion
// happens — not only in the browser that asked for it.

/** Opening the panel needs `view_backups`: metadata about snapshots, never a copy. */
export function assertCanViewBackups(): void {
  assertSensitiveAction("backup.view");
}

/** Taking a snapshot needs `create_backup` — the one recovery act a manager holds. */
export function assertCanCreateBackup(): void {
  assertSensitiveAction("backup.create");
}

/** Replacing the installation needs `restore_backup`. */
export function assertCanRestoreBackup(): void {
  assertSensitiveAction("backup.restore");
}

/** Carrying a copy out needs `export_backup`, on top of being able to see the list. */
export function assertCanExportBackup(): void {
  assertSensitiveAction("backup.export");
}

/** Reading every relationship in the data needs `run_health_check`. */
export function assertCanRunHealthCheck(): void {
  assertSensitiveAction("backup.health_check");
}

/** Changing the schedule changes the recovery policy, so it is `manage_settings`. */
export function assertCanChangeBackupSchedule(): void {
  assertSensitiveAction("backup.schedule");
}

/**
 * Turn anything thrown in this module into a dictionary key.
 *
 * The refusals come from three directions and speak three dialects: this service
 * (which already throws a key), the offline repository (which throws a storage
 * constant), and the database (which raises `backup.error.…`, sometimes with the
 * offending table names appended). One function reads all three, so a screen never
 * has to guess whether a message is prose or a key — and an unrecognised failure
 * says "nothing was changed" rather than leaking a driver's wording.
 */
export function describeBackupError(error: unknown): { key: string; field?: string } {
  const appError =
    error instanceof AppError ? error : new AppError("DB", error instanceof Error ? error.message : String(error));
  const message = appError.message.trim();
  const field = appError.field;

  // Already a key — ours, or one of the health report's.
  // The health keys are camelCase (`backup.health.needsExport`) and SQL appends
  // the tables it missed to the error keys, so match the prefix rather than the
  // whole message and let the dictionary hold the sentence.
  if (/^backup\.(error|health)\.[A-Za-z_.]+/.test(message)) return { key: message.split(/[:\s]/)[0], field };
  // A database refusal, which may carry detail after the code.
  const coded = message.match(/backup\.error\.[a-z_]+/);
  if (coded) return { key: coded[0], field };

  if (/BACKUP_STORAGE_FULL|QuotaExceeded|quota/i.test(message)) return { key: "backup.error.storage_full", field };
  if (/no such backup|not[_ ]found/i.test(message)) return { key: "backup.error.not_found", field };
  if (appError.code === "FORBIDDEN") return { key: "backup.error.forbidden", field };
  return { key: "backup.error.failed", field };
}

// ── reads ────────────────────────────────────────────────────────────────────

export async function loadBackups(): Promise<BackupManifest[]> {
  assertCanViewBackups();
  return getBackupRepository().listBackups();
}

export async function loadBackupSettings(): Promise<BackupSettings> {
  assertCanViewBackups();
  return getBackupRepository().getSettings();
}

/**
 * The monitoring panel's answer: last backup, whether the schedule is being met,
 * what is stored, and when the last restore ran.
 *
 * The restore history is read from the audit log rather than kept in a second
 * table — the audit trail already records who restored what and when, and a
 * module that keeps its own history is a module whose history will disagree with
 * the audit log one day.
 */
export async function loadStatus(): Promise<BackupStatusSummary> {
  assertCanViewBackups();
  const repository = getBackupRepository();
  const [manifests, settings] = await Promise.all([repository.listBackups(), repository.getSettings()]);

  let lastRestore: { at: string; by: string | null } | null = null;
  try {
    const entries = await loadAuditLog();
    const completed = entries
      .filter((entry) => entry.action === "restore.completed")
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0];
    if (completed) lastRestore = { at: String(completed.created_at), by: completed.user_name ?? completed.user_id };
  } catch {
    // A seat that may see backups but not the audit log still gets the panel;
    // only the "last restore" line is missing, and that is the honest answer.
    lastRestore = null;
  }

  return backupStatus({ settings, manifests, lastRestore });
}

// ── writing snapshots ────────────────────────────────────────────────────────

export async function createBackup(kind: BackupKind = "manual", note?: string | null): Promise<BackupManifest> {
  assertCanCreateBackup();
  const repository = getBackupRepository();
  const actor = actingUser();

  const manifest = await repository.createBackup({ kind, note });

  void recordAudit({
    action: "backup.created",
    entity: "backup",
    entity_id: manifest.id,
    entity_label: `${kind} · ${manifest.created_at}`,
    details: {
      kind,
      mode: manifest.mode,
      note: manifest.note ?? "",
      size_bytes: manifest.size_bytes,
      row_count: manifest.row_count,
      table_count: manifest.table_count,
      checksum: manifest.checksum,
    },
    user_id: actor.id,
    user_name: actor.name,
  });

  // An automatic snapshot is also the moment the schedule advances; a manual one
  // does not move it, because "somebody pressed the button on Tuesday" is not a
  // schedule.
  if (kind === "automatic") {
    await repository.saveSettings({ last_automatic_at: manifest.created_at });
  }
  return manifest;
}

export async function saveBackupSettings(patch: Partial<BackupSettings>): Promise<BackupSettings> {
  assertCanChangeBackupSchedule();
  const before = await getBackupRepository().getSettings();
  const next = normalizeSettings({ ...before, ...patch });
  const saved = await getBackupRepository().saveSettings(next);
  const actor = actingUser();

  void recordAudit({
    action: "backup.settings_changed",
    entity: "backup",
    entity_id: "settings",
    entity_label: saved.frequency,
    details: {
      frequency_before: before.frequency,
      frequency_after: saved.frequency,
      retention_days_before: before.retention_days,
      retention_days_after: saved.retention_days,
      retention_count_before: before.retention_count,
      retention_count_after: saved.retention_count,
    },
    user_id: actor.id,
    user_name: actor.name,
  });
  return saved;
}

/**
 * The scheduled snapshot, if one is due.
 *
 * Best effort by design: it runs from an open admin session, it never throws, and
 * it never blocks anything. A shop mid-service does not get an error dialog
 * because a backup could not be written — it gets nothing at all, and the
 * monitoring panel says the schedule slipped, which is where that belongs.
 */
export async function automaticBackupIfDue(now: Date = new Date()): Promise<BackupManifest | null> {
  try {
    assertCanCreateBackup();
    const repository = getBackupRepository();
    const settings = await repository.getSettings();
    if (!isDue(settings, now)) return null;
    return await createBackup("automatic", "scheduled");
  } catch {
    return null;
  }
}

// ── download ─────────────────────────────────────────────────────────────────

export interface DownloadResult {
  filename: string;
  size_bytes: number;
  document: BackupDocument;
}

/**
 * Hand a backup to the admin as a file.
 *
 * Its own capability, and not the one that opens the list: the manifest says a
 * backup exists and how big it is, while the document is the whole installation —
 * customers, sales, the staff directory. `export_backup` is the difference
 * between "we are protected" and "somebody walked out with the database".
 */
export async function downloadBackup(id: string): Promise<DownloadResult> {
  assertCanExportBackup();
  const document = await getBackupRepository().readDocument(id);
  const verdict = validateBackupDocument(document, {
    mode: document.mode,
    // A live document carries the database's md5; only SQL can recompute it, and
    // it does so inside the restore transaction.
    ignoreChecksum: document.mode === "supabase",
  });
  if (!verdict.ok) throw new AppError("VALIDATION", `backup.error.${verdict.code}`);

  const filename = backupFileName(verdict.document);
  const text = serializeDocument(verdict.document);
  writeTextFile(filename, text);

  const actor = actingUser();
  void recordAudit({
    action: "backup.downloaded",
    entity: "backup",
    entity_id: id,
    entity_label: filename,
    details: {
      mode: verdict.document.mode,
      kind: verdict.document.kind,
      size_bytes: text.length,
      row_count: verdict.document.row_count,
      checksum: verdict.document.checksum,
    },
    user_id: actor.id,
    user_name: actor.name,
  });

  return { filename, size_bytes: text.length, document: verdict.document };
}

function writeTextFile(filename: string, text: string): void {
  // Guarded so the service stays callable from a test runner with no document.
  if (typeof document === "undefined" || typeof URL === "undefined") return;
  const blob = new Blob([text], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ── restore ──────────────────────────────────────────────────────────────────

export interface RestoreRequest {
  /** A stored snapshot… */
  id?: string;
  /** …or a file an admin uploaded. Exactly one of the two. */
  fileText?: string;
  /** Must equal `RESTORE_CONFIRMATION`. */
  confirmation: string;
}

/**
 * Replace the installation's data with a snapshot.
 *
 * The refusal paths are the point of this function: a missing capability, a wrong
 * phrase, an unparseable file, a document from the other mode, a document missing
 * tables. Each is named, each is recorded, and none of them leaves the database
 * half-changed — in live mode because the restore is one transaction, offline
 * because the `pre_restore` snapshot is taken first and the failure message names
 * it.
 */
export async function restoreBackup(request: RestoreRequest): Promise<RestoreOutcome> {
  assertCanRestoreBackup();

  const actor = actingUser();
  if (request.confirmation.trim().toUpperCase() !== RESTORE_CONFIRMATION) {
    void recordAudit({
      action: "restore.failed",
      entity: "backup",
      entity_id: request.id ?? "uploaded",
      entity_label: "confirmation refused",
      details: { reason: "confirmation_mismatch", origin: request.id ? "stored" : "uploaded" },
      user_id: actor.id,
      user_name: actor.name,
    });
    throw new AppError("VALIDATION", "backup.error.confirmation");
  }
  if (Boolean(request.id) === Boolean(request.fileText)) {
    throw new AppError("VALIDATION", "backup.error.no_source");
  }

  const repository = getBackupRepository();
  const origin = request.id ? "stored" : "uploaded";

  let document: BackupDocument;
  if (request.id) {
    document = await repository.readDocument(request.id);
  } else {
    const parsed = parseBackupDocument(String(request.fileText), { mode: getBackupMode() });
    if (!parsed.ok) throw new AppError("VALIDATION", `backup.error.${parsed.code}`);
    document = parsed.document;
  }

  void recordAudit({
    action: "restore.started",
    entity: "backup",
    entity_id: request.id ?? "uploaded",
    entity_label: `${origin} · ${document.created_at}`,
    details: {
      origin,
      mode: document.mode,
      kind: document.kind,
      backup_created_at: document.created_at,
      backup_created_by: document.created_by?.name ?? "",
      row_count: document.row_count,
      size_bytes: document.size_bytes,
      checksum: document.checksum,
    },
    user_id: actor.id,
    user_name: actor.name,
  });

  try {
    const outcome = request.id
      ? await repository.restoreFromId(request.id)
      : await repository.restoreFromDocument(document);

    void recordAudit({
      action: "restore.completed",
      entity: "backup",
      entity_id: request.id ?? "uploaded",
      entity_label: `${origin} · ${document.created_at}`,
      details: {
        origin,
        mode: outcome.mode,
        row_count: outcome.row_count,
        pre_restore_backup_id: outcome.pre_restore_backup_id ?? "",
        restored_at: outcome.restored_at,
      },
      user_id: actor.id,
      user_name: actor.name,
    });
    return outcome;
  } catch (error) {
    void recordAudit({
      action: "restore.failed",
      entity: "backup",
      entity_id: request.id ?? "uploaded",
      entity_label: `${origin} · ${document.created_at}`,
      details: {
        origin,
        mode: document.mode,
        reason: error instanceof Error ? error.message.slice(0, 400) : String(error).slice(0, 400),
      },
      user_id: actor.id,
      user_name: actor.name,
    });
    throw error;
  }
}

/**
 * What to do after a successful restore.
 *
 * The data underneath every provider changed, so the caches are wrong by
 * definition. The honest fix is a reload: providers re-read, the session
 * re-resolves its capabilities against the restored directory, stock availability
 * is recomputed from the restored products and reservations, and any realtime
 * subscription reconnects. Returned as a callback so a caller can show its
 * "restored" message first — a reload takes the message with it.
 */
export function afterRestore(): void {
  try {
    // The session may describe a person the restored directory no longer holds;
    // dropping the cached identity makes the next read authoritative.
    window.sessionStorage.setItem("alyq.restore.completed_at", new Date().toISOString());
  } catch {
    /* a reload is still the right answer without it */
  }
  if (typeof window !== "undefined") window.location.reload();
}

// ── data health ──────────────────────────────────────────────────────────────

/**
 * Look at everything and report what does not add up.
 *
 * Reads through `snapshotDocument()`, so it examines the same complete picture a
 * backup would carry — including the rows no screen lists — and stores nothing.
 */
export async function runHealthCheck(): Promise<HealthReport> {
  assertCanRunHealthCheck();
  // Offline, the check reads this browser's own stores and `run_health_check` is
  // the whole of the authority it needs. In live mode it reads through
  // `snapshot_document()` — the same function a download uses, because it returns
  // the same thing: every row of every table. Asking for the second capability
  // here, rather than letting the database refuse it mid-call, means the operator
  // gets a sentence naming what is missing and who can grant it instead of a bare
  // 42501. `canAct` is a read, not a gate; the gates are the two asserts.
  if (getBackupMode() === "supabase" && !canAct("export_backup")) {
    throw new AppError("FORBIDDEN", "backup.health.needsExport");
  }
  const started = Date.now();
  const repository = getBackupRepository();
  const document = await repository.snapshotDocument();
  const model = healthModelFromDocument(document);
  const issues = runHealthChecks(model);
  const examined = examinedCounts(model);
  const actor = actingUser();

  const report: HealthReport = {
    ran_at: new Date(started).toISOString(),
    mode: document.mode,
    duration_ms: Date.now() - started,
    issues,
    examined,
    worst: issues[0]?.severity ?? null,
    ok: issues.every((issue) => issue.severity === "info"),
  };

  void recordAudit({
    action: "health.check_run",
    entity: "backup",
    entity_id: "health",
    entity_label: report.ok ? "clean" : String(report.worst),
    details: {
      mode: report.mode,
      duration_ms: report.duration_ms,
      critical: issues.filter((issue) => issue.severity === "critical").length,
      warning: issues.filter((issue) => issue.severity === "warning").length,
      info: issues.filter((issue) => issue.severity === "info").length,
      codes: issues.map((issue) => issue.code).join(","),
    },
    user_id: actor.id,
    user_name: actor.name,
  });

  return report;
}

/** A health report over a document the caller already holds — used by tests. */
export function healthReportFor(document: BackupDocument, now: Date = new Date()): HealthReport {
  const model = healthModelFromDocument(document);
  const issues = runHealthChecks(model);
  return {
    ran_at: now.toISOString(),
    mode: document.mode,
    duration_ms: 0,
    issues,
    examined: examinedCounts(model),
    worst: issues[0]?.severity ?? null,
    ok: issues.every((issue) => issue.severity === "info"),
  };
}
