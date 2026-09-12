/**
 * Realtime self-test (Phase 16).
 *
 * Run with the shared runner: `npm test` (or `node scripts/test.logic.mjs realtime`).
 *
 * Realtime is the one feature here that cannot be tested against the thing it
 * talks to — there is no server in a logic suite — so the bus is built against a
 * structural interface and driven with a fake channel that records what it was
 * asked to do. That is enough to pin the claims the feature rests on:
 *
 *   1. **demo mode does nothing at all.** No client means no channel, no
 *      listeners, and a status the UI can render honestly;
 *   2. **one channel, not one per screen.** Every registration shares a socket,
 *      and a new table rebuilds the channel instead of opening another;
 *   3. **an event reaches the listeners that asked for that table** and nobody
 *      else, and a channel that was replaced cannot report on the one that
 *      replaced it;
 *   4. **a burst becomes at most two reads, never two at once.** This is the
 *      no-race-condition requirement: overlapping refreshes are how a screen ends
 *      up showing an older read than the one above it;
 *   5. **the poll is the safety net, and the rule is arithmetic** — `live` stretches
 *      the interval, `error` or demo mode returns it to the shop's preference;
 *   6. **the two lists that must agree, do**: the tables the client watches and
 *      the tables the migration publishes. A table missing from the publication
 *      connects happily and never fires, so that failure is checked here instead
 *      of being discovered in production;
 *   7. **publishing is not exposing** — every watched table has a SELECT policy
 *      for `authenticated`, which is what makes per-row delivery safe.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import {
  arrivalsOf,
  DEFAULT_NOTIFICATION_PREFS,
  POLL_CHOICES,
  SAFETY_NET_POLL_MS,
  pollIntervalFor,
} from "@/modules/online/hooks/useOnlineNotifications";

import {
  createCoalescer,
  createRealtimeBus,
  REALTIME_TABLES,
  type RealtimeChannelLike,
  type RealtimeClientLike,
  type RealtimeStatus,
  type RealtimeTable,
} from "../realtime";

type TestCase = { name: string; fn: () => void | Promise<void> };
const tests: TestCase[] = [];
const test = (name: string, fn: () => void | Promise<void>) => tests.push({ name, fn });

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Repo root, found by walking up so the runner's location does not matter. */
function repoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 6; i += 1) {
    if (fs.existsSync(path.join(dir, "src/lib/supabase/realtime.ts"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("could not find the repository root");
}

function migrations(): string {
  const dir = path.join(repoRoot(), "supabase/migrations");
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".sql"))
    .map((name) => fs.readFileSync(path.join(dir, name), "utf8"))
    .join("\n");
}

function sources(file: string): string {
  return fs.readFileSync(path.join(repoRoot(), file), "utf8");
}

// ── the fake channel ──────────────────────────────────────────────────────
interface FakeBinding {
  table: string;
  event: string;
  schema: string;
  callback: (payload: { eventType?: string }) => void;
}

class FakeChannel implements RealtimeChannelLike {
  readonly bindings: FakeBinding[] = [];
  removed = false;
  private onSubscribe: ((status: string, error?: Error) => void) | null = null;

  constructor(readonly topic: string) {}

  on(
    _type: "postgres_changes",
    filter: { event: string; schema: string; table: string },
    callback: (payload: { eventType?: string }) => void,
  ): RealtimeChannelLike {
    this.bindings.push({ table: filter.table, event: filter.event, schema: filter.schema, callback });
    return this;
  }

  subscribe(callback?: (status: string, error?: Error) => void): unknown {
    this.onSubscribe = callback ?? null;
    return this;
  }

  unsubscribe(): unknown {
    return this;
  }

  /** Deliver a change for one table, the way the server would. */
  emit(table: string, eventType: string): void {
    for (const binding of this.bindings) {
      if (binding.table === table) binding.callback({ eventType });
    }
  }

  /** Report a channel state, the way supabase-js does. */
  report(status: string): void {
    this.onSubscribe?.(status);
  }
}

function fakeClient(): {
  client: RealtimeClientLike;
  channels: FakeChannel[];
  removed: FakeChannel[];
} {
  const channels: FakeChannel[] = [];
  const removed: FakeChannel[] = [];
  return {
    channels,
    removed,
    client: {
      channel: (topic: string) => {
        const channel = new FakeChannel(topic);
        channels.push(channel);
        return channel;
      },
      removeChannel: (channel: RealtimeChannelLike) => {
        const fake = channel as FakeChannel;
        fake.removed = true;
        removed.push(fake);
        return Promise.resolve("ok");
      },
    },
  };
}

function statusesOf(bus: { onStatus: (listener: (status: RealtimeStatus) => void) => () => void }): RealtimeStatus[] {
  const seen: RealtimeStatus[] = [];
  bus.onStatus((status) => seen.push(status));
  return seen;
}

// ── 1. demo mode ──────────────────────────────────────────────────────────
test("with no Supabase client the bus does nothing at all", () => {
  const bus = createRealtimeBus({ client: () => null });
  assert.equal(bus.status(), "unavailable", "demo mode is reported, not guessed at");

  const seen: string[] = [];
  const unsubscribe = bus.subscribe(["online_orders", "products"], () => seen.push("called"));
  assert.equal(bus.status(), "unavailable", "subscribing does not invent a channel");
  assert.equal(seen.length, 0);

  unsubscribe();
  bus.stop();
  assert.equal(bus.status(), "unavailable", "and stopping leaves it unavailable");
});

// ── 2. one channel for the whole app ──────────────────────────────────────
test("every registration shares one channel, and a new table rebuilds it", () => {
  const { client, channels, removed } = fakeClient();
  const bus = createRealtimeBus({ client: () => client, topic: "test" });
  const seen = statusesOf(bus);

  const orders: string[] = [];
  const approvals: string[] = [];
  bus.subscribe(["online_orders"], (change) => orders.push(change.event));
  assert.equal(channels.length, 1, "one channel for the first registration");
  assert.deepEqual(
    channels[0].bindings.map((binding) => binding.table),
    ["online_orders"],
  );
  assert.equal(channels[0].bindings[0].event, "*", "inserts, updates and deletes all matter");
  assert.equal(channels[0].bindings[0].schema, "public");
  assert.equal(bus.status(), "connecting", "connecting is not the same as live");
  assert.ok(channels[0].topic.startsWith("test-"), "the topic carries the app's prefix");

  channels[0].report("SUBSCRIBED");
  assert.equal(bus.status(), "live");
  assert.deepEqual(seen, ["connecting", "live"], "status changes are published, repeats are not");

  // A second screen wants a second table: the same socket carries both.
  bus.subscribe(["approval_requests"], (change) => approvals.push(change.table));
  assert.equal(channels.length, 2, "filters are bound at build time, so the channel is rebuilt");
  assert.equal(removed.length, 1, "and the old one is removed rather than left open");
  assert.equal(removed[0], channels[0]);
  assert.deepEqual(
    channels[1].bindings.map((binding) => binding.table),
    ["online_orders", "approval_requests"],
    "the rebuild carries every registered table",
  );
  assert.notEqual(channels[1].topic, channels[0].topic, "a stale channel cannot answer for the new one");

  // A registration for tables already covered costs nothing.
  const before = channels.length;
  const duplicate = bus.subscribe(["online_orders"], () => {});
  assert.equal(channels.length, before, "no new channel for a table that is already watched");
  duplicate();
  assert.equal(channels.length, before, "…and removing it does not drop the others");
});

test("an event reaches the listeners that asked for that table, and nobody else", () => {
  const { client, channels } = fakeClient();
  const bus = createRealtimeBus({ client: () => client });

  const orders: string[] = [];
  const approvals: string[] = [];
  const both: string[] = [];
  bus.subscribe(["online_orders"], (change) => orders.push(`${change.table}:${change.event}`));
  bus.subscribe(["approval_requests"], (change) => approvals.push(`${change.table}:${change.event}`));
  bus.subscribe(["online_orders", "stock_reservations"], (change) => both.push(change.table));

  const channel = channels.at(-1);
  assert.ok(channel);
  channel.report("SUBSCRIBED");

  channel.emit("online_orders", "INSERT");
  assert.deepEqual(orders, ["online_orders:INSERT"]);
  assert.deepEqual(approvals, [], "a listener for another table hears nothing");
  assert.deepEqual(both, ["online_orders"]);

  channel.emit("stock_reservations", "UPDATE");
  assert.deepEqual(orders, ["online_orders:INSERT"], "unchanged");
  assert.deepEqual(both, ["online_orders", "stock_reservations"]);

  channel.emit("approval_requests", "DELETE");
  assert.deepEqual(approvals, ["approval_requests:DELETE"]);

  // An event type this app does not model still arrives as something readable,
  // because the listener re-reads rather than trusting the payload.
  channel.emit("online_orders", "TRUNCATE");
  assert.equal(orders.at(-1), "online_orders:UPDATE");
});

test("unsubscribing the last listener closes the channel, and a dead one cannot report", () => {
  const { client, channels, removed } = fakeClient();
  const bus = createRealtimeBus({ client: () => client });

  const first = bus.subscribe(["online_orders"], () => {});
  const second = bus.subscribe(["products"], () => {});
  const live = channels.at(-1);
  assert.ok(live);
  live.report("SUBSCRIBED");
  assert.equal(bus.status(), "live");

  // Dropping one table changes what the channel must bind, so it is rebuilt: the
  // app is briefly "connecting" again rather than claiming a liveness the new
  // socket has not earned yet.
  first();
  assert.equal(bus.status(), "connecting", "the channel was rebuilt around the tables still watched");
  assert.equal(channels.at(-1) !== live, true, "…and it is a different channel");
  const rebuilt = channels.at(-1);
  assert.ok(rebuilt);
  assert.deepEqual(
    rebuilt.bindings.map((binding) => binding.table),
    ["products"],
    "the surviving registration is still bound",
  );
  rebuilt.report("SUBSCRIBED");
  assert.equal(bus.status(), "live");

  second();
  assert.equal(bus.status(), "idle", "nothing registered, nothing open");
  assert.equal(removed.length, channels.length, "every channel that was opened was handed back");

  // A channel that was replaced must not be able to move the status: its socket
  // is gone, and reporting "error" from it would put the UI in a state the app is
  // not in.
  const stale = channels[0];
  stale.report("CHANNEL_ERROR");
  assert.equal(bus.status(), "idle");
});

test("a refused channel is reported as an error, which is the poller's cue", () => {
  const { client, channels } = fakeClient();
  const bus = createRealtimeBus({ client: () => client });
  const seen = statusesOf(bus);

  bus.subscribe(["refund_records"], () => {});
  const channel = channels.at(-1);
  assert.ok(channel);
  assert.equal(bus.status(), "connecting");

  channel.report("CHANNEL_ERROR");
  assert.equal(bus.status(), "error", "the UI says so instead of implying liveness");

  channel.report("SUBSCRIBED");
  assert.equal(bus.status(), "live", "and recovers when the socket comes back");

  channel.report("CLOSED");
  assert.equal(bus.status(), "error");
  assert.deepEqual(seen, ["connecting", "error", "live", "error"], "every transition, no repeats");

  bus.stop();
  assert.equal(bus.status(), "idle", "stop() clears the registrations too");
  bus.subscribe(["refund_records"], () => {});
  assert.equal(bus.status(), "connecting", "and the bus is usable again afterwards");
});

// ── 4. bursts ─────────────────────────────────────────────────────────────
test("a burst of changes becomes at most two reads", async () => {
  let runs = 0;
  const coalescer = createCoalescer(() => {
    runs += 1;
  }, 40);

  // Writing one website order touches four tables; the first trigger runs at once
  // and the rest of the burst collects into one trailing run.
  coalescer.trigger();
  coalescer.trigger();
  coalescer.trigger();
  coalescer.trigger();
  assert.equal(runs, 1, "the first trigger is immediate, so one event feels instant");

  await sleep(90);
  assert.equal(runs, 2, "the burst produced exactly one trailing read");

  await sleep(90);
  assert.equal(runs, 2, "and nothing keeps firing afterwards");
});

test("refreshes never overlap, and one more runs after an in-flight read", async () => {
  let running = 0;
  let overlapped = false;
  let runs = 0;
  const coalescer = createCoalescer(async () => {
    running += 1;
    runs += 1;
    if (running > 1) overlapped = true;
    await sleep(30);
    running -= 1;
  }, 10);

  coalescer.trigger();
  await sleep(5);
  // Everything below arrives while the first read is still in flight.
  coalescer.trigger();
  coalescer.trigger();
  coalescer.trigger();
  await sleep(80);

  assert.equal(overlapped, false, "two refreshes were never in flight at once");
  assert.equal(runs, 2, "one run, then one more for everything that arrived during it");

  coalescer.trigger();
  await sleep(60);
  assert.equal(runs, 3, "and the coalescer keeps working afterwards");
});

test("cancel() drops a pending read, and a failing read does not kill the subscription", async () => {
  let runs = 0;
  const coalescer = createCoalescer(() => {
    runs += 1;
    throw new Error("the repository is down");
  }, 30);

  coalescer.trigger();
  assert.equal(runs, 1, "a thrown read is the listener's problem, not the bus's");
  coalescer.trigger();
  coalescer.cancel();
  await sleep(70);
  assert.equal(runs, 1, "a cancelled trailing run does not happen — nothing fires after unmount");

  const healthy = createCoalescer(() => {
    runs += 1;
  }, 20);
  healthy.trigger();
  await sleep(50);
  assert.equal(runs, 2, "a new coalescer runs normally");
});

// ── 5. the safety net ─────────────────────────────────────────────────────
test("the poll is the safety net: live stretches it, anything else restores it", () => {
  for (const pollMs of POLL_CHOICES) {
    const prefs = { ...DEFAULT_NOTIFICATION_PREFS, pollMs };
    assert.equal(pollIntervalFor(prefs, false), pollMs, "with no channel the shop's choice is the rate");
    assert.equal(
      pollIntervalFor(prefs, true),
      Math.max(pollMs, SAFETY_NET_POLL_MS),
      "with a channel up the interval becomes the safety net",
    );
    assert.ok(pollIntervalFor(prefs, true) >= pollMs, "and the preference is a floor, never a ceiling");
  }
  assert.ok(SAFETY_NET_POLL_MS > Math.max(...POLL_CHOICES), "the safety net is slower than any polling choice");
});

test("only a rise is news, so an event and the poll cannot announce one order twice", () => {
  assert.equal(arrivalsOf(null, 11), null, "a first reading is a baseline, not eleven new orders");
  assert.equal(arrivalsOf(3, 5), 2, "a rise announces what arrived");
  assert.equal(arrivalsOf(5, 5), null, "no change, no chime");
  assert.equal(arrivalsOf(5, 2), null, "somebody worked the queue — that is not news");
  assert.equal(arrivalsOf(0, 1), 1, "the first order of the day is announced");

  // The path both transports take: whichever reads first moves the baseline, so
  // the second sees no rise. This is what keeps realtime from double-chiming.
  let baseline: number | null = null;
  const announced: number[] = [];
  for (const pending of [4, 4, 5, 5, 5, 3]) {
    const arrived = arrivalsOf(baseline, pending);
    baseline = pending;
    if (arrived !== null) announced.push(arrived);
  }
  assert.deepEqual(announced, [1], "one order arrived, one announcement");
});

// ── 6. the two lists that must agree ──────────────────────────────────────
test("every watched table is published to supabase_realtime, and nothing else is claimed", () => {
  const migration = fs.readFileSync(
    path.join(repoRoot(), "supabase/migrations/0026_realtime_publication.sql"),
    "utf8",
  );
  const wanted = migration.match(/wanted text\[\] := array\[([\s\S]*?)\];/);
  assert.ok(wanted, "the migration lists the tables it publishes");
  const published = [...wanted[1].matchAll(/'([a-z_]+)'/g)].map((match) => match[1]);

  assert.ok(published.length > 0, "the list was parsed");
  for (const table of REALTIME_TABLES) {
    assert.ok(published.includes(table), `${table} is watched by the client and published by the migration`);
  }
  for (const table of published) {
    assert.ok(
      (REALTIME_TABLES as readonly string[]).includes(table),
      `${table} is published and watched — a table in only one list is a silent failure`,
    );
  }
});

test("every watched table has a SELECT policy for authenticated callers", () => {
  const sql = migrations();
  for (const table of REALTIME_TABLES) {
    // Publishing a table does not expose it: Realtime evaluates the SELECT policy
    // per row before delivering it. A table with no read policy for signed-in
    // callers would deliver nothing at all, which looks identical to a bug.
    const policy = new RegExp(
      `create policy[\\s\\S]{0,240}?public\\.${table}\\b[\\s\\S]{0,240}?for (select|all)[\\s\\S]{0,120}?to authenticated`,
      "i",
    );
    const reversed = new RegExp(
      `create policy[\\s\\S]{0,240}?for (select|all)[\\s\\S]{0,120}?to authenticated[\\s\\S]{0,240}?public\\.${table}\\b`,
      "i",
    );
    assert.ok(policy.test(sql) || reversed.test(sql), `${table}: a signed-in caller may read the rows it will hear about`);
  }
});

// ── 7. the wiring ─────────────────────────────────────────────────────────
test("the providers that must go live actually watch their tables", () => {
  const wiring: { file: string; tables: RealtimeTable[] }[] = [
    { file: "src/modules/online/hooks/useOnlineNotifications.ts", tables: ["online_orders"] },
    {
      file: "src/modules/online/hooks/OnlineOrdersProvider.tsx",
      tables: ["online_orders", "order_events", "stock_reservations"],
    },
    { file: "src/modules/approvals/hooks/ApprovalProvider.tsx", tables: ["approval_requests"] },
    { file: "src/modules/returns/hooks/ReturnProvider.tsx", tables: ["sales_returns", "refund_records"] },
    { file: "src/modules/inventory/hooks/InventoryProvider.tsx", tables: ["products", "stock_movements"] },
  ];

  for (const { file, tables } of wiring) {
    const source = sources(file);
    assert.ok(source.includes("useRealtimeWatch"), `${file} watches the channel`);
    assert.ok(
      source.includes('from "@/lib/supabase/useRealtimeWatch"'),
      `${file} uses the shared hook rather than its own socket`,
    );
    for (const table of tables) {
      assert.ok(source.includes(`"${table}"`), `${file} watches ${table}`);
    }
    // A background refresh must not flash a spinner over a screen somebody is
    // reading, so each of these took the silent option.
    assert.ok(
      source.includes("silent"),
      `${file} refreshes silently in the background`,
    );
  }

  // The notifications hook is the one place the chime lives, and it must keep the
  // interval as the safety net rather than trading it for the socket.
  const notifications = sources("src/modules/online/hooks/useOnlineNotifications.ts");
  assert.ok(notifications.includes("pollIntervalFor(prefs, live)"), "the interval survives realtime");
  assert.ok(notifications.includes("SAFETY_NET_POLL_MS"), "and it is stretched, not removed");

  // Sign-out closes the socket.
  const auth = sources("src/lib/auth/hooks/AuthProvider.tsx");
  assert.ok(auth.includes("stopRealtime()"), "signing out stops the channel");
});

// ── runner ────────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
for (const { name, fn } of tests) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`  ✗ ${name}`);
    console.error(`    ${err instanceof Error ? err.message : String(err)}`);
  }
}
console.log(`\n${passed}/${tests.length} realtime tests passed.`);
if (failed > 0) process.exit(1);
