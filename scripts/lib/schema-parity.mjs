/**
 * Schema ↔ application parity checks, run by `scripts/migrations.check.mjs`.
 *
 * Both checks compare two things that must agree but are maintained in
 * different languages, so drift is a matter of time unless something fails:
 *
 *   1. column parity — the `…Row` interfaces in the Supabase repositories
 *      against the columns the migrations create. A column that is read or
 *      written but never created fails in production on the first query.
 *   2. capability parity — `ROLE_CAPABILITIES` in `src/lib/permissions/roles.ts`
 *      against `public.role_capabilities`, which every RLS policy consults. If
 *      they disagree, the UI offers an action the database refuses (or permits
 *      one the UI hides).
 *
 * Neither check knows anything about drivers: they receive a context with a
 * `query(sql)` function returning rows as arrays of strings.
 */
import fs from "node:fs";
import path from "node:path";

/** Tables whose name does not follow from an interface name. */
const TABLE_ALIASES = {
  audit: "audit_log",
  stockmovement: "stock_movements",
  salepayment: "sale_payments",
  saleitem: "sale_items",
  sale: "sales",
  returnitem: "return_items",
  salesreturn: "sales_returns",
  refund: "refund_records",
  profile: "profiles",
  category: "categories",
  movement: "stock_movements",
  return: "sales_returns",
};

/** `interface ExpenseRow { … }` → `{ name, columns }`, parsed from the source. */
function rowInterfaces(source) {
  const interfaces = [];
  const blockRe = /interface\s+(\w*Row)\s*\{([\s\S]*?)\n\}/g;
  const columnRe = /^\s{2,}([a-z][a-z0-9_]*)\??\s*:/gm;
  for (const block of source.matchAll(blockRe)) {
    interfaces.push({
      name: block[1],
      columns: [...block[2].matchAll(columnRe)].map((m) => m[1]),
    });
  }
  return interfaces;
}

export async function checkColumnParity({ driver, failures, c, log, sources, root }) {
  log(c.bold("\nColumn parity with the live repositories"));

  const checked = [];
  const problems = [];
  const skipped = [];

  for (const file of sources) {
    const source = fs.readFileSync(file, "utf8");
    const tables = new Set([...source.matchAll(/\.from\(\s*"([a-z0-9_]+)"/g)].map((m) => m[1]));
    const interfaces = rowInterfaces(source);
    if (interfaces.length === 0 || tables.size === 0) continue;

    for (const iface of interfaces) {
      const base = iface.name.replace(/Row$/, "").toLowerCase();
      const candidates = [TABLE_ALIASES[base], base, `${base}s`, `${base}es`].filter(Boolean);

      // A file that touches exactly one table makes the association
      // unambiguous; otherwise the interface name has to name one of the
      // file's tables.
      const table = tables.size === 1 ? [...tables][0] : candidates.find((t) => tables.has(t));

      if (!table) {
        skipped.push(`${iface.name} in ${path.relative(root, file)} — which table?`);
        continue;
      }

      const rows = await driver.query(
        `select column_name from information_schema.columns
          where table_schema = 'public' and table_name = '${table}'`,
      );
      const existing = new Set(rows.map((r) => r[0]));
      if (existing.size === 0) {
        skipped.push(`${table} — table not created yet`);
        continue;
      }

      const missing = iface.columns.filter((column) => !existing.has(column));
      if (missing.length > 0) {
        problems.push(`${table}: missing ${missing.join(", ")}  (${iface.name})`);
      } else {
        checked.push(`${table} — ${iface.columns.length} columns (${iface.name})`);
      }
    }
  }

  if (problems.length > 0) {
    for (const problem of problems) log(`  ${c.red("✗")} ${problem}`);
    failures.push({ name: "column parity", phase: "expectation", error: problems[0] });
  } else {
    log(`  ${c.green("✓")} every repository row interface matches its table`);
    for (const entry of [...new Set(checked)].sort()) log(c.dim(`      ${entry}`));
  }
  for (const entry of [...new Set(skipped)].sort()) log(c.dim(`      · not checked: ${entry}`));
}

export async function checkCapabilityParity({ driver, failures, c, log, rolesFile }) {
  log(c.bold("\nCapability matrix parity"));

  const source = fs.readFileSync(rolesFile, "utf8");

  const listMatch = source.match(/export const CAPABILITIES = \[([\s\S]*?)\] as const;/);
  const matrixMatch = source.match(/export const ROLE_CAPABILITIES[^=]*= \{([\s\S]*?)\n\};/);
  if (!listMatch || !matrixMatch) {
    const error = "could not parse CAPABILITIES / ROLE_CAPABILITIES from roles.ts";
    log(`  ${c.red("✗")} ${error}`);
    failures.push({ name: "capability parity", phase: "expectation", error });
    return;
  }

  const allCapabilities = [...listMatch[1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);

  const expected = new Map();
  for (const entry of matrixMatch[1].matchAll(/(\w+):\s*(CAPABILITIES|\[([\s\S]*?)\])/g)) {
    const role = entry[1];
    const capabilities =
      entry[2].trim() === "CAPABILITIES"
        ? allCapabilities
        : [...(entry[3] ?? "").matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
    expected.set(role, new Set(capabilities));
  }

  if (expected.size === 0) {
    const error = "no roles parsed from ROLE_CAPABILITIES";
    log(`  ${c.red("✗")} ${error}`);
    failures.push({ name: "capability parity", phase: "expectation", error });
    return;
  }

  const actual = new Map();
  for (const [role, capability] of await driver.query(
    `select role::text, capability from public.role_capabilities`,
  )) {
    if (!actual.has(role)) actual.set(role, new Set());
    actual.get(role).add(capability);
  }

  const problems = [];
  for (const [role, capabilities] of expected) {
    const granted = actual.get(role) ?? new Set();
    for (const capability of capabilities) {
      if (!granted.has(capability)) {
        problems.push(`roles.ts grants ${role} '${capability}', the database does not`);
      }
    }
    for (const capability of granted) {
      if (!capabilities.has(capability)) {
        problems.push(`the database grants ${role} '${capability}', roles.ts does not`);
      }
    }
  }
  for (const [role, granted] of actual) {
    if (!expected.has(role)) {
      problems.push(`the database knows role '${role}' with ${granted.size} grant(s); roles.ts does not`);
    }
  }

  if (problems.length > 0) {
    for (const problem of problems) log(`  ${c.red("✗")} ${problem}`);
    failures.push({ name: "capability parity", phase: "expectation", error: problems[0] });
    return;
  }

  const total = [...actual.values()].reduce((sum, set) => sum + set.size, 0);
  log(
    `  ${c.green("✓")} public.role_capabilities matches ROLE_CAPABILITIES (${actual.size} roles, ${total} grants)`,
  );
}

/**
 * Audit vocabulary parity — can every action the app can emit actually be
 * written, and is every entity in the enum used by one?
 *
 * `AUDIT_ACTIONS` / `AUDIT_ENTITIES` in src/modules/audit/types.ts are what the
 * UI offers and what `recordAudit()` sends; `public.audit_actions` is the
 * foreign-key target of `audit_log.action`. A missing row means the audit write
 * fails at runtime — after the money has moved.
 */
export async function checkAuditVocabularyParity({ driver, failures, c, log, auditTypesFile }) {
  log(c.bold("\nAudit vocabulary parity"));

  const source = fs.readFileSync(auditTypesFile, "utf8");
  const actionsMatch = source.match(/export const AUDIT_ACTIONS = \[([\s\S]*?)\] as const;/);
  const entitiesMatch = source.match(/export const AUDIT_ENTITIES = \[([\s\S]*?)\] as const;/);
  if (!actionsMatch || !entitiesMatch) {
    const error = "could not parse AUDIT_ACTIONS / AUDIT_ENTITIES from audit/types.ts";
    log(`  ${c.red("✗")} ${error}`);
    failures.push({ name: "audit vocabulary parity", phase: "expectation", error });
    return;
  }

  const actions = [...actionsMatch[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  const entities = new Set([...entitiesMatch[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]));

  const rows = await driver.query(`select action, entity from public.audit_actions`);
  const actual = new Map(rows.map(([action, entity]) => [action, entity]));

  const problems = [];
  for (const action of actions) {
    const entity = actual.get(action);
    if (entity === undefined) {
      problems.push(`types.ts can emit '${action}', public.audit_actions has no such action`);
    } else if (!entities.has(entity)) {
      problems.push(`'${action}' is stored against entity '${entity}', which AUDIT_ENTITIES does not list`);
    }
  }
  for (const action of actual.keys()) {
    if (!actions.includes(action)) {
      problems.push(`public.audit_actions has '${action}', types.ts cannot emit it`);
    }
  }
  const covered = new Set([...actual.values()]);
  for (const entity of entities) {
    if (!covered.has(entity)) problems.push(`AUDIT_ENTITIES lists '${entity}', which no action uses`);
  }

  if (problems.length > 0) {
    for (const problem of problems) log(`  ${c.red("✗")} ${problem}`);
    failures.push({ name: "audit vocabulary parity", phase: "expectation", error: problems[0] });
    return;
  }

  log(
    `  ${c.green("✓")} public.audit_actions matches AUDIT_ACTIONS (${actions.length} actions over ${entities.size} entities)`,
  );
}
