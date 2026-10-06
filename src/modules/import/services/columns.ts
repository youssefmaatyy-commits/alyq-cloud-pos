/**
 * Column review & field aliases for Import Center.
 *
 * Strict mapping: an ambiguous header is not mapped until the operator picks.
 * Duplicate mappings are blocked. Blob columns (e.g. data URLs) are refused.
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
  if (kind === "catalog_unified") {
    return [
      { field: "product_id", aliases: ["product_id", "product id", "معرف المنتج", "كود النظام للمنتج"] },
      { field: "product_group", aliases: ["product_group", "product group", "مجموعة المنتج", "group"] },
      { field: "sku", aliases: ["sku", "code", "product sku", "parent_sku", "parent sku", "كود", "رمز", "رمز المنتج", "كود المنتج"], required: true },
      { field: "barcode", aliases: ["barcode", "باركود", "الباركود", "رمز الباركود"] },
      { field: "name_ar", aliases: ["name_ar", "name ar", "name arabic", "name (arabic)", "الاسم", "اسم عربي", "اسم بالعربي", "الاسم (عربي)", "الاسم العربي", "الاسم بالعربي", "product name (arabic)", "اسم المنتج (عربي)", "name", "product name"] },
      { field: "name_en", aliases: ["name_en", "name en", "name english", "name (english)", "اسم انجليزي", "الاسم الإنجليزي", "product name (english)", "اسم المنتج (إنجليزي)", "name", "product name"] },
      { field: "description_ar", aliases: ["description_ar", "description ar", "الوصف", "وصف عربي", "الوصف العربي"] },
      { field: "description_en", aliases: ["description_en", "description en", "description", "وصف انجليزي", "الوصف الإنجليزي"] },
      { field: "category", aliases: ["category", "category_name", "التصنيف", "الفئة", "القسم"] },
      { field: "product_type", aliases: ["product_type", "type", "النوع", "نوع المنتج"] },
      { field: "selling_price", aliases: ["selling_price", "price", "السعر", "سعر البيع", "selling price"] },
      { field: "cost_price", aliases: ["cost_price", "cost", "التكلفة", "سعر التكلفة", "cost price"] },
      { field: "tax_rate", aliases: ["tax_rate", "tax", "الضريبة", "نسبة الضريبة"] },
      { field: "low_stock_level", aliases: ["low_stock_level", "low stock", "الحد الأدنى", "حد إعادة الطلب"] },
      { field: "stock_tracking_enabled", aliases: ["stock_tracking_enabled", "track stock", "تتبع المخزون"] },
      { field: "active", aliases: ["active", "نشط", "الحالة", "مفعل", "is_active"] },
      // Variant fields
      { field: "variant_id", aliases: ["variant_id", "variant id", "معرف المتغير", "معرف الصنف"] },
      { field: "variant_sku", aliases: ["variant_sku", "variant sku", "sku_variant", "رمز المتغير", "كود المتغير", "كود الصنف"] },
      { field: "color_ar", aliases: ["color_ar", "color ar", "color arabic", "color (arabic)", "colour arabic", "colour (arabic)", "اللون", "لون عربي", "اللون (عربي)"] },
      { field: "color_en", aliases: ["color_en", "color en", "color", "colour", "color english", "color (english)", "colour english", "colour (english)", "اللون الإنجليزي", "اللون (إنجليزي)"] },
      { field: "size", aliases: ["size", "المقاس", "مقاس"] },
      { field: "size_label", aliases: ["size_label", "size label", "تسمية المقاس"] },
      { field: "price_override", aliases: ["price_override", "variant price", "سعر المتغير", "سعر المقاس"] },
      { field: "cost_override", aliases: ["cost_override", "variant cost", "تكلفة المتغير"] },
      // Multi-Branch Stock fields
      { field: "branch", aliases: ["branch", "branch_name", "branch_id", "الفرع", "اسم الفرع", "المخزن"] },
      { field: "stock_action", aliases: ["stock_action", "action", "نوع العملية", "عملية المخزون", "stock op"] },
      { field: "quantity", aliases: ["quantity", "stock", "qty", "stock_quantity", "الكمية", "المخزون", "الرصيد", "العدد"] },
      { field: "stock_reason", aliases: ["stock_reason", "reason", "سبب الجرد", "سبب الحركة", "السبب"] },
      { field: "notes", aliases: ["notes", "note", "ملاحظات", "بيان"] },
    ];
  }

  if (kind === "products") {
    return [
      { field: "sku", aliases: ["sku", "code", "product sku", "كود", "رمز", "رمز المنتج"], required: true },
      { field: "name_ar", aliases: ["name_ar", "name ar", "name arabic", "name (arabic)", "الاسم", "اسم عربي", "product name (arabic)", "اسم المنتج (عربي)", "name", "product name"] },
      { field: "name_en", aliases: ["name_en", "name en", "name english", "name (english)", "product name (english)", "اسم المنتج (إنجليزي)", "name", "product name"] },
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
      { field: "active", aliases: ["active", "نشط", "الحالة"] },
    ];
  }

  if (kind === "variants") {
    return [
      { field: "parent_sku", aliases: ["parent_sku", "parent sku", "product sku", "منتج", "رمز المنتج"], required: true },
      { field: "sku", aliases: ["sku", "variant sku", "رمز المتغير"], required: true },
      { field: "color_en", aliases: ["color_en", "color", "colour", "color english", "color (english)", "اللون"] },
      { field: "color_ar", aliases: ["color_ar", "color arabic", "color (arabic)", "اللون عربي"] },
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

  // kind === "stock"
  return [
    { field: "sku", aliases: ["sku", "code", "كود", "رمز"] },
    { field: "barcode", aliases: ["barcode", "باركود"] },
    { field: "branch", aliases: ["branch", "branch_name", "location", "warehouse", "الفرع", "المستودع", "المخزن"] },
    { field: "stock_action", aliases: ["stock_action", "action", "stock op", "نوع العملية", "عملية المخزون", "العملية"] },
    { field: "quantity", aliases: ["quantity", "qty", "stock", "count", "opening stock", "delta", "change", "adjustment", "الكمية", "الفرق"], required: true },
    { field: "stock_reason", aliases: ["stock_reason", "reason", "سبب الحركة", "سبب الجرد", "السبب"] },
    { field: "notes", aliases: ["notes", "ملاحظات"] },
  ];
}

function candidatesFor(header: string, specs: readonly FieldSpec[]): string[] {
  const key = normalizeHeader(header);
  if (!key) return [];
  const parts = header.split(/[/|\\—–-]+/).map(normalizeHeader).filter(Boolean);
  const hits: string[] = [];
  for (const spec of specs) {
    const matchesFull = spec.aliases.some((alias) => normalizeHeader(alias) === key);
    const matchesPart = parts.some((p) => spec.aliases.some((alias) => normalizeHeader(alias) === p));
    if (matchesFull || matchesPart) hits.push(spec.field);
  }
  return hits;
}

/**
 * Propose a column map from workbook headers.
 */
export function reviewColumns(
  headers: readonly string[],
  specs: readonly FieldSpec[],
  overrides: Readonly<Record<number, string | null>> = {},
): ColumnReview {
  const assignments: ColumnAssignment[] = headers.map((header, index) => {
    const refused = isBlobHeader(header) ? ("blob" as const) : null;
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
    .filter(
      (column) =>
        column.refused === null &&
        overrides[column.index] === undefined &&
        column.candidates.length > 1,
    )
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

  const mapped = new Set(
    assignments
      .map((column) => column.field)
      .filter((field): field is string => Boolean(field)),
  );

  const missingRequired = specs
    .filter((spec) => {
      if (spec.required && spec.field === "sku" && mapped.has("product_group")) return false;
      return spec.required && !mapped.has(spec.field);
    })
    .map((spec) => spec.field);

  if (
    specs.some((spec) => spec.field === "sku") &&
    specs.some((spec) => spec.field === "barcode") &&
    !mapped.has("sku") &&
    !mapped.has("barcode") &&
    !mapped.has("product_group") &&
    !mapped.has("variant_sku") &&
    specs.some((spec) => spec.field === "quantity")
  ) {
    missingRequired.push("sku");
  }

  const refusedBlobs = assignments
    .filter((column) => column.refused === "blob")
    .map((column) => ({ index: column.index, header: column.header }));

  const ready =
    ambiguous.length === 0 && duplicateFields.length === 0 && missingRequired.length === 0;

  return { assignments, ambiguous, duplicateFields, missingRequired, refusedBlobs, ready };
}

export function valueAt(row: readonly string[], review: ColumnReview, field: string): string {
  const column = review.assignments.find((item) => item.field === field);
  if (!column) return "";
  return (row[column.index] ?? "").trim();
}
