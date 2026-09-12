import { assertSensitiveAction } from "@/lib/permissions/actions";
import { canAct } from "@/lib/permissions/enforce";
import { AppError } from "@/modules/products/data/repository";
import { getCurrentUser } from "@/modules/inventory/permissions";
import { recordAudit } from "@/modules/audit";
import { getApprovalMode, getApprovalRepository } from "../data";
import type {
  ApprovalDecision,
  ApprovalFiltersValue,
  ApprovalKind,
  ApprovalRequest,
  ApprovalRequirement,
  ApprovalRules,
  ApprovalRulesFormValues,
  ApprovalStatus,
  ApprovalValue,
  NewApprovalRequest,
} from "../types";
import { DEFAULT_APPROVAL_RULES } from "../types";
import {
  evaluateDiscountRule,
  evaluateExpenseRule,
  evaluatePriceChangeRule,
  evaluateRefundRule,
  validateApprovalReason,
  validateApprovalRulesForm,
} from "../validation";
import { normalizeText } from "@/modules/products/services/productQuery";

/**
 * Approval limits — the service funnel (Phase 12, requirement 2).
 *
 * Three responsibilities, in the order a request lives:
 *
 *   1. **Answer "does this need sign-off?"** — `requirementFor*()` reads the
 *      rules and applies the pure evaluators. A domain service calls this
 *      *before* it writes anything, so an over-limit act becomes a request
 *      instead of a record.
 *   2. **Carry the request** — `submitApprovalRequest()` records the ask with the
 *      value before, the value wanted, the threshold crossed and the reason.
 *   3. **Let the deferred act happen once** — `assertRequestApplicable()` proves
 *      a request is approved, is the right kind, and has not already produced a
 *      record; `markRequestApplied()` writes down what it produced. The domain
 *      service does the act itself, so there is one implementation of "create an
 *      expense" and the approval cannot drift from it.
 *
 * Somebody holding `approve_limit_request` is never routed through their own
 * inbox: the limits bind the seats below the authority, which is the only
 * reading that does not make a manager file paperwork to do their job.
 */

// ── guards ────────────────────────────────────────────────────────────────
/** Deciding a request — approving, rejecting or withdrawing one. */
export function assertCanDecideApproval(): void {
  assertSensitiveAction("approval.decide");
}

/** Editing the thresholds themselves. */
export function assertCanEditApprovalRules(): void {
  assertSensitiveAction("approval.rules");
}

/** May the acting user settle an over-limit act without asking anybody? */
export function maySelfApproveLimits(): boolean {
  return canAct("approve_limit_request");
}

// ── rules ─────────────────────────────────────────────────────────────────
let rulesCache: ApprovalRules | null = null;

/** Read the thresholds, refreshing the cache the funnels consult. */
export async function loadApprovalRules(): Promise<ApprovalRules> {
  const rules = await getApprovalRepository().getRules();
  rulesCache = { ...DEFAULT_APPROVAL_RULES, ...rules };
  return rulesCache;
}

/**
 * The thresholds as last read.
 *
 * A till cannot await a round trip on every keystroke, so the POS and the
 * expense form consult this and the provider refreshes it on load. Before the
 * first read it answers with the defaults *disabled* — a rule that has not been
 * fetched must not silently block a sale, and the authoritative check still
 * happens when the request is submitted.
 */
export function cachedApprovalRules(): ApprovalRules {
  return rulesCache ?? { ...DEFAULT_APPROVAL_RULES };
}

export function clearApprovalRulesCache(): void {
  rulesCache = null;
}

/** Validate + persist the thresholds. `manage_settings` work. */
export async function saveApprovalRules(
  values: ApprovalRulesFormValues,
): Promise<ApprovalRules> {
  assertCanEditApprovalRules();
  const current = cachedApprovalRules();
  const { errors, data } = validateApprovalRulesForm(values, current);
  if (!data) {
    const firstField = Object.keys(errors)[0] ?? "discount_limit_percent";
    const err = new AppError("VALIDATION", `Invalid approval rules (${firstField})`, firstField);
    (err as AppError & { fieldErrors?: unknown }).fieldErrors = errors;
    throw err;
  }

  const saved = await getApprovalRepository().saveRules(data);
  rulesCache = saved;

  // Live mode: `set_approval_rules()` writes the audit row, with the before and
  // after. Demo mode has no such function, so the service writes the same row.
  if (getApprovalMode() === "demo") {
    void recordAudit({
      action: "approval_rules.updated",
      entity: "approval_rules",
      entity_id: "1",
      entity_label: "Approval rules",
      details: {
        discount_limit_percent: saved.discount_limit_percent,
        discount_limit_enabled: saved.discount_limit_enabled,
        refund_limit_amount: saved.refund_limit_amount,
        refund_limit_enabled: saved.refund_limit_enabled,
        expense_limit_amount: saved.expense_limit_amount,
        expense_limit_enabled: saved.expense_limit_enabled,
        price_change_approval_enabled: saved.price_change_approval_enabled,
        previous_discount_limit_percent: current.discount_limit_percent,
        previous_refund_limit_amount: current.refund_limit_amount,
        previous_expense_limit_amount: current.expense_limit_amount,
      },
    });
  }
  return saved;
}

// ── does this act need sign-off? ──────────────────────────────────────────
/** An expense over the cap. */
export async function requirementForExpense(amount: number): Promise<ApprovalRequirement | null> {
  return evaluateExpenseRule(await rules(), amount);
}

/** A refund over the cap. */
export async function requirementForRefund(amount: number): Promise<ApprovalRequirement | null> {
  return evaluateRefundRule(await rules(), amount);
}

/** A discount over the cap. `percent` is 0–100. */
export async function requirementForDiscount(percent: number): Promise<ApprovalRequirement | null> {
  return evaluateDiscountRule(await rules(), percent);
}

/** A price or cost move, when the shop requires sign-off for those. */
export async function requirementForPriceChange(
  previous: { selling_price: number; cost_price: number },
  next: { selling_price: number; cost_price: number },
): Promise<ApprovalRequirement | null> {
  return evaluatePriceChangeRule(await rules(), previous, next);
}

async function rules(): Promise<ApprovalRules> {
  if (rulesCache) return rulesCache;
  try {
    return await loadApprovalRules();
  } catch {
    // No rules reachable → nothing to enforce. The capability gates still apply;
    // a limit that cannot be read must not turn into a permanent blockade.
    return { ...DEFAULT_APPROVAL_RULES };
  }
}

// ── the refusal a domain service throws ───────────────────────────────────
/** The marker an over-limit act carries, so a screen can offer to file it. */
export interface ApprovalRequired {
  approvalRequired: ApprovalRequirement;
}

/**
 * Refuse the act and say which rule fired.
 *
 * It is an `AppError("VALIDATION")` with `approvalRequired` attached — the same
 * pattern the returns module uses for field errors — so a caller that does not
 * know about approvals still shows a sensible message rather than crashing.
 */
export function approvalRequiredError(requirement: ApprovalRequirement): AppError & ApprovalRequired {
  const err = new AppError(
    "VALIDATION",
    `This needs approval: ${requirement.ruleLabelKey}`,
    "amount",
  ) as AppError & ApprovalRequired;
  err.approvalRequired = requirement;
  return err;
}

export function isApprovalRequired(err: unknown): err is AppError & ApprovalRequired {
  return (
    err instanceof AppError &&
    typeof (err as AppError & Partial<ApprovalRequired>).approvalRequired === "object" &&
    (err as AppError & ApprovalRequired).approvalRequired !== null
  );
}

/**
 * The gate every over-limit path runs through.
 *
 * Returns `null` when the act may proceed — the rule did not fire, or the acting
 * user holds the authority the rule protects — and otherwise throws the refusal
 * above.
 */
export function assertWithinApprovalLimit(requirement: ApprovalRequirement | null): void {
  if (!requirement) return;
  if (maySelfApproveLimits()) return;
  throw approvalRequiredError(requirement);
}

// ── requests ──────────────────────────────────────────────────────────────
export async function loadApprovalRequests(): Promise<ApprovalRequest[]> {
  return getApprovalRepository().listRequests();
}

export async function loadApprovalRequest(id: string): Promise<ApprovalRequest> {
  return getApprovalRepository().getRequest(id);
}

/** File an over-limit act as a request. Open to every signed-in user. */
export async function submitApprovalRequest(
  requirement: ApprovalRequirement,
  context: {
    entityType: string;
    entityLabel?: string;
    entityId?: string;
    branch?: string | null;
    reason: string;
    previousValue?: ApprovalValue;
    newValue?: ApprovalValue;
    payload?: Record<string, unknown>;
  },
): Promise<ApprovalRequest> {
  const reasonError = validateApprovalReason(context.reason);
  if (reasonError) {
    throw new AppError("VALIDATION", `Invalid reason (${reasonError})`, "reason");
  }

  const input: NewApprovalRequest = {
    kind: requirement.kind,
    entity_type: context.entityType,
    entity_id: context.entityId ?? "",
    entity_label: context.entityLabel,
    branch: context.branch ?? null,
    amount: requirement.amount,
    limit_value: requirement.limit_value,
    previous_value: context.previousValue ?? {},
    new_value: context.newValue ?? {},
    payload: context.payload ?? {},
    reason: context.reason.trim(),
  };

  const request = await getApprovalRepository().createRequest(input);

  if (getApprovalMode() === "demo") {
    void recordAudit({
      action: "approval.requested",
      entity: "approval_request",
      entity_id: request.id,
      entity_label: request.request_number,
      details: {
        kind: request.kind,
        amount: request.amount,
        limit: request.limit_value,
        entity: request.entity_label,
        reason: request.reason,
      },
    });
  }
  return request;
}

/** Approve, reject or withdraw a pending request. */
export async function decideApprovalRequest(
  id: string,
  decision: ApprovalDecision,
  note: string | null,
): Promise<{ request: ApprovalRequest; alreadyDecided: boolean }> {
  assertCanDecideApproval();
  if (decision === "rejected" && !(note ?? "").trim()) {
    throw new AppError("VALIDATION", "A rejected request needs a note saying why", "decision_note");
  }

  const outcome = await getApprovalRepository().decideRequest(id, decision, note);

  if (getApprovalMode() === "demo" && !outcome.alreadyDecided) {
    void recordAudit({
      action:
        decision === "approved"
          ? "approval.approved"
          : decision === "rejected"
            ? "approval.rejected"
            : "approval.cancelled",
      entity: "approval_request",
      entity_id: outcome.request.id,
      entity_label: outcome.request.request_number,
      details: {
        kind: outcome.request.kind,
        amount: outcome.request.amount,
        entity: outcome.request.entity_label,
        reason: outcome.request.reason,
        note: outcome.request.decision_note,
        requested_by: outcome.request.requested_by_name,
      },
    });
  }
  return outcome;
}

/** The requester withdrawing their own pending ask. */
export async function cancelApprovalRequest(id: string): Promise<ApprovalRequest> {
  const request = await getApprovalRepository().getRequest(id);
  if (request.status !== "pending") {
    throw new AppError("VALIDATION", `This request was already ${request.status}`);
  }
  // Withdrawing is not a decision, so it needs no approval capability — but it
  // does need to be yours, unless you hold the authority anyway.
  const acting = getCurrentUser();
  if (acting.id !== request.requested_by && !maySelfApproveLimits()) {
    throw new AppError("FORBIDDEN", "Only the requester may withdraw a request");
  }
  const outcome = await decideApprovalRequest(id, "cancelled", null);
  return outcome.request;
}

/**
 * Prove a request may now be executed, and hand back its payload.
 *
 * Called by the domain service that is about to perform the deferred act —
 * `createExpense(input, { requestId })`, `settleRefund(...)`, `saveProduct(...)`,
 * `completeSale(...)` — so an "approved" flag in a request body cannot invent
 * authority: the request has to exist, be approved, be the right kind, and not
 * have produced a record already.
 */
export async function assertRequestApplicable(
  requestId: string,
  kind: ApprovalKind,
): Promise<ApprovalRequest> {
  const request = await getApprovalRepository().getRequest(requestId);
  if (request.status !== "approved") {
    throw new AppError(
      "VALIDATION",
      `Only an approved request can be applied (this one is ${request.status})`,
    );
  }
  if (request.kind !== kind) {
    throw new AppError("VALIDATION", `This request is for a ${request.kind}, not a ${kind}`);
  }
  if (request.result_entity_id) {
    throw new AppError("VALIDATION", "This request has already been applied");
  }
  return request;
}

/** Write down what an approved request produced. Once. */
export async function markRequestApplied(requestId: string, entityId: string): Promise<void> {
  const applied = await getApprovalRepository().markApplied(requestId, entityId);
  if (getApprovalMode() === "demo") {
    void recordAudit({
      action: "approval.applied",
      entity: "approval_request",
      entity_id: applied.id,
      entity_label: applied.request_number,
      details: {
        kind: applied.kind,
        amount: applied.amount,
        result: entityId,
        decided_by: applied.decided_by_name,
      },
    });
  }
}

/**
 * Perform the deferred act, then record what it produced.
 *
 * `execute` is the domain service's own write, already capability-checked: the
 * approval adds authority to *exceed a limit*, never to do something the actor
 * could not otherwise do.
 */
export async function applyApprovedRequest<T>(
  request: ApprovalRequest,
  execute: () => Promise<{ id: string; value: T }>,
): Promise<T> {
  const { id, value } = await execute();
  await markRequestApplied(request.id, id);
  return value;
}

// ── reading the inbox ─────────────────────────────────────────────────────
export function queryApprovalRequests(
  requests: ApprovalRequest[],
  filters: ApprovalFiltersValue,
): ApprovalRequest[] {
  const needle = normalizeText(filters.search);
  const terms = needle ? needle.split(" ") : [];

  return requests.filter((request) => {
    if (filters.status !== "all" && request.status !== filters.status) return false;
    if (filters.kind !== "all" && request.kind !== filters.kind) return false;
    if (terms.length > 0) {
      const haystack = normalizeText(
        `${request.request_number} ${request.entity_label} ${request.reason} ${request.requested_by_name} ${request.decision_note ?? ""}`,
      );
      for (const term of terms) {
        if (!haystack.includes(term)) return false;
      }
    }
    return true;
  });
}

export interface ApprovalSummary {
  total: number;
  pending: number;
  approved: number;
  rejected: number;
  cancelled: number;
  pendingAmount: number;
  byKind: { kind: ApprovalKind; pending: number; total: number }[];
  byStatus: { status: ApprovalStatus; count: number }[];
}

/** The numbers the inbox tiles and the dashboard KPI both read. */
export function summarizeApprovalRequests(requests: ApprovalRequest[]): ApprovalSummary {
  const kinds: ApprovalKind[] = ["discount", "refund", "expense", "price_change"];
  const statuses: ApprovalStatus[] = ["pending", "approved", "rejected", "cancelled"];
  const count = (status: ApprovalStatus) => requests.filter((r) => r.status === status).length;

  return {
    total: requests.length,
    pending: count("pending"),
    approved: count("approved"),
    rejected: count("rejected"),
    cancelled: count("cancelled"),
    pendingAmount: requests
      .filter((r) => r.status === "pending" && r.kind !== "discount")
      .reduce((sum, r) => sum + r.amount, 0),
    byKind: kinds.map((kind) => ({
      kind,
      pending: requests.filter((r) => r.kind === kind && r.status === "pending").length,
      total: requests.filter((r) => r.kind === kind).length,
    })),
    byStatus: statuses.map((status) => ({ status, count: count(status) })),
  };
}

/** Requests still waiting on a decision — the dashboard's pending-approvals KPI. */
export function pendingApprovalRequests(requests: ApprovalRequest[]): ApprovalRequest[] {
  return requests.filter((r) => r.status === "pending");
}
