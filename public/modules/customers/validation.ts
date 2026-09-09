import type { Customer, NewCustomer } from "./types";

export interface CustomerFormValues {
  name: string;
  phone: string;
  address: string;
  notes: string;
}

export const EMPTY_CUSTOMER_FORM: CustomerFormValues = {
  name: "",
  phone: "",
  address: "",
  notes: "",
};

export function customerToForm(customer: Customer): CustomerFormValues {
  return {
    name: customer.name,
    phone: customer.phone,
    address: customer.address ?? "",
    notes: customer.notes ?? "",
  };
}

export type CustomerFieldErrorCode =
  | "nameRequired"
  | "nameTooLong"
  | "phoneRequired"
  | "phoneInvalid"
  | "phoneTaken"
  | "addressTooLong"
  | "notesTooLong";

export type CustomerFieldErrors = Partial<Record<keyof CustomerFormValues, CustomerFieldErrorCode>>;

export const MAX_CUSTOMER_NAME = 100;
export const MAX_CUSTOMER_PHONE = 30;
export const MAX_CUSTOMER_ADDRESS = 300;
export const MAX_CUSTOMER_NOTES = 500;

export function validateCustomerDraft(
  values: CustomerFormValues,
  existingCustomers: Customer[] = [],
  currentId?: string,
): { errors: CustomerFieldErrors; data: NewCustomer | null } {
  const errors: CustomerFieldErrors = {};
  const name = values.name.trim();
  const phone = values.phone.trim();
  const address = values.address.trim();
  const notes = values.notes.trim();

  if (!name) {
    errors.name = "nameRequired";
  } else if (name.length > MAX_CUSTOMER_NAME) {
    errors.name = "nameTooLong";
  }

  if (!phone) {
    errors.phone = "phoneRequired";
  } else if (phone.length > MAX_CUSTOMER_PHONE) {
    errors.phone = "phoneInvalid";
  } else if (!/^[0-9+\-\s()]+$/.test(phone)) {
    errors.phone = "phoneInvalid";
  } else {
    const clash = existingCustomers.find((c) => c.id !== currentId && c.phone.trim() === phone);
    if (clash) {
      errors.phone = "phoneTaken";
    }
  }

  if (address.length > MAX_CUSTOMER_ADDRESS) {
    errors.address = "addressTooLong";
  }

  if (notes.length > MAX_CUSTOMER_NOTES) {
    errors.notes = "notesTooLong";
  }

  if (Object.keys(errors).length > 0) {
    return { errors, data: null };
  }

  return {
    errors: {},
    data: {
      name,
      phone,
      address: address || null,
      notes: notes || null,
    },
  };
}
