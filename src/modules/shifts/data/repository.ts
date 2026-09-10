import type { CloseShiftInput, NewShift, Shift } from "../types";

export interface ShiftRepository {
  readonly kind: "demo" | "supabase";
  listShifts(): Promise<Shift[]>;
  getShift(id: string): Promise<Shift>;
  /** The single currently-open shift, if any (there can be at most one). */
  getOpenShift(): Promise<Shift | null>;
  openShift(input: NewShift): Promise<Shift>;
  closeShift(id: string, input: CloseShiftInput): Promise<Shift>;
  approveAdjustment(id: string, approverId: string, approverName: string): Promise<Shift>;
}
