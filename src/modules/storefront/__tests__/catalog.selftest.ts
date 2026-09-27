/**
 * Live-storefront catalogue mapping — the exact gap manual Vercel Preview
 * testing found and demo-mode jsdom testing could not: `storefront_catalogue()`
 * (migration 0030) predates the `variants_enabled` column (migration 0043) and
 * has never been updated to select it, so every live product row is missing
 * that field. Demo mode never goes through this RPC — it reads full `Product`
 * rows straight from the repository — so every previous suite that opened a
 * variant PDP was demo-only and never exercised this path.
 *
 * Run with:
 *   npx esbuild src/modules/storefront/__tests__/catalog.selftest.ts \
 *     --bundle --format=esm --platform=node --outfile=/tmp/alyq-catalog.mjs && node /tmp/alyq-catalog.mjs
 */
import assert from "node:assert/strict";
import { toProduct, patchVariantsEnabled } from "../data/storefrontCatalog";
import type { Product } from "@/modules/products/types";
import type { StoreVariant } from "@/modules/online/services/pricing";

type TestCase = { name: string; fn: () => void };
const tests: TestCase[] = [];
const test = (name: string, fn: () => void) => tests.push({ name, fn });

const at = "2026-01-01T00:00:00.000Z";

/** A bare row exactly as `storefront_catalogue()` actually returns it — no
 * `variants_enabled`, no `variant_summary`, because the RPC's fixed column
 * list has never included either. */
function liveRow(id: string, overrides: Partial<Product> = {}) {
  const { variants_enabled: _ignored, variant_summary: _ignoredToo, cost_price: _cost, low_stock_level: _low, ...rest } = {
    id, sku: `SKU-${id}`, barcode: null, name_ar: "منتج", name_en: "Product",
    description_ar: null, description_en: null, category_id: null, product_type: "physical" as const,
    selling_price: 100, cost_price: 0, tax_rate: 0, stock_tracking_enabled: true, stock_quantity: 0,
    low_stock_level: 0, variants_enabled: true, show_on_website: true, is_featured: false, active: true,
    image_url: null, images: [] as string[], created_at: at, updated_at: at,
    ...overrides,
  };
  return rest as Parameters<typeof toProduct>[0];
}

function variant(id: string, product_id: string, color_key: string, color_en: string): StoreVariant {
  return {
    id, product_id, sku: `${product_id}-${id}`, color_key, color_ar: color_en, color_en,
    color_hex: "#111111", size: null, size_label: "One size", image_url: null,
    price_override: null, stock_quantity: 4, active: true, sort_order: 1,
  };
}

test("a raw storefront_catalogue() row has no variants_enabled column to spread — toProduct defaults it false", () => {
  const row = liveRow("prd-ring");
  assert.equal((row as Record<string, unknown>).variants_enabled, undefined,
    "the fixture must reproduce the RPC's real, incomplete shape");
  const product = toProduct(row);
  assert.equal(product.variants_enabled, false);
});

test("patchVariantsEnabled restores true for every product storefront_product_variants() actually named", () => {
  const ring = toProduct(liveRow("prd-ring"));
  const plain = toProduct(liveRow("prd-plain"));
  const variants = [
    variant("v1", "prd-ring", "gold", "Gold"),
    variant("v2", "prd-ring", "silver", "Silver"),
  ];
  const [patchedRing, patchedPlain] = patchVariantsEnabled([ring, plain], variants);
  assert.equal(patchedRing.variants_enabled, true, "the product with real published combinations is corrected");
  assert.equal(patchedPlain.variants_enabled, false, "a product with none stays a simple, non-variant product");
});

test("every real active colour survives the round trip — none fabricated, none dropped", () => {
  const ring = toProduct(liveRow("prd-ring"));
  const variants = [
    variant("v1", "prd-ring", "gold", "Gold"),
    variant("v2", "prd-ring", "silver", "Silver"),
    variant("v3", "prd-ring", "rose", "Rose gold"),
  ];
  const [patched] = patchVariantsEnabled([ring], variants);
  assert.equal(patched.variants_enabled, true);
  assert.deepEqual(variants.map((v) => v.color_key).sort(), ["gold", "rose", "silver"]);
  assert.equal(variants.length, 3, "no combination is invented beyond the three published rows");
});

test("a product with zero active combinations degrades to simple/out-of-stock, not a fabricated colour", () => {
  const orphan = toProduct(liveRow("prd-orphan"));
  const [patched] = patchVariantsEnabled([orphan], []);
  assert.equal(patched.variants_enabled, false);
});

test("patchVariantsEnabled never mutates the input array when nothing needs correcting", () => {
  const products = [toProduct(liveRow("prd-a")), toProduct(liveRow("prd-b"))];
  const result = patchVariantsEnabled(products, []);
  assert.equal(result, products, "an early return avoids allocating when no variant rows exist at all");
});

let failed = 0;
for (const { name, fn } of tests) {
  try {
    fn();
    console.log(`  \u2713 ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`  \u2717 ${name}`);
    console.error(error instanceof Error ? error.message : error);
  }
}
if (failed > 0) {
  console.error(`\n${failed}/${tests.length} live-catalogue variant tests FAILED.`);
  process.exit(1);
}
console.log(`\n${tests.length}/${tests.length} live-catalogue variant tests passed.`);
