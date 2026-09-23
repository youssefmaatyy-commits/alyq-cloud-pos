/**
 * A password input with the policy rendered beside it.
 *
 * It lives in `lib/auth` rather than in the settings module because three screens
 * need it and only one of them is settings: creating an account, an admin
 * resetting one, and a person following a reset link. One implementation, one
 * rule set, one checklist.
 *
 * The checklist is not decoration. An admin setting somebody else's password has
 * no way to guess why `alyq1234` was refused, and the person receiving it has to
 * be told what to type. Rows turn green as they are satisfied — which is also the
 * honest way to show that this check is a convenience: in live mode Supabase
 * enforces its own policy and can still say no.
 */
import { useId, useState } from "react";
import { Field, TextInput } from "@/components/ui";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { evaluatePassword, PASSWORD_RULES } from "../services/passwordPolicy";
import type { PasswordRuleKey } from "../types";

const TONE_BY_SCORE = ["bg-rose-500", "bg-rose-400", "bg-amber-400", "bg-emerald-400", "bg-emerald-500", "bg-emerald-600"];

export interface PasswordFieldProps {
  value: string;
  onChange: (value: string) => void;
  label?: string;
  /** Compared against the password, so `cashier`/`cashier123` is refused. */
  username?: string;
  error?: string;
  hint?: string;
  autoComplete?: string;
  disabled?: boolean;
  required?: boolean;
}

/**
 * A password input with the policy rendered next to it.
 *
 * The checklist is not decoration: an admin setting somebody else's password has
 * no way to guess why "alyq1234" was refused, and the person receiving it has to
 * be told what to type. Every rule in `services/passwordPolicy` gets a row, and
 * rows turn green as they are satisfied — which is also the honest way to show
 * that this check is a convenience, since the provider enforces its own policy in
 * live mode and can still say no.
 */
export function PasswordField({
  value,
  onChange,
  label,
  username,
  error,
  hint,
  autoComplete = "new-password",
  disabled,
  required,
}: PasswordFieldProps) {
  const { t } = useI18n();
  const generated = useId();
  const [reveal, setReveal] = useState(false);
  const verdict = evaluatePassword(value, username);

  const ruleLabel = (key: PasswordRuleKey) => t(`settings.password.rule.${key}` as Parameters<typeof t>[0]);
  const strengthKey =
    verdict.score >= 5 ? "settings.password.strength.strong" : verdict.score >= 3 ? "settings.password.strength.fair" : "settings.password.strength.weak";

  return (
    <div className="space-y-2">
      <Field
        label={label ?? t("settings.password.title")}
        hint={hint ?? t("settings.password.hint")}
        error={error}
        required={required}
        htmlFor={generated}
      >
        <div className="flex items-center gap-2">
          <TextInput
            id={generated}
            type={reveal ? "text" : "password"}
            value={value}
            disabled={disabled}
            autoComplete={autoComplete}
            invalid={Boolean(error) || (value.length > 0 && !verdict.ok)}
            onChange={(event) => onChange(event.target.value)}
            aria-describedby={`${generated}-rules`}
          />
          {/* Revealing a password an admin is typing for somebody else is a
              support necessity; it is off by default and never persisted. */}
          <button
            type="button"
            onClick={() => setReveal((shown) => !shown)}
            className="shrink-0 rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-bold text-slate-700 shadow-sm transition hover:bg-slate-50"
            aria-pressed={reveal}
          >
            {reveal ? t("settings.password.hide") : t("settings.password.show")}
          </button>
        </div>
      </Field>

      <div className="space-y-1.5" id={`${generated}-rules`}>
        <div className="flex items-center gap-2">
          <div className="flex h-1.5 flex-1 gap-1" aria-hidden>
            {PASSWORD_RULES.map((rule, index) => {
              const passed = verdict.rules.find((entry) => entry.key === rule)?.ok ?? false;
              return (
                <span
                  key={rule}
                  className={`h-full flex-1 rounded-full ${passed ? TONE_BY_SCORE[index + 1] : "bg-slate-200"}`}
                />
              );
            })}
          </div>
          {value ? (
            <span className="text-[11px] font-bold text-slate-600">
              {t(strengthKey as Parameters<typeof t>[0])}
            </span>
          ) : null}
        </div>
        <ul className="grid gap-1 sm:grid-cols-2">
          {verdict.rules.map((rule) => (
            <li
              key={rule.key}
              className={`flex items-center gap-1.5 text-[11px] font-semibold ${
                rule.ok ? "text-emerald-700" : "text-slate-500"
              }`}
            >
              <span aria-hidden>{rule.ok ? "✓" : "○"}</span>
              {ruleLabel(rule.key)}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
