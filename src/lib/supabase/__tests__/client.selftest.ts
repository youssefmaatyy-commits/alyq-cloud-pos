/**
 * Supabase client URL regression tests (headless, no project required).
 *
 * These exercise the real supabase-js URL construction with a recording fetch.
 * A deployment that still configures VITE_SUPABASE_URL as its old PostgREST
 * endpoint must invoke Edge Functions from the project root, never under
 * `/rest/v1`.
 */
import assert from "node:assert/strict";
import { createSupabaseClient, SUPABASE_AUTH_OPTIONS, toSupabaseProjectUrl } from "../client";

type TestCase = { name: string; fn: () => void | Promise<void> };
const tests: TestCase[] = [];
const test = (name: string, fn: () => void | Promise<void>) => tests.push({ name, fn });

interface CapturedRequest {
  url: string;
  headers: Headers;
  body: string | null;
}

function recordingClient(configuredUrl = "https://project-under-test.supabase.co/rest/v1") {
  const requests: CapturedRequest[] = [];
  const client = createSupabaseClient(configuredUrl, "test-anon-key", {
    fetch: async (input, init) => {
      const url = input instanceof URL ? input.href : typeof input === "string" ? input : input.url;
      requests.push({
        url,
        headers: new Headers(init?.headers),
        body: typeof init?.body === "string" ? init.body : null,
      });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  });
  return { client, requests };
}

test("the shared Web/Desktop/Mobile client persists and auto-refreshes sessions", () => {
  assert.deepEqual(SUPABASE_AUTH_OPTIONS, {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  });
});

test("a project URL stays a project URL and a legacy REST URL is reduced to its project root", () => {
  assert.equal(
    toSupabaseProjectUrl("https://project-under-test.supabase.co"),
    "https://project-under-test.supabase.co",
  );
  assert.equal(
    toSupabaseProjectUrl(" https://project-under-test.supabase.co/rest/v1/ "),
    "https://project-under-test.supabase.co",
  );
  assert.equal(
    toSupabaseProjectUrl("https://project-under-test.supabase.co/rest/v1?unused=value#fragment"),
    "https://project-under-test.supabase.co",
  );
});

test("alyq-auth and alyq-admin use project-root Edge Function URLs with unchanged invoke payloads and headers", async () => {
  const { client, requests } = recordingClient();
  const authBody = { action: "login", payload: { identifier: "cashier", password: "CorrectHorse1" } };
  const adminBody = { action: "reset_password", payload: { user_id: "user-1", password: "NewPassword1" } };

  await client.functions.invoke("alyq-auth", { body: authBody });
  await client.functions.invoke("alyq-admin", { body: adminBody });

  assert.deepEqual(
    requests.map((request) => request.url),
    [
      "https://project-under-test.supabase.co/functions/v1/alyq-auth",
      "https://project-under-test.supabase.co/functions/v1/alyq-admin",
    ],
  );
  assert.equal(
    requests.some((request) => request.url.includes("/rest/v1/functions/v1/")),
    false,
    "Edge Function URLs can never be constructed beneath the REST endpoint",
  );
  assert.deepEqual(requests.map((request) => JSON.parse(request.body ?? "null")), [authBody, adminBody]);
  for (const request of requests) {
    assert.equal(request.headers.get("content-type"), "application/json");
    assert.equal(request.headers.get("apikey"), "test-anon-key");
    assert.equal(request.headers.get("authorization"), "Bearer test-anon-key");
  }
});

test("the same legacy REST configuration no longer duplicates /rest/v1 for PostgREST callers", async () => {
  const { client, requests } = recordingClient();
  await client.from("profiles").select("id");

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://project-under-test.supabase.co/rest/v1/profiles?select=id");
  assert.equal(requests[0].url.includes("/rest/v1/rest/v1/"), false);
});

let passed = 0;
let failed = 0;
for (const { name, fn } of tests) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`  ✗ ${name}`);
    console.error(`    ${error instanceof Error ? error.message : String(error)}`);
  }
}

console.log(`\n${passed}/${tests.length} Supabase client URL tests passed.`);
if (failed > 0) process.exit(1);
