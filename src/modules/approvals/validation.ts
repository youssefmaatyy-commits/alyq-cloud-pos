/**
 * Approval limits — rule evaluation and form validation (Phase 12).
 *
 * Two jobs, both pure so they can be tested without a repository and reused in
 * demo and live mode:
 *
 *   1. `evaluate*Rule` answers "does this act need sign-off?" for the four kinds.
 *      A service funnel calls the right one *before* it writes anything, so the
 *      act either happens or becomes a request — never both.
 *   2. `validateApprovalRulesForm` keeps the thresholds sane: a percentage is a
 *      percentage, an amount is not negative, and a rule that is switched off
 *      still has to hold a valid number so switching it back on is not a
 *      surprise.
 *
 * The comparison is always strict (`>`): a discount of exactly the cap is within
 * the rule. That is the reading a cashier can act on — "up to 10% is yours" —
 * and it is what the tests pin.
 */
import type {
  ApprovalRequirement,
  ApprovalRules,
  ApprovalRulesFormValues,
} from "./types";
import { roundMoney } from "@/modules/expenses/validation";

/** A discount above the cap needs sign-off. `percent` is 0–100. */
export function evaluateDiscountRule(
  rules: ApprovalRules,
  percent: number,
): ApprovalRequirement | null {
  if (!rules.discount_limit_enabled) return null;
  const value = Number.isFinite(percent) ? percent : 0;
  if (value <= 0) return null;
  if (value <= rules.discount_limit_percent) return null;
  return {
    kind: "discount",
    amount: round2(value),
    limit_value: rules.discount_limit_percent,
    ruleLabelKey: "approvals.rule.discount",
  };
}

/** A refund above the cap needs sign-off before the money moves. */
export function evaluateRefundRule(
  rules: ApprovalRules,
  amount: number,
): ApprovalRequirement | null {
  if (!rules.refund_limit_enabled) return null;
  const value = Number.isFinite(amount) ? amount : 0;
  if (value <= rules.refund_limit_amount) return null;
  return {
    kind: "refund",
    amount: roundMoney(value),
    limit_value: rules.refund_limit_amount,
    ruleLabelKey: "approvals.rule.refund",
  };
}

/** An expense above the cap is filed as a request, not as an expense. */
export function evaluateExpenseRule(
  rules: ApprovalRules,
  amount: number,
): ApprovalRequirement | null {
  if (!rules.expense_limit_enabled) return null;
  const value = Number.isFinite(amount) ? amount : 0;
  if (value <= rules.expense_limit_amount) return null;
  return {
    kind: "expense",
    amount: roundMoney(value),
    limit_value: rules.expense_limit_amount,
    ruleLabelKey: "approvals.rule.expense",
  };
}

/**
 * A price or cost move needs sign-off when the rule is on — and only when a
 * value actually moves. Saving a product to fix its name must not raise a
 * request, or the rule would train people to route around it.
 */
export function evaluatePriceChangeRule(
  rules: ApprovalRules,
  previous: { selling_price: number; cost_price: number },
  next: { selling_price: number; cost_price: number },
): ApprovalRequirement | null {
  if (!rules.price_change_approval_enabled) return null;
  const priceMoved = round2(next.selling_price) !== round2(previous.selling_price);
  const costMoved = round2(next.cost_price) !== round2(previous.cost_price);
  if (!priceMoved && !costMoved) return null;
  return {
    kind: "price_change",
    amount: roundMoney(next.selling_price),
    // No numeric threshold: the rule is "any move", so the limit is the value it
    // had. Rendering reads `limit_value` as "was".
    limit_value: roundMoney(previous.selling_price),
    ruleLabelKey: "approvals.rule.priceChange",
  };
}

function round2(value: number): number {
  return Math.round((Number.isFinite(value) ? value : 0) * 100) / 100;
}

export interface ApprovalRulesValidation {
  valid: boolean;
  errors: Partial<Record<keyof ApprovalRulesFormValues, string>>;
  data: ApprovalRules | null;
}

/**
 * Validate the rules form.
 *
 * Errors are dictionary keys (the module's own `approvals.error.*`), matching
 * how the expense and customer forms report, so the screen translates them.
 */
export function validateApprovalRulesForm(
  values: ApprovalRulesFormValues,
  current: ApprovalRules,
): ApprovalRulesValidation {
  const errors: Partial<Record<keyof ApprovalRulesFormValues, string>> = {};

  const percent = parseNumber(values.discount_limit_percent);
  if (percent === null) errors.discount_limit_percent = "percentInvalid";
  else if (percent < 0 || percent > 100) errors.discount_limit_percent = "percentRange";

  const refund = parseNumber(values.refund_limit_amount);
  if (refund === null) errors.refund_limit_amount = "amountInvalid";
  else if (refund < 0) errors.refund_limit_amount = "amountNegative";

  const expense = parseNumber(values.expense_limit_amount);
  if (expense === null) errors.expense_limit_amount = "amountInvalid";
  else if (expense < 0) errors.expense_limit_amount = "amountNegative";

  if (Object.keys(errors).length > 0) {
    return { valid: false, errors, data: null };
  }

  return {
    valid: true,
    errors: {},
    data: {
      ...current,
      discount_limit_enabled: values.discount_limit_enabled,
      discount_limit_percent: round2(percent as number),
      refund_limit_enabled: values.refund_limit_enabled,
      refund_limit_amount: roundMoney(refund as number),
      expense_limit_enabled: values.expense_limit_enabled,
      expense_limit_amount: roundMoney(expense as number),
      price_change_approval_enabled: values.price_change_approval_enabled,
    },
  };
}

function parseNumber(raw: string): number | null {
  const trimmed = String(raw ?? "").trim().replace(/,/g, "");
  if (trimmed === "") return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

/** The reason a request must carry, validated where the request is raised. */
export function validateApprovalReason(reason: string): string | null {
  const trimmed = String(reason ?? "").trim();
  if (trimmed.length === 0) return "reasonRequired";
  if (trimmed.length > 500) return "reasonTooLong";
  return null;
}
