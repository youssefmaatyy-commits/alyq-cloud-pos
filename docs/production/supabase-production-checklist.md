# Hosted Supabase production checklist

Nothing in this checklist is performed automatically.

## Before migration

- [ ] Confirm project ID, organization, region and environment label are **Production**; use a second-person check.
- [ ] Freeze release SHA and expected migration maximum `0084_role_aliases_rls_hardening.sql`.
- [ ] Export current migration ledger/schema and compare to the repository; stop on unknown drift.
- [ ] Complete and verify the backup record in `backup-restore.md`.
- [ ] Confirm maintenance window, operator, observer, rollback authority and application hold page/version.
- [ ] Confirm required PostgreSQL/Supabase extensions already used by migrations are available.

## Database security

- [ ] Apply migrations strictly `0001` through `0084`, skipping already-recorded matching migrations only.
- [ ] Do not edit an applied migration or improvise a down migration.
- [ ] Verify repository tables have RLS enabled and expected policies.
- [ ] Verify anon/authenticated grants and RPC execution grants against `npm run db:check` output.
- [ ] Inspect security-definer functions for fixed `search_path`, caller authorization and no untrusted dynamic SQL.
- [ ] Verify branch membership, custom-role exceptions, approvals, register credentials and mobile installation direct-table denial.
- [ ] Verify audit rows are append-only and secret redaction is active.

## Auth

- [ ] Set exact HTTPS Site URL and redirect allowlist; remove obsolete localhost redirects.
- [ ] Verify password policy, email templates/provider, session lifetime, refresh, logout and account revocation.
- [ ] Confirm no public self-signup grants an active staff role; onboarding remains inactive/least privilege.
- [ ] Exercise expired/revoked sessions on Web, Desktop and Mobile staging builds.

## Storage

- [ ] Bucket `product-images` exists and is public only because catalogue images require CDN reads.
- [ ] `file_size_limit=5242880`; MIME allowlist is jpeg/png/webp/gif/avif/bmp (no SVG).
- [ ] Authenticated staff policies cover select/insert/update/delete.
- [ ] Anon can insert only under `proofs/` and cannot list/update/delete.
- [ ] Verify object backup/export and restore procedure; verify CORS/origins in the real project.

## Realtime and background work

- [ ] Verify only intended tables/publications emit realtime changes; clients still re-read authoritative rows.
- [ ] Confirm backup scheduling/retention infrastructure if enabled; repository tests do not prove hosted schedules.
- [ ] Configure push worker separately with service-role/APNs/FCM secrets; verify branch/user targeting and invalid-token cleanup.

## Post-migration

- [ ] Confirm migration maximum, schema parity, RLS, RPC grants and Health Center schema state.
- [ ] Execute staging/production smoke checklist before traffic authorization.
- [ ] Record exact result, timestamps and operator in the release manifest.
- [ ] Stop and invoke rollback on any unknown schema, permission bypass, financial mismatch or branch leakage.