/**
 * System QA invariants (Phase 19).
 *
 * Run with:
 *   npx esbuild src/lib/qa/__tests__/systemQa.selftest.ts \
 *     --bundle --format=esm --platform=node --outfile=/tmp/alyq-qa.mjs && node /tmp/alyq-qa.mjs
 *
 * The other suites test what a module *does*. This one tests the properties that
 * hold across all of them — the ones that are easy to break by accident in a
 * single commit and impossible to notice in a single screen:
 *
 *   · **both languages are the same language.** Every key exists in English and
 *     Arabic, and every key the screens ask for exists at all. A missing key does
 *     not crash anything; it prints `backup.tile.health` to a customer.
 *   · **Arabic is right-to-left all the way down.** A physical utility
 *     (`text-right`, `mr-2`) is correct in English and wrong in Arabic, and it
 *     looks fine to whoever wrote it — which is exactly why it is pinned here
 *     rather than left to review.
 *   · **a busy control always comes back.** Any handler that disables a button
 *     while it awaits must clear the flag in a `finally`. Cleared only on the
 *     success path, one rejection wedges the control forever; on the login
 *     screen that is a lockout nobody can explain.
 *   · **every door in the sidebar opens.** A nav link to a route App.tsx does not
 *     declare renders the catch-all, and a gated path that is not declared serves
 *     nothing. Neither is visible in the screen that has the bug.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { ar, en } from "@/lib/i18n/dictionary";

type TestCase = { name: string; fn: () => void };
const tests: TestCase[] = [];
const test = (name: string, fn: () => void) => tests.push({ name, fn });

/** Repo root, found by walking up from cwd so the runner's location is irrelevant. */
function repoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 6; i += 1) {
    if (fs.existsSync(path.join(dir, "src/lib/i18n/dictionary.ts"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("could not locate the repository root from " + process.cwd());
}

const ROOT = repoRoot();
const read = (relative: string): string => fs.readFileSync(path.join(ROOT, relative), "utf8");

/** Every source file, minus the suites themselves. */
function sourceFiles(extension: RegExp, includeTests = false): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules") continue;
        if (!includeTests && entry.name === "__tests__") continue;
        walk(full);
      } else if (extension.test(entry.name)) {
        out.push(path.relative(ROOT, full));
      }
    }
  };
  walk(path.join(ROOT, "src"));
  return out.sort();
}

const TSX = sourceFiles(/\.tsx$/);
const TS = sourceFiles(/\.tsx?$/);

console.log("\nPhase 19 · system QA invariants");

// ── 1. both languages ───────────────────────────────────────────────────────
test("the English and Arabic dictionaries hold exactly the same keys", () => {
  const enKeys = Object.keys(en);
  const arKeys = Object.keys(ar);
  const missingInAr = enKeys.filter((key) => !(key in ar));
  const missingInEn = arKeys.filter((key) => !(key in en));

  assert.deepEqual(missingInAr, [], `keys with no Arabic: ${missingInAr.slice(0, 10).join(", ")}`);
  assert.deepEqual(missingInEn, [], `keys with no English: ${missingInEn.slice(0, 10).join(", ")}`);
  assert.ok(enKeys.length > 2000, `the dictionary is the size this app has (${enKeys.length} keys)`);

  // An empty translation is a missing one that passes a `key in dict` check.
  const blank = enKeys.filter((key) => {
    const english = String(en[key as keyof typeof en] ?? "").trim();
    const arabic = String(ar[key as keyof typeof ar] ?? "").trim();
    return english.length === 0 || arabic.length === 0;
  });
  assert.deepEqual(blank, [], `keys that translate to nothing: ${blank.slice(0, 10).join(", ")}`);
});

test("every key a screen asks for exists, in both languages", () => {
  const used = new Map<string, string[]>();
  const dynamic = new Map<string, string[]>();

  for (const file of TS) {
    if (file.endsWith("lib/i18n/dictionary.ts")) continue;
    const body = read(file);
    for (const match of body.matchAll(/\bt(?:Plural)?\(\s*"([^"]+)"/g)) {
      const list = used.get(match[1]) ?? [];
      list.push(file);
      used.set(match[1], list);
    }
    // `t(\`backup.health.${code}.message\` as never)` — the prefix must exist.
    for (const match of body.matchAll(/\bt(?:Plural)?\(\s*`([a-z0-9_.]+)\.\$\{/g)) {
      const list = dynamic.get(match[1]) ?? [];
      list.push(file);
      dynamic.set(match[1], list);
    }
  }

  assert.ok(used.size > 1500, `the screens ask for this many keys (${used.size})`);

  const absent: string[] = [];
  for (const [key, files] of used) {
    if (!(key in en) || !(key in ar)) absent.push(`${key} (${files[0]})`);
  }
  assert.deepEqual(absent, [], `asked for but not translated: ${absent.slice(0, 12).join(", ")}`);

  const deadPrefix = [...dynamic.keys()].filter(
    (prefix) => !Object.keys(en).some((key) => key.startsWith(`${prefix}.`)),
  );
  assert.deepEqual(deadPrefix, [], `dynamic key prefixes with nothing behind them: ${deadPrefix.join(", ")}`);
});

// ── 2. right-to-left ────────────────────────────────────────────────────────
test("no screen aligns or spaces with a physical edge", () => {
  // `text-left`/`text-right` and `ml-`/`mr-`/`pl-`/`pr-` are correct in English
  // and mirrored-wrong in Arabic. The logical utilities (`text-start`, `text-end`,
  // `ms-`, `me-`, `ps-`, `pe-`) are what the rest of the app uses.
  // Only the physical utilities themselves — never the whole class list, or every
  // element in the app becomes an offender.
  const physical = new RegExp(
    [
      "\\btext-(?:left|right)\\b",
      "\\b(?:ml|mr|pl|pr|scroll-mr|scroll-ml)-(?:\\d+(?:\\.\\d+)?|px|auto)\\b",
      "\\bborder-(?:l|r)(?:-\\d+(?:\\.\\d+)?)?(?:\\s|\"|`)",
      "\\brounded-(?:l|r)(?:-[a-z]+)?(?:\\s|\"|`)",
      "\\b(?:left|right)-(?:0|px|\\d+(?:\\.\\d+)?|full)(?:\\s|\"|`)",
    ].join("|"),
  );
  const offenders: string[] = [];

  for (const file of TSX) {
    const lines = read(file).split("\n");
    lines.forEach((line, index) => {
      if (!/className=|class:/.test(line)) return;
      const match = physical.exec(line);
      if (!match) return;
      offenders.push(`${file}:${index + 1} ${match[0].trim()}`);
    });
  }

  assert.deepEqual(
    offenders,
    [],
    `${offenders.length} physical alignment(s) that will not flip in Arabic:\n      ${offenders.slice(0, 10).join("\n      ")}`,
  );

  // And the convention is real, not a rule nobody follows.
  const logical = TSX.reduce(
    (total, file) => total + (read(file).match(/\btext-(?:start|end)\b|\b(?:ms|me|ps|pe)-\d/g) ?? []).length,
    0,
  );
  assert.ok(logical > 200, `the app aligns logically everywhere else (${logical} uses)`);
});

// ── 3. a busy control always comes back ─────────────────────────────────────
test("every handler that awaits with a busy flag clears it in a finally", () => {
  const FLAGS = /set(Submitting|Busy|Saving|Loading|Working|Pending|Creating|Restoring|Exporting|Downloading|Sending|Printing)\((true|false)\)/g;
  const offenders: string[] = [];

  for (const file of TSX) {
    const body = read(file);
    if (!FLAGS.test(body)) continue;
    FLAGS.lastIndex = 0;

    // Where the `finally` blocks are: a flag cleared inside one comes back on
    // every path, which is the whole point.
    const finallyRanges: [number, number][] = [];
    for (const match of body.matchAll(/finally\s*\{/g)) {
      let depth = 0;
      for (let k = match.index + match[0].length - 1; k < body.length; k += 1) {
        if (body[k] === "{") depth += 1;
        else if (body[k] === "}") {
          depth -= 1;
          if (depth === 0) {
            finallyRanges.push([match.index, k]);
            break;
          }
        }
      }
    }
    const inFinally = (at: number): boolean =>
      finallyRanges.some(([from, to]) => at >= from && at <= to);

    const marks = [...body.matchAll(FLAGS)];
    for (const on of marks.filter((m) => m[2] === "true")) {
      const off = marks.find(
        (m) => (m.index ?? 0) > (on.index ?? 0) && m[1] === on[1] && m[2] === "false",
      );
      if (!off) continue; // never cleared: a different bug, and a visible one
      const between = body.slice(on.index, off.index);
      if (!/await\s/.test(between)) continue; // nothing can reject in between
      if (inFinally(off.index)) continue;
      const line = body.slice(0, on.index).split("\n").length;
      offenders.push(`${file}:${line} set${on[1]}(true) … await … set${on[1]}(false) outside a finally`);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `${offenders.length} handler(s) wedge their control if the await rejects:\n      ${offenders.slice(0, 8).join("\n      ")}`,
  );
});

// ── 4. every door opens ─────────────────────────────────────────────────────
test("every sidebar link resolves to a route App.tsx declares", () => {
  const app = read("src/App.tsx");
  const declared = new Set<string>();
  for (const match of app.matchAll(/<Route\s+[^>]*path="([^"]+)"/g)) {
    declared.add(match[1]);
    // A parent hosting its own descendant <Routes> declares a splat; the screens
    // under it are still reached through the parent.
    if (match[1].endsWith("/*")) declared.add(match[1].slice(0, -2));
  }

  const matches = (target: string): boolean =>
    [...declared].some((route) => {
      if (route === "*" || route === "/*") return false;
      if (route === target) return true;
      if (target.startsWith(`${route}/`)) return true;
      // `/products/:id` answers `/products/abc-123`.
      const parts = route.split("/");
      const actual = target.split("/");
      return parts.length === actual.length && parts.every((part, i) => part.startsWith(":") || part === actual[i]);
    });

  const shell = read("src/components/layout/AppShell.tsx");
  const links = [...new Set([...shell.matchAll(/to="(\/[^"]+)"/g)].map((m) => m[1]))];
  assert.ok(links.length > 15, `the sidebar has this many destinations (${links.length})`);

  const orphan = links.filter((link) => !matches(link));
  assert.deepEqual(orphan, [], `sidebar links that render the catch-all: ${orphan.join(", ")}`);
});

test("every gated path is declared, and names a capability that exists", () => {
  const app = read("src/App.tsx");
  const declared = new Set<string>();
  for (const match of app.matchAll(/<Route\s+[^>]*path="([^"]+)"/g)) {
    declared.add(match[1]);
    if (match[1].endsWith("/*")) declared.add(match[1].slice(0, -2));
  }
  const routes = read("src/lib/permissions/routes.ts");
  const gated = [...routes.matchAll(/\["(\/[^"]+)",\s*"([a-z_]+)"\]/g)].map((m) => ({
    path: m[1],
    capability: m[2],
  }));
  assert.ok(gated.length > 15, `this many paths carry a capability (${gated.length})`);

  const undeclared = gated.filter(
    (entry) =>
      !declared.has(entry.path) &&
      ![...declared].some((route) => route.endsWith("/*") && entry.path.startsWith(route.slice(0, -1))),
  );
  assert.deepEqual(
    undeclared.map((entry) => entry.path),
    [],
    "ROUTE_CAPABILITIES gates paths App.tsx does not declare",
  );

  const roles = read("src/lib/permissions/roles.ts");
  const capabilities = new Set(
    [...roles.slice(roles.indexOf("export const CAPABILITIES")).matchAll(/^\s{2}"([a-z_]+)",$/gm)].map((m) => m[1]),
  );
  const unknown = gated.filter((entry) => !capabilities.has(entry.capability));
  assert.deepEqual(
    unknown.map((entry) => `${entry.path}->${entry.capability}`),
    [],
    "a route is gated by a capability nobody has — that screen is unreachable for everyone",
  );
});

// ── runner ───────────────────────────────────────────────────────────────────
let failed = 0;
for (const { name, fn } of tests) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`  ✗ ${name}`);
    console.error(`    ${(error as Error).message}`);
  }
}
console.log("");
if (failed > 0) {
  console.error(`${failed}/${tests.length} Phase 19 QA invariant tests FAILED.`);
  process.exit(1);
}
console.log(`${tests.length}/${tests.length} Phase 19 system-QA invariants hold.`);
