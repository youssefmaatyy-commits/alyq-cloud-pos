/**
 * Storefront helpers for free-size models (named combinations with no colour
 * and no size). The rule itself lives in `products/variants.ts`; this file only
 * adapts it to the storefront's `StoreVariant` shape so every storefront picker
 * decides the same way.
 */
import { isFreeSizeModel, variantGalleryOf } from "@/modules/products/variants";
import type { StoreVariant } from "./pricing";

export function isFreeSizeStoreVariant(variant: StoreVariant): boolean {
  return isFreeSizeModel(variant);
}

/** The picture a model card shows: its own gallery first, then its cover. */
export function storeVariantPicture(variant: Pick<StoreVariant, "images" | "image_url">): string | null {
  return variantGalleryOf(variant)[0] ?? null;
}
