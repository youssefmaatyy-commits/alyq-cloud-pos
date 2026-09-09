import { useEffect, useMemo, useState } from "react";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { Button, TextInput, ToggleSwitch } from "@/components/ui";
import { usePos } from "../hooks/PosProvider";
import { autoBalanceOther, round2, smartPaymentCalc } from "../services/posMath";
import type { SalePaymentInput } from "../types";

/**
 * Smart split-payment panel.
 *
 * A sale is paid by one or two methods: Cash and/or InstaPay. While split
 * payment is enabled, entering an amount in either method automatically fills
 * the other with the remaining balance (e.g. Total 1000, Cash 500 → InstaPay
 * 500). The summary always shows Total, Paid, Remaining and Change, and the
 * "Complete sale" button is locked until nothing remains unpaid.
 *
 * Cash may overpay (change is returned); InstaPay is clamped to the total.
 */
export function PaymentPanel() {
  const { t, num } = useI18n();
  const { totals, completeSale, completing, isEmpty, canSell } = usePos();

  const [split, setSplit] = useState(false);
  const [cash, setCash] = useState("");
  const [instapay, setInstapay] = useState("");
  const [instapayStatus, setInstapayStatus] = useState<"paid" | "pending">("paid");

  // Reset between sales (cart emptied).
  useEffect(() => {
    if (isEmpty) {
      setSplit(false);
      setCash("");
      setInstapay("");
      setInstapayStatus("paid");
    }
  }, [isEmpty]);

  const total = totals.total;
  const cashNum = round2(Number(cash) || 0);
  const instaNum = round2(Number(instapay) || 0);
  const calc = useMemo(
    () => smartPaymentCalc(total, cashNum, split ? instaNum : 0),
    [total, cashNum, instaNum, split],
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
    return list;
  }, [calc.cashApplied, calc.cashTendered, calc.instapay, instapayStatus]);

  const balanced = calc.remaining === 0 && payments.length > 0;
  const canComplete = !isEmpty && !completing && canSell && balanced;

  const quickAmounts = useMemo(
    () => [total, Math.ceil(total / 5) * 5, Math.ceil(total / 10) * 10, Math.ceil(total / 50) * 50],
    [total],
  );

  const onComplete = async () => {
    if (!canComplete) return;
    await completeSale(payments);
  };

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4">
      <div className="mb-3 flex items-center justify-between">
        <p className="text-[11px] font-bold uppercase tracking-wider text-slate-600">
          {t("pos.payment")}
        </p>
        <span className="text-lg font-extrabold tabular-nums text-slate-900">
          {num(total, 2)}
        </span>
      </div>

      {/* Cash */}
      <div className="space-y-1.5 rounded-xl border border-slate-200 p-2.5">
        <div className="flex items-center justify-between gap-2">
          <label
            htmlFor="cash-input"
            className="text-xs font-bold text-slate-700"
          >
            💵 {t("pos.payment.cash")}
          </label>
          <div className="flex items-center gap-1.5">
            {quickAmounts.map((amount, index) => (
              <button
                key={`${amount}-${index}`}
                type="button"
                onClick={() => onCashChange(amount.toFixed(2))}
                className="h-6 rounded-md border border-slate-200 bg-white px-1.5 text-[10px] font-bold text-slate-600 transition hover:border-indigo-300 hover:bg-indigo-50"
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
        <div className="mt-2 space-y-1.5 rounded-xl border border-slate-200 p-2.5">
          <label htmlFor="instapay-input" className="text-xs font-bold text-slate-700">
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
          <div className="grid grid-cols-2 gap-1 rounded-lg bg-slate-100 p-0.5">
            <button
              type="button"
              onClick={() => setInstapayStatus("paid")}
              className={`h-8 rounded-md text-xs font-bold transition ${
                instapayStatus === "paid" ? "bg-white text-slate-900 shadow-sm" : "text-slate-500"
              }`}
            >
              ✓ {t("pos.instapay.paid")}
            </button>
            <button
              type="button"
              onClick={() => setInstapayStatus("pending")}
              className={`h-8 rounded-md text-xs font-bold transition ${
                instapayStatus === "pending" ? "bg-white text-slate-900 shadow-sm" : "text-slate-500"
              }`}
            >
              ⏳ {t("pos.instapay.pending")}
            </button>
          </div>
        </div>
      ) : null}

      {/* Live summary — always visible */}
      <div className="mt-3 space-y-1.5 rounded-xl bg-slate-50 px-3 py-2.5 text-sm">
        <div className="flex justify-between text-slate-600">
          <span>{t("pos.total")}</span>
          <span className="tabular-nums">{num(total, 2)}</span>
        </div>
        <div className="flex justify-between text-slate-600">
          <span>{t("pos.paid")}</span>
          <span className="tabular-nums">{num(calc.paid, 2)}</span>
        </div>
        <div className="flex justify-between text-slate-600">
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

      <Button
        className="mt-3 w-full"
        size="lg"
        loading={completing}
        disabled={!canComplete}
        onClick={onComplete}
      >
        {completing ? t("pos.completing") : `✓ ${t("pos.complete")}`}
      </Button>
      {!canSell ? (
        <p className="mt-1 text-center text-[11px] font-semibold text-rose-600">
          {t("pos.discountLocked")}
        </p>
      ) : null}
    </div>
  );
}
