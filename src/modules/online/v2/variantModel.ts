/** V2's view over the existing, published exact shelves. No product rollup,
 * inferred size matrix, fixed clothing-size list or alternate stock ledger.
 */
import type { StoreVariant } from "../services/pricing";
import { colorGroupsOf, sortStoreVariants, storeVariantSizeValue } from "../services/pricing";
import { variantAvailableToPromise } from "../services/availability";

export function sizeKeyOf(variant: Pick<StoreVariant, "size" | "size_label"> & Partial<Pick<StoreVariant,"size_value">>): string {
  const value=storeVariantSizeValue(variant);
  return value ? `size:${value.toLocaleLowerCase()}` : "";
}

export function variantModel(
  published: readonly StoreVariant[],
  holds: ReadonlyMap<string, number> = new Map(),
  orderable = true,
) {
  const variants = sortStoreVariants(published.filter((variant) => variant.active));
  const groups = colorGroupsOf(variants);
  const hasColors = groups.some((group) => Boolean(group.color_key || group.color_ar || group.color_en));
  const hasSizes = variants.some((variant) => sizeKeyOf(variant) !== "");
  const hasModels =
    !hasColors &&
    !hasSizes &&
    variants.some((variant) =>
      Boolean((variant.display_name_ar ?? "").trim() || (variant.display_name_en ?? "").trim()),
    );
  const remaining = (variant: StoreVariant): number => orderable
    ? variantAvailableToPromise(variant, holds.get(variant.id) ?? 0)
    : 0;
  const sellable = variants.filter((variant) => remaining(variant) > 0);

  return {
    groups,
    variants,
    hasColors,
    hasSizes,
    hasModels,
    models: variants.map((variant) => ({
      variant,
      available: remaining(variant),
    })),
    sellable,
    remaining,
    /** A colour change never silently inherits another colour's size. */
    exact(colorKey: string | null, sizeKey: string | null): StoreVariant | null {
      if (hasColors && colorKey === null) return null;
      if (hasSizes && sizeKey === null) return null;
      return variants.find((variant) =>
        variant.color_key === (colorKey ?? "") &&
        sizeKeyOf(variant) === (sizeKey ?? "") &&
        remaining(variant) > 0,
      ) ?? null;
    },
    /** Never auto-select among multiple published options, even if just one is in stock. */
    soleQuickAdd(): StoreVariant | null {
      return variants.length === 1 && sellable.length === 1 ? sellable[0] : null;
    },
    /** Existing rows only: sold-out sizes remain visible rather than disappearing. */
    sizesFor(colorKey: string | null) {
      return groups.find((group) => group.color_key === (colorKey ?? ""))?.variants.map((variant) => ({
        variant,
        key: sizeKeyOf(variant),
        label: storeVariantSizeValue(variant),
        available: remaining(variant),
      })) ?? [];
    },
  };
}
