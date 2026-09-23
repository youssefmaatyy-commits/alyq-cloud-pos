// @ts-check
/**
 * ESLint — the static gate that was missing.
 *
 * Scope decision, stated because it is a real one: this lints the application
 * (`src`) and the build/test tooling (`scripts`, config files). It does not lint
 * `supabase/functions`, which is Deno code with Deno globals and a Deno module
 * graph — linting it here would need a second toolchain and would produce noise
 * about `Deno` being undefined. Migrations are checked by `npm run db:check`,
 * which applies them to a real engine and asserts the result; that is a stronger
 * gate than any linter could give them.
 *
 * Rule levels follow one principle: a rule that can only be violated by a defect
 * is an error, and a rule whose violation is often a deliberate trade-off is a
 * warning. Warnings are visible in CI but do not block, so the gate starts
 * strict on the things that break users and leaves the stylistic argument for
 * later.
 */
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";

export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "coverage/**",
      "supabase/functions/**",
      "scripts/tmp-*",
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  // ── the application ──────────────────────────────────────────────────────
  {
    files: ["src/**/*.{ts,tsx}"],
    languageOptions: {
      globals: { ...globals.browser },
    },
    plugins: { "react-hooks": reactHooks },
    rules: {
      // A hook called conditionally is a bug with no readable symptom: the
      // component works until it does not, and then it corrupts state.
      "react-hooks/rules-of-hooks": "error",
      // A missing dependency is often deliberate (a mount-only effect, a ref
      // read on purpose). Worth seeing, not worth blocking a merge.
      "react-hooks/exhaustive-deps": "warn",

      // `catch {}` with nothing in it is how this codebase swallows an expected
      // refusal — a best-effort audit write, an optional identity row. Anywhere
      // else an empty block is still a smell.
      "no-empty": ["error", { allowEmptyCatch: true }],

      // Deliberate trade-offs, not defects: `any` at a Supabase boundary that
      // returns untyped JSON, an unused parameter kept for a callback signature.
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" },
      ],
    },
  },

  // ── build and test tooling ──────────────────────────────────────────────
  // Node globals for the runner, browser globals alongside them because half of
  // this directory drives the real bundle inside jsdom: `scripts/smoke.dom.mjs`,
  // `scripts/store.flow.mjs` and the flow suites all build a DOM and then walk
  // it, so `document` and `window` are genuinely in scope there.
  {
    files: ["scripts/**/*.mjs", "*.config.{js,ts,mjs}", "eslint.config.js"],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      // The test harnesses print with console by design: it is their output.
      "no-console": "off",

      // A harness keeps things a suite does not use yet: `setFieldIndex` is a
      // helper the next form suite will want, `SESSION_KEY` documents the
      // storage key the app writes, and `let detail = []` is a defensive
      // initialiser in a reporter. Deleting them would make this file shorter
      // and the next suite harder to write, so they are warnings: visible in CI,
      // not a reason to block a merge.
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" },
      ],
      "no-useless-assignment": "warn",
    },
  },

  // ── one rule, demoted on purpose ─────────────────────────────────────────
  // `no-useless-assignment` reports a binding whose initialiser is never read.
  // That is a real defect when the binding is a local (`let w = null` before a
  // try that always assigns — those were fixed), and a false positive when the
  // binding comes out of a hook destructure and is read later inside JSX: the
  // rule's flow analysis stops at the render boundary and calls `date` from
  // `const { t, pick, num, date } = useI18n()` unused while the component
  // renders it in two places. Warnings keep it visible without blocking a merge
  // on something the type-checker has already proved is used.
  {
    files: ["src/**/*.{ts,tsx}"],
    rules: {
      "no-useless-assignment": "warn",
    },
  },
);
