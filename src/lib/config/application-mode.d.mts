export type ReleaseEnvironment = 'production' | 'staging' | 'preview' | 'demo';
export type ApplicationConfig =
  | { ok: true; mode: 'production'; environment: Exclude<ReleaseEnvironment, 'demo'>; supabaseUrl: string; supabaseKey: string }
  | { ok: true; mode: 'demo'; environment: 'demo' }
  | { ok: false; mode: 'production' | 'demo'; code: string };
export const PUBLIC_BUILD_VARIABLES: readonly string[];
export function isPublicSupabaseKey(value: unknown): boolean;
export function resolveApplicationConfig(env?: Record<string, string | undefined>): ApplicationConfig;
export function assertBuildEnvironment(env: Record<string, string | undefined>): Exclude<ApplicationConfig, { ok: false }>;
