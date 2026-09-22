import type { ProductVariant } from "@/modules/products/variants";
import type { Product } from "@/modules/products/types";

export type StocktakeStatus = "draft" | "counting" | "review" | "finalized";
export interface StocktakeRow {
  productId: string;
  variantId: string | null;
  productNameAr: string;
  productNameEn: string;
  variantLabel: string;
  sku: string;
  barcode: string | null;
  systemQuantity: number;
  physicalQuantity: number | null;
  /** Snapshot at session creation; used to detect intervening stock changes. */
  snapshotQuantity: number;
  variance: number | null;
  adjustmentReference: string | null;
}
export interface StocktakeSession {
  id: string;
  createdAt: string;
  createdBy: string;
  finalizedAt: string | null;
  finalizedBy: string | null;
  status: StocktakeStatus;
  blind: boolean;
  rows: StocktakeRow[];
}

const KEY = "alyq.inventory.stocktakes.v1";
const read = (): StocktakeSession[] => {
  try { const value = JSON.parse(localStorage.getItem(KEY) ?? "[]"); return Array.isArray(value) ? value : []; } catch { return []; }
};
const write = (value: StocktakeSession[]) => { try { localStorage.setItem(KEY, JSON.stringify(value)); } catch { /* optional demo storage */ } };
const id = () => `stocktake-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

export function listStocktakes(): StocktakeSession[] { return read().sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }
export function createStocktake(products: Product[], variants: ProductVariant[], createdBy: string, blind = false): StocktakeSession {
  const rows: StocktakeRow[] = [];
  for (const product of products.filter((item) => item.active && item.stock_tracking_enabled)) {
    const own = variants.filter((variant) => variant.product_id === product.id && variant.active);
    if (own.length) {
      for (const variant of own) rows.push({
        productId: product.id, variantId: variant.id, productNameAr: product.name_ar, productNameEn: product.name_en,
        variantLabel: [variant.color_en || variant.color_ar, variant.size_label || (variant.size === null ? "" : String(variant.size))].filter(Boolean).join(" / "),
        sku: variant.sku, barcode: variant.barcode, systemQuantity: variant.stock_quantity, snapshotQuantity: variant.stock_quantity,
        physicalQuantity: null, variance: null, adjustmentReference: null,
      });
    } else rows.push({
      productId: product.id, variantId: null, productNameAr: product.name_ar, productNameEn: product.name_en,
      variantLabel: "", sku: product.sku, barcode: product.barcode, systemQuantity: product.stock_quantity,
      snapshotQuantity: product.stock_quantity, physicalQuantity: null, variance: null, adjustmentReference: null,
    });
  }
  const session: StocktakeSession = { id: id(), createdAt: new Date().toISOString(), createdBy, finalizedAt: null, finalizedBy: null, status: "draft", blind, rows };
  write([session, ...read()]); return session;
}
export function saveStocktake(session: StocktakeSession): void { write(read().map((item) => item.id === session.id ? session : item)); }
export function updateCount(session: StocktakeSession, rowIndex: number, quantity: number): StocktakeSession {
  if (session.status === "finalized") return session;
  const rows = session.rows.map((row, index) => index === rowIndex ? { ...row, physicalQuantity: Math.max(0, Math.trunc(quantity)), variance: Math.max(0, Math.trunc(quantity)) - row.systemQuantity } : row);
  return { ...session, rows, status: "counting" };
}
export function scanStocktake(session: StocktakeSession, code: string): StocktakeSession {
  const index = session.rows.findIndex((row) => row.barcode?.toUpperCase() === code.trim().toUpperCase() || row.sku.toUpperCase() === code.trim().toUpperCase());
  if (index < 0) return session;
  const current = session.rows[index].physicalQuantity ?? 0;
  return updateCount(session, index, current + 1);
}
export function moveToReview(session: StocktakeSession): StocktakeSession {
  return session.rows.every((row) => row.physicalQuantity !== null) ? { ...session, status: "review" } : session;
}
export function markFinalized(session: StocktakeSession, finalizedBy: string, references: Map<number, string>): StocktakeSession {
  return { ...session, status: "finalized", finalizedAt: new Date().toISOString(), finalizedBy, rows: session.rows.map((row, index) => ({ ...row, adjustmentReference: references.get(index) ?? row.adjustmentReference })) };
}
