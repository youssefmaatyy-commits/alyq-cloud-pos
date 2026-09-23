/**
 * Offline backup repository — snapshots of the browser's own stores.
 *
 * Demo mode has no database, so "the database" is a set of named keys in
 * `localStorage`. A backup here is exactly that: the allowlisted keys, parsed,
 * wrapped in the same envelope live mode uses, and stored beside them under two
 * more keys. A restore writes them back.
 *
 * Three things this file is careful about:
 *
 *   · It snapshots only what `DEMO_STORES` allows. Session, language and
 *     notification state stay out, because restoring a stale session over a live
 *     one is the kind of failure that looks like the app misbehaving rather than
 *     like a restore having happened.
 *   · It measures what it wrote. `localStorage` refuses silently when it is full,
 *     and a backup that was not stored is worse than no backup: it appears in the
 *     list. So every write is read back and a failure is an error the caller sees.
 *   · It takes a `pre_restore` snapshot before touching anything. Offline there is
 *     no transaction either, so the way back is a snapshot, not an undo.
 *
 * The credential note: the offline directory holds a salt and two digests per
 * account, and they are included — a restored installation whose accounts cannot
 * sign in has not been restored. That is also why downloading a backup is its own
 * capability.
 */
import { safeStorage } from "@/modules/products/data/demoSeed";
import { AppError } from "@/modules/products/data/repository";
import { actingUser } from "@/lib/permissions/enforce";
import {
  DEMO_RESTORE_EXCLUDED,
  DEMO_STORES,
  buildDocument,
  serializeDocument,
  validateBackupDocument,
} from "../schema";
import { normalizeSettings, pruneCandidates } from "../services/schedule";
import type { BackupRepository } from "./repository";
import type {
  BackupDocument,
  BackupKind,
  BackupManifest,
  BackupSettings,
  RestoreOutcome,
} from "../types";

const STORE_KEY = "alyq.backup.v1";
const SETTINGS_KEY = "alyq.backup.settings.v1";

interface BackupStore {
  manifests: BackupManifest[];
  documents: Record<string, BackupDocument>;
}

function emptyStore(): BackupStore {
  return { manifests: [], documents: {} };
}

function readStore(): BackupStore {
  const raw = safeStorage.get(STORE_KEY);
  if (!raw) return emptyStore();
  try {
    const parsed = JSON.parse(raw) as Partial<BackupStore>;
    return {
      manifests: Array.isArray(parsed.manifests) ? parsed.manifests : [],
      documents: parsed.documents && typeof parsed.documents === "object" ? parsed.documents : {},
    };
  } catch {
    return emptyStore();
  }
}

/** Write, then read back: `localStorage` fails silently when it is full. */
function writeStore(store: BackupStore): void {
  const serialized = JSON.stringify(store);
  try {
    window.localStorage.setItem(STORE_KEY, serialized);
  } catch (error) {
    throw new AppError("DB", "BACKUP_STORAGE_FULL", undefined, error instanceof Error ? error.name : undefined);
  }
  if (safeStorage.get(STORE_KEY) !== serialized) {
    throw new AppError("DB", "BACKUP_STORAGE_FULL");
  }
}

function newId(now: Date): string {
  const random = Math.random().toString(36).slice(2, 8);
  return `bk-${now.getTime().toString(36)}-${random}`;
}

export class DemoBackupRepository implements BackupRepository {
  readonly kind = "demo" as const;

  /** Injectable clock so a test can pin "now" and therefore every timestamp. */
  constructor(private readonly clock: () => Date = () => new Date()) {}

  /** Read every allowlisted store. An absent key is recorded as null, not []. */
  private readStores(): Record<string, unknown> {
    const stores: Record<string, unknown> = {};
    for (const key of DEMO_STORES) {
      const raw = safeStorage.get(key);
      if (raw === null) {
        stores[key] = null;
        continue;
      }
      try {
        stores[key] = JSON.parse(raw);
      } catch {
        // A store that will not parse is still worth carrying: dropping it would
        // turn "one key is corrupt" into "the backup lost that key", and the
        // health check is where corruption gets named.
        stores[key] = raw;
      }
    }
    return stores;
  }

  async snapshotDocument(): Promise<BackupDocument> {
    const actor = actingUser();
    return buildDocument({
      mode: "demo",
      kind: "manual",
      payload: { stores: this.readStores() },
      actor: { id: actor.id, name: actor.name },
      now: this.clock(),
    });
  }

  async createBackup(input: { kind: BackupKind; note?: string | null }): Promise<BackupManifest> {
    const now = this.clock();
    const actor = actingUser();
    const document = buildDocument({
      mode: "demo",
      kind: input.kind,
      note: input.note,
      payload: { stores: this.readStores() },
      actor: { id: actor.id, name: actor.name },
      now,
    });

    const id = newId(now);
    const manifest: BackupManifest = {
      id,
      kind: document.kind,
      note: document.note,
      mode: document.mode,
      schema_version: document.schema_version,
      created_at: document.created_at,
      created_by: actor.id || null,
      created_by_name: actor.name || null,
      size_bytes: serializeDocument(document).length,
      row_count: document.row_count,
      table_count: Object.keys(document.payload.stores ?? {}).length,
      checksum: document.checksum,
      source_revision: null,
    };

    const store = readStore();
    store.documents[id] = document;
    store.manifests = [manifest, ...store.manifests.filter((entry) => entry.id !== id)];

    // Retention runs on the way in, so the list cannot grow past what an admin
    // asked to keep — including when the snapshot is an automatic one nobody
    // watched happen.
    const settings = await this.getSettings();
    const prunable = pruneCandidates(store.manifests, settings, now);
    if (prunable.length > 0) {
      const ids = new Set(prunable.map((entry) => entry.id));
      store.manifests = store.manifests.filter((entry) => !ids.has(entry.id));
      for (const pruned of ids) delete store.documents[pruned];
    }

    writeStore(store);
    return manifest;
  }

  async listBackups(): Promise<BackupManifest[]> {
    return [...readStore().manifests].sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  async readDocument(id: string): Promise<BackupDocument> {
    const document = readStore().documents[id];
    if (!document) throw new AppError("NOT_FOUND", `No such backup: ${id}`);
    return document;
  }

  async restoreFromId(id: string): Promise<RestoreOutcome> {
    return this.restoreFromDocument(await this.readDocument(id), id);
  }

  async restoreFromDocument(document: BackupDocument, originId?: string): Promise<RestoreOutcome> {
    const verdict = validateBackupDocument(document, { mode: "demo" });
    if (!verdict.ok) {
      throw new AppError("VALIDATION", `backup.error.${verdict.code}`);
    }

    // The way back, taken before anything is overwritten.
    const preRestore = await this.createBackup({ kind: "pre_restore", note: "before restore" });

    const stores = (verdict.document.payload.stores ?? {}) as Record<string, unknown>;
    let restored = 0;
    try {
      for (const key of DEMO_STORES) {
        if (!Object.prototype.hasOwnProperty.call(stores, key)) continue;
        // The trail is evidence, not state: a restore rewrites the shop and adds
        // to the log, it never replaces it.
        if (DEMO_RESTORE_EXCLUDED.includes(key)) continue;
        const value = stores[key];
        if (value === null) {
          window.localStorage.removeItem(key);
          continue;
        }
        window.localStorage.setItem(key, JSON.stringify(value));
        restored += Array.isArray(value) ? value.length : 1;
      }
    } catch (error) {
      // Half-written stores are the one failure this module cannot undo itself, so
      // it says exactly that and names the snapshot that can.
      throw new AppError(
        "DB",
        `backup.error.partial_restore:${preRestore.id}`,
        undefined,
        error instanceof Error ? error.name : undefined,
      );
    }

    return {
      ok: true,
      mode: "demo",
      restored_at: this.clock().toISOString(),
      row_count: restored,
      pre_restore_backup_id: preRestore.id,
      origin: originId ? "stored" : "uploaded",
    };
  }

  async getSettings(): Promise<BackupSettings> {
    const raw = safeStorage.get(SETTINGS_KEY);
    if (!raw) return normalizeSettings(null);
    try {
      return normalizeSettings(JSON.parse(raw));
    } catch {
      return normalizeSettings(null);
    }
  }

  async saveSettings(patch: Partial<BackupSettings>): Promise<BackupSettings> {
    const next = normalizeSettings({ ...(await this.getSettings()), ...patch });
    safeStorage.set(SETTINGS_KEY, JSON.stringify(next));
    return next;
  }
}

let instance: DemoBackupRepository | null = null;

export function getDemoBackupRepository(): DemoBackupRepository {
  if (!instance) instance = new DemoBackupRepository();
  return instance;
}

/** Test seam. */
export function resetDemoBackupRepository(): void {
  instance = null;
}
