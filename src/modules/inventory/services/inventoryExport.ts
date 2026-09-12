/**
 * Inventory export — current stock, one row per tracked product.
 *
 * Pure, like every other export builder. `InventoryPage` passes the *filtered*
 * result set (`queryInventory` output), so an export with a category or
 * low-stock filter applied contains exactly what is on screen.
 *
 * Valuation: `stock value` is quantity × purchase price (the standard
 * cost-basis inventory valuation). A retail-basis column is included alongside
 * it because shops ask for both; neither is written back anywhere.
 */
import {
  buildSheets,
  toDate,
  type BuiltSheet,
  type ExportSheet,
  type PickBilingual,
  type Translate,
} from "@/lib/export";
import { stockStatus, type Product } from "@/modules/products/types";
import { yesNo } from "@/modules/products/services/productsExport";

export interface InventoryExportInput {
  products: readonly Product[];
  /** Category id → localised name, resolved by the caller. */
  categoryName(id: string | null): string;
  t: Translate;
  pick: PickBilingual;
}

/** Cost-basis value of one product's on-hand stock. */
export function stockValueAtCost(product: Pick<Product, "stock_quantity" | "cost_price">): number {
  return Math.round(product.stock_quantity * product.cost_price * 100) / 100;
}

/** Retail-basis value of one product's on-hand stock. */
export function stockValueAtRetail(product: Pick<Product, "stock_quantity" | "selling_price">): number {
  return Math.round(product.stock_quantity * product.selling_price * 100) / 100;
}

export function buildInventorySheets({
  products,
  categoryName,
  t,
  pick,
}: InventoryExportInput): BuiltSheet[] {
  const totalQty = products.reduce((sum, p) => sum + p.stock_quantity, 0);
  const totalCost = products.reduce((sum, p) => sum + stockValueAtCost(p), 0);
  const totalRetail = products.reduce((sum, p) => sum + stockValueAtRetail(p), 0);

  const sheet: ExportSheet<Product> = {
    name: t("export.sheet.inventory"),
    rows: products,
    columns: [
      { header: t("export.col.name"), value: (p) => pick(p.name_ar, p.name_en), width: 30 },
      { header: t("export.col.sku"), value: (p) => p.sku, width: 16 },
      { header: t("export.col.barcode"), value: (p) => p.barcode ?? "", width: 18 },
      { header: t("export.col.category"), value: (p) => categoryName(p.category_id), width: 20 },
      // The product schema has no unit field — see the note under the table.
      { header: t("export.col.unit"), value: () => "", width: 10 },
      { header: t("export.col.costPrice"), value: (p) => p.cost_price, kind: "money" },
      { header: t("export.col.sellingPrice"), value: (p) => p.selling_price, kind: "money" },
      { header: t("export.col.currentQty"), value: (p) => p.stock_quantity, kind: "number" },
      { header: t("export.col.stockValue"), value: (p) => stockValueAtCost(p), kind: "money", width: 18 },
      { header: t("export.col.retailValue"), value: (p) => stockValueAtRetail(p), kind: "money", width: 18 },
      { header: t("export.col.lowStockLevel"), value: (p) => p.low_stock_level, kind: "number" },
      {
        header: t("export.col.stockStatus"),
        value: (p) => t(`inventory.status.${stockStatus(p)}` as never),
        width: 16,
      },
      { header: t("export.col.active"), value: (p) => yesNo(t, p.active), width: 12 },
      { header: t("export.col.updatedAt"), value: (p) => toDate(p.updated_at), kind: "datetime" },
    ],
    // Aligned to the columns above: label in the first cell, sums in theirs.
    totals: [
      t("export.totalRow"),
      "",
      "",
      "",
      "",
      null,
      null,
      totalQty,
      Math.round(totalCost * 100) / 100,
      Math.round(totalRetail * 100) / 100,
      null,
      "",
      "",
      null,
    ],
    notes: [
      t("export.note.unit"),
      t("export.note.stockValue"),
      `${t("export.col.currentQty")}: ${products.length}`,
    ],
  };

  return buildSheets([sheet]);
}
