# Manual repository settings (GitHub, Vercel)

This file is the checklist for the changes that **cannot** be made from this
repository: they live in the GitHub and Vercel dashboards and need an
organisation owner or repository admin. Everything that *can* be checked from
the repository is checked — `npm run production:preflight` fails if the Pages
workflow comes back, if the environment template stops documenting
`VITE_APP_MODE`, or if the promotion workflow stops gating on the commercial
catalogue gate.

> **Why this file exists.** An automated attempt to change the repository's
> branch protection returned **HTTP 403** — the token in use has `repo` scope but
> not `admin:org`/administration rights, which is the normal, correct setup for
> a working agent. That refusal is not a defect to work around: those settings
> are the ones that protect `main`, so a non-admin credential *must* not be able
> to weaken them. A human with admin rights performs the steps below once.

---

## 1. Branch protection on `main` (do first)

GitHub → **Settings → Branches → Branch protection rules → Add rule** (or edit
the existing rule for `main`):

| Setting | Value | Why |
| --- | --- | --- |
| Branch name pattern | `main` | The only branch that deploys. |
| Require a pull request before merging | **on** | No direct pushes to a release branch. |
| Required approvals | **1** | A second pair of eyes on every migration or price change. |
| Dismiss stale pull request approvals when new commits are pushed | **on** | The approval must match the code. |
| Require review from Code Owners | on, if a `CODEOWNERS` file is added later | — |
| Require status checks to pass before merging | **on** | This is what makes CI a gate rather than a report. |
| Required checks | `Types, gate & build`, `Logic suites`, `Migrations & schema`, `E2E (jsdom) ×2` | The four always-on jobs in `.github/workflows/ci.yml`. Add `Live Supabase E2E` only after `ALYQ_LIVE_CI=true` and the `SUPABASE_TEST_*` secrets exist. |
| Require branches to be up to date before merging | **on** | A green run must be against the code being merged. |
| Require conversation resolution before merging | on | — |
| Require linear history | on (optional) | Keeps `git log` bisectable. |
| Require signed commits | off until signing is provisioned | Enabling it before every operator has a signing key blocks all work. |
| Do not allow bypassing the above settings | **on for administrators** | Otherwise the protection is advisory. |
| Restrict who can push | `main` deployer automation only, if any | — |
| Allow force pushes | **off** | A force push can orphan a released SHA. |
| Allow deletions | **off** | — |

Rulesets work too (**Settings → Rules → Rulesets → New branch ruleset**) and are
the newer surface; the same doors have to be enabled.

## 2. Remove GitHub Pages

The `Deploy to GitHub Pages` workflow was deleted from the repository, which
stops future deploys. The published site and its settings are separate:

1. **Settings → Pages →** set **Source** to **None** (or delete the `gh-pages`
   branch if one exists under **Branches**).
2. **Settings → Environments →** delete the stale `github-pages` environment so
   no job can request it again.
3. If a custom domain was configured on Pages, remove the DNS record pointing at
   `*.github.io` only after the managed host answers on the real domain.

Deleting the workflow without step 1 leaves an orphaned site serving an old
bundle on a GitHub-owned URL — the exact failure the removal exists to end.

## 3. Environments and secrets

| Name | Kind | Where | Value |
| --- | --- | --- | --- |
| `ALYQ_LIVE_CI` | Repository variable | Settings → Secrets and variables → Actions → Variables | `true` only when the live job should run |
| `SUPABASE_TEST_URL` | Secret | Actions secrets | Test project URL (`https://<ref>.supabase.co`) |
| `SUPABASE_TEST_ANON_KEY` | Secret | Actions secrets | Test project's anon/publishable key |
| `production` | Environment | Settings → Environments | Optional protection: required reviewers + deploy branch `main` |
| `SUPABASE_PROD_URL` | Secret | Actions secrets (used by `promote-production.yml`) | Production project URL |
| `SUPABASE_PROD_ANON_KEY` | Secret | Actions secrets (used by `promote-production.yml`) | The same anon/publishable key the storefront ships. **Not** a service key: a `sb_secret_…` or `service_role` value refuses to run the gate |
| `VERCEL_DEPLOY_HOOK_URL` | Secret | Actions secrets (used by `promote-production.yml`) | The project's deploy hook; the promotion's last job POSTs it and performs no other write |
| `ALLOW_EMPTY_STOREFRONT` | Repository variable | Settings → Secrets and variables → Actions → Variables | Leave **unset**. Set to exactly `true` only for the deliberate launch of a shop that has no sellable product yet — `TRUE`, `1` or `yes` fail the gate |

Never store the `service_role` key, the VAPID private key or database passwords
as Actions variables that a workflow passes to a front-end build; the
`npm run production:preflight` job fails if one appears in the shipped sources.

### The promotion workflow

`.github/workflows/promote-production.yml` (manual `workflow_dispatch`) is the only path
that deploys production, and it has three jobs in order:

1. **`catalogue-gate`** — `npm ci` then `npm run catalogue:gate` against
   `SUPABASE_PROD_URL` / `SUPABASE_PROD_ANON_KEY`. Read-only: two `POST …/rpc/storefront_*`
   calls with empty bodies, after the shipped SQL has been proven read-only. Fails when
   nothing is sellable, unless `ALLOW_EMPTY_STOREFRONT` is exactly `true`.
2. **`release`** (`needs: catalogue-gate`) — `VITE_APP_MODE=production` preflight,
   `check:production-guard --require-clean`, `npm run build`, then
   `release:probe --expect-sha`.
3. **`promote`** (`needs` both) — POSTs the Vercel deploy hook. Nothing in the workflow
   merges, pushes or writes to the database.

Inputs: `deploy` (default `true`; `false` runs the gate and the build without promoting) and
`catalogue_only` (runs the gate alone). The workflow holds a non-cancelling `concurrency`
group, so two promotions cannot race.

## 4. Actions permissions

**Settings → Actions → General**:

- **Fork pull request workflows**: leave the default (require approval for first
  run), so an untrusted fork cannot execute arbitrary steps against secrets.
- **Workflow permissions (GITHUB_TOKEN)**: **Read repository contents** — none of
  the CI jobs need write access. `gh pr merge` and releases are performed by a
  human or an operator token, not by the workflow.
- Leave "Allow GitHub Actions to create and approve pull requests" **off**.

## 5. Vercel (the managed host)

Project → **Settings**:

| Area | Setting | Value |
| --- | --- | --- |
| Build & Deployment → Build Command | `npm run build` | The same command CI verifies. |
| Build & Deployment → Output Directory | `dist` | `vite-plugin-singlefile` emits one self-contained `index.html` plus `release.json`. |
| Node.js Version | 22.x | Same major as CI; a different runtime is an untested build matrix. |
| Environment Variables | `VITE_APP_MODE` | `production` — **required, with no fallback**. A build that omits it fails with `APP_MODE_MISSING` instead of inferring a mode from the credentials. Every existing Vercel project needs this variable added once before its next deploy; `demo` is the only way to ask for the evaluation bundle. |
| Environment Variables | `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` | The production project URL and anon/publishable key. A missing or malformed pair now **fails the build** (`SUPABASE_UNCONFIGURED` / `SUPABASE_INCOMPLETE`), which is the point: a Vercel deploy with a half-configured environment cannot publish. |
| Environment Variables | `VITE_DEMO_SEED` | `off`. |
| Environment Variables | `VITE_APP_VERSION`, `VITE_BUILD_SHA` | From the frozen release; Vercel also exposes `VERCEL_GIT_COMMIT_SHA`, which can be passed through as `VITE_BUILD_SHA`. |
| Environment Variables | `WEB_PUSH_VAPID_PUBLIC_KEY` | Public P-256 key for Web Push. |
| Git | Production branch | `main`. Preview deploys may point at any branch — a preview is a demo-shaped artifact and must never be given production credentials. |
| Deployment Protection | enable for previews | Prevents an unreleased bundle from being indexed or linked. |

After the first deploy, verify it from outside the dashboard:

```bash
npm run release:probe -- --url https://<the-production-domain> --expect-sha "$(git rev-parse HEAD)"
```

The probe only ever issues `GET`/`HEAD` requests (`remoteProbePlan()`), reads
`release.json`, and checks that the served HTML carries the same commit. It
creates nothing.

## 6. Supabase dashboard (one-time, for completeness)

- **Authentication → URL configuration**: Site URL plus the exact redirect
  allow-list for the production domain and any custom domain. No wildcard on a
  privileged origin.
- **Authentication → Providers**: email/password enabled; sign-ups disabled for
  a closed installation unless onboarding self-service is intended.
- **Database → Backups**: confirm the schedule and that a restore has been
  rehearsed (`docs/production/backup-restore.md`).
- **Edge Functions → Secrets**: `WEB_PUSH_VAPID_PRIVATE_KEY`, `WEB_PUSH_SUBJECT`,
  `SUPABASE_SERVICE_ROLE_KEY`, `PUSH_DISPATCH_SECRET` — server-side only, never
  `VITE_*`.
