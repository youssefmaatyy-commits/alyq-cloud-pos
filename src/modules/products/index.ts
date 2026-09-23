/**
 * Products & Categories module (Phase 2).
 * Public surface — import from here in other modules/pages.
 */
export { CatalogProvider, useCatalog } from "./hooks/CatalogProvider";
export { ProductsPage } from "./pages/ProductsPage";
export { ProductFormPage } from "./pages/ProductFormPage";
export { ProductDetailPage } from "./pages/ProductDetailPage";
export { CategoriesPage } from "./pages/CategoriesPage";
export { ProductTable } from "./components/ProductTable";
export { ProductForm } from "./components/ProductForm";
export { ProductDetails } from "./components/ProductDetails";
export { ProductFilters, EMPTY_FILTERS } from "./components/ProductFilters";
export type { ProductFiltersValue } from "./components/ProductFilters";
export { CategoryTree } from "./components/CategoryTree";
export { CategoryFormModal } from "./components/CategoryFormModal";
export { ProductTypeBadge, ActiveBadge } from "./components/ProductTypeBadge";
export * from "./types";
export * from "./constants";
export * from "./validation";
export {
  saveProduct,
  saveCategory,
  deleteCategory,
  setProductActive,
  describeError,
} from "./services/catalogService";
export {
  buildCategoryTree,
  flattenCategoryTree,
  toCategoryOptions,
  categoryNameIndex,
} from "./services/categoryTree";
export { queryProducts, summarize } from "./services/productQuery";
export {
  resolveProductImages,
  uploadProductImage,
  validateImageFile,
  MAX_IMAGE_FILE_SIZE,
  ALLOWED_IMAGE_TYPES,
} from "./services/imageStorage";
export type { ProductImageItem } from "./types";
export { BarcodePreview } from "./components/BarcodePreview";
export { ExcelImportModal } from "./components/ExcelImportModal";
export {
  deriveBarcodeFromSku,
  isDerivedFromSku,
  encodeCode128,
  isEncodableCode128,
  validateBarcodePayload,
  barcodeToSvgString,
  code128Checksum,
  MAX_BARCODE_PAYLOAD,
} from "./services/barcode";
export type { EncodedBarcode, BarcodeBar, BarcodeError } from "./services/barcode";
export { buildBarcodeLabelHtml } from "./services/barcodeLabel";
export type { BarcodeLabelData, BarcodeLabelStrings } from "./services/barcodeLabel";
export { getCatalogRepository, getCatalogMode } from "./data";
export { AppError, toAppError } from "./data/repository";
export type { AppErrorCode, CatalogRepository } from "./data/repository";
export {
  importProductsFromCsv,
  importProductsFromFile,
  generateExcelTemplate,
  resolveCategoryIds,
  buildColumnMap,
  parseCsv,
  TEMPLATE_COLUMNS,
} from "./services/excelImport";
export type {
  ImportResult,
  ImportRowResult,
  ImportRowError,
  ImportableField,
  ColumnMap,
} from "./services/excelImport";
