import { assertSensitiveAction } from "@/lib/permissions/actions";
import { getShiftRepository } from "../data";
import { normalizeText } from "@/modules/products/services/productQuery";
import type { CloseShiftInput, NewShift, Shift, ShiftFiltersValue } from "../types";

export async function loadShifts(): Promise<Shift[]> {
  return getShiftRepository().listShifts();
}

/** Opening the drawer needs `open_shift`. */
export function assertCanOpenShift(): void {
  assertSensitiveAction("shift.open");
}

/** Closing it needs `close_shift`. */
export function assertCanCloseShift(): void {
  assertSensitiveAction("shift.close");
}

/** Signing off somebody else's cash difference needs `approve_shift_adjustment`. */
export function assertCanApproveShiftAdjustment(): void {
  assertSensitiveAction("shift.approve_adjustment");
}

/**
 * Reading the cash difference needs `view_shifts`.
 *
 * The difference is the most sensitive number on a shift: it names a person and
 * a shortfall. Every role that can open the shift history holds `view_shifts`,
 * so this refuses nobody who could already see the page — it refuses the caller
 * who reached the service some other way.
 */
export function assertCanViewShiftDifferences(): void {
  assertSensitiveAction("shift.view_differences");
}

export async function openShift(input: NewShift): Promise<Shift> {
  assertCanOpenShift();
  return getShiftRepository().openShift(input);
}

export async function closeShift(id: string, input: CloseShiftInput): Promise<Shift> {
  assertCanCloseShift();
  return getShiftRepository().closeShift(id, input);
}

export async function approveShiftAdjustment(
  id: string,
  approverId: string,
  approverName: string,
): Promise<Shift> {
  assertCanApproveShiftAdjustment();
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
