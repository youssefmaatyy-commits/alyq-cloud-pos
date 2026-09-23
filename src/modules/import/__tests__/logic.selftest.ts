/**
 * Advanced Import Center (Phase 57).
 *
 * The claims: ambiguous columns are not guessed, catalogue codes are not
 * overwritten, stock set and delta are not mixed, customer phones are not
 * fuzzy-merged, archived categories are not assigned, and a blob cell is refused.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { AUDIT_ACTIONS } from "@/modules/audit/types";
import { ar, en } from "@/lib/i18n/dictionary";
import { AppError } from "@/modules/products/data/repository";
import { buildImportPreview } from "../services/preview";
import { reviewColumns } from "../services/columns";
import { fieldSpecs } from "../services/columns";
import { buildErrorReportCsv } from "../services/errorReport";
import { commitImport } from "../services/commit";
import type { PreviewCatalogue } from "../services/preview";

const tests: { name: string; fn: () => void | Promise<void> }[] = [];
function test(name: string, fn: () => void | Promise<void>) {
  tests.push({ name, fn });
}

const catalogue: PreviewCatalogue = {
  products: [
    { id: "p1", sku: "RING", barcode: "111", name_ar: "خاتم", name_en: "Ring", stock_quantity: 4, stock_tracking_enabled: true, variants_enabled: true, active: true, selling_price: 100, cost_price: 40 },
    { id: "p2", sku: "PLAIN", barcode: "222", name_ar: "سادة", name_en: "Plain", stock_quantity: 3, stock_tracking_enabled: true, variants_enabled: false, active: true, selling_price: 50, cost_price: 10 },
  ],
  variants: [
    { id: "v1", product_id: "p1", sku: "RING-G17", barcode: "333", color_ar: "ذهبي", color_en: "Gold", color_key: "gold", size: 17, size_label: null, stock_quantity: 2, active: true },
  ],
  categories: [
    { id: "c1", name_ar: "مجوهرات", name_en: "Jewellery", active: true, parent_id: null },
    { id: "c2", name_ar: "قديم", name_en: "Archived", active: false, parent_id: null },
  ],
  customers: [
    { id: "cu1", name: "Noha", phone: "01001234567", email: null, address: null, notes: null },
  ],
};

test("an ambiguous header is not mapped until the operator chooses", () => {
  const review = reviewColumns(["Name"], fieldSpecs("products"));
  assert.equal(review.ready, false);
  assert.equal(review.assignments[0].field, null);
  assert.ok(review.ambiguous[0].candidates.includes("name_en"));
  assert.ok(review.ambiguous[0].candidates.includes("name_ar"));
  const chosen = reviewColumns(["SKU", "Name"], fieldSpecs("products"), { 0: "sku", 1: "name_en" });
  assert.equal(chosen.assignments[0].field, "sku");
  assert.equal(chosen.ready, true);
});

test("two columns claiming one field are not silently collapsed", () => {
  const review = reviewColumns(["SKU", "Code"], fieldSpecs("products"));
  assert.equal(review.ready, false);
  assert.ok(review.duplicateFields.some((item) => item.field === "sku"));
});

test("product preview refuses archived categories, existing codes, and stock cells", () => {
  const preview = buildImportPreview({
    kind: "products",
    headers: ["SKU", "Product Name (English)", "Category", "Stock"],
    rows: [
      ["NEW-1", "New", "Archived", "9"],
      ["RING", "Other", "Jewellery", ""],
      ["NEW-2", "Ok", "Jewellery", "4"],
    ],
    productPolicy: "reject",
    catalogue,
  });
  assert.equal(preview.rows[0].issues.some((item) => item.code === "archived_category"), true);
  assert.equal(preview.rows[1].status, "error");
  assert.equal(preview.rows[2].issues.some((item) => item.code === "stock_ignored"), true);
  assert.equal(preview.rows[2].status, "warning");
});

test("variant import requires the exact parent and does not overwrite a combination", () => {
  const preview = buildImportPreview({
    kind: "variants",
    headers: ["Parent SKU", "SKU", "Color", "Size"],
    rows: [
      ["RING", "RING-G17", "Gold", "17"],
      ["PLAIN", "PLAIN-1", "Gold", "17"],
      ["MISSING", "X-1", "Gold", "17"],
    ],
    catalogue,
  });
  assert.equal(preview.rows[0].issues.some((item) => item.code === "catalogue_code" || item.code === "exact_variant"), true);
  assert.equal(preview.rows[1].issues.some((item) => item.code === "not_variant_product"), true);
  assert.equal(preview.rows[2].issues.some((item) => item.code === "parent"), true);
});

test("customer identity is the phone, and a fuzzy name is not a merge", () => {
  const preview = buildImportPreview({
    kind: "customers",
    headers: ["Name", "Phone"],
    rows: [
      ["Someone else", "+20 100 123 4567"],
      ["Noha again", ""],
      ["New", "01009998877"],
    ],
    customerPolicy: "reject",
    catalogue,
  });
  assert.equal(preview.rows[0].status, "error");
  assert.equal(preview.rows[1].issues.some((item) => item.code === "phone"), true);
  assert.equal(preview.rows[2].status, "valid");
  const skip = buildImportPreview({
    kind: "customers",
    headers: ["Name", "Phone"],
    rows: [["Other", "01001234567"]],
    customerPolicy: "skip",
    catalogue,
  });
  assert.equal(skip.rows[0].action, "skip");
  assert.equal(skip.rows[0].status, "warning");
});

test("stock set and delta cannot be mixed, and a variant product needs the variant code", () => {
  const mixed = buildImportPreview({
    kind: "stock",
    headers: ["SKU", "Quantity", "Delta"],
    rows: [["PLAIN", "5", "1"]],
    stockMode: "set",
    catalogue,
  });
  assert.ok(mixed.globalErrors.some((error) => /mix/i.test(error)));
  assert.equal(mixed.ready, false);
  const rollup = buildImportPreview({
    kind: "stock",
    headers: ["SKU", "Quantity"],
    rows: [["RING", "1"], ["RING-G17", "2"], ["PLAIN", "-1"]],
    stockMode: "set",
    catalogue,
  });
  assert.equal(rollup.rows[0].issues.some((item) => item.code === "variant_required"), true);
  assert.equal(rollup.rows[1].status, "valid");
  assert.equal(rollup.rows[1].action, "stock_set");
  assert.equal(rollup.rows[2].status, "error");
});

test("a data url is refused and the error report does not embed it", () => {
  const blob = `data:image/png;base64,${"A".repeat(80)}`;
  const preview = buildImportPreview({
    kind: "products",
    headers: ["SKU", "Product Name (English)", "Notes"],
    rows: [["NEW-9", "Named", blob]],
    catalogue,
  });
  assert.equal(preview.rows[0].issues.some((item) => item.code === "blob"), true);
  const csv = buildErrorReportCsv(preview.rows[0].issues);
  assert.equal(csv.includes(blob), false);
  assert.match(csv, /blob/);
});

test("all-or-nothing does not write when the preview has errors", async () => {
  const preview = buildImportPreview({
    kind: "products",
    headers: ["SKU", "Name"],
    rows: [["RING", "Taken"]],
    productPolicy: "reject",
    catalogue,
  });
  await assert.rejects(
    () => commitImport({
      preview,
      mode: "all-or-nothing",
      mayChangeCost: false,
      catalogue: catalogue as never,
    }),
    (error: unknown) => error instanceof AppError,
  );
});

test("the import audit action is shipped and labelled", () => {
  assert.ok(AUDIT_ACTIONS.includes("import.applied"));
  const key = "audit.action.import.applied" as keyof typeof en;
  assert.ok(en[key] && ar[key] && en[key] !== ar[key]);
  const sql = fs.readFileSync(path.join(process.cwd(), "supabase/migrations/0058_import_center_audit.sql"), "utf8");
  assert.match(sql, /import\.applied/);
});

let failed = 0;
for (const { name, fn } of tests) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`  ✗ ${name}`);
    console.error(error);
  }
}
if (failed > 0) {
  console.error(`${failed} import tests failed`);
  process.exit(1);
}
console.log(`${tests.length}/${tests.length} import tests passed`);
