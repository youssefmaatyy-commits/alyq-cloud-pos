/**
 * Data health — the checks that answer "is what we have consistent?".
 *
 * A backup you cannot trust is worse than no backup, and the way to know is to
 * look at the relationships rather than at the row counts: a sale with no items,
 * a stock movement whose chain skips a step, a profile wearing a custom role that
 * no longer exists, a reservation holding stock for an order that was cancelled.
 * None of those are visible from a dashboard, and all of them are visible here.
 *
 * Two deliberate choices:
 *
 *   1. The checks run over a *normalised model*, not over a mode. A live document
 *      keeps sale items in `sale_items`; the offline directory keeps them inside
 *      each sale. `healthModelFromDocument()` flattens both into the same shape,
 *      so there is one set of checks and one set of tests, and a bug found in
 *      demo mode is the same bug in live mode.
 *
 *   2. Nothing here repairs anything. A finding names a code, a severity, a count,
 *      a few identifiers and a recommendation — and the recommendation points at
 *      the tool that already exists (stock repair for stuck reservations, the
 *      audit log for a broken reference, a restore for corruption). A health
 *      checker that also fixes is a second write path into the database nobody
 *      asked for.
 */
import { APP_ROLES, CAPABILITIES } from "@/lib/permissions/roles";
import { AUDIT_ACTIONS } from "@/modules/audit/types";
import type { BackupDocument, HealthArea, HealthIssue, HealthSeverity } from "../types";

/** One row of anything. A document is JSON by nature; accessors keep it honest. */
export type HealthRow = Record<string, unknown>;

export interface HealthModel {
  products: HealthRow[];
  categories: HealthRow[];
  customers: HealthRow[];
  sales: HealthRow[];
  saleItems: HealthRow[];
  payments: HealthRow[];
  movements: HealthRow[];
  reservations: HealthRow[];
  onlineOrders: HealthRow[];
  onlineOrderItems: HealthRow[];
  returns: HealthRow[];
  returnItems: HealthRow[];
  refunds: HealthRow[];
  expenses: HealthRow[];
  shifts: HealthRow[];
  users: HealthRow[];
  customRoles: HealthRow[];
  audit: HealthRow[];
}

const EMPTY_MODEL: HealthModel = {
  products: [],
  categories: [],
  customers: [],
  sales: [],
  saleItems: [],
  payments: [],
  movements: [],
  reservations: [],
  onlineOrders: [],
  onlineOrderItems: [],
  returns: [],
  returnItems: [],
  refunds: [],
  expenses: [],
  shifts: [],
  users: [],
  customRoles: [],
  audit: [],
};

function rows(value: unknown): HealthRow[] {
  if (!Array.isArray(value)) return [];
  return value.filter((row): row is HealthRow => Boolean(row) && typeof row === "object");
}

function str(row: HealthRow, key: string): string | null {
  const value = row[key];
  return typeof value === "string" && value ? value : null;
}

function num(row: HealthRow, key: string): number | null {
  const value = row[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && !Number.isNaN(Number(value))) return Number(value);
  return null;
}

function idSet(list: HealthRow[]): Set<string> {
  return new Set(list.map((row) => str(row, "id")).filter((id): id is string => Boolean(id)));
}

/**
 * Flatten a document into the model the checks read.
 *
 * Live mode is already flat (one key per table). Demo mode nests: a sale carries
 * its `items` and `payments`, a return carries its items — so those are lifted out
 * and given the `sale_id` / `return_id` a table row would have had.
 */
export function healthModelFromDocument(document: BackupDocument): HealthModel {
  const tables = document.payload.tables ?? {};
  const stores = document.payload.stores ?? {};

  if (document.mode === "supabase") {
    return {
      ...EMPTY_MODEL,
      products: rows(tables.products),
      categories: rows(tables.categories),
      customers: rows(tables.customers),
      sales: rows(tables.sales),
      saleItems: rows(tables.sale_items),
      payments: rows(tables.sale_payments),
      movements: rows(tables.stock_movements),
      reservations: rows(tables.stock_reservations),
      onlineOrders: rows(tables.online_orders),
      onlineOrderItems: rows(tables.online_order_items),
      returns: rows(tables.sales_returns),
      returnItems: rows(tables.return_items),
      refunds: rows(tables.refund_records),
      expenses: rows(tables.expenses),
      shifts: rows(tables.shifts),
      users: rows(tables.profiles),
      customRoles: rows(tables.custom_roles),
      audit: rows(tables.audit_log),
    };
  }

  const sales = rows(stores["alyq.demo.sales.v1"]);
  const returns = rows(stores["alyq.demo.returns.v1"]);

  // Lift the nested arrays out and stamp the parent id onto each child, which is
  // exactly what the live tables already carry.
  const saleItems: HealthRow[] = [];
  const payments: HealthRow[] = [];
  for (const sale of sales) {
    const saleId = str(sale, "id") ?? "";
    for (const item of rows(sale.items)) saleItems.push({ ...item, sale_id: str(item, "sale_id") ?? saleId });
    for (const payment of rows(sale.payments)) {
      payments.push({ ...payment, sale_id: str(payment, "sale_id") ?? saleId });
    }
  }
  const returnItems: HealthRow[] = [];
  for (const returned of returns) {
    const returnId = str(returned, "id") ?? "";
    for (const item of rows(returned.items)) {
      returnItems.push({ ...item, return_id: str(item, "return_id") ?? returnId });
    }
  }

  const settings = stores["alyq.demo.website_settings.v1"];

  return {
    ...EMPTY_MODEL,
    products: rows((stores["alyq.demo.catalog.v1"] as HealthRow | undefined)?.products),
    categories: rows((stores["alyq.demo.catalog.v1"] as HealthRow | undefined)?.categories),
    customers: rows(stores["alyq.demo.customers.v1"]),
    sales,
    saleItems,
    payments,
    movements: rows(stores["alyq.demo.stock_movements.v1"]),
    reservations: rows(stores["alyq.demo.stock_reservations.v1"]),
    onlineOrders: rows(stores["alyq.demo.online_orders.v1"]),
    onlineOrderItems: rows(stores["alyq.demo.online_order_items.v1"]),
    returns,
    returnItems,
    refunds: rows(stores["alyq.demo.refunds.v1"]),
    expenses: rows(stores["alyq.demo.expenses.v1"]),
    shifts: rows(stores["alyq.demo.shifts.v1"]),
    users: rows(stores["alyq.identity.staff.v1"]),
    customRoles: rows(stores["alyq.identity.custom_roles.v1"]),
    audit: rows(stores["alyq.demo.audit_log.v1"]),
    // Read so the "examined" scope can say the storefront settings were in the
    // document even though no check needs them yet.
    ...(settings ? {} : {}),
  };
}

function issue(
  code: string,
  area: HealthArea,
  severity: HealthSeverity,
  affected: Array<string | null>,
): HealthIssue | null {
  const ids = affected.filter((entry): entry is string => Boolean(entry));
  if (ids.length === 0) return null;
  return {
    code,
    area,
    severity,
    messageKey: `backup.health.${code}.message`,
    recommendationKey: `backup.health.${code}.recommendation`,
    count: ids.length,
    // Three is enough to act on and short enough to read; the count carries the
    // size of the problem.
    samples: ids.slice(0, 3),
  };
}

export interface HealthCheckOptions {
  /** Payments within this many units of the total are not a finding. */
  paymentTolerance?: number;
}

/**
 * Run every check. Order is by area, and within an area the loudest finding comes
 * first, so a report reads top-down without needing to be sorted by the caller.
 */
export function runHealthChecks(model: HealthModel, options: HealthCheckOptions = {}): HealthIssue[] {
  const tolerance = options.paymentTolerance ?? 0.01;
  const findings: Array<HealthIssue | null> = [];

  const productIds = idSet(model.products);
  const saleIds = idSet(model.sales);
  const customerIds = idSet(model.customers);
  const orderIds = idSet(model.onlineOrders);
  const returnIds = idSet(model.returns);
  const shiftIds = idSet(model.shifts);
  const roleIds = idSet(model.customRoles);

  // ── inventory ────────────────────────────────────────────────────────────
  findings.push(
    issue(
      "negative_stock",
      "inventory",
      "critical",
      model.products
        .filter((product) => (num(product, "stock_quantity") ?? 0) < 0)
        .map((product) => str(product, "sku") ?? str(product, "id")),
    ),
  );

  // The recorded chain: each movement starts where the previous one ended. A gap
  // means stock moved without a movement being written — the quietest kind of
  // loss there is, and the reason the chain is checked rather than the total.
  const chainGaps: string[] = [];
  const lastQuantity = new Map<string, number>();
  const byProduct = new Map<string, HealthRow[]>();
  for (const movement of model.movements) {
    const productId = str(movement, "product_id");
    if (!productId) continue;
    const list = byProduct.get(productId) ?? [];
    list.push(movement);
    byProduct.set(productId, list);
  }
  for (const [productId, list] of byProduct) {
    const ordered = [...list].sort((a, b) => String(str(a, "created_at") ?? "").localeCompare(String(str(b, "created_at") ?? "")));
    let previous: number | null = null;
    for (const movement of ordered) {
      const before = num(movement, "quantity_before");
      const after = num(movement, "quantity_after");
      if (previous !== null && before !== null && Math.abs(before - previous) > 0.0001) {
        chainGaps.push(str(movement, "id") ?? productId);
      }
      if (after !== null) previous = after;
    }
    if (previous !== null) lastQuantity.set(productId, previous);
  }
  findings.push(issue("movement_chain_gap", "inventory", "warning", chainGaps));

  // …and the chain's end must agree with the product's own number.
  findings.push(
    issue(
      "stock_mismatch",
      "inventory",
      "warning",
      model.products
        .filter((product) => {
          const productId = str(product, "id");
          if (!productId) return false;
          const recorded = lastQuantity.get(productId);
          if (recorded === undefined) return false;
          const actual = num(product, "stock_quantity") ?? 0;
          return Math.abs(recorded - actual) > 0.0001;
        })
        .map((product) => str(product, "sku") ?? str(product, "id")),
    ),
  );

  findings.push(
    issue(
      "movement_orphan",
      "inventory",
      "critical",
      model.movements
        .filter((movement) => {
          const productId = str(movement, "product_id");
          return productId !== null && !productIds.has(productId);
        })
        .map((movement) => str(movement, "id")),
    ),
  );

  // Reservations: Phase 15 already repairs the ones that stick, so the
  // recommendation points there rather than proposing a second repair path.
  findings.push(
    issue(
      "reservation_orphan",
      "inventory",
      "critical",
      model.reservations
        .filter((reservation) => {
          const orderId = str(reservation, "online_order_id");
          const productId = str(reservation, "product_id");
          return (
            (orderId !== null && !orderIds.has(orderId)) || (productId !== null && !productIds.has(productId))
          );
        })
        .map((reservation) => str(reservation, "id")),
    ),
  );
  findings.push(
    issue(
      "reservation_stuck",
      "inventory",
      "warning",
      model.reservations
        .filter((reservation) => {
          if (str(reservation, "status") !== "held") return false;
          const orderId = str(reservation, "online_order_id");
          const order = model.onlineOrders.find((candidate) => str(candidate, "id") === orderId);
          if (!order) return false;
          const status = str(order, "status");
          return status === "cancelled" || status === "completed";
        })
        .map((reservation) => str(reservation, "id")),
    ),
  );
  findings.push(
    issue(
      "reservation_invalid_quantity",
      "inventory",
      "warning",
      model.reservations
        .filter((reservation) => (num(reservation, "quantity") ?? 0) <= 0)
        .map((reservation) => str(reservation, "id")),
    ),
  );

  // ── sales ────────────────────────────────────────────────────────────────
  const itemsBySale = new Map<string, number>();
  for (const item of model.saleItems) {
    const saleId = str(item, "sale_id");
    if (!saleId) continue;
    itemsBySale.set(saleId, (itemsBySale.get(saleId) ?? 0) + 1);
  }
  findings.push(
    issue(
      "sale_without_items",
      "sales",
      "critical",
      model.sales
        .filter((sale) => str(sale, "status") !== "voided" && (itemsBySale.get(str(sale, "id") ?? "") ?? 0) === 0)
        .map((sale) => str(sale, "sale_number") ?? str(sale, "id")),
    ),
  );
  findings.push(
    issue(
      "sale_item_orphan",
      "sales",
      "critical",
      model.saleItems
        .filter((item) => {
          const saleId = str(item, "sale_id");
          const productId = str(item, "product_id");
          return (
            (saleId !== null && !saleIds.has(saleId)) || (productId !== null && !productIds.has(productId))
          );
        })
        .map((item) => str(item, "id")),
    ),
  );
  findings.push(
    issue(
      "sale_customer_orphan",
      "sales",
      "warning",
      model.sales
        .filter((sale) => {
          const customerId = str(sale, "customer_id");
          return customerId !== null && !customerIds.has(customerId);
        })
        .map((sale) => str(sale, "sale_number") ?? str(sale, "id")),
    ),
  );

  const paidBySale = new Map<string, number>();
  for (const payment of model.payments) {
    const saleId = str(payment, "sale_id");
    if (!saleId) continue;
    if (str(payment, "status") === "rejected") continue;
    paidBySale.set(saleId, (paidBySale.get(saleId) ?? 0) + (num(payment, "amount") ?? 0));
  }
  findings.push(
    issue(
      "payment_orphan",
      "sales",
      "critical",
      model.payments
        .filter((payment) => {
          const saleId = str(payment, "sale_id");
          return saleId !== null && !saleIds.has(saleId);
        })
        .map((payment) => str(payment, "id")),
    ),
  );
  findings.push(
    issue(
      "payment_invalid_amount",
      "sales",
      "warning",
      model.payments
        .filter((payment) => {
          const amount = num(payment, "amount");
          return amount === null || amount <= 0;
        })
        .map((payment) => str(payment, "id")),
    ),
  );
  findings.push(
    issue(
      "overpaid_sale",
      "sales",
      "warning",
      model.sales
        .filter((sale) => {
          if (str(sale, "status") === "voided") return false;
          const total = num(sale, "total") ?? 0;
          const paid = paidBySale.get(str(sale, "id") ?? "") ?? 0;
          return paid - total > tolerance;
        })
        .map((sale) => str(sale, "sale_number") ?? str(sale, "id")),
    ),
  );

  // ── returns, refunds, online ─────────────────────────────────────────────
  findings.push(
    issue(
      "return_orphan",
      "sales",
      "critical",
      model.returns
        .filter((entry) => {
          const saleId = str(entry, "sale_id");
          return saleId !== null && !saleIds.has(saleId);
        })
        .map((entry) => str(entry, "id")),
    ),
  );
  findings.push(
    issue(
      "return_item_orphan",
      "sales",
      "critical",
      model.returnItems
        .filter((item) => {
          const returnId = str(item, "return_id") ?? str(item, "sales_return_id");
          return returnId !== null && !returnIds.has(returnId);
        })
        .map((item) => str(item, "id")),
    ),
  );
  findings.push(
    issue(
      "refund_orphan",
      "financial",
      "critical",
      model.refunds
        .filter((refund) => {
          const saleId = str(refund, "sale_id");
          const returnId = str(refund, "sales_return_id") ?? str(refund, "return_id");
          return (
            (saleId !== null && !saleIds.has(saleId)) || (returnId !== null && !returnIds.has(returnId))
          );
        })
        .map((refund) => str(refund, "id")),
    ),
  );
  findings.push(
    issue(
      "online_order_item_orphan",
      "online",
      "critical",
      model.onlineOrderItems
        .filter((item) => {
          const orderId = str(item, "online_order_id");
          return orderId !== null && !orderIds.has(orderId);
        })
        .map((item) => str(item, "id")),
    ),
  );

  // ── financial ────────────────────────────────────────────────────────────
  findings.push(
    issue(
      "expense_orphan_shift",
      "financial",
      "warning",
      model.expenses
        .filter((expense) => {
          const shiftId = str(expense, "shift_id");
          return shiftId !== null && !shiftIds.has(shiftId);
        })
        .map((expense) => str(expense, "id")),
    ),
  );
  findings.push(
    issue(
      "expense_invalid_amount",
      "financial",
      "warning",
      model.expenses
        .filter((expense) => (num(expense, "amount") ?? 0) < 0)
        .map((expense) => str(expense, "id")),
    ),
  );

  // ── identity & permissions ───────────────────────────────────────────────
  const knownRoles = new Set<string>(APP_ROLES);
  const knownCapabilities = new Set<string>(CAPABILITIES);

  findings.push(
    issue(
      "user_invalid_role",
      "identity",
      "critical",
      model.users
        .filter((user) => {
          const role = str(user, "role");
          return role === null || !knownRoles.has(role);
        })
        .map((user) => str(user, "username") ?? str(user, "id")),
    ),
  );
  findings.push(
    issue(
      "user_orphan_custom_role",
      "identity",
      "warning",
      model.users
        .filter((user) => {
          const roleId = str(user, "custom_role_id");
          return roleId !== null && !roleIds.has(roleId);
        })
        .map((user) => str(user, "username") ?? str(user, "id")),
    ),
  );
  findings.push(
    issue(
      "role_unknown_capability",
      "identity",
      "critical",
      model.customRoles.flatMap((role) => {
        const capabilities = Array.isArray(role.capabilities) ? (role.capabilities as unknown[]) : [];
        const unknown = capabilities.filter(
          (capability) => typeof capability !== "string" || !knownCapabilities.has(capability),
        );
        return unknown.length > 0 ? [str(role, "key") ?? str(role, "id")] : [];
      }),
    ),
  );
  // Phase 17's exceptions: an unknown id does nothing silently, and the same act
  // in both lists is a decision nobody made. The database refuses both; a
  // document that predates the constraint should still be reported.
  findings.push(
    issue(
      "user_unknown_exception",
      "identity",
      "warning",
      model.users.flatMap((user) => {
        const lists = [
          ...(Array.isArray(user.extra_capabilities) ? (user.extra_capabilities as unknown[]) : []),
          ...(Array.isArray(user.denied_capabilities) ? (user.denied_capabilities as unknown[]) : []),
        ];
        return lists.some((capability) => typeof capability !== "string" || !knownCapabilities.has(capability))
          ? [str(user, "username") ?? str(user, "id")]
          : [];
      }),
    ),
  );
  findings.push(
    issue(
      "user_contradictory_exception",
      "identity",
      "warning",
      model.users.flatMap((user) => {
        const extra = Array.isArray(user.extra_capabilities) ? (user.extra_capabilities as unknown[]) : [];
        const denied = Array.isArray(user.denied_capabilities) ? (user.denied_capabilities as unknown[]) : [];
        const overlap = extra.some((capability) => denied.includes(capability));
        return overlap ? [str(user, "username") ?? str(user, "id")] : [];
      }),
    ),
  );
  findings.push(
    issue(
      "no_active_admin",
      "identity",
      "critical",
      model.users.some((user) => str(user, "role") === "admin" && user.active !== false)
        ? []
        : ["installation"],
    ),
  );

  // ── audit ────────────────────────────────────────────────────────────────
  const knownActions = new Set<string>(AUDIT_ACTIONS);
  findings.push(
    issue(
      "audit_missing_fields",
      "audit",
      "warning",
      model.audit
        .filter((entry) => !str(entry, "action") || !str(entry, "created_at") || !str(entry, "user_id"))
        .map((entry) => str(entry, "id")),
    ),
  );
  findings.push(
    issue(
      "audit_unknown_action",
      "audit",
      "info",
      model.audit
        .filter((entry) => {
          const action = str(entry, "action");
          return action !== null && !knownActions.has(action);
        })
        .map((entry) => str(entry, "id")),
    ),
  );

  const severityRank: Record<HealthSeverity, number> = { critical: 0, warning: 1, info: 2 };
  return findings
    .filter((finding): finding is HealthIssue => finding !== null)
    .sort((a, b) => severityRank[a.severity] - severityRank[b.severity] || a.area.localeCompare(b.area));
}

/** What a report examined — a clean result is only meaningful next to its scope. */
export function examinedCounts(model: HealthModel): Record<string, number> {
  return {
    products: model.products.length,
    sales: model.sales.length,
    sale_items: model.saleItems.length,
    payments: model.payments.length,
    movements: model.movements.length,
    reservations: model.reservations.length,
    online_orders: model.onlineOrders.length,
    returns: model.returns.length,
    refunds: model.refunds.length,
    expenses: model.expenses.length,
    customers: model.customers.length,
    users: model.users.length,
    custom_roles: model.customRoles.length,
    audit_log: model.audit.length,
  };
}
