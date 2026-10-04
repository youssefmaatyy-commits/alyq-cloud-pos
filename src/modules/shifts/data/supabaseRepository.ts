import { getSupabaseClient } from "@/lib/supabase/client";
import { AppError, toAppError } from "@/modules/products/data/repository";
import { roundMoney } from "@/modules/expenses/validation";
import type { CloseShiftInput, NewShift, Shift, ShiftSummary } from "../types";
import type { ShiftRepository } from "./repository";
import { getRegisterCredential } from "@/modules/registers/services/registerService";

interface ShiftRow {
  id: string;
  shift_number: string;
  branch: string;
  branch_id: string;
  register: string;
  register_id?: string | null;
  status: string;
  opening_cash: number;
  opening_at: string;
  opened_by: string;
  opened_by_name: string;
  closing_cash: number | null;
  closed_at: string | null;
  closed_by: string | null;
  closed_by_name: string | null;
  notes: string | null;
  summary: ShiftSummary | null;
  adjustment_approved_by: string | null;
  adjustment_approved_by_name: string | null;
  adjustment_approved_at: string | null;
  created_at: string;
  updated_at: string;
}

function mapShift(row: ShiftRow): Shift {
  return {
    id: row.id,
    shift_number: row.shift_number,
    branch: row.branch,
    branch_id: row.branch_id,
    register: row.register,
    register_id: row.register_id ?? null,
    status: row.status === "closed" ? "closed" : "open",
    opening_cash: Number(row.opening_cash),
    opening_at: row.opening_at,
    opened_by: row.opened_by,
    opened_by_name: row.opened_by_name,
    closing_cash: row.closing_cash === null ? null : Number(row.closing_cash),
    closed_at: row.closed_at,
    closed_by: row.closed_by,
    closed_by_name: row.closed_by_name,
    notes: row.notes,
    summary: row.summary ?? null,
    adjustment_approved_by: row.adjustment_approved_by,
    adjustment_approved_by_name: row.adjustment_approved_by_name,
    adjustment_approved_at: row.adjustment_approved_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export class SupabaseShiftRepository implements ShiftRepository {
  readonly kind = "supabase" as const;

  private require() {
    const client = getSupabaseClient();
    if (!client) throw new AppError("NOT_CONFIGURED");
    return client;
  }

  async listShifts(): Promise<Shift[]> {
    try {
      const { data, error } = await this.require()
        .from("shifts")
        .select("*")
        .order("opening_at", { ascending: false });
      if (error) throw toAppError(error);
      return ((data as ShiftRow[]) ?? []).map(mapShift);
    } catch (err) {
      if (err instanceof AppError) throw err;
      throw toAppError(err);
    }
  }

  async getShift(id: string): Promise<Shift> {
    try {
      const { data, error } = await this.require().from("shifts").select("*").eq("id", id).single();
      if (error) throw toAppError(error);
      return mapShift(data as ShiftRow);
    } catch (err) {
      if (err instanceof AppError) throw err;
      throw toAppError(err);
    }
  }

  async getOpenShift(): Promise<Shift | null> {
    try {
      const { data, error } = await this.require()
        .from("shifts")
        .select("*")
        .eq("status", "open")
        .order("opening_at", { ascending: false })
        .limit(1);
      if (error) throw toAppError(error);
      const rows = (data as ShiftRow[]) ?? [];
      return rows.length > 0 ? mapShift(rows[0]) : null;
    } catch (err) {
      if (err instanceof AppError) throw err;
      throw toAppError(err);
    }
  }

  async openShift(input: NewShift): Promise<Shift> {
    try {
      const client = this.require();
      const register = await getRegisterCredential();
      if (register) {
        const { data, error } = await client.rpc("open_registered_shift", {
          p_opening_cash: roundMoney(input.opening_cash),
          p_installation_id: register.installation_id,
          p_credential: register.credential,
        });
        if (error) throw toAppError(error);
        return mapShift(data as ShiftRow);
      }
      const { data, error } = await client
        .from("shifts")
        .insert({
          branch: input.branch,
          register: input.register,
          status: "open",
          opening_cash: roundMoney(input.opening_cash),
          opening_at: input.opening_at ?? new Date().toISOString(),
          opened_by: input.opened_by,
          opened_by_name: input.opened_by_name,
        })
        .select("*")
        .single();
      if (error) throw toAppError(error);
      return mapShift(data as ShiftRow);
    } catch (err) {
      if (err instanceof AppError) throw err;
      throw toAppError(err);
    }
  }

  async closeShift(id: string, input: CloseShiftInput): Promise<Shift> {
    try {
      // The server derives all tender/refund/movement totals from authoritative
      // allocations under the shift lock. Client `summary` is intentionally not
      // sent and cannot become the frozen reconciliation snapshot.
      const { data, error } = await this.require().rpc("close_shift_authoritative", {
        p_shift_id: id,
        p_actual_cash: input.closing_cash,
        p_reason: input.notes?.trim() || null,
      });
      if (error) throw toAppError(error);
      return mapShift(data as ShiftRow);
    } catch (err) {
      if (err instanceof AppError) throw err;
      throw toAppError(err);
    }
  }

  async approveAdjustment(id: string, approverId: string, approverName: string): Promise<Shift> {
    try {
      const at = new Date().toISOString();
      const { data, error } = await this.require()
        .from("shifts")
        .update({
          adjustment_approved_by: approverId,
          adjustment_approved_by_name: approverName,
          adjustment_approved_at: at,
          updated_at: at,
        })
        .eq("id", id)
        .select("*")
        .single();
      if (error) throw toAppError(error);
      return mapShift(data as ShiftRow);
    } catch (err) {
      if (err instanceof AppError) throw err;
      throw toAppError(err);
    }
  }
}

let singleton: SupabaseShiftRepository | null = null;
export function getSupabaseShiftRepository(): SupabaseShiftRepository {
  if (!singleton) singleton = new SupabaseShiftRepository();
  return singleton;
}
