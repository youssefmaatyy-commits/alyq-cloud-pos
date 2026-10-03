# Operations, observability and supply-chain readiness

## Health and observability

Health Center reports only facts available to the client and uses unknown/not-configured rather than inventing success. Before Go-Live, assign owners and alerts for database/Auth/Storage availability, RPC error rate, failed logins, order failures, queue age/conflicts, push failures, migration/schema mismatch and backup failures. Define incident contacts, severity, acknowledgement targets and an observation window. Repository preparation did not configure or verify hosted alerts.

Do not log tokens, credentials, manager PINs, payment proofs, full customer data, raw exception objects or request authorization headers. Production error boundaries emit a fixed redacted message. Audit is business evidence, not a substitute for infrastructure telemetry. Access to provider/device logs must be least-privilege and retention must be approved.

## Retention and cleanup

The repository's selective cleanup protects sales, sale items, payments, returns/refunds, audit, closed shifts, financial snapshots, finalized stocktakes and backups. Temporary orphan-media retention defaults to 30 days in the client model, but production legal/business retention is **UNKNOWN** and must be approved. Never map a broad provider retention job onto financial/audit history.

## Abuse controls

Validate hosted Auth throttles and public endpoint quotas using approved test identities. Add provider/WAF controls for public checkout and anonymous proof upload without making proof objects enumerable or breaking legitimate customers. Alert on repeated login/approval failures, anomalous proof uploads, order bursts and replay conflicts. Exact limits are production decisions and are not invented here.

## Dependency and supply-chain review

`npm audit` on 2026-10-03 reports 11 high findings, zero critical: two direct build-time tools (`electron-builder`, `vite-plugin-singlefile`) and their transitive chains (`app-builder-lib`, `dmg-builder`, `electron-builder-squirrel-windows`, `@electron/get`, `got`, `cacheable-request`, `http-cache-semantics`, `micromatch`, `braces`). npm's suggested remediations are semver-major/downgrade-shaped and were not applied blindly. The separately locked `brace-expansion` package is 5.0.12.

These advisories are currently in development/build tooling rather than the browser production dependency count, but Desktop artifact production and untrusted build inputs increase relevance. They remain an explicit release-owner acceptance/blocking item. Remediate on a dedicated branch by selecting maintained compatible versions, reviewing changelogs, running the entire regression/build/package matrix and re-auditing—never `npm audit fix --force`.

Controls: immutable `package-lock.json`, `npm ci`, Node 22 parity, repository-vendored `xlsx` tarball, protected branch review, minimal CI permissions, artifact checksums, signing outside Git, malware scanning and provenance/SBOM capture in controlled release CI. GitHub Actions are tag-pinned by major version rather than immutable commit SHA; pinning action SHAs is recommended before release. Installed-package inspection found two dependency lifecycle hooks: `esbuild@0.28.2` (`postinstall: node install.js`) and `electron-winstaller@5.4.0` (`install: node ./script/select-7z-arch.js`). Controlled CI must expect and monitor these binary/tool bootstrap steps; do not install dependencies from unreviewed lockfile changes.
