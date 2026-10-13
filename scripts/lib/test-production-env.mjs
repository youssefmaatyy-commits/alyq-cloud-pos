/** Synthetic public configuration: .invalid cannot be a production project.
 * Used only for offline artifact/contract tests. Never a commercial preflight.
 */
export const testProductionEnv = Object.freeze({
  VITE_APP_MODE: 'production', VITE_RELEASE_ENVIRONMENT: 'preview',
  VITE_SUPABASE_URL: 'https://isolated-release-check.invalid',
  VITE_SUPABASE_ANON_KEY: 'sb_publishable_ci_fixture_only_0000000000',
});
