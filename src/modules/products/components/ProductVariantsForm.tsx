import { useMemo } from "react";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { Button, Card, Field, SectionTitle, SelectInput, TextArea, TextInput, ToggleSwitch } from "@/components/ui";
import {
  formatSizes,
  generateCombinations,
  parseSizes,
  sizeLabelOf,
  suggestVariantSku,
  variantLabel,
  type VariantColorDraft,
} from "../variants";

export type ProductVariantMode = "none" | "colors" | "sizes" | "colors_sizes";

export interface ProductVariantDraft {
  id: string;
  color_ar: string;
  color_en: string;
  color_hex: string;
  size: string;
  size_label: string;
  sku: string;
  barcode: string;
  stock_quantity: string;
  low_stock_level: string;
  price_override: string;
  cost_override: string;
  image_url: string;
  active: boolean;
}

export interface ProductVariantFormValue {
  mode: ProductVariantMode;
  colorsText: string;
  sizesText: string;
  rows: ProductVariantDraft[];
}

export const EMPTY_PRODUCT_VARIANT_FORM: ProductVariantFormValue = {
  mode: "none",
  colorsText: "",
  sizesText: "",
  rows: [],
};

interface Props {
  value: ProductVariantFormValue;
  productSku: string;
  productSellingPrice: string;
  productCostPrice: string;
  onChange: (value: ProductVariantFormValue) => void;
}

function parseColors(input: string): { colors: VariantColorDraft[]; imageByKey: Map<string, string> } {
  const imageByKey = new Map<string, string>();
  const colors = input
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [en = "", ar = "", hex = "", image = ""] = line.split("|").map((part) => part.trim());
      const color: VariantColorDraft = {
        color_en: en || null,
        color_ar: ar || null,
        color_hex: /^#[0-9a-fA-F]{6}$/.test(hex) ? hex.toLowerCase() : null,
      };
      const key = (color.color_en || color.color_ar || "").trim().replace(/\s+/g, " ").toLowerCase();
      if (key && image) imageByKey.set(key, image);
      return color;
    })
    .filter((color) => Boolean(color.color_en || color.color_ar));
  return { colors, imageByKey };
}

function combinationKey(row: Pick<ProductVariantDraft, "color_en" | "color_ar" | "size" | "size_label">): string {
  const color = (row.color_en || row.color_ar).trim().replace(/\s+/g, " ").toLowerCase();
  const size = row.size.trim() !== "" ? Number(row.size.replace(",", ".")) : `label:${row.size_label.trim()}`;
  return `${color}|${size}`;
}

function blankRow(
  productSku: string,
  combination: { color: VariantColorDraft | null; size: number | null; size_label: string | null },
  taken: string[],
  imageUrl = "",
): ProductVariantDraft {
  const colorEn = combination.color?.color_en ?? "";
  const colorAr = combination.color?.color_ar ?? "";
  return {
    id: `${combination.color ? (colorEn || colorAr).trim().toLowerCase() : "size"}|${combination.size ?? combination.size_label ?? ""}`,
    color_ar: colorAr,
    color_en: colorEn,
    color_hex: combination.color?.color_hex ?? "",
    size: combination.size === null ? "" : sizeLabelOf(combination.size, null),
    size_label: combination.size_label ?? "",
    sku: suggestVariantSku(productSku, combination.color, combination.size, combination.size_label, taken),
    barcode: "",
    stock_quantity: "0",
    low_stock_level: "0",
    price_override: "",
    cost_override: "",
    image_url: imageUrl,
    active: true,
  };
}

export function ProductVariantsForm({
  value,
  productSku,
  productSellingPrice,
  productCostPrice,
  onChange,
}: Props) {
  const { t, num } = useI18n();
  const parsed = useMemo(() => parseColors(value.colorsText), [value.colorsText]);
  const sizes = useMemo(() => parseSizes(value.sizesText), [value.sizesText]);
  const total = useMemo(
    () => value.rows.reduce((sum, row) => sum + Math.max(0, Math.trunc(Number(row.stock_quantity) || 0)), 0),
    [value.rows],
  );

  const set = (patch: Partial<ProductVariantFormValue>) => onChange({ ...value, ...patch });

  const generate = () => {
    const combinations = generateCombinations(
      value.mode === "sizes" ? [] : parsed.colors,
      value.mode === "colors" ? [] : sizes,
    );
    const existing = new Map(value.rows.map((row) => [combinationKey(row), row]));
    const taken = value.rows.map((row) => row.sku);
    const rows = combinations.map((combination) => {
      const candidate = blankRow(
        productSku,
        combination,
        taken,
        combination.color ? parsed.imageByKey.get((combination.color.color_en || combination.color.color_ar || "").toLowerCase()) ?? "" : "",
      );
      return existing.get(combinationKey(candidate)) ?? candidate;
    });
    set({ rows });
  };

  const updateRow = (id: string, patch: Partial<ProductVariantDraft>) =>
    set({ rows: value.rows.map((row) => (row.id === id ? { ...row, ...patch } : row)) });

  const modeRequiresColors = value.mode === "colors" || value.mode === "colors_sizes";
  const modeRequiresSizes = value.mode === "sizes" || value.mode === "colors_sizes";

  return (
    <Card data-testid="product-variants-form">
      <SectionTitle>{t("products.variants.title")}</SectionTitle>
      <p className="mb-3 text-xs font-medium text-slate-600">{t("products.variants.subtitle")}</p>
      <Field label={t("products.variants.mode.label")}>
        <SelectInput
          value={value.mode}
          onChange={(event) => {
            const mode = event.target.value as ProductVariantMode;
            set({ mode, rows: mode === "none" ? [] : value.rows });
          }}
          data-testid="variant-mode"
        >
          <option value="none">{t("products.variants.mode.none")}</option>
          <option value="colors">{t("products.variants.mode.colors")}</option>
          <option value="sizes">{t("products.variants.mode.sizes")}</option>
          <option value="colors_sizes">{t("products.variants.mode.colors_sizes")}</option>
        </SelectInput>
      </Field>

      {value.mode !== "none" ? (
        <>
          <div className="mt-3 grid gap-3 md:grid-cols-2">
            {modeRequiresColors ? (
              <Field
                label={t("products.variants.colorsInput")}
                hint="English | العربية | #hex | image URL"
                className={modeRequiresSizes ? "md:col-span-2" : undefined}
              >
                <TextArea
                  rows={4}
                  value={value.colorsText}
                  onChange={(event) => set({ colorsText: event.target.value })}
                  placeholder="Gold | ذهبي | #D4AF37 | https://…\nSilver | فضي | #C0C0C0"
                  data-testid="variant-colors"
                />
              </Field>
            ) : null}
            {modeRequiresSizes ? (
              <Field label={t("products.variants.sizesInput")} hint={t("products.variants.sizesHint")}>
                <TextInput
                  dir="ltr"
                  value={value.sizesText}
                  onChange={(event) => set({ sizesText: event.target.value })}
                  placeholder="17, 18"
                  data-testid="variant-sizes"
                />
              </Field>
            ) : null}
            <div className="flex items-end gap-2">
              <Button type="button" onClick={generate} data-testid="variant-generate">
                {t("products.variants.generate")}
              </Button>
              <span className="pb-2 text-xs font-semibold text-slate-600">
                {value.rows.length} · {sizes.length ? formatSizes(sizes) : t("products.variants.mode.colorsHint")}
              </span>
            </div>
          </div>

          <div className="mt-4 overflow-x-auto rounded-xl border border-slate-200">
            <table className="min-w-[1180px] w-full text-xs" data-testid="product-variant-table">
              <thead>
                <tr className="border-b border-slate-100 bg-slate-50 text-start text-[10px] font-bold uppercase tracking-wider text-slate-500">
                  <th className="px-2 py-2 text-start">{t("products.variants.colCombination")}</th>
                  <th className="px-2 py-2 text-start">{t("products.sku")}</th>
                  <th className="px-2 py-2 text-start">{t("products.barcode")}</th>
                  <th className="px-2 py-2 text-end">{t("products.variants.colStock")}</th>
                  <th className="px-2 py-2 text-end">{t("products.variants.lowStock")}</th>
                  <th className="px-2 py-2 text-end">{t("products.variants.colPrice")}</th>
                  <th className="px-2 py-2 text-end">{t("products.variants.colCost")}</th>
                  <th className="px-2 py-2 text-start">{t("products.imageUrl")}</th>
                  <th className="px-2 py-2 text-center">{t("common.active")}</th>
                </tr>
              </thead>
              <tbody>
                {value.rows.map((row) => (
                  <tr key={row.id} className="border-b border-slate-50 last:border-0" data-testid={`product-variant-${row.id}`}>
                    <td className="whitespace-nowrap px-2 py-2 font-bold">
                      {variantLabel({ color_en: row.color_en || null, color_ar: row.color_ar || null, size: row.size ? Number(row.size.replace(",", ".")) : null, size_label: row.size_label || null })}
                    </td>
                    <td className="px-2 py-2"><TextInput className="w-32 font-mono" value={row.sku} onChange={(e) => updateRow(row.id, { sku: e.target.value })} /></td>
                    <td className="px-2 py-2"><TextInput className="w-32 font-mono" value={row.barcode} onChange={(e) => updateRow(row.id, { barcode: e.target.value })} /></td>
                    <td className="px-2 py-2"><TextInput className="w-20" dir="ltr" inputMode="numeric" value={row.stock_quantity} onChange={(e) => updateRow(row.id, { stock_quantity: e.target.value })} /></td>
                    <td className="px-2 py-2"><TextInput className="w-20" dir="ltr" inputMode="numeric" value={row.low_stock_level} onChange={(e) => updateRow(row.id, { low_stock_level: e.target.value })} /></td>
                    <td className="px-2 py-2"><TextInput className="w-24" dir="ltr" inputMode="decimal" placeholder={productSellingPrice} value={row.price_override} onChange={(e) => updateRow(row.id, { price_override: e.target.value })} /></td>
                    <td className="px-2 py-2"><TextInput className="w-24" dir="ltr" inputMode="decimal" placeholder={productCostPrice} value={row.cost_override} onChange={(e) => updateRow(row.id, { cost_override: e.target.value })} /></td>
                    <td className="px-2 py-2"><TextInput className="w-44" dir="ltr" type="url" placeholder={t("products.imageUrl")} value={row.image_url} onChange={(e) => updateRow(row.id, { image_url: e.target.value })} /></td>
                    <td className="px-2 py-2 text-center"><ToggleSwitch label="" checked={row.active} onChange={(active) => updateRow(row.id, { active })} /></td>
                  </tr>
                ))}
                {value.rows.length === 0 ? (
                  <tr><td colSpan={9} className="px-3 py-5 text-center text-xs text-slate-500">{t("products.variants.emptyEnabled")}</td></tr>
                ) : null}
              </tbody>
            </table>
          </div>
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-lg bg-indigo-50 px-3 py-2 text-xs font-semibold text-indigo-900">
            <span>{t("products.variants.countBadge", { count: value.rows.length, units: num(total, 0) })}</span>
            <span>{t("products.variants.enableHint")}</span>
          </div>
        </>
      ) : (
        <p className="mt-3 rounded-lg bg-slate-50 px-3 py-2 text-xs font-semibold text-slate-600">{t("products.variants.mode.noneHint")}</p>
      )}
    </Card>
  );
}
