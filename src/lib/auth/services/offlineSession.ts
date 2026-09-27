/**
 * Safe offline register lease.
 *
 * This is deliberately NOT a provider session: it contains no access token,
 * refresh token, password, password hash, email or phone. It remembers only the
 * last server-verified identity metadata needed to run the till, and only the
 * `sell` capability. Sensitive routes remain closed even when the online user
 * was an administrator.
 */
import type { AuthSession, AuthUser, SessionPersistence } from "../types";
import type { Capability } from "@/lib/permissions/roles";
import { setCachedSession } from "./sessionStore";

export const OFFLINE_SESSION_STORAGE_KEY = "alyq.auth.offline-register.v1";
export const OFFLINE_SESSION_IDLE_MS = 8 * 60 * 60 * 1000;
export const OFFLINE_SESSION_REMEMBER_MS = 7 * 24 * 60 * 60 * 1000;

interface OfflineSessionSnapshot {
  version: 1;
  user: AuthUser;
  verified_at: string;
  expires_at: string;
  persistence: SessionPersistence;
}

interface MinimalStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function localStore(): MinimalStorage | null {
  try { return globalThis.localStorage ?? globalThis.window?.localStorage ?? null; }
  catch { return null; }
}

function sessionStore(): MinimalStorage | null {
  try { return globalThis.sessionStorage ?? globalThis.window?.sessionStorage ?? null; }
  catch { return null; }
}

function safeRegisterUser(user: AuthUser): AuthUser | null {
  if (!user.capabilities.includes("sell")) return null;
  return {
    id: user.id,
    username: user.username,
    name: user.name,
    role: user.role,
    active: true,
    capabilities: ["sell"] satisfies Capability[],
  };
}

export function writeOfflineSessionSnapshot(
  user: AuthUser,
  remember: boolean,
  now: Date = new Date(),
): OfflineSessionSnapshot | null {
  const safeUser = safeRegisterUser(user);
  if (!safeUser) {
    clearOfflineSessionSnapshot();
    return null;
  }
  const persistence: SessionPersistence = remember ? "local" : "session";
  const ttl = remember ? OFFLINE_SESSION_REMEMBER_MS : OFFLINE_SESSION_IDLE_MS;
  const snapshot: OfflineSessionSnapshot = {
    version: 1,
    user: safeUser,
    verified_at: now.toISOString(),
    expires_at: new Date(now.getTime() + ttl).toISOString(),
    persistence,
  };
  clearOfflineSessionSnapshot();
  try {
    (persistence === "local" ? localStore() : sessionStore())?.setItem(
      OFFLINE_SESSION_STORAGE_KEY,
      JSON.stringify(snapshot),
    );
  } catch {
    return null;
  }
  return snapshot;
}

export function readOfflineSessionSnapshot(now: Date = new Date()): OfflineSessionSnapshot | null {
  for (const store of [localStore(), sessionStore()]) {
    try {
      const raw = store?.getItem(OFFLINE_SESSION_STORAGE_KEY);
      if (!raw) continue;
      const value = JSON.parse(raw) as Partial<OfflineSessionSnapshot>;
      const expiry = new Date(value.expires_at ?? "").getTime();
      const user = value.user;
      if (
        value.version !== 1 ||
        !user?.id ||
        !user.username ||
        !user.name ||
        !Array.isArray(user.capabilities) ||
        user.capabilities.length !== 1 ||
        user.capabilities[0] !== "sell" ||
        !Number.isFinite(expiry) ||
        now.getTime() >= expiry
      ) {
        store?.removeItem(OFFLINE_SESSION_STORAGE_KEY);
        continue;
      }
      return value as OfflineSessionSnapshot;
    } catch {
      store?.removeItem(OFFLINE_SESSION_STORAGE_KEY);
    }
  }
  return null;
}

/** Restore only into memory; no synthetic/reusable credential is persisted. */
export function restoreOfflineSession(now: Date = new Date()): AuthSession | null {
  const snapshot = readOfflineSessionSnapshot(now);
  if (!snapshot) return null;
  const session: AuthSession = {
    token: "offline-register-lease-not-a-server-token",
    user: snapshot.user,
    issued_at: snapshot.verified_at,
    expires_at: snapshot.expires_at,
    remember: snapshot.persistence === "local",
  };
  setCachedSession(session);
  return session;
}

export function clearOfflineSessionSnapshot(): void {
  try { localStore()?.removeItem(OFFLINE_SESSION_STORAGE_KEY); } catch { /* no storage */ }
  try { sessionStore()?.removeItem(OFFLINE_SESSION_STORAGE_KEY); } catch { /* no storage */ }
}

/** Only the register and its pending-sale/history detail routes work on a lease. */
export function offlineSessionAllowsPath(pathname: string): boolean {
  const path = pathname.split("?")[0].replace(/\/+$/, "") || "/";
  return path === "/pos" || path.startsWith("/pos/sales");
}
