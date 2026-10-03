/** The Add/Edit combination draft and the shelf-stock edit guard. Run with `npm test`. */
import assert from "node:assert/strict";
import { DEMO_USERS } from "@/lib/auth/demoUsers";
import { createSession } from "@/lib/auth/services/authService";
import { primeCacheFromStorage, resetSessionCache, writeStoredSession } from "@/lib/auth/services/sessionStore";
import { capabilitiesOf } from "@/lib/permissions/roles";
import { getDemoRepository } from "../data/demoRepository";
import type { NewProduct } from "../types";
import type { ProductVariant } from "../variants";
import { saveVariant } from "../services/variantService";
import {
  EMPTY_PRODUCT_VARIANT_FORM, reconcileVariantDraft, validateVariantDraft,
  variantDraftFromSaved, variantDraftTotal,
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
  assert.deepEqual(draft.sizes, []);
  assert.equal(validateVariantDraft(draft, "RING"), null, "a legacy label-only shelf needs no numeric chip to edit its barcode");
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

console.log(`\n${count}/${count} variant-draft tests passed`);
