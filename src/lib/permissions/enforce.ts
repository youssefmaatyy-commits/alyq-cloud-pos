/**
 * Permission enforcement below the UI.
 *
 * The rule this file exists to make true: **hiding a button is not a security
 * control.** Every money-moving or identity-moving action in the app calls
 * `assertCapability()` from its *service* — the layer every caller passes
 * through, whether the caller is a screen, a provider, a keyboard shortcut or a
 * test — so a request that reaches the service without the capability is
 * refused there, with the same `AppError("FORBIDDEN")` the POS register has
 * always thrown.
 *
 * The client-side check is a convenience; the authoritative one is in the
 * database. `public.can(capability)` (migration 0011, extended by 0021) is what
 * every RLS policy and every admin RPC asks, and it resolves a caller's active
 * custom role first, exactly like `capabilitiesOfUser()` does here. The two
 * implementations are deliberately the same shape so a disagreement is a bug
 * rather than a design difference.
 */
import { getCurrentAuthUser } from "@/lib/auth/services/sessionStore";
import type { AuthUser } from "@/lib/auth/types";
import { AppError } from "@/modules/products/data/repository";
import { capabilityForPermission, type Permission } from "./catalog";
import { resolveCapabilities } from "./customRoles";
import { capabilitiesOf, hasCapability, type Capability } from "./roles";

/** Minimal identity shape accepted by pure permission checks. */
export interface PermissionSubject {
  role?: string | null;
  /** A resolved custom-role/default-role list; when present it wins over role. */
  capabilities?: readonly string[] | null;
}

/**
 * The capabilities that apply to one user.
 *
 * A resolved list on the user wins — that is where a custom role's overlay is
 * carried (see `AuthUser.capabilities`). Without one, the system matrix for the
 * user's role decides. A signed-out user has an empty role, which is not a
 * member of the model, so this returns `[]` and every check below denies.
 */
export function capabilitiesOfUser(user: PermissionSubject | null | undefined): Capability[] {
  if (!user) return [];
  if (Array.isArray(user.capabilities)) {
    // Already resolved at sign-in: filter rather than trust, so a stored
    // session cannot smuggle in a capability the model does not have.
    return resolveCapabilities(null, { capabilities: user.capabilities, active: true });
  }
  return capabilitiesOf(user.role);
}

/** May this user do this? The question every legacy gate asks. */
export function userCan(
  user: PermissionSubject | null | undefined,
  capability: Capability,
): boolean {
  if (!user) return false;
  if (Array.isArray(user.capabilities)) return capabilitiesOfUser(user).includes(capability);
  // Fall back to the plain matrix for a role string, which is what every
  // pre-Phase-10 call site passes.
  return hasCapability(user.role, capability);
}

/** The acting user, from the validated session (anonymous when signed out). */
export function actingUser(): AuthUser {
  return getCurrentAuthUser();
}

/** Service-layer form of `userCan` for the current session. */
export function canAct(capability: Capability): boolean {
  return userCan(actingUser(), capability);
}

/**
 * Reusable application permission check.
 *
 * With no subject it checks the validated current session:
 *
 *     can("pos.sell")
 *
 * A subject can be supplied by tests, previews and non-React application code.
 * It may carry a system role or an already-resolved capability list (the shape
 * used by demo users and active custom roles). Unknown permission strings never
 * fall back to a role or capability: they return false.
 */
export function can(
  permission: Permission | string,
  subject?: PermissionSubject | null,
): boolean {
  const capability = capabilityForPermission(permission);
  if (!capability) return false;
  return subject === undefined ? canAct(capability) : userCan(subject, capability);
}

/** Any capability in a list the acting user holds. */
export function canActAny(capabilities: readonly Capability[]): boolean {
  return capabilities.some((capability) => canAct(capability));
}

/**
 * Refuse the current action unless the acting user holds the capability.
 *
 * Throws the app-wide `AppError` with code `FORBIDDEN`, which is what the
 * register has always thrown and what every screen already knows how to render.
 * The message names the capability so a denial is diagnosable from a log line
 * without guessing which gate fired.
 */
export function assertCapability(capability: Capability, message?: string): void {
  if (canAct(capability)) return;
  throw new AppError(
    "FORBIDDEN",
    message ?? `You do not have permission to do this (${capability})`,
    capability,
  );
}

/**
 * Capability check that tolerates the legacy `user` argument.
 *
 * The module permission helpers (`canCompleteSale`, `canAdjustStock`, …) were
 * written when a role was the whole story, so they take a user object that
 * carries only `role`. The session now carries the *resolved* capability list —
 * custom role included — and it describes the same person, so the argument is
 * acknowledged and the session decides.
 *
 * Routing every one of those helpers through here is what makes a custom role
 * reach the whole app at once: without it, an "Accountant" role could be denied
 * the register in the database and still see an enabled Void button, because the
 * button asked the system matrix instead of the session.
 */
export function canActAs(user: unknown, capability: Capability): boolean {
  const identity = user as (Pick<AuthUser, "role" | "capabilities"> & { id?: string }) | null | undefined;
  if (!identity) return canAct(capability);

  // The object a module helper is handed describes the same person as the
  // session, but it predates custom roles: it carries `role` and not the resolved
  // capability list. When the ids match, the session is the better-informed
  // source, so it decides — that is what makes an "Accountant" overlay actually
  // remove the Void button instead of leaving it enabled.
  const session = actingUser();
  if (identity.id && session.id && identity.id === session.id) return canAct(capability);

  // Any other identity (a fixture, a row being reported on, a signed-out caller)
  // is answered from what it carries: its resolved list if it has one, otherwise
  // the system matrix for its role. Pure, and fail-closed for an empty role.
  return userCan(identity, capability);
}

/** `permissions.denied.apply_discount` — the copy a screen shows on a denial. */
export function deniedMessageKey(capability: Capability): string {
  return `permissions.denied.${capability}`;
}
