import { HashRouter, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { I18nProvider } from "@/lib/i18n/I18nProvider";
import {
  AuthProvider,
  ChangePasswordPage,
  ForgotPasswordPage,
  LoginRoute,
  RequireAuth,
  ResetPasswordPage,
  normalizeRecoveryUrl,
} from "@/lib/auth";
import { ToastProvider } from "@/components/ui";
import { BranchProvider } from "@/lib/branch";
import { RegisterProvider } from "@/modules/registers";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { AppShell } from "@/components/layout/AppShell";
import { CatalogProvider } from "@/modules/products";
import { DashboardPage } from "@/modules/dashboard/DashboardPage";
import {
  CategoriesPage,
  ProductDetailPage,
  ProductFormPage,
  ProductsPage,
} from "@/modules/products";
import {
  InventoryPage,
  InventoryProvider,
  MovementsPage,
  StocktakePage,
} from "@/modules/inventory";
import { PosPage, PosProvider, SaleDetailPage, SalesHistoryPage } from "@/modules/pos";
import { SyncCenterPage } from "@/modules/pos/pages/SyncCenterPage";
import { HealthCenterPage } from "@/modules/system/pages/HealthCenterPage";
import {
  CustomerDetailPage,
  CustomerProvider,
  CustomersPage,
} from "@/modules/customers";
import {
  RefundDetailPage,
  RefundsPage,
  ReturnDetailPage,
  ReturnProvider,
  ReturnsPage,
} from "@/modules/returns";
import { ExpenseProvider, ExpensesPage } from "@/modules/expenses";
import {
  EndOfDayPage,
  ShiftDashboardPage,
  ShiftHistoryPage,
  ShiftProvider,
} from "@/modules/shifts";
import { AuditLogPage, RequireAuditAccess } from "@/modules/audit";
import {
  ApprovalProvider,
  ApprovalRulesPage,
  ApprovalsPage,
} from "@/modules/approvals";
import { AdvancedReportsPage, ReportsPage } from "@/modules/reports";
import { RolesPage, SettingsProvider, UsersPage } from "@/modules/settings";
import { BackupPage } from "@/modules/backup";
import { BrandingPage } from "@/modules/settings/pages/BrandingPage";
import { SettingsHomePage } from "@/modules/settings/pages/SettingsHomePage";
import { SystemSettingsPage } from "@/modules/settings/pages/SystemSettingsPage";
import { BranchesPage } from "@/modules/settings/pages/BranchesPage";
import { RegistersPage } from "@/modules/registers/pages/RegistersPage";
import { DesktopHardwarePage } from "@/modules/registers/pages/DesktopHardwarePage";
import { OperationsCenterPage } from "@/modules/operations/pages/OperationsCenterPage";
import { ImportCenterPage } from "@/modules/import/pages/ImportCenterPage";
import { StoreManagementHome, SalesHome, CatalogHome, InventoryHome, OnlineHome } from "./components/layout/moduleHomes";
import { MobileApp } from "@/modules/mobile/MobileApp";

import {
  DeliveryZonesPage,
  MarketingPage,
  OnlineNotificationsProvider,
  OnlineOrdersPage,
  OnlineOrdersProvider,
  OnlineReportsPage,
  PromotionsPage,
  StockHoldsPage,
  StoreContentPage,
  StorefrontApp,
  WebsiteSettingsPage,
} from "@/modules/online";
import { StorefrontV2Home } from "@/modules/online/v2/StorefrontV2Home";
import { StorefrontV2Catalog } from "@/modules/online/v2/StorefrontV2Catalog";
import { StorefrontV2Product } from "@/modules/online/v2/StorefrontV2Product";
import { StorefrontV2Cart } from "@/modules/online/v2/StorefrontV2Cart";
import { StorefrontV2Checkout } from "@/modules/online/v2/StorefrontV2Checkout";
import { StorefrontV2Confirmation } from "@/modules/online/v2/StorefrontV2Confirmation";
import { StorefrontV2Track } from "@/modules/online/v2/StorefrontV2Track";
import { StorefrontV2Account } from "@/modules/online/v2/StorefrontV2Account";
import { StorefrontV2About } from "@/modules/online/v2/StorefrontV2About";
import { StorefrontV2Contact } from "@/modules/online/v2/StorefrontV2Contact";
import { StorefrontV2PreviewRedirect } from "@/modules/online/v2/StorefrontV2PreviewRedirect";

/**
 * ALYQ Cloud POS — application root.
 * HashRouter keeps deep links working from any static host (including the
 * single-file production build).
 *
 * Routing (Authentication phase) has three branches:
 *   /login     public — rendered outside the shell, with no module providers
 *              mounted, so nothing loads business data before a session exists;
 *   /store/*   public — the customer-facing website, no auth required, and no
 *              POS provider mounted: a shopper browsing the catalogue must not
 *              cause the app to load stock, sales or staff data;
 *   *          everything else — `RequireAuth` first, then the module providers
 *              and the shell. The shell's `RouteGuard` then applies the
 *              role → screen capability table, and `/audit` adds its own copy.
 */
/**
 * A password-reset link arrives with the provider's tokens in the URL fragment,
 * which is also where this app's routes live. Rewriting that fragment into
 * `#/reset-password?…` has to happen before `HashRouter` reads the location, or
 * the person who followed the link lands on the dashboard with a token nobody
 * consumed. Once, at module load, and only when the URL really is a provider
 * redirect.
 */
normalizeRecoveryUrl();

/**
 * Three crash screens, because three different people are looking at them.
 *
 * All three follow the same rule as `ErrorBoundary` itself: no error message and
 * no stack, because both are readable by whoever is at the screen and a stack
 * names the files and libraries in use. The detail goes to the console.
 *
 * Both languages appear at once rather than being translated, because a boundary
 * has to work when the thing that broke is the i18n provider.
 */

/** The shopper's screen: no back-office vocabulary, and the shop's own tones. */
function StorefrontCrashScreen() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-[#faf7f2] p-6">
      <div className="w-full max-w-md rounded-xl border border-[#e7ded1] bg-white p-8 text-center">
        <p className="text-xs uppercase tracking-[0.24em] text-[#b08d57]">ALYQ</p>
        <h1 className="mt-4 text-lg font-semibold text-stone-900">This page could not be displayed</h1>
        <p dir="rtl" className="mt-1 text-base font-semibold text-stone-700">
          تعذّر عرض هذه الصفحة
        </p>
        <p className="mt-4 text-sm leading-relaxed text-stone-600">
          Something went wrong on our side. Please reload to continue.
        </p>
        <p dir="rtl" className="mt-2 text-sm leading-relaxed text-stone-500">
          حدث خطأ من طرفنا. يُرجى إعادة تحميل الصفحة للمتابعة.
        </p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="mt-6 w-full rounded-lg bg-stone-900 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-stone-800"
        >
          Reload · إعادة التحميل
        </button>
      </div>
    </div>
  );
}

/**
 * The cashier's screen. It sits inside the shell, so a crash on the till does not
 * take the rest of the app with it — the navigation is still there, and so is
 * whatever else was open.
 */
function TillCrashScreen() {
  return (
    <div className="flex min-h-[60vh] items-center justify-center p-6">
      <div className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-8 text-center shadow-sm">
        <h1 className="text-lg font-semibold text-slate-900">The till stopped responding</h1>
        <p dir="rtl" className="mt-1 text-base font-semibold text-slate-700">
          توقّف صندوق البيع عن الاستجابة
        </p>
        <p className="mt-4 text-sm leading-relaxed text-slate-600">
          Reload to bring it back. The rest of the app is still running.
        </p>
        <p dir="rtl" className="mt-2 text-sm leading-relaxed text-slate-500">
          أعد التحميل لإعادته. بقية التطبيق ما زالت تعمل.
        </p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="mt-6 w-full rounded-lg bg-slate-900 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-slate-800"
        >
          Reload · إعادة التحميل
        </button>
      </div>
    </div>
  );
}

function LegacyStaffRedirect({ target }: { target?: string } = {}) {
  const location = useLocation();
  const search = location.search;
  const destination = target ? `${target}${search}` : `/dashboard${location.pathname}${search}`;
  return <Navigate to={destination} replace />;
}

export default function App() {
  return (
    // Outermost, and therefore outside the providers too: a crash while the i18n
    // or auth provider renders is still a crash, and this is the screen that
    // catches it. Before this the whole tree could unmount to a blank page.
    <ErrorBoundary>
      <I18nProvider>
        <AuthProvider>
          <ToastProvider>
            <HashRouter>
              <Routes>
                <Route path="/login" element={<LoginRoute />} />
                {/* Password recovery is public by definition: the person using it
                    has no session. Like /login, it renders outside the shell so no
                    module provider loads business data. */}
                <Route path="/forgot-password" element={<ForgotPasswordPage />} />
                <Route path="/reset-password" element={<ResetPasswordPage />} />
                {/* Signed-in self-service password change. Public-routed like the
                    other auth screens (no shell, no module data); inside it the
                    page itself demands a session and the CURRENT password. */}
                <Route path="/change-password" element={<ChangePasswordPage />} />

                {/* Root public Storefront V2 for all visitors */}
                <Route path="/" element={
                  <ErrorBoundary fallback={<StorefrontCrashScreen />}>
                    <StorefrontApp />
                  </ErrorBoundary>
                }>
                  <Route index element={<StorefrontV2Home />} />
                </Route>

                {/* Sibling storefront route */}
                <Route path="/store" element={
                  <ErrorBoundary fallback={<StorefrontCrashScreen />}>
                    <StorefrontApp />
                  </ErrorBoundary>
                }>
                  {/* One public V2 tree; old preview bookmarks only redirect. Keep
                      legacy components in source for rollback, not on a debug URL. */}
                  <Route index element={<StorefrontV2Home />} />
                  <Route path="products" element={<StorefrontV2Catalog />} />
                  {/* `:key` accepts both published slugs and product IDs. */}
                  <Route path="products/:key" element={<StorefrontV2Product />} />
                  <Route path="cart" element={<StorefrontV2Cart />} />
                  <Route path="checkout" element={<StorefrontV2Checkout />} />
                  <Route path="confirmation" element={<StorefrontV2Confirmation />} />
                  <Route path="track" element={<StorefrontV2Track />} />
                  <Route path="account" element={<StorefrontV2Account />} />
                  <Route path="about" element={<StorefrontV2About />} />
                  <Route path="contact" element={<StorefrontV2Contact />} />
                  <Route path="v2/*" element={<StorefrontV2PreviewRedirect />} />
                  <Route path="*" element={<Navigate to="/store" replace />} />
                </Route>

                {/* Prompt 6 management application: same auth and business services,
                    but a purpose-built phone shell rather than the cashier sidebar. */}
                <Route path="/mobile/*" element={<RequireAuth><MobileApp /></RequireAuth>} />

                {/* Authenticated staff application root */}
                <Route path="/dashboard/*" element={<AuthenticatedApp />} />

                {/* Legacy staff paths deterministically redirected to /dashboard/* */}
                <Route path="/pos" element={<LegacyStaffRedirect />} />
                <Route path="/pos/*" element={<LegacyStaffRedirect />} />
                <Route path="/pos/sales" element={<LegacyStaffRedirect />} />
                <Route path="/products" element={<LegacyStaffRedirect />} />
                <Route path="/products/*" element={<LegacyStaffRedirect />} />
                <Route path="/products/import" element={<LegacyStaffRedirect />} />
                <Route path="/categories" element={<LegacyStaffRedirect />} />
                <Route path="/categories/*" element={<LegacyStaffRedirect />} />
                <Route path="/catalog" element={<LegacyStaffRedirect />} />
                <Route path="/catalog/*" element={<LegacyStaffRedirect />} />
                <Route path="/management" element={<LegacyStaffRedirect />} />
                <Route path="/management/*" element={<LegacyStaffRedirect />} />
                <Route path="/inventory" element={<LegacyStaffRedirect />} />
                <Route path="/inventory/*" element={<LegacyStaffRedirect />} />
                <Route path="/inventory/movements" element={<LegacyStaffRedirect />} />
                <Route path="/inventory/stocktake" element={<LegacyStaffRedirect />} />
                <Route path="/sync" element={<LegacyStaffRedirect />} />
                <Route path="/sync/*" element={<LegacyStaffRedirect />} />
                <Route path="/system-health" element={<LegacyStaffRedirect />} />
                <Route path="/system-health/*" element={<LegacyStaffRedirect />} />
                <Route path="/sales" element={<LegacyStaffRedirect />} />
                <Route path="/sales/*" element={<LegacyStaffRedirect />} />
                <Route path="/customers" element={<LegacyStaffRedirect />} />
                <Route path="/customers/*" element={<LegacyStaffRedirect />} />
                <Route path="/returns" element={<LegacyStaffRedirect />} />
                <Route path="/returns/*" element={<LegacyStaffRedirect />} />
                <Route path="/refunds" element={<LegacyStaffRedirect />} />
                <Route path="/refunds/*" element={<LegacyStaffRedirect />} />
                <Route path="/shifts" element={<LegacyStaffRedirect />} />
                <Route path="/shifts/*" element={<LegacyStaffRedirect />} />
                <Route path="/shifts/history" element={<LegacyStaffRedirect />} />
                <Route path="/shifts/eod" element={<LegacyStaffRedirect />} />
                <Route path="/expenses" element={<LegacyStaffRedirect />} />
                <Route path="/expenses/*" element={<LegacyStaffRedirect />} />
                <Route path="/approvals" element={<LegacyStaffRedirect />} />
                <Route path="/approvals/*" element={<LegacyStaffRedirect />} />
                <Route path="/reports" element={<LegacyStaffRedirect />} />
                <Route path="/reports/*" element={<LegacyStaffRedirect />} />
                <Route path="/reports/advanced" element={<LegacyStaffRedirect />} />
                <Route path="/online" element={<LegacyStaffRedirect />} />
                <Route path="/online/*" element={<LegacyStaffRedirect />} />
                <Route path="/online/orders" element={<LegacyStaffRedirect />} />
                <Route path="/online/reservations" element={<LegacyStaffRedirect />} />
                <Route path="/online/reports" element={<LegacyStaffRedirect />} />
                <Route path="/online/website" element={<LegacyStaffRedirect />} />
                <Route path="/online/marketing" element={<LegacyStaffRedirect />} />
                <Route path="/online/content" element={<LegacyStaffRedirect />} />
                <Route path="/online/zones" element={<LegacyStaffRedirect />} />
                <Route path="/online/discounts" element={<LegacyStaffRedirect />} />
                <Route path="/audit" element={<LegacyStaffRedirect />} />
                <Route path="/audit/*" element={<LegacyStaffRedirect />} />
                <Route path="/settings" element={<LegacyStaffRedirect />} />
                <Route path="/settings/*" element={<LegacyStaffRedirect />} />
                <Route path="/settings/users" element={<LegacyStaffRedirect target="/dashboard/settings/users" />} />
                <Route path="/settings/roles" element={<LegacyStaffRedirect target="/dashboard/settings/roles" />} />
                <Route path="/settings/approvals" element={<LegacyStaffRedirect target="/dashboard/settings/approvals" />} />
                <Route path="/settings/branding" element={<LegacyStaffRedirect target="/dashboard/settings/branding" />} />
                <Route path="/settings/backup" element={<LegacyStaffRedirect target="/dashboard/settings/backup" />} />
                <Route path="/settings/operations" element={<LegacyStaffRedirect target="/dashboard/settings/operations" />} />
                <Route path="/settings/system" element={<LegacyStaffRedirect target="/dashboard/settings/system" />} />
                <Route path="/users/*" element={<LegacyStaffRedirect target="/dashboard/settings/users" />} />
                <Route path="/orders/*" element={<LegacyStaffRedirect target="/dashboard/online/orders" />} />

                {/* Sibling reference: path="*" element={<AuthenticatedApp />} */}
                <Route path="*" element={<Navigate to="/" replace />} />
              </Routes>
            </HashRouter>
          </ToastProvider>
        </AuthProvider>
      </I18nProvider>
    </ErrorBoundary>
  );
}

/** The signed-in application: session guard, providers, shell, screens. */
function AuthenticatedApp() {
  return (
    <RequireAuth>
      <BranchProvider>
      <RegisterProvider>
      <CatalogProvider>
        <ApprovalProvider>
        <InventoryProvider>
          <PosProvider>
            <CustomerProvider>
              <ReturnProvider>
                <ExpenseProvider>
                  <ShiftProvider>
                    <OnlineNotificationsProvider>
                      <AppShell>
                        <OnlineOrdersProvider>
                          <Routes>
                            <Route index element={<DashboardPage />} />
                            <Route path="products" element={<ProductsPage />} />
                            <Route path="products/new" element={<ProductFormPage mode="create" />} />
                            <Route path="products/import" element={<ImportCenterPage />} />
                            <Route path="products/:id" element={<ProductDetailPage />} />
                            <Route path="products/:id/edit" element={<ProductFormPage mode="edit" />} />
                            {/* Phase 49: the Catalog module landing. */}
                            <Route path="management" element={<StoreManagementHome />} />
                            <Route path="catalog" element={<CatalogHome />} />
                            <Route path="categories" element={<CategoriesPage />} />
                            {/* Phase 49: /inventory is the module landing; the
                                stock list itself lives one step deeper, with its
                                ?status= pre-filters intact. */}
                            <Route path="inventory" element={<InventoryHome />} />
                            <Route path="inventory/stock" element={<InventoryPage />} />
                            <Route path="inventory/movements" element={<MovementsPage />} />
                            <Route path="inventory/stocktake" element={<StocktakePage />} />
                            {/* The till is the one screen where a blank page stops trade, so it
                                gets a boundary of its own inside the shell: the crash is contained,
                                the navigation survives, and the cashier is told what to do. Same
                                note as /store about keeping the literal on the <Route> line. */}
                            <Route path="pos" element={
                              <ErrorBoundary fallback={<TillCrashScreen />}>
                                <PosPage />
                              </ErrorBoundary>
                            } />
                            <Route path="sync" element={<SyncCenterPage />} />
                            <Route path="system-health" element={<HealthCenterPage />} />
                            {/* Phase 49: the Sales module landing — invoices,
                                returns, refunds, shifts, expenses and the
                                approvals inbox behind one door. */}
                            <Route path="sales" element={<SalesHome />} />
                            <Route path="pos/sales" element={<SalesHistoryPage />} />
                            <Route path="pos/sales/:id" element={<SaleDetailPage />} />
                            <Route path="customers" element={<CustomersPage />} />
                            <Route path="customers/:id" element={<CustomerDetailPage />} />
                            <Route path="returns" element={<ReturnsPage />} />
                            <Route path="returns/:id" element={<ReturnDetailPage />} />
                            <Route path="refunds" element={<RefundsPage />} />
                            <Route path="refunds/:id" element={<RefundDetailPage />} />
                            <Route path="shifts" element={<ShiftDashboardPage />} />
                            <Route path="shifts/history" element={<ShiftHistoryPage />} />
                            <Route path="shifts/eod" element={<EndOfDayPage />} />
                            <Route path="expenses" element={<ExpensesPage />} />
                            {/* Approval limits (Phase 12). The inbox is readable by
                                every signed-in role — an approver sees every
                                request, a requester sees their own — so the path
                                carries no capability in `routes.ts`; deciding a
                                request is asserted in the service. */}
                            <Route path="approvals" element={<ApprovalsPage />} />
                            <Route path="reports" element={<ReportsPage />} />
                            {/* Advanced reports (Phase 14). Same providers, same
                                date window, same read capability as the hub —
                                `/reports` in `routes.ts` covers this path by
                                longest-prefix — but it renders the analysis
                                instead of the raw extracts. */}
                            <Route path="reports/advanced" element={<AdvancedReportsPage />} />
                            {/* Phase 49: the Online module landing — the queue,
                                the shop window and the marketing tools behind
                                one door; each card keeps its own capability. */}
                            <Route path="orders" element={<Navigate to="/dashboard/online/orders" replace />} />
                            <Route path="online" element={<OnlineHome />} />
                            <Route path="online/orders" element={<OnlineOrdersPage />} />
                            <Route path="online/reservations" element={<StockHoldsPage />} />
                            <Route path="online/website" element={<WebsiteSettingsPage />} />
                            <Route path="online/marketing" element={<MarketingPage />} />
                            <Route path="online/zones" element={<DeliveryZonesPage />} />
                            <Route path="online/discounts" element={<PromotionsPage />} />
                            <Route path="online/content" element={<StoreContentPage />} />
                            <Route path="online/reports" element={<OnlineReportsPage />} />
                            <Route
                              path="audit"
                              element={
                                <RequireAuditAccess>
                                  <AuditLogPage />
                                </RequireAuditAccess>
                              }
                            />
                            {/* Settings is mounted only here, not app-wide: the
                                provider reads the account directory, which a
                                cashier has no business asking for. The route
                                guard has already refused the path by the time
                                this renders. */}
                            {/* The splat is what makes the area work: `SettingsArea`
                                renders its own descendant <Routes>, and React Router
                                only hands a deeper path (`/settings/users`) to a
                                parent that declares it may have children. Without
                                `/*` every settings URL fell through to the
                                catch-all below and landed on the dashboard. */}
                            <Route path="users" element={<Navigate to="/dashboard/settings/users" replace />} />
                            <Route path="settings/*" element={<SettingsArea />} />
                            <Route path="*" element={<Navigate to="/dashboard" replace />} />
                          </Routes>
                        </OnlineOrdersProvider>
                      </AppShell>
                    </OnlineNotificationsProvider>
                  </ShiftProvider>
                </ExpenseProvider>
              </ReturnProvider>
            </CustomerProvider>
          </PosProvider>
        </InventoryProvider>
        </ApprovalProvider>
      </CatalogProvider>
      </RegisterProvider>
      </BranchProvider>
    </RequireAuth>
  );
}

/**
 * Settings — the grouped hub (Phase 46).
 *
 * `/settings` is a real screen now: one card per destination, only for roles
 * that may open it. Branding (Phase 46) edits the shared website settings
 * document and asks for the same capability the write enforces server-side
 * (`manage_website`). Users, Roles, Approvals and Backup keep their own
 * capabilities in `ROUTE_CAPABILITIES`, so a role can be given one without
 * the other.
 */
function SettingsArea() {
  return (
    <SettingsProvider>
      <Routes>
        <Route index element={<SettingsHomePage />} />
        <Route path="users" element={<UsersPage />} />
        <Route path="branches" element={<BranchesPage />} />
        <Route path="registers" element={<RegistersPage />} />
        <Route path="hardware" element={<DesktopHardwarePage />} />
        <Route path="roles" element={<RolesPage />} />
        {/* Approval thresholds live under Settings because changing them is
            `manage_settings` work — the same capability that owns the rest of
            the system-wide configuration. */}
        <Route path="approvals" element={<ApprovalRulesPage />} />
        {/* Backup & recovery (Phase 18). Under Settings for the same reason the
            approval thresholds are: it is custody of the installation rather than
            a floor task, and the route guard reads `view_backups` from
            ROUTE_CAPABILITIES like every other path. */}
        <Route path="backup" element={<BackupPage />} />
        {/* Shared brand identity (Phase 46): one brand source for the admin
            shell, login, dashboard and receipts, stored in the website
            settings document the storefront already reads. */}
        <Route path="branding" element={<BrandingPage />} />
        {/* Danger Zone (Phase 47). Its own screen, its own wizard, the
            strongest capability in the table; the route guard has already
            refused every other role before this renders. */}
        <Route path="system" element={<SystemSettingsPage />} />
        <Route path="operations" element={<OperationsCenterPage />} />
        <Route path="*" element={<Navigate to="/dashboard/settings" replace />} />
      </Routes>
    </SettingsProvider>
  );
}
