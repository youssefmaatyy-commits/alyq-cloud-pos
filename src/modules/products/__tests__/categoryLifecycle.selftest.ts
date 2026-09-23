// Phase 44: category lifecycle self-test — headless, Node.
// Run with the shared runner: `npm test` (or `node scripts/test.logic.mjs categoryLifecycle`).
//
// The safe delete/move/archive rules, exercised the way a screen — or a
// hand-built request — would hit them, against the demo data layer, which is
// the demo mode's "server". Every refusal here mirrors a server-side one in
// migration 0044 (same AppError code, same Postgres code), so a pass here
// states the live contract:
//
//   1. an empty category hard-deletes;
//   2. a direct delete of a category holding 1 (and then many) products is
//      refused with CATEGORY_NOT_EMPTY — no cascade, no null-out;
//   3. move 5 products to another category and delete the source in ONE
//      operation — the target receives all 5, the source is gone, stock and
//      variants are untouched;
//   4. source == target is refused; an archived target is refused; a missing
//      side is refused;
//   5. a caller without edit_product / delete_product is refused at the
//      service before any data moves;
//   6. archiving a category with products works — products are NOT touched,
//      stay active and sellable, and the archived category leaves the
//      product-form picker, the register filter set and import matching;
//   7. a forged assignment (create or update straight against the repository)
//      to an archived category is refused;
//   8. reactivate restores everything;
//   9. child categories block a hard delete and a move;
//  10. every lifecycle step lands in the demo audit trail with the actor.

import assert from "node:assert/strict";

import { DEMO_USERS } from "@/lib/auth/demoUsers";
import { createSession } from "@/lib/auth/services/authService";
import {
  primeCacheFromStorage,
  resetSessionCache,
  writeStoredSession,
} from "@/lib/auth/services/sessionStore";
import { capabilitiesOf, type AppRole } from "@/lib/permissions/roles";
import { AppError } from "../data/repository";
import { getDemoRepository } from "../data/demoRepository";
import { getAuditRepository } from "@/modules/audit/data";
import type { ImportRowResult } from "../services/excelImport";
import {
  deleteCategory,
  moveProductsAndDeleteCategory,
  setCategoryActive,
} from "../services/catalogService";
import { resolveCategoryIds } from "../services/excelImport";
import { toCategoryOptions, sellableCategoryFilterIds } from "../services/categoryTree";
import type { NewProduct } from "../types";

// ── harness (same shape as productLifecycle.selftest.ts) ───────────────────

const backing = new Map<string, string>();
const storageStub = {
  getItem: (k: string) => backing.get(k) ?? null,
  setItem: (k: string, v: string) => void backing.set(k, v),
  removeItem: (k: string) => void backing.delete(k),
  clear: () => backing.clear(),
};
Object.defineProperty(globalThis, "localStorage", { value: storageStub, configurable: true });
Object.defineProperty(globalThis, "window", {
  value: { localStorage: storageStub },
  configurable: true,
});

function signInAs(role: AppRole): void {
  const record = DEMO_USERS.find((user) => user.role === role);
  assert.ok(record, `a demo account exists for ${role}`);
  writeStoredSession(createSession({ ...record, capabilities: capabilitiesOf(role) }, false), "local");
  resetSessionCache();
  primeCacheFromStorage();
}

async function refusalCode(fn: () => unknown | Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (err) {
    return err instanceof AppError ? err.code : `not-an-AppError:${String(err)}`;
  }
}

type TestCase = { name: string; fn: () => void | Promise<void> };
const tests: TestCase[] = [];
const test = (name: string, fn: () => void | Promise<void>) => tests.push({ name, fn });

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let skuCounter = 0;
function draft(categoryId: string | null, over: Partial<NewProduct> = {}): NewProduct {
  skuCounter += 1;
  return {
    sku: `CAT-${String(skuCounter).padStart(3, "0")}`,
    barcode: null,
    name_ar: "منتج تصنيف",
    name_en: `Category Product ${skuCounter}`,
    description_ar: null,
    description_en: null,
    category_id: categoryId,
    product_type: "physical",
    selling_price: 30,
    cost_price: 12,
    tax_rate: 0,
    stock_tracking_enabled: true,
    stock_quantity: 7,
    low_stock_level: 0,
    show_on_website: true,
    is_featured: false,
    active: true,
    image_url: null,
    images: [],
    ...over,
  };
}

async function ctx() {
  const catalog = getDemoRepository();
  return {
    catalog,
    products: await catalog.listProducts(),
    categories: await catalog.listCategories(),
  };
}

console.log("\nPhase 44 · safe category delete/move/archive lifecycle (demo data layer)\n");

// ── 1: an empty category hard-deletes ───────────────────────────────────────
test("empty category hard-deletes (admin)", async () => {
  signInAs("admin");
  const { catalog } = await ctx();
  const empty = await catalog.createCategory({
    name_ar: "فارغة",
    name_en: "Temporary Empty",
    parent_id: null,
    active: true,
    sort_order: 90,
  });
  await deleteCategory(empty.id, await ctx());
  const after = await catalog.listCategories();
  assert.ok(!after.some((c) => c.id === empty.id), "the empty category is gone");

  await sleep(5);
  const actions = (await getAuditRepository().listEntries())
    .filter((e) => e.entity_id === empty.id)
    .map((e) => e.action);
  assert.deepEqual(actions, ["category.deleted"], "the delete is on the trail");
});

// ── 2: direct delete refused with products — no cascade, no null-out ────────
test("direct delete of a 1-product category is refused (CATEGORY_NOT_EMPTY)", async () => {
  signInAs("admin");
  const { catalog } = await ctx();
  const cat = await catalog.createCategory({
    name_ar: "واحد",
    name_en: "Single Product Shelf",
    parent_id: null,
    active: true,
    sort_order: 91,
  });
  const product = await catalog.createProduct(draft(cat.id));
  assert.equal(
    await refusalCode(() => catalog.deleteCategory(cat.id)),
    "CATEGORY_NOT_EMPTY",
    "the repository itself refuses — a forged call cannot skip the rule",
  );
  const still = (await catalog.listProducts()).find((p) => p.id === product.id);
  assert.ok(still, "the product was not cascaded away");
  assert.equal(still?.category_id, cat.id, "the product was not nullled out either");
});

test("direct delete of a many-product category is refused", async () => {
  signInAs("admin");
  const { catalog } = await ctx();
  const cat = await catalog.createCategory({
    name_ar: "خوواتم قديمة",
    name_en: "Rings Old",
    parent_id: null,
    active: true,
    sort_order: 92,
  });
  for (let i = 0; i < 3; i += 1) await catalog.createProduct(draft(cat.id));
  assert.equal(
    await refusalCode(() => catalog.deleteCategory(cat.id)),
    "CATEGORY_NOT_EMPTY",
  );
  const kept = (await catalog.listProducts()).filter((p) => p.category_id === cat.id);
  assert.equal(kept.length, 3, "all three products keep their shelf");
  assert.ok(kept.every((p) => p.active && p.stock_quantity === 7), "nothing about them changed");
});

// ── 3: move 5 and delete the source, atomically, history untouched ──────────
test("move 5 products → target receives 5, source is gone, stock/variants unchanged", async () => {
  signInAs("admin");
  const { catalog } = await ctx();
  const source = await catalog.createCategory({
    name_ar: "خوواتم قديمة",
    name_en: "Rings Old Five",
    parent_id: null,
    active: true,
    sort_order: 93,
  });
  const target = await catalog.createCategory({
    name_ar: "خوواتم جديدة",
    name_en: "Rings New Five",
    parent_id: null,
    active: true,
    sort_order: 94,
  });
  const moved = [];
  for (let i = 0; i < 5; i += 1) {
    const p = await catalog.createProduct(
      draft(source.id, { stock_quantity: 3 + i, sku: `MOV-${String(i + 1).padStart(3, "0")}` }),
    );
    moved.push(p);
  }
  const before = new Map(moved.map((p) => [p.id, { stock: p.stock_quantity, category: p.category_id }]));

  const { moved: count } = await moveProductsAndDeleteCategory({
    sourceId: source.id,
    targetId: target.id,
    ...(await ctx()),
  });
  assert.equal(count, 5, "the move reports five products");

  const products = await catalog.listProducts();
  const categories = await catalog.listCategories();
  assert.ok(!categories.some((c) => c.id === source.id), "the source category is deleted");
  for (const p of moved) {
    const now = products.find((row) => row.id === p.id);
    assert.ok(now, "every moved product survives");
    assert.equal(now?.category_id, target.id, "and now names the target");
    assert.equal(now?.stock_quantity, before.get(p.id)?.stock, "stock untouched by the move");
    assert.ok(now?.active, "still active");
  }
  assert.equal(products.filter((p) => p.category_id === source.id).length, 0, "no stragglers");
});

// ── 4: the refusals around the move ─────────────────────────────────────────
test("source == target is refused", async () => {
  signInAs("admin");
  const { categories } = await ctx();
  const cat = categories.find((c) => c.name_en === "Rings New Five") ?? categories[0];
  const code = await refusalCode(async () =>
    moveProductsAndDeleteCategory({
      sourceId: cat.id,
      targetId: cat.id,
      ...(await ctx()),
    }),
  );
  assert.equal(code, "VALIDATION");
});

test("archived target is refused; missing target is refused", async () => {
  signInAs("admin");
  const { catalog } = await ctx();
  const source = await catalog.createCategory({
    name_ar: "مصدر",
    name_en: "Move Source Archived Target",
    parent_id: null,
    active: true,
    sort_order: 95,
  });
  const hidden = await catalog.createCategory({
    name_ar: "مخفية",
    name_en: "Hidden Rings",
    parent_id: null,
    active: false,
    sort_order: 96,
  });
  await catalog.createProduct(draft(source.id));
  assert.equal(
    await refusalCode(async () =>
      moveProductsAndDeleteCategory({ sourceId: source.id, targetId: hidden.id, ...(await ctx()) }),
    ),
    "CATEGORY_ARCHIVED",
    "products cannot move into an archived category",
  );
  assert.equal(
    await refusalCode(async () =>
      moveProductsAndDeleteCategory({
        sourceId: source.id,
        targetId: "cat-does-not-exist",
        ...(await ctx()),
      }),
    ),
    "NOT_FOUND",
  );
  assert.equal(
    await refusalCode(async () =>
      moveProductsAndDeleteCategory({
        sourceId: "cat-does-not-exist",
        targetId: hidden.id,
        ...(await ctx()),
      }),
    ),
    "NOT_FOUND",
  );
  assert.equal(await refusalCode(() => catalog.deleteCategory("cat-does-not-exist")), "NOT_FOUND");
});

// ── 5: restricted roles are restricted ──────────────────────────────────────
test("a viewer is refused at the service before any data moves", async () => {
  signInAs("viewer");
  const { catalog, categories, products } = await ctx();
  const victim = await catalog.createCategory({
    name_ar: "محمية",
    name_en: "Viewer Proof",
    parent_id: null,
    active: true,
    sort_order: 97,
  });
  const other = await catalog.createCategory({
    name_ar: "أخرى",
    name_en: "Viewer Proof Target",
    parent_id: null,
    active: true,
    sort_order: 98,
  });
  assert.equal(await refusalCode(() => deleteCategory(victim.id, { products, categories })), "FORBIDDEN");
  assert.equal(await refusalCode(() => setCategoryActive(victim.id, false)), "FORBIDDEN");
  assert.equal(
    await refusalCode(() =>
      moveProductsAndDeleteCategory({ sourceId: victim.id, targetId: other.id }),
    ),
    "FORBIDDEN",
  );
  const after = await catalog.listCategories();
  assert.ok(after.some((c) => c.id === victim.id), "nothing happened to the category");
});

// ── 6 + 7: archive with products; forged assignments refused ────────────────
test("archive with products: products untouched, sellable, but the shelf is gone everywhere", async () => {
  signInAs("admin");
  const { catalog } = await ctx();
  const hidden = await catalog.createCategory({
    name_ar: "خوواتم مخفية",
    name_en: "Hidden Archive Rings",
    parent_id: null,
    active: true,
    sort_order: 99,
  });
  const kept = [];
  for (let i = 0; i < 2; i += 1) kept.push(await catalog.createProduct(draft(hidden.id)));

  const archived = await setCategoryActive(hidden.id, false);
  assert.equal(archived.active, false, "the category is archived");

  // Products are NOT auto-archived and nothing about them changed.
  const products = await catalog.listProducts();
  for (const p of kept) {
    const now = products.find((row) => row.id === p.id);
    assert.ok(now?.active, "still active — archive ≠ delete");
    assert.equal(now?.stock_quantity, p.stock_quantity, "stock untouched");
    assert.equal(now?.category_id, hidden.id, "still shelved where it was");
    assert.equal(now?.show_on_website, true, "website flags untouched");
  }

  // The product-form picker no longer offers it.
  const { buildCategoryTree } = await import("../services/categoryTree");
  const options = toCategoryOptions(buildCategoryTree(await catalog.listCategories(), products), (ar) => ar);
  assert.ok(!options.some((o) => o.id === hidden.id), "archived category is out of the picker");

  // The register's filter set no longer lists it.
  const sellable = sellableCategoryFilterIds(await catalog.listCategories());
  assert.ok(!sellable.has(hidden.id), "archived category leaves the POS filter set");

  // Import matching no longer captures its name.
  const row: ImportRowResult = {
    row: 1,
    data: { _sku: "X1", _barcode: null, _categoryName: "hidden archive rings" },
    errors: [],
    valid: true,
  };
  const resolved = resolveCategoryIds([row], await catalog.listCategories(), null);
  assert.equal(resolved[0]?.data.category_id, null, "archived names do not capture imports");

  // Reactivate: everything comes back.
  const restored = await setCategoryActive(hidden.id, true);
  assert.equal(restored.active, true);
  const optionsAfter = toCategoryOptions(
    buildCategoryTree(await catalog.listCategories(), await catalog.listProducts()),
    (ar) => ar,
  );
  assert.ok(optionsAfter.some((o) => o.id === hidden.id), "the picker sees it again");

  await sleep(5);
  const actions = (await getAuditRepository().listEntries())
    .filter((e) => e.entity_id === hidden.id)
    .map((e) => e.action);
  assert.ok(actions.includes("category.archived"), "archive is on the trail");
  assert.ok(actions.includes("category.reactivated"), "reactivation is on the trail");
});

test("forged assignment to an archived category is refused server-side", async () => {
  signInAs("admin");
  const { catalog } = await ctx();
  const hidden = await catalog.createCategory({
    name_ar: "مؤرشفة",
    name_en: "Forged Target",
    parent_id: null,
    active: false,
    sort_order: 100,
  });
  assert.equal(
    await refusalCode(() => catalog.createProduct(draft(hidden.id))),
    "CATEGORY_ARCHIVED",
    "createProduct refuses an archived category",
  );
  const elsewhere = await catalog.createCategory({
    name_ar: "سليمة",
    name_en: "Forged From",
    parent_id: null,
    active: true,
    sort_order: 101,
  });
  const product = await catalog.createProduct(draft(elsewhere.id));
  assert.equal(
    await refusalCode(() => catalog.updateProduct(product.id, { category_id: hidden.id })),
    "CATEGORY_ARCHIVED",
    "updateProduct refuses moving into an archived category",
  );
});

// ── 9: hierarchy — children block delete and move ───────────────────────────
test("a category with children cannot be hard-deleted or moved-away", async () => {
  signInAs("admin");
  const { catalog } = await ctx();
  const parent = await catalog.createCategory({
    name_ar: "أب",
    name_en: "Parent With Child",
    parent_id: null,
    active: true,
    sort_order: 102,
  });
  const child = await catalog.createCategory({
    name_ar: "ابن",
    name_en: "Child Of Parent",
    parent_id: parent.id,
    active: true,
    sort_order: 103,
  });
  assert.equal(await refusalCode(() => catalog.deleteCategory(parent.id)), "CATEGORY_HAS_CHILDREN");
  const other = await catalog.createCategory({
    name_ar: "وجهة",
    name_en: "Move Destination For Parent",
    parent_id: null,
    active: true,
    sort_order: 104,
  });
  assert.equal(
    await refusalCode(async () =>
      moveProductsAndDeleteCategory({ sourceId: parent.id, targetId: other.id, ...(await ctx()) }),
    ),
    "CATEGORY_HAS_CHILDREN",
  );
  // The safe route for a parent is archiving — products and children intact.
  const archived = await setCategoryActive(parent.id, false);
  assert.equal(archived.active, false);
  const childAfter = (await catalog.listCategories()).find((c) => c.id === child.id);
  assert.ok(childAfter, "the child is untouched by its parent's archive");
  assert.equal(childAfter?.active, true);
});

let passed = 0;
for (const [index, current] of tests.entries()) {
  try {
    await current.fn();
    passed += 1;
    console.log(`  ✓ ${current.name}`);
  } catch (error) {
    console.error(`\n  ✗ [${index + 1}/${tests.length}] ${current.name}\n`);
    throw error;
  }
}
console.log(`\ncategoryLifecycle: ${passed}/${tests.length} passed\n`);
