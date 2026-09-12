/**
 * One place that turns a stored identity record into the `AuthUser` the whole
 * application reasons about.
 *
 * Both repositories build their result here, so a demo sign-in and a Supabase
 * sign-in produce the same shape — including the resolved capability list, which
 * is what makes every permission check in the app synchronous.
 *
 * The rule encoded below: a custom role *replaces* the system matrix when it is
 * assigned and active. That mirrors `public.can()` in migration 0021, so the UI
 * hiding a button and the database refusing the write are the same decision made
 * twice, not two different decisions.
 */
import { normalizeRole, type AppRole, type Capability } from "@/lib/permissions/roles";
import { resolveCapabilities } from "@/lib/permissions/customRoles";
import type { AuthUser } from "../types";

export interface IdentityInput {
  id: string;
  username: string;
  name: string;
  email?: string | null;
  phone?: string | null;
  /** Raw role string from a profile row or the demo directory. */
  role: string | null | undefined;
  active?: boolean;
  custom_role_id?: string | null;
  /** The assigned custom role, when it could be read. */
  custom_role?: { name_en: string; name_ar: string; capabilities: readonly string[]; active: boolean } | null;
  last_login_at?: string | null;
  /** Supabase Auth uid; the demo directory stores its own ids. */
  auth_id?: string | null;
}

/**
 * An unmappable or absent role yields `null`, and a `null` role is what
 * `ANONYMOUS_USER` carries: every capability denied, fail closed. The caller
 * decides whether that means "refuse the sign-in" (it does, in both
 * repositories) or "render nothing".
 */
export function roleOf(input: IdentityInput): AppRole | null {
  return normalizeRole(input.role);
}

export function capabilitiesForIdentity(input: IdentityInput): Capability[] {
  const role = roleOf(input);
  const custom =
    input.custom_role && input.custom_role.active
      ? { capabilities: input.custom_role.capabilities, active: true }
      : null;
  return resolveCapabilities(role, custom);
}

export function buildAuthUser(input: IdentityInput): AuthUser {
  const role = roleOf(input);
  return {
    id: input.id,
    username: input.username.trim().toLowerCase(),
    name: input.name.trim() || input.username.trim(),
    // A missing role is not representable in the model, so it becomes the empty
    // string — the same value `ANONYMOUS_USER` carries, which no capability
    // check accepts.
    role: (role ?? "") as AppRole,
    auth_id: input.auth_id ?? null,
    email: input.email ?? null,
    phone: input.phone ?? null,
    active: input.active !== false,
    custom_role_id: input.custom_role_id ?? null,
    custom_role_name: input.custom_role ? input.custom_role.name_en : null,
    capabilities: capabilitiesForIdentity(input),
    last_login_at: input.last_login_at ?? null,
  };
}

/** The synthetic email a username maps to when Supabase is the identity provider. */
export function usernameToEmail(username: string, domain = "alyq.local"): string {
  const handle = username.trim();
  return handle.includes("@") ? handle.toLowerCase() : `${handle.toLowerCase()}@${domain}`;
}
