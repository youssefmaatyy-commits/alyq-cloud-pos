/**
 * Product report — what sold, what did not, what the shelf is worth, and what
 * the margin on each of it actually was.
 *
 * Requirement 7's product half: best sellers, slow movers, stock value, margin
 * analysis and per-product profitability. The cost convention is the financial
 * report's own (`costOfGoodsSold`), which is why this tab and the financial
 * summary cannot disagree about gross profit.
 */
import { useMemo } from "react";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { Badge, BoxIcon, Card, ExportButton, LayersIcon, StatTile, WarehouseIcon } from "@/components/ui";
import {
  bestSellers,
  marginSummary,
  productPerformance,
  slowMovers,
  stockValueTotals,
} from "../../services/salesAnalytics";
import { buildSalesAnalytics } from "../../services/salesAnalytics";
import { buildProductAnalyticsSheets } from "../../services/analyticsExport";
import { ReportSection, ReportTable, type ReportColumn } from "../ReportTable";
import type { ReportTabProps } from "./types";

const BEST_LIMIT = 10;
const SLOW_LIMIT = 10;

export function ProductReportTab({ sales, products, variants, range, pick }: ReportTabProps) {
  const { t, money, num } = useI18n();

  const ranged = useMemo(() => buildSalesAnalytics({ sales, shifts: [], range }).sales, [sales, range]);
  const rows = useMemo(() => productPerformance(ranged, products), [ranged, products]);
  const margin = useMemo(() => marginSummary(ranged, products, rows), [ranged, products, rows]);
  const stock = useMemo(() => stockValueTotals(products, variants ?? []), [products, variants]);
  const best = useMemo(() => bestSellers(rows, BEST_LIMIT), [rows]);
  const slow = useMemo(() => slowMovers(products, rows, SLOW_LIMIT), [products, rows]);

  const performanceColumns: ReportColumn<(typeof rows)[number]>[] = [
    { key: "sku", label: t("export.col.sku"), render: (row) => row.sku },
    { key: "name", label: t("export.col.product"), render: (row) => pick(row.nameAr, row.nameEn) },
    { key: "units", label: t("export.col.unitsSold"), align: "end", render: (row) => num(row.units) },
    { key: "revenue", label: t("export.col.revenue"), align: "end", render: (row) => money(row.revenue) },
    { key: "cost", label: t("export.col.unitCost"), align: "end", render: (row) => money(row.cost) },
    {
      key: "profit",
      label: t("export.col.profit"),
      align: "end",
      render: (row) => (
        <span className={row.profit < 0 ? "font-bold text-rose-600" : undefined}>{money(row.profit)}</span>
      ),
    },
    { key: "margin", label: t("export.col.margin"), align: "end", render: (row) => `${num(row.margin, 1)}%` },
    { key: "stock", label: t("export.col.currentQty"), align: "end", render: (row) => num(row.stock) },
  ];

  // A rank is the row's position in this list, so the rows carry it explicitly.
  type RankedRow = (typeof best)[number] & { rank: number };
  const bestColumns: ReportColumn<RankedRow>[] = [
    { key: "rank", label: t("export.col.rank"), render: (row) => num(row.rank) },
    { key: "name", label: t("export.col.product"), render: (row) => pick(row.nameAr, row.nameEn) },
    { key: "units", label: t("export.col.unitsSold"), align: "end", render: (row) => num(row.units) },
    { key: "revenue", label: t("export.col.revenue"), align: "end", render: (row) => money(row.revenue) },
    { key: "profit", label: t("export.col.profit"), align: "end", render: (row) => money(row.profit) },
    { key: "margin", label: t("export.col.margin"), align: "end", render: (row) => `${num(row.margin, 1)}%` },
  ];

  const slowColumns: ReportColumn<(typeof slow)[number]>[] = [
    { key: "sku", label: t("export.col.sku"), render: (row) => row.sku },
    { key: "name", label: t("export.col.product"), render: (row) => pick(row.nameAr, row.nameEn) },
    { key: "stock", label: t("export.col.currentQty"), align: "end", render: (row) => num(row.stock) },
    { key: "price", label: t("export.col.sellingPrice"), align: "end", render: (row) => money(row.sellingPrice) },
    { key: "tied", label: t("export.col.tiedUp"), align: "end", render: (row) => money(row.tiedUp) },
  ];

  const ranked: RankedRow[] = best.map((row, index) => ({ ...row, rank: index + 1 }));

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          label={t("export.metric.grossProfit")}
          value={money(margin.profit)}
          tone={margin.profit >= 0 ? "success" : "danger"}
          icon={<LayersIcon />}
          hint={`${num(margin.margin, 1)}% ${t("export.col.margin").toLowerCase()}`}
        />
        <StatTile
          label={t("export.metric.cogs")}
          value={money(margin.cogs)}
          tone="warning"
          hint={`${num(margin.soldProducts)} ${t("reports.adv.soldProducts").toLowerCase()}`}
        />
        <StatTile
          label={t("export.sheet.stockValue")}
          value={money(stock.atCost)}
          tone="info"
          icon={<WarehouseIcon />}
          hint={`${num(stock.units)} ${t("export.col.unitsSold").toLowerCase()} · ${num(stock.tracked)} ${t(
            "export.col.product",
          ).toLowerCase()}`}
        />
        <StatTile
          label={t("export.col.potentialMargin")}
          value={money(stock.potentialMargin)}
          tone="primary"
          icon={<BoxIcon />}
          hint={`${money(stock.atRetail)} ${t("export.col.retailValue").toLowerCase()}`}
        />
      </div>

      {margin.lossMakers.length > 0 ? (
        <Card className="border-rose-200 bg-rose-50">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="danger">{t("export.note.lossMakers")}</Badge>
            <p className="text-xs font-semibold text-rose-800">
              {margin.lossMakers
                .slice(0, 4)
                .map((row) => `${pick(row.nameAr, row.nameEn)} (${money(row.profit)})`)
                .join(" · ")}
              {margin.lossMakers.length > 4 ? ` · +${margin.lossMakers.length - 4}` : ""}
            </p>
          </div>
        </Card>
      ) : null}

      <Card className="space-y-4">
        <ReportSection
          title={t("reports.adv.productProfitability")}
          hint={t("export.note.costIsCurrent")}
          aside={
            <ExportButton
              name="product-report"
              authority="report"
              size="sm"
              count={rows.length}
              build={() => buildProductAnalyticsSheets({ sales, products, range, t, pick })}
            />
          }
        >
          <ReportTable
            columns={performanceColumns}
            rows={[...rows].sort((a, b) => b.revenue - a.revenue).slice(0, 25)}
            rowKey={(row) => row.productId}
            dense
            emptyLabel={t("reports.adv.empty")}
            emptyHint={t("reports.adv.emptyHint")}
            footerNote={rows.length > 25 ? t("reports.adv.topN", { count: 25 }) : undefined}
          />
        </ReportSection>

        <ReportSection title={t("export.sheet.bestSellers")} hint={t("reports.adv.bestSellersHint")}>
          <ReportTable
            columns={bestColumns}
            rows={ranked}
            rowKey={(row) => row.productId}
            dense
            emptyLabel={t("reports.adv.empty")}
            emptyHint={t("reports.adv.emptyHint")}
          />
        </ReportSection>

        <ReportSection title={t("export.sheet.slowMovers")} hint={t("export.note.slowMovers")}>
          <ReportTable
            columns={slowColumns}
            rows={slow}
            rowKey={(row) => row.productId}
            dense
            emptyLabel={t("reports.adv.noSlowMovers")}
            emptyHint={t("reports.adv.noSlowMoversHint")}
            totals={[
              t("export.totalRow"),
              null,
              num(slow.reduce((acc, row) => acc + row.stock, 0)),
              null,
              money(slow.reduce((acc, row) => acc + row.tiedUp, 0)),
            ]}
          />
        </ReportSection>

        <ReportSection title={t("reports.adv.stockCoverage")}>
          <div className="grid gap-3 sm:grid-cols-3">
            <StatTile label={t("dashboard.lowStock")} value={num(stock.lowStock)} tone="warning" />
            <StatTile label={t("dashboard.outOfStock")} value={num(stock.outOfStock)} tone="danger" />
            <StatTile label={t("export.col.retailValue")} value={money(stock.atRetail)} tone="info" />
          </div>
        </ReportSection>
      </Card>
    </div>
  );
}
