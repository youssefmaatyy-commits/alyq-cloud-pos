/**
 * Apply a reviewed preview (Phase 57).
 *
 * Preview does not call this. All-or-nothing writes nothing when the preview
 * has an error, and undoes its own creates if a later row fails. Stock moves
 * only through the inventory ledger. Customer phones already stored are not
 * rewritten.
 */
import { assertCapability, canAct } from "@/lib/permissions/enforce";
import { identityPhone } from "@/lib/phone";
import { recordAudit } from "@/modules/audit/services/auditService";
import { AppError } from "@/modules/products/data/repository";
import { saveProduct, deleteProduct, saveCategory, deleteCategory } from "@/modules/products/services/catalogService";
import { saveVariant, deleteVariant } from "@/modules/products/services/variantService";
import { EMPTY_PRODUCT_FORM, productToForm } from "@/modules/products/validation";
import type { Category, Product } from "@/modules/products/types";
import type { ProductVariant } from "@/modules/products/variants";
import { saveCustomer, deleteCustomer } from "@/modules/customers/services/customerService";
import { customerToForm } from "@/modules/customers/validation";
import type { Customer } from "@/modules/customers/types";
import { adjustStock, adjustStockToCount, assertCanAdjustStock, assertCanImportStock } from "@/modules/inventory/services/inventoryService";
import { assertCanImportProducts } from "@/modules/products/services/catalogService";
import { findCode, type PreviewCatalogue } from "./preview";
import type { CommitMode, ImportCommitResult, ImportPreview, PreviewIssue, PreviewRow, StockMode } from "../types";

type Undo =
  | { kind: "product"; id: string }
  | { kind: "restore-product"; id: string; values: ReturnType<typeof productToForm> }
  | { kind: "variant"; id: string }
  | { kind: "customer"; id: string }
  | { kind: "restore-customer"; id: string; values: ReturnType<typeof customerToForm> }
  | { kind: "category"; id: string }
  | { kind: "stock"; productId: string; variantId: string | null; before: number };

export async function commitImport(input: {
  preview: ImportPreview;
  mode: CommitMode;
  catalogue: PreviewCatalogue & {
    products: Product[];
    variants: ProductVariant[];
    categories: Category[];
    customers: Customer[];
  };
  mayChangeCost: boolean;
  stockMode?: StockMode;
}): Promise<ImportCommitResult> {
  assertCapability("import_data");
  assertKind(input.preview.kind);
  if (!input.preview.ready) {
    throw new AppError("VALIDATION", "Column review is not finished");
  }
  const blocking = input.preview.globalErrors.filter((error) => !error.startsWith("Only the first sheet"));
  if (blocking.length > 0) throw new AppError("VALIDATION", blocking[0]);
  if (input.mode === "all-or-nothing") {
    if (input.preview.counts.error > 0) {
      throw new AppError("VALIDATION", "All-or-nothing was selected and the preview has errors. Nothing was written.");
    }
    assertCanUndo(input.preview.kind);
  }

  const issues: PreviewIssue[] = [];
  const undos: Undo[] = [];
  let written = 0;
  let skipped = 0;
  const createdProducts: Product[] = [];
  const createdVariants: ProductVariant[] = [];
  const createdCategories: Category[] = [];

  const rows = input.preview.rows.filter((row) => row.status !== "error");
  for (const row of rows) {
    if (row.action === "skip" || row.action === "none") {
      skipped += 1;
      continue;
    }
    try {
      const undo = await applyRow(row, input, createdProducts, createdVariants, createdCategories);
      if (undo) undos.push(undo);
      written += 1;
    } catch (error) {
      issues.push({
        row: row.row,
        field: "_row",
        code: "write_failed",
        level: "error",
        message: error instanceof Error ? error.message : "Write failed",
      });
      if (input.mode === "all-or-nothing") {
        const rolledBack = await rollback(undos, input.catalogue);
        await audit(input, { written: 0, skipped, errors: issues.length, rolledBack });
        return { written: 0, skipped, errors: issues.length, rolledBack, issues };
      }
    }
  }

  await audit(input, { written, skipped, errors: issues.length, rolledBack: false });
  return { written, skipped, errors: issues.length, rolledBack: false, issues };
}

function assertKind(kind: ImportPreview["kind"]): void {
  if (kind === "products") assertCanImportProducts();
  if (kind === "variants") assertCapability("add_product");
  if (kind === "customers") assertCapability("add_customer");
  if (kind === "categories") assertCapability("add_product");
  if (kind === "stock") {
    assertCanImportStock();
    assertCanAdjustStock();
  }
}

function assertCanUndo(kind: ImportPreview["kind"]): void {
  if (kind === "customers") assertCapability("delete_customer");
  else if (kind !== "stock") assertCapability("delete_product");
}

async function applyRow(
  row: PreviewRow,
  input: Parameters<typeof commitImport>[0],
  createdProducts: Product[],
  createdVariants: ProductVariant[],
  createdCategories: Category[],
): Promise<Undo | null> {
  if (input.preview.kind === "products") return applyProduct(row, input, createdProducts);
  if (input.preview.kind === "variants") return applyVariant(row, input, createdVariants);
  if (input.preview.kind === "customers") return applyCustomer(row, input);
  if (input.preview.kind === "categories") return applyCategory(row, input, createdCategories);
  return applyStock(row, input);
}

async function applyProduct(row: PreviewRow, input: Parameters<typeof commitImport>[0], created: Product[]): Promise<Undo | null> {
  const products = [...input.catalogue.products, ...created];
  const owner = findCode(input.catalogue, row.values.sku ?? "", "sku");
  const categoryId = categoryIdFor(row.values.category ?? "", input.catalogue.categories);
  if (row.action === "update") {
    if (!owner?.productId || owner.variantId) throw new AppError("VALIDATION", "SKU no longer identifies one product");
    if (!canAct("edit_product")) throw new AppError("FORBIDDEN", "Updating a product needs edit permission");
    const existing = products.find((product) => product.id === owner.productId);
    if (!existing) throw new AppError("NOT_FOUND");
    const before = productToForm(existing);
    const values = productToForm(existing);
    overlayProduct(values, row.values, categoryId, input.mayChangeCost, existing);
    values.stock_quantity = String(existing.stock_quantity);
    await saveProduct({ values, products, categories: input.catalogue.categories, currentId: existing.id });
    return { kind: "restore-product", id: existing.id, values: before };
  }
  const values = {
    ...EMPTY_PRODUCT_FORM,
    sku: row.values.sku ?? "",
    barcode: row.values.barcode ?? "",
    name_ar: row.values.name_ar || row.values.name_en || "",
    name_en: row.values.name_en || row.values.name_ar || "",
    description_ar: row.values.description_ar ?? "",
    description_en: row.values.description_en ?? "",
    category_id: categoryId ?? "",
    selling_price: row.values.selling_price || "0",
    cost_price: input.mayChangeCost ? row.values.cost_price || "0" : "0",
    tax_rate: row.values.tax_rate || "0",
    stock_tracking_enabled: row.values.stock_tracking_enabled ? row.values.stock_tracking_enabled !== "false" : true,
    stock_quantity: "0",
    low_stock_level: row.values.low_stock_level || "5",
  };
  const saved = await saveProduct({ values, products, categories: input.catalogue.categories });
  created.push(saved.product);
  return { kind: "product", id: saved.product.id };
}

function overlayProduct(
  values: ReturnType<typeof productToForm>,
  incoming: Record<string, string>,
  categoryId: string | null,
  mayChangeCost: boolean,
  existing: Product,
): void {
  if (incoming.name_ar) values.name_ar = incoming.name_ar;
  if (incoming.name_en) values.name_en = incoming.name_en;
  if (incoming.barcode) values.barcode = incoming.barcode;
  if (incoming.description_ar) values.description_ar = incoming.description_ar;
  if (incoming.description_en) values.description_en = incoming.description_en;
  if (incoming.selling_price) values.selling_price = incoming.selling_price;
  if (mayChangeCost && incoming.cost_price) values.cost_price = incoming.cost_price;
  else values.cost_price = String(existing.cost_price ?? 0);
  if (incoming.tax_rate) values.tax_rate = incoming.tax_rate;
  if (incoming.low_stock_level) values.low_stock_level = incoming.low_stock_level;
  if (categoryId) values.category_id = categoryId;
}

async function applyVariant(row: PreviewRow, input: Parameters<typeof commitImport>[0], created: ProductVariant[]): Promise<Undo> {
  const parent = input.catalogue.products.find((product) => product.sku.toUpperCase() === (row.values.parent_sku ?? "").toUpperCase());
  if (!parent?.variants_enabled) throw new AppError("VALIDATION", "Parent is not a variant product");
  const siblings = [...input.catalogue.variants, ...created].filter((variant) => variant.product_id === parent.id);
  const size = row.values.size ? Number(row.values.size) : null;
  const saved = await saveVariant({
    product: parent,
    siblings,
    values: {
      sku: row.values.sku ?? "",
      barcode: row.values.barcode || null,
      color_ar: row.values.color_ar || null,
      color_en: row.values.color_en || null,
      color_hex: null,
      size: Number.isInteger(size) ? size : null,
      size_label: row.values.size_label || null,
      image_url: null,
      price_override: row.values.price_override ? Number(row.values.price_override) : null,
      cost_override: null,
      stock_quantity: 0,
      low_stock_level: row.values.low_stock_level ? Number(row.values.low_stock_level) : 0,
      active: true,
      sort_order: siblings.length,
    },
  });
  created.push(saved.variant);
  return { kind: "variant", id: saved.variant.id };
}

async function applyCustomer(row: PreviewRow, input: Parameters<typeof commitImport>[0]): Promise<Undo | null> {
  const key = identityPhone(row.values.phone);
  const matches = input.catalogue.customers.filter((customer) => identityPhone(customer.phone) === key) as Customer[];
  if (matches.length > 1) throw new AppError("VALIDATION", "Phone matches more than one customer");
  if (matches.length === 1) {
    if (row.action !== "update") throw new AppError("VALIDATION", "Customer match was not an update");
    if (!canAct("edit_customer")) throw new AppError("FORBIDDEN", "Updating a customer needs edit permission");
    const existing = matches[0];
    const before = customerToForm(existing);
    const values = customerToForm(existing);
    values.name = row.values.name || existing.name;
    if (row.values.email) values.email = row.values.email;
    if (row.values.address) values.address = row.values.address;
    if (row.values.notes) values.notes = row.values.notes;
    values.phone = existing.phone;
    await saveCustomer(values, input.catalogue.customers, existing.id);
    return { kind: "restore-customer", id: existing.id, values: before };
  }
  const saved = await saveCustomer({
    name: row.values.name ?? "",
    phone: row.values.phone ?? "",
    email: row.values.email ?? "",
    address: row.values.address ?? "",
    notes: row.values.notes ?? "",
  }, input.catalogue.customers);
  return { kind: "customer", id: saved.customer.id };
}

async function applyCategory(row: PreviewRow, input: Parameters<typeof commitImport>[0], created: Category[]): Promise<Undo> {
  const categories = [...input.catalogue.categories, ...created];
  const parentName = row.values.parent ?? "";
  let parentId = "";
  if (parentName) {
    const active = categories.filter((category) => category.active && (category.name_en.toLowerCase() === parentName.toLowerCase() || category.name_ar.toLowerCase() === parentName.toLowerCase()));
    if (active.length !== 1) throw new AppError("VALIDATION", "Parent category is not one active category");
    parentId = active[0].id;
  }
  const saved = await saveCategory({
    values: {
      name_ar: row.values.name_ar ?? "",
      name_en: row.values.name_en ?? "",
      parent_id: parentId,
      sort_order: row.values.sort_order || "0",
      active: true,
    },
    categories,
  });
  created.push(saved.category);
  return { kind: "category", id: saved.category.id };
}

async function applyStock(row: PreviewRow, input: Parameters<typeof commitImport>[0]): Promise<Undo> {
  const owner = findCode(input.catalogue, row.values.sku || row.values.barcode || "", row.values.sku ? "sku" : "barcode");
  if (!owner) throw new AppError("NOT_FOUND", "Catalogue row disappeared");
  const product = input.catalogue.products.find((item) => item.id === owner.productId);
  const variant = owner.variantId ? input.catalogue.variants.find((item) => item.id === owner.variantId) : null;
  const before = variant?.stock_quantity ?? product?.stock_quantity ?? 0;
  const quantity = Number(row.values.quantity);
  const notes = row.values.notes || "Import center";
  if ((input.stockMode ?? "set") === "set" || row.action === "stock_set") {
    await adjustStockToCount({ productId: owner.productId, variantId: owner.variantId, physicalQuantity: quantity, notes });
  } else {
    await adjustStock({
      productId: owner.productId,
      variantId: owner.variantId,
      type: quantity > 0 ? "adjustment_in" : "adjustment_out",
      reason: "other",
      quantity: Math.abs(quantity),
      notes,
    });
  }
  return { kind: "stock", productId: owner.productId, variantId: owner.variantId, before };
}

function categoryIdFor(name: string, categories: readonly Category[]): string | null {
  if (!name) return null;
  const active = categories.filter((category) => category.active && (category.name_en.toLowerCase() === name.toLowerCase() || category.name_ar.toLowerCase() === name.toLowerCase()));
  if (active.length !== 1) throw new AppError("VALIDATION", "Category is archived, missing, or ambiguous");
  return active[0].id;
}

async function rollback(undos: readonly Undo[], catalogue: PreviewCatalogue): Promise<boolean> {
  let ok = true;
  for (const undo of [...undos].reverse()) {
    try {
      if (undo.kind === "product") await deleteProduct(undo.id);
      else if (undo.kind === "restore-product") await saveProduct({ values: undo.values, products: catalogue.products as Product[], categories: catalogue.categories as Category[], currentId: undo.id });
      else if (undo.kind === "variant") await deleteVariant(undo.id);
      else if (undo.kind === "customer") await deleteCustomer(undo.id);
      else if (undo.kind === "restore-customer") await saveCustomer(undo.values, catalogue.customers as Customer[], undo.id);
      else if (undo.kind === "category") await deleteCategory(undo.id, { products: catalogue.products as Product[], categories: catalogue.categories as Category[] });
      else await adjustStockToCount({ productId: undo.productId, variantId: undo.variantId, physicalQuantity: undo.before, notes: "Import rollback" });
    } catch {
      ok = false;
    }
  }
  return ok;
}

async function audit(
  input: Parameters<typeof commitImport>[0],
  result: { written: number; skipped: number; errors: number; rolledBack: boolean },
): Promise<void> {
  await recordAudit({
    action: "import.applied",
    entity: "system",
    entity_id: input.preview.kind,
    entity_label: input.preview.kind,
    details: {
      kind: input.preview.kind,
      mode: input.mode,
      written: result.written,
      skipped: result.skipped,
      errors: result.errors,
      rolled_back: result.rolledBack,
    },
  });
}


