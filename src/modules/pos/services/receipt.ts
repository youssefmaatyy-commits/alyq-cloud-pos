import { encodeCode128, barcodeToSvgString, escapeXml } from "./barcodeHelpers";
import { round2 } from "./posMath";
import type { Sale } from "../types";
import alyqLogoUrl from "@/assets/alyq-logo.png";

/**
 * Printable receipt builders — ALYQ boutique edition.
 *
 * Pure: each builder takes a record and returns a self-contained HTML document.
 * The only untestable step (window.open / print) lives in `printHtmlDocument`,
 * which is shared by the sales receipt and the return receipt.
 *
 * Design goals (thermal 58mm / 80mm):
 * - compact: tight paddings, 10–11px body type, hairline separators
 * - boutique minimal: centered official logo, serif brand line, small-caps tagline
 * - scannable: Code 128 symbol sized to fit 58mm media, never mirrored in RTL
 */

/** Official ALYQ logo — imported as a Vite asset so the singlefile build
 *  inlines it as a data URL (works offline / in standalone HTML). */
export const RECEIPT_LOGO_SRC = alyqLogoUrl;

/** Contact footer — English labels exactly as specified by the brand. */
export const RECEIPT_CONTACTS = [
  { label: "WhatsApp", value: "0150 0221712" },
  { label: "Facebook", value: "ALYQ.eg" },
  { label: "Instagram", value: "@alyq.eg" },
  { label: "TikTok", value: "@alyq.eg" },
] as const;

/**
 * Display name for a payment method. Cash + InstaPay are the live POS methods;
 * Visa (and any future method) renders sensibly without changing payment logic.
 * Also handles a mixed list (e.g. "cash,instapay") so split refunds render.
 */
export function paymentMethodDisplayName(method: string): string {
  const parts = String(method)
    .split(/[,+]/)
    .map((m) => m.trim())
    .filter(Boolean);
  if (parts.length > 1) {
    return parts.map((p) => paymentMethodDisplayName(p)).join(" + ");
  }
  if (method === "cash") return "Cash";
  if (method === "visa") return "Visa";
  if (method === "instapay") return "InstaPay";
  return method.charAt(0).toUpperCase() + method.slice(1);
}

// ═══════════════════════════════════════════════════════════════════════════
// Customer information on receipts
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Why a customer-linked receipt may not be printed yet.
 * - `missingName`  — a customer is linked but the name is absent
 * - `missingPhone` — a customer is linked but the phone is absent
 * - `null`         — fine (either fully populated, or an anonymous/guest
 *                    transaction which keeps its existing behaviour)
 */
export type CustomerInfoIssue = "missingName" | "missingPhone" | null;

/**
 * A receipt is customer-linked when it carries a customer name or phone.
 * Customer-linked receipts must show BOTH the name and the phone; anonymous
 * (guest) receipts have neither and are always allowed.
 */
export function customerInfoIssue(
  customerName: string | null | undefined,
  customerPhone: string | null | undefined,
): CustomerInfoIssue {
  const hasName = Boolean(customerName && customerName.trim());
  const hasPhone = Boolean(customerPhone && customerPhone.trim());
  if (!hasName && !hasPhone) return null; // guest sale — unchanged behaviour
  if (!hasName) return "missingName";
  if (!hasPhone) return "missingPhone";
  return null;
}

export interface ReceiptStrings {
  businessName: string;
  /** Rendered under the wordmark only when a merchant sets one. */
  businessTagline?: string;
  saleLabel: string;
  dateLabel: string;
  cashierLabel: string;
  itemLabel: string;
  qtyLabel: string;
  priceLabel: string;
  totalLabel: string;
  subtotalLabel: string;
  discountLabel: string;
  paymentLabel: string;
  receivedLabel: string;
  changeLabel: string;
  paidLabel: string;
  remainingLabel: string;
  customerLabel: string;
  customerPhoneLabel: string;
  statusLabel: string;
  thankYou: string;
  voidedNotice: string;
}

/** Localised labels assembled from the dictionary, so the service stays pure. */
export interface ReceiptData {
  sale: Sale;
  strings: ReceiptStrings;
  direction: "rtl" | "ltr";
}

// ═══════════════════════════════════════════════════════════════════════════
// Shared receipt pieces — used by BOTH the sales and return receipts so the
// design, typography, spacing and print workflow never diverge.
// ═══════════════════════════════════════════════════════════════════════════

/** Shared receipt stylesheet — the single source of truth for every receipt. */
function receiptCss(rtl: boolean): string {
  const align = rtl ? "right" : "left";
  return `<style>
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 10px;
    background: #f8fafc;
    font-family: "Inter", "Noto Kufi Arabic", "Segoe UI", Tahoma, system-ui, sans-serif;
    color: #111;
    display: flex;
    justify-content: center;
  }
  .receipt {
    width: 100%;
    max-width: 76mm;
    background: #fff;
    padding: 6px 8px 8px;
    border: 1px solid #e2e8f0;
  }
  .brand { text-align: center; margin: 0 0 3px; }
  .brand .logo { display: block; width: 118px; max-width: 58%; height: auto; margin: 0 auto 2px; }
  .brand .bname { font-family: Georgia, "Times New Roman", serif; font-size: 14px; font-weight: 700; color: #111; }
  .brand .btag { font-size: 8px; letter-spacing: 3px; text-transform: uppercase; color: #555; margin-top: 1px; }
  .sep { border-top: 1px solid #e8e8e8; margin: 5px 0; }
  .headline { display: flex; justify-content: space-between; gap: 8px; font-size: 10.5px; margin: 1px 0; }
  .headline .k { color: #555; font-weight: 600; }
  table { width: 100%; border-collapse: collapse; font-size: 10.5px; }
  th { text-align: ${align}; font-size: 8.5px; text-transform: uppercase; letter-spacing: 0.5px; color: #666; padding: 2px 0; }
  th.qty, th.price, th.total, td.qty, td.price, td.total { text-align: center; }
  td { padding: 2px 0; vertical-align: top; }
  .pname { font-weight: 700; line-height: 1.25; }
  .meta { font-family: ui-monospace, Menlo, monospace; font-size: 8.5px; color: #666; direction: ltr; text-align: ${align}; }
  .price, .total, .qty { font-family: ui-monospace, Menlo, monospace; }
  .totals { font-size: 10.5px; }
  .totals .row { display: flex; justify-content: space-between; gap: 8px; margin: 1px 0; }
  .totals .grand { font-size: 13px; font-weight: 800; border-top: 1px solid #111; margin-top: 3px; padding-top: 3px; }
  .barcode { margin: 5px 0 1px; text-align: center; }
  .barcode svg { max-width: 100%; height: auto; }
  .contact-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 1px 10px; margin-top: 5px; padding-top: 5px; border-top: 1px solid #e8e8e8; }
  .contact { display: flex; justify-content: space-between; gap: 6px; font-size: 9.5px; }
  .contact .clabel { color: #555; font-weight: 600; }
  .contact .cvalue { font-weight: 700; }
  .foot { text-align: center; font-size: 9.5px; color: #555; margin-top: 5px; }
  .status { text-align: center; margin: 3px 0; }
  .badge { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 9.5px; font-weight: 700; letter-spacing: 0.5px; }
  .badge.paid { background: #ecfdf5; color: #047857; }
  .badge.pending { background: #fffbeb; color: #b45309; }
  .badge.voided { background: #fef2f2; color: #b91c1c; }
  @media print {
    body { background: #fff; padding: 0; }
    .receipt { max-width: 100%; border: none; padding: 0 1mm; }
    @page { size: auto; margin: 3mm; }
  }
</style>`;
}

/** Shared brand header (logo + wordmark) used by every receipt. */
function receiptBrandHeader(strings: Pick<ReceiptStrings, "businessName" | "businessTagline">): string {
  const { businessName, businessTagline } = strings;
  // The tagline is rendered only when there is one. The unapproved slogan that
  // used to sit under the wordmark is gone and nothing was invented to replace
  // it: the brand header carries the official identity and stops there. The
  // field stays so a merchant who writes their own tagline still gets it
  // printed, which is a settings decision rather than a branding one.
  const tag = businessTagline?.trim()
    ? `
      <div class="btag">${escapeXml(businessTagline)}</div>`
    : "";
  return `<div class="brand">
      <img class="logo" src="${RECEIPT_LOGO_SRC}" alt="ALYQ" onerror="this.style.display='none'" />
      <div class="bname">${escapeXml(businessName)}</div>${tag}
    </div>`;
}

/** Shared contact footer grid used by every receipt. */
function receiptContactsGrid(): string {
  const contacts = RECEIPT_CONTACTS.map(
    (c) =>
      `<div class="contact"><span class="clabel">${escapeXml(c.label)}</span><bdi class="cvalue" dir="ltr">${escapeXml(c.value)}</bdi></div>`,
  ).join("");
  return `<div class="contact-grid">${contacts}</div>`;
}

/** Wrap receipt body markup in the shared printable document shell. */
function receiptDocument(opts: {
  rtl: boolean;
  documentTitle: string;
  strings: Pick<ReceiptStrings, "businessName" | "businessTagline">;
  bodyHtml: string;
}): string {
  const { rtl, documentTitle, strings, bodyHtml } = opts;
  return `<!doctype html>
<html lang="${rtl ? "ar" : "en"}" dir="${rtl ? "rtl" : "ltr"}">
<head>
<meta charset="utf-8" />
<title>${escapeXml(documentTitle)}</title>
${receiptCss(rtl)}
</head>
<body onload="window.focus();window.print();">
  <div class="receipt">
    ${receiptBrandHeader(strings)}
${bodyHtml}
  </div>
</body>
</html>`;
}

// ═══════════════════════════════════════════════════════════════════════════
// Sales receipt
// ═══════════════════════════════════════════════════════════════════════════

export function buildReceiptHtml({ sale, strings, direction }: ReceiptData): string {
  const rtl = direction === "rtl";
  const date = new Date(sale.created_at);
  const dateStr = date.toLocaleString(rtl ? "ar-SA" : "en-GB", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });

  const rows = sale.items
    .map((item) => {
      const name = rtl ? item.name_ar || item.name_en : item.name_en || item.name_ar;
      return `
      <tr>
        <td class="name">
          <div class="pname">${escapeXml(name)}</div>
          <div class="meta">${escapeXml(item.sku)}${item.barcode ? ` · ${escapeXml(item.barcode)}` : ""}</div>
        </td>
        <td class="qty">${item.quantity}</td>
        <td class="price">${money(item.unit_price)}</td>
        <td class="total">${money(item.line_total)}</td>
      </tr>`;
    })
    .join("");

  const symbol = encodeCode128(sale.sale_number);
  // 1 CSS px per module keeps even long invoice numbers inside 58mm media.
  const barcodeSvg = symbol
    ? barcodeToSvgString(symbol, { height: 30, moduleWidth: 1, showText: true })
    : "";

  const payments = sale.payments ?? [];
  const paymentRows = payments
    .map((p) => {
      const state = p.method === "instapay" && p.status === "pending" ? " (pending)" : "";
      return `<div class="row"><span>${escapeXml(paymentMethodDisplayName(p.method))}${escapeXml(state)}</span><span>${money(p.amount)}</span></div>`;
    })
    .join("");
  const paidTotal = round2(
    payments.filter((p) => p.status === "paid").reduce((sum, p) => sum + p.amount, 0),
  );
  const remainingTotal = round2(Math.max(0, sale.total - paidTotal));
  const cashLine =
    sale.amount_received != null
      ? `<div class="row"><span>${escapeXml(strings.receivedLabel)}</span><span>${money(sale.amount_received)}</span></div>
      <div class="row"><span>${escapeXml(strings.changeLabel)}</span><span>${money(sale.change ?? 0)}</span></div>`
      : "";

  const bodyHtml = `    <div class="status">
      <span class="badge ${sale.status}">${escapeXml(statusLabel(sale, strings))}</span>
    </div>
    <div class="sep"></div>
    <div class="headline"><span class="k">${escapeXml(strings.saleLabel)}</span><span>${escapeXml(sale.sale_number)}</span></div>
    <div class="headline"><span class="k">${escapeXml(strings.dateLabel)}</span><span dir="ltr">${escapeXml(dateStr)}</span></div>
    <div class="headline"><span class="k">${escapeXml(strings.cashierLabel)}</span><span>${escapeXml(sale.user_name)}</span></div>
    ${sale.customer_name ? `<div class="headline"><span class="k">${escapeXml(strings.customerLabel)}</span><span>${escapeXml(sale.customer_name)}</span></div>` : ""}
    ${sale.customer_phone ? `<div class="headline"><span class="k">${escapeXml(strings.customerPhoneLabel)}</span><bdi dir="ltr">${escapeXml(sale.customer_phone)}</bdi></div>` : ""}
    <div class="sep"></div>
    <table>
      <thead>
        <tr>
          <th class="name">${escapeXml(strings.itemLabel)}</th>
          <th class="qty">${escapeXml(strings.qtyLabel)}</th>
          <th class="price">${escapeXml(strings.priceLabel)}</th>
          <th class="total">${escapeXml(strings.totalLabel)}</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="sep"></div>
    <div class="totals">
      <div class="row"><span>${escapeXml(strings.subtotalLabel)}</span><span>${money(sale.subtotal)}</span></div>
      <div class="row"><span>${escapeXml(strings.discountLabel)}</span><span>−${money(sale.discount_amount)}</span></div>
      <div class="row grand"><span>${escapeXml(strings.totalLabel)}</span><span>${money(sale.total)}</span></div>
      ${paymentRows}
      <div class="row"><span>${escapeXml(strings.paidLabel)}</span><span>${money(paidTotal)}</span></div>
      <div class="row"><span>${escapeXml(strings.remainingLabel)}</span><span>${money(remainingTotal)}</span></div>
      ${cashLine}
    </div>
    <div class="barcode">${barcodeSvg}</div>
    ${receiptContactsGrid()}
    <div class="foot">${escapeXml(strings.thankYou)}</div>
    ${sale.status === "voided" ? `<div class="foot" style="color:#b91c1c">${escapeXml(strings.voidedNotice)}</div>` : ""}`;

  return receiptDocument({
    rtl,
    documentTitle: `${strings.businessName} — ${sale.sale_number}`,
    strings,
    bodyHtml,
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Return receipt — same design, typography, spacing and print workflow.
// ═══════════════════════════════════════════════════════════════════════════

export interface ReturnReceiptStrings {
  businessName: string;
  /** Rendered under the wordmark only when a merchant sets one. */
  businessTagline?: string;
  /** "Return Receipt" / "إيصال مرتجع" */
  returnTitle: string;
  /** "Return #" / "رقم المرتجع" */
  returnLabel: string;
  dateLabel: string;
  cashierLabel: string;
  /** "Original invoice" / "الفاتورة الأصلية" */
  invoiceLabel: string;
  customerLabel: string;
  customerPhoneLabel: string;
  itemLabel: string;
  qtyLabel: string;
  priceLabel: string;
  /** Line-level refund amount column. */
  refundLabel: string;
  totalQtyLabel: string;
  totalRefundLabel: string;
  refundMethodLabel: string;
  refundNumberLabel: string;
  reasonLabel: string;
  statusLabel: string;
  thankYou: string;
}

/** Minimal shape of a return record — avoids importing the returns module. */
export interface ReturnReceiptRecord {
  return_number: string;
  created_at: string;
  sale_number: string;
  customer_name: string | null;
  user_name: string;
  reason: string;
  refund_amount: number;
  refund_method: string;
  refund_status: "completed" | "pending" | "rejected";
  items: {
    id: string;
    name_ar: string;
    name_en: string;
    sku: string;
    barcode: string | null;
    unit_price: number;
    quantity: number;
    line_total: number;
  }[];
}

export interface ReturnReceiptData {
  returnRecord: ReturnReceiptRecord;
  strings: ReturnReceiptStrings;
  direction: "rtl" | "ltr";
  /** Phone resolved from the linked sale/customer (not stored on the return). */
  customerPhone?: string | null;
  /** Linked refund number, when a refund record exists. */
  refundNumber?: string | null;
}

export function buildReturnReceiptHtml({
  returnRecord,
  strings,
  direction,
  customerPhone,
  refundNumber,
}: ReturnReceiptData): string {
  const rtl = direction === "rtl";
  const dateStr = new Date(returnRecord.created_at).toLocaleString(rtl ? "ar-SA" : "en-GB", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });

  const rows = returnRecord.items
    .map((item) => {
      const name = rtl ? item.name_ar || item.name_en : item.name_en || item.name_ar;
      return `
      <tr>
        <td class="name">
          <div class="pname">${escapeXml(name)}</div>
          <div class="meta">${escapeXml(item.sku)}${item.barcode ? ` · ${escapeXml(item.barcode)}` : ""}</div>
        </td>
        <td class="qty">${item.quantity}</td>
        <td class="price">${money(item.unit_price)}</td>
        <td class="total">${money(item.line_total)}</td>
      </tr>`;
    })
    .join("");

  const totalQty = returnRecord.items.reduce((sum, item) => sum + item.quantity, 0);

  const symbol = encodeCode128(returnRecord.return_number);
  const barcodeSvg = symbol
    ? barcodeToSvgString(symbol, { height: 30, moduleWidth: 1, showText: true })
    : "";

  const statusClass =
    returnRecord.refund_status === "completed"
      ? "paid"
      : returnRecord.refund_status === "rejected"
        ? "voided"
        : "pending";
  const statusText = `${strings.statusLabel}: ${returnRecord.refund_status}`;

  const bodyHtml = `    <div class="status">
      <span class="badge ${statusClass}">${escapeXml(statusText)}</span>
    </div>
    <div class="foot" style="font-size:12px;font-weight:800;color:#111;letter-spacing:1px;margin-top:2px">${escapeXml(strings.returnTitle)}</div>
    <div class="sep"></div>
    <div class="headline"><span class="k">${escapeXml(strings.returnLabel)}</span><span>${escapeXml(returnRecord.return_number)}</span></div>
    <div class="headline"><span class="k">${escapeXml(strings.dateLabel)}</span><span dir="ltr">${escapeXml(dateStr)}</span></div>
    <div class="headline"><span class="k">${escapeXml(strings.invoiceLabel)}</span><span>${escapeXml(returnRecord.sale_number)}</span></div>
    <div class="headline"><span class="k">${escapeXml(strings.cashierLabel)}</span><span>${escapeXml(returnRecord.user_name)}</span></div>
    ${returnRecord.customer_name ? `<div class="headline"><span class="k">${escapeXml(strings.customerLabel)}</span><span>${escapeXml(returnRecord.customer_name)}</span></div>` : ""}
    ${customerPhone ? `<div class="headline"><span class="k">${escapeXml(strings.customerPhoneLabel)}</span><bdi dir="ltr">${escapeXml(customerPhone)}</bdi></div>` : ""}
    ${refundNumber ? `<div class="headline"><span class="k">${escapeXml(strings.refundNumberLabel)}</span><span>${escapeXml(refundNumber)}</span></div>` : ""}
    <div class="sep"></div>
    <table>
      <thead>
        <tr>
          <th class="name">${escapeXml(strings.itemLabel)}</th>
          <th class="qty">${escapeXml(strings.qtyLabel)}</th>
          <th class="price">${escapeXml(strings.priceLabel)}</th>
          <th class="total">${escapeXml(strings.refundLabel)}</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="sep"></div>
    <div class="totals">
      <div class="row"><span>${escapeXml(strings.totalQtyLabel)}</span><span>${totalQty}</span></div>
      <div class="row grand"><span>${escapeXml(strings.totalRefundLabel)}</span><span>${money(returnRecord.refund_amount)}</span></div>
      <div class="row"><span>${escapeXml(strings.refundMethodLabel)}</span><span>${escapeXml(paymentMethodDisplayName(returnRecord.refund_method))}</span></div>
    </div>
    <div class="headline"><span class="k">${escapeXml(strings.reasonLabel)}</span><span style="text-align:${rtl ? "right" : "left"}">${escapeXml(returnRecord.reason)}</span></div>
    <div class="barcode">${barcodeSvg}</div>
    ${receiptContactsGrid()}
    <div class="foot">${escapeXml(strings.thankYou)}</div>`;

  return receiptDocument({
    rtl,
    documentTitle: `${strings.businessName} — ${returnRecord.return_number}`,
    strings,
    bodyHtml,
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Shared print workflow (used by the sales receipt and the return receipt)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Write receipt HTML into a target window/frame and trigger its print dialog
 * once the document has loaded. `target.print` is invoked exactly once.
 */
export function writeAndPrint(
  target: Window & { print: () => void },
  html: string,
  reference: string,
): void {
  const doc = target.document;
  // The builder embeds an auto-print in the <body>; we strip it and invoke
  // print() ourselves once so the trigger is single and controlled.
  doc.open();
  doc.write(html.replace('onload="window.focus();window.print();"', ""));
  doc.close();

  let printed = false;
  const doPrint = () => {
    if (printed) return;
    printed = true;
    try {
      console.log("[receipt-print] invoking print()", { reference });
      target.focus();
      target.print();
    } catch (err) {
      console.error("[receipt-print] print() threw", {
        error: err instanceof Error ? err.message : err,
      });
    }
  };
  try {
    target.addEventListener("load", () => setTimeout(doPrint, 120));
  } catch {
    /* some browsers reject attaching to a fresh window — fallback timer below */
  }
  setTimeout(doPrint, 450);
}

export type PrintOutcome = "popup" | "iframe" | "embedded-blocked" | "failed";

/**
 * Open the receipt in a print popup, falling back to a hidden same-document
 * iframe when the popup is blocked. Returns what happened so callers can show
 * the right message (never fails silently).
 *
 * NOTE: a browser will not open a native print dialog inside a sandboxed /
 * embedded iframe; that case is reported as "embedded-blocked".
 */
export function printHtmlDocument(html: string, reference: string): PrintOutcome {
  const isEmbedded = typeof window !== "undefined" && window.self !== window.top;

  // Primary path: a top-level print popup (works in a normal browser tab).
  // No initialiser: the try assigns it and the catch assigns null, so every
  // path that reaches the code below has written it.
  let w: Window | null;
  try {
    w = window.open("", "_blank", "width=420,height=640");
  } catch (err) {
    console.error("[receipt-print] window.open() threw", {
      error: err instanceof Error ? err.message : err,
    });
    w = null;
  }
  if (w) {
    try {
      writeAndPrint(w as Window & { print: () => void }, html, reference);
      return "popup";
    } catch (err) {
      console.error("[receipt-print] popup write failed, trying in-page frame", {
        reference,
        error: err instanceof Error ? err.message : err,
      });
      try {
        w.close();
      } catch {
        /* ignore */
      }
    }
  }

  // No popup. Inside an embedded/sandboxed frame the browser also suppresses a
  // native print dialog, so report that instead of attempting a doomed iframe.
  if (isEmbedded) {
    console.error(
      "[receipt-print] blocked: native print dialog cannot open inside an embedded/sandboxed frame",
      { reference },
    );
    return "embedded-blocked";
  }

  console.log("[receipt-print] popup unavailable, using hidden in-page frame", { reference });
  let frame: HTMLIFrameElement | null = null;
  try {
    frame = document.createElement("iframe");
    frame.setAttribute(
      "style",
      "position:fixed;right:0;bottom:0;width:1px;height:1px;border:0;visibility:hidden;",
    );
    frame.setAttribute("aria-hidden", "true");
    frame.setAttribute("tabindex", "-1");
    document.body.appendChild(frame);
    const inner = frame.contentWindow;
    if (!inner) throw new Error("iframe contentWindow unavailable");
    writeAndPrint(inner as Window & { print: () => void }, html, reference);
    return "iframe";
  } catch (err) {
    console.error("[receipt-print] failed to print receipt", {
      reference,
      error: err instanceof Error ? err.message : err,
    });
    try {
      frame?.remove();
    } catch {
      /* ignore */
    }
    return "failed";
  }
}

function money(value: number): string {
  return value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function statusLabel(sale: Sale, strings: ReceiptStrings): string {
  if (sale.status === "voided") return strings.voidedNotice;
  if (sale.status === "pending") return strings.statusLabel + ": pending";
  return strings.statusLabel + ": paid";
}
