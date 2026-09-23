import { getSupabaseClient } from "@/lib/supabase/client";
import { recordAudit } from "@/modules/audit/services/auditService";
import { AppError } from "@/modules/products/data/repository";
import type { Product } from "@/modules/products/types";
import type { ProductVariant } from "@/modules/products/variants";
import { getInventoryMode, getInventoryRepository } from "../data";
import { adjustStockToCount } from "./inventoryService";
import { getCurrentUser } from "../permissions";
import {
  DEMO_STOCKTAKE_ROLLBACK_KEYS,
  STOCKTAKE_DEMO_KEY,
  createStocktake,
  listStocktakes,
  moveToReview,
  saveStocktake,
  stocktakeConflicts,
  type StocktakeConflict,
  type StocktakeSession,
  type StocktakeStatus,
} from "./stocktake";

/**
 * The stocktake door.
 *
 * Demo keeps `alyq.inventory.stocktakes.v1`. Live reads and writes Supabase and
 * does not fall back to that key when the request fails. Finalizing live is
 * one RPC. The page must not loop `adjustStockToCount` and call it done.
 */

export interface StocktakePersistOptions {
  audit?: boolean;
  status?: StocktakeStatus;
}

interface LiveEnvelope {
  ok?: boolean;
  code?: string;
  movements?: number;
  conflicts?: Array<{
    sku?: string;
    expected?: number;
    current?: number | null;
    product_id?: string;
    variant_id?: string | null;
  }>;
  session?: LiveSession;
}

interface LiveSession {
  id: string;
  reference: string;
  status: StocktakeStatus;
  blind: boolean;
  note: string | null;
  created_at: string;
  created_by_name: string;
  finalized_at: string | null;
  finalized_by_name: string | null;
  lines: LiveLine[];
}

interface LiveLine {
  id: string;
  product_id: string;
  variant_id: string | null;
  sku: string;
  barcode: string | null;
  product_name_ar: string;
  product_name_en: string;
  variant_label: string;
  expected_quantity: number;
  physical_quantity: number | null;
  variance: number | null;
  movement_id: string | null;
  movement_reference: string | null;
}

function liveMode(): boolean {
  return getInventoryMode() === "supabase";
}

function requireClient() {
  const client = getSupabaseClient();
  if (!client) throw new AppError("NOT_CONFIGURED", "SUPABASE_NOT_CONFIGURED");
  return client;
}

function asEnvelope(data: unknown): LiveEnvelope {
  const value = typeof data === "string" ? JSON.parse(data) : data;
  return value && typeof value === "object" ? (value as LiveEnvelope) : {};
}

function mapSession(session: LiveSession): StocktakeSession {
  return {
    id: session.id,
    reference: session.reference,
    createdAt: session.created_at,
    createdBy: session.created_by_name,
    finalizedAt: session.finalized_at,
    finalizedBy: session.finalized_by_name,
    status: session.status,
    blind: session.blind,
    note: session.note,
    rows: (session.lines ?? []).map((line) => ({
      lineId: line.id,
      productId: line.product_id,
      variantId: line.variant_id,
      productNameAr: line.product_name_ar,
      productNameEn: line.product_name_en,
      variantLabel: line.variant_label,
      sku: line.sku,
      barcode: line.barcode,
      systemQuantity: line.expected_quantity,
      snapshotQuantity: line.expected_quantity,
      physicalQuantity: line.physical_quantity,
      variance: line.variance,
      adjustmentReference: line.movement_reference ?? line.movement_id,
    })),
  };
}

function conflictsFromEnvelope(envelope: LiveEnvelope): StocktakeConflict[] {
  return (envelope.conflicts ?? []).map((row) => ({
    sku: row.sku ?? "",
    expected: Number(row.expected ?? 0),
    current: row.current === null || row.current === undefined ? null : Number(row.current),
    productId: row.product_id ?? "",
    variantId: row.variant_id ?? null,
  }));
}

function throwLive(envelope: LiveEnvelope): never {
  if (envelope.code === "STOCKTAKE_CONFLICT") {
    const conflicts = conflictsFromEnvelope(envelope);
    throw new AppError(
      "STOCKTAKE_CONFLICT",
      conflicts.map((row) => `${row.sku} (${row.expected}→${row.current ?? "missing"})`).join(", "),
    );
  }
  if (envelope.code === "STOCKTAKE_INCOMPLETE") {
    throw new AppError("STOCKTAKE_INCOMPLETE", envelope.code);
  }
  if (envelope.code === "STOCKTAKE_FINALIZED") {
    throw new AppError("STOCKTAKE_FINALIZED", envelope.code);
  }
  throw new AppError("DB", envelope.code ?? "Stocktake request failed");
}

function throwRpc(error: { message?: string; code?: string }): never {
  const message = error.message ?? "Stocktake request failed";
  if (error.code === "42501" || /adjust_stock|insufficient_privilege/i.test(message)) {
    throw new AppError("FORBIDDEN", message, undefined, error.code);
  }
  if (/no tracked stock/i.test(message)) {
    throw new AppError("VALIDATION", message);
  }
  throw new AppError("DB", message, undefined, error.code);
}

export async function listStocktakeSessions(): Promise<StocktakeSession[]> {
  if (!liveMode()) return listStocktakes();
  const client = requireClient();
  const [sessions, lines] = await Promise.all([
    client
      .from("stocktakes")
      .select("id, reference, status, blind, note, created_at, created_by, created_by_name, finalized_at, finalized_by, finalized_by_name")
      .order("created_at", { ascending: false }),
    client
      .from("stocktake_lines")
      .select("id, stocktake_id, product_id, variant_id, sku, barcode, product_name_ar, product_name_en, variant_label, expected_quantity, physical_quantity, variance, movement_id, movement_reference"),
  ]);
  if (sessions.error) throwRpc(sessions.error);
  if (lines.error) throwRpc(lines.error);
  const grouped = new Map<string, LiveLine[]>();
  for (const line of (lines.data as Array<LiveLine & { stocktake_id: string }> | null) ?? []) {
    const list = grouped.get(line.stocktake_id) ?? [];
    list.push(line);
    grouped.set(line.stocktake_id, list);
  }
  return ((sessions.data as Array<Record<string, unknown>> | null) ?? []).map((row) =>
    mapSession({
      id: String(row.id),
      reference: String(row.reference),
      status: row.status as StocktakeStatus,
      blind: Boolean(row.blind),
      note: (row.note as string | null) ?? null,
      created_at: String(row.created_at),
      created_by_name: String(row.created_by_name ?? ""),
      finalized_at: (row.finalized_at as string | null) ?? null,
      finalized_by_name: (row.finalized_by_name as string | null) ?? null,
      lines: grouped.get(String(row.id)) ?? [],
    }),
  );
}

export async function startStocktake(args: {
  products: Product[];
  variants: ProductVariant[];
  createdBy: string;
  blind?: boolean;
  note?: string | null;
}): Promise<StocktakeSession> {
  if (!liveMode()) {
    const session = createStocktake(args.products, args.variants, args.createdBy, args.blind ?? false);
    if (!session) throw new AppError("VALIDATION", "There is no tracked stock to count");
    void recordAudit({
      action: "stocktake.created",
      entity: "stocktake",
      entity_id: session.id,
      entity_label: session.reference,
      details: { lines: session.rows.length, blind: session.blind },
    });
    return session;
  }
  const client = requireClient();
  const { data, error } = await client.rpc("stocktake_create", {
    p_blind: args.blind ?? false,
    p_note: args.note ?? null,
  });
  if (error) throwRpc(error);
  const envelope = asEnvelope(data);
  if (!envelope.ok || !envelope.session) throwLive(envelope);
  return mapSession(envelope.session);
}

export async function persistStocktakeCounts(
  session: StocktakeSession,
  options: StocktakePersistOptions = {},
): Promise<StocktakeSession> {
  if (!liveMode()) {
    const next = saveStocktake({ ...session, status: options.status ?? session.status });
    if (options.audit) {
      void recordAudit({
        action: "stocktake.updated",
        entity: "stocktake",
        entity_id: next.id,
        entity_label: next.reference,
        details: { lines_saved: next.rows.filter((row) => row.physicalQuantity !== null).length, status: next.status },
      });
    }
    return next;
  }
  const client = requireClient();
  const { data, error } = await client.rpc("stocktake_save_counts", {
    p_stocktake_id: session.id,
    p_counts: session.rows
      .filter((row) => row.physicalQuantity !== null)
      .map((row) => ({ line_id: row.lineId, physical_quantity: row.physicalQuantity })),
    p_status: options.status ?? null,
    p_audit: options.audit ?? false,
  });
  if (error) throwRpc(error);
  const envelope = asEnvelope(data);
  if (!envelope.ok || !envelope.session) throwLive(envelope);
  return mapSession(envelope.session);
}

function snapshotDemo(): Map<string, string | null> {
  const snap = new Map<string, string | null>();
  for (const key of DEMO_STOCKTAKE_ROLLBACK_KEYS) snap.set(key, localStorage.getItem(key));
  return snap;
}

function restoreDemo(snap: Map<string, string | null>): void {
  for (const [key, value] of snap) {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  }
}

async function finalizeDemo(sessionId: string): Promise<StocktakeSession> {
  const session = listStocktakes().find((item) => item.id === sessionId);
  if (!session) throw new AppError("NOT_FOUND", "Stocktake not found");
  if (session.status === "finalized") return session;
  if (session.rows.some((row) => row.physicalQuantity === null)) {
    throw new AppError("STOCKTAKE_INCOMPLETE", "Complete every physical count before finalizing");
  }
  const repository = getInventoryRepository();
  const [products, variants] = await Promise.all([repository.listProducts(), repository.listVariants()]);
  const conflicts = stocktakeConflicts(session, products, variants);
  if (conflicts.length > 0) {
    void recordAudit({
      action: "stocktake.conflict",
      entity: "stocktake",
      entity_id: session.id,
      entity_label: session.reference,
      details: {
        skus: conflicts.map((row) => row.sku).join(", "),
        count: conflicts.length,
      },
    });
    throw new AppError(
      "STOCKTAKE_CONFLICT",
      conflicts.map((row) => `${row.sku} (${row.expected}→${row.current ?? "missing"})`).join(", "),
    );
  }

  const snap = snapshotDemo();
  const user = getCurrentUser();
  try {
    const references = new Map<string, string>();
    for (const row of session.rows) {
      if (row.physicalQuantity === null || row.physicalQuantity === row.snapshotQuantity) continue;
      const result = await adjustStockToCount({
        productId: row.productId,
        variantId: row.variantId,
        physicalQuantity: row.physicalQuantity,
        notes: `Stocktake ${session.reference}`,
      });
      if (result.movement.id) references.set(row.lineId, result.movement.id);
    }
    const finalized: StocktakeSession = {
      ...session,
      status: "finalized",
      finalizedAt: new Date().toISOString(),
      finalizedBy: user.name,
      rows: session.rows.map((row) => ({
        ...row,
        adjustmentReference: references.get(row.lineId) ?? row.adjustmentReference,
      })),
    };
    const stored = listStocktakes().map((item) => (item.id === finalized.id ? finalized : item));
    localStorage.setItem(STOCKTAKE_DEMO_KEY, JSON.stringify(stored));
    void recordAudit({
      action: "stocktake.finalized",
      entity: "stocktake",
      entity_id: finalized.id,
      entity_label: finalized.reference,
      details: { movements: references.size },
    });
    return finalized;
  } catch (error) {
    restoreDemo(snap);
    throw error;
  }
}

export async function finalizeStocktake(sessionId: string): Promise<StocktakeSession> {
  if (!liveMode()) return finalizeDemo(sessionId);
  const client = requireClient();
  const { data, error } = await client.rpc("stocktake_finalize", { p_stocktake_id: sessionId });
  if (error) throwRpc(error);
  const envelope = asEnvelope(data);
  if (!envelope.ok || !envelope.session) throwLive(envelope);
  return mapSession(envelope.session);
}

export async function reviewStocktake(session: StocktakeSession): Promise<StocktakeSession> {
  const reviewed = moveToReview(session);
  if (reviewed.status !== "review") {
    throw new AppError("STOCKTAKE_INCOMPLETE", "Complete every physical count before review");
  }
  return persistStocktakeCounts(reviewed, { audit: true, status: "review" });
}
