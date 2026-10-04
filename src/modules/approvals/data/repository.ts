import type {
  ApprovalDecision,
  ApprovalRequest,
  ApprovalRules,
  NewApprovalRequest,
} from "../types";

/**
 * Persistence contract for the approval-limits module.
 *
 * The shape follows the other modules exactly (`kind`, one method per act) so a
 * screen cannot tell demo mode from live mode — and so the invariants can be
 * written twice, once here in TypeScript and once in migration 0023, with the
 * self-test holding the two together.
 */
export interface ApprovalRepository {
  readonly kind: "supabase" | "demo";

  /** The threshold document. Always resolves: missing means the defaults. */
  getRules(): Promise<ApprovalRules>;
  /** Replace the thresholds. `manage_settings` work, asserted by the service. */
  saveRules(rules: ApprovalRules): Promise<ApprovalRules>;

  listRequests(): Promise<ApprovalRequest[]>;
  getRequest(id: string): Promise<ApprovalRequest>;
  /** Raising a request is open to every signed-in user: being refused is the point. */
  createRequest(input: NewApprovalRequest): Promise<ApprovalRequest>;
  /** Decide once. A rejection needs a note; the money columns never move. */
  decideRequest(
    id: string,
    decision: ApprovalDecision,
    note: string | null,
  ): Promise<{ request: ApprovalRequest; alreadyDecided: boolean }>;
  /** Withdraw a pending request. Only its own requester (or an approver). */
  cancelRequest(id: string): Promise<ApprovalRequest>;
  /** Verify one same-branch manager PIN for one exact pending request. Live only. */
  approveWithManagerPin(id: string, username: string, pin: string): Promise<ApprovalRequest>;
  /**
   * Record what an approved request produced, once. This is what stops the same
   * decision being executed twice.
   */
  markApplied(id: string, entityId: string): Promise<ApprovalRequest>;
}
