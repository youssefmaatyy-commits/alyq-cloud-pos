/**
 * The public storefront's own root.
 *
 * `/store/*` is rendered outside the signed-in application — no session, no
 * module providers from the POS, no shell — because a shopper must be able to
 * browse and buy without an account and without the app loading a single row of
 * business data on their behalf. What it does need is its own three providers,
 * in this order:
 *
 *   1. `StorefrontProvider`  the shop: settings, catalogue, campaigns, reviews;
 *   2. `StoreAccountProvider` the shopper: profile, addresses, wishlist, history;
 *   3. `StoreCartProvider`    the basket, which reads both (a signed-in shopper's
 *      saved address pre-fills checkout, and a campaign price needs the catalogue).
 *
 * `StorefrontV2Shell` sits inside all three so the header can show the cart
 * count and account link, and `<Outlet/>` renders the single public page tree.
 * The former `StoreLayout` and pages remain in source for route-level rollback.
 */
import { Outlet } from "react-router-dom";
import { StorefrontProvider } from "./hooks/StorefrontProvider";
import { StoreAccountProvider } from "./hooks/StoreAccountProvider";
import { StoreCartProvider } from "./hooks/StoreCartProvider";
import { StorefrontV2Shell } from "./v2/StorefrontV2Shell";

export function StorefrontApp() {
  return (
    <StorefrontProvider>
      <StoreAccountProvider>
        <StoreCartProvider>
          <StorefrontV2Shell><Outlet /></StorefrontV2Shell>
        </StoreCartProvider>
      </StoreAccountProvider>
    </StorefrontProvider>
  );
}
