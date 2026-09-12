import { useState } from "react";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { Button, Field, Modal, TextArea, useToast } from "@/components/ui";
import { AppError } from "@/modules/products/data/repository";
import type { ApprovalRequest } from "../types";
import { useApprovals } from "../hooks/ApprovalProvider";
import { approvalKindLabelKey, approvalValueSummary } from "../services/approvalLabels";

export interface ApprovalDecisionModalProps {
  open: boolean;
  onClose: () => void;
  request: ApprovalRequest | null;
  /** Which way the dialog starts out. The other direction stays reachable. */
  startOn?: "approve" | "reject";
}

/**
 * Decide an over-limit request (Phase 12, requirement 2).
 *
 * Approving does two things and the dialog says so: it records the decision, and
 * it performs the act the request stands for — filing the expense, completing the
 * discounted sale, settling the refund, writing the new price. Rejecting records
 * the refusal and nothing else; a note saying why is mandatory, because the
 * requester is entitled to know what to change.
 */
export function ApprovalDecisionModal({ open, onClose, request, startOn = "approve" }: ApprovalDecisionModalProps) {
  const { t, num } = useI18n();
  const toast = useToast();
  const { approveAndApply, decide } = useApprovals();

  const [mode, setMode] = useState<"approve" | "reject">(startOn);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [noteError, setNoteError] = useState<string | null>(null);

  if (!open || !request) return null;

  const isPercent = request.kind === "discount";
  const value = isPercent ? `${num(request.amount, 2)}%` : num(request.amount, 2);

  async function submit() {
    if (!request) return;
    const trimmed = note.trim();
    if (mode === "reject" && trimmed.length === 0) {
      setNoteError(t("approvals.noteRequired"));
      return;
    }
    setNoteError(null);
    setBusy(true);
    try {
      if (mode === "reject") {
        await decide(request.id, "rejected", trimmed);
        toast.success(t("approvals.rejectedToast"));
      } else {
        const applied = await approveAndApply(request, trimmed || null);
        toast.success(
          applied.entityLabel
            ? t("approvals.appliedToast", { label: applied.entityLabel })
            : t("approvals.approvedToast"),
        );
      }
      setNote("");
      onClose();
    } catch (err) {
      toast.error(err instanceof AppError ? err.message || t("common.error") : t("common.error"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={
        mode === "reject"
          ? t("approvals.rejectTitle", { number: request.request_number })
          : t("approvals.approveTitle", { number: request.request_number })
      }
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {t("common.cancel")}
          </Button>
          <Button
            variant="secondary"
            onClick={() => setMode(mode === "reject" ? "approve" : "reject")}
            disabled={busy}
          >
            {mode === "reject" ? t("approvals.approveAction") : t("approvals.rejectAction")}
          </Button>
          <Button
            variant={mode === "reject" ? "danger" : "primary"}
            onClick={() => void submit()}
            loading={busy}
          >
            {mode === "reject" ? t("approvals.confirmReject") : t("approvals.confirmApprove")}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="rounded-xl bg-slate-50 p-3 text-sm">
          <div className="flex items-center justify-between gap-3">
            <span className="text-slate-500">{t("approvals.kind")}</span>
            <span className="font-bold text-slate-900">{t(approvalKindLabelKey(request.kind) as never)}</span>
          </div>
          <div className="mt-1.5 flex items-center justify-between gap-3">
            <span className="text-slate-500">{t("approvals.requestedValue")}</span>
            <span className="font-extrabold tabular-nums text-slate-900">{value}</span>
          </div>
          {request.limit_value !== null ? (
            <div className="mt-1.5 flex items-center justify-between gap-3">
              <span className="text-slate-500">
                {request.kind === "price_change"
                  ? t("approvals.previousValue")
                  : t("approvals.limit")}
              </span>
              <span className="tabular-nums text-slate-700">
                {isPercent || request.kind === "price_change"
                  ? request.kind === "price_change"
                    ? num(request.limit_value, 2)
                    : `${num(request.limit_value, 2)}%`
                  : num(request.limit_value, 2)}
              </span>
            </div>
          ) : null}
          <div className="mt-1.5 flex items-center justify-between gap-3">
            <span className="text-slate-500">{t("approvals.record")}</span>
            <span className="font-mono text-xs text-slate-700">{request.entity_label}</span>
          </div>
          <div className="mt-1.5 flex items-center justify-between gap-3">
            <span className="text-slate-500">{t("approvals.requestedBy")}</span>
            <span className="text-slate-700">{request.requested_by_name}</span>
          </div>
        </div>

        <div>
          <p className="mb-1 text-xs font-bold uppercase tracking-wider text-slate-500">
            {t("approvals.reason")}
          </p>
          <p className="rounded-lg border border-slate-200 bg-white p-2.5 text-sm text-slate-700">
            {request.reason}
          </p>
        </div>

        <div>
          <p className="mb-1 text-xs font-bold uppercase tracking-wider text-slate-500">
            {t("approvals.changeSummary")}
          </p>
          <ul className="space-y-1 rounded-lg border border-slate-200 bg-white p-2.5 text-xs text-slate-700">
            {approvalValueSummary(request.previous_value, request.new_value).map((row) => (
              <li key={row.field} className="flex items-center justify-between gap-3">
                <span className="font-semibold">{row.field}</span>
                <span className="tabular-nums">
                  {row.previous === row.next ? row.next : `${row.previous} → ${row.next}`}
                </span>
              </li>
            ))}
          </ul>
        </div>

        <p className="text-xs leading-relaxed text-slate-600">
          {mode === "reject" ? t("approvals.rejectHint") : t("approvals.approveHint", {
            act: t(approvalKindLabelKey(request.kind) as never),
          })}
        </p>

        <Field
          label={mode === "reject" ? t("approvals.note") : t("approvals.noteOptional")}
          required={mode === "reject"}
          error={noteError ?? undefined}
          htmlFor="approval-decision-note"
        >
          <TextArea
            id="approval-decision-note"
            value={note}
            rows={3}
            invalid={Boolean(noteError)}
            placeholder={
              mode === "reject" ? t("approvals.notePlaceholder") : t("approvals.noteApprovePlaceholder")
            }
            onChange={(e) => setNote(e.target.value)}
          />
        </Field>
      </div>
    </Modal>
  );
}
