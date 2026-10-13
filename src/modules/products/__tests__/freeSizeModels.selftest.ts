import assert from "node:assert/strict";
import { resolveExactScannedVariant } from "@/modules/pos/services/scanner";
import { isFreeSizeStoreVariant, storeVariantPicture } from "@/modules/online/services/variantModels";
import {
  VARIANT_GALLERY_LIMIT,
  isFreeSizeModel,
  modelKeyOf,
  modelNameOf,
  needsVariantChoice,
  sellableVariants,
  variantByCode,
  variantGalleryOf,
  variantGalleryProblem,
  type ProductVariant,
} from "../variants";

// Test fixtures. Only the fields the rules read are meaningful; the rest are
// neutral so the object is a complete ProductVariant.
function variant(partial: Partial<ProductVariant> & Pick<ProductVariant, "id" | "sku">): ProductVariant {
  return {
    product_id: "p-rings",
    barcode: null,
    color_key: "",
    color_ar: null,
    color_en: null,
    color_hex: null,
    size: null,
    size_label: null,
    size_value: null,
    size_sort_order: 0,
    image_url: null,
    images: [],
    display_name_ar: null,
    display_name_en: null,
    price_override: null,
    cost_override: null,
    stock_quantity: 0,
    low_stock_level: 0,
    active: true,
    sort_order: 0,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...partial,
  } as ProductVariant;
}

// ── 1. Legacy products: no variant rows, no choice, nothing changes ─────────
assert.equal(needsVariantChoice({ variants_enabled: false }, []), false, "a legacy simple product asks for nothing");
assert.equal(
  needsVariantChoice({ variants_enabled: false }, [variant({ id: "x", sku: "LEG" })]),
  false,
  "a product with variants disabled never opens a picker, even with stale rows",
);

// ── 2. Multi-model free-size parent ────────────────────────────────────────
const modelA = variant({
  id: "va",
  sku: "RING-A",
  barcode: "629RINGA001",
  display_name_en: "Model A",
  display_name_ar: "موديل A",
  images: ["https://img.example.test/a-front.jpg", "https://img.example.test/a-side.jpg"],
  image_url: "https://img.example.test/a-front.jpg",
  stock_quantity: 3,
});
const modelB = variant({
  id: "vb",
  sku: "RING-B",
  barcode: "629RINGB001",
  display_name_en: "Model B",
  images: [],
  image_url: "https://img.example.test/b-cover.jpg",
  stock_quantity: 0,
});
const family = [modelA, modelB];

assert.equal(isFreeSizeModel(modelA), true, "a named model with no colour and no size is free-size");
assert.equal(isFreeSizeStoreVariant(modelB), true, "the storefront adapter agrees");
assert.equal(
  isFreeSizeModel(variant({ id: "c", sku: "C-42", color_key: "black", color_en: "Black", size_value: "42" })),
  false,
  "a colour/size combination is never free-size",
);
assert.equal(
  isFreeSizeModel(variant({ id: "s", sku: "S-42", size_value: "42" })),
  false,
  "a size-only combination is not a free-size model",
);
assert.equal(modelNameOf(modelA, "ar"), "موديل A", "the Arabic name is shown to Arabic readers");
assert.equal(modelNameOf(modelB, "ar"), "Model B", "the storefront falls back across the name pair");

// Independent SKU and barcode per model: each code resolves to exactly its own model.
assert.equal(variantByCode(family, "ring-b")?.id, "vb", "the SKU is case-insensitive and exact");
assert.equal(variantByCode(family, "629RINGA001")?.id, "va", "the barcode resolves to its own model");
assert.equal(variantByCode(family, "RING"), null, "a partial code never picks a model");

// POS exact-barcode add: the scanned barcode selects the exact model, never a sibling.
assert.equal(resolveExactScannedVariant("629ringb001", family)?.id, "vb", "POS scan picks Model B exactly");
assert.equal(resolveExactScannedVariant("UNKNOWN", family), null, "an unknown code falls through, it does not guess");

// Sold-out models are not sellable; the active in-stock model is.
assert.deepEqual(sellableVariants(family).map((v) => v.id), ["va"], "a sold-out model cannot be bought");

// Required selection: a variant product always asks; the chooser cannot default silently.
assert.equal(needsVariantChoice({ variants_enabled: true }, family), true, "a multi-model parent requires a choice");

// Image switching: each model shows its own gallery first, then its cover,
// never a sibling's picture.
assert.deepEqual(variantGalleryOf(modelA), [
  "https://img.example.test/a-front.jpg",
  "https://img.example.test/a-side.jpg",
], "the model's own gallery is shown in order, the cover is not repeated");
assert.equal(storeVariantPicture(modelA), "https://img.example.test/a-front.jpg", "Model A card shows Model A's photo");
assert.equal(storeVariantPicture(modelB), "https://img.example.test/b-cover.jpg", "Model B falls back to its own cover");
assert.equal(
  storeVariantPicture(variant({ id: "e", sku: "E" })),
  null,
  "a variant with no photos shows no picture rather than a sibling's",
);

// ── 3. Name identity and gallery guards (mirror migration 0096) ────────────
assert.equal(modelKeyOf({ display_name_en: "  model a " }), modelKeyOf({ display_name_en: "Model A" }),
  "a duplicate name differs only by case and spacing, so it is the same model");
assert.notEqual(modelKeyOf(modelA), modelKeyOf(modelB), "distinct names are distinct models");
assert.equal(variantGalleryProblem(["https://a.example.test/1.jpg"]), null, "one https photo is fine");
assert.equal(
  variantGalleryProblem(Array.from({ length: VARIANT_GALLERY_LIMIT + 1 }, (_, i) => `https://a.example.test/${i}.jpg`)),
  "too_many",
  "more than five photos is refused",
);
assert.equal(variantGalleryProblem(["javascript:alert(1)"]), "invalid_url", "a script link is refused");
assert.equal(variantGalleryProblem(["ftp://a.example.test/x.jpg"]), "invalid_url", "only http(s) links are accepted");

console.log("free-size model rules: legacy, multi-model, scan, sold-out, required selection, image switching, guards — passed");
