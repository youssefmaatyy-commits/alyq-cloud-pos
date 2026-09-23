/**
 * Approval limits module (Phase 12, requirement 2).
 *
 * One inbox, one rules screen, and a set of service calls the other modules use
 * to ask "does this act need a second signature?" before they write anything.
 */
export { ApprovalProvider, useApprovals, useOptionalApprovals } from "./hooks/ApprovalProvider";
export { ApprovalsPage } from "./pages/ApprovalsPage";
export { ApprovalRulesPage } from "./pages/ApprovalRulesPage";
export { ApprovalDecisionModal } from "./components/ApprovalDecisionModal";
export { ApprovalRequestDialog } from "./components/ApprovalRequestDialog";

export * from "./types";
export {
  evaluateDiscountRule,
  evaluateExpenseRule,
  evaluatePriceChangeRule,
  evaluateRefundRule,
  validateApprovalReason,
  validateApprovalRulesForm,
} from "./validation";

export {
  approvalKindLabelKey,
  approvalStatusLabelKey,
  approvalStatusTone,
  approvalValueSummary,
  isPercentKind,
} from "./services/approvalLabels";

export {
  applyApprovedRequest,
  reportApplied,
  type AppliedApproval,
} from "./services/applyApproval";

export {
  assertCanDecideApproval,
  assertCanEditApprovalRules,
  assertRequestApplicable,
  assertWithinApprovalLimit,
  cachedApprovalRules,
  cancelApprovalRequest,
  clearApprovalRulesCache,
  decideApprovalRequest,
  isApprovalRequired,
  loadApprovalRequest,
  loadApprovalRequests,
  loadApprovalRules,
  markRequestApplied,
  maySelfApproveLimits,
  pendingApprovalRequests,
  queryApprovalRequests,
  requirementForDiscount,
  requirementForExpense,
  requirementForPriceChange,
  requirementForRefund,
  saveApprovalRules,
  submitApprovalRequest,
  summarizeApprovalRequests,
  approvalRequiredError,
  type ApprovalRequired,
  type ApprovalSummary,
} from "./services/approvalService";

export {
  getApprovalMode,
  getApprovalRepository,
  getDemoApprovalRepository,
  resetDemoApprovalRepository,
  DemoApprovalRepository,
  SupabaseApprovalRepository,
} from "./data";
export type { ApprovalRepository } from "./data/repository";
