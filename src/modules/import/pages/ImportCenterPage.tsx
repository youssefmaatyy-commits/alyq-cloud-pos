/**
 * Advanced Import Center (Phase 57).
 *
 * Upload, review the column map, read the preview, then commit. Viewing the
 * catalogue is not enough to open this screen, and a stock file never writes
 * the product row directly.
 */
import { useMemo, useState } from "react";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { canAct } from "@/lib/permissions/enforce";
import { PageHeader } from "@/components/layout/AppShell";
import { Badge, Button, Card, EmptyState } from "@/components/ui";
import { downloadTextFile } from "@/modules/online/services/seo";
import { useCatalog } from "@/modules/products";
import { useCustomers } from "@/modules/customers";
import { useInventory } from "@/modules/inventory";
import { IMPORT_LIMITS } from "@/modules/products/services/excelImport";
import { fieldSpecs } from "../services/columns";
import { readImportTable } from "../services/readFile";
import { buildImportPreview } from "../services/preview";
import { commitImport } from "../services/commit";
import { buildErrorReportCsv } from "../services/errorReport";
import type { CommitMode, CustomerMatchPolicy, ImportKind, ImportPreview, ProductMatchPolicy, StockMode } from "../types";

const KINDS: ImportKind[] = ["products", "variants", "customers", "categories", "stock"];

export function ImportCenterPage() {
  const { t } = useI18n();
  const allowed = canAct("import_data");
  const catalog = useCatalog();
  const { customers, refresh: refreshCustomers } = useCustomers();
  const inventory = useInventory();
  const [kind, setKind] = useState<ImportKind>("products");
  const [stockMode, setStockMode] = useState<StockMode>("set");
  const [customerPolicy, setCustomerPolicy] = useState<CustomerMatchPolicy>("reject");
  const [productPolicy, setProductPolicy] = useState<ProductMatchPolicy>("reject");
  const [mode, setMode] = useState<CommitMode>("valid-only");
  const [headers, setHeaders] = useState<string[]>([]);
  const [table, setTable] = useState<string[][]>([]);
  const [sheetCount, setSheetCount] = useState(1);
  const [overrides, setOverrides] = useState<Record<number, string | null>>({});
  const [fileError, setFileError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const preview = useMemo<ImportPreview | null>(() => {
    if (headers.length === 0) return null;
    return buildImportPreview({
      kind,
      headers,
      rows: table,
      overrides,
      stockMode,
      customerPolicy,
      productPolicy,
      sheetCount,
      catalogue: {
        products: catalog.products,
        variants: catalog.variants,
        categories: catalog.categories,
        customers,
      },
    });
  }, [kind, headers, table, overrides, stockMode, customerPolicy, productPolicy, sheetCount, catalog.products, catalog.variants, catalog.categories, customers]);

  if (!allowed) {
    return (
      <div>
        <PageHeader title={t("importCenter.title")} subtitle={t("importCenter.subtitle")} />
        <Card><EmptyState icon="🔒" title={t("perm.denied")} description={t("importCenter.denied")} /></Card>
      </div>
    );
  }

  const specs = fieldSpecs(kind);
  const issues = preview ? preview.rows.flatMap((row) => row.issues) : [];

  return (
    <div data-testid="import-center" className="space-y-4">
      <PageHeader
        title={t("importCenter.title")}
        subtitle={t("importCenter.subtitle")}
        crumbs={[{ label: t("nav.dashboard"), to: "/" }, { label: t("home.management.title"), to: "/management" }, { label: t("importCenter.title") }]}
      />
      <p className="text-xs text-stone-500">{t("importCenter.limits", { rows: IMPORT_LIMITS.maxRows, mb: IMPORT_LIMITS.maxBytes / (1024 * 1024) })}</p>
      <div className="flex flex-wrap gap-1">
        {KINDS.map((item) => (
          <button key={item} type="button" data-testid={`import-kind-${item}`} onClick={() => { setKind(item); setOverrides({}); setResult(null); }} className={`rounded-full px-3 py-1 text-xs font-bold ${kind === item ? "bg-stone-900 text-white" : "bg-white text-stone-700 ring-1 ring-stone-200"}`}>
            {t(`importCenter.kind.${item}`)}
          </button>
        ))}
      </div>
      <Card className="space-y-3">
        {kind === "stock" ? (
          <div className="flex gap-2 text-xs font-bold">
            <label><input type="radio" name="stock-mode" checked={stockMode === "set"} onChange={() => setStockMode("set")} /> {t("importCenter.stock.set")}</label>
            <label><input type="radio" name="stock-mode" checked={stockMode === "delta"} onChange={() => setStockMode("delta")} /> {t("importCenter.stock.delta")}</label>
          </div>
        ) : null}
        {kind === "customers" ? (
          <label className="text-xs font-bold text-stone-700">
            {t("importCenter.customer.policy")}
            <select className="ms-2 rounded-lg border border-stone-200 px-2 py-1" value={customerPolicy} onChange={(event) => setCustomerPolicy(event.target.value as CustomerMatchPolicy)}>
              <option value="reject">{t("importCenter.customer.reject")}</option>
              <option value="skip">{t("importCenter.customer.skip")}</option>
              <option value="update">{t("importCenter.customer.update")}</option>
            </select>
          </label>
        ) : null}
        {kind === "products" ? (
          <label className="text-xs font-bold text-stone-700">
            {t("importCenter.product.policy")}
            <select className="ms-2 rounded-lg border border-stone-200 px-2 py-1" value={productPolicy} onChange={(event) => setProductPolicy(event.target.value as ProductMatchPolicy)}>
              <option value="reject">{t("importCenter.product.reject")}</option>
              <option value="update">{t("importCenter.product.update")}</option>
            </select>
          </label>
        ) : null}
        <label className="text-xs font-bold text-stone-700">
          {t("importCenter.commitMode")}
          <select className="ms-2 rounded-lg border border-stone-200 px-2 py-1" value={mode} onChange={(event) => setMode(event.target.value as CommitMode)}>
            <option value="valid-only">{t("importCenter.mode.valid")}</option>
            <option value="all-or-nothing">{t("importCenter.mode.all")}</option>
          </select>
        </label>
        <input
          type="file"
          accept=".csv,.xlsx,.xls,text/csv"
          data-testid="import-file"
          onChange={(event) => {
            const file = event.target.files?.[0];
            setResult(null);
            setOverrides({});
            if (!file) return;
            void readImportTable(file).then((parsed) => {
              setHeaders(parsed.headers);
              setTable(parsed.rows);
              setSheetCount(parsed.sheetCount);
              setFileError(null);
            }).catch((error: unknown) => {
              setHeaders([]);
              setTable([]);
              setFileError(error instanceof Error ? error.message : t("importCenter.parseError"));
            });
          }}
        />
        {fileError ? <p className="text-xs font-semibold text-rose-700">{fileError}</p> : null}
        <p className="text-xs text-stone-500">{t("importCenter.stockNote")}</p>
      </Card>

      {preview ? (
        <Card className="space-y-3" testId="import-preview">
          <p className="text-sm font-bold text-stone-900">{t("importCenter.review")}</p>
          {!preview.review.ready ? <p className="text-xs font-semibold text-amber-800">{t("importCenter.ambiguous")}</p> : null}
          <ul className="space-y-2 text-xs">
            {preview.review.assignments.map((column) => (
              <li key={column.index} className="flex flex-wrap items-center gap-2">
                <span className="font-mono" dir="ltr">{column.header || "—"}</span>
                {column.refused === "blob" ? <Badge tone="danger">{t("importCenter.blob")}</Badge> : null}
                {column.candidates.length > 1 && overrides[column.index] === undefined ? <Badge tone="warning">{t("importCenter.ambiguous")}</Badge> : null}
                <select
                  aria-label={column.header}
                  value={column.field ?? ""}
                  disabled={column.refused === "blob"}
                  onChange={(event) => setOverrides((current) => ({ ...current, [column.index]: event.target.value || null }))}
                  className="rounded-lg border border-stone-200 px-2 py-1"
                >
                  <option value="">{t("importCenter.ignore")}</option>
                  {specs.map((spec) => <option key={spec.field} value={spec.field}>{spec.field}</option>)}
                </select>
              </li>
            ))}
          </ul>
          <p className="text-xs font-semibold text-stone-700">
            {t("importCenter.counts", { valid: preview.counts.valid, warning: preview.counts.warning, error: preview.counts.error })}
          </p>
          {preview.globalErrors.map((error) => <p key={error} className="text-xs text-amber-800">{error}</p>)}
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              disabled={!preview.ready || busy || (mode === "all-or-nothing" && preview.counts.error > 0)}
              onClick={() => {
                void (async () => {
                  setBusy(true);
                  try {
                    const outcome = await commitImport({
                      preview,
                      mode,
                      mayChangeCost: canAct("change_cost"),
                      stockMode,
                      catalogue: {
                        products: catalog.products,
                        variants: catalog.variants,
                        categories: catalog.categories,
                        customers,
                      },
                    });
                    await Promise.all([catalog.refresh(), refreshCustomers(), inventory.refresh({ silent: true })]);
                    setResult(t("importCenter.result", { written: outcome.written, skipped: outcome.skipped, errors: outcome.errors }));
                  } catch (error: unknown) {
                    setResult(error instanceof Error ? error.message : t("importCenter.parseError"));
                  } finally {
                    setBusy(false);
                  }
                })();
              }}
            >
              {t("importCenter.commit")}
            </Button>
            <Button
              type="button"
              variant="secondary"
              disabled={issues.length === 0}
              onClick={() => downloadTextFile("import-errors.csv", buildErrorReportCsv(issues), "text/csv")}
            >
              {t("importCenter.download")}
            </Button>
          </div>
          {result ? <p className="text-xs font-semibold text-stone-800">{result}</p> : null}
        </Card>
      ) : null}
    </div>
  );
}
