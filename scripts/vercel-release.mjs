#!/usr/bin/env node
/** Guarded release client. CLI output is captured, never dumped: a vendor error
 * must not expose env values or credentials. No tokens are written to artifacts.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseEnv } from 'node:util';
import { assertBuildEnvironment } from '../src/lib/config/application-mode.mjs';
import { inspectReleaseArtifact, artifactFiles, digest, assertNoFrontendSecrets } from './lib/release-artifact.mjs';
import { verifyGitHubRelease, assertAutomaticDeploymentsDisabled } from './lib/github-release-gate.mjs';
import { probeCatalogue } from './lib/catalogue-probe.mjs';
import { verifyCandidateRelease } from './lib/candidate-release.mjs';

const env = { ...process.env };
const vercel = (args) => {
  try {
    return execFileSync('npx', ['--yes', 'vercel@63.1.2', ...args, '--token', env.VERCEL_TOKEN], {
      encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 600_000,
    }).trim();
  } catch { throw new Error('Vercel release command failed; promotion blocked. Vendor output withheld for credential safety.'); }
};
try {
  let hostingPolicy;
  try { hostingPolicy = JSON.parse(fs.readFileSync('vercel.json', 'utf8')); }
  catch { throw new Error('Repository Vercel deployment policy unavailable or malformed.'); }
  assertAutomaticDeploymentsDisabled(hostingPolicy);
  for (const name of ['VERCEL_TOKEN', 'VERCEL_ORG_ID', 'VERCEL_PROJECT_ID']) {
    if (!env[name]) throw new Error(`Required protected release setting missing: ${name}`);
  }
  verifyGitHubRelease(env);
  const requested = assertBuildEnvironment(env);
  if (requested.mode !== 'production' || requested.environment !== 'production' || ['.invalid', '.test', '.example', '.localhost'].some((suffix) => new URL(requested.supabaseUrl).hostname.endsWith(suffix)) || ['example.com', 'example.net', 'example.org'].includes(new URL(requested.supabaseUrl).hostname)) {
    throw new Error('Commercial release requires real Production configuration.');
  }
  vercel(['pull', '--yes', '--environment=production']);
  // Vercel build uses its production environment, so validate THAT environment
  // too and require the same public configuration as the approved release.
  let pulledEnv;
  try { pulledEnv = parseEnv(fs.readFileSync('.vercel/.env.production.local', 'utf8')); }
  catch { throw new Error('Raw Vercel Production configuration unavailable or malformed.'); }
  const vercelEnv = { ...env, ...pulledEnv };
  const pulled = assertBuildEnvironment(pulledEnv);
  if (pulled.mode !== requested.mode || pulled.environment !== requested.environment || pulled.supabaseUrl !== requested.supabaseUrl || pulled.supabaseKey !== requested.supabaseKey) {
    throw new Error('Vercel and approved release public configuration disagree.');
  }
  vercel(['build', '--prod']);
  const identity = inspectReleaseArtifact(path.resolve('dist'), { gitSha: env.RELEASE_SHA, config: requested, env: vercelEnv });
  const staticDir = path.resolve('.vercel/output/static');
  for (const name of artifactFiles(path.resolve('dist'))) {
    const deployed = path.join(staticDir, name);
    if (!fs.existsSync(deployed) || digest(fs.readFileSync(deployed)) !== digest(fs.readFileSync(path.join('dist', name)))) {
      throw new Error('Vercel prebuilt artifact differs from the verified final build.');
    }
  }
  for (const name of artifactFiles(staticDir)) assertNoFrontendSecrets(fs.readFileSync(path.join(staticDir, name), 'utf8'), vercelEnv);
  await probeCatalogue(env);
  verifyGitHubRelease(env);
  // --skip-domain creates an immutable production candidate WITHOUT moving the
  // storefront domain. The domain is assigned only by the final promote call.
  const output = vercel(['deploy', '--prebuilt', '--prod', '--skip-domain', '--yes']);
  const urls = output.match(/https:\/\/[a-zA-Z0-9-]+\.vercel\.app/g) ?? [];
  if (!urls.length) throw new Error('Vercel candidate identity unavailable; no promotion performed.');
  const candidate = urls.at(-1);
  await verifyCandidateRelease(candidate, identity);
  await probeCatalogue(env); // stale/empty store cannot sneak through while staging
  verifyGitHubRelease(env); // last checkpoint, AFTER network checks
  vercel(['promote', candidate, '--yes']);
  console.log('Verified Production candidate promoted. Release identity is available in authenticated Health.');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
