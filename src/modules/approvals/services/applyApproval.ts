import { AppError } from "@/modules/products/data/repository";
import { recordAudit } from "@/modules/audit";
import { createExpense } from "@/modules/expenses/services/expenseService";
import { completeSale } from "@/modules/pos/services/saleService";
import { loadCatalog, saveProduct } from "@/modules/products/services/catalogService";
import { settleRefund } from "@/modules/returns/services/returnService";
import type { NewExpense } from "@/modules/expenses/types";
import type { CompleteSaleInput } from "@/modules/pos/types";
import type { ApprovalRequest } from "../types";
import { markRequestApplied } from "./approvalService";

/**
 * Executing an approved request (Phase 12, requirement 2).
 *
 * The decision is recorded by the database (or by the demo repository); the
 * *act* is performed here, by calling the same service funnel the act would have
 * gone through in the first place, with the approved request id attached. That
 * matters more than it looks:
 *
 *   * the funnel re-asserts the capability for the act itself, so an approval
 *     adds authority to exceed a limit and nothing else — approving an expense
 *     request cannot let somebody who lacks `add_expense` file one;
 *   * the funnel calls `assertRequestApplicable`, which re-reads the request and
 *     refuses one that is not approved, is the wrong kind, or has already
 *     produced a record — so clicking twice, or replaying a payload, cannot
 *     create two expenses;
 *   * there is exactly one implementation of "create an expense", "complete a
 *     sale", "settle a refund" and "change a price". Nothing here duplicates
 *     their validation, numbering, stock effects or audit entries.
 *
 * This file lives beside the approvals service rather than inside it to keep the
 * import graph acyclic: the domain services import `approvalService` (for the
 * limit checks), and this module imports the domain services.
 */

/** What the deferred act produced, for the screen to link to afterwards. */
export interface AppliedApproval {
  request: ApprovalRequest;
  entityId: string;
  entityLabel: string;
  /** Where the app can show the result. */
  route: string | null;
}

/**
 * Perform the act an approved request stands for.
 *
 * Throws `AppError("VALIDATION")` when the payload is not shaped the way the
 * funnel needs — a request whose payload was written by an older build, say —
 * rather than performing something approximate with money.
 */
export async function applyApprovedRequest(request: ApprovalRequest): Promise<AppliedApproval> {
  if (request.status !== "approved") {
    throw new AppError(
      "VALIDATION",
      `Only an approved request can be applied (this one is ${request.status})`,
    );
  }
  if (request.result_entity_id) {
    throw new AppError("VALIDATION", "This request has already been applied");
  }

  switch (request.kind) {
    case "expense":
      return applyExpense(request);
    case "refund":
      return applyRefund(request);
    case "discount":
      return applyDiscount(request);
    case "price_change":
      return applyPriceChange(request);
    default:
      throw new AppError("VALIDATION", `Unknown approval request kind '${String(request.kind)}'`);
  }
}

function payloadOf(request: ApprovalRequest): Record<string, unknown> {
  return request.payload && typeof request.payload === "object" ? request.payload : {};
}

async function applyExpense(request: ApprovalRequest): Promise<AppliedApproval> {
  const payload = payloadOf(request) as unknown as NewExpense;
  if (!payload || typeof payload !== "object" || !payload.name || typeof payload.amount !== "number") {
    throw new AppError("VALIDATION", "This request no longer carries a usable expense draft");
  }

  const expense = await createExpense(payload, { requestId: request.id });

  // The provider writes this row when an expense is filed normally; an expense
  // created by an approval never passes through the provider, so the trail is
  // written here. Same action, same entity, same details — one vocabulary.
  void recordAudit({
    action: "expense.created",
    entity: "expense",
    entity_id: expense.id,
    entity_label: expense.expense_number,
    details: {
      name: expense.name,
      category: expense.category,
      amount: expense.amount,
      method: expense.payment_method,
      approval: request.request_number,
      requested_by: request.requested_by_name,
      approved_by: request.decided_by_name,
    },
  });

  return {
    request,
    entityId: expense.id,
    entityLabel: expense.expense_number,
    route: "/expenses",
  };
}

async function applyRefund(request: ApprovalRequest): Promise<AppliedApproval> {
  const payload = payloadOf(request);
  const refundId = typeof payload.refund_id === "string" ? payload.refund_id : "";
  if (!refundId) {
    throw new AppError("VALIDATION", "This request no longer points at a refund");
  }

  const outcome = await settleRefund(refundId, "completed", null, { requestId: request.id });
  return {
    request,
    entityId: outcome.refund.id,
    entityLabel: outcome.refund.refund_number,
    route: `/refunds/${outcome.refund.id}`,
  };
}

async function applyDiscount(request: ApprovalRequest): Promise<AppliedApproval> {
  const payload = payloadOf(request) as unknown as CompleteSaleInput;
  if (!payload || !Array.isArray(payload.lines) || !Array.isArray(payload.payments)) {
    throw new AppError("VALIDATION", "This request no longer carries a usable sale draft");
  }

  const sale = await completeSale(payload, { requestId: request.id });
  return {
    request,
    entityId: sale.id,
    entityLabel: sale.sale_number,
    route: `/pos/sales/${sale.id}`,
  };
}

async function applyPriceChange(request: ApprovalRequest): Promise<AppliedApproval> {
  const payload = payloadOf(request);
  const productId = typeof payload.product_id === "string" ? payload.product_id : "";
  const values = payload.values as never;
  if (!productId || !values) {
    throw new AppError("VALIDATION", "This request no longer carries a usable product draft");
  }

  // The catalogue is read fresh: validating a price change against a stale list
  // is how a duplicate SKU slips through.
  const { products, categories } = await loadCatalog();
  const { product } = await saveProduct({
    values,
    products,
    categories,
    currentId: productId,
    approval: { requestId: request.id },
  });
  return {
    request,
    entityId: product.id,
    entityLabel: product.sku,
    route: `/products/${product.id}`,
  };
}

/**
 * Record the result of an act performed elsewhere.
 *
 * Most callers go through `applyApprovedRequest`, which reports for them; this is
 * the escape hatch for a flow that already holds the created record.
 */
export async function reportApplied(requestId: string, entityId: string): Promise<void> {
  await markRequestApplied(requestId, entityId);
}
