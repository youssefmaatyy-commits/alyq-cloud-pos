/**
 * Column review (Phase 57).
 *
 * A header that fits two fields is not mapped. Two headers that fit one field
 * are not mapped. The operator picks. Nothing is guessed past an exact alias.
 */
import type { ColumnAssignment, ColumnReview, FieldSpec, ImportKind } from "../types";

export function normalizeHeader(header: string): string {
  return header.trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

const BLOB_HEADER = /image|photo|picture|base64|dataurl|صورة|صوره|صور/;

export function isBlobHeader(header: string): boolean {
  return BLOB_HEADER.test(normalizeHeader(header));
}

export function fieldSpecs(kind: ImportKind): FieldSpec[] {
  if (kind === "products") {
    return [
      { field: "sku", aliases: ["sku", "code", "product sku", "كود", "رمز", "رمز المنتج"], required: true },
      { field: "name_ar", aliases: ["name_ar", "name ar", "الاسم", "اسم عربي", "product name (arabic)", "اسم المنتج (عربي)", "name", "product name"] },
      { field: "name_en", aliases: ["name_en", "name en", "product name (english)", "اسم المنتج (إنجليزي)", "name", "product name"] },
      { field: "barcode", aliases: ["barcode", "باركود", "الباركود"] },
      { field: "category", aliases: ["category", "category_name", "التصنيف", "الفئة"] },
      { field: "selling_price", aliases: ["selling_price", "price", "السعر", "سعر البيع", "selling price"] },
      { field: "cost_price", aliases: ["cost_price", "cost", "التكلفة", "سعر التكلفة", "cost price"] },
      { field: "tax_rate", aliases: ["tax_rate", "tax", "الضريبة"] },
      { field: "low_stock_level", aliases: ["low_stock_level", "low stock", "الحد الأدنى"] },
      { field: "stock_tracking_enabled", aliases: ["stock_tracking_enabled", "track stock", "تتبع المخزون"] },
      { field: "product_type", aliases: ["product_type", "type", "النوع"] },
      { field: "description_ar", aliases: ["description_ar", "الوصف"] },
      { field: "description_en", aliases: ["description_en", "description"] },
      { field: "stock_quantity", aliases: ["stock_quantity", "stock", "qty", "quantity", "الكمية", "المخزون"] },
    ];
  }
  if (kind === "variants") {
    return [
      { field: "parent_sku", aliases: ["parent_sku", "parent sku", "product sku", "منتج", "رمز المنتج"], required: true },
      { field: "sku", aliases: ["sku", "variant sku", "رمز المتغير"], required: true },
      { field: "color_en", aliases: ["color_en", "color", "colour", "اللون"] },
      { field: "color_ar", aliases: ["color_ar", "اللون عربي"] },
      { field: "size", aliases: ["size", "المقاس"] },
      { field: "size_label", aliases: ["size_label", "size label"] },
      { field: "barcode", aliases: ["barcode", "باركود"] },
      { field: "price_override", aliases: ["price_override", "price", "السعر"] },
      { field: "low_stock_level", aliases: ["low_stock_level", "low stock"] },
    ];
  }
  if (kind === "customers") {
    return [
      { field: "name", aliases: ["name", "customer", "الاسم", "اسم العميل"], required: true },
      { field: "phone", aliases: ["phone", "mobile", "الهاتف", "الموبايل", "رقم الهاتف"], required: true },
      { field: "email", aliases: ["email", "البريد"] },
      { field: "address", aliases: ["address", "العنوان"] },
      { field: "notes", aliases: ["notes", "ملاحظات"] },
    ];
  }
  if (kind === "categories") {
    return [
      { field: "name_ar", aliases: ["name_ar", "الاسم", "اسم عربي"], required: true },
      { field: "name_en", aliases: ["name_en", "name", "الاسم الإنجليزي"], required: true },
      { field: "parent", aliases: ["parent", "parent category", "التصنيف الأب"] },
      { field: "sort_order", aliases: ["sort_order", "sort", "الترتيب"] },
    ];
  }
  return [
    { field: "sku", aliases: ["sku", "code", "كود", "رمز"] },
    { field: "barcode", aliases: ["barcode", "باركود"] },
    { field: "quantity", aliases: ["quantity", "qty", "stock", "count", "opening stock", "delta", "change", "adjustment", "الكمية", "الفرق"], required: true },
    { field: "notes", aliases: ["notes", "ملاحظات"] },
  ];
}

function candidatesFor(header: string, specs: readonly FieldSpec[]): string[] {
  const key = normalizeHeader(header);
  if (!key) return [];
  const hits: string[] = [];
  for (const spec of specs) {
    if (spec.aliases.some((alias) => normalizeHeader(alias) === key)) hits.push(spec.field);
  }
  return hits;
}

/**
 * Propose a map. Overrides are the operator's review: a field name, or null
 * to ignore the column. An override cannot claim a blob column.
 */
export function reviewColumns(
  headers: readonly string[],
  specs: readonly FieldSpec[],
  overrides: Readonly<Record<number, string | null>> = {},
): ColumnReview {
  const assignments: ColumnAssignment[] = headers.map((header, index) => {
    const refused = isBlobHeader(header) ? "blob" as const : null;
    const candidates = refused ? [] : candidatesFor(header, specs);
    const override = overrides[index];
    let field: string | null = null;
    if (!refused && override !== undefined) {
      field = override;
    } else if (!refused && candidates.length === 1) {
      field = candidates[0];
    }
    return { index, header, field, candidates, refused };
  });

  const ambiguous = assignments
    .filter((column) => column.refused === null && overrides[column.index] === undefined && column.candidates.length > 1)
    .map((column) => ({ index: column.index, header: column.header, candidates: column.candidates }));

  const byField = new Map<string, number[]>();
  for (const column of assignments) {
    if (!column.field) continue;
    const list = byField.get(column.field) ?? [];
    list.push(column.index);
    byField.set(column.field, list);
  }
  const duplicateFields = [...byField.entries()]
    .filter(([, indexes]) => indexes.length > 1)
    .map(([field, indexes]) => ({ field, indexes }));

  const mapped = new Set(assignments.map((column) => column.field).filter((field): field is string => Boolean(field)));
  const missingRequired = specs.filter((spec) => spec.required && !mapped.has(spec.field)).map((spec) => spec.field);
  if (specs.some((spec) => spec.field === "sku") && specs.some((spec) => spec.field === "barcode") && !mapped.has("sku") && !mapped.has("barcode") && specs.some((spec) => spec.field === "quantity")) {
    missingRequired.push("sku");
  }

  const refusedBlobs = assignments.filter((column) => column.refused === "blob").map((column) => ({ index: column.index, header: column.header }));
  const ready = ambiguous.length === 0 && duplicateFields.length === 0 && missingRequired.length === 0;
  return { assignments, ambiguous, duplicateFields, missingRequired, refusedBlobs, ready };
}

export function valueAt(row: readonly string[], review: ColumnReview, field: string): string {
  const column = review.assignments.find((item) => item.field === field);
  if (!column) return "";
  return (row[column.index] ?? "").trim();
}
