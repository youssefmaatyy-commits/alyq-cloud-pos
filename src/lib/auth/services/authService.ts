/**
 * Auth service — the only place that creates, validates and destroys sessions.
 *
 * Session model
 *   - `issued_at`     when the session started
 *   - `expires_at`    sliding expiry: `now + idleTtl`, extended on activity
 *   - `remember`      selects the idle TTL (8 h default, 7 days when checked)
 *   - `token`         opaque for now; becomes the Supabase access token in
 *                     live mode, which is why nothing else reads it
 *
 * `restoreSession()` is called on boot and on every navigation, so an expired
 * session is detected on the next interaction rather than only at startup.
 */
import { getUserRepository, getAuthMode } from "../data";
import type { AuthErrorCode, AuthSession, AuthUser, Credentials, SessionEndReason } from "../types";
import {
  clearStoredSession,
  getCachedSession,
  primeCacheFromStorage,
  readStoredSession,
  writeStoredSession,
} from "./sessionStore";

/** Idle lifetime of a session without "remember me". */
export const SESSION_IDLE_MS = 8 * 60 * 60 * 1000;
/** Idle lifetime with "remember me". */
export const SESSION_REMEMBER_IDLE_MS = 7 * 24 * 60 * 60 * 1000;

/** Hard cap so a sliding session can never live forever on one machine. */
export const SESSION_ABSOLUTE_MS = 30 * 24 * 60 * 60 * 1000;

export interface SignInOutcome {
  ok: boolean;
  session?: AuthSession;
  code?: AuthErrorCode;
}

export function idleTtlFor(remember: boolean): number {
  return remember ? SESSION_REMEMBER_IDLE_MS : SESSION_IDLE_MS;
}

function newToken(): string {
  const random = globalThis.crypto?.randomUUID?.();
  if (random) return `sess-${random}`;
  return `sess-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/** Create (but do not persist) a session for a verified user. */
export function createSession(user: AuthUser, remember = false, now: Date = new Date()): AuthSession {
  const idle = idleTtlFor(remember);
  const expires = now.getTime() + Math.min(idle, SESSION_ABSOLUTE_MS);
  return {
    token: newToken(),
    user,
    issued_at: now.toISOString(),
    expires_at: new Date(expires).toISOString(),
    remember,
  };
}

export function isSessionExpired(session: AuthSession, now: Date = new Date()): boolean {
  const expiry = new Date(session.expires_at).getTime();
  if (Number.isNaN(expiry)) return true;
  if (now.getTime() >= expiry) return true;
  // Absolute cap, independent of activity.
  const issued = new Date(session.issued_at).getTime();
  if (!Number.isNaN(issued) && now.getTime() - issued >= SESSION_ABSOLUTE_MS) return true;
  return false;
}

/** Extend a live session's sliding expiry (activity touch). */
export function touchSession(session: AuthSession, now: Date = new Date()): AuthSession {
  const idle = idleTtlFor(session.remember);
  const issued = new Date(session.issued_at).getTime();
  const cap = Number.isNaN(issued) ? now.getTime() + idle : issued + SESSION_ABSOLUTE_MS;
  const next = Math.min(now.getTime() + idle, cap);
  if (new Date(session.expires_at).getTime() >= next) return session;
  return { ...session, expires_at: new Date(next).toISOString() };
}

/**
 * Sign in. Verifies credentials through the repository, then persists a new
 * session. Returns a coded failure so the login screen can render a message
 * without parsing strings.
 */
export async function signIn(credentials: Credentials): Promise<SignInOutcome> {
  const username = credentials.username.trim();
  const password = credentials.password;
  if (!username) return { ok: false, code: "missing_username" };
  if (!password) return { ok: false, code: "missing_password" };

  let result;
  try {
    result = await getUserRepository().authenticate(username, password);
  } catch {
    return { ok: false, code: "network" };
  }
  if (!result.ok) return { ok: false, code: result.code };

  const session = createSession(result.user, Boolean(credentials.remember));
  writeStoredSession(session, credentials.remember ? "local" : "session");
  return { ok: true, session };
}

/** End the session locally and, in live mode, ask the provider to revoke it. */
export async function signOut(): Promise<void> {
  try {
    await getUserRepository().signOut();
  } catch {
    /* a provider error must never trap the user in a signed-in state */
  }
  clearStoredSession();
}

/**
 * Load and validate the persisted session.
 * Returns the session when it is still valid, otherwise `null` — clearing the
 * stored record and reporting `expired` so the login screen can explain why.
 */
export function restoreSession(now: Date = new Date()): { session: AuthSession | null; reason: SessionEndReason } {
  const stored = readStoredSession();
  if (!stored) {
    primeCacheFromStorage();
    return { session: null, reason: null };
  }
  if (isSessionExpired(stored.session, now)) {
    clearStoredSession();
    return { session: null, reason: "expired" };
  }
  writeStoredSession(stored.session, stored.persistence);
  return { session: stored.session, reason: null };
}

/**
 * Re-check the live session (called on navigation, on tab focus and on an
 * interval). Extends the sliding expiry while valid; ends the session when it
 * has expired.
 */
export function validateSession(now: Date = new Date()): {
  session: AuthSession | null;
  reason: SessionEndReason;
  changed: boolean;
} {
  const current = getCachedSession() ?? readStoredSession()?.session ?? null;
  if (!current) return { session: null, reason: null, changed: false };
  if (isSessionExpired(current, now)) {
    clearStoredSession();
    return { session: null, reason: "expired", changed: true };
  }
  const touched = touchSession(current, now);
  if (touched !== current) {
    const persistence = readStoredSession()?.persistence ?? "local";
    writeStoredSession(touched, persistence);
    return { session: touched, reason: null, changed: true };
  }
  return { session: current, reason: null, changed: false };
}

/** True when a usable session exists right now. */
export function hasActiveSession(now: Date = new Date()): boolean {
  const session = getCachedSession() ?? readStoredSession()?.session ?? null;
  return Boolean(session) && !isSessionExpired(session as AuthSession, now);
}

export { getAuthMode };
