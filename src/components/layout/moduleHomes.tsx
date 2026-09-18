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

export function SalesHome() {
  const { t } = useI18n();
  const approvals = useOptionalApprovals();
  const pending = approvals?.summary.pending ?? 0;
  return (
    <ModuleHomePage
      moduleKey="sales"
      title={t("home.breadcrumb.sales")}
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
      ]}
    />
  );
}

export function CatalogHome() {
  const { t } = useI18n();
  return (
    <ModuleHomePage
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
          to: "/online/content",
          capability: "manage_website",
          icon: <EditIcon />,
          title: t("nav.websiteContent"),
          description: t("home.catalog.content.desc"),
        },
        {
          key: "import",
          to: "/products",
          icon: <PlusCircleIcon />,
          title: t("nav.importExport"),
          description: t("home.catalog.import.desc"),
        },
      ]}
    />
  );
}

export function InventoryHome() {
  const { t } = useI18n();
  return (
    <ModuleHomePage
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
          to: "/online/website",
          capability: "manage_website",
          icon: <WalletIcon />,
          title: t("online.ws.delivery"),
          description: t("home.online.delivery.desc"),
        },
        {
          key: "reports",
          to: "/online/reports",
          capability: "manage_online_orders",
          icon: <ReportIcon />,
          title: t("nav.onlineReports"),
          description: t("home.online.reports.desc"),
        },
      ]}
    />
  );
}
