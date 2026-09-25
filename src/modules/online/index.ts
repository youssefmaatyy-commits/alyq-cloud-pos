/**
 * The online module's public surface.
 *
 * Two audiences import from here and they should never have to know about each
 * other's internals: `App.tsx` needs the storefront root and the five POS/admin
 * screens, and the shell needs the notification provider that drives the
 * new-order badge. Everything else — repositories, services, types — stays
 * reachable by path for the module's own pages and tests.
 */
export { StorefrontApp } from "./StorefrontApp";

// The legacy customer pages are NOT exported by this production barrel. The
// registered rollback suites import them directly through their test-only
// esbuild projection; the public app routes only to the canonical V2 pages.

// POS / back-office screens
export { OnlineOrdersPage } from "./pages/OnlineOrdersPage";
export { WebsiteSettingsPage } from "./pages/WebsiteSettingsPage";
export { MarketingPage } from "./pages/MarketingPage";
export { DeliveryZonesPage } from "./pages/DeliveryZonesPage";
export { PromotionsPage } from "./pages/PromotionsPage";
export { StoreContentPage } from "./pages/StoreContentPage";
export { OnlineReportsPage } from "./pages/OnlineReportsPage";

// Providers
export { OnlineOrdersProvider, useOnlineOrders } from "./hooks/OnlineOrdersProvider";
export { StockHoldsPage } from "./pages/StockHoldsPage";
export { ReservationSummaryCard } from "./components/ReservationSummaryCard";

// Stock-hold reconciliation (Phase 15). Exported so the inventory screen can show
// how many units the website is holding, and so the tests drive the same review
// the repair screen renders.
export {
  AGING_HOLD_DAYS,
  RESERVATION_VERDICTS,
  assertCanRepairReservations,
  heldByProduct,
  mayRepairReservations,
  repairAllFindings,
  repairFinding,
  repairHold,
  restoreHold,
  reviewReservations,
} from "./services/reservationRepair";
export type {
  RepairBatchOutcome,
  RepairOutcome,
  ReservationReview,
  ReservationReviewRow,
  ReservationSeverity,
  ReservationVerdict,
} from "./services/reservationRepair";
export {
  OnlineNotificationsProvider,
  useOnlineNotificationState,
} from "./hooks/OnlineNotificationsProvider";
