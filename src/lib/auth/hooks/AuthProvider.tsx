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
  checkLocalSessionHealth,
  forgetSession,
  isSessionExpired,
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
import {
  shouldRevalidateAfterWake,
  subscribeSessionWakeEvents,
} from "../services/sessionLifecycle";
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
  /**
   * Force the full, provider-asking revalidation now. Not called
   * automatically by anything in this provider (routing, focus and an
   * interval no longer trigger it) — kept as an explicit manual trigger.
   */
  revalidate: () => void;
  /** Re-resolve role/capabilities after a branch or membership change. */
  refreshIdentity: () => Promise<boolean>;
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

/**
 * How often the zero-network local safety check runs (`checkLocalSessionHealth`)
 * for a tab that stays open, focused and on one route — see that function's
 * own doc comment for why this is justified and why it is not a replacement
 * for the removed heartbeat.
 */
const LOCAL_SAFETY_CHECK_MS = 5 * 60 * 1000;

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
 * Expiry/identity are enforced by events, not polling:
 *   · on boot, by reading back the provider session;
 *   · in demo mode only, on navigation by a local expiry read; live route
 *     changes never interpret access-token age as session expiry;
 *   · on sign-in, sign-out and sign-out-everywhere;
 *   · by the provider's own `onAuthStateChange`, which is how a session
 *     revoked elsewhere (or an account deactivated by an admin) ends here
 *     without waiting for anything else to happen;
 *   · on reconnect and on foreground/resume through one shared Web, Desktop and
 *     Capacitor lifecycle adapter;
 *   · on an explicit `refreshIdentity()` call (a branch switch, for instance);
 *   · across the other tabs of this same browser (`services/authEvents`);
 *   · and, underneath all of that, a low-frequency, zero-network safety check
 *     (`checkLocalSessionHealth`) for a tab that sits open on one route and
 *     never backgrounds — see that function's doc comment.
 *
 * An `epoch` counter guards every one of the async paths above: each captures
 * the current epoch before awaiting the provider and discards its result if
 * the epoch has moved on by the time it resolves. Sign-out bumps the epoch
 * synchronously, before its own await, specifically so a slow-to-resolve
 * earlier refresh can never resurrect a session that has since been signed
 * out from under it.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<AuthSession | null>(null);
  const [status, setStatus] = useState<AuthContextValue["status"]>("loading");
  const [endReason, setEndReason] = useState<SessionEndReason>(null);
  const [error, setError] = useState<AuthErrorCode | null>(null);
  const [syncing, setSyncing] = useState(false);
  const explicitSignOutRef = useRef(false);
  // React StrictMode replays effects in development. Preserve the one boot read
  // so the first pass clearing an expired demo record cannot make the replay
  // overwrite its reason with a plain anonymous state.
  const bootRestoreRef = useRef<ReturnType<typeof restoreSession> | null>(null);
  /**
   * The subscription below is mounted once (re-subscribing would drop provider
   * events mid-flight), so it cannot close over `session` — it reads this ref
   * instead, to decide whether an event may adopt a provider session.
   */
  const sessionRef = useRef<AuthSession | null>(null);
  /**
   * Bumped by every state-changing operation before it awaits the provider.
   * An async result is applied only if the epoch it captured is still the
   * current one — otherwise a newer operation (most importantly, a sign-out)
   * has already superseded it, and an outdated answer must not overwrite
   * newer state.
   */
  const epochRef = useRef(0);
  const bumpEpoch = useCallback(() => {
    epochRef.current += 1;
    return epochRef.current;
  }, []);

  // ── boot ────────────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    bootRestoreRef.current ??= restoreSession();
    const { session: restored, reason } = bootRestoreRef.current;

    if (getAuthMode() !== "supabase") {
      setSession(restored);
      setEndReason(reason);
      setStatus(restored ? "authenticated" : "anonymous");
      return;
    }

    // Recovery material belongs to the reset page, not generic session boot.
    // Preserve an existing identity if there is one, otherwise stay anonymous;
    // never sign the provider out while it is exchanging the recovery grant.
    if (!shouldAdoptFoundProviderSession(carriesRecoveryMaterial())) {
      setSession(restored);
      setEndReason(null);
      setStatus(restored ? "authenticated" : "anonymous");
      return;
    }

    // Keep protected routes behind BootScreen until the provider restore has an
    // answer. This prevents a login-screen flash on Web refresh, Electron start
    // and Capacitor cold start.
    const bootEpoch = bumpEpoch();
    setSession(null);
    setStatus("loading");
    setEndReason(null);
    setSyncing(true);
    void (async () => {
      try {
        if (restored) {
          // `revalidateSession` refreshes when the access token is stale and
          // preserves the cached identity when the failure is only transport.
          const result = await revalidateSession();
          if (cancelled || epochRef.current !== bootEpoch) return;
          if (!result.session) {
            forgetSession();
            setSession(null);
            setStatus("anonymous");
            setEndReason(result.reason ?? "expired");
            return;
          }
          setSession(result.session);
          setStatus("authenticated");
          setEndReason(null);
          return;
        }

        // Supabase may hold a perfectly valid provider session even when the
        // old app-side record is absent (the former remember-me-off case).
        const live = await getUserRepository().currentSession();
        if (cancelled || epochRef.current !== bootEpoch) return;
        if (!live?.user) {
          forgetSession();
          setSession(null);
          setStatus("anonymous");
          setEndReason(null);
          return;
        }
        const adopted = adoptProviderSession(live);
        if (!adopted) return;
        setSession(adopted);
        setStatus("authenticated");
        setEndReason(null);
      } catch {
        if (cancelled || epochRef.current !== bootEpoch) return;
        // With no cached identity it is unsafe to invent one offline. With a
        // cached identity `revalidateSession` already retained it above.
        setSession(restored);
        setStatus(restored ? "authenticated" : "anonymous");
        setEndReason(null);
      } finally {
        if (!cancelled) setSyncing(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [bumpEpoch]);

  /**
   * Manual, full (provider-asking) revalidation. Not wired to any automatic
   * trigger any more — kept as an explicit context method for tests and any
   * future caller that genuinely needs to force the authoritative check.
   */
  const revalidate = useCallback(() => {
    const myEpoch = bumpEpoch();
    if (getAuthMode() === "supabase") {
      void (async () => {
        const { session: next, reason, changed } = await revalidateSession();
        if (epochRef.current !== myEpoch) return;
        if (!next) {
          if (changed) {
            setSession(null);
            setStatus("anonymous");
            setEndReason(reason ?? "expired");
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
  }, [bumpEpoch]);

  // ── navigation: demo-only local expiry ──────────────────────────────────
  // A live access-token timestamp is not a session lifetime and can never turn
  // route navigation into logout. Supabase refreshes it through its SDK and the
  // lifecycle recovery path. Demo mode has no refresh token, so its local
  // sliding expiry remains authoritative.
  useEffect(() => {
    if (status !== "authenticated" || getAuthMode() === "supabase") return;
    const onNavigate = () => {
      const current = sessionRef.current;
      if (!current || !isSessionExpired(current)) return;
      forgetSession();
      setSession(null);
      setStatus("anonymous");
      setEndReason("expired");
    };
    window.addEventListener("hashchange", onNavigate);
    window.addEventListener("popstate", onNavigate);
    return () => {
      window.removeEventListener("hashchange", onNavigate);
      window.removeEventListener("popstate", onNavigate);
    };
  }, [status]);

  // ── reconnect / Web+Desktop focus / native foreground ──────────────────
  useEffect(() => {
    if (status !== "authenticated" || getAuthMode() !== "supabase") return;
    return subscribeSessionWakeEvents((wake) => {
      const current = sessionRef.current;
      if (!current || !shouldRevalidateAfterWake(wake, current.expires_at)) return;
      const myEpoch = bumpEpoch();
      void (async () => {
        const { session: next, reason, changed } = await revalidateSession();
        if (epochRef.current !== myEpoch) return;
        if (!next) {
          if (changed) {
            setSession(null);
            setStatus("anonymous");
            setEndReason(reason ?? "expired");
          }
          return;
        }
        if (changed) setSession(next);
      })();
    });
  }, [status, bumpEpoch]);

  // ── local safety net: zero-network, long interval ────────────────────────
  // Demo mode enforces its local sliding expiry. Live mode is deliberately a
  // no-op here: access-token age is never a local logout verdict, and provider
  // refresh remains event/SDK-driven rather than an infinite polling loop.
  useEffect(() => {
    if (status !== "authenticated") return;
    const timer = window.setInterval(() => {
      const myEpoch = bumpEpoch();
      void (async () => {
        const { session: next, reason, changed } = await checkLocalSessionHealth();
        if (epochRef.current !== myEpoch) return;
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
    }, LOCAL_SAFETY_CHECK_MS);
    return () => window.clearInterval(timer);
  }, [status, bumpEpoch]);

  // ── provider events (live) + other tabs (both modes) ────────────────────
  useEffect(() => {
    sessionRef.current = session;
  }, [session]);

  useEffect(() => {
    const unsubscribeProvider =
      getAuthMode() === "supabase"
        ? getUserRepository().onAuthChange((event) => {
            if (event.type === "signed_out") {
              bumpEpoch();
              forgetSession();
              setSession(null);
              setStatus("anonymous");
              setEndReason(explicitSignOutRef.current ? "signed_out" : "expired");
              return;
            }
            // Boot owns discovery of a provider-only persisted session. Later
            // provider events may update only an app session already held, so a
            // stale event cannot resurrect explicit logout or hijack recovery.
            if (!sessionRef.current) return;
            const myEpoch = bumpEpoch();
            void (async () => {
              try {
                const current = await getUserRepository().currentSession();
                if (epochRef.current !== myEpoch || !current?.user) return;
                const adopted = adoptProviderSession(current);
                if (!adopted) return;
                setSession(adopted);
                setStatus("authenticated");
                setEndReason(null);
              } catch {
                // TOKEN_REFRESHED/profile sync transport failure is not logout.
              }
            })();
          })
        : () => undefined;

    const unsubscribeTabs = subscribeAuthEvents((event) => {
      if (event.kind === "signed_out") {
        // Another tab ended the session. Drop this one's record and re-read
        // storage rather than trusting the message's contents.
        bumpEpoch();
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
        const myEpoch = bumpEpoch();
        void (async () => {
          const { session: next, changed, signedOut } = await resyncCurrentIdentity();
          if (epochRef.current !== myEpoch) return;
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
    // through the ref and the subscription is mounted once. `bumpEpoch` is a
    // stable callback, so listing it satisfies the hook contract without
    // resubscribing on session changes.
  }, [bumpEpoch]);

  // ── actions ─────────────────────────────────────────────────────────────
  const signIn = useCallback(async (credentials: Credentials) => {
    // A sign-in is a deliberate new identity: bump first, synchronously, so
    // nothing already in flight (a resume refresh from the login screen's
    // previous session, say) can land its answer on top of this one.
    bumpEpoch();
    explicitSignOutRef.current = false;
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
  }, [bumpEpoch]);

  const signOut = useCallback(async () => {
    // Bumped synchronously, before the await: a stale earlier refresh (resume,
    // a provider event, a cross-tab sync) that is still in flight must never
    // be able to resurrect this session after sign-out has started.
    bumpEpoch();
    explicitSignOutRef.current = true;
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
  }, [session, bumpEpoch]);

  const signOutEverywhere = useCallback(async () => {
    bumpEpoch();
    explicitSignOutRef.current = true;
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
  }, [session, bumpEpoch]);

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

  const refreshIdentity = useCallback(async () => {
    const myEpoch = bumpEpoch();
    const { session: next, signedOut } = await resyncCurrentIdentity();
    if (epochRef.current !== myEpoch) {
      // Superseded by a newer operation (sign-in, sign-out, a newer refresh)
      // whose own result is authoritative: answer from the current state, not
      // from this call's now-stale one, so the caller (e.g. a branch switch)
      // is not told "session ended" when it did not.
      return sessionRef.current !== null;
    }
    if (signedOut || !next) {
      setSession(null);
      setStatus("anonymous");
      setEndReason("signed_out");
      return false;
    }
    // Set even when the serialized identity compares equal: a branch switch is
    // also a deliberate boundary for every branch-scoped data provider.
    setSession(next);
    return true;
  }, [bumpEpoch]);

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
      refreshIdentity,
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
      refreshIdentity,
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
