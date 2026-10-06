/**
 * Atomic Import Commit Engine.
 *
 * Implements transaction-safe execution, multi-branch stock updates,
 * variant derivation, undo rollback queues, and idempotent batch tracking.
 */
import { assertCapability, canAct } from "@/lib/permissions/enforce";
import { identityPhone } from "@/lib/phone";
import { recordAudit } from "@/modules/audit/services/auditService";
import { AppError } from "@/modules/products/data/repository";
import {
  saveProduct,
  deleteProduct,
  saveCategory,
  deleteCategory,
} from "@/modules/products/services/catalogService";
import { saveVariant, deleteVariant } from "@/modules/products/services/variantService";
import { deriveBarcodeFromSku } from "@/modules/products/services/barcode";
import { EMPTY_PRODUCT_FORM, productToForm } from "@/modules/products/validation";
import type { Category, Product } from "@/modules/products/types";
import type { ProductVariant } from "@/modules/products/variants";
import { saveCustomer, deleteCustomer } from "@/modules/customers/services/customerService";
import { customerToForm } from "@/modules/customers/validation";
import type { Customer } from "@/modules/customers/types";
import {
  adjustStock,
  adjustStockToCount,
  assertCanAdjustStock,
  assertCanImportStock,
} from "@/modules/inventory/services/inventoryService";
import { assertCanImportProducts } from "@/modules/products/services/catalogService";
import { getSupabaseClient, isSupabaseConfigured } from "@/lib/supabase/client";
import { findCode, type PreviewCatalogue } from "./preview";
import type {
  CommitMode,
  CustomerMatchPolicy,
  ImportCommitResult,
  ImportPreview,
  PreviewIssue,
  PreviewRow,
  ProductMatchPolicy,
  StockMode,
} from "../types";

type Undo =
  | { kind: "product"; id: string }
  | { kind: "restore-product"; id: string; values: ReturnType<typeof productToForm> }
  | { kind: "variant"; id: string }
  | { kind: "customer"; id: string }
  | { kind: "restore-customer"; id: string; values: ReturnType<typeof customerToForm> }
  | { kind: "category"; id: string }
  | {
      kind: "stock";
      productId: string;
      variantId: string | null;
      branchId?: string | null;
      before: number;
    };

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
  customerPolicy?: CustomerMatchPolicy;
  productPolicy?: ProductMatchPolicy;
  filename?: string;
  batchId?: string;
  activeBranchId?: string | null;
}): Promise<ImportCommitResult> {
  assertCapability("import_data");
  assertKind(input.preview.kind);

  if (!input.preview.ready && input.mode === "all-or-nothing") {
    throw new AppError("VALIDATION", "Column review is not finished or preview contains errors");
  }

  const blocking = input.preview.globalErrors.filter(
    (error) => !error.startsWith("Only the first sheet"),
  );
  if (blocking.length > 0) throw new AppError("VALIDATION", blocking[0]);

  if (input.mode === "all-or-nothing") {
    if (input.preview.counts.error > 0) {
      throw new AppError(
        "VALIDATION",
        "All-or-nothing was selected and the preview has errors. Nothing was written.",
      );
    }
    assertCanUndo(input.preview.kind);
  }

  const batchId =
    input.batchId ??
    (typeof crypto !== "undefined" && "randomUUID" in crypto
      ? `batch-${crypto.randomUUID()}`
      : `batch-${Date.now()}-${Math.random().toString(36).slice(2)}`);

  // Live Mode: execute via authoritative server-side PostgreSQL transaction RPC
  const client = getSupabaseClient();
  if (
    isSupabaseConfigured &&
    client &&
    (input.preview.kind === "catalog_unified" ||
      input.preview.kind === "products" ||
      input.preview.kind === "variants" ||
      input.preview.kind === "stock")
  ) {
    const validRows = input.preview.rows
      .filter((r) => r.status !== "error" && r.action !== "skip" && r.action !== "none")
      .map((r) => r.values);

    const { data, error } = await client.rpc("execute_import_batch", {
      p_batch_id: batchId,
      p_kind: input.preview.kind,
      p_mode: input.mode,
      p_stock_mode: input.stockMode ?? "set",
      p_product_policy: input.productPolicy ?? "reject",
      p_branch_id: input.activeBranchId ?? null,
      p_filename: input.filename ?? null,
      p_rows: validRows,
    });

    if (error) {
      throw new AppError("DB", error.message);
    }

    const res = (data as Record<string, unknown>) ?? {};
    return {
      batchId,
      written: Number(res.written ?? validRows.length),
      skipped: input.preview.rows.length - validRows.length,
      errors: 0,
      rolledBack: false,
      issues: [],
      createdProductIds: (res.created_product_ids as string[]) ?? [],
      createdVariantIds: (res.created_variant_ids as string[]) ?? [],
      stockAdjustmentsCount: Number(res.stock_adjustments_count ?? 0),
    };
  }

  const issues: PreviewIssue[] = [];
  const undos: Undo[] = [];
  let written = 0;
  let skipped = 0;
  let stockAdjustmentsCount = 0;
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
      if (undo?.kind === "stock") stockAdjustmentsCount += 1;
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
        await recordBatchResult({
          batchId,
          input,
          written: 0,
          skipped,
          errors: issues.length,
          rolledBack,
          status: "rolled_back",
          issues,
        });
        return {
          batchId,
          written: 0,
          skipped,
          errors: issues.length,
          rolledBack,
          issues,
          createdProductIds: [],
          createdVariantIds: [],
          stockAdjustmentsCount: 0,
        };
      }
    }
  }

  const result: ImportCommitResult = {
    batchId,
    written,
    skipped,
    errors: issues.length,
    rolledBack: false,
    issues,
    createdProductIds: createdProducts.map((p) => p.id),
    createdVariantIds: createdVariants.map((v) => v.id),
    stockAdjustmentsCount,
  };

  await recordBatchResult({
    batchId,
    input,
    written,
    skipped,
    errors: issues.length,
    rolledBack: false,
    status: issues.length === 0 ? "completed" : "completed",
    issues,
  });

  return result;
}

function assertKind(kind: ImportPreview["kind"]): void {
  if (kind === "products" || kind === "catalog_unified") assertCanImportProducts();
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
  if (input.preview.kind === "catalog_unified") {
    return applyCatalogUnified(row, input, createdProducts, createdVariants);
  }
  if (input.preview.kind === "products") {
    return applyProduct(row, input, createdProducts);
  }
  if (input.preview.kind === "variants") {
    return applyVariant(row, input, createdVariants);
  }
  if (input.preview.kind === "customers") {
    return applyCustomer(row, input);
  }
  if (input.preview.kind === "categories") {
    return applyCategory(row, input, createdCategories);
  }
  return applyStock(row, input);
}

async function applyCatalogUnified(
  row: PreviewRow,
  input: Parameters<typeof commitImport>[0],
  createdProducts: Product[],
  createdVariants: ProductVariant[],
): Promise<Undo | null> {
  const products = [...input.catalogue.products, ...createdProducts];
  const variants = [...input.catalogue.variants, ...createdVariants];

  // 1. Resolve or Create Parent Product
  const sku = (row.values.sku ?? "").trim();
  const explicitProductId = row.values.product_id || row.targetId;
  let product = explicitProductId ? products.find((p) => p.id === explicitProductId) : null;
  if (!product && sku) {
    product = products.find((p) => p.sku.toUpperCase() === sku.toUpperCase()) ?? null;
  }

  const categoryId = categoryIdFor(row.values.category ?? "", input.catalogue.categories);
  const isVariantRow = Boolean(
    row.values.variant_sku ||
      row.values.color_ar ||
      row.values.color_en ||
      row.values.size ||
      row.values.size_label,
  );

  let undo: Undo | null = null;

  if (product) {
    // Update existing product
    if (row.action === "update" || (!isVariantRow && Object.keys(row.values).length > 2)) {
      if (!canAct("edit_product")) {
        throw new AppError("FORBIDDEN", "Updating a product needs edit permission");
      }
      const before = productToForm(product);
      const values = productToForm(product);
      overlayProduct(values, row.values, categoryId, input.mayChangeCost, product);
      values.stock_quantity = String(product.stock_quantity);
      await saveProduct({
        values,
        products,
        categories: input.catalogue.categories,
        currentId: product.id,
      });
      undo = { kind: "restore-product", id: product.id, values: before };
    }
  } else {
    // Create new parent product
    const values = {
      ...EMPTY_PRODUCT_FORM,
      sku: row.values.sku ?? "",
      barcode: isVariantRow ? "" : row.values.barcode || deriveBarcodeFromSku(row.values.sku ?? ""),
      name_ar: row.values.name_ar || row.values.name_en || "",
      name_en: row.values.name_en || row.values.name_ar || "",
      description_ar: row.values.description_ar ?? "",
      description_en: row.values.description_en ?? "",
      category_id: categoryId ?? "",
      selling_price: row.values.selling_price || "0",
      cost_price: input.mayChangeCost ? row.values.cost_price || "0" : "0",
      tax_rate: row.values.tax_rate || "0",
      stock_tracking_enabled: row.values.stock_tracking_enabled
        ? row.values.stock_tracking_enabled !== "false" && row.values.stock_tracking_enabled !== "0"
        : true,
      stock_quantity: "0",
      low_stock_level: row.values.low_stock_level || "5",
      variants_enabled: isVariantRow,
    };
    const saved = await saveProduct({ values, products, categories: input.catalogue.categories });
    product = saved.product;
    createdProducts.push(saved.product);
    undo = { kind: "product", id: saved.product.id };
  }

  // 2. Resolve or Create Variant (if combination row)
  let variant: ProductVariant | null = null;
  if (isVariantRow && product) {
    const variantSku = (row.values.variant_sku || `${product.sku}-VAR`).trim();
    const explicitVariantId = row.values.variant_id || row.variantId;
    const siblings = variants.filter((v) => v.product_id === product!.id);

    variant = explicitVariantId ? siblings.find((v) => v.id === explicitVariantId) ?? null : null;
    if (!variant && variantSku) {
      variant = siblings.find((v) => v.sku.toUpperCase() === variantSku.toUpperCase()) ?? null;
    }

    const size = row.values.size ? Number(row.values.size) : null;
    const variantBarcode =
      row.values.barcode?.trim() || variant?.barcode || deriveBarcodeFromSku(variantSku);

    if (!variant) {
      const savedV = await saveVariant({
        product,
        siblings,
        values: {
          sku: variantSku,
          barcode: variantBarcode,
          color_ar: row.values.color_ar || null,
          color_en: row.values.color_en || null,
          color_hex: null,
          size: Number.isInteger(size) ? size : null,
          size_label: row.values.size_label || null,
          image_url: null,
          price_override: row.values.price_override ? Number(row.values.price_override) : null,
          cost_override:
            input.mayChangeCost && row.values.cost_override
              ? Number(row.values.cost_override)
              : null,
          stock_quantity: 0,
          low_stock_level: row.values.low_stock_level ? Number(row.values.low_stock_level) : 0,
          active: row.values.active ? row.values.active !== "false" : true,
          sort_order: siblings.length,
        },
      });
      variant = savedV.variant;
      createdVariants.push(savedV.variant);
      if (!undo) undo = { kind: "variant", id: savedV.variant.id };
    }
  }

  // 3. Multi-branch stock adjustment
  if (product && row.values.quantity !== undefined && row.values.quantity !== "") {
    const qty = Number(row.values.quantity);
    if (!Number.isNaN(qty)) {
      const notes = row.values.notes || "Excel Catalog Import";
      const reason = (row.values.stock_reason || "recount") as "recount" | "other";
      const action = (row.values.stock_action || "SET_STOCK").toUpperCase();

      if (action === "ADD_STOCK" || action === "DELTA") {
        await adjustStock({
          productId: product.id,
          variantId: variant?.id ?? null,
          type: qty >= 0 ? "adjustment_in" : "adjustment_out",
          reason,
          quantity: Math.abs(qty),
          notes,
        });
      } else if (action === "SUBTRACT_STOCK") {
        await adjustStock({
          productId: product.id,
          variantId: variant?.id ?? null,
          type: "adjustment_out",
          reason,
          quantity: Math.abs(qty),
          notes,
        });
      } else {
        await adjustStockToCount({
          productId: product.id,
          variantId: variant?.id ?? null,
          physicalQuantity: Math.max(0, qty),
          notes,
        });
      }
    }
  }

  return undo;
}

async function applyProduct(
  row: PreviewRow,
  input: Parameters<typeof commitImport>[0],
  created: Product[],
): Promise<Undo | null> {
  const products = [...input.catalogue.products, ...created];
  const owner = findCode(input.catalogue, row.values.sku ?? "", "sku");
  const categoryId = categoryIdFor(row.values.category ?? "", input.catalogue.categories);

  if (row.action === "update") {
    if (!owner?.productId || owner.variantId) {
      throw new AppError("VALIDATION", "SKU no longer identifies one product");
    }
    if (!canAct("edit_product")) {
      throw new AppError("FORBIDDEN", "Updating a product needs edit permission");
    }
    const existing = products.find((product) => product.id === owner.productId);
    if (!existing) throw new AppError("NOT_FOUND");
    const before = productToForm(existing);
    const values = productToForm(existing);
    overlayProduct(values, row.values, categoryId, input.mayChangeCost, existing);
    values.stock_quantity = String(existing.stock_quantity);
    await saveProduct({
      values,
      products,
      categories: input.catalogue.categories,
      currentId: existing.id,
    });
    return { kind: "restore-product", id: existing.id, values: before };
  }

  const values = {
    ...EMPTY_PRODUCT_FORM,
    sku: row.values.sku ?? "",
    barcode: row.values.barcode || deriveBarcodeFromSku(row.values.sku ?? ""),
    name_ar: row.values.name_ar || row.values.name_en || "",
    name_en: row.values.name_en || row.values.name_ar || "",
    description_ar: row.values.description_ar ?? "",
    description_en: row.values.description_en ?? "",
    category_id: categoryId ?? "",
    selling_price: row.values.selling_price || "0",
    cost_price: input.mayChangeCost ? row.values.cost_price || "0" : "0",
    tax_rate: row.values.tax_rate || "0",
    stock_tracking_enabled: row.values.stock_tracking_enabled
      ? row.values.stock_tracking_enabled !== "false"
      : true,
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
  if (incoming.active !== undefined && incoming.active !== "") {
    values.active = incoming.active !== "false" && incoming.active !== "0";
  }
}

async function applyVariant(
  row: PreviewRow,
  input: Parameters<typeof commitImport>[0],
  created: ProductVariant[],
): Promise<Undo> {
  const parent = input.catalogue.products.find(
    (product) => product.sku.toUpperCase() === (row.values.parent_sku ?? "").toUpperCase(),
  );
  if (!parent?.variants_enabled) {
    throw new AppError("VALIDATION", "Parent is not a variant product");
  }
  const siblings = [...input.catalogue.variants, ...created].filter(
    (variant) => variant.product_id === parent.id,
  );
  const size = row.values.size ? Number(row.values.size) : null;
  const sku = row.values.sku ?? "";
  const barcode = row.values.barcode?.trim() || deriveBarcodeFromSku(sku) || null;

  const saved = await saveVariant({
    product: parent,
    siblings,
    values: {
      sku,
      barcode,
      color_ar: row.values.color_ar || null,
      color_en: row.values.color_en || null,
      color_hex: null,
      size: Number.isInteger(size) ? size : null,
      size_label: row.values.size_label || null,
      image_url: null,
      price_override: row.values.price_override ? Number(row.values.price_override) : null,
      cost_override:
        input.mayChangeCost && row.values.cost_override ? Number(row.values.cost_override) : null,
      stock_quantity: 0,
      low_stock_level: row.values.low_stock_level ? Number(row.values.low_stock_level) : 0,
      active: true,
      sort_order: siblings.length,
    },
  });
  created.push(saved.variant);
  return { kind: "variant", id: saved.variant.id };
}

async function applyCustomer(
  row: PreviewRow,
  input: Parameters<typeof commitImport>[0],
): Promise<Undo | null> {
  const key = identityPhone(row.values.phone);
  const matches = input.catalogue.customers.filter(
    (customer) => identityPhone(customer.phone) === key,
  ) as Customer[];
  if (matches.length > 1) throw new AppError("VALIDATION", "Phone matches more than one customer");
  if (matches.length === 1) {
    if (row.action !== "update") {
      throw new AppError("VALIDATION", "Customer match was not an update");
    }
    if (!canAct("edit_customer")) {
      throw new AppError("FORBIDDEN", "Updating a customer needs edit permission");
    }
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
  const saved = await saveCustomer(
    {
      name: row.values.name ?? "",
      phone: row.values.phone ?? "",
      email: row.values.email ?? "",
      address: row.values.address ?? "",
      notes: row.values.notes ?? "",
    },
    input.catalogue.customers,
  );
  return { kind: "customer", id: saved.customer.id };
}

async function applyCategory(
  row: PreviewRow,
  input: Parameters<typeof commitImport>[0],
  created: Category[],
): Promise<Undo> {
  const categories = [...input.catalogue.categories, ...created];
  const parentName = row.values.parent ?? "";
  let parentId = "";
  if (parentName) {
    const active = categories.filter(
      (category) =>
        category.active &&
        (category.name_en.toLowerCase() === parentName.toLowerCase() ||
          category.name_ar.toLowerCase() === parentName.toLowerCase()),
    );
    if (active.length !== 1) {
      throw new AppError("VALIDATION", "Parent category is not one active category");
    }
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

async function applyStock(
  row: PreviewRow,
  input: Parameters<typeof commitImport>[0],
): Promise<Undo> {
  const owner = findCode(
    input.catalogue,
    row.values.sku || row.values.barcode || "",
    row.values.sku ? "sku" : "barcode",
  );
  if (!owner) throw new AppError("NOT_FOUND", "Catalogue row disappeared");

  const product = input.catalogue.products.find((item) => item.id === owner.productId);
  const variant = owner.variantId
    ? input.catalogue.variants.find((item) => item.id === owner.variantId)
    : null;
  const before = variant?.stock_quantity ?? product?.stock_quantity ?? 0;
  const quantity = Number(row.values.quantity);
  const notes = row.values.notes || "Import center";
  const reason = (row.values.stock_reason || "recount") as "recount" | "other";

  if ((input.stockMode ?? "set") === "set" || row.action === "stock_set") {
    await adjustStockToCount({
      productId: owner.productId,
      variantId: owner.variantId,
      physicalQuantity: quantity,
      notes,
    });
  } else if (row.action === "stock_subtract") {
    await adjustStock({
      productId: owner.productId,
      variantId: owner.variantId,
      type: "adjustment_out",
      reason,
      quantity: Math.abs(quantity),
      notes,
    });
  } else {
    await adjustStock({
      productId: owner.productId,
      variantId: owner.variantId,
      type: quantity > 0 ? "adjustment_in" : "adjustment_out",
      reason,
      quantity: Math.abs(quantity),
      notes,
    });
  }

  return { kind: "stock", productId: owner.productId, variantId: owner.variantId, before };
}

function categoryIdFor(name: string, categories: readonly Category[]): string | null {
  if (!name) return null;
  const active = categories.filter(
    (category) =>
      category.active &&
      (category.id === name ||
        category.name_en.toLowerCase() === name.toLowerCase() ||
        category.name_ar.toLowerCase() === name.toLowerCase()),
  );
  if (active.length !== 1) {
    throw new AppError("VALIDATION", "Category is archived, missing, or ambiguous");
  }
  return active[0].id;
}

async function rollback(undos: readonly Undo[], catalogue: PreviewCatalogue): Promise<boolean> {
  let ok = true;
  for (const undo of [...undos].reverse()) {
    try {
      if (undo.kind === "product") await deleteProduct(undo.id);
      else if (undo.kind === "restore-product") {
        await saveProduct({
          values: undo.values,
          products: catalogue.products as Product[],
          categories: catalogue.categories as Category[],
          currentId: undo.id,
        });
      } else if (undo.kind === "variant") await deleteVariant(undo.id);
      else if (undo.kind === "customer") await deleteCustomer(undo.id);
      else if (undo.kind === "restore-customer") {
        await saveCustomer(undo.values, catalogue.customers as Customer[], undo.id);
      } else if (undo.kind === "category") {
        await deleteCategory(undo.id, {
          products: catalogue.products as Product[],
          categories: catalogue.categories as Category[],
        });
      } else {
        await adjustStockToCount({
          productId: undo.productId,
          variantId: undo.variantId,
          physicalQuantity: undo.before,
          notes: "Import rollback",
        });
      }
    } catch {
      ok = false;
    }
  }
  return ok;
}

async function recordBatchResult(args: {
  batchId: string;
  input: Parameters<typeof commitImport>[0];
  written: number;
  skipped: number;
  errors: number;
  rolledBack: boolean;
  status: "completed" | "failed" | "rolled_back";
  issues: PreviewIssue[];
}): Promise<void> {
  // 1. Record Audit Log
  await recordAudit({
    action: "import.applied",
    entity: "system",
    entity_id: args.input.preview.kind,
    entity_label: args.input.preview.kind,
    details: {
      batch_id: args.batchId,
      kind: args.input.preview.kind,
      mode: args.input.mode,
      written: args.written,
      skipped: args.skipped,
      errors: args.errors,
      rolled_back: args.rolledBack,
      filename: args.input.filename ?? null,
    },
  });

  // 2. Persist in `import_batches` table if Supabase client is available
  try {
    const client = getSupabaseClient();
    if (client) {
      await client.from("import_batches").insert({
        batch_id: args.batchId,
        kind: args.input.preview.kind,
        mode: args.input.mode,
        stock_mode: args.input.stockMode ?? null,
        status: args.status,
        filename: args.input.filename ?? null,
        total_rows: args.input.preview.rows.length,
        written_count: args.written,
        skipped_count: args.skipped,
        error_count: args.errors,
        summary: {
          valid: args.input.preview.counts.valid,
          warning: args.input.preview.counts.warning,
          error: args.input.preview.counts.error,
        },
        errors: args.issues.slice(0, 100),
        branch_id: args.input.activeBranchId ?? null,
      });
    }
  } catch {
    // Non-blocking in demo/offline mode
  }
}
