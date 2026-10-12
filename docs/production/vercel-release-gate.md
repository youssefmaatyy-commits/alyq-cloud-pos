# Protected Vercel Production promotion

## Status and limits (2026-10-11)

Repository enforcement is implemented, but provider administration is **NOT verified complete**. No production deployment, domain promotion, Supabase write, seeding or destructive QA was performed in this audit.

- Refetched `main`: `c2cca7aa9863b08b5edda50a12f4c5c7a350530c`; no newer commit at inspection. Unrelated PR #16 is preserved.
- GitHub branch-protection inspection returned HTTP 403 (`Resource not accessible by integration`). This is an authorization limitation, not evidence that protections exist or do not exist.
- GitHub environments returned the existing Pages/Preview/Production variants **with empty protection rules**. `vercel-production` was not listed. The guarded client checks the environment via the API and blocks until independent reviewers and the exact main-only branch policy exist.
- Pages inspection returned HTTP 404 and its old deployment job failed. The unsupported Pages publishing workflow was removed, not replaced with an unlabelled Demo site.
- Repository `vercel.json` disables automatic Git deployment for **every branch**, and the guarded client rejects a checkout that re-enables it. This closes the repository-configured Git bypass; manual/provider administrator privileges still require the checks below.
- A Vercel Git deployment status on the earlier `d7b2a57` PR commit failed while both GitHub CI runs passed. The status did not supply build diagnostics accessible here; it is not treated as commercial validation. No fallback configuration or private credential was added to make it green.
- Direct Vercel project-setting inspection was unavailable in this session. Git integration, production domains, RBAC and automatic promotion remain administrator-owned facts.

A green PR is code-validation evidence, **not** commercial GO or proof that external settings have been applied.

## Administrator prerequisites — mandatory before enabling promotion

1. In GitHub, protect `main` (ruleset/branch protection): require a PR and independent review, disallow direct/force pushes and deletion, require up-to-date checks, apply rules to administrators where supported. Required checks must be GitHub Actions checks with these **exact names**:
   - `Types & build`
   - `Logic suites`
   - `Migrations & schema`
   - `E2E (jsdom)`
   - `Release gate`
2. Create the GitHub environment **`vercel-production`**. Require at least one independent reviewer, enable **prevent self-review**, disable administrator bypass where supported. Choose custom deployment-branch policy with **only `main` of type branch**, not a wildcard, tag or other branch. This policy is checked by the release client, not merely assumed from the YAML environment name.
3. Put the public approved Supabase URL/key and Vercel organization/project IDs in that environment's variables. Put the Vercel deployment credential in its protected secret store only. Do not enter secrets in chat, source, `.env.example`, PRs, logs or browser settings. The workflow exposes the deployment token only to the guarded release-client step, not installation or tests.
4. In the **actual `alyq-store` Vercel project**, disable/disconnect automatic Git **Production** deployments/domain assignment. Keep this repository’s `git.deploymentEnabled=false`; it intentionally disables both Production and PR auto-publication. Use the guarded candidate path, or a separately reviewed isolated preview project/workflow that cannot assign the commercial domain. Do not re-enable Git publication in this checkout merely to obtain a preview check. Do not leave an independent Vercel Git push-to-main path that can bypass GitHub checks or approval. If using provider-native required checks instead, independently demonstrate that they block both automatic Production and manual promotion; a Vercel preview/comment check or GitHub branch protection alone is insufficient. This workflow is designed as the sole Production path.
5. Restrict direct Production deploy/promote access and token custody to the approved release operators. Review manual CLI/dashboard, deploy hooks and other workflow credentials; remove bypass paths. A repository cannot stop a separately privileged provider administrator from bypassing it.
6. Set Vercel's **Production** public environment explicitly: `VITE_APP_MODE=production`, `VITE_RELEASE_ENVIRONMENT=production`, approved HTTPS Supabase URL/public key, optional deprecated `VITE_DEMO_SEED=off`, and the approved presentation/push-public settings. Do not manually pin an obsolete `VITE_BUILD_SHA`; it is derived from the checkout (an explicit override must match). Ensure only the documented allowlisted `VITE_*` names are exposed; disable automatic browser-prefix exposure of additional provider/system values if it adds unapproved names.
7. Keep `ALLOW_EMPTY_STOREFRONT=false` for an existing commercial store. An exact `true` is an exceptional, recorded approval for a genuinely new/staging empty store, not a way to mask a broken catalogue/RPC.
8. Confirm the immutable Production candidate can serve its **nonsecret** `/release.json` to the guarded read-only identity check. HTTP 401/403, unavailable metadata or mismatched SHA/time/environment blocks promotion; do not add a bypass token or weaken deployment protection to hide failure. Agree an approved provider configuration for this observation before GO.
9. Record screenshots/settings evidence containing **names, not values**, reviewer, date, project/domain IDs and a staging negative-release drill. Freeze main changes during the final promotion checkpoint/observation window.

## What the workflows/client enforce

`ci.yml` always runs types, lint, final build/preflight, all logic/release-safety tests, isolated database/schema/RLS tests and **all 31 E2E suites twice**. `Release gate` depends on all four component jobs and refuses failed, cancelled or skipped dependencies. There are no excluded suites, retry-on-failure allowances or production writers.

`promote-production.yml` requests the protected environment only after a successful **push CI run on main in this repository**. PR/fork/manual-run events cannot request production credentials. It checks out that run's exact SHA, reruns the complete gate and probes the actual public storefront.

`scripts/vercel-release.mjs`:

1. Rejects missing/malformed `vercel.json` or a Git auto-deployment policy other than the literal all-branches `false`; verifies checkout SHA equals the approved CI SHA and current main; the CI run has the trusted workflow path, repository/event/branch and completed success.
2. Verifies all five **latest**, exact-SHA, GitHub-Actions checks belong to the approved run. Missing/failed/cancelled/skipped/in-progress checks, newer failed/rerun checks, wrong run/SHA/app and untrusted details URLs are rejected.
3. Verifies independent environment reviewers, no self-review and main-only deployment-branch policy. Missing/inaccessible protection evidence blocks release.
4. Requires real Production configuration; uses pinned Vercel CLI `63.1.2` to pull Production settings. Parses the **raw pulled file**, avoiding ambient environment overrides that could hide a mismatch. Requires the same mode/environment/public backend pair as the approved release.
5. Builds, validates `dist` metadata, copied-file integrity and frontend-secret scans, verifies every final `dist` file exactly matches Vercel's prebuilt static output, and scans additional static files too.
6. Runs an anonymous read-only commercial catalogue check; rechecks GitHub authorization.
7. Deploys `--prebuilt --prod --skip-domain`: an immutable candidate **without assigning the Production domain**. There is no domain-moving deployment before authorization.
8. Requires the **served candidate** release metadata to match the verified artifact's SHA, build timestamp, mode and environment. Reprobes the catalogue, rechecks current main/checks/environment immediately before `vercel promote`.

CLI/provider stdout/stderr is withheld on errors so credentials cannot escape through vendor messages. `.vercel/` (including pulled environment files) is ignored. No provider call was executed here except non-authenticated CLI help to validate supported deployment/promotion flags.

These checkpoints reduce stale-release risk but cannot make a GitHub reference read and a separate provider promotion atomic; the approved main freeze and operator monitoring remain required. If main advances, the client refuses the stale candidate at its next check. Candidates left behind after refusal are not assigned the commercial domain.

## Read-only catalogue contract

`npm run production:catalogue` makes only bounded anonymous **GET** requests to existing STABLE public RPCs:

- `storefront_catalogue`
- `storefront_branch_product_variants`
- `preview_storefront_pricing` for one eligible representative/exact variant

It checks active/web-visible products, positive price, stock tracking/untracked service semantics and exact active variant stock/override prices. A pricing read prevents a positive aggregate stock row with no selectable active shelf from being treated as proof of a plain product. Zero eligible products blocks commercial release unless the exact approved allow-empty exception is active. Exceptions never hide malformed/unavailable RPCs or invalid representative pricing. Output is counts only; no names, SKU/customer/order data, URLs, headers or raw provider responses.

This is a **stock-on-hand/public selectability readiness check**, not an availability-to-promise guarantee under concurrent reservations. It deliberately does not read private reservations/customers/orders or place a test order. Atomic checkout remains authoritative. A conservative representative-pricing refusal blocks the release even if another product might sell; investigate rather than weaken the check.

Positive, negative, allow-empty, RPC-failure, exact-variant and served-candidate cases use isolated stubs. CI's `.invalid` pair is only an offline build contract and never substitutes for the real promotion probe.

## Negative release drill / acceptance evidence

In an isolated staging project/environment, demonstrate that each of a failed E2E/type/build/logic/database job, cancelled/skipped check, stale SHA, unprotected environment, wrong pulled backend pair, wrong candidate metadata and zero sellable catalogue prevents **domain movement**. Confirm the last approved deployment remains served. Never run mutation fixtures or seed the real store as part of this proof.

Until that provider drill, protections, real read-only probe and business sign-off are evidenced, commercial status is **NO-GO**, regardless of local/PR check colors.

## Repository Git-deployment configuration source

Vercel's [pinned primary `GitConfig` declaration](https://github.com/vercel/vercel/blob/c628be7835e03a965b93e9cf9e2bd5ac2acbf5eb/packages/config/src/types.ts#L203-L212) supports `deploymentEnabled` as a boolean or branch map. This patch uses the global boolean **false**, not a main-only map that defaults other branches to true. The policy is covered by positive/negative tests; it does not disable type, build, logic, database, E2E or aggregate GitHub checks, and it is not an assertion that provider RBAC/settings are verified.
