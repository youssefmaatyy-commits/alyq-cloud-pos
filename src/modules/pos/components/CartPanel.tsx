import { useI18n } from "@/lib/i18n/I18nProvider";
import { Button, SelectInput, TextInput } from "@/components/ui";
import { variantLabel } from "@/modules/products/variants";
import { CustomerSearchSelect } from "@/modules/customers/components/CustomerSearchSelect";
import { lineKey } from "../types";
import { usePos } from "../hooks/PosProvider";
import { lineTotals, validateDiscount } from "../services/posMath";

/** The customer is sale state, not a child of a line or of the empty-cart UI. */
export function CartPanel() {
  const { t, num, pick, lang } = useI18n();
  const {
    lines, totals, discount, setDiscount, increase, decrease, removeLine,
    setLineDiscount, clearCart, canDiscount, selectedCustomer, setSelectedCustomer,
  } = usePos();
  const discountError = validateDiscount(discount.type, discount.value);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-2xl border border-stone-200 bg-white" data-testid="pos-cart">
      <div className="flex items-center justify-between gap-2 border-b border-stone-100 px-4 py-3">
        <p className="text-sm font-bold text-stone-900">{t("pos.cart")}</p>
        <div className="flex items-center gap-2">
          {lines.length > 0 && (
            <button type="button" onClick={clearCart} className="text-xs font-semibold text-stone-600 underline-offset-2 hover:text-rose-700 hover:underline" data-testid="pos-clear-cart">
              {t("pos.clearCart")}
            </button>
          )}
          <span className="rounded-full bg-stone-100 px-2 py-0.5 text-xs font-bold text-stone-800 ring-1 ring-inset ring-stone-200">
            {lines.reduce((sum, line) => sum + line.qty, 0)}
          </span>
        </div>
      </div>

      <div className="border-b border-stone-100 px-4 py-2.5">
        <CustomerSearchSelect
          selectedCustomerId={selectedCustomer?.id ?? null}
          onSelect={setSelectedCustomer}
        />
      </div>

      {lines.length === 0 ? (
        <div className="flex min-h-48 flex-1 flex-col items-center justify-center gap-2 p-5 text-center">
          <span aria-hidden className="text-3xl">🧾</span>
          <p className="text-sm font-bold text-stone-900">{t("pos.emptyCart")}</p>
          <p className="text-xs font-medium text-stone-500">{t("pos.emptyCartHint")}</p>
        </div>
      ) : (
        <>
          <ul className="pos-grip-scrollbar min-h-0 flex-1 divide-y divide-stone-100 overflow-y-auto px-3">
            {lines.map((line) => {
              const key = lineKey(line);
              const amounts = lineTotals(line);
              const name = pick(line.name_ar, line.name_en);
              return (
                <li key={key} data-testid={`cart-line-${key}`} className="space-y-2 py-3">
                  <div className="flex min-w-0 items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="break-words text-sm font-bold leading-tight text-stone-900">{name}</p>
                      {line.variant_id && (
                        <p className="mt-1 font-semibold text-stone-700" data-testid="pos-line-variant">
                          {variantLabel({ color_ar: line.color_ar, color_en: line.color_en, size: line.size, size_label: line.size_label }, lang)}
                        </p>
                      )}
                      <span className="mt-1 block truncate font-mono text-[11px] text-stone-500">{line.sku}</span>
                    </div>
                    <button
                      type="button"
                      onClick={() => removeLine(key)}
                      aria-label={`${t("pos.removeItem")}: ${name}`}
                      data-testid={`cart-remove-${key}`}
                      className="shrink-0 rounded-lg border border-stone-200 px-2 py-1.5 text-xs font-bold text-rose-700 hover:border-rose-300 hover:bg-rose-50"
                    >
                      {t("pos.removeItem")}
                    </button>
                  </div>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-1" role="group" aria-label={`${name} · ${t("pos.quantity")}`}>
                      <Button type="button" variant="secondary" size="sm" className="h-9 w-9 !px-0" onClick={() => decrease(key)} aria-label={t("pos.decrease")}>
                        −
                      </Button>
                      <span className="w-8 text-center text-sm font-bold tabular-nums text-stone-900" data-testid={`cart-quantity-${key}`}>{line.qty}</span>
                      <Button type="button" variant="secondary" size="sm" className="h-9 w-9 !px-0" disabled={line.qty >= line.max_qty} onClick={() => increase(key)} aria-label={t("pos.increase")}>
                        +
                      </Button>
                    </div>
                    <div className="text-end text-xs tabular-nums text-stone-700">
                      <p>{t("pos.unitPrice")}: {num(line.unit_price, 2)}</p>
                      <p className="font-bold text-stone-900">{num(amounts.net, 2)}</p>
                      {line.qty >= line.max_qty && <p className="text-[11px] font-semibold text-amber-700">{t("pos.stockLimit", { count: line.max_qty })}</p>}
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5 rounded-lg bg-stone-50 p-2 text-[11px]">
                    <label htmlFor={`discount-${key}`} className="font-bold text-stone-600">{t("pos.lineDiscount")}</label>
                    <select
                      id={`discount-${key}`}
                      aria-label={t("pos.lineDiscount")}
                      disabled={!canDiscount}
                      value={line.item_discount?.type ?? "none"}
                      onChange={(event) => setLineDiscount(key, { type: event.target.value as "none" | "percent" | "fixed", value: line.item_discount?.value ?? 0 })}
                      className="h-8 rounded-md border border-stone-200 bg-white px-1.5 text-stone-900"
                    >
                      <option value="none">{t("pos.discountType.none")}</option>
                      <option value="percent">%</option>
                      <option value="fixed">{t("pos.discountType.fixed")}</option>
                    </select>
                    {line.item_discount?.type !== "none" && (
                      <input
                        aria-label={t("pos.discountValue")}
                        className="h-8 w-16 rounded-md border border-stone-200 bg-white px-1 text-end tabular-nums"
                        type="number" min="0" max={line.item_discount?.type === "percent" ? 100 : undefined}
                        disabled={!canDiscount}
                        value={line.item_discount?.value ?? 0}
                        onChange={(event) => setLineDiscount(key, { type: line.item_discount?.type ?? "fixed", value: Number(event.target.value) })}
                      />
                    )}
                    {amounts.discount > 0 && <span className="font-semibold text-rose-700">−{num(amounts.discount, 2)}</span>}
                  </div>
                </li>
              );
            })}
          </ul>

          <div className="shrink-0 border-t border-stone-100 px-4 py-3">
            <p className="mb-2 text-xs font-bold text-stone-700">{t("pos.invoiceDiscount")}</p>
            {!canDiscount && <p className="mb-2 text-xs text-stone-600">{t("pos.discountLocked")}</p>}
            <div className="flex flex-wrap gap-2">
              <SelectInput
                value={discount.type}
                disabled={!canDiscount}
                onChange={(event) => setDiscount({ ...discount, type: event.target.value as typeof discount.type })}
                aria-label={t("pos.invoiceDiscount")}
                className="h-9 min-w-32 flex-1 py-1 text-xs"
              >
                <option value="none">{t("pos.discountType.none")}</option>
                <option value="percent">{t("pos.discountType.percent")}</option>
                <option value="fixed">{t("pos.discountType.fixed")}</option>
              </SelectInput>
              {discount.type !== "none" && (
                <TextInput
                  dir="ltr" inputMode="decimal" disabled={!canDiscount}
                  value={String(discount.value)} invalid={Boolean(discountError)}
                  onChange={(event) => setDiscount({ ...discount, value: Number(event.target.value) })}
                  placeholder={t("pos.discountValue")}
                  aria-label={t("pos.discountValue")}
                  className="h-9 min-w-20 flex-1 py-1 text-xs"
                />
              )}
            </div>
            {discountError && <p className="mt-1 text-xs font-semibold text-rose-700">{t(discountError === "tooHigh" ? "pos.discountTooHigh" : "pos.discountInvalid")}</p>}
          </div>

          <div className="shrink-0 border-t border-stone-100 px-4 py-3 text-sm">
            <div className="flex items-center justify-between text-stone-600"><span>{t("pos.subtotal")}</span><span className="tabular-nums">{num(totals.subtotal, 2)}</span></div>
            <div className="mt-1 flex items-center justify-between text-stone-600"><span>{t("pos.discount")}</span><span className="tabular-nums text-rose-700">−{num(totals.discountAmount, 2)}</span></div>
            <div className="mt-2 flex items-center justify-between border-t border-stone-200 pt-2 text-base font-extrabold text-stone-900"><span>{t("pos.total")}</span><span className="tabular-nums">{num(totals.total, 2)}</span></div>
          </div>
        </>
      )}
    </div>
  );
}
