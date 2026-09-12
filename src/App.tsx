import { HashRouter, Navigate, Route, Routes } from "react-router-dom";
import { I18nProvider } from "@/lib/i18n/I18nProvider";
import {
  AuthProvider,
  ForgotPasswordPage,
  LoginRoute,
  RequireAuth,
  ResetPasswordPage,
  normalizeRecoveryUrl,
} from "@/lib/auth";
import { ToastProvider } from "@/components/ui";
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

import {
  MarketingPage,
  OnlineNotificationsProvider,
  OnlineOrdersPage,
  OnlineOrdersProvider,
  OnlineReportsPage,
  StoreAccountPage,
  StoreCartPage,
  StoreCheckoutPage,
  StoreConfirmationPage,
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

export default function App() {
  return (
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
              <Route path="/store" element={<StorefrontApp />}>
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
                <Route path="contact" element={<StoreContactPage />} />
                <Route path="*" element={<Navigate to="/store" replace />} />
              </Route>
              <Route path="*" element={<AuthenticatedApp />} />
            </Routes>
          </HashRouter>
        </ToastProvider>
      </AuthProvider>
    </I18nProvider>
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
                            <Route path="/pos" element={<PosPage />} />
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
                            <Route path="/settings" element={<SettingsArea />} />
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
        <Route path="*" element={<Navigate to="/settings/users" replace />} />
      </Routes>
    </SettingsProvider>
  );
}
