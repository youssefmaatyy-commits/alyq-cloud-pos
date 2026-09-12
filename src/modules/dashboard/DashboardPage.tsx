import { Link } from "react-router-dom";
import { useMemo } from "react";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { PageHeader } from "@/components/layout/AppShell";
import {
  Badge,
  BoxIcon,
  Card,
  ClipboardIcon,
  ClockIcon,
  GlobeIcon,
  LayersIcon,
  LoadingBlock,
  ReceiptIcon,
  RotateCcwIcon,
  ShoppingCartIcon,
  StatTile,
  UsersIcon,
  WalletIcon,
  WarehouseIcon,
} from "@/components/ui";
import { cn } from "@/utils/cn";
import { useOptionalApprovals } from "@/modules/approvals";
import { ReservationSummaryCard, useOnlineOrders } from "@/modules/online";
import { mayViewReports } from "@/modules/reports/services/reportAccess";
import {
  CHART_COLORS,
  ChartCard,
  DonutChart,
  LegendItem,
  PairedBarsChart,
  RankBars,
  TrendChart,
} from "./components/Charts";
import { useCatalog } from "@/modules/products/hooks/CatalogProvider";
import { usePos } from "@/modules/pos/hooks/PosProvider";
import { useInventory } from "@/modules/inventory/hooks/InventoryProvider";
import { useCustomers } from "@/modules/customers/hooks/CustomerProvider";
import { useReturns } from "@/modules/returns/hooks/ReturnProvider";
import { useExpenses } from "@/modules/expenses/hooks/ExpenseProvider";
import { useShifts } from "@/modules/shifts/hooks/ShiftProvider";
import {
  DASHBOARD_TREND_DAYS,
  buildDashboardSnapshot,
  computeMonthlyKpis,
  monthExpensesTotal,
  paymentMix,
  revenueVsExpensesSeries,
  salesTrendSeries,
  topProducts,
} from "./dashboardQuery";

/**
 * Operations dashboard — read-only view over live module data.
 *
 * All numbers come from existing providers (sales, inventory, customers,
 * returns, expenses, shifts). No mock data, no new API calls. The page is
 * purely additive: the catalog tiles from Phase 1 remain, with sales,
 * inventory health, returns, expenses and shift status layered on top.
 *
 * Phase 14 layers a performance section on top of that — month-to-date sales,
 * profit and expenses, the two approval queues, and four charts. Two rules kept
 * it honest:
 *
 *   · Every figure is read from the reports' analytics (`computeFinancialTotals`,
 *     `salesTrend`, `productPerformance`, `salesByPaymentMethod`,
 *     `expensesByDay`), so the dashboard cannot show a number that contradicts
 *     the report for the same window. The charts draw those numbers; they do not
 *     compute anything.
 *   · The section is gated on `mayViewReports()` — the same read authority the
 *     reports screen uses. A cashier sees exactly the dashboard they saw before;
 *     a manager sees the analysis. The approval and online-order tiles read their
 *     own providers, which already limit themselves to what the signed-in user
 *     may act on.
 */
export function DashboardPage() {
  const { t, money, num, date, pick } = useI18n();
  const { mode } = useCatalog();
  const { sales, salesLoading } = usePos();
  const { products, loading: inventoryLoading } = useInventory();
  const { customers, loading: customersLoading } = useCustomers();
  const { returnsList, refundsList, loading: returnsLoading } = useReturns();
  const { expenses } = useExpenses();
  const { openShift, currentSummary } = useShifts();
  // Both queues are already scoped to the signed-in user by their providers:
  // approvals returns what this person may decide, online orders only counts
  // when `canManage` is true. The tiles below add no authority of their own.
  const approvals = useOptionalApprovals();
  const { counts: onlineCounts, canManage: canManageOnline } = useOnlineOrders();
  const maySeePerformance = mayViewReports();

  const loading = salesLoading || inventoryLoading || customersLoading || returnsLoading;

  const snapshot = useMemo(
    () =>
      buildDashboardSnapshot({
        sales,
        products,
        returns: returnsList,
        refunds: refundsList,
        expenses,
        customers,
        openShift,
        shiftSummary: currentSummary,
      }),
    [sales, products, returnsList, refundsList, expenses, customers, openShift, currentSummary],
  );

  /* ── Performance series (Phase 14) ────────────────────────────────────────
     Computed for everybody but rendered only behind `maySeePerformance`, so the
     gate is a rendering decision, not a data decision — the numbers on screen
     are the numbers the reports would show. */
  const monthly = useMemo(
    () =>
      computeMonthlyKpis({
        sales,
        products,
        expenses,
        returnsList,
        refundsList,
      }),
    [sales, products, expenses, returnsList, refundsList],
  );
  const trend = useMemo(() => salesTrendSeries({ sales }), [sales]);
  const revenueVsExpenses = useMemo(
    () => revenueVsExpensesSeries({ sales, expenses }),
    [sales, expenses],
  );
  const methods = useMemo(() => paymentMix(sales), [sales]);
  const bestSellersList = useMemo(() => topProducts({ sales, products }), [sales, products]);
  const monthExpenses = useMemo(() => monthExpensesTotal(expenses), [expenses]);
  const hasChartData = trend.some((point) => point.revenue > 0 || point.invoices > 0);

  const dayLabel = (day: string) => date(`${day}T00:00:00`);
  const percent = (value: number) => `${num(value, 1)}%`;

  if (loading) return <LoadingBlock label={t("common.loading")} />;

  return (
    <div>
      <PageHeader
        title={t("nav.dashboard")}
        subtitle={t("app.phase")}
        actions={
          <Badge tone={mode === "supabase" ? "success" : "warning"}>
            {mode === "supabase" ? t("mode.live") : t("mode.demo")}
          </Badge>
        }
      />

      {/* ── Sales KPIs ────────────────────────────────────────────────────── */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          label={t("dashboard.todayRevenue")}
          value={money(snapshot.sales.todayRevenue)}
          tone="primary"
          icon={<WalletIcon />}
          hint={`${snapshot.sales.todayCount} ${t("dashboard.todaySales").toLowerCase()}`}
        />
        <StatTile
          label={t("dashboard.totalRevenue")}
          value={money(snapshot.sales.totalRevenue)}
          tone="success"
          icon={<ShoppingCartIcon />}
          hint={`${snapshot.sales.totalCount} ${t("dashboard.totalSales").toLowerCase()}`}
        />
        <StatTile
          label={t("dashboard.returnsToday")}
          value={money(snapshot.returns.todayTotal)}
          tone="warning"
          icon={<RotateCcwIcon />}
          hint={`${snapshot.returns.todayCount} ${t("common.results")}`}
        />
        <StatTile
          label={t("dashboard.expensesToday")}
          value={money(snapshot.expenses.todayTotal)}
          tone="neutral"
          icon={<ClockIcon />}
          hint={`${snapshot.expenses.todayCount} ${t("common.results")}`}
        />
      </div>

      {/* ── Inventory + catalog ───────────────────────────────────────────── */}
      <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          label={t("products.title")}
          value={String(snapshot.catalog.total)}
          tone="info"
          icon={<BoxIcon />}
          hint={`${snapshot.catalog.active} ${t("common.active").toLowerCase()}`}
        />
        <StatTile
          label={t("dashboard.lowStock")}
          value={String(snapshot.catalog.lowStock)}
          tone="warning"
          icon={<WarehouseIcon />}
        />
        <StatTile
          label={t("dashboard.outOfStock")}
          value={String(snapshot.catalog.outOfStock)}
          tone="danger"
        />
        <StatTile
          label={t("dashboard.inventoryValue")}
          value={money(snapshot.catalog.inventoryValue)}
          tone="neutral"
          icon={<LayersIcon />}
        />
      </div>

      {/* ── Customers + pending + shift ───────────────────────────────────── */}
      <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          label={t("dashboard.customers")}
          value={String(snapshot.customerCount)}
          tone="info"
          icon={<UsersIcon />}
        />
        <StatTile
          label={t("dashboard.pendingSales")}
          value={money(snapshot.sales.pendingTotal)}
          tone="warning"
          hint={`${snapshot.sales.pendingCount} ${t("common.results")}`}
        />
        <StatTile
          label={t("dashboard.totalReturns")}
          value={money(snapshot.returns.totalRefunded)}
          tone="neutral"
          hint={`${snapshot.returns.totalCount} ${t("common.results")}`}
        />
        <StatTile
          label={t("dashboard.pendingRefunds")}
          value={String(snapshot.returns.pendingRefunds)}
          tone={snapshot.returns.pendingRefunds > 0 ? "warning" : "success"}
        />
      </div>

      {maySeePerformance ? (
        <>
          {/* ── Month to date + queues ───────────────────────────────────── */}
          <div className="mt-6 flex flex-wrap items-end justify-between gap-2">
            <div>
              <h2 className="text-base font-bold text-slate-900">{t("dashboard.performance")}</h2>
              <p className="mt-0.5 text-xs font-medium text-slate-600">
                {t("dashboard.performanceHint", { days: DASHBOARD_TREND_DAYS })}
              </p>
            </div>
            <Link
              to="/reports/advanced"
              className="text-xs font-semibold text-indigo-600 hover:text-indigo-700"
            >
              {t("dashboard.viewAdvanced")} →
            </Link>
          </div>

          <div
            className={cn(
              "mt-3 grid gap-3 sm:grid-cols-2",
              canManageOnline ? "lg:grid-cols-5" : "lg:grid-cols-4",
            )}
          >
            <StatTile
              label={t("dashboard.monthSales")}
              value={money(monthly.revenue)}
              tone="primary"
              icon={<WalletIcon />}
              hint={t("dashboard.monthInvoices", { count: monthly.invoices })}
            />
            <StatTile
              label={t("dashboard.monthProfit")}
              value={money(monthly.profit)}
              tone={monthly.profit >= 0 ? "success" : "danger"}
              icon={<LayersIcon />}
              hint={t("dashboard.monthMargin", { margin: percent(monthly.margin) })}
            />
            <StatTile
              label={t("dashboard.monthExpenses")}
              value={money(monthExpenses)}
              tone="warning"
              icon={<ReceiptIcon />}
              hint={t("dashboard.monthRefunds", { amount: money(monthly.refunds) })}
            />
            <StatTile
              label={t("dashboard.pendingApprovals")}
              value={String(approvals?.summary.pending ?? 0)}
              tone={(approvals?.summary.pending ?? 0) > 0 ? "warning" : "success"}
              icon={<ClipboardIcon />}
              hint={t("approvals.pendingHint")}
            />
            {canManageOnline ? (
              <StatTile
                label={t("dashboard.pendingOnlineOrders")}
                value={String(onlineCounts.pending)}
                tone={onlineCounts.pending > 0 ? "info" : "neutral"}
                icon={<GlobeIcon />}
                hint={t("dashboard.onlineNeedsPayment", { count: onlineCounts.needs_payment })}
              />
            ) : null}
          </div>

          {/* What the website is holding, from the review the queue provider
              already computed — no query of its own, and it hides itself for
              anybody who cannot work the online queue. */}
          <ReservationSummaryCard className="mt-3" />

          {/* ── Charts ─────────────────────────────────────────────────────── */}
          <div className="mt-3 grid gap-3 lg:grid-cols-2">
            <Card>
              <ChartCard
                title={t("dashboard.salesTrend")}
                hint={t("dashboard.salesTrendHint", { count: DASHBOARD_TREND_DAYS })}
                empty={hasChartData ? undefined : t("dashboard.noChartData")}
                legend={
                  hasChartData ? (
                    <span className="text-[11px] font-semibold tabular-nums text-slate-500">
                      {dayLabel(trend[0].date)} – {dayLabel(trend[trend.length - 1].date)}
                    </span>
                  ) : undefined
                }
              >
                <TrendChart points={trend.map((point) => ({ date: point.date, total: point.revenue }))} />
              </ChartCard>
            </Card>

            <Card>
              <ChartCard
                title={t("dashboard.revenueVsExpenses")}
                hint={t("dashboard.revenueVsExpensesHint", { count: DASHBOARD_TREND_DAYS })}
                empty={hasChartData ? undefined : t("dashboard.noChartData")}
                legend={
                  <span className="flex flex-wrap items-center gap-3">
                    <LegendItem color={CHART_COLORS[1]} label={t("dashboard.legendRevenue")} />
                    <LegendItem color={CHART_COLORS[3]} label={t("dashboard.legendExpenses")} />
                  </span>
                }
              >
                <PairedBarsChart points={revenueVsExpenses} />
              </ChartCard>
            </Card>

            <Card>
              <ChartCard
                title={t("dashboard.paymentMix")}
                hint={t("dashboard.paymentMixHint")}
                empty={methods.length === 0 ? t("dashboard.noChartData") : undefined}
              >
                <DonutChart
                  slices={methods.map((row, i) => ({
                    label: t(`pos.payment.${row.method}` as never),
                    value: row.amount,
                    color: CHART_COLORS[i % CHART_COLORS.length],
                  }))}
                  centreLabel={t("dashboard.legendRevenue")}
                  centreValue={money(methods.reduce((sum, row) => sum + row.amount, 0))}
                />
              </ChartCard>
            </Card>

            <Card>
              <ChartCard
                title={t("dashboard.productPerformance")}
                hint={t("dashboard.productPerformanceHint", { count: DASHBOARD_TREND_DAYS })}
                empty={bestSellersList.length === 0 ? t("dashboard.noChartData") : undefined}
              >
                <RankBars
                  rows={bestSellersList.map((row) => ({
                    label: pick(row.nameAr, row.nameEn),
                    value: row.revenue,
                    hint: money(row.revenue),
                  }))}
                />
              </ChartCard>
            </Card>
          </div>

          {/* ── Top selling products ───────────────────────────────────────── */}
          <Card className="mt-3">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="text-base font-bold text-slate-900">{t("dashboard.topProducts")}</h2>
                <p className="mt-0.5 text-xs font-medium text-slate-600">
                  {t("dashboard.topProductsHint", { count: DASHBOARD_TREND_DAYS })}
                </p>
              </div>
              <Link
                to="/reports/advanced"
                className="text-xs font-semibold text-indigo-600 hover:text-indigo-700"
              >
                {t("nav.advancedReports")} →
              </Link>
            </div>
            {bestSellersList.length === 0 ? (
              <p className="py-6 text-center text-sm text-slate-500">{t("dashboard.noChartData")}</p>
            ) : (
              <div className="divide-y divide-slate-100">
                {bestSellersList.map((row, index) => (
                  <div key={row.id} className="flex items-center justify-between gap-3 py-2.5">
                    <div className="flex min-w-0 items-center gap-3">
                      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-indigo-50 text-[11px] font-bold text-indigo-600">
                        {index + 1}
                      </span>
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold text-slate-900">
                          {pick(row.nameAr, row.nameEn)}
                        </p>
                        <p className="text-[11px] text-slate-500">
                          {row.units} {t("dashboard.units")} · {money(row.revenue)}
                        </p>
                      </div>
                    </div>
                    <span className="shrink-0 text-xs font-bold tabular-nums text-emerald-700">
                      {money(row.profit)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </>
      ) : null}

      {/* ── Open shift summary ────────────────────────────────────────────── */}
      {snapshot.openShift && snapshot.shiftSummary ? (
        <Card className="mt-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-base font-bold text-slate-900">{t("dashboard.openShift")}</h2>
              <p className="mt-0.5 text-xs font-medium text-slate-600">
                {snapshot.openShift.branch || "—"} · {snapshot.openShift.opened_by_name}
              </p>
            </div>
            <div className="flex flex-wrap gap-4 text-end">
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                  {t("dashboard.cashSales")}
                </p>
                <p className="text-sm font-bold text-slate-900">
                  {money(snapshot.shiftSummary.cash_sales)}
                </p>
              </div>
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                  {t("dashboard.expectedCash")}
                </p>
                <p className="text-sm font-bold text-slate-900">
                  {money(snapshot.shiftSummary.expected_cash)}
                </p>
              </div>
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                  {t("dashboard.todaySales")}
                </p>
                <p className="text-sm font-bold text-slate-900">
                  {snapshot.shiftSummary.sales_count}
                </p>
              </div>
            </div>
          </div>
        </Card>
      ) : (
        <Card className="mt-4">
          <p className="text-sm font-medium text-slate-500">{t("dashboard.noOpenShift")}</p>
        </Card>
      )}

      {/* ── Recent sales ──────────────────────────────────────────────────── */}
      <Card className="mt-4">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-base font-bold text-slate-900">{t("dashboard.recentSales")}</h2>
          <Link
            to="/pos/sales"
            className="text-xs font-semibold text-indigo-600 hover:text-indigo-700"
          >
            {t("nav.sales")} →
          </Link>
        </div>

        {snapshot.recentSales.length === 0 ? (
          <p className="py-6 text-center text-sm text-slate-500">{t("dashboard.noSalesYet")}</p>
        ) : (
          <div className="divide-y divide-slate-100">
            {snapshot.recentSales.map((sale) => (
              <Link
                key={sale.id}
                to={`/pos/sales/${sale.id}`}
                className="flex items-center justify-between gap-3 py-2.5 hover:bg-slate-50 rounded-lg px-2 -mx-2 transition-colors"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-indigo-50 text-indigo-600">
                    <ReceiptIcon />
                  </span>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-slate-900">
                      {sale.sale_number}
                    </p>
                    <p className="text-[11px] text-slate-500">
                      {sale.user_name} · {sale.items_count} {t("dashboard.items")}
                    </p>
                  </div>
                </div>
                <div className="text-end shrink-0">
                  <p className="text-sm font-bold text-slate-900">{money(sale.total)}</p>
                  <Badge
                    tone={sale.status === "completed" ? "success" : "warning"}
                  >
                    {sale.status === "completed"
                      ? sale.payment_method === "cash"
                        ? t("pos.payment.cash")
                        : t("pos.payment.instapay")
                      : t("dashboard.pendingSales")}
                  </Badge>
                </div>
              </Link>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
