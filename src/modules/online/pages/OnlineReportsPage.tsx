/**
 * Online reports.
 *
 * The question this screen answers is "is the website earning its keep, and where
 * is it leaking?" — so it reports the things the till cannot see: how much of the
 * shop's trade came through the website, how many orders are still waiting on a
 * decision, how many were cancelled and what they were worth, which products the
 * website sells that the counter does not, and how much money is sitting in
 * "verification required" because a customer sent an InstaPay screenshot nobody
 * has looked at yet.
 *
 * Numbers here come from the orders themselves, over the chosen date range,
 * rather than from the POS sales table: an order that was never approved never
 * became a sale, and counting only sales would quietly hide every cancellation.
 * Cancelled orders are reported but excluded from revenue, which is the same line
 * the stock ledger draws.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { canActAs } from "@/lib/permissions/enforce";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { useAuth } from "@/lib/auth";
import { useCatalog } from "@/modules/products";
import { PageHeader } from "@/components/layout/AppShell";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  ExportButton,
  LoadingBlock,
  StatTile,
  TextInput,
} from "@/components/ui";
import { getOnlineOrdersRepository, getWebsiteRepository } from "../data";
import { toOnlineError, type OnlineErrorCode } from "../data/repository";
import {
  ONLINE_ORDER_STATUSES,
  ONLINE_PAYMENT_STATUSES,
  type OnlineOrder,
  type OnlineOrderStatus,
  type OnlinePaymentStatus,
} from "../types";
import { buildOnlineOrderSheets } from "../services/onlineOrdersExport";
import { toDateLocal } from "../services/datetime";
import { toTimestampBounds } from "@/modules/reports/services/dateRanges";

/** Orders that produced revenue: everything except a cancellation. */
const countsAsRevenue = (status: OnlineOrderStatus) => status !== "cancelled";

interface ProductRow {
  product_id: string;
  name: string;
  sku: string;
  units: number;
  revenue: number;
  orders: number;
}

export function OnlineReportsPage() {
  const { t, pick, num, money, date } = useI18n();
  const { user } = useAuth();
  const { products } = useCatalog();
  const ordersRepository = useMemo(() => getOnlineOrdersRepository(), []);
  const websiteRepository = useMemo(() => getWebsiteRepository(), []);
  const canManage = canActAs(user, "manage_online_orders");

  const [orders, setOrders] = useState<OnlineOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<OnlineErrorCode | null>(null);

  // Last 30 days by default: long enough to be a trend, short enough to load.
  const [from, setFrom] = useState(() => toDateLocal(new Date(Date.now() - 30 * 864e5).toISOString()));
  const [to, setTo] = useState(() => toDateLocal(new Date().toISOString()));

  const load = useCallback(async () => {
    setLoading(true);
    try {
      // UTC-day edges (shared with the reports): the same picked days query
      // the same orders on every machine, whatever its timezone.
      const bounds = toTimestampBounds({ from: from || null, to: to || null });
      const list = await ordersRepository.listOrders({
        from: bounds.from ?? null,
        to: bounds.to ?? null,
        limit: null,
      });
      setOrders(list);
      setError(null);
    } catch (caught) {
      setError(toOnlineError(caught).code);
    } finally {
      setLoading(false);
    }
  }, [from, ordersRepository, to]);

  useEffect(() => {
    if (canManage) void load();
    else setLoading(false);
  }, [canManage, load]);

  const stats = useMemo(() => {
    const revenueOrders = orders.filter((order) => countsAsRevenue(order.status));
    const cancelled = orders.filter((order) => order.status === "cancelled");
    const completed = orders.filter((order) => order.status === "completed");
    const pending = orders.filter((order) => order.status === "pending");

    const goodsValue = revenueOrders.reduce((sum, order) => sum + order.subtotal - order.discount_amount, 0);
    const deliveryFees = revenueOrders.reduce((sum, order) => sum + order.delivery_fee, 0);
    const totalValue = revenueOrders.reduce((sum, order) => sum + order.total, 0);
    const cancelledValue = cancelled.reduce((sum, order) => sum + order.total, 0);

    const byStatus = new Map<OnlineOrderStatus, { count: number; value: number }>();
    for (const status of ONLINE_ORDER_STATUSES) byStatus.set(status, { count: 0, value: 0 });
    for (const order of orders) {
      const entry = byStatus.get(order.status);
      if (entry) {
        entry.count += 1;
        entry.value += order.total;
      }
    }

    const byPayment = new Map<OnlinePaymentStatus, { count: number; value: number }>();
    for (const status of ONLINE_PAYMENT_STATUSES) byPayment.set(status, { count: 0, value: 0 });
    for (const order of revenueOrders) {
      const entry = byPayment.get(order.payment_status);
      if (entry) {
        entry.count += 1;
        entry.value += order.total;
      }
    }

    const byMethod = {
      cod: { count: 0, value: 0 },
      instapay: { count: 0, value: 0 },
    };
    for (const order of revenueOrders) {
      const entry = byMethod[order.payment_method];
      entry.count += 1;
      entry.value += order.total;
    }

    const byDay = new Map<string, { count: number; value: number }>();
    for (const order of revenueOrders) {
      const key = toDateLocal(order.created_at);
      const entry = byDay.get(key) ?? { count: 0, value: 0 };
      entry.count += 1;
      entry.value += order.total;
      byDay.set(key, entry);
    }

    return {
      total: orders.length,
      revenueOrders: revenueOrders.length,
      goodsValue,
      deliveryFees,
      totalValue,
      cancelledCount: cancelled.length,
      cancelledValue,
      completedCount: completed.length,
      pendingCount: pending.length,
      pendingValue: pending.reduce((sum, order) => sum + order.total, 0),
      average: revenueOrders.length > 0 ? totalValue / revenueOrders.length : 0,
      byStatus,
      byPayment,
      byMethod,
      byDay: [...byDay.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1)),
    };
  }, [orders]);

  // Promotions, read off the order snapshots — never off the live promotion
  // rows, so changing a discount later cannot rewrite this report. Legacy
  // rows predate snapshots: their code (if any) carries the whole discount.
  const promos = useMemo(() => {
    let gross = 0;
    let given = 0;
    let fees = 0;
    let freeShip = 0;
    let autoOrders = 0;
    let autoGiven = 0;
    const byCode = new Map<string, { count: number; revenue: number; discount: number }>();
    for (const order of orders) {
      if (!countsAsRevenue(order.status)) continue;
      gross += order.subtotal;
      given += order.discount_amount;
      fees += order.delivery_fee;
      const snap = order.price_snapshot;
      freeShip += snap?.shipping_discount ?? 0;
      if ((snap?.auto_discount ?? 0) > 0) {
        autoOrders += 1;
        autoGiven += snap?.auto_discount ?? 0;
      }
      if (order.discount_code) {
        const entry = byCode.get(order.discount_code) ?? { count: 0, revenue: 0, discount: 0 };
        entry.count += 1;
        entry.revenue += order.total;
        entry.discount += snap?.promo_discount ?? order.discount_amount;
        byCode.set(order.discount_code, entry);
      }
    }
    return {
      gross,
      given,
      net: gross - given,
      fees,
      freeShip,
      autoOrders,
      autoGiven,
      byCode: [...byCode.entries()]
        .map(([code, entry]) => ({ code, ...entry }))
        .sort((a, b) => b.discount - a.discount || b.count - a.count),
    };
  }, [orders]);

  const bestSellers = useMemo<ProductRow[]>(() => {
    const rows = new Map<string, ProductRow>();
    for (const order of orders) {
      if (!countsAsRevenue(order.status)) continue;
      for (const item of order.items) {
        const product = products.find((candidate) => candidate.id === item.product_id);
        const entry =
          rows.get(item.product_id) ??
          ({
            product_id: item.product_id,
            name: product ? pick(product.name_ar, product.name_en) : pick(item.name_ar, item.name_en),
            sku: item.sku,
            units: 0,
            revenue: 0,
            orders: 0,
          } satisfies ProductRow);
        entry.units += item.quantity;
        entry.revenue += item.line_total;
        entry.orders += 1;
        rows.set(item.product_id, entry);
      }
    }
    return [...rows.values()].sort((a, b) => b.units - a.units || b.revenue - a.revenue).slice(0, 10);
  }, [orders, pick, products]);

  // The website's own best-seller ranking, which also counts till sales: a
  // product that sells everywhere is a different thing from one the site sells.
  const [globalBest, setGlobalBest] = useState<{ product_id: string; units: number }[]>([]);
  useEffect(() => {
    if (!canManage) return;
    let cancelled = false;
    websiteRepository
      .bestSellers(8)
      .then((rows) => {
        if (!cancelled) setGlobalBest(rows);
      })
      .catch(() => {
        if (!cancelled) setGlobalBest([]);
      });
    return () => {
      cancelled = true;
    };
  }, [canManage, websiteRepository]);

  if (!canManage) {
    return (
      <div>
        <PageHeader title={t("online.reports.title")} subtitle={t("online.reports.subtitle")} />
        <Card>
          <EmptyState icon="🔒" title={t("online.settings.noAccess")} description={t("online.settings.noAccessHint")} />
        </Card>
      </div>
    );
  }

  const verificationPending = stats.byPayment.get("verification_required");

  return (
    <div>
      <PageHeader
        title={t("online.reports.title")}
        crumbs={[{ label: t("home.breadcrumb.online"), to: "/online" }, { label: t("nav.onlineReports") }]}
        subtitle={t("online.reports.subtitle")}
        actions={
          <>
            <ExportButton
              name="online-report"
              count={orders.length}
              build={() => buildOnlineOrderSheets({ orders, t, pick })}
            />
            <Button variant="secondary" onClick={() => void load()} title={t("common.retry")}>
              ⟳
            </Button>
          </>
        }
      />

      <Card className="mb-4">
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <p className="mb-1 text-xs font-bold text-slate-800">{t("online.reports.from")}</p>
            <TextInput type="date" value={from} onChange={(event) => setFrom(event.target.value)} className="h-9 w-40 text-xs" />
          </div>
          <div>
            <p className="mb-1 text-xs font-bold text-slate-800">{t("online.reports.to")}</p>
            <TextInput type="date" value={to} onChange={(event) => setTo(event.target.value)} className="h-9 w-40 text-xs" />
          </div>
          <Button size="sm" onClick={() => void load()}>
            {t("online.reports.apply")}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setFrom("");
              setTo("");
            }}
          >
            {t("online.reports.allTime")}
          </Button>
          <p className="ms-auto text-xs font-semibold text-slate-500">
            {t("online.orders.resultCount", { count: num(orders.length, 0) })}
          </p>
        </div>
      </Card>

      {error ? (
        <ErrorState title={t("common.error")} message={t(`online.error.${error}`)} retryLabel={t("common.retry")} onRetry={() => void load()} />
      ) : loading ? (
        <div className="alyq-card">
          <LoadingBlock label={t("common.loading")} />
        </div>
      ) : orders.length === 0 ? (
        <Card>
          <EmptyState icon="📈" title={t("online.reports.empty")} description={t("online.reports.emptyHint")} />
        </Card>
      ) : (
        <>
          <div className="mb-4 grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
            <StatTile
              label={t("online.reports.onlineSales")}
              value={money(stats.totalValue)}
              tone="success"
              hint={t("online.reports.goodsValue", { value: money(stats.goodsValue) })}
            />
            <StatTile
              label={t("online.reports.ordersCount")}
              value={num(stats.revenueOrders, 0)}
              tone="primary"
              hint={t("online.reports.averageOrder", { value: money(stats.average) })}
            />
            <StatTile
              label={t("online.status.pending")}
              value={num(stats.pendingCount, 0)}
              tone="warning"
              hint={t("online.reports.pendingValue", { value: money(stats.pendingValue) })}
            />
            <StatTile
              label={t("online.status.cancelled")}
              value={num(stats.cancelledCount, 0)}
              tone="danger"
              hint={t("online.reports.cancelledValue", { value: money(stats.cancelledValue) })}
            />
          </div>

          <div className="mb-4 grid gap-4 lg:grid-cols-2">
            <Card>
              <h2 className="text-sm font-bold text-slate-900">{t("online.reports.byStatus")}</h2>
              <table className="mt-2 w-full border-collapse text-sm">
                <tbody>
                  {ONLINE_ORDER_STATUSES.map((status) => {
                    const entry = stats.byStatus.get(status);
                    if (!entry) return null;
                    return (
                      <tr key={status} className="border-b border-slate-100 last:border-0">
                        <td className="py-2">
                          <Badge tone={status === "cancelled" ? "danger" : status === "pending" ? "warning" : "neutral"}>
                            {t(`online.status.${status}`)}
                          </Badge>
                        </td>
                        <td className="py-2 text-end text-xs tabular-nums text-slate-600">
                          {t("online.reports.ordersCount")}: {num(entry.count, 0)}
                        </td>
                        <td className="py-2 text-end text-sm font-bold tabular-nums text-slate-900">
                          {money(entry.value)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </Card>

            <Card>
              <h2 className="text-sm font-bold text-slate-900">{t("online.reports.byPaymentStatus")}</h2>
              <table className="mt-2 w-full border-collapse text-sm">
                <tbody>
                  {ONLINE_PAYMENT_STATUSES.map((status) => {
                    const entry = stats.byPayment.get(status);
                    if (!entry) return null;
                    return (
                      <tr key={status} className="border-b border-slate-100 last:border-0">
                        <td className="py-2">
                          <Badge
                            tone={
                              status === "paid"
                                ? "success"
                                : status === "failed"
                                  ? "danger"
                                  : status === "verification_required"
                                    ? "warning"
                                    : "neutral"
                            }
                          >
                            {t(`online.paymentStatus.${status}`)}
                          </Badge>
                        </td>
                        <td className="py-2 text-end text-xs tabular-nums text-slate-600">{num(entry.count, 0)}</td>
                        <td className="py-2 text-end text-sm font-bold tabular-nums text-slate-900">
                          {money(entry.value)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {verificationPending && verificationPending.count > 0 ? (
                <p className="mt-2 rounded-xl bg-amber-50 px-3 py-2 text-xs font-bold text-amber-900">
                  {t("online.reports.verificationWarning", {
                    count: num(verificationPending.count, 0),
                    value: money(verificationPending.value),
                  })}
                </p>
              ) : null}
              <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
                <div className="rounded-xl bg-slate-50 p-2">
                  <p className="font-bold text-slate-700">{t("online.paymentMethod.cod")}</p>
                  <p className="tabular-nums text-slate-600">
                    {num(stats.byMethod.cod.count, 0)} · {money(stats.byMethod.cod.value)}
                  </p>
                </div>
                <div className="rounded-xl bg-slate-50 p-2">
                  <p className="font-bold text-slate-700">{t("online.paymentMethod.instapay")}</p>
                  <p className="tabular-nums text-slate-600">
                    {num(stats.byMethod.instapay.count, 0)} · {money(stats.byMethod.instapay.value)}
                  </p>
                </div>
              </div>
            <p className="mt-2 text-[11px] text-slate-500">
              {t("online.reports.deliveryFees", { value: money(stats.deliveryFees) })}
            </p>
            </Card>
          </div>

          <Card className="mb-4">
            <h2 className="text-sm font-bold text-slate-900">{t("online.reports.promosTitle")}</h2>
            <p className="mt-0.5 text-[11px] font-medium text-slate-500">{t("online.reports.promosHint")}</p>
            <div className="mt-3 grid grid-cols-2 gap-2 text-xs lg:grid-cols-4">
              <div className="rounded-xl bg-slate-50 p-2">
                <p className="font-bold text-slate-700">{t("online.reports.promosGross")}</p>
                <p className="tabular-nums font-black text-slate-900">{money(promos.gross)}</p>
              </div>
              <div className="rounded-xl bg-slate-50 p-2">
                <p className="font-bold text-slate-700">{t("online.reports.promosGiven")}</p>
                <p className="tabular-nums font-black text-emerald-700">−{money(promos.given)}</p>
              </div>
              <div className="rounded-xl bg-slate-50 p-2">
                <p className="font-bold text-slate-700">{t("online.reports.promosNet")}</p>
                <p className="tabular-nums font-black text-slate-900">{money(promos.net)}</p>
              </div>
              <div className="rounded-xl bg-slate-50 p-2">
                <p className="font-bold text-slate-700">{t("online.reports.promosFees")}</p>
                <p className="tabular-nums text-slate-600">
                  {money(promos.fees)}
                  {promos.freeShip > 0 ? ` · ${t("online.reports.promosFreeShip", { value: money(promos.freeShip) })}` : ""}
                </p>
              </div>
            </div>
            {promos.byCode.length === 0 && promos.autoOrders === 0 ? (
              <p className="mt-3 text-xs font-semibold text-slate-500">{t("online.reports.promosEmpty")}</p>
            ) : (
              <table className="mt-3 w-full border-collapse text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-[11px] font-bold uppercase tracking-wider text-slate-500">
                    <th className="py-2 text-start font-semibold">{t("online.reports.promosColOffer")}</th>
                    <th className="py-2 text-end font-semibold">{t("online.reports.promosColOrders")}</th>
                    <th className="py-2 text-end font-semibold">{t("online.reports.promosColDiscount")}</th>
                    <th className="py-2 text-end font-semibold">{t("online.reports.revenue")}</th>
                  </tr>
                </thead>
                <tbody>
                  {promos.autoOrders > 0 ? (
                    <tr className="border-b border-slate-50">
                      <td className="py-2 text-xs font-semibold text-slate-900">
                        {t("online.reports.promosAutomatic")}
                      </td>
                      <td className="py-2 text-end text-xs tabular-nums text-slate-600">
                        {num(promos.autoOrders, 0)}
                      </td>
                      <td className="py-2 text-end text-xs font-bold tabular-nums text-emerald-700">
                        −{money(promos.autoGiven)}
                      </td>
                      <td className="py-2 text-end text-xs tabular-nums text-slate-400">—</td>
                    </tr>
                  ) : null}
                  {promos.byCode.map((row) => (
                    <tr key={row.code} className="border-b border-slate-50 last:border-0">
                      <td className="py-2 font-mono text-xs font-bold text-slate-900" dir="ltr">
                        {row.code}
                      </td>
                      <td className="py-2 text-end text-xs tabular-nums text-slate-600">{num(row.count, 0)}</td>
                      <td className="py-2 text-end text-xs font-bold tabular-nums text-emerald-700">
                        −{money(row.discount)}
                      </td>
                      <td className="py-2 text-end text-xs font-bold tabular-nums text-slate-900">
                        {money(row.revenue)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <h2 className="text-sm font-bold text-slate-900">{t("online.reports.bestSelling")}</h2>
              <p className="mt-0.5 text-[11px] font-medium text-slate-500">{t("online.reports.bestSellingHint")}</p>
              {bestSellers.length === 0 ? (
                <p className="mt-3 text-xs font-semibold text-slate-500">{t("online.reports.noProductSales")}</p>
              ) : (
                <table className="mt-2 w-full border-collapse text-sm">
                  <thead>
                    <tr className="border-b border-slate-200 text-[11px] font-bold uppercase tracking-wider text-slate-500">
                      <th className="py-2 text-start font-semibold">{t("export.col.product")}</th>
                      <th className="py-2 text-end font-semibold">{t("export.col.quantity")}</th>
                      <th className="py-2 text-end font-semibold">{t("online.reports.revenue")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {bestSellers.map((row) => (
                      <tr key={row.product_id} className="border-b border-slate-50 last:border-0">
                        <td className="py-2">
                          <p className="text-xs font-semibold text-slate-900">{row.name}</p>
                          <p className="font-mono text-[10px] text-slate-500">
                            {row.sku} · {t("online.reports.inOrders", { count: num(row.orders, 0) })}
                          </p>
                        </td>
                        <td className="py-2 text-end text-xs font-bold tabular-nums">{num(row.units, 0)}</td>
                        <td className="py-2 text-end text-xs font-bold tabular-nums text-slate-900">
                          {money(row.revenue)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}

              {globalBest.length > 0 ? (
                <div className="mt-3 border-t border-slate-100 pt-2">
                  <p className="text-xs font-bold text-slate-700">{t("online.reports.allTimeBest")}</p>
                  <p className="mt-1 text-[11px] leading-relaxed text-slate-500">
                    {globalBest
                      .map((row) => {
                        const product = products.find((candidate) => candidate.id === row.product_id);
                        const name = product ? pick(product.name_ar, product.name_en) : row.product_id;
                        return `${name} (${num(row.units, 0)})`;
                      })
                      .join(" · ")}
                  </p>
                  <p className="mt-1 text-[11px] text-slate-400">{t("online.reports.allTimeBestHint")}</p>
                </div>
              ) : null}
            </Card>

            <Card>
              <h2 className="text-sm font-bold text-slate-900">{t("online.reports.byDay")}</h2>
              <p className="mt-0.5 text-[11px] font-medium text-slate-500">{t("online.reports.byDayHint")}</p>
              <table className="mt-2 w-full border-collapse text-sm">
                <tbody>
                  {stats.byDay.slice(0, 14).map(([day, entry]) => (
                    <tr key={day} className="border-b border-slate-50 last:border-0">
                      <td className="py-1.5 text-xs text-slate-600" dir="ltr">
                        {day}
                      </td>
                      <td className="py-1.5 text-end text-xs tabular-nums text-slate-600">{num(entry.count, 0)}</td>
                      <td className="py-1.5 text-end text-xs font-bold tabular-nums text-slate-900">
                        {money(entry.value)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="mt-2 text-[11px] text-slate-500">
                {t("online.reports.completedCount", { count: num(stats.completedCount, 0) })}
                {" · "}
                {t("online.reports.lastOrder", {
                  when: orders[0] ? date(orders[0].created_at) : "—",
                })}
              </p>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
