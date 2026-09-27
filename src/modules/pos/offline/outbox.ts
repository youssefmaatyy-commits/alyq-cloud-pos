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
import { reportNetworkResult } from "./connectivity";
import {
  offlineSaleToDisplaySale,
  type OfflineSaleLine,
  type OfflineSaleRecord,
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
  unit_price: number;
}

export interface EnqueueOfflineSaleMeta {
  subtotal: number;
  discount_amount: number;
  total: number;
}

/** Write a completed-while-offline sale locally and queue it for sync. */
export async function enqueueOfflineSale(
  input: CompleteSaleInput,
  lines: OfflineCartLineInput[],
  meta: EnqueueOfflineSaleMeta,
  catalogWrites: readonly OfflineWrite[] = [],
): Promise<OfflineSaleRecord> {
  const db = getOfflineDb();
  const localId = newId();
  const createdAt = new Date().toISOString();

  const record: OfflineSaleRecord = {
    id: localId,
    client_ref: input.client_ref,
    created_at: createdAt,
    input,
    subtotal: meta.subtotal,
    discount_amount: meta.discount_amount,
    total: meta.total,
    customer_id: input.customer_id ?? null,
    customer_name: input.customer_name ?? null,
    customer_phone: input.customer_phone ?? null,
    user_id: input.user_id,
    user_name: input.user_name,
    sync_status: "pending",
    server_id: null,
    server_sale_number: null,
    synced_at: null,
    last_error: null,
    last_error_kind: null,
  };
  const saleLines: OfflineSaleLine[] = lines.map((line, index) => ({
    id: `${localId}::${index}`,
    local_sale_id: localId,
    product_id: line.product_id,
    variant_id: line.variant_id,
    qty: line.qty,
    discount_type: line.discount_type,
    discount_value: line.discount_value,
    name_en: line.name_en,
    name_ar: line.name_ar,
    sku: line.sku,
    unit_price: line.unit_price,
  }));
  const outboxEntry: SyncOutboxEntry = {
    client_ref: input.client_ref,
    local_sale_id: localId,
    created_at: createdAt,
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
  errorCount: number;
  conflictCount: number;
  syncing: boolean;
}

export async function getSyncSummary(): Promise<SyncSummary> {
  const db = getOfflineDb();
  const entries = await db.getAll<SyncOutboxEntry>("sync_outbox");
  return {
    pendingCount: entries.filter((entry) => entry.status === "pending").length,
    errorCount: entries.filter((entry) => entry.status === "error" && entry.last_error_kind !== "conflict").length,
    conflictCount: entries.filter((entry) => entry.last_error_kind === "conflict").length,
    syncing: entries.some((entry) => entry.status === "syncing"),
  };
}

/** Coarse classification so the UI (and the auto-retry policy) can react differently. */
function classifySyncError(error: unknown): { kind: "network" | "conflict" | "rejected"; message: string } {
  if (error instanceof AppError) {
    if (error.code === "NETWORK") return { kind: "network", message: error.message };
    // Migration 0055 §2 raises a plain Postgres exception ("Only N of X in
    // stock") — there is no dedicated error code for a POS sale (unlike the
    // catalog's own VARIANT_STOCK_INSUFFICIENT), so the message itself is
    // the only signal. This is read-only classification for a friendlier
    // label; the sale is preserved and surfaced either way.
    if (/in stock/i.test(error.message)) return { kind: "conflict", message: error.message };
    return { kind: "rejected", message: error.message };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { kind: "rejected", message };
}

/** Exponential backoff for the AUTOMATIC retry loop only; manual retry ignores it. */
function backoffMs(attempts: number): number {
  const steps = [5_000, 15_000, 30_000, 60_000, 120_000];
  return steps[Math.min(attempts, steps.length - 1)];
}

export type CompleteSaleFn = (input: CompleteSaleInput) => Promise<Sale>;

/** Attempt one outbox entry. Never throws — the result is recorded either way. */
async function attemptEntry(entry: SyncOutboxEntry, complete: CompleteSaleFn): Promise<
  { outcome: "synced"; sale: Sale } | { outcome: "failed"; kind: "network" | "conflict" | "rejected"; message: string }
> {
  const db = getOfflineDb();
  const now = new Date().toISOString();
  await db.put<SyncOutboxEntry>("sync_outbox", { ...entry, status: "syncing", last_attempt_at: now });
  const record = await db.get<OfflineSaleRecord>("offline_sales", entry.local_sale_id);
  if (!record) {
    // The local sale row is gone (should not happen — records are never
    // deleted) — drop the orphaned outbox entry rather than retry forever.
    await db.delete("sync_outbox", entry.client_ref);
    return { outcome: "failed", kind: "rejected", message: "Offline sale record missing" };
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
      last_error: null,
      last_error_kind: null,
    });
    await db.delete("sync_outbox", entry.client_ref);
    await db.put("sync_metadata", { key: LAST_SYNCED_AT_KEY, value: new Date().toISOString() });
    return { outcome: "synced", sale };
  } catch (error) {
    const { kind, message } = classifySyncError(error);
    reportNetworkResult(kind === "network" ? "network-error" : "other-error");
    const attempts = entry.attempts + 1;
    await db.put<SyncOutboxEntry>("sync_outbox", {
      ...entry,
      status: "error",
      attempts,
      last_attempt_at: new Date().toISOString(),
      next_attempt_at: new Date(Date.now() + backoffMs(attempts)).toISOString(),
      last_error: message,
      last_error_kind: kind,
    });
    await db.put<OfflineSaleRecord>("offline_sales", {
      ...record,
      sync_status: "error",
      last_error: message,
      last_error_kind: kind,
    });
    return { outcome: "failed", kind, message };
  }
}

/**
 * One sync pass. `force` (the manual "Retry sync" button) attempts every
 * pending/error entry regardless of backoff or error kind. Without it, only
 * never-tried entries and network-classified failures whose backoff window
 * has elapsed are attempted — a `rejected` (validation/business) failure and
 * a stock `conflict` both need a human to look at them, so the automatic
 * loop leaves them alone rather than re-submitting the same refused sale on
 * a timer.
 */
async function processOutboxPass(complete: CompleteSaleFn, options: { force?: boolean } = {}): Promise<SyncRunResult> {
  const db = getOfflineDb();
  const entries = await db.getAll<SyncOutboxEntry>("sync_outbox");
  const now = Date.now();
  const due = entries
    .filter((entry) => entry.status !== "syncing")
    .filter((entry) => {
      if (options.force) return true;
      if (entry.status === "pending") return true;
      if (entry.last_error_kind !== "network") return false;
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

export function processOutbox(complete: CompleteSaleFn, options: { force?: boolean } = {}): Promise<SyncRunResult> {
  if (activeSync) return activeSync;
  activeSync = processOutboxPass(complete, options).finally(() => {
    activeSync = null;
  });
  return activeSync;
}

/** Manual "Retry sync" — attempts everything queued, ignoring backoff/kind. */
export async function retrySyncNow(complete: CompleteSaleFn): Promise<SyncRunResult> {
  return processOutbox(complete, { force: true });
}

/** True when at least one queued sale exists (pending or error). */
export async function hasQueuedSales(): Promise<boolean> {
  const summary = await getSyncSummary();
  return summary.pendingCount + summary.errorCount + summary.conflictCount > 0;
}

/** Test-only helper: build a minimal, valid `SalePaymentInput[]` for cash. */
export function cashPayment(amount: number, tendered?: number): SalePaymentInput[] {
  return [{ method: "cash", amount, status: "paid", tendered: tendered ?? amount }];
}
