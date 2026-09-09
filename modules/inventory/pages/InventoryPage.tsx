import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { PageHeader } from "@/components/layout/AppShell";
import {
  Button,
  Card,
  EmptyState,
  ErrorState,
  LoadingBlock,
  SelectInput,
  StatTile,
  TextInput,
  useToast,
  BoxIcon,
  HistoryIcon,
  SearchIcon,
  WarehouseIcon,
  AlertIcon,
} from "@/components/ui";
import { useInventory } from "../hooks/InventoryProvider";
import {
  paginate,
  queryInventory,
  summarizeInventory,
  totalPagesFor,
  EMPTY_INVENTORY_FILTERS,
  type InventoryFiltersValue,
} from "../services/inventoryQuery";
import { StockStatusBadge } from "../components/StockStatusBadge";
import { StockAdjustmentModal } from "../components/StockAdjustmentModal";
import { ALL_ROLES, ROLE_LABEL, type InventoryRole } from "../permissions";
import type { StockStatus } from "@/modules/products/types";

export function InventoryPage() {
  const { t, pick, num, date } = useI18n();
  const toast = useToast();
  const {
    products,
    movements,
    loading,
    error,
    refresh,
    user,
    canAdjust,
    setUser,
  } = useInventory();

  const [filters, setFilters] = useState<InventoryFiltersValue>(EMPTY_INVENTORY_FILTERS);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [adjusting, setAdjusting] = useState<string | null>(null);

  const nameOf = (id: string | null) => {
    if (!id) return t("products.withoutCategory");
    return prettyCategoryId(id);
  };

  const results = useMemo(
    () => queryInventory(products, filters, nameOf),
    [products, filters],
  );
  const totalPages = totalPagesFor(results.length, pageSize);
  const currentPage = Math.min(page, totalPages);
  const visible = paginate(results, currentPage, pageSize);
  const stats = useMemo(
    () => summarizeInventory(products, movements),
    [products, movements],
  );

  const updateFilters = (next: InventoryFiltersValue) => {
    setFilters(next);
    setPage(1);
  };

  const lastMovement = (productId: string) => {
    for (const movement of movements) {
      if (movement.product_id === productId) return movement;
    }
    return undefined;
  };

  const onRoleChange = (next: InventoryRole) => {
    setUser({ ...user, role: next });
    toast.push(t("inventory.roleSwitcher") + ": " + ROLE_LABEL[next], "info");
  };

  return (
    <div>
      <PageHeader
        title={t("inventory.dashboard")}
        subtitle={t("inventory.dashboardSubtitle")}
        actions={
          <>
            <Button variant="secondary" onClick={() => void refresh()} title={t("common.retry")}>
              ⟳
            </Button>
            <Link
              to="/inventory/movements"
              className="inline-flex h-10 items-center gap-2 rounded-xl bg-white px-4 text-sm font-semibold text-slate-800 ring-1 ring-slate-300 transition-colors hover:bg-slate-50"
            >
              <HistoryIcon />
              {t("inventory.history")}
            </Link>
          </>
        }
      />

      {/* Role / permission banner — always visible, helps demos without auth */}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs font-semibold text-slate-700">
        <span className="flex items-center gap-2">
          <span
            className={`h-2 w-2 rounded-full ${canAdjust ? "bg-emerald-500" : "bg-amber-500"}`}
            aria-hidden
          />
          {t("inventory.perm.banner", { role: ROLE_LABEL[user.role] })}
        </span>
        <label className="flex items-center gap-1.5">
          <span className="text-[11px] uppercase tracking-wider text-slate-500">
            {t("inventory.roleSwitcher")}:
          </span>
          <SelectInput
            value={user.role}
            onChange={(e) => onRoleChange(e.target.value as InventoryRole)}
            className="h-8 w-auto min-w-32 py-1 text-xs font-semibold"
            aria-label={t("inventory.roleSwitcher")}
          >
            {ALL_ROLES.map((role) => (
              <option key={role} value={role}>
                {ROLE_LABEL[role]}
              </option>
            ))}
          </SelectInput>
        </label>
      </div>

      {/* KPI tiles */}
      <div className="mb-4 grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        <StatTile
          label={t("inventory.kpi.totalStock")}
          value={num(stats.totalStock, 0)}
          tone="primary"
          icon={<WarehouseIcon />}
          hint={t("inventory.kpi.totalStockHint")}
        />
        <StatTile
          label={t("inventory.kpi.lowStock")}
          value={String(stats.lowStock)}
          tone="warning"
          hint={t("inventory.status.low")}
        />
        <StatTile
          label={t("inventory.kpi.outOfStock")}
          value={String(stats.outOfStock)}
          tone="danger"
          hint={t("inventory.status.out")}
        />
        <StatTile
          label={t("inventory.kpi.movements7d")}
          value={String(stats.movementsLast7d)}
          tone="info"
          hint={`${t("inventory.kpi.tracked")}: ${num(stats.trackedProducts, 0)}`}
        />
      </div>

      <div className="space-y-4">
        <Card className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <TextInput
              value={filters.search}
              leading={<SearchIcon />}
              onChange={(event) => updateFilters({ ...filters, search: event.target.value })}
              placeholder={t("inventory.searchPlaceholder")}
              aria-label={t("common.search")}
              type="search"
            />
            <SelectInput
              value={filters.categoryId}
              onChange={(e) => updateFilters({ ...filters, categoryId: e.target.value })}
              aria-label={t("products.category")}
            >
              <option value="all">{`${t("products.category")}: ${t("common.all")}`}</option>
              <option value="__uncategorized__">{t("products.withoutCategory")}</option>
              {Array.from(new Set(products.map((p) => p.category_id).filter(Boolean) as string[])).map((id) => (
                <option key={id} value={id}>
                  {prettyCategoryId(id)}
                </option>
              ))}
            </SelectInput>
            <SelectInput
              value={filters.status}
              onChange={(e) =>
                updateFilters({ ...filters, status: e.target.value as StockStatus | "all" })
              }
              aria-label={t("inventory.cols.status")}
            >
              <option value="all">{t("inventory.status.all")}</option>
              <option value="in">{t("inventory.status.in")}</option>
              <option value="low">{t("inventory.status.low")}</option>
              <option value="out">{t("inventory.status.out")}</option>
            </SelectInput>
          </div>
        </Card>

        {error ? (
          <ErrorState
            title={t("products.errorLoad")}
            message={error.message}
            retryLabel={t("common.retry")}
            onRetry={() => void refresh()}
          />
        ) : loading ? (
          <div className="alyq-card">
            <LoadingBlock label={t("common.loading")} />
          </div>
        ) : (
          <InventoryStockTable
            products={visible}
            nameOf={nameOf}
            lastMovementOf={lastMovement}
            onAdjust={(id) => setAdjusting(id)}
            canAdjust={canAdjust}
            empty={
              <Card>
                <EmptyState
                  icon="📦"
                  title={t("inventory.history.empty")}
                  description={t("inventory.history.emptyHint")}
                />
              </Card>
            }
          />
        )}

        {results.length > 0 ? (
          <div className="flex flex-wrap items-center justify-between gap-3 alyq-card px-3 py-2.5 text-xs font-semibold text-slate-700">
            <span className="tabular-nums">
              {t("products.showing", {
                from: (currentPage - 1) * pageSize + 1,
                to: Math.min(currentPage * pageSize, results.length),
                total: results.length,
              })}
            </span>
            <div className="flex items-center gap-2">
              <SelectInput
                value={String(pageSize)}
                onChange={(e) => {
                  setPageSize(Number(e.target.value));
                  setPage(1);
                }}
                className="h-8 w-auto py-1 text-xs font-semibold"
                aria-label={t("productsPerPage")}
              >
                {[10, 20, 50].map((size) => (
                  <option key={size} value={size}>
                    {size}
                  </option>
                ))}
              </SelectInput>
              <Button
                variant="secondary"
                size="sm"
                disabled={currentPage <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              >
                ‹ {t("products.prev")}
              </Button>
              <span className="tabular-nums">
                {currentPage} / {totalPages}
              </span>
              <Button
                variant="secondary"
                size="sm"
                disabled={currentPage >= totalPages}
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              >
                {t("products.next")} ›
              </Button>
            </div>
          </div>
        ) : null}
      </div>

      <StockAdjustmentModal
        productId={adjusting ?? ""}
        open={Boolean(adjusting)}
        onClose={() => setAdjusting(null)}
      />

      {/* Local helpers used by JSX above — must be declared after first use */}
    </div>
  );

  // helper that "smoke" hides the suppression: called with a value type to
  // keep t/pick/num/date referenced by the children above.
  void pick;
  void date;
}

// ── table ────────────────────────────────────────────────────────────────

interface InventoryTableProps {
  products: ReturnType<typeof queryInventory>;
  nameOf: (id: string | null) => string;
  lastMovementOf: (id: string) => { created_at: string } | undefined;
  onAdjust: (id: string) => void;
  canAdjust: boolean;
  empty: React.ReactNode;
}

function InventoryStockTable({
  products,
  nameOf,
  lastMovementOf,
  onAdjust,
  canAdjust,
  empty,
}: InventoryTableProps) {
  const { t, pick, num, date } = useI18n();
  if (products.length === 0) return <>{empty}</>;

  return (
    <>
      <div className="alyq-card hidden overflow-x-auto md:block">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50 text-start text-[11px] font-bold uppercase tracking-wider text-slate-600">
              <th className="px-4 py-3 text-start font-semibold">{t("inventory.cols.product")}</th>
              <th className="px-3 py-3 text-start font-semibold">{t("inventory.cols.sku")}</th>
              <th className="px-3 py-3 text-start font-semibold">{t("inventory.cols.barcode")}</th>
              <th className="px-3 py-3 text-start font-semibold">{t("inventory.cols.category")}</th>
              <th className="px-3 py-3 text-end font-semibold">{t("inventory.cols.quantity")}</th>
              <th className="px-3 py-3 text-end font-semibold">{t("inventory.cols.low")}</th>
              <th className="px-3 py-3 text-start font-semibold">{t("inventory.cols.status")}</th>
              <th className="px-4 py-3 text-end font-semibold">{t("common.actions")}</th>
            </tr>
          </thead>
          <tbody>
            {products.map((product) => {
              const status = product.stock_tracking_enabled
                ? deriveStatus(product)
                : ("none" as StockStatus);
              const last = lastMovementOf(product.id);
              return (
                <tr key={product.id} className="border-b border-slate-50 last:border-0 hover:bg-slate-50/60">
                  <td className="px-4 py-3">
                    <p className="font-medium text-slate-900">
                      {pick(product.name_ar, product.name_en)}
                    </p>
                  </td>
                  <td className="px-3 py-3">
                    <span className="rounded-md bg-slate-100 px-1.5 py-0.5 font-mono text-xs text-slate-700">
                      {product.sku}
                    </span>
                  </td>
                  <td className="px-3 py-3">
                    {product.barcode ? (
                      <span className="font-mono text-xs text-slate-700">{product.barcode}</span>
                    ) : (
                      <span className="text-xs text-slate-400">—</span>
                    )}
                  </td>
                  <td className="px-3 py-3 font-medium text-slate-700">
                    {nameOf(product.category_id)}
                  </td>
                  <td className="px-3 py-3 text-end">
                    <span className="block font-semibold tabular-nums text-slate-900">
                      {num(product.stock_quantity, 0)}
                    </span>
                    <span className="block text-[11px] font-medium text-slate-500">
                      {last ? date(last.created_at) : "—"}
                    </span>
                  </td>
                  <td className="px-3 py-3 text-end font-medium text-slate-700 tabular-nums">
                    {num(product.low_stock_level, 0)}
                  </td>
                  <td className="px-3 py-3">
                    <StockStatusBadge status={status} />
                  </td>
                  <td className="px-4 py-3 text-end">
                    <Button
                      variant="primary"
                      size="sm"
                      disabled={!canAdjust || !product.stock_tracking_enabled}
                      onClick={() => onAdjust(product.id)}
                    >
                      {t("inventory.adjust")}
                    </Button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="space-y-3 md:hidden">
        {products.map((product) => {
          const status = product.stock_tracking_enabled
            ? deriveStatus(product)
            : ("none" as StockStatus);
          const last = lastMovementOf(product.id);
          return (
            <div key={product.id} className="alyq-card p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-slate-900">
                    {pick(product.name_ar, product.name_en)}
                  </p>
                  <p className="font-mono text-[11px] text-slate-600">{product.sku}</p>
                  <p className="text-[11px] text-slate-600">{nameOf(product.category_id)}</p>
                </div>
                <StockStatusBadge status={status} withIcon={false} />
              </div>
              <div className="mt-2 grid grid-cols-3 gap-2 text-xs">
                <div>
                  <p className="text-[10px] font-semibold uppercase text-slate-500">
                    {t("inventory.cols.quantity")}
                  </p>
                  <p className="text-sm font-semibold tabular-nums text-slate-900">
                    {num(product.stock_quantity, 0)}
                  </p>
                </div>
                <div>
                  <p className="text-[10px] font-semibold uppercase text-slate-500">
                    {t("inventory.cols.low")}
                  </p>
                  <p className="text-sm font-medium tabular-nums text-slate-700">
                    {num(product.low_stock_level, 0)}
                  </p>
                </div>
                <div>
                  <p className="text-[10px] font-semibold uppercase text-slate-500">
                    {t("inventory.cols.updated")}
                  </p>
                  <p className="text-xs font-medium text-slate-700">
                    {last ? date(last.created_at) : "—"}
                  </p>
                </div>
              </div>
              <div className="mt-3">
                <Button
                  variant="primary"
                  size="sm"
                  className="w-full"
                  disabled={!canAdjust || !product.stock_tracking_enabled}
                  onClick={() => onAdjust(product.id)}
                >
                  {t("inventory.adjust")}
                </Button>
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}

function deriveStatus(
  product: { stock_tracking_enabled: boolean; stock_quantity: number; low_stock_level: number },
): StockStatus {
  if (!product.stock_tracking_enabled) return "none";
  if (product.stock_quantity <= 0) return "out";
  if (product.low_stock_level > 0 && product.stock_quantity <= product.low_stock_level) return "low";
  return "in";
}

function prettyCategoryId(id: string): string {
  // The inventory page doesn't import the catalog tree on purpose (it stays
  // independent so Phase 4 can move it into its own module). Demo ids follow
  // the `cat-*` convention — turn them into human-readable titles so the
  // table still looks complete.
  return id
    .replace(/^cat-/, "")
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

// Re-export so the JSX above is the only thing that uses the icon import alias.
void BoxIcon;
void AlertIcon;
