/**
 * POS offline-first — domain types (Phase: offline sales).
 *
 * Everything here is additive: no existing POS type is changed shape. An
 * `OfflineSaleRecord` carries the exact `CompleteSaleInput` a cashier would
 * have sent online — the SAME `client_ref`, replayed unchanged when the
 * connection returns — plus the bookkeeping the till needs to show it before
 * a server ever sees it.
 *
 * The server side of idempotency already exists and is not touched by this
 * module: `pos_complete_sale` (migration 0007, carried through 0055) treats
 * `client_ref` as a unique idempotency key — a duplicate `client_ref` returns
 * the existing sale id instead of writing a second row. This module's whole
 * job is to make sure the SAME `client_ref` is replayed on every retry, not
 * to reimplement idempotency itself.
 */
import type { CompleteSaleInput, Sale } from "../types";
import type { Product } from "@/modules/products/types";
import type { ProductVariant } from "@/modules/products/variants";

/** The object-store names inside the one offline database (see `db.ts`). */
export const OFFLINE_STORE_NAMES = [
  "cached_products",
  "cached_variants",
  "offline_sales",
  "offline_sale_lines",
  "sync_outbox",
  "sync_metadata",
] as const;
export type OfflineStoreName = (typeof OFFLINE_STORE_NAMES)[number];

/** A cached product row — the exact live `Product`, nothing invented. */
export interface CachedProduct extends Product {
  /** When this row was last refreshed from a live catalog load. */
  cached_at: string;
}

/** A cached variant row — the exact live `ProductVariant`, nothing invented. */
export interface CachedVariant extends ProductVariant {
  cached_at: string;
}

/** One line of a sale made while offline — mirrors `CompleteSaleInput.lines[]`. */
export interface OfflineSaleLine {
  /** `${local_sale_id}::${index}` — composite key, stable across writes. */
  id: string;
  local_sale_id: string;
  product_id: string;
  variant_id: string | null;
  qty: number;
  discount_type: "none" | "percent" | "fixed";
  discount_value: number;
  /** Frozen at cart time so the till can show the line without a live catalog read. */
  name_en: string;
  name_ar: string;
  sku: string;
  unit_price: number;
}

export type OfflineSyncStatus = "pending" | "syncing" | "synced" | "error";

/**
 * A sale completed while offline, before (and after) it reaches the server.
 *
 * `id` is a locally-generated identifier used everywhere the till would
 * normally use the server's UUID (routes, receipts, the sales list) until
 * the real row exists — at which point `server_id`/`server_sale_number` are
 * filled in and the record is kept (never deleted) as a synced audit trail
 * of what happened offline and when it reached the server.
 */
export interface OfflineSaleRecord {
  id: string;
  client_ref: string;
  created_at: string;
  input: CompleteSaleInput;
  /** Precomputed for display — the exact numbers the cashier saw at the till. */
  subtotal: number;
  discount_amount: number;
  total: number;
  customer_id: string | null;
  customer_name: string | null;
  customer_phone: string | null;
  user_id: string;
  user_name: string;
  sync_status: OfflineSyncStatus;
  /** Filled in once `pos_complete_sale` (or its idempotent replay) succeeds. */
  server_id: string | null;
  server_sale_number: string | null;
  synced_at: string | null;
  /** Human-readable reason the last sync attempt failed, if it did. */
  last_error: string | null;
  /** Coarse classification of `last_error`, so the UI can react differently. */
  last_error_kind: "network" | "conflict" | "rejected" | null;
}

/**
 * The mutation queue. One entry per `OfflineSaleRecord` still waiting to
 * reach the server — deleted only once that sale is confirmed persisted.
 * A failed attempt updates `attempts`/`last_error` and stays queued; it is
 * never silently dropped.
 */
export interface SyncOutboxEntry {
  /** Same value as the sale's `client_ref` — one outbox row per sale, by construction. */
  client_ref: string;
  local_sale_id: string;
  created_at: string;
  attempts: number;
  last_attempt_at: string | null;
  /** Backoff schedule for the automatic (non-manual) retry loop. */
  next_attempt_at: string | null;
  status: "pending" | "syncing" | "error";
  last_error: string | null;
  last_error_kind: "network" | "conflict" | "rejected" | null;
}

/** Small key/value store for sync bookkeeping (e.g. `catalog_cached_at`). */
export interface SyncMetadataEntry {
  key: string;
  value: string;
}

export interface CachedCatalogSnapshot {
  products: Product[];
  variants: ProductVariant[];
  cachedAt: string | null;
}

/** What the sync engine reports after one pass over the outbox. */
export interface SyncRunResult {
  synced: string[];
  failed: string[];
  conflicts: string[];
}

/** Turn a synced/queued offline record into a `Sale`-shaped object the
 * existing sales list/receipt/detail screens can render unmodified.
 *
 * Unsynced sales are shown with the real numbers the till already
 * calculated locally (recalculated authoritatively once synced) — never a
 * placeholder — because a cashier and a customer are both looking at this
 * exact total right now.
 */
export function offlineSaleToDisplaySale(record: OfflineSaleRecord, lines: OfflineSaleLine[]): Sale {
  const items = lines
    .filter((line) => line.local_sale_id === record.id)
    .map((line) => {
      const gross = Math.round(line.unit_price * line.qty * 100) / 100;
      const discountAmount =
        line.discount_type === "percent"
          ? Math.round(((gross * line.discount_value) / 100) * 100) / 100
          : line.discount_type === "fixed"
            ? Math.min(gross, Math.round(line.discount_value * 100) / 100)
            : 0;
      return {
        id: line.id,
        sale_id: record.id,
        product_id: line.product_id,
        variant_id: line.variant_id,
        variant_color_ar: null,
        variant_color_en: null,
        variant_size: null,
        variant_size_label: null,
        name_ar: line.name_ar,
        name_en: line.name_en,
        sku: line.sku,
        barcode: null,
        unit_price: line.unit_price,
        quantity: line.qty,
        gross_total: gross,
        line_total: Math.round((gross - discountAmount) * 100) / 100,
        discount_type: line.discount_type,
        discount_value: line.discount_value,
        discount_amount: discountAmount,
        unit_cost: null,
      };
    });
  const payments = record.input.payments.map((payment, index) => ({
    id: `${record.id}::payment::${index}`,
    sale_id: record.id,
    method: payment.method,
    amount: payment.amount,
    status: payment.status,
    paid_at: payment.status === "paid" ? record.created_at : null,
    paid_by: payment.status === "paid" ? record.user_id : null,
    paid_by_name: payment.status === "paid" ? record.user_name : null,
  }));
  return {
    id: record.server_id ?? record.id,
    sale_number: record.server_sale_number ?? `OFFLINE-${record.id.slice(0, 8).toUpperCase()}`,
    client_ref: record.client_ref,
    status: "completed",
    subtotal: record.subtotal,
    discount_type: record.input.discount_type,
    discount_value: record.input.discount_value,
    discount_amount: record.discount_amount,
    total: record.total,
    user_id: record.user_id,
    user_name: record.user_name,
    items: items as Sale["items"],
    payments: payments as Sale["payments"],
    customer_id: record.customer_id,
    customer_name: record.customer_name,
    customer_phone: record.customer_phone,
    created_at: record.created_at,
    voided_at: null,
    void_reason: null,
    payment_method: record.input.payments[0]?.method ?? "cash",
    payment_status: record.input.payments.every((p) => p.status === "paid") ? "paid" : "pending",
    amount_received: record.input.payments
      .filter((p) => p.method === "cash")
      .reduce((sum, p) => sum + (p.tendered ?? p.amount), 0),
    change: null,
    paid_at: null,
    paid_by: null,
    paid_by_name: null,
    source: "pos",
    shift_id: null,
    offline_sync_status: record.sync_status,
    offline_last_error: record.last_error,
    offline_last_error_kind: record.last_error_kind,
  };
}
