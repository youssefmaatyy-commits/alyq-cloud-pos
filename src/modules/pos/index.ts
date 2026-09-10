/**
 * POS + Sales module (Phase 4) public surface.
 * Reuses Products (catalog), Inventory (stock + movements + roles) and the
 * catalog barcode encoder. This module owns: cart, sales, discounts, payments
 * and receipts.
 */
export { PosProvider, usePos } from "./hooks/PosProvider";
export { useBarcodeScanner } from "./hooks/useBarcodeScanner";
export { PosPage } from "./pages/PosPage";
export { SalesHistoryPage } from "./pages/SalesHistoryPage";
export { SaleDetailPage } from "./pages/SaleDetailPage";
export { ProductGrid } from "./components/ProductGrid";
export { CartPanel } from "./components/CartPanel";
export { PaymentPanel } from "./components/PaymentPanel";
export { SaleCompletedModal } from "./components/SaleCompletedModal";
export {
  cartTotals,
  cartSubtotal,
  discountAmount,
  lineTotal,
  round2,
  cashChange,
  validateDiscount,
  sumPayments,
  paymentsRemaining,
  smartPaymentCalc,
  autoBalanceOther,
  MAX_DISCOUNT_PERCENT,
} from "./services/posMath";
export type { CartTotals, SmartPayment } from "./services/posMath";
export { buildReceiptHtml, buildReturnReceiptHtml, printHtmlDocument, writeAndPrint, customerInfoIssue } from "./services/receipt";
export type {
  CustomerInfoIssue,
  PrintOutcome,
  ReceiptData,
  ReceiptStrings,
  ReturnReceiptData,
  ReturnReceiptRecord,
  ReturnReceiptStrings,
} from "./services/receipt";
export {
  PAYMENT_METHODS,
  EMPTY_DISCOUNT,
  newClientRef,
} from "./types";
export type {
  Sale,
  SaleItem,
  SalePayment,
  SalePaymentInput,
  SaleStatus,
  PaymentMethod,
  PaymentStatus,
  DiscountType,
  CartLine,
  CartDiscount,
  CompleteSaleInput,
  ConfirmPaymentInput,
  VoidSaleInput,
} from "./types";
export {
  canCompleteSale,
  canApplyDiscount,
  canVoidSale,
  canConfirmPayment,
  POS_ROLES,
} from "./permissions";
export type { PosRole } from "./permissions";
export { getSalesRepository, getSalesMode } from "./data";
export type { SalesRepository } from "./data/repository";
export { DemoSalesRepository } from "./data/demoRepository";
export { SupabaseSalesRepository } from "./data/supabaseRepository";
