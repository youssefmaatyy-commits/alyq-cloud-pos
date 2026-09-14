/**
 * alyq-auth — username sign-in and username recovery for real-email accounts.
 *
 * Supabase Auth is email-shaped, and this project's staff accounts carry their
 * REAL email in `auth.users` — that is what makes Forgot Password, recovery
 * mail and account administration work. The sign-in screen, however, asks for a
 * username. Something has to turn "admin" into the address Supabase Auth knows,
 * and it cannot be the browser: `profiles` is RLS'd to self-or-oversight, and
 * an anonymous username → email lookup is exactly the enumeration oracle this
 * project must not build.
 *
 * So the resolution happens here, per request, and only here:
 *
 *   · `login   {identifier, password}`   — resolve, then let Supabase Auth
 *     verify the password (`signInWithPassword`); return session tokens or a
 *     generic refusal. The browser adopts the session with `auth.setSession`
 *     and continues exactly as after a normal email sign-in.
 *   · `recover {identifier, redirect_to}` — resolve, then let Supabase send its
 *     own recovery email to the resolved real address. The public answer is
 *     identical whether or not the identifier exists.
 *
 * ── The trust model ────────────────────────────────────────────────────────
 * This function is pre-authentication by nature, so `verify_jwt` is OFF for it
 * (deploy with `--no-verify-jwt`). What makes that safe:
 *
 *   1. It holds no admin power. The service role is used for exactly two reads
 *      and one revocation: resolve `profiles.username` → uid, read that user's
 *      Auth email, and sign out a session that must never leave this function.
 *      It never returns a profile, an email, or any account-admin action.
 *   2. The password is transient. It arrives in the request body, is handed to
 *      GoTrue's own password grant, and is never logged, stored, echoed back or
 *      written to any audit trail. The response carries tokens only on success.
 *   3. Supabase Auth stays the credential authority. A wrong password fails
 *      here exactly as it fails on the direct email path — this function adds
 *      no verification logic of its own, it only removes the email from public
 *      view.
 *   4. Every failure is generic. "No such username", "wrong password" and
 *      "unmapped account" all cost one provider password check (unknown
 *      identifiers are checked against a deterministic `@alyq.invalid`
 *      sinkhole) and all answer `invalid_credentials`, so neither the response
 *      nor its timing is a directory of who works here. The one honest
 *      exception mirrors the existing app behaviour: `user_inactive` is
 *      reported only AFTER the password proved correct — the same code the
 *      browser path has always returned, to the person who owns the account.
 *   5. The active-user gate runs here, not in the browser: a direct call that
 *      skips the app still gets no tokens for a deactivated account, and any
 *      session GoTrue issued for it is revoked before the response leaves.
 *   6. Abuse resistance: a best-effort per-IP attempt limiter (12 logins /
 *      5 recoveries per 10 minutes per isolate) runs before any provider call,
 *      on top of GoTrue's own rate limits. Honest caveat: server-side sign-ins
 *      share this function's egress IP at GoTrue, so platform auth limits see
 *      one client — acceptable for a staff-sized team, and the limiter above
 *      keys on the real caller IP (`x-forwarded-for`) so an attacker is cut
 *      off before exhausting it. Isolate restarts reset the counter; this is a
 *      speed bump, not a vault.
 *
 * ── What this function deliberately does not do ────────────────────────────
 *   · No audit rows (mirrors `alyq-admin`): GoTrue already logs auth events,
 *     and nothing here may put a password, token or recovery address in a log.
 *   · No trust in `redirect_to`: it must be an absolute http(s) URL, and
 *     Supabase's own Redirect URLs allow-list decides whether it is honoured.
 *   · No username shape oracle: an identifier that matches nobody is not
 *     rejected for its shape — it is checked against the sinkhole and fails
 *     like any other wrong credential.
 *
 * ── Deploying ──────────────────────────────────────────────────────────────
 *   supabase functions deploy alyq-auth --no-verify-jwt
 *
 * `SUPABASE_URL`, `SUPABASE_ANON_KEY` are injected by the runtime;
 * `SUPABASE_SERVICE_ROLE_KEY` is the project-wide secret already set for
 * `alyq-admin`. No migration accompanies this function: username uniqueness
 * (`profiles_username_key`), the profiles RLS and `handle_new_user` all stay
 * exactly as migrations 0011–0036 built them.
 */
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";

/** A request body has no business being large; refusing early is cheap. */
const MAX_BODY_BYTES = 8 * 1024;
const MAX_IDENTIFIER_LENGTH = 320;
/** Longer than any real password and shorter than a body-sized "password". */
const MAX_PASSWORD_LENGTH = 256;
/**
 * `.invalid` is reserved by RFC 2606 and can never receive mail: the sinkhole
 * absorbs credential checks for identifiers that resolve to nobody, so an
 * unknown username costs the same provider call — and takes about the same
 * time — as a known one with a wrong password.
 */
const SINKHOLE_DOMAIN = "alyq.invalid";

// ── best-effort abuse resistance ─────────────────────────────────────────────
const ATTEMPT_WINDOW_MS = 10 * 60 * 1000;
const ATTEMPT_LIMITS: Record<string, number> = { login: 12, recover: 5 };
const attempts = new Map<string, number[]>();

function rateLimited(action: string, ip: string, now = Date.now()): boolean {
  const limit = ATTEMPT_LIMITS[action] ?? 10;
  const key = `${action}:${ip}`;
  const seen = (attempts.get(key) ?? []).filter((at) => now - at < ATTEMPT_WINDOW_MS);
  seen.push(now);
  attempts.set(key, seen);
  if (attempts.size > 10_000) {
    for (const [k, window] of attempts) {
      if (window.every((at) => now - at >= ATTEMPT_WINDOW_MS)) attempts.delete(k);
    }
  }
  return seen.length > limit;
}

const CORS_HEADERS: Record<string, string> = {
  // The boundary here is not the origin — there is no token to check before
  // authentication. The boundary is that this function can only ever answer
  // "valid credentials" or a generic refusal, at a limited rate.
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// ── errors ───────────────────────────────────────────────────────────────────
/**
 * Codes are the app's existing vocabulary (`invalid_credentials`,
 * `user_inactive`, `rate_limited`, …) so the login screen can show them
 * without learning a new language.
 */
class RequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly field?: string,
  ) {
    super(message);
  }
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "content-type": "application/json" },
  });
}

function reject(error: RequestError): Response {
  return jsonResponse(error.status, {
    ok: false,
    error: { code: error.code, message: error.message, field: error.field ?? null },
  });
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function clientIp(req: Request): string {
  const forwarded = req.headers.get("x-forwarded-for") ?? "";
  return forwarded.split(",")[0]?.trim() || "unknown";
}

/** Deterministic per-identifier sinkhole address (djb2, base-36). */
function sinkholeEmail(identifier: string): string {
  let hash = 5381;
  for (let i = 0; i < identifier.length; i += 1) {
    hash = ((hash << 5) + hash + identifier.charCodeAt(i)) >>> 0;
  }
  return `unknown-${hash.toString(36)}@${SINKHOLE_DOMAIN}`;
}

// ── the request context ──────────────────────────────────────────────────────
interface Context {
  /** Service role: identity resolution and session revocation, nothing else. */
  admin: SupabaseClient;
  /** Anon: the provider's own public endpoints (password grant, recovery). */
  anon: SupabaseClient;
}

function buildContext(): Context {
  const url = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !anonKey || !serviceKey) {
    throw new RequestError(
      500,
      "not_configured",
      "SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY must all be set",
    );
  }
  return {
    // Neither client keeps a session: an isolate that remembered somebody's
    // tokens would be a leak between requests.
    admin: createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } }),
    anon: createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } }),
  };
}

interface ResolvedIdentifier {
  /** The address Supabase Auth will be asked about; null when nobody matches. */
  email: string | null;
  profileId: string | null;
  profileActive: boolean | null;
}

/**
 * Identifier → the email Supabase Auth knows.
 *
 * An `@` means the caller typed an address: use it as-is (lowercased, the
 * project's email comparison rule). A bare username is looked up in `profiles`
 * under the project's normalization — trim + lowercase, the same rule the
 * unique index `lower(btrim(username))` enforces — and then resolved to the
 * AUTH user's email, because `auth.users` is the credential authority and
 * `profiles.email` is an admin-maintained copy that could lag behind it.
 */
async function resolveIdentifier(context: Context, identifier: string): Promise<ResolvedIdentifier> {
  const handle = identifier.trim();
  if (handle.includes("@")) {
    return { email: handle.toLowerCase(), profileId: null, profileActive: null };
  }
  const lowered = handle.toLowerCase();
  const { data: profile } = await context.admin
    .from("profiles")
    .select("id, active")
    .in("username", lowered === handle ? [lowered] : [lowered, handle])
    .maybeSingle();
  if (!profile) return { email: null, profileId: null, profileActive: null };
  const { data: authUser } = await context.admin.auth.admin.getUserById(String(profile.id));
  const email = authUser?.user?.email?.trim().toLowerCase() || null;
  return {
    email,
    profileId: String(profile.id),
    profileActive: (profile.active as boolean | null) ?? null,
  };
}

// ── actions ──────────────────────────────────────────────────────────────────
async function login(context: Context, payload: Record<string, unknown>): Promise<Response> {
  const identifier =
    typeof payload.identifier === "string"
      ? payload.identifier.trim().slice(0, MAX_IDENTIFIER_LENGTH)
      : "";
  const password = typeof payload.password === "string" ? payload.password : "";
  if (!identifier) throw new RequestError(400, "invalid_request", "identifier is required", "identifier");
  if (!password) throw new RequestError(400, "missing_password", "password is required", "password");
  if (password.length > MAX_PASSWORD_LENGTH) {
    throw new RequestError(400, "invalid_request", "That password is too long", "password");
  }

  const resolved = await resolveIdentifier(context, identifier);
  // Every attempt costs exactly one provider password check — including a
  // username nobody owns, which is checked against the sinkhole — so neither
  // the answer nor its timing distinguishes the two failures.
  const email = resolved.email ?? sinkholeEmail(identifier);
  const attempt = await context.anon.auth.signInWithPassword({ email, password });
  const session = attempt.error ? null : attempt.data?.session ?? null;
  const authUser = attempt.error ? null : attempt.data?.user ?? null;
  if (!session || !authUser) {
    return jsonResponse(400, { ok: false, code: "invalid_credentials" });
  }

  // The password is proven; only now does the account's state get to matter.
  // This gate lives in the function, not in the browser: a direct call that
  // skips the app still gets no tokens for a deactivated or profile-less
  // account, and the session GoTrue just issued is revoked before we answer.
  let hasProfile = resolved.profileId !== null;
  let active = resolved.profileActive;
  if (!hasProfile) {
    const { data: profile } = await context.admin
      .from("profiles")
      .select("id, active")
      .eq("id", authUser.id)
      .maybeSingle();
    hasProfile = Boolean(profile);
    active = (profile?.active as boolean | null) ?? null;
  }
  if (!hasProfile) {
    // A token is not an identity: no usable profile, no session released.
    await context.admin.auth.admin.signOut(authUser.id).catch(() => undefined);
    return jsonResponse(400, { ok: false, code: "invalid_credentials" });
  }
  if (active === false) {
    await context.admin.auth.admin.signOut(authUser.id).catch(() => undefined);
    return jsonResponse(403, { ok: false, code: "user_inactive" });
  }

  // Tokens only. Never the email, never the profile: the browser learns who it
  // is from its own authenticated reads after `setSession`, exactly as after a
  // normal email sign-in.
  return jsonResponse(200, {
    ok: true,
    session: {
      access_token: session.access_token,
      refresh_token: session.refresh_token,
      expires_in: session.expires_in,
      token_type: session.token_type,
    },
  });
}

async function recover(context: Context, payload: Record<string, unknown>): Promise<Response> {
  const identifier =
    typeof payload.identifier === "string"
      ? payload.identifier.trim().slice(0, MAX_IDENTIFIER_LENGTH)
      : "";
  if (!identifier) {
    throw new RequestError(400, "missing_identifier", "identifier is required", "identifier");
  }
  const redirectTo =
    typeof payload.redirect_to === "string" ? payload.redirect_to.trim().slice(0, 2048) : "";
  if (redirectTo && !/^https?:\/\//i.test(redirectTo)) {
    throw new RequestError(400, "invalid_request", "redirect_to must be an absolute http(s) URL", "redirect_to");
  }
  // Whether the project honours that redirect is decided by Supabase's own
  // Redirect URLs allow-list; this function adds no trust of its own.

  const resolved = await resolveIdentifier(context, identifier);
  const email = resolved.email ?? sinkholeEmail(identifier);
  const { error } = await context.anon.auth.resetPasswordForEmail(
    email,
    redirectTo ? { redirectTo } : undefined,
  );
  if (error) {
    const message = `${error.message ?? ""}`.toLowerCase();
    if (message.includes("rate limit") || message.includes("too many") || message.includes("60 seconds")) {
      return jsonResponse(429, { ok: false, code: "rate_limited" });
    }
    return jsonResponse(502, { ok: false, code: "network" });
  }
  // Supabase answers the same whether or not the address exists, and so does
  // this: the recovery screen stays "if that account exists, a link is on its
  // way" for usernames exactly as it already was for emails.
  return jsonResponse(200, { ok: true, channel: "email" });
}

// ── the handler ──────────────────────────────────────────────────────────────
Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  let action = "";
  try {
    if (req.method !== "POST") {
      throw new RequestError(405, "method_not_allowed", "Use POST.");
    }

    const length = Number(req.headers.get("content-length") ?? "0");
    if (length > MAX_BODY_BYTES) {
      throw new RequestError(413, "payload_too_large", "That request is too large");
    }
    const body = await req.text();
    if (body.length > MAX_BODY_BYTES) {
      throw new RequestError(413, "payload_too_large", "That request is too large");
    }

    let parsed: unknown = null;
    try {
      parsed = body ? JSON.parse(body) : null;
    } catch {
      throw new RequestError(400, "invalid_request", "The body must be JSON");
    }

    action = typeof asRecord(parsed).action === "string" ? (asRecord(parsed).action as string) : "";
    const payload = asRecord(asRecord(parsed).payload);
    if (action !== "login" && action !== "recover") {
      throw new RequestError(400, "unknown_action", "Unknown action. Accepted: login, recover");
    }

    // Abuse resistance before any provider call: this endpoint is, by nature,
    // open to the internet.
    if (rateLimited(action, clientIp(req))) {
      return jsonResponse(429, { ok: false, code: "rate_limited" });
    }

    const context = buildContext();
    return action === "login" ? await login(context, payload) : await recover(context, payload);
  } catch (error) {
    if (error instanceof RequestError) return reject(error);

    // The message goes to the function logs and nowhere else — never the
    // request body. A password or a recovery address has no business in a log.
    const message = error instanceof Error ? error.message : String(error);
    console.error(`alyq-auth: ${action || "request"} failed: ${message}`);
    return reject(new RequestError(500, "unexpected", "The request could not be completed"));
  }
});
