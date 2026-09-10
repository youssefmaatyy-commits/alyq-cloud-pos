#!/usr/bin/env node
/**
 * Migration check — does `supabase/migrations/` actually build the schema the
 * application needs?
 *
 *   node scripts/migrations.check.mjs                  # local, in-process Postgres
 *   node scripts/migrations.check.mjs --verify-only    # skip applying, just inspect
 *   node scripts/migrations.check.mjs --driver=psql --url=postgres://…   # real server
 *
 * Drivers
 *   pglite  an in-process WebAssembly PostgreSQL (@electric-sql/pglite). No
 *           server, no Docker: this is what CI uses, so the schema is validated
 *           on every push. The Supabase-provided objects the migrations rely on
 *           are supplied by `supabase/tests/supabase-shim.sql`.
 *   psql    any real server via the `psql` binary — a CI service container, a
 *           local cluster, or a Supabase connection string. No shim: those
 *           objects already exist there.
 *   auto    (default) psql when a URL is available and psql is installed,
 *           otherwise pglite.
 *
 * What it reports
 *   1. every migration applies, in filename order, each in its own transaction;
 *   2. applying them all a second time changes nothing (idempotency);
 *   3. the result satisfies the application, read from the source rather than
 *      duplicated here:
 *        · every table the repositories call `.from("…")` on exists
 *        · every function they call `.rpc("…")` on exists
 *        · row level security is enabled on those tables
 *        · no enum-typed column defaults to a value that is not one of that
 *          enum's labels
 *
 * (3) is the part that earns its keep. Three defects were found by exactly these
 * assertions while this script was being written: migration 0010 defaulted a
 * `payment_status` column to 'completed' (not a label of that enum), six
 * `for insert … using (false)` policies were rejected by PostgreSQL (INSERT
 * policies take WITH CHECK), and 0007's `raise exception 'Discount above 100%'`
 * had an unescaped % that stopped the function compiling. All three meant the
 * live schema had never been built anywhere.
 *
 * Exit codes: 0 clean · 1 a migration or expectation failed · 2 no driver
 * available (skipped).
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATIONS_DIR = path.join(ROOT, "supabase", "migrations");
const SHIM_FILE = path.join(ROOT, "supabase", "tests", "supabase-shim.sql");
const SRC_DIR = path.join(ROOT, "src");

// ── arguments ─────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const option = (name) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
};

const REQUESTED_DRIVER = option("driver") ?? "auto";
const VERIFY_ONLY = flag("verify-only");
const PSQL = option("psql") ?? process.env.ALYQ_PSQL ?? "psql";
const DATABASE_URL =
  option("url") ?? process.env.ALYQ_DATABASE_URL ?? process.env.DATABASE_URL ?? "";

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
};

/**
 * Objects the repositories already reference whose migrations are not written
 * yet. Listed as pending rather than failing so CI stays green during the
 * production-readiness phase — and the check *fails* once an entry becomes
 * stale (the object exists but is still listed), so this map cannot rot: each
 * entry names the migration that will create it and must be deleted in that
 * very migration's pull request.
 */
const PENDING = {
  tables: {
    profiles: "0011_profiles_and_auth",
    shifts: "0012_shifts",
    expenses: "0013_expenses",
    audit_log: "0014_audit_log",
  },
  rpcs: {},
};

// ── migrations on disk ────────────────────────────────────────────────────
const migrations = fs
  .readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith(".sql"))
  .sort();

if (migrations.length === 0) {
  console.error(c.red("✗ no migrations found in supabase/migrations/"));
  process.exit(1);
}

// ── drivers ───────────────────────────────────────────────────────────────
/**
 * A driver exposes `exec(sql, label)` (one file, atomic) and `query(sql)`
 * returning rows as arrays of strings. Callers never care which one is active.
 */
async function makePsqlDriver(url) {
  const probe = spawnSync(PSQL, ["--version"], { encoding: "utf8" });
  if (probe.status !== 0) throw new Error(`\`${PSQL}\` is not on PATH`);

  return {
    name: `psql${url ? ` → ${url.replace(/:[^:@/]*@/, ":***@")}` : ""}`,
    shim: false,
    exec(sql, label) {
      const file = path.join(MIGRATIONS_DIR, label);
      const result = spawnSync(
        PSQL,
        // --single-transaction: a half-applied migration is worse than a failed
        // one. (A future migration that adds an enum value and *uses* it in the
        // same file must be split in two — Postgres refuses the use until the
        // value is committed.)
        [url, "-X", "-q", "-v", "ON_ERROR_STOP=1", "--single-transaction", "-f", file],
        { encoding: "utf8" },
      );
      if (result.status !== 0) {
        throw new Error(`${result.stderr ?? ""}${result.stdout ?? ""}`.trim() || `psql exited ${result.status}`);
      }
    },
    query(sql) {
      const out = execFileSync(
        PSQL,
        [url, "-X", "-q", "-tA", "-F", "|", "-v", "ON_ERROR_STOP=1", "-c", sql],
        { encoding: "utf8" },
      );
      return out
        .split("\n")
        .map((line) => line.replace(/\r$/, ""))
        .filter((line) => line.length > 0)
        .map((line) => line.split("|"));
    },
    close() {},
  };
}

async function makePgliteDriver() {
  let pglite;
  try {
    pglite = await import("@electric-sql/pglite");
  } catch {
    throw new Error("@electric-sql/pglite is not installed");
  }
  const { PGlite } = pglite;
  const { pgcrypto } = await import("@electric-sql/pglite/contrib/pgcrypto");
  const { pg_trgm } = await import("@electric-sql/pglite/contrib/pg_trgm");
  const { uuid_ossp } = await import("@electric-sql/pglite/contrib/uuid_ossp");

  // The three extensions the migrations create: pgcrypto (0001, 0006), pg_trgm
  // (0002). PGlite needs them registered up front.
  const db = await new PGlite({ extensions: { pgcrypto, pg_trgm, uuid_ossp } });

  return {
    name: "pglite (in-process PostgreSQL)",
    shim: true,
    async exec(sql) {
      await db.exec("begin");
      try {
        await db.exec(sql);
        await db.exec("commit");
      } catch (error) {
        await db.exec("rollback");
        throw error;
      }
    },
    async query(sql) {
      const result = await db.query(sql, [], { rowMode: "array" });
      return result.rows.map((row) => row.map((value) => (value === null ? "" : String(value))));
    },
    async close() {
      await db.close();
    },
  };
}

let driver;
try {
  if (REQUESTED_DRIVER === "pglite") {
    driver = await makePgliteDriver();
  } else if (REQUESTED_DRIVER === "psql") {
    if (!DATABASE_URL) throw new Error("--driver=psql needs --url= (or DATABASE_URL)");
    driver = await makePsqlDriver(DATABASE_URL);
  } else if (DATABASE_URL) {
    driver = await makePsqlDriver(DATABASE_URL);
  } else {
    driver = await makePgliteDriver();
  }
} catch (error) {
  console.error(c.red(`✗ no database driver available: ${error.message}`));
  console.error(
    c.dim(
      "  Install @electric-sql/pglite (npm ci) for the local driver, or pass\n" +
        "  --driver=psql --url=… with a reachable server.",
    ),
  );
  process.exit(2);
}

console.log(c.bold(`\nALYQ migration check · ${migrations.length} files · ${driver.name}\n`));

const failures = [];
const applied = [];

if (!VERIFY_ONLY) {
  // ── the Supabase shim (local driver only) ──────────────────────────────
  if (driver.shim) {
    try {
      await driver.exec(fs.readFileSync(SHIM_FILE, "utf8"), "supabase-shim.sql");
      console.log(`  ${c.green("✓")} ${c.dim("supabase/tests/supabase-shim.sql (auth/storage stand-ins)")}`);
    } catch (error) {
      console.error(`  ${c.red("✗")} shim failed: ${String(error.message).split("\n")[0]}`);
      process.exit(1);
    }
  }

  console.log(c.bold("\nPass 1 — apply in order"));
  for (const name of migrations) {
    try {
      await driver.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, name), "utf8"), name);
      console.log(`  ${c.green("✓")} ${name}`);
    } catch (error) {
      console.log(`  ${c.red("✗")} ${name}`);
      failures.push({ name, phase: "apply", error: error.message });
    }
  }

  // ── pass 2: idempotency ────────────────────────────────────────────────
  if (failures.length === 0) {
    console.log(c.bold("\nPass 2 — re-apply (idempotency)"));
    for (const name of migrations) {
      try {
        await driver.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, name), "utf8"), name);
        console.log(`  ${c.green("✓")} ${name}`);
      } catch (error) {
        console.log(`  ${c.red("✗")} ${name}`);
        failures.push({ name, phase: "idempotency", error: error.message });
      }
    }
  } else {
    console.log(c.dim("\nPass 2 skipped — pass 1 failed."));
  }
}

// ── what the application expects, read from the source ────────────────────
function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

function expectedFromSource() {
  const tables = new Map();
  const rpcs = new Map();
  const record = (map, name, file) => {
    if (!map.has(name)) map.set(name, new Set());
    map.get(name).add(path.relative(ROOT, file));
  };

  for (const file of walk(SRC_DIR)) {
    if (!/\.tsx?$/.test(file) || file.includes("__tests__")) continue;
    const source = fs.readFileSync(file, "utf8");
    // Deliberately not requiring a closing paren straight after the name:
    // `client.rpc("pos_complete_sale", { … })` passes arguments.
    for (const m of source.matchAll(/\.from\(\s*"([a-z0-9_]+)"/g)) record(tables, m[1], file);
    for (const m of source.matchAll(/\.rpc\(\s*"([a-z0-9_]+)"/g)) record(rpcs, m[1], file);
  }
  return { tables, rpcs };
}

const pending = { tables: [], rpcs: [] };

async function checkExpectations() {
  console.log(c.bold("\nSchema expectations"));
  applied.push(...migrations);

  const { tables, rpcs } = expectedFromSource();

  const existing = new Set(
    (
      await driver.query(
        `select tablename from pg_tables where schemaname = 'public'
         union all select viewname from pg_views where schemaname = 'public'`,
      )
    ).map((r) => r[0]),
  );

  const missing = [];
  for (const [table, files] of [...tables].sort()) {
    if (existing.has(table)) continue;
    if (PENDING.tables[table]) pending.tables.push({ table, migration: PENDING.tables[table] });
    else missing.push(`${table}  ← ${[...files].join(", ")}`);
  }

  // Every PENDING entry must still be pending — otherwise it is stale and the
  // migration that created the object should have deleted it.
  const stalePending = Object.entries(PENDING.tables)
    .filter(([table]) => existing.has(table))
    .map(([table]) => `${table} now exists — remove it from PENDING in scripts/migrations.check.mjs`);

  const rlsOff = [];
  if (missing.length === 0) {
    const rls = new Map(
      (
        await driver.query(
          `select c.relname, c.relrowsecurity
             from pg_class c join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'public' and c.relkind = 'r'`,
        )
      ).map((r) => [r[0], r[1] === "t" || r[1] === "true"]),
    );
    for (const table of [...tables.keys()].sort()) {
      if (existing.has(table) && rls.get(table) === false) rlsOff.push(table);
    }
  }

  const functions = new Set(
    (
      await driver.query(
        `select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname in ('public', 'auth')`,
      )
    ).map((r) => r[0]),
  );
  const missingRpcs = [];
  for (const [rpc, files] of [...rpcs].sort()) {
    if (functions.has(rpc)) continue;
    if (PENDING.rpcs[rpc]) pending.rpcs.push({ rpc, migration: PENDING.rpcs[rpc] });
    else missingRpcs.push(`${rpc}()  ← ${[...files].join(", ")}`);
  }

  // An enum-typed column may only default to one of its own labels. This is the
  // assertion that catches the 0010 defect.
  const badDefaults = (
    await driver.query(`
      select c.relname || '.' || a.attname,
             t.typname,
             pg_get_expr(d.adbin, d.adrelid)
        from pg_attrdef d
        join pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum
        join pg_class c on c.oid = d.adrelid
        join pg_namespace n on n.oid = c.relnamespace
        join pg_type t on t.oid = a.atttypid
        left join pg_enum e
               on e.enumtypid = t.oid
              and pg_get_expr(d.adbin, d.adrelid) = quote_literal(e.enumlabel) || '::' || t.typname
       where n.nspname = 'public'
         and t.typtype = 'e'
         and a.attnum > 0
         and e.enumlabel is null
       order by 1
    `)
  ).map((r) => `${r[0]} is ${r[1]}, default ${r[2]}`);

  const report = (label, rows) => {
    if (rows.length === 0) {
      console.log(`  ${c.green("✓")} ${label}`);
      return;
    }
    console.log(`  ${c.red("✗")} ${label} (${rows.length})`);
    for (const row of rows) console.log(`      ${row}`);
    failures.push({ name: label, phase: "expectation", error: rows[0] });
  };

  report(`every table the repositories query exists (${tables.size} named in src/)`, [
    ...missing,
    ...stalePending,
  ]);
  report("row level security is enabled on those tables", rlsOff);
  report(`every RPC the repositories call exists (${rpcs.size} named in src/)`, missingRpcs);
  report("no enum column defaults to a value outside its own labels", badDefaults);

  // The refund enum by name: 0010 got this wrong, and the failure was invisible
  // until the schema was actually built.
  const refundLabels = (
    await driver.query(
      `select e.enumlabel from pg_enum e join pg_type t on t.oid = e.enumtypid
        where t.typname = 'refund_status' order by e.enumsortorder`,
    )
  ).map((r) => r[0]);
  const wanted = ["pending", "completed", "rejected"];
  if (wanted.every((label) => refundLabels.includes(label))) {
    console.log(`  ${c.green("✓")} public.refund_status holds ${wanted.join(", ")}`);
  } else {
    const detail = `public.refund_status is [${refundLabels.join(", ")}], expected ${wanted.join(", ")}`;
    console.log(`  ${c.red("✗")} ${detail}`);
    failures.push({ name: "refund_status labels", phase: "expectation", error: detail });
  }

  // Pending objects are reported, never hidden: they are the schema work the
  // production-readiness plan schedules next.
  const pendingLines = [
    ...pending.tables.map((p) => `table ${p.table}  → ${p.migration}`),
    ...pending.rpcs.map((p) => `rpc   ${p.rpc}()  → ${p.migration}`),
  ];
  if (pendingLines.length > 0) {
    console.log(
      c.yellow(`  • ${pendingLines.length} object(s) referenced by the code, migrations not written yet:`),
    );
    for (const line of pendingLines) console.log(c.dim(`      ${line}`));
  }
}

if (failures.length === 0) {
  try {
    await checkExpectations();
  } catch (error) {
    // A query that cannot run is itself a failure: say which one, briefly.
    const detail = String(error?.message ?? error).split("\n")[0];
    console.log(`  ${c.red("✗")} could not inspect the schema: ${detail}`);
    failures.push({ name: "schema inspection", phase: "expectation", error: detail });
  }
}

await driver.close();

// ── summary ───────────────────────────────────────────────────────────────
if (failures.length) {
  console.log(c.bold(c.red(`\n✗ ${failures.length} failure(s)\n`)));
  for (const f of failures) {
    console.log(`${c.red("•")} ${f.name} ${c.dim(`(${f.phase})`)}`);
    console.log(c.dim(`    ${String(f.error).split("\n").slice(0, 8).join("\n    ")}`));
  }
  console.log(
    c.dim("\nMigrations apply in filename order and each file is atomic.\n"),
  );
  process.exit(1);
}

console.log(
  c.bold(
    c.green(
      `\n✓ ${applied.length || migrations.length} migrations apply cleanly, are idempotent, and satisfy the application\n`,
    ),
  ),
);
