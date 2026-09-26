/**
 * POS scan/search matching self-test (headless, Node).
 * Run with:
 *   npx esbuild src/modules/pos/__tests__/search.selftest.ts \
 *     --bundle --format=esm --platform=node \
 *     --outfile=/tmp/alyq-pos-search-selftest.mjs && node /tmp/alyq-pos-search-selftest.mjs
 *
 * Covers the register's query matching: name (both languages), SKU, product
 * code and barcode — including variant codes surfacing their parent product —
 * plus the sellability exclusions and the deterministic exact-first ranking.
 * Adding to the cart (exact-barcode add, the no-guess variant picker, stock
 * limits) stays in the provider and is proven by the POS e2e flows.
 */
import assert from "node:assert/strict";
import type { Product } from "@/modules/products/types";
import type { ProductVariant } from "@/modules/products/variants";
import {
  POS_SEARCH_RESULT_CAP,
  isPosSellable,
  matchPosProducts,
} from "../services/posSearch";

type TestCase = { name: string; fn: () => void };
const tests: TestCase[] = [];
function test(name: string, fn: () => void) {
  tests.push({ name, fn });
}

let seq = 0;
function product(partial: Partial<Product> & { sku: string }): Product {
  seq += 1;
  return {
    id: partial.id ?? `pos-search-p${seq}`,
    barcode: null,
    name_ar: "",
    name_en: partial.sku,
    description_ar: null,
    description_en: null,
    category_id: null,
    product_type: "physical",
    selling_price: 10,
    cost_price: 5,
    tax_rate: 0,
    stock_tracking_enabled: true,
    stock_quantity: 5,
    low_stock_level: 1,
    variants_enabled: false,
    show_on_website: false,
    is_featured: false,
    active: true,
    image_url: null,
    images: [],
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...partial,
  };
}

function variant(partial: Partial<ProductVariant> & { product_id: string; sku: string }): ProductVariant {
  seq += 1;
  return {
    id: partial.id ?? `00000000-0000-0000-0000-${String(seq).padStart(12, "0")}`,
    barcode: null,
    color_key: "gold",
    color_ar: "ذهبي",
    color_en: "Gold",
    color_hex: null,
    size: 17,
    size_label: null,
    image_url: null,
    price_override: null,
    cost_override: null,
    stock_quantity: 2,
    low_stock_level: 1,
    active: true,
    sort_order: 0,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...partial,
  };
}

const ring = product({
  id: "pos-search-ring",
  sku: "ALYQ-1002",
  barcode: "6281000000020",
  name_ar: "خاتم ذهبي كلاسيكي",
  name_en: "Classic Gold Ring",
});
const earrings = product({
  id: "pos-search-earrings",
  sku: "ALYQ-1001",
  barcode: "6281000000013",
  name_ar: "أقراط لؤلؤ ذهبية",
  name_en: "Gold Pearl Earrings",
});
const bracelet = product({
  id: "pos-search-bracelet",
  sku: "ALYQ-1020",
  name_ar: "سوار",
  name_en: "Minimal Bracelet",
});
const archived = product({ id: "pos-search-archived", sku: "ALYQ-9001", name_en: "Archived Ring", active: false });
const service = product({
  id: "pos-search-service",
  sku: "ALYQ-3001",
  name_en: "Gift Wrapping",
  stock_tracking_enabled: false,
});
const variantRing = product({
  id: "pos-search-vring",
  sku: "UX2-RING",
  name_ar: "خاتم اليوكس ٢",
  name_en: "UX2 Ring",
  variants_enabled: true,
});
const gold17 = variant({
  id: "11111111-1111-1111-1111-111111111111",
  product_id: variantRing.id,
  sku: "UX2-RING-GOLD-17",
});
const silver17 = variant({
  id: "22222222-2222-2222-2222-222222222222",
  product_id: variantRing.id,
  sku: "UX2-RING-SILVER-17",
  barcode: "6220100999117",
  color_key: "silver",
  color_ar: "فضي",
  color_en: "Silver",
});

const products = [ring, earrings, bracelet, archived, service, variantRing];
const variants = [gold17, silver17];

const skus = (query: string) => matchPosProducts(products, variants, query).map((hit) => hit.product.sku);

console.log("\nPOS · scan/search matching");

test("an empty query matches nothing — the register never lists the catalogue", () => {
  assert.deepEqual(matchPosProducts(products, variants, ""), []);
  assert.deepEqual(matchPosProducts(products, variants, "   "), []);
});

test("product-name search returns matching results (both languages)", () => {
  assert.deepEqual(skus("Classic"), ["ALYQ-1002"]);
  assert.deepEqual(skus("classic"), ["ALYQ-1002"], "latin search is case-insensitive");
  assert.deepEqual(skus("خاتم"), ["ALYQ-1002", "UX2-RING"], "arabic name matches in catalog order");
  assert.deepEqual(skus("Earrings"), ["ALYQ-1001"]);
});

test("SKU / product-code search works", () => {
  assert.deepEqual(skus("ALYQ-1020"), ["ALYQ-1020"]);
  assert.deepEqual(skus("alyq-1020"), ["ALYQ-1020"], "codes match case-insensitively");
  assert.deepEqual(skus("ALYQ-100"), ["ALYQ-1002", "ALYQ-1001"], "a code prefix matches every product carrying it");
});

test("barcode search finds the product carrying it", () => {
  assert.deepEqual(skus("6281000000013"), ["ALYQ-1001"]);
  assert.deepEqual(skus("6281000000020"), ["ALYQ-1002"]);
});

test("a variant's own SKU / shelf barcode surfaces its parent product", () => {
  assert.deepEqual(skus("UX2-RING-GOLD-17"), ["UX2-RING"]);
  assert.deepEqual(skus("6220100999117"), ["UX2-RING"], "the shelf barcode resolves to the ring");
});

test("an exact code leads the list even when other products contain it", () => {
  const hits = matchPosProducts(products, variants, "ALYQ-1001");
  assert.equal(hits[0].product.sku, "ALYQ-1001");
  assert.equal(hits[0].exactCode, true);
  const hitsLower = matchPosProducts(products, variants, "alyq-1001");
  assert.equal(hitsLower[0].product.sku, "ALYQ-1001");
  assert.equal(hitsLower[0].exactCode, true);
});

test("every term must match (AND semantics)", () => {
  // "ring" also matches "Earrings", and "gold" matches the variant shelf
  // UX2-RING-GOLD-17 — substring matching, same as the register always had.
  assert.deepEqual(skus("Gold Ring"), ["ALYQ-1002", "ALYQ-1001", "UX2-RING"]);
  assert.deepEqual(skus("Gold Bracelet"), [], "no single product carries both terms");
});

test("inactive and non-tracked products are never offered", () => {
  assert.ok(!isPosSellable(archived), "archived is not sellable");
  assert.ok(!isPosSellable(service), "non-tracked service is not sellable");
  assert.deepEqual(skus("Archived"), [], "archived products stay out of results");
  assert.deepEqual(skus("Wrapping"), [], "services stay out of results");
});

test("a variant product matches as a product — variant choice stays with the picker", () => {
  const hits = matchPosProducts(products, variants, "UX2");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].product.id, variantRing.id);
  assert.equal(hits[0].product.variants_enabled, true);
  // The match names the product only: no variant id is smuggled through.
  assert.ok(!("variant_id" in hits[0]), "matching never pre-selects a combination");
});

test("the result cap keeps the list a compact dropdown, not a catalogue", () => {
  assert.equal(POS_SEARCH_RESULT_CAP, 30);
  const many = Array.from({ length: 60 }, (_, i) =>
    product({ id: `pos-search-bulk-${i}`, sku: `BULK-${i}`, name_en: `Bulk Bracelet ${i}` }),
  );
  const hits = matchPosProducts(many, [], "Bulk");
  assert.equal(hits.length, 60, "matching itself is complete");
  assert.ok(hits.length > POS_SEARCH_RESULT_CAP, "so the UI must name the remainder instead of rendering it all");
});

// runner — sequential, mirroring the other logic suites
let passed = 0;
async function main() {
  for (const { name, fn } of tests) {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  }
  console.log(`\n${passed}/${tests.length} POS search tests passed.`);
}

await main();
