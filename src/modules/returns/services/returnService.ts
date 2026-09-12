import { getReturnMode, getReturnRepository } from "../data";
import type {
  CreateReturnInput,
  RefundDecision,
  RefundRecord,
  ReturnFiltersValue,
  SalesReturn,
  SettleRefundResult,
} from "../types";
import { normalizeText } from "@/modules/products/services/productQuery";
import { assertSensitiveAction } from "@/lib/permissions/actions";
import { getCurrentUser } from "@/modules/inventory/permissions";
import { recordAudit } from "@/modules/audit";
import { AppError } from "@/modules/products/data/repository";

/**
 * Returns & refunds — the service funnel (Phase 7; enforced in Phase 13).
 *
 * Every write goes through here rather than straight to a repository, because
 * this is where the capability check and the audit entry live. Hiding a button
 * is a courtesy; refusing the call is the control (requirement 1 of Phase 11).
 *
 * The refund lifecycle (requirement 3 of Phase 13) is deliberately *not* a
 * second system: it is the existing `refund_records` row moving
 * pending → completed / rejected, which is what migration 0016 already
 * enforces in the database through `pos_settle_refund`. Demo mode enforces the
 * same invariants locally so the two modes cannot drift.
 */

// ── guards ────────────────────────────────────────────────────────────────
/** Recording a return: restores stock and opens a refund. */
export function assertCanCreateReturn(): void {
  assertSensitiveAction("return.create");
}

/** Manager-level sign-off on the goods side of a return. */
export function assertCanApproveReturn(): void {
  assertSensitiveAction("return.approve");
}

/** Refusing a return. Same capability as approving it. */
export function assertCanRejectReturn(): void {
  assertSensitiveAction("return.reject");
}

/** Completing a pending refund — the money really left the drawer. */
export function assertCanSettleRefund(): void {
  assertSensitiveAction("refund.settle");
}

/** Refusing a pending refund. Same capability, opposite direction. */
export function assertCanRejectRefund(): void {
  assertSensitiveAction("return.reject");
}

/** Writing the refund record that accompanies a return. */
export function assertCanRecordRefund(): void {
  assertSensitiveAction("refund.record");
}

// ── reads ─────────────────────────────────────────────────────────────────
export async function loadReturns(): Promise<SalesReturn[]> {
  return getReturnRepository().listReturns();
}

export async function loadRefunds(): Promise<RefundRecord[]> {
  return getReturnRepository().listRefunds();
}

export async function loadReturn(id: string): Promise<SalesReturn> {
  return getReturnRepository().getReturn(id);
}

export async function loadRefundsForSale(saleId: string): Promise<RefundRecord[]> {
  return getReturnRepository().getRefundsForSale(saleId);
}

/** Refunds still waiting for someone with `approve_refund` to decide. */
export function pendingRefunds(refundsList: RefundRecord[]): RefundRecord[] {
  return refundsList.filter((ref) => ref.status === "pending");
}

// ── writes ────────────────────────────────────────────────────────────────
/**
 * Process a sales return: stock goes back on the shelf and a refund row opens.
 *
 * A return settled on the spot (`refund_status: "completed"`, the till
 * default) also needs `process_refund` — handing cash back is a second
 * capability from counting goods back in.
 */
export async function processReturn(
  input: CreateReturnInput,
): Promise<{ returnRecord: SalesReturn; refundRecord: RefundRecord }> {
  assertCanCreateReturn();
  const status = input.refund_status ?? "completed";
  if (status === "completed") assertCanRecordRefund();

  const result = await getReturnRepository().createReturn(input);

  // No database function writes these two, so the app writes them in both
  // modes. Fire-and-forget: a failed audit row must not roll back a return the
  // shop has already handed over the counter.
  void recordAudit({
    action: "return.created",
    entity: "return",
    entity_id: result.returnRecord.id,
    entity_label: result.returnRecord.return_number,
    details: {
      sale: result.returnRecord.sale_number,
      amount: result.returnRecord.refund_amount,
      method: result.returnRecord.refund_method,
      items: result.returnRecord.items.length,
      refund: result.refundRecord.refund_number,
      refund_status: status,
    },
  });
  void recordAudit({
    action: "refund.created",
    entity: "refund",
    entity_id: result.refundRecord.id,
    entity_label: result.refundRecord.refund_number,
    details: {
      amount: result.refundRecord.amount,
      method: result.refundRecord.payment_method,
      sale: result.refundRecord.sale_number,
      status,
      reason: result.refundRecord.reason,
    },
  });

  return result;
}

/**
 * Complete or reject a pending refund (requirement 3).
 *
 * The invariants belong to the data layer — pending only, decided once, a
 * rejection needs a reason, the money is never rewritten — so live mode
 * delegates to `pos_settle_refund` and demo mode mirrors it. What lives here is
 * the capability gate and, in demo mode, the audit row (live mode gets it from
 * the settlement function itself; writing it twice would double the trail).
 */
export async function settleRefund(
  refundId: string,
  decision: RefundDecision,
  reason: string | null,
): Promise<SettleRefundResult> {
  if (decision === "rejected") {
    assertCanRejectRefund();
    const trimmed = reason?.trim() ?? "";
    if (trimmed.length === 0) {
      // Same refusal the database makes — raised here so demo mode agrees and
      // so the caller gets the message before a round trip.
      throw new AppError("VALIDATION", "A rejected refund needs a reason");
    }
  } else {
    assertCanSettleRefund();
  }

  const user = getCurrentUser();
  const outcome = await getReturnRepository().settleRefund(refundId, {
    decision,
    reason: reason?.trim() || null,
    user_id: user.id,
    user_name: user.name,
  });

  if (getReturnMode() === "demo") {
    void recordAudit({
      action: decision === "rejected" ? "refund.rejected" : "refund.settled",
      entity: "refund",
      entity_id: outcome.refund.id,
      entity_label: outcome.refund.refund_number,
      details: {
        amount: outcome.refund.amount,
        method: outcome.refund.payment_method,
        sale: outcome.refund.sale_number,
        decision,
        reason: outcome.refund.rejection_reason,
      },
    });
  }

  return outcome;
}

// ── filtering ─────────────────────────────────────────────────────────────
export function queryReturns(
  returnsList: SalesReturn[],
  filters: ReturnFiltersValue,
): SalesReturn[] {
  const needle = normalizeText(filters.search);
  const terms = needle ? needle.split(" ") : [];

  return returnsList.filter((ret) => {
    if (terms.length > 0) {
      const haystack = normalizeText(
        `${ret.return_number} ${ret.sale_number} ${ret.customer_name ?? ""} ${ret.reason} ${ret.user_name}`,
      );
      for (const term of terms) {
        if (!haystack.includes(term)) return false;
      }
    }
    return true;
  });
}

export function queryRefunds(
  refundsList: RefundRecord[],
  filters: ReturnFiltersValue,
): RefundRecord[] {
  const needle = normalizeText(filters.search);
  const terms = needle ? needle.split(" ") : [];

  return refundsList.filter((ref) => {
    if (terms.length > 0) {
      const haystack = normalizeText(
        `${ref.refund_number} ${ref.sale_number} ${ref.payment_method} ${ref.reason ?? ""} ${ref.user_name}`,
      );
      for (const term of terms) {
        if (!haystack.includes(term)) return false;
      }
    }
    return true;
  });
}
