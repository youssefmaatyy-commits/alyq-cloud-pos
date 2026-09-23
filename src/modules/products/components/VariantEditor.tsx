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
import { useCallback, useEffect, useMemo, useState } from "react";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { canAct } from "@/lib/permissions/enforce";
import {
  Badge,
  Button,
  Field,
  Modal,
  SelectInput,
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
  labelOf,
  saveVariant,
  setVariantActive,
  type GenerateVariantRow,
} from "../services/variantService";
import {
  formatSizes,
  generateCombinations,
  parseSizes,
  sizeLabelOf,
  suggestVariantSku,
  variantLabel,
  type ProductVariant,
  type VariantColorDraft,
} from "../variants";
import type { Product } from "../types";
import { buildBarcodeLabelHtml } from "../services/barcodeLabel";

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
}

const EMPTY_VARIANT_FORM: VariantFormState = {
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
            size_mode: current.size !== null ? "number" : "label",
            size: current.size !== null ? sizeLabelOf(current.size, null) : "",
            size_label: current.size_label ?? "",
            sku: current.sku,
            barcode: current.barcode ?? "",
            price_override: current.price_override !== null ? String(current.price_override) : "",
            cost_override: current.cost_override !== null ? String(current.cost_override) : "",
            low_stock_level: String(current.low_stock_level),
            image_url: current.image_url ?? "",
            active: current.active,
          }
        : EMPTY_VARIANT_FORM,
    );
  }, [current, open]);

  const set = <K extends keyof VariantFormState>(key: K, value: VariantFormState[K]) =>
    setValues((prev) => ({ ...prev, [key]: value }));

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
          size:
            values.size_mode === "number" && values.size.trim() !== ""
              ? Number(values.size.replace(",", "."))
              : null,
          size_label:
            values.size_mode === "label" && values.size_label.trim() !== ""
              ? values.size_label.trim()
              : null,
          image_url: values.image_url.trim() || null,
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
    values.size_mode === "number"
      ? sizeLabelOf(values.size.trim() === "" ? null : Number(values.size.replace(",", ".")), null)
      : values.size_label.trim(),
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
      <div className="grid gap-3 sm:grid-cols-2">
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
        <Field label={t("products.variants.sizeKind")}>
          <SelectInput
            value={values.size_mode}
            onChange={(e) => set("size_mode", e.target.value as "number" | "label")}
            disabled={!allowed}
          >
            <option value="number">{t("products.variants.sizeKindNumber")}</option>
            <option value="label">{t("products.variants.sizeKindLabel")}</option>
          </SelectInput>
        </Field>
        {values.size_mode === "number" ? (
          <Field label={t("products.variants.size")} hint={t("products.variants.sizeHint")}>
            <TextInput
              dir="ltr"
              inputMode="decimal"
              value={values.size}
              onChange={(e) => set("size", e.target.value)}
              placeholder="17.5"
              disabled={!allowed}
            />
          </Field>
        ) : (
          <Field label={t("products.variants.sizeLabel")} hint={t("products.variants.sizeLabelHint")}>
            <TextInput
              value={values.size_label}
              onChange={(e) => set("size_label", e.target.value)}
              placeholder={t("products.variants.oneSize")}
              disabled={!allowed}
            />
          </Field>
        )}
        <Field label={t("products.sku")} required>
          <TextInput
            dir="ltr"
            value={values.sku}
            onChange={(e) => set("sku", e.target.value)}
            placeholder={suggestVariantSku(
              product.sku,
              values.color_en.trim() || values.color_ar.trim()
                ? { color_ar: values.color_ar || null, color_en: values.color_en || null }
                : null,
              values.size_mode === "number" && values.size.trim() !== ""
                ? Number(values.size.replace(",", "."))
                : null,
              values.size_mode === "label" ? values.size_label : null,
              siblings.map((v) => v.sku),
            )}
            disabled={!allowed}
          />
        </Field>
        <Field label={t("products.barcode")}>
          <TextInput
            dir="ltr"
            value={values.barcode}
            onChange={(e) => set("barcode", e.target.value)}
            disabled={!allowed}
          />
        </Field>
        <Field label={t("products.variants.priceOverride")} hint={t("products.variants.priceHint")}>
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
        <div className="sm:col-span-2">
          <ToggleSwitch
            label={t("common.active")}
            hint={!values.active ? t("products.inactiveBadge") : undefined}
            checked={values.active}
            onChange={(checked) => set("active", checked)}
            disabled={!allowed}
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
    return generateCombinations(colors, sizes).map((combination) => ({
      color: combination.color,
      size: combination.size,
      size_label: combination.size_label,
      sku: suggestVariantSku(product.sku, combination.color, combination.size, combination.size_label, taken),
      enabled: true,
    }));
  }, [colors, product.sku, siblings, sizes]);

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
            disabled={!allowed || rows.length === 0}
          >
            {t("products.variants.generateCta", { count: rows.length })}
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
            <li key={row.sku} className="flex items-center justify-between gap-2 px-3 py-1.5 text-xs">
              <span className="flex items-center gap-1.5 font-semibold text-slate-800">
                <Swatch hex={row.color?.color_hex ?? null} />
                {variantLabel({
                  color_en: row.color?.color_en ?? null,
                  color_ar: row.color?.color_ar ?? null,
                  size: row.size,
                  size_label: row.size_label,
                })}
              </span>
              <span className="font-mono text-[11px] text-slate-500">{row.sku}</span>
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
  const printVariant = (variant: ProductVariant) => {
    if (!variant.barcode?.trim()) { toast.error(t("barcode.needsValue")); return; }
    const html = buildBarcodeLabelHtml({
      nameAr: product.name_ar, nameEn: product.name_en, sku: variant.sku, barcode: variant.barcode,
      color: pick(variant.color_ar, variant.color_en), size: sizeLabelOf(variant.size, variant.size_label),
      price: `${num(variant.price_override ?? product.selling_price, 2)} EGP`, direction: isRTL ? "rtl" : "ltr",
    }, { documentTitle: t("barcode.printTitle"), skuLabel: t("products.sku"), priceLabel: t("products.sellingPrice"), printAction: t("barcode.print"), unsupported: t("barcode.unsupported") });
    const win = window.open("", "_blank", "width=720,height=640");
    if (!win) { toast.error(t("barcode.printBlocked")); return; }
    win.document.open(); win.document.write(html); win.document.close();
  };

  const canEdit = canAct("edit_product");
  const canDelete = canAct("delete_product");

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<ProductVariant | null>(null);
  const [generatorOpen, setGeneratorOpen] = useState(false);
  const [busy, setBusy] = useState(false);

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
  const unitsTotal = shelfTotal;
  const hasColors = variants.some((variant) => Boolean(variant.color_key));
  const hasSizes = variants.some((variant) => variant.size !== null || Boolean(variant.size_label));
  const mode = !variants.length ? "none" : hasColors && hasSizes ? "colors_sizes" : hasColors ? "colors" : "sizes";

  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-4" data-testid="variant-editor">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-bold text-slate-900">{t("products.variants.title")}</h2>
          <p className="mt-0.5 text-xs font-medium text-slate-600">{t("products.variants.subtitle")}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Field label={t("products.variants.mode.label")} className="min-w-40">
            <SelectInput value={mode} disabled aria-label={t("products.variants.mode.label")}>
              <option value="none">{t("products.variants.mode.none")}</option>
              <option value="colors">{t("products.variants.mode.colors")}</option>
              <option value="sizes">{t("products.variants.mode.sizes")}</option>
              <option value="colors_sizes">{t("products.variants.mode.colors_sizes")}</option>
            </SelectInput>
          </Field>
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
          {canEdit ? (
            <>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  setEditing(null);
                  setFormOpen(true);
                }}
                data-testid="variant-add"
              >
                + {t("products.variants.addOne")}
              </Button>
              <Button size="sm" variant="secondary" onClick={() => setGeneratorOpen(true)} data-testid="variant-generate">
                {t("products.variants.generate")}
              </Button>
            </>
          ) : null}
          {canEdit && (product.variants_enabled || variants.length > 0) ? (
            <Button size="sm" variant="ghost" onClick={toggleVariants} disabled={busy} data-testid="variant-mode-toggle">
              {product.variants_enabled ? t("products.variants.disable") : t("products.variants.enable")}
            </Button>
          ) : null}
        </div>
      </div>

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
        <div className="mt-3 overflow-x-auto rounded-xl border border-slate-200">
          <table className="w-full text-xs" data-testid="variant-table">
            <thead>
              <tr className="border-b border-slate-100 bg-slate-50 text-start text-[10px] font-bold uppercase tracking-wider text-slate-500">
                <th className="px-3 py-2 text-start">{t("products.variants.colCombination")}</th>
                <th className="px-3 py-2 text-start">{t("products.sku")}</th>
                <th className="px-3 py-2 text-end">{t("products.variants.colPrice")}</th>
                {canAct("view_cost") ? (
                  <th className="px-3 py-2 text-end">{t("products.variants.colCost")}</th>
                ) : null}
                <th className="px-3 py-2 text-end">{t("products.variants.colStock")}</th>
                <th className="px-3 py-2 text-start">{t("products.variants.colStatus")}</th>
                <th className="px-3 py-2 text-end">{t("products.variants.colActions")}</th>
              </tr>
            </thead>
            <tbody>
              {variants.map((variant) => {
                const referenced = (references[variant.id] ?? 0) > 0;
                return (
                  <tr key={variant.id} className="border-b border-slate-50 last:border-0" data-testid={`variant-row-${variant.sku}`}>
                    <td className="px-3 py-2">
                      <span className="flex items-center gap-1.5 font-bold text-slate-900">
                        <Swatch hex={variant.color_hex} />
                        {pick(variant.color_ar, variant.color_en) || t("store.variants.defaultColor")}
                        <span className="font-black text-slate-500">/</span>
                        <span className="tabular-nums">{sizeLabelOf(variant.size, variant.size_label)}</span>
                      </span>
                    </td>
                    <td className="px-3 py-2 font-mono text-[11px] text-slate-600">{variant.sku}</td>
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
                            disabled={busy || referenced}
                            title={
                              referenced
                                ? t("products.variants.referenced", {
                                    count: references[variant.id] ?? 0,
                                  })
                                : undefined
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
