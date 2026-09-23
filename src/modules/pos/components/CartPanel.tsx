import { useI18n } from "@/lib/i18n/I18nProvider";
import { Button, SelectInput, TextInput } from "@/components/ui";
import { lineKey } from "../types";
import { usePos } from "../hooks/PosProvider";
import { lineTotals, validateDiscount } from "../services/posMath";
import { CustomerSearchSelect } from "@/modules/customers/components/CustomerSearchSelect";

/** "17" or "One Size" — the numeric size without trailing zeros. */
function sizeText(size: number | null, label: string | null): string {
  if (size === null || !Number.isFinite(size)) return (label ?? "").trim();
  return String(Math.round(size * 100) / 100);
}

/**
 * Cart panel — the right side of the register.
 * Shows lines, qty steppers (capped at available stock), discount controls
 * and authoritative totals. Discounts are locked unless the current user is
 * authorized (manager / admin).
 */
export function CartPanel() {
  const { t, num } = useI18n();
  const {
    lines,
    totals,
    discount,
    setDiscount,
    increase,
    decrease,
    removeLine,
    setLineDiscount,
    isEmpty,
    canDiscount,
    selectedCustomer,
    setSelectedCustomer,
  } = usePos();

  const discountError = validateDiscount(discount.type, discount.value);

  if (isEmpty) {
    // The customer picker stays available on an empty cart: a known customer
    // often decides what gets rung up, so the selection is made before the
    // first line — and it carries into the first sale when lines appear.
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-stone-300 bg-white p-6 text-center">
        <span aria-hidden className="text-3xl">🧾</span>
        <p className="text-sm font-bold text-stone-900">{t("pos.emptyCart")}</p>
        <p className="text-xs font-medium text-stone-500">{t("pos.emptyCartHint")}</p>
        <div className="w-full max-w-xs">
          <CustomerSearchSelect
            selectedCustomerId={selectedCustomer?.id ?? null}
            onSelect={(c) => setSelectedCustomer(c)}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col gap-3 overflow-hidden rounded-2xl border border-stone-200 bg-white">
      <div className="flex items-center justify-between border-b border-stone-100 px-4 py-3">
        <p className="text-sm font-bold text-stone-900">{t("pos.cart")}</p>
        <span className="rounded-full bg-[#faf5ec] px-2 py-0.5 text-xs font-bold text-[#8a6a3d] ring-1 ring-inset ring-[#e5d5b8]">
          {lines.reduce((s, l) => s + l.qty, 0)}
        </span>
      </div>

      <div className="border-b border-stone-100 px-4 py-2.5">
        <CustomerSearchSelect
          selectedCustomerId={selectedCustomer?.id ?? null}
          onSelect={(c) => setSelectedCustomer(c)}
        />
      </div>

      {/* lines */}
      <ul className="flex-1 divide-y divide-stone-100 overflow-y-auto px-2">
        {lines.map((line) => (
          <li key={lineKey(line)} data-testid={`cart-line-${lineKey(line)}`} className="relative flex items-center gap-2 px-2 pb-10 pt-2.5">
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs font-semibold text-stone-900">
                {line.name_en || line.name_ar}
              </p>
              {/* The exact combination, frozen onto the line: colour then size.
                  Two sizes of one product are two lines and read as such. */}
              {line.variant_id ? (
                <p className="mt-0.5 truncate text-[10px] font-semibold text-[#b08d57]">
                  {line.color_en || line.color_ar}
                  {line.size !== null || line.size_label
                    ? ` / ${sizeText(line.size, line.size_label)}`
                    : ""}
                </p>
              ) : null}
              <p className="mt-0.5 flex items-center gap-2 font-mono text-[10px] text-stone-500">
                <span>{line.sku}</span>
                <span className="tabular-nums">{num(line.unit_price, 2)}</span>
              </p>
            </div>

            {/* qty stepper */}
            <div className="flex items-center gap-1">
              <Button
                variant="secondary"
                size="sm"
                className="h-7 w-7 !px-0"
                onClick={() => decrease(lineKey(line))}
                aria-label="−"
              >
                −
              </Button>
              <span className="w-8 text-center text-sm font-bold tabular-nums text-stone-900">
                {line.qty}
              </span>
              <Button
                variant="secondary"
                size="sm"
                className="h-7 w-7 !px-0"
                disabled={line.qty >= line.max_qty}
                onClick={() => increase(lineKey(line))}
                aria-label="+"
              >
                +
              </Button>
            </div>

            <div className="w-20 text-end">
              <p className="text-xs font-bold tabular-nums text-stone-900">
                {num(line.unit_price * line.qty, 2)}
              </p>
              {line.qty >= line.max_qty ? (
                <p className="text-[10px] font-semibold text-amber-600">
                  {t("inventory.status.low")}: {line.max_qty}
                </p>
              ) : null}
            </div>

            <button
              type="button"
              onClick={() => removeLine(lineKey(line))}
              aria-label="×"
              title="Remove item / حذف الصنف"
              className="flex h-6 w-6 items-center justify-center rounded-md text-stone-400 transition hover:bg-rose-50 hover:text-rose-600"
            >
              ×
            </button>
            <div className="absolute ms-2 mt-16 flex max-w-[calc(100%-1rem)] items-center gap-1 text-[10px]">
              <span className="text-stone-500">Item discount / خصم الصنف</span>
              <select
                aria-label="Item discount type"
                disabled={!canDiscount}
                value={line.item_discount?.type ?? "none"}
                onChange={(e) => setLineDiscount(lineKey(line), { type: e.target.value as "none" | "percent" | "fixed", value: line.item_discount?.value ?? 0 })}
                className="h-6 rounded border border-stone-200 bg-white px-1"
              >
                <option value="none">—</option><option value="percent">%</option><option value="fixed">EGP</option>
              </select>
              {(line.item_discount?.type ?? "none") !== "none" ? (
                <input
                  aria-label="Item discount value"
                  className="h-6 w-14 rounded border border-stone-200 px-1 text-end"
                  type="number" min="0" max={line.item_discount?.type === "percent" ? 100 : undefined}
                  disabled={!canDiscount}
                  value={line.item_discount?.value ?? 0}
                  onChange={(e) => setLineDiscount(lineKey(line), { type: line.item_discount?.type ?? "fixed", value: Number(e.target.value) })}
                />
              ) : null}
              {(() => { const lt = lineTotals(line); return <span className="tabular-nums text-stone-600">{num(lt.gross, 2)} − {num(lt.discount, 2)} = {num(lt.net, 2)}</span>; })()}
            </div>
          </li>
        ))}
      </ul>

      {/* discount */}
      <div className="border-t border-stone-100 px-4 py-3">
        <div className="mb-2 flex items-center gap-2">
          <p className="text-[11px] font-bold uppercase tracking-wider text-stone-600">
            Invoice Discount / خصم الفاتورة
          </p>
          {!canDiscount ? (
            <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-semibold text-amber-800 ring-1 ring-inset ring-amber-300">
              🔒 {t("pos.discountLocked")}
            </span>
          ) : null}
        </div>
        <div className="flex gap-2">
          <SelectInput
            value={discount.type}
            disabled={!canDiscount}
            onChange={(e) => setDiscount({ ...discount, type: e.target.value as typeof discount.type })}
            aria-label={t("pos.discount")}
            className="h-9 w-40 py-1 text-xs"
          >
            <option value="none">{t("pos.discountType.none")}</option>
            <option value="percent">{t("pos.discountType.percent")}</option>
            <option value="fixed">{t("pos.discountType.fixed")}</option>
          </SelectInput>
          {discount.type !== "none" ? (
            <>
              <TextInput
                dir="ltr"
                inputMode="decimal"
                disabled={!canDiscount}
                value={String(discount.value)}
                invalid={Boolean(discountError)}
                onChange={(e) => setDiscount({ ...discount, value: Number(e.target.value) })}
                placeholder={t("pos.discountValue")}
                className="h-9 py-1 text-xs"
              />
              {discountError ? (
                <p className="text-[11px] font-semibold text-rose-600">
                  {discountError === "tooHigh" ? t("pos.discountTooHigh") : t("pos.discountInvalid")}
                </p>
              ) : null}
            </>
          ) : null}
        </div>
      </div>

      {/* totals */}
      <div className="border-t border-stone-100 px-4 py-3 text-sm">
        <div className="flex items-center justify-between text-stone-600">
          <span>{t("pos.subtotal")}</span>
          <span className="tabular-nums">{num(totals.subtotal, 2)}</span>
        </div>
        <div className="mt-1 flex items-center justify-between text-stone-600">
          <span>{t("pos.discount")}</span>
          <span className="tabular-nums text-rose-600">−{num(totals.discountAmount, 2)}</span>
        </div>
        <div className="mt-2 flex items-center justify-between border-t border-stone-200 pt-2 text-base font-extrabold text-stone-900">
          <span>{t("pos.total")}</span>
          <span className="tabular-nums">{num(totals.total, 2)}</span>
        </div>
      </div>
    </div>
  );
}
