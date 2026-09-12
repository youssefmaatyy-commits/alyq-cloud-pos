/**
 * User repository contract — identity, sessions and password recovery.
 *
 * The login screen, the auth service and the Settings module only ever talk to
 * this interface, which is what keeps the offline directory swappable for
 * Supabase Auth without touching a component:
 *
 *   demo : `DemoUserRepository`     — the browser directory in `staffDirectory.ts`
 *   live : `SupabaseUserRepository` — Supabase Auth for credentials and sessions,
 *                                     `profiles` for the name, role and contact
 *                                     details, `custom_roles` for the overlay
 *
 * Two rules the interface enforces by shape:
 *
 *   1. `authenticate()` takes the raw password and returns a coded result. No
 *      caller ever sees a hash, and in live mode no verification happens in the
 *      browser at all — the provider does it.
 *   2. Nothing here stores a password. `requestPasswordReset()` hands an address
 *      to the provider; `updatePassword()` hands a new password to the provider
 *      on an authenticated recovery session. The demo directory keeps a salt and
 *      two digests, and that is the only place a secret-derived value is written.
 */
import type { AuthUser, AuthErrorCode, PasswordResetErrorCode, PasswordResetOutcome } from "../types";
import type { AppRole } from "@/lib/permissions/roles";

/** One row of the user list. Credentials are never part of it. */
export interface AuthUserSummary {
  id: string;
  username: string;
  name: string;
  role: AppRole;
  email: string | null;
  phone: string | null;
  active: boolean;
  custom_role_id: string | null;
  created_at: string | null;
  last_login_at: string | null;
}

export type AuthenticateResult =
  | { ok: true; user: AuthUser }
  | { ok: false; code: AuthErrorCode };

/**
 * A provider session, projected into the three fields the app's session record
 * needs. In live mode `expires_at` is the provider's and is authoritative: the
 * local sliding-expiry simulation is not applied on top of it.
 */
export interface LiveSessionInfo {
  token: string;
  issued_at: string;
  expires_at: string;
  /** Whether the provider can extend it (live: yes; demo: no, it slides locally). */
  refreshable: boolean;
  user: AuthUser | null;
}

/** What the provider said happened. Mapped from `onAuthStateChange`. */
export type AuthChangeEvent =
  | { type: "signed_in"; user: AuthUser }
  | { type: "token_refreshed"; user: AuthUser }
  | { type: "user_updated"; user: AuthUser }
  | { type: "signed_out" };

export type PasswordUpdateResult = { ok: true } | { ok: false; code: PasswordResetErrorCode };

export interface UserRepository {
  readonly kind: "demo" | "supabase";

  /** Every account an admin may manage. */
  listUsers(): Promise<AuthUserSummary[]>;

  /** Verify credentials. Never throws for bad credentials — returns a code. */
  authenticate(username: string, password: string): Promise<AuthenticateResult>;

  /**
   * End the session. `everywhere` asks the provider to revoke all of this
   * user's sessions (live: `signOut({ scope: "global" })`); offline there is only
   * this browser, so the distinction is recorded but has no further reach.
   */
  signOut(options?: { everywhere?: boolean }): Promise<void>;

  /** The provider's current session, or null. */
  currentSession(): Promise<LiveSessionInfo | null>;

  /** Ask the provider to extend the session. Null when it cannot. */
  refreshSession(): Promise<LiveSessionInfo | null>;

  /**
   * Subscribe to provider auth events. Returns the unsubscribe function. The
   * demo repository has no provider, so it returns a no-op: cross-tab sign-out
   * offline is handled by `services/authEvents.ts` instead.
   */
  onAuthChange(listener: (event: AuthChangeEvent) => void): () => void;

  /** Self-service "I forgot my password". */
  requestPasswordReset(identifier: string, redirectTo?: string): Promise<PasswordResetOutcome>;

  /** Set a new password on the signed-in (or recovering) session. */
  updatePassword(newPassword: string): Promise<PasswordUpdateResult>;

  /** Stamp `last_login_at` for a successful sign-in. Best effort. */
  touchLogin(userId: string): Promise<void>;
}
