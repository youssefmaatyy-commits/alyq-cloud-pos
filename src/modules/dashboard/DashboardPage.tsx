import { Link } from "react-router-dom";
import { useEffect, useMemo, useState } from "react";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { PageHeader } from "@/components/layout/AppShell";
import {
  Badge,
  BoxIcon,
  Button,
  Card,
  ClipboardIcon,
  ClockIcon,
  GlobeIcon,
  KpiTile,
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
import { canAct } from "@/lib/permissions/enforce";
import { pathAdmits } from "@/lib/permissions/routes";
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
import { brandDisplayName, useBrand } from "@/lib/branding/brand";
import {
  computeInventoryAlerts,
  computeOnlineKpis,
  computeTopOnlineCategories,
  computeTopOnlineProducts,
  inventoryAlertLine,
} from "./onlineDashboard";
import {
  DASHBOARD_TREND_DAYS,
  buildDashboardSnapshot,
  computeMonthlyKpis,
  monthlyKpisFromTotals,
  monthRangeOf,
  monthExpensesTotal,
  paymentMix,
  revenueVsExpensesSeries,
  salesTrendSeries,
  topProducts,
} from "./dashboardQuery";
import { presetRange, toExportRange } from "@/modules/reports/services/dateRanges";
import type { PaymentMethodSalesRow } from "@/modules/reports/services/salesAnalytics";
import { fetchFinancialSummary, fetchProfitabilitySummary } from "@/modules/reports/services/reportAggregates";
import type {
  FinancialTotals,
} from "@/modules/reports/services/financialExport";
import type { ProfitabilitySummaryParts } from "@/modules/reports/services/reportAggregates";

/**
 * The command centre (Phase 46 edition).
 *
 * The rules that made this page honest in Phase 14 are kept and extended:
 *
 *   · Every figure is derived from providers the shell already mounts — sales,
 *     catalog, inventory (with variants), customers, returns, expenses, shifts,
 *     approvals and the online queue. The reports-derived figures still come
 *     from the reports' analytics, so the dashboard cannot contradict the
 *     Reports hub. Nothing is fetched specially for this page except the same
 *     month summary the performance section always loaded.
 *   · A KPI tile without a destination renders inert rather than fake, and a
 *     destination the signed-in role cannot open is not rendered at all.
 *     Routing goes through the modules' own filters (URL params the screens
 *     hydrate), never through a simulated click.
 *   · Inventory alerts are variant-aware: an alert names the exact combination
 *     ("Gold Ring · Gold / 17 · Out of stock"), and a product is never called
 *     out of stock while one of its combinations still has units.
 *   · The website section appears only for people who work the website queue,
 *     reading the same orders the Online Orders screen shows.
 */
export function DashboardPage() {
  const { t, money, num, date, pick, lang } = useI18n();
  const { mode, categories } = useCatalog();
  const brand = useBrand();
  const { sales, salesLoading } = usePos();
  const { products, loading: inventoryLoading, variantsByProduct } = useInventory();
  const { customers, loading: customersLoading } = useCustomers();
  const { returnsList, refundsList, loading: returnsLoading } = useReturns();
  const { expenses } = useExpenses();
  const { openShift, currentSummary } = useShifts();
  // Both queues are already scoped to the signed-in user by their providers:
  // approvals returns what this person may decide, online orders only counts
  // when `canManage` is true. The tiles below add no authority of their own.
  const approvals = useOptionalApprovals();
  const { orders: onlineOrders, counts: onlineCounts, canManage: canManageOnline } = useOnlineOrders();
  const maySeePerformance = mayViewReports();
  const maySeeCost = canAct("view_cost");
  const canSeeWebsite = canManageOnline || (canActWebsite());
  const mayOpenSales = canActRoute("/pos/sales");
  const mayOpenProducts = canActRoute("/products");
  const mayOpenInventory = canActRoute("/inventory");
  const mayOpenReturns = canActRoute("/returns");
  const mayOpenShifts = canActRoute("/shifts");
  const mayOpenCustomers = canActRoute("/customers");
  const mayOpenOrders = canManageOnline && canActRoute("/online/orders");

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

  // ── the website half ───────────────────────────────────────────────────────
  const onlineKpis = useMemo(() => computeOnlineKpis(onlineOrders), [onlineOrders]);
  const inventoryAlerts = useMemo(
    () => computeInventoryAlerts(products, variantsByProduct, lang),
    [products, variantsByProduct, lang],
  );
  const categoryNameById = useMemo(
    () => new Map(categories.map((category) => [category.id, pick(category.name_ar, category.name_en)])),
    [categories, pick],
  );
  const productById = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);
  const topOnline = useMemo(() => computeTopOnlineProducts(onlineOrders, 5), [onlineOrders]);
  const topOnlineCategories = useMemo(
    () => computeTopOnlineCategories(onlineOrders, productById, categoryNameById, 5),
    [onlineOrders, productById, categoryNameById],
  );
  const websiteVisible = useMemo(
    () => ({
      visible: products.filter((p) => p.show_on_website && p.active).length,
      hidden: products.filter((p) => !p.show_on_website || !p.active).length,
    }),
    [products],
  );
  const recentWebOrders = useMemo(
    () => [...onlineOrders].sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 6),
    [onlineOrders],
  );
  /* ── Performance series (Phase 14) ────────────────────────────────────────
     Computed for everybody but rendered only behind `maySeePerformance`, so the
     gate is a rendering decision, not a data decision — the numbers on screen
     are the numbers the reports would show. */
  /** The month as this browser can sum it from the sales it holds. */
  const clientMonthly = useMemo(
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

  /**
   * The month as the DATABASE sums it — every invoice in the month to date,
   * where the provider's list holds at most SALES_ROW_CAP of them. `sales` is
   * the dependency because a new invoice is what makes the answer stale; the
   * range itself is "this month", which the effect re-reads when it runs.
   */
  const [dbMonthly, setDbMonthly] = useState<FinancialTotals | null>(null);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const result = await fetchFinancialSummary(monthRangeOf());
      // A refused or unavailable aggregate is not an error to surface here: the
      // tile falls back to the numbers the browser can compute, which is what
      // it showed before this existed.
      if (!cancelled) setDbMonthly(result.ok ? result.value : null);
    })();
    return () => {
      cancelled = true;
    };
  }, [sales]);

  const monthly = useMemo(
    () => (dbMonthly ? monthlyKpisFromTotals(dbMonthly) : clientMonthly),
    [dbMonthly, clientMonthly],
  );

  // Today's headline figures use the same bounded aggregate contract as the
  // reports screen. The row providers remain a graceful fallback in demo mode
  // or for a role that cannot view reports; they are never used to manufacture
  // a discount or cost/profit figure that the source data cannot support.
  const todayRange = useMemo(() => toExportRange(presetRange("today")), []);
  const [dbToday, setDbToday] = useState<FinancialTotals | null>(null);
  const [dbTodayProfitability, setDbTodayProfitability] = useState<ProfitabilitySummaryParts | null>(null);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [financial, profitability] = await Promise.all([
        fetchFinancialSummary(todayRange),
        fetchProfitabilitySummary(todayRange),
      ]);
      if (cancelled) return;
      setDbToday(financial.ok ? financial.value : null);
      setDbTodayProfitability(profitability.ok ? profitability.value : null);
    })();
    return () => {
      cancelled = true;
    };
  }, [sales, todayRange]);

  const todayRevenue = dbToday?.revenue ?? snapshot.sales.todayRevenue;
  const todayInvoices = dbToday?.invoiceCount ?? snapshot.sales.todayCount;
  const todayAov = todayInvoices > 0 ? todayRevenue / todayInvoices : 0;
  const todayRefunded = dbToday?.refundsPaid ?? snapshot.returns.todayTotal;
  const todayDiscounts = dbTodayProfitability
    ? dbTodayProfitability.automaticDiscounts +
      dbTodayProfitability.manualItemDiscounts +
      dbTodayProfitability.manualInvoiceDiscounts +
      dbTodayProfitability.promoCodeDiscounts
    : null;
  const todayNetSales = dbTodayProfitability
    ? dbTodayProfitability.netSales - dbTodayProfitability.refundsAmount
    : null;
  // Cost is shown only if every sold unit has its immutable cost snapshot. A
  // partial COGS number is not a "rough profit" — it is an understatement.
  const todayGrossProfit =
    dbTodayProfitability && dbTodayProfitability.cogsUnknownUnits === 0
      ? todayNetSales! - dbTodayProfitability.cogs
      : null;

  const trend = useMemo(() => salesTrendSeries({ sales }), [sales]);
  const revenueVsExpenses = useMemo(
    () => revenueVsExpensesSeries({ sales, expenses }),
    [sales, expenses],
  );
  // The aggregate returns additive payment amounts, including split payments.
  // Use it whenever available rather than building a donut from the provider's
  // capped invoice window; the fallback keeps demo mode usable.
  const methods = useMemo<PaymentMethodSalesRow[]>(() => {
    if (!dbMonthly) return paymentMix(sales);
    const aggregateRows: PaymentMethodSalesRow[] = [
      { method: "cash", invoices: 0, amount: dbMonthly.cash, paid: 0, pending: 0, share: 0 },
      { method: "visa", invoices: 0, amount: dbMonthly.card, paid: 0, pending: 0, share: 0 },
      { method: "instapay", invoices: 0, amount: dbMonthly.instapay, paid: 0, pending: 0, share: 0 },
    ];
    return aggregateRows.filter((row) => row.amount > 0);
  }, [dbMonthly, sales]);
  const bestSellersList = useMemo(() => topProducts({ sales, products }), [sales, products]);
  const monthExpenses = useMemo(() => monthExpensesTotal(expenses), [expenses]);
  const hasChartData = trend.some((point) => point.revenue > 0 || point.invoices > 0);

  const dayLabel = (day: string) => date(`${day}T00:00:00`);
  const percent = (value: number) => `${num(value, 1)}%`;
  const outWord = t("dashboard.alertOut");
  const lowWord = t("dashboard.alertLow");

  if (loading) return <LoadingBlock label={t("common.loading")} />;

  return (
    <div>
      <PageHeader
        title={t("nav.dashboard")}
        subtitle={
          brand
            ? t("dashboard.commandCentreHint", { name: brandDisplayName(brand, lang) })
            : t("app.phase")
        }
        actions={
          <Badge tone={mode === "supabase" ? "success" : "warning"}>
            {mode === "supabase" ? t("mode.live") : t("mode.demo")}
          </Badge>
        }
      />

      {/* ── Quick actions — each routes to a real operation ─────────────────── */}
      <div className="mb-4 flex flex-wrap gap-2" data-testid="dash-quick-actions">
        {mayOpenSales ? (
          <Link to="/pos">
            <Button variant="primary" size="sm" data-testid="dash-qa-new-sale">
              <ShoppingCartIcon /> {t("dashboard.qaNewSale")}
            </Button>
          </Link>
        ) : null}
        {mayOpenProducts ? (
          <Link to="/products/new">
            <Button variant="secondary" size="sm" data-testid="dash-qa-add-product">
              <BoxIcon /> {t("dashboard.qaAddProduct")}
            </Button>
          </Link>
        ) : null}
        {mayOpenInventory ? (
          <Link to="/inventory/stock">
            <Button variant="secondary" size="sm" data-testid="dash-qa-stock">
              <WarehouseIcon /> {t("dashboard.qaStock")}
            </Button>
          </Link>
        ) : null}
        {canSeeWebsite ? (
          <Link to="/online/website">
            <Button variant="secondary" size="sm" data-testid="dash-qa-website">
              <GlobeIcon /> {t("dashboard.qaWebsite")}
            </Button>
          </Link>
        ) : null}
      </div>

      {/* ── Today — the five numbers the day is judged by ──────────────────── */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5" data-testid="dash-kpi-row">
        <KpiTile
          label={t("dashboard.todayRevenue")}
          value={money(todayRevenue)}
          tone="primary"
          featured
          icon={<WalletIcon />}
          hint={t("dashboard.todayInvoicesAov", {
            count: num(todayInvoices, 0),
            average: money(todayAov),
          })}
          to={mayOpenSales ? "/pos/sales?today=1" : undefined}
          testId="kpi-today-sales"
        />
        <KpiTile
          label={t("dashboard.webOrdersToday")}
          value={String(onlineKpis.ordersToday)}
          tone="info"
          icon={<GlobeIcon />}
          hint={canSeeWebsite ? money(onlineKpis.salesToday) : undefined}
          to={mayOpenOrders ? "/online/orders" : undefined}
          testId="kpi-web-orders"
        />
        <KpiTile
          label={t("dashboard.lowStock")}
          value={String(inventoryAlerts.lowCount)}
          tone="warning"
          icon={<WarehouseIcon />}
          hint={`${inventoryAlerts.outCount} ${t("dashboard.outOfStock").toLowerCase()}`}
          to={mayOpenInventory ? "/inventory/stock?status=low" : undefined}
          testId="kpi-low-stock"
        />
        <KpiTile
          label={t("dashboard.returnsToday")}
          value={String(snapshot.returns.todayCount)}
          tone="neutral"
          icon={<RotateCcwIcon />}
          hint={t("dashboard.todayRefunded", { amount: money(todayRefunded) })}
          to={mayOpenReturns ? "/returns" : undefined}
          testId="kpi-returns"
        />
        <KpiTile
          label={t("dashboard.openShift")}
          value={snapshot.openShift ? t("dashboard.shiftOpen") : t("dashboard.shiftClosed")}
          tone={snapshot.openShift ? "success" : "neutral"}
          icon={<ClockIcon />}
          hint={
            snapshot.shiftSummary
              ? `${money(snapshot.shiftSummary.cash_sales)} · ${snapshot.shiftSummary.sales_count}`
              : t("dashboard.noOpenShift")
          }
          to={mayOpenShifts ? "/shifts" : undefined}
          testId="kpi-open-shift"
        />
      </div>

      {/* ── Business KPIs ──────────────────────────────────────────────────── */}
      <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          label={t("dashboard.totalRevenue")}
          value={money(snapshot.sales.totalRevenue)}
          tone="success"
          icon={<ShoppingCartIcon />}
          hint={`${snapshot.sales.totalCount} ${t("dashboard.totalSales").toLowerCase()}`}
        />
        <StatTile
          label={t("dashboard.pendingSales")}
          value={money(snapshot.sales.pendingTotal)}
          tone="warning"
          hint={`${snapshot.sales.pendingCount} ${t("common.results")}`}
        />
        <KpiTile
          label={t("dashboard.customers")}
          value={String(snapshot.customerCount)}
          tone="info"
          icon={<UsersIcon />}
          to={mayOpenCustomers ? "/customers" : undefined}
          hint={mayOpenCustomers ? t("dashboard.customersHint") : undefined}
        />
        <StatTile
          label={t("dashboard.expensesToday")}
          value={money(snapshot.expenses.todayTotal)}
          tone="neutral"
          icon={<ClockIcon />}
          hint={`${snapshot.expenses.todayCount} ${t("common.results")}`}
        />
      </div>

      {/* ── Today's financial controls — aggregate-backed, never a full-history sum ── */}
      {maySeePerformance ? (
        <Card className="mt-5 p-4" testId="dash-today-financials">
          <div className="mb-3">
            <h2 className="text-base font-black text-stone-900">{t("dashboard.todayFinancials")}</h2>
            <p className="mt-0.5 text-xs font-medium text-stone-500">{t("dashboard.todayFinancialsHint")}</p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatTile
              label={t("dashboard.todayNetSales")}
              value={todayNetSales === null ? "—" : money(todayNetSales)}
              tone="primary"
              hint={t("dashboard.todayNetSalesHint", { refunded: money(todayRefunded) })}
            />
            <StatTile
              label={t("dashboard.todayDiscounts")}
              value={todayDiscounts === null ? "—" : money(todayDiscounts)}
              tone="success"
              hint={t("dashboard.todayDiscountsHint")}
            />
            <StatTile
              label={t("dashboard.todayRefunds")}
              value={money(todayRefunded)}
              tone={todayRefunded > 0 ? "warning" : "neutral"}
              hint={
                dbToday
                  ? t("dashboard.todayRefundsHint", { count: num(dbToday.refundsCount, 0) })
                  : t("dashboard.aggregateFallback")
              }
            />
            {maySeeCost ? (
              <StatTile
                label={t("dashboard.todayGrossProfit")}
                value={todayGrossProfit === null ? "—" : money(todayGrossProfit)}
                tone={todayGrossProfit !== null && todayGrossProfit < 0 ? "danger" : "success"}
                hint={
                  todayGrossProfit === null
                    ? t("dashboard.costQualityIncomplete")
                    : t("dashboard.costQualityComplete")
                }
              />
            ) : null}
          </div>
        </Card>
      ) : null}

      {/* ── The website (gated like the sidebar) ───────────────────────────── */}
      {canSeeWebsite ? (
        <Card className="mt-5 p-4" testId="web-section">
          <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
            <div>
              <h2 className="text-base font-black text-stone-900">{t("dashboard.webSection")}</h2>
              <p className="mt-0.5 text-xs font-medium text-stone-500">{t("dashboard.webSectionHint")}</p>
            </div>
            {mayOpenOrders ? (
              <Link to="/online/orders" className="text-xs font-bold text-stone-600 hover:text-stone-900">
                {t("dashboard.viewAll")} →
              </Link>
            ) : null}
          </div>

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" data-testid="web-kpi-row">
            <KpiTile
              label={t("dashboard.pendingReview")}
              value={String(onlineKpis.pendingReview)}
              tone={onlineKpis.pendingReview > 0 ? "warning" : "success"}
              to={mayOpenOrders ? "/online/orders?status=pending" : undefined}
              testId="web-kpi-pending"
            />
            <KpiTile
              label={t("dashboard.instapayAwaiting")}
              value={String(onlineKpis.instapayAwaiting)}
              tone={onlineKpis.instapayAwaiting > 0 ? "danger" : "success"}
              to={mayOpenOrders ? "/online/orders?payment=verification_required" : undefined}
              testId="web-kpi-instapay"
            />
            <KpiTile
              label={t("dashboard.webDelivery")}
              value={String(onlineKpis.deliveryActive)}
              tone="info"
              hint={money(onlineKpis.deliveryFees)}
              to={mayOpenOrders ? "/online/orders" : undefined}
              testId="web-kpi-delivery"
            />
            <KpiTile
              label={t("dashboard.webPickup")}
              value={String(onlineKpis.pickupActive)}
              tone="info"
              to={mayOpenOrders ? "/online/orders" : undefined}
              testId="web-kpi-pickup"
            />
            <KpiTile
              label={t("dashboard.webSalesToday")}
              value={money(onlineKpis.salesToday)}
              tone="primary"
              hint={`${onlineKpis.ordersToday} · ${t("dashboard.webAovShort")} ${money(onlineKpis.avgOrderToday)}`}
              testId="web-kpi-sales-today"
            />
            <KpiTile
              label={t("dashboard.webLast24h")}
              value={String(onlineKpis.last24h)}
              tone="neutral"
              testId="web-kpi-last24h"
            />
            <KpiTile
              label={t("dashboard.webCancelled")}
              value={String(onlineKpis.cancelled)}
              tone={onlineKpis.cancelled > 0 ? "warning" : "neutral"}
              to={mayOpenOrders ? "/online/orders?status=cancelled" : undefined}
              testId="web-kpi-cancelled"
            />
            <KpiTile
              label={t("dashboard.webVisibility")}
              value={`${websiteVisible.visible} / ${websiteVisible.hidden}`}
              tone="neutral"
              hint={t("dashboard.webVisibilityHint")}
              to={mayOpenProducts ? "/products" : undefined}
              testId="web-kpi-visibility"
            />
          </div>

          {/* COD vs InstaPay — the split as a paired bar, small and readable. */}
          <div className="mt-4 grid gap-3 lg:grid-cols-2">
            <Card className="p-3" testId="web-channel-split">
              <p className="text-[11px] font-bold uppercase tracking-wider text-stone-500">
                {t("dashboard.webCodSplit")}
              </p>
              <div className="mt-2 flex items-center gap-3">
                <div className="flex h-3 flex-1 overflow-hidden rounded-full bg-stone-100" role="img" aria-label={t("dashboard.webCodSplit")}>
                  <span
                    className="h-full bg-emerald-500"
                    style={{
                      width: `${
                        onlineKpis.codCount + onlineKpis.instapayCount > 0
                          ? (onlineKpis.codCount / (onlineKpis.codCount + onlineKpis.instapayCount)) * 100
                          : 0
                      }%`,
                    }}
                  />
                  <span className="h-full flex-1 bg-sky-500" />
                </div>
                <span className="shrink-0 text-xs font-bold tabular-nums text-stone-700">
                  COD {onlineKpis.codCount} · InstaPay {onlineKpis.instapayCount}
                </span>
              </div>
              <p className="mt-3 text-[11px] font-medium leading-relaxed text-stone-500">
                {t("dashboard.webCodSplitHint")}
              </p>
            </Card>

            <Card className="p-3" testId="web-top-products">
              <p className="text-[11px] font-bold uppercase tracking-wider text-stone-500">
                {t("dashboard.webTopProducts")}
              </p>
              {topOnline.length === 0 ? (
                <p className="py-6 text-center text-xs font-medium text-stone-400">{t("dashboard.noWebOrders")}</p>
              ) : (
                <ul className="mt-2 space-y-1.5">
                  {topOnline.map((row) => (
                    <li key={row.id} className="flex items-center justify-between gap-2 text-xs font-semibold text-stone-700">
                      <span className="truncate">{pick(row.nameAr, row.nameEn)}</span>
                      <span className="shrink-0 tabular-nums text-stone-500">
                        {row.units} × · {money(row.revenue)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              {topOnlineCategories.length > 0 ? (
                <p className="mt-3 truncate text-[11px] font-medium text-stone-500">
                  {t("dashboard.webTopCategories")}:{" "}
                  {topOnlineCategories.map((row) => row.categoryLabel).join(" · ")}
                </p>
              ) : null}
            </Card>
          </div>

          {/* Variant-aware online stock health */}
          <div className="mt-3 grid gap-3 sm:grid-cols-2" data-testid="web-stock-health">
            <KpiTile
              label={t("dashboard.webOutOfStock")}
              value={String(inventoryAlerts.outCount)}
              tone={inventoryAlerts.outCount > 0 ? "danger" : "success"}
              hint={t("dashboard.webStockHint")}
              to={mayOpenInventory ? "/inventory/stock?status=out" : undefined}
              testId="web-kpi-out-of-stock"
            />
            <KpiTile
              label={t("dashboard.webLowStock")}
              value={String(inventoryAlerts.lowCount)}
              tone={inventoryAlerts.lowCount > 0 ? "warning" : "success"}
              to={mayOpenInventory ? "/inventory/stock?status=low" : undefined}
              testId="web-kpi-low-stock"
            />
          </div>

          {/* Recent website orders */}
          <div className="mt-4" data-testid="dash-recent-web-orders">
            <p className="mb-1.5 text-[11px] font-bold uppercase tracking-wider text-stone-500">
              {t("dashboard.recentWebOrders")}
            </p>
            {recentWebOrders.length === 0 ? (
              <p className="py-4 text-center text-xs font-medium text-stone-400">{t("dashboard.noWebOrders")}</p>
            ) : (
              <div className="divide-y divide-stone-100 rounded-xl border border-stone-200/80 bg-white">
                {recentWebOrders.map((order) => (
                  <Link
                    key={order.id}
                    to={mayOpenOrders ? "/online/orders" : "#"}
                    className="flex items-center justify-between gap-3 px-3 py-2 hover:bg-stone-50"
                  >
                    <span className="min-w-0">
                      <span dir="ltr" className="block truncate font-mono text-xs font-bold text-stone-800">
                        {order.order_number}
                      </span>
                      <span className="block truncate text-[11px] font-medium text-stone-500">
                        {order.customer_name || "—"} ·{" "}
                        {order.delivery_type === "delivery" ? t("dashboard.webDelivery") : t("dashboard.webPickup")}
                      </span>
                    </span>
                    <span className="flex shrink-0 items-center gap-2">
                      <span className="text-xs font-bold tabular-nums text-stone-900">{money(order.total)}</span>
                      <Badge
                        tone={
                          order.status === "cancelled"
                            ? "danger"
                            : order.status === "completed"
                              ? "success"
                              : order.status === "pending"
                                ? "warning"
                                : "info"
                        }
                      >
                        {t(`online.status.${order.status}` as never)}
                      </Badge>
                    </span>
                  </Link>
                ))}
              </div>
            )}
          </div>

          <ReservationSummaryCard className="mt-3" />
        </Card>
      ) : null}

      {maySeePerformance ? (
        <>
          {/* ── Month to date + queues ───────────────────────────────────── */}
          <div className="mt-6 flex flex-wrap items-end justify-between gap-2">
            <div>
              <h2 className="text-base font-black text-stone-900">{t("dashboard.performance")}</h2>
              <p className="mt-0.5 text-xs font-medium text-stone-500">
                {t("dashboard.performanceHint", { days: DASHBOARD_TREND_DAYS })}
              </p>
            </div>
            <Link
              to="/reports/advanced"
              className="text-xs font-bold text-stone-600 hover:text-stone-900"
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
            {maySeeCost ? (
              <StatTile
                label={t("dashboard.monthProfit")}
                value={money(monthly.profit)}
                tone={monthly.profit >= 0 ? "success" : "danger"}
                icon={<LayersIcon />}
                hint={t("dashboard.monthMargin", { margin: percent(monthly.margin) })}
              />
            ) : null}
            <StatTile
              label={t("dashboard.monthExpenses")}
              value={money(monthExpenses)}
              tone="warning"
              icon={<ReceiptIcon />}
              hint={t("dashboard.monthRefunds", { amount: money(monthly.refunds) })}
            />
            <KpiTile
              label={t("dashboard.pendingApprovals")}
              value={String(approvals?.summary.pending ?? 0)}
              tone={(approvals?.summary.pending ?? 0) > 0 ? "warning" : "success"}
              icon={<ClipboardIcon />}
              hint={t("approvals.pendingHint")}
              to="/approvals"
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

          {/* ── Charts ─────────────────────────────────────────────────────── */}
          <div className="mt-3 grid gap-3 lg:grid-cols-2">
            <Card>
              <ChartCard
                title={t("dashboard.salesTrend")}
                hint={t("dashboard.salesTrendHint", { count: DASHBOARD_TREND_DAYS })}
                empty={hasChartData ? undefined : t("dashboard.noChartData")}
                legend={
                  hasChartData ? (
                    <span className="text-[11px] font-semibold tabular-nums text-stone-500">
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
                <h2 className="text-base font-black text-stone-900">{t("dashboard.topProducts")}</h2>
                <p className="mt-0.5 text-xs font-medium text-stone-500">
                  {t("dashboard.topProductsHint", { count: DASHBOARD_TREND_DAYS })}
                </p>
              </div>
              <Link
                to="/reports/advanced"
                className="text-xs font-bold text-stone-600 hover:text-stone-900"
              >
                {t("nav.advancedReports")} →
              </Link>
            </div>
            {bestSellersList.length === 0 ? (
              <p className="py-6 text-center text-sm text-stone-500">{t("dashboard.noChartData")}</p>
            ) : (
              <div className="divide-y divide-stone-100">
                {bestSellersList.map((row, index) => (
                  <div key={row.id} className="flex items-center justify-between gap-3 py-2.5">
                    <div className="flex min-w-0 items-center gap-3">
                      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-stone-900 text-[11px] font-bold text-[#e8ddc9]">
                        {index + 1}
                      </span>
                      <div className="min-w-0">
                        <p className="truncate text-sm font-bold text-stone-900">
                          {pick(row.nameAr, row.nameEn)}
                        </p>
                        <p className="text-[11px] text-stone-500">
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

      {/* ── Stock alerts — variant-aware, name the exact combination ──────── */}
      {mayOpenInventory && inventoryAlerts.low.length + inventoryAlerts.out.length > 0 ? (
        <Card className="mt-4" testId="dash-stock-alerts">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-base font-black text-stone-900">{t("dashboard.alertsTitle")}</h2>
            <Link to="/inventory/stock?status=low" className="text-xs font-bold text-stone-600 hover:text-stone-900">
              {t("nav.inventory")} →
            </Link>
          </div>
          <div className="divide-y divide-stone-100">
            {[...inventoryAlerts.out, ...inventoryAlerts.low].slice(0, 8).map((alert) => (
              <div
                key={`${alert.productId}-${alert.variantId ?? "product"}`}
                className="flex items-center justify-between gap-3 py-2"
                data-testid="dash-stock-alert"
              >
                <p className="min-w-0 truncate text-xs font-bold text-stone-800">
                  {inventoryAlertLine(alert, pick, lowWord, outWord)}
                </p>
                <Badge tone={alert.kind === "out" ? "danger" : "warning"}>
                  {alert.kind === "out" ? outWord : lowWord}
                </Badge>
              </div>
            ))}
          </div>
        </Card>
      ) : null}

      {/* ── Open shift summary ────────────────────────────────────────────── */}
      {snapshot.openShift && snapshot.shiftSummary ? (
        <Card className="mt-4" testId="dash-open-shift">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-base font-black text-stone-900">{t("dashboard.openShift")}</h2>
              <p className="mt-0.5 text-xs font-medium text-stone-500">
                {snapshot.openShift.branch || "—"} · {snapshot.openShift.opened_by_name}
              </p>
            </div>
            <div className="flex flex-wrap gap-4 text-end">
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-wide text-stone-500">
                  {t("dashboard.cashSales")}
                </p>
                <p className="text-sm font-bold text-stone-900">
                  {money(snapshot.shiftSummary.cash_sales)}
                </p>
              </div>
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-wide text-stone-500">
                  {t("dashboard.expectedCash")}
                </p>
                <p className="text-sm font-bold text-stone-900">
                  {money(snapshot.shiftSummary.expected_cash)}
                </p>
              </div>
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-wide text-stone-500">
                  {t("dashboard.todaySales")}
                </p>
                <p className="text-sm font-bold text-stone-900">
                  {snapshot.shiftSummary.sales_count}
                </p>
              </div>
              {mayOpenShifts ? (
                <Link to="/shifts" className="self-center">
                  <Button variant="secondary" size="sm">{t("dashboard.viewAll")}</Button>
                </Link>
              ) : null}
            </div>
          </div>
        </Card>
      ) : (
        <Card className="mt-4" testId="dash-no-open-shift">
          <p className="text-sm font-medium text-stone-500">{t("dashboard.noOpenShift")}</p>
        </Card>
      )}

      {/* ── Recent sales ──────────────────────────────────────────────────── */}
      <Card className="mt-4" testId="dash-recent-orders">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-base font-black text-stone-900">{t("dashboard.recentSales")}</h2>
          {mayOpenSales ? (
            <Link
              to="/pos/sales?today=1"
              className="text-xs font-bold text-stone-600 hover:text-stone-900"
            >
              {t("nav.sales")} →
            </Link>
          ) : null}
        </div>

        {snapshot.recentSales.length === 0 ? (
          <p className="py-6 text-center text-sm text-stone-500">{t("dashboard.noSalesYet")}</p>
        ) : (
          <div className="divide-y divide-stone-100">
            {snapshot.recentSales.map((sale) => (
              <Link
                key={sale.id}
                to={`/pos/sales/${sale.id}`}
                className="flex items-center justify-between gap-3 rounded-lg px-2 py-2.5 transition-colors hover:bg-stone-50"
              >
                <div className="flex min-w-0 items-center gap-3">
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-stone-100 text-stone-700">
                    <ReceiptIcon />
                  </span>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-bold text-stone-900">
                      {sale.sale_number}
                    </p>
                    <p className="text-[11px] text-stone-500">
                      {sale.user_name} · {sale.items_count} {t("dashboard.items")}
                    </p>
                  </div>
                </div>
                <div className="shrink-0 text-end">
                  <p className="text-sm font-bold text-stone-900">{money(sale.total)}</p>
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

// ── helpers ─────────────────────────────────────────────────────────────────

// Local capability checks — kept in one place so the KPI row reads cleanly.
function canActRoute(path: string): boolean {
  return pathAdmits(path, (capability) => canAct(capability));
}
function canActWebsite(): boolean {
  return canAct("manage_website");
}
