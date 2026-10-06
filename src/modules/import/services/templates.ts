/**
 * Excel Import Template Generator.
 *
 * Generates three production-grade Excel templates:
 *   1. Blank Catalog Template: comprehensive blank schema with sample data.
 *   2. Current Catalog Export Template: pre-populated with live catalog data.
 *   3. Stock Adjustment Template: pre-populated with active products & stock balances.
 *
 * Includes dropdown validation lists, version metadata, and bilingual labels.
 */
import type { Category, Product } from "@/modules/products/types";
import type { ProductVariant } from "@/modules/products/variants";
import type { BranchContext, PreviewBranchStock } from "../types";

export const TEMPLATE_VERSION = "1.0.0";

export interface TemplateCatalogData {
  products: readonly Product[];
  variants: readonly ProductVariant[];
  categories: readonly Category[];
  branches?: readonly BranchContext[];
  branchStock?: readonly PreviewBranchStock[];
}

export async function generateBlankCatalogTemplate(
  categories: readonly Category[] = [],
  branches: readonly BranchContext[] = [],
): Promise<ArrayBuffer> {
  const XLSX = await import("xlsx");
  const wb = XLSX.utils.book_new();

  const headers = [
    "Product Name (Arabic) / اسم المنتج (عربي)",
    "Product Name (English) / اسم المنتج (إنجليزي)",
    "Product SKU / رمز المنتج",
    "Barcode / الباركود",
    "Category / الفئة",
    "Product Type / النوع",
    "Selling Price / سعر البيع",
    "Cost Price / سعر التكلفة",
    "Tax Rate % / نسبة الضريبة",
    "Low Stock Level / الحد الأدنى",
    "Stock Tracking Enabled / تتبع المخزون",
    "Active / نشط",
    "Description (Arabic) / الوصف عربي",
    "Description (English) / الوصف إنجليزي",
    "Variant SKU / رمز المتغير",
    "Color (Arabic) / اللون عربي",
    "Color (English) / اللون إنجليزي",
    "Size / المقاس",
    "Size Label / تسمية المقاس",
    "Variant Price Override / سعر المتغير",
    "Variant Cost Override / تكلفة المتغير",
    "Branch / الفرع",
    "Stock Action / العملية",
    "Quantity / الكمية",
    "Stock Reason / السبب",
    "Notes / ملاحظات",
  ];

  const sampleRows = [
    [
      "تيشيرت كلاسيك قطن",
      "Classic Cotton T-Shirt",
      "TSHIRT-001",
      "628100010001",
      categories[0]?.name_en || "Clothing",
      "physical",
      150.0,
      80.0,
      14,
      5,
      "true",
      "true",
      "تيشيرت قطني عالي الجودة",
      "100% Cotton Premium T-Shirt",
      "TSHIRT-BLK-M",
      "أسود",
      "Black",
      "",
      "M",
      150.0,
      80.0,
      branches[0]?.name || "Main Branch",
      "SET_STOCK",
      25,
      "opening_stock",
      "Initial stock load",
    ],
    [
      "تيشيرت كلاسيك قطن",
      "Classic Cotton T-Shirt",
      "TSHIRT-001",
      "628100010002",
      categories[0]?.name_en || "Clothing",
      "physical",
      150.0,
      80.0,
      14,
      5,
      "true",
      "true",
      "تيشيرت قطني عالي الجودة",
      "100% Cotton Premium T-Shirt",
      "TSHIRT-BLK-L",
      "أسود",
      "Black",
      "",
      "L",
      150.0,
      80.0,
      branches[0]?.name || "Main Branch",
      "SET_STOCK",
      30,
      "opening_stock",
      "Initial stock load",
    ],
    [
      "حقيبة جلدية فاخرة",
      "Luxury Leather Bag",
      "BAG-LUX-01",
      "628100020001",
      categories[1]?.name_en || categories[0]?.name_en || "Accessories",
      "physical",
      450.0,
      220.0,
      14,
      3,
      "true",
      "true",
      "حقيبة يد جلد طبيعي",
      "Genuine leather handbag",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      branches[0]?.name || "Main Branch",
      "SET_STOCK",
      12,
      "opening_stock",
      "Standalone product example",
    ],
  ];

  const ws = XLSX.utils.aoa_to_sheet([headers, ...sampleRows]);

  ws["!cols"] = [
    { wch: 28 }, // Name Ar
    { wch: 28 }, // Name En
    { wch: 18 }, // Product SKU
    { wch: 18 }, // Barcode
    { wch: 20 }, // Category
    { wch: 14 }, // Product Type
    { wch: 14 }, // Selling Price
    { wch: 14 }, // Cost Price
    { wch: 12 }, // Tax Rate
    { wch: 14 }, // Low Stock
    { wch: 18 }, // Stock Tracking
    { wch: 10 }, // Active
    { wch: 25 }, // Desc Ar
    { wch: 25 }, // Desc En
    { wch: 20 }, // Variant SKU
    { wch: 16 }, // Color Ar
    { wch: 16 }, // Color En
    { wch: 10 }, // Size
    { wch: 12 }, // Size Label
    { wch: 16 }, // Variant Price Override
    { wch: 16 }, // Variant Cost Override
    { wch: 18 }, // Branch
    { wch: 16 }, // Stock Action
    { wch: 12 }, // Quantity
    { wch: 16 }, // Stock Reason
    { wch: 24 }, // Notes
  ];

  XLSX.utils.book_append_sheet(wb, ws, "Catalog Template");

  // Reference lists sheet for lookup
  const refHeaders = ["Valid Categories", "Valid Branches", "Stock Actions", "Active Values"];
  const maxRefRows = Math.max(
    categories.length,
    branches.length,
    6, // actions
    2, // active
  );

  const stockActions = ["SET_STOCK", "ADD_STOCK", "SUBTRACT_STOCK", "NO_STOCK_CHANGE"];
  const activeVals = ["true", "false"];

  const refRows: (string | number)[][] = [];
  for (let i = 0; i < maxRefRows; i++) {
    refRows.push([
      categories[i]?.name_en || (categories[i]?.name_ar ?? ""),
      branches[i]?.name || "",
      stockActions[i] || "",
      activeVals[i] || "",
    ]);
  }

  const refWs = XLSX.utils.aoa_to_sheet([refHeaders, ...refRows]);
  refWs["!cols"] = [{ wch: 24 }, { wch: 24 }, { wch: 20 }, { wch: 16 }];
  XLSX.utils.book_append_sheet(wb, refWs, "Reference Values");

  const buffer = XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
  return buffer;
}

export async function generateCurrentCatalogExportTemplate(
  data: TemplateCatalogData,
): Promise<ArrayBuffer> {
  const XLSX = await import("xlsx");
  const wb = XLSX.utils.book_new();

  const headers = [
    "Product ID / معرف المنتج",
    "Product Name (Arabic) / اسم المنتج (عربي)",
    "Product Name (English) / اسم المنتج (إنجليزي)",
    "Product SKU / رمز المنتج",
    "Barcode / الباركود",
    "Category / الفئة",
    "Product Type / النوع",
    "Selling Price / سعر البيع",
    "Cost Price / سعر التكلفة",
    "Tax Rate % / نسبة الضريبة",
    "Low Stock Level / الحد الأدنى",
    "Stock Tracking Enabled / تتبع المخزون",
    "Active / نشط",
    "Variant ID / معرف المتغير",
    "Variant SKU / رمز المتغير",
    "Color (Arabic) / اللون عربي",
    "Color (English) / اللون إنجليزي",
    "Size / المقاس",
    "Size Label / تسمية المقاس",
    "Variant Price Override / سعر المتغير",
    "Variant Cost Override / تكلفة المتغير",
    "Branch / الفرع",
    "Current Stock / الرصيد الحالي",
    "Stock Action / العملية",
    "Quantity / الكمية",
    "Stock Reason / السبب",
    "Notes / ملاحظات",
  ];

  const categoryMap = new Map(data.categories.map((c) => [c.id, c.name_en || c.name_ar]));
  const defaultBranchName = data.branches?.[0]?.name || "Main Branch";

  const rows: (string | number)[][] = [];

  for (const product of data.products) {
    const productVariants = data.variants.filter((v) => v.product_id === product.id);

    if (productVariants.length === 0) {
      // Plain product row
      rows.push([
        product.id,
        product.name_ar,
        product.name_en,
        product.sku,
        product.barcode || "",
        categoryMap.get(product.category_id || "") || "",
        product.product_type || "physical",
        product.selling_price,
        product.cost_price ?? 0,
        product.tax_rate ?? 0,
        product.low_stock_level ?? 5,
        product.stock_tracking_enabled ? "true" : "false",
        product.active ? "true" : "false",
        "", // Variant ID
        "", // Variant SKU
        "", // Color Ar
        "", // Color En
        "", // Size
        "", // Size label
        "", // Variant Price
        "", // Variant Cost
        defaultBranchName,
        product.stock_quantity,
        "NO_STOCK_CHANGE",
        product.stock_quantity,
        "recount",
        "",
      ]);
    } else {
      // Multi-variant rows
      for (const variant of productVariants) {
        rows.push([
          product.id,
          product.name_ar,
          product.name_en,
          product.sku,
          variant.barcode || product.barcode || "",
          categoryMap.get(product.category_id || "") || "",
          product.product_type || "physical",
          product.selling_price,
          product.cost_price ?? 0,
          product.tax_rate ?? 0,
          product.low_stock_level ?? 5,
          product.stock_tracking_enabled ? "true" : "false",
          product.active ? "true" : "false",
          variant.id,
          variant.sku,
          variant.color_ar || "",
          variant.color_en || "",
          variant.size ?? "",
          variant.size_label || "",
          variant.price_override ?? "",
          variant.cost_override ?? "",
          defaultBranchName,
          variant.stock_quantity,
          "NO_STOCK_CHANGE",
          variant.stock_quantity,
          "recount",
          "",
        ]);
      }
    }
  }

  const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);
  ws["!cols"] = [
    { wch: 36 }, // Product ID
    { wch: 28 }, // Name Ar
    { wch: 28 }, // Name En
    { wch: 18 }, // Product SKU
    { wch: 18 }, // Barcode
    { wch: 20 }, // Category
    { wch: 14 }, // Product Type
    { wch: 14 }, // Selling Price
    { wch: 14 }, // Cost Price
    { wch: 12 }, // Tax Rate
    { wch: 14 }, // Low Stock
    { wch: 18 }, // Stock Tracking
    { wch: 10 }, // Active
    { wch: 36 }, // Variant ID
    { wch: 20 }, // Variant SKU
    { wch: 16 }, // Color Ar
    { wch: 16 }, // Color En
    { wch: 10 }, // Size
    { wch: 12 }, // Size Label
    { wch: 16 }, // Variant Price Override
    { wch: 16 }, // Variant Cost Override
    { wch: 18 }, // Branch
    { wch: 14 }, // Current Stock
    { wch: 16 }, // Stock Action
    { wch: 12 }, // Quantity
    { wch: 16 }, // Stock Reason
    { wch: 24 }, // Notes
  ];

  XLSX.utils.book_append_sheet(wb, ws, "Current Catalog");

  const buffer = XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
  return buffer;
}

export async function generateStockAdjustmentTemplate(
  data: TemplateCatalogData,
): Promise<ArrayBuffer> {
  const XLSX = await import("xlsx");
  const wb = XLSX.utils.book_new();

  const headers = [
    "Product Name / اسم المنتج",
    "Product SKU / رمز المنتج",
    "Variant SKU / رمز المتغير",
    "Barcode / الباركود",
    "Color / اللون",
    "Size / المقاس",
    "Branch / الفرع",
    "Current Stock / الرصيد الحالي",
    "Stock Action / نوع العملية",
    "New Quantity / Delta / الكمية الجديدة أو الفرق",
    "Stock Reason / سبب الجرد",
    "Notes / ملاحظات",
  ];

  const defaultBranchName = data.branches?.[0]?.name || "Main Branch";
  const rows: (string | number)[][] = [];

  for (const product of data.products) {
    if (!product.stock_tracking_enabled) continue;
    const variants = data.variants.filter((v) => v.product_id === product.id);

    if (variants.length === 0) {
      rows.push([
        product.name_en || product.name_ar,
        product.sku,
        "",
        product.barcode || "",
        "",
        "",
        defaultBranchName,
        product.stock_quantity,
        "SET_STOCK",
        product.stock_quantity,
        "recount",
        "",
      ]);
    } else {
      for (const variant of variants) {
        rows.push([
          product.name_en || product.name_ar,
          product.sku,
          variant.sku,
          variant.barcode || product.barcode || "",
          variant.color_en || variant.color_ar || "",
          variant.size_label || (variant.size !== null ? String(variant.size) : ""),
          defaultBranchName,
          variant.stock_quantity,
          "SET_STOCK",
          variant.stock_quantity,
          "recount",
          "",
        ]);
      }
    }
  }

  const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);
  ws["!cols"] = [
    { wch: 28 }, // Name
    { wch: 18 }, // Product SKU
    { wch: 20 }, // Variant SKU
    { wch: 18 }, // Barcode
    { wch: 14 }, // Color
    { wch: 10 }, // Size
    { wch: 18 }, // Branch
    { wch: 14 }, // Current Stock
    { wch: 16 }, // Stock Action
    { wch: 20 }, // New Qty / Delta
    { wch: 16 }, // Reason
    { wch: 24 }, // Notes
  ];

  XLSX.utils.book_append_sheet(wb, ws, "Stock Adjustments");

  const buffer = XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
  return buffer;
}
