import { safeStorage } from "@/modules/products/data/demoSeed";
import { AppError } from "@/modules/products/data/repository";
import { roundMoney } from "@/modules/expenses/validation";
import { cashDifference } from "../services/shiftCalculations";
import type { CloseShiftInput, NewShift, Shift } from "../types";
import type { ShiftRepository } from "./repository";

const SHIFTS_KEY = "alyq.demo.shifts.v1";
const COUNTER_KEY = "alyq.demo.shift_counter.v1";
const LATENCY = 90;

function nowIso(): string {
  return new Date().toISOString();
}

function delay<T>(value: T, ms = LATENCY): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

function newId(): string {
  const rand =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID().slice(0, 13)
      : Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  return `shf-${rand}`;
}

function load(): Shift[] {
  const raw = safeStorage.get(SHIFTS_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as Shift[]) : [];
  } catch {
    return [];
  }
}

function persist(list: Shift[]): void {
  safeStorage.set(SHIFTS_KEY, JSON.stringify(list));
}

/** Sequential, human-readable shift numbers (SH-000001). */
function nextShiftNumber(): string {
  const current = Number(safeStorage.get(COUNTER_KEY)) || 0;
  const next = Math.max(1, current + 1);
  safeStorage.set(COUNTER_KEY, String(next));
  return `SH-${String(next).padStart(6, "0")}`;
}

export class DemoShiftRepository implements ShiftRepository {
  readonly kind = "demo" as const;
  private shifts: Shift[];

  constructor() {
    this.shifts = load();
  }

  private commit(): void {
    persist(this.shifts);
  }

  private find(id: string): Shift {
    const shift = this.shifts.find((s) => s.id === id);
    if (!shift) throw new AppError("NOT_FOUND", `Shift ${id} not found`);
    return shift;
  }

  async listShifts(): Promise<Shift[]> {
    const sorted = [...this.shifts].sort((a, b) => b.opening_at.localeCompare(a.opening_at));
    return delay(sorted);
  }

  async getShift(id: string): Promise<Shift> {
    return delay({ ...this.find(id) });
  }

  async getOpenShift(): Promise<Shift | null> {
    const open = this.shifts.find((s) => s.status === "open") ?? null;
    return delay(open ? { ...open } : null);
  }

  async openShift(input: NewShift): Promise<Shift> {
    if (this.shifts.some((s) => s.status === "open")) {
      throw new AppError(
        "VALIDATION",
        "A shift is already open. Close it before opening a new one.",
        "shift",
      );
    }
    const at = input.opening_at ?? nowIso();
    const shift: Shift = {
      id: newId(),
      shift_number: nextShiftNumber(),
      branch: input.branch,
      register: input.register,
      status: "open",
      opening_cash: roundMoney(input.opening_cash),
      opening_at: at,
      opened_by: input.opened_by,
      opened_by_name: input.opened_by_name,
      closing_cash: null,
      closed_at: null,
      closed_by: null,
      closed_by_name: null,
      notes: null,
      summary: null,
      adjustment_approved_by: null,
      adjustment_approved_by_name: null,
      adjustment_approved_at: null,
      created_at: at,
      updated_at: at,
    };
    this.shifts = [shift, ...this.shifts];
    this.commit();
    return delay({ ...shift });
  }

  async closeShift(id: string, input: CloseShiftInput): Promise<Shift> {
    const shift = this.find(id);
    if (shift.status === "closed") {
      throw new AppError("VALIDATION", `Shift ${shift.shift_number} is already closed`, "shift");
    }
    const at = input.closed_at ?? nowIso();
    const summary = {
      ...input.summary,
      actual_cash: roundMoney(input.closing_cash),
      difference: cashDifference(input.closing_cash, input.summary.expected_cash),
    };
    const updated: Shift = {
      ...shift,
      status: "closed",
      closing_cash: roundMoney(input.closing_cash),
      closed_at: at,
      closed_by: input.closed_by,
      closed_by_name: input.closed_by_name,
      notes: input.notes?.trim() ? input.notes.trim() : null,
      summary,
      updated_at: at,
    };
    this.shifts = this.shifts.map((s) => (s.id === id ? updated : s));
    this.commit();
    return delay({ ...updated });
  }

  async approveAdjustment(id: string, approverId: string, approverName: string): Promise<Shift> {
    const shift = this.find(id);
    const at = nowIso();
    const updated: Shift = {
      ...shift,
      adjustment_approved_by: approverId,
      adjustment_approved_by_name: approverName,
      adjustment_approved_at: at,
      updated_at: at,
    };
    this.shifts = this.shifts.map((s) => (s.id === id ? updated : s));
    this.commit();
    return delay({ ...updated });
  }
}

let singleton: DemoShiftRepository | null = null;
export function getDemoShiftRepository(): DemoShiftRepository {
  if (!singleton) singleton = new DemoShiftRepository();
  return singleton;
}

/** Test/demo helper — wipes persisted shifts and the numbering counter. */
export function resetDemoShifts(): void {
  safeStorage.set(SHIFTS_KEY, "[]");
  safeStorage.set(COUNTER_KEY, "0");
  if (singleton) singleton = new DemoShiftRepository();
}
