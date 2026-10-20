import { useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { Badge, useToast } from "@/components/ui";
import type { Product } from "@/modules/products/types";
import { variantLabel, variantPrice } from "@/modules/products/variants";
import { usePos } from "../hooks/PosProvider";
import { VariantPicker } from "./VariantPicker";
import { ProductThumb } from "./ProductThumb";
import { CameraBarcodeScannerModal } from "./CameraBarcodeScannerModal";
import { POS_SEARCH_RESULT_CAP, matchPosProducts } from "../services/posSearch";

/**
 * Catalog + scan register workspace — the product side of the till.
 *
 * A cashier can still scan/type a name, SKU or product code with the same
 * keyboard flow, while the empty search state exposes category chips and
 * dense product cards for touch/laptop browsing. Both paths call the existing
 * add/variant APIs; this component is presentation, not a second POS engine.
 *
 * The rules it keeps from the grid era:
 *
 *   · adding goes through the existing `addBySku` / `addLine` flow only, so
 *     stock checks, price overrides, inventory limits and variant identity are
 *     exactly what they were;
 *   · an exact barcode/SKU/Enter resolves a variant's OWN code first (its
 *     exact UUID lands in the cart), then a plain product — and never an
 *     arbitrary combination of a variant product;
 *   · a variant product opens the existing VariantPicker: the register never
 *     chooses a colour or a size for the cashier;
 *   · out-of-stock rows are disabled buttons, not lines that fail at payment.
 *
 * The input stops Enter from propagating to the page-wide scanner listener:
 * a scan typed into this focused box is already added here, and without the
 * stop the global handler would add the same code a second time.
 */
export function PosSearchPanel() {
  const { t, pick, lang } = useI18n();
  const toast = useToast();
  const { products, categories, variants, addLine, addBySku, lines, variantsOf } = usePos();

  const [query, setQuery] = useState("");
  const [activeCategoryId, setActiveCategoryId] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  // The product whose combinations the cashier is choosing between, if any.
  const [picking, setPicking] = useState<string | null>(null);
  const [cameraOpen, setCameraOpen] = useState(false);

  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const hits = useMemo(
    () => matchPosProducts(products, variants, query),
    [products, variants, query],
  );
  const shown = useMemo(() => hits.slice(0, POS_SEARCH_RESULT_CAP), [hits]);
  const remainder = hits.length - shown.length;
  const trimmed = query.trim();
  const listVisible = open && trimmed.length > 0;
  const visibleCategories = useMemo(
    () => categories.filter((category) => products.some((product) => product.category_id === category.id)),
    [categories, products],
  );
  const browseProducts = useMemo(
    () => products
      .filter((product) => !activeCategoryId || product.category_id === activeCategoryId)
      .slice(0, 80),
    [activeCategoryId, products],
  );

  // The highlight follows the list: typing resets it, arrows move it, and the
  // row it lands on is scrolled into view inside the dropdown only.
  useEffect(() => {
    if (!listVisible || activeIndex < 0) return;
    const row = listRef.current?.querySelector<HTMLElement>(
      `[data-pos-result-index="${activeIndex}"]`,
    );
    if (row && typeof row.scrollIntoView === "function") {
      row.scrollIntoView({ block: "nearest" });
    }
  }, [listVisible, activeIndex]);

  // Every combination of the product counts, so the chip is honest even when
  // the units are two different sizes.
  const inSale = (id: string) =>
    lines.filter((line) => line.product_id === id).reduce((sum, line) => sum + line.qty, 0);

  const afterAdd = () => {
    setQuery("");
    setOpen(false);
    setActiveIndex(-1);
    // The next scan starts immediately — no click needed between items.
    inputRef.current?.focus();
  };

  const activate = (product: Product) => {
    // A variant product opens the picker; the register never chooses a
    // colour or a size for the cashier.
    if (product.variants_enabled) {
      setPicking(product.id);
      return;
    }
    if (addLine(product)) {
      afterAdd();
    } else {
      toast.error(t("pos.codeUnavailable"));
    }
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (!listVisible || shown.length === 0) return;
      event.preventDefault();
      setActiveIndex((current) => {
        if (event.key === "ArrowDown") return Math.min(current + 1, shown.length - 1);
        return current <= 0 ? 0 : current - 1;
      });
      return;
    }
    if (event.key === "Escape") {
      setOpen(false);
      setActiveIndex(-1);
      return;
    }
    if (event.key !== "Enter") return;
    // Handled here, so the page-wide scanner listener must not see it: the
    // code below is added (or refused with its own message) exactly once.
    event.preventDefault();
    event.stopPropagation();
    const code = query.trim();
    if (!code) return;
    // An exact barcode/SKU/product code adds the exact matching item or
    // variant directly — `addBySku` resolves a variant's own code first.
    if (addBySku(code)) {
      afterAdd();
      return;
    }
    // Not an exact code: Enter acts on the visible matches, and only when
    // the choice is unambiguous — a single match, or the highlighted row.
    // Multiple matches with nothing highlighted stay open; nothing is added.
    if (shown.length === 1) {
      activate(shown[0].product);
      return;
    }
    if (activeIndex >= 0 && activeIndex < shown.length) {
      activate(shown[activeIndex].product);
      return;
    }
    if (shown.length > 1) {
      setOpen(true);
      return;
    }
    toast.error(t("pos.codeUnavailable"));
  };

  const pickingProduct = picking ? products.find((p) => p.id === picking) ?? null : null;

  const handleCameraScan = (rawCode: string) => {
    const code = rawCode.trim();
    if (!code) return;
    if (addBySku(code)) {
      afterAdd();
      return;
    }
    const matches = matchPosProducts(products, variants, code);
    if (matches.length === 1) {
      activate(matches[0].product);
      return;
    }
    if (matches.length > 1) {
      setQuery(code);
      setOpen(true);
      setActiveIndex(0);
      return;
    }
    toast.error(t("pos.codeUnavailable"));
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-col gap-3">
      {/* The one scan/search input — prominent, focused on arrival. */}
      <div className="relative min-w-0">
        <span
          aria-hidden
          className="pointer-events-none absolute start-3 top-1/2 -translate-y-1/2 text-xl"
        >
          📷
        </span>
        <input
          ref={inputRef}
          value={query}
          autoFocus
          role="combobox"
          aria-expanded={listVisible}
          aria-controls="pos-search-results"
          aria-activedescendant={
            listVisible && activeIndex >= 0 && shown[activeIndex]
              ? `pos-result-option-${shown[activeIndex].product.id}`
              : undefined
          }
          aria-label={t("pos.scanSearch")}
          placeholder={t("pos.scanSearchPlaceholder")}
          data-testid="pos-scan-search"
          onChange={(event) => {
            setQuery(event.target.value);
            setOpen(true);
            setActiveIndex(-1);
          }}
          onFocus={() => {
            if (query.trim()) setOpen(true);
          }}
          onKeyDown={onKeyDown}
          className="h-12 min-w-0 w-full rounded-2xl border border-stone-300 bg-white py-2 pe-24 ps-11 text-[15px] font-semibold shadow-sm outline-none transition placeholder:font-medium placeholder:text-stone-400 focus:border-stone-500 focus:ring-2 focus:ring-stone-900/10"
        />
        <button
          type="button"
          onClick={() => setCameraOpen(true)}
          data-testid="pos-camera-scan-btn"
          aria-label={lang === "ar" ? "مسح الباركود بالكاميرا" : "Scan barcode with camera"}
          className="absolute end-1.5 top-1/2 inline-flex h-9 -translate-y-1/2 items-center gap-1 rounded-xl bg-stone-900 px-2.5 text-xs font-bold text-[#f3ede1] shadow-xs transition hover:bg-stone-800"
        >
          <span aria-hidden>📷</span>
          <span>{lang === "ar" ? "مسح" : "Scan"}</span>
        </button>
      </div>

      {listVisible ? (
        shown.length > 0 ? (
          <div
            ref={listRef}
            id="pos-search-results"
            role="listbox"
            aria-label={t("pos.scanSearchResults")}
            data-testid="pos-search-results"
            className="min-h-0 min-w-0 overflow-y-auto rounded-2xl border border-stone-200 bg-white shadow-sm"
            style={{ maxHeight: "min(24rem, calc(100dvh - 24rem))" }}
          >
            <ul className="min-w-0 divide-y divide-stone-100">
              {shown.map((hit, index) => {
                const product = hit.product;
                // A variant product is never "out" because the rollup says
                // so — it is out when no active combination has stock left.
                const combinations = variantsOf(product.id);
                const sellsByVariant = product.variants_enabled;
                const activeCombos = combinations.filter((v) => v.active);
                const sellable = activeCombos.filter((v) => v.stock_quantity > 0);
                const out = sellsByVariant ? sellable.length === 0 : product.stock_quantity <= 0;
                const totalUnits = sellsByVariant
                  ? activeCombos.reduce((sum, v) => sum + v.stock_quantity, 0)
                  : product.stock_quantity;
                const selected = index === activeIndex;
                const count = inSale(product.id);
                // When the query names a combination's OWN code (SKU or
                // barcode), the row says exactly which shelf that code is —
                // informational only: adding still goes through `addBySku`
                // (Enter) or the picker (click), never a fabricated choice.
                const wanted = query.trim().toUpperCase();
                const exactVariant = wanted
                  ? activeCombos.find(
                      (v) =>
                        v.sku.toUpperCase() === wanted ||
                        (v.barcode ?? "").toUpperCase() === wanted,
                    ) ?? null
                  : null;
                return (
                  <li key={product.id} className="min-w-0">
                    <button
                      type="button"
                      role="option"
                      aria-selected={selected}
                      id={`pos-result-option-${product.id}`}
                      data-testid={`pos-result-${product.id}`}
                      data-pos-result-index={index}
                      disabled={out}
                      onClick={() => activate(product)}
                      onMouseEnter={() => setActiveIndex(index)}
                      className={`flex w-full min-w-0 items-center gap-3 px-3 py-2.5 text-start transition focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-stone-900/20 ${
                        out
                          ? "cursor-not-allowed opacity-60"
                          : selected
                            ? "bg-[#faf5ec]"
                            : "bg-white hover:bg-stone-50"
                      }`}
                    >
                      <ProductThumb
                        url={product.image_url}
                        name={pick(product.name_ar, product.name_en)}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block min-w-0 truncate text-sm font-bold text-stone-900">
                          {pick(product.name_ar, product.name_en)}
                        </span>
                        <span className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
                          <span className="min-w-0 break-all font-mono text-[11px] text-stone-500">
                            {product.sku}
                          </span>
                          {exactVariant ? (
                            <span className="text-[10px] font-bold text-[#8a6a3b]" dir="auto">
                              {variantLabel(exactVariant, lang)} · {exactVariant.sku}
                            </span>
                          ) : sellsByVariant ? (
                            <span className="text-[10px] font-bold uppercase tracking-wide text-[#8a6a3b]">
                              {t("pos.variants.hint")}
                            </span>
                          ) : null}
                        </span>
                      </span>
                      <span className="flex shrink-0 items-center gap-2">
                        {count > 0 ? (
                          <span
                            aria-label={t("pos.scanSearchInSale", { count })}
                            title={t("pos.scanSearchInSale", { count })}
                            className="grid h-6 min-w-6 place-items-center rounded-full bg-stone-900 px-1.5 text-xs font-bold tabular-nums text-white"
                          >
                            {count}
                          </span>
                        ) : null}
                        <span
                          className="min-w-0 text-xs font-semibold tabular-nums text-stone-500"
                          data-testid={`pos-result-stock-${product.id}`}
                        >
                          {out ? (
                            <Badge tone="danger">{t("inventory.status.out")}</Badge>
                          ) : sellsByVariant &&
                            sellable.some((v) => v.stock_quantity <= v.low_stock_level) ? (
                            <Badge tone="warning">
                              {t("inventory.status.low")} · {totalUnits}
                            </Badge>
                          ) : sellsByVariant ? (
                            `${sellable.length}/${activeCombos.length}`
                          ) : (
                            totalUnits
                          )}
                        </span>
                        <span
                          className="min-w-16 text-end text-sm font-extrabold tabular-nums text-stone-900"
                          data-testid={`pos-result-price-${product.id}`}
                          dir="ltr"
                        >
                          {(sellsByVariant && sellable[0]?.price_override != null
                            ? variantPrice(sellable[0], product)
                            : product.selling_price
                          ).toFixed(2)}
                        </span>
                        {/* The row IS the add action; the tile says so. */}
                        <span
                          aria-hidden
                          className="grid h-8 w-8 place-items-center rounded-xl bg-stone-900 text-base font-bold leading-none text-[#f3ede1]"
                        >
                          +
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
            {remainder > 0 ? (
              <p className="border-t border-stone-100 px-3 py-2 text-center text-xs font-semibold text-stone-500">
                {t("pos.scanSearchMore", { count: remainder })}
              </p>
            ) : null}
          </div>
        ) : (
          <div
            data-testid="pos-search-no-results"
            className="flex min-h-24 items-center justify-center rounded-2xl border border-dashed border-stone-300 bg-white px-4 py-6 text-center text-sm font-medium text-stone-500"
          >
            {t("pos.noResults")}
          </div>
        )
      ) : (
        <section data-testid="pos-catalog" className="min-h-0 rounded-2xl border border-stone-200 bg-stone-50/70 p-3 shadow-sm lg:flex lg:flex-1 lg:flex-col">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div>
              <h2 className="text-sm font-black text-stone-900">{t("pos.catalog")}</h2>
              <p className="text-xs font-medium text-stone-500">{t("pos.scanSearchHint")}</p>
            </div>
            <span className="rounded-full bg-white px-2.5 py-1 text-xs font-bold tabular-nums text-stone-600 ring-1 ring-stone-200">
              {browseProducts.length}
            </span>
          </div>
          {visibleCategories.length ? <div className="mb-3 flex gap-2 overflow-x-auto pb-1" role="tablist" aria-label={t("pos.catalog")}>
            <button type="button" role="tab" aria-selected={activeCategoryId === null}
              onClick={() => setActiveCategoryId(null)}
              className={`shrink-0 rounded-xl px-3 py-2 text-xs font-bold transition ${activeCategoryId === null ? "bg-stone-900 text-[#f3ede1]" : "bg-white text-stone-600 ring-1 ring-stone-200 hover:bg-stone-100"}`}>
              {t("pos.allCategories")}
            </button>
            {visibleCategories.map((category) => <button key={category.id} type="button" role="tab"
              aria-selected={activeCategoryId === category.id} onClick={() => setActiveCategoryId(category.id)}
              className={`shrink-0 rounded-xl px-3 py-2 text-xs font-bold transition ${activeCategoryId === category.id ? "bg-stone-900 text-[#f3ede1]" : "bg-white text-stone-600 ring-1 ring-stone-200 hover:bg-stone-100"}`}>
              {pick(category.name_ar, category.name_en)}
            </button>)}
          </div> : null}
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-4 lg:min-h-0 lg:flex-1 lg:content-start lg:overflow-y-auto lg:pe-1">
            {browseProducts.map((product) => {
              const combinations = variantsOf(product.id);
              const activeCombos = combinations.filter((variant) => variant.active);
              const sellable = activeCombos.filter((variant) => variant.stock_quantity > 0);
              const sellsByVariant = product.variants_enabled;
              const out = sellsByVariant ? sellable.length === 0 : product.stock_quantity <= 0;
              const stock = sellsByVariant ? activeCombos.reduce((sum, variant) => sum + variant.stock_quantity, 0) : product.stock_quantity;
              const price = sellsByVariant && sellable[0]?.price_override != null
                ? variantPrice(sellable[0], product) : product.selling_price;
              const count = inSale(product.id);
              return <article key={product.id} className={`group relative min-w-0 overflow-hidden rounded-xl border bg-white ${out ? "border-stone-200 opacity-55" : "border-stone-200 shadow-sm"}`}>
                <button type="button" disabled={out} onClick={() => activate(product)}
                  data-testid={`pos-catalog-product-${product.id}`}
                  className="flex h-full w-full min-w-0 flex-col text-start focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-stone-900">
                  <div className="relative aspect-[4/3] w-full overflow-hidden bg-stone-100">
                    {product.image_url ? <img src={product.image_url} alt="" className="h-full w-full object-cover" /> : <div className="grid h-full place-items-center text-3xl text-stone-300" aria-hidden>◇</div>}
                    {count > 0 ? <span className="absolute end-2 top-2 grid h-6 min-w-6 place-items-center rounded-full bg-stone-900 px-1 text-xs font-bold text-white">{count}</span> : null}
                    {out ? <span className="absolute inset-x-2 bottom-2 rounded-md bg-stone-900/80 px-1.5 py-1 text-center text-[10px] font-bold text-white">{t("inventory.status.out")}</span> : null}
                  </div>
                  <span className="flex min-w-0 flex-1 flex-col p-2.5">
                    <strong className="line-clamp-2 text-xs leading-5 text-stone-900">{pick(product.name_ar, product.name_en)}</strong>
                    <span className="mt-1 truncate font-mono text-[10px] text-stone-500">{product.sku}</span>
                    <span className="mt-auto flex items-end justify-between gap-1 pt-2">
                      <bdi dir="ltr" className="text-sm font-black tabular-nums text-stone-900">{price.toFixed(2)}</bdi>
                      <span className="text-[10px] font-bold text-stone-500">{sellsByVariant ? `${sellable.length}/${activeCombos.length}` : stock}</span>
                    </span>
                  </span>
                </button>
              </article>;
            })}
          </div>
        </section>
      )}

      {pickingProduct ? (
        <VariantPicker
          product={pickingProduct}
          variants={variantsOf(pickingProduct.id)}
          onPick={() => afterAdd()}
          onClose={() => {
            setPicking(null);
            inputRef.current?.focus();
          }}
        />
      ) : null}

      {cameraOpen ? (
        <CameraBarcodeScannerModal
          onScan={handleCameraScan}
          onClose={() => {
            setCameraOpen(false);
            inputRef.current?.focus();
          }}
        />
      ) : null}
    </div>
  );
}
