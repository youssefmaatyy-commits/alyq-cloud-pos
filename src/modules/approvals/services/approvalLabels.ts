import type { ApprovalKind, ApprovalValue } from "../types";

/**
 * Presentation helpers for approval requests (Phase 12).
 *
 * Kept out of the components so the inbox, the decision dialog, the exports and
 * the tests all read a request the same way — and so nothing here can drift from
 * the dictionary keys the screens translate.
 */

/** `approvals.kind.expense` — the four acts a limit can gate. */
export function approvalKindLabelKey(kind: ApprovalKind): string {
  return `approvals.kind.${kind}`;
}

/** `approvals.status.pending` — where a request is in its life. */
export function approvalStatusLabelKey(status: string): string {
  return `approvals.status.${status}`;
}

/** Which badge tone a status wears. */
export function approvalStatusTone(status: string): "success" | "warning" | "danger" | "neutral" {
  switch (status) {
    case "approved":
      return "success";
    case "pending":
      return "warning";
    case "rejected":
      return "danger";
    default:
      return "neutral";
  }
}

/** Is `amount` a percentage rather than money? Only discounts are. */
export function isPercentKind(kind: ApprovalKind): boolean {
  return kind === "discount";
}

export interface ApprovalValueRow {
  field: string;
  previous: string;
  next: string;
}

/** Field labels for the value columns a request carries. */
const FIELD_LABELS: Record<string, string> = {
  selling_price: "Selling price",
  cost_price: "Cost price",
  amount: "Amount",
  discount_percent: "Discount",
  refund_status: "Refund status",
  expense_amount: "Expense amount",
};

function render(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "number") return String(Math.round(value * 100) / 100);
  return String(value);
}

/**
 * The previous value and the new value, side by side — requirement 2 asks for
 * both, and a reader should not have to open the record to see the move.
 */
export function approvalValueSummary(
  previous: ApprovalValue,
  next: ApprovalValue,
): ApprovalValueRow[] {
  const fields = [...new Set([...Object.keys(previous ?? {}), ...Object.keys(next ?? {})])];
  if (fields.length === 0) return [];
  return fields.map((field) => ({
    field: FIELD_LABELS[field] ?? field,
    previous: render(previous?.[field]),
    next: render(next?.[field]),
  }));
}
