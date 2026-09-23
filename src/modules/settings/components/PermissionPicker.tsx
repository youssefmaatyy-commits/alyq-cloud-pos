import { useMemo, useState } from "react";
import { Badge, Card, SearchIcon, TextInput } from "@/components/ui";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { CAPABILITIES, capabilitiesOf, type AppRole, type Capability } from "@/lib/permissions/roles";
import {
  CAPABILITY_GROUPS,
  actionOfCapability,
  actionsInGroup,
  capabilityHintKey,
  capabilityLabelKey,
  capabilityGroupLabelKey,
} from "@/lib/permissions/catalog";

export interface PermissionPickerProps {
  value: Capability[];
  onChange: (next: Capability[]) => void;
  /** Shown as a hint on each row the base system role would already grant. */
  baseRole?: AppRole | null;
  disabled?: boolean;
  error?: string;
}

/**
 * The permission catalogue, as a picker.
 *
 * Built from `CAPABILITY_GROUPS` rather than a hand-written list, so a capability
 * added to `roles.ts` appears here the moment it is grouped — and
 * `catalogProblems()` in the logic suite fails if it is not grouped at all. The
 * alternative (a list maintained beside the matrix) is how a permission ends up
 * ungrantable.
 *
 * Every row also carries its verb — View, Create, Edit, Delete, Approve, Export,
 * Manage — because "permissions" is not one kind of thing. A group header lists
 * the verbs that area actually uses, so an admin can see at a glance that
 * Customers is view/create/edit/delete and Reports is view/export, and never has
 * to wonder why there is no "Approve customer" to tick. The verbs come from
 * `CAPABILITY_ACTIONS`, which the compiler checks against the full capability
 * list: a capability added to `roles.ts` without declaring its verb does not
 * build, which is how the picker supports permissions nobody has written yet.
 *
 * The "the base role grants this" hint is the part that makes a custom role
 * understandable. A custom role *replaces* the system matrix, so unticking
 * something the base role allows is a real reduction, and an admin who cannot see
 * that will spend an afternoon working out why the accountant cannot open the
 * register.
 */
export function PermissionPicker({ value, onChange, baseRole, disabled, error }: PermissionPickerProps) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");

  const selected = useMemo(() => new Set(value), [value]);
  const baseGrants = useMemo(() => new Set(baseRole ? capabilitiesOf(baseRole) : []), [baseRole]);
  const translate = (key: string) => t(key as Parameters<typeof t>[0]);

  const groups = useMemo(() => {
    const term = query.trim().toLowerCase();
    if (!term) return CAPABILITY_GROUPS;
    return CAPABILITY_GROUPS.map((group) => ({
      ...group,
      capabilities: group.capabilities.filter(
        (capability) =>
          capability.includes(term) ||
          translate(capabilityLabelKey(capability)).toLowerCase().includes(term) ||
          translate(capabilityHintKey(capability)).toLowerCase().includes(term),
      ),
    })).filter((group) => group.capabilities.length > 0);
  }, [query, translate]);

  const toggle = (capability: Capability) => {
    if (disabled) return;
    const next = new Set(selected);
    if (next.has(capability)) next.delete(capability);
    else next.add(capability);
    // Keep the stored order canonical so two roles with the same permissions
    // compare equal — in the UI, in the audit log and in the database.
    onChange(CAPABILITIES.filter((entry) => next.has(entry)));
  };

  const setGroup = (capabilities: readonly Capability[], on: boolean) => {
    if (disabled) return;
    const next = new Set(selected);
    for (const capability of capabilities) {
      if (on) next.add(capability);
      else next.delete(capability);
    }
    onChange(CAPABILITIES.filter((entry) => next.has(entry)));
  };

  return (
    <Card className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-sm font-bold text-slate-900">{t("settings.roles.picker.title")}</p>
          <p className="text-xs font-medium text-slate-600">{t("settings.roles.picker.hint")}</p>
          <p className="text-xs font-medium text-slate-500">{t("settings.roles.picker.workspaceHint")}</p>
        </div>
        <div className="flex items-center gap-2">
          <Badge tone="info">
            {t("settings.roles.picker.selected", {
              count: selected.size,
              total: CAPABILITIES.length,
            })}
          </Badge>
          <button
            type="button"
            className="text-xs font-bold text-indigo-700 underline-offset-2 hover:underline disabled:text-slate-400"
            disabled={disabled}
            onClick={() => onChange([...CAPABILITIES])}
          >
            {t("settings.roles.picker.selectAll")}
          </button>
          <button
            type="button"
            className="text-xs font-bold text-slate-600 underline-offset-2 hover:underline disabled:text-slate-400"
            disabled={disabled}
            onClick={() => onChange([])}
          >
            {t("settings.roles.picker.clearAll")}
          </button>
        </div>
      </div>

      <TextInput
        type="search"
        value={query}
        leading={<SearchIcon />}
        onChange={(event) => setQuery(event.target.value)}
        placeholder={t("settings.roles.picker.search")}
        aria-label={t("settings.roles.picker.search")}
      />

      {error ? (
        <p className="flex items-center gap-1 text-xs font-semibold text-rose-700">
          <span aria-hidden>⚠</span>
          {error}
        </p>
      ) : null}

      {groups.length === 0 ? (
        <p className="py-6 text-center text-sm font-medium text-slate-500">
          {t("settings.roles.picker.noResults")}
        </p>
      ) : null}

      <div className="space-y-3">
        {groups.map((group) => {
          return (
            <div key={group.key} className="rounded-xl border border-slate-200 bg-slate-50/60 p-3">
              <div className="mb-2 flex items-center justify-between gap-2">
                <p className="text-xs font-bold uppercase tracking-wide text-slate-700">
                  {translate(capabilityGroupLabelKey(group.key))}
                  {/* The columns this area has — the actions that make sense here. */}
                  <span className="ms-2 font-semibold normal-case tracking-normal text-slate-500">
                    {actionsInGroup(group.key).map((action) => translate(`permissions.action.${action}`)).join(" · ")}
                  </span>
                </p>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() => setGroup(group.capabilities, true)}
                    className="text-[11px] font-bold text-indigo-700 underline-offset-2 hover:underline disabled:text-slate-400"
                  >
                    {t("settings.roles.picker.groupAll")}
                  </button>
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() => setGroup(group.capabilities, false)}
                    className="text-[11px] font-bold text-slate-600 underline-offset-2 hover:underline disabled:text-slate-400"
                  >
                    {t("settings.roles.picker.groupNone")}
                  </button>
                </div>
              </div>
              <ul className="grid gap-1.5 sm:grid-cols-2">
                {group.capabilities.map((capability) => {
                  const on = selected.has(capability);
                  const fromBase = baseGrants.has(capability);
                  const inputId = `cap-${group.key}-${capability}`;
                  return (
                    <li key={capability}>
                      <label
                        htmlFor={inputId}
                        className={`flex cursor-pointer items-start gap-2 rounded-lg border px-2.5 py-2 text-xs transition ${
                          on
                            ? "border-indigo-300 bg-indigo-50/70 text-slate-900"
                            : "border-slate-200 bg-white text-slate-700 hover:border-slate-300"
                        } ${disabled ? "cursor-not-allowed opacity-60" : ""}`}
                      >
                        <input
                          id={inputId}
                          type="checkbox"
                          className="mt-0.5 h-4 w-4 shrink-0 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                          checked={on}
                          disabled={disabled}
                          onChange={() => toggle(capability)}
                        />
                        <span className="min-w-0">
                          <span className="flex items-center gap-1.5">
                            <span className="block font-bold">{translate(capabilityLabelKey(capability))}</span>
                            <span className="shrink-0 rounded-full bg-slate-100 px-1.5 py-0.5 text-[9px] font-black uppercase tracking-wide text-slate-500">
                              {translate(`permissions.action.${actionOfCapability(capability)}`)}
                            </span>
                          </span>
                          <span className="block font-medium text-slate-600">
                            {translate(capabilityHintKey(capability))}
                          </span>
                          {fromBase ? (
                            <span className="mt-0.5 block text-[10px] font-semibold uppercase tracking-wide text-emerald-700">
                              {t("settings.roles.picker.baseGrants")}
                            </span>
                          ) : null}
                        </span>
                      </label>
                    </li>
                  );
                })}
              </ul>
              <p className="sr-only" aria-live="polite">
                {`${translate(capabilityGroupLabelKey(group.key))}: ${
                  group.capabilities.filter((capability) => selected.has(capability)).length
                }/${group.capabilities.length}`}
              </p>
            </div>
          );
        })}
      </div>
    </Card>
  );
}
