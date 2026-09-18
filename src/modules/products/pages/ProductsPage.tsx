import { useCallback, useEffect, useMemo, useRef, useState, lazy, Suspense } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { PageHeader } from "@/components/layout/AppShell";
import {
  Button,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  ExportButton,
  LoadingBlock,
  BoxIcon,
  PlusIcon,
  SelectInput,
  StatTile,
  useToast,
} from "@/components/ui";
import { buildProductsSheets } from "../services/productsExport";
import { buildVariantsSheet } from "../services/variantsExport";
import { ProductFilters, EMPTY_FILTERS, type ProductFiltersValue } from "../components/ProductFilters";
import { ProductTable } from "../components/ProductTable";
import { useCatalog } from "../hooks/CatalogProvider";
import { buildCategorySearchResolver, categoryNameIndex } from "../services/categoryTree";
import { describeError } from "../services/catalogService";
import { paginate, queryProducts, summarize, totalPagesFor } from "../services/productQuery";
import type { Product } from "../types";

// Lazy load ExcelImportModal to prevent xlsx from loading at startup
const ExcelImportModal = lazy(() => 
  import("../components/ExcelImportModal").then(m => ({ default: m.ExcelImportModal }))
);

export function ProductsPage() {
  const { t, pick, tPlural } = useI18n();
  const toast = useToast();
  const {
    products,
    categories,
    variants,
    productReferences,
    loading,
    error,
    refresh,
    refreshReferences,
    setProductActive,
    deleteProduct,
    mode,
  } = useCatalog();

  // History can mint while this screen is away — a sale completed at the POS,
  // an online order approved. The reference map is what keeps a referenced
  // product's delete affordance disabled with its reason, so re-read it
  // silently on mount without flickering the catalogue.
  useEffect(() => {
    void refreshReferences();
  }, [refreshReferences]);

  const [filters, setFilters] = useState<ProductFiltersValue>(EMPTY_FILTERS);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);

  // Phase 46: the shell's global search lands here as `?q=…` (the catalog is
  // the entity the shell can actually see). Hydrated once; anything else in the
  // URL is ignored rather than invented.
  const [params, setParams] = useSearchParams();
  const hydrated = useRef(false);
  useEffect(() => {
    if (hydrated.current) return;
    hydrated.current = true;
    const q = params.get("q");
    if (q) {
      setFilters((current) => ({ ...current, search: q }));
      setPage(1);
      setParams({}, { replace: true });
    }
  }, []); // once, on mount
  const [busyId, setBusyId] = useState<string | null>(null);
  const [pending, setPending] = useState<Product | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Product | null>(null);
  const [importOpen, setImportOpen] = useState(false);

  const nameIndex = useMemo(() => categoryNameIndex(categories, pick), [categories, pick]);
  const categoryName = useCallback(
    (id: string | null) => (id ? nameIndex.get(id) ?? "—" : t("products.withoutCategory")),
    [nameIndex, t],
  );

  const searchResolver = useMemo(
    () => buildCategorySearchResolver(categories, pick),
    [categories, pick],
  );
  const results = useMemo(
    () => queryProducts(products, filters, searchResolver),
    [products, filters, searchResolver],
  );
  const totalPages = totalPagesFor(results.length, pageSize);
  const currentPage = Math.min(page, totalPages);
  const visible = paginate(results, currentPage, pageSize);
  const stats = useMemo(() => summarize(products, categories), [products, categories]);

  const updateFilters = (next: ProductFiltersValue) => {
    setFilters(next);
    setPage(1);
  };

  const handleToggle = (product: Product) => setPending(product);

  const confirmToggle = async () => {
    if (!pending || busyId) return;
    setBusyId(pending.id);
    try {
      await setProductActive(pending.id, !pending.active);
      toast.success(t(pending.active ? "products.archivedToast" : "products.restoredToast"));
    } catch (err) {
      toast.error(t(describeError(err).key as never));
    } finally {
      setBusyId(null);
      setPending(null);
    }
  };

  const handleDelete = (product: Product) => setPendingDelete(product);

  const confirmDelete = async () => {
    // busyId doubles as the double-submit guard: a second confirm while the
    // first is in flight does nothing.
    if (!pendingDelete || busyId) return;
    setBusyId(pendingDelete.id);
    try {
      await deleteProduct(pendingDelete.id);
      toast.success(t("products.deletedToast"));
      setPendingDelete(null);
    } catch (err) {
      toast.error(t(describeError(err).key as never));
      setPendingDelete(null);
    } finally {
      setBusyId(null);
    }
  };

  const resetDemo = async () => {
    if (mode !== "demo") return;
    const { getDemoRepository } = await import("../data/demoRepository");
    getDemoRepository().reset();
    await refresh();
    toast.push(t("common.reset"), "info");
  };

  return (
    <div>
      <PageHeader
        crumbs={[{ label: t("home.breadcrumb.catalog"), to: "/catalog" }, { label: t("nav.products") }]}
        title={t("products.title")}
        subtitle={t("products.subtitle")}
        actions={
          <>
            <Button variant="secondary" onClick={() => void refresh()} title={t("common.retry")}>
              ⟳
            </Button>
            <Button variant="secondary" onClick={() => setImportOpen(true)}>
              📥 {t("import.button")}
            </Button>
            {/* Exports `results` — the filtered set on screen, not the raw list. */}
            <ExportButton
              name="products"
              count={results.length}
              build={() => buildProductsSheets({ products: results, categories, t, pick })}
            />
            {/* The combinations behind the rollups — hidden entirely when the
                catalogue holds none, so the button never exports an empty file. */}
            {variants.length > 0 ? (
              <ExportButton
                name="variants"
                count={variants.length}
                build={() =>
                  buildVariantsSheet({ variants, products, t, pick })
                }
              />
            ) : null}
            <Link
              to="/products/new"
              className="alyq-btn-primary alyq-cta h-10 gap-2 rounded-xl px-4 text-sm"
            >
              <PlusIcon />
              {t("products.add")}
            </Link>
          </>
        }
      />

      <div className="mb-4 grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        <StatTile
          label={t("products.title")}
          value={String(stats.total)}
          tone="primary"
          icon={<BoxIcon />}
          hint={t("products.subtitle")}
        />
        <StatTile
          label={t("common.active")}
          value={String(stats.active)}
          tone="success"
          hint={`${t("common.inactive")}: ${stats.inactive}`}
        />
        <StatTile
          label={t("products.lowStockBadge")}
          value={String(stats.lowStock)}
          tone="warning"
          hint={`${t("products.outOfStock")}: ${stats.outOfStock}`}
        />
        <StatTile
          label={t("products.featuredBadge")}
          value={String(stats.featured)}
          tone="info"
          hint={`${t("products.hiddenOnWebsite")}: ${stats.hiddenOnWebsite}`}
        />
      </div>

      <div className="space-y-4">
        <ProductFilters value={filters} onChange={updateFilters} resultCount={results.length} />

        {error ? (
          <ErrorState
            title={t("products.errorLoad")}
            message={error.message}
            retryLabel={t("common.retry")}
            onRetry={() => void refresh()}
          />
        ) : loading ? (
          <div className="alyq-card">
            <LoadingBlock label={t("common.loading")} />
          </div>
        ) : (
          <ProductTable
            products={visible}
            categoryName={categoryName}
            onToggleActive={handleToggle}
            onDelete={handleDelete}
            references={productReferences}
            busyId={busyId}
            emptyState={
              <div className="alyq-card">
                <EmptyState
                  icon={products.length === 0 ? "📦" : "🔍"}
                  title={products.length === 0 ? t("products.empty") : t("common.noResults")}
                  description={
                    products.length === 0 ? t("products.emptyHint") : t("common.noResultsHint")
                  }
                  action={
                    products.length === 0 ? (
                      <Link
                        to="/products/new"
                        className="alyq-btn-primary alyq-cta h-10 gap-2 rounded-xl px-4 text-sm"
                      >
                        <PlusIcon />
                        {t("products.add")}
                      </Link>
                    ) : (
                      <Button variant="secondary" onClick={() => updateFilters(EMPTY_FILTERS)}>
                        {t("common.clear")}
                      </Button>
                    )
                  }
                />
              </div>
            }
          />
        )}

        {/* Pagination */}
        {results.length > 0 ? (
          <div className="flex flex-wrap items-center justify-between gap-3 alyq-card px-3 py-2.5 text-xs font-semibold text-slate-700">
            <span className="tabular-nums">
              {t("products.showing", {
                from: (currentPage - 1) * pageSize + 1,
                to: Math.min(currentPage * pageSize, results.length),
                total: results.length,
              })}
            </span>
            <div className="flex items-center gap-2">
              <SelectInput
                value={String(pageSize)}
                onChange={(event) => {
                  setPageSize(Number(event.target.value));
                  setPage(1);
                }}
                className="h-8 w-auto py-1 text-xs"
                aria-label={t("productsPerPage")}
              >
                {[10, 20, 50].map((size) => (
                  <option key={size} value={size}>
                    {size} {t("common.rows")}
                  </option>
                ))}
              </SelectInput>
              <Button
                variant="secondary"
                size="sm"
                disabled={currentPage <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              >
                ‹ {t("products.prev")}
              </Button>
              <span className="tabular-nums">
                {currentPage} / {totalPages}
              </span>
              <Button
                variant="secondary"
                size="sm"
                disabled={currentPage >= totalPages}
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              >
                {t("products.next")} ›
              </Button>
            </div>
          </div>
        ) : null}

        {mode === "demo" ? (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-dashed border-amber-400 bg-amber-50 px-3 py-2.5 text-xs font-semibold text-amber-900">
            <span>{t("mode.demoHint")}</span>
            <Button variant="secondary" size="sm" onClick={() => void resetDemo()}>
              {t("common.reset")}
            </Button>
          </div>
        ) : null}
      </div>

      <ConfirmDialog
        open={Boolean(pending)}
        title={pending?.active ? t("products.deleteConfirmTitle") : t("products.restoreConfirmTitle")}
        body={t(
          pending?.active ? "products.deleteConfirmBody" : "products.restoreConfirmBody",
          { name: pending ? pick(pending.name_ar, pending.name_en) : "" },
        )}
        confirmLabel={pending?.active ? t("common.archive") : t("common.restore")}
        tone={pending?.active ? "danger" : "primary"}
        loading={Boolean(pending && busyId === pending.id)}
        onCancel={() => setPending(null)}
        onConfirm={() => void confirmToggle()}
      />
      <ConfirmDialog
        open={Boolean(pendingDelete)}
        title={t("products.permanentDeleteTitle")}
        body={t("products.permanentDeleteBody", {
          name: pendingDelete ? pick(pendingDelete.name_ar, pendingDelete.name_en) : "",
        })}
        confirmLabel={t("products.permanentDelete")}
        tone="danger"
        loading={Boolean(pendingDelete && busyId === pendingDelete.id)}
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => void confirmDelete()}
      />
      {importOpen && (
        <Suspense fallback={null}>
          <ExcelImportModal
            open={importOpen}
            onClose={() => setImportOpen(false)}
            products={products}
            categories={categories}
            onImportComplete={() => void refresh()}
          />
        </Suspense>
      )}
      <span className="sr-only">{tPlural("products.count", results.length)}</span>
    </div>
  );
}
