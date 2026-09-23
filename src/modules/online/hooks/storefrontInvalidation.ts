/**
 * Lightweight cross-tree invalidation for the storefront snapshot.
 *
 * The StorefrontProvider lives under `/store/*` (public, no auth), while
 * admin pages like MarketingPage, PromotionsPage, DeliveryZonesPage live
 * under `/online/*` (authenticated shell). They share no React context.
 *
 * This module provides a simple emitter so admin writes can tell the
 * storefront to refetch its snapshot — works in both demo and live mode.
 */
type Listener = () => void;

const listeners = new Set<Listener>();

export const storefrontInvalidation = {
  /** Call after a successful admin write (campaign, coupon, promotion, zone). */
  notify(): void {
    for (const listener of listeners) listener();
  },

  /** StorefrontProvider subscribes on mount, unsubscribes on unmount. */
  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};