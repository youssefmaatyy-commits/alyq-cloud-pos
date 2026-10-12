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
  size_value?: string | null;
};

/** 17 → "17", 17.5 → "17.5" — never "17.00". */
export function storeSizeLabel(size: number | null, fallback: string | null, sizeValue?: string | null): string {
  if (sizeValue !== undefined && sizeValue !== null) return sizeValue.trim();
  if (size === null || !Number.isFinite(size)) return (fallback ?? "").trim();
  return String(Math.round(size * 100) / 100);
}

/** "Gold / 17", in the reader's language (`"ar"` falls back across the pair). */
export function variantLabelOf(
  variant: VariantLabelSource,
  lang: "ar" | "en" = "en",
): string {
  const color =
    (lang === "ar" ? variant.color_ar || variant.color_en : variant.color_en || variant.color_ar) ??
    "";
  const size = storeSizeLabel(variant.size, variant.size_label, variant.size_value);
  return [color.trim(), size].filter(Boolean).join(" / ");
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
