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
  // Online storefront (Phase 9): every table name is multi-word, so the
  // pluralised interface name never lands on one. Listing them here is what puts
  // the new repositories under the same column-parity guard as the old ones —
  // an interface that reads a column the migrations never created must fail.
  onlineorder: "online_orders",
  onlineorderitem: "online_order_items",
  orderevent: "order_events",
  stockreservation: "stock_reservations",
  productcontent: "product_content",
  websitesettings: "website_settings",
  storefaq: "store_faqs",
  storereview: "store_reviews",
  storecustomer: "store_customers",
  // Identity (Phase 10): `custom_roles` is read by the settings repository next
  // to `profiles`, so the file no longer touches exactly one table and the
  // interface name has to be mapped explicitly to stay under the same guard.
  customrole: "custom_roles",
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

/**
 * Role-alias parity — does the database resolve an outside role string the same
 * way TypeScript does?
 *
 * `ROLE_ALIASES` in roles.ts maps legacy/imported spellings onto the app roles
 * ("owner" → admin, "clerk" → inventory clerk). `public.role_aliases` is what
 * `normalize_app_role()` consults when a profile is created from Supabase
 * metadata. If the two disagree, the same account would have different powers
 * depending on whether it was created through the UI or the database — and an
 * alias that maps to a *more* powerful role on one side would be a privilege
 * escalation.
 */
export async function checkRoleAliasParity({ driver, failures, c, log, rolesFile }) {
  log(c.bold("\nRole alias parity"));

  const source = fs.readFileSync(rolesFile, "utf8");
  const block = source.match(/const ROLE_ALIASES[^=]*= \{([\s\S]*?)\n\};/);
  if (!block) {
    const error = "could not parse ROLE_ALIASES from roles.ts";
    log(`  ${c.red("✗")} ${error}`);
    failures.push({ name: "role alias parity", phase: "expectation", error });
    return;
  }

  const expected = new Map(
    [...block[1].matchAll(/(\w+):\s*"(\w+)"/g)].map((m) => [m[1], m[2]]),
  );
  const actual = new Map(
    await driver.query(`select alias, role::text from public.role_aliases`),
  );

  const problems = [];
  for (const [alias, role] of expected) {
    const stored = actual.get(alias);
    if (stored === undefined) problems.push(`roles.ts accepts '${alias}' → ${role}, the database does not`);
    else if (stored !== role) problems.push(`'${alias}' is ${role} in roles.ts but ${stored} in the database`);
  }
  for (const alias of actual.keys()) {
    if (!expected.has(alias)) problems.push(`the database accepts '${alias}', roles.ts does not`);
  }

  if (problems.length > 0) {
    for (const problem of problems) log(`  ${c.red("✗")} ${problem}`);
    failures.push({ name: "role alias parity", phase: "expectation", error: problems[0] });
    return;
  }

  log(`  ${c.green("✓")} public.role_aliases matches ROLE_ALIASES (${actual.size} aliases)`);
}

/**
 * Seed parity — does `supabase/seed.sql` leave behind the model the app ships?
 *
 * Three sources describe the same four custom roles: `CUSTOM_ROLE_PRESETS` in
 * src/lib/permissions/customRoles.ts (what Settings → Roles offers), the rows
 * seed.sql writes (what a fresh database contains), and the capability order in
 * src/lib/permissions/roles.ts (what the app stores after canonicalising). When
 * they disagree the drift is invisible until somebody signs in as a seeded
 * "Accountant" and finds a button that does nothing — or one that works when it
 * should not.
 *
 * So the check does three things:
 *   1. compares the TypeScript presets with the SQL rows, field by field;
 *   2. reads the rows back out of the seeded database and compares again,
 *      including the array order the app would have written;
 *   3. proves the seeded model *behaves*: it assigns the accountant preset to the
 *      seeded cashier through the same RPC the UI calls, and checks that
 *      public.can() now follows the overlay instead of the system matrix — then
 *      puts the account back the way it was.
 *
 * Like the other checks it needs a driver, and it only ever touches rows the seed
 * itself created (fixed ids, fixed usernames), so running it against a project
 * with real data changes nothing that survives it.
 */
export async function checkSeedParity({
  driver,
  failures,
  c,
  log,
  rolesFile,
  presetsFile,
  demoUsersFile,
  seedFile,
}) {
  log(c.bold("\nSeed parity (supabase/seed.sql ↔ the app's role model)"));
  const problems = [];

  // ── the catalogue order, which is the order the app writes arrays in ──────
  const rolesSource = fs.readFileSync(rolesFile, "utf8");
  const catalogueMatch = rolesSource.match(/export const CAPABILITIES = \[([\s\S]*?)\] as const;/);
  if (!catalogueMatch) {
    problems.push("could not parse CAPABILITIES from roles.ts");
  }
  const catalogue = catalogueMatch
    ? [...catalogueMatch[1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1])
    : [];
  const canonical = (caps) =>
    [...new Set(caps)].sort((a, b) => {
      const ia = catalogue.indexOf(a);
      const ib = catalogue.indexOf(b);
      return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib) || a.localeCompare(b);
    });

  // ── the presets the app offers ────────────────────────────────────────────
  const presetsSource = fs.readFileSync(presetsFile, "utf8");
  const presets = [];
  const presetRe =
    /presetKey:\s*"([a-z0-9_]+)",\s*name_en:\s*"([^"]*)",\s*name_ar:\s*"([^"]*)",\s*base_role:\s*"([a-z_]+)",\s*capabilities:\s*\[([\s\S]*?)\]/g;
  for (const entry of presetsSource.matchAll(presetRe)) {
    presets.push({
      key: entry[1],
      name_en: entry[2],
      name_ar: entry[3],
      base_role: entry[4],
      capabilities: canonical([...entry[5].matchAll(/"([a-z_]+)"/g)].map((m) => m[1])),
    });
  }
  if (presets.length === 0) problems.push("no presets parsed from CUSTOM_ROLE_PRESETS");

  // ── the rows the seed writes ──────────────────────────────────────────────
  const seedSource = fs.readFileSync(seedFile, "utf8");
  const seeded = [];
  const seedRe =
    /'([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})',\s*'([a-z0-9_]+)',\s*'([a-z_]+)',\s*'([^']*)',\s*'([^']*)',\s*'([^']*)',\s*'([^']*)',\s*'\{([a-z0-9_,]*)\}'/g;
  for (const row of seedSource.matchAll(seedRe)) {
    seeded.push({
      id: row[1],
      key: row[2],
      base_role: row[3],
      name_en: row[4],
      name_ar: row[5],
      capabilities: row[8].split(",").filter(Boolean),
    });
  }
  if (seeded.length === 0) problems.push("no custom-role rows parsed from supabase/seed.sql");

  // ── 1. TypeScript ↔ SQL ───────────────────────────────────────────────────
  for (const preset of presets) {
    const row = seeded.find((candidate) => candidate.key === preset.key);
    if (!row) {
      problems.push(`seed.sql does not create the '${preset.key}' preset the app offers`);
      continue;
    }
    if (row.base_role !== preset.base_role) {
      problems.push(
        `preset '${preset.key}': seed.sql falls back to '${row.base_role}', the app to '${preset.base_role}'`,
      );
    }
    if (row.name_en !== preset.name_en || row.name_ar !== preset.name_ar) {
      problems.push(
        `preset '${preset.key}': seed.sql names it '${row.name_en}'/'${row.name_ar}', the app '${preset.name_en}'/'${preset.name_ar}'`,
      );
    }
    if (row.capabilities.join(",") !== preset.capabilities.join(",")) {
      problems.push(
        `preset '${preset.key}': seed.sql grants [${row.capabilities.join(", ")}], the app [${preset.capabilities.join(", ")}]`,
      );
    }
  }
  for (const row of seeded) {
    if (!presets.some((preset) => preset.key === row.key)) {
      problems.push(`seed.sql creates '${row.key}', which the app does not offer as a preset`);
    }
  }
  // Every capability the seed grants must be one the catalogue knows, otherwise
  // the insert is rejected by custom_roles' own validation.
  for (const row of seeded) {
    for (const capability of row.capabilities) {
      if (!catalogue.includes(capability)) {
        problems.push(`seed.sql grants '${row.key}' the unknown capability '${capability}'`);
      }
    }
  }

  if (problems.length > 0) {
    for (const problem of problems) log(`  ${c.red("✗")} ${problem}`);
    failures.push({ name: "seed parity", phase: "expectation", error: problems[0] });
    return;
  }
  log(
    `  ${c.green("✓")} seed.sql's ${seeded.length} presets match CUSTOM_ROLE_PRESETS (keys, names, base roles, capabilities in catalogue order)`,
  );

  // ── 2. what the seeded database actually holds ────────────────────────────
  const dbProblems = [];
  const rows = await driver.query(
    `select key, base_role::text, name_en, name_ar, array_to_string(capabilities, ',')
       from public.custom_roles
      where id::text like '22222222-%'
      order by key`,
  );
  for (const preset of presets) {
    const row = rows.find((candidate) => candidate[0] === preset.key);
    if (!row) {
      dbProblems.push(`the seeded database has no '${preset.key}' custom role`);
      continue;
    }
    if (row[1] !== preset.base_role) {
      dbProblems.push(`custom_roles.'${preset.key}'.base_role is '${row[1]}', expected '${preset.base_role}'`);
    }
    if (row[2] !== preset.name_en || row[3] !== preset.name_ar) {
      dbProblems.push(`custom_roles.'${preset.key}' is named '${row[2]}'/'${row[3]}'`);
    }
    const stored = (row[4] ?? "").split(",").filter(Boolean);
    if (stored.join(",") !== preset.capabilities.join(",")) {
      dbProblems.push(
        `custom_roles.'${preset.key}'.capabilities is [${stored.join(", ")}], expected [${preset.capabilities.join(", ")}]`,
      );
    }
  }
  if (rows.length > presets.length) {
    dbProblems.push(`the seeded database holds ${rows.length} preset rows, expected ${presets.length}`);
  }

  // ── the demo staff the login screen promises ──────────────────────────────
  const demoSource = fs.readFileSync(demoUsersFile, "utf8");
  const demo = [];
  const demoRe = /username:\s*"([a-z_]+)",\s*name:\s*"([^"]*)",\s*role:\s*"([a-z_]+)"/g;
  for (const entry of demoSource.matchAll(demoRe)) {
    demo.push({ username: entry[1], name: entry[2], role: entry[3] });
  }
  if (demo.length === 0) dbProblems.push("no demo accounts parsed from demoUsers.ts");

  const profiles = await driver.query(
    `select username, role::text, active::text from public.profiles order by username`,
  );
  const byUsername = new Map(profiles.map((row) => [row[0], { role: row[1], active: row[2] === "true" }]));

  // The five accounts seed_demo_staff() promises. Its usernames are the role
  // names ('inventory_clerk'), while the offline demo directory shortens one to
  // 'clerk' — so the promise that matters is per role: whichever spelling the
  // login card shows, an active account with that role must exist.
  for (const role of [...new Set(demo.map((account) => account.role))]) {
    const holders = profiles.filter((row) => row[1] === role && row[2] === "true");
    if (holders.length === 0) {
      dbProblems.push(`no active seeded account has the demo role '${role}'`);
    }
  }
  if (!byUsername.get("admin") || byUsername.get("admin").role !== "admin") {
    dbProblems.push("the seeded database has no 'admin' profile with the admin role");
  }
  for (const username of ["manager", "cashier", "inventory_clerk", "viewer"]) {
    if (!byUsername.get(username)) {
      dbProblems.push(`seed_demo_staff() did not leave a '${username}' profile behind`);
    }
  }

  if (dbProblems.length > 0) {
    for (const problem of dbProblems) log(`  ${c.red("✗")} ${problem}`);
    failures.push({ name: "seed parity", phase: "seed", error: dbProblems[0] });
    return;
  }
  log(
    `  ${c.green("✓")} the seeded database holds them: ${rows.length} custom roles, ${profiles.length} staff profiles, one per demo role`,
  );

  // ── 3. the seeded model behaves ───────────────────────────────────────────
  // Assign the accountant overlay to the seeded cashier through the RPC the UI
  // calls, and watch public.can() switch from the system matrix to the overlay.
  // This is the whole point of Phase 10 in one assertion: the same question,
  // answered by the database the way the app answers it.
  const behave = [];
  const asUser = async (id) => {
    await driver.query(`select set_config('request.jwt.claim.sub', '${id}', false)`);
    await driver.query(
      `select set_config('request.jwt.claims', '{"sub":"${id}","role":"authenticated"}', false)`,
    );
  };
  const can = async (capability) =>
    (await driver.query(`select public.can('${capability}')`))[0][0] === "true";

  try {
    const adminId = (await driver.query(`select id::text from auth.users where email = 'admin@alyq.local'`))[0]?.[0];
    const cashierId = (await driver.query(`select id::text from public.profiles where username = 'cashier'`))[0]?.[0];
    const accountantId = (await driver.query(`select id::text from public.custom_roles where key = 'accountant'`))[0]?.[0];
    if (!adminId || !cashierId || !accountantId) throw new Error("the seed left no admin, cashier or accountant role to test with");

    // What the overlay is expected to change is *derived*, not written down: the
    // cashier's own row in public.role_capabilities against the accountant
    // preset's list, both of which this check has already read. GAINED is what the
    // overlay grants and the matrix does not; LOST is the other way round. A probe
    // that hardcoded either list would silently stop testing anything the day
    // somebody moved `add_expense` — which is precisely what happened when this
    // probe was first written: a cashier *may* record an expense, and only a
    // manager may approve or edit one.
    const cashierMatrix = new Set(
      (await driver.query(`select capability from public.role_capabilities where role = 'cashier'`)).map(
        (row) => row[0],
      ),
    );
    const accountant = presets.find((preset) => preset.key === "accountant");
    if (!accountant) throw new Error("the accountant preset is missing, so the overlay cannot be probed");
    const overlay = new Set(accountant.capabilities);
    const GAINED = [...overlay].filter((capability) => !cashierMatrix.has(capability)).slice(0, 4);
    const LOST = [...cashierMatrix].filter((capability) => !overlay.has(capability)).slice(0, 4);
    if (GAINED.length === 0 || LOST.length === 0) {
      behave.push(
        "the accountant preset and the cashier's matrix do not differ in both directions, so assigning the overlay cannot be shown to replace the matrix",
      );
    }

    await asUser(cashierId);
    for (const capability of LOST) {
      if (!(await can(capability))) {
        behave.push(`a seeded cashier does not hold '${capability}' before any overlay is assigned`);
      }
    }
    for (const capability of GAINED) {
      if (await can(capability)) {
        behave.push(`a seeded cashier already holds '${capability}' before any overlay is assigned`);
      }
    }

    await asUser(adminId);
    await driver.query(`select public.admin_set_custom_role('${cashierId}', '${accountantId}')`);

    await asUser(cashierId);
    for (const capability of GAINED) {
      if (!(await can(capability))) behave.push(`the accountant overlay did not grant '${capability}'`);
    }
    for (const capability of LOST) {
      if (await can(capability)) {
        behave.push(
          `the accountant overlay still allows '${capability}' — an overlay replaces the matrix, it does not add to it`,
        );
      }
    }

    // Deactivating the overlay must degrade to the base role, not to nothing —
    // and not to the role the account had before it was assigned.
    await asUser(adminId);
    await driver.query(`select public.admin_set_custom_role_active('${accountantId}', false)`);
    await asUser(cashierId);
    const baseRole = (await driver.query(`select role::text from public.profiles where id = '${cashierId}'`))[0][0];
    if (baseRole !== accountant.base_role) {
      behave.push(
        `deactivating the accountant overlay left the account as '${baseRole}', not its base role '${accountant.base_role}'`,
      );
    }
    const baseMatrix = new Set(
      (
        await driver.query(
          `select capability from public.role_capabilities where role = '${accountant.base_role}'`,
        )
      ).map((row) => row[0]),
    );
    for (const capability of [...GAINED, ...LOST]) {
      if (await can(capability)) {
        behave.push(`a deactivated custom role still grants '${capability}'`);
      }
    }
    const retained = [...baseMatrix].slice(0, 3);
    for (const capability of retained) {
      if (!(await can(capability))) {
        behave.push(
          `after deactivation the account fell back to '${baseRole}' but lost '${capability}', which that role holds`,
        );
      }
    }

    // Put everything back: re-activate the preset, clear the overlay, restore the
    // cashier's system role (assigning moved it to the preset's base).
    await asUser(adminId);
    await driver.query(`select public.admin_set_custom_role_active('${accountantId}', true)`);
    await driver.query(`select public.admin_set_custom_role('${cashierId}', null)`);
    await driver.query(`update public.profiles set role = 'cashier' where id = '${cashierId}'`);
    await asUser(cashierId);
    for (const capability of LOST) {
      if (!(await can(capability))) {
        behave.push(`the cashier did not get '${capability}' back after the overlay was cleared`);
      }
    }
    for (const capability of GAINED) {
      if (await can(capability)) {
        behave.push(`clearing the overlay left '${capability}' behind`);
      }
    }

    await driver.query(`select set_config('request.jwt.claim.sub', '', false)`);
    await driver.query(`select set_config('request.jwt.claims', '', false)`);
  } catch (error) {
    behave.push(`the overlay behaviour check could not run: ${String(error.message).split("\n")[0]}`);
  }

  if (behave.length > 0) {
    for (const problem of behave) log(`  ${c.red("✗")} ${problem}`);
    failures.push({ name: "seed parity", phase: "behaviour", error: behave[0] });
    return;
  }
  log(
    `  ${c.green("✓")} public.can() follows the overlay: assign → accountant's list decides, deactivate → base role, clear → system matrix`,
  );
}

/**
 * Phase 17 behaviour: per-user exceptions, resolved by the database.
 *
 * The overlay probe above shows `public.can()` following a custom role. This one
 * shows it following a *person*: a grant adds what the role lacks, a denial
 * removes what the role holds, and a denial wins over a grant of the same act —
 * in the SQL, not only in TypeScript. The two implementations are separate code
 * paths (migration 0028 and `src/lib/permissions/exceptions.ts`), so agreement
 * is a claim worth checking rather than assuming.
 *
 * Everything expected here is derived from `public.role_capabilities`: which
 * capability to take away is "one the seeded cashier holds", which to grant is
 * "one the cashier does not hold but another role does". Moving a capability
 * between roles therefore cannot silently turn this probe into a no-op.
 *
 * It also checks the two refusals the RPC exists to make, and that the customer
 * book is gated in the database as well as in the service — the module's whole
 * point is that hiding a button is not a security control.
 */
export async function checkExceptionParity({ driver, failures, c, log }) {
  const problems = [];
  const asUser = async (id) => {
    await driver.query(`select set_config('request.jwt.claim.sub', '${id}', false)`);
    await driver.query(
      `select set_config('request.jwt.claims', '{"sub":"${id}","role":"authenticated"}', false)`,
    );
  };
  const can = async (capability) =>
    (await driver.query(`select public.can('${capability}')`))[0][0] === "true";

  try {
    const adminId = (await driver.query(`select id::text from auth.users where email = 'admin@alyq.local'`))[0]?.[0];
    const cashierId = (await driver.query(`select id::text from public.profiles where username = 'cashier'`))[0]?.[0];
    if (!adminId || !cashierId) throw new Error("the seed left no admin or cashier to test with");

    const held = new Set(
      (await driver.query(`select capability from public.role_capabilities where role = 'cashier'`)).map((row) => row[0]),
    );
    const elsewhere = (
      await driver.query(`select capability from public.role_capabilities where role <> 'cashier' order by capability`)
    ).map((row) => row[0]);
    const DENY = [...held].sort()[0];
    const KEEP = [...held].sort().find((capability) => capability !== DENY);
    const GRANT = elsewhere.find((capability) => !held.has(capability));
    if (!DENY || !KEEP || !GRANT) {
      throw new Error("the cashier's matrix does not differ from the other roles in both directions");
    }

    // Baseline: before any exception, the matrix decides.
    await asUser(cashierId);
    if (!(await can(DENY))) problems.push(`a seeded cashier does not hold '${DENY}' before any exception is written`);
    if (!(await can(KEEP))) problems.push(`a seeded cashier does not hold '${KEEP}' before any exception is written`);
    if (await can(GRANT)) problems.push(`a seeded cashier already holds '${GRANT}' before any exception is written`);

    // A grant and a denial, written together.
    await asUser(adminId);
    await driver.query(
      `select public.admin_set_user_exceptions('${cashierId}', array['${GRANT}']::text[], array['${DENY}']::text[])`,
    );
    await asUser(cashierId);
    if (!(await can(GRANT))) problems.push(`the grant of '${GRANT}' did not reach public.can()`);
    if (await can(DENY)) problems.push(`the denial of '${DENY}' did not override the cashier's own matrix`);
    if (!(await can(KEEP))) problems.push(`writing exceptions disturbed '${KEEP}', which nothing mentioned`);

    // The set-returning resolver must agree with can(), capability by capability.
    const resolved = new Set(
      (await driver.query(`select capability from public.current_user_capabilities()`)).map((row) => row[0]),
    );
    if (!resolved.has(GRANT)) problems.push("current_user_capabilities() omits a granted capability");
    if (resolved.has(DENY)) problems.push("current_user_capabilities() still lists a denied capability");
    for (const capability of resolved) {
      if (!(await can(capability))) problems.push(`current_user_capabilities() lists '${capability}' but can() refuses it`);
    }

    // Deny wins over a grant of the same act — and wins in storage too, so the
    // disjointness constraint is never reached by a careless caller.
    await asUser(adminId);
    await driver.query(
      `select public.admin_set_user_exceptions('${cashierId}', array['${DENY}']::text[], array['${DENY}']::text[])`,
    );
    await asUser(cashierId);
    if (await can(DENY)) problems.push(`deny did not win when '${DENY}' was granted and denied in the same call`);
    const storedExtra = (
      await driver.query(
        `select coalesce(array_to_string(extra_capabilities, ','), '') from public.profiles where id = '${cashierId}'`,
      )
    )[0][0];
    if (storedExtra.split(",").filter(Boolean).includes(DENY)) {
      problems.push(`the RPC stored a contradictory grant of '${DENY}' instead of dropping it`);
    }

    // The door is the only door: a seat without manage_users cannot write them.
    await asUser(cashierId);
    let refusedCaller = false;
    try {
      await driver.query(`select public.admin_set_user_exceptions('${adminId}', '{}', '{}')`);
    } catch {
      refusedCaller = true;
    }
    if (!refusedCaller) problems.push("a cashier was able to call public.admin_set_user_exceptions()");

    // And an admin cannot lock themselves out of the console.
    await asUser(adminId);
    let refusedSelfLockout = false;
    try {
      await driver.query(`select public.admin_set_user_exceptions('${adminId}', '{}', array['manage_users']::text[])`);
    } catch {
      refusedSelfLockout = true;
    }
    if (!refusedSelfLockout) problems.push("an administrator was allowed to deny themselves manage_users");

    // Clearing them gives the matrix back exactly as it was.
    await asUser(adminId);
    await driver.query(`select public.admin_set_user_exceptions('${cashierId}', '{}', '{}')`);
    await asUser(cashierId);
    if (!(await can(DENY))) problems.push(`clearing the exceptions did not give '${DENY}' back`);
    if (await can(GRANT)) problems.push(`clearing the exceptions left '${GRANT}' behind`);

    // The customer book is gated where it is stored, not only where it is shown.
    const policies = await driver.query(
      `select policyname, cmd, coalesce(qual, '') || ' ' || coalesce(with_check, '') from pg_policies
        where schemaname = 'public' and tablename = 'customers'`,
    );
    const expected = [
      ["SELECT", "view_customers"],
      ["INSERT", "add_customer"],
      ["UPDATE", "edit_customer"],
      ["DELETE", "delete_customer"],
    ];
    for (const [cmd, capability] of expected) {
      const rows = policies.filter((row) => row[1] === cmd);
      if (rows.length === 0) {
        problems.push(`public.customers has no ${cmd} policy`);
        continue;
      }
      if (!rows.some((row) => String(row[2]).includes(`'${capability}'`))) {
        problems.push(`the ${cmd} policy on public.customers does not ask for '${capability}'`);
      }
    }

    await driver.query(`select set_config('request.jwt.claim.sub', '', false)`);
    await driver.query(`select set_config('request.jwt.claims', '', false)`);
  } catch (error) {
    problems.push(`the exception behaviour check could not run: ${String(error.message).split("\n")[0]}`);
  }

  if (problems.length > 0) {
    for (const problem of problems) log(`  ${c.red("✗")} ${problem}`);
    failures.push({ name: "exception parity", phase: "behaviour", error: problems[0] });
    return;
  }
  log(
    `  ${c.green("✓")} public.can() follows the exceptions: a grant adds, a denial overrides, deny wins, clearing restores — and the customer book is gated in the database`,
  );
}
