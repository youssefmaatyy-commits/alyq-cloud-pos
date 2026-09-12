import { useState } from "react";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { Button, SelectInput, UsersIcon } from "@/components/ui";
import type { Customer } from "../types";
import { useCustomers } from "../hooks/CustomerProvider";
import { CustomerFormModal } from "./CustomerFormModal";
import { canAct } from "@/lib/permissions/enforce";

interface Props {
  selectedCustomerId?: string | null;
  onSelect: (customer: Customer | null) => void;
  className?: string;
  allowQuickAdd?: boolean;
}

export function CustomerSearchSelect({
  selectedCustomerId,
  onSelect,
  className,
  allowQuickAdd = true,
}: Props) {
  const { t } = useI18n();
  const { customers, canView } = useCustomers();
  const [modalOpen, setModalOpen] = useState(false);

  const selected = customers.find((c) => c.id === selectedCustomerId);
  // Quick-add is its own act: a seat may be allowed to read the book without
  // being allowed to add to it, and the reverse is possible too.
  const mayQuickAdd = allowQuickAdd && canAct("add_customer");

  // A role that may not read customers gets no picker at all, and the sale
  // proceeds without one. Rendering an empty dropdown would read as "there are
  // no customers" — a claim about the shop this seat is not allowed to make.
  if (!canView) return null;

  return (
    <div className={`space-y-1.5 ${className ?? ""}`}>
      <div className="flex items-center justify-between gap-2">
        <label htmlFor="customer-select" className="flex items-center gap-1.5 text-xs font-bold text-slate-800">
          <UsersIcon className="h-3.5 w-3.5 text-slate-500" />
          <span>{t("customers.customerLabel")}</span>
        </label>
        {mayQuickAdd && (
          <button
            type="button"
            onClick={() => setModalOpen(true)}
            className="text-[11px] font-bold text-indigo-600 hover:text-indigo-700 hover:underline"
          >
            + {t("customers.add")}
          </button>
        )}
      </div>

      <div className="flex items-center gap-2">
        <SelectInput
          id="customer-select"
          value={selectedCustomerId ?? ""}
          onChange={(e) => {
            const val = e.target.value;
            if (!val) {
              onSelect(null);
            } else {
              const found = customers.find((c) => c.id === val);
              onSelect(found ?? null);
            }
          }}
          className="flex-1 py-1.5 text-xs font-semibold"
          aria-label={t("customers.selectCustomer")}
        >
          <option value="">{t("customers.guestCustomer")}</option>
          {customers.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name} ({c.phone})
            </option>
          ))}
        </SelectInput>

        {selected && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onSelect(null)}
            className="h-8 px-2 text-xs text-slate-500 hover:text-slate-800"
            title={t("customers.guestCustomer")}
          >
            ✕
          </Button>
        )}
      </div>

      {modalOpen && (
        <CustomerFormModal
          open={modalOpen}
          onClose={() => setModalOpen(false)}
          onSaved={(newCust) => {
            onSelect(newCust);
          }}
        />
      )}
    </div>
  );
}
