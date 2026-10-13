# Production environment and secret boundary

All `VITE_*` values are embedded at **build time** and are CLIENT-SAFE only. Build once per environment; never reuse a Demo or staging artifact as a Production release. Changing host settings without rebuilding does not change an existing client.

## Explicit application mode (required)

- `VITE_APP_MODE=production`: Supabase is the only business-data authority. Requires a valid HTTPS project URL and public anon/publishable key. Missing/malformed configuration stops the build; defensive runtime bootstrap shows a bilingual controlled configuration error **before any business providers mount**. No Login/POS/Admin/Checkout or local fake store is mounted on that path. Network/auth failures never switch to Demo.
- `VITE_APP_MODE=demo`: explicit local evaluation only. A persistent bilingual DEMO / not-for-real-transactions banner is visible on every route, and the installable manifest is labelled DEMO. No Production push service-worker registration occurs. Backend credentials do not silently turn this into Production.
- Missing, misspelled or any other mode: fail closed.
- `VITE_DEMO_SEED` is **deprecated** as a selector: unset/empty is allowed; legacy `on` is a deprecated no-op; `off` vetoes Demo; other values and `demo + off` are rejected. Neither `on` nor `off` selects a mode. `production + off` remains compatible. It does **not** promise that Demo function definitions are removed from the bundle. Mode, not credential presence, selects repositories.

### Migration from the old implicit mode

Existing hosted deployments must add `VITE_APP_MODE=production`, retain their approved public backend pair, set the release environment, and rebuild from the approved SHA. Keep `VITE_DEMO_SEED=off` or remove it; it is no longer required to prevent fallback. Local Demo evaluators must set `VITE_APP_MODE=demo` and remove/empty `VITE_DEMO_SEED`. Old no-variable deployments now fail instead of silently creating local business data. Regression tests cover these combinations and the actual built bootstrap.

## Configuration inventory

| Value | Class | Required by / rule |
|---|---|---|
| `VITE_APP_MODE` | PUBLIC, BUILD-TIME | Required exact `production` or `demo`; Production hosts must use `production` |
| `VITE_RELEASE_ENVIRONMENT` | PUBLIC, BUILD-TIME | Production backend labels: `production`, `staging`, `preview`; Demo always labels itself `demo` |
| `VITE_SUPABASE_URL` | PUBLIC, BUILD-TIME | Approved HTTPS project origin, no userinfo/query/fragment; legacy `/rest/v1` suffix normalized; other paths/HTTP/localhost rejected |
| `VITE_SUPABASE_ANON_KEY` | PUBLIC, BUILD-TIME | `sb_publishable_` key or JWT with `role=anon`, `iss=supabase`, supported algorithm/shape; privileged/opaque/malformed keys rejected |
| `WEB_PUSH_VAPID_PUBLIC_KEY` | PUBLIC, BUILD-TIME | Public P-256 application-server key only; explicitly exposed without broad `WEB_PUSH_*` prefix |
| `VITE_CURRENCY` | PUBLIC, BUILD-TIME | `EGP` unless the release decision says otherwise |
| `VITE_STOREFRONT_URL` | PUBLIC, BUILD-TIME | Empty for built-in shop, otherwise approved HTTPS storefront origin |
| `VITE_DEMO_SEED` | PUBLIC, BUILD-TIME | Deprecated compatibility veto described above |
| `VITE_APP_VERSION` | PUBLIC, BUILD-TIME | Release manifest version, currently `6.0.0` |
| `VITE_BUILD_SHA` | PUBLIC, BUILD-TIME | Optional full SHA; if supplied, must equal the checkout; never use a branch/tag/placeholder |
| `ALYQ_BUILD_SHA` | BUILD-TIME | Electron package metadata; full frozen SHA |
| `ALLOW_EMPTY_STOREFRONT` | RELEASE-ONLY, NOT VITE | Default `false`; exact `true` requires approved new/staging exception; never hides an RPC failure |
| `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID` | RELEASE CONFIG | GitHub `vercel-production` protected environment variables |
| `VERCEL_TOKEN` | SERVER/RELEASE SECRET | Protected environment secret; candidate/promotion client only, never app/test/browser/log/PR |
| `SUPABASE_SERVICE_ROLE_KEY` | SERVER-ONLY | Privileged Edge custody only, never app builds, invocation authority, logs or artifacts |
| `PUSH_DISPATCH_SECRET` | SERVER-ONLY | Independent protected scheduler/Edge invocation credential, never frontend/mobile |
| `WEB_PUSH_VAPID_PRIVATE_KEY`, `WEB_PUSH_SUBJECT` | SERVER-ONLY | Supabase Edge secrets/configuration only |
| Database password/connection, APNs/FCM credentials | SERVER-ONLY | Approved migration/backup/push operator only, never client builds |
| Windows/Android/iOS signing material/passwords | RELEASE SECRET | Protected signing custody outside Git |

The build allowlist rejects unknown `VITE_*` names. Key validation is format/authority validation, **not** cryptographic verification: Supabase verifies signatures and RLS/RPCs re-authorize every operation. A syntactically valid key is not proof of a healthy/approved project.

## Release verification and diagnostics

1. From a clean frozen SHA, install with `npm ci` and run the complete gate twice (see `release-builds.md`).
2. Supply the actual approved Production public variables **before** `npm run build`.
3. Run `npm run production:preflight` **after** the final build: it validates configuration without printing values, checkout identity, complete copied artifacts, integrity, private credential patterns and known server-only environment values.
4. Run `npm run production:catalogue` as the mandatory read-only commercial check. No test inserts fake products or places orders against Production.
5. Verify full SHA, UTC build time and environment in authenticated Health/Diagnostics. `release.json` contains only those nonsecret fields plus application mode; support export uses the existing redaction boundary.
6. Follow `vercel-release-gate.md`; green repository tests alone cannot enforce external hosting or branch-protection settings.

CI's `.invalid` public backend/key is a clearly labelled **offline contract fixture**, never commercial evidence. Actual promotion rejects synthetic `.invalid` endpoints, requires environment `production`, checks Vercel's pulled raw Production configuration against the approved pair, and probes the real public catalogue. The private key is never needed for this work.

## Origins and navigation

The root is the public storefront. Staff sign-in is `#/login`; authenticated staff routes live under `#/dashboard` (legacy aliases remain compatible). Supabase Auth Site URL and redirects must name approved Web/Desktop/Mobile callback destinations only. Production Electron loads packaged `dist`; development-only loopback stays confined to the native development shell. Android App Links/iOS Universal Links require controlled HTTPS association files; `alyq://` remains the explicit fallback. Never grant wildcard origin access to privileged native bridges.
