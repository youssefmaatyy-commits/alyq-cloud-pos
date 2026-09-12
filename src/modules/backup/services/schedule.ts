/**
 * Scheduling and retention — the arithmetic of "are we protected right now?".
 *
 * Pure and clock-injectable, because every claim on the monitoring panel is a
 * comparison against `now` and a test that cannot fix the clock cannot test it.
 *
 * The honest constraint, stated plainly: a browser cannot schedule anything while
 * it is closed. So "automatic" means two things working together —
 *
 *   · in live mode, migration 0029 registers a `pg_cron` job (when the extension
 *     is available) that snapshots the database on its own schedule, with no
 *     browser involved. That is the real automatic backup;
 *   · in either mode, an open admin session checks whether one is due and asks for
 *     it. That covers demo installations, and covers a live installation whose
 *     cron job could not be created.
 *
 * Neither interrupts the till: the check is a timestamp comparison, the snapshot
 * is taken by the database or by the offline directory, and a failure is recorded
 * and dropped rather than surfaced to whoever is serving a customer.
 */
import {
  DEFAULT_BACKUP_SETTINGS,
  type BackupFrequency,
  type BackupManifest,
  type BackupSettings,
  type BackupStatus,
  type BackupStatusSummary,
} from "../types";

export const PERIOD_MS: Record<Exclude<BackupFrequency, "off">, number> = {
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
};

/** Twice the period with no snapshot is "overdue" rather than merely "due". */
const OVERDUE_FACTOR = 2;

export function isFrequency(value: unknown): value is BackupFrequency {
  return value === "off" || value === "daily" || value === "weekly";
}

/** Settings as stored, with anything unusable replaced by the default. */
export function normalizeSettings(input: unknown): BackupSettings {
  const raw = (input ?? {}) as Partial<BackupSettings>;
  const days = Number(raw.retention_days);
  const count = Number(raw.retention_count);
  return {
    frequency: isFrequency(raw.frequency) ? raw.frequency : DEFAULT_BACKUP_SETTINGS.frequency,
    retention_days: Number.isFinite(days) && days >= 1 ? Math.min(Math.round(days), 3650) : DEFAULT_BACKUP_SETTINGS.retention_days,
    retention_count: Number.isFinite(count) && count >= 1 ? Math.min(Math.round(count), 500) : DEFAULT_BACKUP_SETTINGS.retention_count,
    last_automatic_at: typeof raw.last_automatic_at === "string" ? raw.last_automatic_at : null,
    updated_at: typeof raw.updated_at === "string" ? raw.updated_at : null,
    updated_by_name: typeof raw.updated_by_name === "string" ? raw.updated_by_name : null,
  };
}

/** When the next automatic snapshot is due, or null when scheduling is off. */
export function nextDueAt(
  settings: BackupSettings,
  now: Date = new Date(),
): Date | null {
  if (settings.frequency === "off") return null;
  const period = PERIOD_MS[settings.frequency];
  const anchor = settings.last_automatic_at ? new Date(settings.last_automatic_at).getTime() : NaN;
  // No automatic snapshot yet: due now, so a fresh installation does not wait a
  // full period to become protected.
  if (!Number.isFinite(anchor)) return new Date(now.getTime());
  return new Date(anchor + period);
}

export function isDue(settings: BackupSettings, now: Date = new Date()): boolean {
  const due = nextDueAt(settings, now);
  return due !== null && due.getTime() <= now.getTime();
}

export interface StatusInput {
  settings: BackupSettings;
  manifests: readonly BackupManifest[];
  /** When a restore last ran, and who ran it — from the audit trail. */
  lastRestore?: { at: string; by: string | null } | null;
  now?: Date;
}

/**
 * The monitoring panel's answer.
 *
 * `protected` means a snapshot exists and the schedule is being met; `due` and
 * `overdue` mean the schedule has slipped by one period or two; `never` means
 * there is nothing to restore from at all, which is the state an installation is
 * in until somebody presses the button; `disabled` means an admin turned
 * scheduling off, and a snapshot may still exist.
 */
export function backupStatus({ settings, manifests, lastRestore, now = new Date() }: StatusInput): BackupStatusSummary {
  const ordered = [...manifests].sort((a, b) => b.created_at.localeCompare(a.created_at));
  const last = ordered[0] ?? null;
  const automatic = ordered.filter((manifest) => manifest.kind === "automatic");
  const lastAutomaticAt = settings.last_automatic_at ?? automatic[0]?.created_at ?? null;

  let status: BackupStatus;
  if (settings.frequency === "off") {
    status = "disabled";
  } else if (!last) {
    status = "never";
  } else {
    const due = nextDueAt({ ...settings, last_automatic_at: lastAutomaticAt }, now);
    const period = PERIOD_MS[settings.frequency];
    if (!due || due.getTime() > now.getTime()) status = "protected";
    else if (due.getTime() + period * (OVERDUE_FACTOR - 1) <= now.getTime()) status = "overdue";
    else status = "due";
  }

  return {
    status,
    last_backup: last,
    last_automatic_at: lastAutomaticAt,
    last_restore: lastRestore ?? null,
    next_automatic_due_at: settings.frequency === "off" ? null : (nextDueAt({ ...settings, last_automatic_at: lastAutomaticAt }, now)?.toISOString() ?? null),
    total_size_bytes: ordered.reduce((sum, manifest) => sum + Math.max(0, manifest.size_bytes), 0),
    backup_count: ordered.length,
    settings,
  };
}

/**
 * Which snapshots retention would remove.
 *
 * Two limits, whichever bites first: age (`retention_days`) and count
 * (`retention_count`). Three things are never pruned, because pruning them is how
 * an installation ends up with no way back:
 *
 *   · the newest snapshot of any kind;
 *   · the newest `pre_restore` snapshot — it is the rollback for the last restore;
 *   · anything when pruning would leave nothing at all.
 */
export function pruneCandidates(
  manifests: readonly BackupManifest[],
  settings: BackupSettings,
  now: Date = new Date(),
): BackupManifest[] {
  if (manifests.length <= 1) return [];

  const ordered = [...manifests].sort((a, b) => b.created_at.localeCompare(a.created_at));
  const newest = ordered[0];
  const protectedIds = new Set([newest.id]);

  // The newest rollback point is protected, but only while it is still inside the
  // window: a pre-restore snapshot of a restore done two months ago is not a way
  // back to anything anybody wants, and it holds the damaged state.
  const newestPreRestore = ordered.find((manifest) => manifest.kind === "pre_restore") ?? null;
  if (
    newestPreRestore &&
    new Date(newestPreRestore.created_at).getTime() >=
      now.getTime() - settings.retention_days * 24 * 60 * 60 * 1000
  ) {
    protectedIds.add(newestPreRestore.id);
  }

  const ageLimit = now.getTime() - settings.retention_days * 24 * 60 * 60 * 1000;
  const keepNewest = new Set(ordered.slice(0, settings.retention_count).map((entry) => entry.id));

  return ordered.filter((manifest) => {
    if (protectedIds.has(manifest.id)) return false;
    // A snapshot somebody took by hand, with a note, is theirs: retention governs
    // the automatic stream, which nobody watches. Pruning a manual snapshot would
    // quietly delete the one an operator took before a risky change.
    if (manifest.kind === "manual") return false;
    // Either limit is enough on its own, which is what the two fields promise:
    // "keep the newest N" and "nothing older than D days". A shop taking twenty
    // snapshots a day is held to the count, and a shop taking one a week is held
    // to the window.
    if (keepNewest.has(manifest.id)) {
      const created = new Date(manifest.created_at).getTime();
      return Number.isFinite(created) && created < ageLimit;
    }
    return true;
  });
}

/** Bytes, as a person reads them. */
export function formatBytes(bytes: number): string {
  const value = Math.max(0, bytes);
  if (value < 1024) return `${value} B`;
  const units = ["KB", "MB", "GB"];
  let scaled = value / 1024;
  let unit = 0;
  while (scaled >= 1024 && unit < units.length - 1) {
    scaled /= 1024;
    unit += 1;
  }
  return `${scaled >= 100 ? Math.round(scaled) : scaled.toFixed(1)} ${units[unit]}`;
}
