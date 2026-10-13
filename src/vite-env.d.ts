/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_APP_MODE?: "production" | "demo";
  readonly VITE_RELEASE_ENVIRONMENT?: "production" | "staging" | "preview" | "demo";
  readonly VITE_SUPABASE_URL?: string;
  readonly VITE_SUPABASE_ANON_KEY?: string;
  readonly VITE_CURRENCY?: string;
  readonly VITE_STOREFRONT_URL?: string;
  readonly VITE_DEMO_SEED?: string;
  readonly VITE_APP_VERSION?: string;
  readonly VITE_BUILD_SHA?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
