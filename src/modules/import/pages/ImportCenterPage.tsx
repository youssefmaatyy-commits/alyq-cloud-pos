/**
 * Master Import Center.
 *
 * Full Excel & CSV importing with all-or-nothing validation, atomic commit,
 * multi-branch stock isolation, template downloads, and rich error reporting.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { canAct } from "@/lib/permissions/enforce";
import { PageHeader } from "@/components/layout/AppShell";
import { Badge, Button, Card, EmptyState, useToast } from "@/components/ui";
import { useCatalog } from "@/modules/products";
import { useCustomers } from "@/modules/customers";
import { useInventory } from "@/modules/inventory";
import { useBranch, type BranchAccess } from "@/lib/branch";
import { fieldSpecs } from "../services/columns";
import { readImportTable } from "../services/readFile";
import { buildImportPreview } from "../services/preview";
import { commitImport } from "../services/commit";
import { importKindsAdmitted } from "../services/access";
import { buildErrorReportCsv, generateErrorReportExcel } from "../services/errorReport";
import {
  generateBlankCatalogTemplate,
  generateCurrentCatalogExportTemplate,
  generateStockAdjustmentTemplate,
} from "../services/templates";
import type {
  CommitMode,
  CustomerMatchPolicy,
  ImportCommitResult,
  ImportKind,
  ImportPreview,
  ProductMatchPolicy,
  StockMode,
} from "../types";

export function ImportCenterPage() {
  const { t } = useI18n();
  const toast = useToast();
  const allowed = canAct("import_data");
  const admitted = useMemo(() => importKindsAdmitted((capability) => canAct(capability)), []);
  const catalog = useCatalog();
  const { customers, refresh: refreshCustomers } = useCustomers();
  const inventory = useInventory();
  const { branches, current } = useBranch();
  const activeBranchId = current?.id ?? null;
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [kind, setKind] = useState<ImportKind>("catalog_unified");
  const [stockMode, setStockMode] = useState<StockMode>("set");
  const [customerPolicy, setCustomerPolicy] = useState<CustomerMatchPolicy>("reject");
  const [productPolicy, setProductPolicy] = useState<ProductMatchPolicy>("reject");
  const [mode, setMode] = useState<CommitMode>("all-or-nothing");

  const [fileName, setFileName] = useState<string | null>(null);
  const [headers, setHeaders] = useState<string[]>([]);
  const [table, setTable] = useState<string[][]>([]);
  const [sheetCount, setSheetCount] = useState<number>(1);
  const [overrides, setOverrides] = useState<Record<number, string | null>>({});

  const [busy, setBusy] = useState(false);
  const [commitResult, setCommitResult] = useState<ImportCommitResult | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"preview" | "issues" | "history">("preview");
  const [issueFilter, setIssueFilter] = useState<"all" | "error" | "warning">("all");

  const specs = useMemo(() => fieldSpecs(kind), [kind]);

  const preview: ImportPreview | null = useMemo(() => {
    if (headers.length === 0 || table.length === 0) return null;
    return buildImportPreview({
      kind,
      headers,
      rows: table,
      overrides,
      stockMode,
      customerPolicy,
      productPolicy,
      sheetCount,
      activeBranchId,
      catalogue: {
        products: catalog.products,
        variants: catalog.variants,
        categories: catalog.categories,
        customers,
        branches: branches.map((b: BranchAccess) => ({
          id: b.id,
          name: b.name_en || b.name_ar,
          code: b.code,
        })),
      },
    });
  }, [
    kind,
    headers,
    table,
    overrides,
    stockMode,
    customerPolicy,
    productPolicy,
    sheetCount,
    activeBranchId,
    catalog.products,
    catalog.variants,
    catalog.categories,
    customers,
    branches,
  ]);

  useEffect(() => {
    if (admitted.length > 0 && !admitted.includes(kind)) {
      setKind(admitted[0]);
      setOverrides({});
      setCommitResult(null);
    }
  }, [admitted, kind]);

  const handleFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setFileError(null);
    setCommitResult(null);
    setFileName(file.name);
    setBusy(true);
    try {
      const data = await readImportTable(file);
      setHeaders(data.headers);
      setTable(data.rows);
      setSheetCount(data.sheetCount);
      setOverrides({});
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Failed to parse file";
      setFileError(msg);
      toast.error(msg);
      setHeaders([]);
      setTable([]);
    } finally {
      setBusy(false);
    }
  };

  const handleDownloadTemplate = async (type: "blank" | "live" | "stock") => {
    try {
      let buffer: ArrayBuffer;
      let filename = "catalog-template.xlsx";

      if (type === "blank") {
        buffer = await generateBlankCatalogTemplate(
          catalog.categories,
          branches.map((b: BranchAccess) => ({ id: b.id, name: b.name_en || b.name_ar })),
        );
        filename = "alyq-blank-catalog-template.xlsx";
      } else if (type === "live") {
        buffer = await generateCurrentCatalogExportTemplate({
          products: catalog.products,
          variants: catalog.variants,
          categories: catalog.categories,
          branches: branches.map((b: BranchAccess) => ({ id: b.id, name: b.name_en || b.name_ar })),
        });
        filename = "alyq-current-catalog-export.xlsx";
      } else {
        buffer = await generateStockAdjustmentTemplate({
          products: catalog.products,
          variants: catalog.variants,
          categories: catalog.categories,
          branches: branches.map((b: BranchAccess) => ({ id: b.id, name: b.name_en || b.name_ar })),
        });
        filename = "alyq-stock-adjustment-template.xlsx";
      }

      const blob = new Blob([buffer], {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      toast.success(`Template ${filename} downloaded successfully.`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to generate template");
    }
  };

  const handleDownloadErrorReport = async (format: "excel" | "csv") => {
    if (!preview) return;
    const allIssues = preview.rows.flatMap((r) => r.issues);
    if (allIssues.length === 0) {
      toast.push("No errors or warnings found to export.", "info");
      return;
    }

    try {
      if (format === "excel") {
        const buffer = await generateErrorReportExcel(allIssues, headers, table);
        const blob = new Blob([buffer], {
          type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `import-errors-${Date.now()}.xlsx`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      } else {
        const csv = buildErrorReportCsv(allIssues);
        const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `import-errors-${Date.now()}.csv`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }
      toast.success("Error report downloaded.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to export error report");
    }
  };

  const handleCommit = async () => {
    if (!preview || !preview.ready) {
      toast.error("Import is not ready. Fix all validation errors before proceeding.");
      return;
    }

    setBusy(true);
    try {
      const result = await commitImport({
        preview,
        mode,
        stockMode,
        activeBranchId,
        filename: fileName || undefined,
        mayChangeCost: canAct("view_cost") || canAct("edit_product"),
        catalogue: {
          products: catalog.products,
          variants: catalog.variants,
          categories: catalog.categories,
          customers,
          branches: branches.map((b: BranchAccess) => ({
            id: b.id,
            name: b.name_en || b.name_ar,
            code: b.code,
          })),
        },
      });

      setCommitResult(result);
      if (result.errors === 0 && !result.rolledBack) {
        toast.success(
          `Import completed! Wrote ${result.written} records, adjusted stock for ${result.stockAdjustmentsCount} items.`,
        );
        await Promise.all([catalog.refresh(), inventory.refresh(), refreshCustomers()]);
      } else {
        toast.error(`Import rolled back with ${result.errors} errors. No changes saved.`);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Import failed");
    } finally {
      setBusy(false);
    }
  };

  const resetAll = () => {
    setFileName(null);
    setHeaders([]);
    setTable([]);
    setOverrides({});
    setCommitResult(null);
    setFileError(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  if (!allowed) {
    return (
      <div className="space-y-4">
        <PageHeader title="Master Import Center / مركز الاستيراد المتقدم" />
        <Card className="p-8">
          <EmptyState
            icon="🔒"
            title={t("perm.denied")}
            description="You do not have permission to import catalogue or inventory data."
          />
        </Card>
      </div>
    );
  }

  const allIssues = preview ? preview.rows.flatMap((r) => r.issues) : [];
  const filteredIssues =
    issueFilter === "all" ? allIssues : allIssues.filter((i) => i.level === issueFilter);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Master Import Center / مركز الاستيراد المتقدم"
        subtitle="Upload Excel workbooks to create products, update variants, adjust multi-branch stock balances, and import customers with atomic safety."
        crumbs={[
          { label: t("nav.dashboard"), to: "/" },
          { label: t("nav.products"), to: "/products" },
          { label: "Import Center / مركز الاستيراد" },
        ]}
      />

      {/* Templates & Guidelines Banner */}
      <Card className="p-5 space-y-4 bg-stone-50 border-stone-200">
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
          <div className="space-y-1">
            <h3 className="text-sm font-bold text-stone-900">
              Download Official Excel Templates / تحميل قوالب الإكسيل المعتمدة
            </h3>
            <p className="text-xs text-stone-500">
              Use verified template columns with pre-configured dropdowns to ensure 100% error-free imports.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => handleDownloadTemplate("blank")}
            >
              📄 Blank Catalog Template
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => handleDownloadTemplate("live")}
            >
              📥 Current Catalog Export
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => handleDownloadTemplate("stock")}
            >
              📊 Stock Adjustment Template
            </Button>
          </div>
        </div>
      </Card>

      {/* Import Configuration & Upload */}
      <Card className="p-5 space-y-5">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <label className="block text-xs font-bold uppercase tracking-wider text-stone-500 mb-1">
              Import Domain / نوع البيانات
            </label>
            <select
              className="w-full rounded-xl border border-stone-200 bg-white px-3 py-2 text-xs font-semibold text-stone-800"
              value={kind}
              onChange={(e) => {
                setKind(e.target.value as ImportKind);
                setOverrides({});
              }}
            >
              <option value="catalog_unified">📦 Unified Catalog (Products & Variants)</option>
              <option value="products">🏷️ Products Only</option>
              <option value="variants">🎨 Variants Only</option>
              <option value="stock">📊 Multi-Branch Stock Adjustments</option>
              <option value="customers">👥 CRM Customers</option>
              <option value="categories">🗂️ Categories</option>
            </select>
          </div>

          <div>
            <label className="block text-xs font-bold uppercase tracking-wider text-stone-500 mb-1">
              Stock Modification Mode / حركة المخزون
            </label>
            <select
              className="w-full rounded-xl border border-stone-200 bg-white px-3 py-2 text-xs font-semibold text-stone-800"
              value={stockMode}
              onChange={(e) => setStockMode(e.target.value as StockMode)}
            >
              <option value="set">📌 SET Stock (تعيين الرصيد الفعلي)</option>
              <option value="delta">➕ ADD/SUBTRACT Delta (إضافة / خصم)</option>
              <option value="no_change">🚫 NO Stock Change (تعديل بيانات فقط)</option>
            </select>
          </div>

          <div>
            <label className="block text-xs font-bold uppercase tracking-wider text-stone-500 mb-1">
              {kind === "customers"
                ? "Existing Customer Policy / سياسة العملاء الموجودين"
                : "Existing SKU Policy / سياسة الأصناف الموجودة"}
            </label>
            {kind === "customers" ? (
              <select
                className="w-full rounded-xl border border-stone-200 bg-white px-3 py-2 text-xs font-semibold text-stone-800"
                value={customerPolicy}
                onChange={(e) => setCustomerPolicy(e.target.value as CustomerMatchPolicy)}
              >
                <option value="reject">❌ Reject Existing (رفض التكرار)</option>
                <option value="skip">⏭️ Skip Existing (تخطي الموجود)</option>
                <option value="update">✏️ Update Existing (تحديث البيانات)</option>
              </select>
            ) : (
              <select
                className="w-full rounded-xl border border-stone-200 bg-white px-3 py-2 text-xs font-semibold text-stone-800"
                value={productPolicy}
                onChange={(e) => setProductPolicy(e.target.value as ProductMatchPolicy)}
              >
                <option value="reject">❌ Reject Existing (رفض التكرار)</option>
                <option value="update">✏️ Update Existing (تحديث البيانات)</option>
              </select>
            )}
          </div>

          <div>
            <label className="block text-xs font-bold uppercase tracking-wider text-stone-500 mb-1">
              Safety Commit Mode / وضع الأمان
            </label>
            <select
              className="w-full rounded-xl border border-stone-200 bg-white px-3 py-2 text-xs font-semibold text-stone-800 font-bold text-emerald-800"
              value={mode}
              onChange={(e) => setMode(e.target.value as CommitMode)}
            >
              <option value="all-or-nothing">🛡️ All-Or-Nothing (إلغاء الكل عند أي خطأ)</option>
              <option value="valid-only">⚠️ Valid Rows Only (تخطي الصفوف الخاطئة)</option>
            </select>
          </div>
        </div>

        {/* File Dropzone */}
        <div className="rounded-2xl border-2 border-dashed border-stone-300 p-6 text-center hover:border-stone-400 bg-stone-50/50">
          <input
            ref={fileInputRef}
            type="file"
            accept=".xlsx,.xls,.csv"
            className="hidden"
            id="import-file-input"
            onChange={handleFileChange}
          />
          <label htmlFor="import-file-input" className="cursor-pointer space-y-2 block">
            <div className="text-3xl">📂</div>
            <div className="text-sm font-bold text-stone-800">
              {fileName ? fileName : "Click to select or drag and drop an Excel (.xlsx) or CSV file"}
            </div>
            <p className="text-xs text-stone-500">
              Supports multi-sheet catalog workbooks up to 5,000 rows.
            </p>
          </label>
        </div>

        {fileError && (
          <div className="rounded-xl bg-rose-50 border border-rose-200 p-4 text-xs font-semibold text-rose-700">
            ⚠️ {fileError}
          </div>
        )}
      </Card>

      {/* Column Review & Preview Results */}
      {preview && (
        <Card className="space-y-4 p-5">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-stone-100 pb-3">
            <div>
              <h3 className="text-sm font-bold text-stone-900">
                Column Mapping Review / مراجعة مطابقة الأعمدة ({headers.length} Columns)
              </h3>
              <p className="text-xs text-stone-500">
                Verify auto-detected columns or manually map headers
              </p>
            </div>
            {preview.review.ready ? (
              <Badge tone="success">✅ Mapping Ready</Badge>
            ) : (
              <Badge tone="warning">⚠️ Action Needed on Columns</Badge>
            )}
          </div>

          <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
            {preview.review.assignments.map((col) => (
              <div
                key={col.index}
                className="rounded-xl border border-stone-200 bg-stone-50 p-3 space-y-1"
              >
                <div className="flex items-center justify-between">
                  <span className="text-[10px] font-bold text-stone-400">
                    Col {col.index + 1}
                  </span>
                  {col.refused === "blob" ? (
                    <span className="text-[10px] font-bold text-rose-600">Blob Refused</span>
                  ) : null}
                </div>
                <div className="text-xs font-bold text-stone-800 truncate" title={col.header}>
                  {col.header}
                </div>
                <select
                  className="w-full rounded-lg border border-stone-200 bg-white px-2 py-1 text-[11px] font-semibold text-stone-700"
                  value={overrides[col.index] !== undefined ? (overrides[col.index] ?? "") : (col.field ?? "")}
                  onChange={(e) => {
                    const val = e.target.value === "" ? null : e.target.value;
                    setOverrides((prev) => ({ ...prev, [col.index]: val }));
                  }}
                >
                  <option value="">— Unmapped / تجاهل —</option>
                  {specs.map((s) => (
                    <option key={s.field} value={s.field}>
                      {s.field} {s.required ? "*" : ""}
                    </option>
                  ))}
                </select>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* Validation Summary & Commit Actions */}
      {preview && (
        <Card className="p-5 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-4 border-b border-stone-100 pb-3">
            <div className="flex items-center gap-3">
              <span className="text-xs font-bold text-stone-500">Summary:</span>
              <span className="rounded-full bg-emerald-100 px-3 py-1 text-xs font-bold text-emerald-800">
                ✅ {preview.counts.valid} Valid Rows
              </span>
              <span className="rounded-full bg-amber-100 px-3 py-1 text-xs font-bold text-amber-800">
                ⚠️ {preview.counts.warning} Warnings
              </span>
              <span className="rounded-full bg-rose-100 px-3 py-1 text-xs font-bold text-rose-800">
                ❌ {preview.counts.error} Errors
              </span>
            </div>

            <div className="flex items-center gap-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => handleDownloadErrorReport("excel")}
                disabled={allIssues.length === 0}
              >
                📥 Download Error Report (Excel)
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => handleDownloadErrorReport("csv")}
                disabled={allIssues.length === 0}
              >
                CSV
              </Button>
              <Button
                variant="primary"
                size="md"
                disabled={!preview.ready || busy}
                onClick={handleCommit}
              >
                {busy ? "Importing..." : `Confirm & Commit Import (${preview.counts.valid} Rows)`}
              </Button>
              <Button variant="secondary" size="md" onClick={resetAll}>
                Reset
              </Button>
            </div>
          </div>

          {/* Validation Tabs */}
          <div className="flex items-center gap-2 border-b border-stone-200">
            <button
              className={`px-4 py-2 text-xs font-bold border-b-2 ${
                activeTab === "preview"
                  ? "border-stone-900 text-stone-900"
                  : "border-transparent text-stone-500 hover:text-stone-700"
              }`}
              onClick={() => setActiveTab("preview")}
            >
              Data Grid Preview ({preview.rows.length})
            </button>
            <button
              className={`px-4 py-2 text-xs font-bold border-b-2 ${
                activeTab === "issues"
                  ? "border-stone-900 text-stone-900"
                  : "border-transparent text-stone-500 hover:text-stone-700"
              }`}
              onClick={() => setActiveTab("issues")}
            >
              Validation Issues & Suggested Fixes ({allIssues.length})
            </button>
          </div>

          {/* Tab 1: Preview Data Table */}
          {activeTab === "preview" && (
            <div className="overflow-x-auto max-h-96">
              <table className="w-full text-start text-xs border-collapse">
                <thead className="bg-stone-100 sticky top-0 font-bold text-stone-700">
                  <tr>
                    <th className="p-2 border border-stone-200">Row</th>
                    <th className="p-2 border border-stone-200">Status</th>
                    <th className="p-2 border border-stone-200">Action</th>
                    <th className="p-2 border border-stone-200">Target</th>
                    <th className="p-2 border border-stone-200">Stock Impact</th>
                    {headers.slice(0, 8).map((h, idx) => (
                      <th key={idx} className="p-2 border border-stone-200 truncate max-w-[150px]">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {preview.rows.map((row) => (
                    <tr
                      key={row.row}
                      className={
                        row.status === "error"
                          ? "bg-rose-50/50"
                          : row.status === "warning"
                          ? "bg-amber-50/50"
                          : "hover:bg-stone-50"
                      }
                    >
                      <td className="p-2 border border-stone-200 font-mono text-[10px]">{row.row}</td>
                      <td className="p-2 border border-stone-200">
                        {row.status === "valid" && <Badge tone="success">Valid</Badge>}
                        {row.status === "warning" && <Badge tone="warning">Warning</Badge>}
                        {row.status === "error" && <Badge tone="danger">Error</Badge>}
                      </td>
                      <td className="p-2 border border-stone-200 font-mono text-[11px] font-semibold">
                        {row.action}
                      </td>
                      <td className="p-2 border border-stone-200 font-mono text-[11px] text-stone-600 truncate max-w-[120px]">
                        {row.targetId || "—"}
                      </td>
                      <td className="p-2 border border-stone-200 font-mono text-[11px]">
                        {row.computedStock ? (
                          <span>
                            {row.computedStock.current} ➔ {row.computedStock.after} ({row.computedStock.delta >= 0 ? `+${row.computedStock.delta}` : row.computedStock.delta})
                          </span>
                        ) : (
                          "—"
                        )}
                      </td>
                      {headers.slice(0, 8).map((_, idx) => (
                        <td key={idx} className="p-2 border border-stone-200 font-mono text-[11px] truncate max-w-[150px]">
                          {row.values[preview.review.assignments[idx]?.field || ""] || table[row.row - 2]?.[idx] || "—"}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Tab 2: Validation Issues */}
          {activeTab === "issues" && (
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <span className="text-xs font-bold text-stone-500">Filter Issues:</span>
                <button
                  className={`px-2.5 py-1 text-xs font-semibold rounded-lg ${
                    issueFilter === "all" ? "bg-stone-900 text-white" : "bg-stone-100 text-stone-700"
                  }`}
                  onClick={() => setIssueFilter("all")}
                >
                  All ({allIssues.length})
                </button>
                <button
                  className={`px-2.5 py-1 text-xs font-semibold rounded-lg ${
                    issueFilter === "error" ? "bg-rose-600 text-white" : "bg-rose-50 text-rose-700"
                  }`}
                  onClick={() => setIssueFilter("error")}
                >
                  Errors ({allIssues.filter((i) => i.level === "error").length})
                </button>
                <button
                  className={`px-2.5 py-1 text-xs font-semibold rounded-lg ${
                    issueFilter === "warning" ? "bg-amber-600 text-white" : "bg-amber-50 text-amber-700"
                  }`}
                  onClick={() => setIssueFilter("warning")}
                >
                  Warnings ({allIssues.filter((i) => i.level === "warning").length})
                </button>
              </div>

              <div className="overflow-x-auto max-h-96">
                <table className="w-full text-start text-xs border-collapse">
                  <thead className="bg-stone-100 sticky top-0 font-bold text-stone-700">
                    <tr>
                      <th className="p-2 border border-stone-200">Row</th>
                      <th className="p-2 border border-stone-200">Level</th>
                      <th className="p-2 border border-stone-200">Field</th>
                      <th className="p-2 border border-stone-200">Issue / Error</th>
                      <th className="p-2 border border-stone-200">Suggested Action / Fix</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredIssues.map((issue, idx) => (
                      <tr
                        key={idx}
                        className={issue.level === "error" ? "bg-rose-50/50" : "bg-amber-50/50"}
                      >
                        <td className="p-2 border border-stone-200 font-mono text-[11px] font-bold">
                          Row {issue.row}
                        </td>
                        <td className="p-2 border border-stone-200 font-bold">
                          {issue.level === "error" ? (
                            <span className="text-rose-700">❌ Error</span>
                          ) : (
                            <span className="text-amber-700">⚠️ Warning</span>
                          )}
                        </td>
                        <td className="p-2 border border-stone-200 font-mono text-[11px] font-semibold text-stone-800">
                          {issue.field}
                        </td>
                        <td className="p-2 border border-stone-200 text-stone-800 font-medium">
                          {issue.message}
                        </td>
                        <td className="p-2 border border-stone-200 text-emerald-800 font-semibold bg-emerald-50/30">
                          {issue.suggestedFix || "Check field value and format"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </Card>
      )}

      {/* Commit Result Modal/Summary */}
      {commitResult && (
        <Card className="p-5 space-y-3 bg-stone-900 text-white rounded-2xl">
          <div className="flex items-center justify-between">
            <h3 className="text-base font-bold text-white">
              {commitResult.rolledBack
                ? "❌ Import Rolled Back (No Data Changed)"
                : "✅ Import Completed Successfully"}
            </h3>
            <span className="text-xs font-mono text-stone-400">Batch ID: {commitResult.batchId}</span>
          </div>
          <div className="grid gap-3 sm:grid-cols-4 text-xs">
            <div className="rounded-xl bg-stone-800 p-3">
              <span className="text-stone-400">Written Records:</span>
              <p className="text-lg font-bold text-emerald-400">{commitResult.written}</p>
            </div>
            <div className="rounded-xl bg-stone-800 p-3">
              <span className="text-stone-400">Stock Adjustments:</span>
              <p className="text-lg font-bold text-teal-400">{commitResult.stockAdjustmentsCount}</p>
            </div>
            <div className="rounded-xl bg-stone-800 p-3">
              <span className="text-stone-400">Skipped Rows:</span>
              <p className="text-lg font-bold text-stone-300">{commitResult.skipped}</p>
            </div>
            <div className="rounded-xl bg-stone-800 p-3">
              <span className="text-stone-400">Errors Count:</span>
              <p className="text-lg font-bold text-rose-400">{commitResult.errors}</p>
            </div>
          </div>
        </Card>
      )}
    </div>
  );
}
