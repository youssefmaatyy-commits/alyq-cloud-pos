/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL?: string;
  readonly VITE_SUPABASE_ANON_KEY?: string;
  readonly VITE_CURRENCY?: string;
  readonly VITE_STOREFRONT_URL?: string;
  readonly VITE_DEMO_SEED?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
