/** URL-backed V2 search, sorting and catalogue facets. All options come from
 * the published shared catalogue; the mobile sheet has an escape route and
 * focus containment without a separate search/stock/pricing system. */
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useSearchParams } from "react-router-dom";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { useStorefront } from "../hooks/StorefrontProvider";
import {
  EMPTY_CATALOG_FILTERS, filtersFromSearchParams, filtersToSearchParams, STOREFRONT_SORTS,
  type CatalogFilters,
} from "../services/catalogQuery";
import { absoluteUrl, applyDocumentMeta, clearDocumentMeta } from "../services/seo";
import { v2CatalogResults } from "./viewModel";
import { V2ProductCard } from "./ProductCard";
import { V2ProductGrid, V2State } from "./Primitives";

export function StorefrontV2Catalog() {
  const { t, pick, money } = useI18n();
  const { products, categoriesFacet, categoryContents, brandsFacet, catalogContext, priceRange,
    campaigns, promotions, promotionTargets, loading, error, refresh, settings } = useStorefront();
  const [params, setParams] = useSearchParams();
  const filters = useMemo(() => filtersFromSearchParams(params), [params]);
  const [search, setSearch] = useState(filters.search);
  const [minPrice, setMinPrice] = useState(filters.minPrice?.toString() ?? "");
  const [maxPrice, setMaxPrice] = useState(filters.maxPrice?.toString() ?? "");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const filterButton = useRef<HTMLButtonElement>(null);
  const filterDrawer = useRef<HTMLDivElement>(null);
  const contentByCategory = new Map(categoryContents.map((content) => [content.category_id, content]));
  const offered = params.get("offer") === "1";
  const category = categoriesFacet.find((item) => item.id === filters.categoryId);
  const heading = category ? pick(contentByCategory.get(category.id)?.title_ar || category.name_ar,
    contentByCategory.get(category.id)?.title_en || category.name_en) : t("store.v2.collection");

  // Catalog options use published, active products/combinations only. No guessed
  // colour or letter-size menu; changing the admin catalogue updates the facets.
  const variants = useMemo(() => products.filter((item) => item.active && item.show_on_website)
    .flatMap((item) => catalogContext.variants?.get(item.id) ?? []).filter((variant) => variant.active),
  [products, catalogContext.variants]);
  const colors = useMemo(() => [...new Map(variants.filter((variant) => variant.color_key)
    .map((variant) => [variant.color_key, variant] as const)).entries()]
    .map(([key, variant]) => ({ key, label: pick(variant.color_ar, variant.color_en) || key }))
    .sort((a, b) => a.label.localeCompare(b.label)), [variants, pick]);
  const sizes = useMemo(() => {
    const values = new Map<string, { value: string; label: string; sort: number }>();
    variants.forEach((variant) => {
      if (variant.size !== null) values.set(`n:${variant.size}`, {
        value: `n:${variant.size}`, label: String(variant.size), sort: variant.size });
      else if (variant.size_label?.trim()) values.set(`l:${variant.size_label.trim()}`, {
        value: `l:${variant.size_label.trim()}`, label: variant.size_label.trim(), sort: Number.POSITIVE_INFINITY });
    });
    return [...values.values()].sort((a, b) => a.sort - b.sort || a.label.localeCompare(b.label));
  }, [variants]);
  const sizeValue = filters.size !== null ? `n:${filters.size}` : filters.sizeLabel ? `l:${filters.sizeLabel}` : "";
  const activeCount = [Boolean(filters.search), filters.categoryId !== "all", Boolean(filters.brand),
    Boolean(filters.color), Boolean(sizeValue), filters.minPrice !== null, filters.maxPrice !== null,
    filters.availability !== "any", offered].filter(Boolean).length;

  useEffect(() => { setSearch(filters.search); }, [filters.search]);
  useEffect(() => { setMinPrice(filters.minPrice?.toString() ?? ""); setMaxPrice(filters.maxPrice?.toString() ?? ""); },
    [filters.minPrice, filters.maxPrice]);
  useEffect(() => {
    applyDocumentMeta({ title: `${heading} — ${pick(settings.contact.store_name_ar, settings.contact.store_name_en)}`,
      description: settings.seo.meta_description,
      canonical: absoluteUrl(window.location.href.split("#")[0], "#/store/products") });
    return () => clearDocumentMeta();
  }, [heading, pick, settings.contact.store_name_ar, settings.contact.store_name_en, settings.seo.meta_description]);
  useEffect(() => {
    if (!filtersOpen || !window.matchMedia("(max-width: 767px)").matches) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    filterDrawer.current?.querySelector<HTMLButtonElement>(".v2-filter-close")?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); setFiltersOpen(false); filterButton.current?.focus(); return; }
      if (event.key !== "Tab") return;
      const focusable = [...(filterDrawer.current?.querySelectorAll<HTMLElement>("button:not(:disabled),input:not(:disabled),select:not(:disabled)") ?? [])]
        .filter((item) => item.getClientRects().length > 0);
      if (!focusable.length) return;
      if (event.shiftKey && document.activeElement === focusable[0]) {
        event.preventDefault(); focusable.at(-1)?.focus();
      } else if (!event.shiftKey && document.activeElement === focusable.at(-1)) {
        event.preventDefault(); focusable[0].focus();
      }
    };
    const onResize = () => { if (!window.matchMedia("(max-width: 767px)").matches) setFiltersOpen(false); };
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", onResize);
    return () => { document.body.style.overflow = previous; window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onResize); };
  }, [filtersOpen]);

  const results = useMemo(() => v2CatalogResults(products, filters, catalogContext,
    campaigns, promotions, promotionTargets, offered),
  [products, filters, catalogContext, campaigns, promotions, promotionTargets, offered]);
  const apply = (patch: Partial<CatalogFilters>, offer = offered) => {
    const next = filtersToSearchParams({ ...filters, ...patch });
    if (offer) next.set("offer", "1");
    setParams(next);
  };
  const submitSearch = (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); apply({ search: search.trim() }); };
  const applyPrice = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const number = (raw: string) => raw.trim() && Number.isFinite(Number(raw)) ? Math.max(0, Number(raw)) : null;
    apply({ minPrice: number(minPrice), maxPrice: number(maxPrice) });
  };
  const clear = () => { setSearch(""); setMinPrice(""); setMaxPrice("");
    setParams(filtersToSearchParams(EMPTY_CATALOG_FILTERS)); setFiltersOpen(false); };

  return <div className="v2-catalog v2-container" data-testid="v2-catalog">
    <div className="v2-catalog-intro"><p className="v2-eyebrow">{t("store.v2.eyebrow")}</p>
      <h1>{heading}</h1><p>{t("store.v2.results", { count: results.length })}</p></div>
    <form className="v2-catalog-search" onSubmit={submitSearch} role="search">
      <label className="sr-only" htmlFor="v2-search-input">{t("store.search.label")}</label>
      <input id="v2-search-input" type="search" value={search} onChange={(event) => setSearch(event.target.value)}
        placeholder={t("store.search.placeholder")} />
      <button type="submit">{t("store.v2.searchGo")}</button>
    </form>
    <div className="v2-category-chips" role="group" aria-label={t("store.nav.categories")}>
      <button type="button" aria-pressed={filters.categoryId === "all"} onClick={() => apply({ categoryId: "all" })}>{t("store.v2.allCategories")}</button>
      {categoriesFacet.map((item) => <button type="button" key={item.id} aria-pressed={filters.categoryId === item.id}
        onClick={() => apply({ categoryId: item.id })}>
        {pick(contentByCategory.get(item.id)?.title_ar || item.name_ar, contentByCategory.get(item.id)?.title_en || item.name_en)}
      </button>)}
    </div>
    <div className="v2-filter-bar">
      <button type="button" className="v2-filter-toggle" aria-expanded={filtersOpen} aria-controls="v2-filters"
        ref={filterButton} onClick={() => setFiltersOpen((value) => !value)}>
        {t("store.v2.activeFilters")}{activeCount ? ` (${activeCount})` : ""} <span aria-hidden>☷</span></button>
      {filtersOpen ? <button type="button" className="v2-filter-backdrop" aria-label={t("common.close")}
        onClick={() => { setFiltersOpen(false); filterButton.current?.focus(); }} /> : null}
      <div className="v2-filter-controls" id="v2-filters" data-open={filtersOpen}
        ref={filterDrawer} role={filtersOpen && window.innerWidth < 768 ? "dialog" : undefined}
        aria-modal={filtersOpen && window.innerWidth < 768 ? true : undefined}
        aria-label={filtersOpen && window.innerWidth < 768 ? t("store.filters.title") : undefined}>
        <div className="v2-filter-drawer-top"><strong>{t("store.filters.title")}</strong>
          <button type="button" className="v2-filter-close" onClick={() => {
            setFiltersOpen(false); filterButton.current?.focus(); }} aria-label={t("common.close")}>×</button></div>
        <label>{t("store.sort.label")}
          <select value={filters.sort} onChange={(event) => apply({ sort: event.target.value as CatalogFilters["sort"] })}>
            {STOREFRONT_SORTS.map((key) => <option key={key} value={key}>{t(`store.sort.${key === "price_asc" ? "priceAsc" : key === "price_desc" ? "priceDesc" : key === "best_selling" ? "bestSelling" : key}`)}</option>)}
          </select>
        </label>
        <label>{t("store.filters.availability")}
          <select value={filters.availability} onChange={(event) => apply({ availability: event.target.value as CatalogFilters["availability"] })}>
            {(["any", "in_stock", "out_of_stock"] as const).map((key) =>
              <option key={key} value={key}>{t(`store.filters.availability.${key}`)}</option>)}</select>
        </label>
        {brandsFacet.length ? <label>{t("store.filters.brand")}
          <select value={filters.brand ?? ""} onChange={(event) => apply({ brand: event.target.value || null })}>
            <option value="">{t("common.all")}</option>
            {brandsFacet.map((brand) => <option key={brand.key} value={brand.key}>{brand.label}</option>)}
          </select>
        </label> : null}
        {colors.length ? <label>{t("store.filters.color")}
          <select value={filters.color ?? ""} onChange={(event) => apply({ color: event.target.value || null })}>
            <option value="">{t("common.all")}</option>
            {colors.map((color) => <option key={color.key} value={color.key}>{color.label}</option>)}
          </select></label> : null}
        {sizes.length ? <label>{t("store.filters.size")}
          <select value={sizeValue} onChange={(event) => {
            const choice = event.target.value;
            apply({ size: choice.startsWith("n:") ? Number(choice.slice(2)) : null,
              sizeLabel: choice.startsWith("l:") ? choice.slice(2) : null });
          }}><option value="">{t("common.all")}</option>
            {sizes.map((size) => <option key={size.value} value={size.value}>{size.label}</option>)}
          </select></label> : null}
        <form className="v2-price-filter" onSubmit={applyPrice}>
          <label>{t("store.filters.minPrice")}
            <input type="number" min="0" inputMode="decimal" value={minPrice}
              placeholder={priceRange ? money(priceRange.min) : undefined}
              onChange={(event) => setMinPrice(event.target.value)} /></label>
          <label>{t("store.filters.maxPrice")}
            <input type="number" min="0" inputMode="decimal" value={maxPrice}
              placeholder={priceRange ? money(priceRange.max) : undefined}
              onChange={(event) => setMaxPrice(event.target.value)} /></label>
          <button type="submit" className="v2-outline-button">{t("store.v2.apply")}</button>
        </form>
        <button type="button" aria-pressed={offered} className="v2-offer-filter" onClick={() => apply({}, !offered)}>
          {t("store.section.onSale")}{offered ? " ×" : " +"}</button>
        <button type="button" className="v2-clear-filters" onClick={clear}>{t("store.filters.clear")}</button>
        <button type="button" className="v2-filter-done v2-primary-button" onClick={() => {
          setFiltersOpen(false); filterButton.current?.focus(); }}>{t("store.v2.apply")}</button>
      </div>
    </div>
    {activeCount ? <div className="v2-active-filters" role="group" aria-label={t("store.v2.activeFilters")}>
      {filters.search ? <button type="button" onClick={() => apply({ search: "" })}>{filters.search} ×</button> : null}
      {filters.color ? <button type="button" onClick={() => apply({ color: null })}>{t("store.filters.color")}: {colors.find((item) => item.key === filters.color)?.label || filters.color} ×</button> : null}
      {sizeValue ? <button type="button" onClick={() => apply({ size: null, sizeLabel: null })}>{t("store.filters.size")}: {sizeValue.slice(2)} ×</button> : null}
      {offered ? <button type="button" onClick={() => apply({}, false)}>{t("store.section.onSale")} ×</button> : null}
      <button type="button" onClick={clear}>{t("store.filters.clear")}</button>
    </div> : null}
    {loading && products.length === 0 ? <V2State kind="loading" />
      : error && products.length === 0 ? <V2State kind="error" onRetry={() => void refresh()} />
        : results.length ? <V2ProductGrid>{results.map((entry, index) =>
          <V2ProductCard key={entry.product.id} entry={entry} filters={filters} priority={index < 2} />)}</V2ProductGrid>
          : <V2State kind="empty" />}
  </div>;
}
