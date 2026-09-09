import { useI18n } from "@/lib/i18n/I18nProvider";
import { Button, Modal } from "@/components/ui";
import { usePos } from "../hooks/PosProvider";
import { buildReceiptHtml } from "../services/receipt";

/**
 * Shown after a successful sale: the sale number, totals and a print action.
 * "New sale" clears the cart and closes the dialog; printing opens the
 * printable receipt in a popup window.
 */
export function SaleCompletedModal() {
  const { t, num } = useI18n();
  const { completedSale, dismissCompleted } = usePos();

  if (!completedSale) return null;

  const printReceipt = () => {
    // The printable HTML is assembled on demand so it stays in sync with the
    // finalised sale record (not the in-memory cart).
    const w = window.open("", "_blank", "width=420,height=640");
    if (!w) return;
    const isRTL = document.documentElement.getAttribute("dir") === "rtl";
    const html = buildReceiptHtml({
      sale: completedSale,
      direction: isRTL ? "rtl" : "ltr",
      strings: {
        businessName: t("receipt.businessName"),
        businessTagline: t("receipt.businessTagline"),
        saleLabel: t("receipt.saleLabel"),
        dateLabel: t("receipt.dateLabel"),
        cashierLabel: t("receipt.cashierLabel"),
        itemLabel: t("receipt.itemLabel"),
        qtyLabel: t("receipt.qtyLabel"),
        priceLabel: t("receipt.priceLabel"),
        totalLabel: t("receipt.totalLabel"),
        subtotalLabel: t("receipt.subtotalLabel"),
        discountLabel: t("receipt.discountLabel"),
        paymentLabel: t("receipt.paymentLabel"),
        receivedLabel: t("receipt.receivedLabel"),
        changeLabel: t("receipt.changeLabel"),
        customerLabel: t("receipt.customerLabel"),
        customerPhoneLabel: t("receipt.customerPhoneLabel"),
        paidLabel: t("pos.paid"),
        remainingLabel: t("pos.remaining"),
        statusLabel: t("receipt.statusLabel"),
        thankYou: t("receipt.thankYou"),
        voidedNotice: t("receipt.voidedNotice"),
      },
    });
    w.document.open();
    w.document.write(html);
    w.document.close();
  };

  return (
    <Modal
      open={Boolean(completedSale)}
      onClose={dismissCompleted}
      title={t("pos.saleCompleted")}
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={dismissCompleted}>
            {t("pos.newSale")}
          </Button>
          <Button onClick={printReceipt}>🖨 {t("pos.printReceipt")}</Button>
        </>
      }
    >
      <div className="space-y-3 text-center">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-emerald-50 text-2xl">
          ✓
        </div>
        <div>
          <p className="text-lg font-extrabold tracking-wide text-slate-900">
            {completedSale.sale_number}
          </p>
          <p className="mt-1 text-2xl font-extrabold tabular-nums text-slate-900">
            {num(completedSale.total, 2)}
          </p>
          <div className="mt-2 flex flex-wrap items-center justify-center gap-1.5">
            {completedSale.payments.map((p) => (
              <span
                key={p.id}
                className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-700"
              >
                {t(`pos.payment.${p.method}`)} · {num(p.amount, 2)}
                {p.method === "instapay" && p.status === "pending"
                  ? ` · ${t("pos.instapay.pending")}`
                  : ""}
              </span>
            ))}
          </div>
          {completedSale.change != null ? (
            <p className="mt-1 text-xs font-semibold text-slate-500">
              {t("pos.change")}: {num(completedSale.change, 2)}
            </p>
          ) : null}
        </div>
      </div>
    </Modal>
  );
}
