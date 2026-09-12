/**
 * Live backup repository — snapshots held by the database itself.
 *
 * Every method is one call to a `security definer` function in migration 0029,
 * and every one of those functions re-checks `public.can(...)` before it does
 * anything. That matters more here than elsewhere: a restore deletes the
 * installation's data, so the authority to run one has to be checked where the
 * deletion happens, not only in the browser that asked for it.
 *
 * The document itself never appears in a list. `backups` is closed to direct
 * reads and the app selects from `backup_manifests`, a view without the payload
 * column, so seeing that a backup exists (`view_backups`) and holding a copy of
 * the whole database (`export_backup`) stay two different permissions — which is
 * the difference between an admin who can reassure somebody and an admin who can
 * walk out with every customer's phone number.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseClient } from "@/lib/supabase/client";
import { AppError, toAppError } from "@/modules/products/data/repository";
import { validateBackupDocument } from "../schema";
import { normalizeSettings } from "../services/schedule";
import type { BackupRepository } from "./repository";
import type {
  BackupDocument,
  BackupKind,
  BackupManifest,
  BackupSettings,
  RestoreOutcome,
} from "../types";

const MANIFEST_COLUMNS =
  "id, kind, note, mode, schema_version, created_at, created_by, created_by_name, size_bytes, row_count, table_count, checksum, source_revision";

function translate(error: { code?: string; message?: string } | null, field?: string): never {
  const message = error?.message ?? "unknown error";
  if (error?.code === "42501" || /insufficient_privilege|Only an admin|may not/i.test(message)) {
    throw new AppError("FORBIDDEN", message);
  }
  if (error?.code === "PGRST116" || /no_data_found|no such backup|not found/i.test(message)) {
    throw new AppError("NOT_FOUND", message);
  }
  if (/backup\.error\./.test(message)) {
    // The database speaks the same codes the validator does, so a refusal reads
    // the same whichever side made it.
    throw new AppError("VALIDATION", message.trim(), field);
  }
  if (error?.code === "23505" || /duplicate key/i.test(message)) {
    throw new AppError("VALIDATION", message, field ?? "form", error?.code);
  }
  throw toAppError(error instanceof Error ? error : new Error(message));
}

function toManifest(row: Record<string, unknown>): BackupManifest {
  return {
    id: String(row.id ?? ""),
    kind: (["manual", "automatic", "pre_restore"].includes(String(row.kind))
      ? String(row.kind)
      : "manual") as BackupKind,
    note: typeof row.note === "string" ? row.note : null,
    mode: row.mode === "demo" ? "demo" : "supabase",
    schema_version: Number(row.schema_version ?? 1),
    created_at: String(row.created_at ?? new Date().toISOString()),
    created_by: typeof row.created_by === "string" ? row.created_by : null,
    created_by_name: typeof row.created_by_name === "string" ? row.created_by_name : null,
    size_bytes: Number(row.size_bytes ?? 0),
    row_count: Number(row.row_count ?? 0),
    table_count: Number(row.table_count ?? 0),
    checksum: String(row.checksum ?? ""),
    source_revision: typeof row.source_revision === "string" ? row.source_revision : null,
  };
}

function toOutcome(value: unknown, origin: "stored" | "uploaded"): RestoreOutcome {
  const raw = (value ?? {}) as Record<string, unknown>;
  return {
    ok: raw.ok !== false,
    mode: raw.mode === "demo" ? "demo" : "supabase",
    restored_at: String(raw.restored_at ?? new Date().toISOString()),
    row_count: Number(raw.row_count ?? 0),
    pre_restore_backup_id: typeof raw.pre_restore_backup_id === "string" ? raw.pre_restore_backup_id : null,
    origin,
  };
}

export class SupabaseBackupRepository implements BackupRepository {
  readonly kind = "supabase" as const;

  /** Injectable so the contract test can drive this class against a stub. */
  constructor(private readonly injected: SupabaseClient | null = null) {}

  private client(): SupabaseClient {
    const client = this.injected ?? getSupabaseClient();
    if (!client) throw new AppError("NOT_CONFIGURED", "SUPABASE_NOT_CONFIGURED");
    return client;
  }

  async listBackups(): Promise<BackupManifest[]> {
    const { data, error } = await this.client()
      .from("backup_manifests")
      .select(MANIFEST_COLUMNS)
      .order("created_at", { ascending: false })
      .limit(200);
    if (error) translate(error);
    return ((data ?? []) as Record<string, unknown>[]).map(toManifest);
  }

  async createBackup(input: { kind: BackupKind; note?: string | null }): Promise<BackupManifest> {
    const { data, error } = await this.client().rpc("create_backup", {
      p_kind: input.kind,
      p_note: input.note ?? null,
    });
    if (error) translate(error);
    return toManifest((data ?? {}) as Record<string, unknown>);
  }

  async readDocument(id: string): Promise<BackupDocument> {
    const { data, error } = await this.client().rpc("get_backup_document", { p_backup_id: id });
    if (error) translate(error);
    const document = data as unknown as BackupDocument;
    // Verified here as well as in the database: a file that has been truncated in
    // transit should be refused before it is offered as a download, and the
    // checksum is the database's own md5, which only the restore transaction can
    // recompute — so the structural checks run and the hash is left to SQL.
    const verdict = validateBackupDocument(document, { mode: "supabase", ignoreChecksum: true });
    if (!verdict.ok) throw new AppError("VALIDATION", `backup.error.${verdict.code}`);
    return verdict.document;
  }

  async snapshotDocument(): Promise<BackupDocument> {
    const { data, error } = await this.client().rpc("snapshot_document");
    if (error) translate(error);
    return data as unknown as BackupDocument;
  }

  async restoreFromId(id: string): Promise<RestoreOutcome> {
    const { data, error } = await this.client().rpc("admin_restore_backup", { p_backup_id: id });
    if (error) translate(error);
    return toOutcome(data, "stored");
  }

  async restoreFromDocument(document: BackupDocument): Promise<RestoreOutcome> {
    const verdict = validateBackupDocument(document, { mode: "supabase", ignoreChecksum: true });
    if (!verdict.ok) throw new AppError("VALIDATION", `backup.error.${verdict.code}`);
    const { data, error } = await this.client().rpc("admin_restore_document", {
      p_document: verdict.document,
    });
    if (error) translate(error);
    return toOutcome(data, "uploaded");
  }

  async getSettings(): Promise<BackupSettings> {
    const { data, error } = await this.client()
      .from("backup_settings")
      .select("frequency, retention_days, retention_count, last_automatic_at, updated_at, updated_by_name")
      .maybeSingle();
    if (error) translate(error);
    return normalizeSettings(data ?? null);
  }

  async saveSettings(patch: Partial<BackupSettings>): Promise<BackupSettings> {
    const current = await this.getSettings();
    const next = normalizeSettings({ ...current, ...patch });
    const { data, error } = await this.client().rpc("save_backup_settings", {
      p_frequency: next.frequency,
      p_retention_days: next.retention_days,
      p_retention_count: next.retention_count,
    });
    if (error) translate(error);
    return normalizeSettings(data ?? next);
  }
}

let instance: SupabaseBackupRepository | null = null;

export function getSupabaseBackupRepository(): SupabaseBackupRepository {
  if (!instance) instance = new SupabaseBackupRepository();
  return instance;
}

/** Test seam. */
export function resetSupabaseBackupRepository(): void {
  instance = null;
}
