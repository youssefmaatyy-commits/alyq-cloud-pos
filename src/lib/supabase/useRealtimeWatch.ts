/**
 * The React end of the realtime bus (Phase 16).
 *
 * Two hooks, both thin on purpose:
 *
 *   · `useRealtimeStatus` — where the channel is, for a label that must not claim
 *     liveness the app does not have ("Live" in Supabase mode with a socket up,
 *     "Checking every 20s" in demo mode or when the channel was refused).
 *   · `useRealtimeWatch(tables, onChange)` — what a provider actually wants: "when
 *     any of these tables moves, re-read". It owns the coalescing, the latest
 *     callback and the teardown, so no provider has to think about bursts,
 *     overlapping refreshes or unsubscribing on unmount.
 *
 * What it deliberately does *not* do is carry data. The listener re-reads through
 * the repository it already used, which keeps one code path for demo and live
 * mode, keeps row-level security in charge of what anybody may see, and means a
 * dropped event costs freshness rather than correctness.
 */
import { useEffect, useRef, useSyncExternalStore } from "react";
import { createCoalescer, realtimeBus, type RealtimeStatus, type RealtimeTable } from "./realtime";

/** Where the shared channel is, reactively. */
export function useRealtimeStatus(): RealtimeStatus {
  return useSyncExternalStore(
    (onStoreChange) => realtimeBus.onStatus(() => onStoreChange()),
    () => realtimeBus.status(),
    // No SSR in this app; the value is what a store-less render would assume.
    () => "unavailable" as RealtimeStatus,
  );
}

export interface UseRealtimeWatchOptions {
  /** Milliseconds a burst is collapsed into. The default suits one order's writes. */
  windowMs?: number;
  /**
   * Watch only while true. A provider that cannot read these rows — a cashier
   * without `manage_online_orders`, say — must not subscribe at all: in live mode
   * the channel would connect and then hear nothing, and the console would carry
   * a refusal nobody can act on.
   */
  enabled?: boolean;
}

/**
 * Re-run `onChange` when any of `tables` changes in the database.
 *
 * `onChange` may change identity every render (providers rebuild callbacks when
 * their filter changes); the latest one is kept in a ref and the subscription
 * itself only moves when the *table list* changes, so a re-render never costs a
 * socket. Returns the channel status so the caller can show it.
 */
export function useRealtimeWatch(
  tables: readonly RealtimeTable[],
  onChange: () => void | Promise<void>,
  options: UseRealtimeWatchOptions = {},
): RealtimeStatus {
  const { windowMs = 400, enabled = true } = options;
  // A stable key: `[a, b]` and `[a, b]` are different arrays on every render.
  const key = tables.join(",");
  const tablesRef = useRef<readonly RealtimeTable[]>(tables);
  tablesRef.current = tables;
  const handler = useRef(onChange);
  handler.current = onChange;

  useEffect(() => {
    if (!enabled || key.length === 0) return;
    const coalescer = createCoalescer(() => handler.current(), windowMs);
    const unsubscribe = realtimeBus.subscribe(tablesRef.current, () => coalescer.trigger());
    return () => {
      coalescer.cancel();
      unsubscribe();
    };
    // `key` stands in for the table list, `windowMs` for the burst window.
  }, [key, windowMs, enabled]);

  return useRealtimeStatus();
}
