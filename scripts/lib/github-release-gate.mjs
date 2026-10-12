import { execFileSync } from 'node:child_process';
export const REQUIRED_RELEASE_CHECKS = Object.freeze(['Types & build', 'Logic suites', 'Migrations & schema', 'E2E (jsdom)', 'Release gate']);

/** Check names alone are not authority. Also reject a newer check/rerun rather
 * than resurrecting an older success on the same SHA. */
export function assertReleaseChecks(checks, sha, runId, repository) {
  if (!/^[a-f0-9]{40}$/.test(sha) || !/^\d+$/.test(String(runId))) throw new Error('Invalid release identity.');
  for (const name of REQUIRED_RELEASE_CHECKS) {
    const matching = checks.filter((check) => check.name === name && check.head_sha === sha && check.app?.slug === 'github-actions')
      .sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at));
    const latest = matching[0];
    let trustedUrl = false;
    try {
      const url = new URL(latest?.details_url);
      trustedUrl = url.protocol === 'https:' && url.hostname === 'github.com' && !url.username && !url.password
        && (repository ? url.pathname.startsWith(`/${repository}/actions/runs/${runId}/`) : new RegExp(`^/[^/]+/[^/]+/actions/runs/${runId}/`).test(url.pathname));
    } catch { /* fail closed */ }
    if (!latest || !trustedUrl || latest.status !== 'completed' || latest.conclusion !== 'success') {
      throw new Error(`Required release check not successful: ${name}`);
    }
  }
}

export function assertCIReleaseRun(run, sha, repository) {
  if (run.head_sha !== sha || run.head_branch !== 'main' || run.event !== 'push'
      || run.name !== 'CI' || run.path !== '.github/workflows/ci.yml'
      || run.status !== 'completed' || run.conclusion !== 'success'
      || run.repository?.full_name !== repository || run.head_repository?.full_name !== repository) {
    throw new Error('Release requires a successful trusted push CI run on the current main commit.');
  }
}

export function assertReleaseEnvironment(environment, policies) {
  const reviewers = environment.protection_rules?.find((rule) => rule.type === 'required_reviewers');
  if (!reviewers?.prevent_self_review || !reviewers.reviewers?.length
      || !environment.deployment_branch_policy?.custom_branch_policies
      || environment.deployment_branch_policy?.protected_branches
      || policies.branch_policies?.length !== 1 || policies.branch_policies[0].name !== 'main'
      || policies.branch_policies[0].type !== 'branch') {
    throw new Error('Production environment must require independent reviewers and allow only the main branch.');
  }
}

export function verifyGitHubRelease(env = process.env) {
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  if (sha !== env.RELEASE_SHA) throw new Error('Checkout does not match the approved CI commit.');
  const repository = env.GITHUB_REPOSITORY;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? '')) throw new Error('GitHub repository identity required.');
  const api = (endpoint) => {
    try { return JSON.parse(execFileSync('gh', ['api', endpoint], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })); }
    catch { throw new Error('GitHub release authorization unavailable; promotion blocked.'); }
  };
  if (api(`repos/${repository}/git/ref/heads/main`).object?.sha !== sha) throw new Error('Main advanced; this release candidate is stale.');
  const run = api(`repos/${repository}/actions/runs/${env.RELEASE_CI_RUN_ID}`);
  assertCIReleaseRun(run, sha, repository);
  const checks = api(`repos/${repository}/commits/${sha}/check-runs?per_page=100`);
  assertReleaseChecks(checks.check_runs ?? [], sha, env.RELEASE_CI_RUN_ID, repository);
  assertReleaseEnvironment(api(`repos/${repository}/environments/vercel-production`), api(`repos/${repository}/environments/vercel-production/deployment-branch-policies`));
  console.log('Protected GitHub release authorization verified for the exact current main commit.');
}
