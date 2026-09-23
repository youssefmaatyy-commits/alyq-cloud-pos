import { useEffect, useMemo, useState } from "react";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { Badge, Button, Field, Modal, TextArea, TextInput, useToast } from "@/components/ui";
import { getCurrentUser } from "@/modules/inventory/permissions";
import { useShifts } from "../hooks/ShiftProvider";
import { EMPTY_CLOSE_SHIFT_FORM, type CloseShiftFormValues, type Shift } from "../types";
import { parseMoney, validateCloseDraft } from "../validation";
import { differenceTone } from "../services/shiftCalculations";
import { ShiftSummaryGrid } from "./ShiftSummaryGrid";

export interface CloseShiftModalProps {
  shift: Shift | null;
  open: boolean;
  onClose: () => void;
}

type CloseStep = "count" | "confirm";

const TILE =
  "rounded-xl border border-[#e7ded1] bg-[#faf7f2] px-3 py-2 text-[#1c1917]";

export function CloseShiftModal({ shift, open, onClose }: CloseShiftModalProps) {
  const { t, num, money } = useI18n();
  const toast = useToast();
  const { closeShiftAction, summaryFor } = useShifts();
  const user = getCurrentUser();

  const [values, setValues] = useState<CloseShiftFormValues>(EMPTY_CLOSE_SHIFT_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [step, setStep] = useState<CloseStep>("count");

  const summary = useMemo(() => summaryFor(shift), [summaryFor, shift]);

  useEffect(() => {
    if (open) {
      setValues(EMPTY_CLOSE_SHIFT_FORM);
      setAttempted(false);
      setFormError(null);
      setStep("count");
    }
  }, [open]);

  const errors = attempted ? validateCloseDraft(values) : {};
  const counted = parseMoney(values.closing_cash);
  const liveDifference = Number.isFinite(counted) && summary ? counted - summary.expected_cash : null;

  function review() {
    setAttempted(true);
    const nextErrors = validateCloseDraft(values);
    if (Object.keys(nextErrors).length > 0 || !shift) return;
    setStep("confirm");
  }

  async function submit() {
    setAttempted(true);
    const nextErrors = validateCloseDraft(values);
    if (Object.keys(nextErrors).length > 0 || !shift) return;
    if (step !== "confirm") {
      setStep("confirm");
      return;
    }
    setSubmitting(true);
    setFormError(null);
    try {
      const closed = await closeShiftAction(shift, {
        closing_cash: parseMoney(values.closing_cash),
        notes: values.notes,
        closed_by: user.id,
        closed_by_name: user.name,
      });
      const difference = closed.summary?.difference ?? 0;
      toast.success(
        difference === 0
          ? `${t("shifts.closedToast")} · ${closed.shift_number} · ${t("shifts.balanced")}`
          : `${t("shifts.closedToast")} · ${closed.shift_number} · ${t("shifts.difference")} ${num(difference, 2)}`,
      );
      onClose();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  if (!shift) return null;

  const confirming = step === "confirm";

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title={`${confirming ? t("shifts.closeReviewTitle") : t("shifts.closeTitle")} · ${shift.shift_number}`}
      footer={
        <>
          {confirming ? (
            <Button variant="secondary" onClick={() => setStep("count")} disabled={submitting}>
              {t("common.back")}
            </Button>
          ) : (
            <Button variant="secondary" onClick={onClose} disabled={submitting}>
              {t("common.cancel")}
            </Button>
          )}
          {confirming ? (
            <Button onClick={() => void submit()} disabled={submitting}>
              {submitting ? t("common.saving") : t("shifts.closeConfirm")}
            </Button>
          ) : (
            <Button onClick={review} disabled={submitting}>
              {t("shifts.closeReview")}
            </Button>
          )}
        </>
      }
    >
      <div className="space-y-4">
        <p className="rounded-xl bg-[#faf7f2] px-3 py-2 text-xs text-[#1c1917]">
          {confirming ? t("shifts.closeReviewHint") : t("shifts.closeConfirmHint")}
        </p>

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <div className={TILE}>
            <p className="text-[11px] font-bold text-[#b08d57]">{t("shifts.openingBalance")}</p>
            <p className="text-lg font-extrabold tabular-nums" dir="ltr">
              {money(shift.opening_cash)}
            </p>
          </div>
          <div className={TILE}>
            <p className="text-[11px] font-bold text-emerald-800">{t("shifts.cashSales")}</p>
            <p className="text-lg font-extrabold tabular-nums text-emerald-900" dir="ltr">
              {money(summary?.cash_sales ?? 0)}
            </p>
          </div>
          <div className={TILE}>
            <p className="text-[11px] font-bold text-rose-800">{t("shifts.cashRefunds")}</p>
            <p className="text-lg font-extrabold tabular-nums text-rose-900" dir="ltr">
              {money(summary?.cash_refunds ?? 0)}
            </p>
          </div>
          <div className={TILE}>
            <p className="text-[11px] font-bold text-amber-800">{t("shifts.cashExpenses")}</p>
            <p className="text-lg font-extrabold tabular-nums text-amber-900" dir="ltr">
              {money(summary?.cash_expenses ?? 0)}
            </p>
          </div>
          <div className="rounded-xl border border-[#b08d57] bg-white px-3 py-2 text-[#1c1917]">
            <p className="text-[11px] font-bold text-[#b08d57]">{t("shifts.expectedCash")}</p>
            <p className="text-lg font-extrabold tabular-nums" dir="ltr">
              {money(summary?.expected_cash ?? 0)}
            </p>
          </div>
          <div className="rounded-xl border border-[#1c1917] bg-white px-3 py-2 text-[#1c1917]">
            <p className="text-[11px] font-bold">{t("shifts.actualCash")}</p>
            <p className="text-lg font-extrabold tabular-nums" dir="ltr">
              {Number.isFinite(counted) ? money(counted) : "—"}
            </p>
          </div>
        </div>

        {summary ? <ShiftSummaryGrid summary={summary} compact /> : null}

        {!confirming ? (
          <Field
            label={t("shifts.closingCash")}
            required
            error={errors.closing_cash ? t(errors.closing_cash as Parameters<typeof t>[0]) : undefined}
            hint={t("shifts.closingCashHint")}
          >
            <TextInput
              value={values.closing_cash}
              invalid={Boolean(errors.closing_cash)}
              onChange={(e) => setValues((v) => ({ ...v, closing_cash: e.target.value }))}
              inputMode="decimal"
              dir="ltr"
              placeholder="0.00"
              autoFocus
            />
          </Field>
        ) : null}

        <div className="flex items-center justify-between rounded-xl border border-[#e7ded1] bg-white px-3 py-2">
          <span className="text-xs font-bold text-[#1c1917]">{t("shifts.difference")}</span>
          <Badge tone={differenceTone(liveDifference)}>
            {liveDifference === null
              ? "—"
              : `${num(liveDifference, 2)} · ${
                  liveDifference === 0
                    ? t("shifts.balanced")
                    : liveDifference > 0
                      ? t("shifts.over")
                      : t("shifts.short")
                }`}
          </Badge>
        </div>

        <Field label={t("shifts.notes")} error={errors.notes ? t(errors.notes as Parameters<typeof t>[0]) : undefined}>
          <TextArea
            value={values.notes}
            invalid={Boolean(errors.notes)}
            onChange={(e) => setValues((v) => ({ ...v, notes: e.target.value }))}
            placeholder={t("shifts.notesPlaceholder")}
            rows={3}
            readOnly={confirming}
          />
        </Field>

        {formError ? (
          <p className="rounded-xl bg-rose-50 px-3 py-2 text-xs text-rose-700">{formError}</p>
        ) : null}
      </div>
    </Modal>
  );
}
