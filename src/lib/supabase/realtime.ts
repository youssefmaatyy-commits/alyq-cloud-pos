/**
 * One realtime bus for the whole signed-in app (Phase 16).
 *
 * Before this, "live" meant a 20-second poll for website orders and a mount-time
 * read for everything else: approve an order in one tab and the other tab's badge
 * was wrong until somebody navigated. Realtime fixes that, but only if it is one
 * thing. So this module owns *the* WebSocket channel — every provider that wants
 * to know about a table registers here, and there is exactly one subscription per
 * set of tables for the whole app, not one per screen.
 *
 * Three rules shaped it:
 *
 *   1. **It is an optimisation, never a source of truth.** An event says
 *      "something changed"; the listener then re-reads through the same
 *      repository it always used. Nothing here parses rows into domain objects,
 *      so a missed event costs freshness and never correctness — and the pollers
 *      stay as the safety net.
 *   2. **Demo mode must not change behaviour.** With no Supabase credentials the
 *      bus reports `unavailable` and does nothing at all: the existing poll and
 *      the existing mount-time loads carry the app exactly as before.
 *   3. **Row-level security still decides what you hear about.** The channel uses
 *      the session's own token, so a cashier receives changes to rows a cashier
 *      may read and nothing else. This is why subscribing is safe to do for
 *      everybody who can open the screen: the database is still the gatekeeper.
 *
 * Bursts are the practical problem. Writing one website order touches
 * `online_orders`, `online_order_items`, `order_events` and `stock_reservations`,
 * and a sale touches `products` and `stock_movements` — four events that must not
 * become four refreshes, and certainly not four overlapping ones. `createCoalescer`
 * is the answer: run once, swallow the burst, and if more arrived while the run
 * was in flight, run exactly once more afterwards.
 */
import { getSupabaseClient } from "./client";

/**
 * Tables this bus can watch.
 *
 * The list is deliberately the same list the migration publishes to
 * `supabase_realtime` (see `0026_realtime_publication.sql`): a table that is not
 * in the publication produces a subscription that connects happily and then never
 * fires, which is the quietest possible failure. Adding one means editing both.
 */
export const REALTIME_TABLES = [
  "online_orders",
  "order_events",
  "stock_reservations",
  "approval_requests",
  "refund_records",
  "sales_returns",
  "products",
  "stock_movements",
] as const;

export type RealtimeTable = (typeof REALTIME_TABLES)[number];

export type RealtimeEvent = "INSERT" | "UPDATE" | "DELETE";

export interface RealtimeChange {
  table: RealtimeTable;
  event: RealtimeEvent;
  /** When the bus saw it, for logs and for "last updated" labels. */
  at: string;
}

/**
 * Where the channel is.
 *
 * `unavailable` is demo mode (nothing to connect to). `error` means the channel
 * was refused or dropped — the app keeps working on its pollers, and the UI says
 * so rather than implying a liveness it does not have.
 */
export type RealtimeStatus = "unavailable" | "idle" | "connecting" | "live" | "error";

type Listener = (change: RealtimeChange) => void;
type StatusListener = (status: RealtimeStatus) => void;

/* ── the smallest shape of supabase-js this needs ────────────────────────────
 * Structural on purpose: the real client satisfies it, and so does the fake the
 * self-test drives it with. Depending on the library's own generics here would
 * make the bus untestable without a server.
 */
export interface RealtimeChannelLike {
  on(
    type: "postgres_changes",
    filter: { event: string; schema: string; table: string },
    callback: (payload: { eventType?: string }) => void,
  ): RealtimeChannelLike;
  subscribe(callback?: (status: string, error?: Error) => void): unknown;
  unsubscribe(): unknown;
}

export interface RealtimeClientLike {
  channel(topic: string): RealtimeChannelLike;
  removeChannel(channel: RealtimeChannelLike): Promise<unknown> | unknown;
}

export interface RealtimeBus {
  /** Where the channel is right now. */
  status(): RealtimeStatus;
  /** Watch a status change; returns an unsubscribe. */
  onStatus(listener: StatusListener): () => void;
  /**
   * Register interest in a set of tables. Returns an unsubscribe; the channel is
   * torn down when the last registration goes, which is what happens on sign-out
   * when every provider unmounts.
   */
  subscribe(tables: readonly RealtimeTable[], listener: Listener): () => void;
  /** Forget every registration and close the channel. */
  stop(): void;
}

/* ── coalescing ─────────────────────────────────────────────────────────── */

export interface Coalescer {
  /** Ask for a run. Safe to call in a burst, and safe to call while running. */
  trigger(): void;
  /** Drop any pending run (used on unmount, so nothing fires after teardown). */
  cancel(): void;
}

/**
 * Collapse a burst of changes into runs that never overlap.
 *
 * The contract, which is the whole point of it:
 *
 *   · the first trigger runs immediately, so a single event feels instant;
 *   · triggers arriving inside `windowMs` of that run are collected into one
 *     trailing run at the end of the window — four events about one order become
 *     two reads, not four;
 *   · triggers arriving *while* a run is in flight never start a second one. One
 *     more run happens after it settles, however many arrived. Overlapping
 *     refreshes are how a screen ends up showing an older read than the one
 *     above it, so this is not a nicety.
 */
export function createCoalescer(
  run: () => void | Promise<void>,
  windowMs = 400,
  schedule: (fn: () => void, ms: number) => ReturnType<typeof setTimeout> = (fn, ms) => setTimeout(fn, ms),
  unschedule: (handle: ReturnType<typeof setTimeout>) => void = (handle) => clearTimeout(handle),
): Coalescer {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let queuedWhileRunning = false;
  let lastRunAt = 0;

  const clearTimer = () => {
    if (timer !== null) {
      unschedule(timer);
      timer = null;
    }
  };

  async function execute(): Promise<void> {
    running = true;
    lastRunAt = Date.now();
    try {
      await run();
    } catch {
      // A failed read is the listener's business (it reports its own error).
      // Swallowing here keeps one bad refresh from killing the subscription.
    } finally {
      running = false;
      // Something arrived mid-flight: one more run, and only one.
      if (queuedWhileRunning) {
        queuedWhileRunning = false;
        void execute();
      }
    }
  }

  return {
    trigger() {
      if (running) {
        queuedWhileRunning = true;
        return;
      }
      const sinceLast = Date.now() - lastRunAt;
      if (lastRunAt > 0 && sinceLast < windowMs) {
        // Inside the window: one trailing run covers the rest of the burst.
        if (timer === null) {
          timer = schedule(() => {
            timer = null;
            void execute();
          }, windowMs - sinceLast);
        }
        return;
      }
      void execute();
    },
    cancel() {
      clearTimer();
      queuedWhileRunning = false;
    },
  };
}

/* ── the bus ────────────────────────────────────────────────────────────── */

interface Registration {
  tables: ReadonlySet<RealtimeTable>;
  listener: Listener;
}

export interface RealtimeBusOptions {
  /** Where the client comes from; `null` means demo mode. */
  client: () => RealtimeClientLike | null;
  /** Topic prefix, so two apps on one project do not share a channel name. */
  topic?: string;
}

export function createRealtimeBus(options: RealtimeBusOptions): RealtimeBus {
  const registrations = new Set<Registration>();
  const statusListeners = new Set<StatusListener>();
  let channel: RealtimeChannelLike | null = null;
  let channelTables: string = "";
  let generation = 0;
  let current: RealtimeStatus = options.client() ? "idle" : "unavailable";

  function setStatus(next: RealtimeStatus): void {
    if (next === current) return;
    current = next;
    for (const listener of [...statusListeners]) listener(next);
  }

  function wantedTables(): RealtimeTable[] {
    const wanted = new Set<RealtimeTable>();
    for (const registration of registrations) {
      for (const table of registration.tables) wanted.add(table);
    }
    return REALTIME_TABLES.filter((table) => wanted.has(table));
  }

  function dispatch(change: RealtimeChange): void {
    for (const registration of [...registrations]) {
      if (registration.tables.has(change.table)) registration.listener(change);
    }
  }

  /**
   * Bring the channel in line with what is registered.
   *
   * supabase-js binds filters when the channel is built, so a new table means a
   * new channel. Rebuilding is rare (providers mount once) and cheap, and it
   * beats keeping one channel per table — which is how an app ends up with nine
   * sockets open.
   */
  function sync(): void {
    const client = options.client();
    if (!client) {
      setStatus("unavailable");
      return;
    }
    const wanted = wantedTables();
    if (wanted.length === 0) {
      teardown();
      setStatus("idle");
      return;
    }
    const key = wanted.join(",");
    if (channel && key === channelTables) return;

    teardown();
    channelTables = key;
    generation += 1;
    const topic = `${options.topic ?? "alyq-live"}-${generation}`;
    const next = client.channel(topic);
    for (const table of wanted) {
      next.on("postgres_changes", { event: "*", schema: "public", table }, (payload) => {
        const event = payload.eventType;
        dispatch({
          table,
          event: event === "INSERT" || event === "UPDATE" || event === "DELETE" ? event : "UPDATE",
          at: new Date().toISOString(),
        });
      });
    }
    channel = next;
    setStatus("connecting");
    next.subscribe((state) => {
      // A channel that was replaced must not report on the one that replaced it.
      if (channel !== next) return;
      if (state === "SUBSCRIBED") setStatus("live");
      else if (state === "CHANNEL_ERROR" || state === "CLOSED" || state === "TIMED_OUT") {
        setStatus("error");
      }
    });
  }

  function teardown(): void {
    const closing = channel;
    channel = null;
    channelTables = "";
    if (!closing) return;
    const client = options.client();
    try {
      if (client) void client.removeChannel(closing);
      else void closing.unsubscribe();
    } catch {
      // A socket that will not close is not worth failing over.
    }
  }

  return {
    status: () => current,
    onStatus(listener) {
      statusListeners.add(listener);
      return () => {
        statusListeners.delete(listener);
      };
    },
    subscribe(tables, listener) {
      const registration: Registration = { tables: new Set(tables), listener };
      registrations.add(registration);
      sync();
      return () => {
        if (!registrations.delete(registration)) return;
        sync();
      };
    },
    stop() {
      registrations.clear();
      teardown();
      setStatus(options.client() ? "idle" : "unavailable");
    },
  };
}

/** The bus the app uses. One per session, created on first import. */
export const realtimeBus: RealtimeBus = createRealtimeBus({
  client: () => getSupabaseClient() as unknown as RealtimeClientLike | null,
  topic: "alyq-pos",
});

/**
 * Close the channel on sign-out.
 *
 * Providers unmounting already does this, so it is a belt-and-braces call — but
 * a socket left open after sign-out would keep receiving rows for a session that
 * no longer exists, and the cost of one line is nothing.
 */
export function stopRealtime(): void {
  realtimeBus.stop();
}
