/**
 * Advanced Import Center (Phase 57).
 *
 * A file is a proposal. Nothing here is a write. Column review, row status
 * and the commit mode are decided before any repository is asked to change.
 */

export type ImportKind = "products" | "variants" | "customers" | "categories" | "stock";

export type StockMode = "set" | "delta";

/** What to do when a customer phone already identifies exactly one person. */
export type CustomerMatchPolicy = "skip" | "update" | "reject";

/** What to do when a product SKU already identifies exactly one product. */
export type ProductMatchPolicy = "reject" | "update";

export type CommitMode = "valid-only" | "all-or-nothing";

export type RowStatus = "valid" | "warning" | "error";

export interface FieldSpec {
  field: string;
  aliases: readonly string[];
  required?: boolean;
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
}

export type RowAction = "create" | "update" | "skip" | "stock_set" | "stock_delta" | "none";

export interface PreviewRow {
  row: number;
  status: RowStatus;
  action: RowAction;
  issues: PreviewIssue[];
  values: Record<string, string>;
  /** Catalogue id the row would change, when the match is unique. */
  targetId: string | null;
  variantId: string | null;
}

export interface ImportPreview {
  kind: ImportKind;
  headers: string[];
  review: ColumnReview;
  rows: PreviewRow[];
  globalErrors: string[];
  counts: { valid: number; warning: number; error: number };
  /** Review is unambiguous and the file itself is acceptable. */
  ready: boolean;
}

export interface ImportCommitResult {
  written: number;
  skipped: number;
  errors: number;
  rolledBack: boolean;
  issues: PreviewIssue[];
}
