/**
 * Import Preview Engine.
 *
 * Implements strict all-or-nothing validation, product identity hierarchy,
 * variant derivation, multi-branch stock verification, and error suggestions.
 */
import { identityPhone } from "@/lib/phone";
import { SKU_PATTERN, MAX_SKU_LENGTH } from "@/modules/products/constants";
import { validateBarcodePayload } from "@/modules/products/services/barcode";
import { colorKeyOf } from "@/modules/products/variants";
import type { Category, Product } from "@/modules/products/types";
import type { ProductVariant } from "@/modules/products/variants";
import type { Customer } from "@/modules/customers/types";
import { fieldSpecs, reviewColumns } from "./columns";
import type {
  BranchContext,
  ColumnReview,
  CustomerMatchPolicy,
  ImportKind,
  ImportPreview,
  PreviewIssue,
  PreviewRow,
  ProductMatchPolicy,
  StockAction,
  StockMode,
} from "../types";

const MAX_CELL = 500;

export interface PreviewBranchStock {
  branch_id: string;
  product_id: string;
  variant_id: string | null;
  quantity: number;
}

export interface PreviewCatalogue {
  products: readonly Pick<
    Product,
    | "id"
    | "sku"
    | "barcode"
    | "name_ar"
    | "name_en"
    | "stock_quantity"
    | "stock_tracking_enabled"
    | "variants_enabled"
    | "active"
    | "selling_price"
    | "cost_price"
    | "tax_rate"
    | "low_stock_level"
    | "category_id"
  >[];
  variants: readonly Pick<
    ProductVariant,
    | "id"
    | "product_id"
    | "sku"
    | "barcode"
    | "color_ar"
    | "color_en"
    | "color_key"
    | "size"
    | "size_label"
    | "stock_quantity"
    | "price_override"
    | "cost_override"
    | "active"
    | "low_stock_level"
  >[];
  categories: readonly Pick<Category, "id" | "name_ar" | "name_en" | "active" | "parent_id">[];
  customers: readonly Pick<Customer, "id" | "name" | "phone" | "email" | "address" | "notes">[];
  branches?: readonly BranchContext[];
  branchStock?: readonly PreviewBranchStock[];
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
  activeBranchId?: string | null;
}

export function buildImportPreview(options: PreviewOptions): ImportPreview {
  const specs = fieldSpecs(options.kind);
  const review = reviewColumns(options.headers, specs, options.overrides);
  const globalErrors: string[] = [];

  if (options.headers.length === 0) globalErrors.push("The file is empty.");
  if ((options.sheetCount ?? 1) > 1) {
    globalErrors.push("Only the first sheet is read. Other sheets were not imported.");
  }

  if (options.kind === "stock") {
    const mixed = mixedStockColumns(options.headers, options.rows);
    if (mixed) {
      globalErrors.push(
        "The file mixes a set-quantity column and a delta column. Choose one stock import, not both.",
      );
    }
  }

  if (
    options.kind === "products" &&
    !review.assignments.some(
      (column) => column.field === "name_ar" || column.field === "name_en",
    )
  ) {
    if (!review.missingRequired.includes("name")) review.missingRequired.push("name");
  }

  const rows = options.rows
    .map((cells, index) => previewRow(options, review, cells, index + 2))
    .filter(
      (row) =>
        Object.values(row.values).some((value) => value !== "") || row.issues.length > 0,
    );

  markFileDuplicates(options.kind, rows);

  const counts = {
    valid: rows.filter((row) => row.status === "valid").length,
    warning: rows.filter((row) => row.status === "warning").length,
    error: rows.filter((row) => row.status === "error").length,
  };

  const hasBlockingGlobalError = globalErrors.some(
    (error) => !error.startsWith("Only the first sheet"),
  );
  const ready = review.ready && !hasBlockingGlobalError && counts.error === 0;

  return {
    kind: options.kind,
    headers: [...options.headers],
    review,
    rows,
    globalErrors,
    counts,
    ready,
  };
}

function previewRow(
  options: PreviewOptions,
  review: ColumnReview,
  cells: readonly string[],
  rowNumber: number,
): PreviewRow {
  const values: Record<string, string> = {};
  for (const column of review.assignments) {
    if (column.field) values[column.field] = (cells[column.index] ?? "").trim();
  }

  const issues: PreviewIssue[] = [];

  for (const cell of cells) {
    if (cell.length > MAX_CELL || cell.trim().startsWith("data:")) {
      issues.push(
        issue(
          rowNumber,
          "_row",
          "blob",
          "error",
          "A cell is a data URL or longer than the cell limit. Images are not imported.",
          "Remove images, data URLs, or lengthy base64 text from the cell.",
        ),
      );
      break;
    }
  }

  let targetId: string | null = null;
  let variantId: string | null = null;
  let branchId: string | null = null;
  let computedStock: PreviewRow["computedStock"] = null;

  if (options.kind === "catalog_unified") {
    const res = reviewCatalogUnified(options, values, rowNumber, issues);
    targetId = res.targetId;
    variantId = res.variantId;
    branchId = res.branchId;
    computedStock = res.computedStock;
  } else if (options.kind === "products") {
    const res = reviewProduct(options, values, rowNumber, issues);
    targetId = res.targetId;
  } else if (options.kind === "variants") {
    const res = reviewVariant(options, values, rowNumber, issues);
    targetId = res.targetId;
    variantId = res.variantId;
  } else if (options.kind === "customers") {
    const res = reviewCustomer(options, values, rowNumber, issues);
    targetId = res.targetId;
  } else if (options.kind === "categories") {
    const res = reviewCategory(options, values, rowNumber, issues);
    targetId = res.targetId;
  } else if (options.kind === "stock") {
    const res = reviewStock(options, values, rowNumber, issues);
    targetId = res.targetId;
    variantId = res.variantId;
    branchId = res.branchId;
    computedStock = res.computedStock;
  }

  const status = issues.some((item) => item.level === "error")
    ? "error"
    : issues.length > 0
      ? "warning"
      : "valid";

  const action = status === "error" ? "none" : actionFor(options.kind, issues, options.stockMode ?? "set", values);

  return {
    row: rowNumber,
    status,
    action,
    issues,
    values,
    targetId,
    variantId,
    branchId,
    computedStock,
  };
}

function actionFor(
  kind: ImportKind,
  issues: readonly PreviewIssue[],
  stockMode: StockMode,
  values: Record<string, string>,
): PreviewRow["action"] {
  if (issues.some((item) => item.code === "skip")) return "skip";
  if (issues.some((item) => item.code === "update")) return "update";
  if (kind === "stock") {
    const stockActionRaw = (values.stock_action || "").toUpperCase();
    if (stockActionRaw === "SUBTRACT_STOCK") return "stock_subtract";
    if (stockActionRaw === "ADD_STOCK") return "stock_delta";
    if (stockActionRaw === "SET_STOCK") return "stock_set";
    return stockMode === "delta" ? "stock_delta" : "stock_set";
  }
  return "create";
}

function reviewCatalogUnified(
  options: PreviewOptions,
  values: Record<string, string>,
  row: number,
  issues: PreviewIssue[],
): {
  targetId: string | null;
  variantId: string | null;
  branchId: string | null;
  computedStock: PreviewRow["computedStock"];
} {
  let targetId: string | null = null;
  let variantId: string | null = null;
  let branchId: string | null = null;
  let computedStock: PreviewRow["computedStock"] = null;

  const sku = values.sku ?? "";
  const variantSku = values.variant_sku ?? "";
  const explicitProductId = values.product_id ?? "";
  const explicitVariantId = values.variant_id ?? "";
  const productGroup = values.product_group || values.group_key || "";
  const effectiveSku = sku || productGroup;

  if (!effectiveSku && !explicitProductId && !variantSku && !explicitVariantId) {
    issues.push(
      issue(
        row,
        "sku",
        "sku",
        "error",
        "Product SKU or New Product Group is required.",
        "Provide a unique alphanumeric code for the product or New Product Group.",
      ),
    );
  } else if (effectiveSku && (!SKU_PATTERN.test(effectiveSku) || effectiveSku.length > MAX_SKU_LENGTH)) {
    issues.push(
      issue(
        row,
        "sku",
        "sku_format",
        "error",
        "SKU format is invalid (must be 3-50 chars, letters, numbers, hyphens).",
        "Change SKU to use standard format e.g. TSHIRT-001",
      ),
    );
  }

  // Find existing product ONLY by ID > Variant SKU resolving parent > SKU
  // Strict rule: NEVER resolve existing products by visible product name.
  let existingProduct: Pick<Product, "id" | "sku" | "variants_enabled" | "stock_tracking_enabled" | "stock_quantity"> | undefined;
  if (explicitProductId) {
    existingProduct = options.catalogue.products.find((p) => p.id === explicitProductId);
  }
  if (!existingProduct && sku) {
    existingProduct = options.catalogue.products.find((p) => sameCode(p.sku, sku));
  }
  if (!existingProduct && variantSku) {
    const foundVariant = options.catalogue.variants.find((v) => sameCode(v.sku, variantSku));
    if (foundVariant) {
      existingProduct = options.catalogue.products.find((p) => p.id === foundVariant.product_id);
    }
  }

  if (existingProduct) {
    targetId = existingProduct.id;
    if ((options.productPolicy ?? "reject") === "reject" && !variantSku && !explicitVariantId) {
      issues.push(
        issue(
          row,
          "sku",
          "catalogue_code",
          "error",
          "Product SKU already exists. Change SKU or switch policy to update existing.",
          "Use a new SKU to create a new product, or proceed with update.",
        ),
      );
    }
  }

  // Variant resolution
  if (variantSku || values.color_ar || values.color_en || values.size || values.size_label) {
    const vSku = variantSku || sku;
    if (!SKU_PATTERN.test(vSku) || vSku.length > MAX_SKU_LENGTH) {
      issues.push(
        issue(
          row,
          "variant_sku",
          "variant_sku_format",
          "error",
          "Variant SKU format is invalid.",
          "Use standard SKU format for variant e.g. TSHIRT-BLK-M",
        ),
      );
    }

    if (explicitVariantId) {
      const matchV = options.catalogue.variants.find((v) => v.id === explicitVariantId);
      if (matchV) variantId = matchV.id;
    }
    if (!variantId && vSku) {
      const matchV = options.catalogue.variants.find((v) => sameCode(v.sku, vSku));
      if (matchV) variantId = matchV.id;
    }
  }

  // Name check
  if (!existingProduct && !values.name_ar && !values.name_en) {
    issues.push(
      issue(
        row,
        "name",
        "name_required",
        "error",
        "At least one product name (Arabic or English) is required for new products.",
        "Add a name in Arabic or English.",
      ),
    );
  }

  // Category validation
  const categoryName = values.category ?? "";
  if (categoryName) {
    const matches = options.catalogue.categories.filter(
      (c) =>
        c.id === categoryName ||
        sameName(c.name_ar, categoryName) ||
        sameName(c.name_en, categoryName),
    );
    const active = matches.filter((c) => c.active);
    if (matches.length > 0 && active.length === 0) {
      issues.push(
        issue(
          row,
          "category",
          "archived_category",
          "error",
          "Specified category is archived.",
          "Select an active category.",
        ),
      );
    } else if (active.length === 0 && matches.length === 0) {
      issues.push(
        issue(
          row,
          "category",
          "category_not_found",
          "error",
          `Category "${categoryName}" was not found.`,
          "Ensure the category name matches an existing active category exactly.",
        ),
      );
    }
  }

  // Numeric fields validation
  validateNumberField(row, "selling_price", values.selling_price, issues, { min: 0, required: false });
  validateNumberField(row, "cost_price", values.cost_price, issues, { min: 0, required: false });
  validateNumberField(row, "tax_rate", values.tax_rate, issues, { min: 0, max: 100, required: false });
  validateNumberField(row, "low_stock_level", values.low_stock_level, issues, { min: 0, required: false });
  validateNumberField(row, "price_override", values.price_override, issues, { min: 0, required: false });
  validateNumberField(row, "cost_override", values.cost_override, issues, { min: 0, required: false });

  // Barcode validation & derivation
  const barcode = values.barcode ?? "";
  if (barcode) {
    const err = validateBarcodePayload(barcode);
    if (err) {
      issues.push(
        issue(
          row,
          "barcode",
          `barcode_${err}`,
          "error",
          `Barcode format is invalid (${err}).`,
          "Provide standard Code 128 ASCII barcode characters or leave blank for auto-derivation.",
        ),
      );
    } else {
      const owner = findCode(options.catalogue, barcode, "barcode");
      if (owner && owner.productId !== targetId) {
        issues.push(
          issue(
            row,
            "barcode",
            "duplicate_barcode",
            "error",
            "Barcode already belongs to another product/variant.",
            "Use a unique barcode or leave blank.",
          ),
        );
      }
    }
  }

  // Branch Stock validation
  if (values.quantity !== undefined && values.quantity !== "") {
    const qty = Number(values.quantity);
    if (!Number.isInteger(qty)) {
      issues.push(
        issue(
          row,
          "quantity",
          "invalid_quantity",
          "error",
          "Quantity must be a whole number.",
          "Enter an integer quantity like 10, -5, or 0.",
        ),
      );
    } else {
      // Resolve branch
      const branchVal = values.branch || options.activeBranchId || "";
      const branches = options.catalogue.branches ?? [];
      const branch = branches.find(
        (b) => b.id === branchVal || sameName(b.name, branchVal) || sameCode(b.code ?? "", branchVal),
      );

      branchId = branch?.id ?? options.activeBranchId ?? null;

      // Current stock balance lookup
      const currentStock = lookupCurrentStock(
        options.catalogue,
        branchId,
        targetId,
        variantId,
        existingProduct?.stock_quantity ?? 0,
      );

      const op = normalizeStockAction(values.stock_action, options.stockMode);
      let after = currentStock;
      let delta = 0;

      if (op === "SET_STOCK") {
        if (qty < 0) {
          issues.push(
            issue(
              row,
              "quantity",
              "negative_set_stock",
              "error",
              "Set stock quantity cannot be negative.",
              "Provide a non-negative count (0 or higher).",
            ),
          );
        }
        after = Math.max(0, qty);
        delta = after - currentStock;
      } else if (op === "ADD_STOCK") {
        delta = qty;
        after = currentStock + delta;
      } else if (op === "SUBTRACT_STOCK") {
        delta = -Math.abs(qty);
        after = currentStock + delta;
      }

      if (after < 0) {
        issues.push(
          issue(
            row,
            "quantity",
            "negative_stock_result",
            "error",
            `Stock balance would become negative (${after}) for this branch.`,
            `Ensure reduction does not exceed available stock (${currentStock}).`,
          ),
        );
      }

      computedStock = {
        branchId,
        branchName: branch?.name ?? "Default Branch",
        current: currentStock,
        after,
        delta,
        action: op,
      };
    }
  }

  return { targetId, variantId, branchId, computedStock };
}

function reviewProduct(
  options: PreviewOptions,
  values: Record<string, string>,
  row: number,
  issues: PreviewIssue[],
): { targetId: string | null } {
  let targetId: string | null = null;
  const sku = values.sku ?? "";
  if (!sku || !SKU_PATTERN.test(sku) || sku.length > MAX_SKU_LENGTH) {
    issues.push(
      issue(
        row,
        "sku",
        "sku",
        "error",
        "SKU is missing or not a catalogue code.",
        "Provide a valid SKU containing letters, numbers, or dashes.",
      ),
    );
  }

  if (!values.name_ar && !values.name_en) {
    issues.push(
      issue(
        row,
        "name",
        "name",
        "error",
        "At least one product name is required.",
        "Enter a product name in Arabic or English.",
      ),
    );
  }

  if (values.stock_quantity) {
    issues.push(
      issue(
        row,
        "stock_quantity",
        "stock_ignored",
        "warning",
        "Stock is not written from a product file. Use the stock import.",
        "To update stock, use the Stock Import tab or Stock Adjustment template.",
      ),
    );
  }

  const barcode = values.barcode ?? "";
  const skuOwner = findCode(options.catalogue, sku, "sku");
  const barcodeOwner = barcode ? findCode(options.catalogue, barcode, "barcode") : null;

  if (skuOwner?.variantId || barcodeOwner?.variantId) {
    issues.push(
      issue(
        row,
        "sku",
        "catalogue_code",
        "error",
        "That code already identifies a variant. Catalogue codes are not overwritten.",
        "Choose a unique SKU that is not already used by a variant.",
      ),
    );
    return { targetId: null };
  }

  if (skuOwner?.productId) {
    targetId = skuOwner.productId;
    if (barcodeOwner?.productId && barcodeOwner.productId !== skuOwner.productId) {
      issues.push(
        issue(
          row,
          "barcode",
          "catalogue_code",
          "error",
          "The barcode belongs to a different product.",
          "Use a unique barcode for this product.",
        ),
      );
      return { targetId };
    }
    if ((options.productPolicy ?? "reject") === "reject") {
      issues.push(
        issue(
          row,
          "sku",
          "exists",
          "error",
          "SKU already exists. Update was not selected, so the row is not overwritten.",
          "Change product policy to 'Update existing' or choose a new SKU.",
        ),
      );
    } else {
      issues.push(
        issue(
          row,
          "sku",
          "update",
          "warning",
          "Existing product will be updated. Images, archive state and stock are left alone.",
        ),
      );
    }
  } else if (barcodeOwner?.productId) {
    issues.push(
      issue(
        row,
        "barcode",
        "catalogue_code",
        "error",
        "Barcode already identifies another product.",
        "Provide a unique barcode.",
      ),
    );
  }

  const categoryName = values.category ?? "";
  if (categoryName) {
    const matches = options.catalogue.categories.filter(
      (category) =>
        sameName(category.name_ar, categoryName) || sameName(category.name_en, categoryName),
    );
    const active = matches.filter((category) => category.active);
    if (matches.length > 0 && active.length === 0) {
      issues.push(
        issue(
          row,
          "category",
          "archived_category",
          "error",
          "That category is archived. Products are not assigned to it.",
          "Select an active category or reactivate this category.",
        ),
      );
    } else if (active.length !== 1) {
      issues.push(
        issue(
          row,
          "category",
          "category",
          "error",
          active.length === 0
            ? "Category was not found."
            : "Category name matches more than one active category.",
          "Ensure category name matches an existing active category.",
        ),
      );
    }
  }

  return { targetId };
}

function reviewVariant(
  options: PreviewOptions,
  values: Record<string, string>,
  row: number,
  issues: PreviewIssue[],
): { targetId: string | null; variantId: string | null } {
  let targetId: string | null = null;
  let variantId: string | null = null;

  const parentSku = values.parent_sku ?? "";
  const parents = options.catalogue.products.filter((product) => sameCode(product.sku, parentSku));
  if (parents.length !== 1) {
    issues.push(
      issue(
        row,
        "parent_sku",
        "parent",
        "error",
        "Parent SKU must match exactly one product.",
        "Check that the parent SKU exists in the product catalog.",
      ),
    );
    return { targetId: null, variantId: null };
  }

  const parent = parents[0];
  targetId = parent.id;

  if (!parent.variants_enabled) {
    issues.push(
      issue(
        row,
        "parent_sku",
        "not_variant_product",
        "error",
        "This product is not sold by variant. Convert it before importing combinations.",
        "Enable variants on this product before adding variant rows.",
      ),
    );
  }

  const sku = values.sku ?? "";
  if (!sku || !SKU_PATTERN.test(sku) || sku.length > MAX_SKU_LENGTH) {
    issues.push(
      issue(
        row,
        "sku",
        "sku",
        "error",
        "Variant SKU is missing or not a catalogue code.",
        "Enter a valid variant SKU.",
      ),
    );
  }

  if (!values.color_en && !values.color_ar && !values.size && !values.size_label) {
    issues.push(
      issue(
        row,
        "color_en",
        "identity",
        "error",
        "A variant needs a colour or a size. Name matching is not used.",
        "Specify a color (Arabic or English) and/or size.",
      ),
    );
  }

  const owner = findCode(options.catalogue, sku, "sku");
  if (owner && (owner.productId !== parent.id || owner.variantId)) {
    issues.push(
      issue(
        row,
        "sku",
        "catalogue_code",
        "error",
        "Variant SKU already identifies another catalogue row.",
        "Use a unique SKU for this combination.",
      ),
    );
  }

  const barcode = values.barcode ?? "";
  if (barcode && findCode(options.catalogue, barcode, "barcode")) {
    issues.push(
      issue(
        row,
        "barcode",
        "catalogue_code",
        "error",
        "Barcode already identifies another catalogue row.",
        "Use a unique barcode or leave blank.",
      ),
    );
  }

  const colorKey = colorKeyOf({
    color_ar: values.color_ar || null,
    color_en: values.color_en || null,
  });
  const size = values.size ? Number(values.size) : null;
  if (values.size && !Number.isInteger(size)) {
    issues.push(
      issue(
        row,
        "size",
        "size",
        "error",
        "Size must be a whole number or left blank.",
        "Enter an integer size e.g. 42, or use size_label for 'XL'.",
      ),
    );
  }

  const twin = options.catalogue.variants.find(
    (variant) =>
      variant.product_id === parent.id &&
      variant.color_key === colorKey &&
      (variant.size ?? null) === (Number.isInteger(size) ? size : null) &&
      (size !== null || (variant.size_label ?? "") === (values.size_label ?? "")),
  );

  if (twin) {
    variantId = twin.id;
    issues.push(
      issue(
        row,
        "sku",
        "exact_variant",
        "error",
        "That exact colour and size already exists. It is not overwritten.",
        "To update existing combination price, edit variant directly in catalog.",
      ),
    );
  }

  return { targetId, variantId };
}

function reviewCustomer(
  options: PreviewOptions,
  values: Record<string, string>,
  row: number,
  issues: PreviewIssue[],
): { targetId: string | null } {
  let targetId: string | null = null;
  if (!values.name) {
    issues.push(
      issue(
        row,
        "name",
        "name",
        "error",
        "Name is required. Names are not used to merge customers.",
        "Provide customer's full name.",
      ),
    );
  }

  const key = identityPhone(values.phone);
  if (!key) {
    issues.push(
      issue(
        row,
        "phone",
        "phone",
        "error",
        "A usable phone is required. Empty and fuzzy names are not a match.",
        "Provide a valid Egyptian or international phone number.",
      ),
    );
    return { targetId: null };
  }

  const matches = options.catalogue.customers.filter(
    (customer) => identityPhone(customer.phone) === key,
  );

  if (matches.length > 1) {
    issues.push(
      issue(
        row,
        "phone",
        "ambiguous_phone",
        "error",
        "More than one customer shares this phone. They are not merged.",
        "Resolve duplicate phone in customer directory first.",
      ),
    );
    return { targetId: null };
  }

  if (matches.length === 1) {
    targetId = matches[0].id;
    const policy = options.customerPolicy ?? "reject";
    if (policy === "reject") {
      issues.push(
        issue(
          row,
          "phone",
          "phone_taken",
          "error",
          "Phone already identifies a customer. Reject was selected.",
          "Change policy to 'Skip existing' or 'Update existing'.",
        ),
      );
    } else if (policy === "skip") {
      issues.push(
        issue(
          row,
          "phone",
          "skip",
          "warning",
          "Existing customer will be skipped. The stored phone is not rewritten.",
        ),
      );
    } else {
      issues.push(
        issue(
          row,
          "phone",
          "update",
          "warning",
          "Existing customer will be updated. The stored phone is kept.",
        ),
      );
    }
  }

  return { targetId };
}

function reviewCategory(
  options: PreviewOptions,
  values: Record<string, string>,
  row: number,
  issues: PreviewIssue[],
): { targetId: string | null } {
  let targetId: string | null = null;
  if (!values.name_ar || !values.name_en) {
    issues.push(
      issue(
        row,
        "name",
        "name",
        "error",
        "Both Arabic and English names are required.",
        "Fill in both Arabic and English names for the category.",
      ),
    );
  }

  const parentName = values.parent ?? "";
  if (parentName) {
    const matches = options.catalogue.categories.filter(
      (category) =>
        sameName(category.name_ar, parentName) || sameName(category.name_en, parentName),
    );
    const active = matches.filter((category) => category.active);
    if (active.length !== 1) {
      issues.push(
        issue(
          row,
          "parent",
          active.length === 0 && matches.length > 0 ? "archived_category" : "parent",
          "error",
          "Parent category must be exactly one active category.",
          "Ensure parent category name matches an existing active category.",
        ),
      );
    }
  }

  const clash = options.catalogue.categories.find(
    (category) =>
      sameName(category.name_en, values.name_en) || sameName(category.name_ar, values.name_ar),
  );
  if (clash) {
    targetId = clash.id;
    issues.push(
      issue(
        row,
        "name",
        "exists",
        "error",
        "A category with that name already exists. It is not overwritten.",
        "Use a unique category name.",
      ),
    );
  }

  return { targetId };
}

function reviewStock(
  options: PreviewOptions,
  values: Record<string, string>,
  row: number,
  issues: PreviewIssue[],
): {
  targetId: string | null;
  variantId: string | null;
  branchId: string | null;
  computedStock: PreviewRow["computedStock"];
} {
  const mode = options.stockMode ?? "set";
  const quantity = Number(values.quantity);

  if (!Number.isInteger(quantity)) {
    issues.push(
      issue(
        row,
        "quantity",
        "quantity",
        "error",
        "Quantity must be a whole number.",
        "Provide an integer stock quantity.",
      ),
    );
    return { targetId: null, variantId: null, branchId: null, computedStock: null };
  }

  const skuOwner = values.sku ? findCode(options.catalogue, values.sku, "sku") : null;
  const barcodeOwner = values.barcode ? findCode(options.catalogue, values.barcode, "barcode") : null;

  if (!skuOwner && !barcodeOwner) {
    issues.push(
      issue(
        row,
        "sku",
        "unknown",
        "error",
        "SKU or barcode must match one catalogue row.",
        "Ensure SKU or barcode exists in the product/variant catalog.",
      ),
    );
    return { targetId: null, variantId: null, branchId: null, computedStock: null };
  }

  if (
    skuOwner &&
    barcodeOwner &&
    (skuOwner.productId !== barcodeOwner.productId ||
      skuOwner.variantId !== barcodeOwner.variantId)
  ) {
    issues.push(
      issue(
        row,
        "barcode",
        "ambiguous",
        "error",
        "SKU and barcode identify different rows.",
        "Ensure SKU and barcode refer to the exact same product or variant.",
      ),
    );
    return { targetId: null, variantId: null, branchId: null, computedStock: null };
  }

  const owner = skuOwner ?? barcodeOwner;
  if (!owner) {
    return { targetId: null, variantId: null, branchId: null, computedStock: null };
  }

  const product = options.catalogue.products.find((item) => item.id === owner.productId);
  if (!product?.stock_tracking_enabled) {
    issues.push(
      issue(
        row,
        "sku",
        "untracked",
        "error",
        "Stock tracking is off for this product.",
        "Enable stock tracking on this product first before adjusting stock.",
      ),
    );
    return {
      targetId: owner.productId,
      variantId: owner.variantId,
      branchId: null,
      computedStock: null,
    };
  }

  if (product.variants_enabled && !owner.variantId) {
    issues.push(
      issue(
        row,
        "sku",
        "variant_required",
        "error",
        "This product sells by variant. Name the variant SKU, not the product rollup.",
        "Provide the specific variant SKU rather than the parent product code.",
      ),
    );
    return {
      targetId: owner.productId,
      variantId: null,
      branchId: null,
      computedStock: null,
    };
  }

  // Multi-branch stock calculation
  const branchVal = values.branch || options.activeBranchId || "";
  const branches = options.catalogue.branches ?? [];
  const branch = branches.find(
    (b) => b.id === branchVal || sameName(b.name, branchVal) || sameCode(b.code ?? "", branchVal),
  );
  const branchId = branch?.id ?? options.activeBranchId ?? null;

  const current = lookupCurrentStock(
    options.catalogue,
    branchId,
    owner.productId,
    owner.variantId,
    owner.variantId
      ? options.catalogue.variants.find((v) => v.id === owner.variantId)?.stock_quantity ?? 0
      : product.stock_quantity,
  );

  const rawOp = values.stock_action ? normalizeStockAction(values.stock_action, mode) : (mode === "delta" ? "ADD_STOCK" : "SET_STOCK");
  let next = current;
  let delta = 0;

  if (rawOp === "SET_STOCK") {
    if (quantity < 0) {
      issues.push(
        issue(
          row,
          "quantity",
          "negative_set_stock",
          "error",
          "A set quantity cannot be negative.",
          "Provide a quantity of 0 or higher.",
        ),
      );
    }
    next = Math.max(0, quantity);
    delta = next - current;
  } else if (rawOp === "ADD_STOCK") {
    if (quantity === 0) {
      issues.push(
        issue(
          row,
          "quantity",
          "zero_delta",
          "error",
          "A delta of zero changes nothing and is not imported.",
          "Specify a non-zero adjustment amount (+5 or -5).",
        ),
      );
    }
    delta = quantity;
    next = current + delta;
  } else if (rawOp === "SUBTRACT_STOCK") {
    delta = -Math.abs(quantity);
    next = current + delta;
  }

  if (next < 0) {
    issues.push(
      issue(
        row,
        "quantity",
        "negative_stock_result",
        "error",
        `Stock balance would become negative (${next}) for this branch.`,
        `Adjustment cannot exceed current stock balance (${current}).`,
      ),
    );
  }

  const computedStock: PreviewRow["computedStock"] = {
    branchId,
    branchName: branch?.name ?? "Default Branch",
    current,
    after: next,
    delta,
    action: rawOp,
  };

  return {
    targetId: owner.productId,
    variantId: owner.variantId,
    branchId,
    computedStock,
  };
}

function markFileDuplicates(kind: ImportKind, rows: PreviewRow[]): void {
  const seen = new Map<string, number>();
  for (const row of rows) {
    const key = duplicateKey(kind, row.values);
    if (!key) continue;
    const previous = seen.get(key);
    if (previous !== undefined) {
      row.issues.push(
        issue(
          row.row,
          "_row",
          "duplicate_in_file",
          "error",
          `Same identity as row ${previous}.`,
          `Remove duplicate row ${row.row} from spreadsheet.`,
        ),
      );
      row.status = "error";
      row.action = "none";
    } else {
      seen.set(key, row.row);
    }
  }
}

function duplicateKey(kind: ImportKind, values: Record<string, string>): string {
  if (kind === "catalog_unified") {
    const b = (values.branch || "default").trim().toLowerCase();
    const v = (values.variant_sku || values.sku || "").toUpperCase();
    return `${v}|${b}`;
  }
  if (kind === "products" || kind === "variants" || kind === "stock") {
    const b = (values.branch || "default").trim().toLowerCase();
    const code = (values.sku || values.barcode || "").toUpperCase();
    return `${code}|${b}`;
  }
  if (kind === "customers") return identityPhone(values.phone);
  if (kind === "categories") {
    return `${(values.name_en || "").toLowerCase()}|${(values.name_ar || "").toLowerCase()}`;
  }
  return "";
}

function mixedStockColumns(
  headers: readonly string[],
  rows: readonly (readonly string[])[],
): boolean {
  const setAliases = new Set(
    ["quantity", "qty", "stock", "count", "openingstock", "الكمية"].map((item) =>
      item.replace(/[^\p{L}\p{N}]+/gu, ""),
    ),
  );
  const deltaAliases = new Set(
    ["delta", "change", "adjustment", "الفرق"].map((item) =>
      item.replace(/[^\p{L}\p{N}]+/gu, ""),
    ),
  );
  let setIndex = -1;
  let deltaIndex = -1;
  headers.forEach((header, index) => {
    const key = header.trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
    if (setAliases.has(key)) setIndex = index;
    if (deltaAliases.has(key)) deltaIndex = index;
  });
  if (setIndex < 0 || deltaIndex < 0 || setIndex === deltaIndex) return false;
  return rows.some(
    (row) => (row[setIndex] ?? "").trim() && (row[deltaIndex] ?? "").trim(),
  );
}

export function findCode(
  catalogue: PreviewCatalogue,
  code: string,
  kind: "sku" | "barcode",
): { productId: string; variantId: string | null } | null {
  const wanted = code.trim().toUpperCase();
  if (!wanted) return null;
  const variant = catalogue.variants.find(
    (item) => ((kind === "sku" ? item.sku : item.barcode) ?? "").toUpperCase() === wanted,
  );
  if (variant) return { productId: variant.product_id, variantId: variant.id };
  const product = catalogue.products.find(
    (item) => ((kind === "sku" ? item.sku : item.barcode) ?? "").toUpperCase() === wanted,
  );
  return product ? { productId: product.id, variantId: null } : null;
}

function lookupCurrentStock(
  catalogue: PreviewCatalogue,
  branchId: string | null,
  productId: string | null,
  variantId: string | null,
  fallback: number,
): number {
  if (!productId) return fallback;
  if (branchId && catalogue.branchStock) {
    const match = catalogue.branchStock.find(
      (b) =>
        b.branch_id === branchId &&
        b.product_id === productId &&
        b.variant_id === (variantId ?? null),
    );
    if (match) return match.quantity;
  }
  return fallback;
}

function validateNumberField(
  row: number,
  field: string,
  raw: string | undefined,
  issues: PreviewIssue[],
  rules: { min?: number; max?: number; required?: boolean },
): void {
  if (raw === undefined || raw === "") {
    if (rules.required) {
      issues.push(
        issue(
          row,
          field,
          "required_number",
          "error",
          `${field} is required.`,
          "Enter a valid numerical value.",
        ),
      );
    }
    return;
  }

  const num = Number(raw);
  if (Number.isNaN(num)) {
    issues.push(
      issue(
        row,
        field,
        "invalid_number",
        "error",
        `Invalid number for ${field}: "${raw}".`,
        "Enter a numeric value like 10.50.",
      ),
    );
    return;
  }

  if (rules.min !== undefined && num < rules.min) {
    issues.push(
      issue(
        row,
        field,
        "number_under_min",
        "error",
        `${field} cannot be less than ${rules.min}.`,
        `Enter a value of ${rules.min} or higher.`,
      ),
    );
  }

  if (rules.max !== undefined && num > rules.max) {
    issues.push(
      issue(
        row,
        field,
        "number_over_max",
        "error",
        `${field} cannot exceed ${rules.max}.`,
        `Enter a value of ${rules.max} or lower.`,
      ),
    );
  }
}

function normalizeStockAction(
  actionRaw: string | undefined,
  defaultMode: StockMode | undefined,
): StockAction {
  const norm = (actionRaw || "").trim().toUpperCase();
  if (norm === "ADD_STOCK" || norm === "ADD" || norm === "DELTA" || norm === "زيادة") {
    return "ADD_STOCK";
  }
  if (norm === "SUBTRACT_STOCK" || norm === "SUBTRACT" || norm === "خصم" || norm === "نقص") {
    return "SUBTRACT_STOCK";
  }
  if (norm === "SET_STOCK" || norm === "SET" || norm === "جرد" || norm === "تحديد") {
    return "SET_STOCK";
  }
  if (norm === "NO_STOCK_CHANGE" || norm === "NO_CHANGE" || norm === "NONE" || norm === "بدون تغيير") {
    return "NO_STOCK_CHANGE";
  }
  if (norm === "UPDATE" || norm === "تحديث") return "UPDATE";
  if (norm === "CREATE" || norm === "إنشاء") return "CREATE";
  return defaultMode === "delta" ? "ADD_STOCK" : "SET_STOCK";
}

function sameCode(left: string, right: string): boolean {
  return left.trim().toUpperCase() === right.trim().toUpperCase() && right.trim() !== "";
}

function sameName(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase() && right.trim() !== "";
}

function issue(
  row: number,
  field: string,
  code: string,
  level: "warning" | "error",
  message: string,
  suggestedFix?: string,
): PreviewIssue {
  return { row, field, code, level, message, suggestedFix };
}
