import { useEffect, useMemo, useState } from "react";
import { Badge, Button, Modal } from "@/components/ui";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { useAuth } from "@/lib/auth/hooks/AuthProvider";
import { CAPABILITIES, type Capability } from "@/lib/permissions/roles";
import {
  CAPABILITY_GROUPS,
  actionOfCapability,
  capabilityGroupLabelKey,
  capabilityLabelKey,
} from "@/lib/permissions/catalog";
import { sanitizeCapabilityExceptions, type CapabilityExceptions } from "@/lib/permissions/exceptions";
import { previewAccess } from "@/lib/permissions/preview";
import { customRoleName, type CustomRole } from "@/lib/permissions/customRoles";
import type { ManagedUser } from "../types";
import { roleLabel } from "./UserStatusBadge";

export interface UserExceptionsModalProps {
  open: boolean;
  user: ManagedUser | null;
  roles: CustomRole[];
  onClose: () => void;
  onSubmit: (userId: string, exceptions: CapabilityExceptions) => Promise<void>;
}

/**
 * Settings → Users → one person's permissions.
 *
 * The role stays the description of the job; this panel is what makes one person
 * different from it, and it is deliberately narrow:
 *
 *   · only what the role lacks can be granted, and only what the role holds can
 *     be withheld — so the two lists cannot contradict each other, and an admin
 *     cannot "grant" something the role already gives (which would look like a
 *     decision and mean nothing);
 *   · a denial wins, in the UI, in the service and in `public.can()`;
 *   · the effect is shown live, as the same preview the Roles screen offers, so
 *     saving is not an act of faith.
 *
 * An exception is meant to be rare and readable. That is why it sits on the
 * person rather than in a role cloned for one seat: a role with a single wearer
 * hides the fact that the difference was personal, and six months later nobody
 * knows which of the two accountant roles is the real one.
 */
export function UserExceptionsModal({ open, user, roles, onClose, onSubmit }: UserExceptionsModalProps) {
  const { t, lang, num } = useI18n();
  const { user: sessionUser } = useAuth();
  const translate = (key: string) => t(key as Parameters<typeof t>[0]);

  const [extra, setExtra] = useState<Capability[]>([]);
  const [denied, setDenied] = useState<Capability[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const customRole = useMemo(() => {
    if (!user?.custom_role_id) return null;
    const role = roles.find((candidate) => candidate.id === user.custom_role_id);
    return role && role.active ? role : null;
  }, [user, roles]);

  /** What the role alone gives — the line the two lists are drawn against. */
  const baseline = useMemo(
    () =>
      previewAccess({
        role: user?.role ?? null,
        customRole: customRole ? { capabilities: customRole.capabilities, active: true } : null,
      }),
    [user, customRole],
  );
  const roleHolds = useMemo(() => new Set(baseline.capabilities), [baseline]);

  useEffect(() => {
    if (!open || !user) return;
    const stored = sanitizeCapabilityExceptions({
      extra: user.extra_capabilities,
      denied: user.denied_capabilities,
    });
    setExtra([...stored.extra]);
    setDenied([...stored.denied]);
    setError(null);
    setSaving(false);
  }, [open, user]);

  const draft = useMemo<CapabilityExceptions>(() => sanitizeCapabilityExceptions({ extra, denied }), [extra, denied]);
  const preview = useMemo(
    () =>
      previewAccess({
        role: user?.role ?? null,
        customRole: customRole ? { capabilities: customRole.capabilities, active: true } : null,
        exceptions: draft,
      }),
    [user, customRole, draft],
  );

  const stored = useMemo(
    () =>
      sanitizeCapabilityExceptions({
        extra: user?.extra_capabilities,
        denied: user?.denied_capabilities,
      }),
    [user],
  );
  const unchanged =
    draft.extra.join(",") === stored.extra.join(",") && draft.denied.join(",") === stored.denied.join(",");

  const isSelf = Boolean(sessionUser?.id) && sessionUser?.id === user?.id;

  function toggle(list: Capability[], setList: (next: Capability[]) => void, capability: Capability) {
    setList(list.includes(capability) ? list.filter((entry) => entry !== capability) : [...list, capability]);
  }

  async function submit() {
    if (!user) return;
    // Restated here because the guard should be read before it is met, not after:
    // the service and `admin_set_user_exceptions` refuse the same write.
    if (isSelf && draft.denied.includes("manage_users")) {
      setError(t("settings.users.exceptions.selfDeny"));
      return;
    }
    setError(null);
    setSaving(true);
    try {
      await onSubmit(user.id, draft);
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      setError(raw.startsWith("settings.") || raw.startsWith("permissions.") ? translate(raw) : raw);
      throw err;
    } finally {
      setSaving(false);
    }
  }

  /** One area's rows, split by the only decision that area can hold. */
  function rowsFor(groupKey: string, kind: "grant" | "withhold") {
    const group = CAPABILITY_GROUPS.find((candidate) => candidate.key === groupKey);
    if (!group) return [];
    return group.capabilities.filter((capability) =>
      kind === "grant" ? !roleHolds.has(capability) : roleHolds.has(capability),
    );
  }

  const grantAreas = CAPABILITY_GROUPS.map((group) => ({ group, rows: rowsFor(group.key, "grant") })).filter(
    (entry) => entry.rows.length > 0,
  );
  const withholdAreas = CAPABILITY_GROUPS.map((group) => ({ group, rows: rowsFor(group.key, "withhold") })).filter(
    (entry) => entry.rows.length > 0,
  );

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title={t("settings.users.exceptions.title")}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            {t("common.cancel")}
          </Button>
          <Button onClick={() => void submit()} disabled={saving || unchanged || !user}>
            {saving ? t("common.saving") : t("common.save")}
          </Button>
        </>
      }
    >
      {user ? (
        <div className="space-y-4">
          <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-3">
            <p className="text-sm font-bold text-slate-900">
              {user.name} <span className="font-medium text-slate-500">({user.username})</span>
            </p>
            <p className="mt-0.5 text-xs font-medium text-slate-600">
              {t("settings.users.exceptions.subtitle", {
                role: customRole ? customRoleName(customRole, lang) : roleLabel(t, user.role),
              })}
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <Badge tone="info">
                {t("settings.users.exceptions.final", { count: num(preview.capabilities.length) })}
              </Badge>
              {preview.addedByException.map((capability) => (
                <Badge key={capability} tone="success">
                  + {translate(capabilityLabelKey(capability))}
                </Badge>
              ))}
              {preview.removedByException.map((capability) => (
                <Badge key={capability} tone="danger">
                  − {translate(capabilityLabelKey(capability))}
                </Badge>
              ))}
            </div>
          </div>

          {error ? (
            <p className="flex items-center gap-1 text-xs font-semibold text-rose-700">
              <span aria-hidden>⚠</span>
              {error}
            </p>
          ) : null}

          {draft.extra.length === 0 && draft.denied.length === 0 ? (
            <p className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs font-semibold text-emerald-900">
              {t("settings.users.exceptions.none")}
            </p>
          ) : null}

          {/* Withhold first: taking something away is the change that needs the
              most looking at, and it is the one a denial wins. */}
          <section className="space-y-2">
            <div>
              <h4 className="text-xs font-bold uppercase tracking-wide text-rose-800">
                {t("settings.users.exceptions.withhold")}
              </h4>
              <p className="text-[11px] font-medium text-slate-600">
                {t("settings.users.exceptions.withholdHint")}
              </p>
            </div>
            {withholdAreas.map(({ group, rows }) => (
              <div key={group.key} className="rounded-xl border border-slate-200 bg-white p-2.5">
                <p className="mb-1.5 text-[11px] font-bold uppercase tracking-wide text-slate-600">
                  {translate(capabilityGroupLabelKey(group.key))}
                </p>
                <ul className="grid gap-1 sm:grid-cols-2">
                  {rows.map((capability) => {
                    const on = denied.includes(capability);
                    const blocked = isSelf && capability === "manage_users";
                    const inputId = `deny-${capability}`;
                    return (
                      <li key={capability}>
                        <label
                          htmlFor={inputId}
                          className={`flex cursor-pointer items-center gap-2 rounded-lg border px-2 py-1.5 text-xs transition ${
                            on ? "border-rose-300 bg-rose-50 text-rose-900" : "border-slate-200 text-slate-700"
                          } ${blocked ? "cursor-not-allowed opacity-60" : ""}`}
                          title={blocked ? t("settings.users.exceptions.selfDeny") : undefined}
                        >
                          <input
                            id={inputId}
                            type="checkbox"
                            className="h-3.5 w-3.5 shrink-0 rounded border-slate-300 text-rose-600 focus:ring-rose-500"
                            checked={on}
                            disabled={blocked || saving}
                            onChange={() => toggle(denied, setDenied, capability)}
                          />
                          <span className="min-w-0 flex-1 font-semibold">
                            {translate(capabilityLabelKey(capability))}
                          </span>
                          <span className="shrink-0 text-[10px] font-bold uppercase tracking-wide text-slate-400">
                            {translate(`permissions.action.${actionOfCapability(capability)}`)}
                          </span>
                        </label>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </section>

          <section className="space-y-2">
            <div>
              <h4 className="text-xs font-bold uppercase tracking-wide text-emerald-800">
                {t("settings.users.exceptions.grant")}
              </h4>
              <p className="text-[11px] font-medium text-slate-600">{t("settings.users.exceptions.grantHint")}</p>
            </div>
            {grantAreas.map(({ group, rows }) => (
              <div key={group.key} className="rounded-xl border border-slate-200 bg-white p-2.5">
                <p className="mb-1.5 text-[11px] font-bold uppercase tracking-wide text-slate-600">
                  {translate(capabilityGroupLabelKey(group.key))}
                </p>
                <ul className="grid gap-1 sm:grid-cols-2">
                  {rows.map((capability) => {
                    const on = extra.includes(capability);
                    const inputId = `grant-${capability}`;
                    return (
                      <li key={capability}>
                        <label
                          htmlFor={inputId}
                          className={`flex cursor-pointer items-center gap-2 rounded-lg border px-2 py-1.5 text-xs transition ${
                            on
                              ? "border-emerald-300 bg-emerald-50 text-emerald-900"
                              : "border-slate-200 text-slate-700"
                          }`}
                        >
                          <input
                            id={inputId}
                            type="checkbox"
                            className="h-3.5 w-3.5 shrink-0 rounded border-slate-300 text-emerald-600 focus:ring-emerald-500"
                            checked={on}
                            disabled={saving}
                            onChange={() => toggle(extra, setExtra, capability)}
                          />
                          <span className="min-w-0 flex-1 font-semibold">
                            {translate(capabilityLabelKey(capability))}
                          </span>
                          <span className="shrink-0 text-[10px] font-bold uppercase tracking-wide text-slate-400">
                            {translate(`permissions.action.${actionOfCapability(capability)}`)}
                          </span>
                        </label>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </section>

          {unchanged ? (
            <p className="text-[11px] font-medium text-slate-500">{t("settings.users.exceptions.unchanged")}</p>
          ) : null}

          {/* The whole catalogue, named once, so the two lists above are visibly
              exhaustive rather than a selection of somebody's favourites. */}
          <p className="text-[11px] font-medium text-slate-400">
            {t("settings.users.exceptions.catalogue", { count: num(CAPABILITIES.length) })}
          </p>
        </div>
      ) : null}
    </Modal>
  );
}
