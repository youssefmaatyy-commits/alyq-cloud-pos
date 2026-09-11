/**
 * Customers module (Phase 7).
 */
export { CustomerProvider, useCustomers } from "./hooks/CustomerProvider";
export { CustomersPage } from "./pages/CustomersPage";
export { CustomerDetailPage } from "./pages/CustomerDetailPage";
export { CustomerFormModal } from "./components/CustomerFormModal";
export { CustomerSearchSelect } from "./components/CustomerSearchSelect";
export * from "./types";
export * from "./validation";
export {
  loadCustomers,
  saveCustomer,
  deleteCustomer,
  queryCustomers,
} from "./services/customerService";
export {
  getCustomerRepository,
  getCustomerMode,
  DemoCustomerRepository,
  SupabaseCustomerRepository,
} from "./data";
export type { CustomerRepository } from "./data/repository";
