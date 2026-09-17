import { HashRouter, Navigate, Route, Routes } from "react-router-dom";
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
} from "@/modules/inventory";
import { PosPage, PosProvider, SaleDetailPage, SalesHistoryPage } from "@/modules/pos";
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

import {
  MarketingPage,
  OnlineNotificationsProvider,
  OnlineOrdersPage,
  OnlineOrdersProvider,
  OnlineReportsPage,
  StockHoldsPage,
  StoreAccountPage,
  StoreCartPage,
  StoreCheckoutPage,
  StoreConfirmationPage,
  StoreAboutPage,
  StoreContactPage,
  StoreContentPage,
  StoreHomePage,
  StoreProductPage,
  StoreProductsPage,
  StoreTrackPage,
  StorefrontApp,
  WebsiteSettingsPage,
} from "@/modules/online";

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
              {/* Its own boundary: a customer who meets a crash gets the shop's
                  screen, not the back office's, and the failure stays on the
                  storefront instead of blanking the app. The `path="/store"` literal
                  stays on the <Route> line: storefrontLink.selftest.ts reads this file
                  and asserts the POS control still has somewhere to land, so splitting
                  the attributes would break the guard without changing the routing. */}
              <Route path="/store" element={
                <ErrorBoundary fallback={<StorefrontCrashScreen />}>
                  <StorefrontApp />
                </ErrorBoundary>
              }>
                <Route index element={<StoreHomePage />} />
                <Route path="products" element={<StoreProductsPage />} />
                {/* `:key` is the slug when a product has one and the id when it
                    does not — both resolve, so a shared link never dies. */}
                <Route path="products/:key" element={<StoreProductPage />} />
                <Route path="cart" element={<StoreCartPage />} />
                <Route path="checkout" element={<StoreCheckoutPage />} />
                <Route path="confirmation" element={<StoreConfirmationPage />} />
                <Route path="track" element={<StoreTrackPage />} />
                <Route path="account" element={<StoreAccountPage />} />
                {/* Phase 45: the shop's own About page, from website_settings.about. */}
                <Route path="about" element={<StoreAboutPage />} />
                <Route path="contact" element={<StoreContactPage />} />
                <Route path="*" element={<Navigate to="/store" replace />} />
              </Route>
              <Route path="*" element={<AuthenticatedApp />} />
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
                            <Route path="/" element={<DashboardPage />} />
                            <Route path="/products" element={<ProductsPage />} />
                            <Route path="/products/new" element={<ProductFormPage mode="create" />} />
                            <Route path="/products/:id" element={<ProductDetailPage />} />
                            <Route path="/products/:id/edit" element={<ProductFormPage mode="edit" />} />
                            <Route path="/categories" element={<CategoriesPage />} />
                            <Route path="/inventory" element={<InventoryPage />} />
                            <Route path="/inventory/movements" element={<MovementsPage />} />
                            {/* The till is the one screen where a blank page stops trade, so it
                                gets a boundary of its own inside the shell: the crash is contained,
                                the navigation survives, and the cashier is told what to do. Same
                                note as /store about keeping the literal on the <Route> line. */}
                            <Route path="/pos" element={
                              <ErrorBoundary fallback={<TillCrashScreen />}>
                                <PosPage />
                              </ErrorBoundary>
                            } />
                            <Route path="/pos/sales" element={<SalesHistoryPage />} />
                            <Route path="/pos/sales/:id" element={<SaleDetailPage />} />
                            <Route path="/customers" element={<CustomersPage />} />
                            <Route path="/customers/:id" element={<CustomerDetailPage />} />
                            <Route path="/returns" element={<ReturnsPage />} />
                            <Route path="/returns/:id" element={<ReturnDetailPage />} />
                            <Route path="/refunds" element={<RefundsPage />} />
                            <Route path="/refunds/:id" element={<RefundDetailPage />} />
                            <Route path="/shifts" element={<ShiftDashboardPage />} />
                            <Route path="/shifts/history" element={<ShiftHistoryPage />} />
                            <Route path="/expenses" element={<ExpensesPage />} />
                            {/* Approval limits (Phase 12). The inbox is readable by
                                every signed-in role — an approver sees every
                                request, a requester sees their own — so the path
                                carries no capability in `routes.ts`; deciding a
                                request is asserted in the service. */}
                            <Route path="/approvals" element={<ApprovalsPage />} />
                            <Route path="/reports" element={<ReportsPage />} />
                            {/* Advanced reports (Phase 14). Same providers, same
                                date window, same read capability as the hub —
                                `/reports` in `routes.ts` covers this path by
                                longest-prefix — but it renders the analysis
                                instead of the raw extracts. */}
                            <Route path="/reports/advanced" element={<AdvancedReportsPage />} />
                            <Route path="/online/orders" element={<OnlineOrdersPage />} />
                            <Route path="/online/reservations" element={<StockHoldsPage />} />
                            <Route path="/online/website" element={<WebsiteSettingsPage />} />
                            <Route path="/online/marketing" element={<MarketingPage />} />
                            <Route path="/online/content" element={<StoreContentPage />} />
                            <Route path="/online/reports" element={<OnlineReportsPage />} />
                            <Route
                              path="/audit"
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
                            <Route path="/settings/*" element={<SettingsArea />} />
                            <Route path="*" element={<Navigate to="/" replace />} />
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
    </RequireAuth>
  );
}

/**
 * Settings → Users and Settings → Roles.
 *
 * `/settings` itself holds no screen: it forwards to the directory, which is what
 * an administrator means by "settings" in an installation where the only two
 * settings screens are people and permissions. Each child carries its own
 * capability (`manage_users`, `manage_roles`) in `ROUTE_CAPABILITIES`, so a role
 * can be given one without the other.
 */
function SettingsArea() {
  return (
    <SettingsProvider>
      <Routes>
        <Route index element={<Navigate to="/settings/users" replace />} />
        <Route path="users" element={<UsersPage />} />
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
        <Route path="*" element={<Navigate to="/settings/users" replace />} />
      </Routes>
    </SettingsProvider>
  );
}
