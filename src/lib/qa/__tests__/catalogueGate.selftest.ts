/**
 * The commercial catalogue gate's policy self-test.
 *
 * The gate is the release condition that answers "can this deployment actually
 * sell something?", so every way it could say *yes* by accident is pinned here:
 *
 *   · a healthy catalogue with stock passes;
 *   · a catalogue with no products fails, and passes only when
 *     `ALLOW_EMPTY_STOREFRONT` is exactly `true`;
 *   · a catalogue that exists but has nothing buyable fails (out of stock,
 *     archived rows, unpublished rows);
 *   · a malformed response fails instead of reading as "no products";
 *   · an unreachable project fails;
 *   · the request plan can only ever be the two read-only public functions;
 *   · a function redefined by a later migration is judged by its LAST
 *     definition, so an earlier read-only body cannot vouch for a later writer.
 */
import assert from "node:assert/strict";

import {
  CATALOGUE_GATE_FUNCTIONS,
  allowEmptyStorefrontFlag,
  assertReadOnlyPlan,
  catalogueGatePlan,
  classifyCataloguePayload,
  evaluateCatalogue,
  inspectFunctionSource,
  inspectGateInputs,
  inspectShippedSql,
  runCatalogueGate,
  type CatalogueFinding,
  type CatalogueProductRow,
  type CatalogueVariantRow,
  type CatalogueHttpResult,
  type CatalogueRequest,
} from "../catalogueGate";

let passed = 0;
function check(name: string, body: () => void | Promise<void>): void {
  try {
    const result = body();
    if (result instanceof Promise) {
      throw new Error(`check "${name}" returned a promise; use checkAsync`);
    }
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    console.error(`  ✗ ${name}\n    ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
async function checkAsync(name: string, body: () => Promise<void>): Promise<void> {
  try {
    await body();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    console.error(`  ✗ ${name}\n    ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

const levelOf = (findings: readonly CatalogueFinding[], code: string) =>
  findings.filter((finding) => finding.code === code).map((finding) => finding.level);

/* ── fixtures ────────────────────────────────────────────────────────────── */

const PRODUCT_URL = "https://alyq-production.supabase.co";
const ANON_JWT = [
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
  btoa(JSON.stringify({ iss: "supabase", role: "anon", ref: "gatecheck" })).replace(/=+$/, ""),
  "signature",
].join(".");

const product = (over: Partial<CatalogueProductRow> = {}): CatalogueProductRow => ({
  id: "p-1",
  sku: "RING-1",
  name_en: "Classic Gold Ring",
  name_ar: "خاتم ذهبي",
  stock_tracking_enabled: true,
  stock_quantity: 5,
  active: true,
  show_on_website: true,
  ...over,
});

const variant = (over: Partial<CatalogueVariantRow> = {}): CatalogueVariantRow => ({
  id: "v-1",
  product_id: "p-1",
  sku: "RING-1-GOLD-17",
  stock_quantity: 2,
  active: true,
  ...over,
});

/** A transport that answers the two planned calls from fixed payloads. */
function stubTransport(payloads: { products: unknown; variants: unknown }): {
  transport: (request: CatalogueRequest) => Promise<CatalogueHttpResult>;
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    transport: async (request) => {
      calls.push(request.url);
      const json = request.functionName === "storefront_catalogue" ? payloads.products : payloads.variants;
      return { status: 200, json };
    },
  };
}

/* ── 1 · the plan is closed and read-only ────────────────────────────────── */

check("the plan is exactly the two public functions, empty-bodied", () => {
  const plan = catalogueGatePlan(PRODUCT_URL, ANON_JWT);
  assert.equal(plan.length, 2);
  assert.deepEqual(plan.map((request) => request.functionName), [...CATALOGUE_GATE_FUNCTIONS]);
  for (const request of plan) {
    assert.equal(request.method, "POST", "PostgREST invokes functions with POST");
    assert.equal(request.body, "{}", "an empty body carries no arguments to write with");
    assert.match(request.url, /^https:\/\/alyq-production\.supabase\.co\/rest\/v1\/rpc\/storefront_(catalogue|branch_product_variants)$/);
  }
  assert.deepEqual(levelOf(assertReadOnlyPlan(plan), "catalogue.read_only"), ["pass"]);
});

check("a plan that named a table, another function or a non-empty body is refused", () => {
  const plan = cataloguePlan();
  assert.deepEqual(levelOf(assertReadOnlyPlan(plan), "catalogue.read_only"), ["fail"]);

  const tableWrite = catalogueGatePlan(PRODUCT_URL, ANON_JWT).map((request) => ({
    ...request,
    url: request.url.replace("/rpc/storefront_catalogue", "/products"),
  }));
  assert.deepEqual(levelOf(assertReadOnlyPlan(tableWrite), "catalogue.read_only"), ["fail"]);

  const withArguments = catalogueGatePlan(PRODUCT_URL, ANON_JWT).map((request) => ({ ...request, body: '{"quantity":9}' }));
  assert.deepEqual(levelOf(assertReadOnlyPlan(withArguments), "catalogue.read_only"), ["fail"]);

  const dropped = catalogueGatePlan(PRODUCT_URL, ANON_JWT).slice(0, 1);
  assert.deepEqual(levelOf(assertReadOnlyPlan(dropped), "catalogue.read_only"), ["fail"]);

  function cataloguePlan(): CatalogueRequest[] {
    return [{
      url: `${PRODUCT_URL}/rest/v1/products`,
      method: "POST",
      body: "{}",
      headers: {},
      functionName: "storefront_catalogue",
    }];
  }
});

check("a secret-shaped credential is refused before any request is built", () => {
  const secretClaim = [
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
    btoa(JSON.stringify({ role: "service_role" })).replace(/=+$/, ""),
    "signature",
  ].join(".");
  for (const key of [secretClaim, "sb_secret_abcdefghijklmnop", "SUPABASE_SERVICE_ROLE_KEY_VALUE"]) {
    const findings = inspectGateInputs({ projectUrl: PRODUCT_URL, anonKey: key });
    assert.deepEqual(levelOf(findings, "catalogue.input"), ["fail"], key.slice(0, 24));
  }
  assert.deepEqual(levelOf(inspectGateInputs({ projectUrl: "", anonKey: ANON_JWT }), "catalogue.input"), ["fail"]);
  assert.deepEqual(levelOf(inspectGateInputs({ projectUrl: PRODUCT_URL, anonKey: "" }), "catalogue.input"), ["fail"]);
  assert.deepEqual(levelOf(inspectGateInputs({ projectUrl: PRODUCT_URL, anonKey: ANON_JWT }), "catalogue.input"), ["pass"]);
});

/* ── 2 · the shipped SQL must stay read-only ─────────────────────────────── */

const STABLE_FUNCTION = `
create or replace function public.storefront_catalogue()
returns table(id uuid, stock_quantity integer, active boolean)
language sql
stable
security definer
set search_path = pg_catalog, public
as $function$
  select p.id, p.stock_quantity, p.active, p.created_at, p.updated_at
    from public.products p
   where p.active
$function$;
`;

check("a stable, select-only function passes the SQL inspection", () => {
  const verdict = inspectFunctionSource(STABLE_FUNCTION, "storefront_catalogue");
  assert.equal(verdict.found, true);
  assert.equal(verdict.readOnly, true);
  assert.equal(verdict.volatility, "stable");
  // The wording is "reads only" — the assertion is that the verdict explains itself.
  assert.match(verdict.reason, /reads only/);
  // `created_at`/`updated_at` must not read as `create`/`update`: the shipped
  // storefront function selects both.
  const shipped = levelOf(inspectShippedSql(STABLE_FUNCTION), "catalogue.sql_read_only");
  assert.deepEqual(shipped, ["pass", "fail"],
    "the products function passes and the absent variants function is reported");
});

check("a volatile function, or one whose body writes, is refused", () => {
  const writing = STABLE_FUNCTION.replace("where p.active", "where p.active;\n  delete from public.products where id is null");
  const volatileBody = STABLE_FUNCTION.replace("\nstable\n", "\nvolatile\n");
  const missing = inspectFunctionSource("select 1;", "storefront_catalogue");
  assert.equal(inspectFunctionSource(writing, "storefront_catalogue").readOnly, false);
  assert.match(inspectFunctionSource(writing, "storefront_catalogue").reason, /delete/);
  assert.equal(inspectFunctionSource(volatileBody, "storefront_catalogue").readOnly, false);
  assert.match(inspectFunctionSource(volatileBody, "storefront_catalogue").reason, /volatile/);
  assert.equal(missing.found, false);
  assert.equal(missing.readOnly, false);
});

/**
 * One `create or replace function public.storefront_catalogue()` definition,
 * quoted the way the argument says (`"function"` → `$function$`, `""` → `$$`).
 *
 * Concatenating several of these is what a migration history looks like, and it
 * is the shape the shipped SQL actually has: `0030_live_mode_hardening.sql`
 * defines the function with an `as $$` body and `0080_branch_stock_operations.sql`
 * redefines it with `as $function$`. `create or replace` means the LAST one is
 * the definition in the database the gate is about to call.
 */
const redefinition = (body: string, volatility = "stable", quote = "function"): string => `
create or replace function public.storefront_catalogue()
returns table(id uuid, stock_quantity integer, active boolean)
language sql
${volatility}
security definer
set search_path = pg_catalog, public
as $${quote}$
${body}
$${quote}$;
`;

check("the LAST definition in migration order wins, so a later writer is refused", () => {
  const readBody = "  select p.id, p.stock_quantity, p.active\n    from public.products p\n   where p.active";
  const writeBody = `${readBody};\n  delete from public.branch_stock_balances where quantity < 0`;

  // The regression: an earlier stable, select-only definition followed by a
  // later writing one. Reading the FIRST match reports the historical read-only
  // body and waves the release through; the effective definition deletes rows.
  const superseded = [redefinition(readBody), redefinition(writeBody)].join("\n");
  const verdict = inspectFunctionSource(superseded, "storefront_catalogue");
  assert.equal(verdict.found, true);
  assert.equal(verdict.readOnly, false,
    "an earlier read-only body must not vouch for the later definition that replaced it");
  assert.match(verdict.reason, /delete/, "the refusal names the write keyword from the LAST body");

  // And the gate-level verdict agrees, which is what stops the RPC being sent.
  assert.deepEqual(levelOf(inspectShippedSql(superseded), "catalogue.sql_read_only"), ["fail", "fail"],
    "a function the last migration turned into a writer fails the shipped-SQL check");

  // A later redefinition that only changes volatility is refused the same way.
  const volatileLater = [redefinition(readBody), redefinition(readBody, "volatile")].join("\n");
  assert.equal(inspectFunctionSource(volatileLater, "storefront_catalogue").readOnly, false);
  assert.match(inspectFunctionSource(volatileLater, "storefront_catalogue").reason, /volatile/);

  // Position is what decides it, not "some definition writes": with the clean
  // body last, the effective definition reads only and the gate passes.
  const restored = [redefinition(writeBody), redefinition(readBody)].join("\n");
  assert.equal(inspectFunctionSource(restored, "storefront_catalogue").readOnly, true);

  // Three files deep, with the mixed quoting the shipped SQL really uses, and
  // with the last header shouted: the global match is case-insensitive and still
  // lands on the final definition.
  const mixed = [
    redefinition(readBody, "stable", ""),
    redefinition(readBody),
    redefinition(writeBody).toUpperCase(),
  ].join("\n");
  const mixedVerdict = inspectFunctionSource(mixed, "storefront_catalogue");
  assert.equal(mixedVerdict.readOnly, false);
  assert.match(mixedVerdict.reason, /delete/i);
});

check("a body that mentions create … function ( cannot truncate its own inspection", () => {
  // The last definition quotes dynamic DDL that itself looks like a function
  // header. Attributing the body's START to a definition must not cut the body
  // short there, or the `delete` that follows would never be read.
  const dynamicDdl = [
    redefinition("  select p.id, p.stock_quantity, p.active from public.products p where p.active"),
    `
create or replace function public.storefront_catalogue()
returns void
language plpgsql
stable
security definer
as $function$
  execute 'create or replace function public.helper() returns void as $h$ select 1 $h$';
  delete from public.products where id is null;
$function$;
`,
  ].join("\n");
  const verdict = inspectFunctionSource(dynamicDdl, "storefront_catalogue");
  assert.equal(verdict.readOnly, false, "the whole effective body is read, past the DDL it mentions");
  assert.match(verdict.reason, /delete/);
  assert.deepEqual(levelOf(inspectShippedSql(dynamicDdl), "catalogue.sql_read_only"), ["fail", "fail"]);
});

/* ── 3 · payload classification ──────────────────────────────────────────── */

check("a well-formed payload is read; a malformed one is a failure, never an empty catalogue", () => {
  assert.equal(classifyCataloguePayload([product()], "products").ok, true);
  assert.equal(classifyCataloguePayload([], "products").ok, true, "an empty array is a valid empty catalogue");
  for (const payload of [null, undefined, {}, "[]", 7, [{ ...product(), id: "" }], [{ ...product(), stock_quantity: "5" }], [{ ...product(), show_on_website: "yes" }], [null]]) {
    const result = classifyCataloguePayload(payload, "products");
    assert.equal(result.ok, false, JSON.stringify(payload)?.slice(0, 40));
  }
  for (const payload of [null, [{}], [{ ...variant(), stock_quantity: null }], [{ ...variant(), product_id: "" }]]) {
    assert.equal(classifyCataloguePayload(payload, "variants").ok, false, JSON.stringify(payload)?.slice(0, 40));
  }
});

/* ── 4 · what is sellable ────────────────────────────────────────────────── */

check("sellable means: untracked, or a published combination with stock, or its own shelf above zero", () => {
  const untracked = evaluateCatalogue([product({ id: "p-1", stock_tracking_enabled: false, stock_quantity: 0 })], []);
  assert.equal(untracked.sellableProducts, 1, "an untracked product can always be ordered");

  const variantInStock = evaluateCatalogue([product({ id: "p-1" })], [variant({ stock_quantity: 3 })]);
  assert.equal(variantInStock.sellableProducts, 1);
  assert.equal(variantInStock.sellableVariants, 1);

  const variantsEmpty = evaluateCatalogue([product({ id: "p-1", stock_quantity: 99 })], [variant({ stock_quantity: 0 })]);
  assert.equal(variantsEmpty.sellableProducts, 0, "the product rollup must not rescue an empty variant shelf");

  const plainInStock = evaluateCatalogue([product({ id: "p-1", stock_quantity: 1 })], []);
  assert.equal(plainInStock.sellableProducts, 1);

  const plainEmpty = evaluateCatalogue([product({ id: "p-1", stock_quantity: 0 })], []);
  assert.equal(plainEmpty.sellableProducts, 0);

  const archivedOnly = evaluateCatalogue([product({ id: "p-1", active: false })], [variant({ stock_quantity: 5 })]);
  assert.equal(archivedOnly.publicProducts, 0);
  assert.equal(archivedOnly.hiddenRows, 1);

  // The public catalogue cannot say "this product has variants, all unpublished"
  // — `storefront_catalogue()` does not return `variants_enabled`, which is the
  // same reason the storefront itself patches the flag from variant presence.
  // Such a product therefore reads as a plain product and its own shelf (the
  // variant rollup) decides, exactly as `catalogQuery` decides in the browser.
  const inactiveVariant = evaluateCatalogue([product({ id: "p-1", stock_quantity: 0 })], [variant({ stock_quantity: 5, active: false })]);
  assert.equal(inactiveVariant.sellableProducts, 0, "an unpublished combination cannot make an empty product buyable");
  assert.equal(
    evaluateCatalogue([product({ id: "p-1", stock_quantity: 2 })], [variant({ stock_quantity: 5, active: false })]).sellableProducts,
    1,
    "with a non-empty rollup the product is buyable as a plain line — the app agrees",
  );
});

/* ── 5 · the five required scenarios ─────────────────────────────────────── */

await checkAsync("positive — a catalogue with stock passes the gate", async () => {
  const { transport, calls } = stubTransport({
    products: [product({ id: "p-1", stock_quantity: 0 }), product({ id: "p-2", sku: "EARR-2" })],
    variants: [variant({ id: "v-1", product_id: "p-1", stock_quantity: 4 })],
  });
  const verdict = await runCatalogueGate({ projectUrl: PRODUCT_URL, anonKey: ANON_JWT, transport });
  assert.equal(verdict.ok, true, JSON.stringify(verdict.findings));
  assert.deepEqual(levelOf(verdict.findings, "catalogue.sellable"), ["pass"]);
  assert.equal(verdict.evaluation?.sellableProducts, 2);
  assert.equal(calls.length, 2, "exactly the two planned calls were made");
  assert.deepEqual(verdict.findings.filter((f) => f.level === "fail"), []);
});

await checkAsync("zero-catalogue — an empty storefront fails unless it is declared", async () => {
  const { transport } = stubTransport({ products: [], variants: [] });
  const verdict = await runCatalogueGate({ projectUrl: PRODUCT_URL, anonKey: ANON_JWT, transport });
  assert.equal(verdict.ok, false);
  assert.deepEqual(levelOf(verdict.findings, "catalogue.empty"), ["fail"]);
  assert.match(verdict.findings.find((f) => f.code === "catalogue.empty")!.message, /ALLOW_EMPTY_STOREFRONT=true/);
});

await checkAsync("allow-empty — only the exact value `true` permits an empty storefront", async () => {
  const { transport } = stubTransport({ products: [], variants: [] });
  for (const value of ["true"]) {
    const verdict = await runCatalogueGate({ projectUrl: PRODUCT_URL, anonKey: ANON_JWT, allowEmptyStorefront: value, transport });
    assert.equal(verdict.ok, true, `value ${JSON.stringify(value)} should permit an empty storefront`);
    assert.deepEqual(levelOf(verdict.findings, "catalogue.empty"), ["warn"]);
    assert.deepEqual(levelOf(verdict.findings, "catalogue.allow_empty"), ["warn"]);
    assert.equal(verdict.allowedEmpty, true);
  }
  for (const value of ["TRUE", "True", "1", "yes", "on", "false", "", " true", "true ", "truely", undefined, null]) {
    const verdict = await runCatalogueGate({ projectUrl: PRODUCT_URL, anonKey: ANON_JWT, allowEmptyStorefront: value as string, transport });
    assert.equal(verdict.ok, false, `value ${JSON.stringify(value)} must not permit an empty storefront`);
    assert.deepEqual(levelOf(verdict.findings, "catalogue.empty"), ["fail"]);
  }
});

await checkAsync("allow-empty does not launder a catalogue that exists but cannot be bought", async () => {
  const { transport } = stubTransport({ products: [product({ stock_quantity: 0 })], variants: [] });
  const strict = await runCatalogueGate({ projectUrl: PRODUCT_URL, anonKey: ANON_JWT, transport });
  assert.equal(strict.ok, false);
  assert.deepEqual(levelOf(strict.findings, "catalogue.nothing_sellable"), ["fail"]);

  const declared = await runCatalogueGate({ projectUrl: PRODUCT_URL, anonKey: ANON_JWT, allowEmptyStorefront: "true", transport });
  assert.deepEqual(levelOf(declared.findings, "catalogue.nothing_sellable"), ["warn"],
    "a declared-empty deployment is permitted, and the declaration is reported");
  assert.equal(declared.ok, true);
  assert.equal(declared.allowedEmpty, true);
});

await checkAsync("malformed-response — a schema drift fails instead of reading as empty", async () => {
  const missingColumns = await runCatalogueGate({
    projectUrl: PRODUCT_URL,
    anonKey: ANON_JWT,
    transport: stubTransport({ products: [{ id: "p-1", sku: "X" }], variants: [] }).transport,
  });
  assert.equal(missingColumns.ok, false);
  assert.deepEqual(levelOf(missingColumns.findings, "catalogue.malformed"), ["fail"]);
  assert.deepEqual(levelOf(missingColumns.findings, "catalogue.empty"), [], "a malformed answer is never 'no products'");

  const notJson = await runCatalogueGate({
    projectUrl: PRODUCT_URL,
    anonKey: ANON_JWT,
    transport: stubTransport({ products: "<html>gateway</html>", variants: [] }).transport,
  });
  assert.equal(notJson.ok, false);
  assert.deepEqual(levelOf(notJson.findings, "catalogue.malformed"), ["fail"]);

  const errorBody = await runCatalogueGate({
    projectUrl: PRODUCT_URL,
    anonKey: ANON_JWT,
    transport: stubTransport({ products: { code: "PGRST202", message: "function not found" }, variants: [] }).transport,
  });
  assert.equal(errorBody.ok, false);
  assert.deepEqual(levelOf(errorBody.findings, "catalogue.malformed"), ["fail"]);
});

await checkAsync("malformed-response — a non-2xx answer fails and is not parsed", async () => {
  const verdict = await runCatalogueGate({
    projectUrl: PRODUCT_URL,
    anonKey: ANON_JWT,
    transport: async (request) => (request.functionName === "storefront_catalogue"
      ? { status: 401, json: { message: "invalid api key" } }
      : { status: 200, json: [] }),
  });
  assert.equal(verdict.ok, false);
  assert.deepEqual(levelOf(verdict.findings, "catalogue.http"), ["fail"]);
  assert.deepEqual(levelOf(verdict.findings, "catalogue.empty"), []);
});

await checkAsync("network-error — an unreachable project fails without writing anything", async () => {
  const calls: string[] = [];
  const verdict = await runCatalogueGate({
    projectUrl: PRODUCT_URL,
    anonKey: ANON_JWT,
    transport: async (request) => {
      calls.push(request.body);
      return { status: 0, networkError: "getaddrinfo ENOTFOUND alyq-production.supabase.co" };
    },
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.findings.filter((finding) => finding.code === "catalogue.unreachable").length, 2);
  assert.deepEqual(levelOf(verdict.findings, "catalogue.reachable"), []);
  assert.ok(calls.every((body) => body === "{}"), "every attempted request was argument-free");
});

await checkAsync("permission-denied — a 403 from either function fails the release", async () => {
  const verdict = await runCatalogueGate({
    projectUrl: PRODUCT_URL,
    anonKey: ANON_JWT,
    transport: async (request) => (request.functionName === "storefront_branch_product_variants"
      ? { status: 403, json: { message: "permission denied for function" } }
      : { status: 200, json: [product({})] }),
  });
  assert.equal(verdict.ok, false);
  assert.deepEqual(levelOf(verdict.findings, "catalogue.http"), ["fail"]);
  assert.match(String(verdict.findings.find((f) => f.code === "catalogue.http")?.message), /HTTP 403/);
});

await checkAsync("timeout — a request that exceeds the bound fails, with no payload leaked", async () => {
  const verdict = await runCatalogueGate({
    projectUrl: PRODUCT_URL,
    anonKey: ANON_JWT,
    // What the CLI's bounded transport reports when `AbortController` fires.
    transport: async () => ({ status: 0, networkError: "timed out after 800 ms" }),
  });
  assert.equal(verdict.ok, false);
  const unreachable = verdict.findings.filter((finding) => finding.code === "catalogue.unreachable");
  assert.equal(unreachable.length, 2);
  assert.deepEqual(levelOf(verdict.findings, "catalogue.sellable"), [], "a timeout is never read as an empty shop");
  for (const finding of unreachable) assert.match(finding.message, /timed out after 800 ms/);
  for (const finding of verdict.findings) {
    assert.ok(!finding.message.includes(ANON_JWT), "no finding echoes the credential");
    assert.ok(!finding.message.includes("{"), "no finding echoes a response body");
  }
});

await checkAsync("a secret-shaped key stops the gate before it calls anything", async () => {
  let called = false;
  const verdict = await runCatalogueGate({
    projectUrl: PRODUCT_URL,
    anonKey: "sb_secret_do_not_use_this_in_a_browser",
    transport: async () => {
      called = true;
      return { status: 200, json: [] };
    },
  });
  assert.equal(verdict.ok, false);
  assert.equal(called, false, "nothing left the process");
  assert.deepEqual(levelOf(verdict.findings, "catalogue.input"), ["fail"]);
});

/* ── 6 · the flag itself ─────────────────────────────────────────────────── */

check("ALLOW_EMPTY_STOREFRONT counts only the exact string true", () => {
  assert.equal(allowEmptyStorefrontFlag("true"), true);
  for (const value of ["TRUE", "True", "1", "yes", "on", "false", "", " true", "true ", "true\n", null, undefined, "truely"]) {
    assert.equal(allowEmptyStorefrontFlag(value as string), false, JSON.stringify(value));
  }
});

console.log(`\n${passed}/${passed} catalogue-gate policy tests passed`);
