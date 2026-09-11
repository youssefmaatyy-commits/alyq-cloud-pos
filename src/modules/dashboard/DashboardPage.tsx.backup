import { Link } from "react-router-dom";
import { useMemo } from "react";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { PageHeader } from "@/components/layout/AppShell";
import {
  Badge,
  BoxIcon,
  Card,
  ClockIcon,
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
import { useCatalog } from "@/modules/products/hooks/CatalogProvider";
import { usePos } from "@/modules/pos/hooks/PosProvider";
import { useInventory } from "@/modules/inventory/hooks/InventoryProvider";
import { useCustomers } from "@/modules/customers/hooks/CustomerProvider";
import { useReturns } from "@/modules/returns/hooks/ReturnProvider";
import { useExpenses } from "@/modules/expenses/hooks/ExpenseProvider";
import { useShifts } from "@/modules/shifts/hooks/ShiftProvider";
import { buildDashboardSnapshot } from "./dashboardQuery";

/**
 * Operations dashboard — read-only view over live module data.
 *
 * All numbers come from existing providers (sales, inventory, customers,
 * returns, expenses, shifts). No mock data, no new API calls. The page is
 * purely additive: the catalog tiles from Phase 1 remain, with sales,
 * inventory health, returns, expenses and shift status layered on top.
 */
export function DashboardPage() {
  const { t, money } = useI18n();
  const { mode } = useCatalog();
  const { sales, salesLoading } = usePos();
  const { products, loading: inventoryLoading } = useInventory();
  const { customers, loading: customersLoading } = useCustomers();
  const { returnsList, refundsList, loading: returnsLoading } = useReturns();
  const { expenses } = useExpenses();
  const { openShift, currentSummary } = useShifts();

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
            <div className="flex flex-wrap gap-4 text-right">
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
                <div className="text-right shrink-0">
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
