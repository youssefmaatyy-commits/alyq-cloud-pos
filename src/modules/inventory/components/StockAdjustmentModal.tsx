import { useEffect, useMemo, useState } from "react";
import { useI18n } from "@/lib/i18n/I18nProvider";
import {
  Button,
  Field,
  Modal,
  SelectInput,
  TextArea,
  TextInput,
  useToast,
} from "@/components/ui";
import {
  ADJUSTMENT_ERROR_KEY,
  MAX_ADJUSTMENT_NOTES,
  parseAdjustmentQuantity,
  validateAdjustment,
} from "../validation";
import {
  EMPTY_ADJUSTMENT_FORM,
  STOCK_MOVEMENT_TYPES,
  STOCK_REASONS,
  isOutbound,
  type StockAdjustmentFormValues,
  type StockMovementType,
  type StockReason,
} from "../types";
import { useInventory } from "../hooks/InventoryProvider";
import { sizeLabelOf, type ProductVariant } from "@/modules/products/variants";

const REASONS_FOR_TYPE: Record<StockMovementType, StockReason[]> = {
  adjustment_in: ["recount", "customer_return", "other"],
  adjustment_out: ["recount", "other"],
  receive: ["purchase", "transfer_in"],
  issue: ["transfer_out", "other"],
  transfer: ["transfer_in", "transfer_out"],
  correction: ["recount"],
};

interface StockAdjustmentModalProps {
  productId: string;
  open: boolean;
  onClose: () => void;
}

export function StockAdjustmentModal({ productId, open, onClose }: StockAdjustmentModalProps) {
  const { t, pick, num, date } = useI18n();
  const toast = useToast();
  const { productById, movementsForProduct, variantsByProduct, adjustStock, canAdjust } =
    useInventory();

  const product = productId ? productById(productId) : undefined;
  const [values, setValues] = useState<StockAdjustmentFormValues>(EMPTY_ADJUSTMENT_FORM);
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [submitAttempted, setSubmitAttempted] = useState(false);
  const [saving, setSaving] = useState(false);

  // Phase 43: which shelf is being counted. A variant product is adjusted per
  // combination — the rollup above it is derived and refuses direct writes.
  const variants = useMemo(
    () => (productId ? variantsByProduct.get(productId) ?? [] : []),
    [productId, variantsByProduct],
  );
  const [variantId, setVariantId] = useState<string | null>(null);
  const activeVariants = useMemo(
    () => variants.filter((variant) => variant.active),
    [variants],
  );
  const needsVariantChoice = Boolean(product?.variants_enabled && activeVariants.length > 0);
  const chosenVariant: ProductVariant | null =
    activeVariants.find((variant) => variant.id === variantId) ?? null;

  useEffect(() => {
    if (!open) return;
    setValues(EMPTY_ADJUSTMENT_FORM);
    setTouched({});
    setSubmitAttempted(false);
    setVariantId(null);
  }, [open, productId]);

  const result = useMemo(() => validateAdjustment(values), [values]);
  const allowedReasons = useMemo(() => REASONS_FOR_TYPE[values.type] ?? [...STOCK_REASONS], [values.type]);

  const showError = (field: keyof StockAdjustmentFormValues) =>
    touched[field] || submitAttempted ? result.errors[field] : undefined;

  const handleTypeChange = (type: StockMovementType) => {
    setValues((prev) => {
      const nextAllowed = REASONS_FOR_TYPE[type] ?? [...STOCK_REASONS];
      const stillAllowed = nextAllowed.includes(prev.reason);
      return {
        ...prev,
        type,
        reason: stillAllowed ? prev.reason : (nextAllowed[0] ?? "other"),
      };
    });
  };

  const { value: qty, isInteger } = parseAdjustmentQuantity(values.quantity);
  // The before/after arithmetic runs on the CHOSEN SHELF: for a variant product
  // the rollup follows the combination, never the other way round.
  const currentQty = chosenVariant ? chosenVariant.stock_quantity : product?.stock_quantity ?? 0;
  const resultQty = isOutbound(values.type)
    ? currentQty - (Number.isFinite(qty) ? qty : 0)
    : currentQty + (Number.isFinite(qty) ? qty : 0);
  const wouldGoNegative = isOutbound(values.type) && resultQty < 0;
  const showNegativeWarning = submitAttempted && wouldGoNegative;

  const set = <K extends keyof StockAdjustmentFormValues>(
    k: K,
    v: StockAdjustmentFormValues[K],
  ) => setValues((p: StockAdjustmentFormValues) => ({ ...p, [k]: v }));

  const handleSave = async () => {
    setSubmitAttempted(true);
    if (Object.keys(result.errors).length > 0) {
      toast.error(t("validation.fixErrors"));
      return;
    }
    if (!product) return;
    if (!canAdjust) {
      toast.error(t("inventory.adjust.permission"));
      return;
    }
    if (!result.data) return;
    if (needsVariantChoice && !chosenVariant) {
      toast.error(t("inventory.adjust.variantRequired"));
      return;
    }
    if (wouldGoNegative) {
      toast.error(t("inventory.adjust.willGoNegative", { result: num(resultQty, 0) }));
      return;
    }
    setSaving(true);
    try {
      await adjustStock({
        productId: product.id,
        variantId: chosenVariant?.id ?? null,
        type: result.data.type,
        reason: result.data.reason,
        quantity: result.data.quantity,
        notes: result.data.notes,
      });
      toast.success(t("inventory.toast.created"));
      onClose();
    } catch (error) {
      const err = error as { code?: string; message?: string };
      if (err?.code === "FORBIDDEN") {
        toast.error(t("inventory.adjust.permission"));
      } else {
        toast.error(t("inventory.toast.failed"));
      }
    } finally {
      setSaving(false);
    }
  };

  // Recent movements for the product — shown as a sidebar in the dialog.
  const recent = useMemo(
    () => movementsForProduct(productId).slice(0, 4),
    [movementsForProduct, productId],
  );

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t("inventory.adjustTitle")}
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            {t("common.cancel")}
          </Button>
          <Button
            onClick={handleSave}
            loading={saving}
            disabled={
              !canAdjust ||
              (product && !product.stock_tracking_enabled) ||
              wouldGoNegative
            }
          >
            {saving ? t("common.saving") : t("inventory.adjust")}
          </Button>
        </>
      }
    >
      {product ? (
        <div className="space-y-4">
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
            <p className="text-sm font-bold text-slate-900">
              {pick(product.name_ar, product.name_en)}
            </p>
            <p className="text-xs font-medium text-slate-600">
              <span className="font-mono">{product.sku}</span>
              {product.barcode ? <span className="ms-2 font-mono">{product.barcode}</span> : null}
            </p>
            {needsVariantChoice ? (
              <div className="mt-2">
                <Field label={t("inventory.adjust.combination")} required>
                  <SelectInput
                    value={variantId ?? ""}
                    onChange={(e) => setVariantId(e.target.value || null)}
                    data-testid="adjust-variant-select"
                  >
                    <option value="">{t("inventory.adjust.pickCombination")}</option>
                    {activeVariants.map((variant) => (
                      <option key={variant.id} value={variant.id}>
                        {pick(variant.color_ar, variant.color_en) || "—"}
                        {" / "}
                        {sizeLabelOf(variant.size, variant.size_label)}
                        {" · "}
                        {num(variant.stock_quantity, 0)}
                      </option>
                    ))}
                  </SelectInput>
                </Field>
              </div>
            ) : null}
            <p className="mt-1 text-[11px] font-semibold text-slate-600">
              {t("products.stockQuantity")}: <span className="tabular-nums">{num(product.stock_quantity, 0)}</span>
              <span className="ms-2 text-slate-400">
                · {t("products.lowStockLevel")} {num(product.low_stock_level, 0)}
              </span>
            </p>
            {!product.stock_tracking_enabled ? (
              <p className="mt-2 text-xs font-semibold text-rose-700">⚠ {t("inventory.adjust.trackingDisabled")}</p>
            ) : null}
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t("products.type") + ":"} required htmlFor="inv-type">
              <SelectInput
                id="inv-type"
                value={values.type}
                onChange={(e) => handleTypeChange(e.target.value as StockMovementType)}
              >
                {STOCK_MOVEMENT_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {t(`inventory.type.${type}` as never)}
                  </option>
                ))}
              </SelectInput>
            </Field>
            <Field label={t("inventory.adjust.reason")} required htmlFor="inv-reason">
              <SelectInput
                id="inv-reason"
                value={values.reason}
                onChange={(e) => set("reason", e.target.value as StockReason)}
              >
                {allowedReasons.map((reason) => (
                  <option key={reason} value={reason}>
                    {t(`inventory.reason.${reason}` as never)}
                  </option>
                ))}
              </SelectInput>
            </Field>
          </div>

          <Field
            label={
              isOutbound(values.type)
                ? t("inventory.adjust.out")
                : t("inventory.adjust.in")
            }
            required
            error={showError("quantity") ? t(ADJUSTMENT_ERROR_KEY[showError("quantity") as keyof typeof ADJUSTMENT_ERROR_KEY] as never) : undefined}
            htmlFor="inv-qty"
          >
            <TextInput
              id="inv-qty"
              dir="ltr"
              inputMode="numeric"
              value={values.quantity}
              invalid={Boolean(showError("quantity"))}
              onBlur={() => setTouched((p) => ({ ...p, quantity: true }))}
              onChange={(e) => set("quantity", e.target.value)}
              placeholder="0"
            />
            <div className="mt-2 flex flex-wrap items-center gap-2 text-xs font-semibold">
              <span className="text-slate-600">
                {t("inventory.adjust.willResult")}:{" "}
                <span className={cn(isInteger && wouldGoNegative ? "text-rose-700" : "text-slate-900", "tabular-nums")}>
                  {num(Number.isFinite(resultQty) ? resultQty : currentQty, 0)}
                </span>
              </span>
              {showNegativeWarning ? (
                <span className="rounded-full bg-rose-50 px-2 py-0.5 text-rose-700 ring-1 ring-rose-200">
                  ⚠ {t("inventory.adjust.willGoNegative", { result: num(resultQty, 0) })}
                </span>
              ) : null}
            </div>
          </Field>

          <Field
            label={t("inventory.adjust.notes")}
            optional={t("common.optional")}
            error={showError("notes") ? t(ADJUSTMENT_ERROR_KEY[showError("notes") as keyof typeof ADJUSTMENT_ERROR_KEY] as never) : undefined}
            htmlFor="inv-notes"
            hint={`${values.notes.length}/${MAX_ADJUSTMENT_NOTES}`}
          >
            <TextArea
              id="inv-notes"
              value={values.notes}
              maxLength={MAX_ADJUSTMENT_NOTES}
              onChange={(e) => set("notes", e.target.value)}
              placeholder={t("inventory.adjust.notesPlaceholder")}
            />
          </Field>

          {recent.length > 0 ? (
            <div className="rounded-xl border border-slate-200 bg-white">
              <p className="border-b border-slate-100 px-3 py-2 text-[11px] font-bold uppercase tracking-wider text-slate-600">
                {t("inventory.history.viewProduct")}
              </p>
              <ul className="divide-y divide-slate-100 text-xs">
                {recent.map((m) => (
                  <li key={m.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                    <span className="font-semibold text-slate-700">
                      {t(`inventory.type.${m.type}` as never)}
                    </span>
                    <span className="tabular-nums text-slate-600">
                      {num(m.quantity_before, 0)} → {num(m.quantity_after, 0)}
                    </span>
                    <span className="text-[11px] text-slate-500">{date(m.created_at)}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : (
        <p className="text-sm font-medium text-slate-600">{t("common.notFound")}</p>
      )}
    </Modal>
  );
}

// helper: a tiny classnames util that doesn't require importing `@/utils/cn`
function cn(...args: (string | false | null | undefined)[]) {
  return args.filter(Boolean).join(" ");
}
