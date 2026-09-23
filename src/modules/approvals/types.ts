/**
 * Approval limits module — domain types (Phase 12, requirement 2).
 *
 * The idea in one paragraph: some acts are ordinary below a threshold and need a
 * second person above it. A discount over a percentage, a refund over an amount,
 * an expense over an amount, and — if the shop turns the rule on — every price
 * change. The act is *not* performed at the moment it is refused; it becomes a
 * request carrying the value before, the value wanted, the threshold it crossed
 * and the reason it was asked for. Somebody holding `approve_limit_request`
 * decides it, and only then does the deferred act run — through the same service
 * funnel it would have run through anyway, so there is one implementation of
 * "create an expense", not two.
 */

/** The four acts a limit rule can gate. */
export const APPROVAL_KINDS = ["discount", "refund", "expense", "price_change"] as const;
export type ApprovalKind = (typeof APPROVAL_KINDS)[number];

/** Where a request is in its life. Decided once, never revisited. */
export const APPROVAL_STATUSES = ["pending", "approved", "rejected", "cancelled"] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

/** What an approver (or the requester, withdrawing) may do to a pending request. */
export type ApprovalDecision = "approved" | "rejected" | "cancelled";

/** The thresholds, as one editable document. */
export interface ApprovalRules {
  discount_limit_enabled: boolean;
  /** A discount above this percentage needs sign-off. 0–100. */
  discount_limit_percent: number;
  refund_limit_enabled: boolean;
  /** A refund above this amount (EGP) needs sign-off. */
  refund_limit_amount: number;
  expense_limit_enabled: boolean;
  /** An expense above this amount (EGP) needs sign-off. */
  expense_limit_amount: number;
  /** When on, every selling-price or cost move needs sign-off. */
  price_change_approval_enabled: boolean;
  updated_by_name: string | null;
  updated_at: string | null;
}

/** The starting position an admin edits on Settings → Approval Rules. */
export const DEFAULT_APPROVAL_RULES: ApprovalRules = {
  discount_limit_enabled: true,
  discount_limit_percent: 10,
  refund_limit_enabled: true,
  refund_limit_amount: 1000,
  expense_limit_enabled: true,
  expense_limit_amount: 500,
  price_change_approval_enabled: false,
  updated_by_name: null,
  updated_at: null,
};

/** The rules form: strings, because that is what an input holds. */
export interface ApprovalRulesFormValues {
  discount_limit_enabled: boolean;
  discount_limit_percent: string;
  refund_limit_enabled: boolean;
  refund_limit_amount: string;
  expense_limit_enabled: boolean;
  expense_limit_amount: string;
  price_change_approval_enabled: boolean;
}

export function approvalRulesToForm(rules: ApprovalRules): ApprovalRulesFormValues {
  return {
    discount_limit_enabled: rules.discount_limit_enabled,
    discount_limit_percent: String(rules.discount_limit_percent),
    refund_limit_enabled: rules.refund_limit_enabled,
    refund_limit_amount: String(rules.refund_limit_amount),
    expense_limit_enabled: rules.expense_limit_enabled,
    expense_limit_amount: String(rules.expense_limit_amount),
    price_change_approval_enabled: rules.price_change_approval_enabled,
  };
}

/** JSON-safe detail, the same shape the audit trail stores. */
export type ApprovalValue = Record<string, string | number | boolean | null>;

export interface ApprovalRequest {
  id: string;
  /** Human-readable sequential number, e.g. APR-000001. */
  request_number: string;
  kind: ApprovalKind;
  /** What the request concerns: "expense", "refund", "sale", "product". */
  entity_type: string;
  /** Blank while the record does not exist yet; filled once it does. */
  entity_id: string;
  entity_label: string;
  branch: string | null;
  /** A percentage for `discount`, money for the other three. */
  amount: number;
  /** The threshold that fired, so the request says why it exists. */
  limit_value: number | null;
  /** The value before the requested move. */
  previous_value: ApprovalValue;
  /** The value being asked for. */
  new_value: ApprovalValue;
  /** The deferred act's arguments, as its own service funnel takes them. */
  payload: Record<string, unknown>;
  /** Why it was asked for. Mandatory — a limit without a reason is friction. */
  reason: string;
  status: ApprovalStatus;
  requested_by: string;
  requested_by_name: string;
  requested_at: string;
  decided_by: string | null;
  decided_by_name: string | null;
  decided_at: string | null;
  decision_note: string | null;
  /** The record approving produced; written once, which is what stops a replay. */
  result_entity_id: string | null;
  created_at: string;
}

export interface NewApprovalRequest {
  kind: ApprovalKind;
  entity_type: string;
  entity_id?: string;
  entity_label?: string;
  branch?: string | null;
  amount: number;
  limit_value?: number | null;
  previous_value?: ApprovalValue;
  new_value?: ApprovalValue;
  payload?: Record<string, unknown>;
  reason: string;
}

export interface ApprovalFiltersValue {
  search: string;
  status: ApprovalStatus | "all";
  kind: ApprovalKind | "all";
}

export const EMPTY_APPROVAL_FILTERS: ApprovalFiltersValue = {
  search: "",
  status: "all",
  kind: "all",
};

/**
 * The answer a service funnel gets when it asks "does this act need sign-off?".
 * `request` is ready to submit; `null` means the rule did not fire.
 */
export interface ApprovalRequirement {
  kind: ApprovalKind;
  /** The value that crossed the line (a percentage or an amount). */
  amount: number;
  /** The threshold it crossed. */
  limit_value: number;
  /** What the rule is called on screen, for the refusal message. */
  ruleLabelKey: string;
}
