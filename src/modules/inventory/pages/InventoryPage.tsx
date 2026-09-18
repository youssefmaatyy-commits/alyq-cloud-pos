import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { PageHeader } from "@/components/layout/AppShell";
import { canAct } from "@/lib/permissions/enforce";
import {
  Button,
  Card,
  EmptyState,
  ErrorState,
  ExportButton,
  LoadingBlock,
  SelectInput,
  StatTile,
  TextInput,
  BoxIcon,
  HistoryIcon,
  SearchIcon,
  WarehouseIcon,
  AlertIcon,
} from "@/components/ui";
import { buildInventorySheets } from "../services/inventoryExport";
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
import { ROLE_LABEL } from "../permissions";
import type { StockStatus } from "@/modules/products/types";
import type { ProductVariant } from "@/modules/products/variants";
import { sizeLabelOf } from "@/modules/products/variants";

export function InventoryPage() {
  const { t, pick, num, date } = useI18n();
  const {
    products,
    movements,
    variantsByProduct,
    loading,
    error,
    refresh,
    user,
    canAdjust,
  } = useInventory();

  const [filters, setFilters] = useState<InventoryFiltersValue>(EMPTY_INVENTORY_FILTERS);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [adjusting, setAdjusting] = useState<string | null>(null);

  // Phase 46: the dashboard's Low/Out tiles land here pre-filtered
  // (`?status=low` / `?status=out`). Hydrated once; unknown values ignored.
  const [params, setParams] = useSearchParams();
  const hydrated = useRef(false);
  useEffect(() => {
    if (hydrated.current) return;
    hydrated.current = true;
    const status = params.get("status");
    if (status === "low" || status === "out" || status === "in") {
      setFilters((current) => ({ ...current, status }));
      setPage(1);
      setParams({}, { replace: true });
    }
  }, []); // once, on mount


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
  // Phase 46: the combination shelf counted directly — a variant product with
  // healthy-looking rollup can still hide a sold-out size, so the tiles below
  // also say how many COMBINATIONS are low or gone.
  const comboStats = useMemo(() => {
    let low = 0;
    let out = 0;
    let total = 0;
    for (const product of products) {
      if (!product.stock_tracking_enabled) continue;
      const variants = (variantsByProduct.get(product.id) ?? []).filter((v) => v.active);
      if (variants.length === 0) continue;
      total += variants.length;
      for (const variant of variants) {
        if (variant.stock_quantity <= 0) out += 1;
        else if (variant.low_stock_level > 0 && variant.stock_quantity <= variant.low_stock_level) low += 1;
      }
    }
    return { low, out, total };
  }, [products, variantsByProduct]);

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
            {/* Held units are the website's reservations — the place they get
                read and, when they disagree with their order, settled. */}
            {canAct("manage_online_orders") ? (
              <Link to="/online/reservations">
                <Button variant="secondary">{t("nav.stockHolds")}</Button>
              </Link>
            ) : null}
            {/* Exports `results` — the filtered rows on screen. Category names
                come from this page's own resolver, which deliberately does not
                import the catalog tree. */}
            <ExportButton
              name="inventory"
              count={results.length}
              build={() =>
                buildInventorySheets({ products: results, categoryName: nameOf, t, pick })
              }
            />
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

      {/* Signed-in identity + what this seat may do (Authentication phase:
          replaces the Phase 3 role switcher — the acting role now comes from
          the session and can only change by signing in as someone else).

          The sentence follows `canAdjust`: the read-only wording used to be
          rendered unconditionally, which is why a fully privileged Admin read
          "Viewing as Admin — changes are not permitted" on this screen while
          the dot beside it said the opposite. The dot and the sentence now
          agree — both track the same resolved capability. */}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs font-semibold text-slate-700">
        <span className="flex items-center gap-2">
          <span
            className={`h-2 w-2 rounded-full ${canAdjust ? "bg-emerald-500" : "bg-amber-500"}`}
            aria-hidden
          />
          {t(canAdjust ? "inventory.perm.bannerAllowed" : "inventory.perm.banner", {
            role: ROLE_LABEL[user.role] ?? user.role,
          })}
        </span>
        <span className="text-[11px] text-slate-500">
          {t("auth.signedInAs")}: <span className="font-bold text-slate-700">{user.name}</span>
        </span>
      </div>

      {/* KPI tiles */}
      <div className="mb-4 grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        <StatTile
          label={t("inventory.kpi.totalStock")}
          value={num(stats.totalStock, 0)}
          tone="primary"
          icon={<WarehouseIcon />}
          hint={
            comboStats.total > 0
              ? `${t("inventory.kpi.totalStockHint")} · ${t("inventory.kpi.variantSkus", { count: comboStats.total })}`
              : t("inventory.kpi.totalStockHint")
          }
        />
        <StatTile
          label={t("inventory.kpi.lowStock")}
          value={String(stats.lowStock)}
          tone="warning"
          hint={
            comboStats.low > 0
              ? `${t("inventory.status.low")} · ${t("inventory.kpi.combosLow", { count: comboStats.low })}`
              : t("inventory.status.low")
          }
        />
        <StatTile
          label={t("inventory.kpi.outOfStock")}
          value={String(stats.outOfStock)}
          tone="danger"
          hint={
            comboStats.out > 0
              ? `${t("inventory.status.out")} · ${t("inventory.kpi.combosOut", { count: comboStats.out })}`
              : t("inventory.status.out")
          }
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
            variantsByProduct={variantsByProduct}
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
  /** Phase 43: the combinations behind a variant product's rollup. */
  variantsByProduct: Map<string, ProductVariant[]>;
  empty: React.ReactNode;
}

function InventoryStockTable({
  products,
  nameOf,
  lastMovementOf,
  onAdjust,
  canAdjust,
  variantsByProduct,
  empty,
}: InventoryTableProps) {
  const { t, pick, num, date } = useI18n();
  // One breakdown open at a time: the screen is a count, not a maze.
  const [expandedId, setExpandedId] = useState<string | null>(null);
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
              const variants = variantsByProduct.get(product.id) ?? [];
              const expanded = expandedId === product.id;
              return (
                <Fragment key={product.id}>
                <tr className="border-b border-slate-50 last:border-0 hover:bg-slate-50/60">
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
                    {variants.length > 0 ? (
                      <button
                        type="button"
                        data-testid={`variant-breakdown-toggle-${product.sku}`}
                        aria-expanded={expanded}
                        onClick={() => setExpandedId(expanded ? null : product.id)}
                        className="mt-0.5 text-[10px] font-bold text-indigo-600 hover:underline"
                      >
                        {expanded
                          ? t("inventory.variants.hide")
                          : t("inventory.variants.show", { count: variants.length })}
                      </button>
                    ) : null}
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
                {/* The breakdown: one row per combination, its OWN shelf. The
                    product line above is the sum; this is where a missing size
                    is actually found. */}
                {expanded && variants.length > 0 ? (
                  <tr className="border-b border-slate-100 bg-indigo-50/40">
                    <td colSpan={8} className="px-4 py-2">
                      <ul className="grid gap-1 sm:grid-cols-2 lg:grid-cols-3" data-testid={`variant-breakdown-${product.sku}`}>
                        {variants.map((variant) => (
                          <li
                            key={variant.id}
                            className="flex items-center justify-between gap-2 rounded-lg bg-white px-2.5 py-1.5 text-[11px] shadow-sm"
                          >
                            <span className="min-w-0 truncate font-semibold text-slate-800">
                              {pick(variant.color_ar, variant.color_en) || t("store.variants.defaultColor")}
                              {" / "}
                              <span className="tabular-nums">
                                {sizeLabelOf(variant.size, variant.size_label)}
                              </span>
                              {!variant.active ? (
                                <span className="ms-1 text-slate-400">· {t("products.variants.statusArchived")}</span>
                              ) : null}
                            </span>
                            <span
                              className={`shrink-0 font-bold tabular-nums ${
                                !variant.active
                                  ? "text-slate-400"
                                  : variant.stock_quantity <= 0
                                    ? "text-rose-600"
                                    : variant.low_stock_level > 0 && variant.stock_quantity <= variant.low_stock_level
                                      ? "text-amber-600"
                                      : "text-emerald-700"
                              }`}
                            >
                              {num(variant.stock_quantity, 0)}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </td>
                  </tr>
                ) : null}
                </Fragment>
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
