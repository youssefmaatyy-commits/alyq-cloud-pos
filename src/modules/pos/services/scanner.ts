import type { ProductVariant } from "@/modules/products/variants";

/**
 * Resolve a keyboard-wedge code to one exact branch-catalogue variant. The
 * caller supplies the already branch-scoped variant list; no sibling color or
 * size fallback is permitted.
 */
export function resolveExactScannedVariant(
  rawCode: string,
  variants: readonly ProductVariant[],
): ProductVariant | null {
  const code = rawCode.trim().toUpperCase();
  if (!code) return null;
  return variants.find((variant) =>
    variant.sku.toUpperCase() === code || (variant.barcode ?? "").toUpperCase() === code,
  ) ?? null;
}
