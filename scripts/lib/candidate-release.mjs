/** Nonsecret verification of the immutable candidate's served release identity.
 * No bypass credential, customer data, cookie or authorization header is used.
 * Deployment protection/network/identity failures stop promotion, never bypass it.
 */
export async function verifyCandidateRelease(candidate, expected, { fetchImpl = globalThis.fetch } = {}) {
  try {
    const url = new URL(candidate);
    if (url.protocol !== 'https:' || !/^[a-z0-9-]+\.vercel\.app$/.test(url.hostname)
        || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('INVALID_CANDIDATE');
    const response = await fetchImpl(new URL('/release.json', url).toString(), {
      method: 'GET', redirect: 'error', signal: AbortSignal.timeout(15_000), headers: { Accept: 'application/json' },
    });
    if (!response.ok) throw new Error('CANDIDATE_UNAVAILABLE');
    const text = await response.text();
    if (text.length > 8192) throw new Error('INVALID_METADATA');
    const actual = JSON.parse(text);
    const keys = ['appMode', 'builtAt', 'environment', 'gitSha'];
    if (!actual || Object.keys(actual).sort().join() !== keys.join()
        || keys.some((key) => actual[key] !== expected[key])) throw new Error('IDENTITY_MISMATCH');
  } catch {
    throw new Error('Candidate release identity unavailable or mismatched; promotion blocked.');
  }
}
