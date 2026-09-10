/**
 * Authentication — domain types.
 *
 * The shapes here are deliberately provider-agnostic so the demo credential
 * store used today can be swapped for Supabase Auth without touching the UI:
 *
 *   demo mode   : `DemoUserRepository` verifies a salted hash in the browser.
 *   live mode   : `SupabaseUserRepository` calls `auth.signInWithPassword()`
 *                 and reads the role from a `profiles` row.
 *
 * The session record is intentionally explicit (token, issued_at, expires_at)
 * rather than an opaque blob, because it is what `restoreSession()` validates
 * and what Supabase's session object will be adapted into later.
 */
import type { AppRole } from "@/lib/permissions/roles";

/** A signed-in person. `role` is always a member of the canonical model. */
export interface AuthUser {
  id: string;
  /** Login handle (lower-case, unique). */
  username: string;
  /** Display name shown across the app and on records. */
  name: string;
  role: AppRole;
  /** Future: Supabase auth user id, when the session is provider-backed. */
  auth_id?: string | null;
}

/** Credentials submitted from the login screen. */
export interface Credentials {
  username: string;
  password: string;
  /** Long-lived session (7 days idle) instead of the 8-hour default. */
  remember?: boolean;
}

export interface AuthSession {
  /** Opaque session token (Supabase access token later). */
  token: string;
  user: AuthUser;
  /** ISO timestamps. */
  issued_at: string;
  /** Sliding expiry: extended on activity. */
  expires_at: string;
  /** Whether the session survives longer idle periods. */
  remember: boolean;
}

/** Why a sign-in attempt failed — drives the message on the login screen. */
export type AuthErrorCode =
  | "invalid_credentials"
  | "missing_username"
  | "missing_password"
  | "network"
  | "not_configured"
  | "unknown";

export class AuthError extends Error {
  readonly code: AuthErrorCode;
  constructor(code: AuthErrorCode, message?: string) {
    super(message ?? code);
    this.name = "AuthError";
    this.code = code;
  }
}

/** Result of a sign-in attempt. */
export type SignInResult =
  | { ok: true; session: AuthSession }
  | { ok: false; code: AuthErrorCode };

/**
 * Why the current session ended — surfaced once on the login screen so the
 * user is told what happened rather than silently bounced.
 */
export type SessionEndReason = "expired" | "signed_out" | null;

/** Where the session record lives between reloads. */
export type SessionPersistence = "local" | "session";

export interface StoredSession {
  session: AuthSession;
  persistence: SessionPersistence;
}
