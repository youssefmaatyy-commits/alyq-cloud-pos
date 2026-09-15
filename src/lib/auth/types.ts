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
import type { AppRole, Capability } from "@/lib/permissions/roles";

/** A signed-in person. `role` is always a member of the canonical model. */
export interface AuthUser {
  id: string;
  /** Login handle (lower-case, unique). */
  username: string;
  /** Display name shown across the app and on records. */
  name: string;
  /**
   * The *system* role. Always one of the five canonical labels, even when the
   * person wears a custom role: a custom role is an overlay that carries its own
   * `base_role`, and keeping this field canonical is what lets every pre-Phase-10
   * permission helper, RLS policy and audit row keep working unchanged.
   */
  role: AppRole;
  /** Supabase Auth user id when the session is provider-backed. */
  auth_id?: string | null;
  /** Contact details, surfaced by Settings → Users. Never a credential. */
  email?: string | null;
  phone?: string | null;
  /**
   * False when an admin deactivated the account. A deactivated profile yields no
   * capabilities in the database (`public.can()` reads only active profiles) and
   * is refused at sign-in here, so the two agree.
   */
  active?: boolean;
  /** Admin-defined role overlay (Phase 10), when one is assigned and active. */
  custom_role_id?: string | null;
  custom_role_name?: string | null;
  /**
   * The capabilities that apply to this person, resolved at sign-in:
   * the custom role's list when one is worn, otherwise the system matrix for
   * `role`. Carrying the resolved list is what keeps every permission check
   * synchronous — no gate has to await a repository to decide whether to render.
   *
   * Required, not optional: an identity whose list is `undefined` would let a
   * `user.capabilities?.includes(x)` read as "unknown" instead of "denied".
   */
  capabilities: readonly Capability[];
  /** When this person last signed in (stamped by the provider or the RPC). */
  last_login_at?: string | null;
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
  /** The account exists but an admin deactivated it. */
  | "user_inactive"
  /**
   * Too many attempts from this client: the server-side sign-in path rate
   * limits before any provider call. A different instruction from "wrong
   * credentials" — wait a moment — and it says nothing about any account.
   */
  | "rate_limited"
  | "unknown";

/**
 * Why a password-reset step failed. Kept separate from `AuthErrorCode` because
 * the reset flow is not a sign-in: "no such account" must not be distinguishable
 * from "check your inbox", or the form becomes an account-enumeration oracle.
 */
export type PasswordResetErrorCode =
  | "missing_identifier"
  | "invalid_email"
  | "network"
  | "not_configured"
  | "weak_password"
  | "not_authenticated"
  /**
   * The signed-in flow re-proves the CURRENT password before changing it, and
   * this is the verdict when that proof fails. Only produced by
   * `changePassword`; never by the recovery flow, which deliberately cannot
   * distinguish between its refusals.
   */
  | "invalid_credentials"
  /**
   * A recovery link that expired, was already used, or does not parse. All three
   * report the same code on purpose: the only action anyone can take is "ask for
   * a new link", and distinguishing them would tell a stranger how close they got.
   */
  | "expired"
  /** Supabase throttles reset requests; "try again in a minute" is the honest answer. */
  | "rate_limited"
  | "unknown";

export type PasswordResetOutcome =
  | { ok: true; /** Demo mode has no mail server, so it says what it did instead. */ channel: "email" | "demo" }
  | { ok: false; code: PasswordResetErrorCode };

/**
 * Password policy vocabulary.
 *
 * It lives with the auth model rather than in the settings module because three
 * different screens apply it: an admin creating an account, an admin resetting
 * one, and a person following a reset link. Sharing one rule set is the point —
 * the alternative is three slightly different bars, and the weakest becomes the
 * real policy.
 */
export type PasswordRuleKey = "length" | "letter" | "digit" | "not_username" | "not_common";

export interface PasswordRuleResult {
  key: PasswordRuleKey;
  ok: boolean;
}

export interface PasswordVerdict {
  ok: boolean;
  /** How many of the rules passed — the strength meter's input. */
  score: number;
  rules: PasswordRuleResult[];
}

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
