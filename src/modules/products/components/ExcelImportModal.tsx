import { useCallback, useMemo, useRef, useState } from "react";
import { useI18n } from "@/lib/i18n/I18nProvider";
import {
  Button,
  Modal,
  useToast,
} from "@/components/ui";
import type { ImportResult } from "../services/excelImport";
import type { ProductPatch } from "../types";
import {
  generateExcelTemplate,
  importProductsFromFile,
  resolveCategoryIds,
} from "../services/excelImport";
import type { Category, NewProduct, Product } from "../types";
import { getCatalogRepository } from "../data";
import { assertCanImportProducts } from "../services/catalogService";
import { AppError } from "../data/repository";
import { canAct, deniedMessageKey } from "@/lib/permissions/enforce";
import type { TranslationKey } from "@/lib/i18n/I18nProvider";

/** The copy shown when the acting user may not apply an import. */
const deniedImportKey = deniedMessageKey("import_data") as TranslationKey;

interface ExcelImportModalProps {
  open: boolean;
  onClose: () => void;
  products: Product[];
  categories: Category[];
  onImportComplete: () => void;
}

type ImportStep = "upload" | "preview" | "importing" | "complete";

export function ExcelImportModal({
  open,
  onClose,
  products,
  categories,
  onImportComplete,
}: ExcelImportModalProps) {
  const { t, pick } = useI18n();
  const toast = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [step, setStep] = useState<ImportStep>("upload");
  const [file, setFile] = useState<File | null>(null);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const [importing, setImporting] = useState(false);
  const [importedCount, setImportedCount] = useState(0);
  const [updatedCount, setUpdatedCount] = useState(0);
  const [skippedCount, setSkippedCount] = useState(0);
  const [failedCount, setFailedCount] = useState(0);
  /** Opt-in: a colliding row replaces the existing product instead of being skipped. */
  const [updateExisting, setUpdateExisting] = useState(false);

  const validRows = useMemo(() => importResult?.validRows ?? [], [importResult]);
  const invalidRows = useMemo(() => importResult?.invalidRows ?? [], [importResult]);

  /**
   * The existing product each valid row collides with, by SKU (case-insensitive)
   * or barcode.
   *
   * Worked out for the preview on purpose: collisions used to surface only as a
   * "failed" count *after* the import ran, so a shop re-uploading a corrected
   * price list saw "0 imported, 12 failed" with no explanation and no way to
   * update anything.
   */
  const duplicateOf = useMemo(() => {
    const matches = new Map<number, Product>();
    if (validRows.length === 0) return matches;

    const bySku = new Map<string, Product>();
    const byBarcode = new Map<string, Product>();
    for (const product of products) {
      bySku.set(product.sku.trim().toLowerCase(), product);
      if (product.barcode) byBarcode.set(product.barcode.trim(), product);
    }

    for (const row of validRows) {
      const match =
        bySku.get(row.data._sku.trim().toLowerCase()) ??
        (row.data._barcode ? byBarcode.get(row.data._barcode.trim()) : undefined);
      if (match) matches.set(row.row, match);
    }
    return matches;
  }, [products, validRows]);

  const duplicateCount = duplicateOf.size;
  const newCount = validRows.length - duplicateCount;

  const handleFileSelect = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const selected = event.target.files?.[0];
      if (!selected) return;

      setFile(selected);
      setImporting(true);

      try {
        const result = await importProductsFromFile(selected);
        setImportResult(result);
        setStep("preview");
      } catch (err) {
        toast.error(t("import.parseError"));
        console.error("Import parse error:", err);
      } finally {
        setImporting(false);
      }
    },
    [t, toast],
  );

  const handleDownloadTemplate = useCallback(async () => {
    const buffer = await generateExcelTemplate();
    const blob = new Blob([buffer], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "products-template.xlsx";
    a.click();
    URL.revokeObjectURL(url);
    toast.success(t("import.templateDownloaded"));
  }, [t, toast]);

  // Phase 17: an import writes cost price, so a seat without `change_cost`
  // imports every column except that one. Dropping the column rather than
  // refusing the file is the honest reading of the permission — the rest of the
  // sheet is theirs to load — provided the screen says so before they press the
  // button, which the note below does.
  const mayChangeCost = canAct("change_cost");
  const fileCarriesCost = validRows.some(
    (row) => row.data.cost_price !== undefined && row.data.cost_price !== null,
  );

  const handleConfirmImport = useCallback(async () => {
    if (!importResult || validRows.length === 0) return;

    // Parsing the file is harmless; writing 400 products from it is not. The
    // authority is asserted at the point the rows are about to be applied, which
    // is also the point a preview-only user stops being able to continue.
    try {
      assertCanImportProducts();
    } catch (error) {
      toast.error(error instanceof AppError && error.code === "FORBIDDEN" ? t(deniedImportKey) : t("import.parseError"));
      return;
    }

    setStep("importing");
    setImporting(true);
    setImportedCount(0);
    setUpdatedCount(0);
    setSkippedCount(0);
    setFailedCount(0);

    const repository = getCatalogRepository();
    const resolved = resolveCategoryIds(validRows, categories, null);

    let success = 0;
    let updated = 0;
    let skipped = 0;
    let failed = 0;

    for (const row of resolved) {
      const existing = duplicateOf.get(row.row);

      // A collision is a decision, not an error: the row is either updated or
      // skipped, and the summary reports which — it is never counted as failed.
      if (existing && !updateExisting) {
        skipped++;
        setSkippedCount(skipped);
        continue;
      }

      const newProduct: NewProduct = {
        sku: row.data.sku!,
        barcode: row.data._barcode,
        name_ar: row.data.name_ar!,
        name_en: row.data.name_en!,
        description_ar: row.data.description_ar ?? null,
        description_en: row.data.description_en ?? null,
        category_id: row.data.category_id ?? null,
        product_type: row.data.product_type ?? "physical",
        selling_price: row.data.selling_price ?? 0,
        // A new product's cost is zero for a seat that may not write cost: the
        // column is theirs to upload and not theirs to store.
        cost_price: mayChangeCost ? (row.data.cost_price ?? 0) : 0,
        tax_rate: row.data.tax_rate ?? 0,
        stock_tracking_enabled: row.data.stock_tracking_enabled ?? false,
        stock_quantity: row.data.stock_quantity ?? 0,
        low_stock_level: row.data.low_stock_level ?? 5,
        show_on_website: row.data.show_on_website ?? true,
        is_featured: row.data.is_featured ?? false,
        active: row.data.active ?? true,
        image_url: null,
        images: [],
      };

      /**
       * An update carries only the columns a spreadsheet can hold. Images and
       * the published / featured / archived flags are deliberately absent, so
       * re-uploading a price list cannot wipe a product's photos or resurrect
       * one that was archived on purpose.
       */
      const patch: ProductPatch = {
        sku: newProduct.sku,
        barcode: newProduct.barcode,
        name_ar: newProduct.name_ar,
        name_en: newProduct.name_en,
        description_ar: newProduct.description_ar,
        description_en: newProduct.description_en,
        category_id: newProduct.category_id,
        product_type: newProduct.product_type,
        selling_price: newProduct.selling_price,
        // Omitted entirely when the seat may not write cost, so an update leaves
        // the stored value alone instead of overwriting it with the sheet's.
        ...(mayChangeCost ? { cost_price: newProduct.cost_price } : {}),
        tax_rate: newProduct.tax_rate,
        stock_tracking_enabled: newProduct.stock_tracking_enabled,
        stock_quantity: newProduct.stock_quantity,
        low_stock_level: newProduct.low_stock_level,
      };

      try {
        if (existing) {
          await repository.updateProduct(existing.id, patch);
          updated++;
          setUpdatedCount(updated);
        } else {
          await repository.createProduct(newProduct);
          success++;
          setImportedCount(success);
        }
      } catch (err) {
        console.error(`Failed to import row ${row.row}:`, err);
        failed++;
        setFailedCount(failed);
      }
    }

    setImporting(false);
    setStep("complete");
    onImportComplete();
  }, [importResult, validRows, categories, duplicateOf, updateExisting, onImportComplete]);

  const handleClose = useCallback(() => {
    setStep("upload");
    setFile(null);
    setImportResult(null);
    setImporting(false);
    setImportedCount(0);
    setUpdatedCount(0);
    setSkippedCount(0);
    setFailedCount(0);
    setUpdateExisting(false);
    onClose();
  }, [onClose]);

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title={t("import.title")}
      size="lg"
    >
      <div className="space-y-4">
        {step === "upload" && (
          <div className="space-y-4">
            <p className="text-sm text-slate-600">{t("import.uploadHint")}</p>

            <div className="flex flex-col items-center justify-center rounded-xl border-2 border-dashed border-slate-300 bg-slate-50 p-8">
              <div className="mb-4 text-5xl">📊</div>
              <p className="mb-4 text-sm font-medium text-slate-700">
                {t("import.dragOrClick")}
              </p>
              <input
                ref={fileInputRef}
                type="file"
                accept=".xlsx,.xls,.csv"
                onChange={(e) => void handleFileSelect(e)}
                className="hidden"
              />
              <Button
                variant="primary"
                onClick={() => fileInputRef.current?.click()}
                disabled={importing}
              >
                {importing ? t("common.loading") : t("import.selectFile")}
              </Button>
            </div>

            <div className="flex justify-center">
              <Button variant="secondary" size="sm" onClick={handleDownloadTemplate}>
                📥 {t("import.downloadTemplate")}
              </Button>
            </div>
          </div>
        )}

        {step === "preview" && importResult && (
          <div className="space-y-4">
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
              <h3 className="mb-2 text-sm font-semibold text-slate-900">
                {t("import.fileSummary")}
              </h3>
              <div className="grid grid-cols-2 gap-3 text-sm">
                <div>
                  <span className="text-slate-600">{t("import.fileName")}:</span>{" "}
                  <span className="font-medium">{file?.name}</span>
                </div>
                <div>
                  <span className="text-slate-600">{t("import.totalRows")}:</span>{" "}
                  <span className="font-medium">{importResult.totalRows}</span>
                </div>
                <div>
                  <span className="text-slate-600">{t("import.validRows")}:</span>{" "}
                  <span className="font-medium text-emerald-600">{validRows.length}</span>
                </div>
                <div>
                  <span className="text-slate-600">{t("import.invalidRows")}:</span>{" "}
                  <span className="font-medium text-red-600">{invalidRows.length}</span>
                </div>
                <div>
                  <span className="text-slate-600">{t("import.newRows")}:</span>{" "}
                  <span className="font-medium text-emerald-600">{newCount}</span>
                </div>
                {duplicateCount > 0 && (
                  <div>
                    <span className="text-slate-600">{t("import.duplicateRows")}:</span>{" "}
                    <span className="font-medium text-amber-600">{duplicateCount}</span>
                  </div>
                )}
              </div>
            </div>

            {importResult.globalErrors.length > 0 && (
              <div className="rounded-lg border border-red-200 bg-red-50 p-4">
                <h3 className="mb-2 text-sm font-semibold text-red-900">
                  {t("import.errors")}
                </h3>
                <ul className="list-inside list-disc space-y-1 text-sm text-red-800">
                  {importResult.globalErrors.map((err, i) => (
                    <li key={i}>{err}</li>
                  ))}
                </ul>
              </div>
            )}

            {invalidRows.length > 0 && (
              <div className="rounded-lg border border-amber-200 bg-amber-50 p-4">
                <h3 className="mb-2 text-sm font-semibold text-amber-900">
                  {t("import.validationErrors")} ({invalidRows.length})
                </h3>
                <div className="max-h-48 overflow-y-auto">
                  <ul className="space-y-2 text-xs text-amber-800">
                    {invalidRows.slice(0, 10).map((row) => (
                      <li key={row.row} className="border-b border-amber-200 pb-2">
                        <span className="font-semibold">{t("import.row")} {row.row}:</span>{" "}
                        {row.errors.map((e) => e.message).join(", ")}
                      </li>
                    ))}
                    {invalidRows.length > 10 && (
                      <li className="text-amber-600">
                        ...{invalidRows.length - 10} {t("import.moreErrors")}
                      </li>
                    )}
                  </ul>
                </div>
              </div>
            )}

            {validRows.length > 0 && (
              <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-4">
                <h3 className="mb-2 text-sm font-semibold text-emerald-900">
                  {t("import.preview")} ({validRows.length})
                </h3>
                {!mayChangeCost && fileCarriesCost ? (
                  <p className="mb-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-900">
                    {t("import.costSkipped")}
                  </p>
                ) : null}
                <div className="max-h-64 overflow-auto">
                  <table className="w-full text-xs">
                    <thead className="sticky top-0 bg-emerald-100">
                      <tr>
                        <th className="px-2 py-1 text-start">{t("import.sku")}</th>
                        <th className="px-2 py-1 text-start">{t("import.name")}</th>
                        <th className="px-2 py-1 text-end">{t("import.price")}</th>
                        <th className="px-2 py-1 text-end">{t("import.stock")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {validRows.slice(0, 20).map((row) => (
                        <tr key={row.row} className="border-b border-emerald-200">
                          <td className="px-2 py-1 font-mono">{row.data._sku}</td>
                          <td className="px-2 py-1">{pick(row.data.name_ar ?? "", row.data.name_en ?? "")}</td>
                          <td className="px-2 py-1 text-end">{row.data.selling_price}</td>
                          <td className="px-2 py-1 text-end">{row.data.stock_quantity}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {validRows.length > 20 && (
                    <p className="mt-2 text-center text-xs text-emerald-600">
                      ...{validRows.length - 20} {t("import.moreRows")}
                    </p>
                  )}
                </div>
              </div>
            )}

            {duplicateCount > 0 && (
              <div className="rounded-lg border border-amber-200 bg-amber-50 p-4">
                <label className="flex cursor-pointer items-start gap-3">
                  <input
                    type="checkbox"
                    checked={updateExisting}
                    onChange={(event) => setUpdateExisting(event.target.checked)}
                    className="mt-0.5 h-4 w-4 rounded border-amber-400 text-amber-600"
                  />
                  <span>
                    <span className="block text-sm font-semibold text-amber-900">
                      {t("import.updateExisting")}
                    </span>
                    <span className="block text-xs text-amber-800">
                      {t("import.updateExistingHint")}
                    </span>
                  </span>
                </label>
                <p className="mt-3 text-xs font-medium text-amber-800">
                  {t(
                    updateExisting ? "import.duplicatesUpdateHint" : "import.duplicatesSkipHint",
                    { count: duplicateCount },
                  )}
                </p>
              </div>
            )}

            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={handleClose}>
                {t("common.cancel")}
              </Button>
              <Button
                variant="primary"
                onClick={() => void handleConfirmImport()}
                disabled={updateExisting ? validRows.length === 0 : newCount === 0}
              >
                {/* The count is what will actually be written, not every valid row —
                    and with nothing to write the button is off, so an import can
                    never run just to report "0 imported". */}
                {t("import.confirmImport")} ({updateExisting ? validRows.length : newCount})
              </Button>
            </div>
          </div>
        )}

        {step === "importing" && (
          <div className="py-12 text-center">
            <div className="mb-4 text-5xl">⏳</div>
            <p className="text-sm font-medium text-slate-700">
              {t("import.importing")}
            </p>
            <p className="mt-2 text-xs text-slate-500">
              {t("import.importedCount", {
                imported: importedCount + updatedCount,
                total: validRows.length,
              })}
            </p>
          </div>
        )}

        {step === "complete" && (
          <div className="py-8 text-center">
            <div className="mb-4 text-5xl">✅</div>
            <h3 className="mb-2 text-lg font-semibold text-slate-900">
              {t("import.complete")}
            </h3>
            <p className="text-sm text-slate-600">
              {t("import.importedSuccess", { count: importedCount })}
            </p>
            {updatedCount > 0 && (
              <p className="mt-2 text-sm text-emerald-600">
                {t("import.updatedSuccess", { count: updatedCount })}
              </p>
            )}
            {skippedCount > 0 && (
              <p className="mt-2 text-sm text-amber-600">
                {t("import.skippedCount", { count: skippedCount })}
              </p>
            )}
            {failedCount > 0 && (
              <p className="mt-2 text-sm text-red-600">
                {t("import.failedCount", { count: failedCount })}
              </p>
            )}
            <div className="mt-6">
              <Button variant="primary" onClick={handleClose}>
                {t("common.close")}
              </Button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
