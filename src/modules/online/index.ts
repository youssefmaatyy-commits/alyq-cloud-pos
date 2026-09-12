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

// Customer-facing pages
export { StoreHomePage } from "./pages/StoreHomePage";
export { StoreProductsPage } from "./pages/StoreProductsPage";
export { StoreProductPage } from "./pages/StoreProductPage";
export { StoreCartPage } from "./pages/StoreCartPage";
export { StoreCheckoutPage } from "./pages/StoreCheckoutPage";
export { StoreConfirmationPage } from "./pages/StoreConfirmationPage";
export { StoreTrackPage } from "./pages/StoreTrackPage";
export { StoreAccountPage } from "./pages/StoreAccountPage";
export { StoreContactPage } from "./pages/StoreContactPage";

// POS / back-office screens
export { OnlineOrdersPage } from "./pages/OnlineOrdersPage";
export { WebsiteSettingsPage } from "./pages/WebsiteSettingsPage";
export { MarketingPage } from "./pages/MarketingPage";
export { StoreContentPage } from "./pages/StoreContentPage";
export { OnlineReportsPage } from "./pages/OnlineReportsPage";

// Providers
export { OnlineOrdersProvider, useOnlineOrders } from "./hooks/OnlineOrdersProvider";
export {
  OnlineNotificationsProvider,
  useOnlineNotificationState,
} from "./hooks/OnlineNotificationsProvider";
