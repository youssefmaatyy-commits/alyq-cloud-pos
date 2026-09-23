import { getSupabaseClient } from "@/lib/supabase/client";
import { AppError, toAppError } from "@/modules/products/data/repository";
import type {
  ApprovalDecision,
  ApprovalKind,
  ApprovalRequest,
  ApprovalRules,
  ApprovalStatus,
  ApprovalValue,
  NewApprovalRequest,
} from "../types";
import { DEFAULT_APPROVAL_RULES } from "../types";
import type { ApprovalRepository } from "./repository";

interface ApprovalRequestRow {
  id: string;
  request_number: string;
  kind: ApprovalKind;
  entity_type: string;
  entity_id: string;
  entity_label: string;
  branch: string | null;
  amount: number | string;
  limit_value: number | string | null;
  previous_value: unknown;
  new_value: unknown;
  payload: unknown;
  reason: string;
  status: ApprovalStatus;
  requested_by: string;
  requested_by_name: string;
  requested_at: string;
  decided_by: string | null;
  decided_by_name: string | null;
  decided_at: string | null;
  decision_note: string | null;
  result_entity_id: string | null;
  created_at: string;
}

function toNumber(value: number | string | null | undefined): number {
  if (typeof value === "number") return value;
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function toValueObject(raw: unknown): ApprovalValue {
  if (!raw || typeof raw !== "object") return {};
  const out: ApprovalValue = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value === null || ["string", "number", "boolean"].includes(typeof value)) {
      out[key] = value as string | number | boolean | null;
    }
  }
  return out;
}

function mapRequest(row: ApprovalRequestRow): ApprovalRequest {
  return {
    id: row.id,
    request_number: row.request_number,
    kind: row.kind,
    entity_type: row.entity_type,
    entity_id: row.entity_id ?? "",
    entity_label: row.entity_label,
    branch: row.branch ?? null,
    amount: toNumber(row.amount),
    limit_value: row.limit_value === null ? null : toNumber(row.limit_value),
    previous_value: toValueObject(row.previous_value),
    new_value: toValueObject(row.new_value),
    payload: (row.payload ?? {}) as Record<string, unknown>,
    reason: row.reason,
    status: row.status,
    requested_by: row.requested_by,
    requested_by_name: row.requested_by_name,
    requested_at: row.requested_at,
    decided_by: row.decided_by ?? null,
    decided_by_name: row.decided_by_name ?? null,
    decided_at: row.decided_at ?? null,
    decision_note: row.decision_note ?? null,
    result_entity_id: row.result_entity_id ?? null,
    created_at: row.created_at,
  };
}

function mapRules(raw: unknown): ApprovalRules {
  const value = (raw ?? {}) as Record<string, unknown>;
  const num = (key: string, fallback: number) => {
    const parsed = Number(value[key]);
    return Number.isFinite(parsed) ? parsed : fallback;
  };
  const bool = (key: string, fallback: boolean) =>
    typeof value[key] === "boolean" ? (value[key] as boolean) : fallback;

  return {
    discount_limit_enabled: bool("discount_limit_enabled", DEFAULT_APPROVAL_RULES.discount_limit_enabled),
    discount_limit_percent: num("discount_limit_percent", DEFAULT_APPROVAL_RULES.discount_limit_percent),
    refund_limit_enabled: bool("refund_limit_enabled", DEFAULT_APPROVAL_RULES.refund_limit_enabled),
    refund_limit_amount: num("refund_limit_amount", DEFAULT_APPROVAL_RULES.refund_limit_amount),
    expense_limit_enabled: bool("expense_limit_enabled", DEFAULT_APPROVAL_RULES.expense_limit_enabled),
    expense_limit_amount: num("expense_limit_amount", DEFAULT_APPROVAL_RULES.expense_limit_amount),
    price_change_approval_enabled: bool(
      "price_change_approval_enabled",
      DEFAULT_APPROVAL_RULES.price_change_approval_enabled,
    ),
    updated_by_name: typeof value.updated_by_name === "string" ? value.updated_by_name : null,
    updated_at: typeof value.updated_at === "string" ? value.updated_at : null,
  };
}

/**
 * Live-mode approvals (Phase 12).
 *
 * Every write is an RPC from migration 0023, because the tables have no direct
 * write path: `approval_requests` is evidence, and the only thing that may
 * change it is a capability-checked, audit-writing function. Reads are plain
 * selects under RLS, which shows an approver everything and a requester their
 * own.
 */
export class SupabaseApprovalRepository implements ApprovalRepository {
  readonly kind = "supabase" as const;

  private require() {
    const client = getSupabaseClient();
    if (!client) throw new AppError("NOT_CONFIGURED");
    return client;
  }

  async getRules(): Promise<ApprovalRules> {
    try {
      const { data, error } = await this.require().rpc("get_approval_rules");
      if (error) throw toAppError(error);
      return mapRules(data);
    } catch (err) {
      if (err instanceof AppError) throw err;
      throw toAppError(err);
    }
  }

  async saveRules(rules: ApprovalRules): Promise<ApprovalRules> {
    try {
      const { data, error } = await this.require().rpc("set_approval_rules", {
        p_rules: {
          discount_limit_enabled: rules.discount_limit_enabled,
          discount_limit_percent: rules.discount_limit_percent,
          refund_limit_enabled: rules.refund_limit_enabled,
          refund_limit_amount: rules.refund_limit_amount,
          expense_limit_enabled: rules.expense_limit_enabled,
          expense_limit_amount: rules.expense_limit_amount,
          price_change_approval_enabled: rules.price_change_approval_enabled,
        },
      });
      if (error) throw toAppError(error);
      return mapRules(data);
    } catch (err) {
      if (err instanceof AppError) throw err;
      throw toAppError(err);
    }
  }

  async listRequests(): Promise<ApprovalRequest[]> {
    try {
      const { data, error } = await this.require()
        .from("approval_requests")
        .select("*")
        .order("requested_at", { ascending: false });
      if (error) throw toAppError(error);
      return ((data as ApprovalRequestRow[]) ?? []).map(mapRequest);
    } catch (err) {
      if (err instanceof AppError) throw err;
      throw toAppError(err);
    }
  }

  async getRequest(id: string): Promise<ApprovalRequest> {
    try {
      const { data, error } = await this.require()
        .from("approval_requests")
        .select("*")
        .eq("id", id)
        .maybeSingle();
      if (error) throw toAppError(error);
      if (!data) throw new AppError("NOT_FOUND", `Approval request ${id} not found`);
      return mapRequest(data as ApprovalRequestRow);
    } catch (err) {
      if (err instanceof AppError) throw err;
      throw toAppError(err);
    }
  }

  async createRequest(input: NewApprovalRequest): Promise<ApprovalRequest> {
    try {
      const { data, error } = await this.require().rpc("submit_approval_request", {
        p_request: {
          kind: input.kind,
          entity_type: input.entity_type,
          entity_id: input.entity_id ?? "",
          entity_label: input.entity_label ?? "",
          branch: input.branch ?? null,
          amount: input.amount,
          limit_value: input.limit_value ?? null,
          previous_value: input.previous_value ?? {},
          new_value: input.new_value ?? {},
          payload: input.payload ?? {},
          reason: input.reason.trim(),
        },
      });
      if (error) throw toAppError(error);
      const created = (data ?? {}) as { request_id?: string };
      if (!created.request_id) throw new AppError("DB", "The approval request was not created");
      return this.getRequest(created.request_id);
    } catch (err) {
      if (err instanceof AppError) throw err;
      throw toAppError(err);
    }
  }

  async decideRequest(
    id: string,
    decision: ApprovalDecision,
    note: string | null,
  ): Promise<{ request: ApprovalRequest; alreadyDecided: boolean }> {
    try {
      const { data, error } = await this.require().rpc("decide_approval_request", {
        p_request_id: id,
        p_decision: decision,
        p_note: note?.trim() || null,
      });
      if (error) throw toAppError(error);
      const decided = (data ?? {}) as { already_decided?: boolean };
      return { request: await this.getRequest(id), alreadyDecided: decided.already_decided === true };
    } catch (err) {
      if (err instanceof AppError) throw err;
      throw toAppError(err);
    }
  }

  async cancelRequest(id: string): Promise<ApprovalRequest> {
    return (await this.decideRequest(id, "cancelled", null)).request;
  }

  async markApplied(id: string, entityId: string): Promise<ApprovalRequest> {
    try {
      const { error } = await this.require().rpc("mark_approval_applied", {
        p_request_id: id,
        p_entity_id: entityId,
      });
      if (error) throw toAppError(error);
      return this.getRequest(id);
    } catch (err) {
      if (err instanceof AppError) throw err;
      throw toAppError(err);
    }
  }
}

let singleton: SupabaseApprovalRepository | null = null;

export function getSupabaseApprovalRepository(): SupabaseApprovalRepository {
  if (!singleton) singleton = new SupabaseApprovalRepository();
  return singleton;
}
