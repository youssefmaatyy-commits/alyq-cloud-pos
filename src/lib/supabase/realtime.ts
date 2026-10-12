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
 * Recovery is part of rule 1. A dropped socket means events were *missed*, and
 * nothing here can know which: the database does not replay them. So coming back
 * up is not enough — the bus tells every listener "you were offline, re-read",
 * and the coalescer collapses that into the single refresh each provider would
 * have made anyway. Backoff keeps a broken connection from becoming a retry
 * storm, and a refusal (as opposed to a drop) is bounded, because a subscription
 * the server rejects for configuration reasons will be rejected again forever.
 *
 * Bursts are the practical problem. Writing one website order touches
 * `online_orders`, `online_order_items`, `order_events` and `stock_reservations`,
 * and a sale touches `products` and `stock_movements` — four events that must not
 * become four refreshes, and certainly not four overlapping ones. `createCoalescer`
 * is the answer: run once, swallow the burst, and if more arrived while the run
 * was in flight, run exactly once more afterwards.
 */
import { applicationConfig, getSupabaseClient } from "./client";

/**
 * Tables this bus can watch.
 *
 * The list is deliberately the same list the migrations publish to
 * `supabase_realtime` (`0026_realtime_publication.sql`, extended by
 * `0027_realtime_sales_publication.sql`): a table that is not in the publication
 * produces a subscription that connects happily and then never fires, which is
 * the quietest possible failure. Adding one means editing both — and a self-test
 * scans every migration for tables added to the publication and fails on drift.
 */
export const REALTIME_TABLES = [
  "online_orders",
  "order_events",
  "stock_reservations",
  "approval_requests",
  "refund_records",
  "sales_returns",
  "sales",
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
  /**
   * True when this is not a row changing but the channel coming back after a
   * drop. Everything written while it was down is unknown and unknowable — the
   * database does not replay it — so a listener must re-read rather than trust
   * what it has. Same contract as a normal change ("re-read this table"), which
   * is why it needs no new plumbing in any provider.
   */
  recovered?: boolean;
}

/**
 * Where the channel is.
 *
 * `unavailable` is demo mode (nothing to connect to). `connecting` is the first
 * attempt. `reconnecting` means the channel dropped and a retry is scheduled —
 * the app keeps working on its pollers meanwhile, and says so rather than
 * implying a liveness it does not have. `error` means the server *refused* the
 * subscription and the bounded retry budget for that case ran out; a refusal is a
 * configuration problem, so hammering it forever would only hide the reason.
 */
export type RealtimeStatus =
  | "unavailable"
  | "idle"
  | "connecting"
  | "live"
  | "reconnecting"
  | "error";

/**
 * The reconnect backoff, in milliseconds.
 *
 * Doubles to a one-minute ceiling and then stays there. Two seconds is short
 * enough that a blip during a busy shift costs nothing; a minute is long enough
 * that a shop whose router is down for an hour asks for the channel sixty times
 * instead of eighteen hundred. Retry forever at that ceiling: a POS left open
 * overnight has to come back by itself, and nobody is going to press a button.
 */
export const RETRY_DELAYS_MS: readonly number[] = [
  2_000, 4_000, 8_000, 16_000, 32_000, 60_000,
];

/**
 * How many times a *refused* subscription is retried before reporting `error`.
 *
 * A drop is transient and worth waiting for. A refusal is the server saying no to
 * this channel — an unpublished table, a revoked grant, a project without
 * realtime — and saying no again in two seconds will not change its mind.
 */
export const REFUSED_RETRY_LIMIT = 3;

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
  /**
   * Reconnect attempts since the channel was last live. Zero while healthy, so a
   * label can say "reconnecting" without inventing a number of its own.
   */
  retries(): number;
  /**
   * Try again immediately and reset the backoff.
   *
   * Used when the tab becomes visible: a laptop that slept through an outage has
   * a throttled timer and a stale socket, and the moment somebody looks at it is
   * exactly when it should be right.
   */
  retry(): void;
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
  /**
   * Reconnect backoff. Injectable so a test can drive an hour of outages in
   * microseconds instead of sleeping through them.
   */
  retryDelays?: readonly number[];
  /** Refusals tolerated before `error`. Injectable for the same reason. */
  refusedRetries?: number;
  schedule?: (fn: () => void, ms: number) => TimerHandle;
  unschedule?: (handle: TimerHandle) => void;
  /**
   * Listen for the tab becoming visible and retry then. Off by default so a bus
   * built in a test never touches `document`; the app's singleton turns it on.
   */
  recoverOnVisible?: boolean;
  /**
   * Where "is this tab being looked at" comes from. Injectable so a test can wake
   * the bus up without a browser; defaults to `document` when recovery is on.
   */
  visibility?: VisibilitySource | null;
}

/** The tab's own visibility, as an injectable pair of questions. */
export interface VisibilitySource {
  hidden(): boolean;
  /** Watch for visibility changes; returns an unsubscribe. */
  onChange(listener: () => void): () => void;
}

/** The document-backed source. `null` where there is no document to ask. */
export function documentVisibility(): VisibilitySource | null {
  if (typeof document === "undefined") return null;
  return {
    hidden: () => document.hidden,
    onChange: (listener) => {
      document.addEventListener("visibilitychange", listener);
      return () => document.removeEventListener("visibilitychange", listener);
    },
  };
}

/** A timer handle, whatever the scheduler returns. */
export type TimerHandle = ReturnType<typeof setTimeout>;

export function createRealtimeBus(options: RealtimeBusOptions): RealtimeBus {
  const registrations = new Set<Registration>();
  const statusListeners = new Set<StatusListener>();
  const retryDelays = options.retryDelays ?? RETRY_DELAYS_MS;
  const refusedLimit = options.refusedRetries ?? REFUSED_RETRY_LIMIT;
  const schedule = options.schedule ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const unschedule = options.unschedule ?? ((handle: TimerHandle) => clearTimeout(handle));

  let channel: RealtimeChannelLike | null = null;
  let channelTables: string = "";
  /**
   * The table set the last channel was built for, kept across teardowns.
   *
   * `channelTables` is cleared when a channel goes so the next `sync` rebuilds;
   * this one survives, because "is this the same subscription we were refused
   * for?" has to outlive the socket it was refused on.
   */
  let builtTables: string = "";
  let generation = 0;
  let current: RealtimeStatus = options.client() ? "idle" : "unavailable";
  /** Attempts since the channel was last live — the backoff index. */
  let attempts = 0;
  /** Consecutive refusals, which are bounded where drops are not. */
  let refusals = 0;
  let retryTimer: TimerHandle | null = null;
  /** Whether it has ever been live, so a first subscribe is not a "recovery". */
  let hasBeenLive = false;

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

  /* ── recovery ─────────────────────────────────────────────────────────── */

  function cancelRetry(): void {
    if (retryTimer !== null) {
      unschedule(retryTimer);
      retryTimer = null;
    }
  }

  /**
   * Queue the next attempt.
   *
   * A drop retries forever at the backoff ceiling, because the thing that has to
   * survive is a shop whose connection went away for an hour and came back with
   * nobody at the keyboard. A refusal is counted instead: the server rejecting the
   * channel is a configuration answer, and asking again every minute for the rest
   * of the session would bury the reason under retries. When the budget runs out
   * the status says `error` and the pollers carry the app, which is precisely why
   * they were kept.
   */
  function scheduleRetry(refused: boolean): void {
    if (refused) refusals += 1;
    if (refused && refusals > refusedLimit) {
      cancelRetry();
      setStatus("error");
      return;
    }
    // One pending attempt at a time: a channel that reports CLOSED and then
    // TIMED_OUT must not queue two reconnects, end up with two sockets, or count
    // one outage twice.
    if (retryTimer !== null) return;
    const delay = retryDelays[Math.min(attempts, retryDelays.length - 1)];
    attempts += 1;
    setStatus("reconnecting");
    retryTimer = schedule(() => {
      retryTimer = null;
      // The channel that failed is still the current one, and `sync` skips work
      // when the table list has not changed — so without tearing it down first, a
      // retry would look at the dead socket, decide everything was in order, and
      // leave the app "reconnecting" forever.
      teardown();
      sync();
    }, delay);
  }

  /**
   * "You were offline — look again."
   *
   * Everything written while the channel was down is unknown and cannot be
   * recovered from the socket, so the honest move on the way back up is to make
   * every listener re-read. One change per registered table, which each
   * provider's coalescer collapses into the single refresh it would have made
   * anyway — recovery must not cost five reads because five providers watch.
   */
  function announceRecovery(): void {
    const at = new Date().toISOString();
    for (const registration of [...registrations]) {
      for (const table of registration.tables) {
        registration.listener({ table, event: "UPDATE", at, recovered: true });
      }
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
      cancelRetry();
      setStatus("unavailable");
      return;
    }
    const wanted = wantedTables();
    if (wanted.length === 0) {
      cancelRetry();
      teardown();
      setStatus("idle");
      return;
    }
    const key = wanted.join(",");
    if (channel && key === channelTables) return;

    // A different set of tables is a different subscription, and deserves a fresh
    // refusal budget rather than inheriting the old one's exhaustion. A retry of
    // the *same* set keeps counting, which is what makes the budget mean anything.
    if (key !== builtTables) refusals = 0;
    builtTables = key;
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
    setStatus(attempts > 0 ? "reconnecting" : "connecting");
    next.subscribe((state) => {
      // A channel that was replaced must not report on the one that replaced it.
      if (channel !== next) return;
      if (state === "SUBSCRIBED") {
        const recovering = hasBeenLive || attempts > 0;
        attempts = 0;
        refusals = 0;
        hasBeenLive = true;
        cancelRetry();
        setStatus("live");
        // Listeners refresh through the same repository they always use, so this
        // is a nudge, not a payload — and a drop that cost events costs one read.
        if (recovering) announceRecovery();
      } else if (state === "CHANNEL_ERROR") {
        scheduleRetry(true);
      } else if (state === "CLOSED" || state === "TIMED_OUT") {
        scheduleRetry(false);
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

  const api: RealtimeBus = {
    status: () => current,
    retries: () => attempts,
    retry() {
      // Nothing to reconnect to in demo mode, and nothing to reconnect for when
      // no provider is watching.
      if (!options.client() || wantedTables().length === 0) return;
      cancelRetry();
      attempts = 0;
      refusals = 0;
      // The failed channel is still the current one, so `sync` would see a
      // matching table list and do nothing: tear it down and build a fresh one.
      teardown();
      sync();
    },
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
      cancelRetry();
      teardown();
      builtTables = "";
      attempts = 0;
      refusals = 0;
      hasBeenLive = false;
      setStatus(options.client() ? "idle" : "unavailable");
    },
  };

  /* ── waking up ──────────────────────────────────────────────────────────
   * A hidden tab is throttled and a slept-through outage leaves the socket dead
   * with a retry timer that has not fired. The moment the tab is visible again is
   * the moment the app should be right, so that is when it reconnects at once
   * instead of waiting out the backoff. The listener lives for the session: the
   * singleton below is created once, and only it opts in.
   */
  if (options.recoverOnVisible) {
    const visibility =
      options.visibility === undefined ? documentVisibility() : options.visibility;
    visibility?.onChange(() => {
      // Still hidden: the retry can wait, and a throttled tab firing reconnects
      // nobody will look at is exactly the load this avoids.
      if (visibility.hidden()) return;
      // Healthy, or nothing to reconnect for.
      if (current === "live" || current === "idle" || current === "unavailable") return;
      api.retry();
    });
  }

  return api;
}

/** The bus the app uses. One per session, created on first import. */
export const realtimeBus: RealtimeBus = createRealtimeBus({
  // Import-time status probing must not pre-empt the controlled bootstrap gate.
  // No channel or business repository is mounted for invalid configuration.
  client: () => applicationConfig.ok ? getSupabaseClient() as unknown as RealtimeClientLike | null : null,
  topic: "alyq-pos",
  recoverOnVisible: true,
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
