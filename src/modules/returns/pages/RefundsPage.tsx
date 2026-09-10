import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { PageHeader } from "@/components/layout/AppShell";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  EyeIcon,
  LoadingBlock,
  PlusIcon,
  ReceiptIcon,
  SearchIcon,
  StatTile,
  TextInput,
} from "@/components/ui";
import { useReturns } from "../hooks/ReturnProvider";
import { queryRefunds } from "../services/returnService";
import { ReturnFormModal } from "../components/ReturnFormModal";
import { canProcessRefund } from "../permissions";

export function RefundsPage() {
  const { t, date, num } = useI18n();
  const navigate = useNavigate();
  const { refundsList, loading, error, refresh } = useReturns();

  const [search, setSearch] = useState("");
  const [modalOpen, setModalOpen] = useState(false);
  const canRefund = canProcessRefund();

  const filteredRefunds = useMemo(() => {
    return queryRefunds(refundsList, { search });
  }, [refundsList, search]);

  const stats = useMemo(() => {
    let totalRefunded = 0;
    let cashRefunded = 0;
    let visaRefunded = 0;
    let instapayRefunded = 0;

    for (const ref of refundsList) {
      totalRefunded += ref.amount;
      if (ref.payment_method === "cash") cashRefunded += ref.amount;
      if (ref.payment_method === "visa") visaRefunded += ref.amount;
      if (ref.payment_method === "instapay") instapayRefunded += ref.amount;
    }

    return {
      refundsCount: refundsList.length,
      totalRefunded,
      cashRefunded,
      visaRefunded,
      instapayRefunded,
    };
  }, [refundsList]);

  return (
    <div>
      <PageHeader
        title={t("refunds.title")}
        subtitle={t("refunds.subtitle")}
        actions={
          <>
            <Button variant="secondary" onClick={() => void refresh()} title={t("common.retry")}>
              ⟳
            </Button>
            {canRefund ? (
              <Button onClick={() => setModalOpen(true)}>
                <PlusIcon />
                {t("returns.add")}
              </Button>
            ) : null}
          </>
        }
      />

      {/* KPI Stats */}
      <div className="mb-4 grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        <StatTile
          label={t("refunds.title")}
          value={String(stats.refundsCount)}
          tone="primary"
          icon={<ReceiptIcon className="h-5 w-5 text-indigo-500" />}
        />
        <StatTile
          label={t("refunds.amount")}
          value={num(stats.totalRefunded, 2)}
          tone="warning"
        />
        <StatTile
          label={t("refunds.cash")}
          value={num(stats.cashRefunded, 2)}
          tone="success"
        />
        <StatTile
          label={t("refunds.instapay")}
          value={num(stats.instapayRefunded, 2)}
          tone="info"
        />
      </div>

      {/* Search */}
      <Card className="mb-4">
        <div className="w-full sm:max-w-md">
          <TextInput
            value={search}
            leading={<SearchIcon />}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t("returns.searchPlaceholder")}
            aria-label={t("common.search")}
            type="search"
          />
        </div>
      </Card>

      {/* Content */}
      {error ? (
        <ErrorState
          title={t("common.error")}
          message={error.message}
          retryLabel={t("common.retry")}
          onRetry={() => void refresh()}
        />
      ) : loading ? (
        <div className="alyq-card">
          <LoadingBlock label={t("common.loading")} />
        </div>
      ) : filteredRefunds.length === 0 ? (
        <Card>
          <EmptyState
            icon="💸"
            title={t("refunds.title")}
            description={t("returns.emptyHint")}
            action={
              canRefund ? (
                <Button onClick={() => setModalOpen(true)}>
                  <PlusIcon />
                  {t("returns.add")}
                </Button>
              ) : undefined
            }
          />
        </Card>
      ) : (
        /* Refunds Table */
        <div className="alyq-card overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-start text-[11px] font-bold uppercase tracking-wider text-slate-600">
                <th className="px-4 py-3 text-start font-semibold">{t("refunds.refundNumber")}</th>
                <th className="px-3 py-3 text-start font-semibold">{t("returns.saleNumber")}</th>
                <th className="px-3 py-3 text-start font-semibold">{t("returns.linkedReturn")}</th>
                <th className="px-3 py-3 text-end font-semibold">{t("refunds.amount")}</th>
                <th className="px-3 py-3 text-start font-semibold">{t("refunds.method")}</th>
                <th className="px-3 py-3 text-start font-semibold">{t("refunds.status")}</th>
                <th className="px-3 py-3 text-start font-semibold">{t("pos.cols.date")}</th>
                <th className="px-3 py-3 text-start font-semibold">{t("pos.cols.user")}</th>
                <th className="px-4 py-3 text-end font-semibold">{t("common.actions")}</th>
              </tr>
            </thead>
            <tbody>
              {filteredRefunds.map((ref) => (
                <tr
                  key={ref.id}
                  className="border-b border-slate-50 last:border-0 hover:bg-slate-50/60 transition-colors"
                >
                  <td className="px-4 py-3 font-mono text-xs font-bold text-amber-700">
                    <Link to={`/refunds/${ref.id}`} className="hover:underline">
                      {ref.refund_number}
                    </Link>
                  </td>
                  <td className="px-3 py-3 font-mono text-xs">
                    <Link
                      to={`/pos/sales/${ref.sale_id}`}
                      className="text-indigo-700 hover:underline"
                    >
                      {ref.sale_number}
                    </Link>
                  </td>
                  <td className="px-3 py-3 font-mono text-xs">
                    {ref.return_id ? (
                      <Link
                        to={`/returns/${ref.return_id}`}
                        className="text-slate-700 hover:text-indigo-600 hover:underline"
                      >
                        {ref.return_id.startsWith("ret-") ? ref.return_id.slice(0, 12) : ref.return_id}
                      </Link>
                    ) : (
                      <span className="text-slate-400">—</span>
                    )}
                  </td>
                  <td className="px-3 py-3 text-end text-sm font-bold tabular-nums text-slate-900">
                    {num(ref.amount, 2)}
                  </td>
                  <td className="px-3 py-3 text-xs">
                    <Badge tone={ref.payment_method === "cash" ? "success" : ref.payment_method === "visa" ? "neutral" : "info"}>
                      {t(`pos.payment.${ref.payment_method}`)}
                    </Badge>
                  </td>
                  <td className="px-3 py-3 text-xs">
                    <Badge tone={ref.status === "completed" ? "success" : "warning"}>
                      {ref.status === "completed" ? t("refunds.paid") : t("refunds.pending")}
                    </Badge>
                  </td>
                  <td className="px-3 py-3 text-xs text-slate-500" dir="ltr">
                    {date(ref.created_at)}
                  </td>
                  <td className="px-3 py-3 text-xs text-slate-600">{ref.user_name}</td>
                  <td className="px-4 py-3 text-end">
                    <Link
                      to={`/refunds/${ref.id}`}
                      className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-slate-600 hover:bg-slate-100"
                      title={t("common.view")}
                    >
                      <EyeIcon />
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Return/Refund Modal */}
      {modalOpen && (
        <ReturnFormModal
          open={modalOpen}
          onClose={() => setModalOpen(false)}
          onSuccess={(returnId) => navigate(`/returns/${returnId}`)}
        />
      )}
    </div>
  );
}
