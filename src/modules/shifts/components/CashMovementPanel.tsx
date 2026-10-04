import { useCallback, useEffect, useState } from "react";
import { Button, Card, Field, TextInput, useToast } from "@/components/ui";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { can } from "@/lib/permissions/enforce";
import { getSupabaseClient } from "@/lib/supabase/client";
import type { Shift } from "../types";

interface MovementRow {
  id: string;
  movement_number: string;
  kind: "cash_in" | "cash_out";
  amount: number | string;
  reason: string;
  approver_name: string | null;
  created_at: string;
}

export function CashMovementPanel({ shift, mode, onChanged }: {
  shift: Shift;
  mode: "demo" | "supabase";
  onChanged: () => void;
}) {
  const { lang, money, date } = useI18n();
  const toast = useToast();
  const [rows, setRows] = useState<MovementRow[]>([]);
  const [kind, setKind] = useState<"cash_in" | "cash_out">("cash_in");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [approvalNeeded, setApprovalNeeded] = useState(false);
  const [managerUsername, setManagerUsername] = useState("");
  const [managerPin, setManagerPin] = useState("");

  const load = useCallback(async () => {
    if (mode !== "supabase") return setRows([]);
    const { data } = await getSupabaseClient()!.from("cash_movements").select("*")
      .eq("shift_id", shift.id).order("created_at", { ascending: false });
    setRows((data as MovementRow[]) ?? []);
  }, [mode, shift.id]);
  useEffect(() => { void load(); }, [load]);

  const payload = () => ({
    kind,
    amount: Math.round(Number(amount) * 100) / 100,
    reason: reason.trim(),
    note: null,
    shift_id: shift.id,
  });

  async function record(approvalRequestId: string | null = null) {
    const value = Number(amount);
    if (!(value > 0) || !reason.trim()) return;
    setBusy(true);
    try {
      const client = getSupabaseClient();
      if (!client || mode !== "supabase") throw new Error(lang === "ar" ? "حركات الدرج الموثوقة غير متاحة دون اتصال." : "Authoritative drawer movements are unavailable offline.");
      const { error } = await client.rpc("record_cash_movement", {
        p_kind: kind,
        p_amount: value,
        p_reason: reason.trim(),
        p_note: null,
        p_approval_request_id: approvalRequestId,
      });
      if (error) {
        if (kind === "cash_out" && /approval required/i.test(error.message)) {
          setApprovalNeeded(true);
          return;
        }
        throw error;
      }
      setAmount(""); setReason(""); setApprovalNeeded(false); setManagerUsername(""); setManagerPin("");
      toast.success(lang === "ar" ? "تم تسجيل حركة الدرج" : "Drawer movement recorded");
      await load(); onChanged();
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "Could not record cash movement");
    } finally {
      setBusy(false);
      if (approvalRequestId) setManagerPin("");
    }
  }

  async function approveAndRecord() {
    if (!managerUsername.trim() || !/^\d{4,12}$/.test(managerPin)) return;
    setBusy(true);
    try {
      const client = getSupabaseClient()!;
      const exactPayload = payload();
      const { data: requestData, error: requestError } = await client.rpc("submit_approval_request", {
        p_request: {
          kind: "expense",
          operation_type: "cash_out",
          entity_type: "cash_movement",
          entity_id: shift.id,
          entity_label: shift.shift_number,
          amount: exactPayload.amount,
          payload: exactPayload,
          reason: exactPayload.reason,
        },
      });
      if (requestError) throw requestError;
      const requestId = (requestData as { request_id?: string })?.request_id;
      if (!requestId) throw new Error("Approval request was not created");
      const { data: approved, error: approvalError } = await client.rpc("approve_with_manager_pin", {
        p_request_id: requestId,
        p_manager_username: managerUsername.trim(),
        p_pin: managerPin,
      });
      if (approvalError) throw approvalError;
      const result = approved as { ok?: boolean; code?: string };
      if (!result.ok) throw new Error(result.code ?? "Manager approval refused");
      await record(requestId);
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "Manager approval refused");
      setManagerPin("");
    } finally {
      setBusy(false);
    }
  }

  if (!can(kind === "cash_in" ? "shifts.cash_in" : "shifts.cash_out") && rows.length === 0) return null;

  return (
    <Card className="mb-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-black text-stone-900">{lang === "ar" ? "حركات درج النقدية" : "Drawer cash movements"}</h2>
          <p className="mt-1 text-xs text-stone-500">{lang === "ar" ? "إدخال وإخراج نقدي حقيقي، وليس فاتورة وهمية." : "Real cash in and cash out — never a fake sale."}</p>
        </div>
        <div className="flex rounded-xl bg-stone-100 p-1">
          {(["cash_in", "cash_out"] as const).filter((item) => can(item === "cash_in" ? "shifts.cash_in" : "shifts.cash_out")).map((item) => (
            <button key={item} className={`rounded-lg px-3 py-1.5 text-xs font-black ${kind === item ? "bg-white text-stone-900 shadow-sm" : "text-stone-500"}`} onClick={() => { setKind(item); setApprovalNeeded(false); }}>{item === "cash_in" ? (lang === "ar" ? "إدخال" : "Cash in") : (lang === "ar" ? "إخراج" : "Cash out")}</button>
          ))}
        </div>
      </div>
      <div className="mt-4 grid gap-3 md:grid-cols-[160px_1fr_auto]">
        <Field label={lang === "ar" ? "المبلغ" : "Amount"} required htmlFor="cash-movement-amount">
          <TextInput id="cash-movement-amount" type="number" min="0.01" step="0.01" value={amount} onChange={(event) => setAmount(event.target.value)} />
        </Field>
        <Field label={lang === "ar" ? "السبب" : "Reason"} required htmlFor="cash-movement-reason">
          <TextInput id="cash-movement-reason" maxLength={120} value={reason} onChange={(event) => setReason(event.target.value)} />
        </Field>
        <Button className="self-end" loading={busy} disabled={mode !== "supabase" || !reason.trim() || !(Number(amount) > 0)} onClick={() => { void record(); }}>
          {lang === "ar" ? "تسجيل" : "Record"}
        </Button>
      </div>
      {mode !== "supabase" ? <p className="mt-2 text-xs font-semibold text-amber-700">{lang === "ar" ? "غير متاح دون اتصال." : "Unavailable offline."}</p> : null}

      {approvalNeeded ? (
        <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-4">
          <p className="text-sm font-black text-amber-950">{lang === "ar" ? "يتطلب إخراج النقدية موافقة مدير في نفس الفرع" : "Cash out needs a same-branch manager"}</p>
          <div className="mt-3 grid gap-3 sm:grid-cols-[1fr_160px_auto]">
            <TextInput autoComplete="off" placeholder={lang === "ar" ? "اسم مستخدم المدير" : "Manager username"} value={managerUsername} onChange={(event) => setManagerUsername(event.target.value)} />
            <TextInput type="password" inputMode="numeric" autoComplete="one-time-code" placeholder="PIN" value={managerPin} onChange={(event) => setManagerPin(event.target.value.replace(/\D/g, "").slice(0, 12))} />
            <Button loading={busy} disabled={!managerUsername.trim() || !/^\d{4,12}$/.test(managerPin)} onClick={() => { void approveAndRecord(); }}>{lang === "ar" ? "موافقة وتنفيذ" : "Approve & record"}</Button>
          </div>
        </div>
      ) : null}

      {rows.length > 0 ? (
        <div className="mt-5 overflow-x-auto border-t border-stone-100 pt-3">
          <table className="w-full text-xs"><tbody>{rows.slice(0, 8).map((row) => (
            <tr key={row.id} className="border-b border-stone-100 last:border-0">
              <td className="py-2 font-mono font-bold text-stone-500">{row.movement_number}</td>
              <td className={`py-2 font-black ${row.kind === "cash_in" ? "text-emerald-700" : "text-rose-700"}`}>{row.kind === "cash_in" ? "+" : "−"}{money(Number(row.amount))}</td>
              <td className="py-2 text-stone-700">{row.reason}</td>
              <td className="py-2 text-stone-500">{row.approver_name ?? "—"}</td>
              <td className="py-2 text-end text-stone-400" dir="ltr">{date(row.created_at)}</td>
            </tr>
          ))}</tbody></table>
        </div>
      ) : null}
    </Card>
  );
}
