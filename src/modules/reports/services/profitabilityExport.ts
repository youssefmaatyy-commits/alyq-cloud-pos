/**
 * Profitability workbooks — the same rows the Profit tab computed.
 *
 * Cost, COGS, profit and margin columns are omitted when the caller cannot
 * view cost. Date bounds are printed on every sheet.
 */
import {
  buildSheets,
  toDate,
  type BuiltSheet,
  type ExportSheet,
  type PickBilingual,
  type Translate,
} from "@/lib/export";
import type { Sale } from "@/modules/pos/types";
import type { Product } from "@/modules/products/types";
import type { ProductVariant } from "@/modules/products/variants";
import type { SalesReturn } from "@/modules/returns/types";
import type { OnlineOrder } from "@/modules/online/types";
import { rangeLabelOf, type DateRange } from "./financialExport";
import {
  buildProfitability,
  type BestSellerRank,
  type ProductProfitRow,
  type ReportChannel,
  type SlowLookbackDays,
  type SlowMoverRow,
  type VariantProfitRow,
} from "./profitability";

interface MetricRow {
  label: string;
  count: number | null;
  amount: number | null;
  note: string | null;
}

export interface ProfitabilityExportInput {
  sales: readonly Sale[];
  products: readonly Product[];
  variants?: readonly ProductVariant[];
  returns?: readonly SalesReturn[];
  orders?: readonly OnlineOrder[];
  range: DateRange;
  channel?: ReportChannel;
  lookbackDays?: SlowLookbackDays;
  rankBy?: BestSellerRank;
  t: Translate;
  pick: PickBilingual;
  canViewCost: boolean;
}

export function buildProfitabilitySheets(input: ProfitabilityExportInput): BuiltSheet[] {
  const { t, pick, range, canViewCost } = input;
  const report = buildProfitability(input);
  const notes = [
    `${t("export.dateRange")}: ${rangeLabelOf(range, t)}`,
    t("export.note.historicalCost"),
    t("export.note.totalsExcludeVoided"),
  ];

  const summary: ExportSheet<MetricRow> = {
    name: t("export.sheet.summary"),
    rows: [
      { label: t("reports.adv.grossSales"), count: report.kpis.invoices, amount: report.kpis.grossSales, note: null },
      { label: t("reports.adv.totalDiscounts"), count: null, amount: report.kpis.totalDiscounts, note: `${report.kpis.discountShareOfGross}%` },
      { label: t("reports.adv.netSales"), count: null, amount: report.kpis.netSales, note: null },
      ...(canViewCost
        ? [
            { label: t("export.metric.cogs"), count: report.kpis.cogsUnknownUnits || null, amount: report.kpis.cogs, note: null },
            { label: t("export.metric.grossProfit"), count: null, amount: report.kpis.grossProfit, note: `${report.kpis.grossMargin}%` },
          ]
        : []),
      { label: t("reports.adv.unitsSold"), count: report.kpis.unitsSold, amount: null, note: null },
      { label: t("reports.adv.aov"), count: null, amount: report.kpis.aov, note: null },
      { label: t("reports.adv.deliveryCollected"), count: null, amount: report.kpis.deliveryFeesCollected, note: null },
    ],
    columns: [
      { header: t("export.col.metric"), value: (m) => m.label, width: 36 },
      { header: t("export.col.count"), value: (m) => m.count, kind: "number", width: 12 },
      { header: t("export.col.amount"), value: (m) => m.amount, kind: "money", width: 18 },
      { header: t("export.col.share"), value: (m) => m.note, width: 20 },
    ],
    notes,
  };

  const productCols: ExportSheet<ProductProfitRow>["columns"] = [
    { header: t("export.col.sku"), value: (r) => r.sku, width: 16 },
    { header: t("export.col.product"), value: (r) => pick(r.nameAr, r.nameEn), width: 34 },
    { header: t("export.col.unitsSold"), value: (r) => r.units, kind: "number", width: 12 },
    { header: t("reports.adv.grossSales"), value: (r) => r.gross, kind: "money", width: 16 },
    { header: t("export.col.discountsGiven"), value: (r) => r.discounts, kind: "money", width: 16 },
    { header: t("reports.adv.netSales"), value: (r) => r.net, kind: "money", width: 16 },
  ];
  if (canViewCost) {
    productCols.push(
      { header: t("export.metric.cogs"), value: (r) => r.cogs, kind: "money", width: 16 },
      { header: t("export.col.profit"), value: (r) => r.profit, kind: "money", width: 16 },
      { header: t("export.col.margin"), value: (r) => r.margin, kind: "percent", width: 12 },
    );
  }

  const products: ExportSheet<ProductProfitRow> = {
    name: t("export.sheet.productProfitability"),
    rows: report.products,
    columns: productCols,
    notes,
  };

  const variantCols: ExportSheet<VariantProfitRow>["columns"] = [
    { header: t("export.col.sku"), value: (r) => r.sku, width: 16 },
    { header: t("export.col.product"), value: (r) => pick(r.nameAr, r.nameEn), width: 28 },
    { header: t("export.col.variant"), value: (r) => pick(r.labelAr, r.labelEn), width: 18 },
    { header: t("export.col.unitsSold"), value: (r) => r.units, kind: "number", width: 12 },
    { header: t("reports.adv.grossSales"), value: (r) => r.gross, kind: "money", width: 16 },
    { header: t("reports.adv.netSales"), value: (r) => r.net, kind: "money", width: 16 },
  ];
  if (canViewCost) {
    variantCols.push(
      { header: t("export.metric.cogs"), value: (r) => r.cogs, kind: "money", width: 16 },
      { header: t("export.col.profit"), value: (r) => r.profit, kind: "money", width: 16 },
      { header: t("export.col.margin"), value: (r) => r.margin, kind: "percent", width: 12 },
    );
  }

  const variants: ExportSheet<VariantProfitRow> = {
    name: t("export.sheet.variantProfitability"),
    rows: report.variants,
    columns: variantCols,
    notes,
  };

  const ranked = report.bestSellers.map((row, index) => ({ rank: index + 1, row }));
  const bestCols: ExportSheet<(typeof ranked)[number]>["columns"] = [
    { header: t("export.col.rank"), value: (r) => r.rank, kind: "number", width: 8 },
    { header: t("export.col.sku"), value: (r) => r.row.sku, width: 16 },
    { header: t("export.col.product"), value: (r) => pick(r.row.nameAr, r.row.nameEn), width: 28 },
    { header: t("export.col.variant"), value: (r) => pick(r.row.labelAr, r.row.labelEn), width: 18 },
    { header: t("export.col.unitsSold"), value: (r) => r.row.units, kind: "number", width: 12 },
    { header: t("reports.adv.netSales"), value: (r) => r.row.net, kind: "money", width: 16 },
  ];
  if (canViewCost) {
    bestCols.push({ header: t("export.col.profit"), value: (r) => r.row.profit, kind: "money", width: 16 });
  }
  const best: ExportSheet<(typeof ranked)[number]> = {
    name: t("export.sheet.bestSellers"),
    rows: ranked,
    columns: bestCols,
    notes,
  };

  const slow: ExportSheet<SlowMoverRow> = {
    name: t("export.sheet.slowMovers"),
    rows: report.slowMovers,
    columns: [
      { header: t("export.col.sku"), value: (r) => r.sku, width: 16 },
      { header: t("export.col.product"), value: (r) => pick(r.nameAr, r.nameEn), width: 28 },
      { header: t("export.col.variant"), value: (r) => pick(r.labelAr, r.labelEn), width: 18 },
      { header: t("export.col.currentQty"), value: (r) => r.stock, kind: "number", width: 12 },
      { header: t("export.col.tiedUp"), value: (r) => r.stockValue, kind: "money", width: 16 },
      { header: t("export.col.lastSale"), value: (r) => toDate(r.lastSaleAt), kind: "datetime", width: 20 },
      { header: t("export.col.daysSince"), value: (r) => r.daysSince, kind: "number", width: 12 },
    ],
    notes: [...notes, t("export.note.slowMoversLookback")],
  };

  return buildSheets([summary, products, variants, best, slow] as ExportSheet<unknown>[]);
}
