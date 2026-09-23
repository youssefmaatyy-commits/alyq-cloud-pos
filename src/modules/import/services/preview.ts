/**
 * Import preview (Phase 57). Pure. A warning may still be committed. An error
 * may not. Ambiguous columns and mixed stock modes fail the whole file.
 */
import { identityPhone } from "@/lib/phone";
import { SKU_PATTERN, MAX_SKU_LENGTH } from "@/modules/products/constants";
import { colorKeyOf } from "@/modules/products/variants";
import type { Category, Product } from "@/modules/products/types";
import type { ProductVariant } from "@/modules/products/variants";
import type { Customer } from "@/modules/customers/types";
import { fieldSpecs, reviewColumns, valueAt } from "./columns";
import type {
  ColumnReview,
  CustomerMatchPolicy,
  ImportKind,
  ImportPreview,
  PreviewIssue,
  PreviewRow,
  ProductMatchPolicy,
  StockMode,
} from "../types";

const MAX_CELL = 500;

export interface PreviewCatalogue {
  products: readonly Pick<Product, "id" | "sku" | "barcode" | "name_ar" | "name_en" | "stock_quantity" | "stock_tracking_enabled" | "variants_enabled" | "active" | "selling_price" | "cost_price">[];
  variants: readonly Pick<ProductVariant, "id" | "product_id" | "sku" | "barcode" | "color_ar" | "color_en" | "color_key" | "size" | "size_label" | "stock_quantity" | "active">[];
  categories: readonly Pick<Category, "id" | "name_ar" | "name_en" | "active" | "parent_id">[];
  customers: readonly Pick<Customer, "id" | "name" | "phone" | "email" | "address" | "notes">[];
}

export interface PreviewOptions {
  kind: ImportKind;
  headers: readonly string[];
  rows: readonly (readonly string[])[];
  overrides?: Readonly<Record<number, string | null>>;
  stockMode?: StockMode;
  customerPolicy?: CustomerMatchPolicy;
  productPolicy?: ProductMatchPolicy;
  catalogue: PreviewCatalogue;
  sheetCount?: number;
}

export function buildImportPreview(options: PreviewOptions): ImportPreview {
  const specs = fieldSpecs(options.kind);
  const review = reviewColumns(options.headers, specs, options.overrides);
  const globalErrors: string[] = [];
  if (options.headers.length === 0) globalErrors.push("The file is empty.");
  if ((options.sheetCount ?? 1) > 1) globalErrors.push("Only the first sheet is read. Other sheets were not imported.");
  if (options.kind === "stock") {
    const mixed = mixedStockColumns(options.headers, options.rows);
    if (mixed) globalErrors.push("The file mixes a set-quantity column and a delta column. Choose one stock import, not both.");
  }
  if (options.kind === "products" && !review.assignments.some((column) => column.field === "name_ar" || column.field === "name_en")) {
    if (!review.missingRequired.includes("name")) review.missingRequired.push("name");
  }

  const rows = options.rows
    .map((cells, index) => previewRow(options, review, cells, index + 2))
    .filter((row) => Object.values(row.values).some((value) => value !== "") || row.issues.length > 0);

  markFileDuplicates(options.kind, rows);

  const counts = {
    valid: rows.filter((row) => row.status === "valid").length,
    warning: rows.filter((row) => row.status === "warning").length,
    error: rows.filter((row) => row.status === "error").length,
  };
  const ready = review.ready && globalErrors.every((error) => error.startsWith("Only the first sheet"));
  return { kind: options.kind, headers: [...options.headers], review, rows, globalErrors, counts, ready };
}

function previewRow(options: PreviewOptions, review: ColumnReview, cells: readonly string[], rowNumber: number): PreviewRow {
  const values: Record<string, string> = {};
  for (const column of review.assignments) {
    if (column.field) values[column.field] = (cells[column.index] ?? "").trim();
  }
  const issues: PreviewIssue[] = [];
  for (const cell of cells) {
    if (cell.length > MAX_CELL || cell.trim().startsWith("data:")) {
      issues.push(issue(rowNumber, "_row", "blob", "error", "A cell is a data URL or longer than the cell limit. Images are not imported."));
      break;
    }
  }
  if (options.kind === "products") reviewProduct(options, values, rowNumber, issues);
  if (options.kind === "variants") reviewVariant(options, values, rowNumber, issues);
  if (options.kind === "customers") reviewCustomer(options, values, rowNumber, issues);
  if (options.kind === "categories") reviewCategory(options, values, rowNumber, issues);
  if (options.kind === "stock") reviewStock(options, values, rowNumber, issues);
  const status = issues.some((item) => item.level === "error") ? "error" : issues.length > 0 ? "warning" : "valid";
  const action = status === "error" ? "none" : actionFor(options.kind, issues, options.stockMode ?? "set");
  return { row: rowNumber, status, action, issues, values, targetId: null, variantId: null };
}

function actionFor(kind: ImportKind, issues: readonly PreviewIssue[], stockMode: StockMode): PreviewRow["action"] {
  if (issues.some((item) => item.code === "skip")) return "skip";
  if (issues.some((item) => item.code === "update")) return "update";
  if (kind === "stock") return stockMode === "delta" ? "stock_delta" : "stock_set";
  return "create";
}

function reviewProduct(options: PreviewOptions, values: Record<string, string>, row: number, issues: PreviewIssue[]): void {
  const sku = values.sku ?? "";
  if (!sku || !SKU_PATTERN.test(sku) || sku.length > MAX_SKU_LENGTH) {
    issues.push(issue(row, "sku", "sku", "error", "SKU is missing or not a catalogue code."));
  }
  if (!values.name_ar && !values.name_en) issues.push(issue(row, "name", "name", "error", "At least one product name is required."));
  if (values.stock_quantity) issues.push(issue(row, "stock_quantity", "stock_ignored", "warning", "Stock is not written from a product file. Use the stock import."));
  const barcode = values.barcode ?? "";
  const skuOwner = findCode(options.catalogue, sku, "sku");
  const barcodeOwner = barcode ? findCode(options.catalogue, barcode, "barcode") : null;
  if (skuOwner?.variantId || barcodeOwner?.variantId) {
    issues.push(issue(row, "sku", "catalogue_code", "error", "That code already identifies a variant. Catalogue codes are not overwritten."));
    return;
  }
  if (skuOwner?.productId) {
    if (barcodeOwner?.productId && barcodeOwner.productId !== skuOwner.productId) {
      issues.push(issue(row, "barcode", "catalogue_code", "error", "The barcode belongs to a different product."));
      return;
    }
    if ((options.productPolicy ?? "reject") === "reject") {
      issues.push(issue(row, "sku", "exists", "error", "SKU already exists. Update was not selected, so the row is not overwritten."));
    } else {
      issues.push(issue(row, "sku", "update", "warning", "Existing product will be updated. Images, archive state and stock are left alone."));
    }
  } else if (barcodeOwner?.productId) {
    issues.push(issue(row, "barcode", "catalogue_code", "error", "Barcode already identifies another product."));
  }
  const categoryName = values.category ?? "";
  if (categoryName) {
    const matches = options.catalogue.categories.filter((category) => sameName(category.name_ar, categoryName) || sameName(category.name_en, categoryName));
    const active = matches.filter((category) => category.active);
    if (matches.length > 0 && active.length === 0) {
      issues.push(issue(row, "category", "archived_category", "error", "That category is archived. Products are not assigned to it."));
    } else if (active.length !== 1) {
      issues.push(issue(row, "category", "category", "error", active.length === 0 ? "Category was not found." : "Category name matches more than one active category."));
    }
  }
}

function reviewVariant(options: PreviewOptions, values: Record<string, string>, row: number, issues: PreviewIssue[]): void {
  const parentSku = values.parent_sku ?? "";
  const parents = options.catalogue.products.filter((product) => sameCode(product.sku, parentSku));
  if (parents.length !== 1) {
    issues.push(issue(row, "parent_sku", "parent", "error", "Parent SKU must match exactly one product."));
    return;
  }
  const parent = parents[0];
  if (!parent.variants_enabled) {
    issues.push(issue(row, "parent_sku", "not_variant_product", "error", "This product is not sold by variant. Convert it before importing combinations."));
  }
  const sku = values.sku ?? "";
  if (!sku || !SKU_PATTERN.test(sku) || sku.length > MAX_SKU_LENGTH) {
    issues.push(issue(row, "sku", "sku", "error", "Variant SKU is missing or not a catalogue code."));
  }
  if (!values.color_en && !values.color_ar && !values.size && !values.size_label) {
    issues.push(issue(row, "color_en", "identity", "error", "A variant needs a colour or a size. Name matching is not used."));
  }
  const owner = findCode(options.catalogue, sku, "sku");
  if (owner && (owner.productId !== parent.id || owner.variantId)) {
    issues.push(issue(row, "sku", "catalogue_code", "error", "Variant SKU already identifies another catalogue row."));
  }
  const barcode = values.barcode ?? "";
  if (barcode && findCode(options.catalogue, barcode, "barcode")) {
    issues.push(issue(row, "barcode", "catalogue_code", "error", "Barcode already identifies another catalogue row."));
  }
  const colorKey = colorKeyOf({ color_ar: values.color_ar || null, color_en: values.color_en || null });
  const size = values.size ? Number(values.size) : null;
  if (values.size && !Number.isInteger(size)) issues.push(issue(row, "size", "size", "error", "Size must be a whole number or left blank."));
  const twin = options.catalogue.variants.find((variant) =>
    variant.product_id === parent.id &&
    variant.color_key === colorKey &&
    (variant.size ?? null) === (Number.isInteger(size) ? size : null) &&
    (size !== null || (variant.size_label ?? "") === (values.size_label ?? "")),
  );
  if (twin) issues.push(issue(row, "sku", "exact_variant", "error", "That exact colour and size already exists. It is not overwritten."));
}

function reviewCustomer(options: PreviewOptions, values: Record<string, string>, row: number, issues: PreviewIssue[]): void {
  if (!values.name) issues.push(issue(row, "name", "name", "error", "Name is required. Names are not used to merge customers."));
  const key = identityPhone(values.phone);
  if (!key) {
    issues.push(issue(row, "phone", "phone", "error", "A usable phone is required. Empty and fuzzy names are not a match."));
    return;
  }
  const matches = options.catalogue.customers.filter((customer) => identityPhone(customer.phone) === key);
  if (matches.length > 1) {
    issues.push(issue(row, "phone", "ambiguous_phone", "error", "More than one customer shares this phone. They are not merged."));
    return;
  }
  if (matches.length === 1) {
    const policy = options.customerPolicy ?? "reject";
    if (policy === "reject") issues.push(issue(row, "phone", "phone_taken", "error", "Phone already identifies a customer. Reject was selected."));
    else if (policy === "skip") issues.push(issue(row, "phone", "skip", "warning", "Existing customer will be skipped. The stored phone is not rewritten."));
    else issues.push(issue(row, "phone", "update", "warning", "Existing customer will be updated. The stored phone is kept."));
  }
}

function reviewCategory(options: PreviewOptions, values: Record<string, string>, row: number, issues: PreviewIssue[]): void {
  if (!values.name_ar || !values.name_en) issues.push(issue(row, "name", "name", "error", "Both Arabic and English names are required."));
  const parentName = values.parent ?? "";
  if (parentName) {
    const matches = options.catalogue.categories.filter((category) => sameName(category.name_ar, parentName) || sameName(category.name_en, parentName));
    const active = matches.filter((category) => category.active);
    if (active.length !== 1) {
      issues.push(issue(row, "parent", active.length === 0 && matches.length > 0 ? "archived_category" : "parent", "error", "Parent category must be exactly one active category."));
    }
  }
  const clash = options.catalogue.categories.find((category) => sameName(category.name_en, values.name_en) || sameName(category.name_ar, values.name_ar));
  if (clash) issues.push(issue(row, "name", "exists", "error", "A category with that name already exists. It is not overwritten."));
}

function reviewStock(options: PreviewOptions, values: Record<string, string>, row: number, issues: PreviewIssue[]): void {
  const mode = options.stockMode ?? "set";
  const quantity = Number(values.quantity);
  if (!Number.isInteger(quantity)) {
    issues.push(issue(row, "quantity", "quantity", "error", "Quantity must be a whole number."));
    return;
  }
  const skuOwner = values.sku ? findCode(options.catalogue, values.sku, "sku") : null;
  const barcodeOwner = values.barcode ? findCode(options.catalogue, values.barcode, "barcode") : null;
  if (!skuOwner && !barcodeOwner) {
    issues.push(issue(row, "sku", "unknown", "error", "SKU or barcode must match one catalogue row."));
    return;
  }
  if (skuOwner && barcodeOwner && (skuOwner.productId !== barcodeOwner.productId || skuOwner.variantId !== barcodeOwner.variantId)) {
    issues.push(issue(row, "barcode", "ambiguous", "error", "SKU and barcode identify different rows."));
    return;
  }
  const owner = skuOwner ?? barcodeOwner;
  if (!owner) return;
  const product = options.catalogue.products.find((item) => item.id === owner.productId);
  if (!product?.stock_tracking_enabled) {
    issues.push(issue(row, "sku", "untracked", "error", "Stock tracking is off for this product."));
    return;
  }
  if (product.variants_enabled && !owner.variantId) {
    issues.push(issue(row, "sku", "variant_required", "error", "This product sells by variant. Name the variant SKU, not the product rollup."));
    return;
  }
  const current = owner.variantId
    ? options.catalogue.variants.find((variant) => variant.id === owner.variantId)?.stock_quantity ?? 0
    : product.stock_quantity;
  const next = mode === "delta" ? current + quantity : quantity;
  if (mode === "set" && quantity < 0) issues.push(issue(row, "quantity", "negative", "error", "A set quantity cannot be negative."));
  if (mode === "delta" && quantity === 0) issues.push(issue(row, "quantity", "zero_delta", "error", "A delta of zero changes nothing and is not imported."));
  if (next < 0) issues.push(issue(row, "quantity", "negative_result", "error", "The ledger would go negative. The row is refused."));
}

function markFileDuplicates(kind: ImportKind, rows: PreviewRow[]): void {
  const seen = new Map<string, number>();
  for (const row of rows) {
    const key = duplicateKey(kind, row.values);
    if (!key) continue;
    const previous = seen.get(key);
    if (previous !== undefined) {
      row.issues.push(issue(row.row, "_row", "duplicate_in_file", "error", `Same identity as row ${previous}.`));
      row.status = "error";
      row.action = "none";
    } else {
      seen.set(key, row.row);
    }
  }
}

function duplicateKey(kind: ImportKind, values: Record<string, string>): string {
  if (kind === "products" || kind === "variants" || kind === "stock") return (values.sku || values.barcode || "").toUpperCase();
  if (kind === "customers") return identityPhone(values.phone);
  if (kind === "categories") return `${(values.name_en || "").toLowerCase()}|${(values.name_ar || "").toLowerCase()}`;
  return "";
}

function mixedStockColumns(headers: readonly string[], rows: readonly (readonly string[])[]): boolean {
  const setAliases = new Set(["quantity", "qty", "stock", "count", "openingstock", "الكمية"].map((item) => item.replace(/[^\p{L}\p{N}]+/gu, "")));
  const deltaAliases = new Set(["delta", "change", "adjustment", "الفرق"].map((item) => item.replace(/[^\p{L}\p{N}]+/gu, "")));
  let setIndex = -1;
  let deltaIndex = -1;
  headers.forEach((header, index) => {
    const key = header.trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
    if (setAliases.has(key)) setIndex = index;
    if (deltaAliases.has(key)) deltaIndex = index;
  });
  if (setIndex < 0 || deltaIndex < 0 || setIndex === deltaIndex) return false;
  return rows.some((row) => (row[setIndex] ?? "").trim() && (row[deltaIndex] ?? "").trim());
}

export function findCode(
  catalogue: PreviewCatalogue,
  code: string,
  kind: "sku" | "barcode",
): { productId: string; variantId: string | null } | null {
  const wanted = code.trim().toUpperCase();
  if (!wanted) return null;
  const variant = catalogue.variants.find((item) => ((kind === "sku" ? item.sku : item.barcode) ?? "").toUpperCase() === wanted);
  if (variant) return { productId: variant.product_id, variantId: variant.id };
  const product = catalogue.products.find((item) => ((kind === "sku" ? item.sku : item.barcode) ?? "").toUpperCase() === wanted);
  return product ? { productId: product.id, variantId: null } : null;
}

function sameCode(left: string, right: string): boolean {
  return left.trim().toUpperCase() === right.trim().toUpperCase() && right.trim() !== "";
}

function sameName(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase() && right.trim() !== "";
}

function issue(row: number, field: string, code: string, level: "warning" | "error", message: string): PreviewIssue {
  return { row, field, code, level, message };
}

export function mappedValue(row: readonly string[], review: ColumnReview, field: string): string {
  return valueAt(row, review, field);
}
