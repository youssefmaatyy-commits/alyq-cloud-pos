import type { ProductVariant } from "@/modules/products/variants";
import type { Product } from "@/modules/products/types";

/**
 * Demo stocktake store.
 *
 * Live mode does not call this module's storage. `stocktakeService` is the
 * door: when Supabase is configured it talks to `stocktakes` / `stocktake_lines`
 * and never reads this key. Keeping the key here is the demo adapter, and the
 * backup allowlist carries it so a demo restore puts the sessions back without
 * replaying their movements.
 */
export const STOCKTAKE_DEMO_KEY = "alyq.inventory.stocktakes.v1";

export type StocktakeStatus = "draft" | "counting" | "review" | "finalized";

export interface StocktakeRow {
  /** Server line id in live mode. Demo rows carry one too, so the shape matches. */
  lineId: string;
  productId: string;
  variantId: string | null;
  productNameAr: string;
  productNameEn: string;
  variantLabel: string;
  sku: string;
  barcode: string | null;
  /** Display copy of the snapshot. Not refreshed from later catalogue stock. */
  systemQuantity: number;
  physicalQuantity: number | null;
  /** Snapshot at session creation. Finalize compares the shelf to this, not to a live reread. */
  snapshotQuantity: number;
  variance: number | null;
  adjustmentReference: string | null;
}

export interface StocktakeSession {
  id: string;
  /** Human reference. Demo uses the same value as `id`. */
  reference: string;
  createdAt: string;
  createdBy: string;
  finalizedAt: string | null;
  finalizedBy: string | null;
  status: StocktakeStatus;
  blind: boolean;
  note: string | null;
  rows: StocktakeRow[];
}

export interface StocktakeConflict {
  sku: string;
  expected: number;
  current: number | null;
  productId: string;
  variantId: string | null;
}

const read = (): StocktakeSession[] => {
  try {
    const value = JSON.parse(localStorage.getItem(STOCKTAKE_DEMO_KEY) ?? "[]");
    return Array.isArray(value) ? value.map(normalizeSession) : [];
  } catch {
    return [];
  }
};

const write = (value: StocktakeSession[]) => {
  try {
    localStorage.setItem(STOCKTAKE_DEMO_KEY, JSON.stringify(value));
  } catch {
    /* optional demo storage */
  }
};

const id = () => `stocktake-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const lineId = () => `line-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

function normalizeSession(value: StocktakeSession): StocktakeSession {
  return {
    ...value,
    reference: value.reference || value.id,
    note: value.note ?? null,
    rows: (value.rows ?? []).map((row) => ({
      ...row,
      lineId: row.lineId || `${value.id}:${row.productId}:${row.variantId ?? "base"}`,
      snapshotQuantity: row.snapshotQuantity ?? row.systemQuantity,
      adjustmentReference: row.adjustmentReference ?? null,
    })),
  };
}

export function variantShelfLabel(variant: ProductVariant): string {
  return [variant.color_en || variant.color_ar, variant.size_label || (variant.size === null ? "" : String(variant.size))]
    .filter(Boolean)
    .join(" / ");
}

/** Shelves a new count should snapshot. Variant products are one row per active combination. */
export function buildStocktakeRows(products: Product[], variants: ProductVariant[]): StocktakeRow[] {
  const rows: StocktakeRow[] = [];
  for (const product of products.filter((item) => item.active && item.stock_tracking_enabled)) {
    const own = variants.filter((variant) => variant.product_id === product.id && variant.active);
    if (product.variants_enabled) {
      for (const variant of own) {
        rows.push({
          lineId: lineId(),
          productId: product.id,
          variantId: variant.id,
          productNameAr: product.name_ar,
          productNameEn: product.name_en,
          variantLabel: variantShelfLabel(variant),
          sku: variant.sku,
          barcode: variant.barcode,
          systemQuantity: variant.stock_quantity,
          snapshotQuantity: variant.stock_quantity,
          physicalQuantity: null,
          variance: null,
          adjustmentReference: null,
        });
      }
      continue;
    }
    rows.push({
      lineId: lineId(),
      productId: product.id,
      variantId: null,
      productNameAr: product.name_ar,
      productNameEn: product.name_en,
      variantLabel: "",
      sku: product.sku,
      barcode: product.barcode,
      systemQuantity: product.stock_quantity,
      snapshotQuantity: product.stock_quantity,
      physicalQuantity: null,
      variance: null,
      adjustmentReference: null,
    });
  }
  return rows;
}

export function listStocktakes(): StocktakeSession[] {
  return read().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function createStocktake(
  products: Product[],
  variants: ProductVariant[],
  createdBy: string,
  blind = false,
): StocktakeSession | null {
  const rows = buildStocktakeRows(products, variants);
  if (rows.length === 0) return null;
  const sessionId = id();
  const session: StocktakeSession = {
    id: sessionId,
    reference: sessionId,
    createdAt: new Date().toISOString(),
    createdBy,
    finalizedAt: null,
    finalizedBy: null,
    status: "counting",
    blind,
    note: null,
    rows,
  };
  write([session, ...read()]);
  return session;
}

/**
 * Persist a demo session. Snapshot columns are taken from the stored row, so a
 * caller cannot rewrite history by sending a newer system quantity.
 */
export function saveStocktake(session: StocktakeSession): StocktakeSession {
  const existing = read().find((item) => item.id === session.id);
  if (!existing || existing.status === "finalized") return existing ?? session;
  const stored = new Map(existing.rows.map((row) => [row.lineId, row]));
  const next: StocktakeSession = {
    ...existing,
    status: session.status === "finalized" ? existing.status : session.status,
    blind: existing.blind,
    rows: existing.rows.map((row) => {
      const incoming = session.rows.find((item) => item.lineId === row.lineId) ?? stored.get(row.lineId) ?? row;
      const physical = incoming.physicalQuantity === null ? null : Math.max(0, Math.trunc(incoming.physicalQuantity));
      return {
        ...row,
        physicalQuantity: physical,
        variance: physical === null ? null : physical - row.snapshotQuantity,
        adjustmentReference: row.adjustmentReference,
      };
    }),
  };
  write(read().map((item) => (item.id === next.id ? next : item)));
  return next;
}

export function updateCount(session: StocktakeSession, rowIndex: number, quantity: number): StocktakeSession {
  if (session.status === "finalized") return session;
  const physical = Math.max(0, Math.trunc(Number.isFinite(quantity) ? quantity : 0));
  const rows = session.rows.map((row, index) =>
    index === rowIndex
      ? { ...row, physicalQuantity: physical, variance: physical - row.snapshotQuantity }
      : row,
  );
  return { ...session, rows, status: session.status === "review" ? "review" : "counting" };
}

export function scanStocktake(session: StocktakeSession, code: string): StocktakeSession {
  const needle = code.trim().toUpperCase();
  if (!needle) return session;
  const index = session.rows.findIndex(
    (row) => row.barcode?.toUpperCase() === needle || row.sku.toUpperCase() === needle,
  );
  if (index < 0) return session;
  const current = session.rows[index].physicalQuantity ?? 0;
  return updateCount(session, index, current + 1);
}

export function moveToReview(session: StocktakeSession): StocktakeSession {
  return session.rows.every((row) => row.physicalQuantity !== null) ? { ...session, status: "review" } : session;
}

export function shelfQuantity(
  product: Product | undefined,
  variant: ProductVariant | undefined,
): number | null {
  if (variant) return variant.stock_quantity;
  if (!product) return null;
  return product.stock_quantity;
}

/** Lines whose shelf no longer matches the snapshot. Empty means finalize may proceed. */
export function stocktakeConflicts(
  session: StocktakeSession,
  products: readonly Product[],
  variants: readonly ProductVariant[],
): StocktakeConflict[] {
  const productById = new Map(products.map((product) => [product.id, product]));
  const variantById = new Map(variants.map((variant) => [variant.id, variant]));
  const conflicts: StocktakeConflict[] = [];
  for (const row of session.rows) {
    const product = productById.get(row.productId);
    const variant = row.variantId ? variantById.get(row.variantId) : undefined;
    if (row.variantId && (!variant || variant.product_id !== row.productId)) {
      conflicts.push({
        sku: row.sku,
        expected: row.snapshotQuantity,
        current: null,
        productId: row.productId,
        variantId: row.variantId,
      });
      continue;
    }
    if (product?.variants_enabled && !row.variantId) {
      conflicts.push({
        sku: row.sku,
        expected: row.snapshotQuantity,
        current: null,
        productId: row.productId,
        variantId: null,
      });
      continue;
    }
    const current = shelfQuantity(product, variant);
    if (current === null || current !== row.snapshotQuantity) {
      conflicts.push({
        sku: row.sku,
        expected: row.snapshotQuantity,
        current,
        productId: row.productId,
        variantId: row.variantId,
      });
    }
  }
  return conflicts;
}

export function demoStocktakeBlocksProduct(productId: string): boolean {
  return read().some((session) => session.rows.some((row) => row.productId === productId));
}

export function demoStocktakeBlocksVariant(variantId: string): boolean {
  return read().some((session) => session.rows.some((row) => row.variantId === variantId));
}

/** Keys a failed demo finalize restores, so a thrown adjustment cannot leave a half-written shelf. */
export const DEMO_STOCKTAKE_ROLLBACK_KEYS = [
  "alyq.demo.catalog.v1",
  "alyq.demo.stock_movements.v1",
  STOCKTAKE_DEMO_KEY,
  "alyq.demo.audit_log.v1",
] as const;
