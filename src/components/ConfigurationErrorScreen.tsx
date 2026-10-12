/**
 * The production fail-closed screen.
 *
 * When `VITE_APP_MODE=production` and the Supabase configuration is missing,
 * incomplete, malformed or dangerous, the application must not start at all —
 * and it must not quietly substitute the demo dataset either. This is the only
 * thing that renders in that case: no router, no providers, no repository, no
 * network. It is deliberately dependency-free (no i18n provider, no UI kit,
 * no service worker) so nothing can fail ahead of it, and deliberately
 * bilingual so the operator standing at the machine can read it.
 *
 * The rendered detail is a list of issue messages produced by
 * `src/lib/appMode.ts`. Those strings never contain a credential value, only
 * field names — the screen is safe to screenshot into a support thread.
 */
import { CONFIGURATION_ISSUES, FATAL_CONFIGURATION_ISSUES, describeAppMode } from "@/lib/appMode";
import { releaseLine } from "@/lib/release";

export function ConfigurationErrorScreen() {
  const fatal = FATAL_CONFIGURATION_ISSUES;
  const warnings = CONFIGURATION_ISSUES.filter((issue) => issue.severity === "warning");

  return (
    <div
      role="alert"
      data-testid="configuration-error"
      dir="ltr"
      className="flex min-h-screen items-center justify-center bg-stone-950 p-6 text-stone-100"
    >
      <div className="w-full max-w-2xl rounded-2xl border border-red-900/60 bg-stone-900 p-8 shadow-lg">
        <p className="text-xs font-semibold uppercase tracking-widest text-red-400">
          ALYQ Cloud POS · configuration blocked
        </p>
        <h1 className="mt-3 text-xl font-semibold text-white">
          This build is configured for production, but its backend configuration is not usable.
        </h1>
        <p dir="rtl" className="mt-1 text-base font-semibold text-stone-200">
          هذه النسخة مُهيّأة للإنتاج، لكن إعدادات الاتصال بقاعدة البيانات غير صالحة.
        </p>

        <p className="mt-5 text-sm leading-relaxed text-stone-300">
          The application refuses to start rather than fall back to local demo data. Nothing was
          written anywhere: no sale, no customer, no stock movement.
        </p>
        <p dir="rtl" className="mt-2 text-sm leading-relaxed text-stone-400">
          التطبيق يرفض العمل بدلًا من التحول إلى بيانات تجريبية محلية. لم يتم كتابة أي شيء: لا بيع
          ولا عميل ولا حركة مخزون.
        </p>

        <ul className="mt-6 space-y-3">
          {fatal.map((issue) => (
            <li
              key={`${issue.code}-${issue.field}`}
              className="rounded-lg border border-red-900/50 bg-red-950/30 p-3"
            >
              <p className="font-mono text-xs text-red-300">
                {issue.code} · {issue.field}
              </p>
              <p className="mt-1 text-sm text-stone-200">{issue.message}</p>
            </li>
          ))}
        </ul>

        {warnings.length > 0 ? (
          <details className="mt-5 text-xs text-stone-400">
            <summary className="cursor-pointer select-none">
              {warnings.length} configuration warning{warnings.length === 1 ? "" : "s"}
            </summary>
            <ul className="mt-2 space-y-1">
              {warnings.map((issue) => (
                <li key={`${issue.code}-${issue.field}`} className="font-mono">
                  {issue.code} · {issue.field}: {issue.message}
                </li>
              ))}
            </ul>
          </details>
        ) : null}

        <div className="mt-6 rounded-lg border border-stone-800 bg-stone-950/60 p-3 text-xs text-stone-400">
          <p>
            Set <code className="text-stone-200">VITE_SUPABASE_URL</code> and{" "}
            <code className="text-stone-200">VITE_SUPABASE_ANON_KEY</code> in the build environment,
            then rebuild. See <code className="text-stone-200">docs/production/production-environment.md</code>.
          </p>
          <p className="mt-2 font-mono text-[11px] text-stone-500">{describeAppMode()}</p>
          <p className="mt-1 font-mono text-[11px] text-stone-500">{releaseLine()}</p>
        </div>

        <button
          type="button"
          onClick={() => window.location.reload()}
          className="mt-6 w-full rounded-lg bg-white px-4 py-2.5 text-sm font-medium text-stone-900 transition-colors hover:bg-stone-200"
        >
          Reload · إعادة التحميل
        </button>
      </div>
    </div>
  );
}

export default ConfigurationErrorScreen;
