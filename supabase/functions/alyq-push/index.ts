/**
 * alyq-push — bounded FCM HTTP v1 and APNs delivery worker.
 *
 * The database owns recipient authorization, current branch/capability checks,
 * installation/token custody, retries and immutable attempt evidence. This
 * worker can only claim a bounded batch and report a provider-safe result. It
 * never queries profiles or accepts recipients/payloads from the request.
 *
 * Invoke with the dedicated PUSH_DISPATCH_SECRET bearer. Gateway JWT verification
 * must be disabled for this function because this handler performs the exact
 * secret check itself. SUPABASE_SERVICE_ROLE_KEY is internal database authority
 * only and is explicitly rejected as invocation authority. Required secret names:
 *
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, PUSH_DISPATCH_SECRET
 *   FCM_PROJECT_ID, FCM_CLIENT_EMAIL, FCM_PRIVATE_KEY
 *   APNS_TEAM_ID, APNS_KEY_ID, APNS_PRIVATE_KEY, APNS_TOPIC, APNS_ENVIRONMENT
 *
 * Never put any of these values in the database, app bundle or logs.
 */
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import {
  classifyApnsResponse,
  classifyFcmResponse,
  classifyNetworkFailure,
  retryDelaySeconds,
  type ClassifiedPushResult,
} from "./providers.ts";
import { isDispatchAuthorized, selectDispatchBatchLimits } from "./request.ts";

const MAX_BODY_BYTES = 4 * 1024;
const MAX_PROVIDER_BODY_BYTES = 16 * 1024;
const MAX_CLAIM = 100;
const MAX_EVENTS = 25;
const SEND_CONCURRENCY = 10;
const REQUEST_TIMEOUT_MS = 12_000;
const CHANNEL_ID = "alyq_operational";

interface ClaimedDelivery {
  delivery_id: string;
  notification_id: string;
  platform: "android" | "ios";
  locale: string;
  push_token: string;
  kind: string;
  title: string;
  body: string;
  route_key: string;
  entity_id: string;
  collapse_key: string;
  attempt_number: number;
}

interface WorkerConfig {
  supabaseUrl: string;
  serviceRoleKey: string;
  dispatchSecret: string;
  fcmProjectId: string | null;
  fcmClientEmail: string | null;
  fcmPrivateKey: string | null;
  apnsTeamId: string | null;
  apnsKeyId: string | null;
  apnsPrivateKey: string | null;
  apnsTopic: string | null;
  apnsEnvironment: "production" | "sandbox";
}

class WorkerError extends Error {
  constructor(readonly code: string, message: string, readonly status = 500) {
    super(message);
  }
}

const JSON_HEADERS = { "content-type": "application/json", "cache-control": "no-store" };

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function env(name: string): string | null {
  return Deno.env.get(name)?.trim() || null;
}

function loadConfig(): WorkerConfig {
  const supabaseUrl = env("SUPABASE_URL");
  const serviceRoleKey = env("SUPABASE_SERVICE_ROLE_KEY");
  const dispatchSecret = env("PUSH_DISPATCH_SECRET");
  if (!supabaseUrl || !serviceRoleKey || !dispatchSecret) {
    throw new WorkerError(
      "not_configured",
      "SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and PUSH_DISPATCH_SECRET must be set",
    );
  }
  if (dispatchSecret === serviceRoleKey) {
    throw new WorkerError("not_configured", "PUSH_DISPATCH_SECRET must differ from SUPABASE_SERVICE_ROLE_KEY");
  }
  const apnsEnvironment = env("APNS_ENVIRONMENT");
  if (apnsEnvironment && apnsEnvironment !== "production" && apnsEnvironment !== "sandbox") {
    throw new WorkerError("not_configured", "APNS_ENVIRONMENT must be production or sandbox");
  }
  return {
    supabaseUrl,
    serviceRoleKey,
    dispatchSecret,
    fcmProjectId: env("FCM_PROJECT_ID"),
    fcmClientEmail: env("FCM_CLIENT_EMAIL"),
    fcmPrivateKey: env("FCM_PRIVATE_KEY"),
    apnsTeamId: env("APNS_TEAM_ID"),
    apnsKeyId: env("APNS_KEY_ID"),
    apnsPrivateKey: env("APNS_PRIVATE_KEY"),
    apnsTopic: env("APNS_TOPIC"),
    apnsEnvironment: apnsEnvironment === "sandbox" ? "sandbox" : "production",
  };
}

async function authorize(req: Request, config: WorkerConfig): Promise<void> {
  const authorization = req.headers.get("authorization");
  if (!await isDispatchAuthorized(authorization, config.dispatchSecret, config.serviceRoleKey)) {
    throw new WorkerError("forbidden", "Push dispatcher authorization required", 403);
  }
}

function base64Url(value: Uint8Array | string): string {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function pemBytes(pem: string): Uint8Array {
  const normalized = pem.replace(/\\n/g, "\n");
  const encoded = normalized.replace(/-----BEGIN [^-]+-----|-----END [^-]+-----|\s/g, "");
  if (!encoded) throw new WorkerError("provider_not_configured", "Provider private key is invalid");
  const binary = atob(encoded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function signedJwt(
  header: Record<string, unknown>,
  claims: Record<string, unknown>,
  privateKey: string,
  algorithm: "RS256" | "ES256",
): Promise<string> {
  const input = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(claims))}`;
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemBytes(privateKey),
    algorithm === "RS256"
      ? { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }
      : { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    algorithm === "RS256" ? "RSASSA-PKCS1-v1_5" : { name: "ECDSA", hash: "SHA-256" },
    key,
    new TextEncoder().encode(input),
  );
  return `${input}.${base64Url(new Uint8Array(signature))}`;
}

let fcmAccessToken: { value: string; expiresAt: number } | null = null;
let fcmAccessTokenPromise: Promise<string> | null = null;
async function refreshFcmAccessToken(config: WorkerConfig): Promise<string> {
  if (!config.fcmClientEmail || !config.fcmPrivateKey) {
    throw new WorkerError("fcm_not_configured", "FCM credentials are not configured");
  }
  const now = Math.floor(Date.now() / 1000);
  const assertion = await signedJwt(
    { alg: "RS256", typ: "JWT" },
    {
      iss: config.fcmClientEmail,
      scope: "https://www.googleapis.com/auth/firebase.messaging",
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    },
    config.fcmPrivateKey,
    "RS256",
  );
  const response = await timedFetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  const body = await safeJson(response);
  const token = typeof body.access_token === "string" ? body.access_token : "";
  if (!response.ok || !token) throw new WorkerError("fcm_auth_unavailable", "FCM authorization failed");
  const expiresIn = typeof body.expires_in === "number" ? body.expires_in : 3600;
  fcmAccessToken = { value: token, expiresAt: Date.now() + Math.max(300, expiresIn - 60) * 1000 };
  return token;
}

async function getFcmAccessToken(config: WorkerConfig): Promise<string> {
  if (fcmAccessToken && fcmAccessToken.expiresAt > Date.now() + 60_000) return fcmAccessToken.value;
  if (fcmAccessTokenPromise) return fcmAccessTokenPromise;
  fcmAccessTokenPromise = refreshFcmAccessToken(config);
  try {
    return await fcmAccessTokenPromise;
  } finally {
    fcmAccessTokenPromise = null;
  }
}

let apnsProviderToken: { value: string; expiresAt: number } | null = null;
let apnsProviderTokenPromise: Promise<string> | null = null;
async function refreshApnsProviderToken(config: WorkerConfig): Promise<string> {
  if (!config.apnsTeamId || !config.apnsKeyId || !config.apnsPrivateKey) {
    throw new WorkerError("apns_not_configured", "APNs credentials are not configured");
  }
  const now = Math.floor(Date.now() / 1000);
  const value = await signedJwt(
    { alg: "ES256", kid: config.apnsKeyId },
    { iss: config.apnsTeamId, iat: now },
    config.apnsPrivateKey,
    "ES256",
  );
  apnsProviderToken = { value, expiresAt: Date.now() + 50 * 60_000 };
  return value;
}

async function getApnsProviderToken(config: WorkerConfig): Promise<string> {
  if (apnsProviderToken && apnsProviderToken.expiresAt > Date.now() + 5 * 60_000) return apnsProviderToken.value;
  if (apnsProviderTokenPromise) return apnsProviderTokenPromise;
  apnsProviderTokenPromise = refreshApnsProviderToken(config);
  try {
    return await apnsProviderTokenPromise;
  } finally {
    apnsProviderTokenPromise = null;
  }
}

async function timedFetch(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function safeJson(response: Response): Promise<Record<string, unknown>> {
  const text = (await response.text()).slice(0, MAX_PROVIDER_BODY_BYTES);
  if (!text) return {};
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function safeData(delivery: ClaimedDelivery): Record<string, string> {
  return {
    notification_id: delivery.notification_id,
    kind: delivery.kind,
    route_key: delivery.route_key,
    entity_id: delivery.entity_id,
  };
}

async function sendFcm(config: WorkerConfig, delivery: ClaimedDelivery): Promise<ClassifiedPushResult> {
  if (!config.fcmProjectId) throw new WorkerError("fcm_not_configured", "FCM project is not configured");
  const accessToken = await getFcmAccessToken(config);
  const response = await timedFetch(
    `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(config.fcmProjectId)}/messages:send`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
      body: JSON.stringify({
        message: {
          token: delivery.push_token,
          notification: { title: delivery.title, body: delivery.body },
          data: safeData(delivery),
          android: {
            collapse_key: delivery.collapse_key,
            priority: "HIGH",
            ttl: "300s",
            notification: { channel_id: CHANNEL_ID, click_action: "ALYQ_NOTIFICATION_OPEN" },
          },
        },
      }),
    },
  );
  const body = await safeJson(response);
  const result = classifyFcmResponse(response.status, body, response.headers.get("retry-after"));
  if (result.errorCode === "unauthenticated") fcmAccessToken = null;
  return result;
}

async function sendApns(config: WorkerConfig, delivery: ClaimedDelivery): Promise<ClassifiedPushResult> {
  if (!config.apnsTopic) throw new WorkerError("apns_not_configured", "APNs topic is not configured");
  const providerToken = await getApnsProviderToken(config);
  const host = config.apnsEnvironment === "sandbox" ? "api.sandbox.push.apple.com" : "api.push.apple.com";
  const response = await timedFetch(`https://${host}/3/device/${encodeURIComponent(delivery.push_token)}`, {
    method: "POST",
    headers: {
      authorization: `bearer ${providerToken}`,
      "content-type": "application/json",
      "apns-topic": config.apnsTopic,
      "apns-push-type": "alert",
      "apns-priority": "10",
      "apns-expiration": String(Math.floor(Date.now() / 1000) + 300),
      "apns-collapse-id": delivery.collapse_key.slice(0, 64),
    },
    body: JSON.stringify({
      aps: {
        alert: { title: delivery.title, body: delivery.body },
        sound: "default",
        category: "ALYQ_NOTIFICATION_OPEN",
        "thread-id": delivery.kind,
      },
      ...safeData(delivery),
    }),
  });
  const body = await safeJson(response);
  const result = classifyApnsResponse(
    response.status,
    body,
    response.headers.get("retry-after"),
    response.headers.get("apns-id"),
  );
  if (result.errorCode === "expiredprovidertoken") apnsProviderToken = null;
  return result;
}

async function reportResult(
  client: SupabaseClient,
  workerId: string,
  delivery: ClaimedDelivery,
  result: ClassifiedPushResult,
): Promise<boolean> {
  const retryAfter = result.outcome === "retry"
    ? retryDelaySeconds(delivery.attempt_number, result.retryAfterSeconds)
    : null;
  const { error } = await client.rpc("notification_record_push_result", {
    p_delivery_id: delivery.delivery_id,
    p_worker: workerId,
    p_outcome: result.outcome,
    p_http_status: result.httpStatus,
    p_error_code: result.errorCode,
    p_provider_reference: result.providerReference,
    p_retry_after_seconds: retryAfter,
  });
  return !error;
}

async function processDelivery(
  client: SupabaseClient,
  config: WorkerConfig,
  workerId: string,
  delivery: ClaimedDelivery,
): Promise<{ outcome: ClassifiedPushResult["outcome"]; recorded: boolean }> {
  let result: ClassifiedPushResult;
  try {
    result = delivery.platform === "android"
      ? await sendFcm(config, delivery)
      : await sendApns(config, delivery);
  } catch (error) {
    result = error instanceof WorkerError
      ? {
          outcome: "retry",
          httpStatus: null,
          errorCode: error.code,
          retryAfterSeconds: retryDelaySeconds(delivery.attempt_number, null),
          providerReference: null,
        }
      : classifyNetworkFailure(delivery.attempt_number);
  }
  return { outcome: result.outcome, recorded: await reportResult(client, workerId, delivery, result) };
}

async function runPool<T, R>(items: T[], concurrency: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const output = new Array<R>(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      output[index] = await task(items[index]);
    }
  });
  await Promise.all(runners);
  return output;
}

async function handler(req: Request): Promise<Response> {
  if (req.method !== "POST") return jsonResponse(405, { ok: false, code: "method_not_allowed" });
  try {
    const config = loadConfig();
    await authorize(req, config);
    const declaredLength = Number(req.headers.get("content-length") ?? 0);
    if (declaredLength > MAX_BODY_BYTES) throw new WorkerError("request_too_large", "Request body is too large", 413);
    const text = await req.text();
    if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) {
      throw new WorkerError("request_too_large", "Request body is too large", 413);
    }
    let payload: Record<string, unknown> = {};
    if (text) {
      try {
        const parsed: unknown = JSON.parse(text);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) payload = parsed as Record<string, unknown>;
      } catch {
        throw new WorkerError("invalid_request", "Request body must be JSON", 400);
      }
    }
    const { limit, eventLimit } = selectDispatchBatchLimits(payload, MAX_CLAIM, MAX_EVENTS);
    const workerId = `alyq-push-${crypto.randomUUID()}`;
    const client = createClient(config.supabaseUrl, config.serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data, error } = await client.rpc("notification_claim_push_batch", {
      p_worker: workerId,
      p_limit: limit,
      p_event_limit: eventLimit,
    });
    if (error) throw new WorkerError("claim_failed", "The delivery batch could not be claimed");
    const deliveries = (Array.isArray(data) ? data : []) as ClaimedDelivery[];
    const results = await runPool(deliveries, SEND_CONCURRENCY, (delivery) =>
      processDelivery(client, config, workerId, delivery));
    const outcomes = { delivered: 0, retry: 0, invalid_token: 0, permanent_failure: 0 };
    let recordFailures = 0;
    for (const result of results) {
      outcomes[result.outcome] += 1;
      if (!result.recorded) recordFailures += 1;
    }
    // Counts only: no token, recipient, notification copy, provider body or credential.
    console.info(JSON.stringify({ component: "alyq-push", claimed: deliveries.length, outcomes, record_failures: recordFailures }));
    return jsonResponse(recordFailures ? 207 : 200, {
      ok: recordFailures === 0,
      claimed: deliveries.length,
      outcomes,
      record_failures: recordFailures,
    });
  } catch (error) {
    const known = error instanceof WorkerError ? error : new WorkerError("worker_failed", "Push worker failed");
    console.error(JSON.stringify({ component: "alyq-push", code: known.code }));
    return jsonResponse(known.status, { ok: false, code: known.code });
  }
}

Deno.serve(handler);
