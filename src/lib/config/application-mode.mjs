/** Browser-safe contract shared by bootstrap, repository selection and release tools.
 * No errors contain configuration values. Demo is an explicit choice, never a fallback.
 */
export const PUBLIC_BUILD_VARIABLES = Object.freeze([
  'VITE_APP_MODE', 'VITE_SUPABASE_URL', 'VITE_SUPABASE_ANON_KEY', 'VITE_CURRENCY',
  'VITE_STOREFRONT_URL', 'VITE_DEMO_SEED', 'VITE_APP_VERSION', 'VITE_BUILD_SHA',
  'VITE_RELEASE_ENVIRONMENT',
]);

export function isPublicSupabaseKey(value) {
  if (typeof value !== 'string') return false;
  if (/^sb_publishable_[A-Za-z0-9_-]{20,}$/.test(value)) return true;
  const parts = value.split('.');
  if (parts.length !== 3 || !parts.every((part) => /^[A-Za-z0-9_-]+$/.test(part)) || parts[2].length < 32) return false;
  try {
    const decode = (part) => JSON.parse(globalThis.atob(part.replace(/-/g, '+').replace(/_/g, '/')));
    const header = decode(parts[0]);
    const payload = decode(parts[1]);
    // This is format/authority validation, NOT cryptographic verification. Supabase
    // verifies the signature and RLS remains the authority for every request.
    return header.typ === 'JWT' && ['HS256', 'RS256', 'ES256'].includes(header.alg)
      && payload.role === 'anon' && payload.iss === 'supabase';
  } catch { return false; }
}

export function resolveApplicationConfig(env = {}) {
  const mode = env.VITE_APP_MODE;
  const fail = (code) => ({ ok: false, mode: mode === 'demo' ? 'demo' : 'production', code });
  if (mode !== 'production' && mode !== 'demo') return fail('APP_MODE_REQUIRED');
  // Deprecated: "off" is retained as a veto, not a second mode selector.
  // Migrate production to VITE_APP_MODE=production; demo to demo and remove off.
  if (env.VITE_DEMO_SEED !== undefined && env.VITE_DEMO_SEED !== '' && !['on', 'off'].includes(env.VITE_DEMO_SEED)) return fail('DEMO_SEED_INVALID');
  if (mode === 'demo') {
    if (env.VITE_DEMO_SEED === 'off') return fail('DEMO_DISABLED');
    return { ok: true, mode: 'demo', environment: 'demo' };
  }
  const urlValue = typeof env.VITE_SUPABASE_URL === 'string' ? env.VITE_SUPABASE_URL.trim() : '';
  const key = typeof env.VITE_SUPABASE_ANON_KEY === 'string' ? env.VITE_SUPABASE_ANON_KEY.trim() : '';
  if (!urlValue || !key) return fail('SUPABASE_CONFIG_REQUIRED');
  let url;
  try { url = new globalThis.URL(urlValue); } catch { return fail('SUPABASE_URL_INVALID'); }
  // Retain the documented legacy /rest/v1 migration path, but reject every
  // other API path, userinfo, query, fragment and non-HTTPS endpoint.
  if (url.protocol !== 'https:' || !url.hostname.includes('.') || url.username || url.password
      || url.search || url.hash || !['', '/', '/rest/v1', '/rest/v1/'].includes(url.pathname)
      || ['localhost', '127.0.0.1', '0.0.0.0'].includes(url.hostname)) return fail('SUPABASE_URL_INVALID');
  if (!isPublicSupabaseKey(key)) return fail('SUPABASE_PUBLIC_KEY_INVALID');
  const environment = env.VITE_RELEASE_ENVIRONMENT || 'production';
  if (!['production', 'staging', 'preview'].includes(environment)) return fail('RELEASE_ENVIRONMENT_INVALID');
  return { ok: true, mode, environment, supabaseUrl: url.origin, supabaseKey: key };
}

export function assertBuildEnvironment(env) {
  const config = resolveApplicationConfig(env);
  if (!config.ok) throw new Error(`Application configuration rejected: ${config.code}`);
  if (Object.keys(env).some((name) => name.startsWith('VITE_') && !PUBLIC_BUILD_VARIABLES.includes(name))) {
    throw new Error('Unapproved browser environment variable. Use only the public build allowlist.');
  }
  return config;
}
