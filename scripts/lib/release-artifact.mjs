import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { isPublicSupabaseKey } from '../../src/lib/config/application-mode.mjs';

export const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
export function artifactFiles(directory) {
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) throw new Error('Symlinks are not permitted in a release artifact.');
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) files.push(path.relative(directory, full).split(path.sep).join('/'));
    }
  };
  walk(directory);
  return files.sort();
}

export function assertNoFrontendSecrets(text, env = {}) {
  if (/sb_secret_[A-Za-z0-9_-]+|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text)) {
    throw new Error('Frontend artifact contains a private credential.');
  }
  for (const jwt of text.match(/[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{32,}/g) ?? []) {
    if (!isPublicSupabaseKey(jwt)) throw new Error('Frontend artifact contains a non-anonymous credential.');
  }
  for (const [name, value] of Object.entries(env)) {
    if (/(SECRET|PASSWORD|PRIVATE|SERVICE_ROLE|(?:^|_)TOKEN(?:$|_))/.test(name)
      && typeof value === 'string' && value.length >= 8
      && [value, JSON.stringify(value).slice(1, -1), encodeURIComponent(value)].some((encoded) => text.includes(encoded))) {
      throw new Error('Frontend artifact contains a server-only environment value.');
    }
  }
}

export function releaseIdentity(root, config, env) {
  const gitSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  if (!/^[a-f0-9]{40}$/.test(gitSha) || (env.VITE_BUILD_SHA && env.VITE_BUILD_SHA !== gitSha)) {
    throw new Error('Release SHA must match the checked-out commit.');
  }
  return { gitSha, builtAt: new Date().toISOString(), environment: config.environment, appMode: config.mode };
}

export function inspectReleaseArtifact(directory, { gitSha, config, env = {} }) {
  const readJson = (name) => {
    try { return JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8')); }
    catch { throw new Error('Final release metadata/integrity unavailable or malformed.'); }
  };
  const identity = readJson('release.json');
  if (Object.keys(identity).sort().join() !== ['appMode', 'builtAt', 'environment', 'gitSha'].sort().join()
      || identity.gitSha !== gitSha || !/^[a-f0-9]{40}$/.test(identity.gitSha)
      || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(identity.builtAt)
      || identity.appMode !== config.mode || identity.environment !== config.environment) {
    throw new Error('Built release identity does not match the checkout and application mode.');
  }
  const integrity = readJson('build-integrity.json');
  const names = artifactFiles(directory).filter((name) => name !== 'build-integrity.json');
  if (names.join() !== Object.keys(integrity).sort().join()
      || names.some((name) => integrity[name] !== digest(fs.readFileSync(path.join(directory, name))))) {
    throw new Error('Final artifact integrity verification failed.');
  }
  const html = fs.readFileSync(path.join(directory, 'index.html'), 'utf8');
  if (!html.includes(`name="alyq-app-mode" content="${config.mode}"`) || !html.includes(identity.gitSha)
      || !html.includes(identity.builtAt) || !html.includes('production-configuration-error')) {
    throw new Error('Final HTML is missing its mode, release identity or fail-closed bootstrap.');
  }
  if (config.mode === 'production' && (!html.includes(config.supabaseUrl) || !html.includes(config.supabaseKey))) {
    throw new Error('Final artifact does not contain the validated public backend configuration.');
  }
  if (config.mode === 'demo' && !html.includes('DEMO — Local test data')) {
    throw new Error('Demo artifact is not visibly labelled.');
  }
  for (const name of names) assertNoFrontendSecrets(fs.readFileSync(path.join(directory, name), 'utf8'), env);
  return identity;
}

export function releaseBuildPlugin(root, identity, env) {
  let directory;
  return {
    name: 'alyq-release-safety',
    apply: 'build',
    configResolved(config) { directory = path.resolve(root, config.build.outDir); },
    transformIndexHtml: {
      order: 'post',
      handler() { return [{ tag: 'meta', attrs: { name: 'alyq-app-mode', content: identity.appMode }, injectTo: 'head' }]; },
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'release.json', source: JSON.stringify(identity, null, 2) + '\n' });
    },
    closeBundle() {
      // Inspect AFTER singlefile inlining and public-asset copying, not just source.
      const manifestPath = path.join(directory, 'mobile.webmanifest');
      if (identity.appMode === 'demo' && fs.existsSync(manifestPath)) {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        manifest.name = 'ALYQ DEMO — Not for real transactions';
        manifest.short_name = 'ALYQ DEMO';
        fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
      }
      const integrity = {};
      for (const name of artifactFiles(directory).filter((name) => name !== 'build-integrity.json')) {
        const bytes = fs.readFileSync(path.join(directory, name));
        assertNoFrontendSecrets(bytes.toString('utf8'), env);
        integrity[name] = digest(bytes);
      }
      fs.writeFileSync(path.join(directory, 'build-integrity.json'), JSON.stringify(integrity, null, 2) + '\n');
    },
  };
}
