# Production security and RLS review

Review date: 2026-10-03. Scope: repository/static and disposable-database evidence only. Hosted configuration remains **UNKNOWN / REQUIRES PRODUCTION VERIFICATION**.

## Results

- All 41 tables referenced by application repositories exist and have RLS enabled in the disposable final schema.
- All 89 referenced RPCs exist; role scenarios exercised anonymous, unprofiled, inactive, viewer, cashier, manager and admin/custom-role behavior through RLS/RPCs.
- Branch tests cover forged scope, cross-branch denial, exact branch stock, approval scope, register authority and mobile-installation custody.
- Static inspection found no `SECURITY DEFINER` function definition lacking a fixed `search_path`. Dynamic SQL occurs in reviewed migration/maintenance paths and must still be compared with the hosted final definitions.
- Anonymous writes are denied except the intentional `product-images/proofs/` insert-only path. That path restricts prefix, MIME and size; anonymous listing/update/delete is denied.
- Audit history is append-only in tested scenarios, and recursive audit/approval secret stripping is tested.
- Selective cleanup uses permission, branch, expiring preview, fresh-state comparison, exact confirmation, approval limits and audit. Financial history, audit, finalized operational records and backups are protected from broad cleanup.
- Sensitive management writes remain online/server-authoritative. Only supported Desktop cash POS sales use the bounded, idempotent offline queue.
- Electron enables context isolation, sandbox and web security, disables Node integration and denies permissions by default; navigation and IPC are allowlisted.
- Production exception logging now suppresses raw error objects/stacks, and startup diagnostics are development-only.

No new repository BLOCKER or HIGH authorization defect remained after review; no schema migration was required. This statement is not a hosted security attestation.

## Mandatory hosted verification

Before Go-Live, compare hosted functions, grants, policies, publications, Auth and Storage settings to the reviewed final schema; test representative denials with test accounts. Confirm exact Site URL/redirects, session/password/provider controls, bucket CORS/object policies and service-role custody. Provider logs, WAF/rate limits, backups, network restrictions and incident access are not visible to this repository and remain unknown.

## Abuse and availability boundaries

Supabase/provider throttling is surfaced for sign-in/reset paths, manager approval failures are bounded/audited, drawer commands are locally rate-limited, realtime retries back off and offline replay stops after five automatic attempts. Public checkout/proof-upload edge/WAF quotas, bot controls and provider-specific Auth thresholds require production configuration and measured testing; absence of that evidence is a Go-Live NO-GO.


## Release-safety addendum — 2026-10-11

The application now selects Production/Demo explicitly and validates public backend configuration before business providers mount. There is no credential-absence/network-failure Demo fallback. Final built/copy artifacts receive identity, integrity and private-credential scans; authenticated Health/support diagnostics expose only nonsecret release fields. Anonymous go-live checks call STABLE public catalogue/variant/pricing RPCs using GET only and never write or seed Production.

CI gates all 31 E2E suites twice plus types/build/lint/logic/isolated database. Promotion validates trusted exact-SHA/latest CI checks, current main, independent environment reviewers/main-only policy, authoritative pulled Vercel configuration, verified prebuilt bytes and the served candidate identity before domain movement. Deployment tokens are restricted to the guarded client step; no production service-role credential is provided to tests or app builds. No RLS/grant/capability/SQL migration or business assertion was weakened.

Residual release blockers: branch-protection API access returned 403; existing listed deployment environments had no protection rules; Vercel automatic Production path/RBAC/settings and a real catalogue probe/provider negative-release drill remain unverified. Dependency audit risk and existing lint warnings must be recorded, not treated as remediation. See `vercel-release-gate.md`. No commercial GO is claimed from offline tests.
