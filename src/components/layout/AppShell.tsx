import { useEffect, useState } from "react";
import { Link, NavLink, useLocation } from "react-router-dom";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { useCatalog } from "@/modules/products/hooks/CatalogProvider";
import { useInventory } from "@/modules/inventory/hooks/InventoryProvider";
import { canViewAuditLog } from "@/modules/shifts/permissions";
import { cn } from "@/utils/cn";
import {
  BoxIcon,
  ChevronIcon,
  CloseIcon,
  GlobeIcon,
  GridIcon,
  HistoryIcon,
  LayersIcon,
  MenuIcon,
  ReceiptIcon,
  RotateCcwIcon,
  ShoppingCartIcon,
  UsersIcon,
  WarehouseIcon,
  WalletIcon,
  ClockIcon,
  ClipboardIcon,
} from "@/components/ui";

function NavItem({
  to,
  icon,
  label,
  end,
}: {
  to: string;
  icon: React.ReactNode;
  label: string;
  end?: boolean;
}) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        cn(
          "flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors",
          isActive
            ? "bg-indigo-600 text-white shadow-sm shadow-indigo-200"
            : "text-slate-700 hover:bg-slate-100 hover:text-slate-900",
        )
      }
    >
      <span aria-hidden className="shrink-0">
        {icon}
      </span>
      <span className="truncate">{label}</span>
    </NavLink>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const { t, lang, toggleLang } = useI18n();
  const { mode } = useCatalog();
  // Sidebar visibility follows the acting role (lead/oversight entries hide).
  const { user } = useInventory();
  const canViewAudit = canViewAuditLog(user);
  const location = useLocation();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    setOpen(false);
  }, [location.pathname]);

  const sidebar = (
    <div className="flex h-full flex-col gap-6 overflow-hidden p-4">
      <Link to="/" className="flex shrink-0 items-center gap-3 px-1">
        <span className="flex h-10 w-10 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-500 to-violet-600 text-white shadow-md shadow-indigo-200">
          <BoxIcon />
        </span>
        <span className="min-w-0">
          <span className="block truncate text-sm font-semibold text-slate-900">{t("app.name")}</span>
          <span className="block truncate text-[11px] font-medium text-slate-600">{t("app.tagline")}</span>
        </span>
      </Link>

      <nav className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto">
        <p className="px-3 pb-1 text-[10px] font-bold uppercase tracking-widest text-slate-500">
          {t("nav.phase1")}
        </p>
        <NavItem to="/" icon={<GridIcon />} label={t("nav.dashboard")} end />

        <p className="px-3 pb-1 pt-4 text-[10px] font-bold uppercase tracking-widest text-slate-500">
          {t("nav.catalog")}
        </p>
        <NavItem to="/products" icon={<BoxIcon />} label={t("nav.products")} />
        <NavItem to="/categories" icon={<LayersIcon />} label={t("nav.categories")} />

        <p className="px-3 pb-1 pt-4 text-[10px] font-bold uppercase tracking-widest text-slate-500">
          {t("app.phase3")}
        </p>
        <NavItem to="/inventory" icon={<WarehouseIcon />} label={t("nav.inventory")} />
        <NavItem to="/inventory/movements" icon={<HistoryIcon />} label={t("nav.movements")} />

        <p className="px-3 pb-1 pt-4 text-[10px] font-bold uppercase tracking-widest text-slate-500">
          {t("nav.salesOps")}
        </p>
        <NavItem to="/pos" icon={<ShoppingCartIcon />} label={t("nav.register")} />
        <NavItem to="/pos/sales" icon={<ReceiptIcon />} label={t("nav.sales")} />
        <NavItem to="/customers" icon={<UsersIcon />} label={t("nav.customers")} />
        <NavItem to="/returns" icon={<RotateCcwIcon />} label={t("nav.returns")} />
        <NavItem to="/refunds" icon={<RotateCcwIcon />} label={t("nav.refunds")} />

        <p className="px-3 pb-1 pt-4 text-[10px] font-bold uppercase tracking-widest text-slate-500">
          {t("app.phase8")}
        </p>
        <NavItem to="/shifts" icon={<WalletIcon />} label={t("nav.shiftDashboard")} end />
        <NavItem to="/shifts/history" icon={<ClockIcon />} label={t("nav.shiftHistory")} />
        <NavItem to="/expenses" icon={<ReceiptIcon />} label={t("nav.expenses")} />
        {canViewAudit ? (
          <NavItem to="/audit" icon={<ClipboardIcon />} label={t("nav.audit")} />
        ) : null}
      </nav>

      <div className="shrink-0 rounded-2xl border border-slate-200 bg-slate-50 p-3">
        <p className="flex items-center gap-2 text-xs font-bold text-slate-800">
          <span
            className={cn(
              "h-2 w-2 rounded-full",
              mode === "supabase" ? "bg-emerald-500" : "bg-amber-500",
            )}
          />
          {mode === "supabase" ? t("mode.live") : t("mode.demo")}
        </p>
        <p className="mt-1 text-[11px] font-medium leading-relaxed text-slate-600">
          {mode === "supabase" ? t("mode.liveHint") : t("mode.demoHint")}
        </p>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      {/* Desktop sidebar */}
      <aside className="fixed inset-y-0 hidden w-64 border-e border-slate-200 bg-white lg:block">
        {sidebar}
      </aside>

      {/* Mobile drawer */}
      {open ? (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-slate-900/40" onClick={() => setOpen(false)} aria-hidden />
          <aside className="absolute inset-y-0 w-[17.5rem] max-w-[85vw] bg-white shadow-xl">
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label={t("common.close")}
              className="absolute end-3 top-3 flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100"
            >
              <CloseIcon />
            </button>
            {sidebar}
          </aside>
        </div>
      ) : null}

      <div className="lg:ps-64">
        <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b border-slate-200 bg-white/90 px-3 backdrop-blur sm:px-5">
          <button
            type="button"
            onClick={() => setOpen(true)}
            aria-label={t("nav.menu")}
            className="flex h-9 w-9 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 lg:hidden"
          >
            <MenuIcon />
          </button>

          <div className="min-w-0 flex-1">
            <p className="truncate text-xs font-semibold text-slate-700">{t("app.phase")}</p>
          </div>

          <button
            type="button"
            onClick={toggleLang}
            className="inline-flex h-9 items-center gap-1.5 rounded-xl border border-slate-300 bg-white px-3 text-xs font-semibold text-slate-800 hover:bg-slate-50"
            title={t("mode.switch")}
          >
            <GlobeIcon />
            {lang === "ar" ? "English" : "العربية"}
          </button>
          <span className="hidden items-center gap-1 rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700 sm:inline-flex">
            {mode === "supabase" ? t("mode.live") : t("mode.demo")}
            <ChevronIcon className="h-3 w-3 -rotate-90 text-slate-300" />
          </span>
        </header>

        <main className="mx-auto w-full max-w-7xl px-3 py-4 sm:px-6 sm:py-6 lg:px-8">{children}</main>
      </div>
    </div>
  );
}

export function PageHeader({
  title,
  subtitle,
  actions,
  backTo,
  backLabel,
}: {
  title: string;
  subtitle?: string;
  actions?: React.ReactNode;
  backTo?: string;
  backLabel?: string;
}) {
  return (
    <div className="mb-5 space-y-3">
      {backTo ? (
        <Link
          to={backTo}
          className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-600 hover:text-indigo-600"
        >
          <ChevronIcon className="h-3.5 w-3.5 rotate-180 rtl:rotate-0" />
          {backLabel}
        </Link>
      ) : null}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-xl font-bold tracking-tight text-slate-900 sm:text-2xl">{title}</h1>
          {subtitle ? <p className="mt-1 text-sm font-medium text-slate-600">{subtitle}</p> : null}
        </div>
        {actions ? (
          <div className="flex flex-wrap items-center gap-2 max-sm:w-full">
            {actions}
          </div>
        ) : null}
      </div>
    </div>
  );
}
