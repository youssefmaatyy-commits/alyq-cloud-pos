# Production environment and secret boundary

All `VITE_*` values are embedded at build time and are therefore **CLIENT-SAFE only**. Build once per environment; do not reuse a staging bundle in production.

## Inventory

| Value | Class | Required by | Rule |
|---|---|---|---|
| `VITE_SUPABASE_URL` | CLIENT-SAFE, BUILD-TIME | Web/Desktop/Mobile | Exact production HTTPS project URL; never PostgREST `/rest/v1` URL |
| `VITE_SUPABASE_ANON_KEY` | CLIENT-SAFE, BUILD-TIME | Web/Desktop/Mobile | Publishable/anon key only; RLS remains mandatory |
| `VITE_CURRENCY` | CLIENT-SAFE, BUILD-TIME | All UIs | `EGP` unless release decision says otherwise |
| `VITE_STOREFRONT_URL` | CLIENT-SAFE, BUILD-TIME | POS navigation | Empty for built-in `#/store`, or exact HTTPS storefront origin |
| `VITE_DEMO_SEED` | CLIENT-SAFE, BUILD-TIME | Repository selection | Must be `off` for production |
| `VITE_APP_VERSION` | CLIENT-SAFE, BUILD-TIME | Mobile Health/About | Must equal release manifest version |
| `VITE_BUILD_SHA` | CLIENT-SAFE, BUILD-TIME | Mobile diagnostics | Full frozen Git SHA |
| `ALYQ_BUILD_SHA` | BUILD-TIME | Electron metadata | Full frozen Git SHA |
| `SUPABASE_SERVICE_ROLE_KEY` | SERVER-ONLY | Admin edge/push worker only | CI/host secret store; never `VITE_*`, client, logs or artifact |
| Database connection/password | SERVER-ONLY | Migration/backup operator | Short-lived protected operator environment; never app build |
| APNs key / FCM service credential | SERVER-ONLY | Push delivery worker | Provider secret store only |
| Windows signing certificate/password | RELEASE/SIGNING SECRET | Controlled Windows CI | Hardware-backed or encrypted secret custody |
| Android keystore/key aliases/passwords | RELEASE/SIGNING SECRET | Android release CI | Outside repository and app bundle |
| Apple signing certificate/profile credentials | RELEASE/SIGNING SECRET | macOS CI | Apple/CI secret custody |
| production site URL / redirect URLs | SERVER CONFIG | Supabase Auth/hosting | Exact HTTPS allowlist, no privileged wildcard |

`.env.example` contains placeholders only. Local `.env*` files, signing files and generated artifacts must remain ignored.

## Release checks

1. Build from a clean frozen SHA using `npm ci`.
2. Set `VITE_DEMO_SEED=off` and all build metadata.
3. Reject empty Supabase URL/key, localhost URLs, placeholder values and service-role-shaped values.
4. Run `npm run production:preflight`, build, and scan `dist`, Desktop package and native assets.
5. Record environment names and secret versions—not secret values—in the release manifest.

## Origins and navigation

Web uses the production HTTPS origin and hash routing. Supabase Auth Site URL and redirects must name only approved Web/Desktop/Mobile callback destinations. Electron production loads packaged `dist`; its development URL accepts loopback only. Android App Links and iOS Universal Links require controlled HTTPS association files; `alyq://` remains the explicit fallback. Never grant wildcard origin access to a privileged native bridge.