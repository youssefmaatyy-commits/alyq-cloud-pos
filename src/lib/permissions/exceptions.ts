/**
 * Per-user permission exceptions — the two lists that sit on top of a role.
 *
 * A role describes a job. Now and then one person needs one act more than the
 * job (a senior cashier who may approve a refund without being a manager) or one
 * act less (a cashier who must not delete a customer). The alternative to
 * naming that on the person is cloning a whole role for a single seat, which
 * buries a personal decision inside a role list where nobody can later see that
 * it was personal — and multiplies roles until nobody knows which one is real.
 *
 * So the exception lives on the person:
 *
 *     final = (active custom role, else the shipped matrix for the role)
 *             + extra − denied,      deny winning
 *
 * The role keeps meaning what it always meant; the exception is additive and
 * visible next to the person it belongs to.
 *
 * The precedence below is implemented three times, deliberately, because each
 * layer has to hold on its own:
 *
 *   here               the session's resolved `AuthUser.capabilities`
 *   public.can()       migration 0028 — what every RLS policy and RPC consults
 *   assertCapability() the service layer, reading the resolved list above
 *
 * A forged UI therefore meets the same arithmetic in the database, and a
 * database that somehow disagrees still refuses the write. `exceptionDiff()`
 * exists so the change can be *shown* — an admin who cannot see what an
 * exception did is an admin who will leave one behind forever.
 */
import { CAPABILITIES, type Capability } from "./roles";

/** Two lists of capability ids. Both are usually empty; most people have none. */
export interface CapabilityExceptions {
  /** Granted on top of the role. */
  readonly extra: readonly Capability[];
  /** Withheld regardless of the role. Wins over `extra` and over the role. */
  readonly denied: readonly Capability[];
}

/** What everybody starts with, and what "no exceptions" means on screen. */
export const NO_EXCEPTIONS: CapabilityExceptions = { extra: [], denied: [] };

function isCapability(value: unknown): value is Capability {
  return typeof value === "string" && (CAPABILITIES as readonly string[]).includes(value);
}

/**
 * Distinct, known and alphabetically sorted — the one shape both stores persist,
 * so a demo directory and a Postgres column hold byte-identical lists and a
 * comparison between "what is stored" and "what was submitted" is meaningful.
 *
 * An unknown id is dropped rather than kept: a capability that no longer exists
 * must not linger in a person's record, silently doing nothing while looking
 * like a decision somebody made.
 */
function normalizeList(value: unknown): Capability[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter(isCapability))].sort();
}

/** Deny wins, and it wins in storage too: the two lists never overlap. */
function withDenyPriority(extra: Capability[], denied: Capability[]): CapabilityExceptions {
  return { extra: extra.filter((capability) => !denied.includes(capability)), denied };
}

/**
 * Read stored exceptions — a `profiles` row, a directory entry, or whatever a
 * previous version of this app wrote. Accepts both the column names and the
 * short ones, and never throws: a corrupt list means "no exceptions", which is
 * the safe reading (the role still applies, nothing extra is granted).
 */
export function parseCapabilityExceptions(input: unknown): CapabilityExceptions {
  if (!input || typeof input !== "object") return NO_EXCEPTIONS;
  const raw = input as {
    extra?: unknown;
    denied?: unknown;
    extra_capabilities?: unknown;
    denied_capabilities?: unknown;
  };
  const extra = normalizeList(raw.extra ?? raw.extra_capabilities);
  const denied = normalizeList(raw.denied ?? raw.denied_capabilities);
  if (extra.length === 0 && denied.length === 0) return NO_EXCEPTIONS;
  return withDenyPriority(extra, denied);
}

/** Normalise what an admin submits, before it is stored or compared. */
export function sanitizeCapabilityExceptions(
  input: { extra?: unknown; denied?: unknown } | null | undefined,
): CapabilityExceptions {
  if (!input) return NO_EXCEPTIONS;
  return withDenyPriority(normalizeList(input.extra), normalizeList(input.denied));
}

/**
 * Apply the two lists to an already-resolved base (a custom role's list, or the
 * shipped matrix). Returns the capabilities in declaration order, so a screen
 * listing them reads the same way the capability catalogue does.
 *
 * With nothing to apply it copies the base and changes nothing — the common case
 * for everybody whose permissions are simply their job.
 */
export function applyExceptions(
  base: readonly Capability[],
  exceptions: CapabilityExceptions | null | undefined,
): Capability[] {
  if (!exceptions || (exceptions.extra.length === 0 && exceptions.denied.length === 0)) {
    return [...base];
  }
  const denied = new Set(exceptions.denied);
  const held = new Set<Capability>();
  for (const capability of base) {
    if (!denied.has(capability)) held.add(capability);
  }
  for (const capability of exceptions.extra) {
    if (!denied.has(capability)) held.add(capability);
  }
  return CAPABILITIES.filter((capability) => held.has(capability));
}

/** True when this person's permissions differ from their role's. */
export function hasExceptions(exceptions: CapabilityExceptions | null | undefined): boolean {
  return !!exceptions && (exceptions.extra.length > 0 || exceptions.denied.length > 0);
}

/**
 * What the exceptions did, as two lists of capability ids — for the audit row,
 * for the user card and for the "this person can also / can no longer" summary
 * an admin reads before saving. Order-insensitive on both sides: a stored list
 * and a submitted list are the same decision however they are sorted.
 */
export function exceptionDiff(
  base: readonly Capability[],
  exceptions: CapabilityExceptions | null | undefined,
): { added: Capability[]; removed: Capability[] } {
  const final = applyExceptions(base, exceptions);
  const wasHeld = new Set(base);
  const isHeld = new Set(final);
  return {
    added: final.filter((capability) => !wasHeld.has(capability)),
    removed: CAPABILITIES.filter((capability) => wasHeld.has(capability) && !isHeld.has(capability)),
  };
}
