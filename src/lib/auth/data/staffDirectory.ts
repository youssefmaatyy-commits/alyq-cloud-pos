/**
 * Demo identity stores — where the offline directory and the offline custom
 * roles live.
 *
 * Two facts decide the shape of this file:
 *
 *   1. **Nothing here is a trust boundary.** Demo mode has no server, so the
 *      directory is a browser record whose only job is to make the app usable
 *      offline and to exercise the same code paths live mode uses. Passwords are
 *      stored as a salt + digest pair (`services/password.ts`), never in clear
 *      text, and live mode does not read this file at all — it asks Supabase Auth.
 *   2. **One store, two readers.** `DemoUserRepository` reads it to authenticate,
 *      and the Settings module reads and writes it to manage employees. Keeping
 *      the record in one place is what stops "the users screen shows five
 *      accounts but a sixth can sign in" — the classic split-directory bug.
 *
 * Live mode keeps the same *shape* in `public.profiles` (migration 0011, extended
 * by 0021 with email, phone, last_login_at and custom_role_id), so a screen or a
 * service written against `StaffDirectoryEntry` needs no changes when credentials
 * are configured.
 */
import { safeStorage } from "@/modules/products/data/demoSeed";
import { normalizeRole, type AppRole } from "@/lib/permissions/roles";
import { DEMO_USERS } from "../demoUsers";
import type { PasswordVerifier } from "../services/password";

export const STAFF_STORAGE_KEY = "alyq.identity.staff.v1";

/** One employee, as the offline directory holds them. */
export interface StaffDirectoryEntry {
  id: string;
  username: string;
  name: string;
  email: string | null;
  phone: string | null;
  /** System role: always one of the five, even when a custom role is worn. */
  role: AppRole;
  /** Admin-defined overlay (Phase 10), or null. */
  custom_role_id: string | null;
  active: boolean;
  created_at: string;
  last_login_at: string | null;
  password_updated_at: string | null;
  /**
   * Salt + digests. `null` for an entry created without a password (an invite
   * that has not been accepted yet), which then cannot sign in.
   */
  verifier: PasswordVerifier | null;
  /** True for the five shipped accounts: they can be edited but never deleted. */
  system: boolean;
}

/** A fixed creation date for the shipped accounts, so the list does not reshuffle. */
const SYSTEM_CREATED_AT = "2026-01-01T09:00:00.000Z";

function seedFromDemoUsers(): StaffDirectoryEntry[] {
  return DEMO_USERS.map((user) => ({
    id: user.id,
    username: user.username,
    name: user.name,
    // The same convention `SupabaseUserRepository` uses to turn a username into
    // an email, so a demo account and a live account look alike on screen.
    email: `${user.username}@alyq.local`,
    phone: null,
    role: user.role,
    custom_role_id: null,
    active: true,
    created_at: SYSTEM_CREATED_AT,
    last_login_at: null,
    password_updated_at: null,
    verifier: user.verifier,
    system: true,
  }));
}

function isEntry(value: unknown): value is StaffDirectoryEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<StaffDirectoryEntry>;
  return (
    typeof entry.id === "string" &&
    typeof entry.username === "string" &&
    typeof entry.name === "string" &&
    normalizeRole(entry.role) !== null
  );
}

/** Normalise one record, dropping anything that cannot be trusted. */
function normalizeEntry(entry: StaffDirectoryEntry): StaffDirectoryEntry {
  const role = normalizeRole(entry.role) ?? "viewer";
  return {
    id: entry.id,
    username: entry.username.trim().toLowerCase(),
    name: entry.name.trim(),
    email: typeof entry.email === "string" && entry.email.trim() ? entry.email.trim().toLowerCase() : null,
    phone: typeof entry.phone === "string" && entry.phone.trim() ? entry.phone.trim() : null,
    role,
    custom_role_id: typeof entry.custom_role_id === "string" && entry.custom_role_id ? entry.custom_role_id : null,
    active: entry.active !== false,
    created_at: typeof entry.created_at === "string" ? entry.created_at : SYSTEM_CREATED_AT,
    last_login_at: typeof entry.last_login_at === "string" ? entry.last_login_at : null,
    password_updated_at:
      typeof entry.password_updated_at === "string" ? entry.password_updated_at : null,
    verifier: entry.verifier && typeof entry.verifier === "object" ? entry.verifier : null,
    system: entry.system === true,
  };
}

/**
 * Read the directory, seeding it from the five shipped accounts the first time.
 * System accounts are always present and always in their shipped order, so a
 * cleared or corrupted store cannot lock an installation out of admin.
 */
export function readStaffDirectory(): StaffDirectoryEntry[] {
  const seeded = seedFromDemoUsers();
  const raw = safeStorage.get(STAFF_STORAGE_KEY);
  if (!raw) {
    writeStaffDirectory(seeded);
    return seeded;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    writeStaffDirectory(seeded);
    return seeded;
  }
  const stored = Array.isArray(parsed) ? parsed.filter(isEntry).map((e) => normalizeEntry(e as StaffDirectoryEntry)) : [];

  // Merge: a system account's editable fields come from storage (an admin may
  // have renamed or deactivated it), but it can never be dropped.
  const byId = new Map(stored.map((entry) => [entry.id, entry]));
  const merged: StaffDirectoryEntry[] = seeded.map((base) => {
    const existing = byId.get(base.id);
    byId.delete(base.id);
    return existing ? { ...existing, system: true, role: normalizeRole(existing.role) ?? base.role } : base;
  });
  // Anything else that was stored (employees an admin added) follows.
  for (const entry of byId.values()) merged.push(entry);

  const result = merged.map(normalizeEntry);
  writeStaffDirectory(result);
  return result;
}

export function writeStaffDirectory(entries: readonly StaffDirectoryEntry[]): void {
  safeStorage.set(STAFF_STORAGE_KEY, JSON.stringify(entries.map(normalizeEntry)));
}

/** Case- and whitespace-insensitive, the way the sign-in screen compares. */
export function findStaffByUsername(handle: string): StaffDirectoryEntry | null {
  const wanted = handle.trim().toLowerCase();
  if (!wanted) return null;
  return (
    readStaffDirectory().find((entry) => entry.username === wanted || (entry.email ?? "") === wanted) ?? null
  );
}

export function findStaffById(id: string): StaffDirectoryEntry | null {
  return readStaffDirectory().find((entry) => entry.id === id) ?? null;
}

/** Insert or replace one entry, keeping the shipped accounts first. */
export function upsertStaffEntry(entry: StaffDirectoryEntry): StaffDirectoryEntry[] {
  const entries = readStaffDirectory();
  const index = entries.findIndex((existing) => existing.id === entry.id);
  const next = normalizeEntry(entry);
  if (index >= 0) entries[index] = { ...entries[index], ...next, system: entries[index].system };
  else entries.push(next);
  writeStaffDirectory(entries);
  return readStaffDirectory();
}

/**
 * Delete an entry. Refuses the shipped accounts: a demo installation must always
 * be able to sign in as admin, and live mode has no delete at all (a profile is
 * deactivated instead).
 */
export function removeStaffEntry(id: string): { removed: boolean; entries: StaffDirectoryEntry[] } {
  const entries = readStaffDirectory();
  const target = entries.find((entry) => entry.id === id);
  if (!target || target.system) return { removed: false, entries };
  writeStaffDirectory(entries.filter((entry) => entry.id !== id));
  return { removed: true, entries: readStaffDirectory() };
}

/** Stamp a successful sign-in. */
export function touchStaffLogin(id: string, at: Date = new Date()): StaffDirectoryEntry | null {
  const entries = readStaffDirectory();
  const target = entries.find((entry) => entry.id === id);
  if (!target) return null;
  target.last_login_at = at.toISOString();
  writeStaffDirectory(entries);
  return { ...target };
}

/** Test seam: forget the stored directory (the next read re-seeds it). */
export function resetStaffDirectory(): void {
  safeStorage.set(STAFF_STORAGE_KEY, "");
}
