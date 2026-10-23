import assert from "node:assert/strict";
import {
  compareVersions, fetchLatestRelease, OFFICIAL_RELEASES_URL, RELEASES_API_URL,
} from "../services/releaseCheck";

let passed = 0;
function test(name: string, run: () => void | Promise<void>) {
  return Promise.resolve(run()).then(() => { passed++; console.log(`✓ ${name}`); });
}

await test("SemVer checks stable releases and prerelease precedence", () => {
  assert.equal(compareVersions("6.1.0", "6.0.9"), 1);
  assert.equal(compareVersions("6.0.0", "6.0.0-preview.1"), 1);
  assert.equal(compareVersions("6.0.0-preview.2", "6.0.0-preview.10"), -1);
  assert.equal(compareVersions("6.0.0-alpha", "6.0.0-beta"), -1);
  assert.equal(compareVersions("v6.0.0+build.3", "6.0.0"), 0);
  assert.equal(compareVersions("latest", "6.0.0"), null);
});

await test("release check uses only the pinned GitHub repository and ignores API-supplied links", async () => {
  let requested = "";
  const result = await fetchLatestRelease(async (input, init) => {
    requested = String(input);
    assert.equal(init?.redirect, "error");
    assert.equal(init?.cache, "no-store");
    return new Response(JSON.stringify({ tag_name: "v6.2.0", html_url: "https://attacker.example/fake" }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  });
  assert.equal(requested, RELEASES_API_URL);
  assert.deepEqual(result, { version: "6.2.0", url: OFFICIAL_RELEASES_URL });
});

await test("invalid response and HTTP failures are rejected rather than treated as update metadata", async () => {
  await assert.rejects(() => fetchLatestRelease(async () => new Response("{}", { status: 200 })));
  await assert.rejects(() => fetchLatestRelease(async () => new Response("{}", { status: 403 })));
});

console.log(`${passed}/3 release-check tests passed`);
