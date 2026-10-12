/**
 * Alias target for `@/lib/supabase/client`, used ONLY by the AuthProvider
 * live-mode harness (`scripts/authProvider.live.flow.mjs`).
 *
 * No Supabase project is reachable in this environment, so the harness swaps
 * this module in for the real one (an esbuild `alias`) to exercise the real
 * `AuthProvider` + `SupabaseUserRepository` wiring against the same proven
 * stub client the contract tests use (`support/supabaseStub.ts`), instead of
 * `createClient()` talking to the network.
 *
 * `getSupabaseClient()` reads a global the test driver sets before each
 * scenario (`globalThis.__ALYQ_TEST_SUPABASE_CLIENT__`), rather than caching
 * one at module load: `SupabaseUserRepository` re-reads it on every call via
 * its own `client()` accessor, so a fresh stub (with its own empty call log)
 * can be swapped in between scenarios without re-bundling or remounting.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export function toSupabaseProjectUrl(configuredUrl: string): string {
  return configuredUrl;
}

export const SUPABASE_URL = "https://fake-project.supabase.test";
export const SUPABASE_PROJECT_URL = SUPABASE_URL;
export const SUPABASE_ANON_KEY = "fake-anon-key";

/** Always "configured": the harness exists specifically to exercise live mode. */
export const isSupabaseConfigured = true;

export function createSupabaseClient(): SupabaseClient {
  throw new Error("createSupabaseClient() must not be called in the AuthProvider test harness");
}

declare global {
  var __ALYQ_TEST_SUPABASE_CLIENT__: SupabaseClient | null | undefined;
}

export function getSupabaseClient(): SupabaseClient | null {
  return (globalThis.__ALYQ_TEST_SUPABASE_CLIENT__ ?? null) as SupabaseClient | null;
}

export function getRepositoryMode(): "supabase" { return "supabase"; }
