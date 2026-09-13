/**
 * Inventory protection — the arithmetic that stops the website overselling.
 *
 * A pending online order does not deduct stock; it *reserves* it. Deducting at
 * checkout would be wrong twice over: a cancelled order would have to be
 * un-deducted (and a stock ledger that goes down and back up misrepresents what
 * happened), and an order that is never approved would silently shrink the
 * catalogue. Reserving keeps the truth in one place:
 *
 *   stock_quantity          what is physically on the shelf
 *   reserved_quantity       what pending website orders are holding
 *   available to promise    the difference — what the next customer may buy
 *
 * The POS is unaffected: the till sells from `stock_quantity`, and a website
 * order only becomes a deduction when it is approved, at which point the
 * reservation is converted and the sale takes the units. Between the two, both
 * the till and the website see the same reduced availability, because the till
 * re-reads stock at completion and the website checks availability here.
 */
import type { OnlineOrder, StockReservation } from "../types";

/** Units held per product, across every reservation still open. */
export function reservedByProduct(
  reservations: readonly StockReservation[],
): Map<string, number> {
  const totals = new Map<string, number>();
  for (const reservation of reservations) {
    if (reservation.status !== "reserved") continue;
    totals.set(reservation.product_id, (totals.get(reservation.product_id) ?? 0) + reservation.quantity);
  }
  return totals;
}

/**
 * How many units of a product may still be promised.
 *
 * `null` means unlimited: a product with stock tracking switched off (a service,
 * a made-to-order drink) has no shelf to run down.
 */
export function availableToPromise(
  product: { stock_tracking_enabled: boolean; stock_quantity: number },
  reserved: number,
): number | null {
  if (!product.stock_tracking_enabled) return null;
  return Math.max(product.stock_quantity - Math.max(reserved, 0), 0);
}

/** Convenience: read the reserved count for one product out of the map. */
export function reservedOf(totals: ReadonlyMap<string, number>, productId: string): number {
  return totals.get(productId) ?? 0;
}

export interface OversellLine {
  product_id: string;
  sku: string;
  requested: number;
  available: number;
}

/**
 * Every line a cart cannot actually fulfil right now.
 *
 * Returns all of them, not just the first: a checkout that reports one shortage
 * at a time makes the customer submit four times.
 */
export function findOversell(
  lines: readonly { product_id: string; quantity: number }[],
  products: readonly {
    id: string;
    sku: string;
    stock_tracking_enabled: boolean;
    stock_quantity: number;
  }[],
  reserved: ReadonlyMap<string, number>,
): OversellLine[] {
  const problems: OversellLine[] = [];
  const byId = new Map(products.map((product) => [product.id, product]));

  // Quantities of the same product across two lines add up: a customer who adds
  // the same piece twice must not be promised the last unit twice.
  const wanted = new Map<string, number>();
  for (const line of lines) {
    wanted.set(line.product_id, (wanted.get(line.product_id) ?? 0) + Math.max(line.quantity, 0));
  }

  for (const [productId, quantity] of wanted) {
    const product = byId.get(productId);
    if (!product) continue;
    const available = availableToPromise(product, reservedOf(reserved, productId));
    if (available === null) continue;
    if (quantity > available) {
      problems.push({ product_id: productId, sku: product.sku, requested: quantity, available });
    }
  }

  return problems;
}

/**
 * True while an order is still holding stock — which is exactly one status.
 *
 * Approving converts the hold into the POS sale's own deduction, so from
 * "approved" onwards the units are already off the shelf and a reservation left
 * open would count them twice. Cancelling releases them. A pending order is the
 * only state where the website is holding units the till cannot sell.
 */
export function holdsReservation(status: OnlineOrder["status"]): boolean {
  return status === "pending";
}

/**
 * Reservations that belong to orders which can no longer hold stock.
 *
 * The repository resolves every hold at the moment of the transition; this exists
 * so a repair pass (and the tests) can spot a leak — units a cancelled, approved
 * or completed order is still keeping out of the pool.
 */
export function staleReservations(
  reservations: readonly StockReservation[],
  orders: readonly OnlineOrder[],
): StockReservation[] {
  const statusById = new Map(orders.map((order) => [order.id, order.status]));
  return reservations.filter((reservation) => {
    if (reservation.status !== "reserved") return false;
    const status = statusById.get(reservation.online_order_id);
    return status !== undefined && !holdsReservation(status);
  });
}

/** Total units currently held across the whole website. */
export function totalReserved(reservations: readonly StockReservation[]): number {
  return reservations
    .filter((reservation) => reservation.status === "reserved")
    .reduce((sum, reservation) => sum + reservation.quantity, 0);
}
