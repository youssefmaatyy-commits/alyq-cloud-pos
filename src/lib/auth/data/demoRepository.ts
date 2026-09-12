/**
 * Demo user repository — the offline directory.
 *
 * Used whenever Supabase is not configured. It has the same shape as the live
 * one, so switching providers changes nothing above this line, and it reads the
 * *same* store the Settings → Users screen writes (`staffDirectory.ts`): an
 * employee created offline can sign in offline, and one an admin deactivated
 * cannot. That single-directory rule is the whole reason the store lives in
 * `lib/auth/data` rather than inside the settings module.
 *
 * Scope note, unchanged from the authentication phase: a client is not a trust
 * boundary. Passwords are verified here against a salt and two digests, never in
 * clear text, but the offline directory exists to make the app usable and
 * testable without a server — not to be secure. Live mode hands verification,
 * sessions, refresh and recovery to Supabase Auth.
 */
import { normalizeRole } from "@/lib/permissions/roles";
import { activeCustomRole } from "@/lib/permissions/customRoleStore";
import { createVerifier, verifyPassword } from "../services/password";
import { buildAuthUser } from "../services/identity";
import { getCachedSession, readStoredSession } from "../services/sessionStore";
import {
  findStaffById,
  findStaffByUsername,
  readStaffDirectory,
  touchStaffLogin,
  upsertStaffEntry,
  type StaffDirectoryEntry,
} from "./staffDirectory";
import type {
  AuthChangeEvent,
  AuthenticateResult,
  AuthUserSummary,
  LiveSessionInfo,
  PasswordUpdateResult,
  RecoveryLinkParts,
  RecoveryLinkResult,
  UserRepository,
} from "./repository";
import type { AuthUser, PasswordResetOutcome } from "../types";

function toSummary(entry: StaffDirectoryEntry): AuthUserSummary {
  return {
    id: entry.id,
    username: entry.username,
    name: entry.name,
    role: normalizeRole(entry.role) ?? "viewer",
    email: entry.email,
    phone: entry.phone,
    active: entry.active,
    custom_role_id: entry.custom_role_id,
    created_at: entry.created_at,
    last_login_at: entry.last_login_at,
  };
}

/** The custom role an entry wears, if it is still assigned *and* active. */
function customRoleOf(entry: StaffDirectoryEntry) {
  const role = activeCustomRole(entry.custom_role_id);
  return role ? { name_en: role.name_en, name_ar: role.name_ar, capabilities: role.capabilities, active: true } : null;
}

export function staffEntryToAuthUser(entry: StaffDirectoryEntry): AuthUser {
  return buildAuthUser({
    id: entry.id,
    username: entry.username,
    name: entry.name,
    email: entry.email,
    phone: entry.phone,
    role: entry.role,
    active: entry.active,
    custom_role_id: entry.custom_role_id,
    custom_role: customRoleOf(entry),
    exceptions: { extra: entry.extra_capabilities, denied: entry.denied_capabilities },
    last_login_at: entry.last_login_at,
    auth_id: null,
  });
}

export class DemoUserRepository implements UserRepository {
  readonly kind = "demo" as const;

  async listUsers(): Promise<AuthUserSummary[]> {
    return readStaffDirectory().map(toSummary);
  }

  async authenticate(username: string, password: string): Promise<AuthenticateResult> {
    const entry = findStaffByUsername(username);
    // Always run a verification, even for an unknown account, so a missing user
    // and a wrong password take the same path and report the same error.
    const known = readStaffDirectory();
    const verifier = entry?.verifier ?? known[0]?.verifier ?? null;
    const valid = verifier ? await verifyPassword(password, verifier) : false;

    if (!entry || !valid) return { ok: false, code: "invalid_credentials" };
    // Deactivated by an admin: a real refusal, and a different message, because
    // the account exists and the password was right — telling the user to try
    // again would send them round in circles.
    if (!entry.active) return { ok: false, code: "user_inactive" };
    if (!entry.verifier) return { ok: false, code: "invalid_credentials" };

    const user = staffEntryToAuthUser(entry);
    if (!user.role) return { ok: false, code: "invalid_credentials" };

    touchStaffLogin(entry.id);
    return { ok: true, user: { ...user, last_login_at: new Date().toISOString() } };
  }

  async signOut(): Promise<void> {
    /* nothing to revoke: the offline directory holds no provider session */
  }

  async currentSession(): Promise<LiveSessionInfo | null> {
    const session = getCachedSession() ?? readStoredSession()?.session ?? null;
    if (!session) return null;
    return {
      token: session.token,
      issued_at: session.issued_at,
      expires_at: session.expires_at,
      refreshable: false,
      user: session.user,
    };
  }

  /** The offline session slides on activity; there is no provider to ask. */
  async refreshSession(): Promise<LiveSessionInfo | null> {
    return null;
  }

  /** No provider offline. Cross-tab sign-out is `services/authEvents.ts`. */
  onAuthChange(_listener: (event: AuthChangeEvent) => void): () => void {
    void _listener;
    return () => undefined;
  }

  async requestPasswordReset(identifier: string): Promise<PasswordResetOutcome> {
    const handle = identifier.trim();
    if (!handle) return { ok: false, code: "missing_identifier" };
    // There is no mail server offline. The answer is the same whether or not the
    // account exists, so the form cannot be used to enumerate the directory; the
    // screen explains what to do instead (ask an admin, who can reset it here).
    return { ok: true, channel: "demo" };
  }

  /**
   * Offline there is no email and therefore no link: the only recovery path is a
   * person who is already signed in changing their own password (or an admin
   * resetting it from Settings → Users). Anything else is reported as
   * unauthenticated rather than pretending a link was consumed.
   */
  async consumeRecoveryLink(_parts: RecoveryLinkParts): Promise<RecoveryLinkResult> {
    void _parts;
    const session = getCachedSession() ?? readStoredSession()?.session ?? null;
    return session ? { ok: true } : { ok: false, code: "not_authenticated" };
  }

  async updatePassword(newPassword: string): Promise<PasswordUpdateResult> {
    const session = getCachedSession() ?? readStoredSession()?.session ?? null;
    const userId = session?.user?.id ?? "";
    const entry = findStaffById(userId);
    if (!entry) return { ok: false, code: "not_authenticated" };
    if (newPassword.length < 8) return { ok: false, code: "weak_password" };

    upsertStaffEntry({
      ...entry,
      verifier: await createVerifier(newPassword),
      password_updated_at: new Date().toISOString(),
    });
    return { ok: true };
  }

  async touchLogin(userId: string): Promise<void> {
    touchStaffLogin(userId);
  }
}

let singleton: DemoUserRepository | null = null;
export function getDemoUserRepository(): DemoUserRepository {
  if (!singleton) singleton = new DemoUserRepository();
  return singleton;
}

/** Test seam. */
export function resetDemoUserRepository(): void {
  singleton = null;
}
