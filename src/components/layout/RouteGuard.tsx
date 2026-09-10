import type { ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { Button, Card, EmptyState } from "@/components/ui";
import { ROLE_LABELS, hasCapability } from "@/lib/permissions/roles";
import { capabilityForPath, isSelfGuardedPath } from "@/lib/permissions/routes";
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

  const required = capabilityForPath(location.pathname);
  if (!required || hasCapability(user.role, required)) return <>{children}</>;

  const roleLabel = ROLE_LABELS[user.role as keyof typeof ROLE_LABELS] ?? user.role;

  return (
    <Card>
      <EmptyState
        icon="🔒"
        title={t("perm.denied")}
        description={t("perm.deniedHint", { role: roleLabel })}
        action={
          <Link to="/">
            <Button variant="secondary">{t("common.backToDashboard")}</Button>
          </Link>
        }
      />
    </Card>
  );
}
