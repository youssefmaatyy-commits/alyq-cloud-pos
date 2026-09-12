import { useState } from "react";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { Button, Field, Modal, TextArea, useToast } from "@/components/ui";
import type { RefundDecision, RefundRecord } from "../types";
import { useReturns } from "../hooks/ReturnProvider";
import { canRejectRefund, canSettleRefund } from "../permissions";
import { AppError } from "@/modules/products/data/repository";

export interface RefundSettleModalProps {
  open: boolean;
  onClose: () => void;
  refund: RefundRecord | null;
  /** Which way the dialog starts out. The other direction stays reachable. */
  decision: RefundDecision;
}

/**
 * Complete or reject a pending refund (Phase 13, requirement 3).
 *
 * This is the human half of `pos_settle_refund`: the money on the row is fixed,
 * the only thing an approver decides is whether it really left the drawer, and
 * a refusal has to say why. Both directions need `approve_refund`, so a till
 * operator who recorded the refund cannot also sign it off — the dialog says so
 * instead of offering buttons that would fail.
 */
export function RefundSettleModal({ open, onClose, refund, decision }: RefundSettleModalProps) {
  const { t, num } = useI18n();
  const toast = useToast();
  const { settleRefund } = useReturns();

  const [mode, setMode] = useState<RefundDecision>(decision);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [reasonError, setReasonError] = useState<string | null>(null);

  if (!open || !refund) return null;

  const allowed = mode === "rejected" ? canRejectRefund() : canSettleRefund();

  async function submit() {
    if (!refund) return;
    const trimmed = reason.trim();
    if (mode === "rejected" && trimmed.length === 0) {
      setReasonError(t("refunds.rejectReasonRequired"));
      return;
    }
    setReasonError(null);
    setBusy(true);
    try {
      const outcome = await settleRefund(refund.id, mode, mode === "rejected" ? trimmed : null);
      toast.success(
        outcome.alreadySettled
          ? t("refunds.alreadySettled")
          : mode === "rejected"
            ? t("refunds.rejectedToast")
            : t("refunds.settledToast"),
      );
      setReason("");
      onClose();
    } catch (err) {
      toast.error(
        err instanceof AppError ? (err.message || t("common.error")) : t("common.error"),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={
        mode === "rejected"
          ? t("refunds.rejectTitle", { number: refund.refund_number })
          : t("refunds.settleTitle", { number: refund.refund_number })
      }
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {t("common.cancel")}
          </Button>
          {mode === "rejected" ? (
            <Button variant="secondary" onClick={() => setMode("completed")} disabled={busy}>
              {t("refunds.approveAction")}
            </Button>
          ) : (
            <Button variant="secondary" onClick={() => setMode("rejected")} disabled={busy}>
              {t("refunds.rejectAction")}
            </Button>
          )}
          <Button
            variant={mode === "rejected" ? "danger" : "primary"}
            onClick={() => void submit()}
            loading={busy}
            disabled={!allowed}
            title={allowed ? undefined : t("refunds.noSettlePermission")}
          >
            {mode === "rejected" ? t("refunds.confirmReject") : t("refunds.confirmSettle")}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="rounded-xl bg-slate-50 p-3 text-sm">
          <div className="flex items-center justify-between gap-3">
            <span className="text-slate-500">{t("refunds.refundNumber")}</span>
            <span className="font-mono font-bold text-slate-900">{refund.refund_number}</span>
          </div>
          <div className="mt-1.5 flex items-center justify-between gap-3">
            <span className="text-slate-500">{t("refunds.amount")}</span>
            <span className="font-extrabold tabular-nums text-slate-900">
              {num(refund.amount, 2)}
            </span>
          </div>
          <div className="mt-1.5 flex items-center justify-between gap-3">
            <span className="text-slate-500">{t("returns.saleNumber")}</span>
            <span className="font-mono text-xs text-slate-700">{refund.sale_number}</span>
          </div>
        </div>

        <p className="text-xs leading-relaxed text-slate-600">
          {mode === "rejected" ? t("refunds.rejectHint") : t("refunds.settleHint")}
        </p>

        {!allowed ? (
          <p className="rounded-lg border border-amber-200 bg-amber-50 p-2.5 text-xs font-semibold text-amber-800">
            {t("refunds.noSettlePermission")}
          </p>
        ) : null}

        {mode === "rejected" ? (
          <Field
            label={t("refunds.rejectReason")}
            required
            error={reasonError ?? undefined}
            htmlFor="refund-reject-reason"
          >
            <TextArea
              id="refund-reject-reason"
              value={reason}
              rows={3}
              invalid={Boolean(reasonError)}
              placeholder={t("refunds.rejectReasonPlaceholder")}
              onChange={(e) => setReason(e.target.value)}
            />
          </Field>
        ) : null}
      </div>
    </Modal>
  );
}
