const AUTHORIZATION = /^Bearer\s+(\S+)\s*$/i;

async function equalSecret(left: string, right: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(left)),
    crypto.subtle.digest("SHA-256", encoder.encode(right)),
  ]);
  const av = new Uint8Array(a);
  const bv = new Uint8Array(b);
  let mismatch = 0;
  for (let index = 0; index < av.length; index += 1) mismatch |= av[index] ^ bv[index];
  return mismatch === 0;
}

/**
 * Authenticate only with the dedicated dispatcher secret. The explicit
 * service-role comparison makes a misconfigured identical secret fail closed
 * and proves that the database credential is never valid invocation authority.
 */
export async function isDispatchAuthorized(
  authorization: string | null,
  dispatchSecret: string,
  serviceRoleKey: string,
): Promise<boolean> {
  const match = authorization ? AUTHORIZATION.exec(authorization) : null;
  if (!match) return false;
  const bearer = match[1];
  const [matchesDispatch, matchesServiceRole] = await Promise.all([
    equalSecret(bearer, dispatchSecret),
    equalSecret(bearer, serviceRoleKey),
  ]);
  return matchesDispatch && !matchesServiceRole;
}

export interface DispatchBatchLimits {
  limit: number;
  eventLimit: number;
}

/** Select only bounded queue controls. Every other caller field is ignored. */
export function selectDispatchBatchLimits(
  payload: Record<string, unknown>,
  maxClaim: number,
  maxEvents: number,
): DispatchBatchLimits {
  const requestedLimit = typeof payload.limit === "number" ? Math.trunc(payload.limit) : 50;
  const requestedEventLimit = typeof payload.event_limit === "number" ? Math.trunc(payload.event_limit) : 20;
  return {
    limit: Math.min(maxClaim, Math.max(1, requestedLimit)),
    eventLimit: Math.min(maxEvents, Math.max(1, requestedEventLimit)),
  };
}
