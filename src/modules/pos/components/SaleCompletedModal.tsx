import { useI18n } from "@/lib/i18n/I18nProvider";
import { Button, Modal, useToast } from "@/components/ui";
import { usePos } from "../hooks/PosProvider";
import { buildReceiptHtml, customerInfoIssue, printHtmlDocument } from "../services/receipt";

/**
 * Shown after a successful sale: the sale number, totals and a print action.
 * "New sale" clears the cart and closes the dialog; printing opens the
 * printable receipt via the shared print workflow (popup, with a hidden
 * in-page frame fallback — see `printHtmlDocument`).
 */
export function SaleCompletedModal() {
  const { t, num } = useI18n();
  const { completedSale, dismissCompleted } = usePos();
  const toast = useToast();

  if (!completedSale) return null;

  const printReceipt = () => {
    if (!completedSale.sale_number || !completedSale.items?.length) {
      console.error("[receipt-print] abort: no completed sale / receipt data", { completedSale });
      toast.error(t("pos.printFailed"));
      return;
    }

    // Customer-linked receipts must carry BOTH the customer name and phone.
    // Anonymous/guest sales have neither and keep their existing behaviour.
    const customerIssue = customerInfoIssue(
      completedSale.customer_name,
      completedSale.customer_phone,
    );
    if (customerIssue) {
      console.error("[receipt-print] abort: incomplete customer information", {
        sale_number: completedSale.sale_number,
        issue: customerIssue,
        customer_name: completedSale.customer_name ?? null,
        customer_phone: completedSale.customer_phone ?? null,
      });
      toast.error(
        t(customerIssue === "missingName" ? "receipt.customerNameMissing" : "receipt.customerPhoneMissing"),
      );
      return;
    }

    // On-screen confirmation that the handler ran and printing is attempted.
    // This toast renders inside the app, so it is visible even when the app
    // runs in a sandboxed iframe whose console is not accessible.
    toast.success(t("pos.printing"));

    const isRTL = document.documentElement.getAttribute("dir") === "rtl";
    let html: string;
    try {
      html = buildReceiptHtml({
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
    } catch (err) {
      console.error("[receipt-print] failed to build receipt html", {
        sale_number: completedSale.sale_number,
        error: err instanceof Error ? err.message : err,
      });
      toast.error(t("pos.printFailed"));
      return;
    }

    const outcome = printHtmlDocument(html, completedSale.sale_number);
    if (outcome === "embedded-blocked") {
      toast.error(t("pos.printEmbedded"));
    } else if (outcome === "failed") {
      toast.error(t("barcode.printBlocked"));
    }
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
