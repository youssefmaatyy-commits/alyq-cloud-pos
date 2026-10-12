# Production environment and secret boundary

All `VITE_*` values are embedded at build time and are therefore **CLIENT-SAFE only**. Build once per environment; do not reuse a staging bundle in production.

## Inventory

| Value | Class | Required by | Rule |
|---|---|---|---|
| `VITE_APP_MODE` | CLIENT-SAFE, BUILD-TIME | Every build | `production` or `demo` — **required, there is no inference**. Unset or unknown makes `vite build` **fail** (`APP_MODE_MISSING` / `APP_MODE_UNKNOWN`). `production` additionally makes a missing/invalid Supabase pair a build failure |
| `VITE_SUPABASE_ANON_KEY` | CLIENT-SAFE, BUILD-TIME | Web/Desktop/Mobile | Publishable/anon key only; RLS remains mandatory |
| `WEB_PUSH_VAPID_PUBLIC_KEY` | CLIENT-SAFE, BUILD-TIME | Home Screen PWA Web Push | Public P-256 application-server key; exposed explicitly by Vite without a broad `WEB_PUSH_*` client prefix |
| `WEB_PUSH_VAPID_PRIVATE_KEY` | SERVER-ONLY | `alyq-push` Web Push signing | Supabase Edge secret only; never `VITE_*`, browser, log or artifact |
| `WEB_PUSH_SUBJECT` | SERVER CONFIG | `alyq-push` VAPID contact | Supabase Edge secret/config; `mailto:` or HTTPS operator contact, no customer data |
| `VITE_CURRENCY` | CLIENT-SAFE, BUILD-TIME | All UIs | `EGP` unless release decision says otherwise |
| `VITE_STOREFRONT_URL` | CLIENT-SAFE, BUILD-TIME | POS navigation | Empty for built-in `#/store`, or exact HTTPS storefront origin |
| `VITE_DEMO_SEED` | CLIENT-SAFE, BUILD-TIME | Repository selection | Must be `off` for production |
| `VITE_APP_VERSION` | CLIENT-SAFE, BUILD-TIME | Mobile Health/About | Must equal release manifest version |
| `VITE_BUILD_SHA` | CLIENT-SAFE, BUILD-TIME | Mobile diagnostics | Full frozen Git SHA |
| `ALYQ_BUILD_SHA` | BUILD-TIME | Electron metadata | Full frozen Git SHA |
| `SUPABASE_SERVICE_ROLE_KEY` | SERVER-ONLY | Internal privileged Supabase clients in admin/push Edge Functions | Never use as incoming HTTP invocation authority; never `VITE_*`, client, logs or artifact |
| `PUSH_DISPATCH_SECRET` | SERVER-ONLY | Protected scheduler and `alyq-push` invocation check only | Independent from service role; never frontend/mobile, `VITE_*`, logs or artifact |
| Database connection/password | SERVER-ONLY | Migration/backup operator | Short-lived protected operator environment; never app build |
| APNs key / FCM service credential / Web Push VAPID private key | SERVER-ONLY | Push delivery worker | Provider secret store only |
| Windows signing certificate/password | RELEASE/SIGNING SECRET | Controlled Windows CI | Hardware-backed or encrypted secret custody |
| Android keystore/key aliases/passwords | RELEASE/SIGNING SECRET | Android release CI | Outside repository and app bundle |
| Apple signing certificate/profile credentials | RELEASE/SIGNING SECRET | macOS CI | Apple/CI secret custody |
| production site URL / redirect URLs | SERVER CONFIG | Supabase Auth/hosting | Exact HTTPS allowlist, no privileged wildcard |

`.env.example` contains placeholders only. Local `.env*` files, signing files and generated artifacts must remain ignored.

## Fail-closed rules (`VITE_APP_MODE=production`)

The policy lives in `src/lib/appMode.ts` and applies in both directions:

| Condition | Result |
| --- | --- |
| No `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` | **Build fails** (`SUPABASE_UNCONFIGURED`); a bundle that exists renders the configuration-error screen |
| Only one of the pair present | Fatal (`SUPABASE_INCOMPLETE`) — a half configuration is a typo, never a demo build |
| URL not absolute, not http(s), or plain `http` to a non-loopback host | Fatal (`SUPABASE_URL_INVALID` / `SUPABASE_URL_INSECURE`) |
| Key is a `service_role` JWT claim, an `sb_secret_…` key, or unparseable | Fatal (`ANON_KEY_LOOKS_SECRET` / `ANON_KEY_INVALID`) |
| `…/rest/v1` project URL | Accepted, normalised to the project root, reported as a warning |
| `VITE_APP_MODE=demo` with credentials present | Accepted: the credentials are ignored and a warning is recorded — a demonstration build cannot reach a project |
| Unset / empty / unknown `VITE_APP_MODE` | **Build fails** (`APP_MODE_MISSING` / `APP_MODE_UNKNOWN`). A build that does not say what it is must not exist; a bundle that was produced anyway (hand-rolled esbuild, an older artifact) renders the configuration-error screen and never mounts the app |
| `VITE_DEMO_SEED` not `off` in a production build | Accepted, warned — preflight and the probe expect `off` |

## Migrating an existing deployment to explicit mode

Every deployment that exists today was built by a pipeline where `VITE_APP_MODE` was
**optional**: with credentials present the mode was assumed to be production, and with
credentials absent it was assumed to be demo. Both assumptions are gone.

Before the next rebuild of any environment, add the variable to that environment's build
settings (Vercel project → Environment Variables, the GitHub Actions workflow env, or the
local `.env.local` for a hand build):

| Environment | Set | Result |
| --- | --- | --- |
| Production web / Desktop / Mobile release | `VITE_APP_MODE=production` (+ the Supabase pair) | Live build, exactly as before |
| Evaluation / demo host | `VITE_APP_MODE=demo` | The local dataset, explicitly chosen |
| Anything you forget | *(nothing)* | `vite build` **fails** with `APP_MODE_MISSING` — a redeploy can no longer ship the local dataset by accident |

This is a one-time change per environment, and it is deliberately loud: the failure mode of
a forgotten variable is now a red build with the variable's name in it, not a live-looking
till writing to `localStorage`.

## The commercial catalogue gate

`VITE_APP_MODE=production` proves the *configuration* is live; it says nothing about whether
the shop behind it has anything to sell. A production promotion therefore runs one more
read-only probe before it releases (`npm run catalogue:gate`, wired into
`.github/workflows/promote-production.yml`):

| Step | Behaviour |
| --- | --- |
| Read the shipped SQL | The two public RPC bodies in `supabase/migrations/*.sql` must prove read-only first; a write keyword, a `volatile` marker or a missing function refuses to send any request at all (exit 1) |
| Call `storefront_catalogue()` and `storefront_branch_product_variants()` | Two `POST …/rest/v1/rpc/<fn>` calls with an empty body and the anon key — the same two functions the storefront itself calls. No other request is ever sent |
| Decide | Pass when at least one public product or variant is sellable (untracked stock, or tracked stock `> 0`, by rollup or by variant). Fail when nothing is sellable (`catalogue.nothing_sellable`) |
| Zero products | Permitted only with `ALLOW_EMPTY_STOREFRONT` **exactly** `true` (GitHub *variable*, not secret). Anything else — `TRUE`, `1`, `yes`, an empty string — fails |

It never writes to Supabase: the probe asserts it holds only the anon key (a `sb_secret_…`
or `service_role` value refuses to run) and that the plan it is about to send contains the
two allow-listed RPC calls and nothing else.

## Release checks

1. Build from a clean frozen SHA using `npm ci`.
2. Set `VITE_APP_MODE=production`, `VITE_DEMO_SEED=off` and all build metadata.
3. Reject empty Supabase URL/key, localhost URLs, placeholder values and service-role-shaped values — the build does this itself; `npm run check:production-guard` proves it with three real builds.
4. Run `npm run production:preflight`, build, then `npm run release:probe` (read-only: manifest + in-browser catalogue walk) **and** `npm run catalogue:gate` (read-only: the real public RPCs), and scan `dist`, Desktop package and native assets.
5. Record environment names and secret versions—not secret values—in the release manifest (`dist/release.json` records the version, commit, build time and mode).

## Origins and navigation

Web uses the production HTTPS origin and hash routing. Supabase Auth Site URL and redirects must name only approved Web/Desktop/Mobile callback destinations. Electron production loads packaged `dist`; its development URL accepts loopback only. Android App Links and iOS Universal Links require controlled HTTPS association files; `alyq://` remains the explicit fallback. Never grant wildcard origin access to a privileged native bridge.