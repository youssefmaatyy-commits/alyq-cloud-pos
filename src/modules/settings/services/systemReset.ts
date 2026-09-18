/**
 * The Danger Zone's service layer (Phase 47).
 *
 * ONE shape, two engines:
 *   · live  — the 0047 RPCs (`system_reset_preview`,
 *             `system_clear_operational_data`, `system_factory_reset`), each a
 *             single atomic, audited, server-authorized statement;
 *   · demo  — the local demo repositories (the "server" when Supabase is not
 *             configured), driven through one synchronous pass per mode with
 *             the same gates (capability, fresh re-auth, phrase, known option
 *             keys, protected admin) enforced BEFORE anything mutates.
 *
 * The React layer never deletes anything itself: it calls these functions and
 * renders the answer. That is the phase's critical rule, kept in both engines.
 *
 * Re-authentication: the current password is verified by the EXISTING auth
 * service (`signIn` in lib/auth — demo verifier or Supabase GoTrue). On
 * success the service records a freshness stamp and the destructive call
 * carries a short window; the raw password is never sent to the database,
 * never stored and never logged. (A Postgres function cannot verify a GoTrue
 * password server-side; the freshest-proof architecture available is the
 * auth-provider verification + a 10-minute server-checked window — documented
 * in 0047.)
 */
import { getSupabaseClient, isSupabaseConfigured } from "@/lib/supabase/client";
import { signIn } from "@/lib/auth/services/authService";
import { getCurrentAuthUser } from "@/lib/auth/services/sessionStore";
import { capabilitiesOfUser } from "@/lib/permissions/enforce";
import { verifyPassword } from "@/lib/auth/services/password";
import { findStaffByUsername } from "@/lib/auth/data/staffDirectory";
import { safeStorage } from "@/modules/products/data/demoSeed";

// ── types ───────────────────────────────────────────────────────────────────

export type ResetMode = "operational" | "factory";

/** The exact phrases the server requires — exported so the UI never drifts. */
export const OPERATIONAL_PHRASE = "DELETE OPERATIONAL DATA";
export const FACTORY_PHRASE = "DELETE ALL DATA";

export interface OperationalOptions {
  sales: boolean;
  returns: boolean;
  /** Deleting sales carries the returns tree with it (server-enforced). */
  orders: boolean;
  shifts: boolean;
  expenses: boolean;
  customers: boolean;
  movements: boolean;
  /** Zero every shelf; variants first, rollup by trigger, recount ledger. */
  quantities: boolean;
}

export interface FactoryOptions {
  products: boolean;
  categories: boolean;
  customers: boolean;
  /** Campaigns, FAQs and the storefront settings document → shipped defaults. */
  website: boolean;
  /** Brand block → shipped ALYQ defaults. */
  branding: boolean;
  /** The `delivery` group of the website settings document. */
  delivery_payment: boolean;
}

export interface PreviewRow {
  group: string;
  action: "delete" | "preserve" | "reset";
  count: number;
}

export interface ResetPreview {
  mode: ResetMode;
  effective_options: Record<string, boolean>;
  delete: PreviewRow[];
  preserve: PreviewRow[];
  protected_admin: { username: string; name: string } | null;
  schema_note: string;
}

export interface ResetResult {
  mode: ResetMode;
  deleted: Record<string, unknown>;
  preserved: Record<string, unknown>;
  /** Demo-only: the client must reload so the local repositories reseed. */
  needsReload?: boolean;
}

/** Server-side classes surface verbatim; the UI maps them to copy. */
export class ResetError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

// ── re-authentication (existing auth service; no new credential path) ──────

const REAUTH_WINDOW_MS = 5 * 60 * 1000; // the server allows ±10 minutes
let reauthAt = 0;

/** True while the re-auth window is open — drives the wizard's gating UI. */
export function isReauthFresh(): boolean {
  return Date.now() - reauthAt < REAUTH_WINDOW_MS;
}

export function resetReauth(): void {
  reauthAt = 0;
}

/**
 * Prove the current password through the existing sign-in flow. The username
 * is the signed-in user's own; `signIn` never changes the session of a
 * different account and the password exists only inside this call.
 */
export async function reauthenticate(
  username: string,
  password: string,
): Promise<{ ok: true } | { ok: false; code: string }> {
  const outcome = await signIn({ username, password });
  if (!outcome.ok) return { ok: false, code: outcome.code ?? "invalid_credentials" };
  reauthAt = Date.now();
  return { ok: true };
}

const freshUntilIso = (): string => new Date(reauthAt + REAUTH_WINDOW_MS).toISOString();

function assertFresh(): void {
  if (!isReauthFresh()) {
    throw new ResetError("RESET_REAUTH_REQUIRED", "Re-enter the current password first.");
  }
}

function assertPhrase(phrase: string, expected: string): void {
  if (phrase.trim().toUpperCase() !== expected) {
    throw new ResetError("RESET_PHRASE_MISMATCH", `Type ${expected} to confirm.`);
  }
}

function translateRpcError(err: unknown): never {
  const message = err instanceof Error ? err.message : String(err);
  const code = message.split(":")[0]?.trim() ?? "";
  const known = [
    "RESET_UNAUTHORIZED",
    "RESET_REAUTH_REQUIRED",
    "RESET_REAUTH_LOCKED",
    "RESET_PHRASE_MISMATCH",
    "RESET_BAD_OPTIONS",
    "RESET_BAD_MODE",
    "SUPER_ADMIN_LOST",
  ];
  if (known.includes(code)) throw new ResetError(code, message.slice(code.length + 1).trim());
  throw new ResetError("RESET_FAILED", message);
}

// ── public API ──────────────────────────────────────────────────────────────

export async function systemResetPreview(
  mode: ResetMode,
  options: Record<string, boolean>,
): Promise<ResetPreview> {
  if (isSupabaseConfigured && getSupabaseClient()) {
    const { data, error } = await getSupabaseClient()!
      .rpc("system_reset_preview", { p_mode: mode, p_options: options });
    if (error) translateRpcError(error);
    return data as ResetPreview;
  }
  return demoPreview(mode, options);
}

export async function clearOperationalData(
  options: OperationalOptions,
  phrase: string,
  password: string,
): Promise<ResetResult> {
  assertPhrase(phrase, OPERATIONAL_PHRASE);
  assertFresh();
  if (isSupabaseConfigured && getSupabaseClient()) {
    const { data, error } = await getSupabaseClient()!
      .rpc("system_clear_operational_data", {
        p_options: options,
        p_confirmation: phrase.trim().toUpperCase(),
        p_fresh_until: freshUntilIso(),
        p_password: password,
      });
    if (error) translateRpcError(error);
    reauthAt = 0; // one reset per proof
    return data as ResetResult;
  }
  const result = await demoClearOperational(options, phrase, password);
  reauthAt = 0;
  return result;
}

export async function factoryReset(
  options: FactoryOptions,
  phrase: string,
  password: string,
): Promise<ResetResult> {
  assertPhrase(phrase, FACTORY_PHRASE);
  assertFresh();
  if (isSupabaseConfigured && getSupabaseClient()) {
    const { data, error } = await getSupabaseClient()!
      .rpc("system_factory_reset", {
        p_options: options,
        p_confirmation: phrase.trim().toUpperCase(),
        p_fresh_until: freshUntilIso(),
        p_password: password,
      });
    if (error) translateRpcError(error);
    reauthAt = 0;
    return data as ResetResult;
  }
  const result = await demoFactoryReset(options, phrase, password);
  reauthAt = 0;
  return result;
}

/**
 * After a rolled-back destructive call: report the failure so the (append-only)
 * trail records that the reset was attempted and refused. Best-effort — a
 * failed report must never mask the original error.
 */
export async function reportResetFailure(mode: ResetMode | "demo", stage: string, message: string): Promise<void> {
  try {
    if (isSupabaseConfigured && getSupabaseClient()) {
      await getSupabaseClient()!
        .rpc("system_reset_report_failure", { p_mode: mode, p_stage: stage, p_message: message });
    } else {
      demoAppendAudit("system.reset.failed", mode, {
        mode,
        stage,
        error: String(message).slice(0, 500),
      });
    }
  } catch {
    /* the original error carries the UX; this row is best-effort */
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Demo engine — the local repositories ARE the server in demo mode. One
// synchronous pass per mode, every gate checked before the first mutation, so
// a refused reset changes nothing (the atomicity the live RPC gets from the
// transaction).
// ════════════════════════════════════════════════════════════════════════════

const K = {
  catalog: "alyq.demo.catalog.v1",
  sales: "alyq.demo.sales.v1",
  saleCounter: "alyq.demo.sale_counter.v1",
  returns: "alyq.demo.returns.v1",
  returnCounter: "alyq.demo.return_counter.v1",
  refunds: "alyq.demo.refunds.v1",
  refundCounter: "alyq.demo.refund_counter.v1",
  orders: "alyq.demo.online_orders.v1",
  orderItems: "alyq.demo.online_order_items.v1",
  orderCounter: "alyq.demo.online_order_counter.v1",
  reservations: "alyq.demo.stock_reservations.v1",
  movements: "alyq.demo.stock_movements.v1",
  shifts: "alyq.demo.shifts.v1",
  shiftCounter: "alyq.demo.shift_counter.v1",
  expenses: "alyq.demo.expenses.v1",
  expenseCounter: "alyq.demo.expense_counter.v1",
  customers: "alyq.demo.customers.v1",
  storeCustomers: "alyq.demo.store_customers.v1",
  approvals: "alyq.demo.approval_requests.v1",
  approvalCounter: "alyq.demo.approval_counter.v1",
  campaigns: "alyq.demo.campaigns.v1",
  faqs: "alyq.demo.store_faqs.v1",
  reviews: "alyq.demo.store_reviews.v1",
  productContents: "alyq.demo.product_contents.v1",
  categoryContents: "alyq.demo.storefront_category_contents.v1",
  websiteSettings: "alyq.demo.website_settings.v1",
  auditLog: "alyq.demo.audit_log.v1",
  onlineSeeded: "alyq.demo.online_seeded.v1",
} as const;

function readJson<T>(key: string, fallback: T): T {
  const raw = safeStorage.get(key);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function demoUser(): { id: string; name: string } {
  // The signed-in demo identity comes from the auth layer's own reader — it
  // checks both persistence stores, validates the record and fails closed to
  // the anonymous user, so the trail shows exactly who the app thinks acts.
  const user = getCurrentAuthUser();
  return { id: user.id || "demo", name: user.name || user.username || "Demo" };
}

function demoIsAdmin(): boolean {
  // Capability through the app's own gate — same model the live RPC's
  // system_assert_authorized() enforces, not a hand-rolled role string, and
  // never a raw localStorage shape that can drift from the session store.
  const user = getCurrentAuthUser();
  return capabilitiesOfUser(user).includes("manage_system_reset") && user.role === "admin";
}

function demoAppendAudit(
  action: "system.reset.started" | "system.reset.succeeded" | "system.reset.failed",
  entityId: string,
  details: Record<string, string | number | boolean | null>,
): void {
  const trail = readJson<unknown[]>(K.auditLog, []);
  const actor = demoUser();
  trail.push({
    id: `audit-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
    action,
    entity: "system",
    entity_id: entityId,
    entity_label: entityId === "factory" ? "Factory reset" : "Clear operational data",
    details,
    user_id: actor.id,
    user_name: actor.name,
    created_at: new Date().toISOString(),
  });
  safeStorage.set(K.auditLog, JSON.stringify(trail));
}

const OPERATIONAL_KEYS: (keyof OperationalOptions)[] = [
  "sales", "returns", "orders", "shifts", "expenses", "customers", "movements", "quantities",
];
const FACTORY_KEYS: (keyof FactoryOptions)[] = [
  "products", "categories", "customers", "website", "branding", "delivery_payment",
];

/**
 * The demo mirror of the server's re-auth proof (0047, Phase 48): the wizard
 * having asked for the password proves nothing on its own — the engine checks
 * it against the staff directory's verifier, exactly like sign-in does. The
 * clear text never leaves this call; nothing about it is stored or audited.
 */
async function demoVerifyPassword(password: string): Promise<void> {
  if (!password || !password.trim()) {
    throw new ResetError("RESET_REAUTH_REQUIRED", "Re-enter the current password first.");
  }
  const entry = findStaffByUsername(getCurrentAuthUser().username);
  const verifier = entry?.verifier ?? null;
  const ok = verifier ? await verifyPassword(password, verifier) : false;
  if (!ok) {
    throw new ResetError("RESET_REAUTH_REQUIRED", "That current password was not accepted.");
  }
}

async function demoGate(
  mode: ResetMode,
  options: Record<string, boolean>,
  allowed: string[],
  phrase: string,
  expected: string,
  password: string,
): Promise<void> {
  if (!demoIsAdmin()) {
    throw new ResetError("RESET_UNAUTHORIZED", "manage_system_reset is required.");
  }
  assertFresh();
  await demoVerifyPassword(password);
  assertPhrase(phrase, expected);
  for (const key of Object.keys(options)) {
    if (!allowed.includes(key)) {
      throw new ResetError("RESET_BAD_OPTIONS", `Unknown option "${key}".`);
    }
  }
  if (mode !== "operational" && mode !== "factory") {
    throw new ResetError("RESET_BAD_MODE", mode);
  }
}

function demoPreview(mode: ResetMode, options: Record<string, boolean>): ResetPreview {
  if (!demoIsAdmin()) {
    throw new ResetError("RESET_UNAUTHORIZED", "manage_system_reset is required.");
  }
  const catalog = readJson<{ products: unknown[]; variants: unknown[]; categories: unknown[] }>(
    K.catalog, { products: [], variants: [], categories: [] },
  );
  const effective = { ...options };
  if (mode === "operational") {
    effective.returns = options.returns || options.sales;
  } else {
    effective.sales = true;
    effective.returns = true;
    effective.orders = true;
    effective.shifts = true;
    effective.expenses = true;
    effective.movements = true;
    effective.quantities = false;
  }
  const count = (key: string, value: unknown[]): PreviewRow => ({
    group: key,
    action: effective[key] ? "delete" : "preserve",
    count: value.length,
  });
  const rows: PreviewRow[] = mode === "operational"
    ? [
        count("sales", readJson<unknown[]>(K.sales, [])),
        count("returns", readJson<unknown[]>(K.returns, [])),
        count("orders", readJson<unknown[]>(K.orders, [])),
        count("shifts", readJson<unknown[]>(K.shifts, [])),
        count("expenses", readJson<unknown[]>(K.expenses, [])),
        count("customers", [
          ...readJson<unknown[]>(K.customers, []),
          ...readJson<unknown[]>(K.storeCustomers, []),
        ]),
        count("movements", readJson<unknown[]>(K.movements, [])),
        {
          group: "quantities",
          action: options.quantities ? "reset" : "preserve",
          count:
            (catalog.products as { stock_quantity?: number }[]).filter((p) => (p.stock_quantity ?? 0) > 0).length +
            (catalog.variants as { stock_quantity?: number }[]).filter((v) => (v.stock_quantity ?? 0) > 0).length,
        },
      ]
    : [
        count("products", catalog.products),
        count("categories", catalog.categories),
        count("customers", [
          ...readJson<unknown[]>(K.customers, []),
          ...readJson<unknown[]>(K.storeCustomers, []),
        ]),
        {
          group: "website",
          action: options.website ? "delete" : "preserve",
          count:
            readJson<unknown[]>(K.campaigns, []).length +
            readJson<unknown[]>(K.faqs, []).length +
            readJson<unknown[]>(K.categoryContents, []).length,
        },
        { group: "branding", action: options.branding ? "delete" : "preserve", count: options.branding ? 1 : 0 },
        { group: "delivery_payment", action: options.delivery_payment ? "delete" : "preserve", count: options.delivery_payment ? 1 : 0 },
      ];
  return {
    mode,
    effective_options: effective,
    delete: rows.filter((r) => r.action !== "preserve"),
    preserve: rows.filter((r) => r.action === "preserve"),
    protected_admin: null,
    schema_note: "Demo mode: local repositories only; the hosted database is never touched.",
  };
}

async function demoClearOperational(
  options: OperationalOptions,
  phrase: string,
  password: string,
): Promise<ResetResult> {
  await demoGate("operational", options as unknown as Record<string, boolean>, OPERATIONAL_KEYS as string[], phrase, OPERATIONAL_PHRASE, password);

  const catalog = readJson<{ products: { id: string; variants_enabled: boolean; stock_quantity: number }[]; variants: { id: string; product_id: string; stock_quantity: number }[]; categories: unknown[] }>(
    K.catalog, { products: [], variants: [], categories: [] },
  );
  const deleted: Record<string, number | boolean> = {};

  demoAppendAudit("system.reset.started", "operational", {
    mode: "operational",
    options: JSON.stringify(options),
  });

  if (options.orders) {
    deleted.online_orders = readJson<unknown[]>(K.orders, []).length;
    for (const key of [K.reservations, K.orderItems, K.orders]) safeStorage.set(key, "[]");
    safeStorage.set(K.orderCounter, "1");
    safeStorage.set(K.onlineSeeded, "cleared");
  }
  if (options.sales) {
    deleted.sales = readJson<unknown[]>(K.sales, []).length;
    for (const key of [K.refunds, K.sales, K.returns]) safeStorage.set(key, "[]");
    // Counters are NOT reset in operational mode: financial references are
    // never reused, even when the rows they once named are gone (live 0047
    // keeps the counters for exactly the same reason).
    deleted.returns = readJson<unknown[]>(K.returns, []).length;
  } else if (options.returns) {
    deleted.returns = readJson<unknown[]>(K.returns, []).length;
    safeStorage.set(K.returns, "[]");
  }
  if (options.movements) {
    deleted.stock_movements = readJson<unknown[]>(K.movements, []).length;
    safeStorage.set(K.movements, "[]");
  }
  if (options.expenses) {
    deleted.expenses = readJson<unknown[]>(K.expenses, []).length;
    safeStorage.set(K.expenses, "[]");
  }
  if (options.shifts) {
    deleted.shifts = readJson<unknown[]>(K.shifts, []).length;
    safeStorage.set(K.shifts, "[]");
  }
  if (options.customers) {
    deleted.customers =
      readJson<unknown[]>(K.customers, []).length + readJson<unknown[]>(K.storeCustomers, []).length;
    for (const key of [K.customers, K.storeCustomers]) safeStorage.set(key, "[]");
  }
  if (options.quantities) {
    // The shelf of record is zeroed per variant; the product rollup follows as
    // the sum of its shelves (the demo mirrors the 0043 trigger's rule). One
    // recount movement per emptied shelf keeps the ledger summing true.
    const movements = options.movements ? [] : readJson<unknown[]>(K.movements, []);
    const actor = demoUser();
    for (const variant of catalog.variants) {
      if (variant.stock_quantity > 0) {
        movements.push({
          id: `mov-reset-${variant.id}`,
          product_id: variant.product_id,
          variant_id: variant.id,
          delta: variant.stock_quantity,
          quantity_before: variant.stock_quantity,
          quantity_after: 0,
          type: "adjustment_out",
          reason: "recount",
          notes: "Danger Zone inventory reset",
          user_id: actor.id,
          user_name: actor.name,
          created_at: new Date().toISOString(),
        });
        variant.stock_quantity = 0;
      }
    }
    for (const product of catalog.products) {
      if (product.variants_enabled) {
        product.stock_quantity = catalog.variants
          .filter((v) => v.product_id === product.id)
          .reduce((sum, v) => sum + v.stock_quantity, 0);
      } else if (product.stock_quantity > 0) {
        movements.push({
          id: `mov-reset-${product.id}`,
          product_id: product.id,
          delta: product.stock_quantity,
          quantity_before: product.stock_quantity,
          quantity_after: 0,
          type: "adjustment_out",
          reason: "recount",
          notes: "Danger Zone inventory reset",
          user_id: actor.id,
          user_name: actor.name,
          created_at: new Date().toISOString(),
        });
        product.stock_quantity = 0;
      }
    }
    safeStorage.set(K.catalog, JSON.stringify(catalog));
    safeStorage.set(K.movements, JSON.stringify(movements));
    deleted.inventory_reset = true;
  }

  demoAppendAudit("system.reset.succeeded", "operational", {
    mode: "operational",
    deleted: JSON.stringify(deleted),
  });

  return {
    mode: "operational",
    deleted,
    preserved: {
      products: catalog.products.length,
      variants: catalog.variants.length,
      categories: catalog.categories.length,
      website_settings: true,
      branding: true,
    },
    needsReload: false,
  };
}

async function demoFactoryReset(options: FactoryOptions, phrase: string, password: string): Promise<ResetResult> {
  await demoGate("factory", options as unknown as Record<string, boolean>, FACTORY_KEYS as string[], phrase, FACTORY_PHRASE, password);
  const catalog = readJson<{ products: unknown[]; variants: unknown[]; categories: unknown[] }>(
    K.catalog, { products: [], variants: [], categories: [] },
  );
  const deleted: Record<string, number | boolean> = {};

  demoAppendAudit("system.reset.started", "factory", {
    mode: "factory",
    options: JSON.stringify(options),
  });

  // The operational floor, always.
  for (const key of [
    K.reservations, K.orderItems, K.orders, K.refunds, K.sales, K.returns,
    K.approvals, K.expenses, K.shifts, K.movements,
  ]) {
    safeStorage.set(key, "[]");
  }
  deleted.operational = true;
  safeStorage.set(K.onlineSeeded, "cleared");

  if (options.customers) {
    deleted.customers =
      readJson<unknown[]>(K.customers, []).length + readJson<unknown[]>(K.storeCustomers, []).length;
    for (const key of [K.customers, K.storeCustomers]) safeStorage.set(key, "[]");
  }

  if (options.products) {
    deleted.products = catalog.products.length;
    deleted.variants = catalog.variants.length;
    for (const key of [K.reviews, K.productContents]) safeStorage.set(key, "[]");
    catalog.products = [];
    catalog.variants = [];
  }

  if (options.categories) {
    deleted.categories = catalog.categories.length;
    safeStorage.set(K.categoryContents, "[]");
    catalog.categories = [];
  }

  if (options.website || options.branding) {
    safeStorage.set(K.campaigns, "[]");
    safeStorage.set(K.faqs, "[]");
  }
  const doc = readJson<{ settings: Record<string, unknown> }>(K.websiteSettings, { settings: {} });
  if (options.website) {
    if (options.branding) {
      doc.settings = {};
    } else {
      doc.settings = {
        brand: doc.settings.brand,
        images: doc.settings.images,
      };
    }
  } else if (options.branding) {
    const images = { ...((doc.settings.images as Record<string, unknown> | undefined) ?? {}) };
    delete images.logo_url;
    delete images.mark_url;
    delete images.logo_dark_url;
    const settings = { ...doc.settings };
    delete settings.brand;
    settings.images = images;
    doc.settings = settings;
  }
  if (options.delivery_payment) {
    const settings = { ...doc.settings };
    delete settings.delivery;
    doc.settings = settings;
  }
  safeStorage.set(K.websiteSettings, JSON.stringify(doc));

  // The catalogue document (products, variants, categories) was mutated in
  // memory — persist it, or the "reset" only ever happened to a local copy.
  safeStorage.set(K.catalog, JSON.stringify(catalog));

  // Factory numbering restarts — nothing old survives to be reused.
  for (const key of [K.saleCounter, K.returnCounter, K.refundCounter, K.approvalCounter, K.shiftCounter, K.expenseCounter]) {
    safeStorage.set(key, "1");
  }

  demoAppendAudit("system.reset.succeeded", "factory", {
    mode: "factory",
    deleted: JSON.stringify(deleted),
  });

  return {
    mode: "factory",
    deleted,
    preserved: {
      products: catalog.products.length,
      categories: catalog.categories.length,
      branding_kept: !options.branding,
    },
    needsReload: true,
  };
}

