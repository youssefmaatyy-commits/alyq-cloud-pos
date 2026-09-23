import { useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { Button, TextInput, UsersIcon } from "@/components/ui";
import type { Customer } from "../types";
import { useCustomers } from "../hooks/CustomerProvider";
import { CustomerFormModal } from "./CustomerFormModal";
import { canAct } from "@/lib/permissions/enforce";
import { filterCustomers } from "../services/customerQuery";

interface Props {
  selectedCustomerId?: string | null;
  onSelect: (customer: Customer | null) => void;
  className?: string;
  allowQuickAdd?: boolean;
}

const MAX_SUGGESTIONS = 8;

/**
 * The till's customer picker.
 *
 * It is a search box, not a list: the register's customer book can be long,
 * and a cashier knows the name or the phone — so typing either narrows the
 * suggestions (name OR phone, case-insensitive, see customerQuery). Selecting
 * nothing is a walk-in, exactly as before: the button clears to walk-in and
 * every sale is valid without a customer. Quick-add opens the same form the
 * customers screen uses, gated by `add_customer` independently of the read
 * gate (`view_customers`) — a seat that may not read the book gets no picker
 * at all, and the sale proceeds without one.
 */
export function CustomerSearchSelect({
  selectedCustomerId,
  onSelect,
  className,
  allowQuickAdd = true,
}: Props) {
  const { t } = useI18n();
  const { customers, canView } = useCustomers();
  const [modalOpen, setModalOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);

  const selected = customers.find((c) => c.id === selectedCustomerId);
  const mayQuickAdd = allowQuickAdd && canAct("add_customer");
  const matches = open ? filterCustomers(customers, query, MAX_SUGGESTIONS) : [];

  // The input shows the chosen customer's name at rest; typing edits it into
  // a live search. Selecting a suggestion closes back to the name.
  const displayValue = open ? query : selected?.name ?? "";

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  if (!canView) return null;

  const pick = (customer: Customer | null) => {
    onSelect(customer);
    setQuery("");
    setOpen(false);
  };

  return (
    <div className={`relative space-y-1.5 ${className ?? ""}`}>
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
        <TextInput
          id="customer-select"
          value={displayValue}
          placeholder={t("customers.searchCustomer")}
          onFocus={() => setOpen(true)}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onBlur={() => setTimeout(() => setOpen(false), 120)}
          className="flex-1 py-1.5 text-xs font-semibold"
          aria-label={t("customers.selectCustomer")}
        />

        {selected && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => pick(null)}
            className="h-8 px-2 text-xs text-slate-500 hover:text-slate-800"
            title={t("customers.guestCustomer")}
          >
            ✕
          </Button>
        )}
      </div>

      {open && (
        <ul
          className="absolute inset-x-0 top-full z-30 max-h-64 overflow-y-auto rounded-xl border border-slate-200 bg-white py-1 shadow-lg"
          role="listbox"
        >
          <li>
            <button
              type="button"
              onMouseDown={(e) => {
                e.preventDefault();
                pick(null);
              }}
              className={`block w-full px-3 py-2 text-start text-xs font-semibold transition hover:bg-indigo-50 ${
                !selected ? "text-indigo-700" : "text-slate-700"
              }`}
            >
              {t("customers.guestCustomer")}
            </button>
          </li>
          {matches.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(c);
                }}
                className={`block w-full px-3 py-2 text-start text-xs transition hover:bg-indigo-50 ${
                  c.id === selected?.id ? "bg-indigo-50 font-bold text-indigo-800" : "text-slate-800"
                }`}
              >
                <span className="font-semibold">{c.name}</span>
                <span className="ms-2 font-mono text-[10px] text-slate-500" dir="ltr">
                  {c.phone}
                </span>
              </button>
            </li>
          ))}
          {matches.length === 0 && query.trim() !== "" && (
            <li className="px-3 py-2 text-xs font-medium text-slate-400">
              {t("customers.noMatches")}
            </li>
          )}
        </ul>
      )}

      {modalOpen && (
        <CustomerFormModal
          open={modalOpen}
          onClose={() => setModalOpen(false)}
          onSaved={(newCust) => {
            pick(newCust);
          }}
        />
      )}
    </div>
  );
}
