# Production release builds and manifest

## Version identity

Current application version is `6.0.0`; Desktop 5.0.0 remains a historical milestone, not a version to rewrite. Every release records semantic app version, platform build number, full Git SHA and schema maximum. Database migrations remain monotonic and independent of app semantic version.

- Web: release version + immutable artifact digest + Git SHA.
- Desktop: package version + `ALYQ_BUILD_SHA`; Windows x64 NSIS target.
- Android: `versionName` follows release version; monotonically increase `versionCode`.
- iOS: `CFBundleShortVersionString` follows release version; monotonically increase `CFBundleVersion`.
- Schema: exact highest successfully applied migration, currently expected `0085`.

## Reproducible sequence

```bash
npm ci
npm run production:preflight
npm run typecheck
npm run lint -- --quiet
npm test
npm run db:check
npm run build
npm run test:bundle
npm run test:e2e
npm run desktop:build
npm run mobile:sync
```

Build with production `VITE_*` values, `VITE_DEMO_SEED=off`, and frozen SHA metadata. Scan artifacts before signing. Never publish from a dirty checkout.

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