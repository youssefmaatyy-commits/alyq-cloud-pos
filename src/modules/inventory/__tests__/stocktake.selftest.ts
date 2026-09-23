/**
 * Live stocktake — demo adapter and the contracts the page must not break.
 *
 * The database cases (one transaction, RLS, backup order) live in
 * supabase/tests/scenarios.sql and run under `npm run db:check`.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { Product } from "@/modules/products/types";
import type { ProductVariant } from "@/modules/products/variants";
import {
  buildStocktakeRows,
  saveStocktake,
  scanStocktake,
  stocktakeConflicts,
  updateCount,
  createStocktake,
  moveToReview,
  STOCKTAKE_DEMO_KEY,
} from "../services/stocktake";

function repoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 6; i += 1) {
    if (fs.existsSync(path.join(dir, "supabase/migrations"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("could not locate the repository root from " + process.cwd());
}

const root = repoRoot();

function installStorage(): void {
  const map = new Map<string, string>();
  const storage = {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
    clear: () => map.clear(),
  };
  try {
    Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true });
  } catch {
    (globalThis as { localStorage?: typeof storage }).localStorage = storage;
  }
}
installStorage();

function product(patch: Partial<Product> & Pick<Product, "id" | "sku">): Product {
  return {
    name_ar: patch.sku,
    name_en: patch.sku,
    barcode: null,
    category_id: "cat",
    selling_price: 10,
    cost_price: 4,
    stock_quantity: 0,
    stock_tracking_enabled: true,
    active: true,
    variants_enabled: false,
    image_url: null,
    description_ar: null,
    description_en: null,
    tax_rate: 0,
    product_type: "physical",
    created_at: "2026-09-23T00:00:00.000Z",
    updated_at: "2026-09-23T00:00:00.000Z",
    low_stock_level: 0,
    show_on_website: false,
    ...patch,
  } as Product;
}

function variant(patch: Partial<ProductVariant> & Pick<ProductVariant, "id" | "product_id" | "sku">): ProductVariant {
  return {
    barcode: null,
    color_key: "gold",
    color_ar: null,
    color_en: null,
    color_hex: null,
    size: null,
    size_label: null,
    image_url: null,
    price_override: null,
    cost_override: null,
    stock_quantity: 0,
    low_stock_level: 0,
    active: true,
    sort_order: 0,
    created_at: "2026-09-23T00:00:00.000Z",
    updated_at: "2026-09-23T00:00:00.000Z",
    ...patch,
  };
}

const ring = product({ id: "ring", sku: "RING", name_en: "Ring", name_ar: "خاتم", variants_enabled: true, stock_quantity: 7 });
const gold = variant({
  id: "gold-17",
  product_id: "ring",
  sku: "RING-G17",
  barcode: "G17",
  color_key: "gold",
  color_en: "Gold",
  color_ar: "ذهبي",
  size: 17,
  stock_quantity: 4,
});
const silver = variant({
  id: "silver-17",
  product_id: "ring",
  sku: "RING-S17",
  barcode: "S17",
  color_key: "silver",
  color_en: "Silver",
  color_ar: "فضي",
  size: 17,
  stock_quantity: 3,
});
const plain = product({ id: "plain", sku: "PLAIN", stock_quantity: 10 });

const tests: Array<[string, () => void]> = [];
const test = (name: string, fn: () => void) => tests.push([name, fn]);

test("gold/17 and silver/17 are separate shelves, and a variant product is not one row", () => {
  const rows = buildStocktakeRows([ring, plain], [gold, silver]);
  assert.deepEqual(rows.map((row) => row.sku).sort(), ["PLAIN", "RING-G17", "RING-S17"]);
  assert.equal(rows.filter((row) => row.productId === "ring" && row.variantId === null).length, 0);
  const goldRow = rows.find((row) => row.sku === "RING-G17");
  assert.equal(goldRow?.snapshotQuantity, 4);
  assert.equal(goldRow?.variantLabel.includes("Gold"), true);
  assert.equal(goldRow?.variantLabel.includes("17"), true);
});

test("a later catalogue quantity does not rewrite the snapshot", () => {
  installStorage();
  const session = createStocktake([plain], [], "Amina");
  assert.ok(session);
  const counted = updateCount(session, 0, 8);
  const saved = saveStocktake({
    ...counted,
    rows: counted.rows.map((row) => ({ ...row, systemQuantity: 99, snapshotQuantity: 99 })),
  });
  assert.equal(saved.rows[0].snapshotQuantity, 10);
  assert.equal(saved.rows[0].systemQuantity, 10);
  assert.equal(saved.rows[0].variance, -2);
  const stored = JSON.parse(localStorage.getItem(STOCKTAKE_DEMO_KEY) ?? "[]") as Array<{ rows: Array<{ snapshotQuantity: number }> }>;
  assert.equal(stored[0].rows[0].snapshotQuantity, 10);
});

test("a moved shelf is a conflict and a matching shelf is not", () => {
  installStorage();
  const session = createStocktake([ring, plain], [gold, silver], "Amina");
  assert.ok(session);
  const moved = { ...silver, stock_quantity: 1 };
  const conflicts = stocktakeConflicts(session, [ring, plain], [gold, moved]);
  assert.deepEqual(conflicts.map((row) => row.sku), ["RING-S17"]);
  assert.equal(conflicts[0].expected, 3);
  assert.equal(conflicts[0].current, 1);
  assert.equal(stocktakeConflicts(session, [ring, plain], [gold, silver]).length, 0);
});

test("review waits for every physical count, and a scan increments one exact row", () => {
  localStorage.clear();
  const session = createStocktake([ring], [gold, silver], "Amina");
  assert.ok(session);
  assert.equal(moveToReview(session).status, "counting");
  const scanned = scanStocktake(session, "s17");
  assert.equal(scanned.rows.find((row) => row.sku === "RING-S17")?.physicalQuantity, 1);
  assert.equal(scanned.rows.find((row) => row.sku === "RING-G17")?.physicalQuantity, null);
});

test("a finalized session ignores a later count edit", () => {
  installStorage();
  const session = createStocktake([plain], [], "Amina");
  assert.ok(session);
  const finalized = { ...session, status: "finalized" as const };
  localStorage.setItem(STOCKTAKE_DEMO_KEY, JSON.stringify([finalized]));
  const edited = updateCount(finalized, 0, 1);
  assert.equal(edited.rows[0].physicalQuantity, null);
  const saved = saveStocktake({
    ...finalized,
    status: "counting",
    rows: finalized.rows.map((row) => ({ ...row, physicalQuantity: 1, snapshotQuantity: 99 })),
  });
  assert.equal(saved.status, "finalized");
  assert.equal(saved.rows[0].physicalQuantity, null);
  assert.equal(saved.rows[0].snapshotQuantity, 10);
});

test("live stocktake does not read the demo key, and the page does not finalize row by row", () => {
  const service = fs.readFileSync(path.join(root, "src/modules/inventory/services/stocktakeService.ts"), "utf8");
  const page = fs.readFileSync(path.join(root, "src/modules/inventory/pages/StocktakePage.tsx"), "utf8");
  const migration = fs.readFileSync(path.join(root, "supabase/migrations/0060_live_stocktake.sql"), "utf8");
  assert.match(service, /stocktake_finalize/);
  assert.match(service, /if \(!liveMode\(\)\)/);
  assert.doesNotMatch(page, /adjustStockToCount/);
  assert.match(page, /finalizeStocktake/);
  assert.match(migration, /stocktake_finalize/);
  assert.match(migration, /STOCKTAKE_CONFLICT/);
  assert.doesNotMatch(migration, /grant execute on function public\.stocktake_finalize\(uuid\) to anon/);
  assert.match(migration, /'stocktakes'/);
  assert.match(migration, /'stocktake_lines'/);
});

let failed = 0;
for (const [name, fn] of tests) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`  ✗ ${name}`);
    console.error(error);
  }
}
if (failed > 0) {
  console.error(`stocktake.selftest.ts → ${failed} failed`);
  process.exit(1);
}
console.log(`stocktake.selftest.ts → ${tests.length}/${tests.length} passed`);
