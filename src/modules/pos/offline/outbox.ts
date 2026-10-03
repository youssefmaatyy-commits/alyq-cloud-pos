/**
 * The offline sale queue and sync engine.
 *
 * A sale completed while offline is written HERE first (`enqueueOfflineSale`)
 * — into `offline_sales` / `offline_sale_lines` / `sync_outbox` — and only
 * ever reaches the server later, when `processOutbox` (or the manual retry
 * button) replays its `CompleteSaleInput` through the exact same guarded
 * completion path (`saleService.completeSale`) an online sale would have
 * used. The payload — and critically its `client_ref` — is never rebuilt or
 * regenerated between attempts: the same idempotency key is replayed every
 * time, which is what makes a retry (automatic or manual) safe.
 *
 * Duplicate protection has two independent layers, and this module owns
 * neither of them — it only has to not defeat them:
 *
 *   1. `pos_complete_sale` (migration 0007 → 0055) checks `client_ref`
 *      first and returns the existing sale id if one is already there —
 *      calling it twice with the same input is a no-op the second time.
 *   2. `sales.client_ref` carries a database `unique` constraint — belt to
 *      the RPC's own braces, even under a race.
 *
 * A queued sale is removed from the outbox ONLY after the server call
 * returns successfully (a real sale id came back) — never optimistically,
 * and never on a timer. A failed attempt updates the entry's error fields
 * and leaves it queued; nothing here ever deletes a failed sale.
 */
import type { CompleteSaleInput, Sale, SalePaymentInput } from "../types";
import { AppError } from "@/modules/products/data/repository";
import { getOfflineDb, type OfflineWrite } from "./db";
import { reportNetworkResult, reportSyncActivity } from "./connectivity";
import { ensureOfflineSchema } from "./schema";
import {
  OFFLINE_BUSINESS_SCHEMA_VERSION,
  offlineSaleToDisplaySale,
  type OfflineSaleLine,
  type OfflineSaleRecord,
  type OfflineSyncErrorKind,
  type SafeSyncOperation,
  type SyncOutboxEntry,
  type SyncRunResult,
} from "./types";

function newId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `local-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

/** What a cart line looks like at the moment it is frozen into an offline sale. */
export interface OfflineCartLineInput {
  product_id: string;
  variant_id: string | null;
  qty: number;
  discount_type: "none" | "percent" | "fixed";
  discount_value: number;
  name_en: string;
  name_ar: string;
  sku: string;
  barcode?: string | null;
  color_ar?: string | null;
  color_en?: string | null;
  size_value?: string | null;
  unit_price: number;
}

export interface EnqueueOfflineSaleMeta {
  subtotal: number;
  discount_amount: number;
  total: number;
  /** Server-resolved active branch whose cached shelves were used. */
  branch_id?: string | null;
}

/** Write a completed-while-offline sale locally and queue it for sync. */
export async function enqueueOfflineSale(
  input: CompleteSaleInput,
  lines: OfflineCartLineInput[],
  meta: EnqueueOfflineSaleMeta,
  catalogWrites: readonly OfflineWrite[] = [],
): Promise<OfflineSaleRecord> {
  const schema = await ensureOfflineSchema();
  if (!schema.compatible) throw new AppError("VALIDATION", "Offline storage schema is not compatible with this app version");
  const db = getOfflineDb();
  const localId = newId();
  const createdAt = new Date().toISOString();
  const branchId = meta.branch_id ?? null;
  const queuedInput: CompleteSaleInput = branchId
    ? {
        ...input,
        offline_evidence: input.offline_evidence ?? {
          schema_version: 1,
          branch_id: branchId,
          captured_at: createdAt,
          subtotal: meta.subtotal,
          discount_amount: meta.discount_amount,
          total: meta.total,
          lines: lines.map((line) => ({
            product_id: line.product_id,
            variant_id: line.variant_id,
            qty: line.qty,
            unit_price: line.unit_price,
            sku: line.sku,
            barcode: line.barcode ?? null,
            color_ar: line.color_ar ?? null,
            color_en: line.color_en ?? null,
            size_value: line.size_value ?? null,
          })),
        },
      }
    : input;

  const record: OfflineSaleRecord = {
    id: localId,
    client_ref: input.client_ref,
    created_at: createdAt,
    branch_id: branchId,
    input: queuedInput,
    subtotal: meta.subtotal,
    discount_amount: meta.discount_amount,
    total: meta.total,
    customer_id: input.customer_id ?? null,
    customer_name: input.customer_name ?? null,
    customer_phone: input.customer_phone ?? null,
    user_id: input.user_id,
    user_name: input.user_name,
    schema_version: OFFLINE_BUSINESS_SCHEMA_VERSION,
    sync_status: "pending",
    server_id: null,
    server_sale_number: null,
    synced_at: null,
    sync_attempts: 0,
    last_attempt_at: null,
    last_error: null,
    last_error_kind: null,
  };
  const saleLines: OfflineSaleLine[] = lines.map((line, index) => ({
    id: `${localId}::${index}`,
    local_sale_id: localId,
    branch_id: meta.branch_id ?? null,
    product_id: line.product_id,
    variant_id: line.variant_id,
    qty: line.qty,
    discount_type: line.discount_type,
    discount_value: line.discount_value,
    name_en: line.name_en,
    name_ar: line.name_ar,
    sku: line.sku,
    barcode: line.barcode ?? null,
    color_ar: line.color_ar ?? null,
    color_en: line.color_en ?? null,
    size_value: line.size_value ?? null,
    unit_price: line.unit_price,
  }));
  const outboxEntry: SyncOutboxEntry = {
    client_ref: input.client_ref,
    local_sale_id: localId,
    branch_id: branchId,
    created_at: createdAt,
    operation_type: "sale.complete",
    schema_version: OFFLINE_BUSINESS_SCHEMA_VERSION,
    attempts: 0,
    last_attempt_at: null,
    next_attempt_at: null,
    status: "pending",
    last_error: null,
    last_error_kind: null,
  };

  // The receipt, its exact-variant lines and its outbox pointer are one unit of
  // work. A browser close/quota/clone failure may commit all three stores or
  // none of them — never a sale with no lines, or a sale the sync engine cannot
  // find. All values above are structured-clone-safe primitives/plain objects.
  await db.putBatch([
    { store: "offline_sales", value: record },
    ...saleLines.map((value) => ({ store: "offline_sale_lines" as const, value })),
    { store: "sync_outbox", value: outboxEntry },
    ...catalogWrites,
  ]);
  return record;
}

/** The just-queued (or just-updated) sale, ready to render immediately. */
export async function getOfflineSaleDisplay(localId: string): Promise<Sale | undefined> {
  const db = getOfflineDb();
  const [record, allLines] = await Promise.all([
    db.get<OfflineSaleRecord>("offline_sales", localId),
    db.getAll<OfflineSaleLine>("offline_sale_lines"),
  ]);
  if (!record) return undefined;
  return offlineSaleToDisplaySale(record, allLines);
}

const LAST_SYNCED_AT_KEY = "last_synced_at";

export async function getLastSyncedAt(): Promise<string | null> {
  const db = getOfflineDb();
  const meta = await db.get<{ key: string; value: string }>("sync_metadata", LAST_SYNCED_AT_KEY);
  return meta?.value ?? null;
}

/** Every offline sale record not yet confirmed synced, newest first, ready to render. */
export async function getOfflineSalesForDisplay(): Promise<Sale[]> {
  const db = getOfflineDb();
  const [records, lines] = await Promise.all([
    db.getAll<OfflineSaleRecord>("offline_sales"),
    db.getAll<OfflineSaleLine>("offline_sale_lines"),
  ]);
  return records
    .filter((record) => record.sync_status !== "synced")
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
    .map((record) => offlineSaleToDisplaySale(record, lines));
}

export interface SyncSummary {
  pendingCount: number;
  failedCount: number;
  /** Compatibility alias used by existing POS badges. */
  errorCount: number;
  deferredCount: number;
  conflictCount: number;
  syncing: boolean;
  oldestPendingAt: string | null;
}

export async function getSyncSummary(activeBranchId: string | null = null): Promise<SyncSummary> {
  const schema = await ensureOfflineSchema();
  const db = getOfflineDb();
  const entries = await db.getAll<SyncOutboxEntry>("sync_outbox");
  if (!schema.compatible) {
    return { pendingCount: 0, failedCount: 0, errorCount: 0, deferredCount: entries.length, conflictCount: 0, syncing: false, oldestPendingAt: entries.map((entry) => entry.created_at).sort()[0] ?? null };
  }
  const deferredByBranch = (entry: SyncOutboxEntry) => Boolean(activeBranchId && (!entry.branch_id || entry.branch_id !== activeBranchId));
  const pending = entries.filter((entry) => entry.status === "pending" && !deferredByBranch(entry));
  const failedCount = entries.filter((entry) => entry.status === "failed").length;
  const deferredCount = entries.filter((entry) => entry.status === "deferred" || deferredByBranch(entry)).length;
  const conflictCount = entries.filter((entry) => entry.status === "conflict" || entry.last_error_kind === "conflict").length;
  return {
    pendingCount: pending.length,
    failedCount,
    errorCount: failedCount,
    deferredCount,
    conflictCount,
    syncing: entries.some((entry) => entry.status === "syncing"),
    oldestPendingAt: [...entries]
      .filter((entry) => entry.status !== "conflict")
      .sort((a, b) => a.created_at.localeCompare(b.created_at))[0]?.created_at ?? null,
  };
}

/** Remove token-like or overly detailed backend text before local display/storage. */
export function safeSyncErrorSummary(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/(bearer|access[_ -]?token|refresh[_ -]?token|service[_ -]?role|private[_ -]?key|api[_ -]?key|password|pin|cookie|card[_ -]?number)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]")
    .replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, "[redacted-token]")
    .replace(/\b01[0125]\d{8}\b/g, "[redacted-phone]")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[redacted-email]")
    .slice(0, 240);
}

/** Coarse classification so the UI and bounded retry policy react differently. */
function classifySyncError(error: unknown): { kind: OfflineSyncErrorKind; message: string } {
  const message = safeSyncErrorSummary(error);
  if (error instanceof AppError) {
    if (error.code === "NETWORK") return { kind: "network", message };
    if (error.code === "FORBIDDEN" || error.pgCode === "42501") return { kind: "permission", message };
    if (error.code === "VARIANT_STOCK_INSUFFICIENT" || error.code === "VARIANT_UNAVAILABLE") {
      return { kind: "conflict", message };
    }
  }
  if (/offline (pricing|stock|evidence) conflict|in stock|no longer sold|variant.*available/i.test(message)) {
    return { kind: "conflict", message };
  }
  if (/permission|not permitted|access denied|active branch|membership|sale not found in active branch/i.test(message)) {
    return { kind: "permission", message };
  }
  if (/schema|migration|function .* does not exist|pos_sync_offline_sale/i.test(message)) {
    return { kind: "schema", message };
  }
  return { kind: "rejected", message };
}

/** Exponential backoff for the AUTOMATIC retry loop only; manual retry ignores it. */
const MAX_AUTOMATIC_ATTEMPTS = 5;

function backoffMs(attempts: number): number {
  const steps = [5_000, 15_000, 30_000, 60_000, 120_000];
  return steps[Math.min(attempts, steps.length - 1)];
}

export type CompleteSaleFn = (input: CompleteSaleInput) => Promise<Sale>;

/** Attempt one outbox entry. Never throws — the result is recorded either way. */
async function attemptEntry(entry: SyncOutboxEntry, complete: CompleteSaleFn): Promise<
  { outcome: "synced"; sale: Sale } | { outcome: "failed"; kind: OfflineSyncErrorKind; message: string }
> {
  const db = getOfflineDb();
  const now = new Date().toISOString();
  await db.put<SyncOutboxEntry>("sync_outbox", { ...entry, status: "syncing", last_attempt_at: now });
  const record = await db.get<OfflineSaleRecord>("offline_sales", entry.local_sale_id);
  if (!record) {
    // Never silently delete a broken pointer. It is non-retryable, but remains
    // visible to support rather than pretending a business operation synced.
    const message = "Offline sale record is unavailable";
    await db.put<SyncOutboxEntry>("sync_outbox", {
      ...entry,
      status: "deferred",
      last_attempt_at: now,
      last_error: message,
      last_error_kind: "schema",
    });
    return { outcome: "failed", kind: "schema", message };
  }
  try {
    const sale = await complete(record.input);
    reportNetworkResult("success");
    await db.put<OfflineSaleRecord>("offline_sales", {
      ...record,
      sync_status: "synced",
      server_id: sale.id,
      server_sale_number: sale.sale_number,
      synced_at: new Date().toISOString(),
      sync_attempts: entry.attempts + 1,
      last_attempt_at: now,
      last_error: null,
      last_error_kind: null,
    });
    await db.delete("sync_outbox", entry.client_ref);
    await db.put("sync_metadata", { key: LAST_SYNCED_AT_KEY, value: new Date().toISOString() });
    await pruneSyncedHistory();
    return { outcome: "synced", sale };
  } catch (error) {
    const { kind, message } = classifySyncError(error);
    reportNetworkResult(kind === "network" ? "network-error" : "other-error");
    const attempts = entry.attempts + 1;
    const status: SyncOutboxEntry["status"] = kind === "conflict"
      ? "conflict"
      : kind === "permission" || kind === "branch" || kind === "schema"
        ? "deferred"
        : "failed";
    await db.put<SyncOutboxEntry>("sync_outbox", {
      ...entry,
      status,
      attempts,
      last_attempt_at: new Date().toISOString(),
      next_attempt_at: new Date(Date.now() + backoffMs(attempts)).toISOString(),
      last_error: message,
      last_error_kind: kind,
    });
    await db.put<OfflineSaleRecord>("offline_sales", {
      ...record,
      sync_status: status,
      sync_attempts: attempts,
      last_attempt_at: now,
      last_error: message,
      last_error_kind: kind,
    });
    return { outcome: "failed", kind, message };
  }
}

const SYNC_HISTORY_LIMIT = 100;

async function pruneSyncedHistory(limit = SYNC_HISTORY_LIMIT): Promise<void> {
  const db = getOfflineDb();
  const records = (await db.getAll<OfflineSaleRecord>("offline_sales"))
    .filter((record) => record.sync_status === "synced")
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
  const stale = records.slice(limit);
  if (stale.length === 0) return;
  const staleIds = new Set(stale.map((record) => record.id));
  const lines = await db.getAll<OfflineSaleLine>("offline_sale_lines");
  for (const record of stale) await db.delete("offline_sales", record.id);
  for (const line of lines) if (staleIds.has(line.local_sale_id)) await db.delete("offline_sale_lines", line.id);
}

function retryable(entry: SyncOutboxEntry, activeBranchId: string | null): boolean {
  if (activeBranchId && entry.branch_id !== activeBranchId) return false;
  return entry.status === "pending" || (entry.status === "failed" && entry.last_error_kind === "network")
    || (entry.status === "deferred" && entry.last_error_kind === "branch");
}

/** Safe, bounded queue/history projection; never exposes payment/customer/raw payload data. */
export async function listSafeSyncOperations(activeBranchId: string | null = null, limit = SYNC_HISTORY_LIMIT): Promise<SafeSyncOperation[]> {
  const schema = await ensureOfflineSchema();
  if (!schema.compatible) return [];
  const db = getOfflineDb();
  const [entries, records, lines] = await Promise.all([
    db.getAll<SyncOutboxEntry>("sync_outbox"),
    db.getAll<OfflineSaleRecord>("offline_sales"),
    db.getAll<OfflineSaleLine>("offline_sale_lines"),
  ]);
  const entriesByRef = new Map(entries.map((entry) => [entry.client_ref, entry]));
  const ordered = records.sort((a, b) => b.created_at.localeCompare(a.created_at));
  const active = ordered.filter((record) => record.sync_status !== "synced");
  const history = ordered
    .filter((record) => record.sync_status === "synced")
    .slice(0, Math.max(1, Math.min(limit, SYNC_HISTORY_LIMIT)));
  // Never hide an unsynced business operation merely to enforce the history
  // bound. Only confirmed technical history is capped.
  return [...active, ...history]
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .map((record) => {
      const entry = entriesByRef.get(record.client_ref);
      const branchDeferred = Boolean(entry && activeBranchId && entry.branch_id !== activeBranchId);
      const status = branchDeferred ? "deferred" : (entry?.status ?? record.sync_status);
      return {
        client_ref: record.client_ref,
        local_sale_id: record.id,
        operation_type: entry?.operation_type ?? "sale.complete",
        branch_id: record.branch_id ?? entry?.branch_id ?? null,
        user_name: record.user_name,
        created_at: record.created_at,
        attempts: entry?.attempts ?? record.sync_attempts ?? 0,
        last_attempt_at: entry?.last_attempt_at ?? record.last_attempt_at ?? record.synced_at,
        next_attempt_at: entry?.next_attempt_at ?? null,
        status,
        error_kind: branchDeferred ? "branch" : (entry?.last_error_kind ?? record.last_error_kind),
        error_summary: branchDeferred ? "Queued for its original branch" : (entry?.last_error ?? record.last_error),
        retryable: entry ? retryable(entry, activeBranchId) : false,
        total: record.total,
        lines: lines.filter((line) => line.local_sale_id === record.id).map((line) => ({
          product_id: line.product_id,
          variant_id: line.variant_id,
          sku: line.sku,
          barcode: line.barcode ?? null,
          color_ar: line.color_ar ?? null,
          color_en: line.color_en ?? null,
          size_value: line.size_value ?? null,
          qty: line.qty,
        })),
        synced_at: record.synced_at,
        server_sale_number: record.server_sale_number,
      } satisfies SafeSyncOperation;
    });
}

/**
 * One sync pass. `retryNetwork` ignores transient-network backoff only; it
 * never bypasses stock conflicts, permission/schema refusals or rejected
 * business rules. Without it, only never-tried and due network rows run.
 */
export interface ProcessOutboxOptions {
  /** Explicit user action: bypass backoff/max only for transient network rows. */
  retryNetwork?: boolean;
  /** A verified reconnect may bypass backoff, but never the automatic-attempt cap. */
  recovery?: boolean;
  /** Replay only rows captured for this active branch. Unscoped legacy rows are deferred. */
  branchId?: string | null;
  /** Manual retry of one stable operation; never rebuilds its client reference. */
  clientRef?: string;
}

async function processOutboxPass(complete: CompleteSaleFn, options: ProcessOutboxOptions = {}): Promise<SyncRunResult> {
  const schema = await ensureOfflineSchema();
  const db = getOfflineDb();
  const entries = await db.getAll<SyncOutboxEntry>("sync_outbox");
  if (!schema.compatible) {
    // Fail closed without writing into a newer/unknown durable format. An older
    // application may inspect health, but must not "normalize" business rows it
    // does not understand.
    return { synced: [], failed: entries.map((entry) => entry.local_sale_id), conflicts: [] };
  }

  // Persist the reason another branch's rows are not eligible. Returning to the
  // original branch makes them eligible again without changing their identity.
  if (options.branchId) {
    for (const entry of entries) {
      if (!entry.branch_id || entry.branch_id !== options.branchId) {
        const message = entry.branch_id ? "Queued for its original branch" : "Original branch is unavailable";
        await db.put<SyncOutboxEntry>("sync_outbox", {
          ...entry,
          status: "deferred",
          last_error_kind: "branch",
          last_error: message,
        });
        const record = await db.get<OfflineSaleRecord>("offline_sales", entry.local_sale_id);
        if (record) await db.put<OfflineSaleRecord>("offline_sales", { ...record, sync_status: "deferred", last_error_kind: "branch", last_error: message });
      }
    }
  }
  const now = Date.now();
  const due = entries
    .filter((entry) => entry.status !== "syncing")
    .filter((entry) => !options.clientRef || entry.client_ref === options.clientRef)
    // A branch switch must never redirect already-captured stock. Unscoped
    // legacy rows also fail closed when an active branch is asserted.
    .filter((entry) => !options.branchId || entry.branch_id === options.branchId)
    .filter((entry) => {
      if (entry.status === "pending") return true;
      if (entry.status === "deferred" && entry.last_error_kind === "branch") return true;
      if (entry.status !== "failed" || entry.last_error_kind !== "network") return false;
      if (options.retryNetwork) return true;
      if (entry.attempts >= MAX_AUTOMATIC_ATTEMPTS) return false;
      if (options.recovery) return true;
      return !entry.next_attempt_at || new Date(entry.next_attempt_at).getTime() <= now;
    })
    .sort((a, b) => (a.created_at < b.created_at ? -1 : 1));

  const result: SyncRunResult = { synced: [], failed: [], conflicts: [] };
  for (const entry of due) {
    const outcome = await attemptEntry(entry, complete);
    if (outcome.outcome === "synced") result.synced.push(entry.local_sale_id);
    else if (outcome.kind === "conflict") result.conflicts.push(entry.local_sale_id);
    else result.failed.push(entry.local_sale_id);
  }
  return result;
}

// Connectivity, the 20-second timer and the manual button can all fire in the
// same tick. Serialize them here so two passes can never read the same pending
// row before either has marked/deleted it. Server idempotency remains the final
// guard, but the client now also makes only one RPC for one queued sale.
let activeSync: Promise<SyncRunResult> | null = null;

export function processOutbox(complete: CompleteSaleFn, options: ProcessOutboxOptions = {}): Promise<SyncRunResult> {
  if (activeSync) return activeSync;
  reportSyncActivity("syncing");
  activeSync = processOutboxPass(complete, options)
    .then((result) => {
      reportSyncActivity(result.failed.length || result.conflicts.length ? "error" : "idle");
      return result;
    })
    .catch((error) => {
      reportSyncActivity("error");
      throw error;
    })
    .finally(() => {
      activeSync = null;
    });
  return activeSync;
}

/** Test/support seam that bypasses transient-network backoff only. */
export async function retrySyncNow(complete: CompleteSaleFn, branchId?: string | null): Promise<SyncRunResult> {
  return processOutbox(complete, { retryNetwork: true, branchId });
}

/** Retry exactly one eligible row with its original immutable input/client_ref. */
export async function retrySyncOperation(
  clientRef: string,
  complete: CompleteSaleFn,
  branchId: string | null,
): Promise<SyncRunResult> {
  const db = getOfflineDb();
  const entry = await db.get<SyncOutboxEntry>("sync_outbox", clientRef);
  if (!entry || !retryable(entry, branchId)) return { synced: [], failed: [], conflicts: [] };
  return processOutbox(complete, { clientRef, retryNetwork: true, branchId });
}

/** True when at least one queued sale exists in any attention state. */
export async function hasQueuedSales(): Promise<boolean> {
  const summary = await getSyncSummary();
  return summary.pendingCount + summary.failedCount + summary.deferredCount + summary.conflictCount > 0;
}

/** Test-only helper: build a minimal, valid `SalePaymentInput[]` for cash. */
export function cashPayment(amount: number, tendered?: number): SalePaymentInput[] {
  return [{ method: "cash", amount, status: "paid", tendered: tendered ?? amount }];
}
