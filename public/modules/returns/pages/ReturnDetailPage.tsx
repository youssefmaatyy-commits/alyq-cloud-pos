import { useMemo } from "react";
import { Link, useParams } from "react-router-dom";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { PageHeader } from "@/components/layout/AppShell";
import {
  Badge,
  Card,
  EmptyState,
  LoadingBlock,
  RotateCcwIcon,
  SectionTitle,
  StatTile,
} from "@/components/ui";
import { useReturns } from "../hooks/ReturnProvider";

export function ReturnDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { t, date, num, isRTL } = useI18n();
  const { returnsList, refundsList, loading } = useReturns();

  const returnRecord = useMemo(() => {
    return returnsList.find((r) => r.id === id);
  }, [returnsList, id]);

  const linkedRefund = useMemo(() => {
    if (!id) return undefined;
    return refundsList.find((ref) => ref.return_id === id);
  }, [refundsList, id]);

  if (loading && !returnRecord) {
    return (
      <div className="alyq-card">
        <LoadingBlock label={t("common.loading")} />
      </div>
    );
  }

  if (!returnRecord) {
    return (
      <Card>
        <EmptyState
          icon="🔄"
          title={t("common.notFound")}
          description={t("returns.emptyHint")}
          action={
            <Link to="/returns" className="alyq-btn-primary alyq-cta h-10 rounded-xl px-4 text-sm">
              {t("returns.title")}
            </Link>
          }
        />
      </Card>
    );
  }

  return (
    <div>
      <PageHeader
        title={returnRecord.return_number}
        subtitle={`${t("returns.returnDetails")} · ${date(returnRecord.created_at)}`}
        backTo="/returns"
        backLabel={t("returns.title")}
        actions={
          <Link
            to={`/pos/sales/${returnRecord.sale_id}`}
            className="inline-flex h-10 items-center gap-1.5 rounded-xl bg-white px-4 text-sm font-semibold text-slate-800 ring-1 ring-slate-300 hover:bg-slate-50"
          >
            {t("returns.saleNumber")}: {returnRecord.sale_number}
          </Link>
        }
      />

      {/* KPI & Summary Tiles */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 mb-6">
        <StatTile
          label={t("returns.refundAmount")}
          value={num(returnRecord.refund_amount, 2)}
          tone="warning"
          icon={<RotateCcwIcon className="h-5 w-5 text-amber-500" />}
          hint={`${t("returns.refundMethod")}: ${t(`pos.payment.${returnRecord.refund_method}`)}`}
        />
        <StatTile
          label={t("returns.items")}
          value={String(returnRecord.items.reduce((s, i) => s + i.quantity, 0))}
          tone="primary"
          hint={`${returnRecord.items.length} ${t("pos.cols.items")}`}
        />
        <StatTile
          label={t("returns.customer")}
          value={returnRecord.customer_name || t("customers.guestCustomer")}
          tone="info"
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
        {/* Returned Items Table */}
        <Card>
          <SectionTitle>{t("returns.items")}</SectionTitle>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-100 text-[10px] font-bold uppercase tracking-wider text-slate-500">
                  <th className="py-2 px-3 text-start">{t("pos.cols.items")}</th>
                  <th className="py-2 px-3 text-center">{t("returns.returnQty")}</th>
                  <th className="py-2 px-3 text-end">{t("pos.unit")}</th>
                  <th className="py-2 px-3 text-end">{t("returns.refundAmount")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {returnRecord.items.map((item) => (
                  <tr key={item.id}>
                    <td className="py-2.5 px-3">
                      <p className="font-semibold text-slate-900">
                        {isRTL ? item.name_ar || item.name_en : item.name_en || item.name_ar}
                      </p>
                      <p className="font-mono text-[10px] text-slate-500">{item.sku}</p>
                    </td>
                    <td className="py-2.5 px-3 text-center font-bold tabular-nums text-slate-900">
                      {item.quantity}
                    </td>
                    <td className="py-2.5 px-3 text-end tabular-nums text-xs text-slate-600 font-mono">
                      {num(item.unit_price, 2)}
                    </td>
                    <td className="py-2.5 px-3 text-end font-bold tabular-nums text-slate-900">
                      {num(item.line_total, 2)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        {/* Audit Details */}
        <div className="space-y-4">
          <Card>
            <SectionTitle>{t("common.details")}</SectionTitle>
            <dl className="space-y-2 text-xs">
              <div className="flex items-center justify-between">
                <dt className="text-slate-500">{t("returns.saleNumber")}</dt>
                <dd>
                  <Link
                    to={`/pos/sales/${returnRecord.sale_id}`}
                    className="font-mono font-bold text-indigo-700 hover:underline"
                  >
                    {returnRecord.sale_number}
                  </Link>
                </dd>
              </div>

              <div className="flex items-center justify-between">
                <dt className="text-slate-500">{t("returns.refundMethod")}</dt>
                <dd>
                  <Badge tone={returnRecord.refund_method === "cash" ? "success" : "info"}>
                    {t(`pos.payment.${returnRecord.refund_method}`)}
                  </Badge>
                </dd>
              </div>

              <div className="flex items-center justify-between">
                <dt className="text-slate-500">{t("pos.cols.user")}</dt>
                <dd className="font-semibold text-slate-900">{returnRecord.user_name}</dd>
              </div>

              <div className="flex items-center justify-between">
                <dt className="text-slate-500">{t("pos.cols.date")}</dt>
                <dd className="text-slate-700" dir="ltr">{date(returnRecord.created_at)}</dd>
              </div>

              <div className="border-t border-slate-100 pt-2">
                <dt className="font-semibold text-slate-700 mb-0.5">{t("returns.reason")}</dt>
                <dd className="rounded-lg bg-slate-50 p-2 text-slate-700">
                  {returnRecord.reason}
                </dd>
              </div>
            </dl>
          </Card>

          {/* Stock Movement Notice */}
          <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-xs space-y-1">
            <p className="font-bold text-emerald-900 flex items-center gap-1.5">
              <span>✓</span>
              <span>{t("returns.movementNotice")}</span>
            </p>
            <p className="text-emerald-700 leading-relaxed">
              {t("app.phase3")} · {t("nav.movements")}
            </p>
          </div>

          {/* Linked Refund Record Card */}
          {linkedRefund && (
            <Card>
              <SectionTitle>{t("returns.linkedRefund")}</SectionTitle>
              <dl className="space-y-1.5 text-xs">
                <div className="flex justify-between">
                  <dt className="text-slate-500">{t("refunds.refundNumber")}</dt>
                  <dd>
                    <Link
                      to={`/refunds/${linkedRefund.id}`}
                      className="font-mono font-bold text-indigo-700 hover:underline"
                    >
                      {linkedRefund.refund_number}
                    </Link>
                  </dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-slate-500">{t("refunds.amount")}</dt>
                  <dd className="font-bold tabular-nums text-indigo-700">{num(linkedRefund.amount, 2)}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-slate-500">{t("refunds.status")}</dt>
                  <dd>
                    <Badge tone={linkedRefund.status === "completed" ? "success" : "warning"}>
                      {linkedRefund.status === "completed" ? t("refunds.paid") : t("refunds.pending")}
                    </Badge>
                  </dd>
                </div>
              </dl>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
