import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { can } from "@/lib/permissions/enforce";
import { pathPermits } from "@/lib/permissions/routes";
import { cn } from "@/utils/cn";
import {
  ArchiveIcon,
  BoxIcon,
  ClipboardIcon,
  CloseIcon,
  GlobeIcon,
  GridIcon,
  HistoryIcon,
  LayersIcon,
  PlusCircleIcon,
  ReceiptIcon,
  ReportIcon,
  RotateCcwIcon,
  ShoppingCartIcon,
  WalletIcon,
} from "@/components/ui";

interface MobilePosBottomNavProps {
  pendingOrders: number;
  pendingApprovals: number;
  unreadNotifications: number;
  syncAttentionCount: number;
}

interface ModuleLinkItem {
  key: string;
  to: string;
  labelAr: string;
  labelEn: string;
  descAr: string;
  descEn: string;
  icon: React.ReactNode;
  badge?: number;
  visible: boolean;
}

export function MobilePosBottomNav({
  pendingOrders,
  pendingApprovals,
  unreadNotifications,
  syncAttentionCount,
}: MobilePosBottomNavProps) {
  const { lang, dir } = useI18n();
  const ar = lang === "ar";
  const location = useLocation();
  const [sheetOpen, setSheetOpen] = useState(false);

  const canOpen = (path: string) => pathPermits(path, (permission) => can(permission));

  useEffect(() => {
    setSheetOpen(false);
  }, [location.pathname, location.search]);

  const isDashboardActive = location.pathname === "/dashboard" || location.pathname === "/dashboard/";
  const isPosActive = location.pathname === "/dashboard/pos" || location.pathname === "/pos";
  const isOrdersActive = location.pathname.startsWith("/dashboard/online/orders");
  const isStockActive = location.pathname.startsWith("/dashboard/inventory");

  const totalMoreBadges = pendingApprovals + unreadNotifications + syncAttentionCount;

  const sections: Array<{
    key: string;
    titleAr: string;
    titleEn: string;
    items: ModuleLinkItem[];
  }> = [
    {
      key: "pos-sales",
      titleAr: "الكاشير والمبيعات",
      titleEn: "POS & Sales",
      items: [
        {
          key: "pos",
          to: "/dashboard/pos",
          labelAr: "شاشة الكاشير (POS)",
          labelEn: "POS Register",
          descAr: "بيع سريع، مسح باركود بالكاميرا، ودفع نقدي أو إنستاباي",
          descEn: "Fast checkout, camera barcode scan, Cash & InstaPay",
          icon: <ShoppingCartIcon />,
          visible: canOpen("/dashboard/pos"),
        },
        {
          key: "invoices",
          to: "/dashboard/pos/sales",
          labelAr: "الفواتير والمبيعات",
          labelEn: "Sales & Invoices",
          descAr: "بحث وطباعة الفواتير ومراجعة المدفوعات",
          descEn: "Search, inspect and print sales receipts",
          icon: <ReceiptIcon />,
          visible: canOpen("/dashboard/pos/sales"),
        },
        {
          key: "returns",
          to: "/dashboard/returns",
          labelAr: "المرتجعات",
          labelEn: "Returns",
          descAr: "تسجيل مرتجعات الفواتير وإعادة المخزون",
          descEn: "Process customer returns and restock lines",
          icon: <RotateCcwIcon />,
          visible: canOpen("/dashboard/returns"),
        },
        {
          key: "refunds",
          to: "/dashboard/refunds",
          labelAr: "الاستردادات المالية",
          labelEn: "Refunds",
          descAr: "صرف ومتابعة مبالغ المرتجعات",
          descEn: "Settle and track customer refunds",
          icon: <WalletIcon />,
          visible: canOpen("/dashboard/refunds"),
        },
        {
          key: "sync",
          to: "/dashboard/sync",
          labelAr: "مزامنة العمل دون اتصال",
          labelEn: "Offline POS Sync",
          descAr: "طابور العمليات المعلقة ومعالجة التعارضات",
          descEn: "Pending offline sales queue and conflict resolution",
          icon: <HistoryIcon />,
          badge: syncAttentionCount,
          visible: canOpen("/dashboard/sync"),
        },
      ],
    },
    {
      key: "catalog-inventory",
      titleAr: "المنتجات والباركود والمخزون",
      titleEn: "Products, Barcode & Inventory",
      items: [
        {
          key: "products",
          to: "/dashboard/products",
          labelAr: "المنتجات والباركود",
          labelEn: "Products & Barcodes",
          descAr: "إدارة الأصناف، الأسعار، المتغيرات وطباعة الباركود",
          descEn: "Manage catalog, variants, prices and barcode labels",
          icon: <BoxIcon />,
          visible: canOpen("/dashboard/products"),
        },
        {
          key: "new-product",
          to: "/dashboard/products/new",
          labelAr: "إضافة منتج جديد",
          labelEn: "Add New Product",
          descAr: "إنشاء صنف جديد مع SKU وباركود تلقائي",
          descEn: "Create product with auto SKU and Code 128 barcode",
          icon: <PlusCircleIcon />,
          visible: canOpen("/dashboard/products/new"),
        },
        {
          key: "categories",
          to: "/dashboard/categories",
          labelAr: "التصنيفات",
          labelEn: "Categories",
          descAr: "تنظيم أقسام وتصنيفات المنتجات",
          descEn: "Organize product categories",
          icon: <LayersIcon />,
          visible: canOpen("/dashboard/categories"),
        },
        {
          key: "stock",
          to: "/dashboard/inventory/stock",
          labelAr: "أرصدة المخزون والأرفف",
          labelEn: "Stock & Exact Shelves",
          descAr: "الكميات الفعلية لكل مقاس ولون والتسويات المخزنية",
          descEn: "Live branch shelves by variant and stock adjustments",
          icon: <LayersIcon />,
          visible: canOpen("/dashboard/inventory/stock"),
        },
        {
          key: "stocktake",
          to: "/dashboard/inventory/stocktake",
          labelAr: "الجرد الفعلي للمخزون",
          labelEn: "Physical Stocktake",
          descAr: "جلسات الجرد ومطابقة الأرصدة الفعلية",
          descEn: "Count sessions and stock variance reconciliation",
          icon: <ClipboardIcon />,
          visible: canOpen("/dashboard/inventory/stocktake"),
        },
        {
          key: "movements",
          to: "/dashboard/inventory/movements",
          labelAr: "حركات وتحويلات المخزون",
          labelEn: "Stock Movements",
          descAr: "سجل الوارد والمنصرف والتسويات والتحويلات",
          descEn: "Complete ledger of stock movements and transfers",
          icon: <HistoryIcon />,
          visible: canOpen("/dashboard/inventory/movements"),
        },
      ],
    },
    {
      key: "customers-online",
      titleAr: "العملاء والمتجر الإلكتروني",
      titleEn: "Customers & Online Store",
      items: [
        {
          key: "customers",
          to: "/dashboard/customers",
          labelAr: "سجل العملاء",
          labelEn: "Customers",
          descAr: "بيانات العملاء وسجل مشترياتهم",
          descEn: "Customer directory and purchase history",
          icon: <ClipboardIcon />,
          visible: canOpen("/dashboard/customers"),
        },
        {
          key: "online-orders",
          to: "/dashboard/online/orders",
          labelAr: "طلبات الأونلاين",
          labelEn: "Online Orders",
          descAr: "قبول وتجهيز طلبات الموقع ومراجعة الدفع",
          descEn: "Approve, fulfill and verify website orders",
          icon: <GlobeIcon />,
          badge: pendingOrders,
          visible: canOpen("/dashboard/online/orders"),
        },
        {
          key: "reservations",
          to: "/dashboard/online/reservations",
          labelAr: "حجوزات المخزون",
          labelEn: "Stock Holds",
          descAr: "متابعة القطع المحجوزة لطلبات المتجر",
          descEn: "Inspect and reconcile online stock reservations",
          icon: <LayersIcon />,
          visible: canOpen("/dashboard/online/reservations"),
        },
        {
          key: "online-hub",
          to: "/dashboard/online",
          labelAr: "إدارة المتجر والتسويق",
          labelEn: "Storefront & Marketing",
          descAr: "إعدادات الموقع، مناطق التوصيل، الكوبونات والعروض",
          descEn: "Website settings, delivery zones, promos and content",
          icon: <GlobeIcon />,
          visible: canOpen("/dashboard/online") || can("website.manage"),
        },
      ],
    },
    {
      key: "shifts-finance-reports",
      titleAr: "الورديات والمصروفات والتقارير",
      titleEn: "Shifts, Expenses & Reports",
      items: [
        {
          key: "shifts",
          to: "/dashboard/shifts",
          labelAr: "الوردية والخزينة",
          labelEn: "Active Shift & Drawer",
          descAr: "فتح وإغلاق الوردية وإيداع/سحب النقدية",
          descEn: "Open/close shift, cash-in and cash-out",
          icon: <WalletIcon />,
          visible: canOpen("/dashboard/shifts"),
        },
        {
          key: "expenses",
          to: "/dashboard/expenses",
          labelAr: "المصروفات",
          labelEn: "Expenses",
          descAr: "تسجيل ومراجعة مصروفات الفرع والوردية",
          descEn: "Record and review branch & shift expenses",
          icon: <ReceiptIcon />,
          visible: canOpen("/dashboard/expenses"),
        },
        {
          key: "eod",
          to: "/dashboard/shifts/eod",
          labelAr: "تقرير إغلاق اليومية (EOD)",
          labelEn: "End of Day (EOD)",
          descAr: "ملخص النقدية والمبيعات والتسويات اليومية",
          descEn: "Daily cash reconciliation and Z-report summary",
          icon: <ReportIcon />,
          visible: canOpen("/dashboard/shifts/eod"),
        },
        {
          key: "reports",
          to: "/dashboard/reports",
          labelAr: "التقارير المالية والمبيعات",
          labelEn: "Reports & Analytics",
          descAr: "تقارير المبيعات، الأرباح، المخزون والموردين",
          descEn: "Sales, financial, inventory and supplier reports",
          icon: <ReportIcon />,
          visible: canOpen("/dashboard/reports"),
        },
      ],
    },
    {
      key: "system-admin",
      titleAr: "الموافقات والإشعارات والإعدادات",
      titleEn: "Approvals, Notifications & Settings",
      items: [
        {
          key: "approvals",
          to: "/dashboard/approvals",
          labelAr: "موافقات المدير",
          labelEn: "Manager Approvals",
          descAr: "طلبات الخصومات والمرتجعات والمصروفات فوق الحد",
          descEn: "Approve or reject over-limit requests",
          icon: <ClipboardIcon />,
          badge: pendingApprovals,
          visible: true,
        },
        {
          key: "notifications",
          to: "/dashboard/notifications",
          labelAr: "مركز الإشعارات",
          labelEn: "Notification Center",
          descAr: "جميع التنبيهات الفورية وإعدادات إشعارات الهاتف",
          descEn: "Operational alerts and push notification settings",
          icon: <GlobeIcon />,
          badge: unreadNotifications,
          visible: true,
        },
        {
          key: "health",
          to: "/dashboard/system-health",
          labelAr: "صحة النظام والتشخيص",
          labelEn: "System Health",
          descAr: "فحص الاتصال بـ Supabase وحالة المزامنة والفرع",
          descEn: "Verify Supabase connectivity, schema and runtime health",
          icon: <ClipboardIcon />,
          visible: canOpen("/dashboard/system-health"),
        },
        {
          key: "settings",
          to: "/dashboard/settings",
          labelAr: "الإعدادات والمستخدمون والصلاحيات",
          labelEn: "Settings, Users & Roles",
          descAr: "المستخدمون، الأدوار، الفروع، الكاشيرات، النسخ الاحتياطي والعتاد",
          descEn: "Users, roles, branches, registers, backups & hardware",
          icon: <ArchiveIcon />,
          visible:
            can("users.manage") ||
            can("roles.manage") ||
            can("settings.manage") ||
            canOpen("/dashboard/settings/backup") ||
            canOpen("/dashboard/settings/operations") ||
            canOpen("/dashboard/audit") ||
            can("website.manage"),
        },
        {
          key: "legacy-mobile",
          to: "/mobile",
          labelAr: "واجهة الإدارة المصغّرة (Mobile Quick View)",
          labelEn: "Mobile Management Quick View",
          descAr: "الانتقال إلى واجهة المتابعة السريعة القديمة (/mobile)",
          descEn: "Open the compact Mobile Management view (/mobile)",
          icon: <GridIcon />,
          visible: true,
        },
      ],
    },
  ];

  return (
    <>
      {/* Fixed Bottom Navigation Bar for Phone & Tablet (< lg) */}
      <nav
        dir={dir}
        aria-label={ar ? "التنقل السريع للهاتف" : "Mobile POS Navigation"}
        data-testid="mobile-pos-bottom-nav"
        className="fixed inset-x-0 bottom-0 z-40 border-t border-stone-200 bg-white/95 px-1.5 pt-1 pb-[max(0.35rem,env(safe-area-inset-bottom,0px))] shadow-[0_-4px_16px_rgba(15,23,42,0.06)] backdrop-blur lg:hidden"
      >
        <div className="mx-auto grid max-w-lg grid-cols-5 items-center gap-1">
          <Link
            to="/dashboard"
            data-testid="mobile-pos-tab-dashboard"
            className={cn(
              "flex min-h-[3.35rem] flex-col items-center justify-center gap-0.5 rounded-2xl px-1 text-[11px] font-bold transition",
              isDashboardActive ? "bg-stone-900 text-[#f3ede1]" : "text-stone-600 hover:bg-stone-100",
            )}
          >
            <GridIcon className="h-4 w-4" />
            <span className="truncate">{ar ? "الرئيسية" : "Home"}</span>
          </Link>

          {canOpen("/dashboard/pos") ? (
            <Link
              to="/dashboard/pos"
              data-testid="mobile-pos-tab-pos"
              className={cn(
                "flex min-h-[3.35rem] flex-col items-center justify-center gap-0.5 rounded-2xl px-1 text-[11px] font-black transition",
                isPosActive
                  ? "bg-[#b08d57] text-[#161311] shadow-sm"
                  : "bg-stone-900/90 text-[#f3ede1] hover:bg-stone-900",
              )}
            >
              <ShoppingCartIcon className="h-4 w-4" />
              <span className="truncate">{ar ? "الكاشير" : "POS"}</span>
            </Link>
          ) : (
            <Link
              to="/dashboard/pos/sales"
              data-testid="mobile-pos-tab-sales"
              className={cn(
                "flex min-h-[3.35rem] flex-col items-center justify-center gap-0.5 rounded-2xl px-1 text-[11px] font-bold transition",
                location.pathname.startsWith("/dashboard/pos/sales")
                  ? "bg-stone-900 text-[#f3ede1]"
                  : "text-stone-600 hover:bg-stone-100",
              )}
            >
              <ReceiptIcon className="h-4 w-4" />
              <span className="truncate">{ar ? "الفواتير" : "Sales"}</span>
            </Link>
          )}

          <Link
            to="/dashboard/online/orders"
            data-testid="mobile-pos-tab-orders"
            className={cn(
              "relative flex min-h-[3.35rem] flex-col items-center justify-center gap-0.5 rounded-2xl px-1 text-[11px] font-bold transition",
              isOrdersActive ? "bg-stone-900 text-[#f3ede1]" : "text-stone-600 hover:bg-stone-100",
            )}
          >
            <GlobeIcon className="h-4 w-4" />
            <span className="truncate">{ar ? "الطلبات" : "Orders"}</span>
            {pendingOrders > 0 ? (
              <span className="absolute end-2 top-1 grid h-4 min-w-4 place-items-center rounded-full bg-[#b08d57] px-1 text-[9px] font-black text-white">
                {pendingOrders > 99 ? "99+" : pendingOrders}
              </span>
            ) : null}
          </Link>

          <Link
            to="/dashboard/inventory/stock"
            data-testid="mobile-pos-tab-stock"
            className={cn(
              "flex min-h-[3.35rem] flex-col items-center justify-center gap-0.5 rounded-2xl px-1 text-[11px] font-bold transition",
              isStockActive ? "bg-stone-900 text-[#f3ede1]" : "text-stone-600 hover:bg-stone-100",
            )}
          >
            <LayersIcon className="h-4 w-4" />
            <span className="truncate">{ar ? "المخزون" : "Stock"}</span>
          </Link>

          <button
            type="button"
            onClick={() => setSheetOpen((open) => !open)}
            aria-expanded={sheetOpen}
            data-testid="mobile-pos-modules-trigger"
            className={cn(
              "relative flex min-h-[3.35rem] flex-col items-center justify-center gap-0.5 rounded-2xl px-1 text-[11px] font-bold transition",
              sheetOpen ? "bg-stone-900 text-[#f3ede1]" : "text-stone-600 hover:bg-stone-100",
            )}
          >
            <BoxIcon className="h-4 w-4" />
            <span className="truncate">{ar ? "الوحدات" : "Modules"}</span>
            {totalMoreBadges > 0 ? (
              <span className="absolute end-2 top-1 grid h-4 min-w-4 place-items-center rounded-full bg-rose-600 px-1 text-[9px] font-black text-white">
                {totalMoreBadges > 99 ? "99+" : totalMoreBadges}
              </span>
            ) : null}
          </button>
        </div>
      </nav>

      {/* All POS Modules Bottom Sheet */}
      {sheetOpen ? (
        <div dir={dir} className="fixed inset-0 z-50 lg:hidden" data-testid="mobile-pos-modules-sheet">
          <div
            className="absolute inset-0 bg-stone-950/60 backdrop-blur-xs"
            onClick={() => setSheetOpen(false)}
            aria-hidden
          />
          <div
            role="dialog"
            aria-modal="true"
            aria-label={ar ? "جميع وحدات نظام ALYQ POS" : "All ALYQ POS Modules"}
            className="absolute inset-x-0 bottom-0 flex max-h-[86vh] flex-col overflow-hidden rounded-t-3xl bg-[#f4f6f8] shadow-2xl"
          >
            <div className="flex items-center justify-between border-b border-stone-200 bg-white px-4 py-3.5">
              <div>
                <p className="text-sm font-black text-stone-900">
                  {ar ? "جميع وحدات ALYQ Cloud POS" : "All ALYQ Cloud POS Modules"}
                </p>
                <p className="text-[11px] font-medium text-stone-500">
                  {ar ? "وصول سريع بلمسة واحدة لجميع خدمات النظام" : "One-tap touch access to every POS service"}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setSheetOpen(false)}
                aria-label={ar ? "إغلاق" : "Close"}
                data-testid="mobile-pos-modules-close"
                className="flex h-9 w-9 items-center justify-center rounded-xl bg-stone-100 text-stone-600 hover:bg-stone-200"
              >
                <CloseIcon />
              </button>
            </div>

            <div className="flex-1 space-y-5 overflow-y-auto p-4 pb-8">
              {sections.map((section) => {
                const visibleItems = section.items.filter((item) => item.visible);
                if (visibleItems.length === 0) return null;
                return (
                  <section key={section.key} className="space-y-2">
                    <h3 className="px-1 text-xs font-black uppercase tracking-wider text-stone-500">
                      {ar ? section.titleAr : section.titleEn}
                    </h3>
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                      {visibleItems.map((item) => (
                        <Link
                          key={item.key}
                          to={item.to}
                          onClick={() => setSheetOpen(false)}
                          data-testid={`mobile-module-link-${item.key}`}
                          className="flex items-center gap-3 rounded-2xl border border-stone-200/90 bg-white p-3 text-start shadow-xs transition active:scale-[0.99] hover:border-stone-300"
                        >
                          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-stone-900 text-[#dfc08a]">
                            {item.icon}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="flex items-center gap-2">
                              <strong className="truncate text-xs font-black text-stone-900">
                                {ar ? item.labelAr : item.labelEn}
                              </strong>
                              {item.badge && item.badge > 0 ? (
                                <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-black tabular-nums text-amber-900">
                                  {item.badge}
                                </span>
                              ) : null}
                            </span>
                            <span className="mt-0.5 block line-clamp-1 text-[11px] font-medium text-stone-500">
                              {ar ? item.descAr : item.descEn}
                            </span>
                          </span>
                          <span aria-hidden className="text-sm font-bold text-stone-400">
                            {ar ? "‹" : "›"}
                          </span>
                        </Link>
                      ))}
                    </div>
                  </section>
                );
              })}
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
