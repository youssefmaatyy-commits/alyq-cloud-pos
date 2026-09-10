/**
 * Session persistence + the single module-level "who is signed in" cache.
 *
 * Everything that asks "who is acting?" goes through `getCurrentAuthUser()`
 * (re-exported as `getCurrentUser()` by the inventory module so existing call
 * sites keep working). Keeping the cache here — not in a component — is what
 * lets the pure permission helpers stay synchronous while the session itself is
 * created/validated by the auth service.
 *
 * Storage layout (one key, so a future Supabase migration has a single place to
 * clear):
 *   localStorage  alyq.auth.session.v1   { session, persistence: "local" }
 *   sessionStorage                        { session, persistence: "session" }
 *
 * Reading checks the *other* store too, so a session created with "remember me"
 * off survives a tab reload but not a browser restart, and switching between the
 * two never leaves a stale record behind.
 */
import type { AuthSession, AuthUser, SessionPersistence, StoredSession } from "../types";

export const SESSION_STORAGE_KEY = "alyq.auth.session.v1";

/**
 * A signed-out placeholder: an empty role is not a member of the model, so
 * `normalizeRole` rejects it and every capability is denied (fail closed).
 * `id` is empty so audit rows written without a session show no actor.
 */
export const ANONYMOUS_USER: AuthUser = { id: "", username: "", name: "", role: "" as AuthUser["role"] };

let cachedSession: AuthSession | null = null;
let cachedLoaded = false;

interface MinimalStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function localStore(): MinimalStorage | null {
  try {
    return globalThis.localStorage ?? globalThis.window?.localStorage ?? null;
  } catch {
    return null;
  }
}

function sessionStore(): MinimalStorage | null {
  try {
    return globalThis.sessionStorage ?? globalThis.window?.sessionStorage ?? null;
  } catch {
    return null;
  }
}

function readFrom(store: MinimalStorage | null): StoredSession | null {
  if (!store) return null;
  try {
    const raw = store.getItem(SESSION_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredSession>;
    const session = parsed?.session as AuthSession | undefined;
    if (!session?.token || !session.user?.id || !session.expires_at) return null;
    return {
      session,
      persistence: parsed.persistence === "session" ? "session" : "local",
    };
  } catch {
    return null;
  }
}

/** Read the persisted session, preferring the long-lived store. */
export function readStoredSession(): StoredSession | null {
  return readFrom(localStore()) ?? readFrom(sessionStore());
}

export function writeStoredSession(session: AuthSession, persistence: SessionPersistence): void {
  const payload = JSON.stringify({ session, persistence } satisfies StoredSession);
  // Never keep two copies of the session around.
  clearStoredSession();
  try {
    if (persistence === "session") sessionStore()?.setItem(SESSION_STORAGE_KEY, payload);
    else localStore()?.setItem(SESSION_STORAGE_KEY, payload);
  } catch {
    /* quota / private mode — the in-memory cache still holds the session */
  }
  cachedSession = session;
  cachedLoaded = true;
}

export function clearStoredSession(): void {
  try {
    localStore()?.removeItem(SESSION_STORAGE_KEY);
  } catch {
    /* ignore */
  }
  try {
    sessionStore()?.removeItem(SESSION_STORAGE_KEY);
  } catch {
    /* ignore */
  }
  cachedSession = null;
  cachedLoaded = true;
}

/** In-memory session (fast path for the permission helpers). */
export function getCachedSession(): AuthSession | null {
  return cachedSession;
}

/** The acting user for permission checks. Signed out → `ANONYMOUS_USER`. */
export function getCurrentAuthUser(): AuthUser {
  return cachedSession?.user ?? ANONYMOUS_USER;
}

/** Seed the cache from storage without validating it (see `restoreSession`). */
export function primeCacheFromStorage(): AuthSession | null {
  if (cachedLoaded) return cachedSession;
  const stored = readStoredSession();
  cachedSession = stored?.session ?? null;
  cachedLoaded = true;
  return cachedSession;
}

/** Test seam — drop the in-memory cache (does not touch storage). */
export function resetSessionCache(): void {
  cachedSession = null;
  cachedLoaded = false;
}
