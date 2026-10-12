# Production release builds and manifest

## Version identity

Current application version is `6.0.0`; Desktop 5.0.0 remains a historical milestone, not a version to rewrite. Every release records semantic app version, platform build number, full Git SHA and schema maximum. Database migrations remain monotonic and independent of app semantic version.

- Web: release version + immutable artifact digest + Git SHA.
- Desktop: package version + `ALYQ_BUILD_SHA`; Windows x64 NSIS target.
- Android: `versionName` follows release version; monotonically increase `versionCode`.
- iOS: `CFBundleShortVersionString` follows release version; monotonically increase `CFBundleVersion`.
- Schema: exact highest successfully applied migration, currently `0094_web_push_subscriptions.sql`
  (`SHIPPED_MIGRATION_COUNT = 94` in `src/modules/operations/types.ts`).

## Application mode

Every build declares its mode with `VITE_APP_MODE`:

| Value | What it produces | What it refuses |
| --- | --- | --- |
| `production` | A live build. `dist/release.json` records `mode: production`, `mode_requested: production` and the commit. | A missing, half-set, malformed, plain-http or `service_role`/`sb_secret_` configuration: `npm run build` fails, and a bundle that exists anyway renders the configuration-error screen instead of the app. It never falls back to demo data. |
| `demo` | The evaluation bundle: in-browser dataset, credentials ignored even when present. `release.json` records `mode: demo`. | Nothing — this is the deliberate artifact for a smoke test or a sales demonstration. It must never be the artifact behind a real till. |
| *(unset)* | **Nothing: the build fails.** There is no inference left. `APP_MODE_MISSING` (or `APP_MODE_UNKNOWN` for an unrecognised value) is fatal before a bundle is written; a bundle produced some other way renders the configuration-error screen and never mounts the app. | A build that does not name its mode. A release pipeline whose variable never arrived now fails loudly instead of producing a demo artifact that looks like a live shop. |

`npm run check:production-guard` proves the whole matrix with real builds:

| Case | Expected |
| --- | --- |
| no `VITE_APP_MODE`, no credentials | **fail** (`APP_MODE_MISSING`), no artifact written |
| no `VITE_APP_MODE`, valid-looking credentials | **fail** (`APP_MODE_MISSING`) — production is not inferred either |
| unknown mode (`staging`), credentials | **fail** (`APP_MODE_UNKNOWN`) |
| `production`, no credentials | **fail** (`SUPABASE_UNCONFIGURED`) |
| `production`, half a pair | **fail** (`SUPABASE_INCOMPLETE`) |
| `production`, complete pair | **succeed**, manifest says `production` |
| `demo`, no credentials | **succeed**, manifest says `demo` |
| `demo` **with** credentials | **succeed**, `SUPABASE_CREDENTIALS_IGNORED`, no Supabase client — and the shipped bundle walks the empty catalogue with zero network requests |

`npm run release:probe` reads the result back (see below).

### Existing deployments must name their mode

An environment that used to rely on inference needs one edit before its next rebuild:
`VITE_APP_MODE=production` in the host's build environment (Vercel project variables, the
CI workflow env). `VITE_APP_MODE=demo` is the only way to ask for the evaluation bundle.
See `production-environment.md` → *Migrating an existing deployment to explicit mode*.

## Release metadata

`vite build` writes **`dist/release.json`** next to the bundle:

```json
{
  "version": "6.0.0",
  "sha": "<full commit, or …-dirty>",
  "built_at": "<ISO-8601 UTC>",
  "dirty": false,
  "mode": "production",
  "mode_source": "explicit",
  "mode_requested": "production",
  "currency": "EGP",
  "schema_migration": "0094_web_push_subscriptions.sql",
  "configuration_issues": [],
  "node": "v22.x"
}
```

`VITE_APP_VERSION` / `VITE_BUILD_SHA` set it explicitly (CI does); otherwise the
version comes from `package.json` and the commit from Git, and an unclean
worktree is marked `…-dirty` with `"dirty": true`. No credential, URL or path is
in the file.

## Reproducible sequence

```bash
npm ci
npm run production:preflight
npm run typecheck
npm run lint -- --quiet
npm test
npm run db:check
VITE_APP_MODE=production VITE_SUPABASE_URL=… VITE_SUPABASE_ANON_KEY=… \
  VITE_DEMO_SEED=off VITE_APP_VERSION=… VITE_BUILD_SHA="$GITHUB_SHA" npm run build
npm run release:probe -- --expect-sha "$GITHUB_SHA"   # non-mutating, reads dist/release.json
npm run test:bundle
npm run test:e2e                                        # CI runs it twice
npm run desktop:build
npm run mobile:sync
```

Build with production `VITE_*` values, `VITE_DEMO_SEED=off`, and frozen SHA metadata. Scan artifacts before signing. Never publish from a dirty checkout — the probe fails a manifest that says `dirty: true`.

## The commercial catalogue gate

The release probe walks an empty catalogue in a browser; that is a UI contract, not the
commercial one. Promotion also runs `npm run catalogue:gate`, a separate **read-only** probe
of the real public RPCs the storefront calls:

```bash
VITE_APP_MODE=demo npm run catalogue:gate                      # reads SUPABASE_PROD_URL / SUPABASE_PROD_ANON_KEY
npm run catalogue:gate -- --url https://… --anon-key … --json   # explicit, machine-readable
ALLOW_EMPTY_STOREFRONT=true npm run catalogue:gate              # a deliberately empty storefront
```

- it first inspects the shipped `storefront_catalogue()` / `storefront_branch_product_variants()`
  bodies in `supabase/migrations/*.sql` and refuses to send anything unless both are proven
  read-only;
- then it issues exactly two `POST …/rest/v1/rpc/<fn>` requests with `{}` bodies, using the
  anon key — no other method, URL or body is ever produced (the plan is asserted before the
  first byte is sent);
- it fails when no public product or variant is sellable, and permits zero products **only**
  when `ALLOW_EMPTY_STOREFRONT` is exactly `true` (case- and whitespace-sensitive; the CLI
  prints the value it saw);
- it classifies an RPC failure, a non-2xx answer, a permission denial, malformed JSON, a
  network error and a *timeout* as release failures, with a bounded request
  (`--timeout`, default 15 s) so a silent project cannot hang a promotion;
- it never prints the key, and no response body reaches a message: findings name the
  function, the HTTP status and the shape of the answer;
- exit codes: `0` sellable (or declared empty), `1` gate failed, `2` unusable invocation.

`npm run catalogue:gate` is `catalogue-gate` in `.github/workflows/promote-production.yml`,
and it runs **before** the release job: a production promotion cannot start until the shop
has something to sell. Its policy tests live in
`src/lib/qa/__tests__/catalogueGate.selftest.ts` and run inside `npm test`.

## The release probe

`npm run release:probe` is read-only by construction:

- it validates `dist/release.json` against the expectations (version, commit,
  mode, cleanliness) using `src/lib/qa/releaseProbe.ts`;
- it boots the shipped bundle in jsdom against an **empty catalogue** — the
  day-zero state — and asserts the shop renders its empty state, the register
  offers nothing, and **no sale, order, return, customer, shift, stock or audit
  row is created** and no network request is made;
- with `--url https://…` it issues two `GET`s (`/release.json`, `/`) and checks
  that the served HTML carries the same commit. `remoteProbePlan()` builds that
  list, and the probe refuses to run if any method in it is not `GET`/`HEAD`.

Its policy tests live in `src/lib/qa/__tests__/releaseProbe.selftest.ts` and run
inside `npm test`.

## Web hosting

Serve `dist/index.html` over HTTPS with hash-route compatibility. Use no-store/short cache for HTML and release metadata; immutable long cache only for content-hashed assets. Enable compression, HSTS after domain validation, `X-Content-Type-Options: nosniff`, restrictive referrer policy, frame protections, and a tested CSP covering the exact Supabase/Storage origins. Do not use wildcard privileged origins. Keep prior immutable artifact/config for rollback.

## Windows CI and signing

Use supported Node 22/npm, `npm ci`, a valid OS trust store and normal `electron-builder --win nsis --x64`. Never disable TLS verification. Sign with the legal publisher's trusted code-signing certificate held in protected CI/HSM custody; use a trusted timestamp server. Verify Authenticode publisher/timestamp on another Windows host, calculate SHA-256, malware-scan, install as standard user and record the checksum. Auto-update remains disabled until signed HTTPS metadata, signature verification and rollback infrastructure exist.

## Android/iOS

Android requires a supported JDK for Capacitor 8/Gradle, Android SDK, accepted licenses and release keystore outside Git. Generate a signed AAB in protected CI; optionally generate an APK for acceptance. Verify package `eg.alyq.management`, version, permissions, App Links and notification behavior.

iOS requires macOS/Xcode, Apple Developer Team, distribution certificate/profile, bundle ID `eg.alyq.management`, Associated Domains, APNs entitlement and archive validation. Prepare TestFlight only in a separately authorized phase.

## Release manifest template

```yaml
release_version: TBD
release_date_utc: TBD
git_sha: TBD
migration_max_before: TBD
migration_max_after: 0085_first_admin_bootstrap.sql
backup_id: TBD
backup_verified_by: TBD
restore_drill_id: TBD
web_artifact_sha256: TBD
desktop_installer_sha256: TBD
desktop_signature_verified: false
android_aab_sha256: TBD
android_signing_verified: false
ios_archive_id: TBD
ios_signing_verified: false
migration_result: NOT_RUN
smoke_test_result: NOT_RUN
health_result: NOT_RUN
rollback_artifact_or_snapshot: TBD
operator: TBD
approver: TBD
```

No `TBD` or false mandatory gate may be treated as production evidence.