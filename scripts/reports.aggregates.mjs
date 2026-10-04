#!/usr/bin/env node
/**
 * Differential suite for the report aggregates added in migration 0032.
 * ═══════════════════════════════════════════════════════════════════════════
 * The question this answers is narrow and unfakeable: does PostgreSQL compute
 * the SAME numbers the shipped TypeScript builders compute, over the same rows,
 * for the same window?
 *
 * Both sides are run against one real database:
 *
 *   TypeScript  ── the actual functions in src/ (bundled, not re-implemented),
 *                  fed the rows read back out of the database;
 *   PostgreSQL  ── the reports_* RPCs, fed nothing but the window.
 *
 * If they agree, the migration did not change a single figure a shop has already
 * been shown. That is the entire bar: 0032 moves WHERE the arithmetic happens,
 * and a move that changes an answer is a bug, not an optimisation.
 *
 * Why the dataset is 2,500 invoices and not twenty: `SALES_ROW_CAP` limits the
 * browser-side path to the most recent 1,000 sales, so on any real book the two
 * sides CANNOT agree — the client is silently summing a slice. The suite proves
 * that too (§5): it shows the truncated answer, the full answer, and that the
 * database returns the full one. A small dataset would have hidden the very
 * defect this phase exists to fix.
 *
 * Deliberately exercised, because these are where an aggregate quietly drifts:
 *   • invoices with NO payment rows — paymentTotals() attributes the whole
 *     total to the sale's own payment_method/payment_status, and a SQL rewrite
 *     that only reads sale_payments reports those invoices as unpaid or free;
 *   • split payments (cash + visa) — an invoice counted once, its money in two
 *     columns;
 *   • voided invoices — excluded from revenue, counted in their own two figures;
 *   • products that never sold — productPerformance() gives every catalogue
 *     product a row, so a left join is required, not an inner one;
 *   • an untracked product holding stock — stockValue uses the RAW quantity
 *     while `stock` is gated on tracking, and the two must disagree;
  *   • day bucketing under a non-UTC host timezone — the builders bucket by
  *     the UTC calendar day, so the database is asked for UTC too, and a
  *     second query in the host zone proves the zone parameter is
  *     load-bearing rather than decoration;
 *   • an empty window — zeros and empty arrays, not nulls and not an error;
 *   • who may ask — every RPC is gated by public.can('view_reports').
 *
 * Run: node scripts/reports.aggregates.mjs   (or: npm run test:e2e reports)
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The shop is in Cairo, not in UTC, and the sandbox usually is. Pinning the
// timezone proves the UTC-day contract holds where it matters: `dayKeyOf`,
// `withinDateRange` and `toTimestampBounds` bucket by the UTC calendar day, so
// on a Cairo host they must agree with a UTC-bucketing database for the right
// reason, and the host-zone comparison in §6 must still move invoices between
// days. Cairo is the interesting choice precisely because Egypt DOES observe
// daylight saving — +2 in winter, +3 in summer — so the cross-zone proof
// cannot be faked with a fixed offset. That is not a hypothetical: it is what
// the first draft of migration 0032 got wrong.
process.env.TZ = process.env.ALYQ_TEST_TZ || "Africa/Cairo";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MIG = path.join(ROOT, "supabase", "migrations");
const BUNDLE = path.join(os.tmpdir(), "alyq-reports.mjs");

// ── output ──────────────────────────────────────────────────────────────────
const c = {
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};
let pass = 0;
let fail = 0;
const ok = (msg) => {
  pass += 1;
  console.log(`  ${c.green("✓")} ${msg}`);
};
const no = (msg, detail) => {
  fail += 1;
  console.log(`  ${c.red("✗")} ${msg}`);
  if (detail) console.log(c.dim(`      ${String(detail).split("\n").join("\n      ").slice(0, 1400)}`));
};
const head = (title) => console.log(`\n${c.bold(title)}`);

// ── comparison ──────────────────────────────────────────────────────────────
// Half a cent. Both sides round money to 2dp, so anything larger is a real
// disagreement and anything smaller is a float artefact worth forgiving.
const TOL = 0.005;
const ISO_TS = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;
const num = (v) => (v === null || v === undefined || v === "" ? 0 : Number(v));
const fmt = (v) =>
  v === null || v === undefined
    ? String(v)
    : Array.isArray(v)
      ? `[${v.length}]`
      : typeof v === "object"
        ? `{${Object.keys(v).length} keys}`
        : String(v);

/** Numbers compare with tolerance (Postgres numerics arrive as strings); everything else by text. */
function eqv(a, b) {
  const an = typeof a === "number" || (typeof a === "string" && a.trim() !== "" && !Number.isNaN(Number(a)));
  const bn = typeof b === "number" || (typeof b === "string" && b.trim() !== "" && !Number.isNaN(Number(b)));
  if ((typeof a === "number" || typeof b === "number") && an && bn) return Math.abs(num(a) - num(b)) <= TOL;
  const sa = a instanceof Date ? a.toISOString() : String(a);
  const sb = b instanceof Date ? b.toISOString() : String(b);
  if (sa === sb) return true;
  // Postgres renders a timestamptz inside jsonb as "2026-06-16T21:57:00+00:00"
  // where JavaScript writes "2026-06-16T21:57:00.000Z". Same instant, two
  // spellings; a day key ("2026-06-16") has no "T" and is compared as text.
  if (ISO_TS.test(sa) && ISO_TS.test(sb)) {
    const ta = Date.parse(sa);
    const tb = Date.parse(sb);
    if (!Number.isNaN(ta) && !Number.isNaN(tb)) return ta === tb;
  }
  return false;
}

function walk(p, a, b, out) {
  const aObj = a !== null && typeof a === "object" && !(a instanceof Date);
  const bObj = b !== null && typeof b === "object" && !(b instanceof Date);
  if (!aObj || !bObj) {
    if (!eqv(a, b)) out.push(`${p || "(root)"}: ts=${fmt(a)} sql=${fmt(b)}`);
    return;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) {
      out.push(`${p}: shape ts=${fmt(a)} sql=${fmt(b)}`);
      return;
    }
    if (a.length !== b.length) out.push(`${p}: length ts=${a.length} sql=${b.length}`);
    for (let i = 0; i < Math.min(a.length, b.length); i += 1) walk(`${p}[${i}]`, a[i], b[i], out);
    return;
  }
  for (const k of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
    if (!(k in a)) out.push(`${p}.${k}: absent from the TypeScript side`);
    else if (!(k in b)) out.push(`${p}.${k}: absent from the SQL side`);
    else walk(p ? `${p}.${k}` : k, a[k], b[k], out);
  }
}

/** Drop the keys the client derives, so only the additive parts are compared. */
function strip(value, ignore) {
  if (!ignore?.length) return value;
  const drop = (v) => {
    if (Array.isArray(v)) return v.map(drop);
    if (v && typeof v === "object" && !(v instanceof Date)) {
      const o = {};
      for (const [k, x] of Object.entries(v)) if (!ignore.includes(k)) o[k] = drop(x);
      return o;
    }
    return v;
  };
  return drop(value);
}

/** Compare a whole aggregate. `key` makes an array order-insensitive by identity. */
function agree(label, ts, sql, { ignore = [], key = null } = {}) {
  const a = strip(ts, ignore);
  const b = strip(sql, ignore);
  const sortByKey = (v) =>
    Array.isArray(v) && key
      ? [...v].sort((x, y) => String(x?.[key] ?? "").localeCompare(String(y?.[key] ?? "")))
      : v;
  const out = [];
  walk("", sortByKey(a), sortByKey(b), out);
  if (out.length === 0) ok(label);
  else no(label, out.slice(0, 8).join("\n") + (out.length > 8 ? `\n…and ${out.length - 8} more` : ""));
  return out.length === 0;
}

// ── boot: one real database, built exactly as migrations.check.mjs builds it ─
const { PGlite } = await import("@electric-sql/pglite");
const { pgcrypto } = await import("@electric-sql/pglite/contrib/pgcrypto");
const { pg_trgm } = await import("@electric-sql/pglite/contrib/pg_trgm");
const { uuid_ossp } = await import("@electric-sql/pglite/contrib/uuid_ossp");
const db = await new PGlite({ extensions: { pgcrypto, pg_trgm, uuid_ossp } });

const q = async (sql, params = []) => (await db.query(sql, params)).rows;
const one = async (sql, params = []) => (await q(sql, params))[0] ?? {};
/** Run inside one transaction; `set_config(..., true)` is transaction-local, so identity lives here. */
async function tx(fn) {
  await db.exec("begin");
  try {
    const out = await fn();
    await db.exec("commit");
    return out;
  } catch (error) {
    await db.exec("rollback");
    throw error;
  }
}

await db.exec(fs.readFileSync(path.join(ROOT, "supabase", "tests", "supabase-shim.sql"), "utf8"));
for (const f of fs.readdirSync(MIG).filter((n) => n.endsWith(".sql")).sort()) {
  await db.exec(fs.readFileSync(path.join(MIG, f), "utf8"));
}
await db.exec(fs.readFileSync(path.join(ROOT, "supabase", "seed.sql"), "utf8"));
// Production's grant set: a browser may attempt any write, so RLS is the only gate.
await db.exec(
  "grant insert, update, delete on public.products, public.categories, public.stock_movements, public.expenses to authenticated",
);

const { buildAppBundle, bundleFileUrl } = await import("./lib/app-bundle.mjs");
await buildAppBundle({
  outfile: BUNDLE,
  entryPoint: path.join(ROOT, "scripts/lib/reportAggregates-entry.ts"),
});
const TS = await import(bundleFileUrl(BUNDLE, `run=${Date.now()}`));
console.log(`${c.dim("bundled the shipped builders from src/ →")} ${BUNDLE}`);

// The real seeded staff. Fixtures are attributed to actual profiles so the
// per-employee breakdown joins against people the database knows.
const staffRows = await q(
  `select id, name, role::text as role from public.profiles where active order by role, name`,
);
const byRole = (role) => staffRows.find((s) => s.role === role) ?? staffRows[0];
const STAFF = [byRole("admin"), byRole("cashier"), byRole("manager")].filter(Boolean);
const ADMIN = byRole("admin");

/** Impersonate: the legacy claim key the shim's auth.uid() reads, plus the Postgres role. */
const become = async (userId, role = "authenticated") => {
  await db.query("select set_config('request.jwt.claim.sub', $1, true)", [userId ?? ""]);
  await db.query("select set_config('role', $1, true)", [role]);
};

/**
 * Set ONLY the identity claim, staying the table owner.
 *
 * Loading fixtures is not something a browser can do, and must not be made to
 * look like one: `sales` grants authenticated SELECT only, with a
 * `with check (false)` insert policy, because pos_complete_sale is the single
 * writer that table has (0015). Granting INSERT here to get the data in would
 * quietly undo that decision and leave the suite testing a database the
 * production one does not resemble. So the fixtures are written as the owner —
 * which bypasses RLS the way a migration or a restore does — while the claim is
 * set to a real admin, because the capability triggers (add_expense and the
 * rest) ask public.can(), and that reads the claim rather than the role.
 */
const claim = async (userId) => {
  await db.query("select set_config('request.jwt.claim.sub', $1, true)", [userId ?? ""]);
};

// ── deterministic dataset ───────────────────────────────────────────────────
let seed = 20260913;
const rnd = () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
};
const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
const pick = (a) => a[Math.floor(rnd() * a.length)];
const m2 = (n) => Math.round(n * 100) / 100;
const esc = (s) => String(s).replace(/'/g, "''");

const DAY = 86_400_000;
const END = new Date("2026-09-13T18:00:00Z").getTime();
const SPAN_DAYS = 400; // more than a year, so "multiple years" is representable
const SALE_COUNT = 2500; // deliberately far past SALES_ROW_CAP (1,000)
const EXPENSE_COUNT = 220;
const EXPENSE_CATEGORIES = ["transport", "maintenance", "supplies", "utilities", "other"];

head("Dataset");
console.log(
  c.dim(
    `  ${SALE_COUNT} invoices across ${SPAN_DAYS} days, ${EXPENSE_COUNT} expenses, plus returns and refunds.\n` +
      `  Every figure below is generated from a fixed seed, so a failure reproduces exactly.`,
  ),
);

// Three catalogue products that pin down semantics a join could silently change.
await tx(async () => {
  await claim(ADMIN.id);
  await db.exec(`insert into public.products
    (id, sku, name_ar, name_en, category_id, product_type, selling_price, cost_price, tax_rate,
     stock_tracking_enabled, stock_quantity, low_stock_level, active, show_on_website)
    values
     ('00000000-0000-4000-8000-00000000d001','DIFF-UNT','غير متتبع','Untracked Diff',
      (select id from public.categories limit 1),'physical',99.00,40.00,15,false,7,3,true,false),
     ('00000000-0000-4000-8000-00000000d002','DIFF-COLD','لم يبع','Never Sold Diff',
      (select id from public.categories limit 1),'physical',250.00,120.00,15,true,12,5,true,false),
     ('00000000-0000-4000-8000-00000000d003','DIFF-LOW','مخزون منخفض','Low Stock Diff',
      (select id from public.categories limit 1),'physical',45.00,30.00,15,true,2,5,true,false)
    on conflict (id) do nothing`);
});

const sellable = await q(
  `select id, sku, name_ar, name_en, selling_price, cost_price from public.products
    where active and product_type = 'physical' order by id`,
);

const saleRows = [];
const itemRows = [];
const payRows = [];
for (let i = 0; i < SALE_COUNT; i += 1) {
  const id = `11111111-2222-4333-8444-${String(i).padStart(12, "0")}`;
  const at = new Date(END - int(0, SPAN_DAYS) * DAY - int(0, 23) * 3_600_000 - int(0, 59) * 60_000);
  const staff = pick(STAFF);
  const lines = [];
  const lineCount = int(1, 4);
  for (let l = 0; l < lineCount; l += 1) {
    const p = pick(sellable);
    const qty = int(1, 5);
    const unit = Number(p.selling_price);
    lines.push({ p, qty, unit, lineTotal: m2(unit * qty) });
  }
  const subtotal = m2(lines.reduce((acc, x) => acc + x.lineTotal, 0));
  const discountType = pick(["none", "none", "percent", "fixed"]);
  const discountValue = discountType === "percent" ? 5 : discountType === "fixed" ? 10 : 0;
  const discountAmount =
    discountType === "percent"
      ? m2((subtotal * discountValue) / 100)
      : discountType === "fixed"
        ? m2(Math.min(discountValue, subtotal))
        : 0;
  const total = m2(subtotal - discountAmount);
  const roll = rnd();
  const status = roll < 0.88 ? "completed" : roll < 0.95 ? "pending" : "voided";

  // The payment shapes that matter, including the one that is easy to get
  // wrong: an invoice with NO payment rows, which paymentTotals() attributes
  // wholly to the sale's own payment_method and payment_status. The shape is
  // decided first so the fallback method/status varies instead of always being
  // cash/paid — a rewrite that hardcodes the fallback would still pass.
  const shape = rnd();
  let saleMethod = "cash";
  let salePayStatus = "paid";
  if (shape >= 0.55 && shape < 0.75) saleMethod = "visa";
  else if (shape >= 0.75 && shape < 0.88) {
    saleMethod = "instapay";
    salePayStatus = "pending";
  } else if (shape >= 0.88) {
    saleMethod = pick(["cash", "instapay"]);
    salePayStatus = pick(["paid", "pending"]);
  }

  // sales_cash_received_covers_total (0015): a cash sale must record a tender;
  // visa and instapay carry none. Tender == total with zero change satisfies
  // every clause (tender >= change >= 0, and tender - change <= total).
  const tender = saleMethod === "cash" ? `${total},0` : "null,null";
  saleRows.push(
    `('${id}','DIFF-${i}','diff-ref-${i}','${status}','${at.toISOString()}'::timestamptz,'${discountType}',` +
      `${discountValue},${discountAmount},${discountAmount},${subtotal},${total},'${staff.id}','${esc(staff.name)}',` +
      `'${saleMethod}','${salePayStatus}',${tender})`,
  );
  for (const line of lines) {
    itemRows.push(
      `('${id}','${line.p.id}','${esc(line.p.name_ar)}','${esc(line.p.name_en)}','${esc(line.p.sku)}',` +
        `${line.unit},${line.qty},${line.lineTotal})`,
    );
  }
  if (shape < 0.55) {
    payRows.push(`('${id}','cash',${total},'paid')`);
  } else if (shape < 0.75) {
    const part = m2(total * 0.4);
    payRows.push(`('${id}','cash',${part},'paid')`);
    payRows.push(`('${id}','visa',${m2(total - part)},'paid')`);
  } else if (shape < 0.88) {
    payRows.push(`('${id}','instapay',${total},'pending')`);
  } // else: no payment rows at all — the legacy fallback branch
}

await tx(async () => {
  await claim(ADMIN.id);
  await db.exec(`insert into public.sales
    (id, sale_number, client_ref, status, created_at, discount_type, discount_value,
     discount_amount, total_discount_amount, subtotal, total, user_id, user_name, payment_method, payment_status,
     amount_received, "change")
    values ${saleRows.join(",")}`);
  await db.exec(`insert into public.sale_items
    (sale_id, product_id, name_ar, name_en, sku, unit_price, quantity, line_total)
    values ${itemRows.join(",")}`);
  await db.exec(`insert into public.sale_payments (sale_id, method, amount, status)
    values ${payRows.join(",")}`);
});

const expenseRows = [];
for (let i = 0; i < EXPENSE_COUNT; i += 1) {
  const at = new Date(END - int(0, SPAN_DAYS) * DAY - int(0, 23) * 3_600_000);
  const staff = pick(STAFF);
  const cat = pick(EXPENSE_CATEGORIES);
  const method = pick(["cash", "cash", "instapay", "visa"]);
  const amount = m2(int(15, 900) + rnd());
  // '' and NULL both have to appear: byBranch keys an empty branch as __none__
  // while its label stays empty, and only a real branch gets a real label.
  const branch = pick(["Main", "Branch 2", "", null]);
  expenseRows.push(
    `('DIFF-EXP-${i}','${esc(`${cat} #${i}`)}','${cat}',${amount},'${method}','${at.toISOString()}'::timestamptz,` +
      `${branch === null ? "null" : `'${esc(branch)}'`},'${staff.id}','${esc(staff.name)}')`,
  );
}

await tx(async () => {
  await claim(ADMIN.id);
  await db.exec(`insert into public.expenses
    (expense_number, name, category, amount, payment_method, spent_at, branch, user_id, user_name)
    values ${expenseRows.join(",")}`);

  // Returns and refunds, so the financial summary's refund columns are compared
  // against something other than zero. Linked to real invoices. Phase 2 binds
  // every completed cash refund to the authoritative open drawer in its branch,
  // so the fixture opens one instead of bypassing the settlement trigger.
  await db.exec(`insert into public.shifts
    (branch, register, opening_cash, opened_by, opened_by_name, opening_at)
    values ('Main', 'Aggregate fixture', 0, '${ADMIN.id}', '${esc(ADMIN.name)}',
      '2025-01-01T00:00:00Z'::timestamptz)`);
  await db.query(`with picked as (
      select s.id, s.sale_number, s.total, s.created_at,
             row_number() over (order by s.created_at, s.id) as g
        from public.sales s
       where s.client_ref like 'diff-ref-%'
       order by s.created_at
       limit 6
    )
    insert into public.sales_returns
      (return_number, sale_id, sale_number, reason, refund_amount, refund_method,
       user_id, user_name, refund_status, created_at)
    select 'DIFF-RET-' || g, id, sale_number, 'damaged', (total * 0.5)::numeric(14,2), 'cash',
           $1, $2, 'completed', created_at
      from picked`, [ADMIN.id, ADMIN.name]);

  await db.query(`with ranked as (
      select r.id, r.sale_id, r.sale_number, r.created_at, r.refund_amount,
             row_number() over (order by r.created_at, r.id) as g
        from public.sales_returns r
       where r.return_number like 'DIFF-RET-%'
    ),
    shaped as (
      select ranked.*,
             (array['completed','pending','completed','rejected'])[1 + (g % 4)] as st
        from ranked
    )
    -- refund_records_settlement_consistent (0016) ties the three settlement
    -- columns to the status: pending has neither a settled_at nor a reason,
    -- completed has a settled_at and no reason, rejected has both. All three
    -- states appear here, because the financial summary counts completed and
    -- pending separately and must ignore rejected altogether.
    insert into public.refund_records
      (refund_number, sale_id, sale_number, return_id, amount, payment_method, status, reason,
       settled_at, settled_by, settled_by_name, rejection_reason, user_id, user_name, created_at)
    select 'DIFF-REF-' || g, sale_id, sale_number, id,
           (refund_amount * 0.5)::numeric(14,2), 'cash', st::public.refund_status, 'damaged',
           case when st = 'pending' then null else created_at end,
           case when st = 'pending' then null else $1 end,
           case when st = 'pending' then null else $2 end,
           case when st = 'rejected' then 'goods unusable' else null end,
           $1, $2, created_at
      from shaped`, [ADMIN.id, ADMIN.name]);
});

const counts = await one(`select
    (select count(*) from public.sales          where client_ref like 'diff-ref-%') as sales,
    (select count(*) from public.sale_items     si join public.sales s on s.id = si.sale_id
      where s.client_ref like 'diff-ref-%')                                          as items,
    (select count(*) from public.sale_payments  p  join public.sales s on s.id = p.sale_id
      where s.client_ref like 'diff-ref-%')                                          as payments,
    (select count(*) from public.sales          where client_ref like 'diff-ref-%'
       and not exists (select 1 from public.sale_payments p where p.sale_id = public.sales.id)) as no_payment,
    (select count(*) from public.expenses       where expense_number like 'DIFF-EXP-%') as expenses,
    (select count(*) from public.sales_returns  where return_number like 'DIFF-RET-%')  as returns,
    (select count(*) from public.refund_records where refund_number like 'DIFF-REF-%')  as refunds,
    (select count(*) from public.sales)                                                 as all_sales,
    (select count(*) from public.products)                                              as all_products`);
console.log(
  `  ${counts.sales} invoices · ${counts.items} lines · ${counts.payments} payment rows` +
    ` · ${c.bold(`${counts.no_payment} with none`)} (the fallback branch)`,
);
console.log(
  `  ${counts.expenses} expenses · ${counts.returns} returns · ${counts.refunds} refunds` +
    ` · ${counts.all_sales} invoices and ${counts.all_products} products in total (seed included)`,
);
if (Number(counts.sales) <= TS.SALES_ROW_CAP) {
  no("the dataset must exceed SALES_ROW_CAP", `${counts.sales} <= ${TS.SALES_ROW_CAP}`);
}

// ── read the database back into the app's own domain shapes ─────────────────
// The TypeScript side is fed exactly what the browser would be fed, so the only
// difference between the two sides is where the arithmetic runs.
const isoOf = (v) => (v instanceof Date ? v.toISOString() : v === null || v === undefined ? null : String(v));

const salesRaw = await q(`select id, sale_number, client_ref, status::text as status,
       subtotal, discount_type::text as discount_type, discount_value, discount_amount, total,
       user_id, user_name, created_at, payment_method::text as payment_method,
       payment_status::text as payment_status, amount_received, "change"
    from public.sales order by created_at desc, id`);
const itemsRaw = await q(`select id, sale_id, product_id, name_ar, name_en, sku, barcode,
       unit_price, quantity, line_total from public.sale_items`);
const paysRaw = await q(`select id, sale_id, method::text as method, amount, status::text as status,
       paid_at from public.sale_payments`);
const productsRaw = await q(`select id, sku, barcode, name_ar, name_en, category_id,
       product_type::text as product_type, selling_price, cost_price, tax_rate,
       stock_tracking_enabled, stock_quantity, low_stock_level, show_on_website, is_featured, active
    from public.products order by name_en`);
const variantsRaw = await q(`select id, product_id, sku, active, stock_quantity, low_stock_level
    from public.product_variants`);
const expensesRaw = await q(`select id, expense_number, name, category, amount,
       payment_method::text as payment_method, spent_at, notes, attachment_url, attachment_name,
       branch, shift_id, user_id, user_name from public.expenses order by spent_at desc, id`);
const returnsRaw = await q(`select id, return_number, sale_id, refund_amount, refund_status::text as refund_status,
       created_at from public.sales_returns order by created_at, id`);
const refundsRaw = await q(`select id, refund_number, sale_id, return_id, amount, status::text as status,
       created_at from public.refund_records order by created_at, id`);

const itemsBySale = new Map();
for (const it of itemsRaw) {
  if (!itemsBySale.has(it.sale_id)) itemsBySale.set(it.sale_id, []);
  itemsBySale.get(it.sale_id).push({
    id: it.id,
    sale_id: it.sale_id,
    product_id: it.product_id,
    name_ar: it.name_ar,
    name_en: it.name_en,
    sku: it.sku,
    barcode: it.barcode ?? null,
    unit_price: num(it.unit_price),
    quantity: num(it.quantity),
    line_total: num(it.line_total),
  });
}
const paysBySale = new Map();
for (const p of paysRaw) {
  if (!paysBySale.has(p.sale_id)) paysBySale.set(p.sale_id, []);
  paysBySale.get(p.sale_id).push({
    id: p.id,
    sale_id: p.sale_id,
    method: p.method,
    amount: num(p.amount),
    status: p.status,
    paid_at: isoOf(p.paid_at),
    paid_by: null,
    paid_by_name: null,
  });
}

const SALES = salesRaw.map((s) => ({
  id: s.id,
  sale_number: s.sale_number,
  client_ref: s.client_ref,
  status: s.status,
  subtotal: num(s.subtotal),
  discount_type: s.discount_type,
  discount_value: num(s.discount_value),
  discount_amount: num(s.discount_amount),
  total: num(s.total),
  user_id: s.user_id,
  user_name: s.user_name,
  items: itemsBySale.get(s.id) ?? [],
  payments: paysBySale.get(s.id) ?? [],
  customer_id: null,
  customer_name: null,
  customer_phone: null,
  created_at: isoOf(s.created_at),
  voided_at: null,
  void_reason: null,
  payment_method: s.payment_method,
  payment_status: s.payment_status,
  amount_received: s.amount_received === null ? null : num(s.amount_received),
  change: s.change === null ? null : num(s.change),
  paid_at: null,
  paid_by: null,
  paid_by_name: null,
}));

const PRODUCTS = productsRaw.map((p) => ({
  id: p.id,
  sku: p.sku,
  barcode: p.barcode ?? null,
  name_ar: p.name_ar,
  name_en: p.name_en,
  description_ar: null,
  description_en: null,
  category_id: p.category_id,
  product_type: p.product_type,
  selling_price: num(p.selling_price),
  cost_price: num(p.cost_price),
  tax_rate: num(p.tax_rate),
  stock_tracking_enabled: Boolean(p.stock_tracking_enabled),
  stock_quantity: num(p.stock_quantity),
  low_stock_level: num(p.low_stock_level),
  show_on_website: Boolean(p.show_on_website),
  is_featured: Boolean(p.is_featured),
  active: Boolean(p.active),
  image_url: null,
  images: [],
  created_at: "",
  updated_at: "",
}));

const VARIANTS = variantsRaw.map((v) => ({
  id: v.id,
  product_id: v.product_id,
  sku: v.sku,
  active: Boolean(v.active),
  stock_quantity: num(v.stock_quantity),
  low_stock_level: num(v.low_stock_level),
}));

const EXPENSES = expensesRaw.map((e) => ({
  id: e.id,
  expense_number: e.expense_number,
  name: e.name,
  category: e.category,
  amount: num(e.amount),
  payment_method: e.payment_method,
  spent_at: isoOf(e.spent_at),
  notes: e.notes ?? null,
  attachment_url: e.attachment_url ?? null,
  attachment_name: e.attachment_name ?? null,
  branch: e.branch ?? null,
  shift_id: e.shift_id ?? null,
  user_id: e.user_id,
  user_name: e.user_name,
}));

const RETURNS = returnsRaw.map((r) => ({
  id: r.id,
  return_number: r.return_number,
  sale_id: r.sale_id,
  refund_amount: num(r.refund_amount),
  status: r.refund_status,
  created_at: isoOf(r.created_at),
}));
const REFUNDS = refundsRaw.map((r) => ({
  id: r.id,
  refund_number: r.refund_number,
  sale_id: r.sale_id,
  return_id: r.return_id,
  amount: num(r.amount),
  status: r.status,
  created_at: isoOf(r.created_at),
}));

// The screen's own window filter, so "in range" is the app's definition.
const inWindow = (iso, range) => TS.withinDateRange(iso, range.from, range.to);

/** Call the five RPCs as a given identity, inside one transaction. */
async function rpc(userId, role, calls) {
  return tx(async () => {
    await become(userId, role);
    const out = {};
    for (const [name, sql, params] of calls) out[name] = (await q(sql, params))[0]?.reports ?? null;
    return out;
  });
}

// What the browser can actually tell the database about itself. Not an offset:
// Intl hands over the zone NAME, which is the only thing that stays true across
// a daylight-saving boundary inside one report window.
const ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;
console.log(c.dim(`  day bucketing timezone: ${ZONE} (offset now ${-new Date(END).getTimezoneOffset()} min)`));

// ── the windows ─────────────────────────────────────────────────────────────
const RANGES = [
  { label: "all time (unbounded)", range: { from: null, to: null } },
  { label: "a whole year+ span", range: { from: "2025-08-18", to: "2026-09-13" } },
  { label: "one calendar month", range: { from: "2026-03-01", to: "2026-03-31" } },
  { label: "the last 30 days", range: { from: "2026-08-15", to: "2026-09-13" } },
  { label: "a single day", range: { from: "2026-06-16", to: "2026-06-16" } },
  { label: "an empty window (2019)", range: { from: "2019-01-01", to: "2019-01-31" } },
];

head("1 · Financial totals — computeFinancialTotals() vs reports_financial_summary()");
head("2 · Sales report — payment mix, per employee, per day");
console.log(c.dim("  (both sections run over every window below)"));

for (const { label, range } of RANGES) {
  const bounds = TS.toTimestampBounds(range);
  const salesW = SALES.filter((s) => inWindow(s.created_at, range));
  const live = TS.revenueSales(salesW);
  const expensesW = TS.expensesInRange(EXPENSES, range);
  const returnsW = RETURNS.filter((r) => inWindow(r.created_at, range));
  const refundsW = REFUNDS.filter((r) => inWindow(r.created_at, range));

  const sql = await rpc(ADMIN.id, "authenticated", [
    [
      "financial",
      `select public.reports_financial_summary($1::timestamptz, $2::timestamptz) as reports`,
      [bounds.from ?? null, bounds.to ?? null],
    ],
    [
      "sales",
      `select public.reports_sales_summary($1::timestamptz, $2::timestamptz, $3) as reports`,
      // UTC, like the TypeScript builders: the differential compares two
      // bucketings of the same days, so both sides must bucket the same day.
      [bounds.from ?? null, bounds.to ?? null, "UTC"],
    ],
    [
      "product",
      `select public.reports_product_performance($1::timestamptz, $2::timestamptz) as reports`,
      [bounds.from ?? null, bounds.to ?? null],
    ],
    [
      "expense",
      `select public.reports_expense_summary($1::timestamptz, $2::timestamptz, $3) as reports`,
      // UTC, like the TypeScript builders (see the sales call above).
      [bounds.from ?? null, bounds.to ?? null, "UTC"],
    ],
  ]);

  console.log(
    `\n${c.bold(`  ▸ ${label}`)} ${c.dim(
      `(${live.length} revenue invoices of ${salesW.length}, ${expensesW.length} expenses)`,
    )}`,
  );

  // 1 — financial totals. The screen passes every invoice in the window,
  //     voided ones included: computeFinancialTotals splits them itself.
  agree(
    "financial totals",
    TS.computeFinancialTotals({
      sales: salesW,
      products: PRODUCTS,
      expenses: expensesW,
      returnsList: returnsW,
      refundsList: refundsW,
    }),
    sql.financial,
  );

  // 2 — the sales report's four parts.
  agree(
    "sales: totals (invoices, revenue, discounts, units)",
    {
      invoices: live.length,
      revenue: TS.roundMoney(live.reduce((a, s) => a + s.total, 0)),
      discounts: TS.roundMoney(live.reduce((a, s) => a + s.discount_amount, 0)),
      units: live.reduce((a, s) => a + s.items.reduce((x, i) => x + i.quantity, 0), 0),
      voidedCount: salesW.filter((s) => s.status === "voided").length,
    },
    {
      invoices: sql.sales?.invoices,
      revenue: sql.sales?.revenue,
      discounts: sql.sales?.discounts,
      units: sql.sales?.units,
      voidedCount: sql.sales?.voidedCount,
    },
  );
  agree(
    "sales: by payment method (PAYMENT_METHODS order)",
    TS.salesByPaymentMethod(salesW),
    sql.sales?.byMethod,
    { ignore: ["share"] },
  );
  agree("sales: by employee (revenue desc)", TS.salesByEmployee(salesW), sql.sales?.byEmployee, {
    ignore: ["share", "avgInvoice"],
    key: "userId",
  });
  agree("sales: by day (trend, zero-filled)", TS.salesTrend(salesW, range), sql.sales?.byDay);

  // 3 — product performance and the shelf valuation.
  const perf = TS.productPerformance(salesW, PRODUCTS);
  agree("product performance (every catalogue product)", perf, sql.product, {
    ignore: ["profit", "margin", "share"],
    key: "productId",
  });

  // 4 — expenses.
  const report = TS.buildExpenseReport(EXPENSES, range);
  agree(
    "expenses: tiles (count, total, per method, active days)",
    { ...report.totals, activeDays: report.activeDays },
    pickExpenseTiles(sql.expense),
    { ignore: ["byCategory"] },
  );
  agree("expenses: by category (zero-filled, app order)", report.byCategory, sql.expense?.byCategory, {
    ignore: ["share", "avg"],
  });
  agree("expenses: by method (app order)", report.byMethod, sql.expense?.byMethod, {
    ignore: ["share", "avg", "cash", "instapay", "visa"],
  });
  agree("expenses: by employee (biggest first)", report.byEmployee, sql.expense?.byEmployee, {
    ignore: ["share", "avg"],
    key: "key",
  });
  agree("expenses: by branch (biggest first)", report.byBranch, sql.expense?.byBranch, {
    ignore: ["share", "avg"],
    key: "key",
  });
  agree("expenses: by day (largest of the day)", report.byDay, sql.expense?.byDay);
  agree("expenses: the single largest", largestOf(report.largest), sql.expense?.largest);

  // 5 — inventory has no window: it is a snapshot of now, so it is compared once.
  if (label === RANGES[0].label) {
    const inv = (
      await rpc(ADMIN.id, "authenticated", [
        ["inventory", `select public.reports_inventory_summary() as reports`, []],
      ])
    ).inventory;
    agree("inventory: the whole shelf, valued", TS.stockValueTotals(PRODUCTS, VARIANTS), inv);
  }
}

/** The five tile numbers plus activeDays — the part of ExpenseSummary the RPC returns. */
function pickExpenseTiles(sql) {
  if (!sql) return {};
  return {
    count: sql.count,
    total: sql.total,
    cash: sql.cash,
    instapay: sql.instapay,
    visa: sql.visa,
    activeDays: sql.activeDays,
  };
}

/** buildExpenseReport's `largest` is a whole Expense; the RPC returns its identity. */
function largestOf(expense) {
  if (!expense) return null;
  return {
    id: expense.id,
    expenseNumber: expense.expense_number,
    name: expense.name,
    amount: expense.amount,
    category: expense.category,
    method: expense.payment_method,
    spentAt: expense.spent_at,
  };
}

// ── 5 · the cap: the reason this phase exists ───────────────────────────────
head("5 · The 1,000-row cap — what the browser sees today vs what the database returns");
{
  const bounds = TS.toTimestampBounds({ from: null, to: null });
  const capped = SALES.slice(0, TS.SALES_ROW_CAP); // the browser's window, newest first
  const tsFull = TS.computeFinancialTotals({
    sales: SALES,
    products: PRODUCTS,
    expenses: EXPENSES,
    returnsList: RETURNS,
    refundsList: REFUNDS,
  });
  const tsCapped = TS.computeFinancialTotals({
    sales: capped,
    products: PRODUCTS,
    expenses: EXPENSES,
    returnsList: RETURNS,
    refundsList: REFUNDS,
  });
  const sqlFull = (
    await rpc(ADMIN.id, "authenticated", [
      [
        "financial",
        `select public.reports_financial_summary($1::timestamptz, $2::timestamptz) as reports`,
        [bounds.from ?? null, bounds.to ?? null],
      ],
    ])
  ).financial;

  console.log(
    c.dim(
      `  invoices: capped=${tsCapped.invoiceCount} full=${tsFull.invoiceCount} sql=${sqlFull.invoiceCount}\n` +
        `  revenue:  capped=${tsCapped.revenue.toFixed(2)} full=${tsFull.revenue.toFixed(2)} sql=${Number(sqlFull.revenue).toFixed(2)}`,
    ),
  );
  if (tsCapped.invoiceCount === tsFull.invoiceCount) {
    no("the capped path must differ from the full path", "the dataset is too small to prove truncation");
  } else {
    ok(
      `the browser-side path is provably short: ${tsFull.invoiceCount - tsCapped.invoiceCount} invoices ` +
        `and ${(tsFull.revenue - tsCapped.revenue).toFixed(2)} EGP never reached the totals`,
    );
  }
  agree("the database returns the FULL figures, not the truncated ones", tsFull, sqlFull);
}

// ── 6 · day bucketing is the UTC day, and the zone parameter proves it ──────
head("6 · Day bucketing — the UTC day on both sides, the zone parameter load-bearing");
{
  const range = { from: "2026-06-01", to: "2026-06-30" };
  const bounds = TS.toTimestampBounds(range);
  const salesW = SALES.filter((s) => inWindow(s.created_at, range));
  const tsTrend = TS.salesTrend(salesW, range);

  const atUtc = (
    await rpc(ADMIN.id, "authenticated", [
      ["trend", `select public.reports_sales_summary($1::timestamptz,$2::timestamptz,$3) as reports`,
        [bounds.from, bounds.to, "UTC"]],
    ])
  ).trend?.byDay;
  agree(`byDay in UTC — the contract both sides share`, tsTrend, atUtc);

  // And the parameter must actually matter: asking in the shop's own zone has
  // to move small-hours invoices between days, or the zone name is decoration.
  if (ZONE !== "UTC") {
    const atZone = (
      await rpc(ADMIN.id, "authenticated", [
        ["trend", `select public.reports_sales_summary($1::timestamptz,$2::timestamptz,$3) as reports`,
          [bounds.from, bounds.to, ZONE]],
      ])
    ).trend?.byDay;
    const differs = JSON.stringify(atZone) !== JSON.stringify(atUtc);
    if (differs) ok(`p_timezone is load-bearing: bucketing the same window in ${ZONE} moves invoices between days`);
    else
      no(
        "p_timezone changed nothing",
        "either the window holds no small-hours invoice or the zone name is ignored",
      );
  } else {
    console.log(c.dim("  (host timezone is UTC — the cross-zone comparison is skipped)"));
  }
}

// ── 7 · who may ask ─────────────────────────────────────────────────────────
head("7 · Permission — every RPC is gated by public.can('view_reports')");
{
  const probe = `select public.reports_financial_summary(null, null) as reports`;
  const viewer = staffRows.find((s) => s.role === "viewer");
  const stranger = "99999999-9999-4999-8999-999999999999"; // a valid uuid with no profile

  const allowed = async (userId, role) => {
    try {
      await rpc(userId, role, [["f", probe, []]]);
      return { refused: false };
    } catch (error) {
      return { refused: true, code: error.code ?? "", message: String(error.message).split("\n")[0] };
    }
  };

  const asAdmin = await allowed(ADMIN.id, "authenticated");
  if (!asAdmin.refused) ok(`${ADMIN.role} (${ADMIN.name}) may read the aggregates`);
  else no("an admin was refused", asAdmin.message);

  // Every built-in role holds view_reports — viewer included, because "may see
  // the numbers" is exactly what that role is for. So the gate is not about
  // system roles; it is about having no identity, losing it, or narrowing it.
  if (viewer) {
    const asViewer = await allowed(viewer.id, "authenticated");
    if (!asViewer.refused)
      ok(`viewer (${viewer.name}) may read them too — view_reports is granted to all five system roles`);
    else no("a viewer was refused, but every system role holds view_reports", asViewer.message);
  }

  const asStranger = await allowed(stranger, "authenticated");
  if (asStranger.refused) ok("an authenticated user with no profile is refused (can() fails closed)");
  else no("a profile-less user was served report data", "public.can() did not fail closed");

  const asAnon = await allowed(null, "anon");
  if (asAnon.refused) ok("anon is refused");
  else no("anon was served report data", "the RPCs are reachable without signing in");

  // The strongest case: an admin NARROWED by a custom role. can() lets an active
  // custom role decide absolutely, so a role without view_reports must refuse
  // even though the underlying system role is admin. Rolled back afterwards.
  try {
    const refused = await tx(async () => {
      const role = await one(
        `insert into public.custom_roles (key, name_en, name_ar, base_role, capabilities, active)
         values ('diff_no_reports','No Reports','بدون تقارير','admin',
                 (select array_agg(capability) from public.role_capabilities
                   where role = 'admin' and capability <> 'view_reports'), true)
         returning id`,
      );
      await db.query("update public.profiles set custom_role_id = $1 where id = $2", [role.id, ADMIN.id]);
      // Become that admin *after* the write, so the refusal can only come from
      // the narrowed capability list and not from having no identity at all.
      await become(ADMIN.id, "authenticated");
      try {
        await db.query(probe);
        return false;
      } catch {
        return true;
      }
    });
    // The transaction committed the role assignment; undo it explicitly.
    await db.query("update public.profiles set custom_role_id = null where id = $1", [ADMIN.id]);
    await db.query("delete from public.custom_roles where key = 'diff_no_reports'");
    if (refused)
      ok("an admin narrowed by a custom role without view_reports is refused — the gate reads can(), not the system role");
    else no("a custom role without view_reports was still served", "the RPC bypasses the overlay");
  } catch (error) {
    no("the custom-role negative case could not be set up", error.message);
  }

  // Every RPC, not just the financial one.
  const all = [
    ["reports_financial_summary(null,null)", "financial"],
    ["reports_sales_summary(null,null,0)", "sales"],
    ["reports_product_performance(null,null)", "product"],
    ["reports_inventory_summary()", "inventory"],
    ["reports_expense_summary(null,null,0)", "expense"],
  ];
  const gated = [];
  for (const [call, name] of all) {
    try {
      await rpc(stranger, "authenticated", [[name, `select public.${call} as reports`, []]]);
      gated.push(`${name} SERVED`);
    } catch {
      /* refused, as it must be */
    }
  }
  if (gated.length === 0) ok("all five RPCs refuse a caller without view_reports");
  else no("an RPC answered a caller it should have refused", gated.join(", "));
}

// ── 8 · what the move actually costs ────────────────────────────────────────
head("8 · Cost — pulling every invoice and adding it up, against one RPC call");
{
  // PGlite is in-process, so this measures WORK and PAYLOAD, not network
  // latency. Over a real connection the row path additionally pays to serialise
  // and transfer every invoice it pulls, which only widens the gap measured
  // here — it never narrows it.
  const ms = (from) => Number(process.hrtime.bigint() - from) / 1e6;
  const range = { from: null, to: null };
  const bounds = TS.toTimestampBounds(range);

  const t0 = process.hrtime.bigint();
  const [sRows, iRows, pRows] = await Promise.all([
    q(`select id, status::text, total, discount_amount, payment_method::text,
              payment_status::text, created_at, user_id, user_name
         from public.sales`),
    q(`select sale_id, product_id, quantity, line_total from public.sale_items`),
    q(`select sale_id, method::text, amount, status::text from public.sale_payments`),
  ]);
  const pullMs = ms(t0);
  const bytesRows =
    JSON.stringify(sRows).length + JSON.stringify(iRows).length + JSON.stringify(pRows).length;

  const t1 = process.hrtime.bigint();
  TS.computeFinancialTotals({
    sales: SALES, products: PRODUCTS, expenses: EXPENSES,
    returnsList: RETURNS, refundsList: REFUNDS,
  });
  TS.salesByPaymentMethod(SALES);
  TS.salesByEmployee(SALES);
  TS.salesTrend(SALES, range);
  TS.productPerformance(SALES, PRODUCTS);
  TS.stockValueTotals(PRODUCTS);
  TS.buildExpenseReport(EXPENSES, range);
  const computeMs = ms(t1);

  const t2 = process.hrtime.bigint();
  const dbSide = await rpc(ADMIN.id, "authenticated", [
    ["financial", `select public.reports_financial_summary($1::timestamptz,$2::timestamptz) as reports`,
      [bounds.from ?? null, bounds.to ?? null]],
    ["sales", `select public.reports_sales_summary($1::timestamptz,$2::timestamptz,$3) as reports`,
      [bounds.from ?? null, bounds.to ?? null, ZONE]],
    ["product", `select public.reports_product_performance($1::timestamptz,$2::timestamptz) as reports`,
      [bounds.from ?? null, bounds.to ?? null]],
    ["inventory", `select public.reports_inventory_summary() as reports`, []],
    ["expense", `select public.reports_expense_summary($1::timestamptz,$2::timestamptz,$3) as reports`,
      [bounds.from ?? null, bounds.to ?? null, ZONE]],
  ]);
  const rpcMs = ms(t2);
  const bytesRpc = JSON.stringify(dbSide).length;

  const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
  console.log(
    c.dim(
      `  browser path : ${sRows.length + iRows.length + pRows.length} rows pulled (${kb(bytesRows)})` +
        ` in ${pullMs.toFixed(0)} ms, then ${computeMs.toFixed(0)} ms of arithmetic` +
        ` = ${(pullMs + computeMs).toFixed(0)} ms\n` +
      `  database path: 5 aggregates (${kb(bytesRpc)}) in ${rpcMs.toFixed(0)} ms\n` +
      `  payload      : ${(bytesRows / Math.max(bytesRpc, 1)).toFixed(0)}× less to move,` +
        ` and none of it held in memory afterwards`,
    ),
  );
  if (bytesRpc < bytesRows) ok("the database path moves strictly less data than the browser path");
  else no("the database path did not reduce the payload", `${kb(bytesRpc)} vs ${kb(bytesRows)}`);
  if (bytesRpc < 64 * 1024) ok(`the whole report answer is ${kb(bytesRpc)} — no invoice list in it`);
  else no("the aggregate payload is unexpectedly large", kb(bytesRpc));
}

// ── summary ─────────────────────────────────────────────────────────────────
await db.close();
console.log(
  fail === 0
    ? `\n${c.bold(c.green(`✓ ${pass} comparisons agree — the database and the shipped builders return the same numbers`))}\n`
    : `\n${c.bold(c.red(`✗ ${fail} of ${pass + fail} comparisons disagree`))}\n`,
);
process.exit(fail === 0 ? 0 : 1);
