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

/** Safe post-login destination: internal /dashboard paths only, never an external URL. */
export function resolveNextTarget(raw: string | null): string {
  if (!raw) return "/dashboard";
  let target = raw.trim();
  try {
    const decoded = decodeURIComponent(target);
    if (decoded !== target) {
      target = decoded;
    }
  } catch {
    return "/dashboard";
  }
  // Open redirect guards: must start with single '/', not '//', '/\', '\\', and must not contain protocol
  if (!target.startsWith("/") || target.startsWith("//") || target.startsWith("/\\") || target.includes("://")) {
    return "/dashboard";
  }
  // Disallow javascript:, data:, vbscript: or control characters
  if (/[\r\n\0]|javascript:|data:|vbscript:/i.test(target)) {
    return "/dashboard";
  }
  // If target points back to auth screens, bounce to /dashboard
  if (
    target === "/login" ||
    target.startsWith("/login?") ||
    target.startsWith("/login/") ||
    target.startsWith("/forgot-password") ||
    target.startsWith("/reset-password") ||
    target.startsWith("/change-password")
  ) {
    return "/dashboard";
  }
  // If already under /dashboard
  if (target === "/dashboard" || target.startsWith("/dashboard/") || target.startsWith("/dashboard?")) {
    return target;
  }
  // If target is root or relative, map it under /dashboard
  if (target === "/" || target.startsWith("/?")) {
    return "/dashboard";
  }
  // For legacy staff paths like /pos, /products, /inventory, etc.
  return `/dashboard${target}`;
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
    const next = target === "/" || target === "/dashboard" ? "" : `?next=${encodeURIComponent(target)}`;
    return <Navigate to={`/login${next}`} replace />;
  }

  return <>{children}</>;
}

/** Public login route; bounces a signed-in visitor into the app. */
export function LoginRoute() {
  const { status } = useAuth();
  const [params] = useSearchParams();

  if (status === "loading") {
    return <BootScreen />;
  }
  if (status === "authenticated") {
    return <Navigate to={resolveNextTarget(params.get("next"))} replace />;
  }
  return <LoginPage />;
}
