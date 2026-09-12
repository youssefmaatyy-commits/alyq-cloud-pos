import { useEffect, useMemo, useState } from "react";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { useToast } from "@/components/ui";
import {
  Badge,
  Button,
  Card,
  Field,
  Modal,
  SearchIcon,
  SelectInput,
  TextInput,
} from "@/components/ui";
import { usePos } from "@/modules/pos";
import { useReturns } from "../hooks/ReturnProvider";
import { useCatalog } from "@/modules/products";
import { getCurrentUser } from "@/modules/inventory/permissions";
import {
  getRemainingReturnableQuantities,
  validateReturnDraft,
  MAX_RETURN_REASON_LENGTH,
} from "../validation";
import type { Sale } from "@/modules/pos/types";
import type { ReturnItemInput } from "../types";
import { normalizeText } from "@/modules/products/services/productQuery";

export interface ReturnFormModalProps {
  open: boolean;
  onClose: () => void;
  preselectedSaleId?: string | null;
  onSuccess?: (returnId: string) => void;
}

export function ReturnFormModal({
  open,
  onClose,
  preselectedSaleId,
  onSuccess,
}: ReturnFormModalProps) {
  const { t, pick, num, date } = useI18n();
  const toast = useToast();
  const { sales } = usePos();
  const { returnsList, refundsList, createReturn } = useReturns();
  const { refresh: refreshCatalog } = useCatalog();

  const [selectedSaleId, setSelectedSaleId] = useState<string>(preselectedSaleId ?? "");
  const [reason, setReason] = useState("");
  const [refundMethod, setRefundMethod] = useState<"cash" | "visa" | "instapay">("cash");
  const [itemQuantities, setItemQuantities] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [submitAttempted, setSubmitAttempted] = useState(false);

  // Search & filter state for sales invoices
  const [searchQuery, setSearchQuery] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  useEffect(() => {
    if (preselectedSaleId) {
      setSelectedSaleId(preselectedSaleId);
    }
  }, [preselectedSaleId]);

  const selectedSale: Sale | undefined = useMemo(() => {
    return sales.find((s) => s.id === selectedSaleId);
  }, [sales, selectedSaleId]);

  // Reset form when sale changes or modal opens
  useEffect(() => {
    if (!open) return;
    setReason("");
    setRefundMethod(selectedSale?.payment_method === "instapay" ? "instapay" : "cash");
    setItemQuantities({});
    setSubmitAttempted(false);
  }, [open, selectedSaleId, selectedSale]);

  // Reset search when modal opens
  useEffect(() => {
    if (open && !preselectedSaleId) {
      setSearchQuery("");
      setDateFrom("");
      setDateTo("");
    }
  }, [open, preselectedSaleId]);

  // Filter eligible non-voided sales invoices by invoice number, customer name, customer phone, date range
  const filteredSales: Sale[] = useMemo(() => {
    const term = normalizeText(searchQuery);
    const fromTime = dateFrom ? new Date(dateFrom).setHours(0, 0, 0, 0) : null;
    const toTime = dateTo ? new Date(dateTo).setHours(23, 59, 59, 999) : null;

    return sales
      .filter((s) => s.status !== "voided")
      .filter((s) => {
        // Date range filter
        if (fromTime || toTime) {
          const saleTime = new Date(s.created_at).getTime();
          if (fromTime && saleTime < fromTime) return false;
          if (toTime && saleTime > toTime) return false;
        }

        // Text search across invoice #, customer name, customer phone
        if (term) {
          const hay = normalizeText(
            `${s.sale_number} ${s.customer_name ?? ""} ${s.customer_phone ?? ""}`
          );
          if (!hay.includes(term)) return false;
        }

        return true;
      })
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
  }, [sales, searchQuery, dateFrom, dateTo]);

  const returnableMap = useMemo(() => {
    if (!selectedSale) return new Map<string, number>();
    return getRemainingReturnableQuantities(selectedSale, returnsList);
  }, [selectedSale, returnsList]);

  const itemsInput: ReturnItemInput[] = useMemo(() => {
    if (!selectedSale) return [];
    return selectedSale.items.map((item) => ({
      sale_item_id: item.id,
      product_id: item.product_id,
      quantity: Number(itemQuantities[item.id] ?? 0),
    }));
  }, [selectedSale, itemQuantities]);

  const validation = useMemo(() => {
    if (!selectedSale) {
      return {
        valid: false,
        errors: { sale: "Sale required" },
        items: [],
        calculatedRefundAmount: 0,
        remainingRefundable: 0,
      };
    }
    return validateReturnDraft(
      selectedSale,
      itemsInput,
      reason,
      refundMethod,
      returnsList,
      refundsList,
    );
  }, [selectedSale, itemsInput, reason, refundMethod, returnsList, refundsList]);

  const hasAnyReturnable = useMemo(() => {
    if (!selectedSale) return false;
    for (const val of returnableMap.values()) {
      if (val > 0) return true;
    }
    return false;
  }, [selectedSale, returnableMap]);

  const handleSubmit = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    setSubmitAttempted(true);

    if (!selectedSale) {
      toast.error(t("returns.selectSalePlaceholder"));
      return;
    }

    if (!validation.valid) {
      if (validation.errors.reason === "reasonRequired") {
        toast.error(t("returns.reasonRequired"));
      } else if (validation.errors.items === "noItemsSelected") {
        toast.error(t("returns.noItemsSelected"));
      } else if (validation.errors.refund === "exceedsSaleError") {
        toast.error(t("refunds.exceedsSaleError"));
      } else {
        toast.error(t("validation.fixErrors"));
      }
      return;
    }

    setSubmitting(true);
    try {
      const user = getCurrentUser();
      const activeItems = itemsInput.filter((i) => i.quantity > 0);

      const res = await createReturn({
        sale_id: selectedSale.id,
        reason: reason.trim(),
        refund_method: refundMethod,
        refund_status: "completed",
        items: activeItems,
        user_id: user.id,
        user_name: user.name,
      });

      // Phase 12: a refund above the cap is still recorded — the goods are back
      // and the stock is right — but it opens `pending` and the request goes to
      // an approver, who releases the money from the inbox.
      if (res.approvalRequest) {
        toast.success(
          t("returns.createdPendingApprovalToast", { number: res.approvalRequest.request_number }),
        );
      } else {
        toast.success(t("returns.createdToast"));
      }
      await refreshCatalog();
      onClose();
      if (onSuccess) onSuccess(res.returnRecord.id);
    } catch (err) {
      toast.error(err instanceof Error && err.message ? err.message : t("common.error"));
    } finally {
      setSubmitting(false);
    }
  };

  const handleSetFullReturn = () => {
    if (!selectedSale) return;
    const full: Record<string, string> = {};
    for (const item of selectedSale.items) {
      const returnable = returnableMap.get(item.id) ?? 0;
      if (returnable > 0) {
        full[item.id] = String(returnable);
      }
    }
    setItemQuantities(full);
  };

  const clearSearchFilters = () => {
    setSearchQuery("");
    setDateFrom("");
    setDateTo("");
  };

  const hasSearchFilters = Boolean(searchQuery || dateFrom || dateTo);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t("returns.newReturn")}
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={submitting}>
            {t("common.cancel")}
          </Button>
          <Button
            onClick={() => void handleSubmit()}
            loading={submitting}
            disabled={!selectedSale || !hasAnyReturnable || selectedSale.status === "voided"}
          >
            {submitting ? t("common.saving") : t("returns.createReturnAction")}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {/* ======================================================== */}
        {/* 1. SEARCH ORIGINAL SALE INVOICE (when not preselected)   */}
        {/* ======================================================== */}
        {!preselectedSaleId && (
          <div className="space-y-3 rounded-2xl border border-slate-200 bg-slate-50/70 p-3 sm:p-4">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-bold uppercase tracking-wider text-slate-700">
                {t("returns.searchInvoices")}
              </span>
              {hasSearchFilters && (
                <button
                  type="button"
                  onClick={clearSearchFilters}
                  className="text-xs font-semibold text-indigo-600 hover:text-indigo-800 hover:underline"
                >
                  {t("returns.clearSearch")}
                </button>
              )}
            </div>

            {/* Keyword Search: Invoice #, Customer name, Phone */}
            <TextInput
              id="invoice-search-input"
              data-testid="invoice-search-input"
              value={searchQuery}
              leading={<SearchIcon />}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={t("returns.searchInvoicesPlaceholder")}
              aria-label={t("returns.searchInvoices")}
              type="search"
              className="bg-white"
            />

            {/* Date Range Filters */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
              <div>
                <label
                  htmlFor="invoice-date-from"
                  className="mb-1 block text-[11px] font-semibold text-slate-600"
                >
                  {t("returns.filterDateFrom")}
                </label>
                <input
                  id="invoice-date-from"
                  data-testid="invoice-date-from"
                  type="date"
                  value={dateFrom}
                  onChange={(e) => setDateFrom(e.target.value)}
                  className="w-full rounded-xl border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-800 shadow-sm outline-none focus:border-indigo-500"
                />
              </div>
              <div>
                <label
                  htmlFor="invoice-date-to"
                  className="mb-1 block text-[11px] font-semibold text-slate-600"
                >
                  {t("returns.filterDateTo")}
                </label>
                <input
                  id="invoice-date-to"
                  data-testid="invoice-date-to"
                  type="date"
                  value={dateTo}
                  onChange={(e) => setDateTo(e.target.value)}
                  className="w-full rounded-xl border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-800 shadow-sm outline-none focus:border-indigo-500"
                />
              </div>
            </div>

            {/* Invoice Select Dropdown */}
            <Field label={t("returns.selectSale")} required htmlFor="select-sale-inv">
              <SelectInput
                id="select-sale-inv"
                data-testid="select-sale-inv"
                value={selectedSaleId}
                onChange={(e) => setSelectedSaleId(e.target.value)}
                className="bg-white"
              >
                <option value="">{t("returns.selectSalePlaceholder")}</option>
                {filteredSales.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.sale_number} — {num(s.total, 2)} ({s.customer_name || t("customers.guestCustomer")}) [
                    {new Date(s.created_at).toLocaleDateString()}]
                  </option>
                ))}
              </SelectInput>
            </Field>

            {/* Quick Invoices Grid: click to select directly */}
            {filteredSales.length > 0 && !selectedSaleId && (
              <div className="space-y-1.5 pt-1">
                <span className="block text-[10px] font-bold uppercase tracking-wider text-slate-500">
                  {t("returns.selectSale")} ({filteredSales.length})
                </span>
                <div className="max-h-48 overflow-y-auto space-y-1 rounded-xl border border-slate-200 bg-white p-1.5">
                  {filteredSales.map((s) => (
                    <button
                      key={s.id}
                      type="button"
                      onClick={() => setSelectedSaleId(s.id)}
                      className="w-full flex items-center justify-between gap-2 rounded-lg p-2 text-start text-xs transition-colors hover:bg-indigo-50/70 hover:text-indigo-900"
                    >
                      <div>
                        <span className="font-mono font-bold text-indigo-700">{s.sale_number}</span>
                        <span className="ms-2 text-slate-600">
                          {s.customer_name || t("customers.guestCustomer")}
                        </span>
                        {s.customer_phone && (
                          <span className="ms-1 font-mono text-[11px] text-slate-400" dir="ltr">
                            ({s.customer_phone})
                          </span>
                        )}
                      </div>
                      <div className="text-end shrink-0">
                        <span className="font-bold tabular-nums text-slate-900">{num(s.total, 2)}</span>
                        <span className="block text-[10px] text-slate-400" dir="ltr">
                          {date(s.created_at)}
                        </span>
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div className="flex items-center justify-between text-[11px] text-slate-500">
              <span>{t("returns.invoicesFound", { count: filteredSales.length })}</span>
              {filteredSales.length === 0 && (
                <span className="font-semibold text-amber-700">
                  {t("returns.noMatchingSales")}
                </span>
              )}
            </div>
          </div>
        )}

        {/* ======================================================== */}
        {/* 2. SELECTED INVOICE DETAILS                              */}
        {/* Shows: Invoice number, Date, Customer, Sold products,    */}
        {/* Quantity sold, Unit price, Discount, Total               */}
        {/* ======================================================== */}
        {selectedSale && (
          <Card className="border-indigo-100 bg-indigo-50/40 p-4 space-y-3">
            <div className="flex items-center justify-between border-b border-indigo-100 pb-2">
              <span className="text-xs font-bold uppercase tracking-wider text-indigo-900">
                {t("returns.selectedSaleSummary")}
              </span>
              {!preselectedSaleId && (
                <button
                  type="button"
                  onClick={() => setSelectedSaleId("")}
                  className="text-xs font-semibold text-indigo-600 hover:text-indigo-800 hover:underline"
                >
                  {t("returns.changeInvoice")}
                </button>
              )}
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
              <div>
                <p className="text-[10px] font-bold uppercase text-slate-500">
                  {t("returns.saleNumber")}
                </p>
                <p className="font-mono text-sm font-bold text-indigo-700">
                  {selectedSale.sale_number}
                </p>
              </div>

              <div>
                <p className="text-[10px] font-bold uppercase text-slate-500">
                  {t("pos.cols.date")}
                </p>
                <p className="font-semibold text-slate-800" dir="ltr">
                  {date(selectedSale.created_at)}
                </p>
              </div>

              <div>
                <p className="text-[10px] font-bold uppercase text-slate-500">
                  {t("returns.customer")}
                </p>
                <p className="font-semibold text-slate-900">
                  {selectedSale.customer_name || t("customers.guestCustomer")}
                </p>
                {selectedSale.customer_phone && (
                  <p className="font-mono text-[10px] text-slate-600" dir="ltr">
                    {selectedSale.customer_phone}
                  </p>
                )}
              </div>

              <div>
                <p className="text-[10px] font-bold uppercase text-slate-500">
                  {t("pos.payment")}
                </p>
                <Badge tone={selectedSale.payment_method === "cash" ? "success" : "info"}>
                  {t(`pos.payment.${selectedSale.payment_method}`)}
                </Badge>
              </div>
            </div>

            {/* Financial summary: Subtotal, Discount, Total, Returnable balance */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 border-t border-indigo-100/70 pt-2 text-xs">
              <div>
                <span className="text-slate-600">{t("pos.subtotal")}: </span>
                <span className="font-bold tabular-nums text-slate-900">
                  {num(selectedSale.subtotal, 2)}
                </span>
              </div>
              <div>
                <span className="text-slate-600">{t("pos.discount")}: </span>
                <span className="font-bold tabular-nums text-rose-600">
                  −{num(selectedSale.discount_amount, 2)}
                </span>
              </div>
              <div>
                <span className="text-slate-600">{t("pos.total")}: </span>
                <span className="font-extrabold tabular-nums text-slate-900 text-sm">
                  {num(selectedSale.total, 2)}
                </span>
              </div>
              <div>
                <span className="text-slate-600">{t("returns.returnableQty")}: </span>
                <span className="font-bold tabular-nums text-indigo-700 text-sm">
                  {num(validation.remainingRefundable, 2)}
                </span>
              </div>
            </div>
          </Card>
        )}

        {/* ======================================================== */}
        {/* 3. RETURN ITEMS SELECTION                                */}
        {/* Sold products, Quantity sold, Unit price, Return qty     */}
        {/* Supports Full return / Partial return                    */}
        {/* ======================================================== */}
        {selectedSale && (
          <>
            {!hasAnyReturnable ? (
              <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-center text-xs font-bold text-amber-800">
                ⚠ {t("returns.allReturned")}
              </div>
            ) : (
              <>
                <div>
                  <div className="mb-2 flex items-center justify-between">
                    <span className="text-xs font-bold text-slate-800">{t("returns.soldItems")}</span>
                    <button
                      type="button"
                      onClick={handleSetFullReturn}
                      className="text-xs font-bold text-indigo-600 hover:text-indigo-700 hover:underline"
                    >
                      {t("returns.fullReturn")}
                    </button>
                  </div>

                  <div className="overflow-x-auto rounded-xl border border-slate-200">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="border-b border-slate-200 bg-slate-50 text-[10px] font-bold uppercase tracking-wider text-slate-600">
                          <th className="py-2 px-3 text-start">{t("pos.cols.items")}</th>
                          <th className="py-2 px-2 text-end">{t("pos.unit")}</th>
                          <th className="py-2 px-2 text-center">{t("returns.soldQty")}</th>
                          <th className="py-2 px-2 text-center">{t("returns.returnableQty")}</th>
                          <th className="py-2 px-3 text-center">{t("returns.returnQty")}</th>
                          <th className="py-2 px-3 text-end">{t("returns.refundAmount")}</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {selectedSale.items.map((item) => {
                          const returnable = returnableMap.get(item.id) ?? 0;
                          const currentQtyStr = itemQuantities[item.id] ?? "";
                          const currentQtyNum = Number(currentQtyStr) || 0;
                          const lineTotal = item.unit_price * currentQtyNum;
                          const hasItemError = currentQtyNum > returnable || currentQtyNum < 0;

                          return (
                            <tr key={item.id} className={returnable === 0 ? "opacity-40 bg-slate-50/50" : ""}>
                              <td className="py-2 px-3">
                                <p className="font-semibold text-slate-900">
                                  {pick(item.name_ar, item.name_en)}
                                </p>
                                <p className="font-mono text-[10px] text-slate-500">
                                  {item.sku}
                                  {item.barcode ? ` · ${item.barcode}` : ""}
                                </p>
                              </td>
                              <td className="py-2 px-2 text-end tabular-nums font-mono">
                                {num(item.unit_price, 2)}
                              </td>
                              <td className="py-2 px-2 text-center tabular-nums font-semibold">
                                {item.quantity}
                              </td>
                              <td className="py-2 px-2 text-center tabular-nums font-bold text-indigo-600">
                                {returnable}
                              </td>
                              <td className="py-2 px-3 text-center w-24">
                                <TextInput
                                  dir="ltr"
                                  inputMode="numeric"
                                  disabled={returnable === 0}
                                  value={currentQtyStr}
                                  invalid={hasItemError}
                                  onChange={(e) => {
                                    const val = e.target.value;
                                    setItemQuantities((p) => ({ ...p, [item.id]: val }));
                                  }}
                                  placeholder="0"
                                  className="h-8 py-1 text-center font-mono text-xs font-bold"
                                />
                              </td>
                              <td className="py-2 px-3 text-end tabular-nums font-bold text-slate-900">
                                {num(lineTotal, 2)}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                  {submitAttempted && validation.errors.items && (
                    <p className="mt-1 text-xs font-semibold text-rose-700">
                      ⚠ {t("returns.noItemsSelected")}
                    </p>
                  )}
                </div>

                {/* Return Reason & Refund Method */}
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field
                    label={t("returns.reason")}
                    required
                    error={
                      submitAttempted && validation.errors.reason === "reasonRequired"
                        ? t("returns.reasonRequired")
                        : undefined
                    }
                    htmlFor="return-reason"
                    hint={`${reason.length}/${MAX_RETURN_REASON_LENGTH}`}
                  >
                    <TextInput
                      id="return-reason"
                      value={reason}
                      maxLength={MAX_RETURN_REASON_LENGTH}
                      onChange={(e) => setReason(e.target.value)}
                      placeholder={t("returns.reasonPlaceholder")}
                    />
                  </Field>

                  <Field label={t("returns.refundMethod")} required htmlFor="refund-method">
                    <SelectInput
                      id="refund-method"
                      value={refundMethod}
                      onChange={(e) => setRefundMethod(e.target.value as "cash" | "visa" | "instapay")}
                    >
                      <option value="cash">{t("pos.payment.cash")}</option>
                      <option value="visa">{t("pos.payment.visa")}</option>
                      <option value="instapay">{t("pos.payment.instapay")}</option>
                    </SelectInput>
                  </Field>
                </div>

                {/* Refund Total Summary */}
                <div className="flex items-center justify-between rounded-xl bg-indigo-50 border border-indigo-100 p-3 text-sm">
                  <div className="space-y-0.5">
                    <p className="font-bold text-indigo-950">{t("returns.refundAmount")}</p>
                    <p className="text-xs text-indigo-700">{t("returns.movementNotice")}</p>
                  </div>
                  <span className="text-xl font-extrabold tabular-nums text-indigo-700">
                    {num(validation.calculatedRefundAmount, 2)}
                  </span>
                </div>
              </>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}
