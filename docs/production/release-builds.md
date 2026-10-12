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
| *(unset)* | Legacy inference: valid credentials → live, none → demo. Recorded as `mode_source: derived-live`/`derived-demo`. | A half-set or malformed pair is treated exactly as in production: fatal. The release probe warns, because a release must be explicit. |

`npm run check:production-guard` proves all three cases with real builds;
`npm run release:probe` reads the result back (see below).

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