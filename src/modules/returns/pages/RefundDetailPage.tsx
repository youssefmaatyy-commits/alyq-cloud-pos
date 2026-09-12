import { useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { PageHeader } from "@/components/layout/AppShell";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  LoadingBlock,
  ReceiptIcon,
  SectionTitle,
  StatTile,
} from "@/components/ui";
import { useReturns } from "../hooks/ReturnProvider";
import { RefundSettleModal } from "../components/RefundSettleModal";
import { canSettleRefund } from "../permissions";
import type { RefundDecision } from "../types";

export function RefundDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { t, date, num } = useI18n();
  const { refundsList, returnsList, loading } = useReturns();
  const [settleOpen, setSettleOpen] = useState<RefundDecision | null>(null);
  const canSettle = canSettleRefund();

  const refundRecord = useMemo(() => {
    return refundsList.find((r) => r.id === id);
  }, [refundsList, id]);

  const linkedReturn = useMemo(() => {
    if (!refundRecord?.return_id) return undefined;
    return returnsList.find((ret) => ret.id === refundRecord.return_id);
  }, [returnsList, refundRecord]);

  if (loading && !refundRecord) {
    return (
      <div className="alyq-card">
        <LoadingBlock label={t("common.loading")} />
      </div>
    );
  }

  if (!refundRecord) {
    return (
      <Card>
        <EmptyState
          icon="💸"
          title={t("common.notFound")}
          description={t("refunds.subtitle")}
          action={
            <Link to="/refunds" className="alyq-btn-primary alyq-cta h-10 rounded-xl px-4 text-sm">
              {t("refunds.title")}
            </Link>
          }
        />
      </Card>
    );
  }

  return (
    <div>
      <PageHeader
        title={refundRecord.refund_number}
        subtitle={`${t("refunds.title")} · ${date(refundRecord.created_at)}`}
        backTo="/refunds"
        backLabel={t("refunds.title")}
        actions={
          <>
            <Link
              to={`/pos/sales/${refundRecord.sale_id}`}
              className="inline-flex h-10 items-center gap-1.5 rounded-xl bg-white px-4 text-sm font-semibold text-slate-800 ring-1 ring-slate-300 hover:bg-slate-50"
            >
              {t("returns.saleNumber")}: {refundRecord.sale_number}
            </Link>
            {refundRecord.status === "pending" && canSettle ? (
              <>
                <Button variant="secondary" onClick={() => setSettleOpen("rejected")}>
                  {t("refunds.rejectAction")}
                </Button>
                <Button onClick={() => setSettleOpen("completed")}>
                  {t("refunds.approveAction")}
                </Button>
              </>
            ) : null}
          </>
        }
      />

      {/* KPI & Summary Tiles */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 mb-6">
        <StatTile
          label={t("refunds.amount")}
          value={num(refundRecord.amount, 2)}
          tone="warning"
          icon={<ReceiptIcon className="h-5 w-5 text-amber-500" />}
          hint={`${t("refunds.method")}: ${t(`pos.payment.${refundRecord.payment_method}`)}`}
        />
        <StatTile
          label={t("refunds.status")}
          value={
            refundRecord.status === "completed"
              ? t("refunds.paid")
              : refundRecord.status === "rejected"
                ? t("refunds.rejected")
                : t("refunds.pending")
          }
          tone={
            refundRecord.status === "completed"
              ? "success"
              : refundRecord.status === "rejected"
                ? "danger"
                : "warning"
          }
        />
        <StatTile
          label={t("pos.cols.user")}
          value={refundRecord.user_name}
          tone="neutral"
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
        {/* Refund Details */}
        <Card>
          <SectionTitle>{t("common.details")}</SectionTitle>
          <dl className="space-y-3 text-sm">
            <div className="flex items-center justify-between border-b border-slate-100 pb-2">
              <dt className="text-slate-500">{t("refunds.refundNumber")}</dt>
              <dd className="font-mono font-bold text-slate-900">{refundRecord.refund_number}</dd>
            </div>
            <div className="flex items-center justify-between border-b border-slate-100 pb-2">
              <dt className="text-slate-500">{t("returns.saleNumber")}</dt>
              <dd>
                <Link
                  to={`/pos/sales/${refundRecord.sale_id}`}
                  className="font-mono font-bold text-indigo-700 hover:underline"
                >
                  {refundRecord.sale_number}
                </Link>
              </dd>
            </div>
            <div className="flex items-center justify-between border-b border-slate-100 pb-2">
              <dt className="text-slate-500">{t("refunds.amount")}</dt>
              <dd className="font-extrabold text-slate-900 tabular-nums">
                {num(refundRecord.amount, 2)}
              </dd>
            </div>
            <div className="flex items-center justify-between border-b border-slate-100 pb-2">
              <dt className="text-slate-500">{t("refunds.method")}</dt>
              <dd>
                <Badge tone={refundRecord.payment_method === "cash" ? "success" : refundRecord.payment_method === "visa" ? "neutral" : "info"}>
                  {t(`pos.payment.${refundRecord.payment_method}`)}
                </Badge>
              </dd>
            </div>
            <div className="flex items-center justify-between border-b border-slate-100 pb-2">
              <dt className="text-slate-500">{t("pos.cols.date")}</dt>
              <dd className="text-slate-700" dir="ltr">{date(refundRecord.created_at)}</dd>
            </div>
            {refundRecord.reason && (
              <div className="pt-1">
                <dt className="font-semibold text-slate-700 mb-1">{t("returns.reason")}</dt>
                <dd className="rounded-lg bg-slate-50 p-2.5 text-slate-700">
                  {refundRecord.reason}
                </dd>
              </div>
            )}
          </dl>
        </Card>

        {/* Settlement trail — who decided, when, and why it was refused */}
        <Card>
          <SectionTitle>{t("refunds.settlementTrail")}</SectionTitle>
          {refundRecord.status === "pending" ? (
            <p className="text-sm text-slate-600">
              {t("refunds.pendingApprovalsHint")}
              {canSettle ? null : (
                <span className="mt-2 block rounded-lg border border-amber-200 bg-amber-50 p-2.5 text-xs font-semibold text-amber-800">
                  {t("refunds.noSettlePermission")}
                </span>
              )}
            </p>
          ) : (
            <dl className="space-y-3 text-sm">
              <div className="flex items-center justify-between border-b border-slate-100 pb-2">
                <dt className="text-slate-500">{t("refunds.status")}</dt>
                <dd>
                  <Badge tone={refundRecord.status === "completed" ? "success" : "danger"}>
                    {refundRecord.status === "completed"
                      ? t("refunds.paid")
                      : t("refunds.rejected")}
                  </Badge>
                </dd>
              </div>
              <div className="flex items-center justify-between border-b border-slate-100 pb-2">
                <dt className="text-slate-500">{t("refunds.settledBy")}</dt>
                <dd className="font-semibold text-slate-800">
                  {refundRecord.settled_by_name ?? "—"}
                </dd>
              </div>
              <div className="flex items-center justify-between border-b border-slate-100 pb-2">
                <dt className="text-slate-500">{t("refunds.settledAt")}</dt>
                <dd className="text-slate-700" dir="ltr">
                  {refundRecord.settled_at ? date(refundRecord.settled_at) : "—"}
                </dd>
              </div>
              {refundRecord.rejection_reason ? (
                <div className="pt-1">
                  <dt className="mb-1 font-semibold text-slate-700">
                    {t("refunds.rejectionReason")}
                  </dt>
                  <dd className="rounded-lg border border-rose-100 bg-rose-50 p-2.5 text-rose-800">
                    {refundRecord.rejection_reason}
                  </dd>
                </div>
              ) : null}
            </dl>
          )}
        </Card>

        {/* Linked Return */}
        <div className="space-y-4">
          {linkedReturn ? (
            <Card>
              <SectionTitle>{t("returns.linkedReturn")}</SectionTitle>
              <dl className="space-y-2 text-xs">
                <div className="flex justify-between">
                  <dt className="text-slate-500">{t("returns.returnNumber")}</dt>
                  <dd>
                    <Link
                      to={`/returns/${linkedReturn.id}`}
                      className="font-mono font-bold text-indigo-700 hover:underline"
                    >
                      {linkedReturn.return_number}
                    </Link>
                  </dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-slate-500">{t("returns.items")}</dt>
                  <dd className="font-bold tabular-nums">
                    {linkedReturn.items.reduce((s, i) => s + i.quantity, 0)}
                  </dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-slate-500">{t("returns.customer")}</dt>
                  <dd className="font-semibold text-slate-800">
                    {linkedReturn.customer_name || t("customers.guestCustomer")}
                  </dd>
                </div>
              </dl>
            </Card>
          ) : null}
        </div>
      </div>

      {settleOpen && refundRecord ? (
        <RefundSettleModal
          open
          refund={refundRecord}
          decision={settleOpen}
          onClose={() => setSettleOpen(null)}
        />
      ) : null}
    </div>
  );
}
