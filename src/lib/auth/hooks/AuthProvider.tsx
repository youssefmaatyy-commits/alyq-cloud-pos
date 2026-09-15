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
import type {
  AuthErrorCode,
  AuthSession,
  AuthUser,
  Credentials,
  PasswordResetOutcome,
  SessionEndReason,
} from "../types";
import type { PasswordUpdateResult } from "../data/repository";
import { stopRealtime } from "@/lib/supabase/realtime";
import {
  adoptProviderSession,
  forgetSession,
  revalidateSession,
  resyncCurrentIdentity,
  restoreSession,
  signIn as signInRequest,
  signOut as signOutRequest,
  validateSession,
  requestPasswordReset as requestResetRequest,
  updatePassword as updatePasswordRequest,
  changePassword as changePasswordRequest,
  shouldAdoptFoundProviderSession,
} from "../services/authService";
import { carriesRecoveryMaterial } from "../services/recoveryUrl";
import { resetSessionCache } from "../services/sessionStore";
import { subscribeAuthEvents } from "../services/authEvents";
import { getAuthMode, getUserRepository } from "../data";
import { recordAudit } from "@/modules/audit/services/auditService";

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
  /** Revoke every session the provider holds for this user, not just this tab. */
  signOutEverywhere: () => Promise<void>;
  clearError: () => void;
  /** Re-check expiry now (used by tests and by the route guard). */
  revalidate: () => void;
  /** Self-service password recovery. `redirectTo` is where the link lands. */
  requestPasswordReset: (identifier: string, redirectTo?: string) => Promise<PasswordResetOutcome>;
  /** Set a new password on the current (or recovering) session. */
  updatePassword: (password: string) => Promise<PasswordUpdateResult>;
  /**
   * Signed-in self-service password change: the CURRENT password must be
   * re-proven first, so a borrowed screen is not a password-change button.
   */
  changePassword: (current: string, next: string) => Promise<PasswordUpdateResult>;
  /** True while a provider session is being read back on boot. */
  syncing: boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/** How often a live session is re-checked while the app is open. */
const HEARTBEAT_MS = 60_000;

/** Audit a session event. Never allowed to break the flow it describes. */
function auditSession(
  action: "session.login" | "session.logout" | "session.login_failed" | "session.refreshed",
  user: { id: string; name: string; username?: string } | null,
  detail: Record<string, string | number | boolean | null> = {},
): void {
  void recordAudit({
    action,
    entity: "session",
    entity_id: user?.id ?? "",
    entity_label: user?.name || user?.username || "—",
    details: detail,
    user_id: user?.id ?? "",
    user_name: user?.name ?? "",
  });
}

/**
 * Owns the session for the whole app. Mounted above the router so the acting
 * user is available to every provider and screen.
 *
 * Expiry is enforced in four places, cheapest first: on boot, on navigation
 * (hash change), on a heartbeat, and — in live mode — by the provider's own
 * `onAuthStateChange`, which is how a session revoked elsewhere (or an account
 * deactivated by an admin) ends here within seconds instead of at the next
 * reload. A third channel covers the other tabs of this same browser
 * (`services/authEvents`).
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<AuthSession | null>(null);
  const [status, setStatus] = useState<AuthContextValue["status"]>("loading");
  const [endReason, setEndReason] = useState<SessionEndReason>(null);
  const [error, setError] = useState<AuthErrorCode | null>(null);
  const [syncing, setSyncing] = useState(false);
  const booted = useRef(false);
  /**
   * The subscription below is mounted once (re-subscribing would drop provider
   * events mid-flight), so it cannot close over `session` — it reads this ref
   * instead, to decide whether an event may adopt a provider session.
   */
  const sessionRef = useRef<AuthSession | null>(null);

  // ── boot ────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (booted.current) return;
    booted.current = true;

    // Offline model first: it is synchronous, so the app renders immediately
    // with whatever was persisted rather than showing a spinner on every reload.
    const { session: restored, reason } = restoreSession();
    setSession(restored);
    setEndReason(reason);
    setStatus(restored ? "authenticated" : "anonymous");

    if (getAuthMode() !== "supabase") return;

    // Live mode: the provider is the authority, so ask it and adopt what it
    // says — including "nothing", which clears a record the browser outlived.
    //
    // Adoption is app-record-authoritative. Because the Supabase client is
    // configured with `persistSession: true`, a provider session can spring
    // into existence for someone who signed in with remember-me OFF and merely
    // closed the tab — and "remember me: off" is a promise, so a provider
    // session with no app record behind it is ended here rather than believed.
    // The one exception is a URL that carries recovery material: the sign-out
    // must not race the reset page that's about to consume that exact link.
    let cancelled = false;
    setSyncing(true);
    void (async () => {
      try {
        const live = await getUserRepository().currentSession();
        if (cancelled) return;
        if (!live || !live.user) {
          forgetSession();
          setSession(null);
          setStatus("anonymous");
          return;
        }
        if (!shouldAdoptFoundProviderSession(restored !== null)) {
          if (carriesRecoveryMaterial()) return; // leave the link for the reset page
          await getUserRepository().signOut().catch(() => undefined);
          forgetSession();
          setSession(null);
          setStatus("anonymous");
          return;
        }
        const adopted = adoptProviderSession(live, restored?.remember ?? false);
        if (!adopted) return;
        setSession(adopted);
        setStatus("authenticated");
        setEndReason(null);
      } catch {
        /* a provider failure on boot keeps the persisted session; the heartbeat retries */
      } finally {
        if (!cancelled) setSyncing(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const revalidate = useCallback(() => {
    if (getAuthMode() === "supabase") {
      // The provider answer is async; the sync check still runs first so an
      // obviously-dead record is dropped without waiting for a round trip.
      const immediate = validateSession();
      if (!immediate.session && immediate.changed) {
        setSession(null);
        setStatus("anonymous");
        setEndReason(immediate.reason);
        return;
      }
      void (async () => {
        const { session: next, reason, changed } = await revalidateSession();
        if (!next) {
          if (changed) {
            setSession(null);
            setStatus("anonymous");
            setEndReason(reason);
          }
          return;
        }
        if (changed) setSession(next);
      })();
      return;
    }

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
    // Identity is re-resolved on focus as well as expiry: coming back to a tab
    // left open overnight is exactly when a role change should apply.
    const resync = () => {
      if (document.visibilityState === "hidden") return;
      void (async () => {
        const { session: next, changed, signedOut } = await resyncCurrentIdentity();
        if (signedOut || !next) {
          setSession(null);
          setStatus("anonymous");
          setEndReason("signed_out");
          return;
        }
        if (changed) setSession(next);
      })();
    };
    window.addEventListener("focus", resync);
    return () => {
      window.removeEventListener("hashchange", onNavigate);
      window.removeEventListener("popstate", onNavigate);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", resync);
      window.clearInterval(timer);
    };
  }, [status, revalidate]);

  // ── provider events (live) + other tabs (both modes) ────────────────────
  useEffect(() => {
    sessionRef.current = session;
  }, [session]);

  useEffect(() => {
    const unsubscribeProvider =
      getAuthMode() === "supabase"
        ? getUserRepository().onAuthChange((event) => {
            if (event.type === "signed_out") {
              forgetSession();
              setSession(null);
              setStatus("anonymous");
              setEndReason("signed_out");
              return;
            }
            // A provider event (SIGNED_IN, TOKEN_REFRESHED, USER_UPDATED) is
            // corroboration, not authority by itself: without a session the
            // app already holds, it must not create one. Conjuring a session
            // here is precisely how remember-me-off logins would come back
            // after reload, and how a recovery link's implicit SIGNED_IN would
            // leak into the app without the reset page asking for it.
            if (!shouldAdoptFoundProviderSession(sessionRef.current !== null)) return;
            const live = {
              token: "",
              issued_at: new Date().toISOString(),
              expires_at: new Date(Date.now() + HEARTBEAT_MS).toISOString(),
              refreshable: true,
              user: event.user,
            };
            // Read the real session back rather than trusting a synthesised
            // expiry; if that fails, keep the user we were just handed.
            void (async () => {
              const current = await getUserRepository().currentSession().catch(() => null);
              const adopted = adoptProviderSession(current ?? live, sessionRef.current?.remember ?? false);
              if (!adopted) return;
              setSession(adopted);
              setStatus("authenticated");
              setEndReason(null);
            })();
          })
        : () => undefined;

    const unsubscribeTabs = subscribeAuthEvents((event) => {
      if (event.kind === "signed_out") {
        // Another tab ended the session. Drop this one's record and re-read
        // storage rather than trusting the message's contents.
        resetSessionCache();
        const { session: current } = restoreSession();
        if (!current) {
          setSession(null);
          setStatus("anonymous");
          setEndReason("signed_out");
        }
        return;
      }

      if (event.kind === "session_changed") {
        // Somebody's authority changed — an admin edited a role, deactivated an
        // account, or reset a password in another tab. Re-resolve this session's
        // identity from the source of truth instead of keeping a stale capability
        // list, and end the session if the account no longer may use it.
        void (async () => {
          const { session: next, changed, signedOut } = await resyncCurrentIdentity();
          if (signedOut || !next) {
            setSession(null);
            setStatus("anonymous");
            setEndReason("signed_out");
            return;
          }
          if (changed) setSession(next);
        })();
      }
    });

    return () => {
      unsubscribeProvider();
      unsubscribeTabs();
    };
    // `sessionRef` is read inside the callbacks; re-subscribing on every
    // session change would drop provider events mid-flight, so the read goes
    // through the ref and the subscription is mounted once. An empty
    // dependency array is intentional here.
  }, []);

  // ── actions ─────────────────────────────────────────────────────────────
  const signIn = useCallback(async (credentials: Credentials) => {
    setError(null);
    const outcome = await signInRequest(credentials);
    if (!outcome.ok || !outcome.session) {
      setError(outcome.code ?? "unknown");
      auditSession("session.login_failed", null, {
        username: credentials.username.trim(),
        reason: outcome.code ?? "unknown",
      });
      return false;
    }
    setSession(outcome.session);
    setEndReason(null);
    setStatus("authenticated");
    auditSession("session.login", outcome.session.user, {
      username: outcome.session.user.username,
      role: outcome.session.user.role,
      custom_role_id: outcome.session.user.custom_role_id ?? null,
      remember: outcome.session.remember,
    });
    return true;
  }, []);

  const signOut = useCallback(async () => {
    const actor = session?.user ?? null;
    await signOutRequest();
    // Providers unmounting drops their own subscriptions; this makes sure no
    // socket outlives the session it was opened for.
    stopRealtime();
    setSession(null);
    setError(null);
    setEndReason("signed_out");
    setStatus("anonymous");
    auditSession("session.logout", actor, { username: actor?.username ?? null });
  }, [session]);

  const signOutEverywhere = useCallback(async () => {
    const actor = session?.user ?? null;
    await signOutRequest({ everywhere: true });
    stopRealtime();
    setSession(null);
    setError(null);
    setEndReason("signed_out");
    setStatus("anonymous");
    auditSession("session.logout", actor, {
      username: actor?.username ?? null,
      everywhere: true,
    });
  }, [session]);

  const requestPasswordReset = useCallback(async (identifier: string, redirectTo?: string) => {
    const outcome = await requestResetRequest(identifier, redirectTo);
    if (outcome.ok) {
      void recordAudit({
        action: "user.password_reset_requested",
        entity: "user",
        entity_id: session?.user?.id ?? "",
        entity_label: identifier.trim(),
        details: { channel: outcome.channel },
        user_id: session?.user?.id ?? "",
        user_name: session?.user?.name ?? "",
      });
    }
    return outcome;
  }, [session]);

  // Auditing for both password flows happens once, in `authService`
  // (`user.password_changed` with a `via` detail), not here: the screen
  // reports, the service records.
  const updatePassword = useCallback(async (password: string) => {
    return updatePasswordRequest(password);
  }, []);

  const changePassword = useCallback(async (current: string, next: string) => {
    return changePasswordRequest(current, next);
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
      signOutEverywhere,
      clearError,
      revalidate,
      requestPasswordReset,
      updatePassword,
      changePassword,
      syncing,
    }),
    [
      session,
      status,
      endReason,
      error,
      syncing,
      signIn,
      signOut,
      signOutEverywhere,
      clearError,
      revalidate,
      requestPasswordReset,
      updatePassword,
      changePassword,
    ],
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
