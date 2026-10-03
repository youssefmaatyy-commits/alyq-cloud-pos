import { useCallback, useEffect, useState } from "react";
import { PageHeader } from "@/components/layout/AppShell";
import { Badge, Button, Card, Field, SelectInput, TextInput } from "@/components/ui";
import { useBranch } from "@/lib/branch";
import { can } from "@/lib/permissions/enforce";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { usePos } from "@/modules/pos";
import { useRegister } from "../RegisterProvider";
import type { RegisterRecord } from "../types";
import { createAndBindRegister, listRegisters, manageRegister } from "../services/registerService";

export function RegistersPage() {
  const { lang, date } = useI18n();
  const ar = lang === "ar";
  const branch = useBranch();
  const registerContext = useRegister();
  const pos = usePos();
  const mayManage = can("registers.manage");
  const [registers, setRegisters] = useState<RegisterRecord[]>([]);
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const copy = ar ? {
    title: "السجلات والأجهزة", subtitle: "هوية مستقلة لكل جهاز بيع، مرتبطة بفرع واحد وتُدار بصلاحيات موثوقة.",
    current: "هذا التثبيت", web: "نسخة الويب — لا توجد هوية جهاز محلية", setup: "تسجيل هذا الجهاز",
    code: "رمز السجل", name: "اسم السجل", branch: "الفرع", create: "إنشاء وربط", registered: "مسجل وجاهز",
    inactive: "غير نشط", active: "نشط", lastSeen: "آخر ظهور", pending: "عمليات معلقة", conflicts: "تعارضات",
    deactivate: "تعطيل", activate: "تنشيط", rename: "تغيير الاسم", reassign: "نقل إلى الفرع المحدد",
    target: "الفرع المستهدف", noRegisters: "لا توجد سجلات متاحة.", loading: "جارٍ التحميل…",
    safety: "لا يمكن نقل أو تعطيل سجل لديه وردية مفتوحة أو عمليات غير متزامنة أو تعارضات غير محلولة.",
  } : {
    title: "Registers & Devices", subtitle: "A separate, permission-managed identity for each branch-bound selling installation.",
    current: "This installation", web: "Web application — no local desktop installation identity", setup: "Register this desktop",
    code: "Register code", name: "Register name", branch: "Branch", create: "Create & bind", registered: "Registered and ready",
    inactive: "Inactive", active: "Active", lastSeen: "Last seen", pending: "Pending operations", conflicts: "Conflicts",
    deactivate: "Deactivate", activate: "Activate", rename: "Rename", reassign: "Move to selected branch",
    target: "Target branch", noRegisters: "No accessible registers.", loading: "Loading…",
    safety: "A register cannot be moved or deactivated while its shift is open or offline operations/conflicts remain.",
  };
  const [targets, setTargets] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    if (!mayManage) return;
    setLoading(true); setError(null);
    try { setRegisters(await listRegisters()); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setLoading(false); }
  }, [mayManage]);

  useEffect(() => { void load(); }, [load]);

  const setup = async () => {
    const branchId = branch.current?.id;
    if (!branchId || !code.trim() || !name.trim()) return;
    setLoading(true); setError(null);
    try {
      await createAndBindRegister({ code: code.trim(), name: name.trim(), branch_id: branchId });
      window.dispatchEvent(new Event("alyq:register-changed"));
      await Promise.all([load(), registerContext.refresh()]);
      setCode(""); setName("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setLoading(false); }
  };

  const act = async (item: RegisterRecord, action: "activate" | "deactivate" | "rename" | "reassign") => {
    const localQueue = pos.syncPendingCount + pos.syncErrorCount + pos.syncDeferredCount + pos.syncConflictCount;
    if ((action === "deactivate" || action === "reassign")
        && registerContext.state.register?.id === item.id && localQueue > 0) {
      setError(copy.safety); return;
    }
    let nextName: string | null = null;
    let nextBranch: string | null = null;
    if (action === "rename") {
      nextName = window.prompt(copy.name, item.name)?.trim() || null;
      if (!nextName) return;
    }
    if (action === "reassign") {
      nextBranch = targets[item.id] || null;
      if (!nextBranch || nextBranch === item.branch_id) return;
    }
    setLoading(true); setError(null);
    try {
      await manageRegister({ register_id: item.id, action, name: nextName, branch_id: nextBranch });
      await load();
      if (registerContext.state.register?.id === item.id) {
        window.dispatchEvent(new Event("alyq:register-changed"));
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setLoading(false); }
  };

  const state = registerContext.state;
  return <div data-testid="registers-page">
    <PageHeader title={copy.title} subtitle={copy.subtitle} />
    {error ? <div className="mb-3 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-semibold text-rose-800">{error}</div> : null}
    <Card>
      <p className="text-xs font-black uppercase tracking-wide text-stone-500">{copy.current}</p>
      {state.kind === "web" ? <p className="mt-2 text-sm text-stone-600">{copy.web}</p> : state.register ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <strong>{state.register.name}</strong><code>{state.register.code}</code>
          <Badge tone={state.kind === "desktop-ready" ? "success" : "danger"}>{state.kind === "desktop-ready" ? copy.registered : state.reason}</Badge>
          <span className="text-xs text-stone-500">{state.register.branch_name ?? state.register.branch_id}</span>
        </div>
      ) : <Badge className="mt-2" tone="warning">{state.reason}</Badge>}
    </Card>

    {mayManage && state.kind === "desktop-unregistered" ? <Card className="mt-4">
      <h2 className="font-black text-stone-900">{copy.setup}</h2>
      <div className="mt-3 grid gap-3 md:grid-cols-3">
        <Field label={copy.code} required><TextInput value={code} maxLength={32} onChange={(event) => setCode(event.target.value.toUpperCase().replace(/[^A-Z0-9_-]/g, ""))} /></Field>
        <Field label={copy.name} required><TextInput value={name} maxLength={80} onChange={(event) => setName(event.target.value)} /></Field>
        <Field label={copy.branch}><TextInput value={branch.current?.name_en ?? ""} readOnly disabled /></Field>
      </div>
      <Button className="mt-3" onClick={() => void setup()} disabled={loading || !code.trim() || !name.trim()}>{copy.create}</Button>
    </Card> : null}

    {mayManage ? <div className="mt-4 space-y-3">
      <p className="rounded-xl bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-900">{copy.safety}</p>
      {loading && registers.length === 0 ? <Card>{copy.loading}</Card> : registers.length === 0 ? <Card>{copy.noRegisters}</Card> : registers.map((item) => (
        <Card key={item.id} data-testid={`register-${item.id}`}>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div><div className="flex items-center gap-2"><strong>{item.name}</strong><code className="text-xs">{item.code}</code><Badge tone={item.active ? "success" : "neutral"}>{item.active ? copy.active : copy.inactive}</Badge></div>
              <p className="mt-1 text-xs text-stone-500">{item.branch_name ?? item.branch_id} · {copy.lastSeen}: {item.last_seen_at ? date(item.last_seen_at) : "Unknown"}</p>
              <p className="mt-1 text-xs text-stone-500">{copy.pending}: {item.pending_offline_count} · {copy.conflicts}: {item.unresolved_conflict_count}</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" onClick={() => void act(item, "rename")} disabled={loading}>{copy.rename}</Button>
              <Button variant="secondary" onClick={() => void act(item, item.active ? "deactivate" : "activate")} disabled={loading}>{item.active ? copy.deactivate : copy.activate}</Button>
            </div>
          </div>
          <div className="mt-3 flex flex-wrap items-end gap-2">
            <Field label={copy.target} className="min-w-56"><SelectInput value={targets[item.id] ?? ""} onChange={(event) => setTargets((current) => ({ ...current, [item.id]: event.target.value }))}>
              <option value="">—</option>{branch.branches.filter((entry) => entry.id !== item.branch_id).map((entry) => <option key={entry.id} value={entry.id}>{entry.name_en}</option>)}
            </SelectInput></Field>
            <Button variant="secondary" onClick={() => void act(item, "reassign")} disabled={loading || !targets[item.id]}>{copy.reassign}</Button>
          </div>
        </Card>
      ))}
    </div> : null}
  </div>;
}
