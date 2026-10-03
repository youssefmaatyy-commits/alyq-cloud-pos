import { useEffect, useState } from "react";
import { PageHeader } from "@/components/layout/AppShell";
import { Badge, Button, Card, Field, SelectInput, TextInput } from "@/components/ui";
import { desktopApi, getDesktopConfig, getDesktopContext, listDesktopPrinters, saveDesktopHardwareConfig } from "@/lib/desktop/bridge";
import type { DesktopHardwareConfig, DesktopPrinterInfo } from "@/lib/desktop/types";
import { can } from "@/lib/permissions/enforce";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { authorizeManualDrawer, recordHardwareEvent } from "../services/registerService";

const defaults: DesktopHardwareConfig = {
  printerName: null,
  paperWidthMm: 80,
  copies: 1,
  silentPrint: true,
  autoPrintAfterSale: false,
  drawerMode: "none",
  autoOpenCashDrawer: false,
};

export function DesktopHardwarePage() {
  const { lang } = useI18n();
  const ar = lang === "ar";
  const mayConfigure = can("hardware.configure");
  const mayOpenDrawer = can("hardware.open_drawer");
  const [config, setConfig] = useState<DesktopHardwareConfig>(defaults);
  const [printers, setPrinters] = useState<DesktopPrinterInfo[]>([]);
  const [context, setContext] = useState<Awaited<ReturnType<typeof getDesktopContext>>>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const copy = ar ? {
    title: "أجهزة سطح المكتب", subtitle: "إعداد محلي محدود للطابعة الحرارية والدرج مع حالة صادقة وآمنة.",
    desktopOnly: "هذه الأدوات متاحة داخل تطبيق سطح المكتب فقط.", printer: "طابعة ويندوز", refresh: "تحديث القائمة",
    paper: "عرض الورق", copies: "عدد النسخ", silent: "إرسال مباشر إلى الطابعة المضبوطة", autoPrint: "طباعة تلقائية بعد عملية بيع مكتملة", drawerMode: "وضع درج النقد", none: "معطل",
    driver: "مهمة عبر تعريف الطابعة", auto: "فتح تلقائي بعد عملية بيع نقدية مكتملة فقط", save: "حفظ الإعداد",
    test: "طباعة اختبار", fullscreen: "وضع الكاشير بملء الشاشة", exitFullscreen: "إنهاء ملء الشاشة",
    manual: "فتح يدوي موثق", reason: "سبب الفتح", open: "تفويض وإرسال أمر الدرج",
    unknown: "غير معروف", status: "حالة الجهاز", truth: "ظهور تعريف الطابعة لا يثبت وجود ورق أو أن الغطاء مغلق أو أن الدرج فتح. نجاح الإرسال يعني الوصول لقائمة الطباعة فقط.",
    submitted: "تم الإرسال لقائمة الطباعة؛ النتيجة المادية غير معروفة.", saved: "تم حفظ الإعداد وتسجيل الحدث.",
  } : {
    title: "Desktop Hardware", subtitle: "Bounded local thermal-printer and drawer configuration with truthful status reporting.",
    desktopOnly: "These controls are available only inside the desktop application.", printer: "Windows printer", refresh: "Refresh list",
    paper: "Paper width", copies: "Receipt copies", silent: "Submit directly to the configured printer", autoPrint: "Auto-print after a completed sale", drawerMode: "Cash-drawer mode", none: "Disabled",
    driver: "Dedicated printer-driver job", auto: "Auto-open only after a completed cash sale", save: "Save configuration",
    test: "Print test", fullscreen: "Cashier full screen", exitFullscreen: "Exit full screen",
    manual: "Audited manual drawer open", reason: "Reason", open: "Authorize & send drawer command",
    unknown: "Unknown", status: "Hardware status", truth: "A visible printer driver does not prove paper, cover, connectivity, or drawer state. Success means spool submission only.",
    submitted: "Submitted to the print spooler; physical outcome is unknown.", saved: "Configuration saved and audited.",
  };

  const load = async () => {
    setError(null);
    try {
      const [nextContext, nextConfig, nextPrinters] = await Promise.all([getDesktopContext(), getDesktopConfig(), listDesktopPrinters()]);
      setContext(nextContext); if (nextConfig) setConfig(nextConfig.hardware); setPrinters(nextPrinters);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };
  useEffect(() => { void load(); }, []);

  const run = async (action: () => Promise<void>) => {
    setBusy(true); setError(null); setMessage(null);
    try { await action(); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };

  if (!context) return <div><PageHeader title={copy.title} subtitle={copy.subtitle} /><Card><Badge tone="neutral">{copy.desktopOnly}</Badge></Card></div>;
  const selectedVisible = Boolean(config.printerName && printers.some((printer) => printer.name === config.printerName));
  const api = desktopApi();
  return <div data-testid="desktop-hardware-page">
    <PageHeader title={copy.title} subtitle={copy.subtitle} actions={<Button variant="secondary" onClick={() => void run(load)}>{copy.refresh}</Button>} />
    {error ? <div className="mb-3 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-semibold text-rose-800">{error}</div> : null}
    {message ? <div className="mb-3 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-semibold text-emerald-800">{message}</div> : null}
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <div className="flex items-center justify-between gap-3"><h2 className="font-black">{copy.status}</h2><Badge tone="neutral">{copy.unknown}</Badge></div>
        <p className="mt-2 text-xs leading-relaxed text-stone-600">{copy.truth}</p>
        <div className="mt-4 space-y-3">
          <Field label={copy.printer}><SelectInput value={config.printerName ?? ""} onChange={(event) => setConfig((value) => ({ ...value, printerName: event.target.value || null }))} disabled={!mayConfigure}>
            <option value="">—</option>{printers.map((printer) => <option key={printer.name} value={printer.name}>{printer.displayName}{printer.isDefault ? " · Default" : ""}</option>)}
          </SelectInput></Field>
          <Field label={copy.paper}><SelectInput value={config.paperWidthMm} onChange={(event) => setConfig((value) => ({ ...value, paperWidthMm: Number(event.target.value) as 58 | 80 }))} disabled={!mayConfigure}><option value={80}>80mm</option><option value={58}>58mm</option></SelectInput></Field>
          <Field label={copy.copies}><SelectInput value={config.copies} onChange={(event) => setConfig((value) => ({ ...value, copies: Number(event.target.value) }))} disabled={!mayConfigure}>{[1, 2, 3, 4, 5].map((count) => <option key={count} value={count}>{count}</option>)}</SelectInput></Field>
          <Field label={copy.drawerMode}><SelectInput value={config.drawerMode} onChange={(event) => setConfig((value) => ({ ...value, drawerMode: event.target.value as DesktopHardwareConfig["drawerMode"] }))} disabled={!mayConfigure}><option value="none">{copy.none}</option><option value="printer-driver">{copy.driver}</option></SelectInput></Field>
          <label className="flex items-center gap-2 text-sm font-semibold"><input type="checkbox" checked={config.silentPrint} onChange={(event) => setConfig((value) => ({ ...value, silentPrint: event.target.checked }))} disabled={!mayConfigure} />{copy.silent}</label>
          <label className="flex items-center gap-2 text-sm font-semibold"><input type="checkbox" checked={config.autoPrintAfterSale} onChange={(event) => setConfig((value) => ({ ...value, autoPrintAfterSale: event.target.checked }))} disabled={!mayConfigure || !config.printerName} />{copy.autoPrint}</label>
          <label className="flex items-center gap-2 text-sm font-semibold"><input type="checkbox" checked={config.autoOpenCashDrawer} onChange={(event) => setConfig((value) => ({ ...value, autoOpenCashDrawer: event.target.checked }))} disabled={!mayConfigure || config.drawerMode === "none"} />{copy.auto}</label>
          <div className="flex flex-wrap gap-2">
            <Button disabled={!mayConfigure || busy} onClick={() => void run(async () => {
              const saved = await saveDesktopHardwareConfig(config);
              await recordHardwareEvent("configured", { paper_width_mm: saved.paperWidthMm, copies: saved.copies, printer_configured: Boolean(saved.printerName), auto_print_after_sale: saved.autoPrintAfterSale, drawer_mode: saved.drawerMode, auto_open_cash_drawer: saved.autoOpenCashDrawer });
              setConfig(saved); setMessage(copy.saved);
            })}>{copy.save}</Button>
            <Button variant="secondary" disabled={!mayConfigure || !selectedVisible || busy} onClick={() => void run(async () => {
              await api!.testPrint();
              await recordHardwareEvent("printer_tested", { paper_width_mm: config.paperWidthMm, spool_submitted: true, physical_state: "unknown" });
              setMessage(copy.submitted);
            })}>{copy.test}</Button>
          </div>
        </div>
      </Card>
      <div className="space-y-4">
        <Card><h2 className="font-black">{copy.fullscreen}</h2><Button className="mt-3" variant="secondary" onClick={() => void run(async () => { const result = await api!.setFullscreen(!context.fullscreen); setContext({ ...context, fullscreen: result.fullscreen }); })}>{context.fullscreen ? copy.exitFullscreen : copy.fullscreen}</Button></Card>
        <Card><h2 className="font-black">{copy.manual}</h2><Field className="mt-3" label={copy.reason}><TextInput value={reason} maxLength={160} onChange={(event) => setReason(event.target.value)} disabled={!mayOpenDrawer} /></Field>
          <Button className="mt-3" disabled={!mayOpenDrawer || reason.trim().length < 3 || config.drawerMode === "none" || busy} onClick={() => void run(async () => {
            const authorized = await authorizeManualDrawer(reason.trim());
            await api!.kickDrawer({ authorizationRef: authorized.authorization_ref, reason: reason.trim() });
            setMessage(copy.submitted); setReason("");
          })}>{copy.open}</Button>
        </Card>
      </div>
    </div>
  </div>;
}
