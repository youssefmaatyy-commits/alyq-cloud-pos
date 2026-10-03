import { useEffect, useMemo, useRef, useState } from "react";
import { Button, Field, Modal, SelectInput, TextArea, TextInput, useToast } from "@/components/ui";
import { useBranch } from "@/lib/branch";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { variantSizeValue } from "@/modules/products/variants";
import { useInventory } from "../hooks/InventoryProvider";
import {
  listSupabaseTransfers,
  transferSupabaseStock,
  type StockTransfer,
} from "../data/transfers";

interface StockTransferModalProps {
  open: boolean;
  onClose: () => void;
}

function operationRef(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? `transfer-${crypto.randomUUID()}`
    : `transfer-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** Minimal transfer workflow over the atomic inventory_transfer_stock RPC. */
export function StockTransferModal({ open, onClose }: StockTransferModalProps) {
  const { isRTL, pick, num, date } = useI18n();
  const toast = useToast();
  const branch = useBranch();
  const { products, variantsByProduct, mode, refresh } = useInventory();
  const [destination, setDestination] = useState("");
  const [productId, setProductId] = useState("");
  const [variantId, setVariantId] = useState("");
  const [quantity, setQuantity] = useState("");
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [recent, setRecent] = useState<StockTransfer[]>([]);
  const clientRef = useRef<string | null>(null);

  const text = isRTL ? {
    title: "تحويل مخزون بين الفروع",
    source: "الفرع المصدر",
    destination: "الفرع الوجهة",
    product: "المنتج",
    combination: "التركيبة الدقيقة",
    quantity: "الكمية",
    reason: "السبب / الملاحظة",
    choose: "اختر",
    transfer: "تحويل الآن",
    available: "متاح",
    recent: "آخر التحويلات",
    none: "لا توجد تحويلات بعد",
    required: "اختر الوجهة والمنتج والتركيبة المطلوبة وأدخل كمية صحيحة.",
    success: "تم تحويل المخزون ذرياً بين الفرعين.",
    retry: "تم تأكيد التحويل السابق دون خصم إضافي.",
  } : {
    title: "Transfer stock between branches",
    source: "Source branch",
    destination: "Destination branch",
    product: "Product",
    combination: "Exact combination",
    quantity: "Quantity",
    reason: "Reason / note",
    choose: "Choose",
    transfer: "Transfer now",
    available: "Available",
    recent: "Recent transfers",
    none: "No transfers yet",
    required: "Choose a destination, product and required combination, then enter a valid quantity.",
    success: "Stock transferred atomically between branches.",
    retry: "The existing transfer was confirmed without another deduction.",
  };

  const destinations = branch.branches.filter((item) => item.id !== branch.current?.id && item.active);
  const tracked = useMemo(
    () => products.filter((product) => product.active && product.stock_tracking_enabled),
    [products],
  );
  const product = tracked.find((item) => item.id === productId) ?? null;
  const combinations = useMemo(
    () => (productId ? (variantsByProduct.get(productId) ?? []).filter((variant) => variant.active) : []),
    [productId, variantsByProduct],
  );
  const variant = combinations.find((item) => item.id === variantId) ?? null;
  const available = variant?.stock_quantity ?? product?.stock_quantity ?? 0;
  const wanted = Number(quantity);
  const valid = mode === "supabase"
    && Boolean(branch.current && destination && product)
    && (!product?.variants_enabled || Boolean(variant))
    && Number.isInteger(wanted) && wanted > 0 && wanted <= available;

  useEffect(() => {
    if (!open) return;
    setDestination("");
    setProductId("");
    setVariantId("");
    setQuantity("");
    setReason("");
    clientRef.current = null;
    void listSupabaseTransfers().then(setRecent).catch(() => setRecent([]));
  }, [open]);

  const submit = async () => {
    if (!valid || !product) {
      toast.error(text.required);
      return;
    }
    setSaving(true);
    try {
      clientRef.current ??= operationRef();
      const result = await transferSupabaseStock({
        clientRef: clientRef.current,
        destinationBranchId: destination,
        productId: product.id,
        variantId: variant?.id ?? null,
        quantity: wanted,
        reason: reason.trim() || null,
      });
      toast.success(result.replayed ? text.retry : `${text.success} ${result.transfer.reference}`);
      clientRef.current = null;
      await refresh();
      setRecent(await listSupabaseTransfers());
      setQuantity("");
      setReason("");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={text.title}
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            {isRTL ? "إغلاق" : "Close"}
          </Button>
          <Button onClick={() => void submit()} loading={saving} disabled={!valid || saving}>
            {text.transfer}
          </Button>
        </>
      }
    >
      <div className="space-y-4" data-testid="stock-transfer-form">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={text.source}>
            <TextInput value={pick(branch.current?.name_ar, branch.current?.name_en) || "—"} disabled />
          </Field>
          <Field label={text.destination} required>
            <SelectInput value={destination} onChange={(event) => setDestination(event.target.value)}>
              <option value="">{text.choose}</option>
              {destinations.map((item) => (
                <option key={item.id} value={item.id}>{pick(item.name_ar, item.name_en)}</option>
              ))}
            </SelectInput>
          </Field>
        </div>

        <Field label={text.product} required>
          <SelectInput
            value={productId}
            onChange={(event) => { setProductId(event.target.value); setVariantId(""); }}
          >
            <option value="">{text.choose}</option>
            {tracked.map((item) => (
              <option key={item.id} value={item.id}>{pick(item.name_ar, item.name_en)} · {item.sku}</option>
            ))}
          </SelectInput>
        </Field>

        {product?.variants_enabled ? (
          <Field label={text.combination} required>
            <SelectInput value={variantId} onChange={(event) => setVariantId(event.target.value)}>
              <option value="">{text.choose}</option>
              {combinations.map((item) => (
                <option key={item.id} value={item.id}>
                  {(pick(item.color_ar, item.color_en) || "—")} / {variantSizeValue(item) || "—"} · {item.sku} · {text.available} {num(item.stock_quantity, 0)}
                </option>
              ))}
            </SelectInput>
          </Field>
        ) : null}

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={`${text.quantity} · ${text.available} ${num(available, 0)}`} required>
            <TextInput
              value={quantity}
              inputMode="numeric"
              dir="ltr"
              onChange={(event) => setQuantity(event.target.value)}
              invalid={quantity.length > 0 && (!Number.isInteger(wanted) || wanted <= 0 || wanted > available)}
            />
          </Field>
          <Field label={text.reason}>
            <TextArea value={reason} maxLength={500} onChange={(event) => setReason(event.target.value)} />
          </Field>
        </div>

        <div className="rounded-xl border border-slate-200">
          <p className="border-b border-slate-200 px-3 py-2 text-xs font-bold text-slate-700">{text.recent}</p>
          {recent.length === 0 ? (
            <p className="px-3 py-4 text-xs text-slate-500">{text.none}</p>
          ) : (
            <div className="divide-y divide-slate-100">
              {recent.map((item) => {
                const source = branch.branches.find((entry) => entry.id === item.source_branch_id);
                const target = branch.branches.find((entry) => entry.id === item.destination_branch_id);
                return (
                  <div key={item.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-xs">
                    <div>
                      <p className="font-mono font-bold text-slate-800">{item.reference}</p>
                      <p className="text-slate-500">
                        {pick(source?.name_ar, source?.name_en) || item.source_branch_id} → {pick(target?.name_ar, target?.name_en) || item.destination_branch_id}
                        {" · "}{num(item.quantity, 0)}{" · "}{item.initiated_by_name}
                      </p>
                    </div>
                    <div className="text-end text-slate-500">
                      <p className="font-semibold text-emerald-700">{item.status}</p>
                      <p dir="ltr">{date(item.completed_at)}</p>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
