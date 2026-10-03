import { safeStorage } from "@/modules/products/data/demoSeed";
import { AppError } from "@/modules/products/data/repository";
import { getCurrentUser } from "@/modules/inventory/permissions";
import type {
  ApprovalDecision,
  ApprovalRequest,
  ApprovalRules,
  ApprovalValue,
  NewApprovalRequest,
} from "../types";
import { DEFAULT_APPROVAL_RULES } from "../types";
import type { ApprovalRepository } from "./repository";

/**
 * Demo-mode approvals (Phase 12).
 *
 * The invariants here are deliberately the same ones migration 0023 enforces in
 * Postgres, because the two modes must not drift:
 *
 *   * a request is decided once — the same decision twice is a no-op, the
 *     opposite decision is refused;
 *   * a rejection needs a note;
 *   * the ask is frozen: `amount`, `limit_value`, `previous_value`, `new_value`,
 *     `payload`, `kind`, `request_number` and `requested_by` cannot be rewritten;
 *   * only an approved request can be applied, and applying it once fills
 *     `result_entity_id`, which is what stops a replay;
 *   * a request is never deleted.
 *
 * The actor is stamped from the session, exactly as the database trigger stamps
 * it from `auth.uid()` — so a demo request and a live request carry the same
 * provenance.
 */

const REQUESTS_KEY = "alyq.demo.approval_requests.v1";
const RULES_KEY = "alyq.demo.approval_rules.v1";
const COUNTER_KEY = "alyq.demo.approval_counter.v1";
const LATENCY = 40;

function delay<T>(value: T, ms = LATENCY): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

function nowIso(): string {
  return new Date().toISOString();
}

function formatRequestNumber(n: number): string {
  return `APR-${String(n).padStart(6, "0")}`;
}

function nextCounter(): number {
  const raw = safeStorage.get(COUNTER_KEY);
  const current = raw ? Number.parseInt(raw, 10) : 0;
  const next = Number.isFinite(current) && current > 0 ? current + 1 : 1;
  safeStorage.set(COUNTER_KEY, String(next));
  return next;
}

function loadRequests(): ApprovalRequest[] {
  const raw = safeStorage.get(REQUESTS_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as ApprovalRequest[]) : [];
  } catch {
    return [];
  }
}

function persistRequests(list: ApprovalRequest[]): void {
  safeStorage.set(REQUESTS_KEY, JSON.stringify(list));
}

function loadRules(): ApprovalRules {
  const raw = safeStorage.get(RULES_KEY);
  if (!raw) return { ...DEFAULT_APPROVAL_RULES };
  try {
    const parsed = JSON.parse(raw) as Partial<ApprovalRules>;
    return { ...DEFAULT_APPROVAL_RULES, ...parsed };
  } catch {
    return { ...DEFAULT_APPROVAL_RULES };
  }
}

function persistRules(rules: ApprovalRules): void {
  safeStorage.set(RULES_KEY, JSON.stringify(rules));
}

function asValueObject(raw: unknown): ApprovalValue {
  if (!raw || typeof raw !== "object") return {};
  const out: ApprovalValue = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value === null || ["string", "number", "boolean"].includes(typeof value)) {
      out[key] = value as string | number | boolean | null;
    }
  }
  return out;
}

export class DemoApprovalRepository implements ApprovalRepository {
  readonly kind = "demo" as const;
  private requests: ApprovalRequest[];
  private rules: ApprovalRules;

  constructor() {
    this.requests = loadRequests();
    this.rules = loadRules();
  }

  async getRules(): Promise<ApprovalRules> {
    return delay({ ...this.rules });
  }

  async saveRules(rules: ApprovalRules): Promise<ApprovalRules> {
    const user = getCurrentUser();
    const saved: ApprovalRules = {
      ...rules,
      updated_by_name: user.name || rules.updated_by_name,
      updated_at: nowIso(),
    };
    this.rules = saved;
    persistRules(saved);
    return delay({ ...saved });
  }

  async listRequests(): Promise<ApprovalRequest[]> {
    return delay(
      [...this.requests].sort((a, b) => b.requested_at.localeCompare(a.requested_at)),
    );
  }

  async getRequest(id: string): Promise<ApprovalRequest> {
    const found = this.requests.find((r) => r.id === id);
    if (!found) throw new AppError("NOT_FOUND", `Approval request ${id} not found`);
    return delay({ ...found });
  }

  async createRequest(input: NewApprovalRequest): Promise<ApprovalRequest> {
    const reason = String(input.reason ?? "").trim();
    if (reason.length === 0) {
      throw new AppError("VALIDATION", "An approval request needs a reason", "reason");
    }
    const amount = Number(input.amount ?? 0);
    if (!Number.isFinite(amount) || amount < 0) {
      throw new AppError("VALIDATION", "An approval request needs a positive value", "amount");
    }

    const user = getCurrentUser();
    const now = nowIso();
    const number = formatRequestNumber(nextCounter());
    const request: ApprovalRequest = {
      id: `apr-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      request_number: number,
      kind: input.kind,
      entity_type: input.entity_type || input.kind,
      entity_id: input.entity_id ?? "",
      entity_label: input.entity_label?.trim() || number,
      branch: input.branch ?? null,
      amount,
      limit_value: input.limit_value ?? null,
      previous_value: asValueObject(input.previous_value),
      new_value: asValueObject(input.new_value),
      payload: (input.payload ?? {}) as Record<string, unknown>,
      reason,
      status: "pending",
      requested_by: user.id,
      requested_by_name: user.name || "Staff",
      requested_at: now,
      decided_by: null,
      decided_by_name: null,
      decided_at: null,
      decision_note: null,
      result_entity_id: null,
      created_at: now,
    };

    this.requests = [request, ...this.requests];
    persistRequests(this.requests);
    return delay({ ...request }, 60);
  }

  async decideRequest(
    id: string,
    decision: ApprovalDecision,
    note: string | null,
  ): Promise<{ request: ApprovalRequest; alreadyDecided: boolean }> {
    const existing = this.requests.find((r) => r.id === id);
    if (!existing) throw new AppError("NOT_FOUND", `Approval request ${id} not found`);

    if (existing.status === decision) {
      return delay({ request: { ...existing }, alreadyDecided: true });
    }
    if (existing.status !== "pending") {
      throw new AppError("VALIDATION", `This request was already ${existing.status}`);
    }
    const trimmedNote = note?.trim() ?? "";
    if (decision === "rejected" && trimmedNote.length === 0) {
      throw new AppError("VALIDATION", "A rejected request needs a note saying why", "decision_note");
    }

    const user = getCurrentUser();
    const now = nowIso();
    const decided: ApprovalRequest = {
      ...existing,
      status: decision,
      decided_by: user.id,
      decided_by_name: user.name || existing.requested_by_name,
      decided_at: now,
      decision_note: decision === "rejected" ? trimmedNote : trimmedNote || null,
    };
    this.requests = this.requests.map((r) => (r.id === id ? decided : r));
    persistRequests(this.requests);
    return delay({ request: { ...decided }, alreadyDecided: false }, 60);
  }

  async cancelRequest(id: string): Promise<ApprovalRequest> {
    return (await this.decideRequest(id, "cancelled", null)).request;
  }

  async approveWithManagerPin(_id: string, _username: string, _pin: string): Promise<ApprovalRequest> {
    throw new AppError("FORBIDDEN", "Inline manager approval is unavailable offline");
  }

  async markApplied(id: string, entityId: string): Promise<ApprovalRequest> {
    const existing = this.requests.find((r) => r.id === id);
    if (!existing) throw new AppError("NOT_FOUND", `Approval request ${id} not found`);
    if (existing.status !== "approved") {
      throw new AppError(
        "VALIDATION",
        `Only an approved request can be applied (this one is ${existing.status})`,
      );
    }
    const trimmed = String(entityId ?? "").trim();
    if (trimmed.length === 0) {
      throw new AppError("VALIDATION", "Applying a request needs the record it produced");
    }
    if (existing.result_entity_id) {
      // Already applied: a replay is a no-op, not a second expense.
      return delay({ ...existing });
    }

    const applied: ApprovalRequest = {
      ...existing,
      result_entity_id: trimmed,
      entity_id: existing.entity_id || trimmed,
    };
    this.requests = this.requests.map((r) => (r.id === id ? applied : r));
    persistRequests(this.requests);
    return delay({ ...applied }, 40);
  }

  /** Test helper: drop every request and reset the thresholds. */
  reset(): void {
    this.requests = [];
    this.rules = { ...DEFAULT_APPROVAL_RULES };
    persistRequests(this.requests);
    persistRules(this.rules);
    safeStorage.set(COUNTER_KEY, "0");
  }
}

let singleton: DemoApprovalRepository | null = null;

export function getDemoApprovalRepository(): DemoApprovalRepository {
  if (!singleton) singleton = new DemoApprovalRepository();
  return singleton;
}

/** Re-read storage — used by tests and by a session switch. */
export function resetDemoApprovalRepository(): void {
  singleton = null;
}
