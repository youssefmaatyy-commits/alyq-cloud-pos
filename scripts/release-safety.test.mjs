#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { JSDOM } from 'jsdom';
import { resolveApplicationConfig, assertBuildEnvironment } from '../src/lib/config/application-mode.mjs';
import { assertNoFrontendSecrets, inspectReleaseArtifact } from './lib/release-artifact.mjs';
import { assertReleaseChecks, REQUIRED_RELEASE_CHECKS, assertCIReleaseRun, assertReleaseEnvironment, assertAutomaticDeploymentsDisabled } from './lib/github-release-gate.mjs';
import { probeCatalogue } from './lib/catalogue-probe.mjs';
import { verifyCandidateRelease } from './lib/candidate-release.mjs';
import { testProductionEnv } from './lib/test-production-env.mjs';
import { waitForRoute } from './lib/ui-waits.mjs';

let passed = 0;
const test = async (label, fn) => { await fn(); passed += 1; console.log(`  ✓ release safety: ${label}`); };
const rejected = (env) => assert.equal(resolveApplicationConfig(env).ok, false);
const jwt = (role) => [
  Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'),
  Buffer.from(JSON.stringify({ role, iss: 'supabase' })).toString('base64url'), 'x'.repeat(43),
].join('.'); // synthetic, never a signed provider credential

await test('missing/unknown mode cannot select Demo, with or without Supabase', () => {
  for (const mode of [undefined, '', 'prod', 'Demo']) rejected({ ...testProductionEnv, VITE_APP_MODE: mode });
  rejected({});
});
await test('missing or malformed Production configuration is rejected', () => {
  for (const url of ['', 'not-a-url', 'http://project.invalid', 'https://user:pass@project.invalid', 'https://project.invalid/auth/v1', 'https://project.invalid?key=bad', 'https://localhost']) {
    rejected({ ...testProductionEnv, VITE_SUPABASE_URL: url });
  }
  for (const key of ['', 'invalid', 'sb_secret_' + 'x'.repeat(32), jwt('service_role'), jwt('authenticated')]) {
    rejected({ ...testProductionEnv, VITE_SUPABASE_ANON_KEY: key });
  }
});
await test('publishable and legacy anon keys accepted, legacy REST URL normalized', () => {
  assert.ok(resolveApplicationConfig(testProductionEnv).ok);
  assert.ok(resolveApplicationConfig({ ...testProductionEnv, VITE_SUPABASE_ANON_KEY: jwt('anon') }).ok);
  assert.ok(resolveApplicationConfig({ ...testProductionEnv, VITE_SUPABASE_URL: testProductionEnv.VITE_SUPABASE_URL + '/rest/v1' }).supabaseUrl === testProductionEnv.VITE_SUPABASE_URL);
  rejected({ ...testProductionEnv, VITE_SUPABASE_URL: 7 });
  rejected({ ...testProductionEnv, VITE_SUPABASE_ANON_KEY: {} });
});
await test('explicit Demo and tested VITE_DEMO_SEED deprecation path', () => {
  assert.ok(resolveApplicationConfig({ VITE_APP_MODE: 'demo' }).ok);
  rejected({ VITE_APP_MODE: 'demo', VITE_DEMO_SEED: 'off' });
  rejected({ VITE_DEMO_SEED: 'off' });
  assert.ok(resolveApplicationConfig({ ...testProductionEnv, VITE_DEMO_SEED: 'off' }).ok);
  assert.ok(resolveApplicationConfig({ VITE_APP_MODE: 'demo', VITE_DEMO_SEED: 'on' }).ok);
});
await test('unknown VITE values and mismatched environment labels refused', () => {
  assert.throws(() => assertBuildEnvironment({ ...testProductionEnv, VITE_UNAPPROVED: 'not-public' }));
  rejected({ ...testProductionEnv, VITE_RELEASE_ENVIRONMENT: 'demo' });
});
await test('frontend scanner rejects private keys and authority, permits only public anon', () => {
  for (const text of ['sb_secret_' + 'x'.repeat(32), jwt('service_role'), jwt('authenticated'), '-----BEGIN PRIVATE KEY-----', 'server-only-test-value']) {
    assert.throws(() => assertNoFrontendSecrets(text, { TEST_SECRET: 'server-only-test-value' }));
  }
  assertNoFrontendSecrets(jwt('anon'));
  const fixture = 'synthetic-only-opaque"value';
  assert.throws(() => assertNoFrontendSecrets(JSON.stringify(fixture), { RELEASE_TOKEN: fixture }));
  assert.throws(() => assertNoFrontendSecrets(encodeURIComponent(fixture), { RELEASE_TOKEN: fixture }));
});


await test('route readiness requires final redirects, current queries and applied consumed stock filters', async () => {
  // Mutable read stubs simulate the next render on the next polling pass. No
  // settle sleeps, second renderer, production globals or private query logs.
  const route = (path, hash, status) => {
    const reads = { hash: 0, status: 0 };
    return { reads, dom: { window: {
      location: { get hash() { return hash(++reads.hash); } },
      document: { querySelector(selector) {
        if (selector === '[data-testid="route-location"]') return { getAttribute: () => path };
        if (selector === 'select[aria-label="Status"]' && status) return { value: status(++reads.status) };
        if (selector === 'header, h1' || selector === 'main h1') return {};
        return null;
      } },
    } } };
  };
  const stock = route('/dashboard/inventory/stock', () => '#/dashboard/inventory/stock',
    (read) => read === 1 ? 'all' : 'low');
  await waitForRoute(stock.dom, '#/dashboard/inventory/stock?status=low');
  assert.ok(stock.reads.status >= 2, 'clearing the URL does not bypass the applied low-stock filter');
  const query = route('/store/account', (read) => read === 1
    ? '#/store/account?tab=profile' : '#/store/account?tab=orders');
  await waitForRoute(query.dom, '#/store/account?tab=orders');
  assert.ok(query.reads.hash >= 2, 'an existing pathname is not the new requested query');
  const redirect = route('/store/account', (read) => read === 1
    ? '#/store/v2/account?tab=orders' : '#/store/account?tab=orders');
  let normalized;
  await waitForRoute(redirect.dom, '#/store/v2/account?tab=orders', { normalizeStorePath(value) {
    normalized = value; return '/store/account?tab=orders';
  } });
  assert.equal(normalized, '/store/v2/account?tab=orders');
  assert.ok(redirect.reads.hash >= 2, 'a transient old-preview URL is not a completed redirect');

  const editor = route('/dashboard/online/website', () => '#/dashboard/online/website?tab=theme');
  let selectionReads = 0;
  editor.dom.window.document.querySelectorAll = (selector) => {
    if (selector !== 'button[data-settings-tab]') return [];
    const selected = ++selectionReads > 1;
    return [{ getAttribute: (name) => name === 'data-settings-tab' ? 'theme' : selected ? 'true' : 'false' }];
  };
  await waitForRoute(editor.dom, '#/dashboard/online/website?tab=theme');
  assert.ok(selectionReads >= 2, 'the correct hash/header do not bypass the newly selected appearance panel');

});


await test('Git auto-deployments cannot bypass required CI and the protected promotion workflow', () => {
  const config = JSON.parse(fs.readFileSync('vercel.json', 'utf8'));
  assertAutomaticDeploymentsDisabled(config);
  assert.equal(config.framework, 'vite');
  assert.equal(config.buildCommand, 'npm run build');
  assert.equal(config.outputDirectory, 'dist');
  for (const value of [undefined, true, 'false', {}, { main: false }]) {
    assert.throws(() => assertAutomaticDeploymentsDisabled({ git: { deploymentEnabled: value } }), /must be disabled/);
  }
  assert.throws(() => assertAutomaticDeploymentsDisabled({}), /must be disabled/);
});

const product = { id: 'synthetic-product', active: true, show_on_website: true, selling_price: 100, stock_tracking_enabled: true, stock_quantity: 1 };
const probe = (products, variants = [], overrides = {}, status = 200) => {
  const requests = [];
  return { requests, result: probeCatalogue({ ...testProductionEnv, ...overrides }, { fetchImpl: async (url, init) => {
    requests.push({ url, init });
    const rpc = new URL(url);
    const data = rpc.pathname.endsWith('/preview_storefront_pricing')
      ? { lines: JSON.parse(rpc.searchParams.get('p_lines')), total: 10 }
      : rpc.pathname.endsWith('/storefront_catalogue') ? products : variants;
    return new Response(JSON.stringify(data), { status });
  } }) };
};
await test('positive catalogue probe, anonymous read-only public RPCs only', async () => {
  const run = probe([product]);
  assert.equal((await run.result).sellableCount, 1);
  assert.ok(run.requests.length === 3 && run.requests.every(({ url, init }) => init.method === 'GET' && !init.body && /\/rpc\/(storefront_catalogue|storefront_branch_product_variants|preview_storefront_pricing)$/.test(new URL(url).pathname)));
});
await test('zero rows and zero sellable rows block commercial release', async () => {
  await assert.rejects(probe([]).result, /Zero sellable/);
  await assert.rejects(probe([{ ...product, stock_quantity: 0 }]).result, /Zero sellable/);
  await assert.rejects(probe([{ ...product, active: false }, { ...product, selling_price: 0 }]).result, /Zero sellable/);
});
await test('allow-empty is explicit and does not mask RPC failures', async () => {
  assert.equal((await probe([], [], { ALLOW_EMPTY_STOREFRONT: 'true' }).result).allowedEmpty, true);
  await assert.rejects(probe([], [], { ALLOW_EMPTY_STOREFRONT: 'false' }).result);
  await assert.rejects(probe([], [], { ALLOW_EMPTY_STOREFRONT: 'TRUE' }).result);
  await assert.rejects(probe([], [], { ALLOW_EMPTY_STOREFRONT: 'true' }, 500).result, /release blocked/);
});
await test('sellability respects exact variant stock/prices and untracked services', async () => {
  const variant = { id: 'synthetic-shelf', product_id: product.id, active: true, stock_quantity: 1, price_override: null };
  assert.equal((await probe([product], [variant]).result).sellableCount, 1);
  assert.equal((await probe([{ ...product, selling_price: 0 }], [{ ...variant, price_override: 25 }]).result).sellableCount, 1, 'positive exact override can sell independently of base price');
  await assert.rejects(probe([product], [{ ...variant, stock_quantity: 0 }]).result);
  await assert.rejects(probe([product], [{ ...variant, active: false }]).result);
  await assert.rejects(probe([{ ...product, variants_enabled: true }]).result);
  assert.equal((await probe([{ ...product, stock_tracking_enabled: false, stock_quantity: 0 }]).result).sellableCount, 1);
});

await test('release authorization requires every exact-SHA trusted CI check', () => {
  const sha = 'a'.repeat(40);
  const checks = REQUIRED_RELEASE_CHECKS.map((name) => ({ name, head_sha: sha, app: { slug: 'github-actions' }, details_url: 'https://github.com/test/repo/actions/runs/42/job/7', status: 'completed', conclusion: 'success', started_at: '2026-10-11T00:00:00Z' }));
  assertReleaseChecks(checks, sha, 42);
  for (const name of REQUIRED_RELEASE_CHECKS) {
    for (const conclusion of ['failure', 'cancelled', 'skipped', null]) {
      assert.throws(() => assertReleaseChecks(checks.map((check) => check.name === name ? { ...check, conclusion } : check), sha, 42));
    }
    assert.throws(() => assertReleaseChecks(checks.filter((check) => check.name !== name), sha, 42));
  }
  assert.throws(() => assertReleaseChecks(checks, 'b'.repeat(40), 42));
  assert.throws(() => assertReleaseChecks(checks, sha, 43));
  assert.throws(() => assertReleaseChecks(checks.map((check) => ({ ...check, app: { slug: 'untrusted' } })), sha, 42));
  assert.throws(() => assertReleaseChecks([...checks, { ...checks[0], conclusion: 'failure', started_at: '2026-10-11T01:00:00Z' }], sha, 42));
  assert.throws(() => assertReleaseChecks([...checks, { ...checks[0], details_url: 'https://github.com/test/repo/actions/runs/43/job/1', started_at: '2026-10-11T01:00:00Z' }], sha, 42), /Required release check/);
  assert.throws(() => assertReleaseChecks(checks.map((check) => ({ ...check, details_url: check.details_url.replace('github.com', 'untrusted.invalid') })), sha, 42));
  assert.throws(() => assertReleaseChecks(checks, sha, 42, 'different/repo'));

});

await test('untrusted CI events and unprotected Production environments cannot authorize promotion', () => {
  const sha = 'a'.repeat(40);
  const repository = 'test/repo';
  const run = { head_sha: sha, head_branch: 'main', event: 'push', name: 'CI', path: '.github/workflows/ci.yml', status: 'completed', conclusion: 'success', repository: { full_name: repository }, head_repository: { full_name: repository } };
  assertCIReleaseRun(run, sha, repository);
  for (const change of [{ head_branch: 'feature' }, { event: 'pull_request' }, { event: 'workflow_dispatch' }, { path: '.github/workflows/untrusted.yml' }, { status: 'in_progress' }, { conclusion: 'failure' }, { head_repository: { full_name: 'untrusted/fork' } }]) {
    assert.throws(() => assertCIReleaseRun({ ...run, ...change }, sha, repository));
  }
  const environment = { can_admins_bypass: false, protection_rules: [{ type: 'required_reviewers', prevent_self_review: false, reviewers: [{ type: 'User', reviewer: { login: 'owner' } }] }], deployment_branch_policy: { custom_branch_policies: true, protected_branches: false } };
  const policies = { branch_policies: [{ name: 'main', type: 'branch' }] };
  assertReleaseEnvironment(environment, policies);
  assertReleaseEnvironment({ ...environment, protection_rules: [{ ...environment.protection_rules[0], prevent_self_review: true }] }, policies);
  assert.throws(() => assertReleaseEnvironment({ ...environment, protection_rules: [] }, policies));
  assert.throws(() => assertReleaseEnvironment({ ...environment, protection_rules: [{ ...environment.protection_rules[0], reviewers: [] }] }, policies));
  assert.throws(() => assertReleaseEnvironment({ ...environment, can_admins_bypass: true }, policies));
  assert.throws(() => assertReleaseEnvironment({ ...environment, can_admins_bypass: undefined }, policies));
  assert.throws(() => assertReleaseEnvironment(environment, { branch_policies: [{ name: '*', type: 'branch' }] }));
  assert.throws(() => assertReleaseEnvironment(environment, { branch_policies: [{ name: 'main', type: 'tag' }] }));
});
await test('candidate served identity must match the verified exact SHA/build/environment', async () => {
  const expected = { appMode: 'production', builtAt: '2026-10-11T00:00:00.000Z', environment: 'production', gitSha: 'a'.repeat(40) };
  let request;
  const fetchImpl = async (url, init) => { request = { url, init }; return new Response(JSON.stringify(expected)); };
  await verifyCandidateRelease('https://isolated-candidate.vercel.app', expected, { fetchImpl });
  assert.equal(request.url, 'https://isolated-candidate.vercel.app/release.json');
  assert.equal(request.init.method, 'GET');
  assert.deepEqual(request.init.headers, { Accept: 'application/json' });
  for (const change of [{ gitSha: 'b'.repeat(40) }, { environment: 'demo' }, { appMode: 'demo' }, { builtAt: '2026-10-10T00:00:00.000Z' }]) {
    await assert.rejects(verifyCandidateRelease('https://isolated-candidate.vercel.app', expected, { fetchImpl: async () => new Response(JSON.stringify({ ...expected, ...change })) }));
  }
  await assert.rejects(verifyCandidateRelease('https://isolated-candidate.vercel.app', expected, { fetchImpl: async () => new Response('', { status: 401 }) }));
  await assert.rejects(verifyCandidateRelease('https://untrusted.invalid', expected, { fetchImpl }));
});
await test('positive rollup without selectable shelves and pricing RPC failures block release even with allow-empty', async () => {
  for (const allow of ['true', 'false']) {
    await assert.rejects(probeCatalogue({ ...testProductionEnv, ALLOW_EMPTY_STOREFRONT: allow }, { fetchImpl: async (url) => {
      const rpc = new URL(url).pathname;
      if (rpc.endsWith('/storefront_catalogue')) return new Response(JSON.stringify([product]));
      if (rpc.endsWith('/storefront_branch_product_variants')) return new Response('[]');
      return new Response('{}', { status: 400 }); // all variants archived; no selectable plain shelf
    } }), /release blocked/);
  }
});

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'alyq-release-safety-'));
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('VITE_')));
const build = (env, output) => spawnSync(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--outDir', output], {
  cwd: process.cwd(), env: { ...cleanEnv, ...env }, encoding: 'utf8', timeout: 180_000,
});
const waitFor = async (condition) => {
  const end = Date.now() + 8_000;
  while (!condition()) {
    if (Date.now() > end) throw new Error('Built bootstrap did not reach its expected state.');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};
async function boot(html, hash = '#/', expectError = false) {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: `https://test.invalid/${hash}`, runScripts: 'outside-only', pretendToBeVisual: true });
  const calls = [];
  dom.window.fetch = async (url) => { calls.push(url); return new Response('[]', { headers: { 'content-type': 'application/json' } }); };
  dom.window.scrollTo = () => {};
  dom.window.TextEncoder = globalThis.TextEncoder;
  dom.window.TextDecoder = globalThis.TextDecoder;
  dom.window.Request = globalThis.Request;
  dom.window.Response = globalThis.Response;
  dom.window.Headers = globalThis.Headers;
  dom.window.console.error = () => {};
  const script = [...html.matchAll(/<script[^>]*type="module"[^>]*>([\s\S]*?)<\/script>/g)].map((match) => match[1]).join('\n');
  assert.ok(script.length > 1000, 'test executes the actual singlefile production JavaScript');
  try { dom.window.eval(script.replaceAll("import.meta.url", JSON.stringify("https://test.invalid/index.html"))); } catch (error) { error.stack = `Built bootstrap: ${error.name}`; throw new Error("Built bootstrap evaluation failed", { cause: error }); }
  await waitFor(() => dom.window.document.querySelector(expectError ? '[data-testid="production-configuration-error"]' : '[data-testid="route-location"]'));
  return { dom, calls };
}
try {
  await test('actual Vite production build fails closed before creating an artifact', () => {
    for (const env of [{}, { VITE_APP_MODE: 'production' }, { ...testProductionEnv, VITE_SUPABASE_ANON_KEY: 'malformed' }, { VITE_APP_MODE: 'demo', VITE_DEMO_SEED: 'off' }]) {
      const output = path.join(temporary, 'rejected');
      assert.ok(build(env, output).status !== 0);
      assert.ok(!fs.existsSync(path.join(output, 'index.html')));
    }
  });
  let productionHtml;
  await test('final Production artifact has exact checkout SHA, mode and no private credentials', () => {
    const output = path.join(temporary, 'production');
    const run = build(testProductionEnv, output);
    if (run.status !== 0) throw new Error('Production fixture build failed. Run the isolated build to diagnose.');
    const gitSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const identity = inspectReleaseArtifact(output, { gitSha, config: resolveApplicationConfig(testProductionEnv) });
    assert.equal(identity.appMode, 'production');
    productionHtml = fs.readFileSync(path.join(output, 'index.html'), 'utf8');
    fs.appendFileSync(path.join(output, 'index.html'), '<!-- tampered -->');
    assert.throws(() => inspectReleaseArtifact(output, { gitSha, config: resolveApplicationConfig(testProductionEnv) }), /integrity/);
  });
  await test('actual Production bootstrap cannot become a local Demo storefront', async () => {
    const { dom } = await boot(productionHtml);
    assert.ok(!dom.window.document.querySelector('[data-testid="application-mode-banner"]'));
    assert.ok(!Object.keys(dom.window.localStorage).some((key) => key.startsWith('alyq.demo.')));
    dom.window.close();
  });
  await test('malformed embedded config blocks Login/POS/Admin/Checkout before providers mount', async () => {
    const broken = productionHtml.replaceAll(testProductionEnv.VITE_SUPABASE_ANON_KEY, 'malformed');
    for (const hash of ['#/login', '#/dashboard/pos', '#/dashboard/settings', '#/store/checkout', '#/']) {
      const { dom, calls } = await boot(broken, hash, true);
      assert.equal(calls.length, 0);
      assert.equal(dom.window.localStorage.length, 0);
      assert.ok(!dom.window.document.querySelector('input, form, aside, [data-testid="route-location"]'));
      dom.window.close();
    }
  });
  await test('explicit final Demo artifact is labelled in UI and installable identity', async () => {
    const output = path.join(temporary, 'demo');
    assert.equal(build({ VITE_APP_MODE: 'demo' }, output).status, 0);
    const html = fs.readFileSync(path.join(output, 'index.html'), 'utf8');
    assert.ok(JSON.parse(fs.readFileSync(path.join(output, 'mobile.webmanifest'), 'utf8')).name.includes('DEMO'));
    const { dom } = await boot(html, '#/login');
    assert.ok(dom.window.document.querySelector('[data-testid="application-mode-banner"]')?.textContent.includes('Not for real transactions'));
    dom.window.close();
  });
} finally { fs.rmSync(temporary, { recursive: true, force: true }); }
console.log(`\n${passed}/${passed} release-safety checks passed\n`);
