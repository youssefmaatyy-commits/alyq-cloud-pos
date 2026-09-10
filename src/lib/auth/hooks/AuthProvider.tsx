import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { AuthErrorCode, AuthSession, AuthUser, Credentials, SessionEndReason } from "../types";
import {
  restoreSession,
  signIn as signInRequest,
  signOut as signOutRequest,
  validateSession,
} from "../services/authService";
import { resetSessionCache } from "../services/sessionStore";
import { getAuthMode } from "../data";

export interface AuthContextValue {
  mode: "demo" | "supabase";
  /** The signed-in user, or null when there is no valid session. */
  user: AuthUser | null;
  session: AuthSession | null;
  /** `loading` while the persisted session is being restored on boot. */
  status: "loading" | "authenticated" | "anonymous";
  /** Why the last session ended (shown once on the login screen). */
  endReason: SessionEndReason;
  /** Last sign-in failure, for the login form. */
  error: AuthErrorCode | null;
  expiresAt: string | null;
  signIn: (credentials: Credentials) => Promise<boolean>;
  signOut: () => Promise<void>;
  clearError: () => void;
  /** Re-check expiry now (used by tests and by the route guard). */
  revalidate: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/** How often a live session is re-checked while the app is open. */
const HEARTBEAT_MS = 60_000;

/**
 * Owns the session for the whole app. Mounted above the router so the acting
 * user is available to every provider and screen.
 *
 * Expiry is enforced in three places, cheapest first: on boot, on navigation
 * (hash change), and on a heartbeat — so a session that lapses while a tab sits
 * open still ends instead of lingering until the next full reload.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<AuthSession | null>(null);
  const [status, setStatus] = useState<AuthContextValue["status"]>("loading");
  const [endReason, setEndReason] = useState<SessionEndReason>(null);
  const [error, setError] = useState<AuthErrorCode | null>(null);
  const booted = useRef(false);

  // Boot: restore a persisted session once.
  useEffect(() => {
    if (booted.current) return;
    booted.current = true;
    const { session: restored, reason } = restoreSession();
    setSession(restored);
    setEndReason(reason);
    setStatus(restored ? "authenticated" : "anonymous");
  }, []);

  const revalidate = useCallback(() => {
    const { session: next, reason, changed } = validateSession();
    if (!next) {
      if (changed) {
        setSession(null);
        setStatus("anonymous");
        setEndReason(reason);
      }
      return;
    }
    if (changed) setSession(next);
  }, []);

  // Navigation + tab focus + heartbeat.
  useEffect(() => {
    if (status !== "authenticated") return;
    const onNavigate = () => revalidate();
    const onVisible = () => {
      if (document.visibilityState !== "hidden") revalidate();
    };
    window.addEventListener("hashchange", onNavigate);
    window.addEventListener("popstate", onNavigate);
    document.addEventListener("visibilitychange", onVisible);
    const timer = window.setInterval(revalidate, HEARTBEAT_MS);
    return () => {
      window.removeEventListener("hashchange", onNavigate);
      window.removeEventListener("popstate", onNavigate);
      document.removeEventListener("visibilitychange", onVisible);
      window.clearInterval(timer);
    };
  }, [status, revalidate]);

  const signIn = useCallback(async (credentials: Credentials) => {
    setError(null);
    const outcome = await signInRequest(credentials);
    if (!outcome.ok || !outcome.session) {
      setError(outcome.code ?? "unknown");
      return false;
    }
    setSession(outcome.session);
    setEndReason(null);
    setStatus("authenticated");
    return true;
  }, []);

  const signOut = useCallback(async () => {
    await signOutRequest();
    setSession(null);
    setError(null);
    setEndReason("signed_out");
    setStatus("anonymous");
  }, []);

  const clearError = useCallback(() => setError(null), []);

  const value = useMemo<AuthContextValue>(
    () => ({
      mode: getAuthMode(),
      user: session?.user ?? null,
      session,
      status,
      endReason,
      error,
      expiresAt: session?.expires_at ?? null,
      signIn,
      signOut,
      clearError,
      revalidate,
    }),
    [session, status, endReason, error, signIn, signOut, clearError, revalidate],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}

/** Test/utility seam: forget the in-memory session cache (storage untouched). */
export { resetSessionCache };
