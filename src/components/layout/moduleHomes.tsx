/**
 * Phase 49 — the four module landing pages (Sales, Catalog, Inventory, Online).
 *
 * Each is a thin configuration of the generic ModuleHomePage: a lead sentence
 * and one card per real sub-screen, every card behind the same capability the
 * route guard reads. Nothing here invents a destination — if a screen exists,
 * its card points at its existing route, so every bookmark and test keeps
 * working. Customers and Reports need no landing of their own: their module
 * pages already ARE the hub (list with details; tabbed reports), so the
 * sidebar points straight at them.
 */
import { Navigate, useLocation } from "react-router-dom";
import { PageHeader } from "@/components/layout/AppShell";
import { ModuleHomePage } from "@/components/layout/ModuleHomePage";
import { useI18n } from "@/lib/i18n/I18nProvider";
import {
  ClipboardIcon,
  GlobeIcon,
  HistoryIcon,
  LayersIcon,
  ReceiptIcon,
  ReportIcon,
  RotateCcwIcon,
  WalletIcon,
  BoxIcon,
  EditIcon,
  PlusCircleIcon,
} from "@/components/ui";
import { useOnlineNotificationState } from "@/modules/online/hooks/OnlineNotificationsProvider";
import { useOptionalApprovals } from "@/modules/approvals";
import { canAct } from "@/lib/permissions/enforce";
import { importKindsAdmitted } from "@/modules/import/services/access";

export function SalesHome({ embedded = false }: { embedded?: boolean }) {
  const { t } = useI18n();
  const approvals = useOptionalApprovals();
  const pending = approvals?.summary.pending ?? 0;
  return (
    <ModuleHomePage
      embedded={embedded}
      crumbs={[{ label: t("home.management.title"), to: "/management" }, { label: t("home.breadcrumb.sales") }]}
      moduleKey="sales"
      title={embedded ? t("home.management.operations") : t("home.breadcrumb.sales")}
      subtitle={t("home.sales.subtitle")}
      cards={[
        {
          key: "invoices",
          to: "/pos/sales",
          icon: <ReceiptIcon />,
          title: t("nav.sales"),
          description: t("home.sales.invoices.desc"),
        },
        {
          key: "returns",
          to: "/returns",
          icon: <RotateCcwIcon />,
          title: t("nav.returns"),
          description: t("home.sales.returns.desc"),
        },
        {
          key: "refunds",
          to: "/refunds",
          icon: <RotateCcwIcon />,
          title: t("nav.refunds"),
          description: t("home.sales.refunds.desc"),
        },
        {
          key: "shifts",
          to: "/shifts",
          icon: <WalletIcon />,
          title: t("nav.shiftDashboard"),
          description: t("home.sales.shifts.desc"),
        },
        {
          key: "expenses",
          to: "/expenses",
          icon: <ReceiptIcon />,
          title: t("nav.expenses"),
          description: t("home.sales.expenses.desc"),
        },
        {
          key: "approvals",
          to: "/approvals",
          icon: <ClipboardIcon />,
          title: t("nav.approvals"),
          description: t("home.sales.approvals.desc"),
          badge: pending,
          badgeLabel: t("approvals.pendingHint"),
        },
        { key: "customers", to: "/customers", icon: <ClipboardIcon />, title: t("nav.customers"), description: t("home.management.customers") },
        { key: "shift-history", to: "/shifts/history", icon: <HistoryIcon />, title: t("nav.shiftHistory"), description: t("home.sales.shifts.desc") },
        { key: "shift-eod", to: "/shifts/eod", icon: <ReportIcon />, title: t("nav.shiftEod"), description: t("home.sales.eod.desc") },
      ]}
    />
  );
}

export function CatalogHome({ embedded = false }: { embedded?: boolean }) {
  const { t } = useI18n();
  const importOpen = importKindsAdmitted((capability) => canAct(capability)).length > 0;
  return (
    <ModuleHomePage
      embedded={embedded}
      crumbs={[{ label: t("home.management.title"), to: "/management" }, { label: t("home.breadcrumb.catalog") }]}
      moduleKey="catalog"
      title={t("home.breadcrumb.catalog")}
      subtitle={t("home.catalog.subtitle")}
      cards={[
        {
          key: "products",
          to: "/products",
          icon: <BoxIcon />,
          title: t("nav.products"),
          description: t("home.catalog.products.desc"),
        },
        {
          key: "categories",
          to: "/categories",
          icon: <LayersIcon />,
          title: t("nav.categories"),
          description: t("home.catalog.categories.desc"),
        },
        {
          key: "content",
          to: "/online/website?tab=productContent",
          capability: "manage_website",
          icon: <EditIcon />,
          title: t("online.ws.productContent"),
          description: t("home.catalog.content.desc"),
        },
        ...(importOpen
          ? [{
              key: "import",
              to: "/products/import",
              capability: "import_data" as const,
              icon: <PlusCircleIcon />,
              title: t("nav.importExport"),
              description: t("home.catalog.import.desc"),
            }]
          : []),
        { key: "media", to: "/online/website?tab=productContent", icon: <EditIcon />, title: t("home.management.media"), description: t("home.management.media.desc") },
      ]}
    />
  );
}

export function InventoryHome({ embedded = false }: { embedded?: boolean }) {
  const { t } = useI18n();
  const location = useLocation();
  if (!embedded && new URLSearchParams(location.search).has("status")) return <Navigate to={`/inventory/stock${location.search}`} replace />;
  return (
    <ModuleHomePage
      embedded={embedded}
      crumbs={[{ label: t("home.management.title"), to: "/management" }, { label: t("home.breadcrumb.inventory") }]}
      moduleKey="inventory"
      title={t("home.breadcrumb.inventory")}
      subtitle={t("home.inventory.subtitle")}
      cards={[
        {
          key: "overview",
          to: "/inventory/stock",
          icon: <LayersIcon />,
          title: t("nav.inventory"),
          description: t("home.inventory.overview.desc"),
        },
        {
          key: "low",
          to: "/inventory/stock?status=low",
          icon: <LayersIcon />,
          title: t("nav.lowStock"),
          description: t("home.inventory.low.desc"),
        },
        {
          key: "out",
          to: "/inventory/stock?status=out",
          icon: <LayersIcon />,
          title: t("nav.outOfStock"),
          description: t("home.inventory.out.desc"),
        },
        {
          key: "movements",
          to: "/inventory/movements",
          icon: <HistoryIcon />,
          title: t("nav.movements"),
          description: t("home.inventory.movements.desc"),
        },
        {
          key: "stocktake",
          to: "/inventory/stocktake",
          icon: <ClipboardIcon />,
          title: t("inventory.stocktake.title"),
          description: t("inventory.stocktake.subtitle"),
        },
        { key: "adjustments", to: "/inventory/stock", capability: "adjust_stock", icon: <EditIcon />, title: t("inventory.adjust"), description: t("home.management.adjustments") },
        { key: "suppliers", to: "/reports?section=suppliers", icon: <ClipboardIcon />, title: t("reports.suppliersTitle"), description: t("reports.suppliersHint") },
      ]}
    />
  );
}

export function OnlineHome() {
  const { t } = useI18n();
  const online = useOnlineNotificationState();
  return (
    <ModuleHomePage
      moduleKey="online"
      title={t("home.breadcrumb.online")}
      subtitle={t("home.online.subtitle")}
      cards={[
        {
          key: "orders",
          to: "/online/orders",
          capability: "manage_online_orders",
          icon: <GlobeIcon />,
          title: t("nav.onlineOrders"),
          description: t("home.online.orders.desc"),
          badge: online.counts.pending,
          badgeLabel:
            online.counts.needs_payment > 0
              ? t("nav.onlineOrdersBadgePayment", { count: online.counts.needs_payment })
              : t("nav.onlineOrdersBadge", { count: online.counts.pending }),
        },
        {
          key: "holds",
          to: "/online/reservations",
          capability: "manage_online_orders",
          icon: <LayersIcon />,
          title: t("nav.stockHolds"),
          description: t("home.online.holds.desc"),
          badge: online.holdAlertCount,
          badgeLabel: t("nav.stockHoldsBadge", { count: online.holdAlertCount }),
        },
        {
          key: "website",
          to: "/online/website",
          capability: "manage_website",
          icon: <EditIcon />,
          title: t("nav.websiteSettings"),
          description: t("home.online.website.desc"),
        },
        {
          key: "marketing",
          to: "/online/marketing",
          capability: "manage_website",
          icon: <PlusCircleIcon />,
          title: t("nav.marketing"),
          description: t("home.online.marketing.desc"),
        },
        {
          key: "content",
          to: "/online/content",
          capability: "manage_website",
          icon: <ClipboardIcon />,
          title: t("nav.websiteContent"),
          description: t("home.online.content.desc"),
        },
        {
          key: "delivery",
          to: "/online/website?tab=delivery",
          capability: "manage_website",
          icon: <WalletIcon />,
          title: t("online.ws.delivery"),
          description: t("home.online.delivery.desc"),
        },
        {
          key: "zones",
          to: "/online/zones",
          capability: "manage_website",
          icon: <GlobeIcon />,
          title: t("online.zones.title"),
          description: t("home.online.zones.desc"),
        },
        {
          key: "discounts",
          to: "/online/discounts",
          capability: "manage_website",
          icon: <PlusCircleIcon />,
          title: t("online.promos.title"),
          description: t("home.online.discounts.desc"),
        },
        {
          key: "promocodes",
          to: "/online/marketing",
          capability: "manage_website",
          icon: <EditIcon />,
          title: t("online.marketing.promoCodes"),
          description: t("home.online.promocodes.desc"),
        },
        {
          key: "reports",
          to: "/online/reports",
          capability: "manage_online_orders",
          icon: <ReportIcon />,
          title: t("nav.onlineReports"),
          description: t("home.online.reports.desc"),
        },
        ...(["social", "checkout", "confirmation"] as const).map((tab) => ({
          key: tab, to: `/online/website?tab=${tab}`, capability: "manage_website" as const,
          icon: <EditIcon />, title: t(`online.ws.${tab}`), description: t("home.online.configure"),
        })),
        { key: "verification", to: "/online/orders", icon: <WalletIcon />, title: t("home.online.verification"), description: t("home.online.verification.desc") },
      ]}
    />
  );
}

/** One operational workspace; the old module URLs remain valid bookmarks. */
export function StoreManagementHome() {
  const { t } = useI18n();
  return <div data-testid="module-management">
    <PageHeader title={t("home.management.title")} subtitle={t("home.management.subtitle")}
      crumbs={[{ label: t("nav.dashboard"), to: "/" }, { label: t("home.management.title") }]} />
    <div className="space-y-9">
      <CatalogHome embedded />
      <InventoryHome embedded />
      <SalesHome embedded />
    </div>
  </div>;
}
