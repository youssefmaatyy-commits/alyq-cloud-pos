/**
 * Auth service — the only place that creates, validates and destroys sessions.
 *
 * Two session models live here, and which one applies is decided by the mode:
 *
 *   live (Supabase configured)
 *     The provider is the authority. `token` is the Supabase access token,
 *     `expires_at` is the provider's expiry, and validation asks the provider
 *     (`currentSession()` / `refreshSession()`) rather than comparing clocks.
 *     `autoRefreshToken` is already on in `lib/supabase/client`, so a tab left
 *     open keeps its session; when the provider says there is none, the session
 *     ends here immediately.
 *
 *   demo (no credentials)
 *     The offline model the authentication phase shipped, unchanged: an opaque
 *     token, a sliding idle expiry (8 h, or 7 days with "remember me") and a
 *     hard 30-day absolute cap. Nothing in it is a security claim — it exists so
 *     the app is usable and testable without a server.
 *
 * Both models share the same record shape (`AuthSession`) and the same absolute
 * cap, so a session can never outlive 30 days on one machine whichever mode
 * minted it.
 *
 * `restoreSession()` runs on boot and `validateSession()` on every navigation,
 * tab focus and heartbeat, so a lapsed session ends at the next interaction
 * rather than at the next reload.
 */
import { getUserRepository, getAuthMode } from "../data";
import { staffEntryToAuthUser } from "../data/demoRepository";
import { findStaffById } from "../data/staffDirectory";
import type {
  AuthErrorCode,
  AuthSession,
  AuthUser,
  Credentials,
  PasswordResetErrorCode,
  PasswordResetOutcome,
  SessionEndReason,
} from "../types";
import type {
  LiveSessionInfo,
  PasswordUpdateResult,
  RecoveryLinkParts,
} from "../data/repository";
import {
  clearStoredSession,
  getCachedSession,
  primeCacheFromStorage,
  readStoredSession,
  writeStoredSession,
} from "./sessionStore";
import { broadcastAuth } from "./authEvents";
import { recordAudit } from "@/modules/audit/services/auditService";

/** Idle lifetime of a session without "remember me" (demo model). */
export const SESSION_IDLE_MS = 8 * 60 * 60 * 1000;
/** Idle lifetime with "remember me" (demo model). */
export const SESSION_REMEMBER_IDLE_MS = 7 * 24 * 60 * 60 * 1000;

/** Hard cap so a sliding session can never live forever on one machine. */
export const SESSION_ABSOLUTE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * How close to its expiry a live session is refreshed proactively. Refreshing
 * early is what stops a request from racing the provider's own clock.
 */
export const LIVE_REFRESH_AHEAD_MS = 5 * 60 * 1000;

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

/**
 * Project a provider session into the app's record.
 *
 * `issued_at` is carried over from an existing record for the same user so the
 * absolute cap measures from when this browser first saw the session, not from
 * the last refresh — otherwise a tab that refreshes hourly would never reach it.
 */
export function sessionFromProvider(
  live: LiveSessionInfo,
  remember: boolean,
  now: Date = new Date(),
): AuthSession {
  const previous = getCachedSession() ?? readStoredSession()?.session ?? null;
  const issuedAt =
    previous && live.user && previous.user.id === live.user.id && previous.issued_at
      ? previous.issued_at
      : now.toISOString();

  return {
    token: live.token || newToken(),
    user: live.user ?? previous?.user ?? ({} as AuthUser),
    issued_at: issuedAt,
    expires_at: live.expires_at || new Date(now.getTime() + idleTtlFor(remember)).toISOString(),
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

/** The absolute cap alone: has this session been alive too long, whatever else? */
export function isBeyondAbsoluteCap(session: AuthSession, now: Date = new Date()): boolean {
  const issued = new Date(session.issued_at).getTime();
  if (Number.isNaN(issued)) return true;
  return now.getTime() - issued >= SESSION_ABSOLUTE_MS;
}

/** Extend a live session's sliding expiry (activity touch, demo model). */
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
 *
 * In live mode the record is built from the provider session (token + expiry),
 * which is why this awaits `currentSession()` after a successful authentication
 * rather than inventing a token locally.
 */
export async function signIn(credentials: Credentials): Promise<SignInOutcome> {
  const username = credentials.username.trim();
  const password = credentials.password;
  if (!username) return { ok: false, code: "missing_username" };
  if (!password) return { ok: false, code: "missing_password" };

  const repository = getUserRepository();
  const remember = Boolean(credentials.remember);

  let result;
  try {
    result = await repository.authenticate(username, password);
  } catch {
    return { ok: false, code: "network" };
  }
  if (!result.ok) return { ok: false, code: result.code };

  let session: AuthSession;
  if (repository.kind === "supabase") {
    // The provider holds the session now; read it back so the token and the
    // expiry are the provider's, not ours.
    const live = await repository.currentSession().catch(() => null);
    session = live?.user ? sessionFromProvider(live, remember) : createSession(result.user, remember);
    if (!live?.user) session = { ...session, user: result.user };
  } else {
    session = createSession(result.user, remember);
  }

  writeStoredSession(session, remember ? "local" : "session");
  broadcastAuth({ kind: "signed_in", user_id: session.user.id, at: new Date().toISOString() });
  return { ok: true, session };
}

/**
 * End the session locally and, in live mode, ask the provider to revoke it.
 *
 * `everywhere: true` revokes every session the provider holds for this user —
 * "log out of all devices" — rather than only this browser's refresh token.
 */
export async function signOut(options?: { everywhere?: boolean }): Promise<void> {
  const everywhere = Boolean(options?.everywhere);
  try {
    await getUserRepository().signOut({ everywhere });
  } catch {
    /* a provider error must never trap the user in a signed-in state */
  }
  clearStoredSession();
  broadcastAuth({ kind: "signed_out", at: new Date().toISOString(), everywhere });
}

/** Sign out of this browser and every other session the provider holds. */
export function signOutEverywhere(): Promise<void> {
  return signOut({ everywhere: true });
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
 *
 * Synchronous, and authoritative for the demo model. Live mode should prefer
 * `revalidateSession()`, which asks the provider.
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

/**
 * Mode-aware revalidation.
 *
 * Live: ask the provider. A session whose provider expiry has passed is
 * refreshed; a refresh the provider refuses ends the session here, which is what
 * makes a revoked or deactivated account stop working within one heartbeat
 * instead of at the next reload. The absolute cap is applied on top, because it
 * is this app's policy rather than the provider's.
 *
 * Demo: the synchronous sliding-expiry model, unchanged.
 */
export async function revalidateSession(now: Date = new Date()): Promise<{
  session: AuthSession | null;
  reason: SessionEndReason;
  changed: boolean;
}> {
  const current = getCachedSession() ?? readStoredSession()?.session ?? null;
  if (!current) return { session: null, reason: null, changed: false };

  if (getAuthMode() !== "supabase") return validateSession(now);

  if (isBeyondAbsoluteCap(current, now)) {
    await signOut();
    return { session: null, reason: "expired", changed: true };
  }

  const repository = getUserRepository();
  const expiry = new Date(current.expires_at).getTime();
  const needsRefresh = Number.isNaN(expiry) || expiry - now.getTime() <= LIVE_REFRESH_AHEAD_MS;

  try {
    const live = needsRefresh ? await repository.refreshSession() : await repository.currentSession();
    if (!live || !live.user) {
      clearStoredSession();
      return { session: null, reason: "expired", changed: true };
    }
    const next = sessionFromProvider(live, current.remember, now);
    const persistence = readStoredSession()?.persistence ?? (current.remember ? "local" : "session");
    writeStoredSession(next, persistence);
    const changed = next.token !== current.token || next.expires_at !== current.expires_at || next.user !== current.user;
    return { session: next, reason: null, changed };
  } catch {
    // A network failure is not a signed-out user: keep the session and try again
    // on the next heartbeat. Only the provider saying "no session" ends it.
    return { session: current, reason: null, changed: false };
  }
}

/**
 * Adopt a session the provider announced (an `onAuthStateChange` event, or a
 * recovery link landing on `#/reset-password`). Persisted like a sign-in.
 */
export function adoptProviderSession(live: LiveSessionInfo, remember = false): AuthSession | null {
  if (!live.user) return null;
  const session = sessionFromProvider(live, remember);
  writeStoredSession(session, remember ? "local" : "session");
  return session;
}

/**
 * May the app turn a provider session it *found* (on boot, from a refresh or
 * focus event, or from the provider's own event channel) into its own
 * session? Only when an app record already attests to it.
 *
 * `persistSession: true` on the Supabase client means a provider session can
 * appear "for free" — most importantly, it would silently resurrect someone
 * who signed in with remember-me OFF and closed the tab, undoing exactly the
 * promise that checkbox makes. So adoption is app-record-authoritative: the
 * record was written by an actual sign-in (or a consumed recovery link), and
 * a provider session with no record behind it is an orphan to be signed out,
 * not a session to be believed.
 */
export function shouldAdoptFoundProviderSession(appSessionHeld: boolean): boolean {
  return appSessionHeld;
}

/** Drop the local record without asking the provider (a signed-out event). */
export function forgetSession(): void {
  clearStoredSession();
}

/** Do two identities differ in any way a permission check would notice? */
function identityChanged(previous: AuthUser, next: AuthUser): boolean {
  if (previous.role !== next.role) return true;
  if (previous.custom_role_id !== next.custom_role_id) return true;
  if (previous.active !== next.active) return true;
  if (previous.name !== next.name) return true;
  if (previous.email !== next.email || previous.phone !== next.phone) return true;
  if (previous.capabilities.length !== next.capabilities.length) return true;
  return previous.capabilities.some((capability, index) => capability !== next.capabilities[index]);
}

/**
 * Re-resolve the signed-in identity from the source of truth.
 *
 * Needed because an administrator can change somebody's authority while that
 * person is signed in — in another tab, or on another machine. Without this, the
 * answer to "can this cashier still void a sale?" would be whatever their session
 * happened to contain when they signed in, which is exactly the stale-permission
 * bug a role system must not have.
 *
 *   live : ask the provider, which re-reads `profiles` and `custom_roles`;
 *   demo : rebuild from the staff directory and the custom-role store.
 *
 * A deactivated or vanished account ends the session here, so the change takes
 * effect at the next heartbeat (≤ 60 s) rather than at the next reload.
 */
export async function resyncCurrentIdentity(now: Date = new Date()): Promise<{
  session: AuthSession | null;
  changed: boolean;
  signedOut: boolean;
}> {
  const current = getCachedSession() ?? readStoredSession()?.session ?? null;
  if (!current) return { session: null, changed: false, signedOut: false };
  const persistence = readStoredSession()?.persistence ?? (current.remember ? "local" : "session");

  if (getAuthMode() === "supabase") {
    try {
      const live = await getUserRepository().currentSession();
      if (!live || !live.user || live.user.active === false) {
        clearStoredSession();
        return { session: null, changed: true, signedOut: true };
      }
      const next = sessionFromProvider(live, current.remember, now);
      const changed = identityChanged(current.user, next.user) || next.token !== current.token;
      writeStoredSession(next, persistence);
      return { session: next, changed, signedOut: false };
    } catch {
      // Offline or provider error: keep what we have and try again later.
      return { session: current, changed: false, signedOut: false };
    }
  }

  const entry = findStaffById(current.user.id);
  if (!entry || !entry.active) {
    clearStoredSession();
    return { session: null, changed: true, signedOut: true };
  }
  const user = staffEntryToAuthUser(entry);
  if (!user.role) {
    clearStoredSession();
    return { session: null, changed: true, signedOut: true };
  }
  if (!identityChanged(current.user, user)) return { session: current, changed: false, signedOut: false };

  const next: AuthSession = {
    ...current,
    // Keep the sign-in timestamp this browser observed: the absolute cap and the
    // "last login" column both describe the session, not the identity edit.
    user: { ...user, last_login_at: current.user.last_login_at ?? user.last_login_at },
  };
  writeStoredSession(next, persistence);
  return { session: next, changed: true, signedOut: false };
}

/** True when a usable session exists right now. */
export function hasActiveSession(now: Date = new Date()): boolean {
  const session = getCachedSession() ?? readStoredSession()?.session ?? null;
  return Boolean(session) && !isSessionExpired(session as AuthSession, now);
}

// ── password recovery ───────────────────────────────────────────────────────

/**
 * Ask for a reset link.
 *
 * Live mode hands the address to Supabase, which emails a link that lands on
 * `#/reset-password` with a recovery token in the URL. Demo mode has no mail
 * server and says so (`channel: "demo"`); the offline answer is an admin reset
 * from Settings → Users.
 *
 * The outcome deliberately does not reveal whether the account exists.
 */
export async function requestPasswordReset(identifier: string, redirectTo?: string): Promise<PasswordResetOutcome> {
  const handle = identifier.trim();
  if (!handle) return { ok: false, code: "missing_identifier" };
  try {
    return await getUserRepository().requestPasswordReset(handle, redirectTo);
  } catch {
    return { ok: false, code: "network" };
  }
}

/**
 * Record that a password was *successfully* changed. Written here, once, so
 * the recovery flow and the reauthenticated change-password flow each produce
 * exactly one audit row carrying how the change was authorised. Never allowed
 * to break the flow it describes.
 */
function auditPasswordChanged(via: "recovery_link" | "current_password"): void {
  const actor = getCachedSession()?.user ?? null;
  void recordAudit({
    action: "user.password_changed",
    entity: "user",
    entity_id: actor?.id ?? "",
    entity_label: actor?.name || actor?.username || "—",
    details: { self_service: true, via },
    user_id: actor?.id ?? "",
    user_name: actor?.name ?? "",
  });
}

/**
 * Set a new password on the current (or recovering) session.
 *
 * Live mode: `auth.updateUser({ password })` — the provider validates strength
 * and invalidates other sessions per the project's settings. Demo mode: a new
 * salt and digests in the offline directory.
 */
export async function updatePassword(newPassword: string): Promise<PasswordUpdateResult> {
  try {
    const outcome = await getUserRepository().updatePassword(newPassword);
    if (outcome.ok) auditPasswordChanged("recovery_link");
    return outcome;
  } catch {
    return { ok: false, code: "network" };
  }
}

/**
 * Change the signed-in user's own password after re-proving the current one.
 * This is deliberately a different door from recovery: no emailed link, no
 * recovery state — the current password is the authority, checked by the same
 * `authenticate` machinery a daily login uses (usernames included).
 */
export async function changePassword(currentPassword: string, newPassword: string): Promise<PasswordUpdateResult> {
  try {
    const outcome = await getUserRepository().changePassword(currentPassword, newPassword);
    if (outcome.ok) auditPasswordChanged("current_password");
    return outcome;
  } catch {
    return { ok: false, code: "network" };
  }
}

/**
 * Follow a reset link: exchange whatever the provider put in the URL for a
 * session, then adopt it so the rest of the app sees a signed-in person who may
 * set a new password.
 *
 * Called once, by the reset page, before it renders the form.
 */
export async function consumePasswordRecoveryLink(
  parts: RecoveryLinkParts,
): Promise<{ ok: true; session: AuthSession | null } | { ok: false; code: PasswordResetErrorCode }> {
  const repository = getUserRepository();
  let result;
  try {
    result = await repository.consumeRecoveryLink(parts);
  } catch {
    return { ok: false, code: "network" };
  }
  if (!result.ok) return result;

  if (repository.kind === "supabase") {
    const live = await repository.currentSession().catch(() => null);
    if (live?.user) return { ok: true, session: adoptProviderSession(live, false) };
    return { ok: true, session: getCachedSession() ?? readStoredSession()?.session ?? null };
  }
  return { ok: true, session: getCachedSession() ?? readStoredSession()?.session ?? null };
}

/**
 * The URL a reset email should land on: this app, at the recovery route, with
 * whatever hash the provider appended preserved.
 */
export function passwordResetRedirectUrl(origin?: string): string {
  const base = (origin ?? globalThis.location?.origin ?? "").replace(/\/$/, "");
  return `${base}/#/reset-password`;
}

export { getAuthMode };
