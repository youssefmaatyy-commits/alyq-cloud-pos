export type PushOutcome = "delivered" | "retry" | "invalid_token" | "permanent_failure";

export interface ClassifiedPushResult {
  outcome: PushOutcome;
  httpStatus: number | null;
  errorCode: string | null;
  retryAfterSeconds: number | null;
  providerReference: string | null;
}

const TRANSIENT_HTTP = new Set([408, 425, 429, 500, 502, 503, 504]);
const FCM_TRANSIENT = new Set(["INTERNAL", "QUOTAEXCEEDED", "UNAVAILABLE", "UNAUTHENTICATED"]);
// The worker emits a fixed valid payload, so INVALID_ARGUMENT at the messaging
// endpoint denotes a malformed registration token rather than arbitrary client data.
const FCM_INVALID_TOKEN = new Set(["UNREGISTERED", "INVALIDARGUMENT", "SENDERIDMISMATCH"]);
const APNS_TRANSIENT = new Set([
  "EXPIREDPROVIDERTOKEN",
  "INTERNALSERVERERROR",
  "SERVICEUNAVAILABLE",
  "SHUTDOWN",
  "TOOMANYPROVIDERTOKENUPDATES",
  "TOOMANYREQUESTS",
]);
const APNS_INVALID_TOKEN = new Set(["BADDEVICETOKEN", "DEVICETOKENNOTFORTOPIC", "UNREGISTERED"]);

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function normalizedCode(value: unknown): string {
  return typeof value === "string" ? value.replace(/[^a-z0-9]/gi, "").toUpperCase() : "";
}

/** Parse Retry-After without ever accepting an unbounded provider delay. */
export function parseRetryAfterSeconds(value: string | null, nowMs = Date.now()): number | null {
  if (!value) return null;
  const numeric = Number(value.trim());
  if (Number.isFinite(numeric) && numeric >= 0) return Math.min(3600, Math.ceil(numeric));
  const at = Date.parse(value);
  if (!Number.isFinite(at)) return null;
  return Math.min(3600, Math.max(0, Math.ceil((at - nowMs) / 1000)));
}

/** Capped exponential delay with deterministic-in-tests bounded jitter. */
export function retryDelaySeconds(
  attemptNumber: number,
  providerRetryAfter: number | null,
  randomUnit = Math.random(),
): number {
  const attempt = Math.min(10, Math.max(1, Math.trunc(attemptNumber) || 1));
  const exponential = Math.min(3600, 15 * (2 ** (attempt - 1)));
  const jitter = 0.75 + (Math.min(1, Math.max(0, randomUnit)) * 0.5);
  const localDelay = Math.ceil(exponential * jitter);
  return Math.min(3600, Math.max(localDelay, providerRetryAfter ?? 0));
}

function fcmCode(body: unknown): string {
  const error = record(record(body).error);
  const details = Array.isArray(error.details) ? error.details : [];
  for (const detail of details) {
    const code = normalizedCode(record(detail).errorCode);
    if (code) return code;
  }
  return normalizedCode(error.status || error.message);
}

export function classifyFcmResponse(
  status: number,
  body: unknown,
  retryAfterHeader: string | null,
): ClassifiedPushResult {
  if (status >= 200 && status < 300) {
    const name = record(body).name;
    return {
      outcome: "delivered",
      httpStatus: status,
      errorCode: null,
      retryAfterSeconds: null,
      providerReference: typeof name === "string" ? name.slice(0, 500) : null,
    };
  }

  const code = fcmCode(body) || `HTTP_${status}`;
  if (FCM_INVALID_TOKEN.has(code)) {
    return { outcome: "invalid_token", httpStatus: status, errorCode: code.toLowerCase(), retryAfterSeconds: null, providerReference: null };
  }
  if (TRANSIENT_HTTP.has(status) || FCM_TRANSIENT.has(code)) {
    return {
      outcome: "retry",
      httpStatus: status,
      errorCode: code.toLowerCase(),
      retryAfterSeconds: parseRetryAfterSeconds(retryAfterHeader),
      providerReference: null,
    };
  }
  return { outcome: "permanent_failure", httpStatus: status, errorCode: code.toLowerCase(), retryAfterSeconds: null, providerReference: null };
}

export function classifyApnsResponse(
  status: number,
  body: unknown,
  retryAfterHeader: string | null,
  apnsId: string | null,
): ClassifiedPushResult {
  if (status === 200) {
    return {
      outcome: "delivered",
      httpStatus: status,
      errorCode: null,
      retryAfterSeconds: null,
      providerReference: apnsId?.slice(0, 500) ?? null,
    };
  }
  const code = normalizedCode(record(body).reason) || `HTTP${status}`;
  if (APNS_INVALID_TOKEN.has(code)) {
    return { outcome: "invalid_token", httpStatus: status, errorCode: code.toLowerCase(), retryAfterSeconds: null, providerReference: null };
  }
  if (TRANSIENT_HTTP.has(status) || APNS_TRANSIENT.has(code)) {
    return {
      outcome: "retry",
      httpStatus: status,
      errorCode: code.toLowerCase(),
      retryAfterSeconds: parseRetryAfterSeconds(retryAfterHeader),
      providerReference: null,
    };
  }
  return { outcome: "permanent_failure", httpStatus: status, errorCode: code.toLowerCase(), retryAfterSeconds: null, providerReference: null };
}

export function classifyNetworkFailure(attemptNumber: number): ClassifiedPushResult {
  return {
    outcome: "retry",
    httpStatus: null,
    errorCode: "network_error",
    retryAfterSeconds: retryDelaySeconds(attemptNumber, null),
    providerReference: null,
  };
}
