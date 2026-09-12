/**
 * Stock holds & reconciliation (Phase 15).
 *
 * The website protects inventory by *holding* it: a pending order writes a
 * `reserved` row per tracked line, approving converts that hold into the POS
 * sale's deduction, cancelling releases it, and availability everywhere in the
 * app is `stock_quantity − held`. When a transition misses its resolution the
 * hold sticks — units nobody can sell, with nothing on any screen to explain why.
 *
 * This is the screen that answers "what is the website holding, and is any of it
 * wrong?". It has two halves and they are deliberately different in kind:
 *
 *   · **Reading** is open to anybody who works the online queue
 *     (`manage_online_orders`, the same capability the orders screen needs — the
 *     route table gates the path). Every hold is listed with its order, its
 *     product, its quantity, its age and a verdict.
 *   · **Repairing** needs `adjust_stock`, because settling a hold changes what the
 *     whole shop can promise to sell — the same consequence as writing the stock
 *     ledger. The buttons are hidden without it, the service refuses without it,
 *     and in live mode `public.repair_stock_reservation` refuses without it.
 *
 * What a repair does *not* do is move stock. By the time a hold is wrong the
 * order's transition has already had its effect on the shelf, so the repair
 * settles the hold's own row and writes one audit entry — anything else would be
 * the double-count the reservation model exists to prevent. Findings where both
 * directions would be a guess are listed with no button at all, because "needs a
 * person" is a more useful answer than a confident wrong repair.
 */
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { PageHeader } from "@/components/layout/AppShell";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  LoadingBlock,
  Modal,
  SearchIcon,
  SelectInput,
  StatTile,
  TextArea,
  TextInput,
  useToast,
} from "@/components/ui";
import { useOnlineOrders } from "../hooks/OnlineOrdersProvider";
import {
  AGING_HOLD_DAYS,
  RESERVATION_VERDICTS,
  mayRepairReservations,
  repairAllFindings,
  repairFinding,
  reviewReservations,
  type ReservationReviewRow,
  type ReservationVerdict,
} from "../services/reservationRepair";
import type { OnlineOrder } from "../types";

const ORDER_TONE: Record<OnlineOrder["status"], "neutral" | "success" | "danger" | "info" | "warning"> = {
  pending: "warning",
  approved: "info",
  processing: "info",
  ready: "success",
  completed: "success",
  cancelled: "danger",
};

const VERDICT_TONE: Record<ReservationVerdict, "neutral" | "success" | "danger" | "info" | "warning"> = {
  valid: "success",
  stale: "danger",
  orphaned: "danger",
  missing_hold: "danger",
  inconsistent: "danger",
  quantity_mismatch: "warning",
  unexpected_hold: "warning",
  unresolved: "info",
};

export function StockHoldsPage() {
  const { t, pick, num, date } = useI18n();
  const toast = useToast();
  const { orders, reservations, products, loading, error, refresh, canManage, mode } =
    useOnlineOrders();

  // Read gate: working the queue. Repair gate: the stock ledger's own capability.
  const mayRepair = mayRepairReservations();

  const [onlyFindings, setOnlyFindings] = useState(true);
  const [verdict, setVerdict] = useState<ReservationVerdict | "all">("all");
  const [search, setSearch] = useState("");
  const [pending, setPending] = useState<ReservationReviewRow[] | null>(null);
  const [reason, setReason] = useState("");
  const [running, setRunning] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const review = useMemo(
    () => reviewReservations({ reservations, orders, products }),
    [reservations, orders, products],
  );

  const rows = useMemo(() => {
    const term = search.trim().toLowerCase();
    return review.rows.filter((row) => {
      if (onlyFindings && row.verdict === "valid") return false;
      if (verdict !== "all" && row.verdict !== verdict) return false;
      if (!term) return true;
      const haystack = `${row.orderNumber} ${row.product?.sku ?? ""} ${row.product?.nameEn ?? ""} ${row.product?.nameAr ?? ""}`.toLowerCase();
      return haystack.includes(term);
    });
  }, [review.rows, onlyFindings, verdict, search]);

  const openHolds = useMemo(
    () => reservations.filter((reservation) => reservation.status === "reserved").length,
    [reservations],
  );

  async function run(target: ReservationReviewRow[]) {
    const trimmed = reason.trim();
    if (target.length === 0 || !trimmed) return;
    setRunning(true);
    setActionError(null);
    try {
      if (target.length === 1) {
        const result = await repairFinding(target[0], trimmed);
        toast.success(
          result.alreadyResolved
            ? t("holds.alreadySettled", { order: target[0].orderNumber })
            : t("holds.repairedOne", { order: target[0].orderNumber }),
        );
      } else {
        const outcome = await repairAllFindings(review, trimmed);
        const parts = [
          outcome.repaired.length > 0 ? t("holds.repairedCount", { count: outcome.repaired.length }) : null,
          outcome.skipped.length > 0 ? t("holds.skippedCount", { count: outcome.skipped.length }) : null,
          outcome.manual.length > 0 ? t("holds.manualCount", { count: outcome.manual.length }) : null,
          outcome.failed.length > 0 ? t("holds.failedCount", { count: outcome.failed.length }) : null,
        ].filter(Boolean);
        const message = parts.length > 0 ? parts.join(" · ") : t("holds.nothingToDo");
        if (outcome.failed.length > 0) {
          // The first refusal is the one worth reading; the audit trail has the rest.
          toast.error(`${message} — ${outcome.failed[0].message}`);
        } else {
          toast.success(message);
        }
      }
      setPending(null);
      setReason("");
      // Availability is derived from these rows, so the providers re-read them and
      // every screen that shows "held" or "available" updates in the same tick.
      await refresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  }

  if (!canManage) {
    return (
      <div>
        <PageHeader title={t("holds.title")} subtitle={t("holds.subtitle")} />
        <Card>
          <p className="text-sm font-medium text-slate-700">{t("holds.noQueueAccess")}</p>
        </Card>
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title={t("holds.title")}
        subtitle={t("holds.subtitle")}
        actions={
          <>
            <Badge tone={mode === "supabase" ? "success" : "warning"}>
              {mode === "supabase" ? t("mode.live") : t("mode.demo")}
            </Badge>
            <Button variant="secondary" onClick={() => void refresh()} title={t("common.refresh")}>
              ⟳
            </Button>
            {mayRepair ? (
              <Button
                onClick={() => {
                  setActionError(null);
                  setPending(review.repairable);
                }}
                disabled={review.repairable.length === 0}
                title={
                  review.repairable.length === 0 ? t("holds.nothingRepairable") : undefined
                }
              >
                {t("holds.repairAll", { count: review.repairable.length })}
              </Button>
            ) : null}
          </>
        }
      />

      <div className="mb-4 grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        <StatTile
          label={t("holds.unitsHeld")}
          value={num(review.heldUnits)}
          tone="primary"
          hint={t("holds.openHoldsCount", { count: openHolds })}
        />
        <StatTile
          label={t("holds.findings")}
          value={num(review.findings.length)}
          tone={review.findings.length > 0 ? "warning" : "success"}
          hint={t("holds.affectedUnits", { count: review.affectedUnits })}
        />
        <StatTile
          label={t("holds.manual")}
          value={num(review.findings.length - review.repairable.length)}
          tone={review.findings.length > review.repairable.length ? "danger" : "neutral"}
          hint={t("holds.manualHint")}
        />
        <StatTile
          label={t("holds.aging")}
          value={num(review.aging)}
          tone={review.aging > 0 ? "warning" : "neutral"}
          hint={t("holds.agingHint", { count: AGING_HOLD_DAYS })}
        />
      </div>

      <Card className="mb-4">
        <p className="text-sm leading-relaxed text-slate-600">{t("holds.explainer")}</p>
        <p className="mt-2 text-xs font-semibold leading-relaxed text-slate-700">
          {t("holds.neverStock")}
        </p>
        {!mayRepair ? (
          <p className="mt-2 text-xs font-medium text-slate-500">{t("holds.readOnly")}</p>
        ) : null}
      </Card>

      {error ? (
        <ErrorState
          title={t("common.error")}
          message={t(`online.error.${error.code}`)}
          retryLabel={t("common.retry")}
          onRetry={() => void refresh()}
        />
      ) : loading ? (
        <div className="alyq-card">
          <LoadingBlock label={t("common.loading")} />
        </div>
      ) : (
        <>
          <Card className="mb-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
              <div className="w-full sm:max-w-md">
                <TextInput
                  value={search}
                  leading={<SearchIcon />}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder={t("holds.searchPlaceholder")}
                  aria-label={t("common.search")}
                  type="search"
                />
              </div>
              <div className="w-full sm:w-56">
                <SelectInput
                  value={verdict}
                  aria-label={t("holds.verdictFilter")}
                  onChange={(event) =>
                    setVerdict(event.target.value as ReservationVerdict | "all")
                  }
                >
                  <option value="all">{t("holds.everyVerdict")}</option>
                  {RESERVATION_VERDICTS.filter((candidate) => candidate !== "valid").map(
                    (candidate) => (
                      <option key={candidate} value={candidate}>
                        {t(`holds.verdict.${candidate}` as Parameters<typeof t>[0])}
                      </option>
                    ),
                  )}
                </SelectInput>
              </div>
              <div className="w-full sm:w-56">
                <SelectInput
                  value={onlyFindings ? "findings" : "all"}
                  aria-label={t("holds.scopeFilter")}
                  onChange={(event) => setOnlyFindings(event.target.value === "findings")}
                >
                  <option value="findings">{t("holds.onlyFindings")}</option>
                  <option value="all">{t("holds.everyHold")}</option>
                </SelectInput>
              </div>
              <p className="text-xs font-semibold text-slate-600 sm:ms-auto">
                {t("holds.resultCount", { count: num(rows.length, 0) })}
              </p>
            </div>
          </Card>

          {rows.length === 0 ? (
            <Card>
              <EmptyState
                icon="📦"
                title={review.findings.length === 0 ? t("holds.allClear") : t("holds.noMatch")}
                description={
                  review.findings.length === 0 ? t("holds.allClearHint") : t("holds.noMatchHint")
                }
                action={
                  <Link to="/online/orders">
                    <Button variant="secondary">{t("online.orders.title")}</Button>
                  </Link>
                }
              />
            </Card>
          ) : (
            <div className="alyq-card overflow-x-auto">
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50 text-start text-[11px] font-bold uppercase tracking-wider text-slate-600">
                    <th className="px-3 py-2 text-start">{t("holds.colOrder")}</th>
                    <th className="px-3 py-2 text-start">{t("holds.colProduct")}</th>
                    <th className="px-3 py-2 text-end">{t("holds.colHeld")}</th>
                    <th className="px-3 py-2 text-end">{t("holds.colExpected")}</th>
                    <th className="px-3 py-2 text-start">{t("holds.colStatus")}</th>
                    <th className="px-3 py-2 text-start">{t("holds.colCreated")}</th>
                    <th className="px-3 py-2 text-start">{t("holds.colVerdict")}</th>
                    <th className="px-3 py-2 text-end">{t("holds.colAction")}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.key} className="border-b border-slate-100 last:border-0">
                      <td className="px-3 py-2.5">
                        <p className="font-semibold text-slate-900">{row.orderNumber}</p>
                        {row.order ? (
                          <Badge tone={ORDER_TONE[row.order.status]}>
                            {t(`online.status.${row.order.status}` as Parameters<typeof t>[0])}
                          </Badge>
                        ) : (
                          <Badge tone="danger">{t("holds.orderMissing")}</Badge>
                        )}
                      </td>
                      <td className="px-3 py-2.5">
                        <p className="font-medium text-slate-900">
                          {row.product ? pick(row.product.nameAr, row.product.nameEn) : "—"}
                        </p>
                        <p className="text-[11px] text-slate-500">{row.product?.sku ?? "—"}</p>
                      </td>
                      <td className="px-3 py-2.5 text-end font-bold tabular-nums text-slate-900">
                        {row.status === "missing" ? "—" : num(row.held)}
                      </td>
                      <td className="px-3 py-2.5 text-end tabular-nums text-slate-600">
                        {row.expected > 0 ? num(row.expected) : "—"}
                      </td>
                      <td className="px-3 py-2.5">
                        <Badge tone={row.status === "reserved" ? "warning" : "neutral"}>
                          {t(`holds.status.${row.status}` as Parameters<typeof t>[0])}
                        </Badge>
                        {row.resolvedAt ? (
                          <p className="mt-0.5 text-[11px] text-slate-500">{date(row.resolvedAt)}</p>
                        ) : null}
                      </td>
                      <td className="px-3 py-2.5">
                        <p className="text-xs text-slate-700">
                          {row.createdAt ? date(row.createdAt) : "—"}
                        </p>
                        {row.ageDays !== null ? (
                          <p
                            className={`text-[11px] font-semibold ${
                              row.ageDays >= AGING_HOLD_DAYS ? "text-amber-700" : "text-slate-500"
                            }`}
                          >
                            {t("holds.ageDays", { count: row.ageDays })}
                          </p>
                        ) : null}
                      </td>
                      <td className="max-w-xs px-3 py-2.5">
                        <Badge tone={VERDICT_TONE[row.verdict]}>
                          {t(`holds.verdict.${row.verdict}` as Parameters<typeof t>[0])}
                        </Badge>
                        <p className="mt-1 text-[11px] leading-relaxed text-slate-600">
                          {t(`holds.explain.${row.verdict}` as Parameters<typeof t>[0])}
                        </p>
                      </td>
                      <td className="px-3 py-2.5 text-end">
                        {row.action && mayRepair ? (
                          <Button
                            size="sm"
                            variant={row.severity === "danger" ? "danger" : "secondary"}
                            onClick={() => {
                              setActionError(null);
                              setPending([row]);
                            }}
                          >
                            {t(`holds.action.${row.action}` as Parameters<typeof t>[0])}
                          </Button>
                        ) : row.action ? (
                          <span className="text-[11px] font-medium text-slate-500">
                            {t("holds.readOnly")}
                          </span>
                        ) : (
                          <span className="text-[11px] font-semibold text-rose-700">
                            {t("holds.needsPerson")}
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {/* One reason covers the whole batch: an operator repairing twelve holds
          left by one interrupted deployment writes why once, and every audit row
          carries it. */}
      <Modal
        open={pending !== null}
        onClose={() => (running ? undefined : setPending(null))}
        size="sm"
        title={
          pending && pending.length > 1
            ? t("holds.repairAllTitle", { count: pending.length })
            : t("holds.repairOneTitle")
        }
        footer={
          <>
            <Button variant="secondary" onClick={() => setPending(null)} disabled={running}>
              {t("common.cancel")}
            </Button>
            <Button
              variant="danger"
              loading={running}
              disabled={!reason.trim() || (pending?.length ?? 0) === 0}
              onClick={() => pending && void run(pending)}
            >
              {t("holds.confirmRepair")}
            </Button>
          </>
        }
      >
        <p className="text-sm leading-relaxed text-slate-600">{t("holds.repairPrompt")}</p>
        {pending && pending.length > 0 ? (
          <ul className="mt-3 max-h-40 space-y-1 overflow-y-auto rounded-xl bg-slate-50 p-3 text-xs text-slate-700">
            {pending.slice(0, 12).map((row) => (
              <li key={row.key} className="flex items-center justify-between gap-2">
                <span className="truncate">
                  {row.orderNumber} · {row.product ? pick(row.product.nameAr, row.product.nameEn) : "—"}
                </span>
                <span className="shrink-0 font-semibold">
                  {t(`holds.action.${row.action ?? "release"}` as Parameters<typeof t>[0])}
                  {row.unitsFreed > 0 ? ` · ${num(row.unitsFreed)}` : ""}
                </span>
              </li>
            ))}
            {pending.length > 12 ? (
              <li className="font-semibold text-slate-500">
                {t("holds.andMore", { count: pending.length - 12 })}
              </li>
            ) : null}
          </ul>
        ) : null}
        <TextArea
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          className="mt-3"
          rows={3}
          placeholder={t("online.orders.reasonPlaceholder")}
          aria-label={t("online.orders.reasonLabel")}
        />
        <p className="mt-2 text-[11px] leading-relaxed text-slate-500">{t("holds.repairConsequence")}</p>
        {actionError ? (
          <p className="mt-2 text-xs font-semibold text-rose-700">{actionError}</p>
        ) : null}
      </Modal>
    </div>
  );
}
