/**
 * Demo user repository — the five accounts in `demoUsers.ts`, verified with
 * salted hashes in the browser (see `services/password.ts` for the caveats).
 *
 * This is the repository used whenever Supabase is not configured. It has the
 * same shape as the Supabase one, so switching providers changes nothing above
 * this line.
 */
import { DEMO_USERS, type AuthUserRecord } from "../demoUsers";
import { verifyPassword } from "../services/password";
import type { AuthenticateResult, UserRepository, AuthUserSummary } from "./repository";

function toSummary(record: AuthUserRecord): AuthUserSummary {
  return { id: record.id, username: record.username, name: record.name, role: record.role };
}

export class DemoUserRepository implements UserRepository {
  readonly kind = "demo" as const;

  async listUsers(): Promise<AuthUserSummary[]> {
    return DEMO_USERS.map(toSummary);
  }

  async authenticate(username: string, password: string): Promise<AuthenticateResult> {
    const handle = username.trim().toLowerCase();
    const record = DEMO_USERS.find((u) => u.username === handle);
    // Always run a verification, even for unknown users, so a missing account
    // and a wrong password take the same path and report the same error.
    const verifier = record?.verifier ?? DEMO_USERS[0].verifier;
    const valid = await verifyPassword(password, verifier);
    if (!record || !valid) return { ok: false, code: "invalid_credentials" };
    return {
      ok: true,
      user: {
        id: record.id,
        username: record.username,
        name: record.name,
        role: record.role,
        auth_id: record.auth_id ?? null,
      },
    };
  }

  async signOut(): Promise<void> {
    /* nothing to revoke for the local demo store */
  }
}

let singleton: DemoUserRepository | null = null;
export function getDemoUserRepository(): DemoUserRepository {
  if (!singleton) singleton = new DemoUserRepository();
  return singleton;
}
