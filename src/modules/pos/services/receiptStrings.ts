import type { TranslationKey } from "@/lib/i18n/I18nProvider";
import type { ReceiptStrings, ReturnReceiptStrings } from "./receipt";

/**
 * Localised receipt labels.
 *
 * Kept in one place so the sales receipt (completed-sale modal + sale detail
 * reprint) and the return receipt (return detail reprint) can never drift
 * apart. The receipt builders themselves stay pure — they only receive strings.
 */

type Translate = (key: TranslationKey, vars?: Record<string, string | number>) => string;

/** Labels shared by the sales receipt, in every entry point that prints one. */
export function salesReceiptStrings(t: Translate): ReceiptStrings {
  return {
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
  };
}

/** Labels for the return receipt. */
export function returnReceiptStrings(
  t: Translate,
  refundStatus: "completed" | "pending" | "rejected",
): ReturnReceiptStrings {
  return {
    businessName: t("receipt.businessName"),
    businessTagline: t("receipt.businessTagline"),
    returnTitle: t("receipt.returnTitle"),
    returnLabel: t("receipt.returnLabel"),
    dateLabel: t("receipt.dateLabel"),
    cashierLabel: t("receipt.cashierLabel"),
    invoiceLabel: t("receipt.originalInvoiceLabel"),
    customerLabel: t("receipt.customerLabel"),
    customerPhoneLabel: t("receipt.customerPhoneLabel"),
    itemLabel: t("receipt.itemLabel"),
    qtyLabel: t("receipt.qtyLabel"),
    priceLabel: t("receipt.priceLabel"),
    refundLabel: t("receipt.refundLabel"),
    totalQtyLabel: t("receipt.totalReturnedQtyLabel"),
    totalRefundLabel: t("receipt.totalRefundLabel"),
    refundMethodLabel: t("receipt.refundMethodLabel"),
    refundNumberLabel: t("receipt.refundNumberLabel"),
    reasonLabel: t("receipt.reasonLabel"),
    statusLabel:
      refundStatus === "completed"
        ? t("receipt.statusCompleted")
        : refundStatus === "rejected"
          ? t("receipt.statusRejected")
          : t("receipt.statusPending"),
    thankYou: t("receipt.returnThankYou"),
  };
}
