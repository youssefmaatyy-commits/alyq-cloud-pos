import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { resolveApplicationConfig } from "@/lib/config/application-mode.mjs";

export const applicationConfig = resolveApplicationConfig(import.meta.env);

/** Retained low-level URL adapter for historical integrations; the application
 * configuration contract validates the input before a business provider mounts. */
export function toSupabaseProjectUrl(configuredUrl: string): string {
  const trimmed = configuredUrl.trim();
  try {
    const url = new URL(trimmed);
    if (url.pathname.replace(/\/+$/, "").toLowerCase() === "/rest/v1") return url.origin;
  } catch { /* the fail-closed application gate reports invalid configuration */ }
  return trimmed;
}

export const SUPABASE_URL = typeof import.meta.env.VITE_SUPABASE_URL === "string" ? import.meta.env.VITE_SUPABASE_URL.trim() : "";
export const SUPABASE_PROJECT_URL = toSupabaseProjectUrl(SUPABASE_URL);
export const SUPABASE_ANON_KEY = typeof import.meta.env.VITE_SUPABASE_ANON_KEY === "string" ? import.meta.env.VITE_SUPABASE_ANON_KEY.trim() : "";
export const isSupabaseConfigured = applicationConfig.ok && applicationConfig.mode === "production";

export class ApplicationConfigurationError extends Error {
  constructor(code: string) {
    super(`Application configuration error: ${code}`);
    this.name = "ApplicationConfigurationError";
  }
}

/** Only explicit Demo may select a local repository. Invalid Production throws. */
export function getRepositoryMode(): "supabase" | "demo" {
  if (!applicationConfig.ok) throw new ApplicationConfigurationError(applicationConfig.code);
  if (applicationConfig.mode === "demo") return "demo";
  getSupabaseClient(); // SDK construction failure is an error, never Demo.
  return "supabase";
}

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
  if (!applicationConfig.ok) throw new ApplicationConfigurationError(applicationConfig.code);
  if (applicationConfig.mode === "demo") return null;
  if (!client) {
    try {
      client = createSupabaseClient(applicationConfig.supabaseUrl, applicationConfig.supabaseKey);
    } catch {
      throw new ApplicationConfigurationError("SUPABASE_CLIENT_UNAVAILABLE");
    }
  }
  return client;
}
