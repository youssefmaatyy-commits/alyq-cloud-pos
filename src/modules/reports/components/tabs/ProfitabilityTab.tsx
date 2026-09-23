/**
 * Profit tab — historical-cost KPIs, product/variant profitability, best
 * sellers, slow movers, discount impact and calendar-day charts.
 */
import { useMemo, useState } from "react";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { canAct } from "@/lib/permissions/enforce";
import {
  Card,
  ExportButton,
  StatTile,
  WalletIcon,
  LayersIcon,
  ReceiptIcon,
  BoxIcon,
} from "@/components/ui";
import {
  ChartCard,
  LegendItem,
  PairedBarsChart,
  TrendChart,
  CHART_COLORS,
} from "@/modules/dashboard/components/Charts";
import {
  buildProfitability,
  type BestSellerRank,
  type ReportChannel,
  type SlowLookbackDays,
} from "../../services/profitability";
import { buildProfitabilitySheets } from "../../services/profitabilityExport";
import { ReportSection, ReportTable, type ReportColumn } from "../ReportTable";
import type { ReportTabProps } from "./types";

function openProduct(productId: string) {
  window.location.hash = `#/products/${productId}`;
}

export function ProfitabilityTab({
  sales,
  products,
  variants,
  returns,
  orders,
  range,
  pick,
}: ReportTabProps) {
  const { t, money, num } = useI18n();
  const canViewCost = canAct("view_cost");
  const [channel, setChannel] = useState<ReportChannel>("all");
  const [lookbackDays, setLookbackDays] = useState<SlowLookbackDays>(90);
  const [rankBy, setRankBy] = useState<BestSellerRank>("units");

  const report = useMemo(
    () =>
      buildProfitability({
        sales,
        products,
        variants,
        returns,
        orders,
        range,
        channel,
        lookbackDays,
        rankBy,
      }),
    [sales, products, variants, returns, orders, range, channel, lookbackDays, rankBy],
  );

  const { kpis } = report;

  const productColumns: ReportColumn<(typeof report.products)[number]>[] = [
    { key: "sku", label: t("export.col.sku"), render: (row) => row.sku },
    { key: "name", label: t("export.col.product"), render: (row) => pick(row.nameAr, row.nameEn) },
    { key: "units", label: t("export.col.unitsSold"), align: "end", render: (row) => num(row.units) },
    { key: "gross", label: t("reports.adv.grossSales"), align: "end", render: (row) => money(row.gross) },
    { key: "disc", label: t("export.col.discountsGiven"), align: "end", render: (row) => money(row.discounts) },
    { key: "net", label: t("reports.adv.netSales"), align: "end", render: (row) => money(row.net) },
    ...(canViewCost
      ? [
          { key: "cogs", label: t("export.metric.cogs"), align: "end" as const, render: (row: (typeof report.products)[number]) => money(row.cogs) },
          {
            key: "profit",
            label: t("export.col.profit"),
            align: "end" as const,
            render: (row: (typeof report.products)[number]) => (
              <span className={row.profit < 0 ? "font-bold text-rose-600" : undefined}>{money(row.profit)}</span>
            ),
          },
          { key: "margin", label: t("export.col.margin"), align: "end" as const, render: (row: (typeof report.products)[number]) => `${num(row.margin, 1)}%` },
        ]
      : []),
  ];

  const variantColumns: ReportColumn<(typeof report.variants)[number]>[] = [
    { key: "sku", label: t("export.col.sku"), render: (row) => row.sku },
    { key: "name", label: t("export.col.product"), render: (row) => pick(row.nameAr, row.nameEn) },
    { key: "variant", label: t("export.col.variant"), render: (row) => pick(row.labelAr, row.labelEn) },
    { key: "units", label: t("export.col.unitsSold"), align: "end", render: (row) => num(row.units) },
    { key: "gross", label: t("reports.adv.grossSales"), align: "end", render: (row) => money(row.gross) },
    { key: "net", label: t("reports.adv.netSales"), align: "end", render: (row) => money(row.net) },
    ...(canViewCost
      ? [
          { key: "cogs", label: t("export.metric.cogs"), align: "end" as const, render: (row: (typeof report.variants)[number]) => money(row.cogs) },
          { key: "profit", label: t("export.col.profit"), align: "end" as const, render: (row: (typeof report.variants)[number]) => money(row.profit) },
          { key: "margin", label: t("export.col.margin"), align: "end" as const, render: (row: (typeof report.variants)[number]) => `${num(row.margin, 1)}%` },
        ]
      : []),
  ];

  type Ranked = (typeof report.bestSellers)[number] & { rank: number };
  const ranked: Ranked[] = report.bestSellers.map((row, index) => ({ ...row, rank: index + 1 }));
  const bestColumns: ReportColumn<Ranked>[] = [
    { key: "rank", label: t("export.col.rank"), render: (row) => num(row.rank) },
    { key: "name", label: t("export.col.product"), render: (row) => pick(row.nameAr, row.nameEn) },
    { key: "variant", label: t("export.col.variant"), render: (row) => pick(row.labelAr, row.labelEn) },
    { key: "units", label: t("export.col.unitsSold"), align: "end", render: (row) => num(row.units) },
    { key: "net", label: t("reports.adv.netSales"), align: "end", render: (row) => money(row.net) },
    ...(canViewCost
      ? [{ key: "profit", label: t("export.col.profit"), align: "end" as const, render: (row: Ranked) => money(row.profit) }]
      : []),
  ];

  const slowColumns: ReportColumn<(typeof report.slowMovers)[number]>[] = [
    { key: "sku", label: t("export.col.sku"), render: (row) => row.sku },
    { key: "name", label: t("export.col.product"), render: (row) => pick(row.nameAr, row.nameEn) },
    { key: "variant", label: t("export.col.variant"), render: (row) => pick(row.labelAr, row.labelEn) },
    { key: "stock", label: t("export.col.currentQty"), align: "end", render: (row) => num(row.stock) },
    { key: "value", label: t("export.col.tiedUp"), align: "end", render: (row) => money(row.stockValue) },
    { key: "last", label: t("export.col.lastSale"), render: (row) => row.lastSaleAt ?? t("reports.adv.neverSold") },
    { key: "days", label: t("export.col.daysSince"), align: "end", render: (row) => (row.daysSince == null ? "—" : num(row.daysSince)) },
  ];

  const discountLabel: Record<(typeof report.discounts)[number]["key"], string> = {
    automatic: t("reports.adv.discountAuto"),
    promo: t("reports.adv.discountPromo"),
    manualItem: t("reports.adv.discountManualItem"),
    manualInvoice: t("reports.adv.discountManualInvoice"),
  };

  const selectClass =
    "rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs font-semibold text-slate-700";

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-xs font-semibold text-slate-600">
          {t("reports.adv.channel")}
          <select className={selectClass} value={channel} onChange={(e) => setChannel(e.target.value as ReportChannel)} aria-label={t("reports.adv.channel")}>
            <option value="all">{t("reports.adv.channelAll")}</option>
            <option value="pos">{t("reports.adv.channelPos")}</option>
            <option value="online">{t("reports.adv.channelOnline")}</option>
          </select>
        </label>
        <label className="flex items-center gap-2 text-xs font-semibold text-slate-600">
          {t("reports.adv.lookback")}
          <select className={selectClass} value={lookbackDays} onChange={(e) => setLookbackDays(Number(e.target.value) as SlowLookbackDays)} aria-label={t("reports.adv.lookback")}>
            <option value={30}>{t("reports.adv.lookback30")}</option>
            <option value={60}>{t("reports.adv.lookback60")}</option>
            <option value={90}>{t("reports.adv.lookback90")}</option>
          </select>
        </label>
        <label className="flex items-center gap-2 text-xs font-semibold text-slate-600">
          {t("reports.adv.rankBy")}
          <select className={selectClass} value={rankBy} onChange={(e) => setRankBy(e.target.value as BestSellerRank)} aria-label={t("reports.adv.rankBy")}>
            <option value="units">{t("reports.adv.bestSellersUnits")}</option>
            <option value="net">{t("reports.adv.bestSellersNet")}</option>
          </select>
        </label>
        <div className="ms-auto">
          <ExportButton
            name="profitability-report"
            authority="report"
            size="sm"
            count={report.products.length + report.variants.length + report.slowMovers.length}
            build={() =>
              buildProfitabilitySheets({
                sales,
                products,
                variants,
                returns,
                orders,
                range,
                channel,
                lookbackDays,
                rankBy,
                t,
                pick,
                canViewCost,
              })
            }
          />
        </div>
      </div>

      <p className="text-xs font-medium text-slate-500">{t("reports.adv.historicalCostHint")}</p>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label={t("reports.adv.grossSales")} value={money(kpis.grossSales)} tone="info" icon={<WalletIcon />} />
        <StatTile
          label={t("reports.adv.totalDiscounts")}
          value={money(kpis.totalDiscounts)}
          tone="warning"
          hint={`${num(kpis.discountShareOfGross, 1)}% ${t("reports.adv.discountOfGross")}`}
        />
        <StatTile label={t("reports.adv.netSales")} value={money(kpis.netSales)} tone="success" hint={`${num(kpis.invoices)} · AOV ${money(kpis.aov)}`} />
        {canViewCost ? (
          <StatTile
            label={t("export.metric.grossProfit")}
            value={money(kpis.grossProfit)}
            tone={kpis.grossProfit >= 0 ? "success" : "danger"}
            icon={<LayersIcon />}
            hint={`${num(kpis.grossMargin, 2)}% · ${t("export.metric.cogs")} ${money(kpis.cogs)}`}
          />
        ) : (
          <StatTile label={t("reports.adv.unitsSold")} value={num(kpis.unitsSold)} tone="primary" icon={<BoxIcon />} />
        )}
      </div>

      {canViewCost && !kpis.cogsAuthoritative ? (
        <Card className="border-amber-200 bg-amber-50">
          <p className="text-xs font-semibold text-amber-800">{t("reports.adv.cogsUnknownHint", { count: kpis.cogsUnknownUnits })}</p>
        </Card>
      ) : null}

      {!canViewCost ? (
        <p className="text-xs font-medium text-slate-500">{t("reports.adv.costHiddenHint")}</p>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label={t("reports.adv.unitsSold")} value={num(kpis.unitsSold)} />
        <StatTile label={t("reports.adv.salesCount")} value={num(kpis.invoices)} />
        <StatTile label={t("reports.adv.deliveryCollected")} value={money(kpis.deliveryFeesCollected)} hint={t("reports.adv.deliveryHint")} icon={<ReceiptIcon />} />
        <StatTile label={t("reports.adv.freeShipping")} value={money(kpis.shippingDiscount)} />
      </div>

      <Card className="space-y-4">
        <ReportSection title={t("reports.adv.discountImpact")} hint={t("reports.adv.historicalCost")}>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {report.discounts.map((row) => (
              <StatTile
                key={row.key}
                label={discountLabel[row.key]}
                value={money(row.amount)}
                hint={`${num(row.shareOfGross, 1)}%`}
              />
            ))}
          </div>
        </ReportSection>

        <div className="grid gap-4 lg:grid-cols-2">
          <ChartCard title={t("reports.adv.chartNetSales")} empty={report.trend.every((p) => p.netSales === 0) ? t("dashboard.noChartData") : undefined}>
            <TrendChart points={report.trend.map((p) => ({ date: p.date, total: p.netSales }))} color={CHART_COLORS[0]} />
          </ChartCard>
          {canViewCost ? (
            <ChartCard title={t("reports.adv.chartGrossProfit")} empty={report.trend.every((p) => p.grossProfit === 0) ? t("dashboard.noChartData") : undefined}>
              <TrendChart points={report.trend.map((p) => ({ date: p.date, total: p.grossProfit }))} color={CHART_COLORS[1]} />
            </ChartCard>
          ) : (
            <ChartCard title={t("reports.adv.chartDiscountTrend")} empty={report.trend.every((p) => p.discounts === 0) ? t("dashboard.noChartData") : undefined}>
              <TrendChart points={report.trend.map((p) => ({ date: p.date, total: p.discounts }))} color={CHART_COLORS[2]} />
            </ChartCard>
          )}
          {canViewCost ? (
            <ChartCard
              title={t("reports.adv.chartSalesVsProfit")}
              legend={
                <span className="flex gap-3">
                  <LegendItem color={CHART_COLORS[1]} label={t("reports.adv.netSales")} />
                  <LegendItem color={CHART_COLORS[3]} label={t("export.metric.grossProfit")} />
                </span>
              }
            >
              <PairedBarsChart
                points={report.trend.map((p) => ({ date: p.date, revenue: p.netSales, expenses: p.grossProfit }))}
                revenueColor={CHART_COLORS[1]}
                expenseColor={CHART_COLORS[3]}
              />
            </ChartCard>
          ) : null}
          <ChartCard title={t("reports.adv.chartDiscountTrend")}>
            <TrendChart points={report.trend.map((p) => ({ date: p.date, total: p.discounts }))} color={CHART_COLORS[2]} />
          </ChartCard>
        </div>

        <ReportSection title={t("export.sheet.productProfitability")} hint={t("reports.adv.profitHint")}>
          <ReportTable
            columns={productColumns}
            rows={report.products.slice(0, 40)}
            rowKey={(row) => row.productId}
            dense
            emptyLabel={t("reports.adv.empty")}
            emptyHint={t("reports.adv.emptyHint")}
            onRowClick={(row) => openProduct(row.productId)}
          />
        </ReportSection>

        <ReportSection title={t("export.sheet.variantProfitability")}>
          <ReportTable
            columns={variantColumns}
            rows={report.variants.slice(0, 40)}
            rowKey={(row) => `${row.productId}::${row.variantId}`}
            dense
            emptyLabel={t("reports.adv.empty")}
            emptyHint={t("reports.adv.emptyHint")}
            onRowClick={(row) => openProduct(row.productId)}
          />
        </ReportSection>

        <ReportSection title={t("export.sheet.bestSellers")} hint={t("reports.adv.bestSellersHint")}>
          <ReportTable
            columns={bestColumns}
            rows={ranked}
            rowKey={(row) => `${row.productId}::${row.variantId}::${row.rank}`}
            dense
            emptyLabel={t("reports.adv.empty")}
            emptyHint={t("reports.adv.emptyHint")}
            onRowClick={(row) => openProduct(row.productId)}
          />
        </ReportSection>

        <ReportSection title={t("export.sheet.slowMovers")} hint={t("reports.adv.slowMoversHint")}>
          <ReportTable
            columns={slowColumns}
            rows={report.slowMovers.slice(0, 50)}
            rowKey={(row) => `${row.productId}::${row.variantId ?? ""}`}
            dense
            emptyLabel={t("reports.adv.noSlowMovers")}
            emptyHint={t("reports.adv.noSlowMoversHint")}
            onRowClick={(row) => openProduct(row.productId)}
          />
        </ReportSection>
      </Card>
    </div>
  );
}
