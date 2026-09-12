/**
 * Backup & recovery — the shapes everything else in the module speaks.
 *
 * One envelope for both modes. That is the whole design decision: a demo
 * installation and a Supabase installation produce the *same document shape*, so
 * the same validator, the same health checker and the same restore dialogue run
 * in either, and a backup file is self-describing rather than only meaningful
 * inside the browser that made it.
 *
 * What differs is the payload, and it has to: offline there is no database, only
 * a set of named stores in `localStorage`, and in live mode there are 35 tables
 * with foreign keys between them. So the payload carries one of two keys —
 * `tables` (live) or `stores` (demo) — and `mode` says which. A document is
 * restored into the mode that made it, and the mismatch is refused explicitly
 * rather than half-applied: restoring a demo snapshot into a live database would
 * mean guessing what each store maps to, and a guess is exactly what a restore
 * must not contain.
 *
 * Credentials: a live document never holds one — Supabase Auth keeps passwords in
 * `auth.users`, which no migration here reads or writes, so restoring profiles
 * cannot change how anybody signs in. A demo document *does* hold the offline
 * directory's salt and digests, because without them a restored installation
 * would have accounts nobody could sign in to. That is why downloading a backup
 * is its own capability (`export_backup`) rather than a side effect of seeing the
 * list, and why the download dialog says what the file contains.
 */

/** Which installation produced (and may consume) a document. */
export type BackupMode = "demo" | "supabase";

/**
 * Why a snapshot exists. `pre_restore` is the one that makes a restore
 * reversible: every restore snapshots the current state first, so "undo" is not a
 * feature anybody has to build — it is restoring the backup the restore made.
 */
export type BackupKind = "manual" | "automatic" | "pre_restore";

/** The envelope's own contract. Bumped when the shape changes, never silently. */
export const BACKUP_FORMAT = "alyq-backup" as const;
export const BACKUP_SCHEMA_VERSION = 1;

/** Business + identity stores a demo backup carries. Session state is not data. */
export type DemoStoreKey = string;

export interface BackupPayload {
  /** Live mode: table name → rows, in foreign-key dependency order. */
  tables?: Record<string, unknown[]>;
  /** Demo mode: storage key → parsed value, allowlisted in `schema.ts`. */
  stores?: Record<string, unknown>;
}

export interface BackupDocument {
  format: typeof BACKUP_FORMAT;
  schema_version: number;
  mode: BackupMode;
  kind: BackupKind;
  /** Free text an admin may add: "before the July price change". */
  note: string | null;
  created_at: string;
  created_by: { id: string; name: string };
  /** Where the snapshot came from, when the database can say (live mode). */
  source_revision: string | null;
  /** Rows per table (live) or per store (demo) — the manifest's honest summary. */
  counts: Record<string, number>;
  row_count: number;
  size_bytes: number;
  /**
   * Corruption detection over the payload, not a signature. Live documents carry
   * the database's own `md5`; demo documents carry the FNV-1a hash computed here.
   * Either way it answers "was this file truncated or edited by hand?", and the
   * authority to restore comes from the capability check, never from the hash.
   */
  checksum: string;
  payload: BackupPayload;
}

/** One row of the backup list — the document itself is never part of it. */
export interface BackupManifest {
  id: string;
  kind: BackupKind;
  note: string | null;
  mode: BackupMode;
  schema_version: number;
  created_at: string;
  created_by: string | null;
  created_by_name: string | null;
  size_bytes: number;
  row_count: number;
  /** How many tables (live) or stores (demo) the document holds. */
  table_count: number;
  checksum: string;
  source_revision: string | null;
}

export type BackupFrequency = "off" | "daily" | "weekly";

/** The schedule, and how long snapshots are kept. One row, one installation. */
export interface BackupSettings {
  frequency: BackupFrequency;
  /** Snapshots older than this are pruned when a new automatic one is written. */
  retention_days: number;
  /** …and however many are kept, so a busy week cannot fill the disk. */
  retention_count: number;
  last_automatic_at: string | null;
  updated_at: string | null;
  updated_by_name: string | null;
}

export const DEFAULT_BACKUP_SETTINGS: BackupSettings = {
  frequency: "daily",
  retention_days: 30,
  retention_count: 14,
  last_automatic_at: null,
  updated_at: null,
  updated_by_name: null,
};

export interface RestoreOutcome {
  ok: boolean;
  mode: BackupMode;
  restored_at: string;
  row_count: number;
  /** The snapshot taken before anything was deleted — the way back. */
  pre_restore_backup_id: string | null;
  origin: "stored" | "uploaded";
}

/** What a restore refused to do, in a code the UI can translate. */
export type RestoreErrorCode =
  | "not_found"
  | "bad_format"
  | "bad_version"
  | "mode_mismatch"
  | "checksum_mismatch"
  | "incomplete"
  | "forbidden"
  | "failed";

// ── data health ──────────────────────────────────────────────────────────────

export type HealthArea =
  | "inventory"
  | "sales"
  | "customers"
  | "online"
  | "identity"
  | "audit"
  | "financial";

export type HealthSeverity = "critical" | "warning" | "info";

/**
 * One finding. The message and the recommendation are dictionary keys, so a
 * report reads in the operator's language and a code can be asserted in a test
 * without pinning prose.
 */
export interface HealthIssue {
  code: string;
  area: HealthArea;
  severity: HealthSeverity;
  messageKey: string;
  recommendationKey: string;
  /** How many records are affected — the difference between a nuisance and a fire. */
  count: number;
  /** A few identifiers, so the report points at something rather than at a number. */
  samples: string[];
}

export interface HealthReport {
  ran_at: string;
  mode: BackupMode;
  duration_ms: number;
  issues: HealthIssue[];
  /** What was examined — a clean report is only meaningful next to its scope. */
  examined: Record<string, number>;
  worst: HealthSeverity | null;
  ok: boolean;
}

/** The monitoring panel's one-line answer: are we protected right now? */
export type BackupStatus = "protected" | "due" | "overdue" | "never" | "disabled";

export interface BackupStatusSummary {
  status: BackupStatus;
  last_backup: BackupManifest | null;
  last_automatic_at: string | null;
  last_restore: { at: string; by: string | null } | null;
  next_automatic_due_at: string | null;
  total_size_bytes: number;
  backup_count: number;
  settings: BackupSettings;
}
