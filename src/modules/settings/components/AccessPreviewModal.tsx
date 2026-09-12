import { useEffect, useMemo, useState } from "react";
import { Badge, Modal, SelectInput } from "@/components/ui";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { APP_ROLES, CAPABILITIES, type AppRole } from "@/lib/permissions/roles";
import { capabilityLabelKey } from "@/lib/permissions/catalog";
import { actionTally, previewAccess } from "@/lib/permissions/preview";
import { customRoleName, type CustomRole } from "@/lib/permissions/customRoles";
import type { ManagedUser } from "../types";
import { roleLabel } from "./UserStatusBadge";

export interface AccessPreviewModalProps {
  open: boolean;
  onClose: () => void;
  roles: CustomRole[];
  users: ManagedUser[];
  /** Preselect a role when the modal is opened from a role card. */
  initialRoleId?: string | null;
}

/** What is being previewed: a role on its own, or one person as configured. */
type Subject =
  | { kind: "system"; role: AppRole }
  | { kind: "custom"; roleId: string }
  | { kind: "user"; userId: string };

/**
 * Settings → Roles & permissions → Preview.
 *
 * The question this answers is the one an admin cannot answer from a list of
 * ticked boxes: *what would this person actually see?* Which menus appear, which
 * buttons exist, and what has quietly disappeared — because a permission nobody
 * thinks about is a permission somebody discovers by accident three weeks later.
 *
 * It is a projection, and it is careful to look like one. Nothing here writes to
 * the session, calls `canAct`, or is read by a guard: `previewAccess()` computes
 * the same three inputs the real gates use (role, overlay, exceptions) against
 * the same two tables (`ROUTE_CAPABILITIES` for screens, the capability catalogue
 * for acts), so the preview cannot say yes where the app would say no. Previewing
 * the admin role while signed in as a cashier changes this panel and nothing
 * else — which is the whole point of it being safe to offer.
 */
export function AccessPreviewModal({ open, onClose, roles, users, initialRoleId }: AccessPreviewModalProps) {
  const { t, lang, num } = useI18n();
  const translate = (key: string) => t(key as Parameters<typeof t>[0]);

  const [subject, setSubject] = useState<Subject>({ kind: "system", role: "cashier" });

  useEffect(() => {
    if (!open) return;
    const preset = initialRoleId ? roles.find((role) => role.id === initialRoleId) : null;
    setSubject(
      preset
        ? { kind: "custom", roleId: preset.id }
        : { kind: "system", role: (roles[0]?.base_role ?? "cashier") as AppRole },
    );
  }, [open, initialRoleId, roles]);

  const customRole = useMemo(
    () => (subject.kind === "custom" ? (roles.find((role) => role.id === subject.roleId) ?? null) : null),
    [subject, roles],
  );
  const person = useMemo(
    () => (subject.kind === "user" ? (users.find((user) => user.id === subject.userId) ?? null) : null),
    [subject, users],
  );
  /** The custom role a previewed person wears, when it is still active. */
  const personRole = useMemo(() => {
    if (!person?.custom_role_id) return null;
    const role = roles.find((candidate) => candidate.id === person.custom_role_id);
    return role && role.active ? role : null;
  }, [person, roles]);

  const preview = useMemo(
    () =>
      previewAccess(
        person
          ? {
              role: person.role,
              customRole: personRole ? { capabilities: personRole.capabilities, active: true } : null,
              exceptions: { extra: person.extra_capabilities, denied: person.denied_capabilities },
            }
          : customRole
            ? { role: customRole.base_role, customRole: { capabilities: customRole.capabilities, active: true } }
            : { role: subject.kind === "system" ? subject.role : null },
      ),
    [person, personRole, customRole, subject],
  );

  const title = person
    ? `${person.name} · ${personRole ? customRoleName(personRole, lang) : roleLabel(t, person.role)}`
    : customRole
      ? customRoleName(customRole, lang)
      : roleLabel(t, subject.kind === "system" ? subject.role : "viewer");

  const tally = actionTally(preview.capabilities);

  return (
    <Modal open={open} onClose={onClose} size="lg" title={t("settings.preview.title")}>
      <div className="space-y-4">
        <p className="text-xs font-medium text-slate-600">{t("settings.preview.subtitle")}</p>

        {/* The one thing this panel must never be mistaken for: a way in. */}
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-900">
          {t("settings.preview.readOnly")}
        </p>

        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1 block text-xs font-bold text-slate-700">{t("settings.preview.subjectRole")}</span>
            <SelectInput
              value={subject.kind === "user" ? "" : subject.kind === "custom" ? subject.roleId : subject.role}
              disabled={subject.kind === "user"}
              onChange={(event) => {
                const value = event.target.value;
                if (roles.some((role) => role.id === value)) setSubject({ kind: "custom", roleId: value });
                else setSubject({ kind: "system", role: value as AppRole });
              }}
            >
              <optgroup label={translate("settings.preview.systemRoles")}>
                {APP_ROLES.map((role) => (
                  <option key={role} value={role}>
                    {roleLabel(t, role)}
                  </option>
                ))}
              </optgroup>
              {roles.length > 0 ? (
                <optgroup label={translate("settings.preview.customRoles")}>
                  {roles.map((role) => (
                    <option key={role.id} value={role.id}>
                      {customRoleName(role, lang)}
                      {role.active ? "" : ` · ${translate("common.inactive")}`}
                    </option>
                  ))}
                </optgroup>
              ) : null}
            </SelectInput>
          </label>

          <label className="block">
            <span className="mb-1 block text-xs font-bold text-slate-700">{t("settings.preview.subjectUser")}</span>
            <SelectInput
              value={person?.id ?? ""}
              onChange={(event) => {
                const userId = event.target.value;
                if (!userId) {
                  setSubject({ kind: "system", role: (person?.role ?? "cashier") as AppRole });
                  return;
                }
                setSubject({ kind: "user", userId });
              }}
            >
              <option value="">{t("settings.preview.noUser")}</option>
              {users.map((user) => (
                <option key={user.id} value={user.id}>
                  {user.name} ({user.username})
                </option>
              ))}
            </SelectInput>
          </label>
        </div>

        <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-bold text-slate-900">{title}</p>
            <Badge tone="info">
              {t("settings.preview.held", {
                count: num(preview.capabilities.length),
                total: num(CAPABILITIES.length),
              })}
            </Badge>
          </div>
          {/* The verbs, so "14 permissions" reads as what they are: 9 reads, 3
              writes, 2 approvals — the shape of a job rather than a number. */}
          <div className="mt-2 flex flex-wrap gap-1.5">
            {tally.map((entry) => (
              <span
                key={entry.action}
                className="rounded-full bg-white px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-slate-600 ring-1 ring-slate-200"
              >
                {translate(`permissions.action.${entry.action}`)} · {num(entry.count)}
              </span>
            ))}
          </div>

          {preview.addedByException.length > 0 || preview.removedByException.length > 0 ? (
            <div className="mt-3 space-y-1.5 border-t border-slate-200 pt-2.5">
              {preview.addedByException.length > 0 ? (
                <p className="flex flex-wrap items-center gap-1.5 text-[11px] font-semibold text-emerald-800">
                  {t("settings.preview.addedByException")}
                  {preview.addedByException.map((capability) => (
                    <Badge key={capability} tone="success">
                      {translate(capabilityLabelKey(capability))}
                    </Badge>
                  ))}
                </p>
              ) : null}
              {preview.removedByException.length > 0 ? (
                <p className="flex flex-wrap items-center gap-1.5 text-[11px] font-semibold text-rose-800">
                  {t("settings.preview.removedByException")}
                  {preview.removedByException.map((capability) => (
                    <Badge key={capability} tone="danger">
                      {translate(capabilityLabelKey(capability))}
                    </Badge>
                  ))}
                </p>
              ) : null}
            </div>
          ) : null}
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <section className="rounded-xl border border-emerald-200 bg-emerald-50/50 p-3">
            <h4 className="mb-2 text-xs font-bold uppercase tracking-wide text-emerald-900">
              {t("settings.preview.menusVisible")} · {num(preview.screens.visible.length)}
            </h4>
            <ul className="space-y-1">
              {preview.screens.visible.map((screen) => (
                <li
                  key={screen.path}
                  className="flex items-center justify-between gap-2 text-xs font-semibold text-slate-800"
                >
                  <span>{translate(screen.labelKey)}</span>
                  <span dir="ltr" className="font-mono text-[10px] font-medium text-slate-400">
                    {screen.path}
                  </span>
                </li>
              ))}
            </ul>
          </section>

          <section className="rounded-xl border border-slate-200 bg-white p-3">
            <h4 className="mb-2 text-xs font-bold uppercase tracking-wide text-slate-600">
              {t("settings.preview.menusHidden")} · {num(preview.screens.hidden.length)}
            </h4>
            {preview.screens.hidden.length === 0 ? (
              <p className="text-xs font-medium text-slate-500">{t("settings.preview.nothingHidden")}</p>
            ) : (
              <ul className="space-y-1">
                {preview.screens.hidden.map((screen) => (
                  <li
                    key={screen.path}
                    className="flex items-center justify-between gap-2 text-xs font-medium text-slate-500"
                  >
                    <span>{translate(screen.labelKey)}</span>
                    {/* The gate is named, so "hidden" is a decision somebody can
                        find and reverse rather than a mystery. */}
                    {screen.capability ? (
                      <Badge tone="neutral">{translate(capabilityLabelKey(screen.capability))}</Badge>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        <section className="space-y-2.5">
          <h4 className="text-xs font-bold uppercase tracking-wide text-slate-700">
            {t("settings.preview.canPerform")} / {t("settings.preview.cannotPerform")}
          </h4>
          {preview.groups.map((group) => (
            <div key={group.key} className="rounded-xl border border-slate-200 bg-slate-50/60 p-3">
              <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
                <p className="text-xs font-bold text-slate-800">{translate(group.labelKey)}</p>
                <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                  {group.actions.map((action) => translate(`permissions.action.${action}`)).join(" · ")}
                </span>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {group.allowed.map((capability) => (
                  <Badge key={capability} tone="success">
                    {translate(capabilityLabelKey(capability))}
                  </Badge>
                ))}
                {group.denied.map((capability) => (
                  <span
                    key={capability}
                    className="rounded-full bg-white px-2 py-0.5 text-[10px] font-semibold text-slate-400 ring-1 ring-slate-200 line-through"
                  >
                    {translate(capabilityLabelKey(capability))}
                  </span>
                ))}
                {group.allowed.length === 0 && group.denied.length === 0 ? (
                  <span className="text-[11px] font-medium text-slate-400">—</span>
                ) : null}
              </div>
            </div>
          ))}
        </section>
      </div>
    </Modal>
  );
}
