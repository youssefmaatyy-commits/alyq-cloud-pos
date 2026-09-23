/**
 * Cross-tab session events.
 *
 * A shop runs the till in one tab and the back office in another. When one of
 * them signs out — or an admin's session is revoked — the other must not keep
 * serving a session that no longer exists. Supabase's `onAuthStateChange` covers
 * the live provider's own storage events, but the app's session record (and
 * therefore every permission check) is ours, so we announce changes ourselves.
 *
 * Two channels, because either can be missing:
 *   · `BroadcastChannel` — immediate, same-origin, not available everywhere;
 *   · a `localStorage` write — arrives as a `storage` event in every *other* tab,
 *     which is exactly the audience, and works in browsers without the channel.
 *
 * The payload carries no session and no token: a tab that hears "signed out"
 * re-reads its own storage and re-validates, rather than trusting a message.
 */
import { SESSION_STORAGE_KEY } from "./sessionStore";

export const AUTH_CHANNEL_NAME = "alyq.auth";
/** The key whose *change* is the fallback signal. Its value is never read. */
export const AUTH_SIGNAL_KEY = "alyq.auth.signal.v1";

export type AuthBroadcast =
  | { kind: "signed_out"; at: string; everywhere: boolean }
  | { kind: "signed_in"; user_id: string; at: string }
  | { kind: "session_changed"; at: string };

type Listener = (event: AuthBroadcast) => void;

function channel(): BroadcastChannel | null {
  try {
    const Ctor = (globalThis as { BroadcastChannel?: typeof BroadcastChannel }).BroadcastChannel;
    return Ctor ? new Ctor(AUTH_CHANNEL_NAME) : null;
  } catch {
    return null;
  }
}

function writeSignal(event: AuthBroadcast): void {
  try {
    // A fresh value every time, so two identical events in a row still fire.
    const payload = JSON.stringify({ ...event, nonce: Math.random().toString(36).slice(2) });
    globalThis.localStorage?.setItem(AUTH_SIGNAL_KEY, payload);
  } catch {
    /* private mode / no storage — the BroadcastChannel half may still work */
  }
}

/** Announce a session change to every other tab. */
export function broadcastAuth(event: AuthBroadcast): void {
  const bus = channel();
  if (bus) {
    try {
      bus.postMessage(event);
    } catch {
      /* ignore */
    }
    bus.close();
  }
  writeSignal(event);
}

/**
 * Listen for other tabs. Returns an unsubscribe function.
 *
 * The same handler is wired to both channels and de-duplicated by the event's
 * timestamp + kind, because a tab with both available would otherwise react
 * twice to one sign-out.
 */
export function subscribeAuthEvents(listener: Listener): () => void {
  const seen = new Set<string>();
  const handle = (event: AuthBroadcast) => {
    const fingerprint = `${event.kind}:${event.at}`;
    if (seen.has(fingerprint)) return;
    seen.add(fingerprint);
    if (seen.size > 32) {
      // Bounded, so a long-lived tab does not accumulate fingerprints forever.
      for (const key of [...seen].slice(0, 16)) seen.delete(key);
    }
    listener(event);
  };

  const bus = channel();
  const onMessage = (message: MessageEvent) => {
    const data = message?.data as AuthBroadcast | undefined;
    if (data && typeof data.kind === "string" && typeof data.at === "string") handle(data);
  };
  bus?.addEventListener("message", onMessage);

  const onStorage = (event: StorageEvent) => {
    if (event.key !== AUTH_SIGNAL_KEY || !event.newValue) return;
    try {
      const data = JSON.parse(event.newValue) as AuthBroadcast;
      if (data && typeof data.kind === "string" && typeof data.at === "string") handle(data);
    } catch {
      /* a malformed signal is ignored, not acted on */
    }
  };
  globalThis.addEventListener?.("storage", onStorage as EventListener);

  // A session written by *this* tab is not an event for this tab; the storage
  // event does not fire in the writing tab, so nothing extra is needed there.
  void SESSION_STORAGE_KEY;

  return () => {
    bus?.removeEventListener("message", onMessage);
    bus?.close();
    globalThis.removeEventListener?.("storage", onStorage as EventListener);
  };
}
