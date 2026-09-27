import { useI18n } from "@/lib/i18n/I18nProvider";
import { Button, TextInput } from "@/components/ui";
import { variantLabel } from "@/modules/products/variants";
import { CustomerSearchSelect } from "@/modules/customers/components/CustomerSearchSelect";
import { lineKey, type CartLine } from "../types";
import { usePos } from "../hooks/PosProvider";
import { lineTotals, round2, validateDiscount } from "../services/posMath";
import { PaymentPanel } from "./PaymentPanel";
import { ProductThumb } from "./ProductThumb";
import { ConnectivityIndicator } from "./ConnectivityIndicator";

/**
 * The Current Sale card — one surface for the whole checkout.
 *
 * Structure (the approved register architecture):
 *
 *   ┌ current sale ───────────────────────┐
 *   │ header (title, customer, clear)     │  flex:none — never moves
 *   │ cart items table                    │  flex:1 · min-height:0 · scrolls
 *   │ totals + payment + complete         │  flex:none — never moves
 *   └─────────────────────────────────────┘
 *
 * Adding the 5th or the 20th product grows the cart's own scroll, never the
 * card: the customer selector, the totals and the payment button stay on
 * screen, and the cart line list is the only part of the checkout that
 * scrolls. On phones/tablets (the mobile drawer) the same card renders at
 * natural height and the drawer scrolls the sale as a whole.
 *
 * Every control keeps its proven behaviour: quantities, per-item discounts
 * (`none` / `%` / fixed EGP, reused from the existing pricing engine), the
 * invoice-level discount (kept separate from the item discounts), exact
 * variant identity and the payment workflow.
 */

/** Column template shared by the caption row and every cart line (desktop). */
const CART_COLS = "xl:grid-cols-[minmax(0,1fr)_5rem_10rem_7.5rem_6rem_2.25rem]";

export function CartPanel() {
  const { t, num } = useI18n();
  const {
    lines, totals, discount, setDiscount, increase, decrease, removeLine,
    setLineDiscount, clearCart, canDiscount, selectedCustomer, setSelectedCustomer,
  } = usePos();
  const discountError = validateDiscount(discount.type, discount.value);
  const count = lines.reduce((sum, line) => sum + line.qty, 0);

  return (
    <div
      data-testid="pos-cart"
      className="flex h-full w-full min-w-0 flex-col rounded-2xl border border-stone-200 bg-white shadow-sm"
    >
      {/* ── Header — flex:none: sale title, customer, clear ─────────────── */}
      <div className="shrink-0 border-b border-stone-100 px-4 pb-2 pt-2.5">
        <div className="flex items-center justify-between gap-2">
          <p className="flex items-center gap-2 text-sm font-bold text-stone-900">
            {t("pos.cart")}
            <span
              className="grid h-6 min-w-6 place-items-center rounded-full bg-stone-100 px-1.5 text-xs font-bold tabular-nums text-stone-800 ring-1 ring-inset ring-stone-200"
              aria-label={t("pos.cartItems")}
            >
              {count}
            </span>
          </p>
          {lines.length > 0 && (
            <button
              type="button"
              onClick={clearCart}
              className="text-xs font-semibold text-stone-600 underline-offset-2 hover:text-rose-700 hover:underline"
              data-testid="pos-clear-cart"
            >
              {t("pos.clearCart")}
            </button>
          )}
        </div>
        {/* Customer selector + quick-add + walk-in clear, in the fixed header:
            adding many products never pushes it away. */}
        <div className="mt-2">
          <CustomerSearchSelect
            selectedCustomerId={selectedCustomer?.id ?? null}
            onSelect={(customer) => setSelectedCustomer(customer)}
          />
        </div>
        {/* Sale status / online-offline-sync indicator — Part 7 of the offline
            brief: stays in the fixed header, never scrolls with the cart. */}
        <ConnectivityIndicator />
      </div>

      {lines.length === 0 ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 overflow-hidden p-6 text-center">
          <span aria-hidden className="text-3xl">🧾</span>
          <p className="text-sm font-bold text-stone-900">{t("pos.emptyCart")}</p>
          <p className="text-xs font-medium text-stone-500">{t("pos.emptyCartHint")}</p>
        </div>
      ) : (
        <>
          {/* Column captions — flex:none, so they stay visible while rows scroll. */}
          <div
            aria-hidden
            className={`hidden shrink-0 items-center gap-x-3 border-b border-stone-100 px-4 py-1 text-[10px] font-bold uppercase tracking-wider text-stone-400 xl:grid ${CART_COLS}`}
          >
            <span>{t("pos.cols.product")}</span>
            <span className="text-end">{t("pos.cols.price")}</span>
            <span>{t("pos.lineDiscount")}</span>
            <span className="text-center">{t("pos.quantity")}</span>
            <span className="text-end">{t("pos.cols.total")}</span>
            <span className="text-end">{t("common.delete")}</span>
          </div>

          {/* ── Cart items — flex:1, the ONLY vertical scroll area ─────────
              lg:min-h keeps a genuinely usable line viewport: the fixed
              header/totals/payment sections may never squeeze it to a sliver
              (it collapsed to ~28px with one line + split payment before).
              On short viewports the register's 41.5rem floor — not this list
              — gives way, so the page scrolls instead of the list starving. */}
          <ul
            aria-label={t("pos.cartItems")}
            className="pos-grip-scrollbar min-h-0 flex-1 divide-y divide-stone-100 overflow-y-auto px-4 py-1 lg:min-h-[4.5rem]"
          >
            {lines.map((line) => (
              <CartRow
                key={lineKey(line)}
                line={line}
                canDiscount={canDiscount}
                onIncrease={increase}
                onDecrease={decrease}
                onRemove={removeLine}
                onDiscount={setLineDiscount}
              />
            ))}
          </ul>
        </>
      )}

      {/* ── Footer — flex:none: totals, then payment ────────────────────── */}
      <div className="shrink-0">
        <div className="border-t border-stone-100 px-4 py-2.5 text-sm">
          <div className="flex items-center justify-between text-stone-600">
            <span>{t("pos.subtotal")}</span>
            <span className="tabular-nums" dir="ltr">{num(totals.subtotal, 2)}</span>
          </div>
          {totals.itemDiscountAmount > 0 && (
            <div className="mt-0.5 flex items-center justify-between text-stone-600">
              <span>{t("pos.itemDiscountsTotal")}</span>
              <span className="tabular-nums text-rose-700" dir="ltr">−{num(totals.itemDiscountAmount, 2)}</span>
            </div>
          )}
          {/* Invoice-level discount: a separate control from خصم القطعة; both
              feed the same existing pricing engine and never overwrite each other. */}
          <div className="mt-1.5 flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
            <span className="flex min-w-0 flex-wrap items-center gap-1.5">
              <span className="text-xs font-bold text-stone-700">{t("pos.invoiceDiscount")}</span>
              <select
                aria-label={t("pos.invoiceDiscount")}
                disabled={!canDiscount}
                value={discount.type}
                onChange={(event) => setDiscount({ ...discount, type: event.target.value as typeof discount.type })}
                className="h-8 rounded-lg border border-stone-200 bg-white px-1.5 text-xs font-semibold text-stone-800 focus:border-stone-400"
              >
                <option value="none">{t("pos.discountType.none")}</option>
                <option value="percent">{t("pos.discountType.percent")}</option>
                <option value="fixed">{t("pos.discountType.fixed")}</option>
              </select>
              {discount.type !== "none" && (
                <TextInput
                  dir="ltr"
                  inputMode="decimal"
                  disabled={!canDiscount}
                  value={String(discount.value)}
                  invalid={Boolean(discountError)}
                  onChange={(event) => setDiscount({ ...discount, value: Number(event.target.value) })}
                  placeholder={t("pos.discountValue")}
                  aria-label={t("pos.discountValue")}
                  className="h-8 w-20 py-0.5 text-xs"
                />
              )}
            </span>
            {totals.invoiceDiscountAmount > 0 && (
              <span className="text-xs font-semibold tabular-nums text-rose-700" dir="ltr">
                −{num(totals.invoiceDiscountAmount, 2)}
              </span>
            )}
          </div>
          {discountError && (
            <p className="mt-1 text-xs font-semibold text-rose-700">
              {t(discountError === "tooHigh" ? "pos.discountTooHigh" : "pos.discountInvalid")}
            </p>
          )}
          {!canDiscount && <p className="mt-1 text-xs text-stone-600">{t("pos.discountLocked")}</p>}
          <div className="mt-1.5 flex items-center justify-between border-t border-stone-200 pt-1.5 text-base font-extrabold text-stone-900">
            <span>{t("pos.total")}</span>
            <span className="tabular-nums" dir="ltr">{num(totals.total, 2)}</span>
          </div>
        </div>

        {/* Payment lives inside the Current Sale card, pinned below the scroll
            area — the cashier always sees how the sale is being settled. */}
        <PaymentPanel />
      </div>
    </div>
  );
}

/**
 * One sale line. Desktop: a six-cell grid row (product · price · item
 * discount · quantity · total · delete). Below lg the same cells stack as two
 * wrapped control lines so the mobile drawer stays thumb-friendly.
 */
function CartRow({
  line,
  canDiscount,
  onIncrease,
  onDecrease,
  onRemove,
  onDiscount,
}: {
  line: CartLine;
  canDiscount: boolean;
  onIncrease: (key: string) => void;
  onDecrease: (key: string) => void;
  onRemove: (key: string) => void;
  onDiscount: (key: string, discount: { type: "none" | "percent" | "fixed"; value: number }) => void;
}) {
  const { t, num, pick, lang } = useI18n();
  const key = lineKey(line);
  const amounts = lineTotals(line);
  const name = pick(line.name_ar, line.name_en);
  const hasItemDiscount = amounts.discount > 0;
  // The effective unit price after the item discount (850 − 10% → 765). The
  // engine discounts the line; per-piece price is derived, never recomputed.
  const effectiveUnit = line.qty > 0 ? round2(amounts.net / line.qty) : line.unit_price;
  const type = line.item_discount?.type ?? "none";

  return (
    <li
      data-testid={`cart-line-${key}`}
      className={`flex flex-col gap-2 py-2.5 xl:grid xl:items-center xl:gap-x-3 ${CART_COLS}`}
    >
      {/* المنتج — thumbnail, name, exact colour/size, code */}
      <div className="flex min-w-0 items-start gap-2.5">
        <ProductThumb url={line.image_url} name={name} />
        <div className="min-w-0">
          <p className="truncate text-sm font-bold leading-tight text-stone-900" title={name}>{name}</p>
          {line.variant_id && (
            <p className="mt-0.5 text-xs font-semibold text-stone-700" data-testid="pos-line-variant">
              {variantLabel(
                { color_ar: line.color_ar, color_en: line.color_en, size: line.size, size_label: line.size_label },
                lang,
              )}
            </p>
          )}
          <span className="mt-0.5 block truncate font-mono text-[11px] text-stone-500" dir="ltr">{line.sku}</span>
          {line.qty >= line.max_qty && (
            <p className="mt-0.5 text-[11px] font-semibold text-amber-700">
              {t("pos.stockLimit", { count: line.max_qty })}
            </p>
          )}
        </div>
      </div>

      {/* السعر + خصم القطعة (mobile row 1) → grid columns 2–3 on desktop */}
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 xl:contents">
        {/* السعر — original crossed out when discounted, effective price clear */}
        <div
          className={`tabular-nums xl:text-end ${hasItemDiscount ? "flex items-baseline gap-1.5 xl:flex-col xl:items-end xl:gap-0" : ""}`}
          dir="ltr"
        >
          {hasItemDiscount ? (
            <>
              <span className="text-[11px] font-medium text-stone-400 line-through">
                {num(line.unit_price, 2)}
              </span>
              <span
                className="text-sm font-bold text-stone-900"
                title={t("pos.effectivePrice")}
                data-testid={`cart-effective-${key}`}
              >
                {num(effectiveUnit, 2)}
              </span>
            </>
          ) : (
            <span className="text-sm font-semibold text-stone-900">{num(line.unit_price, 2)}</span>
          )}
        </div>

        {/* خصم القطعة — بدون / % / مبلغ ثابت, on the existing engine */}
        <div className="flex min-w-0 items-center gap-1">
          <select
            aria-label={t("pos.lineDiscount")}
            disabled={!canDiscount}
            value={type}
            onChange={(event) =>
              onDiscount(key, {
                type: event.target.value as "none" | "percent" | "fixed",
                value: line.item_discount?.value ?? 0,
              })
            }
            className="h-8 rounded-lg border border-stone-200 bg-white px-1.5 text-xs font-semibold text-stone-800 focus:border-stone-400 disabled:opacity-60"
          >
            <option value="none">{t("pos.discountType.noneShort")}</option>
            <option value="percent">{t("pos.discountType.percentShort")}</option>
            <option value="fixed">{t("pos.discountType.fixedShort")}</option>
          </select>
          {type !== "none" && (
            <>
              <input
                aria-label={t("pos.discountValue")}
                type="number"
                min="0"
                max={type === "percent" ? 100 : undefined}
                disabled={!canDiscount}
                value={line.item_discount?.value ?? 0}
                onChange={(event) =>
                  onDiscount(key, { type: type as "percent" | "fixed", value: Number(event.target.value) })
                }
                className="h-8 w-14 rounded-lg border border-stone-200 bg-white px-1.5 text-end text-xs font-semibold tabular-nums text-stone-900 focus:border-stone-400"
                dir="ltr"
              />
              <button
                type="button"
                onClick={() => onDiscount(key, { type: "none", value: 0 })}
                disabled={!canDiscount}
                aria-label={t("pos.itemDiscountReset")}
                title={t("pos.itemDiscountReset")}
                className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-xs font-bold text-stone-400 transition hover:bg-stone-100 hover:text-stone-700"
              >
                ↺
              </button>
            </>
          )}
        </div>
      </div>

      {/* الكمية + الإجمالي + حذف (mobile row 2) → grid columns 4–6 on desktop */}
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 xl:contents">
        {/* الكمية */}
        <div
          className="flex items-center gap-1 xl:justify-center"
          role="group"
          aria-label={`${name} · ${t("pos.quantity")}`}
        >
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="h-9 w-9 !px-0"
            onClick={() => onDecrease(key)}
            aria-label={t("pos.decrease")}
          >
            −
          </Button>
          <span className="w-7 text-center text-sm font-bold tabular-nums text-stone-900" data-testid={`cart-quantity-${key}`}>
            {line.qty}
          </span>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="h-9 w-9 !px-0"
            disabled={line.qty >= line.max_qty}
            onClick={() => onIncrease(key)}
            aria-label={t("pos.increase")}
          >
            +
          </Button>
        </div>

        {/* الإجمالي — discounted line total on the existing engine */}
        <div className="text-end tabular-nums" dir="ltr">
          <span className="block text-sm font-bold text-stone-900" data-testid={`pos-line-total-${key}`}>
            {num(amounts.net, 2)}
          </span>
          {hasItemDiscount && (
            <span className="block text-[11px] font-semibold text-rose-700">−{num(amounts.discount, 2)}</span>
          )}
        </div>

        {/* حذف */}
        <div className="flex justify-end">
          <button
            type="button"
            onClick={() => onRemove(key)}
            aria-label={`${t("pos.removeItem")}: ${name}`}
            data-testid={`cart-remove-${key}`}
            title={t("pos.removeItem")}
            className="grid h-8 w-8 place-items-center rounded-lg text-stone-400 transition hover:bg-rose-50 hover:text-rose-600"
          >
            <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden className="h-4 w-4">
              <path
                fillRule="evenodd"
                d="M8.5 3h3l.5 1h3v2H5V4h3l.5-1Zm-2 5h9l-.7 8.1a1.5 1.5 0 0 1-1.5 1.4H7.7a1.5 1.5 0 0 1-1.5-1.4L5.5 8Z"
                clipRule="evenodd"
              />
            </svg>
          </button>
        </div>
      </div>
    </li>
  );
}
