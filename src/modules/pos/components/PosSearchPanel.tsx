import { useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { Badge, useToast } from "@/components/ui";
import type { Product } from "@/modules/products/types";
import { variantPrice } from "@/modules/products/variants";
import { usePos } from "../hooks/PosProvider";
import { VariantPicker } from "./VariantPicker";
import { POS_SEARCH_RESULT_CAP, matchPosProducts } from "../services/posSearch";

/**
 * Scan/search-first register workspace — the left side of the till.
 *
 * The browsable product-card grid is gone on purpose: the cashier scans a
 * barcode or types a name, SKU or product code, picks the exact row and the
 * item lands in the cart. One prominent input, one compact result list.
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
  const { t, pick } = useI18n();
  const toast = useToast();
  const { products, variants, addLine, addBySku, lines, variantsOf } = usePos();

  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  // The product whose combinations the cashier is choosing between, if any.
  const [picking, setPicking] = useState<string | null>(null);

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

  return (
    <div className="flex min-h-0 min-w-0 flex-col gap-3 lg:h-full lg:rounded-[1.75rem] lg:border lg:border-stone-200 lg:bg-white/55 lg:p-4 lg:shadow-sm xl:gap-4 xl:p-5">
      {/* The one scan/search input — prominent, focused on arrival. */}
      <div className="relative min-w-0 lg:shrink-0">
        <span
          aria-hidden
          className="pointer-events-none absolute start-3 top-1/2 -translate-y-1/2 text-xl lg:start-4 lg:text-2xl"
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
          className="h-14 min-w-0 w-full rounded-2xl border border-stone-300 bg-white py-2 pe-4 ps-12 text-base font-semibold shadow-sm outline-none transition placeholder:font-medium placeholder:text-stone-400 focus:border-stone-500 focus:ring-2 focus:ring-stone-900/10 lg:h-16 lg:rounded-[1.35rem] lg:pe-5 lg:ps-14 lg:text-lg"
        />
      </div>

      {listVisible ? (
        shown.length > 0 ? (
          <div
            ref={listRef}
            id="pos-search-results"
            role="listbox"
            aria-label={t("pos.scanSearchResults")}
            data-testid="pos-search-results"
            className="min-h-0 min-w-0 overflow-y-auto rounded-2xl border border-stone-200 bg-white shadow-sm lg:rounded-[1.25rem]"
            style={{ maxHeight: "min(32rem, calc(100dvh - 22rem))" }}
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
                      className={`flex w-full min-w-0 items-center gap-3 px-3 py-2.5 text-start transition focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-stone-900/20 lg:px-4 lg:py-3 ${
                        out
                          ? "cursor-not-allowed opacity-60"
                          : selected
                            ? "bg-[#faf5ec]"
                            : "bg-white hover:bg-stone-50"
                      }`}
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block min-w-0 truncate text-sm font-bold text-stone-900 lg:text-base">
                          {pick(product.name_ar, product.name_en)}
                        </span>
                        <span className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
                          <span className="min-w-0 break-all font-mono text-[11px] text-stone-500">
                            {product.sku}
                          </span>
                          {sellsByVariant ? (
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
            className="flex min-h-24 items-center justify-center rounded-2xl border border-dashed border-stone-300 bg-white px-4 py-6 text-center text-sm font-medium text-stone-500 lg:min-h-40 lg:rounded-[1.25rem]"
          >
            {t("pos.noResults")}
          </div>
        )
      ) : (
        <div
          data-testid="pos-search-empty"
          className="flex min-h-56 flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-stone-300 bg-white/60 px-6 py-10 text-center lg:min-h-[24rem] lg:rounded-[1.25rem] xl:min-h-[28rem]"
        >
          <span aria-hidden className="text-4xl lg:text-5xl">
            📷
          </span>
          <p className="max-w-2xl text-sm font-semibold text-stone-600 lg:text-base">{t("pos.scanSearchHint")}</p>
        </div>
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
    </div>
  );
}
