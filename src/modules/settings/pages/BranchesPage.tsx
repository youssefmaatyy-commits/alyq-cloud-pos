import { useCallback, useEffect, useMemo, useState } from "react";
import { PageHeader } from "@/components/layout/AppShell";
import { Button, Card, EmptyState, LoadingBlock, useToast } from "@/components/ui";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { useBranch } from "@/lib/branch";
import { can } from "@/lib/permissions/enforce";
import { APP_ROLES, ROLE_LABELS, type AppRole } from "@/lib/permissions/roles";
import { getSupabaseClient } from "@/lib/supabase/client";
import { useSettings } from "../hooks/SettingsProvider";

interface MembershipRow {
  id: string;
  user_id: string;
  branch_id: string;
  role: AppRole;
  custom_role_id: string | null;
  extra_capabilities: string[];
  denied_capabilities: string[];
  active: boolean;
}

const control = "h-10 rounded-xl border border-stone-200 bg-white px-3 text-sm font-semibold text-stone-800 outline-none focus:border-[#b08d57]";

/** Branch assignment is edited only through the audited SECURITY DEFINER RPC. */
export function BranchesPage() {
  const { lang } = useI18n();
  const branch = useBranch();
  const currentBranch = branch.current;
  const settings = useSettings();
  const toast = useToast();
  const [rows, setRows] = useState<MembershipRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);
  const [newUserId, setNewUserId] = useState("");
  const [newRole, setNewRole] = useState<AppRole>("cashier");
  const [pinUser, setPinUser] = useState<string | null>(null);
  const [pin, setPin] = useState("");
  const [branchForm, setBranchForm] = useState({ code: "", name_en: "", name_ar: "" });

  const load = useCallback(async () => {
    if (settings.mode === "demo" || !currentBranch) {
      setRows([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const client = getSupabaseClient();
      const { data, error } = await client!.from("branch_memberships").select("*")
        .eq("branch_id", currentBranch.id).order("created_at");
      if (error) toast.error(error.message);
      setRows((data as MembershipRow[]) ?? []);
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "Could not load branch memberships");
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [currentBranch, settings.mode, toast]);

  useEffect(() => { void load(); }, [load]);

  const userById = useMemo(() => new Map(settings.users.map((user) => [user.id, user])), [settings.users]);
  const unassigned = settings.users.filter((user) => !rows.some((row) => row.user_id === user.id));

  async function saveMembership(row: MembershipRow) {
    if (!branch.current) return;
    setSaving(row.user_id);
    try {
      const { error } = await getSupabaseClient()!.rpc("admin_set_branch_membership", {
        p_user_id: row.user_id,
        p_branch_id: branch.current.id,
        p_role: row.role,
        p_custom_role_id: row.custom_role_id,
        p_extra: row.extra_capabilities,
        p_denied: row.denied_capabilities,
        p_active: row.active,
      });
      if (error) return toast.error(error.message);
      toast.success(lang === "ar" ? "تم تحديث صلاحية الفرع" : "Branch access updated");
      await load();
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "Could not update branch access");
    } finally {
      setSaving(null);
    }
  }

  async function addMembership() {
    if (!newUserId || !branch.current) return;
    await saveMembership({
      id: "", user_id: newUserId, branch_id: branch.current.id, role: newRole,
      custom_role_id: null, extra_capabilities: [], denied_capabilities: [], active: true,
    });
    setNewUserId("");
  }

  async function setManagerPin() {
    if (!pinUser || !branch.current) return;
    const { data, error } = await getSupabaseClient()!.rpc("set_manager_pin", {
      p_user_id: pinUser, p_branch_id: branch.current.id, p_pin: pin,
    });
    setPin("");
    if (error || !(data as { ok?: boolean } | null)?.ok) return toast.error(error?.message ?? "Could not set PIN");
    setPinUser(null);
    toast.success(lang === "ar" ? "تم تعيين رمز موافقة المدير" : "Manager approval PIN set");
  }

  async function createBranch() {
    const { error } = await getSupabaseClient()!.rpc("admin_create_branch", {
      p_code: branchForm.code, p_name_en: branchForm.name_en, p_name_ar: branchForm.name_ar,
    });
    if (error) return toast.error(error.message);
    setBranchForm({ code: "", name_en: "", name_ar: "" });
    await branch.refresh();
    toast.success(lang === "ar" ? "تم إنشاء الفرع" : "Branch created");
  }

  const title = lang === "ar" ? "الفروع وصلاحيات الوصول" : "Branches & access";
  const subtitle = lang === "ar"
    ? "لكل موظف دور وصلاحيات مستقلة في كل فرع."
    : "Each person can have a different role and effective permission set per branch.";

  if (settings.mode === "demo") return (
    <div>
      <PageHeader title={title} subtitle={subtitle} backTo="/settings" />
      <Card><EmptyState icon="⌂" title={lang === "ar" ? "الفرع الرئيسي التجريبي" : "Demo Main Branch"}
        description={lang === "ar" ? "إدارة عضويات الفروع متاحة في الوضع المباشر." : "Branch memberships are managed in live mode."} /></Card>
    </div>
  );

  return (
    <div className="space-y-5">
      <PageHeader title={title} subtitle={subtitle} backTo="/settings" />

      <Card className="p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-xs font-bold uppercase tracking-widest text-[#9a7a49]">{lang === "ar" ? "الفرع النشط" : "Active branch"}</p>
            <h2 className="mt-1 text-lg font-black text-stone-900">{branch.current ? (lang === "ar" ? branch.current.name_ar : branch.current.name_en) : "—"}</h2>
          </div>
          <select className={control} value={branch.current?.id ?? ""}
            onChange={(event) => { void branch.switchBranch(event.target.value); }}>
            {branch.branches.map((item) => <option key={item.id} value={item.id}>{lang === "ar" ? item.name_ar : item.name_en}</option>)}
          </select>
        </div>
      </Card>

      {can("settings.manage") ? (
        <Card className="p-5">
          <h2 className="font-black text-stone-900">{lang === "ar" ? "إنشاء فرع" : "Create branch"}</h2>
          <div className="mt-3 grid gap-3 md:grid-cols-4">
            <input className={control} placeholder="code" value={branchForm.code} onChange={(e) => setBranchForm({ ...branchForm, code: e.target.value })} />
            <input className={control} placeholder="English name" value={branchForm.name_en} onChange={(e) => setBranchForm({ ...branchForm, name_en: e.target.value })} />
            <input dir="rtl" className={control} placeholder="الاسم بالعربية" value={branchForm.name_ar} onChange={(e) => setBranchForm({ ...branchForm, name_ar: e.target.value })} />
            <Button onClick={() => { void createBranch(); }} disabled={!branchForm.code.trim() || !branchForm.name_en.trim() || !branchForm.name_ar.trim()}>
              {lang === "ar" ? "إنشاء" : "Create"}
            </Button>
          </div>
        </Card>
      ) : null}

      <Card className="overflow-hidden">
        <div className="border-b border-stone-100 p-5">
          <h2 className="font-black text-stone-900">{lang === "ar" ? "عضويات الفرع" : "Branch memberships"}</h2>
          <p className="mt-1 text-xs text-stone-500">{lang === "ar" ? "إلغاء العضوية يمنع القراءة والكتابة من الخادم." : "Deactivation blocks both reads and writes at the server."}</p>
        </div>
        {loading ? <LoadingBlock label="Loading…" /> : (
          <div className="divide-y divide-stone-100">
            {rows.map((row) => {
              const user = userById.get(row.user_id);
              return (
                <div key={row.user_id} className="grid items-center gap-3 p-4 md:grid-cols-[1fr_180px_110px_auto]">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-black text-stone-900">{user?.name ?? row.user_id}</p>
                    <p className="truncate text-xs text-stone-500">{user?.username ?? row.user_id}</p>
                  </div>
                  <select className={control} value={row.role} onChange={(e) => setRows((all) => all.map((item) => item.user_id === row.user_id ? { ...item, role: e.target.value as AppRole, custom_role_id: null } : item))}>
                    {APP_ROLES.map((role) => <option key={role} value={role}>{ROLE_LABELS[role]}</option>)}
                  </select>
                  <label className="flex items-center gap-2 text-xs font-bold text-stone-600">
                    <input type="checkbox" checked={row.active} onChange={(e) => setRows((all) => all.map((item) => item.user_id === row.user_id ? { ...item, active: e.target.checked } : item))} />
                    {lang === "ar" ? "نشط" : "Active"}
                  </label>
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" onClick={() => { void saveMembership(row); }} loading={saving === row.user_id}>{lang === "ar" ? "حفظ" : "Save"}</Button>
                    {row.active && (row.role === "admin" || row.role === "manager") ? (
                      <Button size="sm" variant="ghost" onClick={() => setPinUser(row.user_id)}>{lang === "ar" ? "رمز المدير" : "Manager PIN"}</Button>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        )}
        {unassigned.length > 0 ? (
          <div className="grid gap-3 border-t border-stone-100 bg-stone-50 p-4 md:grid-cols-[1fr_180px_auto]">
            <select className={control} value={newUserId} onChange={(e) => setNewUserId(e.target.value)}>
              <option value="">{lang === "ar" ? "اختر موظفًا" : "Choose a user"}</option>
              {unassigned.map((user) => <option key={user.id} value={user.id}>{user.name} · {user.username}</option>)}
            </select>
            <select className={control} value={newRole} onChange={(e) => setNewRole(e.target.value as AppRole)}>
              {APP_ROLES.map((role) => <option key={role} value={role}>{ROLE_LABELS[role]}</option>)}
            </select>
            <Button onClick={() => { void addMembership(); }} disabled={!newUserId}>{lang === "ar" ? "إسناد" : "Assign"}</Button>
          </div>
        ) : null}
      </Card>

      {pinUser ? (
        <Card className="border-amber-200 bg-amber-50/40 p-5">
          <h2 className="font-black text-stone-900">{lang === "ar" ? "تعيين رمز موافقة المدير" : "Set manager approval PIN"}</h2>
          <p className="mt-1 text-xs text-stone-600">{lang === "ar" ? "يُرسل الرمز للتحقق الآمن ولا يُعاد عرضه." : "The PIN is sent for secure hashing and is never returned."}</p>
          <div className="mt-3 flex flex-wrap gap-3">
            <input type="password" inputMode="numeric" autoComplete="new-password" className={control} value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 12))} placeholder="4–12 digits" />
            <Button onClick={() => { void setManagerPin(); }} disabled={!/^\d{4,12}$/.test(pin)}>{lang === "ar" ? "حفظ الرمز" : "Save PIN"}</Button>
            <Button variant="ghost" onClick={() => { setPinUser(null); setPin(""); }}>{lang === "ar" ? "إلغاء" : "Cancel"}</Button>
          </div>
        </Card>
      ) : null}
    </div>
  );
}
