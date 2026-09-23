/**
 * alyq-admin — the only place in this project that holds the service role.
 *
 * Two staff operations cannot be database functions, because they have to create
 * or change credentials in `auth.users`, and nothing an anon key can reach is
 * allowed to do that:
 *
 *   · `create_user`    — an admin adds a person to Settings → Users;
 *   · `reset_password` — an admin sets a new password for somebody else.
 *
 * Everything else in that screen is an RPC (`admin_upsert_staff_profile`,
 * `admin_set_custom_role`, `admin_create_custom_role`, …), and stays one.
 *
 * ── The trust model ────────────────────────────────────────────────────────
 * The browser sends its own access token and nothing else. This function:
 *
 *   1. calls `auth.getUser()` with that token, so the identity is the one
 *      Supabase issued and not a claim somebody typed into a body;
 *   2. asks the database `public.can('manage_users')` *as that caller* — the
 *      same question every RLS policy and every admin RPC asks, so an overlay
 *      role counts here exactly as it counts everywhere else;
 *   3. only then constructs a service-role client, and uses it for the one call
 *      that needs it.
 *
 * The service key is read from the environment per request and never returned,
 * logged, or embedded in a response. `verify_jwt` stays at its default (true) so
 * the platform rejects an unauthenticated invocation before this code runs; the
 * checks above are not a substitute for that, they are the part the platform
 * cannot do — deciding whether *this* caller may manage *users*.
 *
 * ── What this function deliberately does not do ────────────────────────────
 *   · It writes no audit rows. `settingsService` records one attributed entry per
 *     action (`user.created`, `user.password_reset`) and a second row here would
 *     mean every creation appears twice in the trail. The password itself is
 *     never part of any entry, on either side.
 *   · It does not assign custom roles. `create_user` accepts `custom_role_id` and
 *     ignores it: the app follows up with `admin_set_custom_role`, which is where
 *     the rule "assigning an overlay also moves profiles.role to its base" lives.
 *     Ignoring it is also the safe direction — an overlay can widen a role, so a
 *     caller who expects one to be applied and finds it was not ends up with
 *     fewer rights, never more.
 *   · It does not relax validation because the app already did it. The username,
 *     email, role and password rules below mirror `src/modules/settings/
 *     validation.ts` and `src/lib/auth/services/passwordPolicy.ts`. A forged
 *     request that skips the form meets the same bar here, which is the whole
 *     point of enforcement living in more than one layer.
 *
 * ── Deploying ──────────────────────────────────────────────────────────────
 *   supabase secrets set SUPABASE_SERVICE_ROLE_KEY=<project service_role key>
 *   supabase functions deploy alyq-admin
 *
 * `SUPABASE_URL` and `SUPABASE_ANON_KEY` are injected into every edge function
 * by the runtime; only the service key is a secret you set yourself. Rotate it
 * (Dashboard → Settings → API) if it ever leaks, then re-run the two commands.
 */
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";

// ── the rules, mirrored from the app ────────────────────────────────────────
/** The five system roles of `public.app_role`. Anything else is refused. */
const APP_ROLES = ["admin", "manager", "cashier", "inventory_clerk", "viewer"] as const;
type AppRole = (typeof APP_ROLES)[number];

/** `src/modules/settings/validation.ts` — the same two patterns, the same limits. */
const USERNAME_PATTERN = /^[a-z0-9._-]{2,64}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MIN_NAME_LENGTH = 2;

/**
 * `src/lib/auth/services/passwordPolicy.ts`. The browser checklist is a
 * convenience; this is the floor, and Supabase Auth's own password policy (which
 * answers `weak_password`) still applies on top of it. The denylist is short on
 * purpose — it exists to stop `alyq1234`, the password every demo account and
 * every seeded installation ships with, from becoming a real one.
 */
const MIN_PASSWORD_LENGTH = 8;
const COMMON_PASSWORDS = new Set([
  "password",
  "password1",
  "password123",
  "12345678",
  "123456789",
  "1234567890",
  "qwerty123",
  "alyq1234",
  "admin123",
  "admin1234",
  "welcome1",
  "letmein1",
  "11111111",
  "00000000",
]);

/** A request body has no business being large; refusing early is cheap. */
const MAX_BODY_BYTES = 8 * 1024;

/** The capability both actions require — the one `settingsService` asserts too. */
const REQUIRED_CAPABILITY = "manage_users";

const CORS_HEADERS: Record<string, string> = {
  // The origin is not the boundary here: the caller's access token is, and it is
  // checked on every request. A stolen token from another origin is stopped by
  // `public.can()`, not by this header — which is why the header can be honest
  // about being permissive instead of pretending to be a control.
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// ── errors ──────────────────────────────────────────────────────────────────
/**
 * A refusal with an HTTP status and a stable code. The codes are deliberately
 * the same vocabulary the app already translates (`duplicate_username`,
 * `weak_password`, `forbidden`, …) so a message that reaches the UI can be shown
 * rather than shrugged at.
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
    error: { code: error.code, message: error.message, field: error.field ?? null },
  });
}

/** A guard that reads like the sentence it enforces. */
function requireText(
  value: unknown,
  field: string,
  options: { min?: number; max?: number; pattern?: RegExp; code?: string } = {},
): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) {
    throw new RequestError(400, options.code ?? "invalid_request", `${field} is required`, field);
  }
  if (options.min !== undefined && text.length < options.min) {
    throw new RequestError(
      400,
      options.code ?? "invalid_request",
      `${field} must be at least ${options.min} characters`,
      field,
    );
  }
  if (options.max !== undefined && text.length > options.max) {
    throw new RequestError(
      400,
      options.code ?? "invalid_request",
      `${field} must be at most ${options.max} characters`,
      field,
    );
  }
  if (options.pattern && !options.pattern.test(text)) {
    throw new RequestError(400, options.code ?? "invalid_request", `${field} is not valid`, field);
  }
  return text;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * The password floor. `username` is optional: on a reset the name is not part of
 * the request, and a rule with nothing to compare against passes rather than
 * inventing a failure.
 */
function enforcePasswordFloor(password: unknown, field = "password", username?: string): string {
  const candidate = typeof password === "string" ? password : "";
  if (candidate.length < MIN_PASSWORD_LENGTH) {
    throw new RequestError(
      400,
      "weak_password",
      `The password must be at least ${MIN_PASSWORD_LENGTH} characters`,
      field,
    );
  }
  if (!/[a-z\u0621-\u064A]/i.test(candidate)) {
    throw new RequestError(400, "weak_password", "The password must contain a letter", field);
  }
  if (!/[0-9]/.test(candidate)) {
    throw new RequestError(400, "weak_password", "The password must contain a digit", field);
  }
  const lowered = candidate.toLowerCase();
  if (COMMON_PASSWORDS.has(lowered)) {
    throw new RequestError(400, "weak_password", "That password is too common to use", field);
  }
  const handle = (username ?? "").trim().toLowerCase();
  if (handle && (lowered === handle || lowered.includes(handle))) {
    throw new RequestError(400, "weak_password", "The password must not contain the username", field);
  }
  return candidate;
}

interface CreateUserRequest {
  email: string;
  password: string;
  username: string;
  name: string;
  phone: string | null;
  role: AppRole;
  active: boolean;
}

function readCreateUser(payload: Record<string, unknown>): CreateUserRequest {
  const username = requireText(payload.username, "username", {
    min: 2,
    max: 64,
    pattern: USERNAME_PATTERN,
    code: "invalid_username",
  }).toLowerCase();
  const name = requireText(payload.name, "name", { min: MIN_NAME_LENGTH, max: 80 });
  const role = requireText(payload.role, "role", { max: 32 }) as AppRole;
  if (!APP_ROLES.includes(role)) {
    throw new RequestError(400, "invalid_role", `Unknown role '${role}'`, "role");
  }

  // An account with no email of its own still needs an address to sign in with,
  // so the app sends the synthetic `<username>@alyq.local` — the same convention
  // `SupabaseUserRepository.authenticate` signs in with. Either way it has to
  // look like an address.
  const email = requireText(payload.email, "email", {
    max: 320,
    pattern: EMAIL_PATTERN,
    code: "invalid_email",
  }).toLowerCase();

  const phone = typeof payload.phone === "string" && payload.phone.trim()
    ? payload.phone.trim().slice(0, 32)
    : null;

  return {
    email,
    password: enforcePasswordFloor(payload.password, "password", username),
    username,
    name,
    phone,
    role,
    // Absent means active: the form's default, and the friendlier reading of a
    // request that did not say.
    active: payload.active !== false,
  };
}

interface ResetPasswordRequest {
  userId: string;
  password: string;
}

function readResetPassword(payload: Record<string, unknown>): ResetPasswordRequest {
  const userId = requireText(payload.user_id, "user_id", {
    pattern: UUID_PATTERN,
    code: "invalid_user_id",
  });
  return { userId, password: enforcePasswordFloor(payload.password) };
}

// ── the request context ─────────────────────────────────────────────────────
interface Context {
  /** Authenticated as the caller: used for `public.can()` and the staff RPC. */
  caller: SupabaseClient;
  /** Service role: used only for the credential calls themselves. */
  admin: SupabaseClient;
  callerId: string;
}

/**
 * Prove who is asking, and that they may ask. Anything that fails here is a
 * refusal, not an error page: the service client is not constructed until the
 * caller has been identified and authorised.
 */
async function authorize(req: Request): Promise<Context> {
  const url = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !anonKey || !serviceKey) {
    // 500, not 503: this is a deployment that was never finished, and the
    // message goes to whoever is reading the function logs.
    throw new RequestError(
      500,
      "not_configured",
      "SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY must all be set",
    );
  }

  const authorization = req.headers.get("Authorization") ?? "";
  if (!authorization) {
    throw new RequestError(401, "unauthenticated", "An access token is required");
  }

  const caller = createClient(url, anonKey, {
    global: { headers: { Authorization: authorization } },
    // The caller's token is used to identify them, not to keep a session: an
    // isolate that remembered somebody's tokens would be a leak between requests.
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: session, error: userError } = await caller.auth.getUser();
  const user = session?.user;
  if (userError || !user?.id) {
    throw new RequestError(401, "unauthenticated", "That access token is not valid");
  }

  // The database answers, as the caller. A missing profile row, a deactivated
  // account and an overlay that does not grant the capability all come back as
  // `false` — `public.can()` is fail-closed, so this needs no extra cases.
  const { data: allowed, error: canError } = await caller.rpc("can", {
    p_capability: REQUIRED_CAPABILITY,
  });
  if (canError) {
    throw new RequestError(
      500,
      "permission_check_failed",
      `Could not check '${REQUIRED_CAPABILITY}': ${canError.message}`,
    );
  }
  if (allowed !== true) {
    throw new RequestError(
      403,
      "forbidden",
      `This action needs the '${REQUIRED_CAPABILITY}' permission`,
    );
  }

  const admin = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  return { caller, admin, callerId: user.id };
}

// ── actions ─────────────────────────────────────────────────────────────────
/**
 * Create the credentials, then finish the profile.
 *
 * `auth.admin.createUser` fires `public.handle_new_user()`, which builds a
 * profile from the metadata — username and name — and nothing else. Since
 * migration 0030 the trigger deliberately ignores a declared `role`: GoTrue runs
 * it in its own session for a browser sign-up and for `auth.admin.createUser()`
 * alike, so no claim inside it can say which of the two is asking, and metadata
 * belongs to the caller. Every new account therefore starts as an inactive
 * viewer, and a role in the metadata is written to the audit log as a refused
 * escalation rather than granted. That is why `role` is no longer sent below:
 * sending it would not change the outcome, it would only make an account an
 * admin created look like an account that tried to create itself.
 *
 * The role, the active flag, the email and the phone are all set by
 * `admin_upsert_staff_profile` **called as the admin**, not with the service key:
 * the RPC re-checks `manage_users`, validates the name, and refuses to let an
 * admin deactivate their own account. Borrowing its guardrails beats restating
 * them here — and it means the authority for "who this person is" is an RPC that
 * already knew who was asking.
 */
async function createUser(
  context: Context,
  payload: Record<string, unknown>,
): Promise<Response> {
  const request = readCreateUser(payload);

  // Checked before creating anything: `handle_new_user()` resolves a username
  // clash by quietly suffixing it, which would leave the users list showing a
  // name nobody asked for. Refusing here keeps the two spellings of "taken"
  // (username, email) both answered before a row exists.
  const { data: clash } = await context.admin
    .from("profiles")
    .select("id")
    .eq("username", request.username)
    .maybeSingle();
  if (clash) {
    throw new RequestError(
      409,
      "duplicate_username",
      `The username '${request.username}' is already in use`,
      "username",
    );
  }

  const { data: created, error: createError } = await context.admin.auth.admin.createUser({
    email: request.email,
    password: request.password,
    // An account an admin created is confirmed by that act; making the person
    // click a link in an email they may not have access to yet would just strand
    // it. Supabase's own invitation flow is the alternative if that is wanted.
    email_confirm: true,
    // Username, name and phone only. `role` is deliberately not sent: the
    // trigger ignores it (see the note on this function), the role is set
    // authoritatively by `admin_upsert_staff_profile` below, and declaring one
    // here would put a row in the audit log saying this account asked to be
    // something — which is the signal reserved for a real forgery attempt.
    user_metadata: {
      username: request.username,
      name: request.name,
      phone: request.phone,
    },
  });

  const userId = created?.user?.id;
  if (createError || !userId) {
    const message = createError?.message ?? "The account could not be created";
    if (/already registered|already exists|duplicate/i.test(message)) {
      throw new RequestError(409, "email_taken", `An account for ${request.email} already exists`, "email");
    }
    if (/weak password|password should/i.test(message)) {
      throw new RequestError(400, "weak_password", message, "password");
    }
    throw new RequestError(502, "create_failed", message, "email");
  }

  const { error: profileError } = await context.caller.rpc("admin_upsert_staff_profile", {
    p_user_id: userId,
    p_username: request.username,
    p_name: request.name,
    p_email: request.email,
    p_phone: request.phone,
    p_role: request.role,
    p_active: request.active,
  });

  if (profileError) {
    // One action, one result. The trigger's profile would leave the account
    // without the email it signs in with and without a phone number, and the
    // admin would be looking at a user they cannot reset — so the credentials are
    // removed and the request refused instead, and a retry starts clean.
    await context.admin.auth.admin.deleteUser(userId).catch(() => undefined);
    throw new RequestError(
      profileError.code === "23505" ? 409 : 502,
      profileError.code === "23505" ? "duplicate_username" : "profile_failed",
      profileError.message,
      "username",
    );
  }

  return jsonResponse(201, {
    user_id: userId,
    username: request.username,
    email: request.email,
    role: request.role,
    active: request.active,
    // Explicitly reported as not applied, so a caller who sent one does not
    // assume the overlay is on: the app assigns it with `admin_set_custom_role`.
    custom_role_id: null,
  });
}

/**
 * Set a new password for somebody else.
 *
 * Changing a password invalidates that person's refresh tokens, so their other
 * devices end at the next refresh — which is what an admin resetting a shared or
 * compromised account wants, and worth knowing when the account is your own.
 */
async function resetPassword(
  context: Context,
  payload: Record<string, unknown>,
): Promise<Response> {
  const request = readResetPassword(payload);

  // Staff only. `manage_users` is authority over the people who work here, not
  // over every identity in the project, and the day customer accounts move into
  // `auth.users` this is the line that keeps an admin from resetting a shopper's
  // password by guessing an id.
  const { data: profile } = await context.admin
    .from("profiles")
    .select("id, username, active")
    .eq("id", request.userId)
    .maybeSingle();
  if (!profile) {
    throw new RequestError(404, "not_staff", `No staff account with id ${request.userId}`, "user_id");
  }

  const { error } = await context.admin.auth.admin.updateUserById(request.userId, {
    password: request.password,
  });
  if (error) {
    if (/weak password|password should/i.test(error.message)) {
      throw new RequestError(400, "weak_password", error.message, "password");
    }
    throw new RequestError(502, "reset_failed", error.message, "password");
  }

  return jsonResponse(200, {
    user_id: request.userId,
    username: profile.username,
    // Never the password, and never a token: the admin does not get to inherit
    // the session they just reset.
    sessions_invalidated: true,
  });
}

// ── the handler ─────────────────────────────────────────────────────────────
Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

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

    const action = asRecord(parsed).action;
    const payload = asRecord(asRecord(parsed).payload);

    // Authorisation happens before the action is even read: an unauthenticated
    // caller learns nothing about what this function can do.
    const context = await authorize(req);

    switch (action) {
      case "create_user":
        return await createUser(context, payload);
      case "reset_password":
        return await resetPassword(context, payload);
      default:
        throw new RequestError(
          400,
          "unknown_action",
          "Unknown action. Accepted: create_user, reset_password",
        );
    }
  } catch (error) {
    if (error instanceof RequestError) return reject(error);

    // An unexpected failure says what happened and nothing more: the message goes
    // back to a browser, so it carries no key, no token and no stack.
    const message = error instanceof Error ? error.message : String(error);
    console.error(`alyq-admin: ${message}`);
    return reject(new RequestError(500, "unexpected", "The request could not be completed"));
  }
});
