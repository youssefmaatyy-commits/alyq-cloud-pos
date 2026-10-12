import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { RESOLVED_APP_MODE, toSupabaseProjectUrl } from "@/lib/appMode";

/**
 * Central Supabase access for ALYQ Cloud POS.
 *
 * The client is created lazily, and only when `src/lib/appMode.ts` resolved the
 * build to **production** mode with a configuration that passed validation.
 * That module — not this file — owns the policy, so there is exactly one place
 * where "is this build live?" is answered and exactly one place that validates
 * the URL and the anon key.
 *
 * In explicit demo mode (`VITE_APP_MODE=demo`) the credentials are ignored even
 * when they are present: the demo dataset is a deliberate choice, never a
 * fallback. When a production build is misconfigured, `STARTUP_BLOCKED` is true
 * and `main.tsx` renders the configuration-error screen instead of the
 * application, so nothing here can be reached with a half-configured backend.
 * Nothing in this module throws at import time.
 */

export { toSupabaseProjectUrl };

export const SUPABASE_URL = RESOLVED_APP_MODE.supabase.configured
  ? RESOLVED_APP_MODE.supabase.projectUrl
  : "";
export const SUPABASE_PROJECT_URL = SUPABASE_URL;
export const SUPABASE_ANON_KEY = RESOLVED_APP_MODE.supabase.configured
  ? RESOLVED_APP_MODE.supabase.anonKey
  : "";

/**
 * True when validated live credentials are available *and* the build is allowed
 * to use them. Demo mode always answers false, which is what makes every
 * repository selector in the app pick the local dataset.
 */
export const isSupabaseConfigured = RESOLVED_APP_MODE.supabase.configured;

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
