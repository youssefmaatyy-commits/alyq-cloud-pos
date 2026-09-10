/**
 * Password hashing for the demo credential store.
 *
 * Passwords are never stored or compared in clear text: each demo account
 * carries a per-user salt plus a digest, and verification re-hashes the
 * submitted password with the same salt.
 *
 * Two digests are stored per account because the environment decides which one
 * is computable: SHA-256 via Web Crypto where `crypto.subtle` exists (browsers
 * on secure origins, Node ≥ 18), and a documented weaker fallback for
 * non-secure origins. `verifyPassword` picks the one this runtime can produce,
 * so the demo login works everywhere.
 *
 * Scope note — this is browser-side verification for the *demo* store. It keeps
 * secrets out of comparisons, but a client can never be a trust boundary: the
 * Supabase path (`SupabaseUserRepository`) hands verification to the auth
 * server. That is why the repository takes the raw password and all hashing
 * stays behind this module.
 */

export interface PasswordVerifier {
  salt: string;
  /** `sha256("<salt>:<password>")`, hex. Used when Web Crypto is available. */
  sha256: string;
  /** Deterministic fallback digest, used only without `crypto.subtle`. */
  fallback: string;
}

export type HashStrategy = "sha256" | "fallback";

export function hashStrategy(): HashStrategy {
  return globalThis.crypto?.subtle ? "sha256" : "fallback";
}

/** Hex-encoded SHA-256 of `<salt>:<password>`. */
export async function sha256Digest(password: string, salt: string): Promise<string> {
  const bytes = new TextEncoder().encode(`${salt}:${password}`);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Deterministic fallback (FNV-1a seeded pair). Clearly weaker than SHA-256; it
 * exists so the demo login keeps working on non-secure origins and is never
 * the trust boundary.
 */
export function fallbackDigest(password: string, salt: string): string {
  const input = `${salt}:${password}`;
  let h1 = 0x811c9dc5;
  let h2 = 0x1000193;
  for (let i = 0; i < input.length; i += 1) {
    const c = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 + c, 0x85ebca6b) >>> 0;
  }
  return `${h1.toString(16).padStart(8, "0")}${h2.toString(16).padStart(8, "0")}`;
}

/** Verify a submitted password against a stored verifier, per this runtime's capability. */
export async function verifyPassword(password: string, verifier: PasswordVerifier): Promise<boolean> {
  if (hashStrategy() === "sha256") {
    return timingSafeEqual(await sha256Digest(password, verifier.salt), verifier.sha256);
  }
  return timingSafeEqual(fallbackDigest(password, verifier.salt), verifier.fallback);
}

/** Constant-time-ish comparison (cheap insurance; real verification is server-side in live mode). */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
