/**
 * Advanced Import Center Types & Interfaces.
 *
 * All-or-nothing validation, atomic server execution, multi-branch stock
 * isolation, and versioned template architecture.
 */

export type ImportKind =
  | "products"
  | "variants"
  | "catalog_unified"
  | "customers"
  | "categories"
  | "stock";

export type StockMode = "set" | "delta" | "no_change";

export type StockAction =
  | "CREATE"
  | "UPDATE"
  | "ADD_STOCK"
  | "SUBTRACT_STOCK"
  | "SET_STOCK"
  | "NO_STOCK_CHANGE";

/** What to do when a customer phone already identifies exactly one person. */
export type CustomerMatchPolicy = "skip" | "update" | "reject";

/** What to do when a product SKU already identifies exactly one product. */
export type ProductMatchPolicy = "reject" | "update";

export type CommitMode = "all-or-nothing" | "valid-only";

export type RowStatus = "valid" | "warning" | "error";

export interface FieldSpec {
  field: string;
  aliases: readonly string[];
  required?: boolean;
  descriptionAr?: string;
  descriptionEn?: string;
}

export interface ColumnAssignment {
  index: number;
  header: string;
  field: string | null;
  candidates: string[];
  /** Image and data-url columns are never mapped. */
  refused: "blob" | null;
}

export interface ColumnReview {
  assignments: ColumnAssignment[];
  ambiguous: { index: number; header: string; candidates: string[] }[];
  duplicateFields: { field: string; indexes: number[] }[];
  missingRequired: string[];
  refusedBlobs: { index: number; header: string }[];
  ready: boolean;
}

export interface PreviewIssue {
  row: number;
  field: string;
  code: string;
  level: "warning" | "error";
  message: string;
  suggestedFix?: string;
}

export type RowAction =
  | "create"
  | "update"
  | "skip"
  | "stock_set"
  | "stock_delta"
  | "stock_subtract"
  | "none";

export interface PreviewBranchStock {
  branchId: string | null;
  branchName: string | null;
  current: number;
  after: number;
  delta: number;
  action: string;
}

export interface PreviewRow {
  row: number;
  status: RowStatus;
  action: RowAction;
  issues: PreviewIssue[];
  values: Record<string, string>;
  /** Catalogue id the row would change, when the match is unique. */
  targetId: string | null;
  variantId: string | null;
  branchId?: string | null;
  computedStock?: PreviewBranchStock | null;
}

export interface ImportPreview {
  kind: ImportKind;
  headers: string[];
  review: ColumnReview;
  rows: PreviewRow[];
  globalErrors: string[];
  counts: { valid: number; warning: number; error: number };
  /** Review is unambiguous and the file itself is acceptable with 0 errors in all-or-nothing mode. */
  ready: boolean;
}

export interface ImportCommitResult {
  batchId: string;
  written: number;
  skipped: number;
  errors: number;
  rolledBack: boolean;
  issues: PreviewIssue[];
  createdProductIds: string[];
  createdVariantIds: string[];
  stockAdjustmentsCount: number;
}

export interface ImportBatchRecord {
  id: string;
  batch_id: string;
  kind: ImportKind;
  mode: CommitMode;
  stock_mode?: StockMode | null;
  status: "completed" | "failed" | "rolled_back";
  filename?: string | null;
  total_rows: number;
  written_count: number;
  skipped_count: number;
  error_count: number;
  summary?: Record<string, unknown> | null;
  errors?: PreviewIssue[] | null;
  branch_id?: string | null;
  user_id?: string | null;
  user_name?: string | null;
  created_at: string;
}

export interface BranchContext {
  id: string;
  name: string;
  code?: string | null;
  is_headquarters?: boolean;
}
