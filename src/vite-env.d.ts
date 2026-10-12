/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL?: string;
  readonly VITE_SUPABASE_ANON_KEY?: string;
  readonly VITE_CURRENCY?: string;
  readonly VITE_STOREFRONT_URL?: string;
  readonly VITE_DEMO_SEED?: string;
  readonly VITE_APP_VERSION?: string;
  readonly VITE_BUILD_SHA?: string;
  /** Explicit application mode: "production" | "demo". Unset = legacy auto-detect. */
  readonly VITE_APP_MODE?: string;
  /** ISO-8601 build stamp injected by vite.config.ts. */
  readonly VITE_BUILD_TIME?: string;
  /** "true" when the release was built from a dirty worktree. */
  readonly VITE_BUILD_DIRTY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
