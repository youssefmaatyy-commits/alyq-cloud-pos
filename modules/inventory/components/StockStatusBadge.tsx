import { useI18n } from "@/lib/i18n/I18nProvider";
import { Badge } from "@/components/ui";

/**
 * Status pill used in the inventory list and the product detail page.
 * Reuses the same tonal language as `ProductTypeBadge` / `ActiveBadge` to
 * stay consistent with Option B.
 */
export function StockStatusBadge({
  status,
  withIcon = true,
}: {
  status: "in" | "low" | "out" | "none";
  withIcon?: boolean;
}) {
  const { t } = useI18n();

  if (status === "low") {
    return (
      <Badge tone="warning">
        {withIcon ? <span aria-hidden>⚠️</span> : null}
        {t("inventory.status.low")}
      </Badge>
    );
  }
  if (status === "out") {
    return (
      <Badge tone="danger">
        {withIcon ? <span aria-hidden>⛔</span> : null}
        {t("inventory.status.out")}
      </Badge>
    );
  }
  if (status === "none") {
    return <Badge>{t("inventory.status.none")}</Badge>;
  }
  return (
    <Badge tone="success">
      {withIcon ? <span aria-hidden>✔️</span> : null}
      {t("inventory.status.in")}
    </Badge>
  );
}
