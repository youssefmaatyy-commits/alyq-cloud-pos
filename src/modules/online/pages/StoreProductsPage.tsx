/**
 * Search, filters and sorting — the catalogue page.
 *
 * The filters live in the URL, which buys three things a shopper notices: a
 * filtered view can be shared or bookmarked, the back button undoes a filter
 * instead of leaving the page, and a reload does not lose the search. Nothing
 * here writes to the database; it is all resolved in the browser from the
 * catalogue that is already loaded, so filtering is instant even on a phone.
 *
 * Price and availability test the *effective* values — the campaign price and
 * the units that can actually be promised — because a filter that hides a
 * product the tile shows as available is a filter the shopper cannot trust.
 */
import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { cn } from "@/utils/cn";
import { useStorefront } from "../hooks/StorefrontProvider";
import {
  EMPTY_CATALOG_FILTERS,
  filtersFromSearchParams,
  filtersToSearchParams,
  searchCatalog,
  STOREFRONT_SORTS,
  type AvailabilityFilter,
  type CatalogFilters,
  type StorefrontSort,
} from "../services/catalogQuery";
import { ProductCard, ProductGrid } from "../components/storefront/ProductCard";
import { Money } from "../components/storefront/StorePrimitives";
import { applyDocumentMeta, clearDocumentMeta } from "../services/seo";

export function StoreProductsPage() {
  const { t, pick } = useI18n();
  const { products, categories, brandsFacet, priceRange, catalogContext, settings, loading } = useStorefront();
  const [params, setParams] = useSearchParams();

  const filters = useMemo(() => filtersFromSearchParams(params), [params]);
  const [searchDraft, setSearchDraft] = useState(filters.search);
  const [priceDraft, setPriceDraft] = useState({
    min: filters.minPrice !== null ? String(filters.minPrice) : "",
    max: filters.maxPrice !== null ? String(filters.maxPrice) : "",
  });
  const [filtersOpen, setFiltersOpen] = useState(false);

  // A link from another page (a brand chip, a category tile) replaces the query;
  // the drafts follow it rather than showing yesterday's search.
  // The catalogue page is indexed too, and its title says which shop it belongs
  // to: a search result reading only "Products" is a result nobody clicks.
  useEffect(() => {
    const storeName = pick(settings.contact.store_name_ar, settings.contact.store_name_en);
    applyDocumentMeta({
      title: `${t("store.products.title")} — ${storeName}`.trim(),
      description:
        settings.seo.meta_description.trim() || pick(settings.contact.tagline_ar, settings.contact.tagline_en),
    });
    return () => clearDocumentMeta();
  }, [pick, settings.contact.store_name_ar, settings.contact.store_name_en, settings.contact.tagline_ar, settings.contact.tagline_en, settings.seo.meta_description, t]);

  useEffect(() => {
    setSearchDraft(filters.search);
    setPriceDraft({
      min: filters.minPrice !== null ? String(filters.minPrice) : "",
      max: filters.maxPrice !== null ? String(filters.maxPrice) : "",
    });
  }, [filters.maxPrice, filters.minPrice, filters.search]);

  const apply = (patch: Partial<CatalogFilters>) => {
    const next = { ...filters, ...patch };
    setParams(filtersToSearchParams(next), { replace: true });
  };

  // Debounce the search field: typing five characters should not redraw the grid
  // five times on a phone.
  useEffect(() => {
    if (searchDraft === filters.search) return;
    const timer = window.setTimeout(() => apply({ search: searchDraft }), 300);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchDraft]);

  useEffect(() => {
    const min = priceDraft.min === "" ? null : Number(priceDraft.min);
    const max = priceDraft.max === "" ? null : Number(priceDraft.max);
    const nextMin = min !== null && Number.isFinite(min) ? min : null;
    const nextMax = max !== null && Number.isFinite(max) ? max : null;
    if (nextMin === filters.minPrice && nextMax === filters.maxPrice) return;
    const timer = window.setTimeout(() => apply({ minPrice: nextMin, maxPrice: nextMax }), 400);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [priceDraft]);

  const results = useMemo(
    () => searchCatalog(products, filters, catalogContext),
    [catalogContext, filters, products],
  );

  const activeFilterCount =
    (filters.categoryId !== "all" ? 1 : 0) +
    (filters.brand ? 1 : 0) +
    (filters.minPrice !== null || filters.maxPrice !== null ? 1 : 0) +
    (filters.availability !== "any" ? 1 : 0);

  const sortLabel: Record<StorefrontSort, string> = {
    featured: t("store.sort.featured"),
    newest: t("store.sort.newest"),
    price_asc: t("store.sort.priceAsc"),
    price_desc: t("store.sort.priceDesc"),
    best_selling: t("store.sort.bestSelling"),
    name: t("store.sort.name"),
  };

  const filterPanel = (
    <div className="flex flex-col gap-5">
      <div>
        <p className="mb-2 text-xs font-black uppercase tracking-widest text-[var(--store-muted)]">
          {t("store.filters.category")}
        </p>
        <div className="flex flex-col gap-1">
          <button
            type="button"
            onClick={() => apply({ categoryId: "all" })}
            className={cn(
              "rounded-lg px-2.5 py-1.5 text-start text-sm font-semibold transition",
              filters.categoryId === "all"
                ? "bg-[var(--store-primary-soft)] text-[var(--store-primary)]"
                : "text-[var(--store-text)] hover:bg-[var(--store-surface-alt)]",
            )}
          >
            {t("common.all")}
          </button>
          {categories
            .filter((category) => category.active)
            .map((category) => (
              <button
                key={category.id}
                type="button"
                onClick={() => apply({ categoryId: category.id })}
                className={cn(
                  "rounded-lg px-2.5 py-1.5 text-start text-sm font-semibold transition",
                  filters.categoryId === category.id
                    ? "bg-[var(--store-primary-soft)] text-[var(--store-primary)]"
                    : "text-[var(--store-text)] hover:bg-[var(--store-surface-alt)]",
                )}
              >
                {pick(category.name_ar, category.name_en)}
              </button>
            ))}
        </div>
      </div>

      {brandsFacet.length > 0 ? (
        <div>
          <p className="mb-2 text-xs font-black uppercase tracking-widest text-[var(--store-muted)]">
            {t("store.filters.brand")}
          </p>
          <div className="flex flex-wrap gap-1.5">
            <button
              type="button"
              onClick={() => apply({ brand: null })}
              className={cn(
                "rounded-full border px-2.5 py-1 text-xs font-bold transition",
                filters.brand === null
                  ? "border-[var(--store-primary)] bg-[var(--store-primary-soft)] text-[var(--store-primary)]"
                  : "border-[var(--store-border)] text-[var(--store-muted)]",
              )}
            >
              {t("common.all")}
            </button>
            {brandsFacet.map((brand) => (
              <button
                key={brand.key}
                type="button"
                onClick={() => apply({ brand: brand.key })}
                className={cn(
                  "rounded-full border px-2.5 py-1 text-xs font-bold transition",
                  filters.brand === brand.key
                    ? "border-[var(--store-primary)] bg-[var(--store-primary-soft)] text-[var(--store-primary)]"
                    : "border-[var(--store-border)] text-[var(--store-muted)]",
                )}
              >
                {brand.label}
                <span className="ms-1 opacity-60">{brand.count}</span>
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {priceRange ? (
        <div>
          <p className="mb-2 text-xs font-black uppercase tracking-widest text-[var(--store-muted)]">
            {t("store.filters.price")}
          </p>
          <div className="flex items-center gap-2">
            <label className="flex-1">
              <span className="sr-only">{t("store.filters.minPrice")}</span>
              <input
                type="number"
                min={priceRange.min}
                max={priceRange.max}
                value={priceDraft.min}
                onChange={(event) => setPriceDraft((draft) => ({ ...draft, min: event.target.value }))}
                placeholder={String(priceRange.min)}
                className="w-full rounded-lg border border-[var(--store-border)] bg-[var(--store-surface)] px-2 py-1.5 text-sm outline-none focus:border-[var(--store-primary)]"
              />
            </label>
            <span className="text-[var(--store-muted)]">–</span>
            <label className="flex-1">
              <span className="sr-only">{t("store.filters.maxPrice")}</span>
              <input
                type="number"
                min={priceRange.min}
                max={priceRange.max}
                value={priceDraft.max}
                onChange={(event) => setPriceDraft((draft) => ({ ...draft, max: event.target.value }))}
                placeholder={String(priceRange.max)}
                className="w-full rounded-lg border border-[var(--store-border)] bg-[var(--store-surface)] px-2 py-1.5 text-sm outline-none focus:border-[var(--store-primary)]"
              />
            </label>
          </div>
          <p className="mt-1.5 text-[11px] font-medium text-[var(--store-muted)]">
            <Money value={priceRange.min} /> – <Money value={priceRange.max} />
          </p>
        </div>
      ) : null}

      <div>
        <p
          id="store-availability-label"
          className="mb-2 text-xs font-black uppercase tracking-widest text-[var(--store-muted)]"
        >
          {t("store.filters.availability")}
        </p>
        {/* A named group, so a screen reader announces "Availability: in stock,
            1 of 3" instead of three unlabelled radio buttons. */}
        <div className="flex flex-col gap-1" role="radiogroup" aria-labelledby="store-availability-label">
          {(["any", "in_stock", "out_of_stock"] as AvailabilityFilter[]).map((option) => (
            <label
              key={option}
              className="flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm font-semibold text-[var(--store-text)] hover:bg-[var(--store-surface-alt)]"
            >
              <input
                type="radio"
                name="availability"
                checked={filters.availability === option}
                onChange={() => apply({ availability: option })}
                className="accent-[var(--store-primary)]"
              />
              {t(`store.filters.availability.${option}` as never)}
            </label>
          ))}
        </div>
      </div>

      {activeFilterCount > 0 ? (
        <button
          type="button"
          onClick={() => {
            setPriceDraft({ min: "", max: "" });
            setParams(filtersToSearchParams({ ...EMPTY_CATALOG_FILTERS, search: filters.search }), {
              replace: true,
            });
          }}
          className="rounded-lg border border-[var(--store-border)] px-3 py-2 text-xs font-bold text-[var(--store-muted)] transition hover:text-[var(--store-primary)]"
        >
          {t("store.filters.clear")}
        </button>
      ) : null}
    </div>
  );

  return (
    <div className="mx-auto w-full max-w-[var(--store-max-width,72rem)] px-4 py-6 sm:px-6">
      <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-black tracking-tight text-[var(--store-text)]">
            {filters.search
              ? t("store.products.resultsFor", { query: filters.search })
              : t("store.products.title")}
          </h1>
          <p className="mt-1 text-xs font-semibold text-[var(--store-muted)]">
            {loading
              ? t("common.loading")
              : t("store.products.count", { count: results.length })}
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setFiltersOpen((open) => !open)}
            className="relative rounded-lg border border-[var(--store-border)] px-3 py-2 text-xs font-bold text-[var(--store-text)] lg:hidden"
            aria-expanded={filtersOpen}
          >
            {t("store.filters.title")}
            {activeFilterCount > 0 ? (
              <span className="absolute -top-1.5 -end-1.5 grid h-5 min-w-5 place-items-center rounded-full bg-[var(--store-primary)] px-1 text-[10px] font-black text-[var(--store-on-primary)]">
                {activeFilterCount}
              </span>
            ) : null}
          </button>

          <label className="flex items-center gap-2">
            <span className="sr-only">{t("store.sort.label")}</span>
            <select
              value={filters.sort}
              onChange={(event) => apply({ sort: event.target.value as StorefrontSort })}
              className="rounded-lg border border-[var(--store-border)] bg-[var(--store-surface)] px-3 py-2 text-xs font-bold text-[var(--store-text)] outline-none focus:border-[var(--store-primary)]"
            >
              {STOREFRONT_SORTS.map((sort) => (
                <option key={sort} value={sort}>
                  {sortLabel[sort]}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>

      <form className="mb-5 lg:hidden" onSubmit={(event) => event.preventDefault()}>
        <input
          type="search"
          value={searchDraft}
          onChange={(event) => setSearchDraft(event.target.value)}
          placeholder={t("store.search.placeholder")}
          className="w-full rounded-lg border border-[var(--store-border)] bg-[var(--store-surface)] px-3 py-2 text-sm outline-none focus:border-[var(--store-primary)]"
        />
      </form>

      <div className="grid gap-6 lg:grid-cols-[16rem_1fr]">
        <aside
          className={cn(
            "border border-[var(--store-border)] bg-[var(--store-surface)] p-4 lg:block",
            filtersOpen ? "block" : "hidden",
          )}
          style={{ borderRadius: "var(--store-radius)" }}
        >
          {filterPanel}
        </aside>

        <div>
          {results.length === 0 ? (
            <div className="border border-dashed border-[var(--store-border)] bg-[var(--store-surface)] p-10 text-center" style={{ borderRadius: "var(--store-radius)" }}>
              <p className="text-sm font-bold text-[var(--store-text)]">{t("store.products.noResults")}</p>
              <p className="mt-1 text-xs text-[var(--store-muted)]">{t("store.products.noResultsHint")}</p>
              <button
                type="button"
                onClick={() => setParams(new URLSearchParams(), { replace: true })}
                className="mt-4 rounded-lg bg-[var(--store-primary)] px-4 py-2 text-xs font-bold text-[var(--store-on-primary)]"
              >
                {t("store.filters.clear")}
              </button>
            </div>
          ) : (
            <ProductGrid className="lg:grid-cols-3 xl:grid-cols-4">
              {results.map((entry) => (
                <ProductCard key={entry.product.id} entry={entry} />
              ))}
            </ProductGrid>
          )}
        </div>
      </div>
    </div>
  );
}
