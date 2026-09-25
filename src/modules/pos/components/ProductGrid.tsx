import { useEffect, useMemo, useState } from "react";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { Badge, useToast } from "@/components/ui";
import { normalizeText } from "@/modules/products/services/productQuery";
import { useCatalog } from "@/modules/products/hooks/CatalogProvider";
import {
  categoryNameIndex,
  sellableCategoryFilterIds,
} from "@/modules/products/services/categoryTree";
import { usePos } from "../hooks/PosProvider";
import { VariantPicker } from "./VariantPicker";

/**
 * POS product grid — the left side of the register.
 * Optimised for speed: click to add, stock badge always visible, out-of-stock
 * cards disabled, and search runs over name (both languages), SKU and barcode.
 */

export function ProductGrid() {
  const { t, pick } = useI18n();
  const toast = useToast();
  const { products, addLine, addBySku, lines, variantsOf } = usePos();
  // Phase 44: the register's filter chips come from the category table, not
  // from the products — so an ARCHIVED category leaves the shelf labels even
  // while its products keep selling (products are never auto-archived).
  const { categories } = useCatalog();
  // The product whose combinations the cashier is choosing between, if any.
  const [picking, setPicking] = useState<string | null>(null);

  const [search, setSearch] = useSearchState();
  const [category, setCategory] = useCategoryState();

  const categoryLabels = useMemo(() => categoryNameIndex(categories, pick), [categories, pick]);

  const categoryOptions = useMemo(() => {
    const set = new Map<string, string>();
    const activeIds = sellableCategoryFilterIds(categories);
    for (const product of products) {
      if (!product.category_id) continue;
      // An archived category's products stay sellable but the shelf itself is
      // gone; without a live label the id would leak as raw text anyway.
      if (!activeIds.has(product.category_id)) continue;
      set.set(
        product.category_id,
        categoryLabels.get(product.category_id) ?? prettyCategory(product.category_id),
      );
    }
    return [...set.entries()];
  }, [products, categories, categoryLabels]);

  // A filter pointing at a category that has since been archived resets
  // itself — the register never sits on a shelf that no longer exists.
  useEffect(() => {
    if (category !== "all" && !categoryOptions.some(([id]) => id === category)) {
      setCategory("all");
    }
  }, [category, categoryOptions, setCategory]);

  const filtered = useMemo(() => {
    const needle = normalizeText(search);
    const terms = needle ? needle.split(" ") : [];
    return products.filter((product) => {
      // POS sells stock-tracked, active products only.
      if (!product.active || !product.stock_tracking_enabled) return false;
      if (category !== "all" && product.category_id !== category) return false;
      if (terms.length > 0) {
        const haystack = normalizeText(
          [product.name_ar, product.name_en, product.sku, product.barcode ?? ""].join(" \u0001 "),
        );
        for (const term of terms) {
          if (!haystack.includes(term)) return false;
        }
      }
      return true;
    });
  }, [products, search, category]);

  // Scan-to-add: typing a code + Enter in the search box adds it to the cart.
  const onSearchKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter") return;
    const code = search.trim();
    if (!code) return;
    const added = addBySku(code);
    if (added) {
      setSearch("");
    } else {
      flashNotFound();
    }
  };

  // Every combination of the product counts towards its badge, so "2 on the
  // ticket" is honest even when they are two different sizes.
  const inCart = (id: string) =>
    lines.filter((l) => l.product_id === id).reduce((sum, l) => sum + l.qty, 0);

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col gap-3">
      {/* search bar — doubles as the scanner input */}
      <div className="flex min-w-0 gap-2">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={onSearchKeyDown}
          placeholder={t("pos.searchPlaceholder")}
          aria-label={t("pos.search")}
          className="h-11 min-w-0 flex-1 rounded-xl border border-stone-200 bg-white px-3 text-sm font-medium shadow-sm outline-none transition focus:border-stone-500 focus:ring-2 focus:ring-stone-900/10"
        />
      </div>

      {/* Category chips wrap instead of becoming an invisible horizontal
          scrollbar on narrow tills. The same sellable-shelf rules still apply. */}
      {categoryOptions.length > 0 ? (
        <div className="flex min-w-0 flex-wrap gap-1.5 pb-0.5" role="group" aria-label={t("products.category")}>
          <button
            type="button"
            aria-pressed={category === "all"}
            data-testid="pos-category-chip-all"
            onClick={() => setCategory("all")}
            className={`min-h-8 max-w-full rounded-full px-3.5 py-1 text-xs font-bold break-words transition ${
              category === "all"
                ? "bg-stone-900 text-[#f3ede1]"
                : "border border-stone-200 bg-white text-stone-600 hover:border-stone-400"
            }`}
          >
            {t("common.all")}
          </button>
          {categoryOptions.map(([id, label]) => (
            <button
              key={id}
              type="button"
              aria-pressed={category === id}
              data-testid={`pos-category-chip-${id}`}
              onClick={() => setCategory(id)}
              className={`min-h-8 max-w-full rounded-full px-3.5 py-1 text-xs font-bold break-words transition ${
                category === id
                  ? "bg-stone-900 text-[#f3ede1]"
                  : "border border-stone-200 bg-white text-stone-600 hover:border-stone-400"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      ) : null}

      {/* Auto-fill uses the PRODUCT PANE width, not the viewport: three useful
          cards alongside the cart at 1366px, four at 1920px, and fewer if the
          sidebar/zoom/RTL labels need more room. No horizontal carousel. On
          desktop, contain the list's overscroll; on tablet the list is auto-
          height, so trapping overscroll would prevent wheel-scrolling the page. */}
      <div
        className="grid min-h-0 min-w-0 flex-1 content-start gap-2.5 overflow-y-auto pb-1 lg:overscroll-y-contain"
        style={{ gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 11rem), 1fr))" }}
        data-testid="pos-grid"
      >
        {filtered.map((product) => {
          // A variant product is never "out" because the rollup says so — it is
          // out when no active combination has stock left.
          const combinations = variantsOf(product.id);
          const sellsByVariant = product.variants_enabled;
          const sellable = combinations.filter((v) => v.active && v.stock_quantity > 0);
          const out = sellsByVariant ? sellable.length === 0 : product.stock_quantity <= 0;
          const totalUnits = sellsByVariant
            ? combinations.filter((v) => v.active).reduce((sum, v) => sum + v.stock_quantity, 0)
            : product.stock_quantity;
          const qty = inCart(product.id);
          return (
            <button
              key={product.id}
              type="button"
              data-testid={`pos-product-${product.id}`}
              disabled={out}
              onClick={() => {
                // A variant product opens the picker; the register never chooses
                // a colour or a size for the cashier.
                if (sellsByVariant) setPicking(product.id);
                else addLine(product);
              }}
              className={`group flex min-w-0 flex-col rounded-2xl border bg-white p-3 text-start shadow-sm transition focus:outline-none focus-visible:ring-2 focus-visible:ring-stone-900/20 ${
                out
                  ? "cursor-not-allowed border-stone-200 opacity-60"
                  : "border-stone-200/80 hover:border-[#b08d57] hover:shadow-md"
              }`}
            >
              <div className="relative mb-2 flex h-20 items-center justify-center overflow-hidden rounded-xl bg-[#faf7f2]">
                {product.image_url ? (
                  <img
                    src={product.image_url}
                    alt=""
                    loading="lazy"
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <span className="text-2xl font-black text-[#d8c7a7]">
                    {pick(product.name_ar, product.name_en).charAt(0)}
                  </span>
                )}
                {qty > 0 ? (
                  <span className="absolute end-1.5 top-1.5 flex h-6 min-w-6 items-center justify-center rounded-full bg-stone-900 px-1.5 text-xs font-bold text-white ring-2 ring-white">
                    {qty}
                  </span>
                ) : null}
              </div>
              <p className="line-clamp-2 min-h-[2.5em] min-w-0 break-words text-xs font-semibold leading-snug text-stone-900">
                {pick(product.name_ar, product.name_en)}
              </p>
              <p className="mt-0.5 min-w-0 break-all font-mono text-[10px] text-stone-500">{product.sku}</p>
              {/* A long price or Arabic stock badge wraps to its own line rather
                  than setting a minimum width for the entire card/checkout. */}
              <div className="mt-1.5 flex min-w-0 flex-wrap items-center justify-between gap-x-2 gap-y-0.5">
                <span className="min-w-0 break-all text-sm font-extrabold tabular-nums text-stone-900" data-testid="pos-product-price" dir="ltr">
                  {(sellsByVariant && sellable[0]?.price_override != null
                    ? sellable[0].price_override
                    : product.selling_price
                  ).toFixed(2)}
                </span>
                <span className="min-w-0 max-w-full text-[11px] font-semibold text-stone-500 tabular-nums" data-testid="pos-product-stock">
                  {out ? (
                    <Badge tone="danger" className="max-w-full break-words text-start">{t("inventory.status.out")}</Badge>
                  ) : sellsByVariant && sellable.some((v) => v.stock_quantity <= v.low_stock_level) ? (
                    <Badge tone="warning" className="max-w-full break-words text-start">
                      {t("inventory.status.low")} · {totalUnits}
                    </Badge>
                  ) : (
                    sellsByVariant ? `${sellable.length}/${combinations.filter((v) => v.active).length}` : totalUnits
                  )}
                </span>
              </div>
              {sellsByVariant ? (
                <p className="mt-1 min-w-0 break-words text-[10px] font-bold uppercase tracking-wide text-[#8a6a3b]" data-testid="pos-variant-hint">
                  {t("pos.variants.hint")}
                </p>
              ) : null}
              {!out ? (
                <span className="mt-auto max-w-full break-words pt-2 text-[11px] font-bold text-[#8a6a3b]" data-testid="pos-product-action">
                  {sellsByVariant ? t("pos.variants.choose") : t("common.add")}
                </span>
              ) : null}
            </button>
          );
        })}

        {picking ? (
          <VariantPicker
            product={products.find((p) => p.id === picking) as (typeof products)[number]}
            variants={variantsOf(picking)}
            onPick={() => setPicking(null)}
            onClose={() => setPicking(null)}
          />
        ) : null}

        {filtered.length === 0 ? (
          <div className="col-span-full flex h-40 items-center justify-center rounded-2xl border border-dashed border-stone-300 bg-white text-sm font-medium text-stone-500">
            {t("pos.noResults")}
          </div>
        ) : null}
      </div>
    </div>
  );

  function flashNotFound() {
    toast.error(t("pos.codeUnavailable"));
  }
}

// ── local search/category state (kept in the grid so the cart never resets) ──
import { useState as useReactState } from "react";
function useSearchState() {
  return useReactState("");
}
function useCategoryState() {
  return useReactState("all");
}

function prettyCategory(id: string): string {
  return id
    .replace(/^cat-/, "")
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}
