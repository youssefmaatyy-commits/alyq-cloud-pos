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

export const SUPABASE_URL = (env.VITE_SUPABASE_URL ?? "").trim();
export const SUPABASE_ANON_KEY = (env.VITE_SUPABASE_ANON_KEY ?? "").trim();

/** True when real Supabase credentials are available. */
export const isSupabaseConfigured =
  SUPABASE_URL.length > 0 &&
  /^https?:\/\//i.test(SUPABASE_URL) &&
  SUPABASE_ANON_KEY.length > 0;

let client: SupabaseClient | null = null;

/** Returns the shared Supabase client, or `null` in demo mode. */
export function getSupabaseClient(): SupabaseClient | null {
  if (!isSupabaseConfigured) return null;
  if (!client) {
    client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { persistSession: true, autoRefreshToken: true },
    });
  }
  return client;
}
