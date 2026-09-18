/**
 * Phase 2 logic self-test (headless).
 * Run with:  npx esbuild src/modules/products/__tests__/logic.selftest.ts \
 *              --bundle --format=esm --platform=node --outfile=/tmp/alyq-selftest.mjs && node /tmp/alyq-selftest.mjs
 *
 * Exercises the business rules without React or a DOM: validation, uniqueness,
 * search/filter/sort, category tree maths and the demo repository flows.
 */
import assert from "node:assert/strict";
import {
  EMPTY_PRODUCT_FORM,
  isDescendant,
  validateCategoryDraft,
  validateProductDraft,
  categoryUsage,
} from "../validation";
import { buildCategoryTree, flattenCategoryTree } from "../services/categoryTree";
import { normalizeText, queryProducts, summarize } from "../services/productQuery";
import { DemoRepository } from "../data/demoRepository";
import { stockStatus, type Category, type Product, type ProductImageItem } from "../types";
import {
  code128Checksum,
  deriveBarcodeFromSku,
  encodeCode128,
  isDerivedFromSku,
  isEncodableCode128,
  validateBarcodePayload,
  barcodeToSvgString,
} from "../services/barcode";
import { buildBarcodeLabelHtml } from "../services/barcodeLabel";
import { resolveProductImages, validateImageFile } from "../services/imageStorage";

const cat = (
  id: string,
  name_en: string,
  parent_id: string | null = null,
  sort_order = 0,
  active = true,
): Category => ({
  id,
  name_ar: name_en + "-ع",
  name_en,
  parent_id,
  active,
  sort_order,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
});

const prod = (over: Partial<Product> & { id: string; sku: string }): Product => ({
  barcode: null,
  variants_enabled: false,
  name_ar: "منتج",
  name_en: "Product " + over.sku,
  description_ar: null,
  description_en: null,
  category_id: "c1",
  product_type: "physical",
  selling_price: 10,
  cost_price: 5,
  tax_rate: 15,
  stock_tracking_enabled: true,
  stock_quantity: 10,
  low_stock_level: 5,
  show_on_website: true,
  is_featured: false,
  active: true,
  image_url: null,
  images: [],
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
  ...over,
});

const categories: Category[] = [
  cat("c1", "Beverages"),
  cat("c2", "Earrings", "c1", 1),
  cat("c3", "Dairy", null, 2, false),
];

const products: Product[] = [
  prod({ id: "p1", sku: "ALYQ-1", barcode: "100", name_en: "Earrings", name_ar: "أقراط", category_id: "c2" }),
  prod({ id: "p2", sku: "alyq-2", barcode: "200", name_en: "Milk", name_ar: "حليب", category_id: "c3", active: false, product_type: "expiry-tracked" }),
  prod({ id: "p3", sku: "SRV-1", name_en: "Install", name_ar: "تركيب", category_id: null, product_type: "service" }),
];

let passed = 0;
function test(name: string, fn: () => void | Promise<void>): void | Promise<void> {
  let result: void | Promise<void>;
  try {
    result = fn();
  } catch (error) {
    console.error(`  ✗ ${name}`);
    throw error;
  }
  if (result && typeof (result as Promise<void>).then === "function") {
    return result.then(
      () => {
        passed += 1;
        console.log(`  ✓ ${name}`);
      },
      (error) => {
        console.error(`  ✗ ${name}`);
        throw error;
      },
    );
  }
  passed += 1;
  console.log(`  ✓ ${name}`);
}

console.log("\nPhase 2 · logic self-test");

// ── validation ───────────────────────────────────────────────────────────
test("requires both Arabic and English names", () => {
  const { errors } = validateProductDraft(
    { ...EMPTY_PRODUCT_FORM, sku: "X-1", category_id: "c1", selling_price: "1", cost_price: "0", tax_rate: "15" },
    { products, categories },
  );
  assert.equal(errors.name_ar, "nameArRequired");
  assert.equal(errors.name_en, "nameEnRequired");
});

test("rejects negative selling and cost prices", () => {
  const { errors } = validateProductDraft(
    {
      ...EMPTY_PRODUCT_FORM,
      sku: "X-1",
      name_ar: "أ",
      name_en: "a",
      category_id: "c1",
      selling_price: "-1",
      cost_price: "-2",
      tax_rate: "15",
    },
    { products, categories },
  );
  assert.equal(errors.selling_price, "nonnegative");
  assert.equal(errors.cost_price, "nonnegative");
});

test("keeps tax rate inside 0–100", () => {
  const { errors } = validateProductDraft(
    {
      ...EMPTY_PRODUCT_FORM,
      sku: "X-1",
      name_ar: "أ",
      name_en: "a",
      category_id: "c1",
      selling_price: "1",
      cost_price: "1",
      tax_rate: "150",
    },
    { products, categories },
  );
  assert.equal(errors.tax_rate, "taxRange");
});

test("blocks duplicate SKU case-insensitively, ignores self while editing", () => {
  const base = {
    ...EMPTY_PRODUCT_FORM,
    name_ar: "أ",
    name_en: "a",
    category_id: "c1",
    selling_price: "1",
    cost_price: "1",
    tax_rate: "15",
  };
  const taken = validateProductDraft({ ...base, sku: "alyq-1" }, { products, categories });
  assert.equal(taken.errors.sku, "skuTaken");

  const self = validateProductDraft(
    { ...base, sku: "ALYQ-1" },
    { products, categories, currentId: "p1" },
  );
  assert.equal(self.errors.sku, undefined);
  assert.ok(self.data);
});

test("blocks duplicate barcode only when provided", () => {
  const base = {
    ...EMPTY_PRODUCT_FORM,
    sku: "NEW-1",
    name_ar: "أ",
    name_en: "a",
    category_id: "c1",
    selling_price: "1",
    cost_price: "1",
    tax_rate: "15",
  };
  const dup = validateProductDraft({ ...base, barcode: "100" }, { products, categories });
  assert.equal(dup.errors.barcode, "barcodeTaken");

  const blankTwice = validateProductDraft({ ...base, barcode: "  " }, { products, categories });
  assert.equal(blankTwice.errors.barcode, undefined);
  assert.equal(blankTwice.data?.barcode, null);
});

test("normalises and rounds a valid draft", () => {
  const { data } = validateProductDraft(
    {
      ...EMPTY_PRODUCT_FORM,
      sku: "  new-2  ",
      name_ar: " أقراط ",
      name_en: " Earrings ",
      category_id: "c1",
      selling_price: "10.005",
      cost_price: "4.994",
      tax_rate: "15.5",
      images: [{ id: "r1", kind: "remote", url: "https://cdn.example/x.png" }],
    },
    { products, categories },
  );
  assert.equal(data?.sku, "new-2");
  assert.equal(data?.name_ar, "أقراط");
  assert.equal(data?.selling_price, 10.01);
  assert.equal(data?.cost_price, 4.99);
  assert.equal(data?.tax_rate, 15.5);
  // image URLs are resolved separately (after upload) — validated draft holds placeholders
  assert.equal(data?.image_url, null);
  assert.deepEqual(data?.images, []);
});

test("rejects non-image and over-size files + bad sku characters", () => {
  const base = {
    ...EMPTY_PRODUCT_FORM,
    sku: "NEW-3",
    name_ar: "أ",
    name_en: "a",
    category_id: "c1",
    selling_price: "1",
    cost_price: "1",
    tax_rate: "15",
  };

  // Non-image file is rejected at the draft level.
  const pdfFile = new File(["x"], "doc.pdf", { type: "application/pdf" });
  assert.equal(
    validateProductDraft(
      { ...base, images: [{ id: "l1", kind: "local", file: pdfFile, previewUrl: "blob:x" }] },
      { products, categories },
    ).errors.images,
    "imageType",
  );

  // Over-size image is rejected.
  const bigBytes = new Uint8Array(6 * 1024 * 1024);
  const bigFile = new File([bigBytes], "big.png", { type: "image/png" });
  assert.equal(
    validateProductDraft(
      { ...base, images: [{ id: "l2", kind: "local", file: bigFile, previewUrl: "blob:y" }] },
      { products, categories },
    ).errors.images,
    "imageSize",
  );

  assert.equal(validateProductDraft({ ...base, sku: "BAD@SKU" }, { products, categories }).errors.sku, "skuFormat");
});

test("validateImageFile whitelists image types and size", () => {
  assert.equal(validateImageFile(new File(["a"], "a.png", { type: "image/png" })), null);
  assert.equal(validateImageFile(new File(["a"], "a.jpg", { type: "image/jpeg" })), null);
  assert.equal(validateImageFile(new File(["a"], "a.txt", { type: "text/plain" })), "type");
  assert.equal(validateImageFile(new File(["a"], "a.exe", { type: "application/octet-stream" })), "type");
  // SVG is a script-carrying format in a public bucket — refused (0036 removed
  // it from this whitelist and from the bucket's server-side allowed list).
  assert.equal(validateImageFile(new File(["a"], "a.svg", { type: "image/svg+xml" })), "type");
});

// ── category rules ───────────────────────────────────────────────────────
test("category requires bilingual names and integer sort order", () => {
  const { errors } = validateCategoryDraft({ name_ar: "", name_en: "", parent_id: "", sort_order: "1.5", active: true }, { categories });
  assert.equal(errors.name_ar, "nameArRequired");
  assert.equal(errors.name_en, "nameEnRequired");
  assert.equal(errors.sort_order, "sortOrder");
});

test("category cannot be moved under its own descendant", () => {
  assert.equal(isDescendant("c2", "c1", categories), true); // Earrings is inside Beverages
  assert.equal(isDescendant("c1", "c2", categories), false); // Beverages is not inside Earrings
  assert.equal(isDescendant("c2", "c2", categories), true);
  assert.equal(isDescendant("c3", "c1", categories), false);
  const { errors } = validateCategoryDraft(
    { name_ar: "أ", name_en: "a", parent_id: "c2", sort_order: "0", active: true },
    { categories, currentId: "c1" },
  );
  assert.equal(errors.parent_id, "cycle");
});

test("category usage guard reports products and children", () => {
  const usage = categoryUsage("c3", products, categories);
  assert.equal(usage.productCount, 1);
  assert.equal(usage.childCount, 0);
});

// ── tree ─────────────────────────────────────────────────────────────────
test("builds a tree with depths and rolled-up product counts", () => {
  const tree = buildCategoryTree(categories, products);
  assert.equal(tree.length, 2); // c1 (root), c3 (root)
  const root = tree.find((n) => n.id === "c1")!;
  assert.equal(root.depth, 0);
  assert.equal(root.productCount, 0);
  assert.equal(root.descendantProductCount, 1); // Earrings under it
  assert.equal(root.children[0].depth, 1);
  assert.equal(flattenCategoryTree(tree).length, 2); // inactive c3 excluded by default
  assert.equal(flattenCategoryTree(tree, { includeInactive: true }).length, 3);
});

test("orphaned categories surface as roots instead of disappearing", () => {
  const orphaned: Category[] = [cat("cX", "Orphan", "missing")];
  const tree = buildCategoryTree(orphaned, []);
  assert.equal(tree.length, 1);
  assert.equal(tree[0].id, "cX");
});

// ── query ────────────────────────────────────────────────────────────────
test("normalises Arabic search text", () => {
  assert.equal(normalizeText("أَحْمَد"), normalizeText("احمد"));
  assert.equal(normalizeText("مكتبة"), normalizeText("مكتبه"));
});

test("search matches SKU, barcode, bilingual names and category names", () => {
  const nameOf = (id: string | null) => {
    const parts: string[] = [];
    let cursor = categories.find((c) => c.id === id);
    while (cursor) {
      parts.push(cursor.name_en);
      cursor = categories.find((c) => c.id === cursor?.parent_id);
    }
    return parts.join(" ");
  };
  assert.equal(queryProducts(products, { search: "alyq-2", categoryId: "all", status: "all", type: "all", stock: "all", visibility: "all", featured: false, sort: "name" }, nameOf).length, 1);
  assert.equal(queryProducts(products, { search: "200", categoryId: "all", status: "all", type: "all", stock: "all", visibility: "all", featured: false, sort: "name" }, nameOf)[0].id, "p2");
  assert.equal(queryProducts(products, { search: "أقراط", categoryId: "all", status: "all", type: "all", stock: "all", visibility: "all", featured: false, sort: "name" }, nameOf)[0].id, "p1");
  assert.equal(queryProducts(products, { search: "earrings", categoryId: "all", status: "all", type: "all", stock: "all", visibility: "all", featured: false, sort: "name" }, nameOf)[0].id, "p1");
  assert.equal(queryProducts(products, { search: "beverages", categoryId: "all", status: "all", type: "all", stock: "all", visibility: "all", featured: false, sort: "name" }, nameOf)[0].id, "p1");
});

test("status, category, uncategorized and type filters compose", () => {
  const nameOf = () => "";
  const run = (over: Partial<Parameters<typeof queryProducts>[1]>) =>
    queryProducts(
      products,
      { search: "", categoryId: "all", status: "all", type: "all", stock: "all", visibility: "all", featured: false, sort: "name", ...over },
      nameOf,
    ).map((p) => p.id);

  assert.deepEqual(run({ status: "inactive" }), ["p2"]);
  assert.deepEqual(run({ categoryId: "c2" }), ["p1"]);
  assert.deepEqual(run({ categoryId: "__uncategorized__" }), ["p3"]);
  assert.deepEqual(run({ type: "service" }), ["p3"]);
  assert.deepEqual(run({ status: "active", type: "physical" }), ["p1"]);
});

test("sorting by price and update time works", () => {
  const sorted = queryProducts(
    products,
    { search: "", categoryId: "all", status: "all", type: "all", stock: "all", visibility: "all", featured: false, sort: "price_desc" },
    () => "",
  );
  assert.deepEqual(sorted.map((p) => p.selling_price).sort((a, b) => b - a), sorted.map((p) => p.selling_price));
});

test("summarize counts active/inactive/barcoded products", () => {
  const stats = summarize(products, categories);
  assert.equal(stats.total, 3);
  assert.equal(stats.active, 2);
  assert.equal(stats.inactive, 1);
  assert.equal(stats.withBarcode, 2);
  assert.equal(stats.activeCategories, 2);
});

// ── stock + storefront flags ────────────────────────────────────────────
test("stock status derivation", () => {
  assert.equal(stockStatus({ stock_tracking_enabled: false, stock_quantity: 5, low_stock_level: 2 }), "none");
  assert.equal(stockStatus({ stock_tracking_enabled: true, stock_quantity: 0, low_stock_level: 5 }), "out");
  assert.equal(stockStatus({ stock_tracking_enabled: true, stock_quantity: 4, low_stock_level: 5 }), "low");
  assert.equal(stockStatus({ stock_tracking_enabled: true, stock_quantity: 10, low_stock_level: 5 }), "in");
});

test("stock and featured filters work", () => {
  const nameOf = () => "";
  const lowIds = products.filter((p) => stockStatus(p) === "low").map((p) => p.id);
  assert.deepEqual(
    queryProducts(products, { search: "", categoryId: "all", status: "all", type: "all", stock: "low", visibility: "all", featured: false, sort: "name" }, nameOf).map((p) => p.id),
    lowIds,
  );
  const featuredIds = products.filter((p) => p.is_featured).map((p) => p.id);
  assert.deepEqual(
    queryProducts(products, { search: "", categoryId: "all", status: "all", type: "all", stock: "all", visibility: "all", featured: true, sort: "name" }, nameOf).map((p) => p.id),
    featuredIds,
  );
});

test("validates stock quantity and low-stock level", () => {
  const base = { ...EMPTY_PRODUCT_FORM, sku: "S-1", name_ar: "أ", name_en: "a", category_id: "c1", selling_price: "1", cost_price: "1", tax_rate: "15" };
  assert.equal(validateProductDraft({ ...base, stock_quantity: "-3" }, { products, categories }).errors.stock_quantity, "nonnegative");
  assert.equal(validateProductDraft({ ...base, low_stock_level: "-1" }, { products, categories }).errors.low_stock_level, "nonnegative");
  const untracked = validateProductDraft({ ...base, stock_tracking_enabled: false, stock_quantity: "" }, { products, categories });
  assert.equal(untracked.errors.stock_quantity, undefined);
  assert.equal(untracked.data?.stock_quantity, 0);
});

// ── barcode: Code 128 ────────────────────────────────────────────────────

/**
 * Reference decoder used only by the tests. It reverses `encodeCode128` from
 * the emitted bar geometry, proving a real scanner would read back exactly
 * the value we encoded (requirement: POS scanner compatibility).
 */
const CODE128_PATTERNS_REF = [
  "212222","222122","222221","121223","121322","131222","122213","122312","132212","221213",
  "221312","231212","112232","122132","122231","113222","123122","123221","223211","221132",
  "221231","213212","223112","312131","311222","321122","321221","312212","322112","322211",
  "212123","212321","232121","111323","131123","131321","112313","132113","132311","211313",
  "231113","231311","112133","112331","132131","113123","113321","133121","313121","211331",
  "231131","213113","213311","213131","311123","311321","331121","312113","312311","332111",
  "314111","221411","431111","111224","111422","121124","121421","141122","141221","112214",
  "112412","122114","122411","142112","142211","241211","221114","413111","241112","134111",
  "111242","121142","121241","114212","124112","124211","411212","421112","421211","212141",
  "214121","412121","111143","111341","131141","114113","114311","411113","411311","113141",
  "114131","311141","411131","211412","211214","211232","2331112",
];

function decodeCode128(encoded: NonNullable<ReturnType<typeof encodeCode128>>): {
  payload: string;
  checksumOk: boolean;
} {
  // Rebuild the alternating bar/space run widths from the bar rectangles.
  const runs: number[] = [];
  let cursor = encoded.quietZone;
  for (const bar of encoded.bars) {
    if (bar.x > cursor) runs.push(bar.x - cursor); // preceding space
    runs.push(bar.width);
    cursor = bar.x + bar.width;
  }

  // Slice into symbols: 6 runs each, final stop symbol is 7 runs.
  const values: number[] = [];
  let i = 0;
  while (i < runs.length) {
    const take = runs.length - i === 7 ? 7 : 6;
    const pattern = runs.slice(i, i + take).join("");
    const value = CODE128_PATTERNS_REF.indexOf(pattern);
    values.push(value);
    i += take;
  }

  const start = values[0];
  const stop = values[values.length - 1];
  const checksum = values[values.length - 2];
  const data = values.slice(1, values.length - 2);

  let expected = start;
  data.forEach((v, index) => {
    expected += v * (index + 1);
  });

  const payload = data.map((v) => String.fromCharCode(v + 32)).join("");
  return { payload, checksumOk: stop === 106 && checksum === expected % 103 };
}

test("derives a barcode from the SKU (barcode === SKU)", () => {
  assert.equal(deriveBarcodeFromSku("TSHIRT-BLK-001"), "TSHIRT-BLK-001");
  assert.equal(deriveBarcodeFromSku("  alyq-1001 "), "ALYQ-1001");
  assert.equal(deriveBarcodeFromSku("a b c"), "A-B-C");
  assert.equal(deriveBarcodeFromSku("أقراط"), "");
  assert.equal(deriveBarcodeFromSku("SKU--X"), "SKU-X");
});

test("isDerivedFromSku detects auto vs manual barcodes", () => {
  assert.equal(isDerivedFromSku("TSHIRT-BLK-001", "TSHIRT-BLK-001"), true);
  assert.equal(isDerivedFromSku("TSHIRT-BLK-001", "6281000000013"), false);
  assert.equal(isDerivedFromSku("ALYQ-1", null), false);
});

test("Code 128 encodability + payload validation", () => {
  assert.equal(isEncodableCode128("TSHIRT-BLK-001"), true);
  assert.equal(isEncodableCode128("أقراط"), false);
  assert.equal(validateBarcodePayload(""), "empty");
  assert.equal(validateBarcodePayload("أقراط"), "unsupportedChar");
  assert.equal(validateBarcodePayload("A".repeat(49)), "tooLong");
  assert.equal(validateBarcodePayload("ALYQ-1001"), null);
});

test("Code 128 symbol has the correct structure and width", () => {
  const encoded = encodeCode128("ALYQ-1001", 10);
  assert.ok(encoded, "encodes");
  // start + n data + checksum = 11 modules each, stop = 13, plus 2 quiet zones
  const n = "ALYQ-1001".length;
  assert.equal(encoded!.width, 11 * (n + 2) + 13 + 20);
  assert.equal(encoded!.bars[0].x, 10, "leading quiet zone preserved");
});

test("Code 128 checksum matches the documented algorithm", () => {
  // PJJ123C is the canonical worked example for subset B.
  assert.equal(code128Checksum("PJJ123C"), 55);
});

test("encoded symbol round-trips through a reference decoder", () => {
  for (const value of ["TSHIRT-BLK-001", "ALYQ-1001", "6281000000013", "A1", "a-z_0.9"]) {
    const encoded = encodeCode128(value);
    assert.ok(encoded, `encodes ${value}`);
    const decoded = decodeCode128(encoded!);
    assert.equal(decoded.payload, value, `round-trips ${value}`);
    assert.ok(decoded.checksumOk, `checksum + stop valid for ${value}`);
  }
});

test("unsupported payloads encode to null instead of throwing", () => {
  assert.equal(encodeCode128("أقراط"), null);
  assert.equal(encodeCode128(""), null);
});

test("barcode label HTML contains name, SKU, barcode and price", () => {
  const html = buildBarcodeLabelHtml(
    {
      nameAr: "أقراط لؤلؤ",
      nameEn: "Arabic Earrings",
      sku: "ALYQ-1001",
      barcode: "ALYQ-1001",
      price: "EGP 32.50",
      copies: 2,
      direction: "rtl",
    },
    {
      documentTitle: "Barcode labels",
      skuLabel: "SKU",
      priceLabel: "Price",
      printAction: "Print",
      unsupported: "unsupported",
    },
  );
  assert.ok(html.includes("أقراط لؤلؤ"), "Arabic name present");
  assert.ok(html.includes("Arabic Earrings"), "English name present");
  assert.ok(html.includes("ALYQ-1001"), "SKU present");
  assert.ok(html.includes("EGP 32.50"), "price present");
  assert.ok(html.includes("<svg"), "barcode symbol embedded");
  assert.ok(html.includes('dir="rtl"'), "RTL direction honoured");
  assert.equal(html.split('class="label"').length - 1, 2, "renders the requested copies");
});

test("label escapes user content (no HTML injection)", () => {
  const html = buildBarcodeLabelHtml(
    {
      nameAr: "<script>alert(1)</script>",
      nameEn: "<img onerror=x>",
      sku: "A&B",
      barcode: "AB",
      price: "1",
      direction: "ltr",
    },
    { documentTitle: "t", skuLabel: "SKU", priceLabel: "P", printAction: "x", unsupported: "u" },
  );
  assert.ok(!html.includes("<script>alert(1)</script>"), "script tag escaped");
  assert.ok(html.includes("&lt;script&gt;"), "escaped form present");
  assert.ok(html.includes("A&amp;B"), "ampersand escaped");
});

test("barcodeToSvgString emits a standalone SVG", () => {
  const encoded = encodeCode128("ALYQ-1001");
  const svg = barcodeToSvgString(encoded!, { height: 40, moduleWidth: 2 });
  assert.ok(svg.startsWith("<svg"), "is an svg");
  assert.ok(svg.includes("ALYQ-1001"), "human-readable text included");
  assert.ok(svg.includes('xmlns="http://www.w3.org/2000/svg"'), "namespaced for standalone use");
});

// ── demo repository flows ────────────────────────────────────────────────
const repo = new DemoRepository();

async function main(): Promise<void> {
  console.log("\nPhase 2 · demo repository flows");
  await (async () => {
    await test("resolveProductImages splits cover from gallery and keeps order", async () => {
      const items: ProductImageItem[] = [
        { id: "r1", kind: "remote", url: "https://a.jpg" },
        { id: "r2", kind: "remote", url: "https://b.jpg" },
        { id: "r3", kind: "remote", url: "https://c.jpg" },
      ];
      const resolved = await resolveProductImages(items);
      assert.equal(resolved.image_url, "https://a.jpg");
      assert.deepEqual(resolved.images, ["https://b.jpg", "https://c.jpg"]);
    });

    await test("seeds demo catalog", async () => {
      const [cats, prods] = await Promise.all([repo.listCategories(), repo.listProducts()]);
      assert.ok(cats.length >= 7);
      assert.ok(prods.length >= 9);
    });

    await test("a cached catalogue from an older seed revision is replaced, a current one is kept", async () => {
      // The demo range is cached under a key the backup module also reads
      // (schema, health check, backup flow), so it cannot be renamed every time
      // the catalogue changes — that would orphan every snapshot already taken.
      // The state carries a revision instead. Both directions matter: a stale
      // default range has to be swapped out, and anything stamped with the
      // current revision — a shop's own edit, or a restored snapshot — has to be
      // left exactly alone.
      const map = new Map<string, string>();
      const storage = {
        getItem: (key: string) => map.get(key) ?? null,
        setItem: (key: string, value: string) => void map.set(key, value),
        removeItem: (key: string) => void map.delete(key),
      };
      const g = globalThis as Record<string, unknown>;
      const hadWindow = "window" in g;
      const hadLocalStorage = "localStorage" in g;
      const originalWindow = g.window;
      const originalLocalStorage = g.localStorage;
      // `window` as well as `localStorage`: safeStorage reads window.localStorage.
      Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true });
      Object.defineProperty(globalThis, "window", { value: { localStorage: storage }, configurable: true });
      try {
        const KEY = "alyq.demo.catalog.v1";
        map.set(
          KEY,
          JSON.stringify({
            categories: [{ id: "cat-old", name_ar: "مشروبات", name_en: "Beverages" }],
            products: [{ id: "prd-old", sku: "OLD-1", name_en: "Arabic Ground Coffee 250g" }],
            seed_revision: 1,
          }),
        );

        const prods = await new DemoRepository().listProducts();
        assert.ok(!prods.some((p) => p.sku === "OLD-1"), "the retired range is gone");
        assert.ok(prods.some((p) => p.sku === "ALYQ-1001"), "and the current one is in its place");
        const stamped = JSON.parse(map.get(KEY) ?? "{}") as { seed_revision?: number };
        assert.ok(
          typeof stamped.seed_revision === "number" && stamped.seed_revision !== 1,
          "the reseed is stamped with the current revision, so it happens once and not on every load",
        );

        const current = JSON.parse(map.get(KEY) ?? "{}") as { products: { name_en: string }[] };
        current.products[0]!.name_en = "Renamed by the shop";
        map.set(KEY, JSON.stringify(current));
        const kept = await new DemoRepository().listProducts();
        assert.equal(kept[0]?.name_en, "Renamed by the shop", "an edit at the current revision survives");
      } finally {
        if (hadWindow)
          Object.defineProperty(globalThis, "window", { value: originalWindow, configurable: true });
        else delete g.window;
        if (hadLocalStorage)
          Object.defineProperty(globalThis, "localStorage", {
            value: originalLocalStorage,
            configurable: true,
          });
        else delete g.localStorage;
      }
    });

    await test("create → duplicate SKU rejected → update → archive", async () => {
      const created = await repo.createProduct({
        sku: "TEST-900",
        barcode: null,
        name_ar: "منتج اختبار",
        name_en: "Test product",
        description_ar: null,
        description_en: null,
        category_id: null,
        product_type: "physical",
        selling_price: 20,
        cost_price: 10,
        tax_rate: 15,
        stock_tracking_enabled: true,
        stock_quantity: 8,
        low_stock_level: 3,
        show_on_website: true,
        is_featured: false,
        active: true,
        image_url: null,
        images: [],
      });
      assert.ok(created.id);

      await assert.rejects(
        () =>
          repo.createProduct({
            sku: "test-900",
            barcode: null,
            name_ar: "مكرر",
            name_en: "Duplicate",
            description_ar: null,
            description_en: null,
            category_id: null,
            product_type: "physical",
            selling_price: 1,
            cost_price: 1,
            tax_rate: 0,
            stock_tracking_enabled: false,
            stock_quantity: 0,
            low_stock_level: 0,
            show_on_website: true,
            is_featured: false,
            active: true,
            image_url: null,
            images: [],
          }),
        (error: { code: string }) => error.code === "DUPLICATE_SKU",
      );

      const updated = await repo.updateProduct(created.id, { selling_price: 25, barcode: "999000" });
      assert.equal(updated.selling_price, 25);

      await assert.rejects(
        () => repo.updateProduct(created.id, { barcode: "6281000000013" }),
        (error: { code: string }) => error.code === "DUPLICATE_BARCODE",
      );

      const cleared = await repo.updateProduct(created.id, { barcode: null });
      assert.equal(cleared.barcode, null);

      const archived = await repo.setProductActive(created.id, false);
      assert.equal(archived.active, false);
      const restored = await repo.setProductActive(created.id, true);
      assert.equal(restored.active, true);

    });

    await test("category deletion blocked while products reference it", async () => {
      const cats = await repo.listCategories();
      const prods = await repo.listProducts();
      const used = cats.find((c) => prods.some((p) => p.category_id === c.id));
      assert.ok(used);
      await assert.rejects(
        () => repo.deleteCategory(used!.id),
        // Phase 44: the repository raises the structured CATEGORY_NOT_EMPTY
        // (the live RPC raises the same rule; CATEGORY_IN_USE remains the
        // service/legacy code for the generic "still has content" case).
        (error: { code: string }) => error.code === "CATEGORY_NOT_EMPTY",
      );
    });

    await test("empty category can be deleted after deactivation is offered", async () => {
      const created = await repo.createCategory({
        name_ar: "تصنيف مؤقت",
        name_en: "Temporary",
        parent_id: null,
        active: false,
        sort_order: 99,
      });
      await repo.deleteCategory(created.id);
      const cats = await repo.listCategories();
      assert.ok(!cats.some((c) => c.id === created.id));
    });
  })();

  // ── Excel/CSV import ─────────────────────────────────────────────────────

  await (async () => {
    const { parseCsv, buildColumnMap, importProductsFromCsv, resolveCategoryIds } = await import(
      "@/modules/products/services/excelImport"
    );

    test("parseCsv: basic comma-separated values", () => {
      const rows = parseCsv("a,b,c\n1,2,3\n4,5,6");
      assert.equal(rows.length, 3);
      assert.deepEqual(rows[0], ["a", "b", "c"]);
      assert.deepEqual(rows[1], ["1", "2", "3"]);
    });

    test("parseCsv: quoted fields with commas", () => {
      const rows = parseCsv('name,desc\n"Hello, World","A ""quoted"" thing"');
      assert.equal(rows[1][0], "Hello, World");
      assert.equal(rows[1][1], 'A "quoted" thing');
    });

    test("parseCsv: embedded newlines in quoted fields", () => {
      const rows = parseCsv('a,b\n"line1\nline2",c');
      assert.equal(rows.length, 2);
      assert.equal(rows[1][0], "line1\nline2");
      assert.equal(rows[1][1], "c");
    });

    test("parseCsv: strips BOM", () => {
      const rows = parseCsv("\uFEFFa,b\n1,2");
      assert.equal(rows[0][0], "a");
    });

    test("parseCsv: handles Windows line endings", () => {
      const rows = parseCsv("a,b\r\n1,2\r\n3,4");
      assert.equal(rows.length, 3);
    });

    test("buildColumnMap: matches English headers", () => {
      const map = buildColumnMap(["SKU", "Name", "Price", "Cost", "Stock"]);
      assert.equal(map["0"], "sku");
      assert.equal(map["1"], "name_en");
      assert.equal(map["2"], "selling_price");
      assert.equal(map["3"], "cost_price");
      assert.equal(map["4"], "stock_quantity");
    });

    test("buildColumnMap: matches Arabic headers", () => {
      const map = buildColumnMap(["كود", "الاسم", "السعر", "الكمية"]);
      assert.equal(map["0"], "sku");
      assert.equal(map["1"], "name_ar");
      assert.equal(map["2"], "selling_price");
      assert.equal(map["3"], "stock_quantity");
    });

    test("importProductsFromCsv: valid rows parsed correctly", () => {
      const csv = "SKU,Name,Price,Cost,Stock\nALYQ-001,Earrings,32.50,15.00,10\nALYQ-002,Tea,25.00,10.00,20";
      const result = importProductsFromCsv(csv);
      assert.equal(result.totalRows, 2);
      assert.equal(result.validRows.length, 2);
      assert.equal(result.invalidRows.length, 0);
      assert.equal(result.validRows[0].data.sku, "ALYQ-001");
      assert.equal(result.validRows[0].data.selling_price, 32.50);
      assert.equal(result.validRows[0].data.cost_price, 15.00);
      assert.equal(result.validRows[0].data.stock_quantity, 10);
      assert.equal(result.validRows[1].data.sku, "ALYQ-002");
    });

    test("importProductsFromCsv: missing SKU flagged as error", () => {
      const csv = "SKU,Name,Price\n,Earrings,32.50";
      const result = importProductsFromCsv(csv);
      assert.equal(result.invalidRows.length, 1);
      assert.equal(result.invalidRows[0].errors[0].code, "required");
    });

    test("importProductsFromCsv: duplicate SKU within file", () => {
      const csv = "SKU,Name,Price\nDUP-1,Earrings,10\nDUP-1,Tea,20";
      const result = importProductsFromCsv(csv);
      assert.equal(result.validRows.length, 1);
      assert.equal(result.invalidRows.length, 1);
      assert.ok(result.invalidRows[0].errors.some((e) => e.code === "duplicateSku"));
    });

    test("importProductsFromCsv: negative price rejected", () => {
      const csv = "SKU,Name,Price\nX-1,Earrings,-5";
      const result = importProductsFromCsv(csv);
      assert.equal(result.invalidRows.length, 1);
      assert.ok(result.invalidRows[0].errors.some((e) => e.code === "nonnegative"));
    });

    test("importProductsFromCsv: empty file", () => {
      const result = importProductsFromCsv("");
      assert.equal(result.totalRows, 0);
      assert.ok(result.globalErrors.length > 0);
    });

    test("resolveCategoryIds: matches by name", () => {
      const csv = "SKU,Name,Price,Category\nX-1,Earrings,10,Beverages";
      const result = importProductsFromCsv(csv);
      const resolved = resolveCategoryIds(
        result.validRows,
        [{ id: "cat-1", name_ar: "مشروبات", name_en: "Beverages" }],
        null,
      );
      assert.equal(resolved[0].data.category_id, "cat-1");
    });

    test("resolveCategoryIds: falls back to default", () => {
      const csv = "SKU,Name,Price,Category\nX-1,Earrings,10,Unknown";
      const result = importProductsFromCsv(csv);
      const resolved = resolveCategoryIds(result.validRows, [], "default-cat");
      assert.equal(resolved[0].data.category_id, "default-cat");
    });
  })();

  console.log(`\nAll ${passed} logic tests passed.\n`);
}

void main();
