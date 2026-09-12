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
import { resolveCapabilities } from "./customRoles";
import { capabilitiesOf, hasCapability, type Capability } from "./roles";

/**
 * The capabilities that apply to one user.
 *
 * A resolved list on the user wins — that is where a custom role's overlay is
 * carried (see `AuthUser.capabilities`). Without one, the system matrix for the
 * user's role decides. A signed-out user has an empty role, which is not a
 * member of the model, so this returns `[]` and every check below denies.
 */
export function capabilitiesOfUser(user: Pick<AuthUser, "role" | "capabilities"> | null | undefined): Capability[] {
  if (!user) return [];
  if (Array.isArray(user.capabilities)) {
    // Already resolved at sign-in: filter rather than trust, so a stored
    // session cannot smuggle in a capability the model does not have.
    return resolveCapabilities(null, { capabilities: user.capabilities, active: true });
  }
  return capabilitiesOf(user.role);
}

/** May this user do this? The question every gate and every hidden button asks. */
export function userCan(
  user: Pick<AuthUser, "role" | "capabilities"> | null | undefined,
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

/** What the acting user may do right now. */
export function actingCapabilities(): Capability[] {
  return capabilitiesOfUser(actingUser());
}

/** Service-layer form of `userCan` for the current session. */
export function canAct(capability: Capability): boolean {
  return userCan(actingUser(), capability);
}

/** Every capability in a list the acting user holds. */
export function canActAll(capabilities: readonly Capability[]): boolean {
  return capabilities.every((capability) => canAct(capability));
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

/** Refuse unless the acting user holds *every* capability listed. */
export function assertAllCapabilities(capabilities: readonly Capability[], message?: string): void {
  for (const capability of capabilities) assertCapability(capability, message);
}

/** Refuse unless the acting user holds *at least one* of the capabilities. */
export function assertAnyCapability(capabilities: readonly Capability[], message?: string): void {
  if (canActAny(capabilities)) return;
  throw new AppError(
    "FORBIDDEN",
    message ?? `You do not have permission to do this (${capabilities.join(" or ")})`,
    capabilities[0],
  );
}

/** `permissions.denied.apply_discount` — the copy a screen shows on a denial. */
export function deniedMessageKey(capability: Capability): string {
  return `permissions.denied.${capability}`;
}
