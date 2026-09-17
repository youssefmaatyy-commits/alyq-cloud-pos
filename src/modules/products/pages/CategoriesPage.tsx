import { useMemo, useState } from "react";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { PageHeader } from "@/components/layout/AppShell";
import {
  Badge,
  Button,
  EmptyState,
  ErrorState,
  LoadingBlock,
  PlusIcon,
  StatTile,
} from "@/components/ui";
import { CategoryFormModal } from "../components/CategoryFormModal";
import { CategoryTree } from "../components/CategoryTree";
import { useCatalog } from "../hooks/CatalogProvider";
import { flattenCategoryTree } from "../services/categoryTree";

export function CategoriesPage() {
  const { t, pick } = useI18n();
  const { tree, products, categories, loading, error, refresh } = useCatalog();
  const [modal, setModal] = useState<{ open: boolean }>({ open: false });
  // Phase 44: archived categories are not gone — they live behind this filter
  // so they can be found and reactivated, without cluttering the working tree.
  const [view, setView] = useState<"active" | "archived" | "all">("active");

  const flat = useMemo(
    () => flattenCategoryTree(tree, { includeInactive: true }),
    [tree],
  );
  const visibleFlat = useMemo(() => {
    if (view === "all") return flat;
    return flat.filter((node) => (view === "archived" ? !node.active : node.active));
  }, [flat, view]);
  const uncategorized = useMemo(
    () => products.filter((p) => !p.category_id).length,
    [products],
  );
  const roots = tree.length;
  const activeCount = categories.filter((c) => c.active).length;
  const archivedCount = categories.length - activeCount;

  const viewTabs: { id: typeof view; label: string; count: number }[] = [
    { id: "active", label: t("categories.viewActive"), count: activeCount },
    { id: "archived", label: t("categories.viewArchived"), count: archivedCount },
    { id: "all", label: t("categories.viewAll"), count: categories.length },
  ];

  return (
    <div>
      <PageHeader
        title={t("categories.title")}
        subtitle={t("categories.subtitle")}
        actions={
          <>
            <Button variant="secondary" onClick={() => void refresh()}>
              ⟳
            </Button>
            <Button onClick={() => setModal({ open: true })}>
              <PlusIcon />
              {t("categories.add")}
            </Button>
          </>
        }
      />

      <div className="mb-4 grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        <StatTile label={t("categories.title")} value={String(categories.length)} />
        <StatTile label={t("common.active")} value={String(activeCount)} tone="success" />
        <StatTile label={t("categories.tree")} value={String(roots)} tone="info" />
        <StatTile
          label={t("products.withoutCategory")}
          value={String(uncategorized)}
          tone={uncategorized > 0 ? "warning" : "neutral"}
        />
      </div>

      {error ? (
        <ErrorState
          title={t("categories.errorLoad")}
          message={error.message}
          retryLabel={t("common.retry")}
          onRetry={() => void refresh()}
        />
      ) : loading ? (
        <div className="alyq-card">
          <LoadingBlock label={t("common.loading")} />
        </div>
      ) : tree.length === 0 ? (
        <div className="rounded-2xl border border-slate-200 bg-white">
          <EmptyState
            icon="🗂️"
            title={t("categories.empty")}
            description={t("categories.emptyHint")}
            action={
              <Button onClick={() => setModal({ open: true })}>
                <PlusIcon />
                {t("categories.add")}
              </Button>
            }
          />
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-3">
          <div className="alyq-card p-2 lg:col-span-2">
            <div
              className="flex flex-wrap items-center gap-1 px-2 pt-2"
              role="tablist"
              aria-label={t("common.filters")}
            >
              {viewTabs.map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  aria-selected={view === tab.id}
                  onClick={() => setView(tab.id)}
                  className={cnView(view === tab.id)}
                >
                  {tab.label}
                  <span className="ms-1 rounded-full bg-slate-200/80 px-1.5 text-[11px] font-bold tabular-nums text-slate-700">
                    {tab.count}
                  </span>
                </button>
              ))}
            </div>
            <CategoryTree view={view} />
          </div>

          <div className="space-y-3">
            <div className="alyq-card p-4">
              <h2 className="mb-2 text-sm font-bold text-slate-900">{t("categories.tree")}</h2>
              <ul className="space-y-1 text-sm font-medium text-slate-700">
                {visibleFlat.map((node) => (
                  <li key={node.id} className="flex items-center justify-between gap-2">
                    <span className="truncate">{pick(node.name_ar, node.name_en)}</span>
                    <span className="flex items-center gap-1">
                      <Badge tone={node.active ? "success" : "neutral"}>
                        {node.active ? t("common.active") : t("common.inactive")}
                      </Badge>
                      <span className="text-xs font-semibold tabular-nums text-slate-600">
                        {node.descendantProductCount}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            </div>

            <div className="alyq-card p-4 text-xs font-medium leading-relaxed text-slate-600">
              <p className="mb-2 font-bold text-slate-800">{t("common.filters")}</p>
              <ul className="space-y-2">
                <li className="flex items-start gap-2">
                  <span aria-hidden>ℹ️</span>
                  <span>{t("categories.sortHint")}</span>
                </li>
                <li className="flex items-start gap-2">
                  <span aria-hidden>🚫</span>
                  <span>{t("categories.deleteBlockedBody", { name: "…", count: 1 })}</span>
                </li>
                <li className="flex items-start gap-2">
                  <span aria-hidden>🔁</span>
                  <span>{t("categories.moveUnderSelf")}</span>
                </li>
              </ul>
              <p className="mt-3 border-t border-slate-200 pt-2 font-semibold text-slate-700">
                {t("categories.uncategorizedCount", { count: uncategorized })}
              </p>
            </div>
          </div>
        </div>
      )}

      <CategoryFormModal open={modal.open} onClose={() => setModal({ open: false })} />
    </div>
  );
}

/** Small local helper for the view tabs' active styling. */
function cnView(active: boolean): string {
  return [
    "rounded-lg px-2.5 py-1 text-xs font-semibold transition-colors",
    active
      ? "bg-indigo-600 text-white"
      : "bg-slate-100 text-slate-600 hover:bg-slate-200 hover:text-slate-900",
  ].join(" ");
}
