/**
 * The variant editor — the admin side of Phase 43.
 *
 * One section under the product form that owns the whole lifecycle:
 *
 *   · **enable** — the one moment stock could silently appear or vanish, so the
 *     admin says where every existing unit goes. The distribution is checked
 *     against the product's own figure HERE (so the button never lies) and
 *     again in the database (so a stale screen cannot lie either). Nothing is
 *     ever defaulted onto a variant.
 *   · **maintain** — generate colours × sizes in one pass, add or edit one
 *     combination, archive/reactivate, delete (history permitting).
 *   · **disable** — refused while history names a combination; otherwise the
 *     consolidated figure must equal what the variants hold, to the unit.
 *
 * The shelf itself is not edited here: stock moves through the inventory
 * screen (`adjust_stock`), which is the same authority a physical recount has.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { canAct } from "@/lib/permissions/enforce";
import {
  Badge,
  Button,
  Field,
  Modal,
  TextArea,
  TextInput,
  ToggleSwitch,
  useToast,
} from "@/components/ui";
import { AppError, type VariantOpening } from "../data/repository";
import {
  deleteVariant,
  disableVariants,
  enableVariants,
  generateVariants,
  listVariants,
  listColorImages,
  labelOf,
  moveVariant,
  replaceColorImages,
  saveVariant,
  setVariantActive,
  type GenerateVariantRow,
} from "../services/variantService";
import {
  colorKeyOf,
  formatSizes,
  generateCombinations,
  isFreeSizeModel,
  modelNameOf,
  parseSizes,
  suggestVariantSku,
  variantLabel,
  variantSizeValue,
  type ProductColorImage,
  type ProductVariant,
  type VariantColorDraft,
} from "../variants";
import type { Product } from "../types";
import { buildBarcodeLabelHtml, buildBarcodeLabelsHtml, type BarcodeLabelData } from "../services/barcodeLabel";
import { deriveBarcodeFromSku, isDerivedFromSku, nextBarcodeOnSkuChange } from "../services/barcode";
import { ProductVariantsForm } from "./ProductVariantsForm";
import { variantDraftFromSaved, validateVariantDraft } from "../services/variantDraft";
import { adjustStock } from "@/modules/inventory/services/inventoryService";

// ── small shared bits ───────────────────────────────────────────────────────

function VariantStatusBadge({ variant }: { variant: ProductVariant }) {
  const { t } = useI18n();
  if (!variant.active) return <Badge tone="neutral">{t("products.variants.statusArchived")}</Badge>;
  if (variant.stock_quantity <= 0) return <Badge tone="danger">{t("products.variants.statusOut")}</Badge>;
  if (variant.low_stock_level > 0 && variant.stock_quantity <= variant.low_stock_level) {
    return <Badge tone="warning">{t("products.variants.statusLow")}</Badge>;
  }
  return <Badge tone="success">{t("products.variants.statusIn")}</Badge>;
}

function Swatch({ hex }: { hex: string | null }) {
  if (!hex) return null;
  return (
    <span
      aria-hidden
      className="inline-block h-3.5 w-3.5 shrink-0 rounded-full border border-slate-300"
      style={{ backgroundColor: hex }}
    />
  );
}

// ── one combination: create / edit ──────────────────────────────────────────

interface VariantFormState {
  color_ar: string;
  color_en: string;
  color_hex: string;
  size_mode: "number" | "label";
  size: string;
  size_label: string;
  sku: string;
  barcode: string;
  price_override: string;
  cost_override: string;
  low_stock_level: string;
  image_url: string;
  active: boolean;
  /** Free-size model name (migration 0096). Blank for a colour/size combination. */
  display_name_en: string;
  display_name_ar: string;
  /** One https image link per line; saved as the variant's own gallery. */
  gallery: string;
}

const EMPTY_VARIANT_FORM: VariantFormState = {
  display_name_en: "",
  display_name_ar: "",
  gallery: "",
  color_ar: "",
  color_en: "",
  color_hex: "",
  size_mode: "number",
  size: "",
  size_label: "",
  sku: "",
  barcode: "",
  price_override: "",
  cost_override: "",
  low_stock_level: "0",
  image_url: "",
  active: true,
};

function VariantFormModal({
  open,
  product,
  siblings,
  current,
  onClose,
  onSaved,
}: {
  open: boolean;
  product: Product;
  siblings: readonly ProductVariant[];
  current: ProductVariant | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t, isRTL } = useI18n();
  const toast = useToast();
  const canCreate = canAct("add_product");
  const canEdit = canAct("edit_product");
  const allowed = current ? canEdit : canCreate;

  const [values, setValues] = useState<VariantFormState>(EMPTY_VARIANT_FORM);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setValues(
      current
        ? {
            color_ar: current.color_ar ?? "",
            color_en: current.color_en ?? "",
            color_hex: current.color_hex ?? "",
            size_mode: "label",
            size: variantSizeValue(current),
            size_label: variantSizeValue(current),
            sku: current.sku,
            barcode: current.barcode ?? "",
            price_override: current.price_override !== null ? String(current.price_override) : "",
            cost_override: current.cost_override !== null ? String(current.cost_override) : "",
            low_stock_level: String(current.low_stock_level),
            image_url: current.image_url ?? "",
            active: current.active,
            display_name_en: current.display_name_en ?? "",
            display_name_ar: current.display_name_ar ?? "",
            gallery: (current.images ?? []).join("\n"),
          }
        : EMPTY_VARIANT_FORM,
    );
  }, [current, open]);

  const set = <K extends keyof VariantFormState>(key: K, value: VariantFormState[K]) =>
    setValues((prev) => ({ ...prev, [key]: value }));

  /**
   * Typing a SKU keeps the barcode "in sync" while the field is still auto
   * (blank, or exactly what the previous SKU would have derived) — the same
   * rule the product form applies. A barcode that has already diverged (a
   * manufacturer code, a manual override) is left alone.
   */
  const setSku = (nextSku: string) =>
    setValues((prev) => ({
      ...prev,
      sku: nextSku,
      barcode: nextBarcodeOnSkuChange(prev.sku, nextSku, prev.barcode),
    }));

  const regenerateBarcode = () => {
    const derived = deriveBarcodeFromSku(values.sku);
    if (!derived) {
      toast.error(t("barcode.needsSku"));
      return;
    }
    set("barcode", derived);
  };

  const barcodeIsAuto = !values.barcode.trim() || isDerivedFromSku(values.sku, values.barcode);

  const save = async () => {
    if (!allowed || saving) return;
    setSaving(true);
    try {
      await saveVariant({
        product,
        values: {
          sku: values.sku,
          barcode: values.barcode.trim() || null,
          color_ar: values.color_ar.trim() || null,
          color_en: values.color_en.trim() || null,
          color_hex: values.color_hex.trim() || null,
          size: /^[0-9]+(?:\.[0-9]{1,2})?$/.test(values.size.trim()) ? Number(values.size.trim()) : null,
          size_label: values.size.trim() || null,
          size_value: values.size.trim() || null,
          size_sort_order: current?.size_sort_order ?? current?.sort_order ?? siblings.length + 1,
          image_url: values.image_url.trim() || null,
          display_name_en: values.display_name_en.trim() || null,
          display_name_ar: values.display_name_ar.trim() || null,
          images: values.gallery
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean),
          // New combinations start empty: the shelf is filled by the inventory
          // screen, never by a form field.
          stock_quantity: current?.stock_quantity ?? 0,
          price_override: values.price_override.trim() === "" ? null : Number(values.price_override),
          cost_override:
            canAct("view_cost") && values.cost_override.trim() !== ""
              ? Number(values.cost_override)
              : (current?.cost_override ?? null),
          low_stock_level: Math.max(0, Math.trunc(Number(values.low_stock_level) || 0)),
          active: values.active,
          sort_order: current?.sort_order ?? siblings.length + 1,
        },
        currentId: current?.id,
        siblings,
      });
      toast.success(t(current ? "products.variants.savedEdit" : "products.variants.savedNew"));
      onSaved();
      onClose();
    } catch (err) {
      toast.error(err instanceof AppError ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const combinationLabel = [
    values.color_en.trim() || values.color_ar.trim(),
    values.size.trim(),
  ]
    .filter(Boolean)
    .join(" / ");

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={
        current
          ? t("products.variants.editTitle", { label: labelOf(current, isRTL ? "ar" : "en") })
          : t("products.variants.newTitle")
      }
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            {t("common.cancel")}
          </Button>
          <Button onClick={() => void save()} loading={saving} disabled={!allowed}>
            {t("common.save")}
          </Button>
        </>
      }
    >
      {!allowed ? (
        <p className="mb-3 rounded-lg bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-800">
          {t("products.variants.noPermission")}
        </p>
      ) : null}
      <p className="mb-3 text-xs font-semibold text-slate-600">{t("products.variants.freeSizeHelp")}</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t("products.variants.modelName")} hint={t("products.variants.modelNameHint")}>
          <TextInput
            value={values.display_name_en}
            onChange={(e) => set("display_name_en", e.target.value)}
            placeholder="Model A"
            disabled={!allowed}
            data-testid="variant-form-model-en"
          />
        </Field>
        <Field label={t("products.variants.modelName")}>
          <TextInput
            value={values.display_name_ar}
            onChange={(e) => set("display_name_ar", e.target.value)}
            placeholder="موديل A"
            disabled={!allowed}
          />
        </Field>
        <Field label={t("products.variants.colorEn")} hint={t("products.variants.colorHint")}>
          <TextInput
            value={values.color_en}
            onChange={(e) => set("color_en", e.target.value)}
            placeholder="Gold"
            disabled={!allowed}
          />
        </Field>
        <Field label={t("products.variants.colorAr")}>
          <TextInput
            value={values.color_ar}
            onChange={(e) => set("color_ar", e.target.value)}
            placeholder="ذهبي"
            disabled={!allowed}
          />
        </Field>
        <Field label={t("products.variants.colorHex")} hint={t("products.variants.hexHint")}>
          <TextInput
            dir="ltr"
            value={values.color_hex}
            onChange={(e) => set("color_hex", e.target.value)}
            placeholder="#d4af37"
            disabled={!allowed}
          />
        </Field>
        <Field label={t("products.variants.sizeLabel")} hint={t("products.variants.sizeLabelHint")}>
          <TextInput
            dir="auto"
            value={values.size}
            onChange={(e) => set("size", e.target.value)}
            placeholder="XS · 42 · 28x30 · 3-4Y · One Size"
            disabled={!allowed || Boolean(current)}
          />
        </Field>
        <Field label={t("products.sku")} required>
          <TextInput
            dir="ltr"
            value={values.sku}
            onChange={(e) => setSku(e.target.value)}
            placeholder={suggestVariantSku(
              product.sku,
              values.color_en.trim() || values.color_ar.trim()
                ? { color_ar: values.color_ar || null, color_en: values.color_en || null }
                : null,
              values.size.trim() || null,
              values.size.trim() || null,
              siblings.map((v) => v.sku),
            )}
            disabled={!allowed}
          />
        </Field>
        <Field
          label={t("products.barcode")}
          hint={barcodeIsAuto ? t("barcode.autoHint") : t("barcode.manualHint")}
        >
          <div className="flex items-center gap-1.5">
            <TextInput
              dir="ltr"
              value={values.barcode}
              placeholder={deriveBarcodeFromSku(values.sku)}
              onChange={(e) => set("barcode", e.target.value)}
              disabled={!allowed}
              className="flex-1"
              data-testid="variant-form-barcode"
            />
            <Badge tone={barcodeIsAuto ? "info" : "neutral"}>
              {barcodeIsAuto ? t("barcode.auto") : t("barcode.manual")}
            </Badge>
            <button
              type="button"
              onClick={regenerateBarcode}
              disabled={!allowed}
              title={t("barcode.regenerate")}
              className="rounded-md px-1.5 py-1.5 text-[11px] font-bold text-indigo-600 hover:bg-indigo-50 disabled:opacity-40"
            >
              {t("barcode.generate")}
            </button>
          </div>
        </Field>
        <Field
          label={t("products.variants.priceOverride")}
          hint={
            values.display_name_en.trim() || values.display_name_ar.trim()
              ? t("products.variants.noPriceForModel")
              : t("products.variants.priceHint")
          }
        >
          <TextInput
            dir="ltr"
            inputMode="decimal"
            value={values.price_override}
            onChange={(e) => set("price_override", e.target.value)}
            placeholder={String(product.selling_price)}
            disabled={!allowed}
          />
        </Field>
        {canAct("view_cost") ? (
          <Field label={t("products.variants.costOverride")}>
            <TextInput
              dir="ltr"
              inputMode="decimal"
              value={values.cost_override}
              onChange={(e) => set("cost_override", e.target.value)}
              placeholder={String(product.cost_price)}
              disabled={!allowed}
            />
          </Field>
        ) : null}
        <Field label={t("products.variants.lowStock")} hint={t("products.variants.lowStockHint")}>
          <TextInput
            dir="ltr"
            inputMode="numeric"
            value={values.low_stock_level}
            onChange={(e) => set("low_stock_level", e.target.value)}
            disabled={!allowed}
          />
        </Field>
        <Field label={t("products.imageUrl")} hint={t("products.variants.imageHint")}>
          <TextInput
            dir="ltr"
            type="url"
            value={values.image_url}
            onChange={(e) => set("image_url", e.target.value)}
            placeholder="https://…"
            disabled={!allowed}
          />
        </Field>
        <Field label={t("products.variants.gallery")} hint={t("products.variants.galleryHint")} className="sm:col-span-2">
          <textarea
            dir="ltr"
            rows={3}
            value={values.gallery}
            onChange={(e) => set("gallery", e.target.value)}
            placeholder="https://…/model-a-front.jpg"
            disabled={!allowed}
            data-testid="variant-form-gallery"
            className="w-full rounded-lg border border-slate-200 px-3 py-2 font-mono text-xs text-slate-900 focus:border-indigo-400 focus:outline-none disabled:bg-slate-50"
          />
        </Field>
        <div className="sm:col-span-2">
          <ToggleSwitch
            label={t("common.active")}
            hint={current ? t("products.simple.archiveOption") : !values.active ? t("products.inactiveBadge") : undefined}
            checked={values.active}
            onChange={(checked) => set("active", checked)}
            disabled={!allowed || Boolean(current)}
          />
        </div>
      </div>
      {combinationLabel ? (
        <p className="mt-3 rounded-lg bg-slate-50 px-3 py-2 text-xs font-semibold text-slate-700">
          {t("products.variants.preview")}: <span className="font-black">{combinationLabel}</span>
        </p>
      ) : null}
    </Modal>
  );
}

// ── generate colours × sizes ────────────────────────────────────────────────

function VariantGeneratorModal({
  open,
  product,
  siblings,
  onClose,
  onDone,
}: {
  open: boolean;
  product: Product;
  siblings: readonly ProductVariant[];
  onClose: () => void;
  onDone: () => void;
}) {
  const { t } = useI18n();
  const toast = useToast();
  const allowed = canAct("add_product");

  const [colorsText, setColorsText] = useState("");
  const [sizesText, setSizesText] = useState("");
  const [lowStock, setLowStock] = useState("0");
  const [disabledCombinations,setDisabledCombinations]=useState<Set<string>>(()=>new Set());
  const [saving, setSaving] = useState(false);

  // One colour per line: "English | العربية | #hex" — the hex optional, the
  // English optional when an Arabic name carries the colour.
  const colors: VariantColorDraft[] = useMemo(() => {
    return colorsText
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [en = "", ar = "", hex = ""] = line.split("|").map((part) => part.trim());
        const normalizedHex = /^#[0-9a-fA-F]{6}$/.test(hex) ? hex.toLowerCase() : null;
        return {
          color_en: en || null,
          color_ar: ar || null,
          color_hex: normalizedHex,
        } satisfies VariantColorDraft;
      })
      .filter((color) => (color.color_en ?? "") !== "" || (color.color_ar ?? "") !== "");
  }, [colorsText]);

  const sizes = useMemo(() => parseSizes(sizesText), [sizesText]);

  const rows: GenerateVariantRow[] = useMemo(() => {
    const taken = siblings.map((v) => v.sku);
    return generateCombinations(colors, sizes).map((combination) => {
      const sku = suggestVariantSku(product.sku, combination.color, combination.size, combination.size_label, taken);
      return {
        color: combination.color,
        size: combination.size,
        size_label: combination.size_label,
        size_value: combination.size_value,
        size_sort_order: combination.size_sort_order,
        sku,
        // Every row this preview creates is scannable from the moment it is
        // saved — the barcode is derived from the suggested SKU up front.
        barcode: deriveBarcodeFromSku(sku),
        enabled: !disabledCombinations.has(`${combination.color_key}|${combination.size_value ?? ""}`),
      };
    });
  }, [colors, product.sku, siblings, sizes,disabledCombinations]);

  const generate = async () => {
    if (!allowed || saving) return;
    setSaving(true);
    try {
      const created = await generateVariants({
        product,
        rows,
        siblings,
        lowStockLevel: Math.max(0, Math.trunc(Number(lowStock) || 0)),
      });
      toast.success(t("products.variants.generated", { count: created.length }));
      onDone();
      onClose();
    } catch (err) {
      toast.error(err instanceof AppError ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t("products.variants.generateTitle")}
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            {t("common.cancel")}
          </Button>
          <Button
            onClick={() => void generate()}
            loading={saving}
            disabled={!allowed || rows.every((row)=>!row.enabled)}
          >
            {t("products.variants.generateCta", { count: rows.filter((row)=>row.enabled).length })}
          </Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field
          label={t("products.variants.colorsInput")}
          hint={t("products.variants.colorsHint")}
          className="sm:col-span-2"
        >
          <TextArea
            rows={4}
            value={colorsText}
            onChange={(e) => setColorsText(e.target.value)}
            placeholder={"Gold | ذهبي | #d4af37\nSilver | فضي | #c0c0c0\nRose Gold | روز جولد"}
            disabled={!allowed}
          />
        </Field>
        <Field label={t("products.variants.sizesInput")} hint={t("products.variants.sizesHint")}>
          <TextInput
            dir="ltr"
            value={sizesText}
            onChange={(e) => setSizesText(e.target.value)}
            placeholder="16, 16.5, 17, 17.5"
            disabled={!allowed}
          />
        </Field>
        <Field label={t("products.variants.lowStock")} hint={t("products.variants.lowStockHint")}>
          <TextInput
            dir="ltr"
            inputMode="numeric"
            value={lowStock}
            onChange={(e) => setLowStock(e.target.value)}
            disabled={!allowed}
          />
        </Field>
      </div>

      <div className="mt-3 rounded-xl border border-slate-200">
        <p className="border-b border-slate-100 px-3 py-2 text-[11px] font-bold uppercase tracking-wider text-slate-500">
          {t("products.variants.previewCount", { count: rows.length })}
          {sizes.length > 0 ? ` · ${t("products.variants.sizesReadback")}: ${formatSizes(sizes)}` : ""}
        </p>
        <ul className="max-h-52 divide-y divide-slate-50 overflow-y-auto">
          {rows.map((row) => (
            <li key={row.sku} className={`flex items-center justify-between gap-2 px-3 py-1.5 text-xs ${row.enabled ? "" : "opacity-50"}`}>
              <input type="checkbox" checked={row.enabled} aria-label={`Include ${row.sku}`} onChange={(event)=>{
                const key=`${row.color ? colorKeyOf(row.color) : ""}|${row.size_value ?? ""}`;
                setDisabledCombinations((current)=>{const next=new Set(current);if(event.target.checked)next.delete(key);else next.add(key);return next;});
              }}/>
              <span className="flex items-center gap-1.5 font-semibold text-slate-800">
                <Swatch hex={row.color?.color_hex ?? null} />
                {variantLabel({
                  color_en: row.color?.color_en ?? null,
                  color_ar: row.color?.color_ar ?? null,
                  size: row.size,
                  size_label: row.size_label,
                  size_value: row.size_value,
                })}
              </span>
              <span className="flex flex-col items-end font-mono text-[11px] text-slate-500 leading-tight">
                <span>{row.sku}</span>
                <span className="text-slate-400">{row.barcode}</span>
              </span>
            </li>
          ))}
          {rows.length === 0 ? (
            <li className="px-3 py-3 text-center text-xs text-slate-500">
              {t("products.variants.nothingToGenerate")}
            </li>
          ) : null}
        </ul>
      </div>
      {/* Combinations that already exist are skipped, not re-created — the
          same colour/size pair the product already sells stays untouched. */}
      <p className="mt-2 text-[11px] font-medium text-slate-500">{t("products.variants.generateNote")}</p>
    </Modal>
  );
}

// ── the section itself ──────────────────────────────────────────────────────

export function VariantEditor({
  product,
  variants,
  onChanged,
}: {
  product: Product;
  /** Every variant of THIS product, display order. */
  variants: readonly ProductVariant[];
  /** Re-read after any mutation (the parent refreshes catalog + variants). */
  onChanged: () => Promise<void> | void;
}) {
  const { t, num, pick, isRTL } = useI18n();
  const toast = useToast();
  const lang = isRTL ? "ar" : "en";

  // ── label print: shared field toggles + per-row copies for single AND
  // bulk printing, so the two actions never drift into two different UIs. ──
  const [labelOptions, setLabelOptions] = useState({ name: true, color: true, size: true, sku: true, price: true, number: true });
  const [copies, setCopies] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const copiesFor = (variantId: string) => Math.max(1, Math.min(Number(copies[variantId]) || 1, 40));

  const openPrintWindow = (html: string) => {
    const win = window.open("", "_blank", "width=720,height=640");
    if (!win) { toast.error(t("barcode.printBlocked")); return; }
    win.document.open(); win.document.write(html); win.document.close();
  };

  /** A variant with no barcode yet (hand-cleared, or saved before this
   * feature existed) still gets one at print time — it is never silently
   * excluded from a label run, since this never changes what is stored. */
  const labelDataFor = (variant: ProductVariant, labelCopies: number): BarcodeLabelData => ({
    nameAr: product.name_ar, nameEn: product.name_en, sku: variant.sku,
    barcode: variant.barcode?.trim() || deriveBarcodeFromSku(variant.sku),
    color: pick(variant.color_ar, variant.color_en), size: variantSizeValue(variant),
    price: `${num(variant.price_override ?? product.selling_price, 2)} EGP`,
    copies: labelCopies, direction: isRTL ? "rtl" : "ltr",
    showName: labelOptions.name, showColor: labelOptions.color, showSize: labelOptions.size,
    showSku: labelOptions.sku, showPrice: labelOptions.price, showNumber: labelOptions.number,
  });

  const labelStrings = {
    documentTitle: t("barcode.printTitle"), skuLabel: t("products.sku"),
    priceLabel: t("products.sellingPrice"), printAction: t("barcode.print"), unsupported: t("barcode.unsupported"),
  };

  const printVariant = (variant: ProductVariant) => {
    const data = labelDataFor(variant, copiesFor(variant.id));
    if (!data.barcode) { toast.error(t("barcode.needsValue")); return; }
    openPrintWindow(buildBarcodeLabelHtml(data, labelStrings));
  };

  const printSelected = () => {
    const chosen = variants.filter((variant) => selected.has(variant.id));
    if (!chosen.length) return;
    const items = chosen
      .map((variant) => ({ data: labelDataFor(variant, copiesFor(variant.id)) }))
      .filter((item) => Boolean(item.data.barcode));
    if (!items.length) { toast.error(t("barcode.needsValue")); return; }
    openPrintWindow(buildBarcodeLabelsHtml(items, labelStrings));
  };

  const toggleSelected = (id: string) =>
    setSelected((prev) => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const allSelected = variants.length > 0 && variants.every((variant) => selected.has(variant.id));
  const toggleSelectAll = () =>
    setSelected((prev) => (prev.size === variants.length ? new Set() : new Set(variants.map((variant) => variant.id))));

  const canEdit = canAct("edit_product");
  const canDelete = canAct("delete_product");

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<ProductVariant | null>(null);
  const [generatorOpen, setGeneratorOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [colorImages,setColorImages]=useState<ProductColorImage[]>([]);
  const [simple, setSimple] = useState(() => variantDraftFromSaved(variants));
  const sourceSignature = JSON.stringify([variants,colorImages]);
  const previousSource = useRef(sourceSignature);
  const locallyEdited = useRef(false);
  useEffect(()=>{
    let cancelled=false;
    void listColorImages(product.id).then((images)=>{if(!cancelled)setColorImages(images);}).catch(()=>{});
    return ()=>{cancelled=true;};
  },[product.id,variants.length]);
  useEffect(() => {
    if (sourceSignature === previousSource.current) return;
    if (!locallyEdited.current) setSimple(variantDraftFromSaved(variants,colorImages));
    previousSource.current = sourceSignature;
  }, [sourceSignature, variants,colorImages]);
  const changeSimple = (next: typeof simple) => { locallyEdited.current = true; setSimple(next); };
  const canStock = canAct("adjust_stock");
  const canCreate = canAct("add_product");
  const simpleError = validateVariantDraft(simple, product.sku, product.barcode ?? "");
  const simpleDirty = JSON.stringify(simple) !== JSON.stringify(variantDraftFromSaved(variants,colorImages));

  // ── enable flow ──
  const [enabling, setEnabling] = useState(false);
  const [opening, setOpening] = useState<Record<string, string>>({});
  const openingTotal = useMemo(
    () =>
      variants.reduce((sum, variant) => sum + (Math.trunc(Number(opening[variant.id]) || 0)), 0),
    [opening, variants],
  );
  const openingBalanced = openingTotal === product.stock_quantity;

  // ── disable flow ──
  const [disabling, setDisabling] = useState(false);
  const [consolidated, setConsolidated] = useState("");
  const shelfTotal = useMemo(
    () => variants.reduce((sum, variant) => sum + variant.stock_quantity, 0),
    [variants],
  );

  const [references, setReferences] = useState<Record<string, number>>({});
  useEffect(() => {
    if (!canDelete) return;
    let cancelled = false;
    import("../services/variantService")
      .then(({ listVariantReferences }) => listVariantReferences())
      .then((map) => {
        if (!cancelled) setReferences(map);
      })
      .catch(() => {
        /* the counts only decorate the delete button; the database still refuses */
      });
    return () => {
      cancelled = true;
    };
  }, [canDelete, variants.length]);

  const run = useCallback(
    async (action: () => Promise<unknown>, successKey?: Parameters<typeof t>[0]) => {
      if (busy) return;
      setBusy(true);
      try {
        await action();
        if (successKey) toast.success(t(successKey));
        await onChanged();
      } catch (err) {
        toast.error(err instanceof AppError ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [busy, onChanged, t, toast],
  );

  const saveSimple = async () => {
    if (busy || !canEdit || !simpleDirty) return;
    if (simpleError) { toast.error(t(`products.simple.${simpleError}` as never)); return; }
    const pending = simple.rows.filter((row) => !row.persistedId);
    if (pending.length && !canCreate) { toast.error(t("products.variants.noPermission")); return; }
    if (pending.some((row) => Number(row.stock_quantity) > 0) && (!canStock || !product.variants_enabled)) {
      toast.error(t(!canStock ? "products.simple.stockRights" : "products.simple.enableFirst"));
      return;
    }
    setBusy(true);
    try {
      const siblings = (await listVariants()).filter((row) => row.product_id === product.id);
      for (const row of simple.rows) {
        const before = siblings.find((entry) => entry.id === row.persistedId);
        const color = simple.colors.find((entry) => entry.id === row.color_id);
        // A retry after a partial network failure must not create a duplicate.
        const twin = before ?? (!row.persistedId ? siblings.find((entry) =>
          entry.color_key === (row.color_key || (color ? colorKeyOf(color) : "")) &&
          variantSizeValue(entry).toLocaleLowerCase() === row.size.trim().toLocaleLowerCase(),
        ) : null);
        const previous = before ?? twin ?? null;
        const desired = {
          sku: row.sku.trim(), barcode: row.barcode.trim() || null,
          color_key: (previous?.color_key ?? row.color_key) || undefined,
          color_ar: row.color_ar.trim() || null, color_en: row.color_en.trim() || null,
          color_hex: row.color_hex.trim() || null,
          size: previous?.size ?? (/^[0-9]+(?:\.[0-9]{1,2})?$/.test(row.size.trim()) ? Number(row.size.trim()) : null),
          size_label: previous?.size_label ?? (row.size.trim() || null),
          size_value: previous ? variantSizeValue(previous) : (row.size.trim() || null),
          size_sort_order: row.size_sort_order,
          image_url: row.image_url.trim() || null,
          price_override: row.price_override.trim() ? Number(row.price_override) : null,
          cost_override: canAct("change_cost")
            ? (row.cost_override.trim() ? Number(row.cost_override) : null)
            : previous?.cost_override ?? null,
          stock_quantity: 0, // existing stock is ALWAYS read-only in this form
          low_stock_level: Number(row.low_stock_level),
          active: previous?.active ?? row.active,
          sort_order: previous?.sort_order ?? siblings.length + 1,
        };
        // No write for an untouched saved shelf: preserves history and avoids
        // incidental metadata changes when adding just one new size.
        if (previous && row.persistedId &&
            previous.sku === desired.sku && previous.barcode === desired.barcode &&
            previous.color_ar === desired.color_ar && previous.color_en === desired.color_en &&
            previous.color_hex === desired.color_hex && previous.image_url === desired.image_url &&
            (previous.size_sort_order ?? 0) === desired.size_sort_order &&
            previous.price_override === desired.price_override && previous.cost_override === desired.cost_override &&
            previous.low_stock_level === desired.low_stock_level) continue;

        const saved = await saveVariant({ product, siblings, currentId: previous?.id, values: desired });
        if (!previous) siblings.push(saved.variant);
        if (!row.persistedId && Number(row.stock_quantity) > saved.variant.stock_quantity) {
          // Inventory service writes a movement and updates only this shelf;
          // changing a product/variant stock field directly is forbidden.
          await adjustStock({ productId: product.id, variantId: saved.variant.id,
            type: "adjustment_in", reason: "other",
            quantity: Number(row.stock_quantity) - saved.variant.stock_quantity,
            notes: `Opening stock for new combination ${saved.variant.sku}` });
        }
      }
      await replaceColorImages(product.id,simple.colors.flatMap((color)=>{
        const colorKey=color.id && !color.id.startsWith("color:") ? color.id : colorKeyOf(color);
        return color.image_urls.map((image_url,index)=>({color_key:colorKey,image_url,
          alt_ar:color.color_ar.trim()||null,alt_en:color.color_en.trim()||null,
          sort_order:index,is_primary:index===0}));
      }));
      toast.success(t("products.simple.saved"));
      locallyEdited.current = false;
      const [fresh,freshImages] = await Promise.all([
        listVariants().then((rows)=>rows.filter((row)=>row.product_id===product.id)),
        listColorImages(product.id),
      ]);
      setColorImages(freshImages);
      setSimple(variantDraftFromSaved(fresh,freshImages));
      previousSource.current = JSON.stringify(fresh);
      await onChanged();
    } catch (err) {
      toast.error(err instanceof AppError ? err.message : String(err));
      await onChanged(); // show any rows written before a transient failure
    } finally {
      setBusy(false);
    }
  };

  const toggleVariants = () => {
    if (!canEdit || busy) return;
    if (!product.variants_enabled) {
      // Opening the enable panel starts an empty distribution: the admin says
      // where every unit goes, and nothing is assumed.
      setOpening({});
      setEnabling(true);
    } else {
      setConsolidated(String(shelfTotal));
      setDisabling(true);
    }
  };

  const confirmEnable = () =>
    void run(async () => {
      const distribution: VariantOpening[] = variants.map((variant) => ({
        variantId: variant.id,
        quantity: Math.trunc(Number(opening[variant.id]) || 0),
      }));
      await enableVariants(product.id, distribution);
      setEnabling(false);
    });

  const confirmDisable = () =>
    void run(async () => {
      await disableVariants(product.id, Math.trunc(Number(consolidated) || 0));
      setDisabling(false);
    });

  const archivedCount = variants.filter((variant) => !variant.active).length;
  const activeCount = variants.length - archivedCount;
  const unitsTotal = shelfTotal;
  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-4" data-testid="variant-editor">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-bold text-slate-900">{t("products.variants.title")}</h2>
          <p className="mt-0.5 text-xs font-medium text-slate-600">{t("products.variants.subtitle")}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {product.variants_enabled ? (
            <Badge tone="info">
              {t("products.variants.countBadge", {
                count: variants.length,
                units: num(unitsTotal, 0),
              })}
            </Badge>
          ) : null}
          {/* Drafting combinations is the bootstrap: the list is created
              BEFORE the mode is switched on (that is what emptyDisabled says),
              and it stays possible while disabled so a product can be prepared
              or re-prepared. Only the shelves wait for the conversion. */}
          {canEdit && (product.variants_enabled || variants.length > 0) ? (
            <Button size="sm" variant="ghost" onClick={toggleVariants} disabled={busy} data-testid="variant-mode-toggle">
              {product.variants_enabled ? t("products.variants.disable") : t("products.variants.enable")}
            </Button>
          ) : null}
        </div>
      </div>

      <div className="mt-4" data-testid="variant-simple-editor">
        <ProductVariantsForm
          value={simple} productSku={product.sku} productBarcode={product.barcode ?? ""}
          productSellingPrice={String(product.selling_price)} productCostPrice={String(product.cost_price)}
          editing stockEditable={canStock && product.variants_enabled} onChange={changeSimple}
        />
        {canEdit && (
          <div className="mt-2 flex justify-end">
            <Button type="button" onClick={() => void saveSimple()} loading={busy}
              disabled={!simpleDirty || Boolean(simpleError)} data-testid="variant-simple-save">
              {t("products.simple.saveCombinations")}
            </Button>
          </div>
        )}
      </div>

      {/* Kept only for unusual legacy one-shelf or conversion cases. The normal
          employee uses the simple controls above, not pipe-delimited text. */}
      {canEdit && <details className="mt-3 rounded-xl border border-slate-200 px-3 py-2" data-testid="variant-advanced">
        <summary className="cursor-pointer text-xs font-bold text-slate-600">{t("products.simple.advanced")}</summary>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button size="sm" variant="secondary" onClick={() => { setEditing(null); setFormOpen(true); }} data-testid="variant-add">+ {t("products.variants.addOne")}</Button>
          <Button size="sm" variant="secondary" onClick={() => setGeneratorOpen(true)} data-testid="variant-generate">{t("products.variants.generate")}</Button>
        </div>
      </details>}

      {/* ── enable: the opening distribution ── */}
      {enabling && !product.variants_enabled ? (
        <div className="mt-3 rounded-xl border border-indigo-200 bg-indigo-50/50 p-3" data-testid="variant-enable-panel">
          <p className="text-xs font-bold text-indigo-900">{t("products.variants.enableHint")}</p>
          <ul className="mt-2 divide-y divide-indigo-100">
            {variants.map((variant) => (
              <li key={variant.id} className="flex items-center justify-between gap-3 py-1.5">
                <span className="flex items-center gap-1.5 text-xs font-semibold text-slate-800">
                  <Swatch hex={variant.color_hex} />
                  {labelOf(variant, lang)}
                  <span className="font-mono text-[10px] text-slate-400">{variant.sku}</span>
                </span>
                <TextInput
                  dir="ltr"
                  inputMode="numeric"
                  value={opening[variant.id] ?? ""}
                  onChange={(e) => setOpening((prev) => ({ ...prev, [variant.id]: e.target.value }))}
                  placeholder="0"
                  className="h-8 w-20 text-xs"
                  data-testid={`opening-${variant.sku}`}
                />
              </li>
            ))}
          </ul>
          <div className="mt-2 flex items-center justify-between gap-3">
            <p className={`text-xs font-bold ${openingBalanced ? "text-emerald-700" : "text-amber-700"}`}>
              {t("products.variants.openingBalance", {
                distributed: num(openingTotal, 0),
                stock: num(product.stock_quantity, 0),
              })}
            </p>
            <div className="flex gap-2">
              <Button size="sm" variant="secondary" onClick={() => setEnabling(false)}>
                {t("common.cancel")}
              </Button>
              <Button
                size="sm"
                onClick={confirmEnable}
                disabled={busy || !openingBalanced}
                data-testid="variant-enable-confirm"
              >
                {t("products.variants.enableCta")}
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      {/* ── disable: consolidation, guarded ── */}
      {disabling && product.variants_enabled ? (
        <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50/60 p-3" data-testid="variant-disable-panel">
          <p className="text-xs font-bold text-amber-900">{t("products.variants.disableHint")}</p>
          <div className="mt-2 flex flex-wrap items-end justify-between gap-3">
            <Field label={t("products.variants.consolidated")} className="w-40">
              <TextInput
                dir="ltr"
                inputMode="numeric"
                value={consolidated}
                onChange={(e) => setConsolidated(e.target.value)}
                data-testid="variant-consolidated-input"
              />
            </Field>
            <div className="flex gap-2">
              <Button size="sm" variant="secondary" onClick={() => setDisabling(false)}>
                {t("common.cancel")}
              </Button>
              <Button
                size="sm"
                onClick={confirmDisable}
                disabled={busy || Math.trunc(Number(consolidated) || 0) !== shelfTotal}
                data-testid="variant-disable-confirm"
              >
                {t("products.variants.disableCta")}
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      {/* ── the combinations table ── */}
      {variants.length > 0 ? (
        <div className="mt-3 space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-slate-50 p-2.5 text-[11px]" data-testid="variant-label-toolbar">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-semibold text-slate-600">
              {(["name", "color", "size", "sku", "price", "number"] as const).map((key) => (
                <label key={key} className="flex items-center gap-1">
                  <input
                    type="checkbox"
                    checked={labelOptions[key]}
                    onChange={(event) => setLabelOptions((current) => ({ ...current, [key]: event.target.checked }))}
                  />
                  {key}
                </label>
              ))}
            </div>
            <Button
              size="sm"
              variant="secondary"
              type="button"
              disabled={selected.size === 0}
              onClick={printSelected}
              data-testid="variant-print-selected"
            >
              {t("products.variants.printSelected", { count: selected.size })}
            </Button>
          </div>
          <div className="overflow-x-auto rounded-xl border border-slate-200">
          <table className="w-full text-xs" data-testid="variant-table">
            <thead>
              <tr className="border-b border-slate-100 bg-slate-50 text-start text-[10px] font-bold uppercase tracking-wider text-slate-500">
                <th className="px-2 py-2 text-center">
                  <input
                    type="checkbox"
                    aria-label={t("products.variants.selectAll")}
                    checked={allSelected}
                    onChange={toggleSelectAll}
                    data-testid="variant-select-all"
                  />
                </th>
                <th className="px-3 py-2 text-start">{t("products.variants.colCombination")}</th>
                <th className="px-3 py-2 text-start">{t("products.sku")}</th>
                <th className="px-3 py-2 text-start">{t("products.variants.colBarcode")}</th>
                <th className="px-3 py-2 text-end">{t("products.variants.colPrice")}</th>
                {canAct("view_cost") ? (
                  <th className="px-3 py-2 text-end">{t("products.variants.colCost")}</th>
                ) : null}
                <th className="px-3 py-2 text-end">{t("products.variants.colStock")}</th>
                <th className="px-3 py-2 text-start">{t("products.variants.colStatus")}</th>
                <th className="px-3 py-2 text-center">{t("products.variants.colCopies")}</th>
                <th className="px-3 py-2 text-end">{t("products.variants.colActions")}</th>
              </tr>
            </thead>
            <tbody>
              {variants.map((variant) => {
                const referenced = (references[variant.id] ?? 0) > 0;
                const lastSellable = product.variants_enabled && (variants.length <= 1 || (variant.active && activeCount <= 1));
                const barcodeAuto = isDerivedFromSku(variant.sku, variant.barcode);
                return (
                  <tr key={variant.id} className="border-b border-slate-50 last:border-0" data-testid={`variant-row-${variant.sku}`}>
                    <td className="px-2 py-2 text-center">
                      <input
                        type="checkbox"
                        aria-label={`${t("products.variants.selectAll")} ${variant.sku}`}
                        checked={selected.has(variant.id)}
                        onChange={() => toggleSelected(variant.id)}
                        data-testid={`variant-select-${variant.sku}`}
                      />
                    </td>
                    <td className="px-3 py-2">
                      {isFreeSizeModel(variant) ? (
                        <span className="flex items-center gap-1.5 font-bold text-slate-900" data-testid={`variant-model-${variant.sku}`}>
                          {modelNameOf(variant, lang)}
                          <Badge tone="info">{t("pos.variants.freeSize")}</Badge>
                          {variant.images && variant.images.length > 0 ? (
                            <span className="text-[10px] font-semibold text-slate-500">{variant.images.length} 📷</span>
                          ) : null}
                        </span>
                      ) : (
                        <span className="flex items-center gap-1.5 font-bold text-slate-900">
                          <Swatch hex={variant.color_hex} />
                          {pick(variant.color_ar, variant.color_en) || t("store.variants.defaultColor")}
                          <span className="font-black text-slate-500">/</span>
                          <span className="tabular-nums">{variantSizeValue(variant)}</span>
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 font-mono text-[11px] text-slate-600">{variant.sku}</td>
                    <td className="px-3 py-2">
                      <span className="flex items-center gap-1.5 font-mono text-[11px] text-slate-600" data-testid={`variant-barcode-${variant.sku}`}>
                        {variant.barcode?.trim() || <span className="italic text-slate-400">{t("barcode.needsValue")}</span>}
                        <Badge tone={variant.barcode?.trim() ? (barcodeAuto ? "info" : "neutral") : "warning"}>
                          {variant.barcode?.trim() ? (barcodeAuto ? t("barcode.auto") : t("barcode.manual")) : "—"}
                        </Badge>
                      </span>
                    </td>
                    <td className="px-3 py-2 text-end tabular-nums">
                      {variant.price_override !== null ? num(variant.price_override, 2) : "—"}
                    </td>
                    {canAct("view_cost") ? (
                      <td className="px-3 py-2 text-end tabular-nums">
                        {variant.cost_override !== null ? num(variant.cost_override, 2) : "—"}
                      </td>
                    ) : null}
                    <td className="px-3 py-2 text-end font-bold tabular-nums text-slate-900">
                      {product.variants_enabled ? num(variant.stock_quantity, 0) : "—"}
                    </td>
                    <td className="px-3 py-2">
                      <VariantStatusBadge variant={variant} />
                    </td>
                    <td className="px-3 py-2 text-center">
                      <TextInput
                        dir="ltr"
                        inputMode="numeric"
                        value={copies[variant.id] ?? "1"}
                        onChange={(e) => setCopies((prev) => ({ ...prev, [variant.id]: e.target.value }))}
                        className="mx-auto h-7 w-14 text-center text-xs"
                        aria-label={`${t("products.variants.colCopies")} ${variant.sku}`}
                        data-testid={`variant-copies-${variant.sku}`}
                      />
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex items-center justify-end gap-1">
                        <button
                          type="button"
                          onClick={() => printVariant(variant)}
                          className="rounded-md px-1.5 py-1 font-bold text-slate-600 hover:bg-slate-100"
                          title={t("barcode.print")}
                        >
                          {t("barcode.print")}
                        </button>
                        {canEdit ? (
                          <>
                            <button
                              type="button"
                              disabled={busy}
                              aria-label={`${t("products.moveUp")} ${variant.sku}`}
                              onClick={() => void run(() => moveVariant(variant.id, -1, variants))}
                              className="rounded-md px-1.5 py-1 font-bold text-slate-600 hover:bg-slate-100 disabled:opacity-30"
                              data-testid={`variant-move-up-${variant.sku}`}
                            >
                              ↑
                            </button>
                            <button
                              type="button"
                              disabled={busy}
                              aria-label={`${t("products.moveDown")} ${variant.sku}`}
                              onClick={() => void run(() => moveVariant(variant.id, 1, variants))}
                              className="rounded-md px-1.5 py-1 font-bold text-slate-600 hover:bg-slate-100 disabled:opacity-30"
                              data-testid={`variant-move-down-${variant.sku}`}
                            >
                              ↓
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                setEditing(variant);
                                setFormOpen(true);
                              }}
                              className="rounded-md px-1.5 py-1 font-bold text-indigo-600 hover:bg-indigo-50"
                            >
                              {t("common.edit")}
                            </button>
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() =>
                                void run(() => setVariantActive(variant.id, !variant.active))
                              }
                              className="rounded-md px-1.5 py-1 font-bold text-slate-600 hover:bg-slate-100"
                            >
                              {variant.active ? t("products.variants.archive") : t("products.variants.reactivate")}
                            </button>
                          </>
                        ) : null}
                        {canDelete ? (
                          <button
                            type="button"
                            disabled={busy || referenced || lastSellable}
                            title={
                              referenced
                                ? t("products.variants.referenced", { count: references[variant.id] ?? 0 })
                                : lastSellable ? t("products.variants.lastActive") : undefined
                            }
                            onClick={() => void run(() => deleteVariant(variant.id), "products.variants.deleted")}
                            className="rounded-md px-1.5 py-1 font-bold text-rose-600 hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-40"
                          >
                            {t("common.delete")}
                          </button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          </div>
        </div>
      ) : (
        <p className="mt-3 rounded-xl bg-slate-50 px-3 py-3 text-xs font-medium text-slate-600">
          {product.variants_enabled
            ? t("products.variants.emptyEnabled")
            : t("products.variants.emptyDisabled")}
        </p>
      )}

      {product.variants_enabled && archivedCount > 0 ? (
        <p className="mt-2 text-[11px] font-medium text-slate-500">
          {t("products.variants.archivedNote", { count: archivedCount })}
        </p>
      ) : null}

      <VariantFormModal
        open={formOpen}
        product={product}
        siblings={variants}
        current={editing}
        onClose={() => setFormOpen(false)}
        onSaved={() => void onChanged()}
      />
      <VariantGeneratorModal
        open={generatorOpen}
        product={product}
        siblings={variants}
        onClose={() => setGeneratorOpen(false)}
        onDone={() => void onChanged()}
      />
    </section>
  );
}
