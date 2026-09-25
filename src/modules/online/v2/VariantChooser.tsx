import { useI18n } from "@/lib/i18n/I18nProvider";
import type { StoreVariant } from "../services/pricing";
import { variantColorLabel } from "../services/variantLabel";
import { variantModel } from "./variantModel";

/** Same explicit, exact-shelf chooser on a card and on the V2 PDP. A size key
 * is derived from the saved numeric size or the saved size_label (XS / One Size
 * / any future size); no list of clothing sizes is embedded in the UI.
 */
export function V2VariantChooser({ model, colorKey, variantId, onChoice, compact = false }: {
  model: ReturnType<typeof variantModel>;
  colorKey: string | null;
  variantId: string | null;
  onChoice: (variant: StoreVariant | null, colorKey: string | null) => void;
  compact?: boolean;
}) {
  const { t, lang } = useI18n();
  const selectedColor = model.hasColors ? colorKey : "";
  const group = model.groups.find((item) => item.color_key === selectedColor);

  return (
    <div className={`v2-variant-chooser ${compact ? "v2-variant-compact" : ""}`} data-testid="v2-variant-picker">
      {model.hasColors ? (
        <div role="group" aria-label={t("store.variants.color")}>
          <p className="v2-picker-label">{t("store.variants.color")}
            {group ? <span> — {variantColorLabel(group, lang)}</span> : null}
          </p>
          <div className="v2-picker-options">
            {model.groups.map((item) => {
              const name = variantColorLabel(item, lang) || t("store.variants.defaultColor");
              const out = !item.variants.some((variant) => model.remaining(variant) > 0);
              return (
                <button
                  key={item.color_key}
                  type="button"
                  className="v2-color-option"
                  data-testid={`v2-color-${item.color_key}`}
                  data-selected={selectedColor === item.color_key}
                  aria-label={`${t("store.variants.color")}: ${name}${out ? ` — ${t("store.variants.soldOut")}` : ""}`}
                  aria-pressed={selectedColor === item.color_key}
                  onClick={() => onChoice(model.hasSizes ? null : model.exact(item.color_key, ""), item.color_key)}
                >
                  {item.color_hex ? <span className="v2-swatch" style={{ backgroundColor: item.color_hex }} aria-hidden /> : null}
                  <span>{name}</span>
                  {out ? <span className="v2-option-out" aria-hidden>×</span> : null}
                </button>
              );
            })}
          </div>
        </div>
      ) : null}

      {model.hasSizes ? (
        <div role="group" aria-label={t("store.variants.size")}>
          <p className="v2-picker-label">{t("store.variants.size")}</p>
          {!group && model.hasColors ? (
            <p className="v2-picker-hint">{t("store.variants.pickColorFirst")}</p>
          ) : (
            <div className="v2-picker-options">
              {model.sizesFor(selectedColor).map(({ variant, key, label, available }) => (
                <button
                  type="button"
                  key={variant.id}
                  className="v2-size-option"
                  data-testid={`v2-size-${label}`}
                  data-selected={variant.id === variantId}
                  aria-pressed={variant.id === variantId}
                  title={available <= 0 ? t("store.variants.soldOut") : label}
                  aria-label={`${t("store.variants.size")}: ${label}${available <= 0 ? ` — ${t("store.variants.soldOut")}` : ""}`}
                  disabled={available <= 0}
                  onClick={() => onChoice(model.exact(selectedColor, key), selectedColor)}
                >
                  {label || t("store.variants.defaultColor")}
                </button>
              ))}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
