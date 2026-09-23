import { useMemo } from "react";
import { Badge } from "@/components/ui";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { CAPABILITIES, type Capability } from "@/lib/permissions/roles";
import {
  CAPABILITY_GROUPS,
  PERMISSION_ACTIONS,
  actionOfCapability,
  capabilityGroupLabelKey,
  capabilityLabelKey,
} from "@/lib/permissions/catalog";

export interface PermissionSummaryProps {
  /** What the draft role currently holds. */
  capabilities: readonly Capability[];
  /** Tighter spacing for a card; the form uses the full version. */
  compact?: boolean;
}

/**
 * "This role can perform:" / "This role cannot perform:" — the two lists an admin
 * reads before saving.
 *
 * A tick list shows what was chosen; it does not show what choosing it *means*,
 * and the gap between the two is where permission mistakes live. So this panel is
 * written in verbs and areas rather than in identifiers: "Sales · Sell, Apply
 * discount, Void sale" says what the person will be able to do at the till, and
 * the second list says what they will not — including the things nobody thought
 * about, which is the list that actually prevents surprises.
 *
 * Both are derived from the catalogue on every render, so a capability added to
 * `roles.ts` appears here (in one list or the other) without this file changing.
 */
export function PermissionSummary({ capabilities, compact }: PermissionSummaryProps) {
  const { t, lang, num } = useI18n();
  const translate = (key: string) => t(key as Parameters<typeof t>[0]);
  // The list separator follows the language: an English sentence with an Arabic
  // comma in it is the kind of detail that makes a translation look machine-made.
  const separator = lang === "ar" ? "، " : ", ";

  const held = useMemo(() => new Set(capabilities), [capabilities]);
  const areas = useMemo(
    () =>
      CAPABILITY_GROUPS.map((group) => ({
        key: group.key,
        labelKey: capabilityGroupLabelKey(group.key),
        allowed: group.capabilities.filter((capability) => held.has(capability)),
        denied: group.capabilities.filter((capability) => !held.has(capability)),
      })),
    [held],
  );

  const can = areas.filter((area) => area.allowed.length > 0);
  const cannot = areas.filter((area) => area.denied.length > 0);

  return (
    <section
      className={`rounded-xl border border-slate-200 bg-white ${compact ? "p-2.5" : "p-3"} space-y-2.5`}
      aria-label={t("settings.roles.summary.title")}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs font-bold uppercase tracking-wide text-slate-700">
          {t("settings.roles.summary.title")}
        </p>
        <Badge tone="info">
          {t("settings.preview.held", { count: num(held.size), total: num(CAPABILITIES.length) })}
        </Badge>
      </div>

      {held.size === 0 ? (
        <p className="text-xs font-semibold text-rose-700">{t("settings.roles.summary.empty")}</p>
      ) : held.size === CAPABILITIES.length ? (
        <p className="text-xs font-semibold text-emerald-800">{t("settings.roles.summary.all")}</p>
      ) : null}

      <div className={compact ? "space-y-2" : "grid gap-3 sm:grid-cols-2"}>
        <div className="rounded-lg border border-emerald-200 bg-emerald-50/50 p-2.5">
          <h5 className="mb-1.5 text-[11px] font-bold uppercase tracking-wide text-emerald-900">
            {t("settings.roles.summary.can")}
          </h5>
          <ul className="space-y-1">
            {can.map((area) => (
              <li key={area.key} className="text-xs">
                <span className="font-bold text-slate-800">{translate(area.labelKey)}: </span>
                <span className="font-medium text-slate-700">
                  {area.allowed.map((capability) => translate(capabilityLabelKey(capability))).join(separator)}
                </span>
              </li>
            ))}
            {can.length === 0 ? <li className="text-xs font-medium text-slate-400">—</li> : null}
          </ul>
        </div>

        <div className="rounded-lg border border-slate-200 bg-slate-50/70 p-2.5">
          <h5 className="mb-1.5 text-[11px] font-bold uppercase tracking-wide text-slate-600">
            {t("settings.roles.summary.cannot")}
          </h5>
          <ul className="space-y-1">
            {cannot.map((area) => (
              <li key={area.key} className="text-xs">
                <span className="font-bold text-slate-600">{translate(area.labelKey)}: </span>
                <span className="font-medium text-slate-500">
                  {area.denied.map((capability) => translate(capabilityLabelKey(capability))).join(separator)}
                </span>
              </li>
            ))}
            {cannot.length === 0 ? <li className="text-xs font-medium text-slate-400">—</li> : null}
          </ul>
        </div>
      </div>

      {/* The verbs this selection uses, so "22 permissions" reads as a job:
          mostly reads, a few writes, one approval. */}
      <div className="flex flex-wrap gap-1.5">
        {PERMISSION_ACTIONS.map((action) => ({
          action,
          count: capabilities.filter((capability) => actionOfCapability(capability) === action).length,
        }))
          .filter((entry) => entry.count > 0)
          .map((entry) => (
            <span
              key={entry.action}
              className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-slate-600"
            >
              {translate(`permissions.action.${entry.action}`)} · {num(entry.count)}
            </span>
          ))}
      </div>
    </section>
  );
}
