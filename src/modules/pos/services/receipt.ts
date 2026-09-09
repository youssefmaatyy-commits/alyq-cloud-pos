import { encodeCode128, barcodeToSvgString, escapeXml } from "./barcodeHelpers";
import { round2 } from "./posMath";
import type { Sale } from "../types";

/**
 * Printable receipt builder — ALYQ boutique edition.
 *
 * Pure: takes a Sale and returns a self-contained HTML document. The only
 * untestable step (window.open) lives in the component.
 *
 * Design goals (thermal 58mm / 80mm):
 * - compact: tight paddings, 10–11px body type, hairline separators
 * - boutique minimal: centered official logo, serif brand line, small-caps tagline
 * - scannable: Code 128 symbol sized to fit 58mm media, never mirrored in RTL
 */

/** Official ALYQ logo file. Place the attached artwork at `public/alyq-logo.png`
 *  (exact name, unmodified — the receipt only resizes it for print). */
export const RECEIPT_LOGO_SRC = "/alyq-logo.png";

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
 */
export function paymentMethodDisplayName(method: string): string {
  if (method === "cash") return "Cash";
  if (method === "visa") return "Visa";
  if (method === "instapay") return "InstaPay";
  return method.charAt(0).toUpperCase() + method.slice(1);
}

export interface ReceiptStrings {
  businessName: string;
  businessTagline: string;
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

  const contacts = RECEIPT_CONTACTS.map(
    (c) =>
      `<div class="contact"><span class="clabel">${escapeXml(c.label)}</span><bdi class="cvalue" dir="ltr">${escapeXml(c.value)}</bdi></div>`,
  ).join("");

  return `<!doctype html>
<html lang="${rtl ? "ar" : "en"}" dir="${rtl ? "rtl" : "ltr"}">
<head>
<meta charset="utf-8" />
<title>${escapeXml(strings.businessName)} — ${escapeXml(sale.sale_number)}</title>
<style>
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
  th { text-align: ${rtl ? "right" : "left"}; font-size: 8.5px; text-transform: uppercase; letter-spacing: 0.5px; color: #666; padding: 2px 0; }
  th.qty, th.price, th.total, td.qty, td.price, td.total { text-align: center; }
  td { padding: 2px 0; vertical-align: top; }
  .pname { font-weight: 700; line-height: 1.25; }
  .meta { font-family: ui-monospace, Menlo, monospace; font-size: 8.5px; color: #666; direction: ltr; text-align: ${rtl ? "right" : "left"}; }
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
</style>
</head>
<body onload="window.focus();window.print();">
  <div class="receipt">
    <div class="brand">
      <img class="logo" src="${RECEIPT_LOGO_SRC}" alt="ALYQ" onerror="this.style.display='none'" />
      <div class="bname">${escapeXml(strings.businessName)}</div>
      <div class="btag">${escapeXml(strings.businessTagline)}</div>
    </div>
    <div class="status">
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
    <div class="contact-grid">${contacts}</div>
    <div class="foot">${escapeXml(strings.thankYou)}</div>
    ${sale.status === "voided" ? `<div class="foot" style="color:#b91c1c">${escapeXml(strings.voidedNotice)}</div>` : ""}
  </div>
</body>
</html>`;
}

function money(value: number): string {
  return value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function statusLabel(sale: Sale, strings: ReceiptStrings): string {
  if (sale.status === "voided") return strings.voidedNotice;
  if (sale.status === "pending") return strings.statusLabel + ": pending";
  return strings.statusLabel + ": paid";
}
