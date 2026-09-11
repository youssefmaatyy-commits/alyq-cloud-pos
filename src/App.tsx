import { HashRouter, Navigate, Route, Routes } from "react-router-dom";
import { I18nProvider } from "@/lib/i18n/I18nProvider";
import { AuthProvider, LoginRoute, RequireAuth } from "@/lib/auth";
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

import { StorefrontHomePage } from "@/modules/storefront/pages/StorefrontHomePage";
import { StorefrontProductsPage } from "@/modules/storefront/pages/StorefrontProductsPage";
import { StorefrontProductPage } from "@/modules/storefront/pages/StorefrontProductPage";

/**
 * ALYQ Cloud POS — application root.
 * HashRouter keeps deep links working from any static host (including the
 * single-file production build).
 *
 * Routing (Authentication phase) has three branches:
 *   /login     public — rendered outside the shell, with no module providers
 *              mounted, so nothing loads business data before a session exists;
 *   /store/*   public — customer-facing storefront, no auth required;
 *   *          everything else — `RequireAuth` first, then the module providers
 *              and the shell. The shell's `RouteGuard` then applies the
 *              role → screen capability table, and `/audit` adds its own copy.
 */
export default function App() {
  return (
    <I18nProvider>
      <AuthProvider>
        <ToastProvider>
          <HashRouter>
            <Routes>
              <Route path="/" element={<Navigate to="/store" replace />} />
              <Route path="/login" element={<LoginRoute />} />
              <Route path="/store" element={<StorefrontHomePage />} />
              <Route path="/store/products" element={<StorefrontProductsPage />} />
              <Route path="/store/products/:id" element={<StorefrontProductPage />} />
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
        <InventoryProvider>
          <PosProvider>
            <CustomerProvider>
              <ReturnProvider>
                <ExpenseProvider>
                  <ShiftProvider>
                    <AppShell>
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
                        <Route
                          path="/audit"
                          element={
                            <RequireAuditAccess>
                              <AuditLogPage />
                            </RequireAuditAccess>
                          }
                        />
                        <Route path="*" element={<Navigate to="/" replace />} />
                      </Routes>
                    </AppShell>
                  </ShiftProvider>
                </ExpenseProvider>
              </ReturnProvider>
            </CustomerProvider>
          </PosProvider>
        </InventoryProvider>
      </CatalogProvider>
    </RequireAuth>
  );
}
