import type { Shift, ShiftSummary } from "../types";

const escapeHtml = (value: unknown) => String(value ?? "")
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;")
  .replace(/'/g, "&#039;");

export interface ShiftCloseReportInput {
  shift: Shift;
  summary: ShiftSummary;
  lang: "ar" | "en";
  money: (value: number) => string;
  date: (value: string) => string;
}

/** Compact, self-contained close document. It prints the frozen snapshot only. */
export function buildShiftCloseReportHtml({ shift, summary, lang, money, date }: ShiftCloseReportInput): string {
  const ar = lang === "ar";
  const label = (en: string, arabic: string) => ar ? arabic : en;
  const metric = (name: string, value: number, strong = false) =>
    `<div class="metric${strong ? " strong" : ""}"><span>${escapeHtml(name)}</span><b>${escapeHtml(money(value))}</b></div>`;
  const payments = summary.payments_breakdown.length
    ? summary.payments_breakdown.map((item) => metric(item.method, item.amount)).join("")
    : metric(label("Payments", "المدفوعات"), summary.sales_total);
  const closedAt = shift.closed_at ? date(shift.closed_at) : "—";

  return `<!doctype html><html lang="${lang}" dir="${ar ? "rtl" : "ltr"}"><head><meta charset="utf-8" />
<title>${escapeHtml(shift.shift_number)}</title><style>
@page{size:80mm auto;margin:5mm}*{box-sizing:border-box}body{margin:0;color:#1c1917;font:12px/1.45 system-ui,-apple-system,sans-serif}.brand{text-align:center;border-bottom:2px solid #1c1917;padding-bottom:8px}.brand h1{margin:0;font-size:18px}.brand p{margin:2px 0 0;color:#78716c}.meta{display:grid;grid-template-columns:1fr 1fr;gap:5px;margin:10px 0}.meta div{border:1px solid #e7e5e4;border-radius:6px;padding:5px}.meta small{display:block;color:#78716c}.section{border-top:1px dashed #a8a29e;margin-top:8px;padding-top:7px}.section h2{font-size:11px;text-transform:uppercase;letter-spacing:.05em;margin:0 0 4px}.metric{display:flex;justify-content:space-between;gap:12px;padding:2px 0}.metric.strong{border-top:1px solid #1c1917;margin-top:4px;padding-top:5px;font-size:13px}.formula{margin:7px 0;padding:6px;border-radius:6px;background:#f5f5f4;font:10px/1.4 ui-monospace,monospace}.reason{white-space:pre-wrap;border:1px solid #e7e5e4;border-radius:6px;padding:6px}.footer{text-align:center;color:#78716c;font-size:9px;margin-top:10px}@media print{button{display:none}}</style></head><body>
<header class="brand"><h1>ALYQ</h1><p>${escapeHtml(label("Authoritative shift close", "إغلاق وردية موثوق"))}</p></header>
<section class="meta"><div><small>${escapeHtml(label("Shift", "الوردية"))}</small><b>${escapeHtml(shift.shift_number)}</b></div><div><small>${escapeHtml(label("Branch / register", "الفرع / نقطة البيع"))}</small><b>${escapeHtml(`${shift.branch} · ${shift.register}`)}</b></div><div><small>${escapeHtml(label("Opened by", "فتح بواسطة"))}</small><b>${escapeHtml(shift.opened_by_name)}</b></div><div><small>${escapeHtml(label("Closed by", "أغلق بواسطة"))}</small><b>${escapeHtml(shift.closed_by_name ?? "—")}</b></div><div><small>${escapeHtml(label("Opened", "وقت الفتح"))}</small><b>${escapeHtml(date(shift.opening_at))}</b></div><div><small>${escapeHtml(label("Closed", "وقت الإغلاق"))}</small><b>${escapeHtml(closedAt)}</b></div></section>
<section class="section"><h2>${escapeHtml(label("Tender reconciliation", "تسوية وسائل الدفع"))}</h2>${payments}</section>
<section class="section"><h2>${escapeHtml(label("Drawer", "درج النقدية"))}</h2>${metric(label("Opening cash", "نقدية البداية"), shift.opening_cash)}${metric(label("Cash sales", "المبيعات النقدية"), summary.cash_sales)}${metric(label("Cash in", "إدخال نقدي"), (summary.cash_in ?? 0))}${metric(label("Cash refunds", "مستردات نقدية"), -summary.cash_refunds)}${metric(label("Cash out", "إخراج نقدي"), -(summary.cash_out ?? 0))}${metric(label("Legacy cash expenses", "مصروفات نقدية سابقة"), -summary.cash_expenses)}<div class="formula">${escapeHtml(`${money(shift.opening_cash)} + ${money(summary.cash_sales)} + ${money((summary.cash_in ?? 0))} − ${money(summary.cash_refunds)} − ${money((summary.cash_out ?? 0))} − ${money(summary.cash_expenses)} = ${money(summary.expected_cash)}`)}</div>${metric(label("Expected cash", "النقدية المتوقعة"), summary.expected_cash, true)}${metric(label("Actual cash", "النقدية الفعلية"), summary.actual_cash ?? 0)}${metric(label("Over / short", "الزيادة / العجز"), summary.difference ?? 0, true)}</section>
${shift.notes ? `<section class="section"><h2>${escapeHtml(label("Reason / note", "السبب / الملاحظة"))}</h2><div class="reason">${escapeHtml(shift.notes)}</div></section>` : ""}
<footer class="footer">${escapeHtml(label("Frozen at close · append-only audit evidence", "لقطة مجمدة عند الإغلاق · دليل تدقيق غير قابل للتعديل"))}</footer></body></html>`;
}

export function printShiftCloseReport(input: ShiftCloseReportInput): void {
  const popup = window.open("", "_blank", "noopener,noreferrer,width=420,height=720");
  if (!popup) throw new Error("The print window was blocked");
  popup.document.open();
  popup.document.write(buildShiftCloseReportHtml(input));
  popup.document.close();
  popup.focus();
  popup.print();
}
