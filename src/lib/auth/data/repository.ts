/**
 * User repository contract.
 *
 * The login screen and the auth service only ever talk to this interface, which
 * is what keeps the demo credential store swappable for Supabase Auth:
 *
 *   demo : `DemoUserRepository`        — salted hashes in `demoUsers.ts`
 *   live : `SupabaseUserRepository`    — `auth.signInWithPassword()` + `profiles`
 *
 * `authenticate()` deliberately takes the raw password and returns an
 * `AuthResult` — no caller ever sees a hash, and in live mode no password
 * verification happens in the browser at all.
 */
import type { AuthUser, AuthErrorCode } from "../types";

export interface AuthUserSummary {
  id: string;
  username: string;
  name: string;
  role: AuthUser["role"];
}

export type AuthenticateResult =
  | { ok: true; user: AuthUser }
  | { ok: false; code: AuthErrorCode };

export interface UserRepository {
  readonly kind: "demo" | "supabase";
  /** Users available to sign in (future: the user-management screen). */
  listUsers(): Promise<AuthUserSummary[]>;
  /** Verify credentials. Never throws for bad credentials — returns a code. */
  authenticate(username: string, password: string): Promise<AuthenticateResult>;
  /**
   * Live mode only: end the provider-side session. The demo repository has
   * nothing to revoke, so it resolves immediately.
   */
  signOut(): Promise<void>;
}
