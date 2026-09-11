import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { StorefrontLayout } from "../components/StorefrontLayout";
import { fetchStorefrontCatalog } from "../data/storefrontCatalog";
import {
  queryStorefront,
  countByCategory,
  categoryName,
  productName,
  EMPTY_STOREFRONT_FILTERS,
  type StorefrontFilters,
} from "../data/storefrontQuery";
import type { Product, Category } from "@/modules/products/types";
import { stockStatus } from "@/modules/products/types";

export function StorefrontProductsPage() {
  const { t, money, lang } = useI18n();
  const [params, setParams] = useSearchParams();

  const [products, setProducts] = useState<Product[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [loading, setLoading] = useState(true);

  const [filters, setFilters] = useState<StorefrontFilters>(() => ({
    ...EMPTY_STOREFRONT_FILTERS,
    categoryId: params.get("category") ?? "all",
    search: params.get("q") ?? "",
  }));

  useEffect(() => {
    fetchStorefrontCatalog()
      .then(({ products, categories }) => {
        setProducts(products);
        setCategories(categories);
      })
      .finally(() => setLoading(false));
  }, []);

  const filtered = useMemo(() => queryStorefront(products, filters), [products, filters]);
  const categoryCounts = useMemo(() => countByCategory(products), [products]);

  const updateFilter = (patch: Partial<StorefrontFilters>) => {
    setFilters((prev) => ({ ...prev, ...patch }));
    // Update URL params for shareability
    const next = new URLSearchParams(params);
    if (patch.categoryId !== undefined) {
      if (patch.categoryId === "all") next.delete("category");
      else next.set("category", patch.categoryId);
    }
    if (patch.search !== undefined) {
      if (patch.search) next.set("q", patch.search);
      else next.delete("q");
    }
    setParams(next, { replace: true });
  };

  return (
    <StorefrontLayout>
      <div className="flex flex-col gap-6 lg:flex-row">
        {/* Sidebar */}
        <aside className="w-full shrink-0 lg:w-56">
          <div className="rounded-xl border border-slate-200 bg-white p-4">
            <h3 className="mb-3 text-xs font-bold uppercase tracking-wider text-slate-500">
              {t("storefront.categories")}
            </h3>
            <div className="space-y-1">
              <button
                onClick={() => updateFilter({ categoryId: "all" })}
                className={`w-full rounded-lg px-3 py-1.5 text-left text-sm font-medium transition ${
                  filters.categoryId === "all"
                    ? "bg-indigo-50 text-indigo-700"
                    : "text-slate-600 hover:bg-slate-50"
                }`}
              >
                {t("common.all")} <span className="text-xs text-slate-400">({products.length})</span>
              </button>
              {categories.map((cat) => (
                <button
                  key={cat.id}
                  onClick={() => updateFilter({ categoryId: cat.id })}
                  className={`w-full rounded-lg px-3 py-1.5 text-left text-sm font-medium transition ${
                    filters.categoryId === cat.id
                      ? "bg-indigo-50 text-indigo-700"
                      : "text-slate-600 hover:bg-slate-50"
                  }`}
                >
                  {categoryName(cat, lang)}{" "}
                  <span className="text-xs text-slate-400">({categoryCounts.get(cat.id) ?? 0})</span>
                </button>
              ))}
            </div>
          </div>
        </aside>

        {/* Main content */}
        <div className="flex-1">
          {/* Search + sort bar */}
          <div className="mb-4 flex flex-wrap items-center gap-3">
            <input
              type="search"
              value={filters.search}
              onChange={(e) => updateFilter({ search: e.target.value })}
              placeholder={t("storefront.searchPlaceholder")}
              className="h-10 flex-1 rounded-xl border border-slate-200 bg-white px-4 text-sm transition focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100"
            />
            <select
              value={filters.sort}
              onChange={(e) => setFilters((prev) => ({ ...prev, sort: e.target.value as StorefrontFilters["sort"] }))}
              className="h-10 rounded-xl border border-slate-200 bg-white px-3 text-sm font-medium text-slate-700"
            >
              <option value="featured">{t("storefront.sortFeatured")}</option>
              <option value="price_asc">{t("storefront.sortPriceLow")}</option>
              <option value="price_desc">{t("storefront.sortPriceHigh")}</option>
              <option value="name">{t("storefront.sortName")}</option>
            </select>
            <label className="flex items-center gap-2 text-sm font-medium text-slate-600">
              <input
                type="checkbox"
                checked={filters.inStockOnly}
                onChange={(e) => setFilters((prev) => ({ ...prev, inStockOnly: e.target.checked }))}
                className="h-4 w-4 rounded border-slate-300 text-indigo-600"
              />
              {t("storefront.inStockOnly")}
            </label>
          </div>

          {/* Results count */}
          <p className="mb-3 text-xs font-semibold text-slate-500">
            {filtered.length} {t("storefront.productsFound")}
          </p>

          {loading ? (
            <div className="py-16 text-center text-sm text-slate-500">{t("common.loading")}</div>
          ) : filtered.length === 0 ? (
            <div className="rounded-xl border border-slate-200 bg-white py-16 text-center">
              <p className="text-4xl">🔍</p>
              <p className="mt-2 text-sm font-semibold text-slate-700">{t("storefront.noResults")}</p>
              <p className="mt-1 text-xs text-slate-500">{t("storefront.noResultsHint")}</p>
            </div>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {filtered.map((product) => (
                <ProductCard key={product.id} product={product} lang={lang} money={money} />
              ))}
            </div>
          )}
        </div>
      </div>
    </StorefrontLayout>
  );
}

function ProductCard({
  product,
  lang,
  money,
}: {
  product: Product;
  lang: "en" | "ar";
  money: (v: number) => string;
}) {
  const status = stockStatus(product);
  const outOfStock = status === "out";

  return (
    <Link
      to={`/store/products/${product.id}`}
      className="group overflow-hidden rounded-xl border border-slate-200 bg-white transition hover:border-indigo-300 hover:shadow-md"
    >
      <div className="aspect-square bg-slate-100">
        {product.image_url ? (
          <img
            src={product.image_url}
            alt={productName(product, lang)}
            className="h-full w-full object-cover transition group-hover:scale-105"
          />
        ) : (
          <div className="flex h-full items-center justify-center text-4xl text-slate-300">📦</div>
        )}
      </div>
      <div className="p-3">
        <p className="truncate text-sm font-semibold text-slate-900">{productName(product, lang)}</p>
        <p className="mt-0.5 text-xs text-slate-500">{product.sku}</p>
        <div className="mt-2 flex items-center justify-between">
          <span className="text-sm font-bold text-indigo-700">{money(product.selling_price)}</span>
          {outOfStock ? (
            <span className="rounded-full bg-rose-100 px-2 py-0.5 text-[10px] font-bold text-rose-700">
              Out of stock
            </span>
          ) : status === "low" ? (
            <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-bold text-amber-700">
              Low stock
            </span>
          ) : null}
        </div>
      </div>
    </Link>
  );
}
