/** The Add/Edit combination draft and the shelf-stock edit guard. Run with `npm test`. */
import assert from "node:assert/strict";
import { DEMO_USERS } from "@/lib/auth/demoUsers";
import { createSession } from "@/lib/auth/services/authService";
import { primeCacheFromStorage, resetSessionCache, writeStoredSession } from "@/lib/auth/services/sessionStore";
import { capabilitiesOf } from "@/lib/permissions/roles";
import { getDemoRepository } from "../data/demoRepository";
import { AppError, describeError } from "../data/repository";
import type { NewProduct } from "../types";
import { suggestVariantSku, type ProductVariant } from "../variants";
import { generateVariants, saveVariant } from "../services/variantService";
import { deriveBarcodeFromSku, nextBarcodeOnSkuChange } from "../services/barcode";
import {
  EMPTY_PRODUCT_VARIANT_FORM, reconcileVariantDraft, validateVariantDraft,
  variantDraftFromSaved, variantDraftTotal, type ProductVariantFormValue,
} from "../services/variantDraft";

const backing = new Map<string, string>();
const storage = {
  getItem: (key: string) => backing.get(key) ?? null,
  setItem: (key: string, value: string) => void backing.set(key, value),
  removeItem: (key: string) => void backing.delete(key),
  clear: () => backing.clear(),
};
Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true });
Object.defineProperty(globalThis, "window", { value: { localStorage: storage }, configurable: true });
function signIn(role: "admin" | "viewer") {
  const account = DEMO_USERS.find((user) => user.role === role)!;
  writeStoredSession(createSession({ ...account, capabilities: capabilitiesOf(role) }, false), "local");
  resetSessionCache();
  primeCacheFromStorage();
}
const repo = getDemoRepository();
let count = 0;
async function test(name: string, run: () => void | Promise<void>) {
  await run();
  count += 1;
  console.log(`  ✓ ${name}`);
}
const color = (id: string, name: string) => ({ id, color_ar: "", color_en: name, color_hex: "", image_urls: [], image_url: "" });

await test("auto-generated colour × size rows keep independent stock and preserve edits across chip changes", () => {
  let draft = reconcileVariantDraft({ ...EMPTY_PRODUCT_VARIANT_FORM, mode: "colors_sizes",
    colors: [color("color:gold", "Gold"), color("color:silver", "Silver")], sizes: ["17", "18"], rows: [] }, "RING");
  assert.deepEqual(draft.rows.map((r) => `${r.color_en}/${r.size}`), ["Gold/17", "Gold/18", "Silver/17", "Silver/18"]);
  assert.equal(new Set(draft.rows.map((r) => r.sku)).size, 4);
  draft = { ...draft, rows: draft.rows.map((row) => row.size === "17" && row.color_en === "Gold"
    ? { ...row, stock_quantity: "2", barcode: "G17" } : row) };
  draft = reconcileVariantDraft({ ...draft, sizes: ["17", "18", "19"] }, "RING");
  assert.equal(draft.rows.length, 6);
  assert.equal(draft.rows[0].barcode, "G17");
  assert.equal(variantDraftTotal(draft.rows), 2);
  assert.equal(validateVariantDraft(draft, "RING", "BASE-BAR"), null);
  assert.equal(validateVariantDraft({ ...draft, rows: draft.rows.map((row, index) =>
    index === 1 ? { ...row, barcode: "G17" } : row) }, "RING"), "duplicateBarcode");
  assert.equal(validateVariantDraft({ ...draft, rows: draft.rows.map((row, index) =>
    index === 1 ? { ...row, stock_quantity: "-1" } : row) }, "RING"), "invalidQuantity");
  assert.equal(validateVariantDraft({ ...draft, colors: [draft.colors[0], color("color:duplicate", " gold ")] }, "RING"), "duplicateColor");
  assert.equal(validateVariantDraft({ ...draft, mode: "sizes", colors: [], sizes: [] }, "RING"), "sizesRequired");
});

await test("a freshly generated colour × size combination is never barcode-less: it gets deriveBarcodeFromSku(sku) immediately", () => {
  const draft = reconcileVariantDraft({ ...EMPTY_PRODUCT_VARIANT_FORM, mode: "colors_sizes",
    colors: [color("color:gold", "Gold")], sizes: ["17"], rows: [] }, "RING");
  assert.equal(draft.rows.length, 1);
  const row = draft.rows[0];
  assert.notEqual(row.barcode, "", "a brand-new row must not be left blank");
  assert.equal(row.barcode, deriveBarcodeFromSku(row.sku), "the row's own barcode is derived from its own SKU, deterministically");
  // Determinism: reconciling again from the exact same inputs reproduces the
  // exact same barcode — no randomness, no time-based component anywhere.
  const again = reconcileVariantDraft({ ...EMPTY_PRODUCT_VARIANT_FORM, mode: "colors_sizes",
    colors: [color("color:gold", "Gold")], sizes: ["17"], rows: [] }, "RING");
  assert.equal(again.rows[0].barcode, row.barcode);
});

await test("nextBarcodeOnSkuChange regenerates while in auto mode but preserves a manual override", () => {
  // Auto mode: blank barcode always follows the new SKU.
  assert.equal(nextBarcodeOnSkuChange("RING-GOLD-17", "RING-GOLD-18", ""), deriveBarcodeFromSku("RING-GOLD-18"));
  // Auto mode: a barcode that still matches the OLD sku's derivation is
  // considered "auto" and follows the SKU change too.
  assert.equal(
    nextBarcodeOnSkuChange("RING-GOLD-17", "RING-GOLD-18", deriveBarcodeFromSku("RING-GOLD-17")),
    deriveBarcodeFromSku("RING-GOLD-18"),
  );
  // Manual override: once the barcode has diverged from what the OLD sku
  // would derive, a SKU edit must never silently replace it.
  assert.equal(nextBarcodeOnSkuChange("RING-GOLD-17", "RING-GOLD-18", "MANUFACTURER-CODE-9"), "MANUFACTURER-CODE-9");
});

await test("generateVariants persists the derived barcode automatically, and saveVariant derives one for a manually added combination left blank", async () => {
  signIn("admin");
  const input: NewProduct = {
    sku: "GEN-RING", barcode: null, name_ar: "خاتم", name_en: "Generated ring", description_ar: null,
    description_en: null, category_id: null, product_type: "physical", selling_price: 150,
    cost_price: 80, tax_rate: 0, stock_tracking_enabled: true, stock_quantity: 0,
    low_stock_level: 1, show_on_website: true, is_featured: false, active: true,
    image_url: null, images: [],
  };
  const product = await repo.createProduct(input);
  const [generated] = await generateVariants({
    product,
    rows: [{
      color: { color_ar: "ذهبي", color_en: "Gold", color_hex: "#d4af37" },
      size: 17, size_label: null, size_value: "17", size_sort_order: 17,
      sku: "GEN-RING-GOLD-17", enabled: true,
    }],
    siblings: [],
    lowStockLevel: 1,
  });
  assert.equal(generated.barcode, deriveBarcodeFromSku("GEN-RING-GOLD-17"),
    "a generated combination's barcode is automatically derived, never left null");

  // A manually added combination (saveVariant, not the generator) with no
  // barcode typed in must also end up with the deterministic one — manual
  // creation is not a loophole around auto-generation.
  const manual = (await saveVariant({
    product,
    values: {
      sku: "GEN-RING-SILVER-18", barcode: "", color_ar: "فضي", color_en: "Silver", color_hex: "#c0c0c0",
      size: 18, size_label: null, image_url: null, price_override: null, cost_override: null,
      stock_quantity: 0, low_stock_level: 1, active: true, sort_order: 2,
    },
    siblings: [generated],
  })).variant;
  assert.equal(manual.barcode, deriveBarcodeFromSku("GEN-RING-SILVER-18"));

  // An explicit manual barcode on a manually added combination is respected verbatim.
  const overridden = (await saveVariant({
    product,
    values: {
      sku: "GEN-RING-ROSE-19", barcode: "SUPPLIER-CODE-7", color_ar: "وردي", color_en: "Rose", color_hex: "#e8b4b8",
      size: 19, size_label: null, image_url: null, price_override: null, cost_override: null,
      stock_quantity: 0, low_stock_level: 1, active: true, sort_order: 3,
    },
    siblings: [generated, manual],
  })).variant;
  assert.equal(overridden.barcode, "SUPPLIER-CODE-7");
});

await test("no variants, colour-only and size-only modes generate only the requested shelf identities", () => {
  const colors = reconcileVariantDraft({ ...EMPTY_PRODUCT_VARIANT_FORM, mode: "colors",
    colors: [color("color:gold", "Gold"), color("color:silver", "Silver")], rows: [] }, "RING");
  assert.deepEqual(colors.rows.map((row) => [row.color_en, row.size, row.size_label]),
    [["Gold", "", ""], ["Silver", "", ""]]);
  assert.equal(validateVariantDraft(colors, "RING"), null);
  const sizes = reconcileVariantDraft({ ...EMPTY_PRODUCT_VARIANT_FORM, mode: "sizes",
    sizes: ["18", "17"], rows: [] }, "RING");
  assert.deepEqual(sizes.rows.map((row) => [row.color_en, row.size]), [["", "18"], ["", "17"]],
    "explicit merchant size order is preserved instead of silently re-sorting");
  assert.equal(validateVariantDraft(sizes, "RING"), null);
  const none = reconcileVariantDraft({ ...colors, mode: "none" }, "RING");
  assert.equal(none.rows.length, 2, "switching off variants hides, but does not erase, an unsaved draft");
  assert.equal(validateVariantDraft(none, "RING"), null);
  assert.deepEqual(reconcileVariantDraft({ ...none, mode: "colors" }, "RING").rows.map((row) => row.id),
    colors.rows.map((row) => row.id), "switching back restores edited combinations");
});

const saved = (over: Partial<ProductVariant> = {}): ProductVariant => ({
  id: "saved-gold-17", product_id: "p", sku: "RING-GOLD-17", barcode: "G17",
  color_key: "gold", color_ar: "ذهبي", color_en: "Gold", color_hex: "#d4af37",
  size: 17, size_label: null, image_url: "/gold.jpg", price_override: 125,
  cost_override: 70, stock_quantity: 2, low_stock_level: 1, active: true,
  sort_order: 1, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z", ...over,
});

await test("a saved colour rename + new size keeps the original colour key, SKU, ID and stock", () => {
  const original = saved();
  let draft = variantDraftFromSaved([original]);
  assert.equal(draft.mode, "colors_sizes");
  draft = reconcileVariantDraft({ ...draft,
    colors: [{ ...draft.colors[0], color_en: "Yellow Gold" }], sizes: ["17", "18"] }, "RING");
  const first = draft.rows.find((row) => row.persistedId)!;
  const second = draft.rows.find((row) => !row.persistedId)!;
  assert.deepEqual([first.id, first.color_key, first.sku, first.stock_quantity],
    [original.id, "gold", original.sku, "2"]);
  assert.equal(first.color_en, "Yellow Gold");
  assert.equal(second.color_key, "gold", "a new size of this SAVED colour inherits its historical key");
  assert.equal(second.size, "18");
  assert.equal(validateVariantDraft(draft, "RING"), null);
  assert.equal(variantDraftTotal(draft.rows), 2);
});

await test("archived and textual-size saved shelves remain editable and keep their stock in the rollup", () => {
  const oneSize = saved({ size: null, size_label: "One Size", active: false, stock_quantity: 4 });
  const draft = variantDraftFromSaved([oneSize]);
  assert.equal(draft.mode, "colors_sizes");
  assert.deepEqual(draft.sizes, ["One Size"]);
  assert.equal(validateVariantDraft(draft, "RING"), null, "a legacy label-only shelf hydrates into the flexible size list");
  assert.equal(variantDraftTotal(draft.rows), 4, "an archived shelf can still hold real stock");
  assert.equal(reconcileVariantDraft(draft, "RING").rows[0].id, oneSize.id);
});

await test("a service edit and an undefined patch cannot wipe a saved shelf or its parent rollup", async () => {
  signIn("admin");
  const input: NewProduct = {
    sku: "DRAFT-RING", barcode: null, name_ar: "خاتم", name_en: "Draft ring", description_ar: null,
    description_en: null, category_id: null, product_type: "physical", selling_price: 120,
    cost_price: 70, tax_rate: 0, stock_tracking_enabled: true, stock_quantity: 2,
    low_stock_level: 1, show_on_website: true, is_featured: false, active: true,
    image_url: null, images: [],
  };
  const product = await repo.createProduct(input);
  const variant = await repo.createVariant({
    product_id: product.id, sku: "DRAFT-RING-GOLD-17", barcode: "GOLD17", color_ar: "ذهبي",
    color_en: "Gold", color_hex: "#d4af37", size: 17, size_label: null, image_url: null,
    price_override: null, cost_override: null, stock_quantity: 0, low_stock_level: 1,
    active: true, sort_order: 1,
  });
  await repo.enableProductVariants(product.id, [{ variantId: variant.id, quantity: 2 }], { userId: "test", userName: "Test" });
  const values = { ...variant, color_en: "Yellow Gold", barcode: "YELLOW17", stock_quantity: 0 };
  const updated = (await saveVariant({ product, values, siblings: [variant], currentId: variant.id })).variant;
  assert.equal(updated.color_key, "gold");
  assert.equal(updated.stock_quantity, 2, "service omitted stock rather than assigning undefined");
  assert.equal((await repo.listProducts()).find((p) => p.id === product.id)?.stock_quantity, 2);
  assert.equal((await repo.updateVariant(variant.id, { stock_quantity: undefined })).stock_quantity, 2,
    "the demo data layer also ignores undefined fields defensively");
  await assert.rejects(repo.setVariantActive(variant.id, false),
    (err: unknown) => (err as { code?: string }).code === "VARIANT_REQUIRED",
    "archiving the last active shelf would leave the product unsellable");
  const archived = await repo.createVariant({
    product_id: product.id, sku: "DRAFT-RING-SILVER-17", barcode: null,
    color_ar: "فضي", color_en: "Silver", color_hex: "#c0c0c0", size: 17, size_label: null,
    image_url: null, price_override: null, cost_override: null, stock_quantity: 0,
    low_stock_level: 0, active: false, sort_order: 2,
  });
  await assert.rejects(repo.deleteVariant(variant.id),
    (err: unknown) => (err as { code?: string }).code === "VARIANT_REQUIRED",
    "an archived sibling cannot make deleting the last active shelf safe");
  await assert.rejects(saveVariant({ product, values: { ...values, active: false },
    siblings: [updated, archived], currentId: variant.id }),
    (err: unknown) => (err as { code?: string }).code === "VALIDATION",
    "metadata editing cannot bypass the dedicated, guarded archive path");
  signIn("viewer");
  await assert.rejects(saveVariant({ product, values, siblings: [updated], currentId: variant.id }),
    (err: unknown) => (err as { code?: string }).code === "FORBIDDEN",
    "viewer cannot edit a combination even when bypassing the form");
  signIn("admin");
});

await test("regression: reported case with 2 valid colors (names present) and sizes S + 1 generates exactly 4 combinations with validation PASS", () => {
  const form: ProductVariantFormValue = {
    mode: "colors_sizes",
    colors: [
      { id: "color:1", color_ar: "أسود", color_en: "Black", color_hex: "#000000", image_urls: [], image_url: "" },
      { id: "color:2", color_ar: "أبيض", color_en: "White", color_hex: "#ffffff", image_urls: [], image_url: "" },
    ],
    sizes: ["S", "1"],
    rows: [],
  };

  const reconciled = reconcileVariantDraft(form, "SHIRT-01");
  assert.equal(reconciled.rows.length, 4, "2 colors × 2 sizes must produce exactly 4 combinations");
  assert.deepEqual(
    reconciled.rows.map((r) => `${r.color_en}/${r.size}`),
    ["Black/S", "Black/1", "White/S", "White/1"],
  );

  const error = validateVariantDraft(reconciled, "SHIRT-01");
  assert.equal(error, null, "Validation must PASS with zero false 'colorsRequired' errors");
});

await test("Arabic-only, English-only, and bilingual colors generate valid combinations without errors", () => {
  // Arabic only colors
  const arDraft = reconcileVariantDraft({
    mode: "colors_sizes",
    colors: [
      { id: "color:ar1", color_ar: "أحمر", color_en: "", color_hex: "#ef4444", image_urls: [], image_url: "" },
      { id: "color:ar2", color_ar: "أزرق", color_en: "", color_hex: "#3b82f6", image_urls: [], image_url: "" },
    ],
    sizes: ["S", "M"],
    rows: [],
  }, "PROD");
  assert.equal(arDraft.rows.length, 4);
  assert.equal(validateVariantDraft(arDraft, "PROD"), null);

  // English only colors
  const enDraft = reconcileVariantDraft({
    mode: "colors_sizes",
    colors: [
      { id: "color:en1", color_ar: "", color_en: "Red", color_hex: "#ef4444", image_urls: [], image_url: "" },
      { id: "color:en2", color_ar: "", color_en: "Blue", color_hex: "#3b82f6", image_urls: [], image_url: "" },
    ],
    sizes: ["S", "M"],
    rows: [],
  }, "PROD");
  assert.equal(enDraft.rows.length, 4);
  assert.equal(validateVariantDraft(enDraft, "PROD"), null);

  // Mixed bilingual colors
  const mixedDraft = reconcileVariantDraft({
    mode: "colors_sizes",
    colors: [
      { id: "color:m1", color_ar: "أحمر", color_en: "", color_hex: "", image_urls: [], image_url: "" },
      { id: "color:m2", color_ar: "", color_en: "Blue", color_hex: "", image_urls: [], image_url: "" },
      { id: "color:m3", color_ar: "أخضر", color_en: "Green", color_hex: "#22c55e", image_urls: [], image_url: "" },
    ],
    sizes: ["XL"],
    rows: [],
  }, "PROD");
  assert.equal(mixedDraft.rows.length, 3);
  assert.equal(validateVariantDraft(mixedDraft, "PROD"), null);
});

await test("duplicate colors, duplicate sizes, empty colors, and empty sizes report clear validation errors", () => {
  // Duplicate Arabic color name
  const dupAr: ProductVariantFormValue = {
    mode: "colors_sizes",
    colors: [
      { id: "c1", color_ar: "ذهبي", color_en: "Gold", color_hex: "", image_urls: [], image_url: "" },
      { id: "c2", color_ar: "ذهبي", color_en: "Yellow Gold", color_hex: "", image_urls: [], image_url: "" },
    ],
    sizes: ["17"],
    rows: [],
  };
  assert.equal(validateVariantDraft(reconcileVariantDraft(dupAr, "PROD"), "PROD"), "duplicateColor");

  // Duplicate English color name
  const dupEn: ProductVariantFormValue = {
    mode: "colors_sizes",
    colors: [
      { id: "c1", color_ar: "ذهبي", color_en: "Gold", color_hex: "", image_urls: [], image_url: "" },
      { id: "c2", color_ar: "أصفر", color_en: "Gold", color_hex: "", image_urls: [], image_url: "" },
    ],
    sizes: ["17"],
    rows: [],
  };
  assert.equal(validateVariantDraft(reconcileVariantDraft(dupEn, "PROD"), "PROD"), "duplicateColor");

  // Duplicate sizes
  const dupSizes: ProductVariantFormValue = {
    mode: "sizes",
    colors: [],
    sizes: ["S", "s"],
    rows: [],
  };
  assert.equal(validateVariantDraft(reconcileVariantDraft(dupSizes, "PROD"), "PROD"), "duplicateSize");

  // Empty color name
  const emptyColor: ProductVariantFormValue = {
    mode: "colors_sizes",
    colors: [
      { id: "c1", color_ar: "  ", color_en: "", color_hex: "", image_urls: [], image_url: "" },
    ],
    sizes: ["S"],
    rows: [],
  };
  assert.equal(validateVariantDraft(reconcileVariantDraft(emptyColor, "PROD"), "PROD"), "colorsRequired");

  // Empty sizes
  const emptySizes: ProductVariantFormValue = {
    mode: "colors_sizes",
    colors: [
      { id: "c1", color_ar: "أسود", color_en: "Black", color_hex: "", image_urls: [], image_url: "" },
    ],
    sizes: [],
    rows: [],
  };
  assert.equal(validateVariantDraft(reconcileVariantDraft(emptySizes, "PROD"), "PROD"), "sizesRequired");
});

await test("Cartesian generation across 1×3 and 3×1 color/size ratios generates exact variants without missing combinations", () => {
  // 1 color × 3 sizes -> 3 variants
  const oneByThree = reconcileVariantDraft({
    mode: "colors_sizes",
    colors: [{ id: "c1", color_ar: "أسود", color_en: "Black", color_hex: "", image_urls: [], image_url: "" }],
    sizes: ["S", "M", "L"],
    rows: [],
  }, "PROD");
  assert.equal(oneByThree.rows.length, 3);
  assert.deepEqual(oneByThree.rows.map((r) => r.size), ["S", "M", "L"]);

  // 3 colors × 1 size -> 3 variants
  const threeByOne = reconcileVariantDraft({
    mode: "colors_sizes",
    colors: [
      { id: "c1", color_ar: "أسود", color_en: "Black", color_hex: "", image_urls: [], image_url: "" },
      { id: "c2", color_ar: "أبيض", color_en: "White", color_hex: "", image_urls: [], image_url: "" },
      { id: "c3", color_ar: "رمادي", color_en: "Gray", color_hex: "", image_urls: [], image_url: "" },
    ],
    sizes: ["One Size"],
    rows: [],
  }, "PROD");
  assert.equal(threeByOne.rows.length, 3);
  assert.deepEqual(threeByOne.rows.map((r) => r.color_en), ["Black", "White", "Gray"]);
});

await test("regression BR104 + ROSE: legacy 1-char color_key ('r') does not collide when typing RED keystroke by keystroke", async () => {
  signIn("admin");
  const br104 = await repo.createProduct({
    sku: "BR104",
    barcode: "BR104",
    name_ar: "BR-104",
    name_en: "BR-104",
    description_ar: null,
    description_en: null,
    category_id: (await repo.listCategories())[0].id,
    product_type: "physical",
    selling_price: 220,
    cost_price: 85,
    tax_rate: 0,
    stock_tracking_enabled: true,
    variants_enabled: false,
    stock_quantity: 3,
    low_stock_level: 5,
    show_on_website: true,
    is_featured: false,
    active: true,
    image_url: null,
    images: [],
  });

  // Simulate legacy BR104-R-2 row saved with 1-char color_key = 'r' for ROSE
  const roseSaved = await repo.createVariant({
    product_id: br104.id,
    sku: "BR104-R-2",
    barcode: "BR104-R-2",
    color_key: "r",
    color_ar: "روز",
    color_en: "ROSE",
    color_hex: "#ec4899",
    size: null,
    size_label: null,
    size_value: null,
    size_sort_order: 0,
    image_url: null,
    price_override: null,
    cost_override: null,
    stock_quantity: 0,
    low_stock_level: 5,
    active: true,
    sort_order: 1,
  });

  let draft = variantDraftFromSaved([roseSaved]);
  assert.equal(draft.mode, "colors");
  assert.equal(draft.rows.length, 1);
  assert.equal(draft.rows[0].persistedId, roseSaved.id);
  assert.equal(draft.rows[0].sku, "BR104-R-2");

  // User clicks Add Color and types "R", then "RE", then "RED"
  const newColorId = "color:red-draft";
  draft = reconcileVariantDraft({
    ...draft,
    colors: [...draft.colors, { id: newColorId, color_ar: "أحمر", color_en: "R", color_hex: "#ef4444", image_urls: [], image_url: "" }],
  }, "BR104");
  assert.equal(draft.rows.length, 2);
  assert.equal(draft.rows[0].persistedId, roseSaved.id);
  assert.equal(draft.rows[0].sku, "BR104-R-2");

  draft = reconcileVariantDraft({
    ...draft,
    colors: draft.colors.map((c) => (c.id === newColorId ? { ...c, color_en: "RE" } : c)),
  }, "BR104");
  assert.equal(draft.rows[1].sku, "BR104-RE");
  assert.equal(draft.rows[1].color_key, "re");

  draft = reconcileVariantDraft({
    ...draft,
    colors: draft.colors.map((c) => (c.id === newColorId ? { ...c, color_en: "RED" } : c)),
  }, "BR104");
  assert.equal(draft.rows.length, 2);
  assert.equal(draft.rows[0].persistedId, roseSaved.id);
  assert.equal(draft.rows[0].sku, "BR104-R-2");
  assert.equal(draft.rows[1].persistedId, null);
  assert.equal(draft.rows[1].sku, "BR104-RED");
  assert.equal(draft.rows[1].barcode, "BR104-RED");
  assert.equal(draft.rows[1].color_key, "red");
  assert.equal(validateVariantDraft(draft, "BR104", "BR104"), null);

  // Saving ROSE heals color_key from 'r' to 'rose' in place without creating a duplicate,
  // and saving RED creates a second distinct variant while BR104 parent stock stays 3.
  const siblings: ProductVariant[] = [roseSaved];
  const updatedRose = await saveVariant({
    product: br104,
    siblings,
    currentId: roseSaved.id,
    values: {
      sku: draft.rows[0].sku,
      barcode: draft.rows[0].barcode,
      color_key: "rose",
      color_ar: draft.rows[0].color_ar,
      color_en: draft.rows[0].color_en,
      color_hex: draft.rows[0].color_hex,
      size: null,
      size_label: null,
      size_value: null,
      size_sort_order: 0,
      image_url: null,
      price_override: null,
      cost_override: null,
      stock_quantity: 0,
      low_stock_level: 5,
      active: true,
      sort_order: 1,
    },
  });
  assert.equal(updatedRose.variant.id, roseSaved.id);
  assert.equal(updatedRose.variant.color_key, "rose");
  siblings[0] = updatedRose.variant;

  const createdRed = await saveVariant({
    product: br104,
    siblings,
    values: {
      sku: draft.rows[1].sku,
      barcode: draft.rows[1].barcode,
      color_key: draft.rows[1].color_key,
      color_ar: draft.rows[1].color_ar,
      color_en: draft.rows[1].color_en,
      color_hex: draft.rows[1].color_hex,
      size: null,
      size_label: null,
      size_value: null,
      size_sort_order: 0,
      image_url: null,
      price_override: null,
      cost_override: null,
      stock_quantity: 0,
      low_stock_level: 5,
      active: true,
      sort_order: 2,
    },
  });
  assert.notEqual(createdRed.variant.id, roseSaved.id);
  assert.equal(createdRed.variant.sku, "BR104-RED");
  assert.equal(createdRed.variant.color_key, "red");

  const reloadedBr104 = (await repo.listProducts()).find((p) => p.id === br104.id)!;
  assert.equal(reloadedBr104.stock_quantity, 3);
});

await test("Arabic-only colour without size transliterates into a unique SKU that never equals parent SKU", () => {
  const redSku = suggestVariantSku("NK103", { color_ar: "أحمر", color_en: null }, null, null, ["NK103"]);
  const whiteSku = suggestVariantSku("NK103", { color_ar: "أبيض", color_en: null }, null, null, ["NK103", redSku]);
  assert.notEqual(redSku, "NK103");
  assert.notEqual(whiteSku, "NK103");
  assert.notEqual(redSku, whiteSku);
  assert.ok(redSku.startsWith("NK103-"));
  assert.ok(whiteSku.startsWith("NK103-"));
});

await test("describeError maps database, auth, permission, and constraint errors to specific localized keys", () => {
  assert.equal(describeError(new AppError("DUPLICATE_SKU", "dup", "sku", "23505")).key, "validation.skuTaken");
  assert.equal(describeError(new AppError("DUPLICATE_BARCODE", "dup", "barcode", "23505")).key, "validation.barcodeTaken");
  assert.equal(describeError(new AppError("CATEGORY_ARCHIVED", "archived", "category_id", "23514")).key, "categories.archivedTarget");
  assert.equal(describeError(new AppError("VARIANT_STOCK_READONLY", "readonly", "stock_quantity", "23514")).key, "error.variantStockReadonly");
  assert.equal(describeError(new AppError("VARIANT_LEGACY_CONFLICT", "conflict", undefined, "23505")).key, "error.variantLegacyConflict");
  assert.equal(describeError(new AppError("VARIANT_INCOMPLETE", "incomplete", undefined, "23514")).key, "error.variantIncomplete");
  assert.equal(describeError(new AppError("SESSION_EXPIRED", "jwt expired", undefined, "PGRST301")).key, "error.sessionExpired");
  assert.equal(describeError(new AppError("FORBIDDEN", "denied", "selling_price", "42501")).key, "permissions.denied.change_price");
  assert.equal(describeError(new AppError("FORBIDDEN", "denied", "cost_price", "42501")).key, "permissions.denied.change_cost");
  assert.equal(describeError(new Error("TypeError: Failed to fetch")).key, "error.network");
});

console.log(`\n${count}/${count} variant-draft tests passed`);
