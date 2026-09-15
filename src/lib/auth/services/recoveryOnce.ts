/**
 * One-time-use marking for password-recovery material.
 *
 * A reset link must not be a door that stays open: the same `?code=` (or the
 * same token pair) consumed twice should fail the second time, and a logout →
 * back-button → re-submit dance must not re-create recovery authority from a
 * link that was already spent.
 *
 * In live mode the provider already enforces most of this — PKCE codes are
 * single-use server-side and refresh tokens rotate — but the client cannot
 * rely on every deployment having rotation tuned, and the implicit flow can
 * deliver a token pair that stays valid for a while. So this module keeps a
 * small, bounded record of what THIS browser has consumed:
 *
 *   - an in-memory set (covers the life of the page), mirrored into
 *   - `sessionStorage` (covers reloads inside the same tab; a brand-new tab
 *     starts empty and falls back to the provider's enforcement).
 *
 * Only a short, non-reversible fingerprint of the material is stored, never
 * the token itself.
 */

const STORAGE_KEY = "alyq.auth.recovery.used.v1";
/** The list stays tiny; older marks are dropped rather than grown. */
const MAX_MARKS = 16;

const memory = new Set<string>();

/** FNV-1a — enough to tell two recovery payloads apart, useless to reverse. */
function fingerprint(material: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < material.length; i += 1) {
    hash ^= material.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function storage(): Storage | null {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

function readPersisted(): string[] {
  const store = storage();
  if (!store) return [];
  try {
    const parsed = JSON.parse(store.getItem(STORAGE_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

function warm(): void {
  if (memory.size > 0) return;
  for (const mark of readPersisted()) memory.add(mark);
}

/** True when this browser has already consumed this exact material. */
export function recoveryMaterialConsumed(material: string): boolean {
  warm();
  return memory.has(fingerprint(material));
}

/** Record a successful consumption. Idempotent. */
export function markRecoveryMaterialConsumed(material: string): void {
  warm();
  const mark = fingerprint(material);
  memory.add(mark);
  const store = storage();
  if (!store) return;
  try {
    const next = [...readPersisted().filter((m) => m !== mark), mark].slice(-MAX_MARKS);
    store.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* a full or disabled store is not a reason to break the flow */
  }
}

/** Test helper only: forget everything this tab has consumed. */
export function resetRecoveryMarksForTests(): void {
  memory.clear();
  const store = storage();
  if (!store) return;
  try {
    store.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}
