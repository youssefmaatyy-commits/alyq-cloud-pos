/**
 * Online Orders — the POS queue for website sales.
 *
 * This is the screen that makes the website part of the shop rather than a
 * separate thing somebody has to remember to check. A pending order here is a
 * customer waiting and stock being held; approving it is what creates the sale,
 * deducts the inventory and stamps the source as the website, so the till, the
 * stock report and the online report all describe the same event.
 *
 * The list is filtered server-side (status, payment status, search, dates) and
 * the counts above it come from the same query the sidebar badge uses, so the
 * number on the badge and the number of rows here cannot disagree.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { PageHeader } from "@/components/layout/AppShell";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  ExportButton,
  EyeIcon,
  LoadingBlock,
  SearchIcon,
  SelectInput,
  SegmentedTabs,
  StatTile,
  TextInput,
  ToggleSwitch,
} from "@/components/ui";
import { useOnlineOrders } from "../hooks/OnlineOrdersProvider";
import { POLL_CHOICES, SAFETY_NET_POLL_MS } from "../hooks/useOnlineNotifications";
import { useOnlineNotificationState } from "../hooks/OnlineNotificationsProvider";
import { OrderDetailModal } from "../components/OrderDetailModal";
import { buildOnlineOrderSheets } from "../services/onlineOrdersExport";
import { ONLINE_ORDER_STATUSES, ONLINE_PAYMENT_STATUSES, type OnlineOrder, type OnlineOrderStatus, type OnlinePaymentStatus } from "../types";
import type { OnlineOrderFilter } from "../data/repository";
import { variantLabelOf } from "../services/variantLabel";

const STATUS_TONE: Record<OnlineOrder["status"], "neutral" | "success" | "danger" | "info" | "warning"> = {
  pending: "warning",
  approved: "info",
  processing: "info",
  ready: "success",
  completed: "success",
  cancelled: "danger",
};

const PAYMENT_TONE: Record<OnlineOrder["payment_status"], "neutral" | "success" | "danger" | "info" | "warning"> = {
  pending: "neutral",
  paid: "success",
  failed: "danger",
  verification_required: "warning",
};

export function OnlineOrdersPage() {
  const { t, pick, num, date, money, lang } = useI18n();
  const {
    orders,
    loading,
    error,
    filter,
    setFilter,
    resetFilter,
    counts,
    refresh,
    selected,
    select,
    canManage,
    mode,
  } = useOnlineOrders();

  // The shell's single poller, so the banner here and the number in the sidebar
  // are one reading rather than two that can disagree.
  const notifications = useOnlineNotificationState();

  const [statusDraft, setStatusDraft] = useState(filter.status);
  const [paymentDraft, setPaymentDraft] = useState(filter.paymentStatus);
  const [searchDraft, setSearchDraft] = useState(filter.search);

  // Phase 46: the dashboard (and the shell's notifications) route here with the
  // filter in the URL (`?status=pending`, `?payment=verification_required`,
  // `?search=WEB-…`). The params hydrate the filter once, then leave the URL so
  // a manual reload is a clean screen rather than a silently re-filtered one.
  // Unknown values are ignored — a hand-typed URL must not invent a state.
  const [params, setParams] = useSearchParams();
  const hydrated = useRef(false);
  useEffect(() => {
    if (hydrated.current) return;
    hydrated.current = true;
    const status = params.get("status");
    const payment = params.get("payment");
    const search = params.get("search");
    const patch: Partial<OnlineOrderFilter> = {};
    if (status && (ONLINE_ORDER_STATUSES as readonly string[]).includes(status)) {
      patch.status = status as OnlineOrderStatus;
      setStatusDraft(status as OnlineOrderStatus);
    }
    if (payment && (ONLINE_PAYMENT_STATUSES as readonly string[]).includes(payment)) {
      patch.paymentStatus = payment as OnlinePaymentStatus;
      setPaymentDraft(payment as OnlinePaymentStatus);
    }
    if (search) {
      patch.search = search;
      setSearchDraft(search);
    }
    if (Object.keys(patch).length > 0) {
      setFilter(patch);
      setParams({}, { replace: true });
    }
    // Once, on mount: the provider's own filter state is the source afterwards.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const activeFilters = useMemo(
    () =>
      [
        filter.status !== "all" ? 1 : 0,
        filter.paymentStatus !== "all" ? 1 : 0,
        filter.search.trim() ? 1 : 0,
        filter.from ? 1 : 0,
        filter.to ? 1 : 0,
      ].reduce((sum, value) => sum + value, 0),
    [filter],
  );

  const inProgress = counts.approved + counts.processing + counts.ready;

  if (!canManage) {
    return (
      <div>
        <PageHeader title={t("online.orders.title")} subtitle={t("online.orders.subtitle")} />
        <Card>
          <EmptyState icon="🔒" title={t("online.orders.noAccess")} description={t("online.orders.noAccessHint")} />
        </Card>
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title={t("online.orders.title")}
        subtitle={t("online.orders.subtitle")}
        actions={
          <>
            <ExportButton
              name="online-orders"
              count={orders.length}
              build={() => buildOnlineOrderSheets({ orders, t, pick })}
            />
            <Button variant="secondary" onClick={() => void refresh()} title={t("common.retry")}>
              ⟳
            </Button>
            <Link to="/online/reservations">
              <Button variant="secondary">{t("nav.stockHolds")}</Button>
            </Link>
          </>
        }
      />

      {notifications.newOrderNumbers.length > 0 ? (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-amber-300 bg-amber-50 px-4 py-3">
          <p className="text-sm font-bold text-amber-900">
            {t("online.orders.newArrivals", { count: notifications.newOrderNumbers.length })}
            <span className="ms-2 font-mono text-xs font-semibold text-amber-800" dir="ltr">
              {notifications.newOrderNumbers.slice(0, 4).join(" · ")}
            </span>
          </p>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                notifications.acknowledge();
                void refresh();
              }}
            >
              {t("online.orders.showNew")}
            </Button>
            <Button size="sm" variant="ghost" onClick={notifications.acknowledge}>
              {t("common.dismiss")}
            </Button>
          </div>
        </div>
      ) : null}

      {/* Stock-hold problems, from the same review the holds screen shows. They
          belong here too: approving an order is what settles its hold, so this is
          where an operator can act on "this one has been stuck for six days". */}
      {notifications.holdAlerts.length > 0 ? (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-bold text-rose-900">{t("holds.alertsTitle")}</p>
            {notifications.holdAlerts.map((alert) => (
              <Badge key={alert.kind} tone={alert.severity === "danger" ? "danger" : "warning"}>
                {t(`holds.alert.${alert.kind}` as Parameters<typeof t>[0])}
                <span className="ms-1 font-mono tabular-nums">{num(alert.count, 0)}</span>
              </Badge>
            ))}
          </div>
          <Link to="/online/reservations">
            <Button size="sm" variant="secondary">
              {t("nav.stockHolds")}
            </Button>
          </Link>
        </div>
      ) : null}

      <div className="mb-4 grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        <StatTile
          label={t("online.status.pending")}
          value={num(counts.pending, 0)}
          tone="warning"
          hint={t("online.orders.pendingHint")}
        />
        <StatTile
          label={t("online.orders.needsPayment")}
          value={num(counts.needs_payment, 0)}
          tone="info"
          hint={t("online.orders.needsPaymentHint")}
        />
        <StatTile
          label={t("online.orders.inProgress")}
          value={num(inProgress, 0)}
          tone="primary"
          hint={t("online.orders.cancelledCount", { count: num(counts.cancelled, 0) })}
        />
        <StatTile
          label={t("online.orders.openValue")}
          value={money(counts.open_value)}
          tone="success"
          hint={t("online.orders.completedCount", { count: num(counts.completed, 0) })}
        />
      </div>

      <Card className="mb-4 space-y-3">
        {/* Phase 46: the lifecycle as tabs — the queue's main axis is a click,
            not a dropdown. Same filter, same server-side query. */}
        <SegmentedTabs<OnlineOrderStatus | "all">
          ariaLabel={t("online.orders.filterStatus")}
          testId="orders-tabs"
          value={statusDraft}
          onChange={(key) => {
            setStatusDraft(key);
            setFilter({ status: key });
          }}
          tabs={[
            { key: "all", label: t("online.orders.allStatuses") },
            {
              key: "pending",
              label: t("online.status.pending"),
              count: counts.pending,
              tone: "warning",
            },
            { key: "approved", label: t("online.status.approved") },
            { key: "processing", label: t("online.status.processing") },
            { key: "ready", label: t("online.status.ready") },
            { key: "completed", label: t("online.status.completed"), tone: "success" },
            { key: "cancelled", label: t("online.status.cancelled"), tone: "danger" },
          ]}
        />
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <TextInput
            value={searchDraft}
            leading={<SearchIcon />}
            onChange={(event) => setSearchDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") setFilter({ search: searchDraft });
            }}
            onBlur={() => setFilter({ search: searchDraft })}
            placeholder={t("online.orders.searchPlaceholder")}
            aria-label={t("common.search")}
            type="search"
          />
          <SelectInput
            value={statusDraft}
            onChange={(event) => {
              const next = event.target.value as typeof statusDraft;
              setStatusDraft(next);
              setFilter({ status: next });
            }}
            aria-label={t("online.orders.filterStatus")}
          >
            <option value="all">{t("online.orders.allStatuses")}</option>
            {ONLINE_ORDER_STATUSES.map((status) => (
              <option key={status} value={status}>
                {t(`online.status.${status}`)}
              </option>
            ))}
          </SelectInput>
          <SelectInput
            value={paymentDraft}
            onChange={(event) => {
              const next = event.target.value as typeof paymentDraft;
              setPaymentDraft(next);
              setFilter({ paymentStatus: next });
            }}
            aria-label={t("online.orders.filterPayment")}
          >
            <option value="all">{t("online.orders.allPayments")}</option>
            {ONLINE_PAYMENT_STATUSES.map((status) => (
              <option key={status} value={status}>
                {t(`online.paymentStatus.${status}`)}
              </option>
            ))}
          </SelectInput>
          <div className="flex items-center gap-2">
            <TextInput
              type="date"
              value={filter.from ?? ""}
              onChange={(event) => setFilter({ from: event.target.value || null })}
              aria-label={t("online.orders.fromDate")}
            />
            <TextInput
              type="date"
              value={filter.to ?? ""}
              onChange={(event) => setFilter({ to: event.target.value || null })}
              aria-label={t("online.orders.toDate")}
            />
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs font-semibold text-stone-600">
            {t("online.orders.resultCount", { count: num(orders.length, 0) })}
            {activeFilters > 0 ? ` · ${t("online.orders.activeFilters", { count: activeFilters })}` : ""}
            {mode === "demo" ? ` · ${t("online.orders.demoMode")}` : ""}
          </p>
          <div className="flex flex-wrap items-center gap-3">
            {/* How fresh this screen is. A badge that claims "live" over a dead
                socket is worse than no badge, so it reports the channel's own
                state: subscribed, still polling, or polling because the channel
                was refused. */}
            <Badge
              tone={
                notifications.transport === "realtime"
                  ? "success"
                  : notifications.transport === "error" ||
                      notifications.transport === "reconnecting"
                    ? "warning"
                    : "neutral"
              }
            >
              {notifications.transport === "realtime"
                ? t("online.notifications.transport.realtime", {
                    count: Math.round(SAFETY_NET_POLL_MS / 60_000),
                  })
                : t(`online.notifications.transport.${notifications.transport}` as Parameters<typeof t>[0], {
                    count: Math.round(notifications.prefs.pollMs / 1000),
                  })}
            </Badge>
            {activeFilters > 0 ? (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  resetFilter();
                  setStatusDraft("all");
                  setPaymentDraft("all");
                  setSearchDraft("");
                }}
              >
                {t("online.orders.clearFilters")}
              </Button>
            ) : null}
            <div className="w-56">
              <ToggleSwitch
                checked={notifications.prefs.sound}
                onChange={(checked) => notifications.setPrefs({ sound: checked })}
                label={t("online.notifications.sound")}
                hint={t("online.notifications.soundHint")}
              />
            </div>
            <SelectInput
              value={String(notifications.prefs.pollMs)}
              onChange={(event) =>
                notifications.setPrefs({ pollMs: Number(event.target.value) })
              }
              aria-label={t("online.notifications.interval")}
              className="h-9 w-40 text-xs"
            >
              {POLL_CHOICES.map((choice) => (
                <option key={choice} value={String(choice)}>
                  {t("online.notifications.everySeconds", { count: Math.round(choice / 1000) })}
                </option>
              ))}
            </SelectInput>
          </div>
        </div>
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
      ) : orders.length === 0 ? (
        <Card>
          <EmptyState
            icon="🛒"
            title={t("online.orders.empty")}
            description={activeFilters > 0 ? t("online.orders.emptyFiltered") : t("online.orders.emptyHint")}
            action={
              <Button variant="secondary" onClick={() => void refresh()}>
                ⟳ {t("common.refresh")}
              </Button>
            }
          />
        </Card>
      ) : (
        <>
          {/* desktop */}
          <div className="alyq-card hidden overflow-x-auto md:block">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-stone-200 bg-stone-50 text-[11px] font-bold uppercase tracking-wider text-stone-600">
                  <th className="px-4 py-3 text-start font-semibold">{t("export.col.orderNumber")}</th>
                  <th className="px-3 py-3 text-start font-semibold">{t("export.col.customer")}</th>
                  <th className="px-3 py-3 text-start font-semibold">{t("pos.cols.date")}</th>
                  <th className="px-3 py-3 text-end font-semibold">{t("export.col.itemsCount")}</th>
                  <th className="px-3 py-3 text-end font-semibold">{t("export.col.total")}</th>
                  <th className="px-3 py-3 text-start font-semibold">{t("export.col.paymentMethod")}</th>
                  <th className="px-3 py-3 text-start font-semibold">{t("export.col.status")}</th>
                  <th className="px-3 py-3 text-start font-semibold">{t("export.col.paymentStatus")}</th>
                  <th className="px-4 py-3 text-end font-semibold">{t("common.actions")}</th>
                </tr>
              </thead>
              <tbody>
                {orders.map((order) => (
                  <tr
                    key={order.id}
                    className="border-b border-stone-50 transition-colors last:border-0 hover:bg-slate-50/60"
                  >
                    <td className="px-4 py-3">
                      <button
                        type="button"
                        onClick={() => void select(order.id)}
                        className="font-mono text-xs font-bold text-[#9a7a49] hover:underline"
                        dir="ltr"
                      >
                        {order.order_number}
                      </button>
                      {order.sale_number ? (
                        <span className="ms-2 text-[10px] font-semibold text-stone-500" dir="ltr">
                          {order.sale_number}
                        </span>
                      ) : null}
                    </td>
                    <td className="px-3 py-3 text-xs text-stone-700">
                      {order.customer_name}
                      <span className="block text-[11px] text-stone-500" dir="ltr">
                        {order.customer_phone}
                      </span>
                    </td>
                    <td className="px-3 py-3 text-xs text-stone-500" dir="ltr">
                      {date(order.created_at)}
                    </td>
                    <td className="px-3 py-3 text-end text-xs tabular-nums">
                      {num(order.items.reduce((sum, item) => sum + item.quantity, 0), 0)}
                      {/* Phase 43: the queue names the shelf without a click —
                          the same frozen snapshot the detail modal reads. */}
                      {order.items.some((item) => item.variant_id) ? (
                        <span className="mt-0.5 block text-[10px] font-semibold text-[#b08d57]" dir="ltr">
                          {order.items
                            .filter((item) => item.variant_id)
                            .map(
                              (item) =>
                                `${item.quantity} × ${variantLabelOf(
                                  {
                                    color_ar: item.variant_color_ar,
                                    color_en: item.variant_color_en,
                                    size: item.variant_size,
                                    size_label: item.variant_size_label,
                                  },
                                  lang,
                                )}`,
                            )
                            .join(", ")}
                        </span>
                      ) : null}
                    </td>
                    <td className="px-3 py-3 text-end text-sm font-bold tabular-nums text-stone-900">
                      {money(order.total)}
                    </td>
                    <td className="px-3 py-3 text-xs">
                      <Badge tone={order.payment_method === "instapay" ? "info" : "neutral"}>
                        {t(`online.paymentMethod.${order.payment_method}`)}
                      </Badge>
                      <span className="mt-1 block text-[10px] font-semibold text-stone-500">
                        {t(`online.deliveryType.${order.delivery_type}`)}
                      </span>
                    </td>
                    <td className="px-3 py-3 text-xs">
                      <Badge tone={STATUS_TONE[order.status]}>{t(`online.status.${order.status}`)}</Badge>
                    </td>
                    <td className="px-3 py-3 text-xs">
                      <Badge tone={PAYMENT_TONE[order.payment_status]}>
                        {t(`online.paymentStatus.${order.payment_status}`)}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 text-end">
                      <button
                        type="button"
                        onClick={() => void select(order.id)}
                        className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-stone-600 hover:bg-stone-100"
                        title={t("common.view")}
                        aria-label={t("common.view")}
                      >
                        <EyeIcon />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* mobile */}
          <div className="space-y-3 md:hidden">
            {orders.map((order) => (
              <button
                key={order.id}
                type="button"
                onClick={() => void select(order.id)}
                className="alyq-card w-full space-y-2 p-4 text-start"
              >
                <div className="flex items-start justify-between gap-2">
                  <span className="font-mono text-xs font-bold text-[#9a7a49]" dir="ltr">
                    {order.order_number}
                  </span>
                  <Badge tone={STATUS_TONE[order.status]}>{t(`online.status.${order.status}`)}</Badge>
                </div>
                <p className="text-sm font-semibold text-stone-900">{order.customer_name}</p>
                <p className="text-xs text-stone-500" dir="ltr">
                  {order.customer_phone} · {date(order.created_at)}
                </p>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs text-stone-600">
                    {num(order.items.reduce((sum, item) => sum + item.quantity, 0), 0)}{" "}
                    {t("export.col.itemsCount")}
                  </span>
                  <span className="text-sm font-black tabular-nums text-stone-900">{money(order.total)}</span>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  <Badge tone={PAYMENT_TONE[order.payment_status]}>
                    {t(`online.paymentStatus.${order.payment_status}`)}
                  </Badge>
                  <Badge tone="neutral">{t(`online.paymentMethod.${order.payment_method}`)}</Badge>
                  <Badge tone="neutral">{t(`online.deliveryType.${order.delivery_type}`)}</Badge>
                </div>
              </button>
            ))}
          </div>
        </>
      )}

      <OrderDetailModal order={selected} onClose={() => void select(null)} />
    </div>
  );
}
