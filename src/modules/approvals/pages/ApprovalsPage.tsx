import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { PageHeader } from "@/components/layout/AppShell";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  LoadingBlock,
  SearchIcon,
  SelectInput,
  StatTile,
  TextInput,
} from "@/components/ui";
import { useApprovals } from "../hooks/ApprovalProvider";
import { queryApprovalRequests } from "../services/approvalService";
import {
  approvalKindLabelKey,
  approvalStatusLabelKey,
  approvalStatusTone,
} from "../services/approvalLabels";
import { ApprovalDecisionModal } from "../components/ApprovalDecisionModal";
import type { ApprovalFiltersValue, ApprovalRequest } from "../types";
import { APPROVAL_KINDS, APPROVAL_STATUSES, EMPTY_APPROVAL_FILTERS } from "../types";

/**
 * The approval inbox (Phase 12, requirement 2).
 *
 * Two audiences, one screen. Somebody holding `approve_limit_request` sees every
 * request and can decide them; everybody else sees the requests they raised and
 * where each one stands — which is the "show pending approval status" half of the
 * requirement, and the reason a cashier is not left wondering what happened to
 * the expense they filed.
 */
export function ApprovalsPage() {
  const { t, date, num } = useI18n();
  const { requests, summary, loading, error, refresh, mayDecide, cancel } = useApprovals();

  const [filters, setFilters] = useState<ApprovalFiltersValue>(EMPTY_APPROVAL_FILTERS);
  const [target, setTarget] = useState<{ request: ApprovalRequest; startOn: "approve" | "reject" } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const visible = useMemo(() => queryApprovalRequests(requests, filters), [requests, filters]);

  const patch = (next: Partial<ApprovalFiltersValue>) =>
    setFilters((prev) => ({ ...prev, ...next }));

  async function withdraw(request: ApprovalRequest) {
    setBusyId(request.id);
    try {
      await cancel(request.id);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div>
      <PageHeader
        title={t("approvals.title")}
        crumbs={[{ label: t("home.management.title"), to: "/management" }, { label: t("nav.approvals") }]}
        subtitle={mayDecide ? t("approvals.subtitleApprover") : t("approvals.subtitleRequester")}
        actions={
          <>
            <Link
              to="/settings/approvals"
              className="inline-flex h-10 items-center gap-1.5 rounded-xl bg-white px-4 text-sm font-semibold text-slate-800 ring-1 ring-slate-300 hover:bg-slate-50"
            >
              {t("approvals.rules")}
            </Link>
            <Button variant="secondary" onClick={() => void refresh()} title={t("common.refresh")}>
              ⟳
            </Button>
          </>
        }
      />

      <div className="mb-4 grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        <StatTile
          label={t("approvals.pending")}
          value={String(summary.pending)}
          tone={summary.pending > 0 ? "warning" : "neutral"}
          hint={t("approvals.pendingHint")}
        />
        <StatTile label={t("approvals.approved")} value={String(summary.approved)} tone="success" />
        <StatTile label={t("approvals.rejected")} value={String(summary.rejected)} tone="danger" />
        <StatTile
          label={t("approvals.pendingAmount")}
          value={num(summary.pendingAmount, 2)}
          tone="primary"
          hint={t("approvals.pendingAmountHint")}
        />
      </div>

      <Card className="mb-4">
        <div className="grid gap-3 sm:grid-cols-[1fr_180px_180px]">
          <TextInput
            value={filters.search}
            leading={<SearchIcon />}
            onChange={(e) => patch({ search: e.target.value })}
            placeholder={t("approvals.searchPlaceholder")}
            aria-label={t("common.search")}
            type="search"
          />
          <SelectInput
            value={filters.status}
            onChange={(e) => patch({ status: e.target.value as ApprovalFiltersValue["status"] })}
            aria-label={t("approvals.statusLabel")}
          >
            <option value="all">{t("approvals.allStatuses")}</option>
            {APPROVAL_STATUSES.map((status) => (
              <option key={status} value={status}>
                {t(approvalStatusLabelKey(status) as never)}
              </option>
            ))}
          </SelectInput>
          <SelectInput
            value={filters.kind}
            onChange={(e) => patch({ kind: e.target.value as ApprovalFiltersValue["kind"] })}
            aria-label={t("approvals.kind")}
          >
            <option value="all">{t("approvals.allKinds")}</option>
            {APPROVAL_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {t(approvalKindLabelKey(kind) as never)}
              </option>
            ))}
          </SelectInput>
        </div>
      </Card>

      {error ? (
        <ErrorState
          title={t("common.error")}
          message={error.message}
          retryLabel={t("common.retry")}
          onRetry={() => void refresh()}
        />
      ) : loading ? (
        <Card>
          <LoadingBlock label={t("common.loading")} />
        </Card>
      ) : visible.length === 0 ? (
        <Card>
          <EmptyState
            icon="🗂️"
            title={t("approvals.empty")}
            description={mayDecide ? t("approvals.emptyApprover") : t("approvals.emptyRequester")}
          />
        </Card>
      ) : (
        <div className="space-y-3">
          {visible.map((request) => {
            const percent = request.kind === "discount";
            return (
              <Card key={request.id} className="!p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-xs font-bold text-indigo-700">
                        {request.request_number}
                      </span>
                      <Badge tone="neutral">{t(approvalKindLabelKey(request.kind) as never)}</Badge>
                      <Badge tone={approvalStatusTone(request.status)}>
                        {t(approvalStatusLabelKey(request.status) as never)}
                      </Badge>
                      {request.result_entity_id ? (
                        <Badge tone="info">{t("approvals.applied")}</Badge>
                      ) : null}
                    </div>
                    <p className="mt-2 text-sm font-bold text-slate-900">
                      {request.entity_label}
                    </p>
                    <p className="mt-1 text-xs text-slate-600">
                      {t("approvals.requestedBy")}: <b>{request.requested_by_name}</b> ·{" "}
                      <span dir="ltr">{date(request.requested_at)}</span>
                    </p>
                    <p className="mt-1.5 rounded-lg bg-slate-50 p-2 text-xs text-slate-700">
                      <b>{t("approvals.reason")}:</b> {request.reason}
                    </p>
                    {request.decision_note ? (
                      <p className="mt-1.5 rounded-lg bg-slate-50 p-2 text-xs text-slate-700">
                        <b>{t("approvals.note")}:</b> {request.decision_note}
                        {request.decided_by_name ? ` — ${request.decided_by_name}` : ""}
                      </p>
                    ) : null}
                  </div>

                  <div className="text-end">
                    <p className="text-lg font-extrabold tabular-nums text-slate-900">
                      {percent ? `${num(request.amount, 2)}%` : num(request.amount, 2)}
                    </p>
                    {request.limit_value !== null ? (
                      <p className="text-[11px] text-slate-500">
                        {request.kind === "price_change"
                          ? t("approvals.previousValue")
                          : t("approvals.limit")}
                        : {percent ? `${num(request.limit_value, 2)}%` : num(request.limit_value, 2)}
                      </p>
                    ) : null}

                    <div className="mt-2 flex flex-wrap justify-end gap-1.5">
                      {request.status === "pending" && mayDecide ? (
                        <>
                          <Button
                            size="sm"
                            onClick={() => setTarget({ request, startOn: "approve" })}
                          >
                            {t("approvals.approveAction")}
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setTarget({ request, startOn: "reject" })}
                          >
                            {t("approvals.rejectAction")}
                          </Button>
                        </>
                      ) : null}
                      {request.status === "pending" && !mayDecide ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          loading={busyId === request.id}
                          onClick={() => void withdraw(request)}
                        >
                          {t("approvals.withdraw")}
                        </Button>
                      ) : null}
                      {request.status === "approved" && !request.result_entity_id && mayDecide ? (
                        <Button size="sm" variant="subtle" onClick={() => setTarget({ request, startOn: "approve" })}>
                          {t("approvals.applyAgain")}
                        </Button>
                      ) : null}
                      {request.status === "approved" && request.result_entity_id ? (
                        <span className="text-[11px] text-slate-500">
                          {t("approvals.appliedResult")}: <b>{request.result_entity_id.slice(0, 12)}</b>
                        </span>
                      ) : null}
                    </div>
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      )}

      {target ? (
        <ApprovalDecisionModal
          open
          request={target.request}
          startOn={target.startOn}
          onClose={() => setTarget(null)}
        />
      ) : null}
    </div>
  );
}
