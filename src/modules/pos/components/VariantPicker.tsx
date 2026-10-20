import { useEffect, useMemo, useState } from "react";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { Button } from "@/components/ui";
import type { Product } from "@/modules/products/types";
import {
  isFreeSizeModel,
  modelNameOf,
  sizeLabelOf,
  variantGalleryOf,
  variantLabel,
  variantPrice,
  type ProductVariant,
} from "@/modules/products/variants";
import { usePos } from "../hooks/PosProvider";

/**
 * The colour-and-size picker, opened when a product that sells by variant is
 * tapped at the register.
 *
 * Three rules it exists to enforce, all of them about NOT guessing:
 *
 *   · the cashier always picks. A click on a variant product never adds the base
 *     product and never falls back to the first combination;
 *   · the grid is built from the product's ACTIVE variants, so an archived
 *     combination cannot be sold and a sold-out one is a disabled button rather
 *     than a line that fails at payment;
 *   · what is shown per combination is that combination's own stock, not a share
 *     of the product total — "Gold / 17 · 2" means two of THAT ring.
 */
export interface VariantPickerProps {
  product: Product;
  variants: ProductVariant[];
  /** Called after a combination was added, so the parent can close the sheet. */
  onPick: (variant: ProductVariant) => void;
  onClose: () => void;
}

export function VariantPicker({ product, variants, onPick, onClose }: VariantPickerProps) {
  const { t, lang } = useI18n();
  const { addLine, lines } = usePos();
  const [colorKey, setColorKey] = useState<string | null>(null);
  const [requestedQty, setRequestedQty] = useState<number>(1);

  const active = useMemo(() => variants.filter((v) => v.active), [variants]);

  // The colours this product is made in, in first-seen order, with their swatch.
  const colors = useMemo(() => {
    const seen = new Map<string, ProductVariant>();
    for (const variant of active) {
      if (!seen.has(variant.color_key)) seen.set(variant.color_key, variant);
    }
    return [...seen.entries()].map(([key, sample]) => ({ key, sample }));
  }, [active]);

  // Default to the first colour that still has stock, so the cashier is not
  // looking at an empty grid; they still have to choose the size.
  useEffect(() => {
    if (colorKey && colors.some((c) => c.key === colorKey)) return;
    const withStock = colors.find((c) => active.some((v) => v.color_key === c.key && v.stock_quantity > 0));
    setColorKey((withStock ?? colors[0])?.key ?? null);
  }, [colors, active, colorKey]);

  const sizes = useMemo(
    () => active.filter((v) => v.color_key === colorKey).sort((a, b) => (a.size ?? 0) - (b.size ?? 0)),
    [active, colorKey],
  );
  const inCart = (id: string) => lines.find((line) => line.variant_id === id)?.qty ?? 0;
  const hasColors = active.some((variant) => Boolean(variant.color_key));
  const modelsOnly = active.length > 0 && active.every((variant) => isFreeSizeModel(variant));
  const colorsOnly =
    !modelsOnly &&
    active.length > 0 &&
    active.every((variant) => variant.size === null && !variant.size_label);

  const pick = (variant: ProductVariant, count = 1) => {
    const remaining = Math.max(0, variant.stock_quantity - inCart(variant.id));
    if (!variant.active || remaining <= 0) return;
    const units = Math.max(1, Math.min(Math.trunc(count) || 1, remaining));
    let anyAdded = false;
    for (let i = 0; i < units; i += 1) {
      if (addLine(product, variant)) anyAdded = true;
    }
    if (anyAdded) {
      onPick(variant);
      onClose();
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t(modelsOnly ? "pos.variants.chooseModel" : "pos.variants.title")}
      data-testid="pos-variant-picker"
      className="fixed inset-0 z-40 flex items-end justify-center bg-slate-900/40 p-4 sm:items-center"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg rounded-2xl bg-white p-4 shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-3 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="truncate text-sm font-bold text-stone-900">
              {lang === "ar" ? product.name_ar : product.name_en}
            </p>
            <p className="mt-0.5 font-mono text-[11px] text-stone-500">
              {product.sku}
              {product.barcode && product.barcode !== product.sku ? ` (${product.barcode})` : ""} ·{" "}
              {t(modelsOnly ? "pos.variants.chooseModel" : "pos.variants.choose")}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("common.close")}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-stone-400 transition hover:bg-stone-100 hover:text-stone-700"
          >
            ×
          </button>
        </div>

        {/* Visual Model Picker: shared parent barcode, independent photo + stock per model. */}
        {modelsOnly && (
          <div data-testid="pos-model-picker">
            <div className="mb-3 flex items-center justify-between rounded-xl border border-stone-200 bg-stone-50 px-3 py-2" data-testid="pos-model-qty-stepper">
              <span className="text-xs font-bold text-stone-700">
                {t("pos.variants.selectQty")}
              </span>
              <div className="flex items-center gap-1.5" dir="ltr">
                <button
                  type="button"
                  data-testid="pos-model-qty-dec"
                  disabled={requestedQty <= 1}
                  onClick={() => setRequestedQty((q) => Math.max(1, q - 1))}
                  className="flex h-7 w-7 items-center justify-center rounded-lg border border-stone-300 bg-white text-sm font-bold text-stone-700 disabled:opacity-40"
                >
                  −
                </button>
                <input
                  type="number"
                  min={1}
                  data-testid="pos-model-qty-input"
                  value={requestedQty}
                  onChange={(e) => setRequestedQty(Math.max(1, Math.trunc(Number(e.target.value) || 1)))}
                  className="h-7 w-12 rounded-lg border border-stone-300 bg-white text-center text-xs font-bold tabular-nums text-stone-900"
                />
                <button
                  type="button"
                  data-testid="pos-model-qty-inc"
                  onClick={() => setRequestedQty((q) => q + 1)}
                  className="flex h-7 w-7 items-center justify-center rounded-lg border border-stone-300 bg-white text-sm font-bold text-stone-700"
                >
                  +
                </button>
              </div>
            </div>
            <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-stone-500">
              {t("pos.variants.model")}
            </p>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              {active.map((variant) => {
                const remaining = Math.max(0, variant.stock_quantity - inCart(variant.id));
                const out = remaining === 0;
                const photo = variantGalleryOf(variant)[0] ?? product.image_url;
                const label = modelNameOf(variant, lang) ?? variantLabel(variant, lang);
                return (
                  <button
                    key={variant.id}
                    type="button"
                    disabled={out}
                    onClick={() => pick(variant, requestedQty)}
                    data-testid={`pos-model-option-${variant.sku}`}
                    className={`flex flex-col items-center gap-1.5 rounded-xl border p-2.5 text-center transition ${
                      out
                        ? "cursor-not-allowed border-stone-200 bg-stone-50 text-stone-400"
                        : "border-stone-200 bg-white text-stone-900 hover:border-[#d4bf9a] hover:bg-[#faf5ec]"
                    }`}
                    aria-label={`${variantLabel(variant, lang)} — ${remaining}`}
                  >
                    {photo ? (
                      <img
                        src={photo}
                        alt={label}
                        className="h-20 w-full rounded-lg border border-stone-200 object-cover"
                      />
                    ) : (
                      <div className="flex h-20 w-full items-center justify-center rounded-lg border border-dashed border-stone-200 bg-stone-50 text-xs font-bold text-stone-400">
                        {label}
                      </div>
                    )}
                    <span className="w-full truncate text-sm font-bold">{label}</span>
                    <span className="font-mono text-[10px] text-stone-400" dir="ltr">
                      {variant.sku}
                    </span>
                    <span
                      data-testid={`pos-model-stock-${variant.sku}`}
                      className={`rounded-full px-2 py-0.5 text-[11px] font-bold tabular-nums ${
                        out
                          ? "bg-rose-50 text-rose-700"
                          : "bg-emerald-50 text-emerald-800"
                      }`}
                    >
                      {out
                        ? variant.stock_quantity === 0
                          ? t("pos.variants.soldOut")
                          : t("pos.variants.inCart")
                        : t("pos.variants.availableUnits", { count: remaining })}
                    </span>
                    <span className="text-[11px] font-semibold text-stone-600 tabular-nums" dir="ltr">
                      {variantPrice(variant, product).toFixed(2)} EGP
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Size-only products do not ask for an imaginary colour. */}
        {hasColors && <div className="mb-3">
          <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-stone-500">
            {t("pos.variants.color")}
          </p>
          <div className="flex flex-wrap gap-1.5">
            {colors.map(({ key, sample }) => {
              const stock = active
                .filter((v) => v.color_key === key)
                .reduce((sum, v) => sum + Math.max(0, v.stock_quantity - inCart(v.id)), 0);
              const selected = key === colorKey;
              return (
                <button
                  key={key}
                  type="button"
                  disabled={colorsOnly && stock === 0}
                  onClick={() => colorsOnly ? pick(sample) : setColorKey(key)}
                  className={`flex min-h-10 items-center gap-1.5 rounded-xl border px-2.5 py-1.5 text-xs font-semibold transition ${
                    selected
                      ? "border-indigo-400 bg-[#faf5ec] text-[#8a6a3d]"
                      : "border-stone-200 bg-white text-stone-700 hover:border-[#e5d5b8]"
                  } ${stock <= 0 ? "opacity-60" : ""}`}
                >
                  <span
                    aria-hidden
                    className="h-3.5 w-3.5 rounded-full border border-stone-300"
                    style={{ backgroundColor: sample.color_hex ?? "#e2e8f0" }}
                  />
                  {lang === "ar"
                    ? sample.color_ar || sample.color_en
                    : sample.color_en || sample.color_ar}
                  <span className="tabular-nums text-[10px] text-stone-500">{stock}</span>
                </button>
              );
            })}
          </div>
        </div>}

        {/* Only offered, active colour/size IDs are buttons; no inferred grid. */}
        {!modelsOnly && !colorsOnly && <div>
          <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-stone-500">
            {t("pos.variants.size")}
          </p>
          <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-4">
            {sizes.map((variant) => {
              const remaining = Math.max(0, variant.stock_quantity - inCart(variant.id));
              const out = remaining === 0;
              return (
                <button
                  key={variant.id}
                  type="button"
                  disabled={out}
                  onClick={() => pick(variant)}
                  className={`flex min-h-12 flex-col items-center rounded-xl border px-2 py-2 text-sm font-bold tabular-nums transition ${
                    out
                      ? "cursor-not-allowed border-stone-200 bg-stone-50 text-stone-400"
                      : "border-stone-200 bg-white text-stone-900 hover:border-[#d4bf9a] hover:bg-[#faf5ec]"
                  }`}
                  aria-label={`${variantLabel(variant, lang)} — ${remaining}`}
                >
                  <span>{sizeLabelOf(variant.size, variant.size_label) || variantLabel(variant, lang)}</span>
                  <span className="mt-0.5 text-[10px] font-semibold text-stone-500">
                    {out ? (variant.stock_quantity === 0 ? t("pos.variants.soldOut") : t("pos.variants.inCart")) : remaining}
                  </span>
                  {variant.price_override !== null ? (
                    <span className="mt-0.5 text-[10px] font-medium text-stone-500 tabular-nums">
                      {variantPrice(variant, product).toFixed(2)}
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
          {sizes.length === 0 ? (
            <p className="rounded-xl border border-dashed border-stone-200 bg-stone-50 px-3 py-4 text-center text-xs font-medium text-stone-500">
              {t("pos.variants.none")}
            </p>
          ) : null}
        </div>}

        <div className="mt-4 flex justify-end">
          <Button variant="secondary" size="sm" onClick={onClose}>
            {t("common.cancel")}
          </Button>
        </div>
      </div>
    </div>
  );
}
