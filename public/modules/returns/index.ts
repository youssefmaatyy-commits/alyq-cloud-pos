/**
 * Returns & Refunds module (Phase 7).
 */
export { ReturnProvider, useReturns } from "./hooks/ReturnProvider";
export { ReturnsPage } from "./pages/ReturnsPage";
export { ReturnDetailPage } from "./pages/ReturnDetailPage";
export { RefundsPage } from "./pages/RefundsPage";
export { RefundDetailPage } from "./pages/RefundDetailPage";
export { ReturnFormModal } from "./components/ReturnFormModal";
export * from "./types";
export * from "./validation";
export {
  loadReturns,
  loadRefunds,
  processReturn,
  queryReturns,
  queryRefunds,
} from "./services/returnService";
export {
  getReturnRepository,
  getReturnMode,
  DemoReturnRepository,
  SupabaseReturnRepository,
} from "./data";
export type { ReturnRepository } from "./data/repository";
