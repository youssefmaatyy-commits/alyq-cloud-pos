/**
 * Returns & Refunds module (Phase 7).
 */
export { ReturnProvider, useReturns } from "./hooks/ReturnProvider";
export { ReturnsPage } from "./pages/ReturnsPage";
export { ReturnDetailPage } from "./pages/ReturnDetailPage";
export { RefundsPage } from "./pages/RefundsPage";
export { RefundDetailPage } from "./pages/RefundDetailPage";
export { ReturnFormModal } from "./components/ReturnFormModal";
export { RefundSettleModal } from "./components/RefundSettleModal";
export * from "./types";
export * from "./validation";
export {
  loadReturns,
  loadRefunds,
  loadReturn,
  loadRefundsForSale,
  pendingRefunds,
  processReturn,
  settleRefund,
  queryReturns,
  queryRefunds,
  assertCanCreateReturn,
  assertCanApproveReturn,
  assertCanRejectReturn,
  assertCanSettleRefund,
  assertCanRejectRefund,
  assertCanRecordRefund,
} from "./services/returnService";
export {
  canProcessReturn,
  canProcessRefund,
  canSettleRefund,
  canRejectRefund,
  canApproveReturn,
} from "./permissions";
export {
  getReturnRepository,
  getReturnMode,
  DemoReturnRepository,
  SupabaseReturnRepository,
} from "./data";
export type { ReturnRepository } from "./data/repository";
