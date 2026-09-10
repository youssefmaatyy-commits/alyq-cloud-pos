import { getShiftRepository } from "../data";
import { normalizeText } from "@/modules/products/services/productQuery";
import type { CloseShiftInput, NewShift, Shift, ShiftFiltersValue } from "../types";

export async function loadShifts(): Promise<Shift[]> {
  return getShiftRepository().listShifts();
}

export async function loadOpenShift(): Promise<Shift | null> {
  return getShiftRepository().getOpenShift();
}

export async function openShift(input: NewShift): Promise<Shift> {
  return getShiftRepository().openShift(input);
}

export async function closeShift(id: string, input: CloseShiftInput): Promise<Shift> {
  return getShiftRepository().closeShift(id, input);
}

export async function approveShiftAdjustment(
  id: string,
  approverId: string,
  approverName: string,
): Promise<Shift> {
  return getShiftRepository().approveAdjustment(id, approverId, approverName);
}

export function queryShifts(shifts: Shift[], filters: ShiftFiltersValue): Shift[] {
  const terms = normalizeText(filters.search).split(" ").filter(Boolean);
  return shifts.filter((shift) => {
    if (filters.status !== "all" && shift.status !== filters.status) return false;
    if (terms.length === 0) return true;
    const haystack = normalizeText(
      `${shift.shift_number} ${shift.branch} ${shift.register} ${shift.opened_by_name} ${shift.closed_by_name ?? ""}`,
    );
    return terms.every((term) => haystack.includes(term));
  });
}

/** Short human duration between two instants, e.g. "3h 24m". */
export function shiftDuration(openingAt: string, closingAt: string | null): string {
  const start = new Date(openingAt).getTime();
  const end = closingAt ? new Date(closingAt).getTime() : Date.now();
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return "—";
  const minutes = Math.floor((end - start) / 60000);
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}
