/**
 * The stock-hold widget (Phase 15 extension).
 *
 * Four numbers, because those are the four questions somebody asks about what the
 * website is holding: how much, is any of it wrong, how much can be fixed right
 * now, and how long has the oldest one been sitting there. Everything else — the
 * verdicts, the reasons, the repair buttons — lives on the holds screen this links
 * to.
 *
 * It reads the review the queue provider already computed instead of fetching
 * anything, so putting it on the dashboard costs no query: the provider loads the
 * orders, the holds and the catalogue once for the whole session and every screen
 * reads that one pass. It renders nothing at all for somebody who cannot work the
 * online queue, and nothing while the website holds no stock — a card that always
 * says zero teaches people to look past it.
 */
import { Link } from "react-router-dom";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { Card, StatTile } from "@/components/ui";
import { AGING_HOLD_DAYS } from "../services/reservationRepair";
import { useOnlineOrders } from "../hooks/OnlineOrdersProvider";

export function ReservationSummaryCard({ className }: { className?: string }) {
  const { t, num } = useI18n();
  const { canManage, holdReview } = useOnlineOrders();

  if (!canManage || holdReview.rows.length === 0) return null;

  const open = holdReview.rows.filter((row) => row.status === "reserved").length;
  const oldest = holdReview.oldestDays;
  const aging = oldest !== null && oldest >= AGING_HOLD_DAYS;

  return (
    <Card className={className}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs font-bold uppercase tracking-widest text-slate-500">
          {t("nav.stockHolds")}
        </p>
        <Link
          to="/online/reservations"
          className="text-xs font-semibold text-indigo-600 hover:text-indigo-700"
        >
          {t("holds.summaryOpen")} →
        </Link>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile
          label={t("holds.summaryActive")}
          value={num(open, 0)}
          tone="primary"
          hint={t("holds.summaryActiveHint", { count: num(holdReview.heldUnits, 0) })}
        />
        <StatTile
          label={t("holds.findings")}
          value={num(holdReview.findings.length, 0)}
          tone={holdReview.findings.length > 0 ? "warning" : "success"}
          hint={t("holds.affectedUnits", { count: num(holdReview.affectedUnits, 0) })}
        />
        <StatTile
          label={t("holds.summaryRepairable")}
          value={num(holdReview.repairable.length, 0)}
          tone={holdReview.repairable.length > 0 ? "warning" : "neutral"}
          hint={t("holds.manualCount", { count: num(holdReview.needsPerson, 0) })}
        />
        <StatTile
          label={t("holds.oldestHold")}
          value={oldest === null ? "—" : num(oldest, 0)}
          tone={aging ? "warning" : "neutral"}
          hint={t("holds.summaryOldestHint")}
        />
      </div>
    </Card>
  );
}
