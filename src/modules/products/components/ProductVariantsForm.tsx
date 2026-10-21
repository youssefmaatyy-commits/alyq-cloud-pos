import { useRef, useState } from "react";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { Button, Card, Field, SectionTitle, TextInput, useToast } from "@/components/ui";
import { canAct } from "@/lib/permissions/enforce";
import { uploadProductImage, validateImageFile } from "../services/imageStorage";
import {
  createModelDraftRow, EMPTY_PRODUCT_VARIANT_FORM, reconcileVariantDraft, usesColors, usesModels, usesSizes,
  validateVariantDraft, variantDraftTotal,
  type ProductVariantDraft, type ProductVariantFormValue, type ProductVariantMode, type VariantColorRow,
} from "../services/variantDraft";
import { naturalSizeCompare, parseSizes, suggestModelSku, suggestVariantSku, variantLabel } from "../variants";
import { deriveBarcodeFromSku, nextBarcodeOnSkuChange } from "../services/barcode";

export { EMPTY_PRODUCT_VARIANT_FORM };
export type { ProductVariantDraft, ProductVariantFormValue, ProductVariantMode };

interface Props {
  value: ProductVariantFormValue;
  productSku: string;
  productSellingPrice: string;
  productCostPrice: string;
  productBarcode?: string;
  editing?: boolean;
  /** Creation partially saved: keep the combination identities and opening
   * quantities fixed until a retry finishes, while allowing code corrections. */
  structureLocked?: boolean;
  /** Existing variants have an inventory ledger: never edit their stock as a form field. */
  stockEditable?: boolean;
  onChange: (value: ProductVariantFormValue) => void;
}

const COMMON_SWATCHES: Record<string,string> = {
  black:"#000000", white:"#ffffff", red:"#ef4444", blue:"#3b82f6", green:"#22c55e",
  yellow:"#eab308", orange:"#f97316", purple:"#a855f7", pink:"#ec4899", brown:"#92400e",
  gray:"#6b7280", grey:"#6b7280", gold:"#d4af37", silver:"#c0c0c0", beige:"#d6c6a5",
  "أسود":"#000000", "أبيض":"#ffffff", "أحمر":"#ef4444", "أزرق":"#3b82f6", "أخضر":"#22c55e",
  "أصفر":"#eab308", "برتقالي":"#f97316", "بنفسجي":"#a855f7", "وردي":"#ec4899", "بني":"#92400e",
  "رمادي":"#6b7280", "ذهبي":"#d4af37", "فضي":"#c0c0c0", "بيج":"#d6c6a5",
};
const commonSwatch = (name:string) => COMMON_SWATCHES[name.trim().toLocaleLowerCase()] ?? "";

const newColorId = () => `color:${typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : Math.random().toString(36).slice(2)}`;

/** One visible, non-technical color/size workflow used on both Add and Edit. */
export function ProductVariantsForm({
  value, productSku, productSellingPrice, productCostPrice, productBarcode = "",
  editing = false, structureLocked = false, stockEditable = true, onChange,
}: Props) {
  const { t, num, lang } = useI18n();
  const toast = useToast();
  const valueRef = useRef(value);
  valueRef.current = value;
  const [sizeEntry, setSizeEntry] = useState("");
  const [bulkStock, setBulkStock] = useState("");
  const [bulkLow, setBulkLow] = useState("");
  const [uploading, setUploading] = useState<string | null>(null);
  const hasSaved = editing && value.rows.some((row) => row.persistedId);
  const requiresColors = usesColors(value.mode);
  const requiresSizes = usesSizes(value.mode);
  const requiresModels = usesModels(value.mode);
  const displayed = value.mode === "none" ? [] : value.rows;
  const error = validateVariantDraft(value, productSku, productBarcode);

  const change = (next: ProductVariantFormValue) => onChange(reconcileVariantDraft(next, productSku));
  const selectMode = (mode: ProductVariantMode) => {
    if (mode === "models") {
      const reconciled = reconcileVariantDraft({ ...value, mode }, productSku);
      if (reconciled.rows.length === 0) {
        onChange({
          ...reconciled,
          rows: [createModelDraftRow(productSku, 1)],
        });
        return;
      }
      onChange(reconciled);
      return;
    }
    change({ ...value, mode });
  };
  const addModelRow = () => {
    const taken = [productSku, ...value.rows.map((row) => row.sku)].filter(Boolean);
    const nextRow = createModelDraftRow(productSku, value.rows.length + 1, taken);
    onChange(reconcileVariantDraft({ ...value, rows: [...value.rows, nextRow] }, productSku));
  };
  const removeModelRow = (id: string) => {
    const target = value.rows.find((row) => row.id === id);
    if (target?.persistedId) {
      toast.error(t("products.simple.archiveOption"));
      return;
    }
    onChange({ ...value, rows: value.rows.filter((row) => row.id !== id) });
  };
  const updateColor = (id: string, patch: Partial<VariantColorRow>) => change({
    ...value, colors: value.colors.map((color) => color.id === id ? { ...color, ...patch } : color),
  });
  const updateColorName = (color: VariantColorRow, field: "color_ar"|"color_en", name: string) => {
    const automatic = commonSwatch(name);
    updateColor(color.id, { [field]: name, ...(!color.color_hex && automatic ? { color_hex: automatic } : {}) });
  };
  const updateRow = (id: string, patch: Partial<ProductVariantDraft>) => onChange({
    ...value, rows: value.rows.map((row) => row.id === id ? { ...row, ...patch } : row),
  });
  /**
   * Editing a row's SKU keeps its barcode "in sync" while the barcode is
   * still in auto mode (blank, or exactly what the old SKU would derive) —
   * the same rule the product form and the variant editor apply. A barcode
   * that already diverged (hand-typed, a manufacturer code) is left alone.
   */
  const updateSku = (row: ProductVariantDraft, nextSku: string) =>
    updateRow(row.id, {
      sku: nextSku,
      barcode: requiresModels ? row.barcode : nextBarcodeOnSkuChange(row.sku, nextSku, row.barcode),
    });

  const removeColor = (id: string) => {
    if (value.rows.some((row) => row.color_id === id && row.persistedId)) {
      toast.error(t("products.simple.archiveOption"));
      return;
    }
    change({ ...value, colors: value.colors.filter((color) => color.id !== id) });
  };
  const removeSize = (size: string) => {
    if (value.rows.some((row) => row.size.toLocaleLowerCase() === size.toLocaleLowerCase() && row.persistedId)) {
      toast.error(t("products.simple.archiveOption"));
      return;
    }
    change({ ...value, sizes: value.sizes.filter((entry) => entry !== size) });
  };
  const moveSize = (size: string, direction: -1 | 1) => {
    const index = value.sizes.indexOf(size);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= value.sizes.length) return;
    const sizes = [...value.sizes];
    [sizes[index], sizes[target]] = [sizes[target], sizes[index]];
    change({ ...value, sizes });
  };
  const sortSizesNaturally = () => change({ ...value, sizes: [...value.sizes].sort(naturalSizeCompare) });
  const addSizes = () => {
    const parsed = parseSizes(sizeEntry);
    if (!parsed.length) {
      toast.error(t("products.simple.invalidSizes"));
      return;
    }
    const existing = new Set(value.sizes.map((size) => size.toLocaleLowerCase()));
    const newSizes = parsed.filter((size) => !existing.has(size.toLocaleLowerCase()));
    if (!newSizes.length && parsed.length > 0) {
      toast.error(t("products.simple.duplicateSize"));
      return;
    }
    change({ ...value, sizes: [...value.sizes, ...newSizes] });
    setSizeEntry("");
  };

  /** One upload per colour; every new size of that colour reuses the URL. */
  const upload = async (file: File | undefined, key: string, colorId?: string) => {
    if (!file) return;
    const invalid = validateImageFile(file);
    if (invalid) { toast.error(t(invalid === "type" ? "validation.imageType" : "validation.imageSize", { max: 5 })); return; }
    setUploading(key);
    try {
      const url = await uploadProductImage(file);
      const current = valueRef.current;
      if (colorId) {
        onChange({ ...current, colors: current.colors.map((color) => color.id === colorId
          ? { ...color, image_urls: [...color.image_urls, url], image_url: color.image_url || url }
          : color) });
      } else {
        onChange({ ...current, rows: current.rows.map((row) => row.id === key ? { ...row, image_url: url } : row) });
      }
    } catch {
      toast.error(t("products.simple.imageError"));
    } finally {
      setUploading(null);
    }
  };

  const makePrimary = (color: VariantColorRow, url: string) => {
    const image_urls = [url, ...color.image_urls.filter((image) => image !== url)];
    updateColor(color.id, { image_urls, image_url: image_urls[0] ?? "" });
  };
  const removeColorImage = (color: VariantColorRow, url: string) => {
    const image_urls = color.image_urls.filter((image) => image !== url);
    updateColor(color.id, { image_urls, image_url: image_urls[0] ?? "" });
  };
  const moveColorImage = (color: VariantColorRow, url: string, direction: -1 | 1) => {
    const index = color.image_urls.indexOf(url);
    const target = index + direction;
    // Index zero is the explicit primary. Secondary images can be ordered
    // independently; use "Make primary" when the primary itself must change.
    if (index < 1 || target < 1 || target >= color.image_urls.length) return;
    const image_urls = [...color.image_urls];
    [image_urls[index], image_urls[target]] = [image_urls[target], image_urls[index]];
    updateColor(color.id, { image_urls, image_url: image_urls[0] ?? "" });
  };

  const targets = value.rows.filter((row) => !editing || !row.persistedId);
  const bulk = (field: "stock_quantity" | "low_stock_level", raw: string) => {
    if (!/^(0|[1-9]\d*)$/.test(raw)) { toast.error(t("products.simple.invalidQuantity")); return; }
    if (field === "stock_quantity" && !stockEditable) return;
    if (targets.some((row) => row[field] !== "0" && row[field] !== raw) && !window.confirm(t("products.simple.bulkReplace"))) return;
    onChange({ ...value, rows: value.rows.map((row) =>
      targets.some((target) => target.id === row.id) ? { ...row, [field]: raw } : row,
    ) });
  };
  /** Fills any blank SKU, then any blank barcode left behind — a row never
   * leaves this screen without both identifiers once this has run. */
  const generateMissingSku = () => {
    const taken = [productSku, ...value.rows.map((row) => row.sku)].filter(Boolean);
    onChange({ ...value, rows: value.rows.map((row, index) => {
      let sku = row.sku;
      if (!sku.trim()) {
        if (requiresModels) {
          sku = suggestModelSku(productSku, index + 1, taken);
        } else {
          const color = value.colors.find((entry) => entry.id === row.color_id);
          sku = suggestVariantSku(productSku, color ? { color_ar: color.color_ar, color_en: color.color_en } : null,
            row.size || null, row.size || null, taken);
        }
        taken.push(sku);
      }
      const barcode = requiresModels ? row.barcode.trim() : row.barcode.trim() || deriveBarcodeFromSku(sku);
      return sku === row.sku && barcode === row.barcode ? row : { ...row, sku, barcode };
    }) });
  };

  const copyCode = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      void navigator.clipboard.writeText(trimmed).then(
        () => toast.success(t("products.simple.copied")),
        () => {},
      );
    }
  };

  const stepQuantity = (
    row: ProductVariantDraft,
    field: "stock_quantity" | "low_stock_level",
    delta: number,
  ) => {
    const current = Math.max(0, Math.trunc(Number(row[field]) || 0));
    const next = Math.max(0, current + delta);
    updateRow(row.id, { [field]: String(next) });
  };

  return (
    <Card data-testid="product-variants-form" className="min-w-0">
      <SectionTitle>{t("products.variants.title")}</SectionTitle>
      <p className="mb-4 text-xs font-medium text-slate-600">{t("products.simple.intro")}</p>

      <div role="group" aria-label={t("products.variants.mode.label")} data-testid="variant-mode" className="grid gap-2 sm:grid-cols-2 xl:grid-cols-5">
        {(["none", "colors", "sizes", "colors_sizes", "models"] as const).map((mode) => (
          <button key={mode} type="button" data-testid={`variant-mode-${mode}`}
            aria-pressed={value.mode === mode} disabled={(hasSaved || structureLocked) && mode !== value.mode}
            onClick={() => selectMode(mode)}
            className={`min-h-14 rounded-xl border px-3 py-2 text-start text-sm font-bold transition disabled:cursor-not-allowed disabled:opacity-50 ${
              mode === value.mode ? "border-slate-900 bg-slate-900 text-white" : "border-slate-200 bg-white text-slate-700 hover:border-slate-500"
            }`}
          >{t(`products.variants.mode.${mode}`)}</button>
        ))}
      </div>
      {(hasSaved || structureLocked) && <p className="mt-2 text-xs font-semibold text-amber-800">{t(structureLocked ? "products.simple.retrySaved" : "products.simple.modeLocked")}</p>}

      {value.mode !== "none" ? (
        <div className="mt-5 space-y-5">
          {requiresModels && (
            <section data-testid="variant-model-list" className="space-y-3">
              <div className="rounded-xl border border-amber-200 bg-amber-50/70 px-3.5 py-2.5 text-xs font-semibold text-amber-900" data-testid="variant-shared-barcode-banner">
                {t("products.simple.sharedBarcodeBanner", { barcode: productBarcode.trim() || productSku.trim() || "—" })}
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2.5">
                  <h3 className="text-sm font-bold text-slate-900">{t("products.simple.models")}</h3>
                  <span
                    data-testid="variant-models-total-stock"
                    className="rounded-lg border border-emerald-200 bg-emerald-50 px-2.5 py-0.5 text-xs font-extrabold text-emerald-900"
                  >
                    {t("products.stockQuantity")}: {variantDraftTotal(value.rows)}
                  </span>
                </div>
                <Button size="sm" variant="secondary" type="button" data-testid="variant-add-model" disabled={structureLocked} onClick={addModelRow}>
                  + {t("products.simple.addModel")}
                </Button>
              </div>
              {value.rows.map((row, index) => (
                <div key={row.id} data-testid={`variant-model-${index}`} className="rounded-xl border border-slate-200 bg-slate-50/60 p-3">
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      {row.image_url ? (
                        <img src={row.image_url} alt={row.display_name_ar || row.display_name_en || ""} className="h-10 w-10 rounded-lg border border-slate-200 object-cover" />
                      ) : (
                        <div className="flex h-10 w-10 items-center justify-center rounded-lg border border-dashed border-slate-300 bg-white text-[11px] font-bold text-slate-400">
                          #{index + 1}
                        </div>
                      )}
                      <div>
                        <p className="text-xs font-bold text-slate-800">{t("products.simple.modelNumber", { count: index + 1 })}</p>
                        <p className="font-mono text-[11px] text-slate-500">{row.sku || "—"}</p>
                      </div>
                    </div>
                    {!row.persistedId && (
                      <button type="button" disabled={structureLocked} onClick={() => removeModelRow(row.id)} className="text-xs font-bold text-rose-700 hover:underline" data-testid={`variant-remove-model-${index}`}>
                        {t("products.simple.removeModel")}
                      </button>
                    )}
                  </div>
                  <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
                    <Field label={t("products.simple.modelNameAr")}>
                      <TextInput dir="rtl" disabled={structureLocked} value={row.display_name_ar ?? ""} onChange={(event) => updateRow(row.id, { display_name_ar: event.target.value })} placeholder={`شكل ${index + 1}`} data-testid={`variant-model-ar-${index}`} />
                    </Field>
                    <Field label={t("products.simple.modelNameEn")}>
                      <TextInput dir="ltr" disabled={structureLocked} value={row.display_name_en ?? ""} onChange={(event) => updateRow(row.id, { display_name_en: event.target.value })} placeholder={`Model ${index + 1}`} data-testid={`variant-model-en-${index}`} />
                    </Field>
                    <Field label={t("products.sku")}>
                      <TextInput dir="ltr" className="font-mono" disabled={structureLocked} value={row.sku} onChange={(event) => updateSku(row, event.target.value)} placeholder={`${productSku || "BR101"}-M0${index + 1}`} data-testid={`variant-model-sku-${index}`} />
                    </Field>
                    <Field label={t("products.variants.colStock")}>
                      <TextInput dir="ltr" inputMode="numeric" value={row.stock_quantity} readOnly={!stockEditable || Boolean(row.persistedId)} onChange={(event) => updateRow(row.id, { stock_quantity: event.target.value })} data-testid={`variant-model-stock-${index}`} />
                    </Field>
                    <Field label={t("products.simple.variantImage")}>
                      <div className="flex items-center gap-1.5">
                        <TextInput dir="ltr" type="url" className="flex-1 text-xs" placeholder={t("products.imageUrl")} value={row.image_url} onChange={(event) => updateRow(row.id, { image_url: event.target.value })} data-testid={`variant-model-image-${index}`} />
                        <label className="shrink-0 cursor-pointer rounded-lg border border-slate-200 bg-white px-2.5 py-2 text-xs font-semibold hover:bg-slate-100">
                          {uploading === row.id ? "…" : "↑"}
                          <input type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/avif,image/bmp" className="sr-only" disabled={structureLocked || uploading !== null} onChange={(event) => { void upload(event.target.files?.[0], row.id); event.target.value = ""; }} />
                        </label>
                      </div>
                    </Field>
                  </div>
                </div>
              ))}
            </section>
          )}
          {requiresColors && (
            <section data-testid="variant-color-list" className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-sm font-bold text-slate-900">{t("products.simple.colors")}</h3>
                <Button size="sm" variant="secondary" type="button" data-testid="variant-add-color" disabled={structureLocked} onClick={() =>
                  change({ ...value, colors: [...value.colors, { id: newColorId(), color_ar: "", color_en: "", color_hex: "", image_urls: [], image_url: "" }] })
                }>+ {t("products.simple.addColor")}</Button>
              </div>
              {value.colors.map((color, index) => (
                <div key={color.id} data-testid={`variant-color-${index}`} className="rounded-xl border border-slate-200 bg-slate-50/60 p-3">
                  <div className="mb-2 flex justify-between gap-2">
                    <p className="text-xs font-bold text-slate-800">{t("products.simple.colorNumber", { count: index + 1 })}</p>
                    <button type="button" disabled={structureLocked} onClick={() => removeColor(color.id)} className="text-xs font-bold text-rose-700 hover:underline" aria-label={`${t("products.simple.removeColor")} ${color.color_en || color.color_ar || index + 1}`}>
                      {t("products.simple.removeColor")}
                    </button>
                  </div>
                  <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                    <Field label={t("products.variants.colorAr")}><TextInput dir="rtl" disabled={structureLocked} value={color.color_ar} onChange={(event) => updateColorName(color,"color_ar",event.target.value)} placeholder="ذهبي" data-testid={`variant-color-ar-${index}`} /></Field>
                    <Field label={t("products.variants.colorEn")}><TextInput dir="ltr" disabled={structureLocked} value={color.color_en} onChange={(event) => updateColorName(color,"color_en",event.target.value)} placeholder="Gold" data-testid={`variant-color-en-${index}`} /></Field>
                    <Field label={t("products.variants.colorHex")}>
                      <div className="flex items-center gap-2">
                        <input type="color" data-testid={`variant-color-hex-${index}`} disabled={structureLocked} className="h-10 w-14 shrink-0 cursor-pointer rounded-md border border-slate-200 bg-white p-1" aria-label={`${t("products.variants.colorHex")} ${index + 1}`} value={/^#[0-9a-fA-F]{6}$/.test(color.color_hex) ? color.color_hex : "#64748b"} onChange={(event) => updateColor(color.id, { color_hex: event.target.value })} />
                        {color.color_hex ? <button type="button" disabled={structureLocked} className="text-xs font-semibold text-rose-700" onClick={()=>updateColor(color.id,{color_hex:""})}>Clear</button> : <span className="text-xs text-slate-500">Optional</span>}
                      </div>
                    </Field>
                    <Field label={t("products.simple.colorImage")}>
                      <div className="space-y-2">
                        <div className="flex flex-wrap gap-2">
                          {color.image_urls.map((url, imageIndex) => (
                            <div key={url} className={`relative rounded-lg border p-1 ${imageIndex===0 ? "border-slate-900" : "border-slate-200"}`}>
                              <img src={url} className="h-12 w-12 rounded-md object-cover" alt="" />
                              <button type="button" disabled={structureLocked} onClick={()=>makePrimary(color,url)} className="block w-full text-[9px] font-bold text-slate-700">{imageIndex===0 ? "Primary" : "Make primary"}</button>
                              {imageIndex > 0 ? (
                                <div className="flex justify-center gap-2 text-[10px] font-bold text-slate-600">
                                  <button type="button" disabled={structureLocked || imageIndex===1} onClick={()=>moveColorImage(color,url,-1)} aria-label={`Move image ${imageIndex + 1} earlier`}>←</button>
                                  <button type="button" disabled={structureLocked || imageIndex===color.image_urls.length-1} onClick={()=>moveColorImage(color,url,1)} aria-label={`Move image ${imageIndex + 1} later`}>→</button>
                                </div>
                              ) : null}
                              <button type="button" disabled={structureLocked} onClick={()=>removeColorImage(color,url)} className="block w-full text-[9px] text-rose-700">{t("products.simple.removeColor")}</button>
                            </div>
                          ))}
                        </div>
                        <label className="inline-block cursor-pointer rounded-lg border border-slate-200 bg-white px-2 py-2 text-xs font-semibold hover:bg-slate-100">
                          {uploading === color.id ? t("common.loading") : t("products.simple.uploadImage")}
                          <input type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/avif,image/bmp" className="sr-only" disabled={structureLocked || uploading !== null} onChange={(event) => { void upload(event.target.files?.[0], color.id, color.id); event.target.value = ""; }} />
                        </label>
                      </div>
                    </Field>
                  </div>
                </div>
              ))}
              {!value.colors.length && <p className="text-xs text-slate-600">{t("products.simple.addColorHint")}</p>}
            </section>
          )}

          {requiresSizes && (
            <section data-testid="variant-size-list" className="space-y-2">
              <h3 className="text-sm font-bold text-slate-900">{t("products.variants.sizesInput")}</h3>
              <div className="flex flex-wrap items-center gap-2">
                {value.sizes.map((size) => (
                  <span key={size} className="inline-flex min-h-10 items-center gap-2 rounded-full border border-slate-300 bg-white px-3 text-sm font-bold tabular-nums text-slate-900" data-testid={`variant-size-${size}`}>
                    {size}
                    <button type="button" disabled={structureLocked || value.sizes.indexOf(size)===0} onClick={() => moveSize(size,-1)} className="text-slate-500 disabled:opacity-30" aria-label={`Move ${size} earlier`}>←</button>
                    <button type="button" disabled={structureLocked || value.sizes.indexOf(size)===value.sizes.length-1} onClick={() => moveSize(size,1)} className="text-slate-500 disabled:opacity-30" aria-label={`Move ${size} later`}>→</button>
                    <button type="button" disabled={structureLocked} onClick={() => removeSize(size)} className="text-rose-700 hover:text-rose-900" aria-label={`${t("products.simple.removeSize")} ${size}`} title={t("products.simple.removeSize")}>×</button>
                  </span>
                ))}
              </div>
              <div className="flex max-w-md min-w-0 flex-wrap gap-2">
                <TextInput dir="ltr" className="min-w-32 flex-1" disabled={structureLocked} value={sizeEntry} onChange={(event) => setSizeEntry(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); addSizes(); } }} placeholder="XS, S, M, L · 28x30 · 3-4Y · One Size" aria-label={t("products.simple.quickSizes")} data-testid="variant-size-entry" />
                <Button type="button" variant="secondary" onClick={addSizes} disabled={structureLocked} data-testid="variant-add-sizes">+ {t("products.simple.addSizes")}</Button>
                <Button type="button" variant="ghost" onClick={sortSizesNaturally} disabled={structureLocked || value.sizes.length<2}>A→Z / 1→10</Button>
              </div>
              <p className="text-xs text-slate-600">{t("products.simple.quickSizesHint")}</p>
            </section>
          )}

          <section>
            <h3 className="text-sm font-bold text-slate-900">{t("products.simple.combinations", { count: displayed.length })}</h3>
            <p className="mb-2 text-xs text-slate-600">{editing ? t("products.simple.editStockHint") : t("products.simple.autoHint")}</p>
            {displayed.length > 0 && (
              <div className="mb-3 flex flex-wrap items-end gap-2 rounded-xl bg-slate-50 p-3 text-xs">
                <Field label={t("products.simple.bulkStock")}><TextInput dir="ltr" inputMode="numeric" className="w-24" value={bulkStock} onChange={(event) => setBulkStock(event.target.value)} data-testid="variant-bulk-stock" /></Field>
                <Button size="sm" variant="secondary" type="button" onClick={() => bulk("stock_quantity", bulkStock)} disabled={!stockEditable || targets.length === 0} data-testid="variant-bulk-stock-apply">{t("products.simple.setAll")}</Button>
                <Field label={t("products.simple.bulkLow")}><TextInput dir="ltr" inputMode="numeric" className="w-24" value={bulkLow} onChange={(event) => setBulkLow(event.target.value)} data-testid="variant-bulk-low" /></Field>
                <Button size="sm" variant="secondary" type="button" onClick={() => bulk("low_stock_level", bulkLow)} disabled={targets.length === 0} data-testid="variant-bulk-low-apply">{t("products.simple.setAll")}</Button>
                <Button size="sm" variant="ghost" type="button" onClick={generateMissingSku}>{t("products.simple.generateMissingSku")}</Button>
                <Button size="sm" variant="ghost" type="button" disabled={!targets.length} onClick={() => onChange({ ...value, rows: value.rows.map((row) => row.persistedId ? row : { ...row, active: true }) })}>{t("products.simple.activateNew")}</Button>
              </div>
            )}
            <div className="max-w-full overflow-x-auto rounded-xl border border-slate-200 max-md:border-0 max-md:overflow-visible" data-testid="variant-table-scroll">
              <table className="w-full text-xs max-md:block md:table md:min-w-[880px]" data-testid="product-variant-table">
                <thead className="bg-slate-50 text-start text-[11px] font-bold text-slate-600 max-md:hidden"><tr className="border-b border-slate-200">
                  <th className="p-2 text-start">{t("products.variants.colCombination")}</th>
                  <th className="p-2 text-start">{t("products.sku")}</th>
                  <th className="p-2 text-start">{t("products.barcode")}</th>
                  <th className="p-2 text-start">{t("products.variants.colStock")}</th>
                  <th className="p-2 text-start">{t("products.variants.lowStock")}</th>
                  <th className="p-2 text-start">{t("products.variants.colPrice")}</th>
                  {canAct("view_cost") && <th className="p-2 text-start">{t("products.variants.colCost")}</th>}
                  <th className="p-2 text-start">{t("products.simple.variantImage")}</th>
                  <th className="p-2 text-center">{t("common.active")}</th>
                </tr></thead>
                <tbody className="max-md:block max-md:space-y-3">{displayed.map((row) => {
                  const color = value.colors.find((entry) => entry.id === row.color_id);
                  const archived = row.persistedId && !row.active;
                  const stockReadOnly = !stockEditable || Boolean(row.persistedId);
                  return <tr key={row.id} data-testid={`product-variant-${row.id}`} className={`border-b border-slate-100 last:border-0 max-md:grid max-md:grid-cols-2 max-md:gap-2.5 max-md:rounded-xl max-md:border max-md:border-slate-200 max-md:bg-slate-50/40 max-md:p-3 ${archived ? "bg-slate-50 text-slate-500" : ""}`}>
                    <td className="p-2 font-bold md:min-w-28 max-md:col-span-2 max-md:flex max-md:items-center max-md:justify-between max-md:border-b max-md:border-slate-200/80 max-md:p-0 max-md:pb-2">
                      <span className="flex items-center gap-1.5 text-sm md:text-xs text-slate-900">
                        {row.color_hex ? <span aria-hidden className="inline-block h-3.5 w-3.5 shrink-0 rounded-full border border-slate-300" style={{ backgroundColor: row.color_hex }} /> : null}
                        {variantLabel({ color_ar: row.color_ar, color_en: row.color_en, size: null, size_label: row.size, size_value: row.size, display_name_ar: row.display_name_ar, display_name_en: row.display_name_en }, lang) || "—"}
                      </span>
                      <span className="rounded-md bg-white px-2 py-0.5 font-mono text-[11px] font-semibold text-slate-600 ring-1 ring-slate-200 md:hidden">
                        {row.sku || "—"}
                      </span>
                    </td>
                    <td className="p-2 max-md:col-span-2 max-md:p-0">
                      <span className="mb-1 block text-[11px] font-bold text-slate-600 md:hidden">{t("products.sku")}</span>
                      <div className="flex items-center gap-1.5">
                        <TextInput dir="ltr" className="w-full font-mono text-xs md:w-32" value={row.sku} onChange={(event) => updateSku(row, event.target.value)} aria-label={`${t("products.sku")} ${row.id}`} data-testid={`variant-field-sku-${row.id}`} />
                        {row.sku.trim() ? (
                          <button type="button" onClick={() => copyCode(row.sku)} className="shrink-0 rounded-lg border border-slate-200 bg-white px-2 py-2 text-[11px] font-bold text-slate-700 hover:bg-slate-100 md:px-1.5 md:py-1" title={t("products.simple.copyCode")} data-testid={`variant-copy-sku-${row.id}`}>
                            {t("products.simple.copyCode")}
                          </button>
                        ) : null}
                      </div>
                    </td>
                    <td className="p-2 max-md:col-span-2 max-md:p-0">
                      <span className="mb-1 block text-[11px] font-bold text-slate-600 md:hidden">{t("products.barcode")}</span>
                      <div className="flex items-center gap-1.5">
                        <TextInput dir="ltr" className="w-full font-mono text-xs md:w-32" placeholder={requiresModels ? (productBarcode.trim() || productSku.trim() || undefined) : undefined} value={row.barcode} onChange={(event) => updateRow(row.id, { barcode: event.target.value })} aria-label={`${t("products.barcode")} ${row.id}`} data-testid={`variant-field-barcode-${row.id}`} />
                        {(row.barcode.trim() || (requiresModels && (productBarcode.trim() || productSku.trim()))) ? (
                          <button type="button" onClick={() => copyCode(row.barcode.trim() || productBarcode.trim() || productSku.trim())} className="shrink-0 rounded-lg border border-slate-200 bg-white px-2 py-2 text-[11px] font-bold text-slate-700 hover:bg-slate-100 md:px-1.5 md:py-1" title={t("products.simple.copyCode")} data-testid={`variant-copy-barcode-${row.id}`}>
                            {t("products.simple.copyCode")}
                          </button>
                        ) : null}
                      </div>
                    </td>
                    <td className="p-2 max-md:col-span-1 max-md:p-0">
                      <span className="mb-1 block text-[11px] font-bold text-slate-600 md:hidden">{t("products.variants.colStock")}</span>
                      <div className="flex items-center gap-1">
                        {!stockReadOnly ? (
                          <button type="button" onClick={() => stepQuantity(row, "stock_quantity", -1)} className="flex h-9 w-8 shrink-0 items-center justify-center rounded-lg border border-slate-200 bg-white text-sm font-bold text-slate-700 active:bg-slate-100 md:hidden" aria-label={`Decrease stock ${row.id}`}>−</button>
                        ) : null}
                        <TextInput dir="ltr" inputMode="numeric" className="w-full text-center text-xs md:w-16" value={row.stock_quantity} readOnly={stockReadOnly} onChange={(event) => updateRow(row.id, { stock_quantity: event.target.value })} aria-label={`${t("products.variants.colStock")} ${row.id}`} data-testid={`variant-field-stock-${row.id}`} />
                        {!stockReadOnly ? (
                          <button type="button" onClick={() => stepQuantity(row, "stock_quantity", 1)} className="flex h-9 w-8 shrink-0 items-center justify-center rounded-lg border border-slate-200 bg-white text-sm font-bold text-slate-700 active:bg-slate-100 md:hidden" aria-label={`Increase stock ${row.id}`}>+</button>
                        ) : null}
                      </div>
                    </td>
                    <td className="p-2 max-md:col-span-1 max-md:p-0">
                      <span className="mb-1 block text-[11px] font-bold text-slate-600 md:hidden">{t("products.variants.lowStock")}</span>
                      <div className="flex items-center gap-1">
                        <button type="button" onClick={() => stepQuantity(row, "low_stock_level", -1)} className="flex h-9 w-8 shrink-0 items-center justify-center rounded-lg border border-slate-200 bg-white text-sm font-bold text-slate-700 active:bg-slate-100 md:hidden" aria-label={`Decrease low stock ${row.id}`}>−</button>
                        <TextInput dir="ltr" inputMode="numeric" className="w-full text-center text-xs md:w-16" value={row.low_stock_level} onChange={(event) => updateRow(row.id, { low_stock_level: event.target.value })} aria-label={`${t("products.variants.lowStock")} ${row.id}`} data-testid={`variant-field-low-${row.id}`} />
                        <button type="button" onClick={() => stepQuantity(row, "low_stock_level", 1)} className="flex h-9 w-8 shrink-0 items-center justify-center rounded-lg border border-slate-200 bg-white text-sm font-bold text-slate-700 active:bg-slate-100 md:hidden" aria-label={`Increase low stock ${row.id}`}>+</button>
                      </div>
                    </td>
                    <td className="p-2 max-md:col-span-1 max-md:p-0">
                      <span className="mb-1 block text-[11px] font-bold text-slate-600 md:hidden">{t("products.variants.colPrice")}</span>
                      <TextInput dir="ltr" inputMode="decimal" className="w-full text-xs md:w-20" placeholder={productSellingPrice} readOnly={requiresModels} value={row.price_override} onChange={(event) => updateRow(row.id, { price_override: event.target.value })} aria-label={`${t("products.variants.colPrice")} ${row.id}`} data-testid={`variant-field-price-${row.id}`} />
                    </td>
                    {canAct("view_cost") && <td className="p-2 max-md:col-span-1 max-md:p-0">
                      <span className="mb-1 block text-[11px] font-bold text-slate-600 md:hidden">{t("products.variants.colCost")}</span>
                      <TextInput dir="ltr" inputMode="decimal" className="w-full text-xs md:w-20" readOnly={!canAct("change_cost")} placeholder={productCostPrice} value={row.cost_override} onChange={(event) => updateRow(row.id, { cost_override: event.target.value })} aria-label={`${t("products.variants.colCost")} ${row.id}`} data-testid={`variant-field-cost-${row.id}`} />
                    </td>}
                    <td className="p-2 max-md:col-span-2 max-md:p-0">
                      <span className="mb-1 block text-[11px] font-bold text-slate-600 md:hidden">{t("products.simple.variantImage")}</span>
                      <div className="flex items-center gap-1.5"><TextInput dir="ltr" type="url" className="w-full text-xs md:w-28" placeholder={color?.image_url ? t("products.simple.inheritsColor") : t("products.imageUrl")} value={row.image_url} onChange={(event) => updateRow(row.id, { image_url: event.target.value })} aria-label={`${t("products.simple.variantImage")} ${row.id}`} data-testid={`variant-field-image-${row.id}`} />
                        <label className="shrink-0 cursor-pointer rounded-lg border border-slate-200 bg-white px-2.5 py-2 text-xs font-semibold hover:bg-slate-100" title={t("products.simple.uploadImage")}>↑<input type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/avif,image/bmp" className="sr-only" disabled={uploading !== null} onChange={(event) => { void upload(event.target.files?.[0], row.id); event.target.value = ""; }} /></label>
                      </div>
                    </td>
                    <td className="p-2 text-center max-md:col-span-2 max-md:flex max-md:items-center max-md:justify-between max-md:border-t max-md:border-slate-200/80 max-md:p-0 max-md:pt-2">
                      <span className="text-xs font-bold text-slate-700 md:hidden">{t("common.active")}</span>
                      <input type="checkbox" className="h-4 w-4" aria-label={`${t("common.active")} ${row.id}`} checked={row.active} disabled={Boolean(row.persistedId)} onChange={(event) => updateRow(row.id, { active: event.target.checked })} title={row.persistedId ? t("products.simple.archiveOption") : undefined} />
                    </td>
                  </tr>;
                })}
                {!displayed.length && <tr><td colSpan={9} className="p-6 text-center text-xs text-slate-600">{t("products.simple.waiting")}</td></tr>}
                </tbody>
              </table>
            </div>
            <p className="mt-3 text-xs font-semibold text-slate-700" data-testid="variant-derived-stock">{t("products.variants.countBadge", { count: displayed.length, units: num(variantDraftTotal(displayed), 0) })}</p>
            {error && <p role="alert" className="mt-2 text-xs font-semibold text-rose-700">{t(`products.simple.${error}` as never)}</p>}
          </section>
        </div>
      ) : <p className="mt-3 rounded-lg bg-slate-50 px-3 py-2 text-xs font-semibold text-slate-600">{t("products.variants.mode.noneHint")}</p>}
    </Card>
  );
}
