import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { PageHeader } from "@/components/layout/AppShell";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  LoadingBlock,
  Modal,
  SearchIcon,
  SelectInput,
  StatTile,
  TextInput,
} from "@/components/ui";
import { MobileBadge, MobileCard } from "@/modules/mobile/components/MobilePrimitives";
import "@/modules/mobile/mobile.css";
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
  const { t, date, num, isRTL } = useI18n();
  const { requests, summary, loading, error, refresh, mayDecide, cancel } = useApprovals();
  const routeParams = useParams<{ id?: string }>();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();

  const [filters, setFilters] = useState<ApprovalFiltersValue>(EMPTY_APPROVAL_FILTERS);
  const [target, setTarget] = useState<{ request: ApprovalRequest; startOn: "approve" | "reject" } | null>(null);
  const [detailRequestId, setDetailRequestId] = useState<string | null>(routeParams.id ?? null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const hydrated = useRef(false);
  useEffect(() => {
    if (hydrated.current) return;
    hydrated.current = true;
    const reqId = params.get("requestId") ?? routeParams.id;
    if (reqId) {
      setDetailRequestId(reqId);
      if (params.get("requestId")) setParams({}, { replace: true });
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (routeParams.id) setDetailRequestId(routeParams.id);
  }, [routeParams.id]);

  const detailRequest = useMemo(
    () => requests.find((r) => r.id === detailRequestId) ?? null,
    [requests, detailRequestId],
  );

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
              {t("common.refresh")}
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
                      <button
                        type="button"
                        onClick={() => setDetailRequestId(request.id)}
                        className="font-mono text-xs font-bold text-[#172033] hover:text-indigo-700 hover:underline"
                      >
                        {request.request_number}
                      </button>
                      <Badge tone="neutral">{t(approvalKindLabelKey(request.kind) as never)}</Badge>
                      <Badge tone={approvalStatusTone(request.status)}>
                        {t(approvalStatusLabelKey(request.status) as never)}
                      </Badge>
                      {request.branch ? (
                        <Badge tone="neutral">{request.branch}</Badge>
                      ) : null}
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
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => setDetailRequestId(request.id)}
                        data-testid={`approval-detail-btn-${request.id}`}
                      >
                        {isRTL ? "التفاصيل والأدلة" : "Details & evidence"}
                      </Button>
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

      {detailRequest ? (
        <Modal
          open
          onClose={() => {
            setDetailRequestId(null);
            if (routeParams.id) navigate("/dashboard/approvals", { replace: true });
          }}
          size="lg"
          title={
            <span className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-sm font-bold text-[#172033]">
                {detailRequest.request_number}
              </span>
              <MobileBadge
                tone={
                  detailRequest.status === "pending"
                    ? "warning"
                    : detailRequest.status === "approved"
                      ? "success"
                      : "danger"
                }
              >
                {t(approvalStatusLabelKey(detailRequest.status) as never)}
              </MobileBadge>
            </span>
          }
          footer={
            <>
              <Button
                variant="secondary"
                onClick={() => {
                  setDetailRequestId(null);
                  if (routeParams.id) navigate("/dashboard/approvals", { replace: true });
                }}
              >
                {t("common.close")}
              </Button>
              {detailRequest.status === "pending" && mayDecide ? (
                <>
                  <Button
                    onClick={() => {
                      const req = detailRequest;
                      setDetailRequestId(null);
                      setTarget({ request: req, startOn: "approve" });
                    }}
                  >
                    {t("approvals.approveAction")}
                  </Button>
                  <Button
                    variant="danger"
                    onClick={() => {
                      const req = detailRequest;
                      setDetailRequestId(null);
                      setTarget({ request: req, startOn: "reject" });
                    }}
                  >
                    {t("approvals.rejectAction")}
                  </Button>
                </>
              ) : null}
              {detailRequest.status === "pending" && !mayDecide ? (
                <Button
                  variant="ghost"
                  loading={busyId === detailRequest.id}
                  onClick={() => void withdraw(detailRequest)}
                >
                  {t("approvals.withdraw")}
                </Button>
              ) : null}
              {detailRequest.status === "approved" && !detailRequest.result_entity_id && mayDecide ? (
                <Button
                  variant="subtle"
                  onClick={() => {
                    const req = detailRequest;
                    setDetailRequestId(null);
                    setTarget({ request: req, startOn: "approve" });
                  }}
                >
                  {t("approvals.applyAgain")}
                </Button>
              ) : null}
            </>
          }
        >
          <div className="space-y-4" data-testid="approval-detail-modal">
            <MobileCard>
              <div className="mobile-row mb-3">
                <MobileBadge
                  tone={
                    detailRequest.status === "pending"
                      ? "warning"
                      : detailRequest.status === "approved"
                        ? "success"
                        : "danger"
                  }
                >
                  {detailRequest.status}
                </MobileBadge>
                <strong>{t(approvalKindLabelKey(detailRequest.kind) as never)}</strong>
              </div>
              <dl className="mobile-detail-grid sm:grid-cols-3">
                <div>
                  <dt>{t("approvals.requestedBy")}</dt>
                  <dd className="font-semibold">{detailRequest.requested_by_name}</dd>
                </div>
                <div>
                  <dt>{isRTL ? "الفرع" : "Branch"}</dt>
                  <dd>{detailRequest.branch ?? "—"}</dd>
                </div>
                <div>
                  <dt>{isRTL ? "نوع العملية" : "Operation"}</dt>
                  <dd>{detailRequest.operation_type ?? detailRequest.kind}</dd>
                </div>
                <div>
                  <dt>{isRTL ? "القيمة" : "Amount"}</dt>
                  <dd className="font-bold tabular-nums">
                    {detailRequest.kind === "discount"
                      ? `${num(detailRequest.amount, 2)}%`
                      : num(detailRequest.amount, 2)}
                  </dd>
                </div>
                <div>
                  <dt>
                    {detailRequest.kind === "price_change"
                      ? t("approvals.previousValue")
                      : t("approvals.limit")}
                  </dt>
                  <dd className="tabular-nums">
                    {detailRequest.limit_value !== null
                      ? detailRequest.kind === "discount"
                        ? `${num(detailRequest.limit_value, 2)}%`
                        : num(detailRequest.limit_value, 2)
                      : "—"}
                  </dd>
                </div>
                <div>
                  <dt>{isRTL ? "العنصر المرتبط" : "Entity"}</dt>
                  <dd className="font-semibold">{detailRequest.entity_label}</dd>
                </div>
                <div>
                  <dt>{isRTL ? "تاريخ الطلب" : "Requested"}</dt>
                  <dd dir="ltr">{date(detailRequest.requested_at)}</dd>
                </div>
                <div>
                  <dt>{isRTL ? "تاريخ الانتهاء" : "Expires"}</dt>
                  <dd dir="ltr">{detailRequest.expires_at ? date(detailRequest.expires_at) : "—"}</dd>
                </div>
                {detailRequest.decided_by_name ? (
                  <div>
                    <dt>{isRTL ? "تم القرار بواسطة" : "Decided by"}</dt>
                    <dd>
                      {detailRequest.decided_by_name}
                      {detailRequest.decided_at ? ` · ${date(detailRequest.decided_at)}` : ""}
                    </dd>
                  </div>
                ) : null}
                <div className="mobile-detail-wide">
                  <dt>{t("approvals.reason")}</dt>
                  <dd>{detailRequest.reason}</dd>
                </div>
                {detailRequest.decision_note ? (
                  <div className="mobile-detail-wide">
                    <dt>{t("approvals.note")}</dt>
                    <dd>{detailRequest.decision_note}</dd>
                  </div>
                ) : null}
                <div className="mobile-detail-wide">
                  <dt>{isRTL ? "معرّف الترابط (Correlation)" : "Correlation"}</dt>
                  <dd dir="ltr" className="font-mono text-xs">
                    {detailRequest.correlation_id ?? "—"}
                  </dd>
                </div>
              </dl>
            </MobileCard>

            <MobileCard>
              <h2>{isRTL ? "التغيير المطلوب (Requested change)" : "Requested change"}</h2>
              <pre className="mobile-safe-evidence">
                {JSON.stringify(detailRequest.new_value ?? {}, null, 2)}
              </pre>
            </MobileCard>
          </div>
        </Modal>
      ) : null}

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
