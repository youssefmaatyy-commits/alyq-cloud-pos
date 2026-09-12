/**
 * Backup repository contract — snapshots, restores and the schedule.
 *
 * Two implementations, one interface, chosen by `data/index.ts` exactly like
 * every other module:
 *
 *   demo     the offline stores in `localStorage`, snapshotted into the same
 *            envelope and kept beside the data they describe
 *   supabase `backups` + `backup_settings`, written only through `security
 *            definer` functions that re-check `public.can(...)` server-side
 *
 * The split matters more here than anywhere else in the app, because this is the
 * one module whose job is to be right when everything else has already gone
 * wrong. So the contract is deliberately small and every method is whole:
 * a snapshot is one document, a restore is one transaction, and there is no
 * method that writes half of either.
 *
 * Note what is *not* here: deleting a backup. Retention prunes automatically
 * inside `createBackup`, and a manual delete button would be the only way in this
 * module to destroy a way back — so there is no button and no method.
 */
import type {
  BackupDocument,
  BackupKind,
  BackupManifest,
  BackupSettings,
  RestoreOutcome,
} from "../types";

export interface BackupRepository {
  readonly kind: "demo" | "supabase";

  /** Every snapshot this installation holds, newest first, metadata only. */
  listBackups(): Promise<BackupManifest[]>;

  /**
   * Take a snapshot now. `automatic` is what the scheduler asks for and
   * `pre_restore` is what a restore takes before it deletes anything; both go
   * through the same path as a manual one, so a rollback is an ordinary backup.
   */
  createBackup(input: { kind: BackupKind; note?: string | null }): Promise<BackupManifest>;

  /** One stored document, for download or for verifying before a restore. */
  readDocument(id: string): Promise<BackupDocument>;

  /**
   * Build a document without storing it. The health checker reads through this:
   * it needs the same complete picture a backup has, and it must not leave a
   * snapshot behind every time somebody looks.
   */
  snapshotDocument(): Promise<BackupDocument>;

  /** Restore a stored snapshot. The implementation snapshots first. */
  restoreFromId(id: string): Promise<RestoreOutcome>;

  /**
   * Restore a document that arrived as a file. Validated by the same rules, and
   * it also snapshots the current state first — an uploaded file is not trusted
   * more than a stored one, it is trusted less.
   */
  restoreFromDocument(document: BackupDocument): Promise<RestoreOutcome>;

  getSettings(): Promise<BackupSettings>;
  saveSettings(patch: Partial<BackupSettings>): Promise<BackupSettings>;
}
