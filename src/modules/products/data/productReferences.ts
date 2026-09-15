import { safeStorage } from "./demoSeed";
import { EMPTY_PRODUCT_REFERENCES, type ProductReferenceCounts, type ProductReferenceMap } from "./repository";

/**
 * Demo-mode mirror of `public.product_reference_counts` (migration 0037).
 *
 * The live database counts rows in the five history tables a permanently
 * deleted product would orphan. Demo mode keeps those same ledgers in
 * localStorage, so the exact same question is answered by scanning them.
 * The keys belong to the POS / returns / inventory / online demo stores; they
 * are read here as plain JSON rather than through those modules' repositories,
 * because the catalog repository is deliberately at the bottom of the import
 * graph — reaching into the POS module from here would create the cycle the
 * layering exists to prevent. The stored shapes are the modules' own domain
 * types (Sale.items, SalesReturn.items, StockMovement, OnlineOrder.items,
 * StockReservation), each carrying `product_id`.
 *
 * The five buckets are the same five the SQL function reports, so a table
 * rendered from demo data and a table rendered from a live database disable
 * permanent deletion for exactly the same products.
 */

const SALES_KEY = "alyq.demo.sales.v1";
const RETURNS_KEY = "alyq.demo.returns.v1";
const MOVEMENTS_KEY = "alyq.demo.stock_movements.v1";
const ORDERS_KEY = "alyq.demo.online_orders.v1";
const RESERVATIONS_KEY = "alyq.demo.stock_reservations.v1";

function readArray(key: string): unknown[] {
  const raw = safeStorage.get(key);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Rows that carry a nested `items` array (sales, returns, online orders). */
function lineItems(rows: unknown[]): unknown[] {
  const items: unknown[] = [];
  for (const row of rows) {
    const lines = (row as { items?: unknown }).items;
    if (Array.isArray(lines)) items.push(...lines);
  }
  return items;
}

function countByProduct(rows: unknown[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const id = (row as { product_id?: unknown }).product_id;
    if (typeof id === "string" && id.length > 0) {
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
  }
  return counts;
}

/**
 * Every demo product id that has preserved history, with the per-table
 * breakdown. Pure read — nothing is written, normalised or repaired.
 */
export function demoProductReferences(): ProductReferenceMap {
  const sales = countByProduct(lineItems(readArray(SALES_KEY)));
  const returns = countByProduct(lineItems(readArray(RETURNS_KEY)));
  const movements = countByProduct(readArray(MOVEMENTS_KEY));
  const orderItems = countByProduct(lineItems(readArray(ORDERS_KEY)));
  const reservations = countByProduct(readArray(RESERVATIONS_KEY));

  const map: ProductReferenceMap = {};
  const ids = new Set<string>([
    ...sales.keys(),
    ...returns.keys(),
    ...movements.keys(),
    ...orderItems.keys(),
    ...reservations.keys(),
  ]);
  for (const id of ids) {
    const counts: ProductReferenceCounts = {
      sale_items: sales.get(id) ?? 0,
      return_items: returns.get(id) ?? 0,
      stock_movements: movements.get(id) ?? 0,
      online_order_items: orderItems.get(id) ?? 0,
      stock_reservations: reservations.get(id) ?? 0,
      total: 0,
    };
    counts.total =
      counts.sale_items +
      counts.return_items +
      counts.stock_movements +
      counts.online_order_items +
      counts.stock_reservations;
    if (counts.total > 0) map[id] = counts;
  }
  return map;
}

/** The same question for one product — zeros when it has no history. */
export function demoProductReferenceCounts(productId: string): ProductReferenceCounts {
  return demoProductReferences()[productId] ?? { ...EMPTY_PRODUCT_REFERENCES };
}
