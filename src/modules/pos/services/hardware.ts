import { desktopApi, getDesktopConfig } from "@/lib/desktop/bridge";
import type { Sale } from "../types";
import { printHtmlDocument, type PrintOutcome } from "./receipt";

export type ReceiptPrintOutcome = PrintOutcome | "submitted" | "native-failed";

/**
 * One receipt path for web and desktop. Native spool failure is an operational
 * result only: this function has no transaction mutator and never retries a sale.
 */
export async function printReceiptDocument(html: string, reference: string): Promise<ReceiptPrintOutcome> {
  const api = desktopApi();
  if (!api) return printHtmlDocument(html, reference);
  try {
    await api.printReceipt({ html, reference });
    return "submitted";
  } catch (error) {
    console.error("[desktop-print] spool submission failed", {
      reference,
      error: error instanceof Error ? error.message : "Print submission failed",
    });
    return "native-failed";
  }
}

const automaticPrintAttempts = new Set<string>();

export async function isAutomaticReceiptPrintingEnabled(): Promise<boolean> {
  if (!desktopApi()) return false;
  const config = await getDesktopConfig();
  return Boolean(config?.hardware.autoPrintAfterSale && config.hardware.printerName);
}

/** Exactly one automatic spool attempt per completed sale in this renderer. */
export async function autoPrintReceiptDocument(html: string, reference: string): Promise<ReceiptPrintOutcome | "skipped"> {
  const api = desktopApi();
  if (!api || automaticPrintAttempts.has(reference)) return "skipped";
  const config = await getDesktopConfig();
  if (!config?.hardware.autoPrintAfterSale || !config.hardware.printerName || automaticPrintAttempts.has(reference)) return "skipped";
  automaticPrintAttempts.add(reference);
  return printReceiptDocument(html, reference);
}

const drawerAttempts = new Set<string>();

/**
 * Automatic drawer behavior is deliberately narrower than payment: one paid
 * cash allocation, a configured driver job, and one attempt per completed sale.
 * A failure never changes/duplicates/reverses the completed transaction.
 */
export async function openDrawerAfterCashSale(sale: Sale): Promise<"skipped" | "submitted" | "failed"> {
  const api = desktopApi();
  if (!api || drawerAttempts.has(sale.client_ref)) return "skipped";
  const hasPaidCash = sale.payments.some((payment) => payment.method === "cash" && payment.status === "paid" && payment.amount > 0);
  if (!hasPaidCash) return "skipped";
  const config = await getDesktopConfig();
  if (!config?.hardware.autoOpenCashDrawer || config.hardware.drawerMode !== "printer-driver" || drawerAttempts.has(sale.client_ref)) return "skipped";
  drawerAttempts.add(sale.client_ref);
  try {
    await api.kickDrawer({ authorizationRef: sale.id || sale.client_ref, reason: "completed_cash_sale" });
    return "submitted";
  } catch (error) {
    console.error("[desktop-drawer] command submission failed after completed sale", {
      sale_number: sale.sale_number,
      error: error instanceof Error ? error.message : "Drawer submission failed",
    });
    return "failed";
  }
}
