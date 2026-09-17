/**
 * Storefront checkout contract — the live path, headless (no DOM, no network).
 *
 * Run with:
 *   npx esbuild src/modules/online/__tests__/checkout.selftest.ts \
 *     --bundle --format=esm --platform=node --outfile=/tmp/alyq-checkout.mjs && node /tmp/alyq-checkout.mjs
 *
 * `SupabaseOnlineRepository.placeOrder` is the only way an order reaches the
 * database from the shop, and CI has no reachable Supabase project, so the
 * wiring is otherwise unverified. This suite drives the real class against a stub
 * client that answers exactly the way PostgREST does, and pins three contracts:
 *
 *   1. what travels to `place_online_order`: the customer's own fields, the
 *      lines as `{ product_id, qty }` (never a price — the function prices the
 *      cart from the catalogue), and a `store_customer_id` that can only be a
 *      real `store_customers.id`. Website accounts are browser-local with ids
 *      like `cus-…`, and the function casts the field to `uuid` while entering
 *      its block — a local id aborted the whole order with `22P02` (HTTP 400)
 *      before any validation and before a single row was written.
 *   2. how the placed order is read back: a guest cannot select
 *      `online_orders`/`online_order_items`/`order_events` (staff-only under
 *      RLS), so the confirmation must come from the phone-gated
 *      `lookup_online_order`, with the staff read as the fallback. Reading the
 *      tables directly is the defect this suite exists to catch: it made a
 *      successfully placed order look like a failure.
 *   3. what the customer and the operator are told when the server refuses:
 *      the friendly code from the server's own wording (stock, coupon,
 *      visibility), never a collapsed `"[object Object]"`.
 *
 * The last block is a source guard: it fails if `placeOrder` can go back to
 * reading the order tables directly, or the checkout provider to logging a
 * stringified throwable.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  OnlineError,
  describeThrown,
  toOnlineError,
} from "../data/repository";
import { SupabaseOnlineRepository, toStoreCustomerId } from "../data/supabaseRepository";
import type { CustomerAddress, PlaceOrderInput } from "../types";

type TestCase = { name: string; fn: () => void | Promise<void> };
const tests: TestCase[] = [];
const test = (name: string, fn: () => void | Promise<void>) => tests.push({ name, fn });

// ── stub client ──────────────────────────────────────────────────────────────
type Row = Record<string, unknown>;
type Result = { data: unknown; error: unknown };

/**
 * A PostgREST failure as it really arrives: a **plain object**, not an `Error`.
 * `String()` on it is `"[object Object]"`, which is how the checkout used to
 * lose the server's wording, SQLSTATE and hint.
 */
const postgrestError = (fields: {
  code: string;
  message: string;
  details?: string | null;
  hint?: string | null;
}) => ({ details: null, hint: null, ...fields });

const ORDER_ID = "1f0a2b3c-4d5e-4f60-8a9b-0c1d2e3f4a5b";
const CLIENT_REF = "ref-8f20c1";

const ORDER_ROW: Row = {
  id: ORDER_ID,
  order_number: "WEB-000007",
  client_ref: CLIENT_REF,
  store_customer_id: null,
  customer_name: "أحمد الشريف",
  customer_phone: "0501234567",
  customer_email: null,
  delivery_type: "delivery",
  address: { city: "القاهرة", area: "مدينة نصر", street: "شارع 9", building: "12" },
  subtotal: "350.00",
  discount_code: null,
  discount_amount: "0.00",
  delivery_fee: "30.00",
  total: "380.00",
  payment_method: "cod",
  payment_status: "pending",
  status: "pending",
  payment_reference: null,
  payment_proof_url: null,
  payment_submitted_at: null,
  payment_verified_by: null,
  payment_verified_by_name: null,
  payment_verified_at: null,
  payment_rejected_reason: null,
  sale_id: null,
  sale_number: null,
  notes: null,
  cancellation_reason: null,
  approved_by: null,
  approved_by_name: null,
  approved_at: null,
  cancelled_by: null,
  cancelled_by_name: null,
  cancelled_at: null,
  completed_at: null,
  created_at: "2026-09-17T09:00:00.000Z",
  updated_at: "2026-09-17T09:00:00.000Z",
};

const ITEM_ROW: Row = {
  id: "item-1",
  order_id: ORDER_ID,
  product_id: "prod-ring",
  sku: "SCN-A",
  barcode: "6291000000011",
  name_ar: "خاتم",
  name_en: "Classic Gold Ring",
  unit_price: "350.00",
  quantity: 1,
  line_total: "350.00",
  created_at: "2026-09-17T09:00:00.000Z",
};

const EVENT_ROW: Row = {
  id: "event-1",
  order_id: ORDER_ID,
  kind: "placed",
  note: null,
  user_id: null,
  user_name: null,
  created_at: "2026-09-17T09:00:00.000Z",
};

interface StubOptions {
  /** The answer to `rpc("place_online_order", …)`. */
  place?: Result;
  /** The answer to `rpc("lookup_online_order", …)`. */
  lookup?: Result;
  /** Rows the order tables answer with (the staff read-back). */
  tables?: { online_orders?: Row[]; online_order_items?: Row[]; order_events?: Row[] };
  /** Tables that answer with a PostgREST error object. */
  errorOn?: string[];
}

/** Records every call and answers like PostgREST — including plain-object errors. */
function makeStub(options: StubOptions = {}) {
  const calls: string[] = [];
  const payloads: Record<string, unknown> = {};

  const table = (name: string) => {
    const rows = options.tables?.[name as keyof NonNullable<StubOptions["tables"]>] ?? [];
    const filters: Array<(row: Row) => boolean> = [];
    let maybeOne = false;

    const builder: Record<string, unknown> & PromiseLike<Result> = {
      select() {
        calls.push(`from.${name}.select`);
        return builder;
      },
      eq(column: string, value: unknown) {
        filters.push((row) => row[column] === value);
        return builder;
      },
      in(column: string, values: unknown[]) {
        filters.push((row) => values.includes(row[column]));
        return builder;
      },
      order() {
        return builder;
      },
      limit() {
        return builder;
      },
      maybeSingle() {
        calls.push(`from.${name}.maybeSingle`);
        maybeOne = true;
        return builder;
      },
      single() {
        calls.push(`from.${name}.single`);
        maybeOne = true;
        return builder;
      },
      then<TResult1 = Result, TResult2 = never>(
        onfulfilled?: ((value: Result) => TResult1 | PromiseLike<TResult1>) | null,
        onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
      ): PromiseLike<TResult1 | TResult2> {
        const errorOn = (options.errorOn ?? []).includes(name);
        const matched = rows.filter((row) => filters.every((keep) => keep(row)));
        const result: Result = errorOn
          ? {
              data: null,
              error: postgrestError({
                code: "42501",
                message: `permission denied for table ${name}`,
                hint: `GRANT SELECT ON public.${name} TO anon;`,
              }),
            }
          : { data: maybeOne ? (matched[0] ?? null) : matched, error: null };
        return Promise.resolve(result).then(onfulfilled, onrejected);
      },
    };
    return builder;
  };

  const client = {
    rpc(name: string, args: Record<string, unknown>) {
      calls.push(`rpc.${name}`);
      if (args && "p_payload" in args) payloads.p_payload = args.p_payload;
      if (args && "p_order_number" in args) payloads.p_order_number = args.p_order_number;
      if (args && "p_phone" in args) payloads.p_phone = args.p_phone;
      const answer =
        name === "place_online_order"
          ? (options.place ?? {
              data: { order_id: ORDER_ID, order_number: "WEB-000007", duplicate: false },
              error: null,
            })
          : name === "lookup_online_order"
            ? (options.lookup ?? {
                data: {
                  order: ORDER_ROW,
                  items: [ITEM_ROW],
                  events: [{ kind: "placed", note: null, user_name: null, created_at: "2026-09-17T09:00:00.000Z" }],
                },
                error: null,
              })
            : (options.lookup ?? { data: null, error: null });
      return Promise.resolve(answer);
    },
    from: table,
  };

  return { client, calls, payloads };
}

const repo = (stub: ReturnType<typeof makeStub>) =>
  new SupabaseOnlineRepository(stub.client as never);

/** The address as the checkout form builds it — a whole CustomerAddress. */
const ADDRESS: CustomerAddress = {
  id: "addr-1",
  label: "Home",
  full_name: "أحمد الشريف",
  phone: "0501234567",
  city: "القاهرة",
  area: "مدينة نصر",
  street: "شارع 9",
  building: "12",
  floor: "3",
  apartment: "7",
  is_default: true,
  notes: null,
};

const guestOrder = (over: Partial<PlaceOrderInput> = {}): PlaceOrderInput => ({
  client_ref: CLIENT_REF,
  customer_name: "أحمد الشريف",
  customer_phone: "0501234567",
  customer_email: null,
  store_customer_id: null,
  delivery_type: "delivery",
  address: ADDRESS,
  lines: [{ product_id: "prod-ring", qty: 1 }],
  coupon_code: null,
  payment_method: "cod",
  notes: null,
  ...over,
});

// ── 1. what travels to the database ──────────────────────────────────────────

test("a guest order sends the customer's fields and lines, and no price", async () => {
  const stub = makeStub();
  await repo(stub).placeOrder(guestOrder({ notes: "اتصل قبل التسليم" }));

  assert.deepEqual(stub.payloads.p_payload, {
    client_ref: CLIENT_REF,
    customer_name: "أحمد الشريف",
    customer_phone: "0501234567",
    customer_email: null,
    store_customer_id: null,
    delivery_type: "delivery",
    address: ADDRESS,
    lines: [{ product_id: "prod-ring", qty: 1 }],
    coupon_code: null,
    payment_method: "cod",
    notes: "اتصل قبل التسليم",
  });
});

test("a pickup order sends `{}` for the address, never null", async () => {
  const stub = makeStub();
  await repo(stub).placeOrder(guestOrder({ delivery_type: "pickup", address: null }));

  const payload = stub.payloads.p_payload as { address: unknown; delivery_type: string };
  assert.equal(payload.delivery_type, "pickup");
  assert.deepEqual(payload.address, {}, "the column is not null, so pickup sends an empty object");
});

test("a coupon code is normalised before it travels", async () => {
  const stub = makeStub();
  await repo(stub).placeOrder(guestOrder({ coupon_code: "  welcome 10 " }));

  assert.equal((stub.payloads.p_payload as { coupon_code: string }).coupon_code, "WELCOME10");
});

test("a browser-local account id never travels as store_customer_id", async () => {
  // `localAccounts.newId("cus")` produces ids like this one; the function casts
  // the field to `uuid`, so sending it aborted the order with 22P02 / HTTP 400.
  const stub = makeStub();
  await repo(stub).placeOrder(guestOrder({ store_customer_id: "cus-mf3k9a2-1a2b3c4d" }));

  assert.equal((stub.payloads.p_payload as { store_customer_id: unknown }).store_customer_id, null);
});

test("a real store_customers.id does travel", async () => {
  const stub = makeStub();
  const id = "9c8b7a65-4321-4f0e-8a1b-2c3d4e5f6071";
  await repo(stub).placeOrder(guestOrder({ store_customer_id: id }));

  assert.equal((stub.payloads.p_payload as { store_customer_id: string }).store_customer_id, id);
});

test("toStoreCustomerId accepts only a uuid, trimmed", () => {
  const uuid = "9c8b7a65-4321-4f0e-8a1b-2c3d4e5f6071";
  assert.equal(toStoreCustomerId(uuid), uuid);
  assert.equal(toStoreCustomerId(`  ${uuid}  `), uuid);
  assert.equal(toStoreCustomerId(uuid.toUpperCase()), uuid.toUpperCase());
  assert.equal(toStoreCustomerId("cus-mf3k9a2-1a2b3c4d"), null);
  assert.equal(toStoreCustomerId(""), null);
  assert.equal(toStoreCustomerId(null), null);
  assert.equal(toStoreCustomerId(undefined), null);
});

// ── 2. how the placed order is read back ─────────────────────────────────────

test("the confirmation comes from lookup_online_order, not from the order tables", async () => {
  const stub = makeStub();
  const result = await repo(stub).placeOrder(guestOrder());

  assert.deepEqual(
    stub.calls,
    ["rpc.place_online_order", "rpc.lookup_online_order"],
    "the guest read-back must be the phone-gated function the storefront is allowed",
  );
  assert.equal(stub.payloads.p_order_number, "WEB-000007");
  assert.equal(stub.payloads.p_phone, "0501234567");

  assert.equal(result.order.order_number, "WEB-000007");
  assert.equal(result.order.customer_name, "أحمد الشريف");
  assert.equal(result.order.total, 380, "numeric columns map to numbers");
  assert.equal(result.order.items.length, 1);
  assert.equal(result.order.items[0].sku, "SCN-A");
  assert.equal(result.order.items[0].unit_price, 350);
  assert.equal(result.order.events.length, 1);
  assert.equal(result.duplicate, false);
  assert.ok(result.order.id, "the confirmation has the row it was written as");
});

test("a duplicate submit still reads the original order back", async () => {
  const stub = makeStub({
    place: { data: { order_id: ORDER_ID, order_number: "WEB-000007", duplicate: true }, error: null },
  });
  const result = await repo(stub).placeOrder(guestOrder());

  assert.equal(result.duplicate, true);
  assert.equal(result.order.order_number, "WEB-000007");
});

test("a staff session can still read the tables when the lookup refuses", async () => {
  const stub = makeStub({
    lookup: { data: null, error: postgrestError({ code: "P0002", message: "Order not found" }) },
    tables: { online_orders: [ORDER_ROW], online_order_items: [ITEM_ROW], order_events: [EVENT_ROW] },
  });
  const result = await repo(stub).placeOrder(guestOrder());

  assert.ok(stub.calls.includes("from.online_orders.maybeSingle"), "the fallback read ran");
  assert.equal(result.order.order_number, "WEB-000007");
  assert.equal(result.order.items[0].sku, "SCN-A");
  assert.equal(result.order.events[0].kind, "placed");
});

test("when the order cannot be read back, the customer is told it exists", async () => {
  const stub = makeStub({
    lookup: { data: null, error: postgrestError({ code: "42501", message: "permission denied for table online_orders" }) },
    errorOn: ["online_orders", "online_order_items", "order_events"],
  });

  await assert.rejects(
    () => repo(stub).placeOrder(guestOrder()),
    (error: unknown) => {
      assert.ok(error instanceof OnlineError, "one normalized shape");
      assert.equal(error.code, "order_unreadable");
      assert.equal(error.detail.order_number, "WEB-000007", "the number travels, so it can be tracked");
      assert.notEqual(error.message, "[object Object]");
      return true;
    },
  );
});

test("a response without an order id is refused, not half-accepted", async () => {
  const stub = makeStub({ place: { data: { duplicate: false }, error: null } });

  await assert.rejects(
    () => repo(stub).placeOrder(guestOrder()),
    (error: unknown) => {
      assert.ok(error instanceof OnlineError);
      assert.equal(error.code, "db");
      assert.match(error.message, /order id missing/i);
      return true;
    },
  );
});

// ── 3. what the customer and the operator are told ───────────────────────────

test("a business refusal keeps its meaning instead of collapsing to the db code", async () => {
  const cases: Array<{ error: ReturnType<typeof postgrestError>; code: string; sku?: string }> = [
    {
      error: postgrestError({ code: "23514", message: "Only 2 of SCN-A available" }),
      code: "insufficient_stock",
      sku: "SCN-A",
    },
    {
      error: postgrestError({ code: "23514", message: "Product SCN-B is not available on the website" }),
      code: "product_unavailable",
      sku: "SCN-B",
    },
    {
      error: postgrestError({ code: "23514", message: "Product SCN-C cannot be ordered online" }),
      code: "product_not_online",
      sku: "SCN-C",
    },
    {
      error: postgrestError({ code: "23514", message: "Coupon RAMADAN has expired" }),
      code: "coupon_expired",
    },
    {
      error: postgrestError({ code: "23514", message: "Invalid quantity" }),
      code: "invalid_quantity",
    },
    {
      error: postgrestError({ code: "23514", message: "Delivery is not available" }),
      code: "delivery_unavailable",
    },
    {
      error: postgrestError({ code: "23514", message: "A delivery address is required" }),
      code: "missing_address",
    },
    {
      // 0042: the shop listed the places it serves and this address is not one
      // of them. Before the mapping it fell through to `db` — the customer read
      // "something went wrong" for a rule the shop had configured on purpose.
      error: postgrestError({ code: "23514", message: "Delivery to القاهرة is not available" }),
      code: "delivery_area_unsupported",
    },
    {
      error: postgrestError({ code: "23514", message: "Delivery orders need at least 1000.00" }),
      code: "delivery_minimum_not_met",
    },
    {
      error: postgrestError({ code: "23514", message: "Empty cart" }),
      code: "empty_cart",
    },
    {
      error: postgrestError({ code: "23503", message: "Product 2f1e not found" }),
      code: "product_not_found",
    },
    {
      error: postgrestError({ code: "P0002", message: "Order not found" }),
      code: "order_not_found",
    },
  ];

  const minimum = makeStub({
    place: {
      data: null,
      error: postgrestError({ code: "23514", message: "Delivery orders need at least 1000.00" }),
    },
  });
  await assert.rejects(
    () => repo(minimum).placeOrder(guestOrder()),
    (caught: unknown) => {
      assert.ok(caught instanceof OnlineError);
      assert.equal(caught.code, "delivery_minimum_not_met");
      assert.equal(caught.detail.minimum, 1000, "the refusal carries the shop's number");
      return true;
    },
  );

  for (const { error, code, sku } of cases) {
    const stub = makeStub({ place: { data: null, error } });
    await assert.rejects(
      () => repo(stub).placeOrder(guestOrder()),
      (caught: unknown) => {
        assert.ok(caught instanceof OnlineError, `${code}: a single shape`);
        assert.equal(caught.code, code, `"${error.message}" maps to ${code}`);
        assert.equal(caught.message, error.message, "the server's own wording survives");
        assert.notEqual(caught.message, "[object Object]");
        if (sku) assert.equal(caught.detail.sku, sku, "the customer is told which item");
        return true;
      },
    );
  }
});

test("a permission refusal is reported as itself, with the server's hint", () => {
  const described = describeThrown(
    postgrestError({
      code: "42501",
      message: "permission denied for table online_orders",
      hint: "GRANT SELECT ON public.online_orders TO anon;",
    }),
  );

  assert.equal(described.message, "permission denied for table online_orders");
  assert.equal(described.code, "42501");
  assert.equal(described.hint, "GRANT SELECT ON public.online_orders TO anon;");

  const normalized = toOnlineError(
    postgrestError({ code: "42501", message: "permission denied for table online_orders" }),
  );
  assert.equal(normalized.code, "db", "the storefront shows its friendly generic text");
  assert.equal(normalized.message, "permission denied for table online_orders", "the operator sees why");
  assert.equal(normalized.detail.server_code, "42501");
});

test("the malformed-uuid refusal that blocked every signed-in checkout is legible", () => {
  const normalized = toOnlineError(
    postgrestError({
      code: "22P02",
      message: 'invalid input syntax for type uuid: "cus-mf3k9a2-1a2b3c4d"',
    }),
  );

  assert.equal(normalized.code, "db");
  assert.match(normalized.message, /invalid input syntax for type uuid/);
  assert.notEqual(normalized.message, "[object Object]");
});

test("describeThrown never turns a non-error into [object Object]", () => {
  const values: unknown[] = [
    {},
    [],
    { message: null },
    { error: { message: "inner" } },
    new Date("2026-09-17T00:00:00.000Z"),
    () => undefined,
    Object.create(null),
    0,
    false,
    null,
    undefined,
    "[object Object]",
  ];

  for (const value of values) {
    const { message } = describeThrown(value);
    assert.equal(typeof message, "string");
    assert.ok(message.trim().length > 0, `${String(typeof value)} has a readable message`);
    assert.notEqual(message, "[object Object]", "a stringified object is never the message");
  }
});

test("a PostgrestError that IS an Error instance is read the same way", () => {
  // Newer postgrest-js builds extend Error; the fields must be picked up either way.
  const error = Object.assign(new Error("duplicate key value violates unique constraint"), {
    code: "23505",
    details: "Key (client_ref)=(ref-8f20c1) already exists.",
    hint: null,
  });

  const described = describeThrown(error);
  assert.equal(described.code, "23505");
  assert.equal(described.details, "Key (client_ref)=(ref-8f20c1) already exists.");
  assert.equal(toOnlineError(error).message, "duplicate key value violates unique constraint");
});

test("toOnlineError passes an OnlineError straight through", () => {
  const original = new OnlineError("coupon_invalid", "Coupon NOPE is not valid", {
    field: "coupon_code",
  });
  assert.equal(toOnlineError(original), original);
  assert.equal(toOnlineError(toOnlineError(original)), original);
});

// ── 4. anti-regression guards ────────────────────────────────────────────────

const readSource = (relative: string) =>
  fs.readFileSync(path.join(process.cwd(), relative), "utf8");

test("placeOrder cannot go back to reading the order tables itself", () => {
  const source = readSource("src/modules/online/data/supabaseRepository.ts");
  const body = source.slice(source.indexOf("async placeOrder"), source.indexOf("private async readPlacedOrder"));
  assert.ok(body.length > 0, "placeOrder was found");
  assert.ok(
    !/\.from\("online_orders"\)/.test(body),
    "the read-back must go through lookup_online_order / getOrder, never a direct table select",
  );
  assert.ok(
    /this\.lookupOrder\(/.test(body) || /readPlacedOrder/.test(body),
    "the guest read-back still exists",
  );
});

test("the checkout provider never logs a stringified throwable", () => {
  const source = readSource("src/modules/online/hooks/StoreCartProvider.tsx");
  assert.ok(
    !/String\(caught\)/.test(source),
    "`String(caught)` is what printed [object Object] for a Supabase error object",
  );
  assert.ok(/describeThrown\(caught\)/.test(source), "the log reads the error field by field");
  assert.ok(/hint:/.test(source), "the operator gets PostgREST's hint");
});

test("the normalization never stringifies an unknown object", () => {
  const source = readSource("src/modules/online/data/repository.ts");
  const start = source.indexOf("export function describeThrown");
  const end = source.indexOf("/** Anything thrown, normalized");
  const body = source.slice(start, end);
  assert.ok(!/String\(error\)/.test(body.replace(/return \{ message: String\(error\),[\s\S]*?\};/, "")),
    "describeThrown reads fields instead of stringifying the value");
});

// ── runner ───────────────────────────────────────────────────────────────────
let passed = 0;
for (const { name, fn } of tests) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    console.error(`  ✗ ${name}`);
    console.error(error);
    process.exit(1);
  }
}
console.log(`\n${passed}/${tests.length} passed`);
