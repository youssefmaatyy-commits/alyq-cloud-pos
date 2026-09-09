import { barcodeToSvgString, encodeCode128, escapeXml } from "./barcode";

/**
 * Printable barcode label.
 *
 * The label document is built as a self-contained HTML string so it can be
 * opened in a popup and printed without pulling the app's CSS in. Keeping
 * this a pure function makes the whole print path unit-testable — the only
 * untestable part left is `window.open`.
 */

export interface BarcodeLabelData {
  nameAr: string;
  nameEn: string;
  sku: string;
  barcode: string;
  /** Pre-formatted price string (already localised + currency-suffixed). */
  price: string;
  /** Number of copies to lay out on the sheet. */
  copies?: number;
  /** `rtl` renders the name line right-aligned with the Arabic name first. */
  direction?: "rtl" | "ltr";
}

export interface BarcodeLabelStrings {
  documentTitle: string;
  skuLabel: string;
  priceLabel: string;
  printAction: string;
  unsupported: string;
}

/** One label card (used both standalone and repeated on the sheet). */
function renderLabelCard(data: BarcodeLabelData, strings: BarcodeLabelStrings): string {
  const encoded = encodeCode128(data.barcode);
  const rtl = data.direction === "rtl";
  const primaryName = rtl ? data.nameAr || data.nameEn : data.nameEn || data.nameAr;
  const secondaryName = rtl ? data.nameEn || "" : data.nameAr || "";

  const symbol = encoded
    ? barcodeToSvgString(encoded, { height: 52, moduleWidth: 1.6, showText: true })
    : `<div class="unsupported">${escapeXml(strings.unsupported)}</div>`;

  return `
    <div class="label" dir="${rtl ? "rtl" : "ltr"}">
      <div class="name" title="${escapeXml(primaryName)}">${escapeXml(primaryName)}</div>
      ${secondaryName ? `<div class="name-alt">${escapeXml(secondaryName)}</div>` : ""}
      <div class="symbol">${symbol}</div>
      <div class="meta">
        <span class="sku"><span class="muted">${escapeXml(strings.skuLabel)}</span> ${escapeXml(data.sku)}</span>
        <span class="price">${escapeXml(data.price)}</span>
      </div>
    </div>`;
}

/**
 * Build the complete, standalone print document for one product.
 * Layout is a simple flow of fixed-size label cards so a sheet of identical
 * labels prints predictably on both A4 and label-roll printers.
 */
export function buildBarcodeLabelHtml(
  data: BarcodeLabelData,
  strings: BarcodeLabelStrings,
): string {
  const copies = Math.max(1, Math.min(data.copies ?? 1, 40));
  const cards = Array.from({ length: copies }, () => renderLabelCard(data, strings)).join("");

  return `<!doctype html>
<html lang="${data.direction === "rtl" ? "ar" : "en"}" dir="${data.direction === "rtl" ? "rtl" : "ltr"}">
<head>
<meta charset="utf-8" />
<title>${escapeXml(strings.documentTitle)}</title>
<style>
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 12px;
    background: #fff;
    color: #0f172a;
    font-family: "Inter", "Noto Kufi Arabic", "Segoe UI", Tahoma, system-ui, sans-serif;
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-content: flex-start;
  }
  .label {
    width: 58mm;
    padding: 6px 8px 8px;
    border: 1px solid #e2e8f0;
    border-radius: 6px;
    text-align: center;
    page-break-inside: avoid;
    break-inside: avoid;
  }
  .name {
    font-size: 12px;
    font-weight: 700;
    line-height: 1.25;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .name-alt {
    font-size: 10px;
    font-weight: 500;
    color: #475569;
    line-height: 1.2;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .symbol { margin: 4px 0 2px; }
  .symbol svg { max-width: 100%; height: auto; }
  .meta {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 6px;
    font-size: 11px;
  }
  .sku { font-family: ui-monospace, "SFMono-Regular", Menlo, monospace; direction: ltr; }
  .muted { color: #64748b; font-weight: 600; }
  .price { font-weight: 800; white-space: nowrap; }
  .unsupported { font-size: 11px; color: #b91c1c; padding: 14px 0; }
  @media print {
    body { padding: 0; gap: 0; }
    .label { border: none; border-radius: 0; }
    @page { margin: 6mm; }
  }
</style>
</head>
<body onload="window.focus();window.print();">
${cards}
</body>
</html>`;
}
