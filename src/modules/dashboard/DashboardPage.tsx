import { Link } from "react-router-dom";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { PageHeader } from "@/components/layout/AppShell";
import { Badge, BoxIcon, Card, LayersIcon, PlusIcon, StatTile } from "@/components/ui";
import { useCatalog } from "@/modules/products/hooks/CatalogProvider";
import { summarize } from "@/modules/products/services/productQuery";

/**
 * Phase 1 dashboard. Intentionally left untouched apart from read-only
 * catalog counters so Phase 2 stays additive.
 */
export function DashboardPage() {
  const { t } = useI18n();
  const { products, categories, mode } = useCatalog();
  const stats = summarize(products, categories);

  return (
    <div>
      <PageHeader
        title={t("nav.dashboard")}
        subtitle={t("app.phase")}
        actions={<Badge tone={mode === "supabase" ? "success" : "warning"}>
          {mode === "supabase" ? t("mode.live") : t("mode.demo")}
        </Badge>}
      />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label={t("products.title")} value={String(stats.total)} tone="primary" icon={<BoxIcon />} />
        <StatTile label={t("common.active")} value={String(stats.active)} tone="success" />
        <StatTile label={t("common.inactive")} value={String(stats.inactive)} tone="warning" />
        <StatTile label={t("nav.categories")} value={String(stats.activeCategories)} tone="info" />
      </div>

      <Card className="mt-4">
        <div className="flex flex-wrap items-start gap-4">
          <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-indigo-50 text-indigo-600">
            <LayersIcon />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-bold text-slate-900">{t("nav.catalog")}</h2>
            <p className="mt-1 max-w-2xl text-sm font-medium text-slate-600">{t("common.dashboardSoon")}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Link
              to="/products"
              className="alyq-btn-primary alyq-cta h-10 gap-2 rounded-xl px-4 text-sm"
            >
              {t("nav.products")}
            </Link>
            <Link
              to="/products/new"
              className="inline-flex h-10 items-center gap-2 rounded-xl bg-white px-4 text-sm font-semibold text-slate-800 ring-1 ring-slate-300 hover:bg-slate-50"
            >
              <PlusIcon />
              {t("products.add")}
            </Link>
          </div>
        </div>
      </Card>
    </div>
  );
}
