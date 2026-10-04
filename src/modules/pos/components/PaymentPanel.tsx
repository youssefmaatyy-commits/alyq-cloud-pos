import { useEffect, useMemo, useState } from "react";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { Button, TextInput, useToast } from "@/components/ui";
import { ApprovalRequestDialog } from "@/modules/approvals";
import { OpenShiftModal, useShifts } from "@/modules/shifts";
import { usePos } from "../hooks/PosProvider";
import { autoBalanceOther, round2, smartPaymentCalc } from "../services/posMath";
import type { SalePaymentInput } from "../types";

/**
 * Smart split-payment panel — the fixed footer of the Current Sale card.
 *
 * A sale is paid by one to three methods: Cash, InstaPay and/or Visa (card).
 * While split payment is enabled, additional methods become available and
 * entering an amount in any method automatically fills the others with the
 * remaining balance (e.g. Total 1000, Cash 500 → InstaPay 500).
 * The summary always shows Paid, Change and Remaining, and the
 * "Complete sale" button is locked until nothing remains unpaid.
 *
 * Cash may overpay (change is returned); InstaPay and Visa are clamped to
 * the total. Visa is always paid (never pending).
 *
 * The whole section is `flex:none` inside the card: it never scrolls away and
 * never pushes the cart's line list off screen. When split payment expands
 * the form, the three tender boxes sit side by side in ONE row so the footer
 * stays compact on a 768px-till.
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
    connectivityState,
  } = usePos();
  const onlineOnlyTenderBlocked = connectivityState === "offline" || connectivityState === "degraded";

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

  useEffect(() => {
    if (!onlineOnlyTenderBlocked) return;
    setSplit(false);
    setInstapay("");
    setVisa("");
    setInstapayStatus("paid");
  }, [onlineOnlyTenderBlocked]);

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
    <div className="w-full min-w-0 border-t border-stone-100 px-4 py-1.5" data-testid="pos-payment">
      {split ? (
        /* Split tender: cash, InstaPay and Visa side by side in ONE row, so
           the expanded form never eats the cart's scroll area. The quick
           amounts are hidden here — they fill the WHOLE total into cash,
           which is not what a split tender means. */
        <div className="grid gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
          <div className="flex flex-wrap items-center gap-1.5 rounded-xl border border-stone-200 p-1.5">
            <label htmlFor="cash-input" className="shrink-0 text-xs font-bold text-stone-700">
              💵 {t("pos.payment.cash")}
            </label>
            <TextInput
              id="cash-input"
              data-testid="cash-input"
              dir="ltr"
              inputMode="decimal"
              value={cash}
              onChange={(e) => onCashChange(e.target.value)}
              placeholder="0.00"
              className="h-8 min-w-20 flex-1 font-mono text-sm"
            />
          </div>
          <div className="min-w-0 space-y-0.5 rounded-xl border border-stone-200 p-1.5">
            <div className="flex min-w-0 flex-wrap items-center justify-between gap-1.5">
              <label htmlFor="instapay-input" className="shrink-0 text-xs font-bold text-stone-700">
                📱 {t("pos.payment.instapay")}
              </label>
              <div className="flex shrink-0 overflow-hidden rounded-lg bg-stone-100 p-0.5">
                <button
                  type="button"
                  onClick={() => setInstapayStatus("paid")}
                  className={`h-5 whitespace-nowrap rounded px-1 text-[10px] font-bold transition ${
                    instapayStatus === "paid" ? "bg-white text-stone-900 shadow-sm" : "text-stone-500"
                  }`}
                >
                  ✓ {t("pos.instapay.paid")}
                </button>
                <button
                  type="button"
                  onClick={() => setInstapayStatus("pending")}
                  className={`h-5 whitespace-nowrap rounded px-1 text-[10px] font-bold transition ${
                    instapayStatus === "pending" ? "bg-white text-stone-900 shadow-sm" : "text-stone-500"
                  }`}
                >
                  ⏳ {t("pos.instapay.pending")}
                </button>
              </div>
            </div>
            <TextInput
              id="instapay-input"
              data-testid="instapay-input"
              dir="ltr"
              inputMode="decimal"
              value={instapay}
              onChange={(e) => onInstaChange(e.target.value)}
              placeholder="0.00"
              className="h-8 font-mono text-sm"
            />
          </div>
          <div className="flex flex-wrap items-center gap-1.5 rounded-xl border border-stone-200 p-1.5">
            <label htmlFor="visa-input" className="shrink-0 text-xs font-bold text-stone-700">
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
              className="h-8 min-w-20 flex-1 font-mono text-sm"
            />
          </div>
        </div>
      ) : (
        /* Cash-only: the tender field with the quick amounts beside it. */
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-stone-200 p-2">
          <label htmlFor="cash-input" className="shrink-0 text-xs font-bold text-stone-700">
            💵 {t("pos.payment.cash")}
          </label>
          <TextInput
            id="cash-input"
            data-testid="cash-input"
            dir="ltr"
            inputMode="decimal"
            value={cash}
            onChange={(e) => onCashChange(e.target.value)}
            placeholder="0.00"
            className="h-9 min-w-24 flex-1 font-mono text-sm"
          />
          <div className="flex flex-wrap items-center gap-1.5">
            {quickAmounts.map((amount, index) => (
              <button
                key={`${amount}-${index}`}
                type="button"
                onClick={() => onCashChange(amount.toFixed(2))}
                className="h-7 rounded-md border border-stone-200 bg-white px-1.5 text-[10px] font-bold text-stone-600 transition hover:border-[#d4bf9a] hover:bg-[#faf5ec]"
              >
                {index === 0 ? t("pos.exact") : num(amount, 0)}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Split toggle — compact inline switch. The bordered ToggleSwitch is a
          form-row-sized control (~48px); at the register it must not eat the
          cart line list's scrollport. Same contract: a button[role="switch"]
          with the label text in its closest div. */}
      <div className="mt-1 flex items-center justify-between gap-2 rounded-xl border border-stone-200 bg-white px-2.5 py-1">
        <span className="min-w-0 truncate text-xs font-bold text-stone-700">{t("pos.splitPayment")}</span>
        <button
          type="button"
          role="switch"
          aria-checked={split}
          disabled={onlineOnlyTenderBlocked}
          title={onlineOnlyTenderBlocked ? t("pos.offlineCashOnly") : undefined}
          onClick={() => toggleSplit(!split)}
          className={`relative h-5 w-9 shrink-0 rounded-full transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stone-400 disabled:cursor-not-allowed disabled:opacity-40 ${
            split ? "bg-stone-800" : "bg-stone-300"
          }`}
        >
          <span
            className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all ${
              split ? "start-[1.125rem]" : "start-0.5"
            }`}
          />
        </button>
      </div>
      {onlineOnlyTenderBlocked ? <p className="mt-1 rounded-lg bg-amber-50 px-2 py-1 text-[10px] font-semibold text-amber-900">{t("pos.offlineCashOnly")}</p> : null}

      {/* Live summary — always visible, one compact line: who is paying and
          the numbers that decide whether the sale can complete. */}
      <div className="mt-1 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-xl bg-stone-50 px-3 py-1.5 text-xs font-semibold">
        <span className="min-w-0 truncate text-stone-600">
          <span className="font-bold text-stone-800">
            {selectedCustomer ? selectedCustomer.name : t("customers.guestCustomer")}
          </span>
          {selectedCustomer?.phone ? (
            <span className="ms-1.5 font-mono text-[10px] text-stone-500" dir="ltr">
              {selectedCustomer.phone}
            </span>
          ) : null}
        </span>
        <span className="text-stone-600">
          {t("pos.paid")}{" "}
          <span className="font-bold tabular-nums text-stone-900" dir="ltr">{num(calc.paid, 2)}</span>
        </span>
        <span className="text-stone-600">
          {t("pos.change")}{" "}
          <span className="font-bold tabular-nums text-stone-900" dir="ltr">{num(calc.change, 2)}</span>
        </span>
        <span className={calc.remaining === 0 ? "text-emerald-700" : "text-amber-700"}>
          {t("pos.remaining")}{" "}
          <span className="font-bold tabular-nums" dir="ltr">{num(calc.remaining, 2)}</span>
        </span>
      </div>
      {/* Per-method breakdown: how much of the total is covered by each tender. */}
      {split && (calc.instapay > 0 || calc.visa > 0) ? (
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 px-1 text-[11px] text-stone-600">
          <span>
            💵 {t("pos.paidCash")} <span className="tabular-nums" dir="ltr">{num(calc.cashApplied, 2)}</span>
          </span>
          <span>
            📱 {t("pos.paidInstapay")} <span className="tabular-nums" dir="ltr">{num(calc.instapay, 2)}</span>
          </span>
          {calc.visa > 0 ? (
            <span>
              💳 {t("pos.paidVisa")} <span className="tabular-nums" dir="ltr">{num(calc.visa, 2)}</span>
            </span>
          ) : null}
        </div>
      ) : null}

      {calc.remaining > 0 && (cashNum > 0 || (split && (instaNum > 0 || visaNum > 0))) ? (
        <p className="mt-1 text-[11px] font-semibold text-amber-600">{t("pos.underpaid")}</p>
      ) : null}

      {shiftBlocked ? (
        <div
          className="mt-1.5 flex items-center justify-between gap-2 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2"
          role="alert"
        >
          <p className="min-w-0 text-xs font-bold text-amber-900">⏱ {t("pos.shiftRequired")}</p>
          <Button
            variant="secondary"
            size="sm"
            className="h-8 shrink-0 px-2.5 text-xs"
            onClick={() => setShiftModalOpen(true)}
          >
            {t("pos.openShiftAction")}
          </Button>
        </div>
      ) : null}

      {canSell ? (
        <Button
          className="mt-1 w-full"
          size="lg"
          loading={completing}
          disabled={!canComplete}
          onClick={onComplete}
        >
          {completing ? t("pos.completing") : `✓ ${t("pos.complete")}`}
        </Button>
      ) : null}
      {failure ? (
        <p className="mt-1.5 rounded-lg bg-rose-50 px-2.5 py-1.5 text-[11px] font-semibold text-rose-700">
          {failure}
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
