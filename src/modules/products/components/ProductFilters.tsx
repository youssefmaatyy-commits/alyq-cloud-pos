import { useMemo } from "react";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { SelectInput, TextInput } from "@/components/ui";
import { SearchIcon } from "@/components/ui";
import { toCategoryOptions } from "../services/categoryTree";
import { useCatalog } from "../hooks/CatalogProvider";
import { UNCATEGORIZED_ID, type ProductType } from "../types";
import { PRODUCT_TYPES } from "../types";
import { PRODUCT_TYPE_META } from "../constants";

export type StatusFilter = "all" | "active" | "inactive";
export type StockFilter = "all" | "in" | "low" | "out";
export type SortKey = "name" | "sku" | "price_asc" | "price_desc" | "updated";

export interface ProductFiltersValue {
  search: string;
  categoryId: string;
  status: StatusFilter;
  type: ProductType | "all";
  stock: StockFilter;
  /** Phase 46: what the storefront shows (independent of active/archived). */
  visibility: "all" | "visible" | "hidden";
  featured: boolean;
  sort: SortKey;
}

export const EMPTY_FILTERS: ProductFiltersValue = {
  search: "",
  categoryId: "all",
  status: "all",
  type: "all",
  stock: "all",
  visibility: "all",
  featured: false,
  sort: "name",
};

export interface ProductFiltersProps {
  value: ProductFiltersValue;
  onChange: (next: ProductFiltersValue) => void;
  resultCount: number;
}

export function ProductFilters({ value, onChange, resultCount }: ProductFiltersProps) {
  const { t, pick, tPlural } = useI18n();
  const { tree } = useCatalog();

  const options = useMemo(() => toCategoryOptions(tree, pick, { includeInactive: true }), [tree, pick]);

  const isDirty =
    value.search !== EMPTY_FILTERS.search ||
    value.categoryId !== EMPTY_FILTERS.categoryId ||
    value.status !== EMPTY_FILTERS.status ||
    value.type !== EMPTY_FILTERS.type ||
    value.stock !== EMPTY_FILTERS.stock ||
    value.visibility !== EMPTY_FILTERS.visibility ||
    value.featured !== EMPTY_FILTERS.featured ||
    value.sort !== EMPTY_FILTERS.sort;

  return (
    <div className="space-y-3 rounded-2xl border border-slate-200 bg-white p-3 shadow-sm shadow-slate-100 sm:p-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="sm:col-span-2">
          <TextInput
            value={value.search}
            leading={<SearchIcon />}
            onChange={(event) => onChange({ ...value, search: event.target.value })}
            placeholder={t("products.searchPlaceholder")}
            aria-label={t("common.search")}
            type="search"
          />
        </div>

        <SelectInput
          value={value.categoryId}
          onChange={(event) => onChange({ ...value, categoryId: event.target.value })}
          aria-label={t("products.category")}
        >
          <option value="all">{`${t("products.category")}: ${t("common.all")}`}</option>
          <option value={UNCATEGORIZED_ID}>{t("products.withoutCategory")}</option>
          {options.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </SelectInput>

        <SelectInput
          value={value.status}
          onChange={(event) => onChange({ ...value, status: event.target.value as StatusFilter })}
          aria-label={t("common.status")}
        >
          <option value="all">{`${t("common.status")}: ${t("common.all")}`}</option>
          <option value="active">{t("common.active")}</option>
          <option value="inactive">{t("common.inactive")}</option>
        </SelectInput>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <FilterChip
            active={value.type === "all"}
            onClick={() => onChange({ ...value, type: "all" })}
            label={`${t("products.type")}: ${t("common.all")}`}
          />
          {PRODUCT_TYPES.map((type) => (
            <FilterChip
              key={type}
              active={value.type === type}
              onClick={() => onChange({ ...value, type })}
              label={`${PRODUCT_TYPE_META[type].icon} ${t(PRODUCT_TYPE_META[type].labelKey as never)}`}
            />
          ))}
          <span className="mx-0.5 h-4 w-px bg-slate-200" aria-hidden />
          <FilterChip
            active={value.featured}
            onClick={() => onChange({ ...value, featured: !value.featured })}
            label={`⭐ ${t("products.featuredBadge")}`}
          />
        </div>

        <div className="ms-auto flex flex-wrap items-center gap-2">
          <SelectInput
            value={value.stock}
            onChange={(event) => onChange({ ...value, stock: event.target.value as StockFilter })}
            className="h-9 w-auto min-w-40 py-1.5 text-xs font-semibold"
            aria-label={t("common.stock")}
          >
            <option value="all">{`${t("common.stock")}: ${t("common.all")}`}</option>
            <option value="in">{t("products.inStock")}</option>
            <option value="low">{t("products.lowStockBadge")}</option>
            <option value="out">{t("products.outOfStock")}</option>
          </SelectInput>
          <SelectInput
            value={value.visibility}
            onChange={(event) =>
              onChange({ ...value, visibility: event.target.value as ProductFiltersValue["visibility"] })
            }
            className="h-9 w-auto min-w-40 py-1.5 text-xs font-semibold"
            aria-label={t("products.visibilityFilter")}
            data-testid="products-visibility-filter"
          >
            <option value="all">{`${t("products.visibilityFilter")}: ${t("common.all")}`}</option>
            <option value="visible">{t("products.visibilityVisible")}</option>
            <option value="hidden">{t("products.visibilityHidden")}</option>
          </SelectInput>
          <SelectInput
            value={value.sort}
            onChange={(event) => onChange({ ...value, sort: event.target.value as SortKey })}
            className="h-9 w-auto min-w-44 py-1.5 text-xs font-semibold"
            aria-label={t("common.filters")}
          >
            <option value="name">{t("products.cols.product")} (A→Z)</option>
            <option value="sku">{t("products.sku")} (A→Z)</option>
            <option value="price_asc">{t("products.cols.price")} ↑</option>
            <option value="price_desc">{t("products.cols.price")} ↓</option>
            <option value="updated">{t("common.updated")}</option>
          </SelectInput>
          {isDirty ? (
            <button
              type="button"
              onClick={() => onChange(EMPTY_FILTERS)}
              className="rounded-xl px-2.5 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-100 hover:text-slate-900"
            >
              {t("common.clear")}
            </button>
          ) : null}
          <span className="rounded-full bg-indigo-50 px-2.5 py-1 text-xs font-bold text-indigo-800 ring-1 ring-indigo-200 tabular-nums">
            {tPlural("products.count", resultCount)}
          </span>
        </div>
      </div>
    </div>
  );
}

function FilterChip({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        active
          ? "rounded-full bg-indigo-600 px-2.5 py-1 text-[11px] font-semibold text-white shadow-md shadow-indigo-200"
          : "rounded-full bg-slate-100 px-2.5 py-1 text-[11px] font-semibold text-slate-700 ring-1 ring-slate-200 hover:bg-slate-200"
      }
    >
      {label}
    </button>
  );
}
