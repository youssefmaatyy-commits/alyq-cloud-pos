/**
 * One label for one combination, everywhere the customer reads one.
 *
 * "Gold / 17" — colour first, then the NUMERIC size with no trailing zeros, in
 * the reader's language. The order lines, the cart, the picker buttons and the
 * confirmation page all render through this one function, so the same shelf is
 * named the same way on every screen — and after a rename, the frozen snapshot
 * on a line still reads exactly what the customer bought.
 */
/** The shape every labelling call accepts — a variant or a frozen snapshot. */
export type VariantLabelSource = {
  color_ar: string | null;
  color_en: string | null;
  size: number | null;
  size_label: string | null;
  display_name_ar?: string | null;
  display_name_en?: string | null;
  variant_display_name?: string | null;
};

/** 17 → "17", 17.5 → "17.5" — never "17.00". */
export function storeSizeLabel(size: number | null, fallback: string | null): string {
  if (size === null || !Number.isFinite(size)) return (fallback ?? "").trim();
  return String(Math.round(size * 100) / 100);
}

/** The model/shape label in the active language. */
export function variantModelLabel(
  variant: Pick<VariantLabelSource, "display_name_ar" | "display_name_en" | "variant_display_name">,
  lang: "ar" | "en" = "en",
): string {
  const ar = (variant.display_name_ar ?? variant.variant_display_name ?? "").trim();
  const en = (variant.display_name_en ?? variant.variant_display_name ?? "").trim();
  return lang === "ar" ? ar || en : en || ar;
}

/** "Gold / 17" or "شكل 1", in the reader's language (`"ar"` falls back across the pair). */
export function variantLabelOf(
  variant: VariantLabelSource,
  lang: "ar" | "en" = "en",
): string {
  const color =
    (lang === "ar" ? variant.color_ar || variant.color_en : variant.color_en || variant.color_ar) ??
    "";
  const primary = color.trim() || variantModelLabel(variant, lang);
  const size = storeSizeLabel(variant.size, variant.size_label);
  return [primary, size].filter(Boolean).join(" / ");
}

/** The colour's own label, without the size — for the picker's swatch row. */
export function variantColorLabel(
  variant: Pick<VariantLabelSource, "color_ar" | "color_en">,
  lang: "ar" | "en" = "en",
): string {
  return (
    (lang === "ar" ? variant.color_ar || variant.color_en : variant.color_en || variant.color_ar) ??
    ""
  ).trim();
}
