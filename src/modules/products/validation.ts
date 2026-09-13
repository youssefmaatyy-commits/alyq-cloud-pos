import {
  MAX_BARCODE_LENGTH,
  MAX_IMAGES,
  MAX_NAME_LENGTH,
  MAX_SKU_LENGTH,
  MAX_TEXT_LENGTH,
  SKU_PATTERN,
} from "./constants";
import type { Category, NewProduct, Product, ProductImageItem, ProductType } from "./types";
import { validateImageFile } from "./services/imageStorage";
import { validateBarcodePayload } from "./services/barcode";

/** Stable error codes shared by every field validator. */
export type FieldErrorCode =
  | "required"
  | "nameArRequired"
  | "nameEnRequired"
  | "skuRequired"
  | "skuFormat"
  | "skuTaken"
  | "barcodeTaken"
  | "nonnegative"
  | "taxRange"
  | "categoryRequired"
  | "categoryInactive"
  | "url"
  | "sortOrder"
  | "tooLong"
  | "barcodeUnsupported"
  | "barcodeTooLong"
  | "imageType"
  | "imageSize"
  | "imageCount"
  | "cycle";

/** Map of field name → error code. Empty object means the draft is valid. */
export type FieldErrors = Record<string, FieldErrorCode>;

export interface ProductFormValues {
  sku: string;
  barcode: string;
  name_ar: string;
  name_en: string;
  description_ar: string;
  description_en: string;
  category_id: string;
  product_type: ProductType;
  selling_price: string;
  cost_price: string;
  tax_rate: string;
  stock_tracking_enabled: boolean;
  stock_quantity: string;
  low_stock_level: string;
  show_on_website: boolean;
  is_featured: boolean;
  active: boolean;
  /** Ordered image slots — index 0 is the cover; the rest become the gallery. */
  images: ProductImageItem[];
}

export const EMPTY_PRODUCT_FORM: ProductFormValues = {
  sku: "",
  barcode: "",
  name_ar: "",
  name_en: "",
  description_ar: "",
  description_en: "",
  category_id: "",
  product_type: "physical",
  selling_price: "",
  cost_price: "",
  tax_rate: "15",
  stock_tracking_enabled: true,
  stock_quantity: "0",
  low_stock_level: "5",
  show_on_website: true,
  is_featured: false,
  active: true,
  images: [],
};

/** Rebuild the stored cover + gallery as ordered remote image slots. */
function buildImageItems(imageUrl: string | null, gallery: string[] | undefined): ProductImageItem[] {
  const merged = [imageUrl, ...(gallery ?? [])].filter(
    (url): url is string => Boolean(url && url.trim()),
  );
  return merged.map((url, index) => ({
    id: `remote-${index}-${url.length}-${url.slice(-6)}`,
    kind: "remote",
    url,
  }));
}

export function productToForm(product: Product): ProductFormValues {
  return {
    sku: product.sku,
    barcode: product.barcode ?? "",
    name_ar: product.name_ar,
    name_en: product.name_en,
    description_ar: product.description_ar ?? "",
    description_en: product.description_en ?? "",
    category_id: product.category_id ?? "",
    product_type: product.product_type,
    selling_price: String(product.selling_price ?? ""),
    cost_price: String(product.cost_price ?? ""),
    tax_rate: String(product.tax_rate ?? ""),
    stock_tracking_enabled: product.stock_tracking_enabled,
    stock_quantity: String(product.stock_quantity ?? ""),
    low_stock_level: String(product.low_stock_level ?? ""),
    show_on_website: product.show_on_website ?? true,
    is_featured: product.is_featured ?? false,
    active: product.active,
    images: buildImageItems(product.image_url, product.images),
  };
}

export interface CategoryFormValues {
  name_ar: string;
  name_en: string;
  parent_id: string;
  sort_order: string;
  active: boolean;
}

export const EMPTY_CATEGORY_FORM: CategoryFormValues = {
  name_ar: "",
  name_en: "",
  parent_id: "",
  sort_order: "0",
  active: true,
};

export function categoryToForm(category: Category): CategoryFormValues {
  return {
    name_ar: category.name_ar,
    name_en: category.name_en,
    parent_id: category.parent_id ?? "",
    sort_order: String(category.sort_order ?? 0),
    active: category.active,
  };
}

// ── primitives ───────────────────────────────────────────────────────────

function parseNumber(raw: string): number {
  const cleaned = raw.replace(/[^\d.,-]/g, "").replace(/,/g, ".");
  const normalized =
    cleaned.indexOf(".") !== cleaned.lastIndexOf(".")
      ? cleaned.replace(/,/g, "")
      : cleaned;
  const value = Number(normalized);
  return Number.isFinite(value) ? value : NaN;
}

function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

// ── product validation ───────────────────────────────────────────────────

export interface ProductValidationContext {
  /** All known products (any status) — used for uniqueness checks. */
  products: Product[];
  categories: Category[];
  /** When editing, this product is excluded from uniqueness checks. */
  currentId?: string;
}

/**
 * Validates a product draft. Pure: no I/O, no React, fully unit-testable.
 * Returns both the field errors and the normalised payload when valid.
 */
export function validateProductDraft(
  values: ProductFormValues,
  ctx: ProductValidationContext,
): { errors: FieldErrors; data: NewProduct | null } {
  const errors: FieldErrors = {};
  const sku = values.sku.trim();
  const barcode = values.barcode.trim();
  const nameAr = values.name_ar.trim();
  const nameEn = values.name_en.trim();

  if (!sku) errors.sku = "skuRequired";
  else if (sku.length > MAX_SKU_LENGTH) errors.sku = "tooLong";
  else if (!SKU_PATTERN.test(sku)) errors.sku = "skuFormat";

  if (barcode) {
    // A barcode must be printable/scannable as Code 128, not just short.
    const barcodeError = validateBarcodePayload(barcode);
    if (barcodeError === "tooLong" || barcode.length > MAX_BARCODE_LENGTH) {
      errors.barcode = "barcodeTooLong";
    } else if (barcodeError === "unsupportedChar") {
      errors.barcode = "barcodeUnsupported";
    }
  }

  if (!nameAr) errors.name_ar = "nameArRequired";
  else if (nameAr.length > MAX_NAME_LENGTH) errors.name_ar = "tooLong";

  if (!nameEn) errors.name_en = "nameEnRequired";
  else if (nameEn.length > MAX_NAME_LENGTH) errors.name_en = "tooLong";

  if (values.description_ar.trim().length > MAX_TEXT_LENGTH) errors.description_ar = "tooLong";
  if (values.description_en.trim().length > MAX_TEXT_LENGTH) errors.description_en = "tooLong";

  if (!values.category_id) errors.category_id = "categoryRequired";

  const selling = parseNumber(values.selling_price);
  if (!values.selling_price.trim() || Number.isNaN(selling)) errors.selling_price = "required";
  else if (selling < 0) errors.selling_price = "nonnegative";

  const cost = parseNumber(values.cost_price);
  if (!values.cost_price.trim() || Number.isNaN(cost)) errors.cost_price = "required";
  else if (cost < 0) errors.cost_price = "nonnegative";

  const taxRaw = values.tax_rate.trim();
  const tax = parseNumber(taxRaw);
  if (!taxRaw || Number.isNaN(tax)) errors.tax_rate = "required";
  else if (tax < 0 || tax > 100) errors.tax_rate = "taxRange";

  // Stock — enforced only while tracking is enabled.
  const stockRaw = values.stock_quantity.trim();
  const stockQty = parseNumber(stockRaw);
  if (values.stock_tracking_enabled) {
    if (!stockRaw || Number.isNaN(stockQty)) errors.stock_quantity = "required";
    else if (stockQty < 0) errors.stock_quantity = "nonnegative";
  }

  const lowRaw = values.low_stock_level.trim();
  const lowLevel = parseNumber(lowRaw);
  if (!lowRaw || Number.isNaN(lowLevel)) errors.low_stock_level = "required";
  else if (lowLevel < 0) errors.low_stock_level = "nonnegative";

  // Image slots — enforce count, file type and file size.
  const items = values.images ?? [];
  if (items.length > MAX_IMAGES) {
    errors.images = "imageCount";
  } else {
    for (const item of items) {
      if (item.kind === "local") {
        const fileError = validateImageFile(item.file);
        if (fileError === "type") {
          errors.images = "imageType";
          break;
        }
        if (fileError === "size") {
          errors.images = "imageSize";
          break;
        }
      }
    }
  }

  // Uniqueness — case-insensitive on SKU, exact on barcode.
  if (!errors.sku) {
    const taken = ctx.products.some(
      (p) => p.id !== ctx.currentId && p.sku.trim().toLowerCase() === sku.toLowerCase(),
    );
    if (taken) errors.sku = "skuTaken";
  }
  if (!errors.barcode && barcode) {
    const taken = ctx.products.some(
      (p) => p.id !== ctx.currentId && (p.barcode ?? "").trim() === barcode,
    );
    if (taken) errors.barcode = "barcodeTaken";
  }

  // Category must exist; warn (but don't hard-block) when it is inactive.
  if (!errors.category_id) {
    const category = ctx.categories.find((c) => c.id === values.category_id);
    if (!category) errors.category_id = "categoryRequired";
  }

  if (Object.keys(errors).length > 0) return { errors, data: null };

  const data: NewProduct = {
    sku,
    barcode: barcode || null,
    name_ar: nameAr,
    name_en: nameEn,
    description_ar: values.description_ar.trim() || null,
    description_en: values.description_en.trim() || null,
    category_id: values.category_id,
    product_type: values.product_type,
    selling_price: round2(selling),
    cost_price: round2(cost),
    tax_rate: round2(tax),
    stock_tracking_enabled: values.stock_tracking_enabled,
    stock_quantity: values.stock_tracking_enabled ? Math.round(stockQty) : 0,
    low_stock_level: Math.round(lowLevel),
    show_on_website: values.show_on_website,
    is_featured: values.is_featured,
    active: values.active,
    // Placeholders — real URLs are produced by `resolveProductImages` after
    // any newly selected files have been uploaded.
    image_url: null,
    images: [],
  };

  return { errors, data };
}

// ── category validation ──────────────────────────────────────────────────

export interface CategoryValidationContext {
  categories: Category[];
  currentId?: string;
}

export function validateCategoryDraft(
  values: CategoryFormValues,
  ctx: CategoryValidationContext,
): { errors: FieldErrors; data: Omit<Category, "id" | "created_at" | "updated_at"> | null } {
  const errors: FieldErrors = {};
  const nameAr = values.name_ar.trim();
  const nameEn = values.name_en.trim();
  const parent = values.parent_id || null;
  const sortRaw = values.sort_order.trim();
  const sortOrder = Number(sortRaw === "" ? "0" : sortRaw);

  if (!nameAr) errors.name_ar = "nameArRequired";
  else if (nameAr.length > MAX_NAME_LENGTH) errors.name_ar = "tooLong";

  if (!nameEn) errors.name_en = "nameEnRequired";
  else if (nameEn.length > MAX_NAME_LENGTH) errors.name_en = "tooLong";

  if (!Number.isInteger(sortOrder) || sortOrder < 0) errors.sort_order = "sortOrder";

  // A category may never be nested inside one of its own descendants.
  if (parent && ctx.currentId && !errors.sort_order) {
    const blocked = isDescendant(parent, ctx.currentId, ctx.categories);
    if (blocked) errors.parent_id = "cycle";
  }
  if (parent && !ctx.categories.some((c) => c.id === parent)) {
    errors.parent_id = "required";
  }

  if (Object.keys(errors).length > 0) return { errors, data: null };

  return {
    errors,
    data: {
      name_ar: nameAr,
      name_en: nameEn,
      parent_id: parent,
      sort_order: sortOrder,
      active: values.active,
    },
  };
}

/**
 * True when `candidateId` lies inside the subtree of `categoryId`
 * (i.e. it is `categoryId` itself or one of its descendants).
 * Used to reject `parent_id = <own descendant>` when editing a category.
 */
export function isDescendant(
  candidateId: string,
  categoryId: string,
  categories: Category[],
): boolean {
  if (candidateId === categoryId) return true;
  const byId = new Map(categories.map((c) => [c.id, c]));
  let cursor: Category | undefined = byId.get(candidateId);
  const guard = new Set<string>();
  while (cursor?.parent_id) {
    if (cursor.parent_id === categoryId) return true;
    if (guard.has(cursor.parent_id)) break;
    guard.add(cursor.parent_id);
    cursor = byId.get(cursor.parent_id);
  }
  return false;
}

/** Guard used before deleting a category. */
export function categoryUsage(
  categoryId: string,
  products: Product[],
  categories: Category[],
): { productCount: number; childCount: number } {
  return {
    productCount: products.filter((p) => p.category_id === categoryId).length,
    childCount: categories.filter((c) => c.parent_id === categoryId).length,
  };
}

/** Human-readable i18n keys for each field error code. */
export const FIELD_ERROR_KEY: Record<FieldErrorCode, string> = {
  required: "validation.required",
  nameArRequired: "validation.nameArRequired",
  nameEnRequired: "validation.nameEnRequired",
  skuRequired: "validation.skuRequired",
  skuFormat: "validation.skuFormat",
  skuTaken: "validation.skuTaken",
  barcodeTaken: "validation.barcodeTaken",
  nonnegative: "validation.nonnegative",
  taxRange: "validation.taxRange",
  categoryRequired: "validation.categoryRequired",
  categoryInactive: "validation.categoryInactive",
  url: "validation.url",
  sortOrder: "validation.sortOrder",
  tooLong: "validation.nameTooLong",
  barcodeUnsupported: "validation.barcodeUnsupported",
  barcodeTooLong: "validation.barcodeTooLong",
  imageType: "validation.imageType",
  imageSize: "validation.imageSize",
  imageCount: "validation.imageCount",
  cycle: "categories.moveUnderSelf",
};

export function fieldErrorKey(code: FieldErrorCode): string {
  return FIELD_ERROR_KEY[code] ?? "validation.required";
}
