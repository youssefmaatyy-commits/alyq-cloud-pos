/**
 * Stock holds & reconciliation (Phase 15, extended).
 *
 * The website protects inventory by *holding* it: a pending order writes a
 * `reserved` row per tracked line, approving converts that hold into the POS
 * sale's own deduction, cancelling releases it, and availability everywhere in the
 * app is `stock_quantity − held`. When a transition misses its resolution the
 * hold sticks — units nobody can sell, with nothing on any screen to explain why.
 *
 * This is the screen that answers "what is the website holding, and is any of it
 * wrong?". Three layers, in the order somebody actually reads them:
 *
 *   · **Monitoring** — five counts (healthy, problems, old, missing, duplicate)
 *     that double as filters, so "how bad is it" and "show me that" are one click.
 *   · **Alerts** — the same review phrased as the problems that matter, shared
 *     with the sidebar badge and the online-orders banner, because a number that
 *     differs between two screens teaches staff to distrust both.
 *   · **Repair** — the table, its verdicts and the remedies.
 *
 * Reading is open to anybody who works the online queue (`manage_online_orders`,
 * gated in the route table). *Repairing* needs `adjust_stock`, because settling a
 * hold changes what the whole shop can promise to sell — the same consequence as
 * writing the stock ledger. The buttons are hidden without it, the service refuses
 * without it, and in live mode `public.repair_stock_reservation` refuses without
 * it. Findings where both directions would be a guess carry no button at all:
 * "needs a person" is a more useful answer than a confident wrong repair.
 *
 * The review itself comes from the queue provider rather than being recomputed
 * here, so this screen, the badge, the dashboard widget and the order queue are
 * all reading one pass over one set of rows — and when the queue is filtered, all
 * of them are told that some holds could not be judged instead of guessing.
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
import {
  DateRangePicker,
  toExportRange,
} from "@/modules/reports/components/DateRangePicker";
import { useOnlineOrders } from "../hooks/OnlineOrdersProvider";
import {
  AGING_HOLD_DAYS,
  EMPTY_RESERVATION_FILTERS,
  RESERVATION_ALERT_VERDICTS,
  RESERVATION_VERDICTS,
  activeReservationFilters,
  filterReservationRows,
  mayRepairReservations,
  repairAllFindings,
  repairFinding,
  reservationRowProducts,
  reviewReservations,
  type ReservationAlert,
  type ReservationFilters,
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
  duplicate_hold: "danger",
  quantity_mismatch: "warning",
  unexpected_hold: "warning",
  unresolved: "info",
};

/** "Gold / 17" from a row's frozen combination, or null for a product-level hold. */
function variantLabelOf(
  variant: NonNullable<ReservationReviewRow["variant"]>,
  pick: (ar: string | null, en: string | null) => string,
): string {
  const colour = pick(variant.colorAr, variant.colorEn);
  const size = variant.size !== null ? String(variant.size) : (variant.sizeLabel ?? "");
  return [colour, size].filter(Boolean).join(" / ");
}

const ORDER_STATUSES: OnlineOrder["status"][] = [
  "pending",
  "approved",
  "processing",
  "ready",
  "completed",
  "cancelled",
];

export function StockHoldsPage() {
  const { t, pick, num, date } = useI18n();
  const toast = useToast();
  const {
    loading,
    error,
    refresh,
    resetFilter,
    canManage,
    mode,
    reservations,
    orders,
    products: catalogue,
    holdReview: review,
    holdAlerts: alerts,
  } = useOnlineOrders();

  // Read gate: working the queue. Repair gate: the stock ledger's own capability.
  const mayRepair = mayRepairReservations();

  const [filters, setFilters] = useState<ReservationFilters>(EMPTY_RESERVATION_FILTERS);
  const [pending, setPending] = useState<ReservationReviewRow[] | null>(null);
  const [reason, setReason] = useState("");
  const [running, setRunning] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const rows = useMemo(() => filterReservationRows(review.rows, filters), [review.rows, filters]);
  const products = useMemo(() => reservationRowProducts(review.rows), [review.rows]);
  const activeFilters = activeReservationFilters(filters);
  const openHolds = useMemo(
    () => review.rows.filter((row) => row.status === "reserved").length,
    [review.rows],
  );

  const patch = (next: Partial<ReservationFilters>) =>
    setFilters((current) => ({ ...current, ...next }));

  /** A monitoring chip is a filter with a number on it — clicking narrows the table. */
  function showVerdict(verdict: ReservationVerdict | readonly ReservationVerdict[]) {
    setFilters({ ...EMPTY_RESERVATION_FILTERS, verdict, scope: "findings" });
  }

  function showAlert(alert: ReservationAlert) {
    if (alert.kind === "aging") {
      setFilters({ ...EMPTY_RESERVATION_FILTERS, scope: "all", minAgeDays: AGING_HOLD_DAYS });
      return;
    }
    // `aging` is an age rule over correct holds, so it narrows by age instead.
    setFilters({
      ...EMPTY_RESERVATION_FILTERS,
      verdict: RESERVATION_ALERT_VERDICTS[alert.kind],
      scope: "findings",
    });
  }

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
        // The batch works from a review of its own over the same rows, so it acts
        // on what the table is showing rather than on a filter's subset.
        const outcome = await repairAllFindings(
          // Re-reviewed from the loaded lists, not rebuilt out of the visible
          // rows: the batch has to judge what is really held, including anything
          // the current filter hides, or it would quietly leave rows behind.
          reviewReservations({
            reservations,
            orders,
            products: catalogue,
            ordersComplete: !review.partial,
          }),
          trimmed,
        );
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

  const monitor = [
    {
      id: "healthy",
      value: review.healthy,
      tone: "text-emerald-700",
      apply: () => setFilters({ ...EMPTY_RESERVATION_FILTERS, scope: "all", verdict: "valid" }),
      on: filters.verdict === "valid" && filters.scope === "all",
    },
    {
      id: "problems",
      value: review.findings.length,
      tone: review.findings.length > 0 ? "text-amber-700" : "text-slate-500",
      apply: () => setFilters({ ...EMPTY_RESERVATION_FILTERS, scope: "findings" }),
      on: filters.scope === "findings" && filters.verdict === "all" && activeFilters <= 1,
    },
    {
      id: "old",
      value: review.aging,
      tone: review.aging > 0 ? "text-amber-700" : "text-slate-500",
      apply: () =>
        setFilters({ ...EMPTY_RESERVATION_FILTERS, scope: "all", minAgeDays: AGING_HOLD_DAYS }),
      on: filters.minAgeDays !== null,
    },
    {
      id: "missing",
      value: review.byVerdict.missing_hold,
      tone: review.byVerdict.missing_hold > 0 ? "text-rose-700" : "text-slate-500",
      apply: () => showVerdict("missing_hold"),
      on: filters.verdict === "missing_hold",
    },
    {
      id: "duplicate",
      value: review.byVerdict.duplicate_hold,
      tone: review.byVerdict.duplicate_hold > 0 ? "text-rose-700" : "text-slate-500",
      apply: () => showVerdict("duplicate_hold"),
      on: filters.verdict === "duplicate_hold",
    },
  ] as const;

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
                title={review.repairable.length === 0 ? t("holds.nothingRepairable") : undefined}
              >
                {t("holds.repairAll", { count: review.repairable.length })}
              </Button>
            ) : null}
          </>
        }
      />

      {alerts.length > 0 ? (
        <Card className="mb-4 border-amber-300 bg-amber-50">
          <p className="mb-2 text-xs font-bold uppercase tracking-widest text-amber-900">
            {t("holds.alertsTitle")}
          </p>
          <ul className="space-y-2">
            {alerts.map((alert) => (
              <li key={alert.kind} className="flex flex-wrap items-center gap-2 text-xs">
                <Badge tone={alert.severity === "danger" ? "danger" : "warning"}>
                  {t(`holds.alert.${alert.kind}` as Parameters<typeof t>[0])}
                </Badge>
                <span className="font-semibold text-slate-800">
                  {t("holds.alert.detail", { count: alert.count, units: num(alert.units) })}
                </span>
                {alert.oldestDays !== null ? (
                  <span className="text-slate-600">
                    {t("holds.alert.oldest", { count: alert.oldestDays })}
                  </span>
                ) : null}
                {alert.orderNumbers.length > 0 ? (
                  <span className="font-mono text-[11px] text-slate-600">
                    {alert.orderNumbers.join(" · ")}
                  </span>
                ) : null}
                {!alert.repairable ? (
                  <span className="font-semibold text-rose-700">{t("holds.needsPerson")}</span>
                ) : null}
                <Button size="sm" variant="ghost" onClick={() => showAlert(alert)}>
                  {t("holds.alert.show")}
                </Button>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {review.partial && review.unjudged > 0 ? (
        <Card className="mb-4 border-slate-300 bg-slate-50">
          <div className="flex flex-wrap items-center gap-3">
            <p className="text-xs font-semibold text-slate-700">
              {t("holds.partialNotice", { count: review.unjudged })}
            </p>
            <Button size="sm" variant="secondary" onClick={() => resetFilter()}>
              {t("holds.partialAction")}
            </Button>
          </div>
        </Card>
      ) : null}

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
          value={num(review.needsPerson)}
          tone={review.needsPerson > 0 ? "danger" : "neutral"}
          hint={t("holds.manualHint")}
        />
        <StatTile
          label={t("holds.oldestHold")}
          value={review.oldestDays === null ? "—" : num(review.oldestDays)}
          tone={
            review.oldestDays === null
              ? "neutral"
              : review.oldestDays >= AGING_HOLD_DAYS
                ? "warning"
                : "neutral"
          }
          hint={t("holds.agingHint", { count: AGING_HOLD_DAYS })}
        />
      </div>

      {/* Monitoring: the five counts that answer "how bad is it", each one a
          filter, because the next question is always "show me". */}
      <Card className="mb-4">
        <div className="flex flex-wrap gap-2">
          {monitor.map((chip) => (
            <button
              key={chip.id}
              type="button"
              onClick={chip.apply}
              aria-pressed={chip.on}
              className={`flex min-w-28 flex-col items-start gap-0.5 rounded-xl border px-3 py-2 text-start transition ${
                chip.on
                  ? "border-indigo-400 bg-indigo-50"
                  : "border-slate-200 bg-white hover:border-slate-300"
              }`}
            >
              <span className="text-[10px] font-bold uppercase tracking-widest text-slate-500">
                {t(`holds.monitor.${chip.id}` as Parameters<typeof t>[0])}
              </span>
              <span className={`text-lg font-bold tabular-nums ${chip.tone}`}>{num(chip.value)}</span>
            </button>
          ))}
        </div>
        <p className="mt-3 text-sm leading-relaxed text-slate-600">{t("holds.explainer")}</p>
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
            <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
              <div className="w-full lg:max-w-xs">
                <TextInput
                  value={filters.search}
                  leading={<SearchIcon />}
                  onChange={(event) => patch({ search: event.target.value })}
                  placeholder={t("holds.searchPlaceholder")}
                  aria-label={t("common.search")}
                  type="search"
                />
              </div>
              <div className="w-full sm:w-48">
                <SelectInput
                  value={typeof filters.verdict === "string" ? filters.verdict : ""}
                  aria-label={t("holds.verdictFilter")}
                  onChange={(event) =>
                    patch({
                      verdict: event.target.value === "" ? "all" : (event.target.value as ReservationVerdict),
                    })
                  }
                >
                  {/* An empty value means "several verdicts at once", which is what
                      an alert's Show button sets — the option reads as such. */}
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
              <div className="w-full sm:w-44">
                <SelectInput
                  value={filters.orderStatus}
                  aria-label={t("holds.filter.orderStatus")}
                  onChange={(event) =>
                    patch({ orderStatus: event.target.value as ReservationFilters["orderStatus"] })
                  }
                >
                  <option value="all">{t("holds.filter.everyStatus")}</option>
                  {ORDER_STATUSES.map((status) => (
                    <option key={status} value={status}>
                      {t(`online.status.${status}` as Parameters<typeof t>[0])}
                    </option>
                  ))}
                  <option value="missing">{t("holds.orderMissing")}</option>
                </SelectInput>
              </div>
              <div className="w-full sm:w-52">
                <SelectInput
                  value={filters.productId}
                  aria-label={t("holds.filter.product")}
                  onChange={(event) => patch({ productId: event.target.value })}
                >
                  <option value="all">{t("holds.filter.everyProduct")}</option>
                  {products.map((product) => (
                    <option key={product.id} value={product.id}>
                      {product.label}
                    </option>
                  ))}
                </SelectInput>
              </div>
              <div className="w-full sm:w-44">
                <SelectInput
                  value={filters.scope}
                  aria-label={t("holds.scopeFilter")}
                  onChange={(event) => patch({ scope: event.target.value as ReservationFilters["scope"] })}
                >
                  <option value="findings">{t("holds.onlyFindings")}</option>
                  <option value="all">{t("holds.everyHold")}</option>
                </SelectInput>
              </div>
              <div className="flex items-center gap-2 sm:ms-auto">
                <p className="text-xs font-semibold text-slate-600">
                  {t("holds.resultCount", { count: num(rows.length, 0) })}
                </p>
                {activeFilters > 0 ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setFilters(EMPTY_RESERVATION_FILTERS)}
                  >
                    {t("holds.filter.clear", { count: activeFilters })}
                  </Button>
                ) : null}
              </div>
            </div>

            {/* The hold's own creation day, inclusive — the question is usually
                "what has been sitting there since the weekend". */}
            <div className="mt-3 border-t border-slate-100 pt-3">
              <DateRangePicker
                value={{ from: filters.from ?? "", to: filters.to ?? "" }}
                onChange={(next) => {
                  // The picker speaks "" for "no bound"; the review speaks null.
                  const range = toExportRange(next);
                  patch({ from: range.from, to: range.to });
                }}
              />
            </div>
          </Card>

          {rows.length === 0 ? (
            <Card>
              <EmptyState
                icon="📦"
                title={
                  activeFilters > 0
                    ? t("holds.noMatch")
                    : review.findings.length === 0
                      ? t("holds.allClear")
                      : t("holds.noMatch")
                }
                description={
                  activeFilters > 0
                    ? t("holds.noMatchHint")
                    : review.findings.length === 0
                      ? t("holds.allClearHint")
                      : t("holds.noMatchHint")
                }
                action={
                  activeFilters > 0 ? (
                    <Button variant="secondary" onClick={() => setFilters(EMPTY_RESERVATION_FILTERS)}>
                      {t("holds.filter.clearAll")}
                    </Button>
                  ) : (
                    <Link to="/online/orders">
                      <Button variant="secondary">{t("online.orders.title")}</Button>
                    </Link>
                  )
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
                        {row.variant ? (
                          <p
                            className="text-[11px] font-semibold text-indigo-600"
                            data-testid={`hold-variant-${row.key}`}
                          >
                            {variantLabelOf(row.variant, pick)}
                          </p>
                        ) : null}
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
                  {row.orderNumber} ·{" "}
                  {row.product ? pick(row.product.nameAr, row.product.nameEn) : "—"}
                  {row.variant ? ` · ${variantLabelOf(row.variant, pick)}` : ""}
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
