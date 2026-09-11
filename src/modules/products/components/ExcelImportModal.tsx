import { useCallback, useMemo, useRef, useState } from "react";
import { useI18n } from "@/lib/i18n/I18nProvider";
import {
  Button,
  Modal,
  useToast,
} from "@/components/ui";
import type { ImportResult } from "../services/excelImport";
import {
  generateExcelTemplate,
  importProductsFromFile,
  resolveCategoryIds,
} from "../services/excelImport";
import type { Category, NewProduct, Product } from "../types";
import { getCatalogRepository } from "../data";

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
  const [failedCount, setFailedCount] = useState(0);

  const validRows = useMemo(() => importResult?.validRows ?? [], [importResult]);
  const invalidRows = useMemo(() => importResult?.invalidRows ?? [], [importResult]);

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

  const handleConfirmImport = useCallback(async () => {
    if (!importResult || validRows.length === 0) return;

    setStep("importing");
    setImporting(true);
    setImportedCount(0);
    setFailedCount(0);

    const repository = getCatalogRepository();
    const resolved = resolveCategoryIds(validRows, categories, null);

    let success = 0;
    let failed = 0;

    for (const row of resolved) {
      try {
        // Check for duplicate SKU in existing products
        const existingSku = products.find(
          (p) => p.sku.toLowerCase() === row.data._sku.toLowerCase(),
        );
        if (existingSku) {
          failed++;
          continue;
        }

        // Check for duplicate barcode in existing products
        if (row.data._barcode) {
          const existingBarcode = products.find(
            (p) => p.barcode === row.data._barcode,
          );
          if (existingBarcode) {
            failed++;
            continue;
          }
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
          cost_price: row.data.cost_price ?? 0,
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

        await repository.createProduct(newProduct);
        success++;
        setImportedCount(success);
      } catch (err) {
        console.error(`Failed to import row ${row.row}:`, err);
        failed++;
        setFailedCount(failed);
      }
    }

    setImporting(false);
    setStep("complete");
    onImportComplete();
  }, [importResult, validRows, categories, products, onImportComplete]);

  const handleClose = useCallback(() => {
    setStep("upload");
    setFile(null);
    setImportResult(null);
    setImporting(false);
    setImportedCount(0);
    setFailedCount(0);
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
                <div className="max-h-64 overflow-auto">
                  <table className="w-full text-xs">
                    <thead className="sticky top-0 bg-emerald-100">
                      <tr>
                        <th className="px-2 py-1 text-left">{t("import.sku")}</th>
                        <th className="px-2 py-1 text-left">{t("import.name")}</th>
                        <th className="px-2 py-1 text-right">{t("import.price")}</th>
                        <th className="px-2 py-1 text-right">{t("import.stock")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {validRows.slice(0, 20).map((row) => (
                        <tr key={row.row} className="border-b border-emerald-200">
                          <td className="px-2 py-1 font-mono">{row.data._sku}</td>
                          <td className="px-2 py-1">{pick(row.data.name_ar ?? "", row.data.name_en ?? "")}</td>
                          <td className="px-2 py-1 text-right">{row.data.selling_price}</td>
                          <td className="px-2 py-1 text-right">{row.data.stock_quantity}</td>
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

            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={handleClose}>
                {t("common.cancel")}
              </Button>
              <Button
                variant="primary"
                onClick={() => void handleConfirmImport()}
                disabled={validRows.length === 0}
              >
                {t("import.confirmImport")} ({validRows.length})
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
              {t("import.importedCount", { imported: importedCount, total: validRows.length })}
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
