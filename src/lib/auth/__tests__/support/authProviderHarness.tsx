/**
 * Minimal render harness for the AuthProvider live-mode regression suite
 * (`scripts/authProvider.live.flow.mjs`).
 *
 * Mounts the REAL `AuthProvider` (not a reimplementation) around a probe that
 * republishes `useAuth()`'s value to `globalThis.__auth` on every render, so a
 * plain Node driver script can read status/session and call the context's
 * actions without needing React itself.
 */
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { AuthProvider, useAuth, type AuthContextValue } from "../../hooks/AuthProvider";
import { resetAuthRepositories } from "../../data";
import { resetSessionCache, SESSION_STORAGE_KEY } from "../../services/sessionStore";
import { AUTH_SIGNAL_KEY } from "../../services/authEvents";
import { checkLocalSessionHealth, isBeyondAbsoluteCap, SESSION_ABSOLUTE_MS } from "../../services/authService";

export {
  resetAuthRepositories,
  resetSessionCache,
  SESSION_STORAGE_KEY,
  AUTH_SIGNAL_KEY,
  checkLocalSessionHealth,
  isBeyondAbsoluteCap,
  SESSION_ABSOLUTE_MS,
};

declare global {
  var __auth: AuthContextValue | undefined;
}

function Probe() {
  const auth = useAuth();
  globalThis.__auth = auth;
  return null;
}

let root: Root | null = null;

export function mountAuthHarness(): void {
  // Always a fresh DOM node: reusing a container that was already passed to
  // `createRoot()` once trips React's "createRoot() on a container that has
  // already been passed to createRoot()" dev warning, and — worse for this
  // harness — the next mount's effects can end up attached to stale state.
  const stale = document.getElementById("auth-harness-root");
  stale?.remove();
  const container = document.createElement("div");
  container.id = "auth-harness-root";
  document.body.appendChild(container);
  root = createRoot(container);
  root.render(createElement(AuthProvider, null, createElement(Probe)));
}

export function unmountAuthHarness(): void {
  root?.unmount();
  root = null;
  document.getElementById("auth-harness-root")?.remove();
  delete globalThis.__auth;
}
