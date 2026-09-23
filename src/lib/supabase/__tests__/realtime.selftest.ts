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
  REFUSED_RETRY_LIMIT,
  RETRY_DELAYS_MS,
  type RealtimeChannelLike,
  type RealtimeClientLike,
  type RealtimeStatus,
  type RealtimeTable,
  type TimerHandle,
  type VisibilitySource,
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

/**
 * A clock the test turns by hand.
 *
 * Reconnect backoff is the one behaviour here that lives in tens of seconds, and
 * a suite that sleeps through it is a suite nobody runs. Injecting the scheduler
 * lets a test watch an hour of outage in microseconds and still assert the actual
 * delays the bus asked for.
 */
function manualClock() {
  interface Entry {
    fn: () => void;
    ms: number;
    id: number;
    cancelled: boolean;
  }
  const queue: Entry[] = [];
  let nextId = 1;
  return {
    schedule: (fn: () => void, ms: number): TimerHandle => {
      const entry: Entry = { fn, ms, id: nextId, cancelled: false };
      nextId += 1;
      queue.push(entry);
      return entry.id as unknown as TimerHandle;
    },
    unschedule: (handle: TimerHandle): void => {
      const entry = queue.find((candidate) => candidate.id === (handle as unknown as number));
      if (entry) entry.cancelled = true;
    },
    /** The delays currently waiting, in the order they were asked for. */
    delays(): number[] {
      return queue.filter((entry) => !entry.cancelled).map((entry) => entry.ms);
    },
    pending(): number {
      return queue.filter((entry) => !entry.cancelled).length;
    },
    /** Run the soonest pending timer, the way the clock would. */
    advance(): boolean {
      const entry = queue
        .filter((candidate) => !candidate.cancelled)
        .sort((a, b) => a.ms - b.ms)[0];
      if (!entry) return false;
      entry.cancelled = true;
      entry.fn();
      return true;
    },
  };
}

/** A tab whose visibility the test controls. */
function fakeVisibility(startHidden = false): VisibilitySource & {
  setHidden(hidden: boolean): void;
} {
  const listeners = new Set<() => void>();
  let hidden = startHidden;
  return {
    hidden: () => hidden,
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setHidden(next: boolean) {
      hidden = next;
      for (const listener of [...listeners]) listener();
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

test("a refused channel retries a bounded number of times, then says so", () => {
  const { client, channels } = fakeClient();
  const clock = manualClock();
  const bus = createRealtimeBus({
    client: () => client,
    retryDelays: [10, 20, 40],
    refusedRetries: 2,
    schedule: clock.schedule,
    unschedule: clock.unschedule,
  });
  const seen = statusesOf(bus);

  bus.subscribe(["refund_records"], () => {});
  assert.equal(bus.status(), "connecting", "the first attempt is not a retry");

  const first = channels.at(-1);
  assert.ok(first);
  first.report("CHANNEL_ERROR");
  assert.equal(bus.status(), "reconnecting", "a failure is announced as a retry in progress");
  assert.equal(bus.retries(), 1, "and the attempt is counted");
  assert.deepEqual(clock.delays(), [10], "the first retry waits the first backoff step");

  // The server refuses again, and again: this is a configuration answer, so the
  // budget runs out instead of asking forever.
  assert.ok(clock.advance());
  channels.at(-1)?.report("CHANNEL_ERROR");
  assert.equal(bus.retries(), 2);
  assert.deepEqual(clock.delays(), [20], "the backoff doubles");

  assert.ok(clock.advance());
  channels.at(-1)?.report("CHANNEL_ERROR");
  assert.equal(bus.status(), "error", "after the budget the poller is the transport, and the UI says so");
  assert.equal(clock.pending(), 0, "no retry is queued for a refusal that will be refused again");

  // Recovery is still possible — by hand, or by anything that calls retry().
  bus.retry();
  assert.equal(bus.status(), "connecting", "retry() starts the budget again from the top");
  assert.equal(bus.retries(), 0);
  channels.at(-1)?.report("SUBSCRIBED");
  assert.equal(bus.status(), "live");
  assert.deepEqual(
    seen,
    ["connecting", "reconnecting", "error", "connecting", "live"],
    "every transition, and no repeats",
  );

  bus.stop();
  assert.equal(bus.status(), "idle", "stop() clears the registrations too");
  bus.subscribe(["refund_records"], () => {});
  assert.equal(bus.status(), "connecting", "and the bus is usable again afterwards");
});

// ── 3b. recovery ──────────────────────────────────────────────────────────
test("a dropped channel reconnects on its own, and makes every listener re-read", () => {
  const { client, channels, removed } = fakeClient();
  const clock = manualClock();
  const bus = createRealtimeBus({
    client: () => client,
    retryDelays: [10, 20, 40],
    schedule: clock.schedule,
    unschedule: clock.unschedule,
  });
  const seen = statusesOf(bus);
  const orders: string[] = [];
  const products: string[] = [];
  bus.subscribe(["online_orders"], (change) => orders.push(change.recovered ? "recovered" : change.event));
  bus.subscribe(["products"], (change) => products.push(change.recovered ? "recovered" : change.event));

  const channel = channels.at(-1);
  assert.ok(channel);
  channel.report("SUBSCRIBED");
  assert.equal(bus.status(), "live");
  assert.equal(bus.retries(), 0);
  assert.deepEqual(orders, [], "coming up for the first time is not a recovery: nothing was missed");

  // The connection goes away. Unlike a refusal, this is worth waiting for.
  channel.report("CLOSED");
  assert.equal(bus.status(), "reconnecting");
  assert.equal(bus.retries(), 1);
  assert.deepEqual(clock.delays(), [10]);

  assert.ok(clock.advance(), "the retry fires when the clock reaches it");
  // Three channels in all: the first registration, the rebuild when the second
  // listener asked for another table, and the one this retry built.
  assert.equal(channels.length, 3, "…and builds a fresh channel");
  assert.equal(removed.length, channels.length - 1, "every channel but the current one was handed back");
  assert.ok(removed.includes(channel), "including the one that dropped, rather than leaving it open");

  const revived = channels.at(-1);
  assert.ok(revived);
  revived.report("SUBSCRIBED");
  assert.equal(bus.status(), "live");
  assert.equal(bus.retries(), 0, "a live channel resets the backoff");
  // Events written while it was down are gone and cannot be replayed, so the only
  // honest recovery is to tell everybody to look again.
  assert.deepEqual(orders, ["recovered"], "each listener re-reads what it missed");
  assert.deepEqual(products, ["recovered"]);
  assert.deepEqual(seen, ["connecting", "live", "reconnecting", "live"]);
});

test("the backoff grows to its ceiling, and one drop queues exactly one retry", () => {
  const { client, channels } = fakeClient();
  const clock = manualClock();
  const bus = createRealtimeBus({
    client: () => client,
    retryDelays: [2, 4, 8],
    schedule: clock.schedule,
    unschedule: clock.unschedule,
  });
  bus.subscribe(["online_orders"], () => {});
  channels.at(-1)?.report("SUBSCRIBED");
  assert.equal(bus.status(), "live");

  // An outage that stays an outage: each attempt fails, so the wait grows. A
  // channel that recovers in between starts again at the short end, which is what
  // a shop wants — a blip at lunchtime should not inherit the night's backoff.
  const delays: number[] = [];
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const channel = channels.at(-1);
    assert.ok(channel);
    channel.report("CLOSED");
    assert.equal(bus.status(), "reconnecting", `attempt ${attempt + 1} is waiting to retry`);
    assert.equal(clock.pending(), 1, "one outage, one queued retry");
    delays.push(...clock.delays());
    assert.ok(clock.advance(), `attempt ${attempt + 1} fires when the clock reaches it`);
    assert.equal(channels.length, attempt + 2, "…and builds a fresh channel");
  }
  assert.deepEqual(delays, [2, 4, 8, 8, 8], "it doubles, then holds at the ceiling");

  // A channel that reports twice for one failure must not reconnect twice, or one
  // outage leaves two sockets competing for the same events.
  const channel = channels.at(-1);
  assert.ok(channel);
  const attemptsBefore = bus.retries();
  channel.report("CLOSED");
  channel.report("TIMED_OUT");
  assert.equal(clock.pending(), 1, "CLOSED then TIMED_OUT is one outage, not two");
  assert.equal(bus.retries(), attemptsBefore + 1, "and it is counted once");

  // Recovering resets the count, so the next drop starts at two seconds again.
  assert.ok(clock.advance());
  channels.at(-1)?.report("SUBSCRIBED");
  assert.equal(bus.status(), "live");
  assert.equal(bus.retries(), 0);
  channels.at(-1)?.report("CLOSED");
  assert.deepEqual(clock.delays(), [2], "a recovered channel does not carry its old backoff");
});

test("the shipped backoff is the one the app runs with", () => {
  assert.equal(RETRY_DELAYS_MS[0], 2_000, "a blip during a shift costs two seconds");
  assert.equal(RETRY_DELAYS_MS.at(-1), 60_000, "and the ceiling is a minute");
  for (let index = 1; index < RETRY_DELAYS_MS.length; index += 1) {
    assert.ok(
      RETRY_DELAYS_MS[index] >= RETRY_DELAYS_MS[index - 1],
      "the backoff never shortens",
    );
  }
  assert.ok(REFUSED_RETRY_LIMIT >= 1, "a refusal is retried at least once before being reported");
  // A POS left open overnight has to come back by itself, so drops retry forever.
  const source = sources("src/lib/supabase/realtime.ts");
  assert.ok(
    source.includes("if (refused && refusals > refusedLimit)"),
    "only refusals are bounded; a dropped connection is not",
  );
});

test("waking a hidden tab reconnects at once instead of waiting out the backoff", () => {
  const { client, channels } = fakeClient();
  const clock = manualClock();
  const visibility = fakeVisibility();
  const bus = createRealtimeBus({
    client: () => client,
    retryDelays: [60_000],
    schedule: clock.schedule,
    unschedule: clock.unschedule,
    recoverOnVisible: true,
    visibility,
  });
  const orders: string[] = [];
  bus.subscribe(["online_orders"], (change) => orders.push(change.recovered ? "recovered" : change.event));
  channels.at(-1)?.report("SUBSCRIBED");
  assert.equal(bus.status(), "live");

  visibility.setHidden(true);
  channels.at(-1)?.report("CLOSED");
  assert.equal(bus.status(), "reconnecting");
  assert.deepEqual(clock.delays(), [60_000], "the retry is a minute away");

  // Still hidden: a throttled tab is not being read, so it keeps waiting.
  visibility.setHidden(true);
  assert.deepEqual(clock.delays(), [60_000], "another hidden notification changes nothing");

  // Somebody looks at it: reconnect now rather than in a minute.
  visibility.setHidden(false);
  assert.equal(clock.pending(), 0, "the waiting retry was dropped");
  assert.equal(channels.length, 2, "and a fresh channel was built immediately");
  channels.at(-1)?.report("SUBSCRIBED");
  assert.equal(bus.status(), "live");
  assert.deepEqual(orders, ["recovered"], "the outage it slept through is re-read, not forgotten");

  // A healthy bus ignores the same event.
  const before = channels.length;
  visibility.setHidden(true);
  visibility.setHidden(false);
  assert.equal(channels.length, before, "a live channel is not rebuilt for looking at the tab");
});

test("stop() cancels a pending retry, so signing out really closes the socket", () => {
  const { client, channels, removed } = fakeClient();
  const clock = manualClock();
  const bus = createRealtimeBus({
    client: () => client,
    retryDelays: [10],
    schedule: clock.schedule,
    unschedule: clock.unschedule,
  });
  bus.subscribe(["online_orders"], () => {});
  channels.at(-1)?.report("CLOSED");
  assert.equal(clock.pending(), 1, "a retry is waiting");

  bus.stop();
  assert.equal(clock.pending(), 0, "and sign-out cancels it");
  assert.equal(bus.status(), "idle");
  assert.equal(clock.advance(), false, "nothing fires afterwards");
  assert.equal(channels.length, 1, "no channel is built for a bus nobody is watching");
  assert.equal(removed.length, 1, "the dead one was handed back");
});

test("one order's writes and a reconnect become one refresh per listener", async () => {
  const { client, channels } = fakeClient();
  const clock = manualClock();
  const bus = createRealtimeBus({
    client: () => client,
    retryDelays: [10],
    schedule: clock.schedule,
    unschedule: clock.unschedule,
  });

  let refreshes = 0;
  const coalescer = createCoalescer(() => {
    refreshes += 1;
  }, 25);
  // One provider watching the three tables a website order is written across.
  bus.subscribe(["online_orders", "order_events", "stock_reservations"], () => coalescer.trigger());
  const channel = channels.at(-1);
  assert.ok(channel);
  channel.report("SUBSCRIBED");

  channel.emit("online_orders", "INSERT");
  channel.emit("order_events", "INSERT");
  channel.emit("stock_reservations", "INSERT");
  channel.emit("online_orders", "UPDATE");
  assert.equal(refreshes, 1, "four events about one order read once, immediately");
  await sleep(70);
  assert.equal(refreshes, 2, "then once more for the rest of the burst");

  // The channel drops and comes back: recovery is one more nudge per listener,
  // not one per table it watches.
  channel.report("CLOSED");
  assert.ok(clock.advance());
  channels.at(-1)?.report("SUBSCRIBED");
  assert.equal(refreshes, 3, "coming back re-reads at once…");
  await sleep(70);
  assert.equal(refreshes, 4, "…and the three recovered tables collapse into one trailing read");
  coalescer.cancel();
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
  // Scanned across *every* migration rather than read out of one file: the
  // publication grew in 0027 and will grow again, and a parity test that only
  // knows about the migration it was written next to passes while the two lists
  // drift apart — which is the failure this test exists to catch.
  const dir = path.join(repoRoot(), "supabase/migrations");
  const published = new Set<string>();
  for (const name of fs.readdirSync(dir).filter((file) => file.endsWith(".sql"))) {
    const sql = fs.readFileSync(path.join(dir, name), "utf8");
    // The array a publication migration iterates…
    for (const block of sql.matchAll(/wanted text\[\] := array\[([\s\S]*?)\];/g)) {
      for (const match of block[1].matchAll(/'([a-z_]+)'/g)) published.add(match[1]);
    }
    // …and any table a migration adds to the publication directly.
    for (const match of sql.matchAll(
      /alter publication supabase_realtime add table public\.([a-z_]+)/g,
    )) {
      published.add(match[1]);
    }
  }

  assert.ok(published.size > 0, "the migrations were parsed");
  for (const table of REALTIME_TABLES) {
    assert.ok(published.has(table), `${table} is watched by the client and published by a migration`);
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
    { file: "src/modules/pos/hooks/PosProvider.tsx", tables: ["sales"] },
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
