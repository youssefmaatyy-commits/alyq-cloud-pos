import { useMemo } from "react";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { Badge } from "@/components/ui";
import { normalizeText } from "@/modules/products/services/productQuery";
import { usePos } from "../hooks/PosProvider";

/**
 * POS product grid — the left side of the register.
 * Optimised for speed: click to add, stock badge always visible, out-of-stock
 * cards disabled, and search runs over name (both languages), SKU and barcode.
 */

export function ProductGrid() {
  const { t, pick } = useI18n();
  const { products, addLine, addBySku, lines } = usePos();

  const [search, setSearch] = useSearchState();
  const [category, setCategory] = useCategoryState();

  const categoryOptions = useMemo(() => {
    const set = new Map<string, string>();
    for (const product of products) {
      if (!product.category_id) continue;
      set.set(product.category_id, prettyCategory(product.category_id));
    }
    return [...set.entries()];
  }, [products]);

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

  const inCart = (id: string) => lines.find((l) => l.product_id === id)?.qty ?? 0;

  return (
    <div className="flex h-full flex-col gap-3">
      {/* search bar — doubles as the scanner input */}
      <div className="flex gap-2">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={onSearchKeyDown}
          placeholder={t("pos.searchPlaceholder")}
          aria-label={t("pos.search")}
          className="h-11 flex-1 rounded-xl border border-slate-300 bg-white px-3 text-sm font-medium shadow-sm outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100"
        />
        {categoryOptions.length > 0 ? (
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            aria-label={t("products.category")}
            className="h-11 rounded-xl border border-slate-300 bg-white px-2 text-sm font-medium shadow-sm outline-none focus:border-indigo-500"
          >
            <option value="all">{`${t("products.category")}: ${t("common.all")}`}</option>
            {categoryOptions.map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </select>
        ) : null}
      </div>

      {/* grid */}
      <div className="grid flex-1 grid-cols-2 gap-2.5 overflow-y-auto pb-1 sm:grid-cols-3 xl:grid-cols-4">
        {filtered.map((product) => {
          const out = product.stock_quantity <= 0;
          const qty = inCart(product.id);
          return (
            <button
              key={product.id}
              type="button"
              disabled={out}
              onClick={() => addLine(product)}
              className={`group flex flex-col rounded-2xl border bg-white p-3 text-start shadow-sm transition focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-200 ${
                out
                  ? "cursor-not-allowed border-slate-200 opacity-60"
                  : "border-slate-200 hover:border-indigo-300 hover:shadow"
              }`}
            >
              <div className="mb-1.5 flex items-start justify-between gap-2">
                <span
                  className="flex h-11 w-11 items-center justify-center overflow-hidden rounded-xl bg-slate-100"
                  aria-hidden
                >
                  {product.image_url ? (
                    <img
                      src={product.image_url}
                      alt=""
                      loading="lazy"
                      className="h-full w-full object-cover"
                    />
                  ) : (
                    <span className="text-lg font-bold text-slate-400">
                      {pick(product.name_ar, product.name_en).charAt(0)}
                    </span>
                  )}
                </span>
                {qty > 0 ? (
                  <span className="flex h-6 min-w-6 items-center justify-center rounded-full bg-indigo-600 px-1.5 text-xs font-bold text-white">
                    {qty}
                  </span>
                ) : null}
              </div>
              <p className="line-clamp-2 min-h-[2.5em] text-xs font-semibold leading-snug text-slate-900">
                {pick(product.name_ar, product.name_en)}
              </p>
              <p className="mt-0.5 truncate font-mono text-[10px] text-slate-500">{product.sku}</p>
              <div className="mt-1.5 flex items-center justify-between gap-2">
                <span className="text-sm font-extrabold tabular-nums text-slate-900">
                  {product.selling_price.toFixed(2)}
                </span>
                {out ? (
                  <Badge tone="danger">{t("inventory.status.out")}</Badge>
                ) : product.stock_quantity <= product.low_stock_level ? (
                  <Badge tone="warning">
                    {t("inventory.status.low")} · {product.stock_quantity}
                  </Badge>
                ) : (
                  <span className="text-[11px] font-semibold text-slate-500 tabular-nums">
                    {product.stock_quantity}
                  </span>
                )}
              </div>
            </button>
          );
        })}

        {filtered.length === 0 ? (
          <div className="col-span-full flex h-40 items-center justify-center rounded-2xl border border-dashed border-slate-300 bg-white text-sm font-medium text-slate-500">
            {t("pos.noResults")}
          </div>
        ) : null}
      </div>
    </div>
  );

  function flashNotFound() {
    // brief shake + toast handled by parent via window event? Keep simple:
    // the empty grid already communicates "no match". This no-op keeps the
    // Enter handler honest.
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
