/**
 * Password policy — one rule set for every place a password is chosen.
 *
 * Three callers share it: an admin creating an account, an admin resetting one,
 * and a person changing their own password after following a reset link. Sharing
 * matters because the alternative is three slightly different bars, and the
 * weakest one becomes the real policy.
 *
 * Scope, stated plainly: this is a *usability* gate, not a security control. It
 * runs in the browser, so anyone can skip it. In live mode Supabase Auth enforces
 * its own policy server-side and its verdict arrives as `weak_password`
 * (`SupabaseUserRepository.updatePassword`), which is the answer that counts.
 * What this file guarantees is that the form says "too short" before the network
 * does, in the admin's own language.
 */
import type { PasswordRuleKey, PasswordRuleResult, PasswordVerdict } from "../types";

/** The floor. Supabase's own default is 6; we ask for 8 and say why in the UI. */
export const MIN_PASSWORD_LENGTH = 8;

/**
 * A deliberately tiny denylist. A real one is thousands of entries and belongs
 * server-side (or in the provider's configuration); listing a handful of the
 * passwords that actually turn up on a shop floor catches the common case
 * without pretending to be a breach corpus. `alyq1234` is on it because it is
 * this app's own demo password — the one string guaranteed to be tried first.
 */
const COMMON_PASSWORDS = new Set([
  "password",
  "password1",
  "password123",
  "12345678",
  "123456789",
  "1234567890",
  "qwerty123",
  "alyq1234",
  "admin123",
  "admin1234",
  "welcome1",
  "letmein1",
  "11111111",
  "00000000",
]);

export const PASSWORD_RULES: readonly PasswordRuleKey[] = [
  "length",
  "letter",
  "digit",
  "not_username",
  "not_common",
];

/**
 * Evaluate a candidate password.
 *
 * `username` is optional: when supplied, a password that is the username (or
 * contains it) fails — the single most common weak choice on a multi-account
 * installation (`cashier` / `cashier123`) and the one a length check cannot catch.
 */
export function evaluatePassword(password: string, username?: string): PasswordVerdict {
  const candidate = password ?? "";
  const lowered = candidate.toLowerCase();
  const handle = (username ?? "").trim().toLowerCase();

  const rules: PasswordRuleResult[] = [
    { key: "length", ok: candidate.length >= MIN_PASSWORD_LENGTH },
    // Arabic letters count as letters: an Arabic-only password is not "no letters".
    { key: "letter", ok: /[a-z\u0621-\u064A]/i.test(candidate) },
    { key: "digit", ok: /[0-9]/.test(candidate) },
    {
      key: "not_username",
      // No username supplied → nothing to compare against, so the rule passes
      // rather than failing a form that has not reached that field yet.
      ok: !handle || (lowered !== handle && !lowered.includes(handle)),
    },
    { key: "not_common", ok: !COMMON_PASSWORDS.has(lowered) },
  ];

  return {
    ok: rules.every((rule) => rule.ok),
    score: rules.filter((rule) => rule.ok).length,
    rules,
  };
}

/** The i18n key for one rule, for the checklist under the field. */
export function passwordRuleLabelKey(rule: PasswordRuleKey): string {
  return `settings.password.rule.${rule}`;
}

/**
 * A verdict as a single message key. The first failing rule wins, in the order
 * the checklist displays them, so the message and the highlighted row agree.
 */
export function passwordVerdictKey(verdict: PasswordVerdict): string {
  if (verdict.ok) return "settings.password.ok";
  const failed = PASSWORD_RULES.find((key) => !verdict.rules.some((rule) => rule.key === key && rule.ok));
  return failed ? passwordRuleLabelKey(failed) : "settings.password.rule.length";
}
