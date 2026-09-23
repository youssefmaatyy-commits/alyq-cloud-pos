import type { ReactNode } from "react";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { Card, EmptyState } from "@/components/ui";
import { useInventory } from "@/modules/inventory/hooks/InventoryProvider";
import { canViewAuditLog } from "@/modules/shifts/permissions";

/**
 * Route guard for the audit trail.
 *
 * Reading the audit log is an oversight action (manager / admin only — see
 * `canViewAuditLog`), so the route is gated here and not just hidden in the
 * sidebar: typing `#/audit` directly must not leak the trail. The guard reads
 * the *reactive* acting user, so switching to a lower role while the page is
 * open immediately replaces the trail with the denial state.
 */
export function RequireAuditAccess({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const { user } = useInventory();

  if (!canViewAuditLog(user)) {
    return (
      <div>
        <Card>
          <EmptyState icon="🔒" title={t("audit.denied")} description={t("audit.deniedHint")} />
        </Card>
      </div>
    );
  }

  return <>{children}</>;
}
