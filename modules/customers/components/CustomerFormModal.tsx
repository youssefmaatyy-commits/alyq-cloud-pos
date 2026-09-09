import { useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { useToast } from "@/components/ui";
import { Button, Field, Modal, TextArea, TextInput } from "@/components/ui";
import type { Customer } from "../types";
import {
  EMPTY_CUSTOMER_FORM,
  MAX_CUSTOMER_ADDRESS,
  MAX_CUSTOMER_NAME,
  MAX_CUSTOMER_NOTES,
  MAX_CUSTOMER_PHONE,
  customerToForm,
  validateCustomerDraft,
  type CustomerFieldErrors,
  type CustomerFormValues,
} from "../validation";
import { useCustomers } from "../hooks/CustomerProvider";

export interface CustomerFormModalProps {
  open: boolean;
  onClose: () => void;
  customer?: Customer | null;
  onSaved?: (savedCustomer: Customer) => void;
}

export function CustomerFormModal({
  open,
  onClose,
  customer,
  onSaved,
}: CustomerFormModalProps) {
  const { t } = useI18n();
  const toast = useToast();
  const { customers, saveCustomer } = useCustomers();

  const [values, setValues] = useState<CustomerFormValues>(EMPTY_CUSTOMER_FORM);
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [submitAttempted, setSubmitAttempted] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setValues(customer ? customerToForm(customer) : EMPTY_CUSTOMER_FORM);
    setTouched({});
    setSubmitAttempted(false);
  }, [open, customer]);

  const validation = validateCustomerDraft(values, customers, customer?.id);
  const errors: CustomerFieldErrors = validation.errors;

  const showError = (field: keyof CustomerFormValues) =>
    touched[field] || submitAttempted ? errors[field] : undefined;

  const handleSave = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    setSubmitAttempted(true);
    if (Object.keys(errors).length > 0) {
      toast.error(t("validation.fixErrors"));
      return;
    }
    setSaving(true);
    try {
      const { customer: saved, isNew } = await saveCustomer(values, customer?.id);
      toast.success(t(isNew ? "customers.createdToast" : "customers.updatedToast"));
      onClose();
      if (onSaved) onSaved(saved);
    } catch (err) {
      const error = err as { field?: string; message?: string };
      if (error.field === "phone") {
        toast.error(t("customers.phoneTaken"));
      } else {
        toast.error(t("customers.saveError"));
      }
    } finally {
      setSaving(false);
    }
  };

  const getErrorMessage = (code?: string) => {
    if (!code) return undefined;
    switch (code) {
      case "nameRequired":
        return t("customers.nameRequired");
      case "nameTooLong":
        return t("customers.nameTooLong", { max: MAX_CUSTOMER_NAME });
      case "phoneRequired":
        return t("customers.phoneRequired");
      case "phoneInvalid":
        return t("customers.phoneInvalid");
      case "phoneTaken":
        return t("customers.phoneTaken");
      case "addressTooLong":
        return t("customers.addressTooLong", { max: MAX_CUSTOMER_ADDRESS });
      case "notesTooLong":
        return t("customers.notesTooLong", { max: MAX_CUSTOMER_NOTES });
      default:
        return t("validation.required");
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={customer ? t("customers.edit") : t("customers.add")}
      size="md"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            {t("common.cancel")}
          </Button>
          <Button onClick={() => void handleSave()} loading={saving}>
            {saving ? t("common.saving") : t("common.save")}
          </Button>
        </>
      }
    >
      <form onSubmit={(e) => void handleSave(e)} className="space-y-3" noValidate>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            label={t("customers.name")}
            required
            error={getErrorMessage(showError("name"))}
            htmlFor="cust-name"
          >
            <TextInput
              id="cust-name"
              value={values.name}
              maxLength={MAX_CUSTOMER_NAME}
              invalid={Boolean(showError("name"))}
              onBlur={() => setTouched((p) => ({ ...p, name: true }))}
              onChange={(e) => setValues((p) => ({ ...p, name: e.target.value }))}
              placeholder={t("customers.namePlaceholder")}
            />
          </Field>

          <Field
            label={t("customers.phone")}
            required
            error={getErrorMessage(showError("phone"))}
            htmlFor="cust-phone"
          >
            <TextInput
              id="cust-phone"
              dir="ltr"
              inputMode="tel"
              value={values.phone}
              maxLength={MAX_CUSTOMER_PHONE}
              invalid={Boolean(showError("phone"))}
              onBlur={() => setTouched((p) => ({ ...p, phone: true }))}
              onChange={(e) => setValues((p) => ({ ...p, phone: e.target.value }))}
              placeholder="05xxxxxxxx"
            />
          </Field>
        </div>

        <Field
          label={t("customers.address")}
          optional={t("common.optional")}
          error={getErrorMessage(showError("address"))}
          htmlFor="cust-address"
          hint={`${values.address.length}/${MAX_CUSTOMER_ADDRESS}`}
        >
          <TextInput
            id="cust-address"
            value={values.address}
            maxLength={MAX_CUSTOMER_ADDRESS}
            invalid={Boolean(showError("address"))}
            onBlur={() => setTouched((p) => ({ ...p, address: true }))}
            onChange={(e) => setValues((p) => ({ ...p, address: e.target.value }))}
            placeholder={t("customers.addressPlaceholder")}
          />
        </Field>

        <Field
          label={t("customers.notes")}
          optional={t("common.optional")}
          error={getErrorMessage(showError("notes"))}
          htmlFor="cust-notes"
          hint={`${values.notes.length}/${MAX_CUSTOMER_NOTES}`}
        >
          <TextArea
            id="cust-notes"
            rows={3}
            value={values.notes}
            maxLength={MAX_CUSTOMER_NOTES}
            invalid={Boolean(showError("notes"))}
            onBlur={() => setTouched((p) => ({ ...p, notes: true }))}
            onChange={(e) => setValues((p) => ({ ...p, notes: e.target.value }))}
            placeholder={t("customers.notesPlaceholder")}
          />
        </Field>
      </form>
    </Modal>
  );
}
