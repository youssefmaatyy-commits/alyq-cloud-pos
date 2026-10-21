import type { Product } from "@/modules/products/types";
import type { ProductVariant } from "@/modules/products/variants";

/**
 * Resolve a keyboard-wedge code to one exact branch-catalogue variant. The
 * caller supplies the already branch-scoped variant list; no sibling color,
 * size, or model fallback is permitted. If more than one variant matches the
 * code, returns null so the caller opens the visual picker instead of picking
 * the first variant automatically.
 */
export function resolveExactScannedVariant(
  rawCode: string,
  variants: readonly ProductVariant[],
): ProductVariant | null {
  const code = rawCode.trim().toUpperCase();
  if (!code) return null;
  const matches = variants.filter(
    (variant) =>
      variant.sku.toUpperCase() === code || (variant.barcode ?? "").toUpperCase() === code,
  );
  return matches.length === 1 ? matches[0] : null;
}

/**
 * Resolve a scanned shared parent barcode or SKU to a `variants_enabled`
 * product so the register can open the visual Model / Variant Picker instead
 * of auto-selecting a model or rejecting the scan.
 */
export function resolveScannedVariantProduct(
  rawCode: string,
  products: readonly Product[],
  variants: readonly ProductVariant[],
): Product | null {
  const code = rawCode.trim().toUpperCase();
  if (!code) return null;
  const direct = products.find(
    (p) =>
      p.active &&
      p.variants_enabled &&
      (p.sku.toUpperCase() === code || (p.barcode ?? "").toUpperCase() === code),
  );
  if (direct) return direct;
  const compact = code.replace(/-/g, "");
  if (compact) {
    const compactMatches = products.filter(
      (p) =>
        p.active &&
        p.variants_enabled &&
        (p.sku.toUpperCase().replace(/-/g, "") === compact ||
          (p.barcode ?? "").toUpperCase().replace(/-/g, "") === compact),
    );
    if (compactMatches.length === 1) return compactMatches[0];
  }
  const variantMatches = variants.filter(
    (v) => v.active && (v.sku.toUpperCase() === code || (v.barcode ?? "").toUpperCase() === code),
  );
  if (variantMatches.length > 1) {
    const productIds = new Set(variantMatches.map((v) => v.product_id));
    if (productIds.size === 1) {
      const pid = [...productIds][0];
      return products.find((p) => p.id === pid && p.active && p.variants_enabled) ?? null;
    }
  }
  return null;
}
