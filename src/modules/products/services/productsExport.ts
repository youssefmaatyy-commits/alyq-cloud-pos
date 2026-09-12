/**
 * Products export — the complete catalogue, one row per product.
 *
 * Pure: it receives rows the `CatalogProvider` already loaded plus a translate
 * function, and returns plain `BuiltSheet`s. No `xlsx`, no DOM, no repository —
 * an export is a read-only projection of data the screen is already showing, so
 * it honours whatever filters the caller passes in (`ProductsPage` hands it the
 * *filtered* result set, never the raw list).
 */
import {
  buildSheets,
  toDate,
  type BuiltSheet,
  type ExportSheet,
  type PickBilingual,
  type Translate,
} from "@/lib/export";
import { categoryNameIndex } from "./categoryTree";
import { PRODUCT_TYPE_META } from "../constants";
import { marginPct, stockStatus, type Category, type Product } from "../types";

export interface ProductsExportInput {
  /** The rows to export — already filtered by the caller when filters are on. */
  products: readonly Product[];
  categories: readonly Category[];
  t: Translate;
  pick: PickBilingual;
}

/** Localised Yes/No, so flag columns read naturally in either language. */
export function yesNo(t: Translate, value: boolean): string {
  return value ? t("export.yes") : t("export.no");
}

export function buildProductsSheets({
  products,
  categories,
  t,
  pick,
}: ProductsExportInput): BuiltSheet[] {
  const names = categoryNameIndex([...categories], pick);
  const categoryOf = (id: string | null) =>
    id ? names.get(id) ?? "—" : t("products.withoutCategory");

  const sheet: ExportSheet<Product> = {
    name: t("export.sheet.products"),
    rows: products,
    columns: [
      { header: t("export.col.sku"), value: (p) => p.sku, width: 16 },
      { header: t("export.col.barcode"), value: (p) => p.barcode ?? "", width: 18 },
      { header: t("export.col.name"), value: (p) => pick(p.name_ar, p.name_en), width: 28 },
      { header: t("export.col.nameAr"), value: (p) => p.name_ar, width: 28 },
      { header: t("export.col.nameEn"), value: (p) => p.name_en, width: 28 },
      { header: t("export.col.description"), value: (p) => pick(p.description_ar, p.description_en), width: 34 },
      { header: t("export.col.category"), value: (p) => categoryOf(p.category_id), width: 20 },
      {
        header: t("export.col.productType"),
        value: (p) => t(PRODUCT_TYPE_META[p.product_type].labelKey as never),
        width: 16,
      },
      { header: t("export.col.costPrice"), value: (p) => p.cost_price, kind: "money" },
      { header: t("export.col.sellingPrice"), value: (p) => p.selling_price, kind: "money" },
      {
        header: t("export.col.margin"),
        value: (p) => marginPct(p.selling_price, p.cost_price),
        kind: "percent",
      },
      { header: t("export.col.taxRate"), value: (p) => p.tax_rate, kind: "percent" },
      {
        header: t("export.col.stockTracking"),
        value: (p) => yesNo(t, p.stock_tracking_enabled),
        width: 14,
      },
      { header: t("export.col.currentQty"), value: (p) => p.stock_quantity, kind: "number" },
      { header: t("export.col.lowStockLevel"), value: (p) => p.low_stock_level, kind: "number" },
      {
        header: t("export.col.stockStatus"),
        value: (p) => t(`inventory.status.${stockStatus(p)}` as never),
        width: 16,
      },
      { header: t("export.col.active"), value: (p) => (p.active ? t("common.active") : t("common.inactive")), width: 12 },
      { header: t("export.col.featured"), value: (p) => yesNo(t, p.is_featured), width: 12 },
      { header: t("export.col.showOnWebsite"), value: (p) => yesNo(t, p.show_on_website), width: 14 },
      { header: t("export.col.createdAt"), value: (p) => toDate(p.created_at), kind: "datetime" },
      { header: t("export.col.updatedAt"), value: (p) => toDate(p.updated_at), kind: "datetime" },
    ],
    notes: [
      t("export.note.generatedBy", { app: t("app.name") }),
      `${t("export.col.currentQty")}: ${products.length}`,
    ],
  };

  return buildSheets([sheet]);
}
