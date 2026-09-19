import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { PageHeader } from "@/components/layout/AppShell";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  LoadingBlock,
  SelectInput,
  TextInput,
  SearchIcon,
  HistoryIcon,
  MinusCircleIcon,
  PlusCircleIcon,
  WarehouseIcon,
} from "@/components/ui";
import { useInventory } from "../hooks/InventoryProvider";
import { paginate, totalPagesFor } from "../services/inventoryQuery";
import { normalizeText } from "@/modules/products/services/productQuery";
import {
  STOCK_MOVEMENT_TYPES,
  STOCK_REASONS,
  directionLabel,
  isOutbound,
  type StockMovement,
  type StockMovementType,
  type StockReason,
} from "../types";
import { StockStatusBadge } from "../components/StockStatusBadge";
import { ROLE_LABEL } from "../permissions";

export function MovementsPage() {
  const { t, pick } = useI18n();
  const { movements, products, loading, error, refresh, user, canAdjust } = useInventory();

  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState<StockMovementType | "all">("all");
  const [reasonFilter, setReasonFilter] = useState<StockReason | "all">("all");
  const [direction, setDirection] = useState<"all" | "in" | "out">("all");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);

  const productIndex = useMemo(
    () => new Map(products.map((p) => [p.id, p])),
    [products],
  );

  const filtered = useMemo(() => {
    const needle = normalizeText(search);
    const terms = needle ? needle.split(" ") : [];
    return movements.filter((m) => {
      if (typeFilter !== "all" && m.type !== typeFilter) return false;
      if (reasonFilter !== "all" && m.reason !== reasonFilter) return false;
      if (direction !== "all" && directionLabel(m.type) !== direction) return false;
      if (terms.length > 0) {
        const product = productIndex.get(m.product_id);
        const haystack = normalizeText(
          [m.notes ?? "", m.user_name, m.reason, m.type, product ? product.sku : "", product ? product.name_en : "", product ? product.name_ar : ""].join(" \u0001 "),
        );
        for (const term of terms) {
          if (!haystack.includes(term)) return false;
        }
      }
      return true;
    });
  }, [movements, typeFilter, reasonFilter, direction, search, productIndex]);

  const totalPages = totalPagesFor(filtered.length, pageSize);
  const currentPage = Math.min(page, totalPages);
  const visible = paginate(filtered, currentPage, pageSize);

  const productNameOf = (id: string) => {
    const product = productIndex.get(id);
    return product ? pick(product.name_ar, product.name_en) : "—";
  };

  return (
    <div>
      <PageHeader
        crumbs={[{ label: t("home.management.title"), to: "/management" }, { label: t("nav.movements") }]}
        title={t("inventory.history")}
        subtitle={t("inventory.history.subtitle")}
        actions={
          <>
            <Button variant="secondary" onClick={() => void refresh()} title={t("common.retry")}>
              ⟳
            </Button>
            <Link
              to="/inventory/stock"
              className="inline-flex h-10 items-center gap-2 rounded-xl bg-white px-4 text-sm font-semibold text-slate-800 ring-1 ring-slate-300 transition-colors hover:bg-slate-50"
            >
              <WarehouseIcon />
              {t("inventory.dashboard")}
            </Link>
          </>
        }
      />

      {!canAdjust ? (
        <div className="mb-4 rounded-2xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-900">
          {t("inventory.perm.banner", { role: ROLE_LABEL[user.role] })}
        </div>
      ) : null}

      <Card className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <TextInput
          value={search}
          leading={<SearchIcon />}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(1);
          }}
          placeholder={t("inventory.history.viewProduct")}
          aria-label={t("common.search")}
          type="search"
        />
        <SelectInput
          value={typeFilter}
          onChange={(e) => {
            setTypeFilter(e.target.value as StockMovementType | "all");
            setPage(1);
          }}
          aria-label={t("inventory.cols.type")}
        >
          <option value="all">{`${t("inventory.cols.type")}: ${t("common.all")}`}</option>
          {STOCK_MOVEMENT_TYPES.map((type) => (
            <option key={type} value={type}>
              {t(`inventory.type.${type}` as never)}
            </option>
          ))}
        </SelectInput>
        <SelectInput
          value={reasonFilter}
          onChange={(e) => {
            setReasonFilter(e.target.value as StockReason | "all");
            setPage(1);
          }}
          aria-label={t("inventory.cols.reason")}
        >
          <option value="all">{`${t("inventory.cols.reason")}: ${t("common.all")}`}</option>
          {STOCK_REASONS.map((reason) => (
            <option key={reason} value={reason}>
              {t(`inventory.reason.${reason}` as never)}
            </option>
          ))}
        </SelectInput>
        <SelectInput
          value={direction}
          onChange={(e) => {
            setDirection(e.target.value as "all" | "in" | "out");
            setPage(1);
          }}
          aria-label={t("common.stock")}
        >
          <option value="all">{`${t("common.stock")}: ${t("common.all")}`}</option>
          <option value="in">{t("inventory.status.in")}</option>
          <option value="out">{t("inventory.status.out")}</option>
        </SelectInput>
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
      ) : filtered.length === 0 ? (
        <Card>
          <EmptyState
            icon={<HistoryIcon /> as never}
            title={t("inventory.history.empty")}
            description={
              canAdjust
                ? t("inventory.history.emptyHint")
                : t("inventory.history.signIn")
            }
            action={
              canAdjust ? (
                <Link
                  to="/inventory/stock"
                  className="inline-flex h-10 items-center gap-2 rounded-xl bg-indigo-600 px-4 text-sm font-medium text-white hover:bg-indigo-700"
                >
                  {t("inventory.adjust")}
                </Link>
              ) : undefined
            }
          />
        </Card>
      ) : (
        <>
          <div className="alyq-card hidden overflow-x-auto md:block">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-start text-[11px] font-bold uppercase tracking-wider text-slate-600">
                  <th className="px-4 py-3 text-start font-semibold">{t("inventory.cols.product")}</th>
                  <th className="px-3 py-3 text-start font-semibold">{t("inventory.cols.type")}</th>
                  <th className="px-3 py-3 text-end font-semibold">{t("inventory.cols.delta")}</th>
                  <th className="px-3 py-3 text-end font-semibold">{t("inventory.cols.before")}</th>
                  <th className="px-3 py-3 text-end font-semibold">{t("inventory.cols.after")}</th>
                  <th className="px-3 py-3 text-start font-semibold">{t("inventory.cols.reason")}</th>
                  <th className="px-3 py-3 text-start font-semibold">{t("inventory.cols.notes")}</th>
                  <th className="px-3 py-3 text-start font-semibold">{t("inventory.cols.user")}</th>
                  <th className="px-3 py-3 text-start font-semibold">{t("inventory.cols.date")}</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((m) => (
                  <MovementRow key={m.id} movement={m} productName={productNameOf(m.product_id)} />
                ))}
              </tbody>
            </table>
          </div>

          <div className="space-y-3 md:hidden">
            {visible.map((m) => (
              <MovementCard key={m.id} movement={m} productName={productNameOf(m.product_id)} />
            ))}
          </div>

          <div className="mt-3 flex flex-wrap items-center justify-between gap-3 alyq-card px-3 py-2.5 text-xs font-semibold text-slate-700">
            <span className="tabular-nums">
              {t("products.showing", {
                from: (currentPage - 1) * pageSize + 1,
                to: Math.min(currentPage * pageSize, filtered.length),
                total: filtered.length,
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
        </>
      )}

      <div className="sr-only">{t("inventory.history.viewAll")}</div>
      <span className="sr-only">{t("inventory.history.viewAll")}</span>
    </div>
  );
}

function MovementRow({
  movement,
  productName,
}: {
  movement: StockMovement;
  productName: string;
}) {
  const { t, num, date } = useI18n();
  const out = isOutbound(movement.type);
  return (
    <tr className="border-b border-slate-50 last:border-0 hover:bg-slate-50/60">
      <td className="px-4 py-3 align-top">
        <span className="block font-medium text-slate-900">{productName}</span>
        <span className="block text-[11px] font-medium text-slate-500">
          {date(movement.created_at)}
        </span>
      </td>
      <td className="px-3 py-3 align-top">
        <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1 ring-inset ${out ? "bg-rose-50 text-rose-700 ring-rose-200" : "bg-emerald-50 text-emerald-700 ring-emerald-200"}`}>
          {out ? <MinusCircleIcon /> : <PlusCircleIcon />}
          {t(`inventory.type.${movement.type}` as never)}
        </span>
      </td>
      <td className="px-3 py-3 text-end align-top font-semibold tabular-nums text-slate-900">
        {out ? "−" : "+"}
        {num(movement.delta, 0)}
      </td>
      <td className="px-3 py-3 text-end align-top text-slate-700 tabular-nums">
        {num(movement.quantity_before, 0)}
      </td>
      <td className="px-3 py-3 text-end align-top font-semibold text-slate-900 tabular-nums">
        {num(movement.quantity_after, 0)}
      </td>
      <td className="px-3 py-3 align-top font-medium text-slate-700">
        {t(`inventory.reason.${movement.reason}` as never)}
      </td>
      <td className="px-3 py-3 align-top text-slate-600 max-w-72">
        {movement.notes ? (
          <span className="block text-xs">{movement.notes}</span>
        ) : (
          <span className="text-[11px] text-slate-400">—</span>
        )}
      </td>
      <td className="px-3 py-3 align-top">
        <span className="block text-xs font-semibold text-slate-700">{movement.user_name}</span>
        <span className="block text-[10px] text-slate-500">{movement.user_id}</span>
      </td>
      <td className="px-3 py-3 align-top text-xs text-slate-600">
        {date(movement.created_at)}
      </td>
    </tr>
  );
}

function MovementCard({
  movement,
  productName,
}: {
  movement: StockMovement;
  productName: string;
}) {
  const { t, num, date } = useI18n();
  const out = isOutbound(movement.type);
  return (
    <div className="alyq-card p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-slate-900">{productName}</p>
          <p className="text-[11px] text-slate-600">
            {t(`inventory.type.${movement.type}` as never)} ·{" "}
            {t(`inventory.reason.${movement.reason}` as never)}
          </p>
        </div>
        <span
          className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1 ring-inset ${out ? "bg-rose-50 text-rose-700 ring-rose-200" : "bg-emerald-50 text-emerald-700 ring-emerald-200"}`}
        >
          {out ? "−" : "+"}
          {num(movement.delta, 0)}
        </span>
      </div>
      <div className="mt-2 grid grid-cols-3 gap-2 text-xs">
        <div>
          <p className="text-[10px] font-semibold uppercase text-slate-500">
            {t("inventory.cols.before")}
          </p>
          <p className="font-medium tabular-nums text-slate-700">{num(movement.quantity_before, 0)}</p>
        </div>
        <div>
          <p className="text-[10px] font-semibold uppercase text-slate-500">
            {t("inventory.cols.after")}
          </p>
          <p className="font-semibold tabular-nums text-slate-900">{num(movement.quantity_after, 0)}</p>
        </div>
        <div>
          <p className="text-[10px] font-semibold uppercase text-slate-500">
            {t("inventory.cols.date")}
          </p>
          <p className="font-medium text-slate-700">{date(movement.created_at)}</p>
        </div>
      </div>
      {movement.notes ? (
        <p className="mt-2 text-xs text-slate-600">{movement.notes}</p>
      ) : null}
      <p className="mt-2 text-[11px] text-slate-500">
        {t("inventory.cols.user")}: {movement.user_name}
      </p>
      <Badge tone={out ? "danger" : "success"} className="mt-2 inline-flex">
        <StockStatusBadge status={deriveStatus(movement.quantity_after)} withIcon={false} />
      </Badge>
    </div>
  );
}

function deriveStatus(quantity: number): "in" | "out" {
  return quantity <= 0 ? "out" : "in";
}
