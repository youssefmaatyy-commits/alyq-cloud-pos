import { useState } from "react";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { Button, Field, Modal, TextArea, useToast } from "@/components/ui";
import { AppError } from "@/modules/products/data/repository";
import type { ApprovalKind, ApprovalRequirement, ApprovalValue } from "../types";
import { useApprovals } from "../hooks/ApprovalProvider";
import { approvalKindLabelKey } from "../services/approvalLabels";

export interface ApprovalRequestDialogProps {
  open: boolean;
  onClose: () => void;
  /** The rule that fired, carried by the service's refusal. */
  requirement: ApprovalRequirement | null;
  entityType: string;
  entityLabel?: string;
  entityId?: string;
  branch?: string | null;
  previousValue?: ApprovalValue;
  newValue?: ApprovalValue;
  /** The deferred act's arguments, replayed by `applyApprovedRequest`. */
  payload?: Record<string, unknown>;
  /** Shown above the reason field: what the user was trying to do. */
  summary?: string;
  /** Called with the request once it is filed, so the form can close cleanly. */
  onFiled?: (requestId: string, requestNumber: string) => void;
}

/**
 * "This needs approval" — the dialog a form opens when a service refused an
 * over-limit act (Phase 12, requirement 2).
 *
 * The act is *not* performed here and not half-performed: the only thing written
 * is the request, carrying the value before, the value wanted, the threshold
 * that fired, the deferred act's own arguments and the reason the user gives.
 * Somebody holding `approve_limit_request` decides it later, and the act then
 * runs through the funnel it was always going to run through.
 */
export function ApprovalRequestDialog({
  open,
  onClose,
  requirement,
  entityType,
  entityLabel,
  entityId,
  branch,
  previousValue,
  newValue,
  payload,
  summary,
  onFiled,
}: ApprovalRequestDialogProps) {
  const { t, num } = useI18n();
  const toast = useToast();
  const { request } = useApprovals();

  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [reasonError, setReasonError] = useState<string | null>(null);

  if (!open || !requirement) return null;

  const kind: ApprovalKind = requirement.kind;
  const isPercent = kind === "discount";
  const value = isPercent ? `${num(requirement.amount, 2)}%` : num(requirement.amount, 2);
  const limit = isPercent
    ? `${num(requirement.limit_value, 2)}%`
    : num(requirement.limit_value, 2);

  async function submit() {
    if (!requirement) return;
    const trimmed = reason.trim();
    if (trimmed.length === 0) {
      setReasonError(t("approvals.reasonRequired"));
      return;
    }
    if (trimmed.length > 500) {
      setReasonError(t("approvals.reasonTooLong"));
      return;
    }
    setReasonError(null);
    setBusy(true);
    try {
      const created = await request(requirement, {
        entityType,
        entityLabel,
        entityId,
        branch: branch ?? null,
        reason: trimmed,
        previousValue,
        newValue,
        payload,
      });
      toast.success(t("approvals.filedToast", { number: created.request_number }));
      setReason("");
      onFiled?.(created.id, created.request_number);
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
      title={t("approvals.requestTitle")}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {t("common.cancel")}
          </Button>
          <Button onClick={() => void submit()} loading={busy}>
            {t("approvals.sendFile")}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm font-semibold text-amber-900">
          {t("approvals.overLimitNotice", { act: t(approvalKindLabelKey(kind) as never) })}
        </p>

        <div className="rounded-xl bg-slate-50 p-3 text-sm">
          <div className="flex items-center justify-between gap-3">
            <span className="text-slate-500">{t("approvals.kind")}</span>
            <span className="font-bold text-slate-900">{t(approvalKindLabelKey(kind) as never)}</span>
          </div>
          <div className="mt-1.5 flex items-center justify-between gap-3">
            <span className="text-slate-500">{t("approvals.requestedValue")}</span>
            <span className="font-extrabold tabular-nums text-slate-900">{value}</span>
          </div>
          <div className="mt-1.5 flex items-center justify-between gap-3">
            <span className="text-slate-500">
              {kind === "price_change" ? t("approvals.previousValue") : t("approvals.limit")}
            </span>
            <span className="tabular-nums text-slate-700">{limit}</span>
          </div>
          {summary ? (
            <div className="mt-2 border-t border-slate-200 pt-2 text-xs text-slate-600">
              {summary}
            </div>
          ) : null}
        </div>

        <Field
          label={t("approvals.reason")}
          required
          hint={t("approvals.reasonHint")}
          error={reasonError ?? undefined}
          htmlFor="approval-request-reason"
        >
          <TextArea
            id="approval-request-reason"
            value={reason}
            rows={3}
            invalid={Boolean(reasonError)}
            placeholder={t("approvals.reasonPlaceholder")}
            onChange={(e) => setReason(e.target.value)}
          />
        </Field>
      </div>
    </Modal>
  );
}
