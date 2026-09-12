import { useEffect, useState } from "react";
import { Link, NavLink, useLocation } from "react-router-dom";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { useCatalog } from "@/modules/products/hooks/CatalogProvider";
import { useInventory } from "@/modules/inventory/hooks/InventoryProvider";
import { useAuth } from "@/lib/auth";
import { ROLE_LABELS } from "@/lib/permissions/roles";
import { canAct } from "@/lib/permissions/enforce";
import { capabilityForPath } from "@/lib/permissions/routes";
import { useOnlineNotificationState } from "@/modules/online/hooks/OnlineNotificationsProvider";
import { useOptionalApprovals } from "@/modules/approvals";
import { RouteGuard } from "./RouteGuard";
import { cn } from "@/utils/cn";
import {
  ArchiveIcon,
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
  ReportIcon,
  EditIcon,
  PlusCircleIcon,
} from "@/components/ui";

/**
 * A sidebar entry.
 *
 * `badge` is a count the entry carries — currently only the online-orders queue,
 * where the number is the reason to look. It renders inside the link so it is
 * read as part of the destination, and it inverts on the active row rather than
 * staying amber on indigo.
 */
function NavItem({
  to,
  icon,
  label,
  end,
  visible = true,
  badge = 0,
  badgeLabel,
}: {
  to: string;
  icon: React.ReactNode;
  label: string;
  end?: boolean;
  visible?: boolean;
  badge?: number;
  badgeLabel?: string;
}) {
  if (!visible) return null;
  return (
    <NavLink
      to={to}
      end={end}
      title={badgeLabel}
      className={({ isActive }) =>
        cn(
          "flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors",
          isActive
            ? "bg-indigo-600 text-white shadow-sm shadow-indigo-200"
            : "text-slate-700 hover:bg-slate-100 hover:text-slate-900",
        )
      }
    >
      {/* Children as a function: the badge inverts on the active row, and only
          NavLink knows whether it is active. */}
      {({ isActive }) => (
        <>
          <span aria-hidden className="shrink-0">
            {icon}
          </span>
          <span className="truncate">{label}</span>
          {badge > 0 ? (
            <span
              className={cn(
                "ms-auto shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-black tabular-nums",
                isActive ? "bg-white text-indigo-700" : "bg-amber-100 text-amber-800",
              )}
            >
              {badge > 99 ? "99+" : badge}
            </span>
          ) : null}
        </>
      )}
    </NavLink>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const { t, lang, toggleLang } = useI18n();
  const { mode } = useCatalog();
  // Sidebar visibility follows the signed-in role: an entry is shown only when
  // the same capability table the route guard reads allows the screen.
  const { user } = useInventory();
  const { signOut, signOutEverywhere, endReason, user: sessionUser } = useAuth();
  const canOpen = (path: string) => {
    const required = capabilityForPath(path);
    // Resolved capabilities (custom roles included), so the sidebar and the
    // route guard cannot disagree about what this person may open.
    return !required || canAct(required);
  };
  const canManageOnline = canAct("manage_online_orders");
  const canManageWebsite = canAct("manage_website");
  const canManageUsers = canAct("manage_users");
  const canManageRoles = canAct("manage_roles");
  const canManageSettings = canAct("manage_settings");
  // Approval limits (Phase 12): the badge is the inbox's pending count, read
  // from the provider the shell is mounted inside. `useOptional` because the
  // storefront and the login screen render without it.
  const approvals = useOptionalApprovals();
  const pendingApprovals = approvals?.summary.pending ?? 0;
  // A custom role's name is what the person is called; the system label is the
  // fallback (and what the matrix calls the base role underneath).
  const roleLabel =
    sessionUser?.custom_role_name || ROLE_LABELS[user.role as keyof typeof ROLE_LABELS] || user.role;
  // One poller for the whole shell (see `OnlineNotificationsProvider`): the badge
  // below and the banner on the Online Orders screen read the same counts.
  const online = useOnlineNotificationState();
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
        <NavItem to="/inventory" icon={<WarehouseIcon />} label={t("nav.inventory")} visible={canOpen("/inventory")} />
        <NavItem to="/inventory/movements" icon={<HistoryIcon />} label={t("nav.movements")} visible={canOpen("/inventory/movements")} />

        <p className="px-3 pb-1 pt-4 text-[10px] font-bold uppercase tracking-widest text-slate-500">
          {t("nav.salesOps")}
        </p>
        <NavItem to="/pos" icon={<ShoppingCartIcon />} label={t("nav.register")} visible={canOpen("/pos")} />
        <NavItem to="/pos/sales" icon={<ReceiptIcon />} label={t("nav.sales")} visible={canOpen("/pos/sales")} />
        <NavItem to="/customers" icon={<UsersIcon />} label={t("nav.customers")} />
        <NavItem to="/returns" icon={<RotateCcwIcon />} label={t("nav.returns")} visible={canOpen("/returns")} />
        <NavItem to="/refunds" icon={<RotateCcwIcon />} label={t("nav.refunds")} visible={canOpen("/refunds")} />

        <p className="px-3 pb-1 pt-4 text-[10px] font-bold uppercase tracking-widest text-slate-500">
          {t("app.phase8")}
        </p>
        <NavItem to="/shifts" icon={<WalletIcon />} label={t("nav.shiftDashboard")} end visible={canOpen("/shifts")} />
        <NavItem to="/shifts/history" icon={<ClockIcon />} label={t("nav.shiftHistory")} visible={canOpen("/shifts/history")} />
        <NavItem to="/expenses" icon={<ReceiptIcon />} label={t("nav.expenses")} visible={canOpen("/expenses")} />
        <NavItem to="/reports" icon={<ReportIcon />} label={t("nav.reports")} visible={canOpen("/reports")} />
        <NavItem
          to="/reports/advanced"
          icon={<LayersIcon />}
          label={t("nav.advancedReports")}
          visible={canOpen("/reports/advanced")}
        />
        <NavItem to="/audit" icon={<ClipboardIcon />} label={t("nav.audit")} visible={canOpen("/audit")} />
        {/* Every signed-in role may open the inbox: an approver decides from it,
            a requester watches their own ask. Deciding is asserted in the
            service, not by hiding the screen. */}
        <NavItem
          to="/approvals"
          icon={<ClipboardIcon />}
          label={t("nav.approvals")}
          badge={pendingApprovals}
          badgeLabel={t("approvals.pendingHint")}
        />

        {canManageOnline || canManageWebsite ? (
          <>
            <p className="px-3 pb-1 pt-4 text-[10px] font-bold uppercase tracking-widest text-slate-500">
              {t("app.phase9")}
            </p>
            <NavItem
              to="/online/orders"
              icon={<GlobeIcon />}
              label={t("nav.onlineOrders")}
              visible={canOpen("/online/orders")}
              badge={online.counts.pending}
              badgeLabel={
                online.counts.needs_payment > 0
                  ? t("nav.onlineOrdersBadgePayment", { count: online.counts.needs_payment })
                  : t("nav.onlineOrdersBadge", { count: online.counts.pending })
              }
            />
            <NavItem
              to="/online/reservations"
              icon={<LayersIcon />}
              label={t("nav.stockHolds")}
              visible={canOpen("/online/reservations")}
              // Stuck holds are stock nobody can sell, so they earn a badge of
              // their own rather than being folded into the pending-orders count.
              badge={online.holdAlertCount}
              badgeLabel={t("nav.stockHoldsBadge", { count: online.holdAlertCount })}
            />
            <NavItem
              to="/online/reports"
              icon={<ReportIcon />}
              label={t("nav.onlineReports")}
              visible={canOpen("/online/reports")}
            />
            <NavItem
              to="/online/website"
              icon={<EditIcon />}
              label={t("nav.websiteSettings")}
              visible={canOpen("/online/website")}
            />
            <NavItem
              to="/online/marketing"
              icon={<PlusCircleIcon />}
              label={t("nav.marketing")}
              visible={canOpen("/online/marketing")}
            />
            <NavItem
              to="/online/content"
              icon={<ClipboardIcon />}
              label={t("nav.websiteContent")}
              visible={canOpen("/online/content")}
            />
            {/* Not a screen: the shop itself, in a new tab, so configuring it and
                looking at it can happen side by side. */}
            <a
              href="#/store"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-100 hover:text-slate-900"
            >
              <span aria-hidden className="shrink-0">
                <ShoppingCartIcon />
              </span>
              <span className="truncate">{t("nav.viewStore")}</span>
              <span aria-hidden className="ms-auto text-[10px] text-slate-400">
                ↗
              </span>
            </a>
          </>
        ) : null}

        {/* Settings (Phase 10). Two entries, each behind its own capability:
            managing accounts and managing the permission model are different
            authorities, and a role may hold one without the other. */}
        {canManageUsers || canManageRoles || canManageSettings || canOpen("/settings/backup") ? (
          <>
            <p className="px-3 pb-1 pt-4 text-[10px] font-bold uppercase tracking-widest text-slate-500">
              {t("nav.settings")}
            </p>
            <NavItem
              to="/settings/users"
              icon={<UsersIcon />}
              label={t("nav.settingsUsers")}
              visible={canOpen("/settings/users")}
            />
            <NavItem
              to="/settings/roles"
              icon={<ClipboardIcon />}
              label={t("nav.settingsRoles")}
              visible={canOpen("/settings/roles")}
            />
            <NavItem
              to="/settings/backup"
              icon={<ArchiveIcon />}
              label={t("nav.settingsBackup")}
              visible={canOpen("/settings/backup")}
            />
            <NavItem
              to="/settings/approvals"
              icon={<ReportIcon />}
              label={t("approvals.rules")}
              visible={canOpen("/settings/approvals") && canManageSettings}
            />
          </>
        ) : null}
      </nav>

      {/* Signed-in user — the acting role comes from the auth session. */}
      <div className="shrink-0 rounded-2xl border border-slate-200 bg-slate-50 p-3">
        <p className="text-[11px] font-bold uppercase tracking-widest text-slate-500">
          {t("auth.signedInAs")}
        </p>
        <p className="mt-1 truncate text-xs font-bold text-slate-800">{user.name}</p>
        <p className="mt-0.5 flex flex-wrap items-center gap-1.5">
          <span className="rounded-md bg-indigo-50 px-1.5 py-0.5 text-[10px] font-bold text-indigo-700">
            {roleLabel}
          </span>
          {user.username ? (
            <span className="truncate text-[10px] font-medium text-slate-500">@{user.username}</span>
          ) : null}
        </p>
        <button
          type="button"
          onClick={() => void signOut()}
          className="mt-2 w-full rounded-xl border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-100"
        >
          {t("auth.signOut")}
        </button>
        {mode === "supabase" ? (
          <button
            type="button"
            onClick={() => void signOutEverywhere()}
            title={t("auth.signOutEverywhereHint")}
            className="mt-1.5 w-full rounded-xl border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-rose-50 hover:text-rose-700"
          >
            {t("auth.signOutEverywhere")}
          </button>
        ) : null}
      </div>

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
            <p className="truncate text-xs font-semibold text-slate-700">
              {endReason === "expired" ? t("auth.sessionExpired") : t("app.phase")}
            </p>
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

        <main className="mx-auto w-full max-w-7xl px-3 py-4 sm:px-6 sm:py-6 lg:px-8">
          <RouteGuard>{children}</RouteGuard>
        </main>
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
