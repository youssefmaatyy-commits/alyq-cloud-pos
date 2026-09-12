import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { AppError } from "@/modules/products/data/repository";
import { canAct } from "@/lib/permissions/enforce";
import { getApprovalMode, getApprovalRepository } from "../data";
import type { ApprovalRepository } from "../data/repository";
import type {
  ApprovalDecision,
  ApprovalKind,
  ApprovalRequest,
  ApprovalRequirement,
  ApprovalRules,
  ApprovalRulesFormValues,
  ApprovalValue,
} from "../types";
import { DEFAULT_APPROVAL_RULES } from "../types";
import {
  cancelApprovalRequest,
  clearApprovalRulesCache,
  decideApprovalRequest,
  loadApprovalRequests,
  loadApprovalRules,
  saveApprovalRules,
  submitApprovalRequest,
  summarizeApprovalRequests,
  type ApprovalSummary,
} from "../services/approvalService";
import { applyApprovedRequest, type AppliedApproval } from "../services/applyApproval";

export interface ApprovalContextValue {
  mode: "supabase" | "demo";
  repository: ApprovalRepository;
  requests: ApprovalRequest[];
  rules: ApprovalRules;
  summary: ApprovalSummary;
  loading: boolean;
  error: AppError | null;
  refresh: () => Promise<void>;
  /** May the signed-in user decide requests (and therefore skip the limits)? */
  mayDecide: boolean;

  /**
   * File an over-limit act as a request. This is what a form calls after the
   * service refused it with `approvalRequiredError`.
   */
  request: (
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
  ) => Promise<ApprovalRequest>;

  decide: (
    id: string,
    decision: ApprovalDecision,
    note: string | null,
  ) => Promise<ApprovalRequest>;
  cancel: (id: string) => Promise<ApprovalRequest>;

  /** Perform the act an approved request stands for, then record what it made. */
  apply: (request: ApprovalRequest) => Promise<AppliedApproval>;

  /** Decide *and* apply in one step — the inbox's primary button. */
  approveAndApply: (request: ApprovalRequest, note: string | null) => Promise<AppliedApproval>;

  saveRules: (values: ApprovalRulesFormValues) => Promise<ApprovalRules>;
  requestsOfKind: (kind: ApprovalKind) => ApprovalRequest[];
  pendingCount: number;
}

const ApprovalContext = createContext<ApprovalContextValue | null>(null);

export function ApprovalProvider({ children }: { children: ReactNode }) {
  const [requests, setRequests] = useState<ApprovalRequest[]>([]);
  const [rules, setRules] = useState<ApprovalRules>(DEFAULT_APPROVAL_RULES);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<AppError | null>(null);

  const repository = useMemo(() => getApprovalRepository(), []);
  const mode = useMemo(() => getApprovalMode(), []);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // The rules are read first and cached, because the domain funnels consult
      // the cache synchronously when they decide whether an act is over a limit.
      const [list, current] = await Promise.all([loadApprovalRequests(), loadApprovalRules()]);
      setRequests(list);
      setRules(current);
    } catch (err) {
      setError(err instanceof AppError ? err : new AppError("DB", String(err)));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    return () => clearApprovalRulesCache();
  }, [refresh]);

  const request = useCallback<ApprovalContextValue["request"]>(
    async (requirement, context) => {
      const created = await submitApprovalRequest(requirement, context);
      setRequests((prev) => [created, ...prev]);
      return created;
    },
    [],
  );

  const decide = useCallback<ApprovalContextValue["decide"]>(
    async (id, decision, note) => {
      const outcome = await decideApprovalRequest(id, decision, note);
      setRequests((prev) => prev.map((r) => (r.id === id ? outcome.request : r)));
      return outcome.request;
    },
    [],
  );

  const cancel = useCallback<ApprovalContextValue["cancel"]>(async (id) => {
    const cancelled = await cancelApprovalRequest(id);
    setRequests((prev) => prev.map((r) => (r.id === id ? cancelled : r)));
    return cancelled;
  }, []);

  const apply = useCallback<ApprovalContextValue["apply"]>(async (target) => {
    const applied = await applyApprovedRequest(target);
    setRequests((prev) =>
      prev.map((r) => (r.id === target.id ? { ...r, result_entity_id: applied.entityId } : r)),
    );
    return applied;
  }, []);

  const approveAndApply = useCallback<ApprovalContextValue["approveAndApply"]>(
    async (target, note) => {
      const decided = await decide(target.id, "approved", note);
      try {
        return await apply(decided);
      } catch (err) {
        // The decision stands even when the act fails: the request is approved
        // and the inbox offers "apply" again, rather than losing the signature.
        setRequests((prev) => prev.map((r) => (r.id === target.id ? decided : r)));
        throw err;
      }
    },
    [apply, decide],
  );

  const saveRulesAction = useCallback<ApprovalContextValue["saveRules"]>(async (values) => {
    const saved = await saveApprovalRules(values);
    setRules(saved);
    return saved;
  }, []);

  const summary = useMemo(() => summarizeApprovalRequests(requests), [requests]);

  const requestsOfKind = useCallback(
    (kind: ApprovalKind) => requests.filter((r) => r.kind === kind),
    [requests],
  );

  // Read from the same source the service refuses from, so the button and the
  // gate cannot disagree. Re-asked whenever the inbox changes, which is when a
  // session switch would have shown up anyway.
  const mayDecide = useMemo(
    () => canAct("approve_limit_request"),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [requests.length, rules, loading],
  );

  const value = useMemo<ApprovalContextValue>(
    () => ({
      mode,
      repository,
      requests,
      rules,
      summary,
      loading,
      error,
      refresh,
      mayDecide,
      request,
      decide,
      cancel,
      apply,
      approveAndApply,
      saveRules: saveRulesAction,
      requestsOfKind,
      pendingCount: summary.pending,
    }),
    [
      mode,
      repository,
      requests,
      rules,
      summary,
      loading,
      error,
      refresh,
      mayDecide,
      request,
      decide,
      cancel,
      apply,
      approveAndApply,
      saveRulesAction,
      requestsOfKind,
    ],
  );

  return <ApprovalContext.Provider value={value}>{children}</ApprovalContext.Provider>;
}

export function useApprovals(): ApprovalContextValue {
  const ctx = useContext(ApprovalContext);
  if (!ctx) throw new Error("useApprovals must be used inside <ApprovalProvider>");
  return ctx;
}

/**
 * Read the approvals state without requiring the provider.
 *
 * The dashboard and the sidebar badge sit outside `ApprovalProvider`, and a
 * pending-approvals count must not crash them when it is absent.
 */
export function useOptionalApprovals(): ApprovalContextValue | null {
  return useContext(ApprovalContext);
}
