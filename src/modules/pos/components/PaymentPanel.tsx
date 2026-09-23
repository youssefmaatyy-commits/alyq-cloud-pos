import { useEffect, useMemo, useState } from "react";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { Button, TextInput, ToggleSwitch, useToast } from "@/components/ui";
import { ApprovalRequestDialog } from "@/modules/approvals";
import { OpenShiftModal, useShifts } from "@/modules/shifts";
import { usePos } from "../hooks/PosProvider";
import { autoBalanceOther, round2, smartPaymentCalc } from "../services/posMath";
import type { SalePaymentInput } from "../types";

/**
 * Smart split-payment panel.
 *
 * A sale is paid by one to three methods: Cash, InstaPay and/or Visa (card).
 * While split payment is enabled, additional methods become available and
 * entering an amount in any method automatically fills the others with the
 * remaining balance (e.g. Total 1000, Cash 500 → InstaPay 500).
 * The summary always shows Total, Paid, Remaining and Change, and the
 * "Complete sale" button is locked until nothing remains unpaid.
 *
 * Cash may overpay (change is returned); InstaPay and Visa are clamped to
 * the total. Visa is always paid (never pending).
 */
export function PaymentPanel() {
  const { t, num } = useI18n();
  const toast = useToast();
  const {
    totals,
    completeSale,
    completing,
    isEmpty,
    canSell,
    discount,
    approvalAsk,
    dismissApprovalAsk,
    clearCart,
    selectedCustomer,
  } = usePos();

  // A till sale is drawer money: it needs an open shift to land in (Phase 27).
  // The gate shows the moment the shift list has loaded with nothing open, so
  // the register tells the cashier to open one instead of failing on submit —
  // and the database still enforces the same rule server-side (0040).
  const { openShift, loading: shiftsLoading, refresh: refreshShifts } = useShifts();
  const [shiftModalOpen, setShiftModalOpen] = useState(false);
  const shiftBlocked = !shiftsLoading && openShift === null;

  const [split, setSplit] = useState(false);
  const [cash, setCash] = useState("");
  const [instapay, setInstapay] = useState("");
  const [visa, setVisa] = useState("");
  const [instapayStatus, setInstapayStatus] = useState<"paid" | "pending">("paid");

  // Reset between sales (cart emptied).
  useEffect(() => {
    if (isEmpty) {
      setSplit(false);
      setCash("");
      setInstapay("");
      setVisa("");
      setInstapayStatus("paid");
    }
  }, [isEmpty]);

  const total = totals.total;
  const cashNum = round2(Number(cash) || 0);
  const instaNum = round2(Number(instapay) || 0);
  const visaNum = round2(Number(visa) || 0);
  const calc = useMemo(
    () => smartPaymentCalc(total, cashNum, split ? instaNum : 0, split ? visaNum : 0),
    [total, cashNum, instaNum, visaNum, split],
  );

  // ── auto-balance: last-edited field wins, the other fills the remainder ──
  const onCashChange = (value: string) => {
    setCash(value);
    if (split) {
      const entered = round2(Number(value) || 0);
      const other = autoBalanceOther(total, entered);
      setInstapay(other === 0 ? "" : String(other));
    }
  };

  const onInstaChange = (value: string) => {
    setInstapay(value);
    const entered = Math.min(round2(Number(value) || 0), total);
    const other = autoBalanceOther(total, entered);
    setCash(other === 0 ? "" : String(other));
  };

  const toggleSplit = (on: boolean) => {
    setSplit(on);
    // Switching to split re-balances: instapay takes over the uncovered part.
    if (on && cashNum > 0) {
      const other = autoBalanceOther(total, cashNum);
      setInstapay(other === 0 ? "" : String(other));
    } else if (!on) {
      setInstapay("");
    }
  };

  // ── build the authoritative payments from the live calculation ──
  const payments: SalePaymentInput[] = useMemo(() => {
    const list: SalePaymentInput[] = [];
    if (calc.cashApplied > 0) {
      list.push({
        method: "cash",
        amount: calc.cashApplied,
        status: "paid",
        tendered: calc.cashTendered,
      });
    }
    if (calc.instapay > 0) {
      list.push({ method: "instapay", amount: calc.instapay, status: instapayStatus });
    }
    if (calc.visa > 0) {
      list.push({ method: "visa", amount: calc.visa, status: "paid" });
    }
    return list;
  }, [calc.cashApplied, calc.cashTendered, calc.instapay, calc.visa, instapayStatus]);

  const balanced = calc.remaining === 0 && payments.length > 0;
  const canComplete = !isEmpty && !completing && canSell && balanced && !shiftBlocked;

  const quickAmounts = useMemo(
    () => [total, Math.ceil(total / 5) * 5, Math.ceil(total / 10) * 10, Math.ceil(total / 50) * 50],
    [total],
  );

  const [failure, setFailure] = useState<string | null>(null);

  const onComplete = async () => {
    if (!canComplete) return;
    setFailure(null);
    try {
      // `null` means the discount crossed an approval limit: nothing was
      // written, and `approvalAsk` now carries the draft the register can send
      // for approval instead.
      await completeSale(payments);
    } catch (err) {
      // The race where the shift closes between render and submit: the RPC
      // (or the demo repository) is the authority, and its code comes back
      // here — surface the same message the gate shows.
      if ((err as { code?: string } | null)?.code === "SHIFT_REQUIRED") {
        setFailure(t("pos.shiftRequired"));
        toast.error(t("pos.shiftRequired"));
        void refreshShifts();
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      setFailure(message);
      toast.error(message);
    }
  };

  return (
    <div className="rounded-2xl border border-stone-200 bg-white p-4">
      <div className="mb-3 flex items-center justify-between">
        <p className="text-[11px] font-bold uppercase tracking-wider text-stone-600">
          {t("pos.payment")}
        </p>
        <span className="text-lg font-extrabold tabular-nums text-stone-900">
          {num(total, 2)}
        </span>
      </div>

      {/* Who the sale is for — chosen in the cart, shown here so it cannot
          be missed before money moves. Walk-in stays a first-class value. */}
      <div className="mb-3 flex items-center gap-2 rounded-lg bg-stone-50 px-2.5 py-1.5">
        <span className="text-[11px] font-bold uppercase tracking-wider text-stone-500">
          {t("pos.customer")}
        </span>
        <span className="min-w-0 flex-1 truncate text-xs font-semibold text-stone-800">
          {selectedCustomer ? selectedCustomer.name : t("customers.guestCustomer")}
        </span>
        {selectedCustomer ? (
          <span className="font-mono text-[10px] text-stone-500" dir="ltr">
            {selectedCustomer.phone}
          </span>
        ) : null}
      </div>

      {/* Cash */}
      <div className="space-y-1.5 rounded-xl border border-stone-200 p-2.5">
        <div className="flex items-center justify-between gap-2">
          <label
            htmlFor="cash-input"
            className="text-xs font-bold text-stone-700"
          >
            💵 {t("pos.payment.cash")}
          </label>
          <div className="flex items-center gap-1.5">
            {quickAmounts.map((amount, index) => (
              <button
                key={`${amount}-${index}`}
                type="button"
                onClick={() => onCashChange(amount.toFixed(2))}
                className="h-6 rounded-md border border-stone-200 bg-white px-1.5 text-[10px] font-bold text-stone-600 transition hover:border-[#d4bf9a] hover:bg-[#faf5ec]"
              >
                {index === 0 ? t("pos.exact") : num(amount, 0)}
              </button>
            ))}
          </div>
        </div>
        <TextInput
          id="cash-input"
          data-testid="cash-input"
          dir="ltr"
          inputMode="decimal"
          value={cash}
          onChange={(e) => onCashChange(e.target.value)}
          placeholder="0.00"
          className="h-10 font-mono text-sm"
        />
      </div>

      {/* Split toggle + InstaPay */}
      <div className="mt-2">
        <ToggleSwitch
          label={t("pos.splitPayment")}
          hint={t("pos.splitPaymentHint")}
          checked={split}
          onChange={toggleSplit}
        />
      </div>

      {split ? (
        <div className="mt-2 space-y-2">
          <div className="space-y-1.5 rounded-xl border border-stone-200 p-2.5">
            <label htmlFor="instapay-input" className="text-xs font-bold text-stone-700">
              📱 {t("pos.payment.instapay")}
            </label>
            <TextInput
              id="instapay-input"
              data-testid="instapay-input"
              dir="ltr"
              inputMode="decimal"
              value={instapay}
              onChange={(e) => onInstaChange(e.target.value)}
              placeholder="0.00"
              className="h-10 font-mono text-sm"
            />
            <div className="grid grid-cols-2 gap-1 rounded-lg bg-stone-100 p-0.5">
              <button
                type="button"
                onClick={() => setInstapayStatus("paid")}
                className={`h-8 rounded-md text-xs font-bold transition ${
                  instapayStatus === "paid" ? "bg-white text-stone-900 shadow-sm" : "text-stone-500"
                }`}
              >
                ✓ {t("pos.instapay.paid")}
              </button>
              <button
                type="button"
                onClick={() => setInstapayStatus("pending")}
                className={`h-8 rounded-md text-xs font-bold transition ${
                  instapayStatus === "pending" ? "bg-white text-stone-900 shadow-sm" : "text-stone-500"
                }`}
              >
                ⏳ {t("pos.instapay.pending")}
              </button>
            </div>
          </div>

          {/* Visa / Card */}
          <div className="space-y-1.5 rounded-xl border border-stone-200 p-2.5">
            <label htmlFor="visa-input" className="text-xs font-bold text-stone-700">
              💳 {t("pos.payment.visa")}
            </label>
            <TextInput
              id="visa-input"
              data-testid="visa-input"
              dir="ltr"
              inputMode="decimal"
              value={visa}
              onChange={(e) => setVisa(e.target.value)}
              placeholder="0.00"
              className="h-10 font-mono text-sm"
            />
          </div>
        </div>
      ) : null}

      {/* Live summary — always visible */}
      <div className="mt-3 space-y-1.5 rounded-xl bg-stone-50 px-3 py-2.5 text-sm">
        <div className="flex justify-between font-bold text-stone-900">
          <span>{t("pos.total")}</span>
          <span className="tabular-nums">{num(total, 2)}</span>
        </div>
        {/* Per-method breakdown: how much of the total is covered by each tender. */}
        <div className="space-y-1 rounded-lg bg-white/70 px-2.5 py-1.5">
          <div className="flex justify-between text-stone-600">
            <span>💵 {t("pos.paidCash")}</span>
            <span className="tabular-nums">{num(calc.cashApplied, 2)}</span>
          </div>
          <div className="flex justify-between text-stone-600">
            <span>📱 {t("pos.paidInstapay")}</span>
            <span className="tabular-nums">{num(calc.instapay, 2)}</span>
          </div>
          {calc.visa > 0 ? (
            <div className="flex justify-between text-stone-600">
              <span>💳 {t("pos.paidVisa")}</span>
              <span className="tabular-nums">{num(calc.visa, 2)}</span>
            </div>
          ) : null}
        </div>
        <div className="flex justify-between border-t border-stone-200 pt-1.5 font-semibold text-stone-800">
          <span>{t("pos.paid")}</span>
          <span className="tabular-nums">{num(calc.paid, 2)}</span>
        </div>
        <div className="flex justify-between text-stone-600">
          <span>{t("pos.change")}</span>
          <span className="tabular-nums">{num(calc.change, 2)}</span>
        </div>
        <div
          className={`flex justify-between font-bold ${
            calc.remaining === 0 ? "text-emerald-700" : "text-amber-700"
          }`}
        >
          <span>{t("pos.remaining")}</span>
          <span className="tabular-nums">{num(calc.remaining, 2)}</span>
        </div>
      </div>

      {calc.remaining > 0 ? (
        <p className="mt-1.5 text-[11px] font-semibold text-amber-600">{t("pos.underpaid")}</p>
      ) : null}

      {shiftBlocked ? (
        <div className="mt-3 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2.5" role="alert">
          <p className="text-xs font-bold text-amber-900">⏱ {t("pos.shiftRequired")}</p>
          <Button
            variant="secondary"
            size="sm"
            className="mt-2 w-full"
            onClick={() => setShiftModalOpen(true)}
          >
            {t("pos.openShiftAction")}
          </Button>
        </div>
      ) : null}

      <Button
        className="mt-3 w-full"
        size="lg"
        loading={completing}
        disabled={!canComplete}
        onClick={onComplete}
      >
        {completing ? t("pos.completing") : `✓ ${t("pos.complete")}`}
      </Button>
      {failure ? (
        <p className="mt-1.5 rounded-lg bg-rose-50 px-2.5 py-1.5 text-[11px] font-semibold text-rose-700">
          {failure}
        </p>
      ) : null}
      {!canSell ? (
        <p className="mt-1 text-center text-[11px] font-semibold text-rose-600">
          {t("pos.discountLocked")}
        </p>
      ) : null}

      {/* Phase 12: the discount is above the cap this seat may apply alone. The
          sale was not written — send it for approval, or lower the discount and
          ring it up now. */}
      {approvalAsk ? (
        <ApprovalRequestDialog
          open
          requirement={approvalAsk.requirement}
          entityType="sale"
          entityLabel={t("pos.discountApprovalLabel")}
          previousValue={{ discount_percent: 0 }}
          newValue={{
            discount_percent: approvalAsk.requirement.amount,
            total: round2(totals.total),
          }}
          payload={approvalAsk.input as unknown as Record<string, unknown>}
          summary={`${t("pos.discount")}: ${
            discount.type === "percent" ? `${num(discount.value, 2)}%` : num(discount.value, 2)
          } · ${t("pos.total")}: ${num(totals.total, 2)}`}
          onFiled={() => {
            clearCart();
            dismissApprovalAsk();
          }}
          onClose={dismissApprovalAsk}
        />
      ) : null}

      {shiftModalOpen ? (
        <OpenShiftModal
          open
          onClose={() => {
            setShiftModalOpen(false);
            void refreshShifts();
          }}
        />
      ) : null}
    </div>
  );
}
