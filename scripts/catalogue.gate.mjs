#!/usr/bin/env node
/**
 * Commercial catalogue gate — is this production deployment actually selling?
 *
 *   node scripts/catalogue.gate.mjs                       # env: SUPABASE_PROD_URL / SUPABASE_PROD_ANON_KEY
 *   node scripts/catalogue.gate.mjs --url https://… --anon-key …
 *   ALLOW_EMPTY_STOREFRONT=true node scripts/catalogue.gate.mjs
 *   node scripts/catalogue.gate.mjs --json
 *
 * It asks the two public `security definer` functions the anonymous storefront
 * itself calls — `storefront_catalogue()` and
 * `storefront_branch_product_variants()` — and FAILS when nothing in the answer
 * can be bought. `ALLOW_EMPTY_STOREFRONT` must be exactly `true` for a
 * deliberately empty storefront to pass; every other value fails closed.
 *
 * ## Never writes
 *
 * · the request plan is the closed two-call set from `catalogueGatePlan()`, and
 *   `assertReadOnlyPlan()` re-checks it before anything is sent;
 * · the bodies are `{}` — there are no arguments to write with;
 * · the credential must be the anon key: a `service_role`/`sb_secret_` value is
 *   refused before a request is built;
 * · the shipped migrations are parsed first (`inspectShippedSql`) and the gate
 *   refuses to run unless both functions are still `stable`/`immutable` with no
 *   write keyword in their bodies.
 *
 * That last check is the reason this script reads SQL: "the probe never writes"
 * must not depend on a comment staying true.
 *
 * Exit code 0 when the storefront can sell something (or is declared empty),
 * 1 when the gate fails, 2 when the invocation itself is unusable.
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  CATALOGUE_GATE_FUNCTIONS,
  allowEmptyStorefrontFlag,
  catalogueGatePlan,
  inspectShippedSql,
  runCatalogueGate,
} from "../src/lib/qa/catalogueGate.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
};

function arg(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] && !process.argv[index + 1].startsWith("--")
    ? process.argv[index + 1]
    : fallback;
}
const has = (name) => process.argv.includes(`--${name}`);

const projectUrl = arg("url") ?? process.env.SUPABASE_PROD_URL ?? process.env.VITE_SUPABASE_URL ?? "";
const anonKey = arg("anon-key") ?? process.env.SUPABASE_PROD_ANON_KEY ?? process.env.VITE_SUPABASE_ANON_KEY ?? "";
const allowEmptyStorefront = process.env.ALLOW_EMPTY_STOREFRONT;
const asJson = has("json");
const timeoutMs = Number(arg("timeout", "15000"));

/* ── 0 · the shipped SQL proves the two functions are read-only ──────────── */

const migrationDirectory = path.join(ROOT, "supabase", "migrations");
const migrationSql = fs.readdirSync(migrationDirectory)
  .filter((name) => /^\d{4}_.+\.sql$/.test(name))
  .sort()
  .map((name) => fs.readFileSync(path.join(migrationDirectory, name), "utf8"))
  .join("\n");
const sqlFindings = inspectShippedSql(migrationSql);
const sqlFailures = sqlFindings.filter((finding) => finding.level === "fail");
if (sqlFailures.length > 0) {
  for (const finding of sqlFailures) console.error(c.red(`✗ ${finding.code} — ${finding.message}`));
  console.error(c.red("\n✗ refusing to call a function that is not proven read-only in the shipped migrations.\n"));
  process.exit(1);
}

/* ── 1 · announce exactly what will be sent ──────────────────────────────── */

const plan = catalogueGatePlan(projectUrl, anonKey);
if (!asJson) {
  console.log(c.bold("\nCommercial catalogue gate — read-only, two public RPCs\n"));
  if (allowEmptyStorefrontFlag(allowEmptyStorefront)) {
    console.log(c.yellow("! ALLOW_EMPTY_STOREFRONT=true — an empty storefront will be permitted\n"));
  } else if (allowEmptyStorefront !== undefined && allowEmptyStorefront !== "") {
    console.log(c.yellow(`! ALLOW_EMPTY_STOREFRONT="${allowEmptyStorefront}" is not exactly "true"; an empty storefront will FAIL\n`));
  }
  for (const request of plan) {
    console.log(c.dim(`  ${request.method} ${request.url} · body ${request.body}`));
  }
  for (const finding of sqlFindings) console.log(c.dim(`  · ${finding.message}`));
  console.log();
}

/* ── 2 · the transport: one fetch per planned request, nothing else ──────── */

async function transport(request) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      signal: controller.signal,
      redirect: "follow",
    });
    const text = await response.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = text.slice(0, 400);
    }
    return { status: response.status, json };
  } catch (error) {
    return { status: 0, networkError: error?.name === "AbortError" ? `timed out after ${timeoutMs} ms` : String(error?.message ?? error) };
  } finally {
    clearTimeout(timer);
  }
}

/* ── 3 · decide ──────────────────────────────────────────────────────────── */

if (!projectUrl.trim() || !anonKey.trim()) {
  console.error(c.red(
    "\n✗ missing configuration: pass --url/--anon-key, or set SUPABASE_PROD_URL and SUPABASE_PROD_ANON_KEY.\n" +
    "  The gate reads the public API as an anonymous visitor — never the service_role key.\n",
  ));
  process.exit(2);
}

const verdict = await runCatalogueGate({ projectUrl, anonKey, allowEmptyStorefront, transport });

if (asJson) {
  console.log(JSON.stringify({
    gate: "catalogue",
    functions: CATALOGUE_GATE_FUNCTIONS,
    sql: sqlFindings.map((finding) => ({ level: finding.level, code: finding.code, message: finding.message })),
    ...verdict,
  }, null, 2));
} else {
  for (const finding of verdict.findings) {
    const mark = finding.level === "pass" ? c.green("✓") : finding.level === "warn" ? c.yellow("!") : c.red("✗");
    console.log(`${mark} ${finding.code} — ${finding.message}`);
  }
  console.log(
    `\n${verdict.ok ? c.green("catalogue gate passed") : c.red("catalogue gate failed")} · ` +
      `${verdict.passed} passed, ${verdict.warned} warned, ${verdict.failed} failed\n`,
  );
}

process.exit(verdict.ok ? 0 : 1);
