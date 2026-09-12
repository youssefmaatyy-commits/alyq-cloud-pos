/**
 * New-order notifications for the POS.
 *
 * A website order that nobody looks at is worse than no website: the customer
 * has paid (or promised to) and the stock is being held. So the shell asks for
 * counts on an interval, and three things happen when the pending number goes
 * up — a badge in the sidebar, a banner on the online-orders screen, and (if the
 * shop switched it on) a short beep.
 *
 * The beep is synthesised with the WebAudio API rather than played from a file:
 * there is no asset to ship, nothing to fail to load on a slow connection, and
 * browsers only allow it after the user has interacted with the page, which is
 * already true of anybody working the till.
 *
 * Phase 16 put a realtime channel underneath this. In live mode an insert on
 * `online_orders` arrives over the shared socket and re-runs *this* refresh, so a
 * new order is on the badge in well under a second instead of up to twenty. The
 * interval does not go away — it becomes the safety net, stretched to two minutes
 * while the channel is up and back to the shop's chosen rate the moment it is
 * not. That ordering matters: realtime is an optimisation, and the poll is what
 * makes a dropped socket cost freshness rather than a missed order.
 *
 * Nothing about the announcement changes, which is what keeps it from double-
 * chiming. "Only a rise is news" is measured against the last count this hook
 * saw, and every path — event, interval, manual refresh — goes through the same
 * `refresh`, so whichever arrives first sets the baseline and the other sees no
 * rise to announce.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useRealtimeWatch } from "@/lib/supabase/useRealtimeWatch";
import { getOnlineOrdersRepository } from "../data";
import { EMPTY_ORDER_COUNTS, toOnlineError, type OrderCounts } from "../data/repository";

const PREFS_KEY = "alyq.online.notify.v1";

/** How often to ask. 20s is quick enough to feel live, quiet enough to be free. */
export const DEFAULT_POLL_MS = 20_000;
export const POLL_CHOICES = [10_000, 20_000, 60_000] as const;

/**
 * How often to re-check while a realtime channel is up.
 *
 * Two minutes is long enough that the socket does the work and short enough that
 * a channel which silently stopped delivering — a laptop waking from sleep, a
 * proxy that dropped the upgrade — is contradicted by a real read soon after.
 */
export const SAFETY_NET_POLL_MS = 120_000;

/**
 * How many orders just arrived, or `null` when there is nothing to announce.
 *
 * Only a rise is news. A fall means somebody worked the queue, and a first
 * reading is a baseline — announcing eleven orders that were already waiting
 * would train staff to ignore the chime. This is also what keeps a realtime event
 * and the safety-net poll from announcing the same order twice: whichever runs
 * first moves the baseline, and the other then sees no rise. Extracted from the
 * refresh so the rule is tested rather than trusted.
 */
export function arrivalsOf(previous: number | null, pending: number): number | null {
  if (previous === null) return null;
  if (pending <= previous) return null;
  return pending - previous;
}

/**
 * How fresh this screen is, in one word the UI can render.
 *
 * `realtime` means a channel is subscribed and events are arriving; `polling`
 * means the interval is the only thing working (demo mode, still connecting);
 * `error` means the channel was refused or dropped and the poll has taken over.
 */
export type NotificationTransport = "realtime" | "polling" | "error";

/**
 * The interval to run at, given the shop's preference and whether the channel is
 * up. Exported because it is the one number that decides how the app behaves when
 * realtime fails, and a rule like that belongs in a test rather than in prose.
 */
export function pollIntervalFor(prefs: NotificationPrefs, live: boolean): number {
  if (!live) return prefs.pollMs;
  // The preference is a floor, never a ceiling: a shop that asked to be checked
  // every 60s is not silently checked every 20s because a socket came up, and one
  // that asked for 10s is not hammered while the socket is doing the work.
  return Math.max(prefs.pollMs, SAFETY_NET_POLL_MS);
}

export interface NotificationPrefs {
  sound: boolean;
  pollMs: number;
}

export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = {
  sound: true,
  pollMs: DEFAULT_POLL_MS,
};

function readPrefs(): NotificationPrefs {
  try {
    const raw = window.localStorage.getItem(PREFS_KEY);
    if (!raw) return DEFAULT_NOTIFICATION_PREFS;
    const parsed = JSON.parse(raw) as Partial<NotificationPrefs>;
    return {
      sound: typeof parsed.sound === "boolean" ? parsed.sound : DEFAULT_NOTIFICATION_PREFS.sound,
      pollMs: POLL_CHOICES.includes(parsed.pollMs as (typeof POLL_CHOICES)[number])
        ? (parsed.pollMs as number)
        : DEFAULT_NOTIFICATION_PREFS.pollMs,
    };
  } catch {
    return DEFAULT_NOTIFICATION_PREFS;
  }
}

function writePrefs(prefs: NotificationPrefs): void {
  try {
    window.localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    /* private mode — the preference simply will not survive a reload */
  }
}

/** Two short tones: distinct from a till beep, and impossible to sleep through. */
export function playOrderChime(): void {
  try {
    const AudioCtor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtor) return;
    const context = new AudioCtor();
    const now = context.currentTime;

    for (const [offset, frequency] of [
      [0, 880],
      [0.18, 1174.66],
    ] as const) {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = "sine";
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0.0001, now + offset);
      gain.gain.exponentialRampToValueAtTime(0.18, now + offset + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + offset + 0.16);
      oscillator.connect(gain).connect(context.destination);
      oscillator.start(now + offset);
      oscillator.stop(now + offset + 0.18);
    }

    // Closing the context releases the audio device; the notes are already
    // scheduled, so this does not cut them off.
    window.setTimeout(() => void context.close(), 800);
  } catch {
    // No audio device, blocked autoplay, or a browser without WebAudio: the
    // badge and the banner still do their job.
  }
}

export interface OnlineNotificationState {
  counts: OrderCounts;
  loading: boolean;
  error: string | null;
  /** Orders that arrived since this screen was opened — the banner's list. */
  newOrderNumbers: string[];
  /** True once at least one poll has completed since the hook mounted. */
  ready: boolean;
  /** How the counts are arriving — for a label that must not overclaim. */
  transport: NotificationTransport;
  /** True while a realtime channel is subscribed to `online_orders`. */
  live: boolean;
  prefs: NotificationPrefs;
  setPrefs: (prefs: Partial<NotificationPrefs>) => void;
  refresh: () => Promise<void>;
  /** Called by the online-orders screen once it has shown the arrivals. */
  acknowledge: () => void;
  lastCheckedAt: string | null;
}

/**
 * The state a screen sees when nothing is polling.
 *
 * Exported so the shared provider can hand it out instead of throwing when the
 * shell is mounted somewhere that has no website orders to watch.
 */
export const EMPTY_NOTIFICATION_STATE: OnlineNotificationState = {
  counts: EMPTY_ORDER_COUNTS,
  loading: false,
  error: null,
  newOrderNumbers: [],
  ready: false,
  transport: "polling",
  live: false,
  prefs: DEFAULT_NOTIFICATION_PREFS,
  setPrefs: () => {},
  refresh: async () => {},
  acknowledge: () => {},
  lastCheckedAt: null,
};

/**
 * Poll for order counts.
 *
 * `enabled` should be the capability check: a user without `manage_online_orders`
 * must not have the shell querying orders at all, because in live mode that
 * query would be refused by row-level security on every tick.
 */
export function useOnlineNotifications(enabled: boolean): OnlineNotificationState {
  const [counts, setCounts] = useState<OrderCounts>(EMPTY_ORDER_COUNTS);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [lastCheckedAt, setLastCheckedAt] = useState<string | null>(null);
  const [prefs, setPrefsState] = useState<NotificationPrefs>(() =>
    typeof window === "undefined" ? DEFAULT_NOTIFICATION_PREFS : readPrefs(),
  );
  const [newOrderNumbers, setNewOrderNumbers] = useState<string[]>([]);

  const previousPending = useRef<number | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    if (!enabled) return;
    try {
      const repository = getOnlineOrdersRepository();
      const next = await repository.counts();
      if (!mounted.current) return;

      const before = previousPending.current;
      previousPending.current = next.pending;

      const arrived = arrivalsOf(before, next.pending);
      if (arrived !== null) {
        if (prefs.sound) playOrderChime();
        try {
          const recent = await repository.listOrders({ status: "pending", limit: arrived });
          if (mounted.current) {
            setNewOrderNumbers((previous) => [
              ...recent.map((order) => order.order_number),
              ...previous,
            ].slice(0, 12));
          }
        } catch {
          // The badge already knows; the list is a convenience.
        }
      }

      setCounts(next);
      setError(null);
      setLastCheckedAt(new Date().toISOString());
    } catch (caught) {
      if (!mounted.current) return;
      setError(toOnlineError(caught).message);
    } finally {
      if (mounted.current) {
        setLoading(false);
        setReady(true);
      }
    }
  }, [enabled, prefs.sound]);

  // The same refresh the interval uses, triggered by an insert or update on the
  // orders table. `enabled` is the capability check: a user who may not read
  // these rows must not subscribe to them, because in live mode the channel would
  // connect and then hear nothing at all.
  const status = useRealtimeWatch(["online_orders"], refresh, { enabled });
  const live = status === "live";
  const transport: NotificationTransport = status === "error" ? "error" : live ? "realtime" : "polling";

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      setCounts(EMPTY_ORDER_COUNTS);
      return;
    }
    void refresh();
    const timer = window.setInterval(() => void refresh(), pollIntervalFor(prefs, live));
    return () => window.clearInterval(timer);
  }, [enabled, prefs, live, refresh]);

  const setPrefs = useCallback((patch: Partial<NotificationPrefs>) => {
    setPrefsState((current) => {
      const next = { ...current, ...patch };
      writePrefs(next);
      return next;
    });
  }, []);

  const acknowledge = useCallback(() => setNewOrderNumbers([]), []);

  return {
    counts,
    loading,
    error,
    newOrderNumbers,
    ready,
    transport,
    live,
    prefs,
    setPrefs,
    refresh,
    acknowledge,
    lastCheckedAt,
  };
}
