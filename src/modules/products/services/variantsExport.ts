/**
 * Variants export (Phase 43) — the catalogue's combinations, one row per shelf.
 *
 * Pure like `productsExport`: rows the `CatalogProvider` already loaded in, plain
 * `BuiltSheet`s out. The products sheet stays one-row-per-product (its quantity
 * column is the rollup); this sheet is the per-combination truth underneath it,
 * so a workbook with both shows the sum AND the shelves — and nothing sums the
 * two sheets together.
 *
 * Cost columns obey `view_cost`, exactly as the products sheet does: a seat that
 * cannot see cost on the screen must not find it in a download.
 */
import {
  buildSheets,
  toDate,
  type BuiltSheet,
  type ExportColumn,
  type ExportSheet,
  type PickBilingual,
  type Translate,
} from "@/lib/export";
import { canAct } from "@/lib/permissions/enforce";
import type { Product } from "../types";
import { sizeLabelOf, type ProductVariant } from "../variants";

export interface VariantsExportInput {
  variants: readonly ProductVariant[];
  products: readonly Product[];
  t: Translate;
  pick: PickBilingual;
  /** Defaults to the seat's `view_cost`, overridable for the selftest. */
  maySeeCost?: boolean;
}

export function buildVariantsSheet({
  variants,
  products,
  t,
  pick,
  maySeeCost,
}: VariantsExportInput): BuiltSheet[] {
  if (variants.length === 0) return [];
  const seesCost = maySeeCost ?? canAct("view_cost");
  const productById = new Map(products.map((product) => [product.id, product]));

  const sheet: ExportSheet<ProductVariant> = {
    name: t("export.sheet.variants"),
    rows: variants,
    columns: [
      {
        header: t("export.col.product"),
        value: (v) => {
          const product = productById.get(v.product_id);
          return product ? pick(product.name_ar, product.name_en) : "—";
        },
        width: 28,
      },
      { header: t("export.col.sku"), value: (v) => productById.get(v.product_id)?.sku ?? "—", width: 16 },
      { header: t("export.col.variantColour"), value: (v) => pick(v.color_ar, v.color_en) || "—", width: 16 },
      {
        header: t("export.col.variantSize"),
        value: (v) => sizeLabelOf(v.size, v.size_label),
        width: 10,
      },
      { header: t("export.col.variantSku"), value: (v) => v.sku, width: 20 },
      { header: t("export.col.barcode"), value: (v) => v.barcode ?? "", width: 18 },
      ...(seesCost
        ? ([
            { header: t("export.col.costPrice"), value: (v) => v.cost_override ?? productById.get(v.product_id)?.cost_price ?? 0, kind: "money" },
          ] as ExportColumn<ProductVariant>[])
        : []),
      {
        header: t("export.col.sellingPrice"),
        value: (v) => v.price_override ?? productById.get(v.product_id)?.selling_price ?? 0,
        kind: "money",
      },
      { header: t("export.col.currentQty"), value: (v) => v.stock_quantity, kind: "number" },
      { header: t("export.col.lowStockLevel"), value: (v) => v.low_stock_level, kind: "number" },
      {
        header: t("export.col.stockStatus"),
        value: (v) =>
          !v.active
            ? t("inventory.status.none")
            : v.stock_quantity <= 0
              ? t("inventory.status.out")
              : v.low_stock_level > 0 && v.stock_quantity <= v.low_stock_level
                ? t("inventory.status.low")
                : t("inventory.status.in"),
        width: 14,
      },
      { header: t("export.col.active"), value: (v) => (v.active ? t("common.active") : t("common.inactive")), width: 12 },
      { header: t("export.col.createdAt"), value: (v) => toDate(v.created_at), kind: "datetime" },
    ],
    notes: [
      t("export.note.generatedBy", { app: t("app.name") }),
      `${t("export.sheet.variants")}: ${variants.length}`,
    ],
  };

  return buildSheets([sheet]);
}
