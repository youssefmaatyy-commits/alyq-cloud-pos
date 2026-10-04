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
  ExportButton,
  EyeIcon,
  LoadingBlock,
  PlusIcon,
  RotateCcwIcon,
  SearchIcon,
  StatTile,
  TextInput,
} from "@/components/ui";
import { useReturns } from "../hooks/ReturnProvider";
import { queryRefunds, queryReturns } from "../services/returnService";
import { ReturnFormModal } from "../components/ReturnFormModal";
import { buildReturnsSheets } from "../services/returnsExport";

export function ReturnsPage({ initialTab = "returns" }: { initialTab?: "returns" | "refunds" }) {
  const { t, date, num, pick } = useI18n();
  const navigate = useNavigate();
  const { returnsList, refundsList, loading, error, refresh } = useReturns();

  const [activeTab, setActiveTab] = useState<"returns" | "refunds">(initialTab);
  const [search, setSearch] = useState("");
  const [modalOpen, setModalOpen] = useState(false);

  const filteredReturns = useMemo(() => {
    return queryReturns(returnsList, { search });
  }, [returnsList, search]);

  const filteredRefunds = useMemo(() => {
    return queryRefunds(refundsList, { search });
  }, [refundsList, search]);

  const stats = useMemo(() => {
    let totalRefunded = 0;
    let cashRefunded = 0;
    let instapayRefunded = 0;

    for (const ref of refundsList) {
      // Pending is money still owed and rejected is money never paid. Financial
      // totals include only completed settlement records.
      if (ref.status !== "completed") continue;
      totalRefunded += ref.amount;
      if (ref.payment_method === "cash") cashRefunded += ref.amount;
      if (ref.payment_method === "instapay") instapayRefunded += ref.amount;
    }

    return {
      returnsCount: returnsList.length,
      refundsCount: refundsList.length,
      totalRefunded,
      cashRefunded,
      instapayRefunded,
    };
  }, [returnsList, refundsList]);

  return (
    <div>
      <PageHeader
        crumbs={[{ label: t("home.management.title"), to: "/management" }, { label: t("nav.returns") }]}
        title={t("returns.title")}
        subtitle={t("returns.subtitle")}
        actions={
          <>
            {/* Exports what the search box currently narrows both tabs down to. */}
            <ExportButton
              name="returns"
              count={filteredReturns.length + filteredRefunds.length}
              build={() =>
                buildReturnsSheets({
                  returnsList: filteredReturns,
                  refundsList: filteredRefunds,
                  t,
                  pick,
                })
              }
            />
            <Button variant="secondary" onClick={() => void refresh()} title={t("common.retry")}>
              ⟳
            </Button>
            <Button onClick={() => setModalOpen(true)}>
              <PlusIcon />
              {t("returns.add")}
            </Button>
          </>
        }
      />

      {/* KPI Stats */}
      <div className="mb-4 grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        <StatTile
          label={t("returns.title")}
          value={String(stats.returnsCount)}
          tone="primary"
          icon={<RotateCcwIcon className="h-5 w-5 text-indigo-500" />}
        />
        <StatTile
          label={t("returns.refundAmount")}
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

      {/* Tabs & Search */}
      <Card className="mb-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex rounded-xl bg-slate-100 p-1">
            <button
              type="button"
              onClick={() => setActiveTab("returns")}
              className={`rounded-lg px-4 py-1.5 text-xs font-bold transition-all ${
                activeTab === "returns"
                  ? "bg-white text-slate-900 shadow-sm"
                  : "text-slate-600 hover:text-slate-900"
              }`}
            >
              {t("returns.title")} ({returnsList.length})
            </button>
            <button
              type="button"
              onClick={() => setActiveTab("refunds")}
              className={`rounded-lg px-4 py-1.5 text-xs font-bold transition-all ${
                activeTab === "refunds"
                  ? "bg-white text-slate-900 shadow-sm"
                  : "text-slate-600 hover:text-slate-900"
              }`}
            >
              {t("refunds.title")} ({refundsList.length})
            </button>
          </div>

          <div className="w-full sm:max-w-xs">
            <TextInput
              value={search}
              leading={<SearchIcon />}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t("returns.searchPlaceholder")}
              aria-label={t("common.search")}
              type="search"
            />
          </div>
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
      ) : activeTab === "returns" ? (
        filteredReturns.length === 0 ? (
          <Card>
            <EmptyState
              icon="🔄"
              title={t("returns.empty")}
              description={t("returns.emptyHint")}
              action={
                <Button onClick={() => setModalOpen(true)}>
                  <PlusIcon />
                  {t("returns.add")}
                </Button>
              }
            />
          </Card>
        ) : (
          <>
            {/* Desktop Returns Table */}
            <div className="alyq-card hidden overflow-x-auto md:block">
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50 text-start text-[11px] font-bold uppercase tracking-wider text-slate-600">
                    <th className="px-4 py-3 text-start font-semibold">{t("returns.returnNumber")}</th>
                    <th className="px-3 py-3 text-start font-semibold">{t("returns.saleNumber")}</th>
                    <th className="px-3 py-3 text-start font-semibold">{t("returns.customer")}</th>
                    <th className="px-3 py-3 text-start font-semibold">{t("returns.reason")}</th>
                    <th className="px-3 py-3 text-start font-semibold">{t("returns.itemsColumn")}</th>
                    <th className="px-3 py-3 text-start font-semibold">{t("pos.cols.status")}</th>
                    <th className="px-3 py-3 text-end font-semibold">{t("returns.refundAmount")}</th>
                    <th className="px-3 py-3 text-start font-semibold">{t("returns.refundMethod")}</th>
                    <th className="px-3 py-3 text-start font-semibold">{t("pos.cols.date")}</th>
                    <th className="px-4 py-3 text-end font-semibold">{t("common.actions")}</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredReturns.map((ret) => (
                    <tr
                      key={ret.id}
                      className="border-b border-slate-50 last:border-0 hover:bg-slate-50/60 transition-colors"
                    >
                      <td className="px-4 py-3 font-mono text-xs font-bold text-indigo-700">
                        <Link to={`/returns/${ret.id}`} className="hover:underline">
                          {ret.return_number}
                        </Link>
                      </td>
                      <td className="px-3 py-3 font-mono text-xs">
                        <Link
                          to={`/pos/sales/${ret.sale_id}`}
                          className="font-semibold text-slate-700 hover:text-indigo-600 hover:underline"
                        >
                          {ret.sale_number}
                        </Link>
                      </td>
                      <td className="px-3 py-3 text-xs text-slate-700">
                        {ret.customer_name || t("customers.guestCustomer")}
                      </td>
                      <td className="px-3 py-3 text-xs text-slate-600 max-w-xs truncate">
                        {ret.reason}
                      </td>
                      {/* What came back, with its exact combination (Phase 43):
                          a return restores the shelf the goods left, so the row
                          names Gold / 17 rather than just the product. */}
                      <td className="px-3 py-3 text-xs text-slate-700" data-testid="returns-items-cell">
                        {ret.items.map((item) => (
                          <div key={item.id} className="truncate">
                            {t("returns.itemLine", {
                              count: item.quantity,
                              name: pick(item.name_ar, item.name_en),
                              variant: item.variant_id
                                ? ` · ${item.variant_color_en || item.variant_color_ar}${item.variant_size !== null || item.variant_size_label ? ` / ${item.variant_size !== null ? Math.round(item.variant_size * 100) / 100 : item.variant_size_label}` : ""}`
                                : "",
                            })}
                          </div>
                        ))}
                      </td>
                      <td className="px-3 py-3">
                        <Badge
                          tone={
                            ret.refund_status === "completed"
                              ? "success"
                              : ret.refund_status === "rejected"
                                ? "danger"
                                : "warning"
                          }
                        >
                          {t(`returns.status.${ret.refund_status}`)}
                        </Badge>
                      </td>
                      <td className="px-3 py-3 text-end text-sm font-bold tabular-nums text-slate-900">
                        {num(ret.refund_amount, 2)}
                      </td>
                      <td className="px-3 py-3 text-xs">
                        <Badge tone={ret.refund_method === "cash" ? "success" : "info"}>
                          {t(`pos.payment.${ret.refund_method}`)}
                        </Badge>
                      </td>
                      <td className="px-3 py-3 text-xs text-slate-500" dir="ltr">
                        {date(ret.created_at)}
                      </td>
                      <td className="px-4 py-3 text-end">
                        <Link
                          to={`/returns/${ret.id}`}
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

            {/* Mobile Cards */}
            <div className="space-y-3 md:hidden">
              {filteredReturns.map((ret) => (
                <div key={ret.id} className="alyq-card p-4 space-y-2">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <Link
                        to={`/returns/${ret.id}`}
                        className="font-mono text-sm font-bold text-indigo-700"
                      >
                        {ret.return_number}
                      </Link>
                      <p className="text-xs text-slate-500">
                        {t("returns.saleNumber")}:{" "}
                        <Link
                          to={`/pos/sales/${ret.sale_id}`}
                          className="font-mono text-slate-700 hover:underline"
                        >
                          {ret.sale_number}
                        </Link>
                      </p>
                    </div>
                    <Badge tone={ret.refund_method === "cash" ? "success" : "info"}>
                      {t(`pos.payment.${ret.refund_method}`)}
                    </Badge>
                  </div>

                  <p className="text-xs text-slate-600">{ret.reason}</p>

                  <div className="flex items-center justify-between border-t border-slate-100 pt-2 text-xs">
                    <span className="text-slate-500">{date(ret.created_at)}</span>
                    <span className="text-sm font-bold tabular-nums text-slate-900">
                      {num(ret.refund_amount, 2)}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </>
        )
      ) : filteredRefunds.length === 0 ? (
        <Card>
          <EmptyState
            icon="💸"
            title={t("refunds.title")}
            description={t("refunds.subtitle")}
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
                <th className="px-3 py-3 text-end font-semibold">{t("refunds.amount")}</th>
                <th className="px-3 py-3 text-start font-semibold">{t("refunds.method")}</th>
                <th className="px-3 py-3 text-start font-semibold">{t("refunds.status")}</th>
                <th className="px-3 py-3 text-start font-semibold">{t("pos.cols.date")}</th>
                <th className="px-3 py-3 text-start font-semibold">{t("pos.cols.user")}</th>
              </tr>
            </thead>
            <tbody>
              {filteredRefunds.map((ref) => (
                <tr
                  key={ref.id}
                  className="border-b border-slate-50 last:border-0 hover:bg-slate-50/60 transition-colors"
                >
                  <td className="px-4 py-3 font-mono text-xs font-bold text-slate-900">
                    {ref.refund_number}
                  </td>
                  <td className="px-3 py-3 font-mono text-xs">
                    <Link
                      to={`/pos/sales/${ref.sale_id}`}
                      className="text-indigo-700 hover:underline"
                    >
                      {ref.sale_number}
                    </Link>
                  </td>
                  <td className="px-3 py-3 text-end text-sm font-bold tabular-nums text-slate-900">
                    {num(ref.amount, 2)}
                  </td>
                  <td className="px-3 py-3 text-xs">
                    <Badge tone={ref.payment_method === "cash" ? "success" : "info"}>
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
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Return Modal */}
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
