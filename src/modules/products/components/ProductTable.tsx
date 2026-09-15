import { Link } from "react-router-dom";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { Badge } from "@/components/ui";
import { ArchiveIcon, EditIcon, EyeIcon, RestoreIcon, TrashIcon } from "@/components/ui";
import { cn } from "@/utils/cn";
import { marginPct, stockStatus, type Product, type StockStatus } from "../types";
import { canAct } from "@/lib/permissions/enforce";
import { mayPerform } from "@/lib/permissions/actions";
import type { ProductReferenceMap } from "../data/repository";
import { ActiveBadge, ProductTypeBadge } from "./ProductTypeBadge";

export interface ProductTableProps {
  products: Product[];
  categoryName: (id: string | null) => string;
  onToggleActive: (product: Product) => void;
  onDelete: (product: Product) => void;
  /** product id → preserved-history counts; a hit disables permanent delete. */
  references: ProductReferenceMap;
  busyId?: string | null;
  emptyState?: React.ReactNode;
}

function Thumb({ product }: { product: Product }) {
  const initials = (product.name_en || product.name_ar || "?").trim().charAt(0).toUpperCase();
  return (
    <span className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-gradient-to-br from-slate-100 to-slate-200 text-sm font-bold text-slate-600">
      {product.image_url ? (
        <img
          src={product.image_url}
          alt=""
          loading="lazy"
          className="h-full w-full object-cover"
          onError={(event) => {
            (event.currentTarget as HTMLImageElement).style.display = "none";
          }}
        />
      ) : (
        <span aria-hidden>{initials}</span>
      )}
    </span>
  );
}

export function StockBadge({ status }: { status: StockStatus }) {
  const { t } = useI18n();
  if (status === "low") return <Badge tone="warning">{t("products.lowStockBadge")}</Badge>;
  if (status === "out") return <Badge tone="danger">{t("products.outOfStock")}</Badge>;
  return null;
}

function StockCell({ product }: { product: Product }) {
  const { t, num } = useI18n();
  const status = stockStatus(product);
  if (status === "none") {
    return <span className="text-xs font-medium text-slate-500">{t("products.notTracked")}</span>;
  }
  return (
    <div className="space-y-1">
      <span className="block text-sm font-semibold tabular-nums text-slate-900">
        {num(product.stock_quantity, 0)}
      </span>
      <StockBadge status={status} />
    </div>
  );
}

export function ProductTable({
  products,
  categoryName,
  onToggleActive,
  onDelete,
  references,
  busyId,
  emptyState,
}: ProductTableProps) {
  const { t, pick, money, date, num } = useI18n();
  // The destructive column only renders for a seat that could use it; the
  // disabled-with-reason variant replaces the click for referenced products.
  const mayDelete = mayPerform("product.delete");

  if (products.length === 0 && emptyState) return <>{emptyState}</>;

  return (
    <>
      {/* Desktop */}
      <div className="alyq-card hidden overflow-x-auto md:block">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50 text-start text-[11px] font-bold uppercase tracking-wider text-slate-600">
              <th className="px-4 py-3 text-start font-semibold">{t("products.cols.product")}</th>
              <th className="px-3 py-3 text-start font-semibold">{t("products.sku")}</th>
              <th className="px-3 py-3 text-start font-semibold">{t("products.cols.category")}</th>
              <th className="px-3 py-3 text-start font-semibold">{t("products.cols.type")}</th>
              <th className="px-3 py-3 text-start font-semibold">{t("common.stock")}</th>
              <th className="px-3 py-3 text-end font-semibold">{t("products.cols.price")}</th>
              <th className="px-3 py-3 text-start font-semibold">{t("products.cols.status")}</th>
              <th className="px-4 py-3 text-end font-semibold">{t("common.actions")}</th>
            </tr>
          </thead>
          <tbody>
            {products.map((product) => {
              // Phase 17: margin is cost in disguise, so it follows `view_cost`.
              const maySeeCost = canAct("view_cost");
              const margin = maySeeCost ? marginPct(product.selling_price, product.cost_price) : null;
              const status = stockStatus(product);
              return (
                <tr key={product.id} className="border-b border-slate-50 last:border-0 hover:bg-slate-50/60">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      <Thumb product={product} />
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5">
                          {product.is_featured ? (
                            <span title={t("products.featuredBadge")} aria-label={t("products.featuredBadge")}>
                              ⭐
                            </span>
                          ) : null}
                          <Link
                            to={`/products/${product.id}`}
                            className="block max-w-52 truncate font-medium text-slate-900 hover:text-indigo-600"
                          >
                            {pick(product.name_ar, product.name_en)}
                          </Link>
                        </div>
                        <span className="block max-w-52 truncate text-xs font-medium text-slate-600">
                          {pick(product.description_ar, product.description_en) === "—"
                            ? product.barcode ?? "—"
                            : pick(product.description_ar, product.description_en)}
                        </span>
                      </div>
                    </div>
                  </td>
                  <td className="px-3 py-3">
                    <span className="rounded-md bg-slate-100 px-1.5 py-0.5 font-mono text-xs text-slate-700">
                      {product.sku}
                    </span>
                  </td>
                  <td className="px-3 py-3 font-medium text-slate-700">{categoryName(product.category_id)}</td>
                  <td className="px-3 py-3">
                    <ProductTypeBadge type={product.product_type} />
                  </td>
                  <td className="px-3 py-3">
                    <StockCell product={product} />
                  </td>
                  <td className="px-3 py-3 text-end">
                    <span className="block font-semibold tabular-nums text-slate-900">
                      {money(product.selling_price)}
                    </span>
                    <span className="block text-[11px] font-medium text-slate-600 tabular-nums">
                      {t("products.taxRate")} {num(product.tax_rate, 2)}%
                      {margin !== null ? ` · ${t("products.margin")} ${num(margin, 1)}%` : ""}
                    </span>
                  </td>
                  <td className="px-3 py-3">
                    <div className="flex flex-col items-start gap-1">
                      <ActiveBadge active={product.active} />
                      {!product.show_on_website ? (
                        <span
                          className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-600 ring-1 ring-inset ring-slate-200"
                          title={t("products.hiddenOnWebsite")}
                        >
                          🕶 {t("products.hiddenOnWebsite")}
                        </span>
                      ) : null}
                      {status === "low" || status === "out" ? <StockBadge status={status} /> : null}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-1">
                      <TableAction to={`/products/${product.id}`} label={t("common.view")}>
                        <EyeIcon />
                      </TableAction>
                      <TableAction to={`/products/${product.id}/edit`} label={t("common.edit")}>
                        <EditIcon />
                      </TableAction>
                      <button
                        type="button"
                        disabled={busyId === product.id}
                        onClick={() => onToggleActive(product)}
                        title={product.active ? t("common.archive") : t("common.restore")}
                        aria-label={product.active ? t("common.archive") : t("common.restore")}
                        className={cn(
                          "flex h-8 w-8 items-center justify-center rounded-lg transition-colors disabled:opacity-40",
                          product.active
                            ? "text-slate-500 hover:bg-rose-50 hover:text-rose-600"
                            : "text-emerald-600 hover:bg-emerald-50",
                        )}
                      >
                        {product.active ? <ArchiveIcon /> : <RestoreIcon />}
                      </button>
                      {mayDelete ? (
                        <DeleteAction
                          product={product}
                          referenced={references[product.id]}
                          busy={busyId === product.id}
                          onDelete={() => onDelete(product)}
                        />
                      ) : null}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Mobile */}
      <div className="space-y-3 md:hidden">
        {products.map((product) => {
          const status = stockStatus(product);
          return (
            <div key={product.id} className="alyq-card p-3">
              <div className="flex items-start gap-3">
                <Thumb product={product} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    {product.is_featured ? <span aria-label={t("products.featuredBadge")}>⭐</span> : null}
                    <Link
                      to={`/products/${product.id}`}
                      className="block truncate text-sm font-semibold text-slate-900"
                    >
                      {pick(product.name_ar, product.name_en)}
                    </Link>
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-1.5">
                    <ProductTypeBadge type={product.product_type} withIcon={false} />
                    <ActiveBadge active={product.active} />
                    {!product.show_on_website ? <Badge>🕶</Badge> : null}
                    <StockBadge status={status} />
                  </div>
                  <p className="mt-1.5 font-mono text-[11px] font-medium text-slate-600">{product.sku}</p>
                  <p className="text-[11px] font-medium text-slate-600">{categoryName(product.category_id)}</p>
                  <div className="mt-1.5 flex items-center gap-3">
                    <p className="text-base font-semibold tabular-nums text-slate-900">
                      {money(product.selling_price)}
                      <span className="ms-1 text-[11px] font-medium text-slate-600">
                        +{num(product.tax_rate, 2)}%
                      </span>
                    </p>
                    {status !== "none" ? (
                      <p className="text-[11px] font-semibold tabular-nums text-slate-700">
                        {t("common.stock")}: {num(product.stock_quantity, 0)}
                      </p>
                    ) : null}
                  </div>
                </div>
              </div>
              <div className="mt-3 flex items-center justify-between gap-2 border-t border-slate-100 pt-2.5">
                <span className="text-[11px] font-medium text-slate-600">{date(product.updated_at)}</span>
                <div className="flex items-center gap-1">
                  <TableAction to={`/products/${product.id}`} label={t("common.view")}>
                    <EyeIcon />
                  </TableAction>
                  <TableAction to={`/products/${product.id}/edit`} label={t("common.edit")}>
                    <EditIcon />
                  </TableAction>
                  <button
                    type="button"
                    disabled={busyId === product.id}
                    onClick={() => onToggleActive(product)}
                    className={cn(
                      "flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-medium disabled:opacity-40",
                      product.active
                        ? "text-rose-600 hover:bg-rose-50"
                        : "text-emerald-600 hover:bg-emerald-50",
                    )}
                  >
                    {product.active ? <ArchiveIcon /> : <RestoreIcon />}
                    {product.active ? t("common.archive") : t("common.restore")}
                  </button>
                  {mayDelete ? (
                    <DeleteAction
                      product={product}
                      referenced={references[product.id]}
                      busy={busyId === product.id}
                      onDelete={() => onDelete(product)}
                      withLabel
                    />
                  ) : null}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}

/**
 * The permanent-delete affordance. Two honest states, no dead button:
 *   referenced  → disabled, and its title/aria-label carries the reason;
 *   unused      → armed, opening the page's explicit confirmation first.
 * Whether a product is referenced is data (`references`), not guesswork, and
 * the final word belongs to the repository either way.
 */
function DeleteAction({
  product,
  referenced,
  busy,
  onDelete,
  withLabel = false,
}: {
  product: Product;
  referenced: ProductReferenceMap[string] | undefined;
  busy: boolean;
  onDelete: () => void;
  withLabel?: boolean;
}) {
  const { t } = useI18n();
  const hasHistory = (referenced?.total ?? 0) > 0;
  if (hasHistory) {
    const reason = t("products.errorHasHistory");
    return (
      <button
        type="button"
        disabled
        title={reason}
        aria-label={reason}
        className={cn(
          "flex items-center rounded-lg text-slate-300 dark:text-slate-600",
          withLabel
            ? "cursor-not-allowed gap-1.5 px-2 py-1.5 text-xs font-medium"
            : "h-8 w-8 cursor-not-allowed justify-center",
        )}
      >
        <TrashIcon />
        {withLabel ? t("products.permanentDelete") : null}
      </button>
    );
  }
  return (
    <button
      type="button"
      disabled={busy}
      onClick={onDelete}
      title={t("products.permanentDelete")}
      aria-label={`${t("products.permanentDelete")}: ${product.name_en}`}
      className={cn(
        "flex items-center rounded-lg text-rose-500 transition-colors hover:bg-rose-50 hover:text-rose-700 disabled:opacity-40",
        withLabel ? "gap-1.5 px-2 py-1.5 text-xs font-medium" : "h-8 w-8 justify-center",
      )}
    >
      <TrashIcon />
      {withLabel ? t("products.permanentDelete") : null}
    </button>
  );
}

function TableAction({
  to,
  label,
  children,
}: {
  to: string;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <Link
      to={to}
      title={label}
      aria-label={label}
      className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-600 transition-colors hover:bg-slate-100 hover:text-slate-900"
    >
      {children}
    </Link>
  );
}
