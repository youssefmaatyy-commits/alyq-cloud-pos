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
 * Placeholder expiry for the synthetic session object built from a bare
 * provider event, before the real session is read back — never a polling
 * interval. See `onAuthChange` below.
 */
const PROVIDER_EVENT_PLACEHOLDER_MS = 60_000;

/**
 * How long a tab must have been backgrounded (hidden, or the window
 * unfocused) before coming back counts as "resuming" rather than a brief
 * alt-tab — the dedup window for the merged focus/visibility refresh.
 */
const RESUME_MIN_BACKGROUND_MS = 60_000;

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
 *   · on navigation, by a local, non-mutating expiry read only — no provider
 *     call, because a route change is not an authority change;
 *   · on sign-in, sign-out and sign-out-everywhere;
 *   · by the provider's own `onAuthStateChange`, which is how a session
 *     revoked elsewhere (or an account deactivated by an admin) ends here
 *     without waiting for anything else to happen;
 *   · on resuming the tab after a meaningful time backgrounded (one merged
 *     focus/visibility path — see the resume effect below);
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
  const booted = useRef(false);
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
    const bootEpoch = bumpEpoch();
    setSyncing(true);
    void (async () => {
      try {
        const live = await getUserRepository().currentSession();
        if (cancelled || epochRef.current !== bootEpoch) return;
        if (!live || !live.user) {
          forgetSession();
          setSession(null);
          setStatus("anonymous");
          return;
        }
        if (!shouldAdoptFoundProviderSession(restored !== null)) {
          if (carriesRecoveryMaterial()) return; // leave the link for the reset page
          await getUserRepository().signOut().catch(() => undefined);
          if (cancelled || epochRef.current !== bootEpoch) return;
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
        /* a provider failure on boot keeps the persisted session; the next
           authority check (sign-in/out, a provider event, or resuming the
           tab) retries */
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

  // ── navigation: a local, non-mutating expiry read only ───────────────────
  // Routing is not an authority-change event, so this never asks the
  // provider and never touches the sliding-expiry model (which would wrongly
  // stretch a live session's provider-set expiry). It exists only so a
  // session whose clock has *already* run out ends at the next click rather
  // than surviving — silently "authenticated" — until the next resume or
  // safety check.
  useEffect(() => {
    if (status !== "authenticated") return;
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

  // ── resume: ONE merged focus/visibility refresh, deduped by a sentinel ───
  // `backgroundedAt` is set (without overwriting an earlier value) whenever
  // the tab is hidden or the window loses focus, and consumed by whichever of
  // "visible" or "focus" fires first on the way back — so a tab switch (which
  // fires both) refreshes once, not twice, and a window losing OS focus
  // without a tab change (which fires only focus/blur) is still covered. A
  // background period shorter than the threshold is treated as a flicker, not
  // a return, and is not refreshed at all.
  useEffect(() => {
    if (status !== "authenticated") return;
    let backgroundedAt: number | null = null;
    const markBackgrounded = () => {
      if (backgroundedAt === null) backgroundedAt = Date.now();
    };
    const maybeResume = () => {
      if (document.visibilityState === "hidden") return;
      if (backgroundedAt === null) return;
      const elapsed = Date.now() - backgroundedAt;
      backgroundedAt = null; // consumed: the other event, if it also fires, no-ops
      if (elapsed < RESUME_MIN_BACKGROUND_MS) return;
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
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") markBackgrounded();
      else maybeResume();
    };
    const onBlur = () => markBackgrounded();
    const onFocus = () => maybeResume();
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("blur", onBlur);
    window.addEventListener("focus", onFocus);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("focus", onFocus);
    };
  }, [status, bumpEpoch]);

  // ── local safety net: zero-network, long interval ────────────────────────
  // Covers the one thing none of the above does: a tab that stays open,
  // focused and on one route for a long time. See `checkLocalSessionHealth`.
  // This is deliberately NOT a replacement for the removed heartbeat — it
  // never asks the provider for role/branch/custom-role data, and the one
  // network call it can make (revoking a session past the absolute cap) is
  // the rare terminal case, not the common tick.
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
              expires_at: new Date(Date.now() + PROVIDER_EVENT_PLACEHOLDER_MS).toISOString(),
              refreshable: true,
              user: event.user,
            };
            // Read the real session back rather than trusting a synthesised
            // expiry; if that fails, keep the user we were just handed.
            const myEpoch = bumpEpoch();
            void (async () => {
              const current = await getUserRepository().currentSession().catch(() => null);
              if (epochRef.current !== myEpoch) return;
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
    // through the ref and the subscription is mounted once. An empty
    // dependency array is intentional here.
  }, []);

  // ── actions ─────────────────────────────────────────────────────────────
  const signIn = useCallback(async (credentials: Credentials) => {
    // A sign-in is a deliberate new identity: bump first, synchronously, so
    // nothing already in flight (a resume refresh from the login screen's
    // previous session, say) can land its answer on top of this one.
    bumpEpoch();
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
