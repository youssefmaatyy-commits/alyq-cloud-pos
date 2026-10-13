/**
 * The storefront combination picker — colour first, then NUMERIC size.
 *
 * One row of colour swatches (or colour names, when the shop never gave a hex),
 * each opening that colour's sizes in numeric order — 16 → 16.5 → 17 → 17.5, as
 * numbers, because "17" sorting before "16.5" is a string sort's mistake and a
 * shopper's confusion. Every size chip states its own shelf: sold-out stays
 * visible but unbuyable, because "we ran out of 17" is information while a
 * quietly missing button is a bug report waiting to happen.
 *
 * Nothing is preselected. A silent default is the web's version of the register
 * picking a colour for the cashier: the customer says which one they want.
 */
import { useI18n } from "@/lib/i18n/I18nProvider";
import { cn } from "@/utils/cn";
import type { StoreVariant, StoreVariantColorGroup } from "../../services/pricing";
import { modelNameOf, storeSizeLabel, variantColorLabel } from "../../services/variantLabel";
import { isFreeSizeStoreVariant, storeVariantPicture } from "../../services/variantModels";

export function VariantPicker({
  groups,
  chosenColorKey,
  chosenVariantId,
  availableOf,
  onColor,
  onVariant,
}: {
  groups: readonly StoreVariantColorGroup[];
  chosenColorKey: string | null;
  chosenVariantId: string | null;
  /** Available-to-promise of one combination; null = not stock-tracked. */
  availableOf: (variant: StoreVariant) => number | null;
  onColor: (colorKey: string) => void;
  onVariant: (variant: StoreVariant) => void;
}) {
  const { t, pick, lang } = useI18n();

  // A free-size product (every combination is a named model, with no colour and
  // no size) is chosen by model — a picture and a name — never by a size chip.
  const everyVariant = groups.flatMap((group) => group.variants);
  if (everyVariant.length > 0 && everyVariant.every(isFreeSizeStoreVariant)) {
    return (
      <FreeSizeModelPicker
        variants={everyVariant}
        chosenVariantId={chosenVariantId}
        availableOf={availableOf}
        onVariant={onVariant}
      />
    );
  }

  // The sizes shown are the chosen colour's; no colour chosen yet → the prompt
  // below, never a silent default.
  const chosenGroup =
    groups.find((candidate) => candidate.color_key === chosenColorKey) ?? null;

  const colorName = (group: StoreVariantColorGroup) => {
    const label = variantColorLabel(group, lang);
    return label || t("store.variants.defaultColor");
  };

  return (
    <div className="mt-4 space-y-3" data-testid="store-variant-picker">
      {/* Colour — hidden entirely for a size-only product (one empty group). */}
      {groups.length > 1 || (groups[0]?.color_key ?? "") !== "" ? (
        <div>
          <p className="mb-1.5 text-[11px] font-black uppercase tracking-wider text-[var(--store-text-secondary)]">
            {t("store.variants.color")}
          </p>
          <div className="flex flex-wrap gap-2" role="listbox" aria-label={t("store.variants.color")}>
            {groups.map((group) => {
              const selected = group.color_key === chosenColorKey;
              // A colour is buyable when ANY of its sizes has stock; a fully
              // sold-out colour stays listed but dimmed, like a sold-out size.
              const anyStock = group.variants.some(
                (variant) => {
                  const available = availableOf(variant);
                  return available === null || available > 0;
                },
              );
              return (
                <button
                  key={group.color_key || "__default__"}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  data-testid={`variant-color-${group.color_key || "default"}`}
                  onClick={() => onColor(group.color_key)}
                  className={cn(
                    "min-h-11 flex items-center gap-1.5 border px-3 py-1.5 text-xs font-bold transition",
                    selected
                      ? "border-[var(--store-primary)] text-[var(--store-primary)] ring-1 ring-[var(--store-primary)]"
                      : "border-[var(--store-border)] text-[var(--store-text-primary)] hover:border-[var(--store-primary)]",
                    !anyStock && "opacity-50",
                  )}
                  style={{ borderRadius: "var(--store-radius-button)" }}
                >
                  {group.color_hex ? (
                    <span
                      aria-hidden
                      className="h-3.5 w-3.5 rounded-full border border-[var(--store-border)]"
                      style={{ backgroundColor: group.color_hex }}
                    />
                  ) : null}
                  {colorName(group)}
                </button>
              );
            })}
          </div>
        </div>
      ) : null}

      {/* Size — the chosen colour's numeric sizes, ascending, none silent. */}
      {chosenGroup ? (
        <div>
          <p className="mb-1.5 text-[11px] font-black uppercase tracking-wider text-[var(--store-text-secondary)]">
            {t("store.variants.size")}
          </p>
          <div className="flex flex-wrap gap-2" role="listbox" aria-label={t("store.variants.size")}>
            {chosenGroup.variants.map((variant) => {
              const selected = variant.id === chosenVariantId;
              const available = availableOf(variant);
              const buyable = available === null || available > 0;
              const size = storeSizeLabel(variant.size, variant.size_label, variant.size_value);
              const name = pick(
                variant.color_ar,
                variant.color_en,
              );
              return (
                <button
                  key={variant.id}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  aria-disabled={!buyable}
                  data-testid={`variant-size-${storeSizeLabel(variant.size, variant.size_label, variant.size_value)}`}
                  title={
                    !buyable
                      ? t("store.variants.soldOut")
                      : available !== null && available <= 5
                        ? t("store.product.onlyLeft", { count: available })
                        : name
                          ? `${name} / ${size}`
                          : size
                  }
                  onClick={() => buyable && onVariant(variant)}
                  className={cn(
                    "min-h-11 min-w-11 border px-3 py-1.5 text-xs font-black tabular-nums transition",
                    selected
                      ? "border-[var(--store-primary)] bg-[var(--store-primary)] text-[var(--store-on-primary)]"
                      : "border-[var(--store-border)] text-[var(--store-text-primary)] hover:border-[var(--store-primary)]",
                    !buyable &&
                      "cursor-not-allowed text-[var(--store-text-secondary)] line-through decoration-[var(--store-border)] opacity-60",
                  )}
                  style={{ borderRadius: "var(--store-radius-button)" }}
                >
                  {size}
                </button>
              );
            })}
          </div>
        </div>
      ) : (
        <p className="text-xs font-semibold text-[var(--store-text-secondary)]">
          {t("store.variants.pickColorFirst")}
        </p>
      )}
    </div>
  );
}

/**
 * A free-size model grid: one card per model, its own picture first, its own
 * name, and an honest sold-out state. Nothing is preselected and no size is
 * asked for.
 */
export function FreeSizeModelPicker({
  variants,
  chosenVariantId,
  availableOf,
  onVariant,
}: {
  variants: readonly StoreVariant[];
  chosenVariantId: string | null;
  availableOf: (variant: StoreVariant) => number | null;
  onVariant: (variant: StoreVariant) => void;
}) {
  const { t, lang } = useI18n();
  return (
    <div className="mt-4 space-y-2" data-testid="store-model-picker">
      <p className="text-[11px] font-black uppercase tracking-wider text-[var(--store-text-secondary)]">
        {t("store.variants.chooseModel")}
      </p>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3" role="listbox" aria-label={t("store.variants.chooseModel")}>
        {variants.map((variant) => {
          const selected = variant.id === chosenVariantId;
          const available = availableOf(variant);
          const buyable = available === null || available > 0;
          const name = modelNameOf(variant, lang) ?? "";
          const picture = storeVariantPicture(variant);
          return (
            <button
              key={variant.id}
              type="button"
              role="option"
              aria-selected={selected}
              aria-disabled={!buyable}
              data-testid={`variant-model-${variant.sku}`}
              title={buyable ? name : t("store.variants.soldOut")}
              onClick={() => buyable && onVariant(variant)}
              className={cn(
                "flex flex-col overflow-hidden border text-start transition",
                selected
                  ? "border-[var(--store-primary)] ring-1 ring-[var(--store-primary)]"
                  : "border-[var(--store-border)] hover:border-[var(--store-primary)]",
                !buyable && "cursor-not-allowed opacity-60",
              )}
              style={{ borderRadius: "var(--store-radius-button)" }}
            >
              {picture ? (
                <img
                  src={picture}
                  alt={name}
                  loading="lazy"
                  className="aspect-square w-full object-cover"
                />
              ) : (
                <span className="flex aspect-square w-full items-center justify-center bg-[var(--store-surface-muted,#f5f5f4)] text-xs text-[var(--store-text-secondary)]">
                  {name}
                </span>
              )}
              <span className="px-2 py-1.5 text-xs font-black text-[var(--store-text-primary)]">{name}</span>
              <span className="px-2 pb-2 text-[11px] font-bold text-[var(--store-text-secondary)]">
                {!buyable
                  ? t("store.variants.soldOut")
                  : available !== null && available <= 5
                    ? t("store.product.onlyLeft", { count: available })
                    : t("pos.variants.freeSize")}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
