import { getOfflineDb, hasPersistentOfflineStorage } from "./db";
import {
  OFFLINE_BUSINESS_SCHEMA_VERSION,
  OFFLINE_CATALOG_SCHEMA_VERSION,
  type OfflineSaleRecord,
  type SyncOutboxEntry,
} from "./types";

const BUSINESS_VERSION_KEY = "offline_business_schema_version";
const CATALOG_VERSION_KEY = "offline_catalog_schema_version";

export interface OfflineSchemaHealth {
  compatible: boolean;
  businessVersion: number | null;
  expectedBusinessVersion: number;
  catalogVersion: number | null;
  expectedCatalogVersion: number;
  persistent: boolean;
  migrated: boolean;
  detail: "current" | "upgraded" | "newer_than_app" | "unavailable";
}

function versionOf(value: string | undefined): number | null {
  if (!value || !/^\d+$/.test(value)) return null;
  return Number(value);
}

/**
 * Upgrade local structures without ever clearing a business store. Disposable
 * catalogue rows may be invalidated independently; outbox, receipts and lines
 * are migrated in place and remain durable.
 */
export async function ensureOfflineSchema(): Promise<OfflineSchemaHealth> {
  const db = getOfflineDb();
  try {
    const [businessMeta, catalogMeta] = await Promise.all([
      db.get<{ key: string; value: string }>("sync_metadata", BUSINESS_VERSION_KEY),
      db.get<{ key: string; value: string }>("sync_metadata", CATALOG_VERSION_KEY),
    ]);
    const businessVersion = versionOf(businessMeta?.value);
    const catalogVersion = versionOf(catalogMeta?.value);
    if (businessVersion !== null && businessVersion > OFFLINE_BUSINESS_SCHEMA_VERSION) {
      return {
        compatible: false,
        businessVersion,
        expectedBusinessVersion: OFFLINE_BUSINESS_SCHEMA_VERSION,
        catalogVersion,
        expectedCatalogVersion: OFFLINE_CATALOG_SCHEMA_VERSION,
        persistent: hasPersistentOfflineStorage(),
        migrated: false,
        detail: "newer_than_app",
      };
    }

    let migrated = businessVersion !== OFFLINE_BUSINESS_SCHEMA_VERSION;
    if (migrated) {
      const [sales, entries] = await Promise.all([
        db.getAll<Omit<OfflineSaleRecord, "sync_status"> & { sync_status?: string }>("offline_sales"),
        db.getAll<Omit<SyncOutboxEntry, "status"> & { status?: string }>("sync_outbox"),
      ]);
      await db.putBatch([
        ...sales.map((sale) => ({
          store: "offline_sales" as const,
          value: {
            ...sale,
            schema_version: OFFLINE_BUSINESS_SCHEMA_VERSION,
            sync_status: sale.sync_status === "error"
              ? (sale.last_error_kind === "conflict" ? "conflict" : "failed")
              : (sale.sync_status ?? "pending"),
          },
        })),
        ...entries.map((entry) => ({
          store: "sync_outbox" as const,
          value: {
            ...entry,
            operation_type: "sale.complete" as const,
            schema_version: OFFLINE_BUSINESS_SCHEMA_VERSION,
            status: entry.status === "error"
              ? (entry.last_error_kind === "conflict" ? "conflict" : "failed")
              : (entry.status ?? "pending"),
          },
        })),
        {
          store: "sync_metadata" as const,
          value: { key: BUSINESS_VERSION_KEY, value: String(OFFLINE_BUSINESS_SCHEMA_VERSION) },
        },
      ]);
    }

    // The catalogue is disposable and branch-qualified. A structural mismatch
    // is repaired by removing only those rows; pending receipts/outbox survive.
    if (catalogVersion !== OFFLINE_CATALOG_SCHEMA_VERSION) {
      await db.clear("cached_products");
      await db.clear("cached_variants");
      await db.put("sync_metadata", {
        key: CATALOG_VERSION_KEY,
        value: String(OFFLINE_CATALOG_SCHEMA_VERSION),
      });
      migrated = true;
    }

    return {
      compatible: true,
      businessVersion: OFFLINE_BUSINESS_SCHEMA_VERSION,
      expectedBusinessVersion: OFFLINE_BUSINESS_SCHEMA_VERSION,
      catalogVersion: OFFLINE_CATALOG_SCHEMA_VERSION,
      expectedCatalogVersion: OFFLINE_CATALOG_SCHEMA_VERSION,
      persistent: hasPersistentOfflineStorage(),
      migrated,
      detail: migrated ? "upgraded" : "current",
    };
  } catch {
    return {
      compatible: false,
      businessVersion: null,
      expectedBusinessVersion: OFFLINE_BUSINESS_SCHEMA_VERSION,
      catalogVersion: null,
      expectedCatalogVersion: OFFLINE_CATALOG_SCHEMA_VERSION,
      persistent: hasPersistentOfflineStorage(),
      migrated: false,
      detail: "unavailable",
    };
  }
}

/** Refresh only last-known catalogue data. Durable business stores are excluded. */
export async function clearDisposableCatalogCache(): Promise<void> {
  const db = getOfflineDb();
  await db.clear("cached_products");
  await db.clear("cached_variants");
  await db.delete("sync_metadata", "catalog_cached_at");
  await db.delete("sync_metadata", "catalog_branch_id");
}
