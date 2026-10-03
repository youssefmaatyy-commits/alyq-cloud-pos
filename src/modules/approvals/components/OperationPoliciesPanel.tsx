import { useCallback, useEffect, useState } from "react";
import { Button, Card, LoadingBlock, useToast } from "@/components/ui";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { useBranch } from "@/lib/branch";
import { getSupabaseClient } from "@/lib/supabase/client";
import { APP_ROLES, ROLE_LABELS, type AppRole } from "@/lib/permissions/roles";
import { useSettings } from "@/modules/settings/hooks/SettingsProvider";

const OPERATIONS = [
  "item_discount", "invoice_discount", "price_override", "void", "refund", "cash_out",
] as const;
type Operation = (typeof OPERATIONS)[number];
type ScopeType = "branch" | "role" | "user";

const PERMISSION: Record<Operation, string> = {
  item_discount: "apply_discount",
  invoice_discount: "apply_discount",
  price_override: "change_price",
  void: "void_sale",
  refund: "process_refund",
  cash_out: "cash_out",
};

interface PolicyRow {
  id?: string;
  branch_id: string;
  operation: Operation;
  scope_type: ScopeType;
  scope_role: AppRole | null;
  scope_user_id: string | null;
  permission_required: string;
  enabled: boolean;
  allow_approval: boolean;
  allow_permission_escalation: boolean;
  normal_max_percent: number | null;
  normal_max_amount: number | null;
  approval_max_percent: number | null;
  approval_max_amount: number | null;
}

const input = "h-9 rounded-lg border border-stone-200 bg-white px-2 text-xs font-semibold outline-none focus:border-[#b08d57]";
const numberValue = (value: string) => value.trim() === "" ? null : Number(value);

function blank(branchId: string): PolicyRow {
  return {
    branch_id: branchId, operation: "item_discount", scope_type: "role", scope_role: "cashier",
    scope_user_id: null, permission_required: "apply_discount", enabled: true,
    allow_approval: true, allow_permission_escalation: false,
    normal_max_percent: null, normal_max_amount: null, approval_max_percent: null, approval_max_amount: null,
  };
}

export function OperationPoliciesPanel() {
  const { lang } = useI18n();
  const branch = useBranch();
  const currentBranch = branch.current;
  const settings = useSettings();
  const toast = useToast();
  const [rows, setRows] = useState<PolicyRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);
  const [draft, setDraft] = useState<PolicyRow | null>(null);

  const load = useCallback(async () => {
    if (settings.mode === "demo" || !currentBranch) { setRows([]); setLoading(false); return; }
    setLoading(true);
    try {
      const { data, error } = await getSupabaseClient()!.from("operation_policies").select("*")
        .eq("branch_id", currentBranch.id).order("operation").order("scope_type");
      if (error) toast.error(error.message);
      setRows((data as PolicyRow[]) ?? []);
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "Could not load operation policies");
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [currentBranch, settings.mode, toast]);

  useEffect(() => { void load(); }, [load]);

  async function save(row: PolicyRow) {
    setSaving(row.id ?? "new");
    try {
      const { error } = await getSupabaseClient()!.rpc("set_operation_policy", { p_policy: row });
      if (error) return toast.error(error.message);
      toast.success(lang === "ar" ? "تم حفظ سياسة العملية" : "Operation policy saved");
      setDraft(null);
      await load();
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "Could not save operation policy");
    } finally {
      setSaving(null);
    }
  }

  function patch(id: string | undefined, next: Partial<PolicyRow>) {
    if (!id) setDraft((current) => current ? { ...current, ...next } : current);
    else setRows((all) => all.map((row) => row.id === id ? { ...row, ...next } : row));
  }

  const renderRow = (row: PolicyRow, isDraft = false) => {
    const key = row.id ?? "new";
    const percentOperation = row.operation.includes("discount");
    return (
      <div key={key} className="grid gap-3 border-t border-stone-100 p-4 first:border-t-0 xl:grid-cols-[170px_160px_1fr_auto]">
        <div>
          <p className="text-xs font-black text-stone-900">{row.operation.replace(/_/g, " ")}</p>
          <p className="mt-1 text-[11px] text-stone-500">{row.permission_required}</p>
        </div>
        <div className="space-y-2">
          {isDraft ? (
            <select className={`${input} w-full`} value={row.operation} onChange={(e) => {
              const operation = e.target.value as Operation;
              patch(undefined, { operation, permission_required: PERMISSION[operation] });
            }}>
              {OPERATIONS.map((operation) => <option key={operation} value={operation}>{operation.replace(/_/g, " ")}</option>)}
            </select>
          ) : null}
          <select className={`${input} w-full`} disabled={!isDraft || row.scope_type === "branch"} value={row.scope_type}
            onChange={(e) => patch(row.id, { scope_type: e.target.value as ScopeType, scope_role: e.target.value === "role" ? "cashier" : null, scope_user_id: e.target.value === "user" ? settings.users[0]?.id ?? null : null })}>
            <option value="branch">{lang === "ar" ? "الفرع" : "Branch default"}</option>
            <option value="role">{lang === "ar" ? "دور" : "Role override"}</option>
            <option value="user">{lang === "ar" ? "مستخدم" : "User override"}</option>
          </select>
          {row.scope_type === "role" ? (
            <select className={`${input} w-full`} disabled={!isDraft} value={row.scope_role ?? "cashier"} onChange={(e) => patch(row.id, { scope_role: e.target.value as AppRole })}>
              {APP_ROLES.map((role) => <option key={role} value={role}>{ROLE_LABELS[role]}</option>)}
            </select>
          ) : row.scope_type === "user" ? (
            <select className={`${input} w-full`} disabled={!isDraft} value={row.scope_user_id ?? ""} onChange={(e) => patch(row.id, { scope_user_id: e.target.value })}>
              {settings.users.map((user) => <option key={user.id} value={user.id}>{user.name}</option>)}
            </select>
          ) : null}
        </div>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          <label className="text-[11px] font-bold text-stone-500">
            {percentOperation ? (lang === "ar" ? "الحد الطبيعي %" : "Normal max %") : (lang === "ar" ? "الحد الطبيعي" : "Normal max amount")}
            <input type="number" min="0" max={percentOperation ? 100 : undefined} className={`${input} mt-1 w-full`} value={(percentOperation ? row.normal_max_percent : row.normal_max_amount) ?? ""}
              onChange={(e) => patch(row.id, percentOperation ? { normal_max_percent: numberValue(e.target.value) } : { normal_max_amount: numberValue(e.target.value) })} />
          </label>
          <label className="text-[11px] font-bold text-stone-500">
            {percentOperation ? (lang === "ar" ? "حد الموافقة %" : "Approval max %") : (lang === "ar" ? "حد الموافقة" : "Approval max amount")}
            <input type="number" min="0" max={percentOperation ? 100 : undefined} className={`${input} mt-1 w-full`} value={(percentOperation ? row.approval_max_percent : row.approval_max_amount) ?? ""}
              onChange={(e) => patch(row.id, percentOperation ? { approval_max_percent: numberValue(e.target.value) } : { approval_max_amount: numberValue(e.target.value) })} />
          </label>
          <label className="flex items-center gap-2 text-[11px] font-bold text-stone-600"><input type="checkbox" checked={row.allow_approval} onChange={(e) => patch(row.id, { allow_approval: e.target.checked })} />{lang === "ar" ? "تصعيد للموافقة" : "Allow approval"}</label>
          <label className="flex items-center gap-2 text-[11px] font-bold text-stone-600"><input type="checkbox" checked={row.allow_permission_escalation} onChange={(e) => patch(row.id, { allow_permission_escalation: e.target.checked })} />{lang === "ar" ? "تصعيد بدون صلاحية" : "Escalate forbidden"}</label>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" loading={saving === key} onClick={() => { void save(row); }}>{lang === "ar" ? "حفظ" : "Save"}</Button>
          {isDraft ? <Button size="sm" variant="ghost" onClick={() => setDraft(null)}>{lang === "ar" ? "إلغاء" : "Cancel"}</Button> : null}
        </div>
      </div>
    );
  };

  return (
    <Card className="mt-5 overflow-hidden">
      <div className="flex flex-wrap items-start justify-between gap-3 p-5">
        <div>
          <h2 className="font-black text-stone-900">{lang === "ar" ? "حدود العمليات حسب الفرع" : "Branch operation authority"}</h2>
          <p className="mt-1 max-w-3xl text-xs leading-5 text-stone-500">{lang === "ar"
            ? "المنع يبقى منعًا ما لم تسمح السياسة صراحةً بالتصعيد. تتغلب سياسة المستخدم على الدور، والدور على الفرع."
            : "Forbidden stays forbidden unless escalation is explicit. User overrides role; role overrides the branch default."}</p>
        </div>
        {!draft && branch.current ? <Button size="sm" variant="secondary" onClick={() => setDraft(blank(branch.current!.id))}>{lang === "ar" ? "إضافة استثناء" : "Add override"}</Button> : null}
      </div>
      {settings.mode === "demo" ? <p className="border-t p-5 text-sm text-stone-500">{lang === "ar" ? "السياسات الموثوقة متاحة في الوضع المباشر." : "Authoritative policies are available in live mode."}</p>
        : loading ? <LoadingBlock label="Loading…" /> : <div>{rows.map((row) => renderRow(row))}{draft ? renderRow(draft, true) : null}</div>}
    </Card>
  );
}
