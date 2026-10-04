import { useState } from "react";
import { Badge, Button, Card, Field, TextInput, useToast } from "@/components/ui";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { useBranch } from "@/lib/branch";
import { can } from "@/lib/permissions/enforce";
import { getSupabaseClient, isSupabaseConfigured } from "@/lib/supabase/client";

type Category = "customers" | "cancelled_online_orders" | "expired_promotions" | "unfinished_stocktakes";
interface CleanupState {
  delete_count: number;
  anonymize_count: number;
  archive_count: number;
  protected_count: number;
  dependencies: Record<string, string>;
}
interface Preview {
  preview_id: string;
  category: Category;
  state: CleanupState;
  fingerprint: string;
  preview_token: string;
  confirmation_phrase: string;
  expires_at: string;
}

const CATEGORIES: Category[] = ["customers", "cancelled_online_orders", "expired_promotions", "unfinished_stocktakes"];

export function SelectiveCleanupPanel() {
  const { lang, date } = useI18n();
  const branch = useBranch();
  const toast = useToast();
  const [category, setCategory] = useState<Category>("customers");
  const [from, setFrom] = useState("");
  const [before, setBefore] = useState("");
  const [recordId, setRecordId] = useState("");
  const [reference, setReference] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Record<string, unknown> | null>(null);
  const live = isSupabaseConfigured;
  const mayExecute = can("system.execute_cleanup");

  async function generatePreview() {
    setBusy(true); setResult(null); setConfirmation("");
    try {
      const filters: Record<string, string> = {
        before: new Date(`${before}T23:59:59`).toISOString(),
      };
      if (from) filters.from = new Date(`${from}T00:00:00`).toISOString();
      if (recordId.trim()) filters.record_id = recordId.trim();
      if (reference.trim()) filters.reference = reference.trim();
      const { data, error } = await getSupabaseClient()!.rpc("preview_selective_cleanup", {
        p_category: category,
        p_filters: filters,
      });
      if (error) throw error;
      setPreview(data as Preview);
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "Preview failed");
    } finally { setBusy(false); }
  }

  async function execute() {
    if (!preview) return;
    setBusy(true);
    try {
      const { data, error } = await getSupabaseClient()!.rpc("execute_selective_cleanup", {
        p_preview_id: preview.preview_id,
        p_preview_token: preview.preview_token,
        p_fingerprint: preview.fingerprint,
        p_confirmation: confirmation,
        p_approval_request_id: null,
      });
      if (error) throw error;
      setResult((data as Record<string, unknown>) ?? {});
      // Tokens are one-shot and short-lived; discard immediately after use.
      setPreview(null); setConfirmation("");
      toast.success(lang === "ar" ? "اكتمل التنظيف الانتقائي" : "Selective cleanup completed");
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "Cleanup failed");
    } finally { setBusy(false); }
  }

  const name = (value: Category) => ({
    customers: lang === "ar" ? "بيانات العملاء القديمة" : "Old customer data",
    cancelled_online_orders: lang === "ar" ? "طلبات الإنترنت الملغاة" : "Cancelled online orders",
    expired_promotions: lang === "ar" ? "العروض المنتهية" : "Expired promotions",
    unfinished_stocktakes: lang === "ar" ? "الجرد غير المكتمل" : "Unfinished stocktakes",
  })[value];
  const referenceLabel = ({
    customers: lang === "ar" ? "رقم الهاتف الدقيق" : "Exact phone",
    cancelled_online_orders: lang === "ar" ? "رقم الطلب / مرجع العميل" : "Order / client reference",
    expired_promotions: lang === "ar" ? "اسم العرض الدقيق" : "Exact promotion name",
    unfinished_stocktakes: lang === "ar" ? "مرجع الجرد الدقيق" : "Exact stocktake reference",
  } as const)[category];

  return (
    <Card className="mb-5 border-amber-300 bg-amber-50/30" data-testid="selective-cleanup-panel">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Badge tone="warning">{lang === "ar" ? "انتقائي" : "Selective"}</Badge>
          <h2 className="mt-2 text-base font-black text-stone-900">{lang === "ar" ? "تنظيف بيانات آمن" : "Safe selective data cleanup"}</h2>
          <p className="mt-1 max-w-3xl text-xs leading-5 text-stone-600">{lang === "ar"
            ? "فئات وفلاتر محددة فقط. السجلات المالية النهائية وسجل التدقيق والتسويات والجرد النهائي محمية دائمًا."
            : "Only explicit categories and filters. Final financial, audit, reconciliation and finalized stocktake history is always protected."}</p>
          {branch.current ? <p className="mt-1 text-[11px] font-bold text-stone-500">{lang === "ar" ? "نطاق الفرع:" : "Branch scope:"} {lang === "ar" ? branch.current.name_ar : branch.current.name_en}</p> : null}
        </div>
        <Badge tone={mayExecute ? "danger" : "neutral"}>{mayExecute ? (lang === "ar" ? "يمكن التنفيذ" : "Execution permitted") : (lang === "ar" ? "معاينة فقط" : "Preview only")}</Badge>
      </div>

      {!live ? <p className="mt-4 rounded-xl bg-white p-3 text-xs font-bold text-amber-800">{lang === "ar" ? "المعاينة الموثوقة غير متاحة دون اتصال." : "Authoritative cleanup preview is unavailable offline."}</p> : (
        <>
          <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
            <Field label={lang === "ar" ? "الفئة" : "Safe category"}>
              <select className="h-10 w-full rounded-xl border border-stone-200 bg-white px-3 text-sm font-semibold" value={category} onChange={(e) => { setCategory(e.target.value as Category); setPreview(null); setReference(""); }}>
                {CATEGORIES.map((item) => <option key={item} value={item}>{name(item)}</option>)}
              </select>
            </Field>
            <Field label={lang === "ar" ? "من تاريخ (اختياري)" : "Created from (optional)"}>
              <TextInput type="date" max={before || new Date().toISOString().slice(0, 10)} value={from} onChange={(e) => { setFrom(e.target.value); setPreview(null); }} />
            </Field>
            <Field label={lang === "ar" ? "قبل تاريخ" : "Created before"}>
              <TextInput type="date" min={from || undefined} max={new Date().toISOString().slice(0, 10)} value={before} onChange={(e) => { setBefore(e.target.value); setPreview(null); }} />
            </Field>
            <Field label={lang === "ar" ? "معرّف سجل UUID (اختياري)" : "Record UUID (optional)"}>
              <TextInput value={recordId} onChange={(e) => { setRecordId(e.target.value); setPreview(null); }} placeholder="xxxxxxxx-xxxx-…" />
            </Field>
            <Field label={referenceLabel}>
              <TextInput maxLength={120} value={reference} onChange={(e) => { setReference(e.target.value); setPreview(null); }} />
            </Field>
            <Button className="self-end" variant="secondary" loading={busy} disabled={!before || (!!from && from > before) || !can("system.preview_cleanup")} onClick={() => { void generatePreview(); }}>
              {lang === "ar" ? "معاينة حقيقية" : "Real-count preview"}
            </Button>
          </div>

          {preview ? (
            <div className="mt-4 rounded-xl border border-stone-200 bg-white p-4" data-testid="selective-cleanup-preview">
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {([
                  ["delete_count", lang === "ar" ? "حذف" : "Delete"],
                  ["anonymize_count", lang === "ar" ? "إخفاء الهوية" : "Anonymize"],
                  ["archive_count", lang === "ar" ? "أرشفة" : "Archive"],
                  ["protected_count", lang === "ar" ? "محمي" : "Protected"],
                ] as const).map(([key, label]) => <div key={key} className="rounded-lg bg-stone-50 p-3"><p className="text-[10px] font-bold uppercase text-stone-500">{label}</p><p className="mt-1 text-xl font-black text-stone-900">{preview.state[key]}</p></div>)}
              </div>
              <div className="mt-3 rounded-lg bg-emerald-50 p-3">
                <p className="text-[10px] font-black uppercase text-emerald-800">{lang === "ar" ? "سياسة التبعيات" : "Dependency policy"}</p>
                {Object.entries(preview.state.dependencies).map(([key, value]) => <p key={key} className="mt-1 text-xs text-emerald-900"><strong>{key.replace(/_/g, " ")}:</strong> {value}</p>)}
              </div>
              <p className="mt-3 break-all text-[10px] text-stone-400">SHA-256: {preview.fingerprint} · {lang === "ar" ? "ينتهي" : "expires"} {date(preview.expires_at)}</p>
              {mayExecute ? (
                <div className="mt-4 border-t border-stone-100 pt-4">
                  <p className="text-xs font-bold text-red-800">{lang === "ar" ? "اكتب العبارة كما هي:" : "Type the exact phrase:"} <code className="rounded bg-red-50 px-2 py-1">{preview.confirmation_phrase}</code></p>
                  <div className="mt-3 flex flex-wrap gap-3">
                    <TextInput autoComplete="off" value={confirmation} onChange={(e) => setConfirmation(e.target.value)} />
                    <Button variant="danger" loading={busy} disabled={confirmation !== preview.confirmation_phrase} onClick={() => { void execute(); }}>{lang === "ar" ? "تنفيذ مرة واحدة" : "Execute once"}</Button>
                  </div>
                </div>
              ) : <p className="mt-3 text-xs font-bold text-stone-500">{lang === "ar" ? "تحتاج صلاحية تنفيذ منفصلة للمتابعة." : "A separate execute permission is required to continue."}</p>}
            </div>
          ) : null}
          {result ? <pre className="mt-4 overflow-auto rounded-xl bg-emerald-50 p-3 text-xs font-semibold text-emerald-900">{JSON.stringify(result, null, 2)}</pre> : null}
        </>
      )}
    </Card>
  );
}
