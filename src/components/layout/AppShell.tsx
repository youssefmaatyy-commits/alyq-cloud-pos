import { useEffect, useMemo, useRef, useState } from "react";
import { Link, NavLink, useLocation, useNavigate } from "react-router-dom";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { useCatalog } from "@/modules/products/hooks/CatalogProvider";
import { useInventory } from "@/modules/inventory/hooks/InventoryProvider";
import { useAuth } from "@/lib/auth";
import { ROLE_LABELS } from "@/lib/permissions/roles";
import { can } from "@/lib/permissions/enforce";
import { openStorefrontRoute } from "@/lib/storefront/storefrontLink";
import { pathPermits } from "@/lib/permissions/routes";
import { useOnlineNotificationState } from "@/modules/online/hooks/OnlineNotificationsProvider";
import { useOptionalApprovals } from "@/modules/approvals";
import { normalizeText } from "@/modules/products/services/productQuery";
import { brandDisplayName, useBrand } from "@/lib/branding/brand";
import { RouteGuard } from "./RouteGuard";
import { cn } from "@/utils/cn";
import {
  ArchiveIcon,
  BoxIcon,
  ChevronIcon,
  CloseIcon,
  GlobeIcon,
  GridIcon,
  MenuIcon,
  ShoppingCartIcon,
  ReportIcon,
} from "@/components/ui";

/**
 * The admin shell (Phase 46 edition).
 *
 * Visual direction: a dark, warm-charcoal sidebar against a bright, warm-white
 * workspace — the till reads as the premium half of one product with the
 * storefront (espresso `#161311` and antique gold `#b08d57` are the storefront
 * theme's own ink-and-accent tokens). Structure is unchanged where it matters:
 * every route, badge, capability gate and testid keeps its meaning; what
 * changed is how clearly it presents.
 *
 * - Collapsible on desktop (icons only), drawer on mobile — the drawer was
 *   already here; both share the same nav tree.
 * - The brand at the top is the shared brand source (Settings → Branding),
 *   falling back to the shipped wordmark when nothing is configured.
 * - The top bar gains a global search over real, loaded entities (products are
 *   already in the shell's catalog provider; everything else routes to the
 *   module's own filter — the search never invents a result) and one
 *   notifications menu for the two inboxes that already had badges.
 */

/** localStorage key for the desktop collapse preference (visual only). */
const COLLAPSE_KEY = "alyq.admin.sidebar.collapsed.v1";

const SIDEBAR_BG = "bg-[#161311]";

/**
 * A sidebar entry.
 *
 * `badge` is a count the entry carries — currently the online-orders queue and
 * the approvals inbox, where the number is the reason to look. It renders
 * inside the link so it is read as part of the destination, and it inverts on
 * the active row.
 */
function NavItem({
  to,
  icon,
  label,
  end,
  visible = true,
  badge = 0,
  badgeLabel,
  collapsed = false,
  active,
}: {
  to: string;
  icon: React.ReactNode;
  label: string;
  end?: boolean;
  visible?: boolean;
  badge?: number;
  badgeLabel?: string;
  collapsed?: boolean;
  testId?: string;
  active?: boolean;
}) {
  if (!visible) return null;

  const rowClass = ({ isActive }: { isActive: boolean }) =>
    cn(
      "group relative flex items-center gap-3 rounded-xl text-sm font-medium transition-colors",
      collapsed ? "justify-center px-0 py-2.5" : "px-3 py-2.5",
      (active ?? isActive)
        ? "bg-white/10 text-[#f3ede1]"
        : "text-stone-400 hover:bg-white/5 hover:text-stone-100",
    );

  // The active row carries a thin gold rule on the inline-start edge — the
  // antique-gold detail the storefront theme already speaks, quiet enough to
  // stay premium rather than shout like a template.
  const marker = ({ isActive }: { isActive: boolean }) =>
    isActive ? (
      <span
        aria-hidden
        className="absolute inset-y-1.5 start-0 w-0.5 rounded-full bg-[#b08d57]"
      />
    ) : null;

  // The count rides WITH the label (`ms-2`), never at the far edge of the row:
  // on a wide sparse row a far-edge pill reads as a detached floating number —
  // in RTL it lands on the opposite side from the icon and looks orphaned —
  // while a label-adjacent pill is attached to its control in both directions.
  // The collapsed (icons-only) row keeps the overlaid corner badge instead.
  const badgeEl =
    badge > 0 ? (
      <span
        className={cn(
          "shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-black tabular-nums",
          collapsed ? "absolute end-1 top-1" : "ms-2",
          "bg-[#b08d57]/25 text-[#dfc08a] group-hover:bg-[#b08d57]/35",
        )}
      >
        {badge > 99 ? "99+" : badge}
      </span>
    ) : null;

  const iconEl = (
    <span aria-hidden className="shrink-0">
      {icon}
    </span>
  );
  const labelEl = collapsed ? (
    <span className="sr-only">{label}</span>
  ) : (
    <span className="truncate">{label}</span>
  );
  return (
    <NavLink aria-current={active ? "page" : undefined} to={to} end={end} title={collapsed ? label : badgeLabel} className={rowClass}>
      {({ isActive }) => (
        <>
          {marker({ isActive: active ?? isActive })}
          {iconEl}
          {labelEl}
          {badgeEl}
        </>
      )}
    </NavLink>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const { t, lang, toggleLang } = useI18n();
  const { mode, products } = useCatalog();
  // Sidebar visibility follows the signed-in role: an entry is shown only when
  // the same capability table the route guard reads allows the screen.
  const { user } = useInventory();
  const { signOut, signOutEverywhere, endReason, user: sessionUser } = useAuth();
  const navigate = useNavigate();
  const brand = useBrand();
  const canOpen = (path: string) =>
    // Same answer as the route guard, alternates included. A module door that
    // has no open child is hidden by the callers below — not by a role name.
    pathPermits(path, (permission) => can(permission));
  const canManageOnline = can("orders.view");
  const canManageWebsite = can("website.manage");
  const canManageUsers = can("users.manage");
  const canManageRoles = can("roles.manage");
  const canManageSettings = can("settings.manage");
  const canSearchProducts = can("products.view");
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
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return window.localStorage.getItem(COLLAPSE_KEY) === "1";
    } catch {
      return false;
    }
  });

  useEffect(() => {
    setOpen(false);
  }, [location.pathname]);

  const toggleCollapsed = () => {
    setCollapsed((current) => {
      try {
        window.localStorage.setItem(COLLAPSE_KEY, current ? "0" : "1");
      } catch {
        /* private mode — the preference simply does not persist */
      }
      return !current;
    });
  };

  // ── global search ─────────────────────────────────────────────────────────
  // Only real entities: products come from the catalog the shell already holds;
  // the other inboxes are routed to their own filter screens rather than
  // previewed here, so the dropdown can never show a row that does not exist.
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const searchRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setSearchOpen(false);
    setNotificationsOpen(false);
  }, [location.pathname]);

  const productMatches = useMemo(() => {
    const needle = normalizeText(query);
    if (needle.length < 2) return [];
    return products
      .filter((product) =>
        [product.name_ar, product.name_en, product.sku, product.barcode ?? ""].some((field) =>
          normalizeText(field).includes(needle),
        ),
      )
      .slice(0, 6);
  }, [products, query]);

  useEffect(() => {
    if (!searchOpen && !notificationsOpen) return;
    const onDown = (event: MouseEvent) => {
      if (searchRef.current && !searchRef.current.contains(event.target as Node)) {
        setSearchOpen(false);
        setNotificationsOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setSearchOpen(false);
        setNotificationsOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [searchOpen, notificationsOpen]);

  const submitSearch = () => {
    const needle = query.trim();
    if (!needle) return;
    setSearchOpen(false);
    navigate(
      canSearchProducts
        ? `/products?q=${encodeURIComponent(needle)}`
        : `/online/orders?search=${encodeURIComponent(needle)}`,
    );
  };

  const notificationTotal = pendingApprovals + online.counts.pending;

  const brandName = brand ? brandDisplayName(brand, lang) : t("app.name");
  const brandMark = brand?.markUrl ?? null;
  const brandTile = (
    <span className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-gradient-to-br from-[#b08d57] to-[#7d5f33] text-sm font-black text-[#161311] shadow-md shadow-black/30">
      {brandMark ? (
        <img src={brandMark} alt="" className="h-full w-full object-contain" />
      ) : (
        "A"
      )}
    </span>
  );

  const sidebar = (navCollapsed: boolean) => (
    <div className="flex h-full flex-col gap-5 overflow-hidden p-3.5">
      {/* Brand — the shared brand source; the wordmark is the fallback. Click
          always goes to the dashboard. */}
      <div className="flex shrink-0 items-center gap-2 px-0.5">
        <Link to="/" className="flex min-w-0 flex-1 items-center gap-3 rounded-xl" title={brandName}>
          {brandTile}
          {!navCollapsed ? (
            <span className="min-w-0" data-testid="shell-brand">
              <span className="block truncate text-sm font-black tracking-tight text-[#f3ede1]">
                {brandName}
              </span>
              <span className="block truncate text-[10px] font-semibold text-stone-500">
                {t("app.tagline")}
              </span>
            </span>
          ) : null}
        </Link>
        {!navCollapsed ? (
          <button
            type="button"
            onClick={toggleCollapsed}
            title={t("admin.shell.collapse")}
            aria-label={t("admin.shell.collapse")}
            className="hidden h-7 w-7 shrink-0 place-items-center rounded-lg text-stone-500 hover:bg-white/5 hover:text-stone-200 lg:grid"
          >
            <ChevronIcon className="h-3.5 w-3.5 rotate-180 rtl:rotate-0" />
          </button>
        ) : null}
      </div>

      <nav className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto" aria-label={t("nav.menu")}>
        {/* Six primary areas; desktop and mobile share this exact navigation. */}
        <NavItem to="/" icon={<GridIcon />} label={t("nav.dashboard")} end collapsed={navCollapsed} />
        <NavItem to="/pos" icon={<ShoppingCartIcon />} label={t("home.pos.title")} end visible={canOpen("/pos")} collapsed={navCollapsed} />
        <NavItem
          to="/management"
          icon={<BoxIcon />}
          label={t("home.management.title")}
          // Derived from real capabilities, never from a role name: the door
          // renders when the session can open at least one gated child of the
          // workspace (sales, stock, returns, shifts, customers…). Products,
          // categories and approvals carry no capability by design — they are
          // open to every signed-in seat — so a seat stripped of every gated
          // child (e.g. a website-only role) sees no door at all. Admin holds
          // everything, so the door is always there for an admin.
          visible={
            canOpen("/sales") ||
            canOpen("/inventory") ||
            canOpen("/returns") ||
            canOpen("/refunds") ||
            canOpen("/shifts") ||
            canOpen("/expenses") ||
            canOpen("/customers")
          }
          active={["/management", "/catalog", "/products", "/categories", "/inventory", "/sales", "/pos/sales", "/returns", "/refunds", "/shifts", "/expenses", "/customers", "/approvals"].some((path) => location.pathname === path || location.pathname.startsWith(`${path}/`))}
          badge={pendingApprovals}
          badgeLabel={t("approvals.pendingHint")}
          collapsed={navCollapsed}
        />
        <NavItem
          to="/online"
          icon={<GlobeIcon />}
          label={t("home.breadcrumb.online")}
          visible={canOpen("/online/orders") || canManageWebsite}
          active={["/online/orders", "/online/reservations", "/online/website", "/online/marketing", "/online/zones", "/online/content", "/online/reports"].some((path) => location.pathname === path || location.pathname.startsWith(`${path}/`)) || location.pathname === "/online"}
          badge={online.counts.pending}
          badgeLabel={
            online.counts.needs_payment > 0
              ? t("nav.onlineOrdersBadgePayment", { count: online.counts.needs_payment })
              : t("nav.onlineOrdersBadge", { count: online.counts.pending })
          }
          collapsed={navCollapsed}
        />
        <NavItem to="/reports" icon={<ReportIcon />} label={t("nav.reports")} visible={canOpen("/reports")} collapsed={navCollapsed} />
        {canManageUsers || canManageRoles || canManageSettings || canOpen("/settings/backup") || canOpen("/settings/operations") || canOpen("/audit") || can("system.reset") || canManageWebsite ? (
          <NavItem
            to="/settings"
            icon={<ArchiveIcon />}
            label={t("nav.settings")}
            active={location.pathname.startsWith("/settings") || location.pathname === "/audit"}
            visible
            collapsed={navCollapsed}
          />
        ) : null}

        {/* Not a screen: the shop itself, offered in a new tab so configuring
            it and looking at it can happen side by side. The new tab is a
            preference, not a requirement: an embedded host or a popup blocker
            swallows target="_blank" without a word, which made this a dead
            button — the click is taken over and falls back to this tab;
            target stays for middle-click and ctrl-click. */}
        {canManageOnline || canManageWebsite ? (
          <a
            href="#/store"
            target="_blank"
            rel="noopener noreferrer"
            data-testid="nav-open-website"
            onClick={(event) => {
              event.preventDefault();
              openStorefrontRoute();
            }}
            className={cn(
              "mt-2 flex w-full items-center gap-3 rounded-xl border-t border-white/10 pt-3 text-sm font-medium text-stone-400 transition-colors hover:bg-white/5 hover:text-stone-100",
              navCollapsed ? "justify-center px-0 py-2.5" : "px-3 py-2.5",
            )}
          >
            <span aria-hidden className="shrink-0">
              <GlobeIcon />
            </span>
            {!navCollapsed ? (
              <span className="truncate">{t("nav.viewStore")}</span>
            ) : (
              <span className="sr-only">{t("nav.viewStore")}</span>
            )}
            {!navCollapsed ? (
              <span aria-hidden className="ms-auto text-[10px] text-stone-500">
                ↗
              </span>
            ) : null}
          </a>
        ) : null}
      </nav>

      {/* Signed-in user — the acting role comes from the auth session. */}
      <div className="shrink-0 rounded-2xl border border-white/10 bg-white/5 p-3">
        <p className="text-[11px] font-bold uppercase tracking-widest text-stone-500">
          {t("auth.signedInAs")}
        </p>
        <p className="mt-1 truncate text-xs font-bold text-[#f3ede1]">{user.name}</p>
        <p className="mt-0.5 flex flex-wrap items-center gap-1.5">
          <span className="rounded-md bg-[#b08d57]/20 px-1.5 py-0.5 text-[10px] font-bold text-[#dfc08a]">
            {roleLabel}
          </span>
          {user.username && !navCollapsed ? (
            <span className="truncate text-[10px] font-medium text-stone-500">@{user.username}</span>
          ) : null}
        </p>
        <button
          type="button"
          onClick={() => void signOut()}
          className="mt-2 w-full rounded-xl border border-white/15 bg-white/5 px-3 py-1.5 text-xs font-semibold text-stone-200 hover:bg-white/10"
        >
          {t("auth.signOut")}
        </button>
        {mode === "supabase" ? (
          <button
            type="button"
            onClick={() => void signOutEverywhere()}
            title={t("auth.signOutEverywhereHint")}
            className="mt-1.5 w-full rounded-xl border border-white/15 bg-white/5 px-3 py-1.5 text-xs font-semibold text-stone-200 hover:bg-rose-500/15 hover:text-rose-300"
          >
            {t("auth.signOutEverywhere")}
          </button>
        ) : null}
      </div>

      {!navCollapsed ? (
        <div className="shrink-0 rounded-2xl border border-white/10 bg-white/5 p-3">
          <p className="flex items-center gap-2 text-xs font-bold text-[#f3ede1]">
            <span
              className={cn(
                "h-2 w-2 rounded-full",
                mode === "supabase" ? "bg-emerald-400" : "bg-amber-400",
              )}
            />
            {mode === "supabase" ? t("mode.live") : t("mode.demo")}
          </p>
          <p className="mt-1 text-[11px] font-medium leading-relaxed text-stone-400">
            {mode === "supabase" ? t("mode.liveHint") : t("mode.demoHint")}
          </p>
        </div>
      ) : null}
    </div>
  );

  return (
    <div className="min-h-screen bg-[#f7f5f2] text-stone-900">
      {/* Desktop sidebar */}
      <aside
        className={cn(
          "fixed inset-y-0 start-0 z-40 hidden flex-col border-e border-black/50 lg:flex",
          SIDEBAR_BG,
          collapsed ? "w-[4.75rem]" : "w-64",
        )}
      >
        {sidebar(collapsed)}
      </aside>

      {/* Mobile drawer */}
      {open ? (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div className="absolute inset-0 bg-stone-950/60" onClick={() => setOpen(false)} aria-hidden />
          <aside
            className={cn("absolute inset-y-0 w-[17.5rem] max-w-[85vw] shadow-2xl", SIDEBAR_BG)}
            role="dialog"
            aria-label={t("nav.menu")}
          >
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label={t("common.close")}
              className="absolute end-3 top-3 z-10 flex h-8 w-8 items-center justify-center rounded-lg text-stone-400 hover:bg-white/10 hover:text-stone-100"
            >
              <CloseIcon />
            </button>
            {sidebar(false)}
          </aside>
        </div>
      ) : null}

      <div className={cn("transition-[padding] duration-200", collapsed ? "lg:ps-[4.75rem]" : "lg:ps-64")}>
        <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b border-stone-200/80 bg-[#f7f5f2]/90 px-3 backdrop-blur sm:px-5">
          <button
            type="button"
            onClick={() => setOpen(true)}
            aria-label={t("nav.menu")}
            className="flex h-9 w-9 items-center justify-center rounded-lg text-stone-500 hover:bg-stone-900/5 lg:hidden"
          >
            <MenuIcon />
          </button>

          {/* Global search — only modules this identity may open contribute results. */}
          {canSearchProducts || canManageOnline ? (
          <div ref={searchRef} className="relative min-w-0 flex-1 max-w-md">
            <div className="flex items-center gap-2 rounded-xl border border-stone-200 bg-white px-3 shadow-sm focus-within:border-stone-400">
              <span aria-hidden className="text-stone-400">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
                  <circle cx="11" cy="11" r="7" />
                  <path d="m20 20-3.5-3.5" />
                </svg>
              </span>
              <input
                // type="text" + role="searchbox" on purpose: the regression
                // suites scope page filters with input[type="search"], and this
                // shell-level box must never win that query (it renders first).
                type="text"
                role="searchbox"
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setSearchOpen(true);
                }}
                onFocus={() => setSearchOpen(true)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") submitSearch();
                }}
                placeholder={t("admin.shell.searchPlaceholder")}
                aria-label={t("admin.shell.searchPlaceholder")}
                data-testid="global-search"
                className="h-9 w-full bg-transparent text-xs font-semibold text-stone-800 outline-none placeholder:text-stone-400"
              />
            </div>

            {searchOpen && query.trim().length >= 2 ? (
              <div
                role="listbox"
                aria-label={t("admin.shell.searchPlaceholder")}
                className="absolute inset-x-0 top-11 z-40 overflow-hidden rounded-xl border border-stone-200 bg-white shadow-xl"
                data-testid="global-search-panel"
              >
                {canSearchProducts && productMatches.length > 0 ? (
                  productMatches.map((product) => (
                    <Link
                      key={product.id}
                      to={`/products/${product.id}`}
                      role="option"
                      aria-selected={false}
                      onClick={() => setSearchOpen(false)}
                      className="flex items-center gap-2.5 px-3 py-2 text-xs font-semibold text-stone-700 hover:bg-stone-100"
                    >
                      <BoxIcon />
                      <span className="truncate">{lang === "ar" ? product.name_ar : product.name_en}</span>
                      <span dir="ltr" className="ms-auto shrink-0 font-mono text-[10px] text-stone-400">
                        {product.sku}
                      </span>
                    </Link>
                  ))
                ) : canSearchProducts ? (
                  <p className="px-3 py-2 text-xs font-medium text-stone-400">
                    {t("admin.shell.searchNoProducts")}
                  </p>
                ) : null}
                {canOpen("/online/orders") && (canManageOnline || canManageWebsite) ? (
                  <button
                    type="button"
                    onClick={() => {
                      setSearchOpen(false);
                      navigate(`/online/orders?search=${encodeURIComponent(query.trim())}`);
                    }}
                    className="flex w-full items-center gap-2 border-t border-stone-100 px-3 py-2 text-xs font-semibold text-stone-600 hover:bg-stone-100"
                  >
                    <GlobeIcon />
                    {t("admin.shell.searchOrders", { query: query.trim() })}
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
          ) : <div className="flex-1" />}

          {/* Notifications — one menu for the two inboxes the sidebar badges
              already count. A viewer with neither inbox sees no button at all
              rather than a bell that does nothing. */}
          {notificationTotal > 0 ? (
            <div className="relative">
              <button
                type="button"
                onClick={() => setNotificationsOpen((current) => !current)}
                aria-label={t("admin.shell.notifications")}
                aria-expanded={notificationsOpen}
                data-testid="topbar-notifications"
                className="relative flex h-9 w-9 items-center justify-center rounded-xl border border-stone-200 bg-white text-stone-600 hover:bg-stone-100"
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
                  <path d="M13.7 21a2 2 0 0 1-3.4 0" />
                </svg>
                <span className="absolute -end-1 -top-1 grid h-4 min-w-4 place-items-center rounded-full bg-[#b08d57] px-1 text-[9px] font-black text-white">
                  {notificationTotal > 99 ? "99+" : notificationTotal}
                </span>
              </button>
              {notificationsOpen ? (
                <div className="absolute end-0 top-11 z-40 w-64 overflow-hidden rounded-xl border border-stone-200 bg-white shadow-xl">
                  {pendingApprovals > 0 ? (
                    <Link
                      to="/approvals"
                      onClick={() => setNotificationsOpen(false)}
                      className="flex items-center justify-between gap-2 px-3 py-2.5 text-xs font-semibold text-stone-700 hover:bg-stone-100"
                    >
                      {t("nav.approvals")}
                      <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-black tabular-nums text-amber-800">
                        {pendingApprovals}
                      </span>
                    </Link>
                  ) : null}
                  {online.counts.pending > 0 && canOpen("/online/orders") && (canManageOnline || canManageWebsite) ? (
                    <Link
                      to={{ pathname: "/online/orders", search: "?status=pending" }}
                      onClick={() => setNotificationsOpen(false)}
                      className="flex items-center justify-between gap-2 px-3 py-2.5 text-xs font-semibold text-stone-700 hover:bg-stone-100"
                    >
                      {t("nav.onlineOrders")}
                      <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-black tabular-nums text-amber-800">
                        {online.counts.pending}
                      </span>
                    </Link>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null}

          <button
            type="button"
            onClick={toggleLang}
            className="inline-flex h-9 items-center gap-1.5 rounded-xl border border-stone-200 bg-white px-3 text-xs font-semibold text-stone-800 hover:bg-stone-100"
            title={t("mode.switch")}
          >
            <GlobeIcon />
            {lang === "ar" ? "English" : "العربية"}
          </button>
          <span className="hidden items-center gap-1 rounded-xl border border-stone-200 bg-white px-3 py-2 text-xs font-semibold text-stone-700 sm:inline-flex">
            {mode === "supabase" ? t("mode.live") : t("mode.demo")}
            <ChevronIcon className="h-3 w-3 -rotate-90 text-stone-300" />
          </span>
          {endReason === "expired" ? (
            <span className="hidden truncate text-xs font-semibold text-rose-600 md:inline">
              {t("auth.sessionExpired")}
            </span>
          ) : null}
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
  crumbs,
}: {
  title: string;
  subtitle?: string;
  actions?: React.ReactNode;
  backTo?: string;
  backLabel?: string;
  /** Phase 49: the trail above the title — "Catalog / Products / Gold Ring".
      Last crumb is where you are, so it renders as plain text, not a link. */
  crumbs?: { label: string; to?: string }[];
}) {
  return (
    <div className="mb-5 space-y-3">
      {crumbs && crumbs.length > 0 ? (
        <nav aria-label="Breadcrumb" data-testid="breadcrumbs" className="flex flex-wrap items-center gap-1.5 text-[11px] font-bold uppercase tracking-widest text-stone-400">
          {crumbs.map((crumb, index) => {
            const last = index === crumbs.length - 1;
            return (
              <span key={`${crumb.label}-${index}`} className="flex items-center gap-1.5">
                {crumb.to && !last ? (
                  <Link to={crumb.to} className="transition hover:text-stone-700">
                    {crumb.label}
                  </Link>
                ) : (
                  <span className={last ? "text-stone-600" : undefined}>{crumb.label}</span>
                )}
                {!last ? <span aria-hidden>/</span> : null}
              </span>
            );
          })}
        </nav>
      ) : null}
      {backTo ? (
        <Link
          to={backTo}
          className="inline-flex items-center gap-1.5 text-xs font-semibold text-stone-500 hover:text-stone-900"
        >
          <ChevronIcon className="h-3.5 w-3.5 rotate-180 rtl:rotate-0" />
          {backLabel}
        </Link>
      ) : null}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-xl font-black tracking-tight text-stone-900 sm:text-[1.55rem]">{title}</h1>
          {subtitle ? <p className="mt-1 text-sm font-medium text-stone-500">{subtitle}</p> : null}
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
