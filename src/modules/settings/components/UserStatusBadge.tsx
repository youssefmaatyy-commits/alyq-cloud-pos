import { Badge } from "@/components/ui";
import { useI18n } from "@/lib/i18n/I18nProvider";
import type { AppRole } from "@/lib/permissions/roles";
import type { ManagedUser } from "../types";

type Translate = ReturnType<typeof useI18n>["t"];

/** The localised name of one of the five system roles. */
export function roleLabel(t: Translate, role: AppRole | string): string {
  return role ? t(`settings.role.${role}` as Parameters<Translate>[0]) : "—";
}

/**
 * Active / deactivated, as a badge.
 *
 * A deactivated account is the one state an admin must be able to see at a glance
 * across a long table: it explains a support call ("I can't sign in") without
 * anyone opening the row.
 */
export function UserStatusBadge({ active }: { active: boolean }) {
  const { t } = useI18n();
  return (
    <Badge tone={active ? "success" : "danger"}>
      <span aria-hidden>{active ? "●" : "○"}</span>
      {active ? t("settings.users.status.active") : t("settings.users.status.inactive")}
    </Badge>
  );
}

/** Role cell: the system role, plus the overlay name when one is assigned. */
export function UserRoleBadge({ user }: { user: ManagedUser }) {
  const { t } = useI18n();
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Badge tone={user.role === "admin" ? "info" : "neutral"}>{roleLabel(t, user.role)}</Badge>
      {user.custom_role_name ? (
        // `Badge` takes no title, so the explanation rides on a wrapper: an admin
        // hovering a role they did not create should be told it overrides the
        // system matrix rather than adding to it.
        <span title={t("settings.users.form.customRoleHint")} className="inline-flex">
          <Badge tone="warning">{user.custom_role_name}</Badge>
        </span>
      ) : null}
    </div>
  );
}
