import { HashRouter, Navigate, Route, Routes } from "react-router-dom";
import { I18nProvider } from "@/lib/i18n/I18nProvider";
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

/**
 * ALYQ Cloud POS — application root.
 * HashRouter keeps deep links working from any static host (including the
 * single-file production build).
 */
export default function App() {
  return (
    <I18nProvider>
      <ToastProvider>
        <CatalogProvider>
          <InventoryProvider>
            <PosProvider>
              <CustomerProvider>
                <ReturnProvider>
                 <ExpenseProvider>
                  <ShiftProvider>
                  <HashRouter>
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
                  </HashRouter>
                  </ShiftProvider>
                 </ExpenseProvider>
                </ReturnProvider>
              </CustomerProvider>
            </PosProvider>
          </InventoryProvider>
        </CatalogProvider>
      </ToastProvider>
    </I18nProvider>
  );
}
