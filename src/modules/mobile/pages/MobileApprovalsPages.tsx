import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { can } from "@/lib/permissions/enforce";
import { useApprovals } from "@/modules/approvals";
import { requireMobileOnline } from "../services/mobileRuntime";
import { MobileBadge, MobileCard, MobilePage, MobileState } from "../components/MobilePrimitives";

export function MobileApprovalsPage() {
  const approvals = useApprovals();
  if (!can("approvals.approve")) return <MobilePage title="Approvals"><MobileState kind="denied" title="Manager approval access denied" /></MobilePage>;
  const requests = approvals.requests.filter((request) => request.status === "pending");
  return <MobilePage title="Approval Center" subtitle="Server-authoritative pending requests" actions={<button type="button" className="mobile-action" onClick={() => void approvals.refresh()}>Refresh</button>}>
    {approvals.loading ? <MobileState kind="loading" title="Loading approval requests…" />
      : approvals.error ? <MobileState kind="error" title="Approvals unavailable" detail={approvals.error.message} retry={() => void approvals.refresh()} />
        : requests.length === 0 ? <MobileState kind="empty" title="No pending approvals" />
          : <div className="mobile-list">{requests.map((request) => <Link className="mobile-list-link" key={request.id} to={`/mobile/approvals/${request.id}`}><MobileCard><div className="mobile-row"><strong>{request.request_number}</strong><MobileBadge tone="warning">{request.kind}</MobileBadge></div><p>{request.entity_label}</p><div className="mobile-row mobile-muted"><span>{request.requested_by_name} · {request.branch ?? "—"}</span><strong>{request.amount}</strong></div><span className="mobile-muted">{new Date(request.requested_at).toLocaleString()}</span></MobileCard></Link>)}</div>}
  </MobilePage>;
}

export function MobileApprovalDetailPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const approvals = useApprovals();
  const request = approvals.requests.find((entry) => entry.id === id);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const decide = async (decision: "approved" | "rejected") => {
    if (!request) return;
    const note = window.prompt(decision === "rejected" ? "Rejection reason (required)" : "Approval note (optional)")?.trim() ?? "";
    if (decision === "rejected" && !note) return;
    setBusy(true); setError("");
    try {
      await requireMobileOnline();
      if (decision === "approved") await approvals.approveAndApply(request, note || null);
      else await approvals.decide(request.id, "rejected", note);
      await approvals.refresh({ silent: true });
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Decision unavailable"); }
    finally { setBusy(false); }
  };

  return <MobilePage title={request?.request_number ?? "Approval detail"} subtitle="Operation-bound evidence" actions={<button type="button" className="mobile-action" onClick={() => navigate(-1)}>Back</button>}>
    {!can("approvals.approve") ? <MobileState kind="denied" title="Manager approval access denied" />
      : approvals.loading ? <MobileState kind="loading" title="Loading approval…" />
        : !request ? <MobileState kind="denied" title="Access denied or request unavailable" detail="The request is not available in your active authorized branch." />
          : <>
            {error ? <MobileState kind="error" title="Decision not completed" detail={error} /> : null}
            <MobileCard><div className="mobile-row"><MobileBadge tone={request.status === "pending" ? "warning" : request.status === "approved" ? "success" : "danger"}>{request.status}</MobileBadge><strong>{request.kind}</strong></div><dl className="mobile-detail-grid"><div><dt>Requester</dt><dd>{request.requested_by_name}</dd></div><div><dt>Branch</dt><dd>{request.branch ?? "—"}</dd></div><div><dt>Operation</dt><dd>{request.operation_type ?? request.kind}</dd></div><div><dt>Amount</dt><dd>{request.amount}</dd></div><div><dt>Threshold</dt><dd>{request.limit_value ?? "—"}</dd></div><div><dt>Entity</dt><dd>{request.entity_label}</dd></div><div><dt>Requested</dt><dd>{new Date(request.requested_at).toLocaleString()}</dd></div><div><dt>Expires</dt><dd>{request.expires_at ? new Date(request.expires_at).toLocaleString() : "—"}</dd></div><div className="mobile-detail-wide"><dt>Reason</dt><dd>{request.reason}</dd></div><div className="mobile-detail-wide"><dt>Correlation</dt><dd dir="ltr">{request.correlation_id ?? "—"}</dd></div></dl></MobileCard>
            <MobileCard><h2>Requested change</h2><pre className="mobile-safe-evidence">{JSON.stringify(request.new_value, null, 2)}</pre></MobileCard>
            {request.status === "pending" ? <div className="mobile-sticky-actions"><button type="button" disabled={busy} onClick={() => void decide("approved")}>Approve & apply</button><button type="button" className="danger" disabled={busy} onClick={() => void decide("rejected")}>Reject</button></div> : null}
          </>}
  </MobilePage>;
}
