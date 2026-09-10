import type { ReactNode } from "react";
import { Navigate, useLocation, useSearchParams } from "react-router-dom";
import { useAuth } from "../hooks/AuthProvider";
import { LoginPage } from "./LoginPage";

/**
 * Session guards.
 *
 * `RequireAuth` wraps every protected screen (the whole app shell), so a screen
 * cannot be reached without a valid session whether it is clicked in the sidebar
 * or typed as a deep link. `LoginRoute` is the mirror image: the login screen is
 * public, and an already signed-in visitor is sent straight back into the app.
 */

/** Safe post-login destination: internal paths only, never an external URL. */
export function resolveNextTarget(raw: string | null): string {
  if (!raw) return "/";
  if (!raw.startsWith("/") || raw.startsWith("//")) return "/";
  return raw;
}

/** Shown for the single frame before the persisted session is restored. */
function BootScreen() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50">
      <div className="flex flex-col items-center gap-3">
        <span
          aria-hidden
          className="h-8 w-8 animate-spin rounded-full border-2 border-slate-300 border-t-indigo-600"
        />
        <p className="text-xs font-semibold text-slate-600">ALYQ Cloud POS</p>
      </div>
    </div>
  );
}

export function RequireAuth({ children }: { children: ReactNode }) {
  const { status } = useAuth();
  const location = useLocation();

  if (status === "loading") return <BootScreen />;

  if (status === "anonymous") {
    // Remember where the user was heading (internal paths only; `resolveNextTarget`
    // re-checks it after sign-in) so a deep link survives the login detour.
    const target = `${location.pathname}${location.search}`;
    const next = target === "/" ? "" : `?next=${encodeURIComponent(target)}`;
    return <Navigate to={`/login${next}`} replace />;
  }

  return <>{children}</>;
}

/** Public login route; bounces a signed-in visitor into the app. */
export function LoginRoute() {
  const { status } = useAuth();
  const [params] = useSearchParams();

  if (status === "loading") return <BootScreen />;
  if (status === "authenticated") {
    return <Navigate to={resolveNextTarget(params.get("next"))} replace />;
  }
  return <LoginPage />;
}
