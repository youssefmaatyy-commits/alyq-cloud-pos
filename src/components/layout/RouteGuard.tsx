import type { ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { Button, Card, EmptyState } from "@/components/ui";
import { ROLE_LABELS } from "@/lib/permissions/roles";
import { can } from "@/lib/permissions/enforce";
import { getCurrentAuthUser } from "@/lib/auth/services/sessionStore";
import { isSelfGuardedPath, pathPermits } from "@/lib/permissions/routes";
import { useInventory } from "@/modules/inventory/hooks/InventoryProvider";

/**
 * Route-level capability guard (Authentication phase).
 *
 * Wraps the whole shell so every screen is covered by one check. A role that
 * lacks the capability for the current path sees a denial instead of the page,
 * whether it arrived by clicking the sidebar — where the entry is hidden anyway
 * — or by typing the URL.
 *
 * This is the second of three deliberately redundant layers:
 *   1. the sidebar only shows screens the role may open (`ROUTE_CAPABILITIES`);
 *   2. this guard refuses the screen itself;
 *   3. action layers still re-check before writing (`InventoryProvider.adjustStock`,
 *      `PosProvider.completeSale`, …).
 *
 * `/audit` keeps its own guard, which supplies more specific denial copy.
 */
export function RouteGuard({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const location = useLocation();
  const { user } = useInventory();

  // Screens with a dedicated guard (audit) render their own, more specific denial.
  if (isSelfGuardedPath(location.pathname)) return <>{children}</>;

  // Normalized permissions, including route alternates, drive this same decision
  // in the sidebar and module cards. Hidden navigation is not this check.
  if (pathPermits(location.pathname, (permission) => can(permission))) return <>{children}</>;

  // Named after what the person actually is. An accountant wearing a custom role
  // should read "Accountant cannot open this screen", not "Manager cannot…".
  const session = getCurrentAuthUser();
  const roleLabel =
    session.custom_role_name || ROLE_LABELS[user.role as keyof typeof ROLE_LABELS] || user.role;

  return (
    <Card testId="route-access-denied">
      <EmptyState
        icon="🔒"
        title={t("perm.denied")}
        description={t("perm.deniedHint", { role: roleLabel })}
        action={
          can("dashboard.view") ? (
            <Link to="/dashboard">
              <Button variant="secondary">{t("common.backToDashboard")}</Button>
            </Link>
          ) : undefined
        }
      />
    </Card>
  );
}
