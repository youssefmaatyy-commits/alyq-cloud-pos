import type { CloseShiftFormValues, ShiftFormValues } from "./types";

export const MAX_SHIFT_NOTES = 400;
export const MAX_SHIFT_BRANCH = 80;
export const MAX_OPENING_CASH = 10_000_000;

export type ShiftFieldCode = "branch" | "register" | "opening_cash" | "closing_cash" | "notes";
export type ShiftErrors = Partial<Record<ShiftFieldCode, string>>;

/** Parse a money string; returns NaN when it is not a number. */
export function parseMoney(value: string): number {
  const cleaned = value.replace(/[,\s]/g, "");
  if (!cleaned) return Number.NaN;
  return Number(cleaned);
}

export function validateShiftDraft(values: ShiftFormValues): ShiftErrors {
  const errors: ShiftErrors = {};
  const branch = values.branch.trim();
  const opening = parseMoney(values.opening_cash);

  if (!branch) errors.branch = "shifts.error.branchRequired";
  else if (branch.length > MAX_SHIFT_BRANCH) errors.branch = "shifts.error.branchTooLong";

  if (!values.register.trim()) errors.register = "shifts.error.registerRequired";

  if (!Number.isFinite(opening)) errors.opening_cash = "shifts.error.openingRequired";
  else if (opening < 0) errors.opening_cash = "shifts.error.openingNegative";
  else if (opening > MAX_OPENING_CASH) errors.opening_cash = "shifts.error.openingTooLarge";

  return errors;
}

export function validateCloseDraft(values: CloseShiftFormValues): ShiftErrors {
  const errors: ShiftErrors = {};
  const closing = parseMoney(values.closing_cash);

  if (!Number.isFinite(closing)) errors.closing_cash = "shifts.error.closingRequired";
  else if (closing < 0) errors.closing_cash = "shifts.error.closingNegative";
  else if (closing > MAX_OPENING_CASH) errors.closing_cash = "shifts.error.closingTooLarge";

  if (values.notes.trim().length > MAX_SHIFT_NOTES) errors.notes = "shifts.error.notesTooLong";

  return errors;
}
