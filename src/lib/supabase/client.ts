import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Central Supabase access for ALYQ Cloud POS.
 *
 * The client is created lazily and only when BOTH `VITE_SUPABASE_URL` and
 * `VITE_SUPABASE_ANON_KEY` are present. When they are missing the application
 * automatically runs in **demo mode** (in-memory, browser-persisted data) so the
 * UI is always usable. Nothing here throws at import time.
 */

const env = import.meta.env ?? {};

/**
 * Supabase's JavaScript client expects a project URL, not one of its API URLs.
 *
 * Some existing deployments supplied the PostgREST endpoint here
 * (`https://<project>.supabase.co/rest/v1`). Passing that endpoint through made
 * supabase-js append its own API paths beneath it, including
 * `/rest/v1/functions/v1/<function>`. Accept the existing configuration while
 * always handing the SDK the project base URL it requires.
 */
export function toSupabaseProjectUrl(configuredUrl: string): string {
  const trimmed = configuredUrl.trim();
  if (!trimmed) return "";

  try {
    const url = new URL(trimmed);
    const path = url.pathname.replace(/\/+$/, "").toLowerCase();
    if (path === "/rest/v1") {
      url.pathname = "/";
      url.search = "";
      url.hash = "";
      return url.href.replace(/\/$/, "");
    }
  } catch {
    // Keep invalid input intact. `isSupabaseConfigured` retains the existing
    // configuration gate, and supabase-js remains responsible for reporting a
    // malformed URL if a caller tries to create a live client.
  }

  return trimmed;
}

export const SUPABASE_URL = (env.VITE_SUPABASE_URL ?? "").trim();
export const SUPABASE_PROJECT_URL = toSupabaseProjectUrl(SUPABASE_URL);
export const SUPABASE_ANON_KEY = (env.VITE_SUPABASE_ANON_KEY ?? "").trim();

/** True when real Supabase credentials are available. */
export const isSupabaseConfigured =
  SUPABASE_PROJECT_URL.length > 0 &&
  /^https?:\/\//i.test(SUPABASE_PROJECT_URL) &&
  SUPABASE_ANON_KEY.length > 0;

interface SupabaseClientFactoryOptions {
  /** Test seam; production uses the platform fetch implementation. */
  fetch?: typeof globalThis.fetch;
}

/** Canonical provider session settings shared by Web, Desktop and Mobile. */
export const SUPABASE_AUTH_OPTIONS = Object.freeze({
  persistSession: true,
  autoRefreshToken: true,
  detectSessionInUrl: true,
});

/**
 * Create a client from either the documented project URL or a legacy REST URL.
 * All SDK services (PostgREST, Auth, Storage, Realtime and Edge Functions)
 * therefore derive their paths from the same project root.
 */
export function createSupabaseClient(
  configuredUrl: string,
  anonKey: string,
  options: SupabaseClientFactoryOptions = {},
): SupabaseClient {
  return createClient(toSupabaseProjectUrl(configuredUrl), anonKey, {
    // One provider-owned session contract for browsers, Electron's renderer
    // and the Capacitor WebView. Supabase persists only its own token bundle;
    // the application never stores a password or invents a refresh token.
    auth: SUPABASE_AUTH_OPTIONS,
    ...(options.fetch ? { global: { fetch: options.fetch } } : {}),
  });
}

let client: SupabaseClient | null = null;

/** Returns the shared Supabase client, or `null` in demo mode. */
export function getSupabaseClient(): SupabaseClient | null {
  if (!isSupabaseConfigured) return null;
  if (!client) {
    client = createSupabaseClient(SUPABASE_PROJECT_URL, SUPABASE_ANON_KEY);
  }
  return client;
}
