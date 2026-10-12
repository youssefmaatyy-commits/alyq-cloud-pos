/**
 * The commercial catalogue gate — the release condition that says "this
 * deployment is actually open for business".
 *
 * `scripts/release.probe.mjs` proves a *bundle* is well-formed: it reads
 * `release.json` and boots the shipped app against an EMPTY catalogue to show it
 * survives day zero. That is a rendering contract, not a commercial one: a
 * build whose Supabase project holds nothing passes it happily, and so does a
 * project whose products are all unpublished, archived or out of stock.
 *
 * This module is the other half. It asks the real public API — the two
 * `security definer` functions the anonymous storefront itself calls:
 *
 *   storefront_catalogue()                 the products the shop lists
 *   storefront_branch_product_variants()   the combinations it can sell
 *
 * and it fails the release when nothing in that answer is buyable.
 *
 * ## It cannot write
 *
 * Three independent properties, each checked in code rather than promised:
 *
 *   1. **The request plan is closed.** `catalogueGatePlan()` builds the only two
 *      requests the gate ever makes: `POST /rest/v1/rpc/<one of the two
 *      allow-listed functions>`, empty JSON body. There is no parameter through
 *      which a caller can name another function, another path or another body,
 *      and `assertReadOnlyPlan()` re-checks what the plan contains before it is
 *      sent (`POST /rpc/`, because that is how PostgREST invokes a function —
 *      what matters is that the *target* is a read-only function and the *body*
 *      carries no arguments to write with).
 *   2. **The functions are read-only in the shipped SQL.** `inspectFunctionSource()`
 *      parses the migrations that define them — reading the LAST definition of
 *      each, which is the one `create or replace` actually leaves in the
 *      database — and refuses anything that is not `stable`/`immutable` or whose
 *      body contains a write keyword. A later migration that turned either
 *      function into a mutating one fails the gate before a single request
 *      leaves the process, even when an earlier migration defined it read-only.
 *   3. **The credential is the anon key only.** A `service_role` JWT claim or an
 *      `sb_secret_…` key is refused up front: the gate must see exactly what an
 *      anonymous visitor sees, and must never hold a key that could write.
 *
 * Nothing here is a browser concern — the app never imports this — so it also
 * stays dependency-free and directly importable by a plain Node script.
 */

/* ── the closed request plan ─────────────────────────────────────────────── */

/** The only two functions the gate may call. Both are public and read-only. */
export const CATALOGUE_GATE_FUNCTIONS = [
  "storefront_catalogue",
  "storefront_branch_product_variants",
] as const;

export type CatalogueGateFunction = (typeof CATALOGUE_GATE_FUNCTIONS)[number];

export interface CatalogueRequest {
  /** Absolute URL of a PostgREST function endpoint. */
  url: string;
  method: "POST";
  /** `{}` — no arguments, so there is nothing for a function to write with. */
  body: string;
  headers: Record<string, string>;
  /** Which allow-listed function this is, for reports. */
  functionName: CatalogueGateFunction;
}

/**
 * The complete request plan. Two calls, no options, no environment-dependent
 * branching: a reviewer can read the whole of what the gate does to production
 * in this one function.
 */
export function catalogueGatePlan(projectUrl: string, anonKey: string): CatalogueRequest[] {
  const base = projectUrl.trim().replace(/\/+$/, "");
  const key = anonKey.trim();
  const headers = {
    apikey: key,
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  return CATALOGUE_GATE_FUNCTIONS.map((functionName) => ({
    url: `${base}/rest/v1/rpc/${functionName}`,
    method: "POST" as const,
    body: "{}",
    headers,
    functionName,
  }));
}

/**
 * Re-check a plan before it is used. This is the assertion that makes "the gate
 * never writes" a property of the code: every request must target one of the two
 * allow-listed function endpoints with an empty body.
 */
export function assertReadOnlyPlan(plan: readonly CatalogueRequest[]): CatalogueFinding[] {
  const findings: CatalogueFinding[] = [];
  const planned = plan.map((request) => request.functionName);
  const unexpected = planned.filter(
    (name) => !(CATALOGUE_GATE_FUNCTIONS as readonly string[]).includes(name),
  );
  const missing = CATALOGUE_GATE_FUNCTIONS.filter((name) => !planned.includes(name));
  const wrongShape = plan.filter((request) => {
    const path = (() => {
      try {
        return new URL(request.url).pathname;
      } catch {
        return request.url;
      }
    })();
    return request.method !== "POST"
      || path !== `/rest/v1/rpc/${request.functionName}`
      || (request.body ?? "").trim() !== "{}";
  });

  if (unexpected.length > 0 || missing.length > 0 || wrongShape.length > 0) {
    findings.push({
      level: "fail",
      code: "catalogue.read_only",
      message: `the request plan is not the closed set of two read-only functions (unexpected: ${unexpected.join(", ") || "none"}; missing: ${missing.join(", ") || "none"}; malformed: ${wrongShape.length})`,
    });
  } else {
    findings.push({
      level: "pass",
      code: "catalogue.read_only",
      message: `the plan is ${plan.length} read-only RPC call(s) with empty bodies: ${planned.join(", ")}`,
    });
  }
  return findings;
}

/* ── input safety ────────────────────────────────────────────────────────── */

export interface CatalogueGateInputs {
  projectUrl: string;
  anonKey: string;
  /** Raw `ALLOW_EMPTY_STOREFRONT` value. */
  allowEmptyStorefront?: string;
}

/**
 * The gate is only allowed to hold an anonymous, read-only credential — it must
 * see exactly what a shopper sees. A secret key is refused before any request is
 * built, so a misconfigured CI secret cannot widen the gate into a database
 * client.
 */
export function inspectGateInputs(inputs: CatalogueGateInputs): CatalogueFinding[] {
  const findings: CatalogueFinding[] = [];
  const url = (inputs.projectUrl ?? "").trim();
  const key = (inputs.anonKey ?? "").trim();

  let parsed: URL | null;
  try {
    parsed = new URL(url);
  } catch {
    parsed = null;
  }
  if (!parsed || (parsed.protocol !== "https:" && parsed.protocol !== "http:")) {
    findings.push({
      level: "fail",
      code: "catalogue.input",
      message: "no usable production project URL was supplied (expected an absolute http(s) URL).",
    });
  }
  if (!key) {
    findings.push({
      level: "fail",
      code: "catalogue.input",
      message: "no anon key was supplied; the gate reads the public API as an anonymous visitor.",
    });
  } else if (/^sb_secret_/i.test(key) || /service[_-]?role/i.test(key) || /"role"\s*:\s*"service_role"/.test(decodeBase64UrlSafe(key))) {
    findings.push({
      level: "fail",
      code: "catalogue.input",
      message: "the supplied key is a Supabase secret/service_role credential; the gate must use the anon (publishable) key.",
    });
  }

  if (findings.length === 0) {
    findings.push({
      level: "pass",
      code: "catalogue.input",
      message: `production project ${parsed ? parsed.host : url} with an anonymous key`,
    });
  }
  return findings;
}

/** Base64url decode that never throws — used only to read a JWT claim. */
function decodeBase64UrlSafe(value: string): string {
  const part = value.split(".")[1];
  if (!part) return "";
  try {
    const padded = part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "=");
    if (typeof globalThis.atob === "function") return globalThis.atob(padded);
    return Buffer.from(padded, "base64").toString("binary");
  } catch {
    return "";
  }
}

/* ── the shipped SQL must be read-only ───────────────────────────────────── */

const WRITE_KEYWORDS = [
  "insert", "update", "delete", "truncate", "alter", "drop", "create", "grant",
  "revoke", "merge", "call", "do", "copy", "vacuum", "comment", "refresh",
];

export interface FunctionSourceVerdict {
  found: boolean;
  readOnly: boolean;
  volatility: string;
  reason: string;
}

/**
 * Parse `create or replace function public.<name>(…) … as $function$ … $function$`
 * out of the shipped migrations and decide whether the body can write.
 *
 * Word boundaries matter: `updated_at` is not an `update`, `created_at` is not a
 * `create`. The volatility keyword is read from the header (between the closing
 * `)` of the signature and `as $function$`), where PostgreSQL expects it.
 *
 * ## The last definition is the one that ships
 *
 * The migrations are concatenated in filename order and `create or replace`
 * means a later file *supersedes* an earlier one, so the definition worth
 * judging is the LAST match, not the first. `storefront_catalogue()` really is
 * defined twice — `0030_live_mode_hardening.sql` and then
 * `0080_branch_stock_operations.sql` — and only the 0080 body exists in the
 * database the gate is about to call. A single (non-global) match reads the
 * historical 0030 body instead, which is how a later migration could hand the
 * gate a `delete`-ing function and still be reported read-only.
 */
export function inspectFunctionSource(sql: string, functionName: string): FunctionSourceVerdict {
  // `g` is as load-bearing as `i`: collect every definition of this function and
  // inspect the final one, which is the effective definition in migration order.
  const definitions = [...sql.matchAll(new RegExp(
    `create\\s+(?:or\\s+replace\\s+)?function\\s+public\\.${functionName}\\s*\\(`,
    "gi",
  ))];
  const header = definitions[definitions.length - 1];
  if (!header || header.index === undefined) {
    return {
      found: false,
      readOnly: false,
      volatility: "",
      reason: `the shipped migrations do not define public.${functionName}()`,
    };
  }

  // Confine the search for the body's START to the effective definition: it ends
  // where the next function header begins. Without the bound, a definition quoted
  // some other way (`as $$ …`, as 0030 used) would let the search run on into an
  // unrelated later function and judge *that* body — a pass for SQL never read.
  // If the bound is ever wrong, the gate fails closed rather than open.
  const nextDefinition = new RegExp(
    "create\\s+(?:or\\s+replace\\s+)?function\\s+(?:public\\.)?[a-z_][a-z0-9_$]*\\s*\\(",
    "gi",
  );
  nextDefinition.lastIndex = header.index + header[0].length;
  const definitionEnd = nextDefinition.exec(sql)?.index ?? sql.length;

  const definition = sql.slice(header.index, definitionEnd);
  const bodyStart = /\bas\s+\$function\$/i.exec(definition);
  if (!bodyStart) {
    return {
      found: true,
      readOnly: false,
      volatility: "",
      reason: `public.${functionName}() is not defined with a $function$ body, so its body cannot be inspected`,
    };
  }

  const headerText = definition.slice(0, bodyStart.index);
  // The body is read to its own closing delimiter in the FULL text, not to the
  // bound above: a body that mentions `create … function (` itself (dynamic DDL)
  // must not be able to truncate the inspection and hide a write keyword that
  // follows it. Only the body's start is attributed to a definition.
  const bodyText = sql
    .slice(header.index + bodyStart.index + bodyStart[0].length)
    .split(/\$function\$/i)[0] ?? "";

  const volatility = /\b(immutable|stable|volatile)\b/i.exec(headerText.toLowerCase())?.[1] ?? "";
  const written = WRITE_KEYWORDS.filter((keyword) =>
    new RegExp(`\\b${keyword}\\b`, "i").test(bodyText));

  if (volatility && volatility !== "stable" && volatility !== "immutable") {
    return {
      found: true,
      readOnly: false,
      volatility,
      reason: `public.${functionName}() is declared ${volatility}; the gate only calls stable/immutable functions`,
    };
  }
  if (written.length > 0) {
    return {
      found: true,
      readOnly: false,
      volatility: volatility || "unspecified",
      reason: `public.${functionName}() contains ${written.join(", ")} — a function the gate calls must be read-only`,
    };
  }
  return {
    found: true,
    readOnly: true,
    volatility: volatility || "unspecified",
    reason: `public.${functionName}() is declared ${volatility || "without a volatility keyword"} and reads only — no write keyword appears in its body`,
  };
}

/** Every shipped function the gate depends on, checked against the SQL. */
export function inspectShippedSql(sql: string): CatalogueFinding[] {
  const findings: CatalogueFinding[] = [];
  for (const functionName of CATALOGUE_GATE_FUNCTIONS) {
    const verdict = inspectFunctionSource(sql, functionName);
    findings.push({
      level: verdict.found && verdict.readOnly ? "pass" : "fail",
      code: `catalogue.sql_read_only`,
      message: verdict.reason,
    });
  }
  return findings;
}

/* ── the payload, and what is buyable in it ──────────────────────────────── */

export interface CatalogueProductRow {
  id: string;
  sku: string;
  name_en?: string | null;
  name_ar?: string | null;
  stock_tracking_enabled: boolean;
  stock_quantity: number;
  active: boolean;
  show_on_website: boolean;
}

export interface CatalogueVariantRow {
  id: string;
  product_id: string;
  sku: string;
  stock_quantity: number;
  active: boolean;
}

/**
 * Defensively read one RPC payload.
 *
 * A response that is not an array of rows with the documented columns is a
 * FAILURE, never an empty catalogue: silently treating a schema drift, an error
 * body or an HTML page as "no products" is exactly how a broken deployment gets
 * promoted with a green tick.
 */
export function classifyCataloguePayload(
  payload: unknown,
  shape: "products" | "variants",
): { ok: true; rows: (CatalogueProductRow | CatalogueVariantRow)[] } | { ok: false; reason: string } {
  if (!Array.isArray(payload)) {
    return {
      ok: false,
      reason: payload === null || payload === undefined
        ? "the response was empty (not a JSON array)"
        : `the response is ${typeof payload}, not a JSON array of rows`,
    };
  }

  const rows: (CatalogueProductRow | CatalogueVariantRow)[] = [];
  for (let index = 0; index < payload.length; index += 1) {
    const row = payload[index];
    if (typeof row !== "object" || row === null) {
      return { ok: false, reason: `row ${index} is not an object` };
    }
    const record = row as Record<string, unknown>;
    const id = record.id;
    if (typeof id !== "string" || id.length === 0) {
      return { ok: false, reason: `row ${index} has no usable id` };
    }
    if (typeof record.stock_quantity !== "number" || !Number.isFinite(record.stock_quantity)) {
      return { ok: false, reason: `row ${index} (${id}) has no numeric stock_quantity` };
    }
    if (typeof record.active !== "boolean") {
      return { ok: false, reason: `row ${index} (${id}) has no boolean active flag` };
    }
    if (shape === "products") {
      if (typeof record.show_on_website !== "boolean") {
        return { ok: false, reason: `row ${index} (${id}) has no boolean show_on_website flag` };
      }
      if (typeof record.stock_tracking_enabled !== "boolean") {
        return { ok: false, reason: `row ${index} (${id}) has no boolean stock_tracking_enabled flag` };
      }
      rows.push({
        id,
        sku: typeof record.sku === "string" ? record.sku : "",
        name_en: (record.name_en ?? null) as string | null,
        name_ar: (record.name_ar ?? null) as string | null,
        stock_tracking_enabled: record.stock_tracking_enabled,
        stock_quantity: record.stock_quantity,
        active: record.active,
        show_on_website: record.show_on_website,
      });
    } else {
      if (typeof record.product_id !== "string" || record.product_id.length === 0) {
        return { ok: false, reason: `variant row ${index} (${id}) has no product_id` };
      }
      rows.push({
        id,
        product_id: record.product_id,
        sku: typeof record.sku === "string" ? record.sku : "",
        stock_quantity: record.stock_quantity,
        active: record.active,
      });
    }
  }
  return { ok: true, rows };
}

export interface CatalogueEvaluation {
  /** Products the public API lists and that may be published at all. */
  publicProducts: number;
  /** Units a shopper could actually check out right now. */
  sellableVariants: number;
  /** Products with at least one sellable unit. */
  sellableProducts: number;
  /** Products that must never be public; the RPC should not have returned them. */
  hiddenRows: number;
  /** Names of the first few sellable products, for a human reading the log. */
  examples: string[];
}

/**
 * What "sellable" means, in one place:
 *
 *   · stock is not tracked (`stock_tracking_enabled = false`) → sellable. The
 *     shop promises nothing about a shelf, so an order can always be placed.
 *   · the product has published combinations → sellable when at least one of
 *     them is above zero. Every option being empty means the PDP's chooser has
 *     nothing to offer and the quick-add is disabled.
 *   · otherwise → sellable when the product's own shelf is above zero.
 *
 * This mirrors `availableToPromise()`/`variantAvailableToPromise()` in
 * `src/modules/online/services/availability.ts`, which is what the storefront
 * itself uses to enable a buy button.
 */
export function evaluateCatalogue(
  products: readonly CatalogueProductRow[],
  variants: readonly CatalogueVariantRow[],
): CatalogueEvaluation {
  const publicProducts = products.filter((product) => product.active && product.show_on_website);
  const hiddenRows = products.length - publicProducts.length;
  const byProduct = new Map<string, CatalogueVariantRow[]>();
  for (const variant of variants) {
    if (!variant.active) continue;
    const list = byProduct.get(variant.product_id);
    if (list) list.push(variant);
    else byProduct.set(variant.product_id, [variant]);
  }

  let sellableProducts = 0;
  let sellableVariants = 0;
  const examples: string[] = [];
  for (const product of publicProducts) {
    const own = byProduct.get(product.id) ?? [];
    const positiveUnits = own.filter((variant) => variant.stock_quantity > 0).length;
    const sellable = !product.stock_tracking_enabled
      ? true
      : own.length > 0
        ? positiveUnits > 0
        : product.stock_quantity > 0;
    if (sellable) {
      sellableProducts += 1;
      sellableVariants += product.stock_tracking_enabled
        ? Math.max(positiveUnits, own.length === 0 ? product.stock_quantity : 0)
        : 1;
      if (examples.length < 5) examples.push(product.name_en || product.name_ar || product.sku || product.id);
    }
  }

  return { publicProducts: publicProducts.length, sellableProducts, sellableVariants, hiddenRows, examples };
}

/* ── findings and the verdict ────────────────────────────────────────────── */

export type CatalogueLevel = "pass" | "warn" | "fail";

export interface CatalogueFinding {
  level: CatalogueLevel;
  /** Stable id, e.g. `catalogue.sellable`, so CI logs can be grepped. */
  code: string;
  message: string;
}

export interface CatalogueGateVerdict {
  ok: boolean;
  findings: CatalogueFinding[];
  passed: number;
  warned: number;
  failed: number;
  evaluation: CatalogueEvaluation | null;
  /** True when the gate was satisfied because the empty storefront was declared. */
  allowedEmpty: boolean;
}

export interface CatalogueHttpResult {
  status: number;
  json?: unknown;
  /** Set by the transport instead of throwing, so it can be classified. */
  networkError?: string;
}

export type CatalogueTransport = (request: CatalogueRequest) => Promise<CatalogueHttpResult>;

/**
 * The one interpretation of `ALLOW_EMPTY_STOREFRONT`.
 *
 * It is the deliberate escape hatch for a deployment that is *meant* to have an
 * empty storefront (a pre-launch staging project, a shop between seasons). It is
 * awkward on purpose: only the exact string `true` counts — not `TRUE`, not
 * `True`, not `1`, `yes`, `on`, `"true "`, and not a stale `"false"`. Every one
 * of those fails closed, and the CLI prints which value it saw so a padded
 * variable is diagnosable rather than mysterious.
 */
export function allowEmptyStorefrontFlag(raw: string | undefined | null): boolean {
  return raw === "true";
}

function push(findings: CatalogueFinding[], level: CatalogueLevel, code: string, message: string): void {
  findings.push({ level, code, message });
}

function summarise(findings: readonly CatalogueFinding[]): Pick<CatalogueGateVerdict, "passed" | "warned" | "failed" | "ok"> {
  const failed = findings.filter((finding) => finding.level === "fail").length;
  return {
    failed,
    warned: findings.filter((finding) => finding.level === "warn").length,
    passed: findings.filter((finding) => finding.level === "pass").length,
    ok: failed === 0,
  };
}

/**
 * Run the gate. `transport` is injected so the whole decision path — including
 * an unreachable project and a malformed response — is testable without a
 * network, and so the only code that touches the socket is the tiny fetch
 * adapter in `scripts/catalogue.gate.mjs`.
 */
export async function runCatalogueGate(options: {
  projectUrl: string;
  anonKey: string;
  allowEmptyStorefront?: string;
  transport: CatalogueTransport;
}): Promise<CatalogueGateVerdict> {
  const findings: CatalogueFinding[] = [];
  const allowEmpty = allowEmptyStorefrontFlag(options.allowEmptyStorefront);

  findings.push(...inspectGateInputs(options));
  const plan = catalogueGatePlan(options.projectUrl, options.anonKey);
  findings.push(...assertReadOnlyPlan(plan));

  if (findings.some((finding) => finding.level === "fail")) {
    // A bad plan or a secret-shaped key means nothing is sent at all.
    const summary = summarise(findings);
    return { ...summary, findings, evaluation: null, allowedEmpty: false };
  }

  const answered = new Map<CatalogueGateFunction, unknown>();
  let transportFailed = false;
  for (const request of plan) {
    const result = await options.transport(request);
    if (result.networkError) {
      transportFailed = true;
      push(findings, "fail", "catalogue.unreachable",
        `${request.functionName}: the project could not be reached (${result.networkError})`);
      continue;
    }
    if (result.status < 200 || result.status >= 300) {
      transportFailed = true;
      push(findings, "fail", "catalogue.http",
        `${request.functionName} answered HTTP ${result.status}`);
      continue;
    }
    answered.set(request.functionName, result.json);
  }

  if (transportFailed) {
    const summary = summarise(findings);
    return { ...summary, findings, evaluation: null, allowedEmpty: false };
  }
  push(findings, "pass", "catalogue.reachable",
    `both public functions answered (${CATALOGUE_GATE_FUNCTIONS.join(", ")})`);

  const products = classifyCataloguePayload(answered.get("storefront_catalogue"), "products");
  const variants = classifyCataloguePayload(answered.get("storefront_branch_product_variants"), "variants");
  if (!products.ok) {
    push(findings, "fail", "catalogue.malformed", `storefront_catalogue: ${products.reason}`);
  }
  if (!variants.ok) {
    push(findings, "fail", "catalogue.malformed", `storefront_branch_product_variants: ${variants.reason}`);
  }
  if (!products.ok || !variants.ok) {
    const summary = summarise(findings);
    return { ...summary, findings, evaluation: null, allowedEmpty: false };
  }

  const evaluation = evaluateCatalogue(
    products.rows as CatalogueProductRow[],
    variants.rows as CatalogueVariantRow[],
  );

  if (evaluation.hiddenRows > 0) {
    push(findings, "warn", "catalogue.hidden_rows",
      `${evaluation.hiddenRows} row(s) came back from the public catalogue that are not active and website-visible; they were excluded`);
  }

  if (evaluation.publicProducts === 0) {
    push(findings, allowEmpty ? "warn" : "fail", "catalogue.empty",
      allowEmpty
        ? "the public catalogue is empty and ALLOW_EMPTY_STOREFRONT=true, so the release is permitted"
        : "the public catalogue is empty: storefront_catalogue() returned no rows. A production deployment must be able to sell something; set ALLOW_EMPTY_STOREFRONT=true only for a deployment that is deliberately empty.");
    if (allowEmpty) {
      push(findings, "warn", "catalogue.allow_empty",
        "ALLOW_EMPTY_STOREFRONT=true was used to permit an empty storefront");
    }
    const summary = summarise(findings);
    return { ...summary, findings, evaluation, allowedEmpty: allowEmpty };
  }

  if (evaluation.sellableProducts === 0) {
    push(findings, allowEmpty ? "warn" : "fail", "catalogue.nothing_sellable",
      `${evaluation.publicProducts} product(s) are listed but none of them can be bought: every tracked product is at zero stock and no published combination has stock either${allowEmpty ? " (permitted because ALLOW_EMPTY_STOREFRONT=true)" : ""}`);
    if (allowEmpty) {
      push(findings, "warn", "catalogue.allow_empty",
        "ALLOW_EMPTY_STOREFRONT=true was used to permit a catalogue with nothing sellable");
    }
    const summary = summarise(findings);
    return { ...summary, findings, evaluation, allowedEmpty: allowEmpty };
  }

  push(findings, "pass", "catalogue.products",
    `${evaluation.publicProducts} public product(s) listed`);
  push(findings, "pass", "catalogue.sellable",
    `${evaluation.sellableProducts} product(s) are buyable right now (${evaluation.sellableVariants} sellable combination/units) — e.g. ${evaluation.examples.join(", ")}`);

  const summary = summarise(findings);
  return { ...summary, findings, evaluation, allowedEmpty: allowEmpty };
}
