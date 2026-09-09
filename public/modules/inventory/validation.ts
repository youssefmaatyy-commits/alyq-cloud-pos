import {
  STOCK_MOVEMENT_TYPES,
  STOCK_REASONS,
  type StockAdjustmentFormValues,
  type StockMovementType,
  type StockReason,
} from "./types";

export type AdjustmentFieldCode =
  | "quantityRequired"
  | "quantityPositive"
  | "quantityInteger"
  | "notesTooLong";

export type AdjustmentErrors = Partial<Record<keyof StockAdjustmentFormValues, AdjustmentFieldCode>>;

export interface AdjustmentValidationResult {
  errors: AdjustmentErrors;
  data: {
    type: StockMovementType;
    reason: StockReason;
    quantity: number;
    notes: string | null;
  } | null;
}

const MAX_NOTES_LENGTH = 500;

export function parseAdjustmentQuantity(raw: string): { value: number; isInteger: boolean } {
  const cleaned = raw.replace(/[^\d.,-]/g, "").replace(/,/g, ".");
  const normalized =
    cleaned.indexOf(".") !== cleaned.lastIndexOf(".")
      ? cleaned.replace(/,/g, "")
      : cleaned;
  const value = Number(normalized);
  if (!Number.isFinite(value)) return { value: NaN, isInteger: false };
  return { value, isInteger: Number.isInteger(value) };
}

export function validateAdjustment(
  values: StockAdjustmentFormValues,
): AdjustmentValidationResult {
  const errors: AdjustmentErrors = {};

  if (!STOCK_MOVEMENT_TYPES.includes(values.type)) {
    errors.type = undefined;
  }
  if (!STOCK_REASONS.includes(values.reason)) {
    errors.reason = undefined;
  }

  if (!values.quantity.trim()) {
    errors.quantity = "quantityRequired";
  } else {
    const { value, isInteger } = parseAdjustmentQuantity(values.quantity);
    if (Number.isNaN(value)) {
      errors.quantity = "quantityRequired";
    } else if (value <= 0) {
      errors.quantity = "quantityPositive";
    } else if (!isInteger) {
      errors.quantity = "quantityInteger";
    }
  }

  if (values.notes.length > MAX_NOTES_LENGTH) {
    errors.notes = "notesTooLong";
  }

  if (errors.quantity || errors.type || errors.reason || errors.notes) {
    return { errors, data: null };
  }
  const { value } = parseAdjustmentQuantity(values.quantity);
  return {
    errors,
    data: {
      type: values.type,
      reason: values.reason,
      quantity: value,
      notes: values.notes.trim() ? values.notes.trim() : null,
    },
  };
}

export const ADJUSTMENT_ERROR_KEY: Record<AdjustmentFieldCode, string> = {
  quantityRequired: "inventory.errors.quantityRequired",
  quantityPositive: "inventory.errors.quantityPositive",
  quantityInteger: "inventory.errors.quantityInteger",
  notesTooLong: "inventory.errors.notesTooLong",
};

export const MAX_ADJUSTMENT_NOTES = MAX_NOTES_LENGTH;
