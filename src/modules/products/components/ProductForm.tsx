import { useCallback, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { useToast } from "@/components/ui";
import { Button, Field, SelectInput, TextArea, TextInput, ToggleSwitch } from "@/components/ui";
import { Card, SectionTitle, StatTile } from "@/components/ui";
import {
  MAX_BARCODE_LENGTH,
  MAX_NAME_LENGTH,
  MAX_SKU_LENGTH,
  MAX_TEXT_LENGTH,
  PRODUCT_TYPE_META,
  STOCK_DEFAULT_BY_TYPE,
} from "../constants";
import { PRODUCT_TYPES, marginPct, stockStatus, suggestSku, type Product, type ProductType } from "../types";
import { colorKeyOf, variantSizeValue, type ProductVariant } from "../variants";
import {
  EMPTY_PRODUCT_FORM,
  fieldErrorKey,
  productToForm,
  validateProductDraft,
  type FieldErrors,
  type ProductFormValues,
} from "../validation";
import { ApprovalRequestDialog, isApprovalRequired, type ApprovalRequirement } from "@/modules/approvals";
import { canAct } from "@/lib/permissions/enforce";
import { useCatalog } from "../hooks/CatalogProvider";
import { toCategoryOptions } from "../services/categoryTree";
import { describeError } from "../services/catalogService";
import { ProductImagesEditor } from "./ProductImagesEditor";
import { BarcodePreview } from "./BarcodePreview";
import { deriveBarcodeFromSku, isDerivedFromSku } from "../services/barcode";
import { buildBarcodeLabelHtml } from "../services/barcodeLabel";
import { StockBadge } from "./ProductTable";
import { ProductVariantsForm, EMPTY_PRODUCT_VARIANT_FORM, type ProductVariantFormValue } from "./ProductVariantsForm";
import { validateVariantDraft, variantDraftTotal } from "../services/variantDraft";
import { enableVariants, listVariants, replaceColorImages, saveVariant } from "../services/variantService";

export function ProductForm({ productId }: { productId?: string }) {
  const { t, pick, money, num, isRTL } = useI18n();
  const toast = useToast();
  const navigate = useNavigate();
  const { products, categories, tree, loading, saveProduct, refresh } = useCatalog();

  const existing = useMemo(
    () => (productId ? products.find((p) => p.id === productId) : undefined),
    [productId, products],
  );

  const [values, setValues] = useState<ProductFormValues>(() => {
    const base = existing ? productToForm(existing) : EMPTY_PRODUCT_FORM;
    // Phase 17: a seat that may not see cost price still submits a value for it,
    // because the record has one and the form validates it. Hidden means
    // unchanged, never zeroed — an edit carries the product's own cost through
    // (so `priceChanges` sees no move and asks for no authority), and a new
    // product starts at zero rather than failing a field nobody can fill in.
    return canAct("view_cost") || base.cost_price.trim() ? base : { ...base, cost_price: "0" };
  });
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [submitAttempted, setSubmitAttempted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [printCopies, setPrintCopies] = useState("1");
  const [labelOptions, setLabelOptions] = useState({ name: true, color: true, size: true, sku: true, price: true, number: true });

  // Variant setup is part of the initial product draft. The edit page reuses
  // these same controls, with saved stock guarded by the inventory ledger.
  const [variantConfig, setVariantConfig] = useState<ProductVariantFormValue>(EMPTY_PRODUCT_VARIANT_FORM);
  // Create + combinations + opening stock spans several requests. Once a
  // product exists, a retry must RESUME it, not try to create the same SKU
  // again. The map also survives a response lost after a variant insert.
  const variantBootstrap = useRef<{
    product: Product; productDraft: string; ids: Map<string, string>;
  } | null>(null);
  const [bootstrapPending, setBootstrapPending] = useState(false);
  /**
   * `auto` keeps the barcode mirrored from the SKU; `manual` means the admin
   * entered a manufacturer barcode which must survive later SKU edits.
   */
  const [barcodeMode, setBarcodeMode] = useState<"auto" | "manual">(() => {
    if (!existing || !existing.barcode) return "auto";
    return isDerivedFromSku(existing.sku, existing.barcode) ? "auto" : "manual";
  });
  const barcodeModeRef = useRef(barcodeMode);
  barcodeModeRef.current = barcodeMode;

  // Keep the form in sync when the record finishes loading (deep-link to edit).
  const [hydratedId, setHydratedId] = useState<string | undefined>(existing?.id);
  if (productId && existing && hydratedId !== productId) {
    setHydratedId(productId);
    setValues(productToForm(existing));
    setBarcodeMode(
      !existing.barcode || isDerivedFromSku(existing.sku, existing.barcode) ? "auto" : "manual",
    );
  }

  // Revalidate against the just-created product ID after a partial save. Its
  // own SKU is not a duplicate when the employee retries the remaining rows.
  const activeId = productId ?? (bootstrapPending ? variantBootstrap.current?.product.id : undefined);
  const draft = useMemo(
    () => validateProductDraft(values, { products, categories, currentId: activeId }),
    [values, products, categories, activeId],
  );
  const errors: FieldErrors = draft.errors;

  const showError = useCallback(
    (field: string) => (touched[field] || submitAttempted ? errors[field] : undefined),
    [touched, submitAttempted, errors],
  );

  const set = useCallback(
    <K extends keyof ProductFormValues>(key: K, value: ProductFormValues[K]) => {
      setValues((prev) => {
        const next = { ...prev, [key]: value } as ProductFormValues;
        // Automatic barcode generation: while the barcode is in "auto" mode,
        // every SKU keystroke regenerates it so the preview stays live.
        if (key === "sku" && barcodeModeRef.current === "auto") {
          next.barcode = deriveBarcodeFromSku(String(value));
        }
        return next;
      });
    },
    [],
  );

  /** Force-regenerate the barcode from the current SKU and lock back to auto. */
  const generateBarcode = useCallback(() => {
    const derived = deriveBarcodeFromSku(values.sku);
    if (!derived) {
      toast.error(t("barcode.needsSku"));
      return;
    }
    setBarcodeMode("auto");
    setValues((prev) => ({ ...prev, barcode: derived }));
    setTouched((prev) => ({ ...prev, barcode: true }));
  }, [values.sku, t, toast]);

  /** Open a print-ready label sheet in a popup window. */
  const printBarcode = useCallback(() => {
    const barcodeValue = values.barcode.trim();
    if (!barcodeValue) {
      toast.error(t("barcode.needsValue"));
      return;
    }
    const copies = Math.max(1, Math.min(Number(printCopies) || 1, 40));
    const html = buildBarcodeLabelHtml(
      {
        nameAr: values.name_ar,
        nameEn: values.name_en,
        sku: values.sku,
        barcode: barcodeValue,
        price: money(Number(values.selling_price.replace(/,/g, ".")) || 0),
        copies,
        showName: labelOptions.name, showColor: labelOptions.color, showSize: labelOptions.size,
        showSku: labelOptions.sku, showPrice: labelOptions.price, showNumber: labelOptions.number,
        direction: isRTL ? "rtl" : "ltr",
      },
      {
        documentTitle: t("barcode.printTitle"),
        skuLabel: t("products.sku"),
        priceLabel: t("products.sellingPrice"),
        printAction: t("barcode.print"),
        unsupported: t("barcode.unsupported"),
      },
    );
    const win = window.open("", "_blank", "width=720,height=640");
    if (!win) {
      toast.error(t("barcode.printBlocked"));
      return;
    }
    win.document.open();
    win.document.write(html);
    win.document.close();
  }, [values, printCopies, labelOptions, money, t, toast, isRTL]);

  // Phase 44: archived categories are not offered. A product already sitting
  // in an archived category keeps its label visible (so an edit can be saved
  // without a forced move) — but new assignments go to active shelves only.
  // The server refuses an archived assignment regardless of what the picker
  // allowed.
  const categoryOptions = useMemo(() => {
    const options = toCategoryOptions(tree, pick);
    const current = values.category_id;
    if (
      current &&
      !options.some((option) => option.id === current) &&
      categories.some((c) => c.id === current)
    ) {
      const archived = categories.find((c) => c.id === current)!;
      return [
        ...options,
        {
          id: archived.id,
          label: `${pick(archived.name_ar, archived.name_en)} (${t("categories.archivedBadge")})`,
          depth: 0,
          active: false,
          productCount: 0,
        },
      ];
    }
    return options;
  }, [tree, pick, categories, values.category_id, t]);

  // Cost is two capabilities, not one: seeing the number and writing it. A seat
  // that may see but not write gets a read-only field that says why; a seat that
  // may do neither gets no field at all.
  const maySeeCost = canAct("view_cost");
  const mayChangeCost = canAct("change_cost");

  const selling = Number(values.selling_price.replace(/,/g, ".")) || 0;
  const cost = Number(values.cost_price.replace(/,/g, ".")) || 0;
  const profit = selling - cost;
  const margin = marginPct(selling, cost);

  const isEdit = Boolean(productId);
  const variantTotal = variantDraftTotal(variantConfig.rows);
  const hasNewVariants = !isEdit && variantConfig.mode !== "none";
  const variantStockIsDerived = hasNewVariants || Boolean(existing?.variants_enabled);
  const shownStock = hasNewVariants ? variantTotal : Number(values.stock_quantity.replace(/,/g, ".")) || 0;
  const liveStatus = stockStatus({
    stock_tracking_enabled: values.stock_tracking_enabled,
    stock_quantity: shownStock,
    low_stock_level: Number(values.low_stock_level.replace(/,/g, ".")) || 0,
  });
  const variantError = hasNewVariants ? validateVariantDraft(variantConfig, values.sku, values.barcode) : null;
  const dirty = useMemo(() => {
    const baseline = existing ? productToForm(existing) : EMPTY_PRODUCT_FORM;
    return JSON.stringify(baseline) !== JSON.stringify(values);
  }, [existing, values]);

  const handleTypeChange = (type: ProductType) => {
    setValues((prev) => ({
      ...prev,
      product_type: type,
      stock_tracking_enabled: STOCK_DEFAULT_BY_TYPE[type],
    }));
  };

  const handleBlur = (field: string) => () => setTouched((prev) => ({ ...prev, [field]: true }));

  const changeVariantConfig = (next: ProductVariantFormValue) => {
    setVariantConfig(next);
    if (next.mode !== "none") {
      setValues((previous) => ({
        ...previous, stock_quantity: String(variantDraftTotal(next.rows)), stock_tracking_enabled: true,
      }));
    }
  };

  const saveDraftAndVariants = async () => {
    if (variantError) {
      throw new Error(t(`products.simple.${variantError}` as never));
    }
    const productValues = hasNewVariants
      ? { ...values, stock_quantity: String(variantTotal), stock_tracking_enabled: true }
      : values;
    if (hasNewVariants && (!canAct("edit_product") ||
        (variantTotal > 0 && !canAct("adjust_stock")))) {
      throw new Error(t("products.simple.enableRights"));
    }
    const bootstrap = variantBootstrap.current;
    if (bootstrap && (!hasNewVariants || JSON.stringify(productValues) !== bootstrap.productDraft)) {
      throw new Error(t("products.simple.retryLocked"));
    }
    const result = bootstrap
      ? { product: bootstrap.product, isNew: true }
      : await saveProduct(productValues, productId);
    if (!hasNewVariants || !result.isNew) return result;
    if (!variantBootstrap.current) {
      variantBootstrap.current = {
        product: result.product, productDraft: JSON.stringify(productValues), ids: new Map(),
      };
      setBootstrapPending(true);
    }
    const resume = variantBootstrap.current;
    // Re-read each time. A response may have timed out AFTER an insert landed;
    // the exact colour+size (or the ID from an earlier successful response)
    // identifies that shelf without ever creating a duplicate on retry.
    const created: ProductVariant[] = (await listVariants()).filter((variant) => variant.product_id === result.product.id);
    const ordered: ProductVariant[] = [];
    for (const row of variantConfig.rows) {
      const sizeValue = row.size.trim() || null;
      const numericSize = sizeValue && /^[0-9]+(?:\.[0-9]{1,2})?$/.test(sizeValue)
        ? Number(sizeValue) : null;
      const colorKey = row.color_key || colorKeyOf(row);
      const previous = created.find((variant) => variant.id === resume.ids.get(row.id)) ?? created.find(
        (variant) => variant.color_key === colorKey &&
          variantSizeValue(variant).toLocaleLowerCase() === (sizeValue ?? "").toLocaleLowerCase(),
      );
      const rowValues = {
        sku: row.sku, barcode: row.barcode.trim() || null,
        color_key: previous?.color_key ?? colorKey,
        color_ar: row.color_ar.trim() || null,
        color_en: row.color_en.trim() || null,
        color_hex: row.color_hex.trim() || null,
        size: numericSize, size_label: sizeValue, size_value: sizeValue,
        size_sort_order: row.size_sort_order,
        image_url: row.image_url.trim() || null,
        price_override: row.price_override.trim() ? Number(row.price_override) : null,
        cost_override: canAct("change_cost") && row.cost_override.trim() ? Number(row.cost_override) : null,
        stock_quantity: 0, low_stock_level: Number(row.low_stock_level),
        active: row.active, sort_order: previous?.sort_order ?? created.length + 1,
      };
      // A previously saved row may have a corrected barcode on retry. The
      // service strips stock from updates, so this still cannot move its shelf.
      const needsEdit = previous && (
        previous.sku !== rowValues.sku || previous.barcode !== rowValues.barcode ||
        previous.color_ar !== rowValues.color_ar || previous.color_en !== rowValues.color_en ||
        previous.color_hex !== rowValues.color_hex || previous.image_url !== rowValues.image_url ||
        variantSizeValue(previous) !== (rowValues.size_value ?? "") ||
        (previous.size_sort_order ?? 0) !== rowValues.size_sort_order ||
        previous.price_override !== rowValues.price_override || previous.cost_override !== rowValues.cost_override ||
        previous.low_stock_level !== rowValues.low_stock_level || previous.active !== rowValues.active
      );
      const variant = previous && !needsEdit ? previous : (await saveVariant({
        product: result.product, siblings: created, currentId: previous?.id, values: rowValues,
      })).variant;
      if (!previous) created.push(variant);
      resume.ids.set(row.id, variant.id);
      ordered.push(variant);
    }
    // enableVariants atomically allocates the already-existing product total
    // across these exact IDs. In demo mode its movement ledger is retry-safe;
    // in Supabase the RPC is a single database transaction.
    await enableVariants(
      result.product.id,
      ordered.map((variant, index) => ({
        variantId: variant.id,
        quantity: Number(variantConfig.rows[index].stock_quantity),
      })),
    );
    await replaceColorImages(result.product.id, variantConfig.colors.flatMap((color) => {
      const colorKey = color.id && !color.id.startsWith("color:") ? color.id : colorKeyOf(color);
      return color.image_urls.map((image_url,index) => ({
        color_key: colorKey,
        image_url,
        alt_ar: color.color_ar.trim() || null,
        alt_en: color.color_en.trim() || null,
        sort_order: index,
        is_primary: index===0,
      }));
    }));
    await refresh();
    variantBootstrap.current = null;
    setBootstrapPending(false);
    return result;
  };

  const goBack = useCallback(() => {
    navigate(productId ? `/dashboard/products/${productId}` : "/dashboard/products");
  }, [navigate, productId]);

  const handleSaveAndEditVariants = async () => {
    setSubmitAttempted(true);
    if (Object.keys(errors).length > 0) {
      toast.error(t("validation.fixErrors"));
      const first = Object.keys(errors)[0];
      document.querySelector<HTMLElement>(`[name="${first}"]`)?.focus();
      return;
    }
    if (variantError) {
      toast.error(t(`products.simple.${variantError}` as never));
      document.querySelector<HTMLElement>('[data-testid="product-variants-form"]')?.scrollIntoView?.({ block: "center" });
      return;
    }
    setSaving(true);
    try {
      const { product, isNew } = await saveDraftAndVariants();
      toast.success(t(isNew ? "products.createdToast" : "products.updatedToast"));
      if (isNew) {
        navigate(`/dashboard/products/${product.id}/edit`);
      } else {
        navigate(`/dashboard/products/${productId}`);
      }
    } catch (error) {
      if (isApprovalRequired(error)) {
        setApprovalAsk(error.approvalRequired);
        return;
      }
      const described = describeError(error);
      toast.error(error instanceof Error && [t("products.simple.enableRights"), t("products.simple.retryLocked")].includes(error.message)
        ? error.message
        : variantBootstrap.current ? `${t(described.key as never)} · ${t("products.simple.retryShort")}` : t(described.key as never));
      if (described.field) {
        setTouched((prev) => ({ ...prev, [described.field as string]: true }));
      }
    } finally {
      setSaving(false);
    }
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSubmitAttempted(true);
    if (Object.keys(errors).length > 0) {
      toast.error(t("validation.fixErrors"));
      const first = Object.keys(errors)[0];
      document.querySelector<HTMLElement>(`[name="${first}"]`)?.focus();
      return;
    }
    if (variantError) {
      toast.error(t(`products.simple.${variantError}` as never));
      document.querySelector<HTMLElement>('[data-testid="product-variants-form"]')?.scrollIntoView?.({ block: "center" });
      return;
    }
    setSaving(true);
    try {
      const { isNew } = await saveDraftAndVariants();
      toast.success(t(isNew ? "products.createdToast" : "products.updatedToast"));
      navigate(isNew ? "/dashboard/products" : `/dashboard/products/${productId}`);
    } catch (error) {
      // Phase 12: the shop requires a second signature on price moves. Nothing
      // was written — offer to file the change, carrying the draft verbatim so
      // an approval applies exactly what was asked for.
      if (isApprovalRequired(error)) {
        setApprovalAsk(error.approvalRequired);
        return;
      }
      const described = describeError(error);
      toast.error(error instanceof Error && [t("products.simple.enableRights"), t("products.simple.retryLocked")].includes(error.message)
        ? error.message
        : variantBootstrap.current ? `${t(described.key as never)} · ${t("products.simple.retryShort")}` : t(described.key as never));
      if (described.field) {
        setTouched((prev) => ({ ...prev, [described.field as string]: true }));
      }
    } finally {
      setSaving(false);
    }
  };

  const skuAvailable = !errors.sku && values.sku.trim().length > 0;

  // The over-limit price move the service refused, waiting for a reason.
  const [approvalAsk, setApprovalAsk] = useState<ApprovalRequirement | null>(null);

  if (productId && loading && !existing) {
    return <Card className="text-sm font-medium text-slate-600">{t("common.loading")}</Card>;
  }

  if (productId && !loading && !existing) {
    return (
      <Card className="text-sm font-medium text-slate-700">
        {t("common.notFound")}
        <div className="mt-3">
          <Button variant="secondary" onClick={() => navigate("/dashboard/products")}>
            {t("common.back")}
          </Button>
        </div>
      </Card>
    );
  }

  return (
    <>
    <form onSubmit={handleSubmit} className="space-y-4" noValidate>
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          {/* Names */}
          <Card>
            <SectionTitle>{t("products.cols.product")}</SectionTitle>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field
                label={t("products.nameAr")}
                required
                dir="rtl"
                error={showError("name_ar") ? t(fieldErrorKey(showError("name_ar")!) as never, { max: MAX_NAME_LENGTH }) : undefined}
                htmlFor="name_ar"
              >
                <TextInput
                  id="name_ar"
                  name="name_ar"
                  dir="rtl"
                  lang="ar"
                  maxLength={MAX_NAME_LENGTH}
                  value={values.name_ar}
                  invalid={Boolean(showError("name_ar"))}
                  onBlur={handleBlur("name_ar")}
                  onChange={(e) => set("name_ar", e.target.value)}
                  placeholder="الاسم بالعربية"
                />
              </Field>
              <Field
                label={t("products.nameEn")}
                required
                dir="ltr"
                error={showError("name_en") ? t(fieldErrorKey(showError("name_en")!) as never, { max: MAX_NAME_LENGTH }) : undefined}
                htmlFor="name_en"
              >
                <TextInput
                  id="name_en"
                  name="name_en"
                  dir="ltr"
                  maxLength={MAX_NAME_LENGTH}
                  value={values.name_en}
                  invalid={Boolean(showError("name_en"))}
                  onBlur={handleBlur("name_en")}
                  onChange={(e) => set("name_en", e.target.value)}
                  placeholder="English name"
                />
              </Field>
              <Field
                label={t("products.descriptionAr")}
                optional={t("common.optional")}
                dir="rtl"
                error={
                  showError("description_ar")
                    ? t(fieldErrorKey(showError("description_ar")!) as never, { max: MAX_TEXT_LENGTH })
                    : undefined
                }
                htmlFor="description_ar"
              >
                <TextArea
                  id="description_ar"
                  name="description_ar"
                  dir="rtl"
                  lang="ar"
                  maxLength={MAX_TEXT_LENGTH}
                  value={values.description_ar}
                  onBlur={handleBlur("description_ar")}
                  onChange={(e) => set("description_ar", e.target.value)}
                />
              </Field>
              <Field
                label={t("products.descriptionEn")}
                optional={t("common.optional")}
                dir="ltr"
                error={
                  showError("description_en")
                    ? t(fieldErrorKey(showError("description_en")!) as never, { max: MAX_TEXT_LENGTH })
                    : undefined
                }
                htmlFor="description_en"
              >
                <TextArea
                  id="description_en"
                  name="description_en"
                  dir="ltr"
                  maxLength={MAX_TEXT_LENGTH}
                  value={values.description_en}
                  onBlur={handleBlur("description_en")}
                  onChange={(e) => set("description_en", e.target.value)}
                />
              </Field>
            </div>
          </Card>

          {/* Identifiers */}
          <Card>
            <SectionTitle>{t("products.sku")} / {t("products.barcode")}</SectionTitle>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field
                label={t("products.sku")}
                required
                error={
                  showError("sku")
                    ? t(fieldErrorKey(showError("sku")!) as never, { max: MAX_SKU_LENGTH })
                    : undefined
                }
                hint={skuAvailable ? t("validation.skuAvailable") : undefined}
                htmlFor="sku"
              >
                <div className="flex gap-2">
                  <TextInput
                    id="sku"
                    name="sku"
                    dir="ltr"
                    maxLength={MAX_SKU_LENGTH}
                    className="font-mono"
                    value={values.sku}
                    invalid={Boolean(showError("sku"))}
                    onBlur={handleBlur("sku")}
                    onChange={(e) => set("sku", e.target.value)}
                    placeholder={t("products.skuPlaceholder")}
                  />
                  <Button
                    variant="secondary"
                    size="md"
                    type="button"
                    title={t("common.new")}
                    onClick={() =>
                      set("sku", suggestSku(values.name_en || values.name_ar, products.map((p) => p.sku)))
                    }
                  >
                    ⚡
                  </Button>
                </div>
              </Field>
              <Field
                label={t("products.barcode")}
                optional={t("common.optional")}
                error={
                  showError("barcode")
                    ? t(fieldErrorKey(showError("barcode")!) as never, { max: MAX_BARCODE_LENGTH })
                    : undefined
                }
                hint={
                  showError("barcode")
                    ? undefined
                    : barcodeMode === "auto"
                      ? t("barcode.autoHint")
                      : t("barcode.manualHint")
                }
                htmlFor="barcode"
              >
                <div className="flex gap-2">
                  <TextInput
                    id="barcode"
                    name="barcode"
                    dir="ltr"
                    maxLength={MAX_BARCODE_LENGTH}
                    className="font-mono"
                    value={values.barcode}
                    invalid={Boolean(showError("barcode"))}
                    onBlur={handleBlur("barcode")}
                    onChange={(e) => {
                      // Typing in the barcode means the admin is entering a
                      // manufacturer code — stop mirroring the SKU.
                      setBarcodeMode("manual");
                      set("barcode", e.target.value);
                    }}
                    placeholder={t("products.barcodePlaceholder")}
                  />
                  <Button
                    variant="secondary"
                    size="md"
                    type="button"
                    title={t("barcode.regenerate")}
                    aria-label={t("barcode.regenerate")}
                    onClick={generateBarcode}
                  >
                    ⟲
                  </Button>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  <span
                    className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1 ring-inset ${
                      barcodeMode === "auto"
                        ? "bg-indigo-50 text-indigo-800 ring-indigo-200"
                        : "bg-amber-50 text-amber-800 ring-amber-300"
                    }`}
                  >
                    {barcodeMode === "auto" ? t("barcode.auto") : t("barcode.manual")}
                  </span>
                  <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-700 ring-1 ring-inset ring-slate-200">
                    {t("barcode.format")}
                  </span>
                </div>
              </Field>
            </div>

            {/* ── Live Code 128 preview + label actions ───────────────── */}
            <div className="mt-4 border-t border-slate-100 pt-4">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <p className="text-[11px] font-bold uppercase tracking-wider text-slate-600">
                  {t("barcode.preview")}
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  <label className="flex items-center gap-1.5 text-[11px] font-semibold text-slate-600">
                    {t("barcode.copies")}
                    <TextInput
                      dir="ltr"
                      inputMode="numeric"
                      aria-label={t("barcode.copies")}
                      className="h-8 w-16 py-1 text-center font-mono text-xs"
                      value={printCopies}
                      onChange={(e) => setPrintCopies(e.target.value)}
                    />
                  </label>
                  <div className="flex flex-wrap items-center gap-2 text-[10px]">
                    {(["name", "color", "size", "sku", "price", "number"] as const).map((key) => <label key={key} className="flex items-center gap-1"><input type="checkbox" checked={labelOptions[key]} onChange={(event) => setLabelOptions((current) => ({ ...current, [key]: event.target.checked }))} />{key}</label>)}
                  </div>
                  <Button variant="ghost" size="sm" type="button" onClick={() => setPrintCopies(String(Math.max(1, Number(values.stock_quantity) || 1)))}>
                    {t("barcode.byStock")}
                  </Button>
                  <Button variant="secondary" size="sm" type="button" onClick={generateBarcode}>
                    {t("barcode.generate")}
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    type="button"
                    onClick={printBarcode}
                    disabled={!values.barcode.trim()}
                  >
                    🖨 {t("barcode.print")}
                  </Button>
                </div>
              </div>
              <BarcodePreview value={values.barcode} />
            </div>
          </Card>

          {!isEdit ? (
            <ProductVariantsForm
              value={variantConfig}
              productSku={values.sku}
              productSellingPrice={values.selling_price}
              productCostPrice={values.cost_price}
              productBarcode={values.barcode}
              onChange={changeVariantConfig}
              structureLocked={bootstrapPending}
              stockEditable={!bootstrapPending}
            />
          ) : null}

          {/* Pricing + Stock */}
          <Card>
            <SectionTitle>{t("products.sellingPrice")} / {t("common.stock")}</SectionTitle>
            <div className="grid gap-3 sm:grid-cols-3">
              <Field
                label={t("products.sellingPrice")}
                required
                error={showError("selling_price") ? t(fieldErrorKey(showError("selling_price")!) as never) : undefined}
                htmlFor="selling_price"
              >
                <TextInput
                  id="selling_price"
                  name="selling_price"
                  dir="ltr"
                  inputMode="decimal"
                  value={values.selling_price}
                  invalid={Boolean(showError("selling_price"))}
                  onBlur={handleBlur("selling_price")}
                  onChange={(e) => set("selling_price", e.target.value)}
                  placeholder="0.00"
                />
              </Field>
              {maySeeCost ? (
                <Field
                  label={t("products.costPrice")}
                  required
                  hint={mayChangeCost ? undefined : t("permissions.denied.change_cost")}
                  error={showError("cost_price") ? t(fieldErrorKey(showError("cost_price")!) as never) : undefined}
                  htmlFor="cost_price"
                >
                  <TextInput
                    id="cost_price"
                    name="cost_price"
                    dir="ltr"
                    inputMode="decimal"
                    readOnly={!mayChangeCost}
                    value={values.cost_price}
                    invalid={Boolean(showError("cost_price"))}
                    onBlur={handleBlur("cost_price")}
                    onChange={(e) => set("cost_price", e.target.value)}
                    placeholder="0.00"
                  />
                </Field>
              ) : null}
              <Field
                label={t("products.taxRate")}
                required
                error={showError("tax_rate") ? t(fieldErrorKey(showError("tax_rate")!) as never) : undefined}
                htmlFor="tax_rate"
              >
                <TextInput
                  id="tax_rate"
                  name="tax_rate"
                  dir="ltr"
                  inputMode="decimal"
                  value={values.tax_rate}
                  invalid={Boolean(showError("tax_rate"))}
                  onBlur={handleBlur("tax_rate")}
                  onChange={(e) => set("tax_rate", e.target.value)}
                  placeholder="15"
                />
              </Field>
            </div>

            {values.stock_tracking_enabled ? (
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                {variantStockIsDerived ? (
                  <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2" data-testid="derived-product-stock">
                    <p className="text-xs font-bold text-slate-700">{t("products.stockQuantity")}</p>
                    <p className="mt-1 text-xl font-black tabular-nums text-slate-900">{num(shownStock, 0)}</p>
                    <p className="text-xs text-slate-600">{t("products.simple.productStockDerived")}</p>
                  </div>
                ) : (
                  <Field
                    label={t("products.stockQuantity")}
                    required
                    hint={t("products.stockQuantityHint")}
                    error={showError("stock_quantity") ? t(fieldErrorKey(showError("stock_quantity")!) as never) : undefined}
                    htmlFor="stock_quantity"
                  >
                    <TextInput
                      id="stock_quantity" name="stock_quantity" dir="ltr" inputMode="numeric"
                      value={values.stock_quantity} invalid={Boolean(showError("stock_quantity"))}
                      onBlur={handleBlur("stock_quantity")}
                      onChange={(e) => set("stock_quantity", e.target.value)} placeholder="0"
                    />
                  </Field>
                )}
                <Field
                  label={t("products.lowStockLevel")}
                  required
                  hint={t("products.lowStockLevelHint")}
                  error={showError("low_stock_level") ? t(fieldErrorKey(showError("low_stock_level")!) as never) : undefined}
                  htmlFor="low_stock_level"
                >
                  <TextInput
                    id="low_stock_level"
                    name="low_stock_level"
                    dir="ltr"
                    inputMode="numeric"
                    value={values.low_stock_level}
                    invalid={Boolean(showError("low_stock_level"))}
                    onBlur={handleBlur("low_stock_level")}
                    onChange={(e) => set("low_stock_level", e.target.value)}
                    placeholder="5"
                  />
                </Field>
              </div>
            ) : null}

            <div className="mt-3 grid gap-3 sm:grid-cols-3">
              {/* Both figures are cost in disguise: profit is price minus cost,
                  and margin is the same subtraction as a percentage. */}
              {maySeeCost ? (
                <>
                  <StatTile label={t("products.profit")} value={money(profit)} tone={profit >= 0 ? "success" : "danger"} />
                  <StatTile label={t("products.margin")} value={margin === null ? "—" : `${num(margin, 1)}%`} />
                </>
              ) : null}
              <StatTile
                label={t("common.stock")}
                value={values.stock_tracking_enabled ? num(shownStock, 0) : "—"}
                badge={values.stock_tracking_enabled ? <StockBadge status={liveStatus} /> : undefined}
                tone={liveStatus === "out" ? "danger" : liveStatus === "low" ? "warning" : "neutral"}
              />
            </div>
          </Card>
        </div>

        {/* Side column */}
        <div className="space-y-4">
          <Card>
            <SectionTitle>{t("common.status")}</SectionTitle>
            <div className="space-y-3">
              <Field
                label={t("products.category")}
                required
                error={showError("category_id") ? t(fieldErrorKey(showError("category_id")!) as never) : undefined}
                htmlFor="category_id"
              >
                <SelectInput
                  id="category_id"
                  name="category_id"
                  value={values.category_id}
                  invalid={Boolean(showError("category_id"))}
                  onBlur={handleBlur("category_id")}
                  onChange={(e) => set("category_id", e.target.value)}
                >
                  <option value="">{t("products.selectCategory")}</option>
                  {categoryOptions.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label}
                      {option.active ? "" : " ⏸"}
                    </option>
                  ))}
                </SelectInput>
              </Field>

              <Field
                label={t("products.type")}
                required
                hint={t(PRODUCT_TYPE_META[values.product_type].hintKey as never)}
                htmlFor="product_type"
              >
                <SelectInput
                  id="product_type"
                  name="product_type"
                  value={values.product_type}
                  onChange={(e) => handleTypeChange(e.target.value as ProductType)}
                >
                  {PRODUCT_TYPES.map((type) => (
                    <option key={type} value={type}>
                      {PRODUCT_TYPE_META[type].icon} {t(PRODUCT_TYPE_META[type].labelKey as never)}
                    </option>
                  ))}
                </SelectInput>
              </Field>

              <ToggleSwitch
                label={t("products.stockTracking")}
                hint={t("products.stockTrackingHint")}
                checked={values.stock_tracking_enabled}
                disabled={variantStockIsDerived}
                onChange={(checked) => set("stock_tracking_enabled", checked)}
              />

              <ToggleSwitch
                label={t("products.showOnWebsite")}
                hint={t("products.showOnWebsiteHint")}
                checked={values.show_on_website}
                onChange={(checked) => set("show_on_website", checked)}
              />

              <ToggleSwitch
                label={t("products.featured")}
                hint={t("products.featuredHint")}
                checked={values.is_featured}
                onChange={(checked) => set("is_featured", checked)}
              />

              <ToggleSwitch
                label={isEdit ? t("common.active") : t("products.activeBadge")}
                hint={values.active ? undefined : t("products.inactiveBadge")}
                checked={values.active}
                onChange={(checked) => set("active", checked)}
              />
            </div>
          </Card>

          <Card>
            <SectionTitle>{t("products.images")}</SectionTitle>
            <ProductImagesEditor
              items={values.images}
              onChange={(items) => set("images", items)}
              error={showError("images") ? t(fieldErrorKey(showError("images")!) as never) : undefined}
            />
          </Card>
        </div>
      </div>

      {/* Sticky action bar */}
      <div className="alyq-actionbar sticky bottom-0 z-20 -mx-3 flex flex-col-reverse items-stretch gap-2 px-3 py-3 sm:-mx-6 sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <p className="text-xs font-semibold text-slate-600 sm:text-sm">
          {bootstrapPending ? t("products.simple.retryShort") : dirty ? t("common.unsavedTitle") : isEdit ? t("common.updated") : t("common.readOnly")}
        </p>
        <div className="flex items-center gap-2 max-sm:w-full [&>button]:max-sm:flex-1">
          <Button variant="secondary" type="button" onClick={goBack} disabled={saving}>
            {t("common.cancel")}
          </Button>
          {!isEdit ? (
            <>
              {!hasNewVariants ? (
                <Button
                  variant="secondary"
                  type="button"
                  onClick={() => void handleSaveAndEditVariants()}
                  disabled={saving}
                  className="max-sm:w-full"
                >
                  {t("products.saveAndEditVariants")}
                </Button>
              ) : null}
              <Button type="submit" size="lg" loading={saving} className="max-sm:w-full" data-testid="product-form-save">
                {saving ? t("common.saving") : t("common.save")}
              </Button>
            </>
          ) : (
            <Button type="submit" size="lg" loading={saving} className="max-sm:w-full">
              {saving ? t("common.saving") : t("common.save")}
            </Button>
          )}
        </div>
      </div>
    </form>

    {approvalAsk && existing ? (
      <ApprovalRequestDialog
        open
        requirement={approvalAsk}
        entityType="product"
        entityId={existing.id}
        entityLabel={`${existing.name_en || existing.name_ar} · ${existing.sku}`}
        previousValue={{
          selling_price: Number(existing.selling_price),
          cost_price: Number(existing.cost_price ?? 0),
        }}
        newValue={{
          selling_price: Number(values.selling_price),
          cost_price: Number(values.cost_price),
        }}
        payload={{ product_id: existing.id, values } as unknown as Record<string, unknown>}
        summary={`${t("products.sellingPrice")}: ${money(Number(existing.selling_price))} → ${money(
          Number(values.selling_price),
        )}`}
        onFiled={() => goBack()}
        onClose={() => setApprovalAsk(null)}
      />
    ) : null}
    </>
  );
}
